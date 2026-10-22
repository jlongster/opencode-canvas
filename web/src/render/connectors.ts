import type { Editor } from '../editor/Editor'
import type { Box, Vec } from '../editor/geometry'

/*
 * Lines from a session's frame to its subagents' frames, drawn on a 2D canvas laid over the
 * WebGPU one and kept in step with the camera, so they stay crisp and a constant width on screen
 * at any zoom. They follow the frames as drawn (the renderer eases frames toward the layout), and
 * route through the gutter between a parent and its children, so they never cross a frame.
 */

export type ConnectorKind = 'elbow' | 'bus' | 'curve' | 'curvedBus'

export interface ConnectorStyle {
	/**
	 * elbow: one orthogonal route per child, in parallel lanes that never cross; bus: one shared
	 * spine with a branch to each child; curve: a cubic from the parent to each child (horizontal
	 * tangents); curvedBus: a shared spine whose turns are round
	 */
	kind: ConnectorKind
	/** screen px */
	width: number
	/** the parent's colour, each child's own, or a neutral grey */
	color: 'session' | 'child' | 'neutral'
	opacity: number
	dashed: boolean
	ends: 'none' | 'dot' | 'square'
	/** where lines leave the parent: the middle of its right edge, or its title row */
	from: 'middle' | 'title'
	/** where they reach a child: its title row, or the middle of its left edge */
	to: 'title' | 'middle'
	/** screen px: corner radius of elbows and bus junctions; the curved bus's turns */
	radius: number
}

export interface ConnectorLink {
	childId: string
	color: string
	/** page px from the child's top to its title row (scaled with it) */
	titleY: number
	/**
	 * 1: the line goes to the child; 0: the child is hidden in a stack and the line goes to the
	 * stack's front card instead; in between while it slides out
	 */
	reveal: number
	frontId: string
}

export interface ConnectorFamily {
	parentId: string
	color: string
	/** page px from the parent's top to its title row */
	titleY: number
	links: ConnectorLink[]
}

export const DEFAULT_STYLE: ConnectorStyle = {
	kind: 'bus',
	width: 1.5,
	color: 'session',
	opacity: 0.7,
	dashed: false,
	ends: 'dot',
	from: 'title',
	to: 'title',
	radius: 6,
}

interface Route {
	b: Vec
	color: string
	alpha: number
}

export class Connectors {
	readonly canvas = document.createElement('canvas')
	private ctx: CanvasRenderingContext2D
	private ro: ResizeObserver
	private size = { w: 0, h: 0, dpr: 1 }
	private signature = ''
	families: ConnectorFamily[] = []
	style: ConnectorStyle = { ...DEFAULT_STYLE }

	constructor(
		private host: HTMLElement,
		private editor: Editor,
		/** the box a frame is drawn at right now (the renderer's eased one), and its opacity */
		private boxOf: (id: string) => (Box & { opacity?: number }) | undefined,
	) {
		this.canvas.className = 'connectors'
		this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none'
		// Under the frame titles and everything else in the overlay.
		host.prepend(this.canvas)
		this.ctx = this.canvas.getContext('2d')!
		this.ro = new ResizeObserver(() => this.resize())
		this.ro.observe(host)
		this.resize()
	}

	private resize() {
		const r = this.host.getBoundingClientRect()
		const dpr = Math.min(window.devicePixelRatio || 1, 3)
		this.size = { w: r.width, h: r.height, dpr }
		this.canvas.width = Math.max(1, Math.round(r.width * dpr))
		this.canvas.height = Math.max(1, Math.round(r.height * dpr))
		this.signature = ''
	}

	/** Redraws when the camera, a frame, the families or the style changed. Call every frame. */
	draw() {
		const cam = this.editor.camera.peek()
		let sig = `${cam.x.toFixed(2)},${cam.y.toFixed(2)},${cam.z.toFixed(5)},${this.size.w},${this.size.h},${JSON.stringify(this.style)}`
		for (const f of this.families) {
			sig += `|${f.parentId}:${key(this.boxOf(f.parentId))}`
			for (const l of f.links) sig += `;${l.childId}:${key(this.boxOf(l.childId))}:${l.reveal.toFixed(3)}:${l.frontId}:${l.color}`
		}
		if (sig === this.signature) return
		this.signature = sig

		const { ctx } = this
		const { dpr } = this.size
		ctx.setTransform(1, 0, 0, 1, 0, 0)
		ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
		const toScreen = (p: Vec): Vec => ({ x: (p.x + cam.x) * cam.z, y: (p.y + cam.y) * cam.z })
		for (const f of this.families) this.drawFamily(f, toScreen)
	}

