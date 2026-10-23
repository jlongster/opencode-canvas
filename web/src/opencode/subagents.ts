/**
 * The subagents of a canvas's frames, as soon as they exist: not only those that posted something
 * (and so have a frame of their own) but every one running, waiting on an answer, or finished
 * recently, so a fresh load shows them all as orbs on their parent's title.
 *
 * A paired tab asks OpenCode for the children of every shown top-level frame (session.list with
 * parentID) when the page loads, when a frame or a pairing comes along, and whenever a server's
 * event stream (re)connects, then follows the stream: a new child of a shown frame
 * (session.created with its parentID) shows straight away. Each child it shows gets a frame on the
 * canvas server with no items (POST …/subagents, on edit links), so it's a subagent like any
 * other: an orb, a drawer, busy reported for everyone, its OpenCode info mirrored (see live.ts).
 * Finished ones are capped per frame (FINISHED_MAX, the most recent); older ones on the canvas fold
 * into the row's "+N" (see render/subagents/titleOrbs.ts).
 *
 * How each one is doing, after a reload too: busy comes from session.active() and the stream (see
 * LiveSessions.busyFrames); waiting from its pending questions and permission requests, read for
 * every recent child, then the stream's ask events, and reported to the canvas server like busy
 * (`asking`); failed from its last message, then execution events (LiveSessions.setFailed, mirrored
 * as `opencode.failed`).
 */
import type { OpenCodeSessionInfo, Session } from '../../../shared/types'
import type { Editor } from '../editor/Editor'
import { atom, react } from '../state/signals'
import { addSubagents } from '../sync/client'
import { listAsks, parseForm, parsePermission } from './asks'
import { onOpenCodeEvents, type OpenCodeEvent } from './events'
import { isOpenCodeSession, liveSessions } from './live'
import { pairing, pairings, withServer, type OpenCodeClient } from './pairings'

type SessionInfo = Awaited<ReturnType<OpenCodeClient['session']['get']>>

/** each frame's most recent children are listed (newest first)... */
const CHILDREN_LIMIT = 50
/** ...finished ones count when they were active this recently... */
const RECENT_MS = 3 * 60 * 60_000
/** ...and show, at most this many per frame (those on the canvas already included) */
const FINISHED_MAX = 6
/** working or waiting ones all show, up to this many per frame */
const WORKING_MAX = 16
/** the recent children whose pending questions and permission requests are read, per frame */
const ASK_SCAN_MAX = 12
const CONCURRENCY = 6
const REQUEST_MS = 10_000
const SCAN_DEBOUNCE_MS = 30
/** a server's frames aren't listed again on its stream connecting within this long of a listing */
const RESCAN_MS = 3_000

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined)
const setEquals = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((x) => b.has(x))

/** Runs `fn` over `list`, at most `n` at a time. */
async function pool<T>(list: T[], n: number, fn: (x: T) => Promise<void>) {
	let next = 0
	await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
		while (next < list.length) await fn(list[next++])
	}))
}

const infoOf = (s: SessionInfo): OpenCodeSessionInfo => ({
	title: s.title?.trim().replace(/\s+/g, ' ') ?? '',
	...(s.parentID ? { parentId: s.parentID } : {}),
	...(s.agent ? { agent: s.agent } : {}),
	...(s.location?.directory ? { directory: s.location.directory } : {}),
	createdAt: s.time.created,
	updatedAt: s.time.updated,
})

/** One canvas page's frames' subagents, from this tab's paired OpenCode servers. */
export class FrameSubagents {
	/** the subagents waiting on an answer, as this tab's paired servers say (live) */
	readonly asking = atom<ReadonlySet<string>>('subagentsAsking', new Set(), setEquals)
	/** shown top-level frames on paired servers: id → server */
	private parents = new Map<string, string>()
	/** when each frame's children were last listed (performance.now()) */
	private scanned = new Map<string, number>()
	private queued = new Map<string, Set<string>>()
	private timer = 0
	/** pending asks of subagents: ask id → its session */
	private asks = new Map<string, string>()
	/** subagents whose last run's outcome was read (since their server's stream last connected) */
	private checked = new Set<string>()
	/** subagents being given a frame */
	private adding = new Set<string>()
	private streams = new Map<string, () => void>()
	private disposers: (() => void)[] = []
	private destroyed = false

