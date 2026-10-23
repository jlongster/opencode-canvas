/**
 * Every session frame on a canvas is an OpenCode session: its title (renames included), parent,
 * agent, times and whether OpenCode deleted it come from the OpenCode it lives on, which only
 * browsers talk to. The canvas keeps only which sessions it shows (and which server each is on, once
 * known) and its own state for them, by session id: items, groups, order, hidden, notes.
 *
 * `liveSessions` (one per tab) is what this tab's paired servers say about sessions: it fetches the
 * sessions canvases want, in batches (a server's recent sessions in one list, the rest one by one), and
 * follows every paired server's event stream for renames, new and deleted sessions and busy/idle,
 * fetching its sessions again whenever a stream (re)connects, in case it missed something. A session
 * no paired server has stays as the canvas knows it.
 *
 * `FrameSessions` (one per canvas page) wants the canvas's frames, shows what OpenCode says about
 * them in this tab straight away (Editor.setLiveSessions), and on edit links mirrors it to the canvas
 * server, which saves it on the frames and broadcasts it: everyone else (view links, people without a
 * pairing, this browser with no paired tab open) sees that.
 */
import type { OpenCodeSessionInfo, OpenCodeSessionSummary, Session } from '../../../shared/types'
import type { Editor, LiveSession } from '../editor/Editor'
import { atom, react } from '../state/signals'
import { mirrorSessions } from '../sync/client'
import { PASTED_SESSION_ID } from '../ui/pastePage'
import { onOpenCodeEvents, type OpenCodeEvent } from './events'
import { pairing, pairings, withServer, type OpenCodeClient } from './pairings'
import { onSessionsListed } from './sessions'

const SESSION_ID = /^ses_[A-Za-z0-9]{26}$/
const TITLE_MAX = 200
/** sessions wanted together are first looked for among a server's this many most recent ones... */
const LIST_LIMIT = 200
/** ...when there are more than this many of them */
const LIST_OVER = 3
/** the rest are fetched one by one, this many at a time per server */
const GET_CONCURRENCY = 6
const REQUEST_MS = 10_000
/** wanted sessions are fetched together after this long */
const FETCH_DEBOUNCE_MS = 30
/** changes are mirrored to the canvas server together after this long */
const MIRROR_DEBOUNCE_MS = 120
const MIRROR_RETRY_MS = 5_000

type SessionInfo = Awaited<ReturnType<OpenCodeClient['session']['get']>>

/** What this tab knows about a session from a paired server. */
export interface KnownSession extends Partial<OpenCodeSessionInfo> {
	id: string
	serverKey: string
	/** read from OpenCode in full; else only what listings and events said */
	complete: boolean
}

/** An OpenCode title as the canvas keeps it: one line, at most TITLE_MAX characters. */
const cleanTitle = (title: unknown) => (typeof title === 'string' ? title.trim().replace(/\s+/g, ' ').slice(0, TITLE_MAX) : '')
const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined)

/** Real OpenCode sessions only: not "Pasted links" or anything else made up on the canvas. */
export const isOpenCodeSession = (id: string) => SESSION_ID.test(id) && id !== PASTED_SESSION_ID

function isNotFound(e: unknown): boolean {
	if (!e || typeof e !== 'object') return false
	const err = e as { _tag?: unknown; status?: unknown; cause?: { status?: unknown } }
	return err._tag === 'SessionNotFoundError' || err.status === 404 || err.cause?.status === 404
}

function fromOpenCode(serverKey: string, s: SessionInfo): KnownSession {
	return {
		id: s.id,
		serverKey,
		complete: true,
		title: cleanTitle(s.title),
		...(s.parentID ? { parentId: s.parentID } : {}),
		...(s.agent ? { agent: s.agent } : {}),
		...(s.location?.directory ? { directory: s.location.directory } : {}),
		createdAt: s.time.created,
		updatedAt: s.time.updated,
	}
}

/** Runs `fn` over `list`, at most `n` at a time. */
async function pool<T>(list: T[], n: number, fn: (x: T) => Promise<void>) {
	let next = 0
	await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
		while (next < list.length) await fn(list[next++])
	}))
}

