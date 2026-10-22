import type { SessionLink } from '../../../shared/types'
import type { Editor } from '../editor/Editor'
import type { Vec } from '../editor/geometry'
import { frameTitleBox } from '../editor/layout'
import { parseSelectionId } from '../editor/selection'
import { answerQuestion, dismissQuestion, listAsks, replyPermission, type Ask, type AskValue, type PermissionAsk, type QuestionAsk } from '../opencode/asks'
import { ownerId, pairing, pairings, withServer } from '../opencode/pairings'
import { atom, computed, react, type Atom } from '../state/signals'
import { addSessionFrame, linkSession, unlinkSession } from '../sync/client'
import type { Peer, Presence } from './Presence'
import { runsHere, SessionHost, sessionName } from './SessionHost'

/** An image attached to a prompt in the owner's prompt box. */
export interface PromptAttachment {
	id: string
	name: string
	mime: string
	dataUrl: string
}

/** Why this browser can't prompt a session, or null when it can. 'unlinked': nobody linked it to OpenCode here. */
export type TalkBlock = 'not-yours' | 'not-paired' | 'unlinked' | null

/** One of your prompts in a session, as the prompt thread shows it: the text you typed and the images' data: URLs. */
export interface ThreadPrompt {
	id: string
	text: string
	images: string[]
	at: number
}

/** A session's last exchange from OpenCode: your latest prompts (oldest first, steers included) and what it said since. */
export interface LastExchange {
	prompts: ThreadPrompt[]
	reply: { text: string; at: number } | null
}

/** A session's turn in progress, as seen from here (see SessionControl.turns). */
export interface TurnInfo {
	/** when it started working (or when we first saw it working) */
	since: number
}

const PROMPT_MAX = 20_000
const EXCHANGE_SCAN = 40
const EXCHANGE_PROMPTS_MAX = 3
const FIND_SESSION_MS = 8_000
const INTERRUPT_MS = 10_000
/** a session still working this long after it was interrupted can be stopped again */
const STOP_WAIT_MS = 20_000
/** screen px outside a session frame (title included) that still counts as over it, for C */
const FRAME_REACH = 48
/** screen px kept above a frame's title brought into view for its prompt */
const PROMPT_ROOM_PX = 200

/**
 * Talking to a canvas's sessions from their frames. A frame's session is linked to OpenCode by one
 * browser (records from the canvas server, see server/links.ts), which runs it (SessionHost) while
 * one of its tabs is open; everyone sees its live state (the reply streaming in, what it asks)
 * through the room, and whether it's working from the server's status.
 *
 * On edit links, a frame's prompt button, or C over it (or with it or something in it selected),
 * opens the prompt bubbles at the frame (see SessionPrompt): the input for its owner, a note about
 * whose it is for everyone else. A session not linked yet is linked on the way when one of this
 * browser's paired OpenCodes has it. View links (canEdit false) only watch.
 */
export class SessionControl {
	/** the session whose prompt bubbles are open */
	readonly prompting = atom<string | null>('sessionPrompting', null)
	/** linked sessions that are working, from the server's status (live) */
	readonly busy: Atom<Set<string>>
	/** our own sessions we interrupted, by session id (when), until they stop working */
	readonly stopping = atom<Record<string, number>>('sessionStopping', {})
	/** when each working session's turn started, by session id (gone when it stops) */
	readonly turns = atom<Record<string, TurnInfo>>('sessionTurns', {})
	/** a session being linked to this browser as its prompt opens, and why that failed (see open) */
	readonly linking = atom<{ sessionId: string; error: string | null } | null>('sessionLinking', null)
	/**
	 * Sessions whose questions were put away here (the card at their frame closed), with what they
	 * were asking then: the card comes back when that changes, or from the frame's badge.
	 */
	readonly asksAway = atom<Record<string, string>>('sessionAsksAway', {})
	/** each linked session's live state from the room (its owner's tab), by session id */
	readonly live = computed<Map<string, Peer>>('sessionLive', () => {
		const map = new Map<string, Peer>()
		for (const p of this.presence.peers.get()) if (p.user.agent && p.user.sessionId) map.set(p.user.sessionId, p)
		return map
	})
	private host: SessionHost | null
	private disposers: (() => void)[] = []

