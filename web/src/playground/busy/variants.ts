import { range, select, SPEED, type ParamDef, type ParamValues } from '../shared/params'
import { hash3 } from './geometry'

/** A rectangle in device pixels (unrounded). */
export interface Rect {
	x: number
	y: number
	w: number
	h: number
}

/** What a variation draws one frame's indicator with. */
export interface BusyCtx {
	/** the frame, device px */
	frame: Rect
	/** speed-scaled seconds, offset per frame */
	t: number
	reduced: boolean
	dpr: number
	/** zoom: CSS px per page unit */
	z: number
	p: ParamValues
	/** stable per variation and frame, for simulations that keep state */
	key: string
	/** CSS px to whole device px (at least 1) */
	px(css: number): number
	/**
	 * A block at whole device px lit to `level` (0..1). `weight` is how much of it the done fill
	 * lights (usually the falloff), so the resolve keeps the band's shape.
	 */
	cell(x: number, y: number, w: number, h: number, level: number, weight?: number): void
}

export interface BusyVariant {
	id: string
	name: string
	/** one line on what it is and where it comes from, shown as the demo's caption */
	note: string
	params: ParamDef[]
	/** reduced motion: the time to freeze at, a pose that still reads as "busy" */
	still: number
	/** block variations draw cells on the CPU */
	draw?: (c: BusyCtx) => void
	/** flow variations: `float field(Fx f)` (see flow.ts), seen through the dot grid */
	glsl?: string
}

// ---------- timing ----------

/** CSS cubic-bezier(x1, y1, x2, y2) as a function of progress. */
export function bezier(x1: number, y1: number, x2: number, y2: number) {
	const cx = 3 * x1
	const bx = 3 * (x2 - x1) - cx
	const ax = 1 - cx - bx
	const cy = 3 * y1
	const by = 3 * (y2 - y1) - cy
	const ay = 1 - cy - by
	const sx = (t: number) => ((ax * t + bx) * t + cx) * t
	return (x: number) => {
		if (x <= 0) return 0
		if (x >= 1) return 1
		let lo = 0
		let hi = 1
		let t = x
		for (let i = 0; i < 24; i++) {
			if (sx(t) < x) lo = t
			else hi = t
			t = (lo + hi) / 2
		}
		return ((ay * t + by) * t + cy) * t
	}
}

export const easeOut = bezier(0.23, 1, 0.32, 1)
const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
const mod = (a: number, b: number) => ((a % b) + b) % b

// ---------- the band of cells around a frame ----------

/** One cell of the band: its device-px block, grid index, and where it sits relative to the outline. */
interface Cell {
	x: number
	y: number
	gx: number
	gy: number
	/** CSS px outside the frame's edge (cell centre) */
	d: number
	/** CSS px along the outline from the top centre, clockwise */
	s: number
	/** outward normal */
	nx: number
	ny: number
}

interface Band {
	cells: Cell[]
	/** perimeter, CSS px */
	L: number
	/** cell pitch, CSS px */
	pitch: number
	/** cell size, device px */
	size: number
}

/**
 * Every cell of a screen-aligned grid (constant screen size, snapped to the frame's corner) whose
 * centre lies within `depth` cells outside the frame's rounded outline, with its distance from the
 * edge and its arc length around the outline. Cached until the frame, zoom or grid changes.
 */
