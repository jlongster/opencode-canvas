/**
 * The busy effect round a session frame that's working: Brian's Brain. Shared by the app's renderer
 * (WebGPU, see Renderer.ts) and the busy playground (WebGL, see playground/busy), which only differ
 * in how they rasterize the blocks this fills in.
 *
 * A band of cells outside each frame's rounded outline runs Brian's Brain, a three-state automaton
 * (firing, dying, off): the edge row sparks at random and the rule turns the sparks into tiny gliders
 * that crawl along and out of the band, firing bright and dying dim. The cells are whole device
 * pixels at a constant CSS size, on a grid snapped to the frame's corner (so they move with the
 * canvas). Only frames in view are simulated; a frame that comes back into view starts afresh (warmed
 * up, so it never starts empty).
 *
 * When a frame stops working its band resolves (see envelope.ts): the cells give way to a bright rim
 * falling off outward, held, then faded.
 */

import { FRAME_RADIUS } from './envelope'

/** The effect's settings; the keys are the busy playground's parameter keys. */
export interface BrainSettings {
	/** time multiplier */
	speed: number
	/** cell size, CSS px */
	cell: number
	/** gap between cells, CSS px */
	gap: number
	/** band depth, cells */
	depth: number
	/** one generation, s (speed-scaled) */
	step: number
	/** chance an edge cell fires each generation */
	spark: number
	/** brightness of dying cells */
	dying: number
	/** the row of cells on the edge always glows this much */
	base: number
	falloff: number
	/** peak opacity */
	peak: number
	color: 'session' | 'white'
}

/** James's settings: the app's effect, and the playground's Brian's Brain defaults. */
export const BRAIN: BrainSettings = {
	speed: 0.1,
	cell: 2,
	gap: 1,
	depth: 3,
	step: 0.03,
	spark: 0.15,
	dying: 0.69,
	base: 0.18,
	falloff: 0.6,
	peak: 0.9,
	color: 'white',
}

/** Reduced motion: the time the automaton stops at, a pose that still reads as busy. */
export const BRAIN_STILL = 3

/** Generations run before a band is first shown, so it starts mid-flow. */
const WARM = 40
/** Bands bigger than this many cells (a huge frame, very zoomed in) aren't drawn. */
const MAX_CELLS = 400_000

/** One frame's band. */
export interface BrainFrame {
	/** stable per frame: its automaton is kept under this */
	key: string
	/** page units */
	box: { x: number; y: number; w: number; h: number }
	/** sRGB 0..1 (unless the settings say white) */
	color: readonly [number, number, number]
	/** seconds added to its clock, so frames run out of phase */
	offset: number
	/** per frame, so their sparks differ */
	seed: number
	presence: number
	fill: number
}

/** Where the canvas is on screen: screen (CSS px) = page × z + (x, y). */
export interface BrainView {
	x: number
	y: number
	z: number
	/** CSS px */
	width: number
	height: number
	dpr: number
}

/** Floats per block (see BrainBlocks). */
export const BLOCK_FLOATS = 8

/**
 * A frame's band: its cells on a grid in device px relative to the frame's (rounded) corner, with
 * each cell's neighbours, and the automaton running on them.
 */
interface Band {
	sig: string
	n: number
	gx: Int32Array
	gy: Int32Array
	/** on the edge row (sparks, glows) */
	edge: Uint8Array
	/** the falloff, 1 at the edge */
	fall: Float32Array
	/** 8 per cell, -1 for none */
	nb: Int32Array
	/** first grid row, and per row up to two runs of columns: start, end, slot base */
	row0: number
	runs: Int32Array
	slots: Int32Array
	state: Uint8Array
	next: Uint8Array
	gen: number
}

/**
 * The blocks to draw, BLOCK_FLOATS each: x, y, w, h (whole device px), r, g, b, a (premultiplied).
 * Fill them in for the frames in view with fill().
 */
export class BrainBlocks {
	data = new Float32Array(BLOCK_FLOATS * 4096)
	n = 0
	/** frames whose band was in view on the last fill */
	framesInView = 0
	/** the earliest time (as passed to fill) a band in view steps to its next generation */
	nextT = Infinity

	private bands = new Map<string, Band>()
	private seen = new Set<string>()

