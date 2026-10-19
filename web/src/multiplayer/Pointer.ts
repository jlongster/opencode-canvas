import type { Vec } from '../editor/geometry'

/**
 * The eye pointer: sessions' creatures (see AgentWorms). A wedge, like a mouse pointer that can
 * point any way: two straight sides from a rounded tip, two rounded back corners, and a smooth
 * concave notch in the middle of its back. One eye, at its centroid.
 *
 * The outline is built from a few parameters (SHAPE), symmetric about its axis, in units of its
 * length (tip to back corners), then turned to its native heading (NATIVE: tip up-left, like a
 * pointer) and centred on its area's centroid; it's drawn rotated about that centre so the tip
 * points along any heading. The lighting (a lit rim on the edges facing the top left, a bevel in
 * shade on the ones facing away, all the way round; the eye's catchlight) is in screen space, so it
 * stays lit from the top left however it turns, and so does the eye's lid, which always comes down
 * from the top.
 */

/** its length on screen, tip to back corners, px (it's drawn this size whatever the zoom) */
export const SIZE = 33
/** its centre sits this far above the point on the page where it is (its root), screen px */
export const LIFT = 20

/** The outline's parameters, in units of its length. */
const SHAPE = {
	/** half the angle at its tip, radians */
	halfAngle: (21 * Math.PI) / 180,
	/** how far the notch's middle reaches in from the back corners' line */
	notchDepth: 0.125,
	/** how much of each half of the back curves round into the notch's bottom (the rest is straight) */
	notchRound: 0.32,
	/** how round the tip and back corners are: how far along each edge the rounding starts */
	tipRadius: 0.09,
	cornerRadius: 0.1,
	/** the eye's radius */
	eye: 0.127,
}
/** the way its tip points by default, radians (screen: x right, y down): up and to the left */
export const NATIVE = (-125 * Math.PI) / 180

type Seg = { kind: 'L'; to: Vec } | { kind: 'Q'; c: Vec; to: Vec } | { kind: 'C'; c1: Vec; c2: Vec; to: Vec }