	constructor(
		private editor: Editor,
		private canvasId: string,
		/** edit links give subagents frames on the canvas server */
		private create: boolean,
	) {
		this.disposers.push(
			liveSessions.retain(),
			react(() => {
				const keys = new Set(pairings.get().map((p) => p.key))
				this.parents = topLevel(editor.sessions.get(), editor.families.get().parentOf, liveSessions.sessions.get(), keys)
				this.syncStreams(new Set(this.parents.values()))
				for (const [id, key] of this.parents) if (!this.scanned.has(id)) this.queue(key, id)
				for (const id of [...this.scanned.keys()]) if (!this.parents.has(id)) this.scanned.delete(id)
			}),
		)
	}

	destroy() {
		this.destroyed = true
		clearTimeout(this.timer)
		for (const d of this.disposers.splice(0)) d()
		for (const stop of this.streams.values()) stop()
		this.streams.clear()
	}

	private syncStreams(keys: Set<string>) {
		for (const [key, stop] of this.streams) {
			if (keys.has(key)) continue
			stop()
			this.streams.delete(key)
		}
		for (const key of keys) {
			if (this.streams.has(key)) continue
			this.streams.set(key, onOpenCodeEvents(key, { onEvent: (ev) => this.onEvent(key, ev), onConnect: () => this.onConnect(key) }))
		}
	}

	/** The stream (re)connected: what happened meanwhile is read again. */
	private onConnect(key: string) {
		const now = performance.now()
		for (const [id, k] of this.parents) {
			if (k !== key) continue
			if (now - (this.scanned.get(id) ?? -Infinity) < RESCAN_MS) continue
			for (const kid of this.editor.families.get().kids.get(id) ?? []) this.checked.delete(kid)
			this.queue(key, id)
		}
	}

	private queue(key: string, parentId: string) {
		let set = this.queued.get(key)
		if (!set) this.queued.set(key, (set = new Set()))
		set.add(parentId)
		this.scanned.set(parentId, performance.now())
		if (!this.timer) this.timer = window.setTimeout(() => this.flush(), SCAN_DEBOUNCE_MS)
	}

	private flush() {
		this.timer = 0
		for (const [key, ids] of this.queued) void this.scan(key, [...ids]).catch((e) => console.warn('could not list subagents:', (e as Error).message))
		this.queued.clear()
	}

	/** Lists these frames' children on one server and shows the ones that matter now. */
	private async scan(key: string, parentIds: string[]) {
		const startedAt = performance.now()
		const signal = () => AbortSignal.timeout(REQUEST_MS)
		const { active, lists } = await withServer(key, async (c) => {
			const lists = new Map<string, SessionInfo[]>()
			const [active] = await Promise.all([
				c.session.active({ signal: signal() }),
				pool(parentIds, CONCURRENCY, async (parentID) => {
					const res = await c.session.list({ parentID, limit: CHILDREN_LIMIT, order: 'desc' }, { signal: signal() })
					lists.set(parentID, res.data.filter((s) => !s.time.archived && s.parentID === parentID).sort((a, b) => b.time.updated - a.time.updated))
				}),
			])
			return { active: active as Record<string, unknown>, lists }
		})
		if (this.destroyed) return
		const now = Date.now()
		const recent = new Map<string, SessionInfo[]>()
		for (const [parentId, kids] of lists) recent.set(parentId, kids.filter((s) => s.id in active || now - s.time.updated < RECENT_MS))

		// Who's waiting on an answer: every recent child, working or not.
		const askIds = [...recent.values()].flatMap((kids) => kids.slice(0, ASK_SCAN_MAX).map((s) => s.id))
		const asks = askIds.length ? await listAsks(key, askIds) : []
		if (this.destroyed) return
		if (asks) {
			const read = new Set(askIds)
			for (const [id, sessionId] of this.asks) if (read.has(sessionId)) this.asks.delete(id)
			for (const a of asks) this.asks.set(a.id, a.sessionId)
			this.publishAsking()
		}
		const waiting = new Set(this.asks.values())

		const records = this.editor.sessionRecords.peek()
		const shown: SessionInfo[] = []
		for (const [, kids] of recent) {
			const working = kids.filter((s) => s.id in active || waiting.has(s.id)).slice(0, WORKING_MAX)
			const finished = kids.filter((s) => !working.includes(s))
			let room = FINISHED_MAX - finished.filter((s) => records[s.id]).length
			shown.push(...working, ...finished.filter((s) => records[s.id] || room-- > 0))
		}
		// (and those on the canvas already, whatever they're doing)
		for (const kids of lists.values()) for (const s of kids) if (records[s.id] && !shown.includes(s)) shown.push(s)
		liveSessions.noteSessions(key, shown, startedAt)

		const fresh = shown.filter((s) => !records[s.id])
		if (fresh.length) this.add(key, fresh.map((s) => ({ id: s.id, info: infoOf(s) })))
		await this.checkOutcomes(key, shown.filter((s) => !(s.id in active)).map((s) => s.id))
	}

