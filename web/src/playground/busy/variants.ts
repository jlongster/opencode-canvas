import { range, select, SPEED, type ParamDef, type ParamValues } from '../shared/params'
import { hash3, noise3 } from './geometry'

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
	draw(c: BusyCtx): void
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
const easeInOut = bezier(0.65, 0, 0.35, 1)
const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
const mod = (a: number, b: number) => ((a % b) + b) % b
const smoothstep = (a: number, b: number, x: number) => {
	const t = clamp01((x - a) / (b - a))
	return t * t * (3 - 2 * t)
}

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

/** Seamless noise around the loop: s is mapped onto a circle so it wraps at L. */
function loopNoise(s: number, L: number, scale: number, y: number, z: number) {
	const R = L / (2 * Math.PI * scale)
	const a = (s / L) * 2 * Math.PI
	return noise3(Math.cos(a) * R + 31.7, Math.sin(a) * R + 11.3 + y, z)
}

const BAYER8 = (() => {
	const m = [
		[0, 2],
		[3, 1],
	]
	let b = m
	for (let n = 2; n < 8; n *= 2) {
		const next: number[][] = []
		for (let y = 0; y < 2 * n; y++) {
			next.push([])
			for (let x = 0; x < 2 * n; x++) next[y].push(4 * b[y % n][x % n] + m[Math.floor(y / n)][Math.floor(x / n)])
		}
		b = next
	}
	return b.map((row) => row.map((v) => (v + 0.5) / 64))
})()

const COLOR = select('color', 'Colour', ['session', 'white'], 'session')
const PEAK = (v: number) => range('peak', 'Intensity', v, 0, 1, 0.01)
const LEVELS = (v: number) => range('levels', 'Brightness steps', v, 0, 6, 1)
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