	private drawFamily(f: ConnectorFamily, toScreen: (p: Vec) => Vec) {
		const st = this.style
		const P = this.boxOf(f.parentId)
		if (!P || !f.links.length) return
		const fade = P.opacity ?? 1
		const a = toScreen({ x: P.x + P.w, y: st.from === 'middle' ? P.y + P.h / 2 : P.y + f.titleY })
		const anchor = (id: string, titleY: number): Vec | null => {
			const C = this.boxOf(id)
			if (!C) return null
			return toScreen({ x: C.x, y: st.to === 'middle' ? C.y + C.h / 2 : C.y + titleY })
		}
		const routes: Route[] = []
		for (const l of f.links) {
			const own = anchor(l.childId, l.titleY)
			if (!own) continue
			const frontLink = f.links.find((x) => x.childId === l.frontId)
			const front = l.childId === l.frontId || !frontLink ? own : anchor(l.frontId, frontLink.titleY)
			const t = l.childId === l.frontId ? 1 : l.reveal
			const b = front ? { x: front.x + (own.x - front.x) * t, y: front.y + (own.y - front.y) * t } : own
			// A child still hidden in the stack shares its line with the front card: drawn once, not twice.
			const alpha = l.childId === l.frontId ? 1 : Math.min(1, t * 1.5)
			if (alpha <= 0.002) continue
			routes.push({ b, color: st.color === 'child' ? l.color : st.color === 'session' ? f.color : NEUTRAL, alpha })
		}
		if (!routes.length) return
		const left = Math.min(...routes.map((r) => r.b.x))
		if (left <= a.x + 2) return
		const gx = a.x + (left - a.x) * 0.5

		const ctx = this.ctx
		ctx.lineWidth = st.width
		ctx.lineJoin = 'round'
		ctx.lineCap = st.dashed ? 'butt' : 'round'
		ctx.setLineDash(st.dashed ? [st.width * 4, st.width * 3] : [])

		// Fully revealed routes in one colour go into one path, so shared segments aren't drawn twice.
		const groups = new Map<string, Route[]>()
		for (const r of routes) {
			const k = `${r.color}|${r.alpha >= 0.999 ? 1 : r.alpha.toFixed(3)}`
			let list = groups.get(k)
			if (!list) groups.set(k, (list = []))
			list.push(r)
		}
		const lanes = this.lanes(a, routes, gx, left)
		for (const list of groups.values()) {
			ctx.strokeStyle = rgba(list[0].color, st.opacity * list[0].alpha * fade)
			ctx.beginPath()
			for (const r of list) this.path(a, r, gx, lanes.get(r) ?? gx)
			ctx.stroke()
		}
		ctx.setLineDash([])
		if (st.ends === 'none') return
		for (const r of routes) {
			ctx.fillStyle = rgba(r.color, Math.min(1, st.opacity * 1.2) * r.alpha * fade)
			this.end(r.b)
		}
		ctx.fillStyle = rgba(routes[0].color, Math.min(1, st.opacity * 1.2) * fade)
		this.end(a)
	}

	/**
	 * Elbow lanes: each route gets its own vertical, the shallower ones (closest to the parent's
	 * anchor in y) nearer the children, so the L shapes nest and never cross.
	 */
	private lanes(a: Vec, routes: Route[], gx: number, left: number) {
		const out = new Map<Route, number>()
		if (this.style.kind !== 'elbow') return out
		const spacing = Math.max(3, this.style.width * 3)
		const room = Math.max(0, (left - a.x) * 0.8)
		for (const dir of [-1, 1]) {
			const side = routes.filter((r) => Math.sign(r.b.y - a.y) === dir).sort((p, q) => Math.abs(q.b.y - a.y) - Math.abs(p.b.y - a.y))
			const n = side.length
			const step = n > 1 ? Math.min(spacing, room / (n - 1)) : 0
			side.forEach((r, i) => out.set(r, gx + (i - (n - 1) / 2) * step))
		}
		return out
	}

	private path(a: Vec, r: Route, gx: number, lane: number) {
		const ctx = this.ctx
		const { b } = r
		const st = this.style
		const dy = b.y - a.y
		ctx.moveTo(a.x, a.y)
		if (st.kind === 'curve') {
			const k = (b.x - a.x) * 0.5
			ctx.bezierCurveTo(a.x + k, a.y, b.x - k, b.y, b.x, b.y)
			return
		}
		if (Math.abs(dy) < 0.75) {
			ctx.lineTo(b.x, b.y)
			return
		}
		if (st.kind === 'elbow') {
			const r0 = Math.min(st.radius, Math.abs(dy) / 2, lane - a.x, b.x - lane)
			ctx.arcTo(lane, a.y, lane, b.y, Math.max(0, r0))
			ctx.arcTo(lane, b.y, b.x, b.y, Math.max(0, r0))
			ctx.lineTo(b.x, b.y)
			return
		}
		// Bus: the trunk to the spine, down the spine, out along the branch; routes share the trunk and
		// spine exactly, so it reads as one line with a T at each branch (its corner softened by the radius).
		// The curved bus turns along wide quarter circles instead.
		const want = st.kind === 'bus' ? st.radius : Math.max(14, st.radius * 3)
		const R = Math.max(0, Math.min(want, Math.abs(dy) / 2, gx - a.x, b.x - gx))
		ctx.arcTo(gx, a.y, gx, b.y, R)
		ctx.arcTo(gx, b.y, b.x, b.y, R)
		ctx.lineTo(b.x, b.y)
	}

	private end(p: Vec) {
		const ctx = this.ctx
		const st = this.style
		const r = Math.max(2.25, st.width * 1.6)
		ctx.beginPath()
		if (st.ends === 'dot') ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
		else ctx.rect(p.x - r, p.y - r, r * 2, r * 2)
		ctx.fill()
	}

	destroy() {
		this.ro.disconnect()
		this.canvas.remove()
	}
}

const NEUTRAL = '#a1a1aa'

function key(b: (Box & { opacity?: number }) | undefined) {
	return b ? `${b.x.toFixed(1)},${b.y.toFixed(1)},${b.w.toFixed(1)},${b.h.toFixed(1)},${(b.opacity ?? 1).toFixed(2)}` : '-'
}

function rgba(hex: string, a: number) {
	const n = parseInt(hex.slice(1), 16)
	return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, a)).toFixed(3)})`
}