	/** Fills in the blocks for these frames' bands at time `t` (s, speed-scaled). */
	fill(view: BrainView, frames: readonly BrainFrame[], s: BrainSettings, t: number) {
		this.n = 0
		this.framesInView = 0
		this.nextT = Infinity
		this.seen.clear()
		const { dpr, z } = view
		const size = Math.max(1, Math.round(s.cell * dpr))
		const pd = size + Math.round(s.gap * dpr)
		const pitch = pd / dpr
		const reach = 1 + s.depth * pitch
		const W = view.width * dpr
		const H = view.height * dpr
		const white = s.color === 'white'

		for (const fr of frames) {
			if (fr.presence <= 0.001) continue
			const fx = (fr.box.x * z + view.x) * dpr
			const fy = (fr.box.y * z + view.y) * dpr
			const fw = fr.box.w * z * dpr
			const fh = fr.box.h * z * dpr
			const rd = reach * dpr
			if (fx + fw + rd < 0 || fy + fh + rd < 0 || fx - rd > W || fy - rd > H) continue
			const fwc = fr.box.w * z
			const fhc = fr.box.h * z
			if ((2 * (fwc + fhc) + 8 * reach) * reach > MAX_CELLS * pitch * pitch) continue
			this.framesInView++
			this.seen.add(fr.key)

			const sig = [fw, fh, z, size, pd, s.depth, s.falloff].map((v) => v.toFixed(3)).join()
			let b = this.bands.get(fr.key)
			if (!b || b.sig !== sig) {
				const fresh = build(sig, fwc, fhc, z, dpr, size, pd, s.depth, s.falloff)
				if (b) remap(b, fresh)
				this.bands.set(fr.key, (b = fresh))
			}

			// Step the automaton to now; far behind (or before), it starts afresh.
			const ft = t + fr.offset
			const gen = Math.floor(ft / s.step)
			if (gen < b.gen || gen - b.gen > WARM) {
				b.state.fill(0)
				b.gen = gen - WARM
			}
			while (b.gen < gen) step(b, s.spark, fr.seed)
			this.nextT = Math.min(this.nextT, (gen + 1) * s.step - fr.offset)

			const ox = Math.round(fx)
			const oy = Math.round(fy)
			const [cr, cg, cb] = white ? WHITE : fr.color
			const k = s.peak * fr.presence
			const keep = 1 - fr.fill
			const st = b.state
			for (let i = 0; i < b.n; i++) {
				const x = ox + b.gx[i] * pd
				const y = oy + b.gy[i] * pd
				if (x + size <= 0 || y + size <= 0 || x >= W || y >= H) continue
				const f = b.fall[i]
				const lv = st[i] === 1 ? 1 : st[i] === 2 ? s.dying : b.edge[i] ? s.base : 0
				// Done: the cells give way to a bright rim that falls off outward (fall³), then fade.
				const l = Math.max(Math.min(1, lv * (0.35 + 0.65 * f)) * keep, fr.fill * f * f * f)
				const a = k * l
				if (a > 0.002) this.push(x, y, size, a * cr, a * cg, a * cb, a)
			}
		}

		for (const key of this.bands.keys()) if (!this.seen.has(key)) this.bands.delete(key)
	}

	private push(x: number, y: number, size: number, r: number, g: number, b: number, a: number) {
		if ((this.n + 1) * BLOCK_FLOATS > this.data.length) {
			const next = new Float32Array(this.data.length * 2)
			next.set(this.data)
			this.data = next
		}
		const o = this.n++ * BLOCK_FLOATS
		const d = this.data
		d[o] = x
		d[o + 1] = y
		d[o + 2] = size
		d[o + 3] = size
		d[o + 4] = r
		d[o + 5] = g
		d[o + 6] = b
		d[o + 7] = a
	}
}

const WHITE = [1, 1, 1] as const

/** One generation: firing cells die, dying ones go off, and an off cell fires with exactly two firing neighbours (or, on the edge, at random). */
function step(b: Band, spark: number, seed: number) {
	b.gen++
	const cur = b.state
	const next = b.next
	const nb = b.nb
	for (let i = 0; i < b.n; i++) {
		const c = cur[i]
		if (c === 1) next[i] = 2
		else if (c === 2) next[i] = 0
		else {
			let on = 0
			for (let k = i * 8, e = k + 8; k < e; k++) {
				const j = nb[k]
				if (j >= 0 && cur[j] === 1) on++
			}
			next[i] = on === 2 || (b.edge[i] && hash3(b.gx[i] * 7919 + b.gy[i], b.gen, seed) < spark) ? 1 : 0
		}
	}
	b.state = next
	b.next = cur
}

/**
 * Every cell of a grid (pitch `pd`, cells `size` device px, origin the frame's corner) whose centre
 * lies between 1 CSS px and 1 + `depth` cells outside the frame's rounded outline (`fw` × `fh` CSS
 * px), with its falloff and neighbours.
 */