const setEquals = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((x) => b.has(x))

class LiveSessions {
	/** what the paired servers say about the sessions this tab has heard of, by id (live) */
	readonly sessions = atom<Record<string, KnownSession>>('openCodeSessions', {})
	/** sessions working right now, on paired servers whose event stream is up (live) */
	readonly busy = atom<ReadonlySet<string>>('openCodeBusy', new Set(), setEquals)
	/** sessions whose last run failed, as the paired servers' event streams said (live) */
	readonly failed = atom<ReadonlySet<string>>('openCodeFailed', new Set(), setEquals)
	/** bumped when sessions came or went on a server (or its stream reconnected): lists of them may be out of date */
	readonly listVersion = atom<number>('openCodeListVersion', 0)

	/** each consumer's wanted sessions: id → the server it's said to be on (a hint), if any */
	private wants = new Map<object, Map<string, string | undefined>>()
	/** sessions each server said it doesn't have (asked again when its stream reconnects) */
	private missing = new Map<string, Set<string>>()
	private pending = new Set<string>()
	private timer = 0
	private flushing = false
	/** when an event last told us something about each session (performance.now()), so a fetch that started earlier doesn't undo it */
	private touched = new Map<string, number>()
	/** which sessions are working, by server: only for servers whose stream is up */
	private busyBy = new Map<string, Set<string>>()
	private streams = new Map<string, () => void>()
	private users = 0
	private stopping: (() => void)[] = []

	/** Keeps the paired servers' event streams open until the returned function is called (counted). */
	retain(): () => void {
		if (this.users++ === 0) {
			this.stopping.push(
				react(() => this.syncServers(pairings.get().map((p) => p.key))),
				onSessionsListed((key, list, startedAt) => this.noteListed(key, list, startedAt)),
			)
		}
		let released = false
		return () => {
			if (released) return
			released = true
			if (--this.users > 0) return
			for (const stop of this.stopping.splice(0)) stop()
			for (const key of [...this.streams.keys()]) this.dropServer(key)
			clearTimeout(this.timer)
			this.timer = 0
		}
	}

	/** Keeps these sessions (id → the server each is said to be on, if known) fetched and up to date for `who`. */
	want(who: object, ids: Map<string, string | undefined>) {
		const before = this.wants.get(who)
		this.wants.set(who, ids)
		const known = this.sessions.peek()
		for (const id of ids.keys()) if (!before?.has(id) && !known[id]?.complete) this.pending.add(id)
		this.schedule()
	}

	unwant(who: object) {
		this.wants.delete(who)
	}

	/** Which sessions are working on a server, or undefined while its event stream isn't up. */
	busyOn(serverKey: string): ReadonlySet<string> | undefined {
		this.busy.get()
		return this.busyBy.get(serverKey)
	}

	/**
	 * Which of a canvas's frames are working (reactive): what this tab's paired servers say where
	 * their event streams are up, else what the canvas server says (`reported`). `own`: the ones this
	 * tab knows of itself, which it reports to the canvas server for everyone else. Each frame shows
	 * its own session only (a parent's band says nothing about its subagents').
	 */
	busyFrames(records: Record<string, Session>, reported: ReadonlySet<string>): { shown: Set<string>; own: string[] } {
		this.busy.get()
		const known = this.sessions.get()
		const shown = new Set<string>()
		const own: string[] = []
		for (const [id, record] of Object.entries(records)) {
			const home = known[id]?.serverKey ?? record.serverKey
			const here = home && isOpenCodeSession(id) ? this.busyBy.get(home) : undefined
			if (here ? here.has(id) : reported.has(id)) shown.add(id)
			if (here?.has(id)) own.push(id)
		}
		return { shown, own: own.sort() }
	}

	private wanted(): Map<string, string | undefined> {
		const all = new Map<string, string | undefined>()
		for (const ids of this.wants.values()) for (const [id, hint] of ids) if (!all.get(id)) all.set(id, hint)
		return all
	}

