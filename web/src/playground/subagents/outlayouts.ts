import type { Pose } from './pose'

/*
 * Semantic zoom's zoomed-out layouts: where a session's subagents sit around the bottom of its frame
 * when you're far out. Everything is flat: no lean, no perspective (the fan turns cards in the plane
 * only). Each returns a pose per child, relative to the parent's pose, that zooming in blends into
 * the dealt rows card by card.
 */

export type OutLayout = 'tucked' | 'dock' | 'fan' | 'tabs'

export const OUT_LAYOUTS: { id: OutLayout; name: string; note: string; params: string[] }[] = [
	{
		id: 'tucked',
		name: 'Tucked',
		note: 'Under the frame like a pile of papers seen from above: a strip of each peeks out below its bottom edge, with a status dot and the agent.',
		params: ['depth', 'offset', 'minOff', 'falloff', 'jitter', 'dim', 'shadow'],
	},
	{
		id: 'dock',
		name: 'Dock',
		note: 'Miniature frames in a neat row docked just under the bottom edge; past a row it wraps, or ends on a "+N" card.',
		params: ['perRow', 'overflow', 'dockGap', 'shadow'],
	},
	{
		id: 'fan',
		name: 'Fan',
		note: 'A hand of cards held below the frame: a shallow flat arc, newest in the middle on top, turned in the plane only.',
		params: ['handSize', 'handStep', 'arc', 'tuck', 'maxHand', 'shadow'],
	},
	{
		id: 'tabs',
		name: 'Tabs',
		note: 'Index sheets stepping down behind the frame, each with a labelled tab hanging below it, staggered along the bottom like a card file.',
		params: ['maxTabs', 'tabStep', 'tabH', 'dim', 'shadow'],
	},
]

export interface OutParams {
	/** page units for screen pixels at the current zoom (1 / z) */
	px: number
	depth: number
	offset: number
	falloff: number
	jitter: number
	dim: number
	shadow: number
	perRow: number
	overflow: string
	dockGap: number
	handSize: number
	handStep: number
	arc: number
	tuck: number
	maxHand: number
	maxTabs: number
	tabStep: number
	tabH: number
}

/** What a card needs beyond its pose: where its tab hangs (tabs), and a "+N" it carries (dock, tabs). */
export interface OutExtra {
	/** tab's left edge and width, in page units from the card's left edge */
	tabX: number
	tabW: number
	tabH: number
	/** children summarised by this card ("+N"), 0 for none */
	plus: number
	/** stacking rank within the family: 0 on top */
	rank: number
}

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v))

/** A stable small number in -0.5…0.5 per index (paper jitter). */
const wobble = (i: number, salt: number) => (((i + 1) * 7919 + salt * 104729) % 97) / 97 - 0.5

/** Fan order: the newest in the middle, then alternately right and left of it. */
export function handPos(i: number) {
	return i === 0 ? 0 : i % 2 ? Math.ceil(i / 2) : -Math.ceil(i / 2)
}

/**
 * The zoomed-out pose of child i of n (deck order: running first, then newest) around parent pose P.
 * `g` is the child frame's natural size. Writes `out` and `extra`.
 */
