/**
 * Runs this browser's linked sessions. A link belongs to the browser that made it (its ownerId);
 * while one of that browser's tabs has the canvas open (and its OpenCode is paired there), that tab
 * runs the session: it talks to OpenCode directly and shares the session's live state through the
 * canvas's room, so everyone sees it reply. With no such tab the link is offline. (Whether it's
 * working, the busy band, is reported for every frame, linked or not: see opencode/live.ts.)
 *
 * Each running session is its own room participant: a read-only y-websocket connection with its own
 * awareness client id and no pointer, publishing user.agent + sessionId, chat/chatSent/speaking
 * (the streaming reply, shown in the frame's prompt bubbles), thinking, subagents and asking. It
 * disappears the moment the tab closes.
 *
 * With several tabs of the same browser on the canvas, a Web Lock per session makes sure only one runs it.
 *
 * Busy/idle comes from OpenCode's event stream (reconciled with session.active() on connect and
 * every RECONCILE_MS), whoever started the work: a prompt from the canvas, the TUI, anything. While
 * the session works the assistant's text streams into its chat; the final reply stays there until
 * the next turn.
 *
 * Its subagents (child sessions, e.g. from the task tool, and their children) are tracked from the
 * same stream: which are busy is published as `subagents`.
 *
 * So are the questions (its question tool: OpenCode forms) and tool permission requests the session
 * and its subagents are waiting on (see asks.ts), reconciled with OpenCode's pending lists like
 * busy/idle: while any are, `asking` says so, and the frame calls for its owner to answer.
 */
import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'
import type { Session, SessionLink } from '../../../shared/types'
import { wsUrl } from '../base'
import { askCount, askText, listAsks, parseForm, parsePermission, type Ask } from '../opencode/asks'
import { onOpenCodeEvents, type OpenCodeEvent } from '../opencode/events'
import { errorText, ownerId, pairing, pairings, withServer } from '../opencode/pairings'
import { react, type Atom } from '../state/signals'
import { markDelivered } from '../sync/client'
import type { AskingInfo, PresenceState, SubagentInfo } from './Presence'

const NAME_MAX = 40
const CHAT_MAX = 2000
const ERROR_MAX = 240
/** streamed text is published at most this often */
const STREAM_PUBLISH_MS = 80
/** an idle session that turns busy again within this long (its next queued turn) keeps working */
const IDLE_SETTLE_MS = 600
/** busy/idle is checked against session.active() this often, in case the stream missed something */
const RECONCILE_MS = 30_000
/** at most this many busy subagents are published (the oldest ones) */
const SUBAGENTS_MAX = 8
const SUBAGENT_TITLE_MAX = 80
const CHILDREN_LIMIT = 50

/** A session's name for its live state in the room: its frame's title (OpenCode's), else a short id. */
export function sessionName(sessionId: string, title: string) {
	const t = title.trim()
	if (!t || t === sessionId) return `ses_…${sessionId.slice(-6)}`
	return t.length > NAME_MAX ? t.slice(0, NAME_MAX - 1) + '…' : t
}

/** Long replies keep their end: "…" plus the latest CHAT_MAX - 1 characters. */
function capChat(text: string) {
	const chars = Array.from(text)
	return chars.length > CHAT_MAX ? '…' + chars.slice(chars.length - (CHAT_MAX - 1)).join('') : text
}

const short = (text: string) => (text.length > ERROR_MAX ? text.slice(0, ERROR_MAX - 1) + '…' : text)

/** Whether this browser runs the session: its link is ours and its OpenCode is paired here. */
export const runsHere = (r: SessionLink) => r.ownerId === ownerId && !!pairing(r.serverKey)

/**
 * The text of the latest of the session's last `scan` assistant messages that has any (a turn's
 * last steps may be only tool calls), capped like the shared chat; "" when there's none.
 */
