import type { Editor } from '../editor/Editor'
import type { Vec } from '../editor/geometry'
import { AgentWorms } from './AgentWorms'
import type { Conjure } from './Conjure'
import type { Peer, Presence } from './Presence'

const EASE_MS = 45

/**
 * Other people's cursors, drawn as DOM in screen space. Positions are eased toward the latest
 * broadcast point every frame, so cursors glide instead of stepping at the network rate.
 * AI agents get a worm instead (see AgentWorms).
 */
export class PeerCursors {
	private host: HTMLDivElement
	private cursors = new Map<
		number,
		{ el: HTMLDivElement; label: HTMLSpanElement; message: HTMLSpanElement; shown: Vec; color: string; name: string; chat: string | null }
	>()
	private worms: AgentWorms
	private dispose: () => void

	constructor(
		parent: HTMLElement,
		private editor: Editor,
		private presence: Presence,
		conjure: Conjure | null = null,
	) {
		this.host = document.createElement('div')
		this.host.className = 'peer-cursors'
		parent.appendChild(this.host)
		this.worms = new AgentWorms(this.host, editor, conjure)
		this.dispose = editor.onFrame((now, elapsed) => this.update(now, elapsed))
	}

	private update(now: number, elapsed: number) {
		const k = 1 - Math.exp(-elapsed / EASE_MS)
		const followingId = this.presence.followingId.peek()
		const seen = new Set<number>()
		const agents: Peer[] = []

		for (const peer of this.presence.peers.peek()) {
			if (peer.user.agent) {
				agents.push(peer)
				continue
			}
			if (!peer.cursor) continue
			seen.add(peer.clientId)
			let c = this.cursors.get(peer.clientId)
			if (!c) {
				const el = document.createElement('div')
				el.className = 'peer-cursor'
				el.innerHTML =
					'<svg width="18" height="18" viewBox="0 0 18 18"><path d="M2 1.5 L15.5 8.2 L9.2 9.6 L6.4 15.6 Z" stroke="white" stroke-width="1.3" stroke-linejoin="round"/></svg>' +
					'<span class="peer-cursor-label"><span class="peer-cursor-name"></span><span class="peer-cursor-message"></span></span>'
				const label = el.querySelector<HTMLSpanElement>('.peer-cursor-label')!
				const message = el.querySelector<HTMLSpanElement>('.peer-cursor-message')!
				this.host.appendChild(el)
				c = { el, label, message, shown: { ...peer.cursor }, color: '', name: '', chat: null }
				this.cursors.set(peer.clientId, c)
			}
			if (c.color !== peer.user.color) {
				c.color = peer.user.color
				c.el.querySelector('path')!.setAttribute('fill', c.color)
				c.label.style.background = c.color
			}
			if (c.name !== peer.user.name) {
				c.name = peer.user.name
				c.label.firstElementChild!.textContent = c.name
			}
			const chat = peer.chat ?? null
			if (c.chat !== chat) {
				c.chat = chat
				c.message.textContent = chat || '…'
				c.label.classList.toggle('chatting', chat !== null)
			}
			c.label.classList.toggle('sent', chat !== null && !!peer.chatSent)
			c.shown.x += (peer.cursor.x - c.shown.x) * k
			c.shown.y += (peer.cursor.y - c.shown.y) * k
			const p = this.editor.pageToScreen(c.shown)
			c.el.style.transform = `translate(${p.x}px, ${p.y}px)`
			c.el.classList.toggle('followed', peer.clientId === followingId)
		}

		for (const [id, c] of this.cursors) {
			if (seen.has(id)) continue
			c.el.remove()
			this.cursors.delete(id)
		}

		this.worms.update(now, elapsed, agents)
	}

	destroy() {
		this.dispose()
		this.worms.destroy()
		this.host.remove()
	}
}
