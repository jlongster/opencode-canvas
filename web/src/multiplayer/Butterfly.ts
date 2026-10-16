import type { Vec } from '../editor/geometry'
import './butterfly.css'

/**
 * Drawing for conjured sessions' butterflies (see AgentWorms): the worm grown up. Everything is in
 * screen px at size 1; AgentWorms passes the size (scale) and the pose each frame.
 *
 * The butterfly is seen from the side and a little above. Its body runs along F (forward, toward
 * the head) and U is "up" from its back. Each wing is a flat shape in (p, q): p along the body,
 * q out along the span. Opening the wings by phi rotates them around the body axis, the far wing
 * away from us and the near one toward us; looked at from ELEVATION above, a span of q lands on
 * screen at q * cos(phi - ELEVATION) along U for the far wing and q * cos(phi + ELEVATION) for the
 * near one. Closed (phi 0) both stand up together; open flat (phi 90°) they spread above and below.
 */

/** how far above the butterfly we look from */
const ELEVATION = (50 * Math.PI) / 180
export const HEAD_R = 7
/** where the wings join the body (the thorax), behind the head */
export const THORAX: Vec = { x: -9, y: -1 }
const OUTLINE = 1.5
/** wings are drawn this much bigger than their outlines below */
export const WING = 1.25
/** how far the wings lean back along the body, per unit of span */
export const SWEEP = 0.2

export interface Colors {
	base: string
	dark: string
	light: string
	/** the far wings, in shadow */
	far: string
	farLight: string
	/** the chrysalis */
	silk: string
}

/** A frame on screen: origin (the head), forward and up unit-ish vectors, and the size. */
export interface Pose {
	o: Vec
	F: Vec
	U: Vec
	s: number
}

export function pt(pose: Pose, u: number, w: number): Vec {
	const { o, F, U, s } = pose
	return { x: o.x + (u * F.x + w * U.x) * s, y: o.y + (u * F.y + w * U.y) * s }
}

/** The screen direction of a wing's span (per unit q), and its length factor (negative: below the body). */
export function wingSpan(phi: number, far: boolean) {
	return Math.cos(far ? phi - ELEVATION : phi + ELEVATION)
}

type WingKind = 'fore' | 'hind'

/** Wing outlines in (p, q), root near the origin, q out along the span. */
function wingPath(ctx: CanvasRenderingContext2D, kind: WingKind, k = 1, cp = 0, cq = 0) {
	const P = (p: number) => cp + (p - cp) * k
	const Q = (q: number) => cq + (q - cq) * k
	if (kind === 'fore') {
		ctx.moveTo(P(2), Q(0))
		ctx.bezierCurveTo(P(5), Q(8), P(7), Q(17), P(4), Q(23))
		ctx.bezierCurveTo(P(1), Q(27), P(-7), Q(25), P(-11), Q(19))
		ctx.bezierCurveTo(P(-14), Q(14), P(-9), Q(6), P(-4), Q(0))
	} else {
		ctx.moveTo(P(-2), Q(0))
		ctx.bezierCurveTo(P(-2), Q(7), P(-5), Q(14), P(-11), Q(15))
		ctx.bezierCurveTo(P(-18), Q(16), P(-21), Q(10), P(-17), Q(5))
		ctx.bezierCurveTo(P(-14), Q(1), P(-10), Q(-1), P(-6), Q(-1))
	}
	ctx.closePath()
}

/** Light spots near the wing's edge, (p, q, r). */
const SPOTS: Record<WingKind, [number, number, number][]> = {
	fore: [
		[1.5, 21, 1.6],
		[-3, 23, 1.4],
		[-7.5, 21, 1.3],
	],
	hind: [
		[-12, 12.5, 1.4],
		[-16.5, 10, 1.2],
	],
}

/**
 * One wing at `root`, spanning `span` (see wingSpan). The outline is stroked in screen space so
 * it stays even however the wing is foreshortened.
 */