export async function lastAssistantText(serverKey: string, sessionId: string, scan = 10): Promise<string> {
	const res = await withServer(serverKey, (c) => c.message.list({ sessionID: sessionId, limit: scan, order: 'desc', type: 'assistant' }))
	for (const m of res.data as { type?: string; content?: { type: string; text?: string }[] }[]) {
		if (m?.type !== 'assistant') continue
		const text = (m.content ?? [])
			.filter((p) => p.type === 'text')
			.map((p) => p.text ?? '')
			.join('\n\n')
			.trim()
		if (text) return capChat(text)
	}
	return ''
}

export class SessionHost {
	private running = new Map<string, { stop: AbortController; runtime: SessionRuntime | null }>()
	private disposers: (() => void)[] = []

	constructor(
		private canvasId: string,
		private records: Atom<SessionLink[]>,
		/** the canvas's frames as shown, titled after their OpenCode sessions (see opencode/live.ts) */
		private frames: Atom<Record<string, Session>>,
	) {
		this.disposers.push(
			react(() => {
				pairings.get()
				this.sync(this.records.get())
			}),
			// A renamed session's live state takes its new name.
			react(() => {
				const frames = this.frames.get()
				for (const [sessionId, run] of this.running) run.runtime?.setName(frames[sessionId]?.title ?? '')
			}),
		)
	}

	destroy() {
		for (const d of this.disposers.splice(0)) d()
		for (const sessionId of [...this.running.keys()]) this.stop(sessionId)
	}

	private sync(records: SessionLink[]) {
		const wanted = new Map(records.filter(runsHere).map((r) => [r.sessionId, r]))
		for (const sessionId of [...this.running.keys()]) if (!wanted.has(sessionId)) this.stop(sessionId)
		for (const [sessionId, record] of wanted) {
			const run = this.running.get(sessionId)
			if (run) run.runtime?.setRecord(record)
			else this.start(sessionId)
		}
	}

	private start(sessionId: string) {
		const run = { stop: new AbortController(), runtime: null as SessionRuntime | null }
		this.running.set(sessionId, run)
		const hold = () =>
			new Promise<void>((resolve) => {
				if (run.stop.signal.aborted) return resolve()
				const record = this.records.peek().find((r) => r.sessionId === sessionId)
				if (!record) return resolve()
				run.runtime = new SessionRuntime(this.canvasId, record, this.frames.peek()[sessionId]?.title ?? '')
				run.stop.signal.addEventListener('abort', () => {
					run.runtime?.destroy()
					run.runtime = null
					resolve()
				})
			})
		const locks = (navigator as Navigator & { locks?: LockManager }).locks
		if (!locks) {
			hold()
			return
		}
		// Released when we stop (or the tab closes); another tab of ours waiting for it takes over then.
		locks.request(`opencode-canvas-session:${this.canvasId}:${sessionId}`, { signal: run.stop.signal }, hold).catch((e) => {
			if ((e as Error)?.name !== 'AbortError') console.error('session lock failed', e)
		})
	}

	private stop(sessionId: string) {
		const run = this.running.get(sessionId)
		if (!run) return
		this.running.delete(sessionId)
		run.stop.abort()
	}
}

interface Subagent extends SubagentInfo {
	parentId: string
	busy: boolean
	/** its last run failed */
	failed?: boolean
	/** how its last run ended has been read from OpenCode (events say from then on) */
	checked?: boolean
	/** when it last turned busy */
	since: number
}

const subTitle = (title: unknown) => {
	const t = typeof title === 'string' ? title.trim() : ''
	return t.length > SUBAGENT_TITLE_MAX ? t.slice(0, SUBAGENT_TITLE_MAX - 1) + '…' : t
}