	private syncServers(keys: string[]) {
		for (const key of [...this.streams.keys()]) if (!keys.includes(key)) this.dropServer(key)
		for (const key of keys) {
			if (this.streams.has(key)) continue
			this.missing.delete(key)
			this.streams.set(key, onOpenCodeEvents(key, { onEvent: (ev) => this.onEvent(key, ev), onConnect: () => this.onConnect(key) }))
			// (it may have sessions the other servers don't; its stream connecting asks it again)
			this.request(key)
		}
	}

	/** A server was unpaired (or nothing needs it): what it said goes, and its frames show the canvas's mirror again. */
	private dropServer(key: string) {
		this.streams.get(key)?.()
		this.streams.delete(key)
		this.missing.delete(key)
		this.busyBy.delete(key)
		this.publishBusy()
		const all = this.sessions.peek()
		const kept = Object.fromEntries(Object.entries(all).filter(([, s]) => s.serverKey !== key))
		if (Object.keys(kept).length !== Object.keys(all).length) this.sessions.set(kept)
	}

	/** The stream (re)connected: events may have been missed, so its sessions are fetched again. */
	private onConnect(key: string) {
		this.missing.delete(key)
		this.request(key)
		this.listVersion.set(this.listVersion.peek() + 1)
		void withServer(key, (c) => c.session.active({ signal: AbortSignal.timeout(REQUEST_MS) }))
			.then((active) => {
				if (!this.streams.has(key)) return
				this.busyBy.set(key, new Set(Object.keys(active)))
				this.publishBusy()
			})
			.catch(() => {})
	}

	/** Queues the wanted sessions that may be on this server: its own, and those not found anywhere yet. */
	private request(key: string) {
		const known = this.sessions.peek()
		for (const [id, hint] of this.wanted()) {
			const home = (known[id]?.complete && known[id].serverKey) || hint
			if (!home || home === key || !pairing(home)) this.pending.add(id)
		}
		this.schedule()
	}

	private schedule() {
		if (!this.pending.size || this.timer || !this.users) return
		this.timer = window.setTimeout(() => {
			this.timer = 0
			void this.flush()
		}, FETCH_DEBOUNCE_MS)
	}

	private async flush() {
		if (this.flushing) return
		const wanted = this.wanted()
		const ids = [...this.pending].filter((id) => wanted.has(id))
		this.pending.clear()
		if (!ids.length) return
		this.flushing = true
		try {
			const servers = pairings.peek().map((p) => p.key)
			const known = this.sessions.peek()
			const byServer = new Map<string, string[]>()
			for (const id of ids) {
				const home = (known[id]?.complete && known[id].serverKey) || wanted.get(id)
				const targets =
					home && servers.includes(home) && !this.missing.get(home)?.has(id) ? [home] : servers.filter((k) => !this.missing.get(k)?.has(id))
				for (const key of targets) byServer.set(key, [...(byServer.get(key) ?? []), id])
			}
			await Promise.all([...byServer].map(([key, list]) => this.fetchFrom(key, list)))
		} finally {
			this.flushing = false
			this.schedule()
		}
	}

	/** Reads these sessions from one server: found ones are put, missing ones looked for elsewhere. */
	private async fetchFrom(key: string, ids: string[]) {
		const startedAt = performance.now()
		const found: KnownSession[] = []
		const gone: string[] = []
		await withServer(key, async (c) => {
			let rest = ids
			if (ids.length > LIST_OVER) {
				const recent = await c.session.list({ limit: LIST_LIMIT, order: 'desc' }, { signal: AbortSignal.timeout(REQUEST_MS) })
				for (const s of recent.data) if (rest.includes(s.id)) found.push(fromOpenCode(key, s))
				rest = rest.filter((id) => !found.some((s) => s.id === id))
			}
			await pool(rest, GET_CONCURRENCY, async (id) => {
				try {
					found.push(fromOpenCode(key, await c.session.get({ sessionID: id }, { signal: AbortSignal.timeout(REQUEST_MS) })))
				} catch (e) {
					if (!isNotFound(e)) throw e
					gone.push(id)
				}
			})
		}).catch(() => {
			// Unreachable (noted in the servers list): its stream reconnecting asks again.
		})
		if (!this.streams.has(key)) return
		const all = { ...this.sessions.peek() }
		let changed = false
		for (const s of found) {
			const prev = all[s.id]
			// An event told us about it after this fetch started: what it said is newer.
			const next = prev && (this.touched.get(s.id) ?? 0) > startedAt ? { ...s, title: prev.title ?? s.title, ...(prev.deleted ? { deleted: true } : {}) } : s
			if (prev && sameSession(prev, next)) continue
			all[s.id] = next
			changed = true
		}
		const missing = this.missing.get(key) ?? new Set<string>()
		this.missing.set(key, missing)
		for (const id of gone) {
			missing.add(id)
			const prev = all[id]
			// It was here before and isn't any more: deleted while we weren't listening.
			if (prev?.complete && prev.serverKey === key) {
				if (!prev.deleted) {
					all[id] = { ...prev, deleted: true }
					changed = true
				}
			} else if (pairings.peek().some((p) => p.key !== key && !this.missing.get(p.key)?.has(id))) {
				this.pending.add(id)
			}
		}
		if (changed) this.sessions.set(all)
	}

