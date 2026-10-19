import { sessionColor } from '../../../shared/sessionColor'
import type { AttentionAction, ConjuredAgent } from '../../../shared/types'
import type { Editor } from '../editor/Editor'
import type { Vec } from '../editor/geometry'
import { ownerId, pairing, pairings, withServer } from '../opencode/pairings'
import { atom, computed, react, type Atom } from '../state/signals'
import { banishConjured, conjure as conjureSession } from '../sync/client'
import type { Peer, Presence, SubagentInfo } from './Presence'
import { lastAssistantText, runsHere, SessionHost, sessionName } from './SessionHost'

/** An image attached to a prompt in the C dialog. */
export interface PromptAttachment {
	id: string
	name: string
	mime: string
	dataUrl: string
}

/**
 * Why this browser can't prompt a session, or null when it can. 'not-conjured': nobody brought it
 * onto the canvas; 'view-only': a view link.
 */
export type TalkBlock = 'not-conjured' | 'not-yours' | 'not-paired' | 'view-only' | null

/** What a frame's status rail shows (see Rails): its glyph and state word follow from this. */
export type RailState = 'idle' | 'thinking' | 'replying' | 'waiting' | 'error' | 'asleep'

/** One session frame's live status, put together from its record, its live presence and its attention queue. */
export interface LiveStatus {
	sessionId: string
	/** its record's title ("" when it has none) */
	title: string
	color: string
	/** conjured onto the canvas (it has a record) */
	conjured: boolean
	/** an owner tab runs it right now */
	awake: boolean
	state: RailState
	busy: boolean
	/** working since (ms) */
	since?: number
	/** the step in progress (or the last one, idle) */
	activity?: string
	/** its reply: the one streaming in, or the last turn's (capped, keeping its end) */
	reply: string | null
	/** the reply is still coming */
	replyLive: boolean
	/** when the last turn ended (ms) */
	endedAt?: number
	/** how the last turn ended, when it didn't finish cleanly */
	error?: string
	model?: string
	agent?: string
	directory?: string
	subagents: SubagentInfo[]
	/** subagents running right now */
	running: number
	/** steps queued for attention (say / highlight) */
	queued: number
	/** the first of them */
	firstQueued?: AttentionAction
	/** attention muted here (see Conjure.muted) */
	muted: boolean
	/** its owner is this browser */
	ours: boolean
}

const PROMPT_MAX = 20_000
const FIND_SESSION_MS = 8_000
const INTERRUPT_MS = 10_000
/** a session still working this long after it was interrupted can be stopped again */
const STOP_WAIT_MS = 20_000
const MUTED_KEY = 'canvas.muted'

/**
 * Conjured sessions on a canvas: OpenCode sessions brought onto it (records from the canvas server,
 * see server/conjured.ts), whose frames come alive with a status rail (see Rails). The browser that
 * conjured a session owns it and runs it (SessionHost) while one of its tabs is open; everyone else
 * sees its status, or, with no owner tab, that it's asleep.
 *
 * The C dialog (`dialog`, see SessionDialog) is where people look closer and, the owner, talk to it:
 * prompt, steer, queue, stop. Sessions that queued something for attention get a rail too, conjured
 * or not. View links (canEdit false) only watch.
 */
export class Conjure {
	/** the session whose C dialog is open */
	readonly dialog = atom<string | null>('conjureDialog', null)
	/** the session picker C opened next to the pointer (not over a frame): where it shows */
	readonly picking = atom<{ screen: Vec; page: Vec } | null>('conjurePicking', null)
	/** our own sessions we interrupted, by session id (when), until they stop working */
	readonly stopping = atom<Record<string, number>>('conjureStopping', {})
	/** sessions whose attention calls are muted in this browser: no "needs you", not in the tray */
	readonly muted = atom<ReadonlySet<string>>('conjureMuted', new Set())
	/** live presences of conjured sessions, by session id */
	readonly peers = computed<Map<string, Peer>>('conjurePeers', () => {
		const map = new Map<string, Peer>()
		for (const p of this.presence.peers.get()) if (p.user.conjured && p.user.sessionId) map.set(p.user.sessionId, p)
		return map
	})
	/** every frame with a rail: conjured sessions and sessions with something queued for attention */
	readonly statuses = computed<Map<string, LiveStatus>>('conjureStatuses', () => {
		const records = this.records.get()
		const peers = this.peers.get()
		const muted = this.muted.get()
		const byQueue = new Map<string, AttentionAction[]>()
		for (const a of this.queue.get()) {
			let list = byQueue.get(a.sessionId)
			if (!list) byQueue.set(a.sessionId, (list = []))
			list.push(a)
		}
		const map = new Map<string, LiveStatus>()
		const ids = new Set([...records.map((r) => r.sessionId), ...byQueue.keys()])
		for (const sessionId of ids) {
			const r = records.find((x) => x.sessionId === sessionId)
			const peer = r ? peers.get(sessionId) : undefined
			const queue = byQueue.get(sessionId) ?? []
			map.set(sessionId, status(sessionId, r, peer, queue, muted.has(sessionId)))
		}
		return map
	})
	private host: SessionHost | null
	private disposers: (() => void)[] = []