/** The outline as a start point and segments, in units, tip along +x at the origin. */
function outline(): { start: Vec; segs: Seg[] } {
	const h = Math.tan(SHAPE.halfAngle)
	const T = { x: 0, y: 0 }
	const C1 = { x: -1, y: h }
	const C2 = { x: -1, y: -h }
	const N = { x: -1 + SHAPE.notchDepth, y: 0 }
	const along = (a: Vec, b: Vec, d: number) => {
		const l = Math.hypot(b.x - a.x, b.y - a.y) || 1
		return { x: a.x + ((b.x - a.x) / l) * d, y: a.y + ((b.y - a.y) / l) * d }
	}
	const rt = SHAPE.tipRadius
	const rc = SHAPE.cornerRadius
	const lerp = (a: Vec, b: Vec, t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
	const a1 = lerp(N, C1, SHAPE.notchRound)
	const a2 = lerp(N, C2, SHAPE.notchRound)
	return {
		start: along(T, C1, rt),
		segs: [
			{ kind: 'L', to: along(C1, T, rc) },
			{ kind: 'Q', c: C1, to: along(C1, N, rc) },
			{ kind: 'L', to: a1 },
			{ kind: 'C', c1: lerp(a1, N, 0.6), c2: lerp(a2, N, 0.6), to: a2 },
			{ kind: 'L', to: along(C2, N, rc) },
			{ kind: 'Q', c: C2, to: along(C2, T, rc) },
			{ kind: 'L', to: along(T, C2, rt) },
			{ kind: 'Q', c: T, to: along(T, C1, rt) },
		],
	}
}

/** The outline sampled as a polygon, in the same frame. */
function sample(o: { start: Vec; segs: Seg[] }, n = 10): Vec[] {
	const pts: Vec[] = [o.start]
	let at = o.start
	for (const s of o.segs) {
		if (s.kind === 'L') pts.push(s.to)
		else
			for (let i = 1; i <= n; i++) {
				const t = i / n
				const u = 1 - t
				pts.push(
					s.kind === 'Q'
						? { x: u * u * at.x + 2 * u * t * s.c.x + t * t * s.to.x, y: u * u * at.y + 2 * u * t * s.c.y + t * t * s.to.y }
						: {
								x: u * u * u * at.x + 3 * u * u * t * s.c1.x + 3 * u * t * t * s.c2.x + t * t * t * s.to.x,
								y: u * u * u * at.y + 3 * u * u * t * s.c1.y + 3 * u * t * t * s.c2.y + t * t * t * s.to.y,
							},
				)
			}
		at = s.to
	}
	pts.pop()
	return pts
}

const RAW = outline()
const CENTRE = centroid(sample(RAW))
/** a point of the raw outline, turned to NATIVE about its centroid */
const native = (p: Vec): Vec => {
	const c = Math.cos(NATIVE)
	const s = Math.sin(NATIVE)
	const x = p.x - CENTRE.x
	const y = p.y - CENTRE.y
	return { x: x * c - y * s, y: x * s + y * c }
}
/** how far its tip is from its centre, in units */
export const TIP_REACH = Math.hypot(CENTRE.x, CENTRE.y)
/** The outline as SVG path data, in units about its centre (also how the canvas draws it). */
export const POINTER_D = pointerD(1)
/** Its eye about its centre, in units: right on the centroid. */
export const POINTER_EYE = { x: 0, y: 0, r: SHAPE.eye }
/** Its outline as a polygon about its centre, in units (for hit testing). */
const POLY = sample(RAW, 4).map(native)
/** Its tip about its centre, in units. */
const TIP = native({ x: 0, y: 0 })
/** Its outline finely sampled, with each edge's outward normal, for the rim (see drawPointer). */
const RING = sample(RAW, 12).map(native)
const OUTWARD = (() => {
	const a = RING[0]
	const b = RING[1]
	const m = { x: (a.x + b.x) / 2 + (b.y - a.y) * 0.01, y: (a.y + b.y) / 2 - (b.x - a.x) * 0.01 }
	return inside(RING, m) ? -1 : 1
})()
/** where the light comes from (screen): above, a little to the left */
const LIGHT = (() => {
	const l = Math.hypot(0.3, 0.95)
	return { x: -0.3 / l, y: -0.95 / l }
})()

let unitPath: Path2D | null = null

/** The outline as SVG path data about its centre, `scale` px to its length, at its native heading. */
export function pointerD(scale: number): string {
	const c = (p: Vec) => {
		const q = native(p)
		return `${(q.x * scale).toFixed(3)} ${(q.y * scale).toFixed(3)}`
	}
	const out = [`M ${c(RAW.start)}`]
	for (const s of RAW.segs) {
		if (s.kind === 'L') out.push(`L ${c(s.to)}`)
		else if (s.kind === 'Q') out.push(`Q ${c(s.c)} ${c(s.to)}`)
		else out.push(`C ${c(s.c1)} ${c(s.c2)} ${c(s.to)}`)
	}
	out.push('Z')
	return out.join(' ')
}

function centroid(pts: Vec[]): Vec {
	let a = 0
	let x = 0
	let y = 0
	for (let i = 0; i < pts.length; i++) {
		const p = pts[i]
		const q = pts[(i + 1) % pts.length]
		const k = p.x * q.y - q.x * p.y
		a += k
		x += (p.x + q.x) * k
		y += (p.y + q.y) * k
	}
	return { x: x / (3 * a), y: y / (3 * a) }
}

export interface Palette {
	/** the colours as rgb, for blending the rim round the outline */
	rgb: { base: number[]; rim: number[]; bevel: number[] }
	base: string
	/** the lit rim along its upper edges */
	rim: string
	/** the bevel in shade along its lower edges and the notch */
	bevel: string
	/** fine lines: the lid's edge, the closed eye */
	edge: string
}

export function palette(color: string): Palette {
	const rgb = parseColor(color) ?? [34, 211, 238]
	const mix = (to: number, k: number) => rgb.map((c) => c + (to - c) * k)
	const tones = { base: mix(255, 0.03), rim: mix(255, 0.32), bevel: mix(0, 0.26) }
	const css = (c: number[]) => `rgb(${c.map(Math.round).join(', ')})`
	return { rgb: tones, base: css(tones.base), rim: css(tones.rim), bevel: css(tones.bevel), edge: mixColor(color, 0, 0.5) }
}

export interface EyeState {
	/** where it looks, -1..1 across the eye (screen space) */
	look: Vec
	/** 0 open .. 1 shut: the upper lid */
	lid: number
	/** 0..1 wide open (alarm): a bigger eye, a smaller pupil */
	wide: number
	/** a furrowed lid, sloping down toward its tip side, radians */
	slant: number
	/** 0..1 shut tight (a hard line rather than a sleepy curve) */
	squeeze: number
	/** 0..1 the lower lid up: squinting */
	lower: number
	/** 0..1 dizzy: a spinning spiral for a pupil */
	dizzy: number
}

export function openEye(): EyeState {
	return { look: { x: 0, y: 0 }, lid: 0, wide: 0, slant: 0, squeeze: 0, lower: 0, dizzy: 0 }
}

/** One pointer as placed on screen this frame. */
export interface Shape {
	centre: Vec
	heading: number
	scale: number
	path: Path2D
	/** outline in screen px, for hit testing */
	poly: Vec[]
	tip: Vec
	eye: Vec
	eyeR: number
	/** the outline finely sampled, screen px */
	ring: Vec[]
	/** its top, screen y */
	top: number
}

/** Places the pointer: centred at `centre` (screen), its tip along `heading`, `scale` times SIZE. */
export function place(centre: Vec, heading: number, scale = 1): Shape {
	const s = SIZE * scale
	const a = heading - NATIVE
	const cos = Math.cos(a)
	const sin = Math.sin(a)
	const at = (p: Vec): Vec => ({ x: centre.x + (p.x * cos - p.y * sin) * s, y: centre.y + (p.x * sin + p.y * cos) * s })
	unitPath ??= new Path2D(POINTER_D)
	const path = new Path2D()
	path.addPath(unitPath, new DOMMatrix([cos * s, sin * s, -sin * s, cos * s, centre.x, centre.y]))
	const poly = POLY.map(at)
	return {
		centre,
		heading,
		scale,
		path,
		poly,
		tip: at(TIP),
		ring: RING.map(at),
		eye: at(POINTER_EYE),
		eyeR: SHAPE.eye * s,
		top: Math.min(...poly.map((p) => p.y)),
	}
}

export interface DrawOpts {
	dpr: number
	/** a soft glow round it in its colour (thinking), 0..1 */
	glow?: number
	glowColor?: string
	/** the drop shadow's strength, 0..1 */
	shadow?: number
}

/** Draws a placed pointer: shadow, flat fill, rim and bevel lit from the top left, and its eye. */
export function drawPointer(ctx: CanvasRenderingContext2D, shape: Shape, pal: Palette, eye: EyeState, opts: DrawOpts) {
	drawBody(ctx, shape, pal, opts)
	drawEye(ctx, shape.eye, shape.eyeR, eye, pal, Math.cos(shape.heading) < 0 ? -1 : 1)
}

/** Draws a placed pointer without its eye (people's cursors use this too, see PeerCursors). */
export function drawBody(ctx: CanvasRenderingContext2D, shape: Shape, pal: Palette, opts: DrawOpts) {
	const { path, scale } = shape
	const dpr = opts.dpr
	ctx.save()
	if (opts.glow && opts.glow > 0.01) {
		ctx.save()
		ctx.shadowColor = opts.glowColor ?? pal.rim
		ctx.shadowBlur = 14 * scale * dpr * opts.glow
		ctx.globalAlpha *= Math.min(1, opts.glow)
		ctx.fillStyle = pal.base
		ctx.fill(path)
		ctx.fill(path)
		ctx.restore()
	}
	ctx.shadowColor = `rgba(0, 0, 0, ${0.42 * (opts.shadow ?? 1)})`
	ctx.shadowBlur = 4 * scale * dpr
	ctx.shadowOffsetY = 1.6 * scale * dpr
	ctx.fillStyle = pal.base
	ctx.fill(path)
	ctx.shadowColor = 'transparent'
	ctx.shadowBlur = 0
	ctx.shadowOffsetY = 0
	// A rim all the way round, each bit of edge shaded by which way it faces: lit where it faces
	// the light (top left), in shade where it faces away, blending through the flat colour between.
	ctx.clip(path)
	ctx.lineCap = 'round'
	const size = SIZE * scale
	const ring = shape.ring
	const { base, rim, bevel } = pal.rgb
	// (edges side-on to the light get a faint darker line, so the rim never quite disappears)
	const side = base.map((c, j) => c + (bevel[j] - c) * 0.35)
	for (const pass of [0, 1]) {
		ctx.globalAlpha = pass ? 1 : 0.4
		for (let i = 0; i < ring.length; i++) {
			const a = ring[i]
			const b = ring[(i + 1) % ring.length]
			const dx = b.x - a.x
			const dy = b.y - a.y
			const l = Math.hypot(dx, dy) || 1
			const k = ((dy / l) * LIGHT.x - (dx / l) * LIGHT.y) * OUTWARD
			const lit = k > 0
			const f = smoothstep(Math.abs(k) / 0.6)
			const to = lit ? rim : bevel
			ctx.strokeStyle = `rgb(${side.map((c, j) => Math.round(c + (to[j] - c) * f)).join(', ')})`
			ctx.lineWidth = Math.max(lit ? 1.5 : 1.9, size * (lit ? 0.03 : 0.042)) * (pass ? 1 : 1.8)
			ctx.beginPath()
			ctx.moveTo(a.x, a.y)
			ctx.lineTo(b.x, b.y)
			ctx.stroke()
		}
	}
	ctx.restore()
}

/** The eye: white, a black pupil with a catchlight (always up and to the right), its lid from the top. */
export function drawEye(ctx: CanvasRenderingContext2D, c: Vec, r: number, eye: EyeState, pal: Palette, side: number) {
	const er = r * (1 + 0.16 * eye.wide)
	ctx.save()
	ctx.beginPath()
	ctx.arc(c.x, c.y, er, 0, Math.PI * 2)
	ctx.fillStyle = '#fbfbfd'
	ctx.fill()
	ctx.clip()
	const pr = er * (0.63 - 0.18 * eye.wide)
	const reach = er - pr - er * 0.06
	const ll = Math.hypot(eye.look.x, eye.look.y)
	const k = ll > 1 ? 1 / ll : 1
	const px = c.x + eye.look.x * k * reach
	const py = c.y + eye.look.y * k * reach
	if (eye.dizzy > 0.5) {
		// a spiral, turning
		const t = performance.now() / 1000
		ctx.strokeStyle = '#16161a'
		ctx.lineWidth = Math.max(0.8, er * 0.16)
		ctx.lineCap = 'round'
		ctx.beginPath()
		for (let i = 0; i <= 28; i++) {
			const u = i / 28
			const a = t * 9 + u * Math.PI * 4.2
			const rr = er * 0.82 * u
			const x = c.x + Math.cos(a) * rr
			const y = c.y + Math.sin(a) * rr
			if (i) ctx.lineTo(x, y)
			else ctx.moveTo(x, y)
		}
		ctx.stroke()
	} else {
		ctx.beginPath()
		ctx.arc(px, py, pr, 0, Math.PI * 2)
		ctx.fillStyle = '#121216'
		ctx.fill()
		ctx.beginPath()
		ctx.arc(px + pr * 0.34, py - pr * 0.43, Math.max(0.5, pr * 0.24), 0, Math.PI * 2)
		ctx.fillStyle = '#ffffff'
		ctx.fill()
	}
	const lid = Math.min(1, Math.max(0, eye.lid))
	const lower = Math.min(1, Math.max(0, eye.lower))
	const lw = Math.max(0.8, er * 0.17)
	ctx.strokeStyle = pal.edge
	ctx.lineCap = 'round'
	ctx.lineWidth = lw
	if (lower > 0.02 && lid < 0.92) {
		// squinting: the lower lid up a little
		const edge = c.y + er - er * 0.9 * lower
		ctx.fillStyle = pal.base
		ctx.beginPath()
		ctx.moveTo(c.x - er - 1, c.y + er + 1)
		ctx.lineTo(c.x + er + 1, c.y + er + 1)
		ctx.lineTo(c.x + er + 1, edge)
		ctx.quadraticCurveTo(c.x, edge - er * 0.25, c.x - er - 1, edge)
		ctx.closePath()
		ctx.fill()
	}
	if (lid > 0.02) {
		const edge = c.y - er + 2 * er * lid
		const tilt = Math.tan(eye.slant) * er * side
		ctx.fillStyle = pal.base
		ctx.beginPath()
		ctx.moveTo(c.x - er - 1, c.y - er - 1)
		ctx.lineTo(c.x + er + 1, c.y - er - 1)
		ctx.lineTo(c.x + er + 1, edge + tilt)
		ctx.lineTo(c.x - er - 1, edge - tilt)
		ctx.closePath()
		ctx.fill()
		ctx.beginPath()
		if (lid > 0.92 && eye.squeeze > 0.5) {
			// screwed shut: a hard line, a crease under it
			ctx.moveTo(c.x - er * 0.85, c.y - tilt * 0.85)
			ctx.lineTo(c.x + er * 0.85, c.y + tilt * 0.85)
			ctx.moveTo(c.x - er * 0.45, c.y + er * 0.45 - tilt * 0.4)
			ctx.lineTo(c.x + er * 0.45, c.y + er * 0.45 + tilt * 0.4)
		} else if (lid > 0.92) {
			// shut: a soft curve
			ctx.arc(c.x, c.y - er * 0.35, er * 0.78, Math.PI * 0.18, Math.PI * 0.82)
		} else {
			ctx.moveTo(c.x - er, edge - tilt)
			ctx.lineTo(c.x + er, edge + tilt)
		}
		ctx.stroke()
	}
	ctx.restore()
}

function inside(poly: Vec[], p: Vec) {
	let r = false
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const a = poly[i]
		const b = poly[j]
		if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) r = !r
	}
	return r
}

