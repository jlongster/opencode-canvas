/**
 * "Ember clumps", a busy effect round a session frame that's working (the app's until it switched to
 * Brian's Brain, see render/busy/brain.ts); drawn by the busy playground's DotPass.
 *
 * A continuous field lives in a band outside each frame's rounded outline: two layers of fine value
 * noise wrapped round the perimeter crawl in opposite directions while drifting outward, and only
 * their peaks light up (sparse bright clumps with a dimmer halo, thinning away from the edge). It is
 * seen through a grid of dots anchored to the canvas: whole device pixels, a constant CSS size at any
 * zoom. The field is evaluated once per grid cell, at its centre, and only for cells in the bands of
 * frames in view; each cell then becomes one dot, lit by brightness (or sized: halftone, or switched
 * against a Bayer threshold: dither).
 *
 * When a frame stops working its band resolves: the flow gives way to a bright rim falling off
 * outward, held, then faded (see envelope).
 */

import { FRAME_RADIUS } from '../../render/busy/envelope'

export type DotShape = 'round' | 'square'
export type MaskMode = 'brightness' | 'halftone' | 'dither'

/** The effect's settings; the keys are the busy playground's parameter keys. */
export interface EmberSettings {
	/** time multiplier */
	speed: number
	/** grid pitch, CSS px */
	pitch: number
	/** dot size, CSS px */
	dot: number
	shape: DotShape
	mode: MaskMode
	/** brightness steps (0: continuous) */
	levels: number
	/** opacity of the band's unlit dots */
	base: number
	/** the row of dots on the edge always glows at least this much */
	rim: number
	/** slow noise shrinking dots (0: off) */
	modulate: number
	/** noise size, CSS px */
	scale: number
	/** outward drift, CSS px/s */
	drift: number
	/** band depth, CSS px */
	depth: number
	falloff: number
	intensity: number
	/** peak opacity */
	peak: number
	/** the session colour, or (mesh) slow hue drifts round the frame near it */
	color: 'session' | 'mesh'
	/** crawl along the outline, CSS px/s */
	crawl: number
	/** how much of the noise stays dark: higher, sparser clumps */
	sparse: number
	/** the halo round each clump */
	dim: number
}

/** James's settings: the playground's Ember defaults. */
export const EMBER: EmberSettings = {
	speed: 0.75,
	pitch: 5,
	dot: 2,
	shape: 'square',
	mode: 'brightness',
	levels: 0,
	base: 0,
	rim: 0.18,
	modulate: 0,
	scale: 9,
	drift: 5,
	depth: 11,
	falloff: 0.7,
	intensity: 1,
	peak: 0.9,
	color: 'session',
	crawl: 5.5,
	sparse: 0.525,
	dim: 0.3,
}

/** Reduced motion: the time the field freezes at, a pose that still reads as busy. */
export const EMBER_STILL = 4


/** One frame's band. */
export interface EmberFrame {
	/** page units */
	box: { x: number; y: number; w: number; h: number }
	/** sRGB 0..1 */
	color: readonly [number, number, number]
	/** seconds added to its clock, so frames run out of phase */
	offset: number
	/** per frame, so their noise differs */
	seed: number
	presence: number
	fill: number
}

/** Where the canvas is on screen: screen (CSS px) = page × z + (x, y). */
export interface EmberView {
	x: number
	y: number
	z: number
	/** CSS px */
	width: number
	height: number
	dpr: number
}

/** Floats per dot (see EmberDots). */
export const DOT_FLOATS = 12

/**
 * The dots to draw, one per lit cell, DOT_FLOATS each:
 *   cell x, cell y (its top-left, device px), pitch (device px), round (0/1),
 *   lit size, unlit size (device px), lit alpha, unlit alpha,
 *   r, g, b (0..1, not premultiplied), 0.
 * A rasterizer covers each cell's pitch × pitch device pixels and, per pixel, takes the larger of
 * the lit dot's coverage × its alpha and the unlit dot's × its alpha: square dots cover whole pixels
 * (`side = floor(size + 0.5)`, at `floor((pitch − side) / 2)` in the cell), round ones are
 * antialiased over one pixel round the cell's centre. Premultiplied output.
 */
export class EmberDots {
	data = new Float32Array(DOT_FLOATS * 1024)
	n = 0
	/** frames whose band was in view on the last fill */
	framesInView = 0