export function drawWing(
	ctx: CanvasRenderingContext2D,
	pose: Pose,
	kind: WingKind,
	root: Vec,
	span: number,
	far: boolean,
	c: Colors,
	sweep = SWEEP,
) {
	const { F, U, s } = pose
	// Never quite edge-on, which would leave nothing to fill.
	const q = Math.abs(span) < 0.04 ? (span < 0 ? -0.04 : 0.04) : span
	const w = s * WING
	const back = sweep * Math.abs(q)
	const m: [number, number, number, number, number, number] = [F.x * w, F.y * w, (U.x * q - F.x * back) * w, (U.y * q - F.y * back) * w, root.x, root.y]
	const inLocal = (draw: () => void) => {
		ctx.save()
		ctx.transform(...m)
		ctx.beginPath()
		draw()
		ctx.restore()
	}
	ctx.lineJoin = 'round'
	inLocal(() => wingPath(ctx, kind))
	ctx.fillStyle = far ? c.far : c.base
	ctx.fill()
	// The lighter middle, a leaf-vein of colour toward the root.
	inLocal(() => (kind === 'fore' ? wingPath(ctx, kind, 0.58, -3, 3) : wingPath(ctx, kind, 0.55, -6, 2)))
	ctx.fillStyle = far ? c.farLight : c.light
	const a = ctx.globalAlpha
	ctx.globalAlpha = a * 0.75
	ctx.fill()
	ctx.globalAlpha = a
	// An eye-spot on the forewing, and pale dots along the edges.
	if (kind === 'fore') {
		inLocal(() => ctx.ellipse(-3, 13, 2.4, 2.4, 0, 0, Math.PI * 2))
		ctx.fillStyle = c.dark
		ctx.fill()
		inLocal(() => ctx.ellipse(-3, 13, 1.1, 1.1, 0, 0, Math.PI * 2))
		ctx.fillStyle = far ? c.farLight : c.light
		ctx.fill()
	}
	if (!far) {
		for (const [p, qq, r] of SPOTS[kind]) {
			inLocal(() => ctx.ellipse(p, qq, r, r, 0, 0, Math.PI * 2))
			ctx.fillStyle = c.light
			ctx.fill()
		}
	}
	inLocal(() => wingPath(ctx, kind))
	ctx.strokeStyle = c.dark
	ctx.lineWidth = OUTLINE * s
	ctx.stroke()
}

/** The body behind the head: a thorax and a short segmented abdomen, drawn like the worm. */
export function drawBody(ctx: CanvasRenderingContext2D, pose: Pose, c: Colors, droop: number) {
	const { s } = pose
	const segs: [number, number, number][] = [
		[-25, -3.4 - droop * 2.2, 2.6],
		[-21.5, -2.4 - droop * 1.4, 3.4],
		[-17.5, -1.6 - droop * 0.7, 4.1],
		[-13, -1, 4.6],
		[THORAX.x, THORAX.y, 5.6],
	]
	const pts = segs.map(([u, w]) => pt(pose, u, w))
	ctx.fillStyle = c.dark
	pts.forEach((p, i) => disc(ctx, p.x, p.y, (segs[i][2] + OUTLINE) * s))
	ctx.fillStyle = c.base
	pts.forEach((p, i) => disc(ctx, p.x, p.y, segs[i][2] * s))
	// Segment rings, like the worm's.
	ctx.strokeStyle = c.light
	ctx.lineCap = 'round'
	ctx.lineWidth = 1.2 * s
	const a = ctx.globalAlpha
	ctx.globalAlpha = a * 0.8
	for (let i = 1; i < 4; i++) {
		const p = pts[i]
		const r = segs[i][2] * 0.75 * s
		const n = { x: pose.U.x, y: pose.U.y }
		ctx.beginPath()
		ctx.moveTo(p.x - n.x * r + pose.F.x * s * 1.6, p.y - n.y * r + pose.F.y * s * 1.6)
		ctx.lineTo(p.x + n.x * r + pose.F.x * s * 1.6, p.y + n.y * r + pose.F.y * s * 1.6)
		ctx.stroke()
	}
	ctx.globalAlpha = a
}

/** Two little antennae with knobs, the near one with the worm's sparkle. Returns the sparkle's spot. */
export function drawAntennae(ctx: CanvasRenderingContext2D, pose: Pose, c: Colors, sway: number, knob: number): Vec {
	const { s } = pose
	ctx.strokeStyle = c.dark
	ctx.lineWidth = 1.3 * s
	ctx.lineCap = 'round'
	let tip: Vec = pose.o
	for (const far of [true, false]) {
		const du = far ? -2.2 : 0
		const sw = sway * (far ? 0.8 : 1)
		const base = pt(pose, -1 + du, HEAD_R * 0.75)
		const ctl = pt(pose, 1 + du + sw * 2, HEAD_R + 8)
		const end = pt(pose, 5 + du + sw * 6, HEAD_R + 12 - Math.abs(sw) * 2)
		ctx.beginPath()
		ctx.moveTo(base.x, base.y)
		ctx.quadraticCurveTo(ctl.x, ctl.y, end.x, end.y)
		ctx.stroke()
		if (far) {
			ctx.fillStyle = c.dark
			disc(ctx, end.x, end.y, 1.6 * s * knob)
		}
		tip = end
	}
	return tip
}

