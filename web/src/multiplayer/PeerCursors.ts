import type { Editor } from '../editor/Editor'
import type { Vec } from '../editor/geometry'
import { AgentWorms } from './AgentWorms'
import type { Attention } from './Attention'
import type { Conjure } from './Conjure'
import { NATIVE, drawBody, palette, place } from './Pointer'
import type { Peer, Presence } from './Presence'

const EASE_MS = 45
/** how tall a person's cursor is on screen, px: a normal cursor, a bit smaller than a creature */
const CURSOR_H = 21
/** room round it in its little canvas for the shadow, px */
const PAD = 4

/**
 * Other people's cursors, drawn as DOM in screen space. Positions are eased toward the latest
 * broadcast point every frame, so cursors glide instead of stepping at the network rate.
 * Sessions' creatures are drawn instead of a cursor (see AgentWorms).
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
	private worms: AgentWorms
	private dispose: () => void

	constructor(
		parent: HTMLElement,
		private editor: Editor,
		private presence: Presence,
		private conjure: Conjure | null = null,
		attention: Attention | null = null,
	) {
		this.host = document.createElement('div')
		this.host.className = 'peer-cursors'
		parent.appendChild(this.host)
		this.worms = new AgentWorms(this.host, editor, conjure, attention)
		this.dispose = editor.onFrame((now, elapsed) => this.update(now, elapsed))
	}

	private update(now: number, elapsed: number) {
		const k = 1 - Math.exp(-elapsed / EASE_MS)
		const followingId = this.presence.followingId.peek()
		const seen = new Set<number>()
		const agents: Peer[] = []

		for (const peer of this.presence.peers.peek()) {
			if (peer.user.agent) {
				// (Only creatures: agents using the canvas through MCP have no presence of their own.)
				if (peer.user.conjured) agents.push(peer)
				continue
			}
			if (!peer.cursor) continue
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

		// Conjured worms nobody runs right now sleep where they were put.
		if (this.conjure) agents.push(...this.conjure.sleepers.get())
		// Creatures of hidden frames hide with them.
		const sessions = this.editor.sessions.peek()
		this.worms.update(now, elapsed, agents.filter((p) => !p.user.sessionId || !sessions[p.user.sessionId]?.hidden))
	}

	destroy() {
		this.dispose()
		this.worms.destroy()
		this.host.remove()
	}
}

let cursorShape: { box: { x: number; y: number; w: number; h: number }; draw: (ctx: CanvasRenderingContext2D, dpr: number, color: string) => void } | null =
	null

/**
 * A person's cursor: the creatures' wedge (see Pointer) without the eye, at its native heading (tip
 * up-left, like a normal pointer), with the very tip of its rounded point on the hotspot (0, 0).
 */
function cursorGeometry() {
	if (cursorShape) return cursorShape
	const probe = place({ x: 0, y: 0 }, NATIVE, 1)
	const ys = probe.ring.map((p) => p.y)
	const scale = CURSOR_H / (Math.max(...ys) - Math.min(...ys))
	const shape0 = place({ x: 0, y: 0 }, NATIVE, scale)
	const dir = { x: Math.cos(NATIVE), y: Math.sin(NATIVE) }
	const tip = shape0.ring.reduce((a, p) => (p.x * dir.x + p.y * dir.y > a.x * dir.x + a.y * dir.y ? p : a))
	const shape = place({ x: -tip.x, y: -tip.y }, NATIVE, scale)
	const xs = shape.ring.map((p) => p.x)
	const ys2 = shape.ring.map((p) => p.y)
	const x = Math.floor(Math.min(...xs)) - PAD
	const y = Math.floor(Math.min(...ys2)) - PAD
	const box = { x, y, w: Math.ceil(Math.max(...xs)) + PAD - x, h: Math.ceil(Math.max(...ys2)) + PAD + 1 - y }
	cursorShape = {
		box,
		draw: (ctx, dpr, color) => {
			ctx.setTransform(dpr, 0, 0, dpr, -box.x * dpr, -box.y * dpr)
			drawBody(ctx, shape, palette(color), { dpr })
		},
	}
	return cursorShape
}

function drawCursor(canvas: HTMLCanvasElement, color: string, dpr: number) {
	const { box, draw } = cursorGeometry()
	canvas.width = Math.round(box.w * dpr)
	canvas.height = Math.round(box.h * dpr)
	canvas.style.width = `${box.w}px`
	canvas.style.height = `${box.h}px`
	canvas.style.left = `${box.x}px`
	canvas.style.top = `${box.y}px`
	const ctx = canvas.getContext('2d')!
	ctx.clearRect(0, 0, canvas.width, canvas.height)
	draw(ctx, dpr, color)
}
