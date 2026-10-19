/**
 * Runs this browser's conjured worms. A worm belongs to the browser that conjured it (its ownerId);
 * while one of that browser's tabs has the canvas open (and its OpenCode is paired there), that tab
 * runs the worm: it talks to OpenCode directly and publishes the worm's presence into the canvas's
 * room, so everyone sees it think and reply. With no such tab the worm sleeps for everyone (see
 * Conjure.sleepers).
 *
 * Each running worm is its own room participant: a read-only y-websocket connection with its own
 * awareness client id, publishing exactly what the canvas server's agents used to (user.conjured,
 * cursor at the worm's position, chat/chatSent/speaking/thinking). So every viewer, and the canvas
 * server's presence API, sees it like any other agent, and it disappears the moment the tab closes.
 *
 * With several tabs of the same browser on the canvas, a Web Lock per worm makes sure only one runs it.
 *
 * Busy/idle comes from OpenCode's event stream (reconciled with session.active() on connect and
 * every RECONCILE_MS), whoever started the work: a prompt from the canvas, the TUI, anything. While
 * the session works the worm thinks and the assistant's text streams into its chat (shown in its
 * prompt box); the final reply stays there until the next turn.
 *
 * Its subagents (child sessions, e.g. from the task tool, and their children) are tracked from the
 * same stream: which are busy is published as `subagents`, and viewers draw a tiny worm for each.
 */
import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'
import type { ConjuredAgent } from '../../../shared/types'
import { wsUrl } from '../base'
import { onOpenCodeEvents, type OpenCodeEvent } from '../opencode/events'
import { errorText, ownerId, pairing, pairings, withServer } from '../opencode/pairings'
import { react, type Atom } from '../state/signals'
import { updateConjured } from '../sync/client'
import type { PresenceState, SubagentInfo } from './Presence'

const NAME_MAX = 40
const CHAT_MAX = 2000
const ERROR_MAX = 240
/** streamed text is published at most this often */
const STREAM_PUBLISH_MS = 80
/** an idle session that turns busy again within this long (its next queued turn) keeps thinking */
const IDLE_SETTLE_MS = 600
/** busy/idle is checked against session.active() this often, in case the stream missed something */
const RECONCILE_MS = 30_000
/** at most this many busy subagents are published (the oldest ones) */
const SUBAGENTS_MAX = 8
const SUBAGENT_TITLE_MAX = 80
const CHILDREN_LIMIT = 50

export function wormName(r: Pick<ConjuredAgent, 'title' | 'sessionId'>) {
	const title = r.title.trim()
	if (!title) return `ses_…${r.sessionId.slice(-6)}`
	return title.length > NAME_MAX ? title.slice(0, NAME_MAX - 1) + '…' : title
}

/** Long replies keep their end: "…" plus the latest CHAT_MAX - 1 characters. */
function capChat(text: string) {
	const chars = Array.from(text)
	return chars.length > CHAT_MAX ? '…' + chars.slice(chars.length - (CHAT_MAX - 1)).join('') : text
}

const short = (text: string) => (text.length > ERROR_MAX ? text.slice(0, ERROR_MAX - 1) + '…' : text)

/** Whether this browser runs the worm: it's ours and its OpenCode is paired here. */
export const runsHere = (r: ConjuredAgent) => r.ownerId === ownerId && !!pairing(r.serverKey)