/** One linked session, running in this tab: its status, its live state in the room, and its replies. */
class SessionRuntime {
	private doc = new Y.Doc()
	private provider: WebsocketProvider
	private chat: string | null = null
	private chatSent = true
	private thinking = false
	/** the session is working (from events or session.active()) */
	private busy = false
	private error: string | null = null
	/** the assistant message (step) whose text is showing, and its text blocks by ordinal */
	private messageId: string | null = null
	private blocks = new Map<number, string>()
	/** the text showing is a finished turn's reply (or there's none yet) */
	private replyDone = true
	private idleTimer = 0
	private publishTimer = 0
	private reconcileTimer = 0
	private reconciling = false
	private unwatch: () => void
	private destroyed = false
	/** descendant sessions (children, grandchildren…), by id */
	private subs = new Map<string, Subagent>()
	private subagents: SubagentInfo[] = []
	private failedSubagents: string[] = []
	/** questions and permission requests it (or a subagent) waits on, by id, in the order they came */
	private asks = new Map<string, Ask>()
	private asking: AskingInfo | null = null
	/** while its pending lists are being read: what events said meanwhile (those win over the lists) */
	private askEvents: { added: Map<string, Ask>; gone: Set<string> } | null = null

	constructor(
		private canvasId: string,
		private record: SessionLink,
		/** its frame's title */
		private title: string,
	) {
		// Read-only: it never writes the canvas's document, it only shares live state.
		this.provider = new WebsocketProvider(wsUrl('/api/rooms'), `canvas-${record.canvasId}`, this.doc, { disableBc: true, params: { view: '1' } })
		this.publish()
		this.unwatch = onOpenCodeEvents(record.serverKey, {
			onEvent: (ev) => this.onEvent(ev),
			onConnect: () => void this.reconcile(),
		})
		this.reconcileTimer = window.setInterval(() => void this.reconcile(), RECONCILE_MS)
		void this.reconcile()
	}

	setRecord(record: SessionLink) {
		const changed = record.color !== this.record.color
		this.record = record
		if (changed) this.publish()
	}

	setName(title: string) {
		if (title === this.title) return
		this.title = title
		this.publish()
	}

	destroy() {
		this.destroyed = true
		this.unwatch()
		clearTimeout(this.idleTimer)
		clearTimeout(this.publishTimer)
		clearInterval(this.reconcileTimer)
		this.provider.awareness.setLocalState(null)
		this.provider.destroy()
		this.doc.destroy()
	}

	private publish() {
		clearTimeout(this.publishTimer)
		this.publishTimer = 0
		if (this.destroyed) return
		const r = this.record
		const state: PresenceState = {
			user: { name: sessionName(r.sessionId, this.title), color: r.color, agent: true, sessionId: r.sessionId, serverKey: r.serverKey },
			cursor: null,
			selection: [],
			view: null,
			chat: this.chat,
			chatSent: this.chatSent,
			speaking: !!this.chat,
			thinking: this.thinking,
			...(this.subagents.length ? { subagents: this.subagents } : {}),
			...(this.failedSubagents.length ? { failedSubagents: this.failedSubagents } : {}),
			...(this.asking ? { asking: this.asking } : {}),
		}
		this.provider.awareness.setLocalState(state)
	}

	private schedulePublish() {
		if (!this.publishTimer) this.publishTimer = window.setTimeout(() => this.publish(), STREAM_PUBLISH_MS)
	}