	/** A server's recent sessions were listed (the Sessions panel, seeding): what we didn't know yet, or older than the list. */
	private noteListed(key: string, list: OpenCodeSessionSummary[], startedAt: number) {
		if (!this.streams.has(key)) return
		const all = { ...this.sessions.peek() }
		let changed = false
		for (const s of list) {
			const prev = all[s.id]
			if (prev && (this.touched.get(s.id) ?? 0) > startedAt) continue
			const next: KnownSession = {
				...prev,
				id: s.id,
				serverKey: key,
				complete: prev?.serverKey === key && prev.complete,
				title: cleanTitle(s.title),
				...(s.directory ? { directory: s.directory } : {}),
				updatedAt: Math.max(prev?.updatedAt ?? 0, s.updatedAt),
			}
			if (prev && sameSession(prev, next)) continue
			all[s.id] = next
			changed = true
		}
		if (changed) this.sessions.set(all)
	}

	private onEvent(key: string, ev: OpenCodeEvent) {
		const data = ev.data ?? {}
		const id = typeof data.sessionID === 'string' ? data.sessionID : null
		if (!id) return
		const at = typeof ev.created === 'number' ? ev.created : Date.now()
		switch (ev.type) {
			case 'session.created': {
				const parentId = text(data.parentID)
				const directory = text((data.location as { directory?: unknown } | undefined)?.directory)
				const agent = text(data.agent)
				this.patch(key, id, { title: cleanTitle(data.title), ...(parentId ? { parentId } : {}), ...(agent ? { agent } : {}), ...(directory ? { directory } : {}), createdAt: at, updatedAt: at }, !parentId)
				if (!parentId) this.listVersion.set(this.listVersion.peek() + 1)
				return
			}
			case 'session.renamed':
				return this.patch(key, id, { title: cleanTitle(data.title), updatedAt: at })
			case 'session.updated': {
				// (older servers send the whole session)
				const info = data.info as { title?: unknown } | undefined
				if (info && typeof info.title === 'string') this.patch(key, id, { title: cleanTitle(info.title), updatedAt: at })
				return
			}
			case 'session.moved': {
				const directory = text((data.location as { directory?: unknown } | undefined)?.directory)
				return directory ? this.patch(key, id, { directory }) : undefined
			}
			case 'session.agent.selected': {
				const agent = text(data.agent)
				return agent ? this.patch(key, id, { agent }) : undefined
			}
			case 'session.deleted':
				this.patch(key, id, { deleted: true, updatedAt: at })
				this.setBusy(key, id, false)
				this.listVersion.set(this.listVersion.peek() + 1)
				return
			case 'session.archived':
			case 'session.unarchived':
				this.listVersion.set(this.listVersion.peek() + 1)
				return
			case 'session.status': {
				const status = (data.status as { type?: unknown } | undefined)?.type
				if (status === 'busy' || status === 'retry') this.setBusy(key, id, true, at)
				else if (status === 'idle') this.setBusy(key, id, false, at)
				return
			}
			case 'session.execution.started':
				this.setFailed(id, false)
				return this.setBusy(key, id, true, at)
			case 'session.execution.failed':
				this.setFailed(id, true)
				return this.setBusy(key, id, false, at)
			case 'session.execution.succeeded':
			case 'session.execution.interrupted':
			case 'session.idle':
				return this.setBusy(key, id, false, at)
		}
	}