	constructor(
		readonly editor: Editor,
		readonly presence: Presence,
		readonly canvasId: string,
		/** edit links can talk to their own sessions and conjure; view links only watch */
		readonly canEdit: boolean,
		readonly records: Atom<ConjuredAgent[]>,
		/** the canvas's queued attention actions */
		readonly queue: Atom<AttentionAction[]>,
		private canvasTitle: () => string,
	) {
		this.host = new SessionHost(canvasId, records)
		this.muted.set(loadMuted(canvasId))
		this.disposers.push(
			react(() => {
				const statuses = this.statuses.get()
				const stopping = this.stopping.peek()
				const still = Object.keys(stopping).filter((id) => statuses.get(id)?.busy)
				if (still.length !== Object.keys(stopping).length) this.stopping.set(Object.fromEntries(still.map((id) => [id, stopping[id]])))
			}),
			// The rail's band in the layout.
			react(() => {
				const ids = [...this.statuses.get().keys()]
				editor.railed.set(new Set(ids))
			}),
		)
		const onStorage = (e: StorageEvent) => e.key === MUTED_KEY && this.muted.set(loadMuted(canvasId))
		window.addEventListener('storage', onStorage)
		this.disposers.push(() => window.removeEventListener('storage', onStorage), () => editor.railed.set(new Set()))
	}

	get canPrompt() {
		return this.canEdit
	}

	record(sessionId: string): ConjuredAgent | undefined {
		return this.records.peek().find((r) => r.sessionId === sessionId)
	}

	/** The session's live status (reactive), if its frame has a rail. */
	status(sessionId: string): LiveStatus | undefined {
		return this.statuses.get().get(sessionId)
	}

	/** Why we can't prompt this session (reactive on pairings), or null when we can. */
	talkBlock(sessionId: string): TalkBlock {
		if (!this.canEdit) return 'view-only'
		pairings.get()
		const r = this.records.get().find((x) => x.sessionId === sessionId)
		if (!r) return 'not-conjured'
		if (r.ownerId !== ownerId) return 'not-yours'
		if (!runsHere(r)) return 'not-paired'
		return null
	}

	openDialog(sessionId: string) {
		this.picking.set(null)
		this.dialog.set(sessionId)
	}

	closeDialog() {
		this.dialog.set(null)
	}

	/** Brings the session's frame into view (and selects it). False if it has none here. */
	focus(sessionId: string): boolean {
		return this.editor.focusSelectionKey(`frame:${sessionId}`)
	}

	toggleMute(sessionId: string) {
		const next = new Set(loadMuted(this.canvasId))
		if (next.has(sessionId)) next.delete(sessionId)
		else next.add(sessionId)
		saveMuted(this.canvasId, next)
		this.muted.set(next)
	}

