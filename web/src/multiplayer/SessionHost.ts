/**
 * Runs this browser's conjured sessions. A conjured session belongs to the browser that conjured it
 * (its ownerId); while one of that browser's tabs has the canvas open (and its OpenCode is paired
 * there), that tab runs it: it talks to OpenCode directly and publishes the session's live status
 * into the canvas's room, which every viewer draws on the session frame's status rail (see Rails).
 * With no such tab the session is asleep for everyone.
 *
 * Each running session is its own room participant: a read-only y-websocket connection with its
 * own awareness client id, publishing user.conjured (no cursor, no view), whether it's working
 * (thinking), its reply (chat/chatSent/speaking), its subagents and what it's up to (live). So every
 * viewer, and the canvas server's presence API, sees it, and it's gone the moment the tab closes.
 *
 * With several tabs of the same browser on the canvas, a Web Lock per session makes sure only one runs it.
 *
 * Busy/idle comes from OpenCode's event stream (reconciled with session.active() on connect and
 * every RECONCILE_MS), whoever started the work: a prompt from the canvas, the TUI, anything. While
 * the session works, the step in progress (a tool call, thinking) is published as live.activity
 * and the assistant's text streams into chat; the final reply stays until the next turn.
 *
 * Its subagents (child sessions, e.g. from the task tool, and their children) are tracked from the
 * same stream: running ones, and the ones that finished during the current turn.
 */
import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'
import type { ConjuredAgent } from '../../../shared/types'
import { wsUrl } from '../base'
import { onOpenCodeEvents, type OpenCodeEvent } from '../opencode/events'
import { errorText, ownerId, pairing, pairings, withServer } from '../opencode/pairings'
import { react, type Atom } from '../state/signals'
import { updateConjured } from '../sync/client'
import type { LiveInfo, PresenceState, SubagentInfo } from './Presence'

const NAME_MAX = 40
const CHAT_MAX = 2000
const ERROR_MAX = 240
const ACTIVITY_MAX = 160
/** streamed text is published at most this often */
const STREAM_PUBLISH_MS = 80
/** an idle session that turns busy again within this long (its next queued turn) keeps working */
const IDLE_SETTLE_MS = 600
/** busy/idle is checked against session.active() this often, in case the stream missed something */
const RECONCILE_MS = 30_000
/** at most this many subagents are published: running ones (oldest first), then finished ones */
const SUBAGENTS_MAX = 12
const SUBAGENT_TITLE_MAX = 80
const CHILDREN_LIMIT = 50

export function sessionName(r: Pick<ConjuredAgent, 'title' | 'sessionId'>) {
	const title = r.title.trim()
	if (!title) return `ses_…${r.sessionId.slice(-6)}`
	return title.length > NAME_MAX ? title.slice(0, NAME_MAX - 1) + '…' : title
}

/** Long replies keep their end: "…" plus the latest `max` - 1 characters. */
function capChat(text: string, max = CHAT_MAX) {
	const chars = Array.from(text)
	return chars.length > max ? '…' + chars.slice(chars.length - (max - 1)).join('') : text
}

const short = (text: string, max = ERROR_MAX) => (text.length > max ? text.slice(0, max - 1) + '…' : text)

/** Whether this browser runs the session: it's ours and its OpenCode is paired here. */
export const runsHere = (r: ConjuredAgent) => r.ownerId === ownerId && !!pairing(r.serverKey)

/**
 * The text of the latest of the session's last `scan` assistant messages that has any (a turn's
 * last steps may be only tool calls), capped like the published reply unless `full`; "" when there's none.
 */
export async function lastAssistantText(serverKey: string, sessionId: string, scan = 10, full = false): Promise<string> {
	const res = await withServer(serverKey, (c) => c.message.list({ sessionID: sessionId, limit: scan, order: 'desc', type: 'assistant' }))
	for (const m of res.data as { type?: string; content?: { type: string; text?: string }[] }[]) {
		if (m?.type !== 'assistant') continue
		const text = (m.content ?? [])
			.filter((p) => p.type === 'text')
			.map((p) => p.text ?? '')
			.join('\n\n')
			.trim()
		if (text) return full ? text : capChat(text)
	}
	return ''
}