/**
 * The text of the latest of the session's last `scan` assistant messages that has any (a turn's
 * last steps may be only tool calls), capped like the worm's chat; "" when there's none.
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

export class WormHost {
	private running = new Map<string, { stop: AbortController; runtime: WormRuntime | null }>()
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
		const run = { stop: new AbortController(), runtime: null as WormRuntime | null }
		this.running.set(sessionId, run)
		const hold = () =>
			new Promise<void>((resolve) => {
				if (run.stop.signal.aborted) return resolve()
				const record = this.records.peek().find((r) => r.sessionId === sessionId)
				if (!record) return resolve()
				run.runtime = new WormRuntime(record)
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
		locks.request(`opencode-canvas-worm:${this.canvasId}:${sessionId}`, { signal: run.stop.signal }, hold).catch((e) => {
			if ((e as Error)?.name !== 'AbortError') console.error('worm lock failed', e)
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
}

const subTitle = (title: unknown) => {
	const t = typeof title === 'string' ? title.trim() : ''
	return t.length > SUBAGENT_TITLE_MAX ? t.slice(0, SUBAGENT_TITLE_MAX - 1) + '…' : t
}

/** One worm, running in this tab: its room presence and its OpenCode session's busy/idle and replies. */
class WormRuntime {
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

	constructor(private record: ConjuredAgent) {
		// Read-only: a worm never writes the canvas's document, it only shares presence.
		this.provider = new WebsocketProvider(wsUrl('/api/rooms'), `canvas-${record.canvasId}`, this.doc, { disableBc: true, params: { view: '1' } })
		this.publish()
		this.unwatch = onOpenCodeEvents(record.serverKey, {
			onEvent: (ev) => this.onEvent(ev),
			onConnect: () => void this.reconcile(),
		})
		this.reconcileTimer = window.setInterval(() => void this.reconcile(), RECONCILE_MS)
		void this.reconcile()
	}

	setRecord(record: ConjuredAgent) {
		const moved = record.x !== this.record.x || record.y !== this.record.y || record.title !== this.record.title || record.color !== this.record.color
		this.record = record
		if (moved) this.publish()
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
			user: { name: wormName(r), color: r.color, agent: true, conjured: true, sessionId: r.sessionId, serverKey: r.serverKey },
			cursor: { x: r.x, y: r.y },
			selection: [],
			view: null,
			chat: this.chat,
			chatSent: this.chatSent,
			speaking: !!this.chat,
			thinking: this.thinking,
			...(this.subagents.length ? { subagents: this.subagents } : {}),
		}
		this.provider.awareness.setLocalState(state)
	}

	private schedulePublish() {
		if (!this.publishTimer) this.publishTimer = window.setTimeout(() => this.publish(), STREAM_PUBLISH_MS)
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
		// Something new started meanwhile: that owns the worm now.
		if (this.busy || this.destroyed) return
		this.thinking = false
		const interrupted = error?.startsWith('(interrupted')
		const chat = error ? `${text ? text + '\n\n' : ''}${interrupted ? error : `⚠️ ${short(error)}`}` : text
		this.chat = chat ? capChat(chat) : null
		this.chatSent = true
		this.publish()
		void this.refreshTitle()
	}

	/** Events of other sessions: the worm's subagents starting, working and finishing. */
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
		if (busy) sub.since = Date.now()
		this.publishSubagents()
	}

	/** Publishes the busy subagents, oldest first, if that list changed. */
	private publishSubagents(force = false) {
		const next = [...this.subs.values()]
			.filter((s) => s.busy)
			.sort((a, b) => a.since - b.since || (a.id < b.id ? -1 : 1))
			.slice(0, SUBAGENTS_MAX)
			.map(({ id, title, agent }) => ({ id, title, ...(agent ? { agent } : {}) }))
		if (!force && JSON.stringify(next) === JSON.stringify(this.subagents)) return
		this.subagents = next
		this.schedulePublish()
	}

	/** Checks the worm against the sessions OpenCode says are running. */
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

	/** Lists the worm's children (and the children of busy ones) and marks which are running. */
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
		this.publishSubagents()
	}

	/** Sessions get their title after the first turn: keep the worm's name in step. */
	private async refreshTitle() {
		const s = await withServer(this.record.serverKey, (c) => c.session.get({ sessionID: this.record.sessionId })).catch(() => null)
		const title = s?.title?.trim() || ''
		if (!title || title === this.record.title || this.destroyed) return
		this.setRecord({ ...this.record, title })
		await updateConjured(this.record.canvasId, this.record.sessionId, { title }).catch(() => {})
	}
}
