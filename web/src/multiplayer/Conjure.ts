import type { ConjuredAgent } from '../../../shared/types'
import type { Editor } from '../editor/Editor'
import type { Vec } from '../editor/geometry'
import { ownerId, pairing, pairings, withServer } from '../opencode/pairings'
import { atom, computed, type Atom } from '../state/signals'
import { banishConjured, conjure as conjureSession, updateConjured } from '../sync/client'
import type { Peer, Presence } from './Presence'
import { lastAssistantText, runsHere, WormHost, wormName } from './WormHost'

export interface PromptTarget {
	clientId: number
	sessionId: string
}

/** An image attached to a prompt in the owner's prompt box. */
export interface PromptAttachment {
	id: string
	name: string
	mime: string
	dataUrl: string
}

/** Why this browser can't talk to a worm, or null when it can. */
export type TalkBlock = 'not-yours' | 'not-paired' | null

const PROMPT_MAX = 20_000
const FIND_SESSION_MS = 8_000

/**
 * Conjured worms on a canvas: OpenCode sessions brought onto it (records from the canvas server,
 * see server/conjured.ts). The browser that conjured a worm owns it and runs it (WormHost) while
 * one of its tabs is open; everyone else sees its presence, or, with no owner tab, a sleeping worm
 * drawn from its record.
 *
 * On edit links, dragging a worm moves it for everyone and clicking one opens a box under it (see
 * ConjurePrompt): the prompt box for its owner, a note about whose it is for everyone else. View
 * links (canEdit false) only watch.
 */
export class Conjure {
	/** the worm whose box is open */
	readonly prompting = atom<PromptTarget | null>('conjurePrompting', null)
	/** when each worm was last startled (clicked or focused), by awareness client id */
	readonly startled = new Map<number, number>()
	/** where worms were just summoned to (C), by session id, for AgentWorms to crawl there right away */
	readonly placing = new Map<string, Vec>()
	/**
	 * Replies reopened here with "Show last reply", by session id: shown pinned in the bubble until
	 * the worm's own chat changes from what it was then (baseChat).
	 */
	readonly replays = new Map<string, { text: string; baseChat: string | null }>()
	/** worms with no live presence (nobody runs them), as made-up peers to draw asleep */
	readonly sleepers = computed<Peer[]>('conjureSleepers', () => {
		const awake = new Set(this.presence.peers.get().filter((p) => p.user.conjured && p.user.sessionId).map((p) => p.user.sessionId))
		return this.records
			.get()
			.filter((r) => !awake.has(r.sessionId))
			.map((r) => ({
				clientId: sleeperId(r.sessionId),
				user: { name: wormName(r), color: r.color, agent: true, conjured: true, sessionId: r.sessionId, serverKey: r.serverKey, asleep: true },
				cursor: { x: r.x, y: r.y },
				selection: [],
				view: null,
				chat: null,
				chatSent: true,
			}))
	})
	private host: WormHost | null

	constructor(
		readonly editor: Editor,
		readonly presence: Presence,
		readonly canvasId: string,
		/** edit links can drag and click worms; view links only watch */
		readonly canEdit: boolean,
		readonly records: Atom<ConjuredAgent[]>,
		private canvasTitle: () => string,
	) {
		this.host = new WormHost(canvasId, records)
	}

	get canPrompt() {
		return this.canEdit
	}

	record(sessionId: string): ConjuredAgent | undefined {
		return this.records.peek().find((r) => r.sessionId === sessionId)
	}

	/** Why we can't prompt this worm (reactive on pairings), or null when we can. */
	talkBlock(sessionId: string): TalkBlock {
		pairings.get()
		const r = this.records.get().find((x) => x.sessionId === sessionId)
		if (!r || r.ownerId !== ownerId) return 'not-yours'
		if (!runsHere(r)) return 'not-paired'
		return null
	}

	/** Every worm: live presences and sleeping records. */
	worms(): Peer[] {
		return [...this.presence.peers.peek().filter((p) => p.user.conjured), ...this.sleepers.get()]
	}

	/** The worm's presence (or sleeping stand-in), by awareness client id. */
	peer(clientId: number): Peer | undefined {
		return this.worms().find((p) => p.clientId === clientId)
	}

	/** Startles the worm and opens its box. */
	open(peer: Peer) {
		if (!this.canPrompt || !peer.user.sessionId) return
		this.startled.set(peer.clientId, performance.now())
		this.prompting.set({ clientId: peer.clientId, sessionId: peer.user.sessionId })
	}

	close() {
		this.prompting.set(null)
	}

	/** Brings an already conjured worm into view and gives it a jolt. False if it isn't here (yet). */
	focus(sessionId: string): boolean {
		const peer = this.worms().find((p) => p.user.sessionId === sessionId)
		if (!peer?.cursor) return false
		this.editor.centerOn({ x: peer.cursor.x, y: peer.cursor.y, w: 0, h: 0 })
		this.startled.set(peer.clientId, performance.now())
		return true
	}