export class SessionHost {
	private running = new Map<string, { stop: AbortController; runtime: SessionRuntime | null }>()
	private disposers: (() => void)[] = []

	constructor(
		private canvasId: string,
		private records: Atom<ConjuredAgent[]>,
	) {
		this.disposers.push(
			react(() => {
				pairings.get()
				this.sync(this.records.get())
			}),
		)
	}

	destroy() {
		for (const d of this.disposers.splice(0)) d()
		for (const sessionId of [...this.running.keys()]) this.stop(sessionId)
	}

	private sync(records: ConjuredAgent[]) {
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
				run.runtime = new SessionRuntime(record)
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
	/** when it last turned busy */
	since: number
	/** when it last finished (0: not since its parent's turn started) */
	doneAt: number
}

const subTitle = (title: unknown) => {
	const t = typeof title === 'string' ? title.trim() : ''
	return t.length > SUBAGENT_TITLE_MAX ? t.slice(0, SUBAGENT_TITLE_MAX - 1) + '…' : t
}

/** The argument of a tool call that says what it's working on, by how tools usually name it. */
const ACTIVITY_KEYS = ['filePath', 'path', 'command', 'pattern', 'description', 'url', 'query', 'prompt', 'name']

/**
 * A tool call as one short line, like "read web/src/editor/layout.ts" or "bash bun test": the
 * tool's name and its most telling argument, with the session's directory taken off paths.
 */
export function describeTool(name: string, input: Record<string, unknown> | undefined, directory = ''): string {
	let arg = ''
	for (const key of ACTIVITY_KEYS) {
		const v = input?.[key]
		if (typeof v === 'string' && v.trim()) {
			arg = v.trim()
			break
		}
	}
	if (directory && arg.startsWith(directory + '/')) arg = arg.slice(directory.length + 1)
	arg = arg.replace(/\s+/g, ' ')
	return short(arg ? `${name} ${arg}` : name, ACTIVITY_MAX)
}

/** One conjured session, running in this tab: its room presence and its OpenCode session's status and replies. */
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
	private live: LiveInfo = {}
	/** tool names by call id (the call event itself has only the input) */
	private tools = new Map<string, string>()
	private idleTimer = 0
	private publishTimer = 0
	private reconcileTimer = 0
	private reconciling = false
	private unwatch: () => void
	private destroyed = false
	/** descendant sessions (children, grandchildren…), by id */
	private subs = new Map<string, Subagent>()
	private subagents: SubagentInfo[] = []

	constructor(private record: ConjuredAgent) {
		// Read-only: it never writes the canvas's document, it only shares presence.
		this.provider = new WebsocketProvider(wsUrl('/api/rooms'), `canvas-${record.canvasId}`, this.doc, { disableBc: true, params: { view: '1' } })
		this.publish()
		this.unwatch = onOpenCodeEvents(record.serverKey, {
			onEvent: (ev) => this.onEvent(ev),
			onConnect: () => void this.reconcile(),
		})
		this.reconcileTimer = window.setInterval(() => void this.reconcile(), RECONCILE_MS)
		void this.reconcile()
		void this.refreshInfo()
	}