/** The chrysalis: a plump silk-wrapped pod along the body, with threads around it. */
export function drawCocoon(ctx: CanvasRenderingContext2D, at: Vec, s: number, angle: number, wrap: number, crack: number, c: Colors) {
	ctx.save()
	ctx.translate(at.x, at.y)
	ctx.rotate(angle)
	const rx = 15 * s
	const ry = 9.5 * s
	ctx.fillStyle = c.dark
	ctx.beginPath()
	ctx.ellipse(0, 0, rx + OUTLINE * s, ry + OUTLINE * s, 0, 0, Math.PI * 2)
	ctx.fill()
	ctx.fillStyle = c.silk
	ctx.beginPath()
	ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2)
	ctx.fill()
	// Silk threads wound round it, more of them as it wraps up.
	ctx.save()
	ctx.beginPath()
	ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2)
	ctx.clip()
	ctx.strokeStyle = c.base
	ctx.lineWidth = 1.3 * s
	ctx.globalAlpha *= 0.7
	const threads = 6
	for (let i = 0; i < threads; i++) {
		const f = (i + 1) / (threads + 1)
		if (f > wrap) break
		const x = -rx + f * rx * 2
		ctx.beginPath()
		ctx.moveTo(x - 4 * s, -ry)
		ctx.quadraticCurveTo(x + 3 * s, 0, x - 3 * s, ry)
		ctx.stroke()
	}
	ctx.restore()
	// A shine on top.
	ctx.fillStyle = 'rgba(255, 255, 255, 0.45)'
	ctx.beginPath()
	ctx.ellipse(-rx * 0.25, -ry * 0.5, rx * 0.35, ry * 0.18, -0.15, 0, Math.PI * 2)
	ctx.fill()
	// About to burst: a glowing zigzag crack.
	if (crack > 0) {
		ctx.strokeStyle = '#fffbe6'
		ctx.shadowColor = c.light
		ctx.shadowBlur = 8 * crack
		ctx.lineWidth = 1.6 * s
		ctx.lineJoin = 'round'
		ctx.beginPath()
		const n = 6
		for (let i = 0; i <= n; i++) {
			const x = -rx * 0.75 + (i / n) * rx * 1.5 * crack
			const y = (i % 2 === 0 ? -1 : 1) * 2.2 * s
			if (i === 0) ctx.moveTo(x, y)
			else ctx.lineTo(x, y)
		}
		ctx.stroke()
	}
	ctx.restore()
}

/** The pod's two halves flying apart and fading, t 0..1. */
export function drawShell(ctx: CanvasRenderingContext2D, at: Vec, s: number, t: number, c: Colors) {
	const a = ctx.globalAlpha
	ctx.globalAlpha = a * Math.max(0, 1 - t)
	for (const side of [-1, 1]) {
		ctx.save()
		ctx.translate(at.x + side * t * 16 * s, at.y + t * t * 22 * s - t * 6 * s)
		ctx.rotate(side * t * 1.2)
		ctx.beginPath()
		ctx.ellipse(0, 0, 15 * s, 9.5 * s, 0, side < 0 ? Math.PI * 0.5 : -Math.PI * 0.5, side < 0 ? Math.PI * 1.5 : Math.PI * 0.5)
		ctx.closePath()
		ctx.fillStyle = c.silk
		ctx.fill()
		ctx.strokeStyle = c.dark
		ctx.lineWidth = OUTLINE * s
		ctx.stroke()
		ctx.restore()
	}
	ctx.globalAlpha = a
}

/** Sparkles bursting out of the chrysalis, t 0..1. */
export function drawBurst(ctx: CanvasRenderingContext2D, at: Vec, s: number, t: number, seed: number, c: Colors) {
	const a = ctx.globalAlpha
	const n = 11
	for (let i = 0; i < n; i++) {
		const ang = seed + (i / n) * Math.PI * 2 + Math.sin(seed * 3 + i) * 0.3
		const reach = (26 + 14 * ((i * 7) % 3)) * s
		const d = reach * (1 - Math.pow(1 - t, 3))
		const r = (i % 3 === 0 ? 4.2 : 3) * s * (1 - t * 0.6)
		ctx.globalAlpha = a * Math.min(1, (1 - t) * 1.8)
		sparkle(ctx, at.x + Math.cos(ang) * d, at.y + Math.sin(ang) * d * 0.8, r, t * 3 + i, i % 2 ? '#fffbe6' : c.light, c.dark)
	}
	// and a soft flash
	ctx.globalAlpha = a * Math.max(0, 0.5 - t) * 1.2
	ctx.fillStyle = '#fffbe6'
	disc(ctx, at.x, at.y, (10 + 30 * t) * s)
	ctx.globalAlpha = a
}

export function disc(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
	if (r <= 0) return
	ctx.beginPath()
	ctx.arc(x, y, r, 0, Math.PI * 2)
	ctx.fill()
}

export function ellipse(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number) {
	if (rx <= 0 || ry <= 0) return
	ctx.beginPath()
	ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2)
	ctx.fill()
}

export function sparkle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, spin: number, fill: string, stroke: string) {
	if (r <= 0) return
	ctx.beginPath()
	for (let i = 0; i < 8; i++) {
		const a = spin + (i * Math.PI) / 4
		const d = i % 2 === 0 ? r : r * 0.32
		const px = x + Math.cos(a) * d
		const py = y + Math.sin(a) * d
		if (i === 0) ctx.moveTo(px, py)
		else ctx.lineTo(px, py)
	}
	ctx.closePath()
	ctx.fillStyle = fill
	ctx.strokeStyle = stroke
	ctx.lineWidth = 0.9
	ctx.fill()
	ctx.stroke()
}