	private onEvent(ev: OpenCodeEvent) {
		const data = ev.data
		if (data && this.onAskEvent(ev.type, data)) return
		if (data && typeof data.sessionID === 'string' && data.sessionID !== this.record.sessionId) return this.onFamilyEvent(ev.type, data.sessionID, data)
		if (data?.sessionID !== this.record.sessionId) return
		switch (ev.type) {
			case 'session.execution.started':
				return this.setBusy(true)
			// What it was given before is gone from its context: the media people added to its frame
			// goes again with the next prompt (see Item.delivered).
			case 'session.compaction.ended':
				void markDelivered(this.canvasId, this.record.sessionId, { clear: true }).catch(() => {})
				return
			case 'session.status': {
				const status = (data.status as { type?: unknown } | undefined)?.type
				if (status === 'busy' || status === 'retry') this.setBusy(true)
				else if (status === 'idle') this.setBusy(false)
				return
			}
			// Text never says whether the session is working (a turn often says something and carries
			// on with tools and more steps): only status and execution events, and session.active(), do.
			case 'session.text.started':
			case 'session.text.delta':
			case 'session.text.ended': {
				// We missed this turn starting: ask OpenCode whether it's running.
				if (!this.busy) void this.reconcile()
				const messageId = String(data.assistantMessageID)
				const ordinal = Number(data.ordinal)
				if (this.replyDone) this.clearText()
				if (this.messageId !== messageId) {
					// a new step with text: it replaces what the previous one said
					this.messageId = messageId
					this.blocks.clear()
				}
				const prev = this.blocks.get(ordinal) ?? ''
				this.blocks.set(
					ordinal,
					ev.type === 'session.text.delta' ? prev + String(data.delta ?? '') : ev.type === 'session.text.ended' ? String(data.text ?? prev) : prev,
				)
				const text = this.text()
				this.chat = text ? capChat(text) : null
				// still coming while the session works; settle() marks the final reply sent
				this.chatSent = !this.busy
				this.schedulePublish()
				return
			}
			case 'session.execution.failed':
				this.error = errorText(data.error)
				return this.setBusy(false)
			case 'session.execution.interrupted':
				this.error = `(interrupted: ${String(data.reason ?? 'interrupted')})`
				return this.setBusy(false)
			case 'session.execution.succeeded':
			case 'session.idle':
				return this.setBusy(false)
		}
	}

	private text() {
		return [...this.blocks.entries()]
			.sort(([a], [b]) => a - b)
			.map(([, t]) => t)
			.join('\n\n')
			.trim()
	}

	/** Forgets the shown text, for a new turn's. */
	private clearText() {
		this.replyDone = false
		this.messageId = null
		this.blocks.clear()
		this.chat = null
		this.chatSent = true
	}

	private setBusy(busy: boolean) {
		if (busy) {
			clearTimeout(this.idleTimer)
			this.idleTimer = 0
			if (this.busy) return
			this.busy = true
			this.error = null
			// The last turn's reply goes; text this turn already streamed (before we knew it was busy) stays.
			if (this.replyDone) this.clearText()
			this.thinking = true
			this.chatSent = !this.chat
			this.publish()
		} else if (this.busy && !this.idleTimer) {
			this.idleTimer = window.setTimeout(() => void this.settle(), IDLE_SETTLE_MS)
		}
	}

	/** The turn ended: stop thinking and show how it ended. */
	private async settle() {
		this.idleTimer = 0
		if (!this.busy) return
		this.busy = false
		const error = this.error
		this.error = null
		let text = this.text()
		// what's showing is now the final reply: the next turn's text replaces it
		this.replyDone = true
		// just this turn's last message: an earlier one could be a previous turn's
		if (!text) text = await lastAssistantText(this.record.serverKey, this.record.sessionId, 1).catch(() => '')
		// Something new started meanwhile: that owns the chat now.
		if (this.busy || this.destroyed) return
		this.thinking = false
		this.dropAsks(this.record.sessionId)
		const interrupted = error?.startsWith('(interrupted')
		const chat = error ? `${text ? text + '\n\n' : ''}${interrupted ? error : `⚠️ ${short(error)}`}` : text
		this.chat = chat ? capChat(chat) : null
		this.chatSent = true
		this.publish()
	}

	/** Questions and permission requests coming and going (true when it was one, ours or not). */
	private onAskEvent(type: string, data: Record<string, unknown>): boolean {
		const ours = (sessionId: unknown) => sessionId === this.record.sessionId || (typeof sessionId === 'string' && this.subs.has(sessionId))
		switch (type) {
			case 'form.created':
			case 'permission.asked': {
				const ask = type === 'form.created' ? parseForm(data.form) : parsePermission(data)
				if (ask && ours(ask.sessionId)) {
					this.asks.set(ask.id, ask)
					this.askEvents?.added.set(ask.id, ask)
					this.publishAsking()
				}
				return true
			}
			case 'form.replied':
			case 'form.cancelled':
			case 'permission.replied': {
				const id = type === 'permission.replied' ? data.requestID : data.id
				if (typeof id !== 'string') return true
				this.askEvents?.gone.add(id)
				this.askEvents?.added.delete(id)
				if (this.asks.delete(id)) this.publishAsking()
				return true
			}
		}
		return false
	}