function smoothstep(t: number) {
	const u = Math.min(1, Math.max(0, t))
	return u * u * (3 - 2 * u)
}

/** Whether a screen point is on the shape, or within `slop` px of it. */
export function hits(shape: Shape, p: Vec, slop: number) {
	const poly = shape.poly
	let inside = false
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const a = poly[i]
		const b = poly[j]
		if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
	}
	if (inside) return true
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) if (segDist(p, poly[j], poly[i]) <= slop) return true
	return false
}

function segDist(p: Vec, a: Vec, b: Vec) {
	const dx = b.x - a.x
	const dy = b.y - a.y
	const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)))
	return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t)
}

/** Smooth value noise, about -1..1: wobbles that never quite repeat. */
export function noise(x: number) {
	const i = Math.floor(x)
	const f = x - i
	const u = f * f * (3 - 2 * f)
	return hash1(i) + (hash1(i + 1) - hash1(i)) * u
}

function hash1(i: number) {
	const h = Math.sin(i * 127.1 + 311.7) * 43758.5453
	return (h - Math.floor(h)) * 2 - 1
}

/** Two octaves of noise. */
export function wobble(x: number) {
	return noise(x) * 0.68 + noise(x * 2.3 + 17.3) * 0.32
}

/** The shortest signed turn from angle a to angle b, radians. */
export function turn(a: number, b: number) {
	let d = (b - a) % (Math.PI * 2)
	if (d > Math.PI) d -= Math.PI * 2
	if (d < -Math.PI) d += Math.PI * 2
	return d
}

/** The colour mixed toward black (0) or white (255) by k. */
export function mixColor(color: string, to: number, k: number) {
	const rgb = parseColor(color) ?? [34, 211, 238]
	return `rgb(${rgb.map((c) => Math.round(c + (to - c) * k)).join(', ')})`
}

function parseColor(color: string): number[] | null {
	const rgb = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(color.trim())
	if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
	const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())
	if (!m) return null
	const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1]
	return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16))
}
