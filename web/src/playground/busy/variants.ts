import { range, select, SPEED, type ParamDef, type ParamValues } from '../shared/params'
import { LAYOUT } from '../../editor/layout'
import { rng } from './geometry'

/** A rectangle in device pixels (unrounded unless noted). */
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
	/** the slot reserved after the title text (titled variations), device px */
	slot: Rect
	/** speed-scaled seconds, offset per frame */
	t: number
	dpr: number
	/** zoom: CSS px per page unit */
	z: number
	p: ParamValues
	/** stable per frame */
	seed: number
	/** CSS px to whole device px (at least 1) */
	px(css: number): number
	/** A block at whole device px lit to `level` (0 = the unlit floor, 1 = full colour), after the done fill and brightness steps. */
	cell(x: number, y: number, w: number, h: number, level: number): void
}

export interface BusyVariant {
	id: string
	name: string
	/** the principle it follows and where from, shown as the demo's caption */
	note: string
	params: ParamDef[]
	/** titled variations sit right after the frame title in a slot this big (CSS px) */
	slot?: (p: ParamValues) => [number, number]
	/** reduced motion: the time to freeze at, a pose that still reads as "busy" */
	still: number
	draw(c: BusyCtx): void
}

// ---------- timing ----------

/** CSS cubic-bezier(x1, y1, x2, y2) as a function of progress (Newton–Raphson, then bisection). */
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
		let t = x
		for (let i = 0; i < 6; i++) {
			const d = (3 * ax * t + 2 * bx) * t + cx
			if (Math.abs(d) < 1e-6) break
			t -= (sx(t) - x) / d
		}
		if (t < 0 || t > 1 || Math.abs(sx(t) - x) > 1e-4) {
			let lo = 0
			let hi = 1
			t = x
			for (let i = 0; i < 24; i++) {
				if (sx(t) < x) lo = t
				else hi = t
				t = (lo + hi) / 2
			}
		}
		return ((ay * t + by) * t + cy) * t
	}
}

/** Emil Kowalski's strong ease-out and the playground's ease-in-out. */
export const easeOut = bezier(0.23, 1, 0.32, 1)
export const easeInOut = bezier(0.65, 0, 0.35, 1)
const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
const mod = (a: number, b: number) => ((a % b) + b) % b

/** Fast attack, slow quadratic release: 0 → 1 over `attack`, back to 0 over `decay`, then rest. */
function pulse(u: number, attack: number, decay: number) {
	if (u < 0) return 0
	if (u < attack) return easeOut(u / attack)
	const x = (u - attack) / decay
	return x >= 1 ? 0 : (1 - x) * (1 - x)
}

const COLOR = select('color', 'Colour', ['session', 'white'], 'session')
const FLOOR = (v: number) => range('floor', 'Unlit', v, 0, 0.3, 0.005)
const PEAK = (v: number) => range('peak', 'Lit', v, 0, 1, 0.01)
const LEVELS = (v: number) => range('levels', 'Brightness steps', v, 0, 6, 1)

/** Top-left of the title slot, snapped. */
const slotOrigin = (c: BusyCtx, w: number, h: number) => [Math.round(c.slot.x), Math.round(c.slot.y + (c.slot.h - h) / 2)]