	/**
	 * Prompts the worm's session, straight from this browser; whoever runs the worm shows the reply.
	 * Attached images go along as data: URLs (they never touch the canvas server).
	 */
	async send(target: PromptTarget, text: string, attachments: PromptAttachment[] = []) {
		const r = this.record(target.sessionId)
		if (!r) throw new Error('that worm was banished')
		const block = this.talkBlock(r.sessionId)
		if (block === 'not-yours') throw new Error('only the browser that conjured this worm can prompt it')
		if (block) throw new Error(`its OpenCode isn't paired in this browser`)
		const prompt = text.trim()
		if (prompt.length > PROMPT_MAX) throw new Error(`that's longer than ${PROMPT_MAX} characters`)
		if (!prompt && !attachments.length) throw new Error('say something or attach an image')
		const from = this.presence.me.peek().name.trim().slice(0, 60)
		const title = this.canvasTitle()
		const images = attachments.length === 1 ? 'an image' : `${attachments.length} images`
		const body = prompt || `(sent ${images})`
		await withServer(r.serverKey, async (c) => {
			const active = await c.session.active({ signal: AbortSignal.timeout(10_000) })
			if (r.sessionId in active) throw new Error(`${wormName(r)} is busy right now (its session is already running); try again when it's done`)
			await c.session.prompt({
				sessionID: r.sessionId,
				text: from ? `${from} (on the canvas "${title}"): ${body}` : body,
				...(attachments.length ? { files: attachments.map((a) => ({ uri: a.dataUrl, name: a.name })) } : {}),
				metadata: { source: 'canvas', canvasId: this.canvasId, ...(from ? { from } : {}) },
			})
		})
	}

	/**
	 * C over a session frame (or a long press): brings the session's worm to `at`. Conjures it when
	 * it isn't here (from whichever paired OpenCode has the session); otherwise our own worm crawls
	 * over. Resolves to a message for the user when it can't, else null.
	 */
	async summon(sessionId: string, at: Vec): Promise<string | null> {
		if (!this.canEdit) return null
		const spot = { x: Math.round(at.x), y: Math.round(at.y) }
		const r = this.record(sessionId)
		if (r) {
			if (r.ownerId !== ownerId) return 'Owned by someone else'
			this.placing.set(sessionId, spot)
			this.close()
			await this.move(sessionId, spot)
			return null
		}
		const found = await findSession(sessionId)
		if (!found) return pairings.peek().length ? 'No paired OpenCode has this session' : 'Pair an OpenCode (Conjure) to summon its sessions'
		try {
			await conjureSession(this.canvasId, { sessionId, serverKey: found.serverKey, ownerId, title: found.title, ...spot })
		} catch (e) {
			// Someone conjured it meanwhile.
			if ((e as { status?: number }).status === 409) return this.record(sessionId)?.ownerId === ownerId ? null : 'Owned by someone else'
			throw e
		}
		return null
	}

	/**
	 * The worm's most recent reply: what it last said in the room, or, for our own worm, its
	 * session's last assistant message from OpenCode (there even after a reload or dismissing it).
	 */
	async lastReply(sessionId: string): Promise<string> {
		const said = this.saying(sessionId)
		if (said) return said
		const r = this.record(sessionId)
		if (!r || !this.ours(sessionId)) return ''
		return lastAssistantText(r.serverKey, sessionId)
	}

	/** What the worm is saying in the room right now (its reply, finished or not), or null. */
	saying(sessionId: string): string | null {
		const peer = this.presence.peers.get().find((p) => p.user.conjured && p.user.sessionId === sessionId)
		return (peer?.speaking && peer.chat) || null
	}

	/** Reopens a reply in the worm's bubble, pinned (here only). */
	showReply(sessionId: string, text: string) {
		const peer = this.presence.peers.peek().find((p) => p.user.conjured && p.user.sessionId === sessionId)
		this.replays.set(sessionId, { text, baseChat: peer?.chat ?? null })
	}

	/** Puts the worm down at a new page position, for everyone. */
	async move(sessionId: string, at: { x: number; y: number }) {
		if (!this.canEdit) return
		await updateConjured(this.canvasId, sessionId, at)
	}

	async banish(sessionId: string) {
		if (!this.canEdit) return
		if (this.prompting.peek()?.sessionId === sessionId) this.close()
		await banishConjured(this.canvasId, sessionId)
	}

	/** Clears the worm's reply for everyone when we run it (others just hide it locally). */
	dismiss(sessionId: string) {
		this.host?.dismiss(sessionId)
	}

	/** Our own worm, with its OpenCode paired here. */
	ours(sessionId: string) {
		const r = this.record(sessionId)
		return !!r && r.ownerId === ownerId && !!pairing(r.serverKey)
	}

	destroy() {
		this.host?.destroy()
		this.host = null
	}
}

/** Which paired OpenCode has the session, and its title, or null when none does. */
async function findSession(sessionId: string): Promise<{ serverKey: string; title: string } | null> {
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

/** A stable made-up awareness id for a sleeping worm (negative, so it never clashes with real ones). */
function sleeperId(sessionId: string) {
	let h = 0
	for (const ch of sessionId) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0
	return -1 - (h % 1_000_000_000)
}
