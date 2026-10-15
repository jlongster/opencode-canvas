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
 * the session works the worm thinks and the assistant's text streams into its speech bubble; the
 * final reply stays up until the next turn or until someone dismisses it.
 */
import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'
import type { ConjuredAgent } from '../../../shared/types'
import { wsUrl } from '../base'
import { onOpenCodeEvents, type OpenCodeEvent } from '../opencode/events'
import { errorText, ownerId, pairing, pairings, withServer } from '../opencode/pairings'
import { react, type Atom } from '../state/signals'
import { updateConjured } from '../sync/client'
import type { PresenceState } from './Presence'

const NAME_MAX = 40
const CHAT_MAX = 2000
const ERROR_MAX = 240
/** streamed text is published at most this often */
const STREAM_PUBLISH_MS = 80
/** an idle session that turns busy again within this long (its next queued turn) keeps thinking */
const IDLE_SETTLE_MS = 600
/** busy/idle is checked against session.active() this often, in case the stream missed something */
const RECONCILE_MS = 30_000
const CHANNEL = 'opencode-canvas-worms'

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

export class WormHost {
	private running = new Map<string, { stop: AbortController; runtime: WormRuntime | null }>()
	private disposers: (() => void)[] = []
	private channel: BroadcastChannel | null = typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null

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
		if (this.channel) {
			this.channel.onmessage = (e: MessageEvent) => {
				const msg = e.data as { type?: string; canvasId?: string; sessionId?: string }
				if (msg?.type === 'dismiss' && msg.canvasId === this.canvasId && msg.sessionId) this.running.get(msg.sessionId)?.runtime?.dismiss()
			}
		}
	}

	/** Clears the worm's reply for everyone, from whichever of this browser's tabs runs it. */
	dismiss(sessionId: string) {
		this.running.get(sessionId)?.runtime?.dismiss()
		this.channel?.postMessage({ type: 'dismiss', canvasId: this.canvasId, sessionId })
	}

	destroy() {
		for (const d of this.disposers.splice(0)) d()
		this.channel?.close()
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
	private idleTimer = 0
	private publishTimer = 0
	private reconcileTimer = 0
	private unwatch: () => void
	private destroyed = false

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

	dismiss() {
		if (this.busy) return
		this.chat = null
		this.chatSent = true
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
			user: { name: wormName(r), color: r.color, agent: true, conjured: true, sessionId: r.sessionId, serverKey: r.serverKey },
			cursor: { x: r.x, y: r.y },
			selection: [],
			view: null,
			chat: this.chat,
			chatSent: this.chatSent,
			speaking: !!this.chat,
			thinking: this.thinking,
		}
		this.provider.awareness.setLocalState(state)
	}

	private schedulePublish() {
		if (!this.publishTimer) this.publishTimer = window.setTimeout(() => this.publish(), STREAM_PUBLISH_MS)
	}

	private onEvent(ev: OpenCodeEvent) {
		const data = ev.data
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
			case 'session.text.started':
			case 'session.text.delta':
			case 'session.text.ended': {
				this.setBusy(true)
				const messageId = String(data.assistantMessageID)
				const ordinal = Number(data.ordinal)
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
				this.chatSent = false
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

	private setBusy(busy: boolean) {
		if (busy) {
			clearTimeout(this.idleTimer)
			this.idleTimer = 0
			if (this.busy) return
			this.busy = true
			this.error = null
			this.messageId = null
			this.blocks.clear()
			this.thinking = true
			this.chat = null
			this.chatSent = true
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
		if (!text) text = await this.lastReply().catch(() => '')
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

	/** Checks the worm against the sessions OpenCode says are running. */
	private async reconcile() {
		const active = await withServer(this.record.serverKey, (c) => c.session.active({ signal: AbortSignal.timeout(10_000) })).catch(() => null)
		if (!active || this.destroyed) return
		this.setBusy(this.record.sessionId in active)
	}

	/** The text of the session's latest assistant message, for when the stream missed it. */
	private async lastReply() {
		const res = await withServer(this.record.serverKey, (c) =>
			c.message.list({ sessionID: this.record.sessionId, limit: 1, order: 'desc', type: 'assistant' }),
		)
		const message = res.data[0] as { type?: string; content?: { type: string; text?: string }[] } | undefined
		if (message?.type !== 'assistant') return ''
		return (message.content ?? [])
			.filter((p) => p.type === 'text')
			.map((p) => p.text ?? '')
			.join('\n\n')
			.trim()
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