	/**
	 * Prompts the session, straight from this browser. Attached images go along as data: URLs (they
	 * never touch the canvas server). 'steer' adds it to the turn in progress while the session
	 * works (as OpenCode's TUI does when you type while it works), or starts one when idle; 'queue'
	 * waits for the turn to end. Resolves to whether it went to a running session.
	 */
	async send(sessionId: string, text: string, attachments: PromptAttachment[] = [], delivery: 'steer' | 'queue' = 'steer'): Promise<{ running: boolean }> {
		const r = this.record(sessionId)
		const block = this.talkBlock(sessionId)
		if (!r || block === 'not-conjured') throw new Error('it was banished')
		if (block === 'not-yours') throw new Error('only the browser that conjured this session can prompt it')
		if (block === 'view-only') throw new Error('this is a view-only link')
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
				delivery,
			})
			return { running: r.sessionId in active }
		})
	}

	/**
	 * Interrupts our own session (OpenCode's session.interrupt, as its TUI does on Esc): the turn in
	 * progress stops. It shows as stopping until it stops working.
	 */
	async interrupt(sessionId: string) {
		const r = this.record(sessionId)
		if (!r) throw new Error('it was banished')
		if (this.talkBlock(sessionId)) throw new Error('only the browser that conjured this session can stop it')
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

	/**
	 * Conjures a session onto the canvas, as ours (from whichever paired OpenCode has it): its frame
	 * comes alive (the server makes one if there's none). `found`: the session's server and title
	 * when the caller already knows them. Resolves to a message for the user when it can't, else null.
	 */
	async connect(sessionId: string, found?: { serverKey: string; title: string } | null): Promise<string | null> {
		if (!this.canEdit) return 'This is a view-only link'
		const r = this.record(sessionId)
		if (r) return r.ownerId === ownerId ? null : 'Already conjured, by someone else'
		found ??= await findSession(sessionId)
		if (!found) return pairings.peek().length ? 'No OpenCode paired in this browser has this session' : 'Pair an OpenCode (Conjure) to connect its sessions'
		try {
			await conjureSession(this.canvasId, { sessionId, serverKey: found.serverKey, ownerId, title: found.title })
		} catch (e) {
			// Someone conjured it meanwhile.
			if ((e as { status?: number }).status === 409) return this.record(sessionId)?.ownerId === ownerId ? null : 'Already conjured, by someone else'
			throw e
		}
		return null
	}

	/**
	 * The session's most recent reply: what it's publishing, or, for our own session, its last
	 * assistant message from OpenCode (there even after a reload). `full` fetches the whole of it
	 * (what's published keeps only the end of long replies) when we can.
	 */
	async lastReply(sessionId: string, full = false): Promise<string> {
		const published = this.status(sessionId)?.reply ?? ''
		const r = this.record(sessionId)
		const ours = !!r && this.ours(sessionId)
		if (published && (!full || !ours || !published.startsWith('…'))) return published
		if (!r || !ours) return published
		return (await lastAssistantText(r.serverKey, sessionId, 10, full)) || published
	}

	async banish(sessionId: string) {
		if (!this.canEdit) return
		await banishConjured(this.canvasId, sessionId)
	}

	/** Our own session, with its OpenCode paired here. */
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

function status(sessionId: string, r: ConjuredAgent | undefined, peer: Peer | undefined, queue: AttentionAction[], muted: boolean): LiveStatus {
	const live = peer?.live ?? {}
	const busy = !!peer?.thinking
	const subagents = peer?.subagents ?? []
	const reply = (peer?.speaking && peer.chat) || null
	const replyLive = busy && !!reply && peer?.chatSent === false
	const calling = queue.length > 0 && !muted
	let state: RailState
	if (busy) state = live.replying && reply ? 'replying' : 'thinking'
	else if (calling) state = 'waiting'
	else if (!peer) state = r ? 'asleep' : 'idle'
	else if (live.error) state = 'error'
	else state = 'idle'
	return {
		sessionId,
		title: r ? sessionName(r) : '',
		color: r?.color ?? peer?.user.color ?? sessionColor(sessionId),
		conjured: !!r,
		awake: !!peer,
		state,
		busy,
		since: busy ? live.since : undefined,
		activity: live.activity,
		reply,
		replyLive,
		endedAt: live.endedAt,
		error: live.error,
		model: live.model,
		agent: live.agent,
		directory: live.directory,
		subagents,
		running: subagents.filter((s) => !s.done).length,
		queued: queue.length,
		firstQueued: queue[0],
		muted,
		ours: !!r && r.ownerId === ownerId,
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

function loadMuted(canvasId: string): Set<string> {
	try {
		const all = JSON.parse(localStorage.getItem(MUTED_KEY) ?? '{}') as Record<string, string[]>
		return new Set(Array.isArray(all[canvasId]) ? all[canvasId] : [])
	} catch {
		return new Set()
	}
}

function saveMuted(canvasId: string, muted: Set<string>) {
	try {
		const all = JSON.parse(localStorage.getItem(MUTED_KEY) ?? '{}') as Record<string, string[]>
		if (muted.size) all[canvasId] = [...muted]
		else delete all[canvasId]
		localStorage.setItem(MUTED_KEY, JSON.stringify(all))
	} catch {}
}