function build(sig: string, fw: number, fh: number, z: number, dpr: number, size: number, pd: number, depth: number, falloff: number): Band {
	const offset = 1
	const pitch = pd / dpr
	const reach = offset + depth * pitch
	const r = Math.min(FRAME_RADIUS * z, fw / 2, fh / 2)
	const qx = fw / 2 - r
	const qy = fh / 2 - r
	const g0x = Math.floor((-reach * dpr) / pd) - 1
	const g1x = Math.ceil(((fw + reach) * dpr) / pd) + 1
	const g0y = g0x
	const g1y = Math.ceil(((fh + reach) * dpr) / pd) + 1
	const rows = g1y - g0y + 1
	const runs = new Int32Array(rows * 6)
	let slotCount = 0
	for (let gy = g0y; gy <= g1y; gy++) {
		const py = (gy * pd + size / 2) / dpr - fh / 2
		const o = (gy - g0y) * 6
		const a0 = g0x
		let a1 = g1x
		let b0 = 1
		let b1 = 0
		if (Math.abs(py) - fh / 2 < offset) {
			// Across the frame only cells beyond its straight top and bottom edges (or its sides) count.
			const side = Math.abs(py) <= qy ? 0 : fw / 2 - qx
			a1 = Math.min(g1x, Math.ceil((side * dpr) / pd) + 1)
			b0 = Math.max(a1 + 1, Math.floor(((fw - side) * dpr) / pd) - 1)
			b1 = g1x
		}
		runs[o] = a0
		runs[o + 1] = a1
		runs[o + 2] = slotCount
		slotCount += a1 - a0 + 1
		runs[o + 3] = b0
		runs[o + 4] = b1
		runs[o + 5] = slotCount
		if (b1 >= b0) slotCount += b1 - b0 + 1
	}
	const slots = new Int32Array(slotCount).fill(-1)
	const gxs: number[] = []
	const gys: number[] = []
	const ds: number[] = []
	for (let gy = g0y; gy <= g1y; gy++) {
		const o = (gy - g0y) * 6
		const py = (gy * pd + size / 2) / dpr - fh / 2
		for (let run = 0; run < 2; run++) {
			const ga = runs[o + run * 3]
			const gb = runs[o + run * 3 + 1]
			const base = runs[o + run * 3 + 2]
			for (let gx = ga; gx <= gb; gx++) {
				const px = (gx * pd + size / 2) / dpr - fw / 2
				const dx = px - Math.max(-qx, Math.min(qx, px))
				const dy = py - Math.max(-qy, Math.min(qy, py))
				const d = Math.hypot(dx, dy) - r
				if (d < offset || d > reach) continue
				slots[base + gx - ga] = gxs.length
				gxs.push(gx)
				gys.push(gy)
				ds.push(d - offset)
			}
		}
	}
	const n = gxs.length
	const b: Band = {
		sig,
		n,
		gx: Int32Array.from(gxs),
		gy: Int32Array.from(gys),
		edge: new Uint8Array(n),
		fall: new Float32Array(n),
		nb: new Int32Array(n * 8),
		row0: g0y,
		runs,
		slots,
		state: new Uint8Array(n),
		next: new Uint8Array(n),
		gen: -Infinity,
	}
	for (let i = 0; i < n; i++) {
		b.edge[i] = ds[i] < pitch ? 1 : 0
		b.fall[i] = Math.pow(Math.min(1, Math.max(0, 1 - ds[i] / (depth * pitch))), falloff)
		let k = i * 8
		for (let dy = -1; dy <= 1; dy++)
			for (let dx = -1; dx <= 1; dx++) if (dx || dy) b.nb[k++] = lookup(b, b.gx[i] + dx, b.gy[i] + dy)
	}
	return b
}

/** The cell at grid (gx, gy), or -1. */
function lookup(b: Band, gx: number, gy: number) {
	const row = gy - b.row0
	if (row < 0 || row * 6 >= b.runs.length) return -1
	const o = row * 6
	if (gx >= b.runs[o] && gx <= b.runs[o + 1]) return b.slots[b.runs[o + 2] + gx - b.runs[o]]
	if (gx >= b.runs[o + 3] && gx <= b.runs[o + 4]) return b.slots[b.runs[o + 5] + gx - b.runs[o + 3]]
	return -1
}

/** A rebuilt band (zoom, resize) keeps its automaton where the cells are the same. */
function remap(from: Band, to: Band) {
	to.gen = from.gen
	for (let i = 0; i < to.n; i++) {
		const j = lookup(from, to.gx[i], to.gy[i])
		to.state[i] = j >= 0 ? from.state[j] : 0
	}
}

/** Integer hash of three ints, in [0, 1). */
function hash3(x: number, y: number, z: number) {
	let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 1274126177)
	h = Math.imul(h ^ (h >>> 13), 1274126177)
	return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}