	/** A session that stopped working isn't waiting on anything any more. */
	private dropAsks(sessionId: string) {
		let dropped = false
		for (const [id, a] of this.asks) if (a.sessionId === sessionId) dropped = this.asks.delete(id) || dropped
		if (dropped) this.publishAsking()
	}

	/** Publishes what it's asking, if that changed. */
	private publishAsking() {
		const asks = [...this.asks.values()]
		const next: AskingInfo | null = asks.length
			? {
					kind: asks.some((a) => a.kind === 'question') ? 'question' : 'permission',
					count: askCount(asks),
					text: askText(asks.find((a) => a.kind === 'question') ?? asks[0]),
					sessions: [...new Set(asks.map((a) => a.sessionId))],
				}
			: null
		if (JSON.stringify(next) === JSON.stringify(this.asking)) return
		this.asking = next
		this.publish()
	}

	/** Checks its asks against OpenCode's pending lists, for it and its busy subagents. */
	private async reconcileAsks(active: Record<string, unknown>) {
		const ids = [this.record.sessionId, ...[...this.subs.values()].filter((s) => s.id in active).map((s) => s.id)]
		const events = (this.askEvents = { added: new Map(), gone: new Set() })
		const asks = await listAsks(this.record.serverKey, ids)
		if (this.askEvents === events) this.askEvents = null
		if (!asks || this.destroyed) return
		// (sessions not listed, idle subagents, can't be waiting on anything)
		this.asks = new Map([...asks.filter((a) => !events.gone.has(a.id)).map((a) => [a.id, a] as const), ...events.added])
		this.publishAsking()
	}

	/** Events of other sessions: its subagents starting, working and finishing. */
	private onFamilyEvent(type: string, sessionId: string, data: Record<string, unknown>) {
		if (type === 'session.created') {
			const parentId = typeof data.parentID === 'string' ? data.parentID : ''
			if (parentId !== this.record.sessionId && !this.subs.has(parentId)) return
			if (!this.subs.has(sessionId)) {
				const agent = typeof data.agent === 'string' && data.agent ? data.agent : undefined
				this.subs.set(sessionId, { id: sessionId, parentId, title: subTitle(data.title), ...(agent ? { agent } : {}), busy: false, since: 0 })
			}
			return
		}
		const sub = this.subs.get(sessionId)
		if (!sub) return
		switch (type) {
			case 'session.renamed':
				sub.title = subTitle(data.title)
				return this.publishSubagents(true)
			case 'session.deleted':
				this.subs.delete(sessionId)
				this.dropAsks(sessionId)
				return this.publishSubagents()
			case 'session.status': {
				const status = (data.status as { type?: unknown } | undefined)?.type
				if (status === 'busy' || status === 'retry') this.setSubBusy(sub, true)
				else if (status === 'idle') this.setSubBusy(sub, false)
				return
			}
			case 'session.execution.started':
				sub.failed = false
				return this.setSubBusy(sub, true, true)
			case 'session.step.started':
			case 'session.text.started':
			case 'session.tool.called':
				return this.setSubBusy(sub, true)
			case 'session.execution.failed':
				sub.failed = true
				return this.setSubBusy(sub, false, true)
			case 'session.execution.succeeded':
			case 'session.execution.interrupted':
			case 'session.idle':
				return this.setSubBusy(sub, false)
		}
	}

	private setSubBusy(sub: Subagent, busy: boolean, changed = false) {
		if (sub.busy === busy) {
			if (changed) this.publishSubagents()
			return
		}
		sub.busy = busy
		if (busy) sub.since = Date.now()
		else this.dropAsks(sub.id)
		this.publishSubagents()
	}

