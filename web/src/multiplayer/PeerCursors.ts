import type { Editor } from '../editor/Editor'
import type { Vec } from '../editor/geometry'
import type { Presence } from './Presence'

const EASE_MS = 45
/** a classic pointer arrow, tip at (0, 0), in CSS px */
const ARROW = new Path2D('M1 1 L1 17.5 L5.4 13.4 L8.4 20.2 L11.2 19 L8.3 12.4 L14.4 12.4 Z')
/** its little canvas: room round the arrow for the outline and shadow, px */
const BOX = { x: -3, y: -3, w: 22, h: 27 }

/**
 * Other people's cursors, drawn as DOM in screen space. Positions are eased toward the latest
 * broadcast point every frame, so cursors glide instead of stepping at the network rate.
 * Agents (linked sessions' live state) have no pointer and aren't drawn.
 */
export class PeerCursors {
	private host: HTMLDivElement
	private cursors = new Map<
		number,
		{
			el: HTMLDivElement
			canvas: HTMLCanvasElement
			label: HTMLSpanElement
			message: HTMLSpanElement
			shown: Vec
			color: string
			dpr: number
			name: string
			chat: string | null
		}
	>()
	private dispose: () => void

	constructor(
		parent: HTMLElement,
		private editor: Editor,
		private presence: Presence,
	) {
		this.host = document.createElement('div')
		this.host.className = 'peer-cursors'
		parent.appendChild(this.host)
		this.dispose = editor.onFrame((_now, elapsed) => this.update(elapsed))
	}

	private update(elapsed: number) {
		const k = 1 - Math.exp(-elapsed / EASE_MS)
		const followingId = this.presence.followingId.peek()
		const seen = new Set<number>()

		for (const peer of this.presence.peers.peek()) {
			if (peer.user.agent || !peer.cursor) continue
			seen.add(peer.clientId)
			let c = this.cursors.get(peer.clientId)
			if (!c) {
				const el = document.createElement('div')
				el.className = 'peer-cursor'
				el.innerHTML =
					'<canvas></canvas>' +
					'<span class="peer-cursor-label"><span class="peer-cursor-name"></span><span class="peer-cursor-message"></span></span>'
				const canvas = el.querySelector('canvas')!
				const label = el.querySelector<HTMLSpanElement>('.peer-cursor-label')!
				const message = el.querySelector<HTMLSpanElement>('.peer-cursor-message')!
				this.host.appendChild(el)
				const cursor = { el, canvas, label, message, shown: { ...peer.cursor }, color: '', dpr: 0, name: '', chat: null }
				// (it's drawn once, so draw it again if the GPU resets and wipes it)
				canvas.addEventListener('contextrestored', () => (cursor.dpr = 0))
				c = cursor
				this.cursors.set(peer.clientId, c)
			}
			const dpr = window.devicePixelRatio || 1
			if (c.color !== peer.user.color || c.dpr !== dpr) {
				c.color = peer.user.color
				c.dpr = dpr
				drawCursor(c.canvas, c.color, dpr)
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
			// (on whole device pixels, so its bitmap stays crisp)
			c.el.style.transform = `translate(${Math.round(p.x * dpr) / dpr}px, ${Math.round(p.y * dpr) / dpr}px)`
			c.el.classList.toggle('followed', peer.clientId === followingId)
		}

		for (const [id, c] of this.cursors) {
			if (seen.has(id)) continue
			c.el.remove()
			this.cursors.delete(id)
		}
	}

	destroy() {
		this.dispose()
		this.host.remove()
	}
}

/** A person's cursor: an arrow in their colour with a white outline and a soft shadow, tip on the hotspot (0, 0). */
function drawCursor(canvas: HTMLCanvasElement, color: string, dpr: number) {
	canvas.width = Math.round(BOX.w * dpr)
	canvas.height = Math.round(BOX.h * dpr)
	canvas.style.width = `${BOX.w}px`
	canvas.style.height = `${BOX.h}px`
	canvas.style.left = `${BOX.x}px`
	canvas.style.top = `${BOX.y}px`
	const ctx = canvas.getContext('2d')!
	ctx.clearRect(0, 0, canvas.width, canvas.height)
	ctx.setTransform(dpr, 0, 0, dpr, -BOX.x * dpr, -BOX.y * dpr)
	ctx.lineJoin = 'round'
	ctx.shadowColor = 'rgba(0, 0, 0, 0.35)'
	ctx.shadowBlur = 3
	ctx.shadowOffsetY = 1
	ctx.fillStyle = color
	ctx.fill(ARROW)
	ctx.shadowColor = 'transparent'
	ctx.strokeStyle = '#fff'
	ctx.lineWidth = 1.5
	ctx.stroke(ARROW)
}