	constructor(
		readonly editor: Editor,
		readonly presence: Presence,
		readonly canvasId: string,
		/** edit links can prompt; view links only watch */
		readonly canEdit: boolean,
		readonly records: Atom<SessionLink[]>,
		busy: Atom<Set<string>>,
		private canvasTitle: () => string,
	) {
		this.busy = busy
		let seen: string | null = null
		this.host = new SessionHost(canvasId, records, this.editor.sessions)
		this.disposers.push(
			react(() => {
				const busy = this.busy.get()
				const stopping = this.stopping.peek()
				const still = Object.keys(stopping).filter((id) => busy.has(id))
				if (still.length !== Object.keys(stopping).length) this.stopping.set(Object.fromEntries(still.map((id) => [id, stopping[id]])))
			}),
			react(() => this.trackTurns(this.busy.get())),
			// Its frame gone (hidden, or deleted after it was here): nothing to anchor the prompt to.
			react(() => {
				const id = this.prompting.get()
				const session = id ? this.editor.sessions.get()[id] : undefined
				if (session) seen = id
				if (id && (session?.hidden || (!session && seen === id))) this.close()
			}),
		)
		if (canEdit) {
			window.addEventListener('keydown', this.onKeyDown)
			this.disposers.push(() => window.removeEventListener('keydown', this.onKeyDown))
		}
	}

