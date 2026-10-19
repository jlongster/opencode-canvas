import type { ConjuredAgent } from '../../../shared/types'
import type { Editor } from '../editor/Editor'
import type { Vec } from '../editor/geometry'
import { ownerId, pairing, pairings, withServer } from '../opencode/pairings'
import { atom, computed, react, type Atom } from '../state/signals'
import { banishConjured, conjure as conjureSession, moveConjured } from '../sync/client'
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

/** Why this browser can't talk to a worm, or null when it can. 'unowned': nobody conjured it (an agent's say/highlight made it). */
export type TalkBlock = 'not-yours' | 'not-paired' | 'unowned' | null

const PROMPT_MAX = 20_000
const FIND_SESSION_MS = 8_000
const INTERRUPT_MS = 10_000
/** a worm still thinking this long after its session was interrupted can be stopped again */
const STOP_WAIT_MS = 20_000

/**
 * Conjured worms on a canvas: OpenCode sessions brought onto it (records from the canvas server,
 * see server/conjured.ts). The browser that conjured a worm owns it and runs it (WormHost) while
 * one of its tabs is open; everyone else sees its presence, or, with no owner tab, a sleeping worm
 * drawn from its record.
 *
 * Only its owner moves a worm from here (summon: C, a long press or picking it in a Conjure menu;
 * or dragging it, see AgentWorms), through the server's owner-checked move; the server also moves
 * it along with its frame, and its agent points it elsewhere (highlight steps). On edit links,
 * clicking one opens a box under it (see ConjurePrompt): the prompt box for its owner, a note about
 * whose it is for everyone else. View links (canEdit false) only watch.
 */
export class Conjure {
	/** the worm whose box is open */
	readonly prompting = atom<PromptTarget | null>('conjurePrompting', null)
	/** the session picker C opened next to the pointer (not over a session): where it shows, and where to conjure */
	readonly picking = atom<{ screen: Vec; page: Vec } | null>('conjurePicking', null)
	/** when each worm was last startled (clicked or focused), by awareness client id */
	readonly startled = new Map<number, number>()
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
	/** our own worms whose sessions we interrupted, by session id (when), until they stop thinking */
	readonly stopping = atom<Record<string, number>>('conjureStopping', {})
	private host: WormHost | null
	private unwatchStopping: () => void
	private unwatchPointer: () => void
	/** where the pointer last was on the canvas (page space), for menus to conjure at */
	private lastPointer: Vec | null = null

	constructor(
		readonly editor: Editor,
		readonly presence: Presence,
		readonly canvasId: string,
		/** edit links can click worms; view links only watch */
		readonly canEdit: boolean,
		readonly records: Atom<ConjuredAgent[]>,
		private canvasTitle: () => string,
	) {
		this.host = new WormHost(canvasId, records)
		this.unwatchStopping = react(() => {
			const peers = this.presence.peers.get()
			const stopping = this.stopping.peek()
			const still = Object.keys(stopping).filter((id) => peers.some((p) => p.user.conjured && p.user.sessionId === id && p.thinking))
			if (still.length !== Object.keys(stopping).length) this.stopping.set(Object.fromEntries(still.map((id) => [id, stopping[id]])))
		})
		this.unwatchPointer = react(() => {
			const at = this.editor.pointerPage.get()
			if (at) this.lastPointer = at
		})
	}

	/**
	 * Where a session picked from a menu goes: where the pointer last was on the canvas, when that's
	 * still in view, else the middle of the view.
	 */
	menuSpot(): Vec {
		const view = this.editor.viewportPageBounds.get()
		const at = this.lastPointer
		if (at && at.x >= view.x && at.x <= view.x + view.w && at.y >= view.y && at.y <= view.y + view.h) return at
		return { x: view.x + view.w / 2, y: view.y + view.h / 2 }
	}

