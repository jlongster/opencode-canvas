/**
 * How a canvas's subagents are doing, after a reload too. Only subagents with output show (as orbs
 * on their parent's title, see editor/drawers.ts): those are the ones followed here.
 *
 * Busy comes from session.active() and the stream (see LiveSessions.busyFrames). A paired tab reads
 * the rest for the subagents of every shown top-level frame on its paired servers when they come
 * along (on load, or posting their first item) and whenever a server's event stream (re)connects:
 * waiting from their pending questions and permission requests (the recent ones), then the stream's
 * ask events, reported to the canvas server like busy (`asking`); failed from their last message,
 * then execution events (LiveSessions.setFailed, mirrored as `opencode.failed`).
 */
import type { Session } from '../../../shared/types'
import type { Editor } from '../editor/Editor'
import { atom, react } from '../state/signals'
import { listAsks, parseForm, parsePermission } from './asks'
import { onOpenCodeEvents, type OpenCodeEvent } from './events'
import { isOpenCodeSession, liveSessions } from './live'
import { pairing, pairings, withServer } from './pairings'

/** pending questions and permission requests are read for subagents active this recently... */
const RECENT_MS = 3 * 60 * 60_000
/** ...at most this many (the most recent) per read */
const ASK_SCAN_MAX = 12
const CONCURRENCY = 6
const REQUEST_MS = 10_000
const SCAN_DEBOUNCE_MS = 30
/** a server's subagents aren't read again on its stream connecting within this long of a read */
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

/** One canvas page's frames' subagents, from this tab's paired OpenCode servers. */
export class FrameSubagents {
	/** the subagents waiting on an answer, as this tab's paired servers say (live) */
	readonly asking = atom<ReadonlySet<string>>('subagentsAsking', new Set(), setEquals)
	/** shown top-level frames on paired servers: id → server */
	private parents = new Map<string, string>()
	/** subagents read (since their server's stream last connected) */
	private read = new Set<string>()
	/** when each server's subagents were last read (performance.now()) */
	private readAt = new Map<string, number>()
	private queued = new Map<string, Set<string>>()
	private timer = 0
	/** pending asks of subagents: ask id → its session */
	private asks = new Map<string, string>()
	private streams = new Map<string, () => void>()
	private disposers: (() => void)[] = []
	private destroyed = false

	constructor(private editor: Editor) {
		this.disposers.push(
			liveSessions.retain(),
			react(() => {
				const keys = new Set(pairings.get().map((p) => p.key))
				const { parentOf, kids } = editor.families.get()
				this.parents = topLevel(editor.sessions.get(), parentOf, editor.postedSessions.get(), liveSessions.sessions.get(), keys)
				this.syncStreams(new Set(this.parents.values()))
				for (const [id, key] of this.parents) for (const kid of kids.get(id) ?? []) if (!this.read.has(kid)) this.queue(key, kid)
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
			this.streams.set(key, onOpenCodeEvents(key, { onEvent: (ev) => this.onEvent(ev), onConnect: () => this.onConnect(key) }))
		}
	}

	/** The stream (re)connected: what happened meanwhile is read again. */
	private onConnect(key: string) {
		if (performance.now() - (this.readAt.get(key) ?? -Infinity) < RESCAN_MS) return
		const { kids } = this.editor.families.get()
		for (const [id, k] of this.parents) if (k === key) for (const kid of kids.get(id) ?? []) this.queue(key, kid)
	}

	private queue(key: string, id: string) {
		let set = this.queued.get(key)
		if (!set) this.queued.set(key, (set = new Set()))
		set.add(id)
		this.read.add(id)
		this.readAt.set(key, performance.now())
		if (!this.timer) this.timer = window.setTimeout(() => this.flush(), SCAN_DEBOUNCE_MS)
	}

	private flush() {
		this.timer = 0
		for (const [key, ids] of this.queued) {
			void this.scan(key, [...ids]).catch((e) => {
				for (const id of ids) this.read.delete(id)
				console.warn('could not read subagents:', (e as Error).message)
			})
		}
		this.queued.clear()
	}

	/** Reads whether these subagents (on one server) are waiting on an answer, and how their last runs ended. */
	private async scan(key: string, ids: string[]) {
		const active = (await withServer(key, (c) => c.session.active({ signal: AbortSignal.timeout(REQUEST_MS) }))) as Record<string, unknown>
		if (this.destroyed) return

		// Who's waiting on an answer: the recent ones, working or not.
		const sessions = this.editor.sessions.peek()
		const updatedAt = (id: string) => sessions[id]?.opencode?.updatedAt ?? Date.now()
		const askIds = ids
			.filter((id) => id in active || Date.now() - updatedAt(id) < RECENT_MS)
			.sort((a, b) => updatedAt(b) - updatedAt(a))
			.slice(0, ASK_SCAN_MAX)
		const asks = askIds.length ? await listAsks(key, askIds) : []
		if (this.destroyed) return
		if (asks) {
			const read = new Set(askIds)
			for (const [id, sessionId] of this.asks) if (read.has(sessionId)) this.asks.delete(id)
			for (const a of asks) this.asks.set(a.id, a.sessionId)
			this.publishAsking()
		}
		await this.checkOutcomes(key, ids.filter((id) => !(id in active)))
	}

	/** How their last runs ended (before we were listening): each one's latest message says. */
	private async checkOutcomes(key: string, ids: string[]) {
		await withServer(key, (c) =>
			pool(ids, CONCURRENCY, async (sessionID) => {
				const res = await c.message.list({ sessionID, limit: 1, order: 'desc' }, { signal: AbortSignal.timeout(REQUEST_MS) }).catch(() => null)
				const last = res?.data[0] as { type?: string; outcome?: string } | undefined
				if (!res) this.read.delete(sessionID)
				else if (!this.destroyed && last?.type === 'idle') liveSessions.setFailed(sessionID, last.outcome === 'failed')
			}),
		).catch(() => {})
	}

	private onEvent(ev: OpenCodeEvent) {
		const data = ev.data ?? {}
		switch (ev.type) {
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

	/** (one without output too: it may post its first item while it waits) */
	private isSubagent(id: string) {
		const parent = liveSessions.sessions.peek()[id]?.parentId ?? this.editor.sessions.peek()[id]?.opencode?.parentId
		return !!parent && (this.parents.has(parent) || this.editor.families.get().parentOf.has(id))
	}

	private publishAsking() {
		this.asking.set(new Set(this.asks.values()))
	}
}

/** The shown top-level frames (not another frame's subagent here) on these servers: id → server. */
function topLevel(
	sessions: Record<string, Session>,
	parentOf: ReadonlyMap<string, string>,
	posted: ReadonlySet<string>,
	known: ReturnType<typeof liveSessions.sessions.peek>,
	keys: Set<string>,
) {
	const out = new Map<string, string>()
	for (const s of Object.values(sessions)) {
		if (!isOpenCodeSession(s.id) || s.hidden || s.opencode?.deleted || parentOf.has(s.id)) continue
		// (a subagent with no output isn't shown)
		if (s.opencode?.parentId && !posted.has(s.id)) continue
		const key = known[s.id]?.serverKey ?? s.serverKey
		if (key && keys.has(key) && pairing(key)) out.set(s.id, key)
	}
	return out
}