	/**
	 * What an event said about a session, merged into what we know. Sessions we know nothing about
	 * are only kept when wanted (then fetched in full too) or `keep`.
	 */
	private patch(key: string, id: string, changes: Partial<OpenCodeSessionInfo>, keep = false) {
		const prev = this.sessions.peek()[id]
		const wanted = !prev && this.wanted().has(id)
		if (!prev && !wanted && !keep) return
		this.touched.set(id, performance.now())
		this.missing.get(key)?.delete(id)
		const next: KnownSession = { ...prev, ...changes, id, serverKey: key, complete: (prev?.serverKey === key && prev.complete) || (keep && !prev) }
		if (prev && sameSession(prev, next)) return
		this.sessions.set({ ...this.sessions.peek(), [id]: next })
		if (wanted) {
			this.pending.add(id)
			this.schedule()
		}
	}

	private setBusy(key: string, id: string, busy: boolean, at?: number) {
		const set = this.busyBy.get(key)
		if (!set || set.has(id) === busy) return
		if (busy) set.add(id)
		else set.delete(id)
		const prev = this.sessions.peek()[id]
		if (at && prev && (prev.updatedAt ?? 0) < at) this.sessions.set({ ...this.sessions.peek(), [id]: { ...prev, updatedAt: at } })
		this.publishBusy()
	}

	private setFailed(id: string, failed: boolean) {
		const now = this.failed.peek()
		if (now.has(id) === failed) return
		const next = new Set(now)
		if (failed) next.add(id)
		else next.delete(id)
		this.failed.set(next)
	}

	private publishBusy() {
		this.busy.set(new Set([...this.busyBy.values()].flatMap((s) => [...s])))
	}
}

function sameSession(a: KnownSession, b: KnownSession) {
	return (
		a.serverKey === b.serverKey &&
		a.complete === b.complete &&
		a.title === b.title &&
		a.parentId === b.parentId &&
		a.agent === b.agent &&
		a.directory === b.directory &&
		a.createdAt === b.createdAt &&
		a.updatedAt === b.updatedAt &&
		!!a.deleted === !!b.deleted
	)
}

/** What this tab's paired OpenCode servers say about sessions (one per tab, shared by everything on the page). */
export const liveSessions = new LiveSessions()
;(window as any).liveSessions = liveSessions

/** The fields the canvas server keeps of a session (times aside: they alone aren't worth mirroring). */
const mirrorKey = (serverKey: string, s: OpenCodeSessionInfo) =>
	JSON.stringify([serverKey, s.title, s.parentId ?? null, s.agent ?? null, s.directory ?? null, !!s.deleted])

/**
 * One canvas page's frames as OpenCode sessions: keeps them fetched and followed (liveSessions),
 * shows what OpenCode says about them here, and (`mirror`, on edit links) reports it to the canvas
 * server for everyone else.
 */
export class FrameSessions {
	private disposers: (() => void)[] = []
	/** each frame's info as last mirrored (or found already on the server), by session id */
	private sent = new Map<string, string>()
	private queue = new Map<string, Parameters<typeof mirrorSessions>[1][number]>()
	/** the mirror request in flight: they go one at a time, so the server ends up with the latest */
	private sending: Promise<void> | null = null
	private timer = 0
	private retryTimer = 0
	private shown = new WeakMap<KnownSession, { record: Session; live: LiveSession }>()
	private destroyed = false