const bands = new Map<string, { sig: string; band: Band }>()
function band(c: BusyCtx, cellCss: number, gapCss: number, depth: number, offsetCss = 1): Band {
	const size = c.px(cellCss)
	const pd = size + Math.round(gapCss * c.dpr)
	const sig = [c.frame.x, c.frame.y, c.frame.w, c.frame.h, size, pd, depth, offsetCss, c.z].map((v) => v.toFixed(2)).join()
	const hit = bands.get(c.key)
	if (hit && hit.sig === sig) return hit.band
	const dpr = c.dpr
	const fx = c.frame.x / dpr
	const fy = c.frame.y / dpr
	const fw = c.frame.w / dpr
	const fh = c.frame.h / dpr
	const r = Math.min(20 * c.z, fw / 2, fh / 2)
	const qx = fw / 2 - r
	const qy = fh / 2 - r
	const hp = (Math.PI / 2) * r
	const L = 4 * (qx + qy) + 2 * Math.PI * r
	const cx = fx + fw / 2
	const cy = fy + fh / 2
	const pitch = pd / dpr
	const reach = offsetCss + depth * pitch
	const ox = Math.round(c.frame.x)
	const oy = Math.round(c.frame.y)
	const g0x = Math.floor((-reach * dpr) / pd) - 1
	const g1x = Math.ceil(((fw + reach) * dpr) / pd) + 1
	const g0y = Math.floor((-reach * dpr) / pd) - 1
	const g1y = Math.ceil(((fh + reach) * dpr) / pd) + 1
	const cells: Cell[] = []
	for (let gy = g0y; gy <= g1y; gy++) {
		const Y = oy + gy * pd
		const py = (Y + size / 2) / dpr - cy
		// Rows across the middle of the frame only have cells near the left and right edges.
		const inside = Math.abs(py) < qy - 1
		const ranges = inside
			? [
					[g0x, Math.ceil((2 * pitch * dpr) / pd) + 1],
					[Math.floor(((fw - 2 * pitch) * dpr) / pd) - 1, g1x],
				]
			: [[g0x, g1x]]
		for (const [ga, gb] of ranges)
		for (let gx = ga; gx <= gb; gx++) {
			const X = ox + gx * pd
			const px = (X + size / 2) / dpr - cx
			const kx = Math.max(-qx, Math.min(qx, px))
			const ky = Math.max(-qy, Math.min(qy, py))
			let dx = px - kx
			let dy = py - ky
			const len = Math.hypot(dx, dy)
			if (len < 1e-6) continue
			const d = len - r
			if (d < offsetCss || d > reach) continue
			dx /= len
			dy /= len
			let s: number
			if (Math.abs(px) <= qx && py < 0) s = px >= 0 ? px : L + px
			else if (Math.abs(px) <= qx) s = qx + 2 * hp + 2 * qy + (qx - px)
			else if (Math.abs(py) <= qy && px > 0) s = qx + hp + (py + qy)
			else if (Math.abs(py) <= qy) s = 3 * qx + 2 * qy + 3 * hp + (qy - py)
			else {
				const a = Math.atan2(dy, dx)
				if (dx > 0 && dy < 0) s = qx + r * (a + Math.PI / 2)
				else if (dx > 0) s = qx + hp + 2 * qy + r * a
				else if (dy > 0) s = 3 * qx + 2 * qy + 2 * hp + r * (a - Math.PI / 2)
				else s = 3 * qx + 4 * qy + 3 * hp + r * (a + Math.PI)
			}
			cells.push({ x: X, y: Y, gx, gy, d: d - offsetCss, s: mod(s, L), nx: dx, ny: dy })
		}
	}
	const b = { cells, L, pitch, size }
	bands.set(c.key, { sig, band: b })
	return b
}



const COLOR = select('color', 'Colour', ['session', 'white'], 'session')
const PEAK = (v: number) => range('peak', 'Intensity', v, 0, 1, 0.01)
const CELL = (v: number) => range('cell', 'Cell', v, 1, 10, 1, 'px')
const GAP = (v: number) => range('gap', 'Gap', v, 0, 4, 1, 'px')
const DEPTH = (v: number, max = 16) => range('depth', 'Band depth', v, 1, max, 1, 'cells')
const FALLOFF = (v: number) => range('falloff', 'Falloff', v, 0.2, 4, 0.05)

