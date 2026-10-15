/**
 * Conjured worms: real OpenCode sessions brought onto a canvas as worms people can talk to. Each
 * one (at most one per session per canvas) sits still at its page position, present in the
 * canvas's room like an MCP agent (see ServerPresence), and stays as long as it's conjured, across
 * room reloads and server restarts (the records are saved in data/index.json).
 *
 * Prompting one sends the text to its session; while the session works the worm is `thinking`,
 * and the assistant's reply streams into its chat (chatSent false while streaming, speaking so
 * browsers draw a speech bubble). The finished reply stays up until the next prompt or until
 * someone dismisses it.
 *
 * Work started anywhere else (the TUI, another client) shows too: OpenCode's shared event stream
 * tells us when each conjured session turns busy or idle (reconciled with session.active() on
 * connect and every RECONCILE_MS, so it can't get stuck), the worm thinks meanwhile, and the
 * turn's final text shows when it's done.
 *
 * People on edit links can drag a worm somewhere else (move), which moves its presence cursor.
 */
import type { ConjuredAgent } from '../shared/types'
import { errorText, onOpenCodeEvents, opencode, OpenCodeUnavailable, withOpenCode, type OpenCodeClient, type OpenCodeEvent } from './opencode'
import { SERVER_PRESENCE_RENEW_MS, ServerPresence } from './presence'

export class ConjureError extends Error {
	constructor(public status: number, message: string) {
		super(message)
	}
}

export interface ConjuredDeps {
	canvasExists(id: string): boolean
	canvasTitle(id: string): string
	/** persists the index (which reads all() for its conjured records) */
	save(): void
}

const SESSION_ID = /^ses_[A-Za-z0-9]{26}$/
const COLORS = ['#f472b6', '#a78bfa', '#fb923c', '#4ade80', '#facc15', '#f87171', '#60a5fa', '#2dd4bf', '#e879f9', '#a3e635']
const NAME_MAX = 40
const CHAT_MAX = 2000
const PROMPT_MAX = 20_000
const ERROR_MAX = 240
/** streamed text is published at most this often */
const STREAM_PUBLISH_MS = 80
const CONNECT_MS = 10_000
/** a dropped event stream is resumed this many times while the session still runs */
const RESUBSCRIBE_TRIES = 5
/** an idle session that turns busy again within this long (its next queued turn) keeps thinking */
const IDLE_SETTLE_MS = 600
/** busy/idle is checked against session.active() this often, in case the stream missed something */
const RECONCILE_MS = 30_000
/** a canvas prompt's session can still be listed active this long after its run ends */
const RUN_LINGER_MS = 5000

interface Run {
	abort: AbortController
	/** the assistant message (step) whose text is showing, and its text blocks by ordinal */
	messageId: string | null
	blocks: Map<number, string>
}

interface Worm {
	record: ConjuredAgent
	presence: ServerPresence
	chat: string | null
	chatSent: boolean
	thinking: boolean
	run: Run | null
	/** its session is busy with work started somewhere other than this canvas */
	external: boolean
	/** that work failed, with this error */
	externalError: string | null
	idleTimer?: Timer
	runEndedAt: number
	publishTimer?: Timer
}

const key = (canvasId: string, sessionId: string) => `${canvasId}/${sessionId}`

export function colorFor(sessionId: string) {
	let h = 0
	for (const ch of sessionId) h = (h * 31 + ch.charCodeAt(0)) >>> 0
	return COLORS[h % COLORS.length]
}