export const VARIANTS: BusyVariant[] = [
	{
		id: 'shed',
		name: 'Pixel shedding',
		note: 'The whole outline sheds square pixels: every cell of the edge lets go of one now and then, which hops outward a cell at a time (sometimes sideways), stepping down in brightness until it is gone. Positions are always whole cells; nothing glides.',
		params: [
			SPEED,
			CELL(3),
			GAP(1),
			DEPTH(9, 20),
			range('interval', 'Every', 1.3, 0.3, 5, 0.05, 's'),
			range('density', 'Density', 1, 0.1, 1, 0.01),
			range('step', 'Hop', 0.09, 0.03, 0.3, 0.01, 's'),
			range('drift', 'Sideways drift', 0.35, 0, 1, 0.01),
			range('base', 'Edge glow', 0.5, 0, 1, 0.01),
			FALLOFF(1),
			PEAK(0.9),
			LEVELS(4),
			COLOR,
		],
		still: 2.2,
		draw(c) {
			const { p } = c
			const depth = p.depth as number
			const b = band(c, p.cell as number, p.gap as number, depth)
			const n = Math.max(16, Math.floor(b.L / b.pitch))
			const I = p.interval as number
			const step = p.step as number
			const drift = p.drift as number
			const dens = p.density as number
			const base = p.base as number
			for (const q of b.cells) {
				const row = Math.floor(q.d / b.pitch)
				const col = Math.floor((q.s / b.L) * n) % n
				const f = fall(b, q.d, depth, p.falloff as number)
				let level = row === 0 ? base : 0
				for (let dc = -2; dc <= 2 && level < 1; dc++) {
					const src = mod(col - dc, n)
					const k0 = Math.floor(c.t / I)
					for (let k = k0 - 1; k <= k0; k++) {
						if (hash3(src, k, 3) > dens) continue
						const launch = (k + hash3(src, k, 5)) * I
						const age = Math.floor((c.t - launch) / step)
						if (age !== row) continue
						const dir = hash3(src, k, 9) < 0.5 ? -1 : 1
						const side = hash3(src, k, 11) < drift ? Math.floor((row * dir) / 3) : 0
						if (side !== dc) continue
						level = Math.max(level, 1 - row / depth)
					}
				}
				c.cell(q.x, q.y, b.size, b.size, level, f)
			}
		},
	},
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
	{
		id: 'dither',
		name: 'Bayer emanation',
		note: 'Bands of light leave the whole edge and travel outward, drawn as an 8×8 Bayer ordered dither of 2px cells instead of a gradient: every pixel is fully on or off, and density does the fading.',
		params: [
			SPEED,
			CELL(2),
			GAP(1),
			DEPTH(10, 30),
			range('wavelength', 'Wavelength', 22, 8, 80, 1, 'px'),
			range('period', 'Period', 1.6, 0.4, 5, 0.05, 's'),
			range('sharp', 'Band sharpness', 2.5, 0.5, 8, 0.1),
			range('wobble', 'Wobble', 0.25, 0, 1, 0.01),
			range('base', 'Edge glow', 0.35, 0, 1, 0.01),
			FALLOFF(1.2),
			PEAK(0.85),
			COLOR,
		],
		still: 0.5,
		draw(c) {
			const { p } = c
			const depth = p.depth as number
			const b = band(c, p.cell as number, p.gap as number, depth)
			const lambda = p.wavelength as number
			const base = p.base as number
			for (const q of b.cells) {
				const f = fall(b, q.d, depth, p.falloff as number)
				const wob = (p.wobble as number) * (loopNoise(q.s, b.L, 60, 0, c.t * 0.3) - 0.5)
				const w = Math.pow(0.5 + 0.5 * Math.cos(2 * Math.PI * (q.d / lambda - c.t / (p.period as number) + wob)), p.sharp as number)
				const I = f * (base + (1 - base) * w)
				const thr = BAYER8[mod(q.gy, 8)][mod(q.gx, 8)]
				c.cell(q.x, q.y, b.size, b.size, I > thr ? 1 : 0, f > thr ? 1 : 0)
			}
		},
	},
	{
		id: 'rule',
		name: 'Cellular border',
		note: 'An elementary cellular automaton (rule 30) wrapped around the perimeter: each step the newest generation appears at the edge and older ones are pushed outward, fading, so the whole outline grows crisp, ever-changing lace.',
		params: [
			SPEED,
			CELL(3),
			GAP(1),
			DEPTH(7),
			range('step', 'Step', 0.11, 0.04, 0.5, 0.01, 's'),
			range('rule', 'Rule', 30, 0, 255, 1),
			range('noise', 'Mutation', 0.004, 0, 0.05, 0.001),
			FALLOFF(1),
			PEAK(0.9),
			LEVELS(4),
			COLOR,
		],
		still: 4,
		draw(c) {
			const { p } = c
			const depth = p.depth as number
			const b = band(c, p.cell as number, p.gap as number, depth)
			const n = Math.max(16, Math.floor(b.L / b.pitch))
			const rule = p.rule as number
			const mut = p.noise as number
			const s = sim(
				c,
				`${n}:${depth}:${rule}`,
				p.step as number,
				() => Array.from({ length: depth + 1 }, (_, r) => Uint8Array.from({ length: n }, (_, i) => (hash3(i, r, 7) < 0.5 ? 1 : 0))),
				(sm) => {
					const prev = sm.data[sm.data.length - 1]
					const next = new Uint8Array(n)
					for (let i = 0; i < n; i++) {
						const k = (prev[(i + n - 1) % n] << 2) | (prev[i] << 1) | prev[(i + 1) % n]
						next[i] = (rule >> k) & 1
						if (mut && hash3(i, sm.gen, 13) < mut) next[i] ^= 1
					}
					sm.data.push(next)
					if (sm.data.length > depth + 1) sm.data.shift()
				},
				depth + 2,
			)
			const rows = s.data.length
			for (const q of b.cells) {
				const row = Math.floor(q.d / b.pitch)
				if (row >= rows) continue
				const gen = s.data[rows - 1 - row]
				const f = fall(b, q.d, depth, p.falloff as number)
				c.cell(q.x, q.y, b.size, b.size, gen[Math.floor((q.s / b.L) * n) % n] ? 0.25 + 0.75 * f : 0, f)
			}
		},
	},
	{
		id: 'flip',
		name: 'Split-flap ring',
		note: 'Two rings of 6px tiles round the frame flip like a split-flap board: flips set off from four points at once and run both ways round the perimeter, each tile turning edge-on in whole pixels from its dim face to its lit one and back.',
		params: [
			SPEED,
			CELL(6),
			GAP(2),
			DEPTH(2, 4),
			range('origins', 'Start points', 4, 1, 8, 1),
			range('period', 'Cycle', 2.4, 0.8, 6, 0.05, 's'),
			range('travel', 'Travel speed', 260, 40, 1200, 10, 'px/s'),
			range('flip', 'Flip time', 0.22, 0.06, 0.6, 0.01, 's'),
			range('hold', 'Lit for', 0.3, 0.1, 0.9, 0.01),
			range('dim', 'Dim face', 0.28, 0, 1, 0.01),
			range('spin', 'Start drift', 0.04, 0, 0.3, 0.005),
			PEAK(0.9),
			COLOR,
		],
		still: 0.9,
		draw(c) {
			const { p } = c
			const b = band(c, p.cell as number, p.gap as number, p.depth as number, 2)
			const K = p.origins as number
			const P = p.period as number
			const flip = p.flip as number
			const dim = p.dim as number
			const shift = (c.t * (p.spin as number)) % 1
			for (const q of b.cells) {
				// Distance (along the outline) to the nearest start point.
				const u = mod(q.s / b.L - shift, 1 / K) * K
				const dist = Math.min(u, 1 - u) * (b.L / K) + Math.floor(q.d / b.pitch) * b.pitch * 0.5
				const local = mod(c.t - dist / (p.travel as number), P)
				// Turn to the lit face, hold it for part of the cycle, then turn back.
				const back = (p.hold as number) * P
				let ang: number
				let lit: boolean
				if (local < back) {
					const k = clamp01(local / flip)
					ang = Math.PI * easeInOut(k)
					lit = k >= 0.5
				} else {
					const k = clamp01((local - back) / flip)
					ang = Math.PI * easeInOut(k)
					lit = k < 0.5
				}
				const scale = Math.abs(Math.cos(ang))
				const along = Math.abs(q.ny) > Math.abs(q.nx)
				const full = b.size
				const sz = Math.round(full * scale)
				if (sz <= 0) continue
				const off = Math.floor((full - sz) / 2)
				const level = lit ? 1 : dim
				if (along) c.cell(q.x, q.y + off, full, sz, level, 1)
				else c.cell(q.x + off, q.y, sz, full, level, 1)
			}
		},
	},
	{
		id: 'aura',
		name: 'Pixel aura',
		note: 'A band of 3px cells all the way round the frame, lit by slow noise that flows outward from the edge and snapped to four brightness steps: a dithered, pixel-art aura that never repeats exactly.',
		params: [
			SPEED,
			CELL(3),
			GAP(1),
			DEPTH(7),
			range('scale', 'Noise size', 26, 6, 120, 1, 'px'),
			range('flow', 'Outward flow', 16, 0, 80, 1, 'px/s'),
			range('churn', 'Churn', 0.25, 0, 2, 0.01),
			range('base', 'Edge glow', 0.16, 0, 1, 0.01),
			FALLOFF(1.5),
			PEAK(0.9),
			LEVELS(4),
			COLOR,
		],
		still: 3,
		draw(c) {
			const { p } = c
			const depth = p.depth as number
			const b = band(c, p.cell as number, p.gap as number, depth)
			const sc = p.scale as number
			const base = p.base as number
			for (const q of b.cells) {
				const f = fall(b, q.d, depth, p.falloff as number)
				const n = loopNoise(q.s, b.L, sc, (q.d - c.t * (p.flow as number)) / sc, c.t * (p.churn as number))
				c.cell(q.x, q.y, b.size, b.size, f * (base + (1 - base) * smoothstep(0.42, 0.85, n)), f)
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