/** 1 at the edge, 0 at the band's outer side. */
const fall = (b: Band, d: number, depth: number, k: number) => Math.pow(clamp01(1 - d / (depth * b.pitch)), k)

// ---------- simulations that keep state (stepped at a fixed rate from t) ----------

interface Sim {
	sig: string
	gen: number
	data: Uint8Array[]
}
const sims = new Map<string, Sim>()
function sim(c: BusyCtx, sig: string, step: number, make: () => Uint8Array[], advance: (s: Sim) => void, warm: number) {
	const gen = Math.floor(c.t / step)
	let s = sims.get(c.key)
	if (!s || s.sig !== sig || gen < s.gen || gen - s.gen > 240) {
		s = { sig, gen: gen - warm, data: make() }
		sims.set(c.key, s)
	}
	while (s.gen < gen) {
		s.gen++
		advance(s)
	}
	return s
}

export const BLOCK_VARIANTS: BusyVariant[] = [
	{
		id: 'brain',
		name: 'Brian’s Brain',
		note: 'A band round the frame runs Brian’s Brain, a three-state automaton (firing, dying, off): the edge row sparks at random and the rule turns the sparks into tiny gliders that crawl along and out of the band, firing bright and dying dim.',
		params: [
			SPEED,
			CELL(3),
			GAP(1),
			DEPTH(8),
			range('step', 'Step', 0.07, 0.03, 0.3, 0.01, 's'),
			range('spark', 'Edge sparks', 0.15, 0, 0.3, 0.005),
			range('dying', 'Dying cells', 0.35, 0, 1, 0.01),
			range('base', 'Edge glow', 0.18, 0, 1, 0.01),
			FALLOFF(0.6),
			PEAK(0.9),
			COLOR,
		],
		still: 3,
		draw(c) {
			const { p } = c
			const depth = p.depth as number
			const b = band(c, p.cell as number, p.gap as number, depth)
			const cells = b.cells
			// Neighbours by grid index, built with the band.
			const nb = neighbours(c.key, b)
			const spark = p.spark as number
			const s = sim(
				c,
				`${cells.length}:${b.size}`,
				p.step as number,
				() => [new Uint8Array(cells.length)],
				(sm) => {
					const cur = sm.data[0]
					const next = new Uint8Array(cells.length)
					for (let i = 0; i < cells.length; i++) {
						if (cur[i] === 1) next[i] = 2
						else if (cur[i] === 2) next[i] = 0
						else {
							let on = 0
							for (const j of nb[i]) if (cur[j] === 1) on++
							if (on === 2 || (cells[i].d < b.pitch && hash3(i, sm.gen, 17) < spark)) next[i] = 1
						}
					}
					sm.data[0] = next
				},
				40,
			)
			const st = s.data[0]
			const dying = p.dying as number
			const base = p.base as number
			for (let i = 0; i < cells.length; i++) {
				const q = cells[i]
				const f = fall(b, q.d, depth, p.falloff as number)
				const lv = st[i] === 1 ? 1 : st[i] === 2 ? dying : q.d < b.pitch ? base : 0
				c.cell(q.x, q.y, b.size, b.size, lv * (0.35 + 0.65 * f), f)
			}
		},
	},
]

const nbCache = new Map<string, { band: Band; nb: number[][] }>()
function neighbours(key: string, b: Band) {
	const hit = nbCache.get(key)
	if (hit && hit.band === b) return hit.nb
	const index = new Map<number, number>()
	b.cells.forEach((q, i) => index.set(q.gx * 100003 + q.gy, i))
	const nb = b.cells.map((q) => {
		const out: number[] = []
		for (let dy = -1; dy <= 1; dy++)
			for (let dx = -1; dx <= 1; dx++) {
				if (!dx && !dy) continue
				const j = index.get((q.gx + dx) * 100003 + q.gy + dy)
				if (j !== undefined) out.push(j)
			}
		return out
	})
	nbCache.set(key, { band: b, nb })
	return nb
}