	/**
	 * C prompts the session whose frame the pointer is over (or near), else the one the selection is
	 * in; C again (or Esc) closes it.
	 */
	private onKeyDown = (e: KeyboardEvent) => {
		if (e.key !== 'c' && e.key !== 'C') return
		// With a modifier it's Cmd/Ctrl+C (copy) or similar: leave it alone.
		if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || isEditable(e.target) || this.editor.inputs.isPointing) return
		const tool = this.editor.currentToolId.get()
		if (tool !== 'select' && tool !== 'hand') return
		const pointer = this.editor.pointerPage.peek()
		// (with the pointer over the open prompt itself, C closes it)
		const sessionId = (pointer && this.sessionAt(pointer)) || this.selectedSession() || this.prompting.peek()
		if (!sessionId) return
		// (so the C doesn't land in the prompt's input, focused as it opens)
		e.preventDefault()
		this.toggle(sessionId)
	}

	/** The session whose frame (title included) contains a page point, or is nearest within FRAME_REACH screen px of it. */
	private sessionAt(point: Vec): string | null {
		const z = this.editor.getZoom()
		const reach = FRAME_REACH / z
		let nearest: { id: string; d: number } | null = null
		for (const section of this.editor.layout.get().sections) {
			if (this.editor.isSessionHidden(section.id)) continue
			const d = Math.min(distanceToBox(section.box, point), distanceToBox(frameTitleBox(section, z), point))
			if (d <= reach && (!nearest || d < nearest.d)) nearest = { id: section.id, d }
		}
		return nearest?.id ?? null
	}

	/** The one session the selection is in (a frame, its items or groups), if it's in one. */
	private selectedSession(): string | null {
		const items = this.editor.items.peek()
		const ids = new Set<string>()
		for (const key of this.editor.selectedIds.peek()) {
			const { kind, id } = parseSelectionId(key)
			if (kind === 'frame') ids.add(id)
			else if (kind === 'item' && items[id]) ids.add(items[id].sessionId)
			else if (kind === 'group') ids.add(id.slice(0, id.indexOf('/')))
		}
		return ids.size === 1 ? [...ids][0] : null
	}

	/** Opens the session's prompt (which says why, if it can't link it), or closes it if it's open. */
	toggle(sessionId: string) {
		if (this.prompting.peek() === sessionId) return this.close()
		void this.open(sessionId)
	}

	/** Whether this browser can open the session's prompt (reactive): edit links, when it's linked or a paired OpenCode may have it. */
	canOpen(sessionId: string) {
		if (!this.canEdit) return false
		return this.records.get().some((r) => r.sessionId === sessionId) || pairings.get().length > 0
	}

	/** Keeps `turns` in step with the busy sessions: when each started working. */
	private trackTurns(busy: Set<string>) {
		const prev = this.turns.peek()
		const next: Record<string, TurnInfo> = {}
		for (const id of busy) next[id] = prev[id] ?? { since: Date.now() }
		const keys = Object.keys(next)
		if (keys.length !== Object.keys(prev).length || keys.some((id) => next[id] !== prev[id])) this.turns.set(next)
	}

	get canPrompt() {
		return this.canEdit
	}

	record(sessionId: string): SessionLink | undefined {
		return this.records.peek().find((r) => r.sessionId === sessionId)
	}

	/** A session's name: its frame's title (its OpenCode session's, see opencode/live.ts), else a short id (reactive). */
	label(sessionId: string) {
		const title = this.editor.sessions.get()[sessionId]?.title.trim()
		if (title && title !== sessionId) return title
		return sessionName(sessionId, '')
	}

	/** Puts a session's questions away here until what it asks changes (`key`: what it asks now). */
	putAsksAway(sessionId: string, key: string) {
		this.asksAway.set({ ...this.asksAway.peek(), [sessionId]: key })
	}

	/** Shows a session's questions at its frame again. */
	showAsks(sessionId: string) {
		const { [sessionId]: _, ...rest } = this.asksAway.peek()
		if (_ !== undefined) this.asksAway.set(rest)
	}

	/** Whether the session is working (reactive). */
	isBusy(sessionId: string) {
		return this.busy.get().has(sessionId)
	}

	/** Why we can't prompt this session (reactive on pairings and links), or null when we can. */
	talkBlock(sessionId: string): TalkBlock {
		pairings.get()
		const r = this.records.get().find((x) => x.sessionId === sessionId)
		if (!r) return 'unlinked'
		if (r.ownerId !== ownerId) return 'not-yours'
		if (!runsHere(r)) return 'not-paired'
		return null
	}

	/**
	 * Opens the session's prompt bubbles at its frame. Not linked yet: links it to this browser first
	 * when one of our paired OpenCodes has it (the bubbles open meanwhile, read-only until it's linked).
	 * Resolves to a message for the user when it can't link it, else null.
	 */
	async open(sessionId: string): Promise<string | null> {
		if (!this.canPrompt) return null
		this.prompting.set(sessionId)
		if (this.record(sessionId)) return null
		this.linking.set({ sessionId, error: null })
		const fail = (error: string) => {
			if (this.linking.peek()?.sessionId === sessionId) this.linking.set({ sessionId, error })
			return error
		}
		try {
			const found = await findSession(sessionId)
			if (!found) return fail(pairings.peek().length ? 'No OpenCode paired in this browser has this session.' : 'Pair the OpenCode it runs on (Sessions, top right) to prompt it from here.')
			this.put(await linkSession(this.canvasId, { sessionId, serverKey: found.serverKey, ownerId }))
		} catch (e) {
			// Someone linked it meanwhile: theirs.
			if ((e as { status?: number }).status === 409) return fail('Another browser linked it meanwhile.')
			return fail((e as Error).message)
		}
		if (this.linking.peek()?.sessionId === sessionId) this.linking.set(null)
		return null
	}

	/**
	 * A session picked from a paired OpenCode (the Sessions panel): gets a frame if it has none, is
	 * linked to this browser, and its prompt bubbles open there.
	 */
	async add(sessionId: string, found: { serverKey: string; title: string }): Promise<string | null> {
		if (!this.canEdit) return null
		if (!this.editor.sessions.peek()[sessionId]) await addSessionFrame(this.canvasId, sessionId, { title: found.title, serverKey: found.serverKey })
		if (!this.record(sessionId)) {
			try {
				this.put(await linkSession(this.canvasId, { sessionId, serverKey: found.serverKey, ownerId }))
			} catch (e) {
				if ((e as { status?: number }).status !== 409) throw e
			}
		}
		this.editor.revealKey(`frame:${sessionId}`)
		this.prompting.set(sessionId)
		this.bringIntoView(sessionId)
		return null
	}

	/** Pans to the session's frame title (with room above it for the prompt) once its frame is laid out, if it's off screen. */
	private bringIntoView(sessionId: string, tries = 20) {
		const section = this.editor.layout.get().sections.find((s) => s.id === sessionId)
		if (!section) {
			if (tries > 0) window.setTimeout(() => this.bringIntoView(sessionId, tries - 1), 100)
			return
		}
		const z = this.editor.getZoom()
		const title = frameTitleBox(section, z)
		const view = this.editor.viewportPageBounds.get()
		const onScreen = title.x < view.x + view.w && title.x + 200 / z > view.x && title.y + title.h > view.y && title.y < view.y + view.h
		if (onScreen) return
		const room = PROMPT_ROOM_PX / z
		this.editor.centerOn({ x: title.x, y: title.y - room, w: Math.min(section.box.w, view.w * 0.6), h: title.h + room * 2 })
	}

	close() {
		this.prompting.set(null)
	}

	/**
	 * Prompts the session, straight from this browser; whoever runs it shares the reply. Attached
	 * images go along as data: URLs (they never touch the canvas server). While the session is
	 * running, the prompt steers it: OpenCode adds it to the turn in progress (as its TUI does when
	 * you type while it works); with `queue` it waits for the turn to finish instead. Resolves to
	 * whether it went to a running session.
	 */
	async send(sessionId: string, text: string, attachments: PromptAttachment[] = [], opts: { queue?: boolean } = {}): Promise<{ steered: boolean }> {
		const r = this.record(sessionId)
		if (!r) throw new Error('that session isn\'t linked to OpenCode here')
		const block = this.talkBlock(r.sessionId)
		if (block === 'not-yours') throw new Error('only the browser that linked this session can prompt it')
		if (block) throw new Error(`its OpenCode isn't paired in this browser`)
		const prompt = text.trim()
		if (prompt.length > PROMPT_MAX) throw new Error(`that's longer than ${PROMPT_MAX} characters`)
		if (!prompt && !attachments.length) throw new Error('say something or attach an image')
		const from = this.presence.me.peek().name.trim().slice(0, 60)
		const title = this.canvasTitle()
		const images = attachments.length === 1 ? 'an image' : `${attachments.length} images`
		const body = prompt || `(sent ${images})`
		return withServer(r.serverKey, async (c) => {
			const active = await c.session.active({ signal: AbortSignal.timeout(10_000) }).catch(() => ({}))
			await c.session.prompt({
				sessionID: r.sessionId,
				text: from ? `${from} (on the canvas "${title}"): ${body}` : body,
				...(attachments.length ? { files: attachments.map((a) => ({ uri: a.dataUrl, name: a.name })) } : {}),
				metadata: { source: 'canvas', canvasId: this.canvasId, ...(from ? { from } : {}) },
				delivery: opts.queue ? 'queue' : 'steer',
			})
			return { steered: r.sessionId in active }
		})
	}

	/**
	 * Interrupts our own session (OpenCode's session.interrupt, as its TUI does on Esc): the turn in
	 * progress stops. It shows as stopping until it stops working.
	 */
	async interrupt(sessionId: string) {
		const r = this.record(sessionId)
		if (!r) throw new Error('that session isn\'t linked to OpenCode here')
		if (this.talkBlock(sessionId)) throw new Error('only the browser that linked this session can stop it')
		if (this.stopping.peek()[sessionId]) return
		const at = Date.now()
		this.setStopping(sessionId, at)
		try {
			await withServer(r.serverKey, (c) => c.session.interrupt({ sessionID: sessionId }, { signal: AbortSignal.timeout(INTERRUPT_MS) }))
		} catch (e) {
			this.setStopping(sessionId, null)
			throw e
		}
		window.setTimeout(() => this.stopping.peek()[sessionId] === at && this.setStopping(sessionId, null), STOP_WAIT_MS)
	}

	private setStopping(sessionId: string, at: number | null) {
		const { [sessionId]: _, ...rest } = this.stopping.peek()
		this.stopping.set(at === null ? rest : { ...rest, [sessionId]: at })
	}

	/** A record as the server has (or will have) it, without waiting for its event. */
	private put(record: SessionLink) {
		this.records.set([...this.records.peek().filter((x) => x.sessionId !== record.sessionId), record])
	}

	/**
	 * Our own session's last exchange, from its messages in OpenCode: the latest prompts (with the
	 * canvas's "Name (on the canvas …):" prefix taken off again) and the newest thing it said after
	 * them. Null when it isn't ours to read.
	 */
	async lastExchange(sessionId: string): Promise<LastExchange | null> {
		const r = this.record(sessionId)
		if (!r || !this.ours(sessionId)) return null
		const res = await withServer(r.serverKey, (c) =>
			c.message.list({ sessionID: sessionId, limit: EXCHANGE_SCAN, order: 'desc' }, { signal: AbortSignal.timeout(10_000) }),
		)
		const prompts: ThreadPrompt[] = []
		let reply: LastExchange['reply'] = null
		for (const m of res.data as RawMessage[]) {
			if (m?.type === 'assistant') {
				const text = (m.content ?? [])
					.filter((p) => p.type === 'text')
					.map((p) => p.text ?? '')
					.join('\n\n')
					.trim()
				if (!text) continue
				// (newest first: text before any prompt is the reply; text after one is the exchange before)
				if (prompts.length) break
				reply ??= { text, at: m.time?.completed ?? m.time?.created ?? 0 }
			} else if (m?.type === 'user') {
				prompts.unshift(threadPrompt(m))
				if (prompts.length >= EXCHANGE_PROMPTS_MAX) break
			} else if (m?.type === 'compaction' && prompts.length) break
		}
		return { prompts, reply }
	}

	/**
	 * What our own session (and its busy subagents) waits on us to answer: questions and permission
	 * requests, oldest first. Null when it isn't ours or OpenCode can't be reached.
	 */
	async asks(sessionId: string): Promise<Ask[] | null> {
		const r = this.record(sessionId)
		if (!r || !this.ours(sessionId)) return null
		const peer = this.live.get().get(sessionId)
		return listAsks(r.serverKey, [sessionId, ...(peer?.subagents ?? []).map((s) => s.id)])
	}

	/** Answers one of our session's questions (field key → value); the session carries on with it. */
	async answer(sessionId: string, ask: QuestionAsk, answer: Record<string, AskValue>) {
		await answerQuestion(this.ownedServer(sessionId), ask, answer)
	}

	/** Dismisses one of our session's questions unanswered (OpenCode stops the turn, as its TUI's Esc does). */
	async dismiss(sessionId: string, ask: QuestionAsk) {
		await dismissQuestion(this.ownedServer(sessionId), ask)
	}

	/** Allows (once, or always from now on) or rejects one of our session's tool permission requests. */
	async permit(sessionId: string, ask: PermissionAsk, decision: 'once' | 'always' | 'reject') {
		await replyPermission(this.ownedServer(sessionId), ask, decision)
	}

	private ownedServer(sessionId: string) {
		const r = this.record(sessionId)
		if (!r) throw new Error('that session isn\'t linked to OpenCode here')
		if (this.talkBlock(sessionId)) throw new Error('only the browser that linked this session can answer it')
		return r.serverKey
	}

	/** Unlinks the session from OpenCode for everyone (its frame stays). */
	async unlink(sessionId: string) {
		if (!this.canEdit) return
		if (this.prompting.peek() === sessionId) this.close()
		await unlinkSession(this.canvasId, sessionId)
	}

	/** Our own link, with its OpenCode paired here. */
	ours(sessionId: string) {
		const r = this.record(sessionId)
		return !!r && r.ownerId === ownerId && !!pairing(r.serverKey)
	}

	destroy() {
		for (const d of this.disposers.splice(0)) d()
		this.host?.destroy()
		this.host = null
	}
}

