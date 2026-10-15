import type { Editor } from '../editor/Editor'
import { atom } from '../state/signals'
import { banishConjured, dismissConjured, moveConjured, promptConjured } from '../sync/client'
import type { Peer, Presence } from './Presence'

export interface PromptTarget {
	clientId: number
	sessionId: string
}

/**
 * Talking to conjured worms (OpenCode sessions brought onto the canvas, see server/conjured.ts).
 * On edit links, clicking one opens a prompt box under it (see ConjurePrompt) and dragging one moves
 * it; everything they do comes back through presence, so everyone sees it. View links (canvasId
 * null) only watch.
 */
export class Conjure {
	/** the worm whose prompt box is open */
	readonly prompting = atom<PromptTarget | null>('conjurePrompting', null)
	/** when each worm was last startled (clicked or focused), by awareness client id */
	readonly startled = new Map<number, number>()

	constructor(
		readonly editor: Editor,
		readonly presence: Presence,
		/** the canvas, on edit links; null on view links, which can't prompt */
		readonly canvasId: string | null,
	) {}

	get canPrompt() {
		return this.canvasId !== null
	}

	/** The worm's presence, by awareness client id. */
	peer(clientId: number): Peer | undefined {
		return this.presence.peers.peek().find((p) => p.clientId === clientId && p.user.conjured)
	}

	/** Startles the worm and opens its prompt box. */
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
		const peer = this.presence.peers.peek().find((p) => p.user.conjured && p.user.sessionId === sessionId)
		if (!peer?.cursor) return false
		this.editor.centerOn({ x: peer.cursor.x, y: peer.cursor.y, w: 0, h: 0 })
		this.startled.set(peer.clientId, performance.now())
		return true
	}

	async send(target: PromptTarget, text: string) {
		if (!this.canvasId) return
		await promptConjured(this.canvasId, target.sessionId, text, this.presence.me.peek().name)
	}

	/** Puts the worm down at a new page position, for everyone. */
	async move(sessionId: string, at: { x: number; y: number }) {
		if (!this.canvasId) return
		await moveConjured(this.canvasId, sessionId, at)
	}

	async banish(sessionId: string) {
		if (!this.canvasId) return
		if (this.prompting.peek()?.sessionId === sessionId) this.close()
		await banishConjured(this.canvasId, sessionId)
	}

	/** Clears the worm's reply for everyone (edit links only; view links hide it locally). */
	async dismiss(sessionId: string) {
		if (!this.canvasId) return
		await dismissConjured(this.canvasId, sessionId)
	}
}