	constructor(
		private editor: Editor,
		private canvasId: string,
		private mirror: boolean,
	) {
		this.disposers.push(
			liveSessions.retain(),
			() => liveSessions.unwant(this),
			react(() => {
				const wanted = new Map<string, string | undefined>()
				for (const s of Object.values(editor.sessionRecords.get())) if (isOpenCodeSession(s.id)) wanted.set(s.id, s.serverKey)
				// and their parents (and theirs) without frames: a subagent's subagent finds its way to its frame through them
				const known = liveSessions.sessions.get()
				let ids = [...wanted.keys()]
				for (let depth = 0; depth < 4 && ids.length; depth++) {
					const next: string[] = []
					for (const id of ids) {
						const parent = known[id]?.parentId ?? editor.sessionRecords.peek()[id]?.opencode?.parentId
						if (parent && isOpenCodeSession(parent) && !wanted.has(parent)) {
							wanted.set(parent, known[id]?.serverKey)
							next.push(parent)
						}
					}
					ids = next
				}
				liveSessions.want(this, wanted)
			}),
			react(() => this.show(editor.sessionRecords.get(), liveSessions.sessions.get())),
			react(() => {
				const parents: Record<string, string> = {}
				for (const k of Object.values(liveSessions.sessions.get())) if (k.parentId) parents[k.id] = k.parentId
				editor.knownParents.set(parents)
			}),
		)
	}

	destroy() {
		this.destroyed = true
		clearTimeout(this.timer)
		clearTimeout(this.retryTimer)
		for (const d of this.disposers.splice(0)) d()
		this.editor.setLiveSessions({})
	}

	private show(records: Record<string, Session>, known: Record<string, KnownSession>) {
		const live: Record<string, LiveSession> = {}
		for (const [id, record] of Object.entries(records)) {
			const k = known[id]
			if (k && isOpenCodeSession(id)) live[id] = this.liveFor(k, record)
		}
		this.editor.setLiveSessions(live)
		if (this.mirror) this.queueMirror(records, live)
	}

	/**
	 * A frame's session as shown here: what we know, over the canvas's mirror for anything we don't,
	 * unless the mirror is newer (another tab heard about a change first). The same object while
	 * neither changes.
	 */
	private liveFor(k: KnownSession, record: Session): LiveSession {
		const hit = this.shown.get(k)
		if (hit && hit.record.opencode === record.opencode && hit.record.serverKey === record.serverKey) return hit.live
		const { id: _, serverKey, complete, ...info } = k
		const mirrored = record.opencode
		let live: LiveSession
		if (mirrored && record.serverKey === serverKey && (mirrored.updatedAt ?? 0) > (k.updatedAt ?? 0)) {
			live = { ...mirrored, serverKey }
		} else {
			const defined = Object.fromEntries(Object.entries(info).filter(([, v]) => v !== undefined)) as Partial<OpenCodeSessionInfo>
			live = { title: '', ...(complete ? {} : mirrored), ...defined, serverKey }
		}
		this.shown.set(k, { record, live })
		return live
	}

	private queueMirror(records: Record<string, Session>, live: Record<string, LiveSession>) {
		for (const [id, info] of Object.entries(live)) {
			const record = records[id]
			const key = mirrorKey(info.serverKey, info)
			const onServer = record.serverKey && record.opencode ? mirrorKey(record.serverKey, record.opencode) : ''
			if (key === onServer) {
				this.sent.set(id, key)
				continue
			}
			if (this.sent.get(id) === key) continue
			this.sent.set(id, key)
			const { serverKey, ...rest } = info
			this.queue.set(id, { sessionId: id, serverKey, ...rest })
		}
		if (this.queue.size && !this.timer) this.timer = window.setTimeout(() => void this.flushMirror(), MIRROR_DEBOUNCE_MS)
	}

	private async flushMirror() {
		this.timer = 0
		if (this.sending) await this.sending
		const batch = [...this.queue.values()]
		this.queue.clear()
		if (!batch.length || this.destroyed) return
		this.sending = mirrorSessions(this.canvasId, batch).then(
			() => {},
			(e) => {
				console.warn('could not tell the canvas server what OpenCode says about its sessions:', (e as Error).message)
				// (a canvas server from before frames followed OpenCode has no such route: nothing to retry)
				if ((e as { status?: number }).status === 404) return
				for (const s of batch) if (this.sent.get(s.sessionId) === mirrorKey(s.serverKey, s)) this.sent.delete(s.sessionId)
				clearTimeout(this.retryTimer)
				this.retryTimer = window.setTimeout(() => !this.destroyed && this.show(this.editor.sessionRecords.peek(), liveSessions.sessions.peek()), MIRROR_RETRY_MS)
			},
		)
		await this.sending
		this.sending = null
	}
}