/** Which paired OpenCode has the session, and its title, or null when none does. */
export async function findSession(sessionId: string): Promise<{ serverKey: string; title: string } | null> {
	const all = pairings.peek()
	const results = await Promise.allSettled(
		all.map((p) =>
			withServer(p.key, (c) => c.session.get({ sessionID: sessionId }, { signal: AbortSignal.timeout(FIND_SESSION_MS) })).then((s) => ({
				serverKey: p.key,
				title: s.title?.trim() || '',
			})),
		),
	)
	for (const r of results) if (r.status === 'fulfilled') return r.value
	return null
}

interface RawMessage {
	id?: string
	type?: string
	text?: string
	time?: { created?: number; completed?: number }
	metadata?: Record<string, unknown>
	files?: { data?: string; mime?: string; source?: { type?: string; uri?: string } }[]
	content?: { type: string; text?: string }[]
}

/** A user message as the thread shows it: without what send() put round it, and its images as data: URLs. */
function threadPrompt(m: RawMessage): ThreadPrompt {
	let text = m.text ?? ''
	const from = m.metadata?.source === 'canvas' && typeof m.metadata.from === 'string' ? m.metadata.from : ''
	if (from && text.startsWith(`${from} (on the canvas "`)) {
		const end = text.indexOf('"): ', from.length)
		if (end >= 0) text = text.slice(end + 4)
	}
	const images = (m.files ?? [])
		.map((f) => {
			const uri = f.source?.type === 'uri' ? (f.source.uri ?? '') : ''
			if (/^data:image\//.test(uri)) return uri
			if (f.data && f.mime?.startsWith('image/')) return `data:${f.mime};base64,${f.data}`
			return ''
		})
		.filter(Boolean)
	if (images.length && /^\(sent (an image|\d+ images)\)$/.test(text)) text = ''
	return { id: m.id ?? '', text, images, at: m.time?.created ?? 0 }
}

function distanceToBox(b: { x: number; y: number; w: number; h: number }, p: Vec) {
	const dx = Math.max(b.x - p.x, 0, p.x - (b.x + b.w))
	const dy = Math.max(b.y - p.y, 0, p.y - (b.y + b.h))
	return Math.hypot(dx, dy)
}

function isEditable(target: EventTarget | null) {
	const el = target as HTMLElement | null
	return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}
