import type { Frame, Tile } from './data'

/** The app's frame metrics (editor/layout.ts LAYOUT), in page units. */
export const FRAME = {
	pad: 40,
	head: 96,
	row: 320,
	gap: 16,
	title: 40,
	radius: 20,
	/** an empty (ghost) frame's body */
	empty: 120,
}

export interface Rect {
	x: number
	y: number
	w: number
	h: number
}

export interface FrameGeom {
	w: number
	h: number
	tiles: Rect[]
}

/**
 * A frame's natural size with its tiles in justified rows (each row scaled to the content width, the
 * last row left at the row height if it would be stretched).
 */
export function frameGeom(tiles: Tile[], maxRow: number): FrameGeom {
	const { pad, head, row, gap } = FRAME
	if (!tiles.length) return { w: 640, h: head + FRAME.empty + pad, tiles: [] }
	const natural = tiles.reduce((s, t) => s + t.a * row, 0) + gap * (tiles.length - 1)
	const W = Math.min(maxRow, natural)
	const out: Rect[] = []
	let y = head
	let i = 0
	while (i < tiles.length) {
		let j = i
		let sum = 0
		while (j < tiles.length) {
			const next = sum + tiles[j].a
			if (j > i && next * row + gap * (j - i) > W * 1.12) break
			sum = next
			j++
		}
		const n = j - i
		let h = (W - gap * (n - 1)) / sum
		if (j === tiles.length && h > row * 1.2) h = row
		let x = pad
		for (let k = i; k < j; k++) {
			const w = tiles[k].a * h
			out.push({ x, y, w, h })
			x += w + gap
		}
		y += h + gap
		i = j
	}
	return { w: W + pad * 2, h: y - gap + pad, tiles: out }
}

/** A child placed relative to its parent's top-left: where its top-left goes and its scale. */
export interface Placed {
	x: number
	y: number
	s: number
}

export interface FanLayout {
	at: Placed[]
	/** the family's extent relative to the parent's top-left (includes the parent) */
	box: Rect
}

const union = (a: Rect, b: Rect): Rect => {
	const x = Math.min(a.x, b.x)
	const y = Math.min(a.y, b.y)
	return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }
}

/**
 * Rows, as the canvas lays out items: every child at the same scale, left to right, wrapping before
 * `maxW`, each row as tall as its tallest frame.
 */
function rows(sizes: { w: number; h: number }[], scale: number, maxW: number, gap: number, x0: number, y0: number) {
	const at: Placed[] = []
	let x = 0
	let y = 0
	let rowH = 0
	let w = 0
	for (const sz of sizes) {
		const fw = sz.w * scale
		if (x > 0 && x + fw > maxW) {
			y += rowH + gap
			x = 0
			rowH = 0
		}
		at.push({ x: x0 + x, y: y0 + y, s: scale })
		x += fw + gap
		w = Math.max(w, x - gap)
		rowH = Math.max(rowH, sz.h * scale)
	}
	return { at, w, h: y + rowH }
}

/** A wrap width that gives about `n` rows. */
function widthFor(sizes: { w: number; h: number }[], scale: number, gap: number, n: number) {
	const total = sizes.reduce((t, s) => t + s.w * scale + gap, 0)
	const widest = Math.max(...sizes.map((s) => s.w * scale))
	return Math.max(widest, total / n + widest * 0.35)
}

export type FanKind = 'row' | 'grid' | 'below'

/** Where a parent's children go when its deck is spread: a row or grid beside it, or a grid under it. */
export function fanLayout(kind: FanKind, parent: { w: number; h: number }, sizes: { w: number; h: number }[], scale: number, cols: number): FanLayout {
	const gap = 48
	const side = 96
	const parentBox: Rect = { x: 0, y: 0, w: parent.w, h: parent.h }
	if (!sizes.length) return { at: [], box: parentBox }
	if (kind === 'row' || kind === 'grid') {
		const n = kind === 'row' ? 1 : sizes.length <= 2 ? 1 : sizes.length <= 6 ? 2 : 3
		const m = rows(sizes, scale, n === 1 ? Infinity : widthFor(sizes, scale, gap, n), gap, parent.w + side, 0)
		return { at: m.at, box: union(parentBox, { x: parent.w + side, y: 0, w: m.w, h: m.h }) }
	}
	const avg = sizes.reduce((t, s) => t + s.w, 0) / sizes.length
	const m = rows(sizes, scale, Math.max(parent.w, cols * avg * scale + (cols - 1) * gap + 1), gap, 0, parent.h + 72)
	return { at: m.at, box: union(parentBox, { x: 0, y: parent.h + 72, w: m.w, h: m.h }) }
}

export interface FocusLayout {
	at: Placed[]
	/** group headings ("Running", "Done"), relative to the parent's top-left */
	headings: { text: string; x: number; y: number; w: number }[]
	box: Rect
}

/** Focus: the parent at full size on the left, its children at `scale` in rows to the right, running first. */
export function focusLayout(parent: { w: number; h: number }, children: { size: { w: number; h: number }; group: string }[], scale: number, cols: number): FocusLayout {
	const gap = 48
	const x0 = parent.w + 160
	const at: Placed[] = new Array(children.length)
	const headings: FocusLayout['headings'] = []
	const avg = children.length ? children.reduce((t, c) => t + c.size.w, 0) / children.length : 1000
	const maxW = cols * avg * scale + (cols - 1) * gap + 1
	// Groups share a band while they fit side by side (Running · 2 next to Failed · 1), else start a new one.
	let y = 0
	let w = 0
	let bandX = 0
	let bandH = 0
	const groups = [...new Set(children.map((c) => c.group))]
	for (const g of groups) {
		const idx = children.map((c, i) => (c.group === g ? i : -1)).filter((i) => i >= 0)
		const m = rows(
			idx.map((i) => children[i].size),
			scale,
			maxW,
			gap,
			0,
			0,
		)
		if (bandX > 0 && bandX + 96 + m.w > maxW) {
			y += bandH + 96
			bandX = 0
			bandH = 0
		}
		const gx = x0 + (bandX ? bandX + 96 : 0)
		headings.push({ text: `${g} · ${idx.length}`, x: gx, y, w: m.w })
		idx.forEach((i, k) => (at[i] = { x: m.at[k].x + gx, y: m.at[k].y + y + 64, s: m.at[k].s }))
		bandX = (bandX ? bandX + 96 : 0) + m.w
		bandH = Math.max(bandH, 64 + m.h)
		w = Math.max(w, bandX)
	}
	y += bandH + 96
	const box = union({ x: 0, y: 0, w: parent.w, h: parent.h }, { x: x0, y: 0, w, h: Math.max(0, y - 96) })
	return { at, headings, box }
}

export function frameMaxRow(f: Frame) {
	return f.parent ? 1100 : 1600
}