	/** Publishes the busy subagents, oldest first, if that list changed. */
	private publishSubagents(force = false) {
		const next = [...this.subs.values()]
			.filter((s) => s.busy)
			.sort((a, b) => a.since - b.since || (a.id < b.id ? -1 : 1))
			.slice(0, SUBAGENTS_MAX)
			.map(({ id, title, agent }) => ({ id, title, ...(agent ? { agent } : {}) }))
		const failed = [...this.subs.values()].filter((s) => s.failed && !s.busy).map((s) => s.id)
		if (!force && JSON.stringify(next) === JSON.stringify(this.subagents) && JSON.stringify(failed) === JSON.stringify(this.failedSubagents)) return
		this.subagents = next
		this.failedSubagents = failed
		this.schedulePublish()
	}

	/** How subagents' last runs ended (before we were listening): its latest message says, once per subagent. */
	private async checkOutcomes(subs: Subagent[]) {
		await Promise.all(
			subs.slice(0, CHILDREN_LIMIT).map(async (sub) => {
				sub.checked = true
				const res = await withServer(this.record.serverKey, (c) => c.message.list({ sessionID: sub.id, limit: 1, order: 'desc' }, { signal: AbortSignal.timeout(10_000) })).catch(() => null)
				const last = res?.data[0] as { type?: string; outcome?: string } | undefined
				if (last?.type === 'idle' && !sub.busy) sub.failed = last.outcome === 'failed'
			}),
		)
	}

	/** Checks the session against the ones OpenCode says are running. */
	private async reconcile() {
		if (this.reconciling) return
		this.reconciling = true
		const active = await withServer(this.record.serverKey, (c) => c.session.active({ signal: AbortSignal.timeout(10_000) }))
			.catch(() => null)
			.finally(() => (this.reconciling = false))
		if (!active || this.destroyed) return
		this.setBusy(this.record.sessionId in active)
		await this.reconcileSubagents(active)
		await this.reconcileAsks(active)
	}

	/** Lists the session's children (and the children of busy ones) and marks which are running. */
	private async reconcileSubagents(active: Record<string, unknown>) {
		const list = (parentId: string) =>
			withServer(this.record.serverKey, (c) => c.session.list({ parentID: parentId, limit: CHILDREN_LIMIT, order: 'desc' }, { signal: AbortSignal.timeout(10_000) }))
				.then((res) => res.data)
				.catch(() => null)
		const seen = new Set<string>()
		const add = (parentId: string, sessions: Awaited<ReturnType<typeof list>>) => {
			for (const s of sessions ?? []) {
				seen.add(s.id)
				const sub = this.subs.get(s.id)
				if (sub) sub.title = subTitle(s.title)
				else this.subs.set(s.id, { id: s.id, parentId, title: subTitle(s.title), ...(s.agent ? { agent: s.agent } : {}), busy: false, since: 0 })
			}
		}
		const children = await list(this.record.sessionId)
		if (!children || this.destroyed) return
		add(this.record.sessionId, children)
		const busyChildren = children.filter((s) => s.id in active)
		const grandchildren = await Promise.all(busyChildren.map((s) => list(s.id)))
		if (this.destroyed) return
		busyChildren.forEach((s, i) => add(s.id, grandchildren[i]))
		for (const sub of this.subs.values()) {
			// Gone from a listing we have (children; grandchildren of busy children): deleted.
			const listed = sub.parentId === this.record.sessionId || busyChildren.some((c) => c.id === sub.parentId)
			if (listed && !seen.has(sub.id)) {
				this.subs.delete(sub.id)
				continue
			}
			const busy = sub.id in active
			if (sub.busy !== busy) {
				sub.busy = busy
				if (busy) sub.since = Date.now()
			}
		}
		await this.checkOutcomes([...this.subs.values()].filter((s) => !s.busy && !s.checked))
		if (this.destroyed) return
		this.publishSubagents()
	}
}