	setRecord(record: ConjuredAgent) {
		const changed = record.title !== this.record.title || record.color !== this.record.color
		this.record = record
		if (changed) this.publish()
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
			user: { name: sessionName(r), color: r.color, agent: true, conjured: true, sessionId: r.sessionId, serverKey: r.serverKey },
			cursor: null,
			selection: [],
			view: null,
			chat: this.chat,
			chatSent: this.chatSent,
			speaking: !!this.chat,
			thinking: this.thinking,
			live: this.live,
			...(this.subagents.length ? { subagents: this.subagents } : {}),
		}
		this.provider.awareness.setLocalState(state)
	}

	private schedulePublish() {
		if (!this.publishTimer) this.publishTimer = window.setTimeout(() => this.publish(), STREAM_PUBLISH_MS)
	}

	private setLive(patch: Partial<LiveInfo>, now = false) {
		const next = { ...this.live, ...patch }
		for (const k of Object.keys(next) as (keyof LiveInfo)[]) if (next[k] === undefined) delete next[k]
		if (JSON.stringify(next) === JSON.stringify(this.live)) return
		this.live = next
		if (now) this.publish()
		else this.schedulePublish()
	}

	private onEvent(ev: OpenCodeEvent) {
		const data = ev.data
		if (data && typeof data.sessionID === 'string' && data.sessionID !== this.record.sessionId) return this.onFamilyEvent(ev.type, data.sessionID, data)
		if (data?.sessionID !== this.record.sessionId) return
		switch (ev.type) {
			case 'session.execution.started':
				return this.setBusy(true)
			case 'session.status': {
				const status = (data.status as { type?: unknown } | undefined)?.type
				if (status === 'busy' || status === 'retry') this.setBusy(true)
				else if (status === 'idle') this.setBusy(false)
				return
			}
			case 'session.step.started': {
				const model = (data.model as { id?: unknown } | undefined)?.id
				return this.setLive({
					...(typeof model === 'string' ? { model } : {}),
					...(typeof data.agent === 'string' ? { agent: data.agent } : {}),
				})
			}
			case 'session.reasoning.started':
				return this.setLive({ activity: 'thinking', replying: undefined })
			case 'session.tool.input.started':
				if (typeof data.id === 'string' && typeof data.name === 'string') this.tools.set(data.id, data.name)
				return this.setLive({ activity: typeof data.name === 'string' ? data.name : undefined, replying: undefined })
			case 'session.tool.called': {
				const name = typeof data.id === 'string' ? this.tools.get(data.id) : undefined
				if (!name) return
				return this.setLive({ activity: describeTool(name, data.input as Record<string, unknown>, this.live.directory), replying: undefined })
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
				// (still replying after the text ends, until the next tool call or thinking, or the turn's end)
				if (this.busy) this.live = { ...this.live, replying: true }
				this.schedulePublish()
				return
			}
			case 'session.execution.failed':
				this.error = errorText(data.error)
				return this.setBusy(false)
			case 'session.execution.interrupted':
				this.error = 'interrupted'
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
			// A new turn: subagents that finished in the last one are forgotten.
			for (const sub of this.subs.values()) sub.doneAt = 0
			this.publishSubagents()
			this.live = { ...this.live, since: Date.now(), activity: 'thinking' }
			delete this.live.error
			delete this.live.endedAt
			this.publish()
		} else if (this.busy && !this.idleTimer) {
			this.idleTimer = window.setTimeout(() => void this.settle(), IDLE_SETTLE_MS)
		}
	}

	/** The turn ended: stop working and show how it ended. */
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
		// Something new started meanwhile: that owns it now.
		if (this.busy || this.destroyed) return
		this.thinking = false
		this.chat = text ? capChat(text) : null
		this.chatSent = true
		const { since: _, replying: __, ...rest } = this.live
		this.live = { ...rest, endedAt: Date.now(), ...(error ? { error: short(error) } : {}) }
		this.publish()
		void this.refreshInfo()
	}

	/** Events of other sessions: the session's subagents starting, working and finishing. */
	private onFamilyEvent(type: string, sessionId: string, data: Record<string, unknown>) {
		if (type === 'session.created') {
			const parentId = typeof data.parentID === 'string' ? data.parentID : ''
			if (parentId !== this.record.sessionId && !this.subs.has(parentId)) return
			if (!this.subs.has(sessionId)) {
				const agent = typeof data.agent === 'string' && data.agent ? data.agent : undefined
				this.subs.set(sessionId, { id: sessionId, parentId, title: subTitle(data.title), ...(agent ? { agent } : {}), busy: false, since: 0, doneAt: 0 })
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
				return this.publishSubagents()
			case 'session.status': {
				const status = (data.status as { type?: unknown } | undefined)?.type
				if (status === 'busy' || status === 'retry') this.setSubBusy(sub, true)
				else if (status === 'idle') this.setSubBusy(sub, false)
				return
			}
			case 'session.execution.started':
			case 'session.step.started':
			case 'session.text.started':
			case 'session.tool.called':
				return this.setSubBusy(sub, true)
			case 'session.execution.succeeded':
			case 'session.execution.failed':
			case 'session.execution.interrupted':
			case 'session.idle':
				return this.setSubBusy(sub, false)
		}
	}

	private setSubBusy(sub: Subagent, busy: boolean) {
		if (sub.busy === busy) return
		sub.busy = busy
		if (busy) {
			sub.since = Date.now()
			sub.doneAt = 0
		} else if (this.busy) sub.doneAt = Date.now()
		this.publishSubagents()
	}

	/** Publishes the running subagents (oldest first) and those done this turn, if that list changed. */
	private publishSubagents(force = false) {
		const all = [...this.subs.values()]
		const running = all.filter((s) => s.busy).sort((a, b) => a.since - b.since || (a.id < b.id ? -1 : 1))
		const done = all.filter((s) => !s.busy && s.doneAt).sort((a, b) => a.doneAt - b.doneAt)
		const next = [...running, ...done].slice(0, SUBAGENTS_MAX).map(({ id, title, agent, since, busy }) => ({
			id,
			title,
			...(agent ? { agent } : {}),
			...(since ? { since } : {}),
			...(busy ? {} : { done: true }),
		}))
		if (!force && JSON.stringify(next) === JSON.stringify(this.subagents)) return
		this.subagents = next
		this.schedulePublish()
	}

	/** Checks the session against the sessions OpenCode says are running. */
	private async reconcile() {
		if (this.reconciling) return
		this.reconciling = true
		const active = await withServer(this.record.serverKey, (c) => c.session.active({ signal: AbortSignal.timeout(10_000) }))
			.catch(() => null)
			.finally(() => (this.reconciling = false))
		if (!active || this.destroyed) return
		this.setBusy(this.record.sessionId in active)
		await this.reconcileSubagents(active)
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
				else this.subs.set(s.id, { id: s.id, parentId, title: subTitle(s.title), ...(s.agent ? { agent: s.agent } : {}), busy: false, since: 0, doneAt: 0 })
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
				else if (this.busy) sub.doneAt = Date.now()
			}
		}
		this.publishSubagents()
	}

	/**
	 * Sessions get their title after the first turn: keep the record's in step. Also picks up what
	 * it runs as (model, agent) and its directory, for the C dialog.
	 */
	private async refreshInfo() {
		const s = await withServer(this.record.serverKey, (c) => c.session.get({ sessionID: this.record.sessionId })).catch(() => null)
		if (!s || this.destroyed) return
		this.setLive({
			...(s.location?.directory ? { directory: s.location.directory } : {}),
			...(s.model?.id && !this.live.model ? { model: s.model.id } : {}),
			...(s.agent && !this.live.agent ? { agent: s.agent } : {}),
		})
		// Just started (the tab opened) with the session idle: show its last reply, from before.
		if (!this.chat && !this.busy && this.replyDone) {
			const text = await lastAssistantText(this.record.serverKey, this.record.sessionId).catch(() => '')
			if (text && !this.chat && !this.busy && !this.destroyed) {
				this.chat = text
				this.chatSent = true
				if (!this.live.endedAt) this.live = { ...this.live, endedAt: s.time.idle ?? s.time.updated }
				this.publish()
			}
		}
		const title = s.title?.trim() || ''
		if (!title || title === this.record.title) return
		this.setRecord({ ...this.record, title })
		await updateConjured(this.record.canvasId, this.record.sessionId, { title }).catch(() => {})
	}
}