	private push(x: number, y: number, pd: number, round: number, lit: number, base: number, litAlpha: number, baseAlpha: number, r: number, g: number, b: number) {
		if ((this.n + 1) * DOT_FLOATS > this.data.length) {
			const next = new Float32Array(this.data.length * 2)
			next.set(this.data)
			this.data = next
		}
		const o = this.n++ * DOT_FLOATS
		const d = this.data
		d[o] = x
		d[o + 1] = y
		d[o + 2] = pd
		d[o + 3] = round
		d[o + 4] = lit
		d[o + 5] = base
		d[o + 6] = litAlpha
		d[o + 7] = baseAlpha
		d[o + 8] = r
		d[o + 9] = g
		d[o + 10] = b
		d[o + 11] = 0
	}

	// The cells of the bands in view, by index into the visible grid: a stamp says which were touched
	// on this fill, so nothing needs clearing between fills.
	private stamp = new Uint32Array(0)
	private best = new Float32Array(0)
	private band = new Float32Array(0)
	private rgb = new Float32Array(0)
	private touched = new Int32Array(0)
	private gen = 0

	private grid(cells: number) {
		if (this.stamp.length >= cells) return
		const size = Math.max(cells, this.stamp.length * 2)
		this.stamp = new Uint32Array(size)
		this.best = new Float32Array(size)
		this.band = new Float32Array(size)
		this.rgb = new Float32Array(size * 3)
		this.touched = new Int32Array(size)
		this.gen = 0
	}