	/** Whether this browser may move the worm: its own, or one nobody owns (moving it adopts it). */
	canMove(sessionId: string): boolean {
		if (!this.canEdit) return false
		const r = this.record(sessionId)
		return !!r && (r.ownerId === ownerId || (!r.ownerId && pairings.peek().length > 0))
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
		if (r && !r.ownerId) return 'unowned'
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
	 * Attached images go along as data: URLs (they never touch the canvas server). While the session
	 * is running, the prompt steers it: OpenCode adds it to the turn in progress (as its TUI does when
	 * you type while it works). Resolves to whether it steered a running session.
	 */
	async send(target: PromptTarget, text: string, attachments: PromptAttachment[] = []): Promise<{ steered: boolean }> {
		const r = this.record(target.sessionId)
		if (!r) throw new Error('that worm was banished')
		const block = this.talkBlock(r.sessionId)
		if (block === 'not-yours') throw new Error('only the browser that conjured this worm can prompt it')
		if (block === 'unowned') throw new Error('nobody has conjured this session yet: conjure it from your OpenCode to talk to it')
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
				delivery: 'steer',
			})
			return { steered: r.sessionId in active }
		})
	}

	/**
	 * Interrupts our own worm's session (OpenCode's session.interrupt, as its TUI does on Esc): the
	 * turn in progress stops. The worm shows as stopping until it stops thinking.
	 */
	async interrupt(sessionId: string) {
		const r = this.record(sessionId)
		if (!r) throw new Error('that worm was banished')
		if (this.talkBlock(sessionId)) throw new Error('only the browser that conjured this worm can stop it')
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
	 * C over a session frame (or a long press), or picking it in a Conjure menu: brings the session's
	 * worm to `at` (page space) and opens its prompt box there. Ours glides over; one nobody owns (an
	 * agent's attention actions made it) is adopted on the way; one that isn't here yet is conjured
	 * there (from whichever paired OpenCode has the session). Someone else's stays put and gets its box
	 * opened (whose it is), brought into view. `found`: the session's server and title when the
	 * caller already knows them. Resolves to a message for the user when it can't, else null.
	 */
	async summon(sessionId: string, at: Vec, found?: { serverKey: string; title: string }): Promise<string | null> {
		if (!this.canEdit) return null
		const spot = { x: Math.round(at.x), y: Math.round(at.y) }
		const r = this.record(sessionId)
		if (r?.ownerId && r.ownerId !== ownerId) {
			const peer = this.worms().find((p) => p.user.sessionId === sessionId)
			if (peer?.cursor && !this.inView(peer.cursor)) this.focus(sessionId)
			if (peer) this.open(peer)
			return null
		}
		if (r?.ownerId) {
			this.close()
			const moving = this.move(sessionId, spot)
			this.openWhenHere(sessionId)
			await moving
			return null
		}
		found ??= (await findSession(sessionId)) ?? undefined
		if (!found) return pairings.peek().length ? 'No paired OpenCode has this session' : 'Pair an OpenCode (Conjure) to summon its sessions'
		this.close()
		try {
			if (r) await this.move(sessionId, spot, found)
			else this.put(await conjureSession(this.canvasId, { sessionId, serverKey: found.serverKey, ownerId, title: found.title, ...spot }))
		} catch (e) {
			// Someone conjured it meanwhile.
			if ((e as { status?: number }).status === 409 || (e as { status?: number }).status === 403) {
				if (this.record(sessionId)?.ownerId !== ownerId) return 'Owned by someone else'
				await this.move(sessionId, spot)
			} else throw e
		}
		this.openWhenHere(sessionId)
		return null
	}

	/**
	 * Moves our own worm to a page position for everyone (C, a menu, a drag), or adopts one nobody
	 * owns there (`found`: its OpenCode, looked up when not given). It starts over right away; if the
	 * server refuses, it goes back.
	 */
	async move(sessionId: string, at: Vec, found?: { serverKey: string; title: string }) {
		if (!this.canEdit) return
		const r = this.record(sessionId)
		if (!r) throw new Error('that worm was banished')
		const spot = { x: Math.round(at.x), y: Math.round(at.y) }
		if (!r.ownerId) {
			found ??= (await findSession(sessionId)) ?? undefined
			if (!found) throw new Error(pairings.peek().length ? 'No paired OpenCode has this session' : 'Pair an OpenCode (Conjure) to move it')
		}
		this.put({ ...r, ...spot })
		try {
			this.put(await moveConjured(this.canvasId, sessionId, { ...spot, ownerId, ...(r.ownerId ? {} : { serverKey: found!.serverKey, title: found!.title }) }))
		} catch (e) {
			const now = this.record(sessionId)
			if (now && now.x === spot.x && now.y === spot.y) this.put({ ...now, x: r.x, y: r.y })
			throw e
		}
	}

	/** A record as the server has (or will have) it, without waiting for its event. */
	private put(record: ConjuredAgent) {
		this.records.set([...this.records.peek().filter((x) => x.sessionId !== record.sessionId), record])
	}

	/** Opens the worm's box as soon as it's here (a new one shows up asleep first, then wakes). */
	private openWhenHere(sessionId: string, tries = 20) {
		const peer = this.worms().find((p) => p.user.sessionId === sessionId)
		if (peer) return this.open(peer)
		if (tries > 0) window.setTimeout(() => this.openWhenHere(sessionId, tries - 1), 100)
	}

	private inView(p: Vec) {
		const v = this.editor.viewportPageBounds.get()
		return p.x >= v.x && p.x <= v.x + v.w && p.y >= v.y && p.y <= v.y + v.h
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
		this.unwatchStopping()
		this.unwatchPointer()
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