export function outPose(layout: OutLayout, P: Pose, i: number, n: number, g: { w: number; h: number }, q: OutParams, out: Pose, extra: OutExtra): Pose {
	const ps = P.s
	const pw = P.bw * ps
	const ph = P.bh * ps
	const left = P.x - pw / 2
	const bottom = P.y + ph
	out.rx = 0
	out.ry = 0
	out.rz = 0
	out.tz = 0
	out.grx = 0
	out.gx = P.x
	out.gy = bottom
	out.pox = P.x
	out.poy = P.y + ph / 2
	out.persp = 2400
	out.strip = 0
	out.tab = 0
	out.shade = 0
	out.sh = 0
	out.o = 1
	extra.plus = 0
	extra.rank = i
	extra.tabX = 0
	extra.tabW = 0
	extra.tabH = 0

	if (layout === 'tucked') {
		const slot = Math.max(0, Math.min(i, q.depth - 1))
		const k = Math.pow(q.falloff, slot + 1)
		const w = pw * k
		const s = Math.min(ps, w / g.w)
		const off = q.offset * ps * (slot + 1)
		out.x = P.x + wobble(slot, 1) * q.jitter * 0.03 * pw
		out.y = bottom + off - ph * k
		out.s = s
		out.bw = w / s
		out.bh = (ph * k) / s
		out.hy = 1
		out.rz = wobble(slot, 2) * q.jitter * 1.6
		out.strip = 1
		out.shade = Math.min(0.8, q.dim * (slot + 1))
		out.sh = q.shadow
		out.o = clamp(q.depth - i)
		return out
	}

	if (layout === 'dock') {
		const per = Math.max(2, Math.round(q.perRow))
		const gap = 0.03 * pw
		const wm = (pw - (per - 1) * gap) / per
		const hm = wm * 0.62
		const plusMode = q.overflow !== 'wrap' && n > per
		let slot = i
		if (plusMode && i >= per - 1) {
			slot = per - 1
			out.o = i === per - 1 ? 1 : 0
			if (i === per - 1) extra.plus = n - (per - 1)
		}
		const row = plusMode ? 0 : Math.floor(slot / per)
		const col = plusMode ? slot : slot % per
		const inRow = plusMode ? per : Math.min(per, n - row * per)
		const rowW = inRow * wm + (inRow - 1) * gap
		const x0 = left + (pw - rowW) / 2
		const s = wm / g.w
		out.s = s
		out.bw = g.w
		out.bh = hm / s
		out.x = x0 + col * (wm + gap) + wm / 2
		out.y = bottom + Math.max(q.dockGap, 6 * q.px) * ps + row * (hm + gap)
		out.hy = 0.5
		out.sh = q.shadow * 0.5
		return out
	}

	if (layout === 'fan') {
		const m = Math.min(n, Math.max(1, Math.round(q.maxHand)))
		const cw = pw * q.handSize
		const ch = cw / 1.5
		const s = cw / g.w
		out.s = s
		out.bw = g.w
		out.bh = ch / s
		out.hy = 0.5
		// Positions centre-out; a hand wider than ±16° gets a tighter step, so the arc stays shallow.
		const positions = Array.from({ length: m }, (_, k) => handPos(k))
		const mid = (Math.max(...positions) + Math.min(...positions)) / 2
		const step = m > 1 ? Math.min(q.handStep, 32 / (m - 1)) : 0
		const pos = i < m ? handPos(i) - mid : 0
		const th = (pos * step * Math.PI) / 180
		const R = ch * q.arc
		const top = bottom - q.tuck * ch
		const cx = P.x + Math.sin(th) * (R - ch / 2)
		const cy = top + R - Math.cos(th) * (R - ch / 2)
		out.x = cx
		out.y = cy - ch / 2
		out.rz = pos * step
		out.sh = q.shadow
		out.shade = Math.min(0.35, Math.abs(pos) * 0.05)
		out.o = i < m ? 1 : 0
		return out
	}

	// tabs: index sheets stepping down behind the frame, a labelled tab hanging below each
	const K = Math.min(n, Math.max(1, Math.round(q.maxTabs)))
	const slot = Math.min(i, K - 1)
	const stepY = Math.max(q.tabStep, 5 * q.px) * ps
	const tabH = Math.max(q.tabH, 15 * q.px) * ps
	const k = 1 - 0.008 * (slot + 1)
	const w = pw * k
	const s = Math.min(ps, w / g.w)
	out.x = P.x
	out.y = bottom + stepY * (slot + 1) - ph * k
	out.s = s
	out.bw = w / s
	out.bh = (ph * k) / s
	out.hy = 1
	out.strip = 1
	out.tab = 1
	out.shade = Math.min(0.6, q.dim * 0.6 * (slot + 1))
	out.sh = q.shadow * 0.6
	out.o = clamp(K - i)
	const margin = pw * 0.04
	const tgap = pw * 0.012
	const tabW = (pw - margin * 2 - (K - 1) * tgap) / K
	extra.tabW = tabW
	extra.tabH = tabH
	extra.tabX = margin + slot * (tabW + tgap) - (pw - w) / 2
	if (slot === K - 1 && n > K && i === K - 1) extra.plus = n - (K - 1)
	return out
}

/** The family's extent in the zoomed-out layout, relative to the parent's top-left, ignoring rotation. */
export function outExtent(layout: OutLayout, poses: Pose[], extras: OutExtra[], parent: { w: number; h: number }) {
	let x0 = 0
	let y0 = 0
	let x1 = parent.w
	let y1 = parent.h
	poses.forEach((p, k) => {
		if (p.o <= 0) return
		const w = p.bw * p.s
		const h = p.bh * p.s
		// a turned card reaches a little wider and lower than its box
		const r = Math.abs(p.rz) > 0.01 ? Math.abs(Math.sin((p.rz * Math.PI) / 180)) * h * 0.5 : 0
		x0 = Math.min(x0, p.x - w / 2 - r)
		x1 = Math.max(x1, p.x + w / 2 + r)
		y0 = Math.min(y0, p.y)
		y1 = Math.max(y1, p.y + h + r * 0.5 + (layout === 'tabs' ? extras[k].tabH : 0))
	})
	return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}