	/** Fills in the dots for these frames' bands at time `t` (s, speed-scaled). */
	fill(view: EmberView, frames: readonly EmberFrame[], s: EmberSettings, t: number) {
		this.n = 0
		this.framesInView = 0
		const { dpr, z } = view
		const pd = Math.max(2, Math.round(s.pitch * dpr))
		const ox = Math.round(view.x * dpr)
		const oy = Math.round(view.y * dpr)
		// The visible grid: every cell with a pixel on screen.
		const c0x = Math.floor(-ox / pd)
		const c0y = Math.floor(-oy / pd)
		const gw = Math.floor((view.width * dpr - ox) / pd) - c0x + 1
		const gh = Math.floor((view.height * dpr - oy) / pd) - c0y + 1
		if (gw <= 0 || gh <= 0) return
		this.grid(gw * gh)
		if (++this.gen === 0xffffffff) {
			this.stamp.fill(0)
			this.gen = 1
		}
		const gen = this.gen
		let touched = 0
		const depth = s.depth
		const reach = depth + 1 + s.pitch
		const mesh = s.color === 'mesh'

		for (const fr of frames) {
			if (fr.presence <= 0.001) continue
			const bx = fr.box.w / 2
			const by = fr.box.h / 2
			const cx = fr.box.x + bx
			const cy = fr.box.y + by
			// The band's box in device px, as cells of the visible grid.
			const left = (fr.box.x * z + view.x - reach) * dpr
			const top = (fr.box.y * z + view.y - reach) * dpr
			const right = ((fr.box.x + fr.box.w) * z + view.x + reach) * dpr
			const bottom = ((fr.box.y + fr.box.h) * z + view.y + reach) * dpr
			const ax = Math.max(c0x, Math.floor((left - ox) / pd))
			const bxc = Math.min(c0x + gw - 1, Math.floor((right - ox) / pd))
			const ay = Math.max(c0y, Math.floor((top - oy) / pd))
			const byc = Math.min(c0y + gh - 1, Math.floor((bottom - oy) / pd))
			if (ax > bxc || ay > byc) continue
			this.framesInView++

			const r = Math.min(FRAME_RADIUS, bx, by)
			const qx = bx - r
			const qy = by - r
			const hp = 0.5 * Math.PI * r
			const Lp = 4 * (qx + qy) + 2 * Math.PI * r
			const L = Lp * z
			const ft = t + fr.offset
			const seed = fr.seed
			// Cells across the middle of the frame only matter near its left and right edges.
			const innerL = Math.floor(((fr.box.x * z + view.x + s.pitch) * dpr - ox) / pd)
			const innerR = Math.ceil((((fr.box.x + fr.box.w) * z + view.x - s.pitch) * dpr - ox) / pd)
			const [cr, cg, cb] = fr.color

			for (let gy = ay; gy <= byc; gy++) {
				const py = ((oy + gy * pd + 0.5 * pd) / dpr - view.y) / z - cy
				const middle = Math.abs(py) < qy
				for (let gx = ax; gx <= bxc; gx++) {
					if (middle && gx > innerL && gx < innerR) {
						gx = innerR
						if (gx > bxc) break
					}
					const px = ((ox + gx * pd + 0.5 * pd) / dpr - view.x) / z - cx
					// Distance outside the rounded outline, CSS px (cells on its very edge don't count).
					const kx = Math.abs(px) - qx
					const ky = Math.abs(py) - qy
					const outer = Math.hypot(Math.max(kx, 0), Math.max(ky, 0)) + Math.min(Math.max(kx, ky), 0) - r
					const d = outer * z - 1
					if (d < 0 || d > depth) continue
					// Arc length round the outline from the top centre, clockwise (page units).
					const dvx = px - Math.max(-qx, Math.min(qx, px))
					const dvy = py - Math.max(-qy, Math.min(qy, py))
					let arc: number
					if (dvx === 0) arc = py < 0 ? (px >= 0 ? px : Lp + px) : qx + 2 * hp + 2 * qy + (qx - px)
					else if (dvy === 0) arc = px > 0 ? qx + hp + (py + qy) : 3 * qx + 2 * qy + 3 * hp + (qy - py)
					else {
						const a = Math.atan2(dvy, dvx)
						if (dvx > 0 && dvy < 0) arc = qx + r * (a + 0.5 * Math.PI)
						else if (dvx > 0) arc = qx + hp + 2 * qy + r * a
						else if (dvy > 0) arc = 3 * qx + 2 * qy + 2 * hp + r * (a - 0.5 * Math.PI)
						else arc = 3 * qx + 4 * qy + 3 * hp + r * (a + Math.PI)
					}
					const fall = Math.pow(clamp01(1 - d / depth), s.falloff)
					let v = clamp01(field(arc * z, L, d, ft, seed, fall, s) * s.intensity)
					// The row of dots on the edge always glows a little.
					if (d <= s.pitch) v = Math.max(v, s.rim * fall)
					// Done: the flow gives way to a bright rim that falls off outward, then fades.
					v = Math.max(v * (1 - fr.fill), fr.fill * fall * fall * fall) * fr.presence

					const i = (gy - c0y) * gw + (gx - c0x)
					if (this.stamp[i] !== gen) {
						this.stamp[i] = gen
						this.best[i] = -1
						this.band[i] = 0
						this.touched[touched++] = i
					}
					this.band[i] = Math.max(this.band[i], fr.presence)
					if (v > this.best[i]) {
						this.best[i] = v
						let r0 = cr
						let g0 = cg
						let b0 = cb
						if (mesh) [r0, g0, b0] = meshTint(arc * z, L, ft, seed, cr, cg, cb)
						this.rgb[i * 3] = r0
						this.rgb[i * 3 + 1] = g0
						this.rgb[i * 3 + 2] = b0
					}
				}
			}
		}

		// Each touched cell becomes a dot (or none).
		const dotPx = s.dot * dpr
		const round = s.shape === 'round' ? 1 : 0
		const mode = s.mode
		for (let k = 0; k < touched; k++) {
			const i = this.touched[k]
			const best = Math.max(0, this.best[i])
			const gx = c0x + (i % gw)
			const gy = c0y + Math.floor(i / gw)
			let grow = 1
			if (s.modulate > 0) grow = mix(1, smoothstep(0.25, 0.75, noise3(gx * 0.09, gy * 0.09, t * 0.15)), s.modulate)
			let alpha: number
			if (mode === 'brightness') alpha = s.levels > 0.5 ? Math.floor(best * s.levels + 0.5) / s.levels : best
			else if (mode === 'halftone') {
				alpha = best > 0.004 ? 1 : 0
				grow *= Math.sqrt(best)
			} else alpha = best > bayer4(gx, gy) ? 1 : 0
			const litAlpha = alpha * s.peak
			if (litAlpha <= 0.002 && s.base <= 0.002) continue
			this.push(ox + gx * pd, oy + gy * pd, pd, round, dotPx * grow, dotPx, litAlpha, s.base, this.rgb[i * 3], this.rgb[i * 3 + 1], this.rgb[i * 3 + 2])
		}
	}
}