	/** How their last runs ended (before we were listening): each one's latest message says. */
	private async checkOutcomes(key: string, ids: string[]) {
		const todo = ids.filter((id) => !this.checked.has(id))
		for (const id of todo) this.checked.add(id)
		await withServer(key, (c) =>
			pool(todo, CONCURRENCY, async (sessionID) => {
				const res = await c.message.list({ sessionID, limit: 1, order: 'desc' }, { signal: AbortSignal.timeout(REQUEST_MS) }).catch(() => null)
				const last = res?.data[0] as { type?: string; outcome?: string } | undefined
				if (!res) this.checked.delete(sessionID)
				else if (!this.destroyed && last?.type === 'idle') liveSessions.setFailed(sessionID, last.outcome === 'failed')
			}),
		).catch(() => {})
	}

	/** Gives these subagents frames on the canvas server (edit links only). */
	private add(key: string, list: { id: string; info: OpenCodeSessionInfo }[]) {
		if (!this.create) return
		const todo = list.filter((s) => !this.adding.has(s.id) && !this.editor.sessionRecords.peek()[s.id])
		if (!todo.length) return
		for (const s of todo) this.adding.add(s.id)
		void addSubagents(this.canvasId, todo.map((s) => ({ sessionId: s.id, serverKey: key, ...s.info })))
			.catch((e) => console.warn('could not add subagents to the canvas:', (e as Error).message))
			.finally(() => todo.forEach((s) => this.adding.delete(s.id)))
	}

	private onEvent(key: string, ev: OpenCodeEvent) {
		const data = ev.data ?? {}
		switch (ev.type) {
			case 'session.created': {
				const id = text(data.sessionID)
				const parentId = text(data.parentID)
				if (!id || !parentId || this.parents.get(parentId) !== key) return
				const at = typeof ev.created === 'number' ? ev.created : Date.now()
				const agent = text(data.agent)
				const directory = text((data.location as { directory?: unknown } | undefined)?.directory)
				const title = typeof data.title === 'string' ? data.title.trim().replace(/\s+/g, ' ') : ''
				return this.add(key, [{ id, info: { title, parentId, ...(agent ? { agent } : {}), ...(directory ? { directory } : {}), createdAt: at, updatedAt: at } }])
			}
			case 'form.created':
			case 'permission.asked': {
				const ask = ev.type === 'form.created' ? parseForm(data.form) : parsePermission(data)
				if (!ask || !this.isSubagent(ask.sessionId)) return
				this.asks.set(ask.id, ask.sessionId)
				return this.publishAsking()
			}
			case 'form.replied':
			case 'form.cancelled':
			case 'permission.replied': {
				const id = ev.type === 'permission.replied' ? data.requestID : data.id
				if (typeof id === 'string' && this.asks.delete(id)) this.publishAsking()
				return
			}
			// A session that stopped working isn't waiting on anything any more.
			case 'session.execution.succeeded':
			case 'session.execution.failed':
			case 'session.execution.interrupted':
			case 'session.idle':
			case 'session.deleted': {
				const id = text(data.sessionID)
				let dropped = false
				for (const [askId, sessionId] of this.asks) if (sessionId === id) dropped = this.asks.delete(askId) || dropped
				if (dropped) this.publishAsking()
				return
			}
		}
	}

	private isSubagent(id: string) {
		const parent = liveSessions.sessions.peek()[id]?.parentId ?? this.editor.sessions.peek()[id]?.opencode?.parentId
		return !!parent && (this.parents.has(parent) || this.editor.families.get().parentOf.has(id))
	}

	private publishAsking() {
		this.asking.set(new Set(this.asks.values()))
	}
}

/** The shown top-level frames (not another frame's subagent here) on these servers: id → server. */
function topLevel(sessions: Record<string, Session>, parentOf: ReadonlyMap<string, string>, known: ReturnType<typeof liveSessions.sessions.peek>, keys: Set<string>) {
	const out = new Map<string, string>()
	for (const s of Object.values(sessions)) {
		if (!isOpenCodeSession(s.id) || s.hidden || s.opencode?.deleted || parentOf.has(s.id)) continue
		const key = known[s.id]?.serverKey ?? s.serverKey
		if (key && keys.has(key) && pairing(key)) out.set(s.id, key)
	}
	return out
}