export const VARIANTS: BusyVariant[] = [
	{
		id: 'cascade',
		name: 'Title cascade',
		note: 'Four blocks after the title light in turn, like Vercel’s loading dots: 100 ms attack, 500 ms release, 120 ms apart, then a third of the cycle at rest. The blocks never move; only which one is lit does.',
		params: [
			SPEED,
			range('count', 'Blocks', 4, 2, 8, 1),
			range('size', 'Block', 4, 2, 8, 1, 'px'),
			range('gap', 'Gap', 2, 1, 6, 1, 'px'),
			range('period', 'Cycle', 1.4, 0.6, 3, 0.05, 's'),
			range('stagger', 'Stagger', 0.12, 0.03, 0.3, 0.01, 's'),
			range('attack', 'Attack', 0.1, 0.02, 0.4, 0.01, 's'),
			range('decay', 'Release', 0.5, 0.1, 1.5, 0.05, 's'),
			FLOOR(0.08),
			PEAK(0.95),
			LEVELS(0),
			COLOR,
		],
		slot: (p) => {
			const n = p.count as number
			return [n * (p.size as number) + (n - 1) * (p.gap as number), p.size as number]
		},
		still: 0.2,
		draw(c) {
			const { p } = c
			const s = c.px(p.size as number)
			const pitch = s + c.px(p.gap as number)
			const [x0, y0] = slotOrigin(c, 0, s)
			for (let i = 0; i < (p.count as number); i++) {
				const u = mod(c.t - i * (p.stagger as number), p.period as number)
				c.cell(x0 + i * pitch, y0, s, s, pulse(u, p.attack as number, p.decay as number))
			}
		},
	},
	{
		id: 'gray',
		name: 'Gray-code counter',
		note: 'Five blocks after the title count in Gray code: every 220 ms exactly one block changes (eased over 120 ms), so it reads as steady computation without ever flickering. The right block toggles most, the left least; 32 ticks make an exact 7 s loop.',
		params: [
			SPEED,
			range('bits', 'Blocks', 5, 3, 8, 1),
			range('size', 'Block', 4, 2, 8, 1, 'px'),
			range('gap', 'Gap', 2, 1, 6, 1, 'px'),
			range('tick', 'Tick', 0.22, 0.08, 0.6, 0.01, 's'),
			range('ease', 'Change', 0.12, 0, 0.4, 0.01, 's'),
			FLOOR(0.08),
			PEAK(0.9),
			COLOR,
		],
		slot: (p) => {
			const n = p.bits as number
			return [n * (p.size as number) + (n - 1) * (p.gap as number), p.size as number]
		},
		still: 2.42,
		draw(c) {
			const { p } = c
			const s = c.px(p.size as number)
			const pitch = s + c.px(p.gap as number)
			const n = p.bits as number
			const [x0, y0] = slotOrigin(c, 0, s)
			const tick = p.tick as number
			const k = Math.floor(c.t / tick)
			const into = c.t - k * tick
			const gray = (m: number) => m ^ (m >> 1)
			const now = gray(mod(k, 1 << n))
			const before = gray(mod(k - 1, 1 << n))
			const e = (p.ease as number) > 0 ? easeOut(Math.min(1, into / (p.ease as number))) : 1
			for (let i = 0; i < n; i++) {
				const bit = n - 1 - i
				const a = (before >> bit) & 1
				const b = (now >> bit) & 1
				c.cell(x0 + i * pitch, y0, s, s, a + (b - a) * e)
			}
		},
	},
	{
		id: 'typing',
		name: 'Typing',
		note: 'A block cursor after the title “types” a short line of dim cells at an uneven, human rhythm, pauses, then clears and starts again: the session is writing. Each line is seeded, so no two are the same, and every cycle ends where the next begins.',
		params: [
			SPEED,
			range('cells', 'Max cells', 6, 3, 12, 1),
			range('width', 'Cell width', 3, 2, 6, 1, 'px'),
			range('height', 'Cell height', 7, 3, 12, 1, 'px'),
			range('gap', 'Gap', 1, 0, 4, 1, 'px'),
			range('period', 'Cycle', 2.6, 1.2, 6, 0.1, 's'),
			range('typed', 'Typed cells', 0.32, 0, 1, 0.01),
			FLOOR(0),
			PEAK(0.95),
			COLOR,
		],
		slot: (p) => {
			const n = (p.cells as number) + 1
			return [n * (p.width as number) + (n - 1) * (p.gap as number), p.height as number]
		},
		still: 1.9,
		draw(c) {
			const { p } = c
			const w = c.px(p.width as number)
			const h = c.px(p.height as number)
			const pitch = w + c.px(p.gap as number)
			const [x0, y0] = slotOrigin(c, 0, h)
			const P = p.period as number
			const max = p.cells as number
			const k = Math.floor(c.t / P)
			const u = c.t - k * P
			// Per line: how many cells, and when each lands (uneven gaps, one longer "thinking" pause).
			const r = rng(c.seed * 7919 + k * 104729)
			const n = Math.max(2, Math.round(max * (0.55 + 0.45 * r())))
			const gaps: number[] = []
			const pause = Math.floor(r() * n)
			for (let i = 0; i < n; i++) gaps.push((0.5 + r()) * (i === pause ? 3 : 1))
			const total = gaps.reduce((a, b) => a + b, 0)
			const typeStart = 0.08 * P
			const typeEnd = 0.58 * P
			const clearAt = 0.84 * P
			const at: number[] = []
			let acc = 0
			for (const g of gaps) {
				acc += g
				at.push(typeStart + (acc / total) * (typeEnd - typeStart))
			}
			const typedCount = at.filter((a) => u >= a).length
			const clearing = u >= clearAt
			for (let i = 0; i <= max; i++) {
				let level = 0
				if (i < n && u >= at[i]) {
					level = (p.typed as number) * easeOut(Math.min(1, (u - at[i]) / 0.06))
					if (clearing) level *= 1 - easeOut(clamp01((u - clearAt - i * 0.025) / 0.15))
				}
				// The cursor sits after the last typed cell; it blinks once while the line holds.
				const cursorAt = clearing ? 0 : typedCount
				if (i === cursorAt) {
					const hold = u - typeEnd
					const blink = !clearing && hold > 0.18 * P && hold < 0.18 * P + 0.24 ? 0.25 : 1
					level = Math.max(level, blink)
				}
				c.cell(x0 + i * pitch, y0, w, h, level)
			}
		},
	},
	{
		id: 'quadrant',
		name: 'Quadrant spinner',
		note: 'The terminal’s ▖▘▝▗ box spinner as a 2×2 block glyph after the title: the lit quadrant steps clockwise every 150 ms (cli-spinners’ boxBounce is 120 ms), the one it left fades over two steps.',
		params: [
			SPEED,
			range('size', 'Quadrant', 4, 2, 8, 1, 'px'),
			range('gap', 'Gap', 1, 0, 3, 1, 'px'),
			range('step', 'Step', 0.15, 0.08, 0.4, 0.01, 's'),
			range('tail', 'Tail', 2, 0.5, 3, 0.1, 'steps'),
			FLOOR(0.1),
			PEAK(0.95),
			LEVELS(0),
			COLOR,
		],
		slot: (p) => {
			const d = 2 * (p.size as number) + (p.gap as number)
			return [d, d]
		},
		still: 0.07,
		draw(c) {
			const { p } = c
			const s = c.px(p.size as number)
			const pitch = s + c.px(p.gap as number)
			const [x0, y0] = slotOrigin(c, 0, 2 * s + (pitch - s))
			const step = p.step as number
			const order = [
				[0, 0],
				[1, 0],
				[1, 1],
				[0, 1],
			]
			order.forEach(([cx, cy], j) => {
				const age = mod(c.t - j * step, 4 * step)
				const level = age < step ? 1 : Math.pow(clamp01(1 - (age - step) / ((p.tail as number) * step)), 1.5)
				c.cell(x0 + cx * pitch, y0 + cy * pitch, s, s, level)
			})
		},
	},
	{
		id: 'meter',
		name: 'Level meter',
		note: 'A 4×3 block meter after the title: ▁▃▅▇ bars whose heights follow one cosine (Shiffman’s simple harmonic motion), offset by column so a wave rolls across, snapped to whole rows like an LED level display. Every bar empties once a cycle, so the cluster breathes instead of sitting lit.',
		params: [
			SPEED,
			range('columns', 'Columns', 4, 2, 8, 1),
			range('rows', 'Rows', 3, 2, 6, 1),
			range('size', 'Block', 3, 2, 6, 1, 'px'),
			range('gap', 'Gap', 1, 0, 3, 1, 'px'),
			range('period', 'Cycle', 1.8, 0.6, 4, 0.05, 's'),
			range('offset', 'Column offset', 0.14, 0, 0.5, 0.01),
			FLOOR(0.08),
			PEAK(0.85),
			COLOR,
		],
		slot: (p) => {
			const s = p.size as number
			const g = p.gap as number
			return [(p.columns as number) * (s + g) - g, (p.rows as number) * (s + g) - g]
		},
		still: 0.3,
		draw(c) {
			const { p } = c
			const s = c.px(p.size as number)
			const pitch = s + c.px(p.gap as number)
			const cols = p.columns as number
			const rows = p.rows as number
			const [x0, y0] = slotOrigin(c, 0, rows * pitch - (pitch - s))
			const ph = c.t / (p.period as number)
			for (let i = 0; i < cols; i++) {
				const a = ph - i * (p.offset as number)
				const hgt = 0.5 - 0.5 * Math.cos(2 * Math.PI * a)
				const lit = Math.round(hgt * rows)
				for (let r = 0; r < rows; r++) c.cell(x0 + i * pitch, y0 + (rows - 1 - r) * pitch, s, s, r < lit ? 1 : 0)
			}
		},
	},
	{
		id: 'tiles',
		name: 'Tile progress',
		note: 'An indeterminate progress bar made of tiles along the bottom edge (in the frame’s bottom padding, or just under the frame when zoomed out): a fill front and an empty front sweep left to right with ease-in-out, 450 ms apart (Material’s indeterminate bar), then the row rests. Brightness snaps to three steps.',
		params: [
			SPEED,
			range('width', 'Tile width', 6, 2, 16, 1, 'px'),
			range('height', 'Tile height', 2, 1, 6, 1, 'px'),
			range('gap', 'Gap', 2, 1, 6, 1, 'px'),
			range('below', 'Below frame', 6, 2, 24, 1, 'px'),
			range('period', 'Cycle', 2.6, 1.2, 6, 0.1, 's'),
			range('sweep', 'Sweep', 1.1, 0.4, 3, 0.05, 's'),
			range('lag', 'Empty lag', 0.45, 0.1, 1.5, 0.05, 's'),
			range('soft', 'Soft edge', 4, 1, 12, 1, 'tiles'),
			FLOOR(0.05),
			PEAK(0.6),
			LEVELS(3),
			COLOR,
		],
		still: 0.75,
		draw(c) {
			const { p, frame } = c
			if (frame.w < 200 * c.dpr) return
			const w = c.px(p.width as number)
			const h = c.px(p.height as number)
			const pitch = w + c.px(p.gap as number)
			const pad = LAYOUT.framePadding * c.z * c.dpr
			const span = frame.w - 2 * c.px(24)
			const n = Math.floor((span + pitch - w) / pitch)
			const x0 = Math.round(frame.x + (frame.w - (n * pitch - (pitch - w))) / 2)
			// Centred in the frame's bottom padding when it has room, else just under the frame.
			const y0 = Math.round(pad >= h + c.px(14) ? frame.y + frame.h - (pad + h) / 2 : frame.y + frame.h + c.px(p.below as number))
			const u = mod(c.t, p.period as number)
			const soft = p.soft as number
			const reach = n + soft
			const fill = easeInOut(clamp01(u / (p.sweep as number))) * reach
			const empty = easeInOut(clamp01((u - (p.lag as number)) / (p.sweep as number))) * reach
			for (let i = 0; i < n; i++) {
				const x = x0 + i * pitch
				c.cell(x, y0, w, h, clamp01((fill - i) / soft) - clamp01((empty - i) / soft))
			}
		},
	},
]