function displayName(r: ConjuredAgent) {
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

export function createConjured(deps: ConjuredDeps, stored: ConjuredAgent[]) {
	const worms = new Map<string, Worm>()
	let unwatch: (() => void) | null = null
	let reconcileTimer: Timer | undefined

	function add(record: ConjuredAgent) {
		const w: Worm = {
			record,
			presence: new ServerPresence(record.canvasId),
			chat: null,
			chatSent: true,
			thinking: false,
			run: null,
			external: false,
			externalError: null,
			runEndedAt: 0,
		}
		worms.set(key(record.canvasId, record.sessionId), w)
		syncWatch()
		return w
	}

	async function publish(w: Worm) {
		clearTimeout(w.publishTimer)
		w.publishTimer = undefined
		if (worms.get(key(w.record.canvasId, w.record.sessionId)) !== w) return
		if (!deps.canvasExists(w.record.canvasId)) return drop(w)
		const r = w.record
		await w.presence.set({
			user: { name: displayName(r), color: r.color, agent: true, conjured: true, sessionId: r.sessionId },
			cursor: { x: r.x, y: r.y },
			selection: [],
			view: null,
			chat: w.chat,
			chatSent: w.chatSent,
			speaking: !!w.chat,
			thinking: w.thinking,
		})
	}

	function schedulePublish(w: Worm) {
		w.publishTimer ??= setTimeout(() => publish(w).catch(() => {}), STREAM_PUBLISH_MS)
	}

	function drop(w: Worm) {
		const k = key(w.record.canvasId, w.record.sessionId)
		if (worms.get(k) !== w) return
		worms.delete(k)
		clearTimeout(w.publishTimer)
		clearTimeout(w.idleTimer)
		w.run?.abort.abort()
		w.run = null
		w.presence.leave().catch((e) => console.error('conjured worm leave failed:', e))
		deps.save()
		syncWatch()
	}

	function get(canvasId: string, sessionId: string): Worm {
		const w = worms.get(key(canvasId, sessionId))
		if (!w) throw new ConjureError(404, `no conjured worm for ${sessionId} on this canvas`)
		return w
	}

	// Bring back the saved worms, and keep everyone's presence fresh.
	for (const record of stored) if (deps.canvasExists(record.canvasId)) add(record)
	for (const w of worms.values()) publish(w).catch((e) => console.error('conjured worm presence failed:', e))
	setInterval(() => {
		for (const w of worms.values()) if (!w.publishTimer) publish(w).catch(() => {})
	}, SERVER_PRESENCE_RENEW_MS)

	// ---------- busy / idle, wherever the work comes from ----------

	/** Follows OpenCode's events while any worm is conjured. */
	function syncWatch() {
		if (worms.size > 0 && !unwatch) {
			unwatch = onOpenCodeEvents({ onEvent, onConnect: () => reconcile().catch(() => {}) })
			reconcileTimer = setInterval(() => reconcile().catch(() => {}), RECONCILE_MS)
		} else if (worms.size === 0 && unwatch) {
			unwatch()
			unwatch = null
			clearInterval(reconcileTimer)
		}
	}

	function onEvent(ev: OpenCodeEvent) {
		const sessionId = ev.data?.sessionID
		if (typeof sessionId !== 'string') return
		let busy: boolean | null = null
		switch (ev.type) {
			case 'session.execution.started':
				busy = true
				break
			case 'session.status': {
				const status = (ev.data?.status as { type?: unknown } | undefined)?.type
				busy = status === 'busy' || status === 'retry' ? true : status === 'idle' ? false : null
				break
			}
			case 'session.execution.failed':
			case 'session.execution.succeeded':
			case 'session.execution.interrupted':
			case 'session.idle':
				busy = false
				break
		}
		if (busy === null) return
		for (const w of worms.values()) {
			if (w.record.sessionId !== sessionId) continue
			if (ev.type === 'session.execution.failed' && w.external) w.externalError = errorText(ev.data?.error)
			setBusy(w, busy)
		}
	}

	/** Checks every worm against the sessions OpenCode says are running. */
	async function reconcile() {
		if (worms.size === 0) return
		const active = await withOpenCode((c) => c.session.active({ signal: AbortSignal.timeout(CONNECT_MS) }))
		for (const w of worms.values()) {
			const busy = w.record.sessionId in active
			if (busy && Date.now() - w.runEndedAt < RUN_LINGER_MS) continue
			setBusy(w, busy)
		}
	}

	/** A canvas prompt (w.run) handles its own thinking; this is everything else. */
	function setBusy(w: Worm, busy: boolean) {
		if (w.run || worms.get(key(w.record.canvasId, w.record.sessionId)) !== w) return
		if (busy) {
			clearTimeout(w.idleTimer)
			w.idleTimer = undefined
			if (w.external) return
			w.external = true
			w.externalError = null
			w.thinking = true
			w.chat = null
			w.chatSent = true
			publish(w).catch(() => {})
		} else if (w.external) {
			w.idleTimer ??= setTimeout(() => settle(w).catch(() => {}), IDLE_SETTLE_MS)
		} else if (w.thinking) {
			w.thinking = false
			publish(w).catch(() => {})
		}
	}

	/** Work from elsewhere finished: stop thinking and say how the turn ended. */
	async function settle(w: Worm) {
		w.idleTimer = undefined
		if (!w.external || w.run) return
		w.external = false
		const error = w.externalError
		w.externalError = null
		const text = await lastReply(w.record.sessionId).catch(() => '')
		// Something new started meanwhile: that owns the worm now.
		if (w.external || w.run) return
		w.thinking = false
		const chat = error ? `${text ? text + '\n\n' : ''}⚠️ ${short(error)}` : text
		if (chat) {
			w.chat = capChat(chat)
			w.chatSent = true
		}
		await publish(w)
		refreshTitle(w).catch(() => {})
	}

	// ---------- prompting ----------

	/** Opens the event stream and waits until it's connected, so nothing after this is missed. */
	async function subscribe(client: OpenCodeClient, signal: AbortSignal) {
		const it = client.event.subscribe({ signal })[Symbol.asyncIterator]()
		const first = await Promise.race([
			it.next(),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out opening the event stream')), CONNECT_MS)),
		])
		if (first.done) throw new Error('the event stream closed')
		return it
	}

	function finish(w: Worm, run: Run, chat: string | null) {
		if (w.run !== run) return
		w.run = null
		w.runEndedAt = Date.now()
		w.thinking = false
		w.chat = chat ? capChat(chat) : null
		w.chatSent = true
		publish(w).catch(() => {})
		refreshTitle(w).catch(() => {})
	}

	const runText = (run: Run) => [...run.blocks.entries()].sort(([a], [b]) => a - b).map(([, t]) => t).join('\n\n').trim()

	/** Follows the session's events until its execution ends, streaming the reply into the chat. */
	async function follow(w: Worm, run: Run, it: AsyncIterator<unknown>) {
		const sessionId = w.record.sessionId
		let outcome: { error?: string; interrupted?: string } | null = null
		for (let tries = 0; !outcome; tries++) {
			try {
				while (true) {
					const next = await it.next()
					if (next.done) break
					const ev = next.value as { type: string; data?: Record<string, unknown> }
					if (ev.data?.sessionID !== sessionId || w.run !== run) continue
					const data = ev.data
					switch (ev.type) {
						case 'session.text.started':
						case 'session.text.delta':
						case 'session.text.ended': {
							const messageId = String(data.assistantMessageID)
							const ordinal = Number(data.ordinal)
							if (run.messageId !== messageId) {
								// a new step with text: it replaces what the previous one said
								run.messageId = messageId
								run.blocks.clear()
							}
							const prev = run.blocks.get(ordinal) ?? ''
							run.blocks.set(
								ordinal,
								ev.type === 'session.text.delta' ? prev + String(data.delta ?? '') : ev.type === 'session.text.ended' ? String(data.text ?? prev) : prev,
							)
							const text = runText(run)
							w.chat = text ? capChat(text) : null
							w.chatSent = false
							schedulePublish(w)
							break
						}
						case 'session.execution.failed':
							outcome = { error: errorText(data.error) }
							break
						case 'session.execution.interrupted':
							outcome = { interrupted: String(data.reason ?? 'interrupted') }
							break
						case 'session.execution.succeeded':
						case 'session.idle':
							outcome = {}
							break
					}
					if (outcome) break
				}
			} catch (e) {
				if (run.abort.signal.aborted || w.run !== run) return
				console.error(`conjured ${sessionId}: event stream failed:`, errorText(e))
			}
			if (outcome || run.abort.signal.aborted || w.run !== run) break
			// The stream ended early. Resume it if the session is still working; otherwise it's done.
			const active = await withOpenCode((c) => c.session.active()).catch(() => null)
			if (!active || !(sessionId in active) || tries >= RESUBSCRIBE_TRIES) {
				outcome = {}
				break
			}
			try {
				it = await subscribe(await opencode(), run.abort.signal)
			} catch {
				await Bun.sleep(1000)
			}
		}
		if (w.run !== run) return
		run.abort.abort()
		let text = runText(run)
		if (!text && !outcome?.error) text = (await lastReply(sessionId).catch(() => '')) || ''
		if (outcome?.error) finish(w, run, `${text ? text + '\n\n' : ''}⚠️ ${short(outcome.error)}`)
		else if (outcome?.interrupted) finish(w, run, `${text ? text + '\n\n' : ''}(interrupted: ${outcome.interrupted})`)
		else finish(w, run, text || '(no reply)')
	}

	/** The text of the session's latest assistant message, for when the stream missed it. */
	async function lastReply(sessionId: string) {
		const res = await withOpenCode((c) => c.message.list({ sessionID: sessionId, limit: 1, order: 'desc', type: 'assistant' }))
		const message = res.data[0] as { type?: string; content?: { type: string; text?: string }[] } | undefined
		if (message?.type !== 'assistant') return ''
		return (message.content ?? []).filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n\n').trim()
	}

	async function refreshTitle(w: Worm) {
		const s = await withOpenCode((c) => c.session.get({ sessionID: w.record.sessionId }))
		const title = s.title?.trim() || ''
		if (!title || title === w.record.title) return
		w.record = { ...w.record, title }
		deps.save()
		await publish(w)
	}

	// ---------- API ----------

	return {
		/** every record, for saving */
		all: (): ConjuredAgent[] => [...worms.values()].map((w) => w.record),

		list: (canvasId: string): ConjuredAgent[] =>
			[...worms.values()].filter((w) => w.record.canvasId === canvasId).map((w) => w.record).sort((a, b) => a.createdAt - b.createdAt),

		async conjure(canvasId: string, sessionId: unknown, x: unknown, y: unknown): Promise<ConjuredAgent> {
			if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
				throw new ConjureError(400, `"sessionId" must be an OpenCode session id ("ses_" + 26 characters)`)
			}
			if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
				throw new ConjureError(400, 'send {"sessionId", "x", "y"} with x/y the page position')
			}
			if (worms.has(key(canvasId, sessionId))) throw new ConjureError(409, 'that session is already conjured on this canvas')
			let session
			try {
				session = await withOpenCode((c) => c.session.get({ sessionID: sessionId }))
			} catch (e) {
				if (e instanceof OpenCodeUnavailable) throw new ConjureError(503, e.message)
				throw new ConjureError(404, `OpenCode has no session ${sessionId}: ${errorText(e)}`)
			}
			if (!deps.canvasExists(canvasId)) throw new ConjureError(404, `no canvas ${canvasId}`)
			if (worms.has(key(canvasId, sessionId))) throw new ConjureError(409, 'that session is already conjured on this canvas')
			const record: ConjuredAgent = {
				canvasId,
				sessionId,
				title: session.title?.trim() || '',
				directory: session.location.directory,
				color: colorFor(sessionId),
				x: Math.round(x),
				y: Math.round(y),
				createdAt: Date.now(),
			}
			const w = add(record)
			deps.save()
			await publish(w)
			reconcile().catch(() => {})
			return record
		},

		/** Puts the worm somewhere else on the page (it was dragged there). */
		async move(canvasId: string, sessionId: string, x: unknown, y: unknown): Promise<ConjuredAgent> {
			const w = get(canvasId, sessionId)
			if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
				throw new ConjureError(400, 'send {"x", "y"} with the new page position')
			}
			w.record = { ...w.record, x: Math.round(x), y: Math.round(y) }
			deps.save()
			await publish(w)
			return w.record
		},

		banish(canvasId: string, sessionId: string) {
			drop(get(canvasId, sessionId))
		},

		/** Throws away every worm on a canvas (it was deleted). */
		dropCanvas(canvasId: string) {
			for (const w of [...worms.values()]) if (w.record.canvasId === canvasId) drop(w)
		},

		/** Clears the worm's speech bubble for everyone (a reply stays until then, or the next prompt). */
		async dismiss(canvasId: string, sessionId: string) {
			const w = get(canvasId, sessionId)
			if (w.run) return
			w.chat = null
			w.chatSent = true
			await publish(w)
		},

		/** Sends a prompt to the worm's session; the reply streams into its chat afterwards. */
		async prompt(canvasId: string, sessionId: string, textValue: unknown, fromValue: unknown) {
			const w = get(canvasId, sessionId)
			const text = typeof textValue === 'string' ? textValue.trim() : ''
			if (!text) throw new ConjureError(400, 'send {"text": "<prompt>"}')
			if (text.length > PROMPT_MAX) throw new ConjureError(400, `"text" is longer than ${PROMPT_MAX} characters`)
			const from = typeof fromValue === 'string' ? fromValue.trim().slice(0, 60) : ''
			const name = displayName(w.record)
			if (w.run) throw new ConjureError(409, `${name} is still working on the last prompt`)

			const run: Run = { abort: new AbortController(), messageId: null, blocks: new Map() }
			w.run = run
			clearTimeout(w.idleTimer)
			w.idleTimer = undefined
			w.external = false
			const fail = (status: number, message: string): never => {
				if (w.run === run) {
					run.abort.abort()
					w.run = null
					w.thinking = false
					// it may be busy with something else: the next check (or event) says so
					reconcile().catch(() => {})
					w.chat = status === 409 ? null : `⚠️ ${short(message)}`
					w.chatSent = true
					publish(w).catch(() => {})
				}
				throw new ConjureError(status, message)
			}

			let client: OpenCodeClient
			let it: AsyncIterator<unknown>
			try {
				client = await opencode()
				const active = await withOpenCode((c) => c.session.active({ signal: AbortSignal.timeout(CONNECT_MS) }))
				if (sessionId in active) return fail(409, `${name} is busy right now (its session is already running); try again when it's done`)
				w.thinking = true
				w.chat = null
				w.chatSent = true
				await publish(w)
				// Listen first, so no part of the reply is missed.
				it = await subscribe(client, run.abort.signal)
			} catch (e) {
				if (e instanceof ConjureError) throw e
				return fail(e instanceof OpenCodeUnavailable ? 503 : 502, errorText(e))
			}
			const canvasTitle = deps.canvasTitle(canvasId)
			try {
				await client.session.prompt({
					sessionID: sessionId,
					text: from ? `${from} (on the canvas "${canvasTitle}"): ${text}` : text,
					metadata: { source: 'canvas', canvasId, ...(from ? { from } : {}) },
				})
			} catch (e) {
				return fail(502, errorText(e))
			}
			follow(w, run, it).catch((e) => {
				console.error(`conjured ${sessionId}: follow failed:`, e)
				finish(w, run, `⚠️ ${short(errorText(e))}`)
			})
			return { ok: true, sessionId, thinking: true }
		},
	}
}