/**
 * The field at a point of the band (0..1): `arc` CSS px round the outline (of `L`), `d` CSS px out
 * from it, `fall` the falloff there (1 at the edge).
 */
function field(arc: number, L: number, d: number, t: number, seed: number, fall: number, p: EmberSettings) {
	const away = (d - t * p.drift) / p.scale
	const a = aroundNoise(arc, L, t, seed, p.scale, p.crawl, away, t * 0.11)
	const b = aroundNoise(arc, L, t, seed, p.scale * 1.15, -p.crawl, away * 1.1 + 9, t * 0.13)
	const m = Math.max(a, b)
	// Bright peaks, and a dimmer halo round them (like dying cells), thinning outward.
	const bright = smoothstep(p.sparse + 0.06, p.sparse + 0.12, m)
	const dim = smoothstep(p.sparse - 0.02, p.sparse + 0.03, m) * p.dim
	const edge = smoothstep(0, 0.25, fall)
	return Math.max(bright, dim) * (0.35 + 0.65 * fall) * edge
}

/**
 * Noise round the loop: arc length mapped onto a circle (so it wraps seamlessly) crawling at
 * `along` CSS px/s, plus a coordinate away from the edge and one through time.
 */
function aroundNoise(arc: number, L: number, t: number, seed: number, scale: number, along: number, away: number, w: number) {
	const R = L / (2 * Math.PI * scale)
	const a = ((arc - t * along) / L) * 2 * Math.PI
	return noise3(Math.cos(a) * R + seed * 11.7, Math.sin(a) * R + seed * 5.3, away + w + seed * 2.9)
}

/** Mesh colour: the session colour's hue drifting slowly round the frame. */
function meshTint(arc: number, L: number, t: number, seed: number, r: number, g: number, b: number): [number, number, number] {
	const h = aroundNoise(arc, L, t, seed, 140, -6, t * 0.05, 0) - 0.5
	return hueRotate(r, g, b, h * 1.4)
}

function hueRotate(r: number, g: number, b: number, angle: number): [number, number, number] {
	const y = 0.299 * r + 0.587 * g + 0.114 * b
	const i = 0.596 * r - 0.274 * g - 0.322 * b
	const q = 0.211 * r - 0.523 * g + 0.312 * b
	const h = Math.atan2(q, i) + angle
	const c = Math.hypot(i, q)
	const ni = c * Math.cos(h)
	const nq = c * Math.sin(h)
	return [clamp01(y + 0.956 * ni + 0.621 * nq), clamp01(y - 0.272 * ni - 0.647 * nq), clamp01(y - 1.106 * ni + 1.703 * nq)]
}

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]

function bayer4(x: number, y: number) {
	return (BAYER4[(((x % 4) + 4) % 4) + (((y % 4) + 4) % 4) * 4] + 0.5) / 16
}

/** Integer lattice hash in [0, 1). */
function hash3(x: number, y: number, z: number) {
	let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 1274126177)
	h = Math.imul(h ^ (h >>> 13), 1274126177)
	return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** 3D value noise in [0, 1]. */
function noise3(x: number, y: number, z: number) {
	const ix = Math.floor(x)
	const iy = Math.floor(y)
	const iz = Math.floor(z)
	let fx = x - ix
	let fy = y - iy
	let fz = z - iz
	fx = fx * fx * (3 - 2 * fx)
	fy = fy * fy * (3 - 2 * fy)
	fz = fz * fz * (3 - 2 * fz)
	const x00 = mix(hash3(ix, iy, iz), hash3(ix + 1, iy, iz), fx)
	const x10 = mix(hash3(ix, iy + 1, iz), hash3(ix + 1, iy + 1, iz), fx)
	const x01 = mix(hash3(ix, iy, iz + 1), hash3(ix + 1, iy, iz + 1), fx)
	const x11 = mix(hash3(ix, iy + 1, iz + 1), hash3(ix + 1, iy + 1, iz + 1), fx)
	return mix(mix(x00, x10, fy), mix(x01, x11, fy), fz)
}

function mix(a: number, b: number, t: number) {
	return a + (b - a) * t
}

function smoothstep(e0: number, e1: number, x: number) {
	const t = clamp01((x - e0) / (e1 - e0))
	return t * t * (3 - 2 * t)
}

function clamp01(x: number) {
	return x < 0 ? 0 : x > 1 ? 1 : x
}
