import type { DotLayer, Region } from '../../render/subagents/dots'
import { blend, clamp01, clumps, loopClumps, lookColor, noise3, smoothstep, wobble, type KidLook, type KidState, type RGB } from '../../render/subagents/field'
import { easeOut } from '../../render/busy/ember'
import { range, select, toggle, type ParamDef, type ParamValues } from '../shared/params'
import { textCell, textCols } from './glyphs'

/*
 * Ways to show a session's subagents in the strip between its title and its frame's content. Each
 * lays its entries out in CSS px (a constant size on screen, like the Ember band's dots: `measure`)
 * and paints dots for them on the shared grid (`paint`); the DOM text and hit areas come from the
 * same entries (see lists.ts). Sizes never depend on state, so a subagent changing state never moves
 * anything: only its dots change, through smooth fields.
 */

export type RepId = 'rims' | 'cells' | 'strip' | 'spark' | 'glyphs' | 'tree' | 'waffle' | 'pills'

export interface KidView {
	id: string
	title: string
	agent: string
	task: string
	/** 1-based, in the order the session started them */
	index: number
	rgb: RGB
	seed: number
	state: KidState
	look: KidLook
	/** how busy it was (0..1) `ago` s before now (before it finished, once it has) */
	activity: (ago: number) => number
	/** s its current (or last) run has taken */
	ran: number
	/** s since its state last changed */
	sinceChange: number
	/** "1m 04s", "failed"… */
	elapsed: string
}

export interface Rect {
	x: number
	y: number
	w: number
	h: number
}

export interface Text extends Rect {
	/** a subagent's name: its agent (muted), then its task */
	agent?: string
	task?: string
	text?: string
	cls?: string
	align?: 'left' | 'right' | 'center'
}

export interface Entry {
	/** a subagent's id, MORE (the +N / show less entry) or a SUMMARY_ part */
	id: string
	/** list-local CSS px: its hit area, and what glides when the list reflows */
	rect: Rect
	/** its dot region, relative to rect */
	dots: Rect | null
	texts: Text[]
	/** a CSS shape drawn behind it */
	cls?: string
}

export interface ListLayout {
	w: number
	h: number
	entries: Entry[]
	/** list-local text that belongs to no entry */
	notes: Text[]
}

export interface MeasureContext {
	/** CSS px per cell, as drawn */
	pitch: number
	/** the +N entry was clicked: show every subagent */
	showAll: boolean
	text: (s: string, weight: 400 | 500 | 600, size?: number) => number
}

export interface PaintContext {
	g: DotLayer
	/** the list's top-left on screen, CSS px */
	x: number
	y: number
	/** each entry's rect as shown now (entries glide when the list reflows) */
	rect: (id: string) => Rect | undefined
	kids: Map<string, KidView>
	p: ParamValues
	/** the whole list's opacity */
	alpha: number
}

export interface Rep {
	id: RepId
	name: string
	note: string
	params: ParamDef[]
	measure(kids: KidView[], width: number, p: ParamValues, c: MeasureContext): ListLayout
	paint(list: ListLayout, c: PaintContext): void
}

export const MORE = '__more'
const PEAK = 0.9
const LABEL_GAP = 5
const speed = (p: ParamValues) => num(p, 'speed', 1)

// ---------- shared measuring ----------

const num = (p: ParamValues, k: string, d: number) => (typeof p[k] === 'number' ? (p[k] as number) : d)
const cellsUp = (px: number, pitch: number) => Math.ceil(px / pitch - 1e-6) * pitch

function labelWidth(k: KidView, c: MeasureContext) {
	return c.text(k.agent, 400) + LABEL_GAP + c.text(k.task, 500)
}

function label(k: KidView, x: number, y: number, w: number, h: number, cls = ''): Text {
	return { x, y, w, h, agent: k.agent, task: k.task, cls }
}

export function summaryText(kids: KidView[]) {
	const n = { running: 0, waiting: 0, failed: 0, done: 0 }
	for (const k of kids) n[k.state]++
	const parts: string[] = []
	if (n.running) parts.push(`${n.running} running`)
	if (n.waiting) parts.push(`${n.waiting} waiting`)
	if (n.failed) parts.push(`${n.failed} failed`)
	if (n.done) parts.push(`${n.done} done`)
	return parts.join(' · ') || 'no subagents'
}

interface Sized {
	id: string
	w: number
}

/**
 * Wrapping rows of equal-height entries; past `rows` rows the rest fold into a "+N" entry at the end
 * of the last row (or, showing all, a "Show less" one after the last entry).
 */
function flow(items: Sized[], width: number, h: number, gap: number, rows: number, c: MeasureContext) {
	const moreW = (label: string) => cellsUp(c.text(label, 500) + 20, c.pitch)
	const placed: (Sized & { x: number; y: number })[] = []
	let x = 0
	let row = 0
	let i = 0
	const limit = c.showAll ? Infinity : rows
	for (; i < items.length; i++) {
		const w = Math.min(items[i].w, width)
		if (x > 0 && x + w > width) {
			row++
			x = 0
		}
		if (row >= limit) break
		placed.push({ ...items[i], w, x, y: row * (h + gap) })
		x += w + gap
	}
	let more: Entry | null = null
	const moreEntry = (text: string, mx: number, my: number, w: number): Entry => ({
		id: MORE,
		rect: { x: mx, y: my, w, h },
		dots: null,
		texts: [{ x: 0, y: 0, w, h, text, cls: 'more', align: 'center' }],
		cls: 'more-chip',
	})
	if (i < items.length) {
		while (true) {
			const text = `+${items.length - placed.length}`
			const mw = moreW(text)
			const last = placed[placed.length - 1]
			if (!last) {
				more = moreEntry(text, 0, 0, mw)
				break
			}
			if (last.x + last.w + gap + mw <= width) {
				more = moreEntry(text, last.x + last.w + gap, last.y, mw)
				break
			}
			placed.pop()
		}
	} else if (c.showAll && rowsNeeded(items, width, gap) > rows) {
		const mw = moreW('Show less')
		const last = placed[placed.length - 1]
		const fits = last && last.x + last.w + gap + mw <= width
		more = moreEntry('Show less', fits ? last.x + last.w + gap : 0, fits ? last.y : (last ? last.y + h + gap : 0), mw)
	}
	const bottom = Math.max(placed.length ? placed[placed.length - 1].y + h : 0, more ? more.rect.y + h : 0)
	return { placed, more, h: bottom }
}

function rowsNeeded(items: Sized[], width: number, gap: number) {
	let x = 0
	let rows = items.length ? 1 : 0
	for (const it of items) {
		const w = Math.min(it.w, width)
		if (x > 0 && x + w > width) {
			rows++
			x = 0
		}
		x += w + gap
	}
	return rows
}

/** Vertical rows: past `rows`, a last row says how many more (or, showing all, offers to show less). */
function stack(kids: KidView[], rows: number, c: MeasureContext) {
	const limit = c.showAll ? kids.length : kids.length > rows ? rows - 1 : rows
	const shown = kids.slice(0, Math.max(0, limit))
	const hidden = kids.length - shown.length
	const more = hidden > 0 ? `+${hidden} more` : c.showAll && kids.length > rows ? 'Show less' : null
	return { shown, more }
}

/** Every subagent's entry with its view and dot region, as shown now. */
function each(list: ListLayout, c: PaintContext, fn: (k: KidView, r: Region, rect: Rect, e: Entry) => void) {
	for (const e of list.entries) {
		const k = c.kids.get(e.id)
		if (!k || !e.dots) continue
		const r = c.rect(e.id) ?? e.rect
		const d = e.dots
		const region = c.g.region(c.x + r.x + d.x, c.y + r.y + d.y, d.w + (r.w - e.rect.w), d.h + (r.h - e.rect.h), false)
		if (region.visible) fn(k, region, r, e)
	}
}

const hoverLift = (v: number, look: KidLook) => v * (1 + 0.35 * look.hover)

/** Cells clockwise round a cols × rows ring from its top-left corner. */
function ringArc(x: number, y: number, cols: number, rows: number) {
	if (y === 0) return x
	if (x === cols - 1) return cols - 1 + y
	if (y === rows - 1) return cols - 1 + rows - 1 + (cols - 1 - x)
	return 2 * (cols - 1) + rows - 1 + (rows - 1 - y)
}

// ---------- 1. Ember rims ----------

const rims: Rep = {
	id: 'rims',
	name: 'Ember rims',
	note: 'Each subagent is a chip with a miniature of the frame’s own busy band crawling round its rim; done settles into a calm dotted outline, failed turns it red, waiting breathes.',
	params: [
		range('speed', 'Speed', 1, 0, 3, 0.05, '×'),
		range('crawl', 'Crawl', 9, 0, 30, 0.5, 'px/s'),
		range('depth', 'Rim depth', 1, 1, 2, 1, 'cells'),
		range('rows', 'Rows before +N', 2, 1, 6, 1),
		range('maxw', 'Name width', 200, 80, 320, 4, 'px'),
		select('done', 'Done', ['outline', 'faint', 'none'], 'outline'),
	],
	measure(kids, width, p, c) {
		const h = 6 * c.pitch
		const items = kids.map((k) => ({ id: k.id, w: cellsUp(Math.min(labelWidth(k, c), num(p, 'maxw', 200)) + 24, c.pitch) }))
		const f = flow(items, width, h, 2 * c.pitch, num(p, 'rows', 2), c)
		const byId = new Map(kids.map((k) => [k.id, k]))
		const entries: Entry[] = f.placed.map((it) => ({
			id: it.id,
			rect: { x: it.x, y: it.y, w: it.w, h },
			dots: { x: 0, y: 0, w: it.w, h },
			texts: [label(byId.get(it.id)!, 12, 0, it.w - 24, h)],
		}))
		if (f.more) entries.push(f.more)
		return { w: width, h: f.h, entries, notes: [] }
	},
	paint(list, c) {
		const depth = num(c.p, 'depth', 1)
		const crawl = num(c.p, 'crawl', 9)
		const done = c.p.done === 'none' ? 0 : c.p.done === 'faint' ? 0.16 : 0.34
		const pitch = c.g.pitch
		each(list, c, (k, r) => {
			const { cols, rows } = r
			const L = 2 * (cols - 1) + 2 * (rows - 1)
			const look = k.look
			const t = look.clock * speed(c.p)
			const rgb = lookColor(k.rgb, look)
			for (let y = 0; y < rows; y++) {
				for (let x = 0; x < cols; x++) {
					const ring = Math.min(x, y, cols - 1 - x, rows - 1 - y)
					if (ring >= depth) continue
					// rounded corners: the corner cells stay dark
					if ((x === 0 || x === cols - 1) && (y === 0 || y === rows - 1)) continue
					const arc = ringArc(x, y, cols, rows)
					const flow = loopClumps(arc * pitch, L * pitch, t, k.seed, crawl)
					const run = Math.max(flow, 0.18)
					let v = blend(look, run, done, Math.max(0.55, flow), 0.1 + 0.5 * look.breath)
					v = Math.max(v, 0.75 * look.open)
					if (ring > 0) v *= 0.45
					r.set(x, y, hoverLift(v, look) * PEAK * c.alpha, rgb)
				}
			}
		})
	},
}

// ---------- 2. Ember cells ----------

const cells: Rep = {
	id: 'cells',
	name: 'Ember cells',
	note: 'A small dot-matrix square per subagent, before its name, in columns: embers rise through it while it runs, it settles to a solid block when done, crosses out red when it fails, and its ring breathes while it waits.',
	params: [
		range('speed', 'Speed', 1, 0, 3, 0.05, '×'),
		range('size', 'Cell', 4, 3, 6, 1, 'dots'),
		range('rise', 'Rise', 6, 0, 20, 0.5, 'px/s'),
		range('rows', 'Rows before +N', 3, 1, 8, 1),
		range('col', 'Column width', 190, 110, 300, 5, 'px'),
	],
	measure(kids, width, p, c) {
		const k = num(p, 'size', 4)
		const bs = k * c.pitch
		const h = Math.max(bs, 18)
		const colW = Math.min(width, num(p, 'col', 190))
		const gapX = 3 * c.pitch
		const cols = Math.max(1, Math.floor((width + gapX) / (colW + gapX)))
		const rows = num(p, 'rows', 3)
		const limit = c.showAll ? Infinity : rows * cols
		const shown = kids.length > limit ? kids.slice(0, limit - 1) : kids
		const entries: Entry[] = shown.map((kid, i) => {
			const x = (i % cols) * (colW + gapX)
			const y = Math.floor(i / cols) * (h + c.pitch)
			return {
				id: kid.id,
				rect: { x, y, w: colW, h },
				dots: { x: 0, y: (h - bs) / 2, w: bs, h: bs },
				texts: [label(kid, bs + 8, 0, colW - bs - 8, h)],
			}
		})
		const hidden = kids.length - shown.length
		const extra = hidden > 0 ? `+${hidden} more` : c.showAll && kids.length > rows * cols ? 'Show less' : null
		if (extra) {
			const i = shown.length
			const x = (i % cols) * (colW + gapX)
			const y = Math.floor(i / cols) * (h + c.pitch)
			entries.push({ id: MORE, rect: { x, y, w: Math.min(colW, cellsUp(c.text(extra, 500) + 20, c.pitch)), h }, dots: null, texts: [{ x: 0, y: 0, w: colW, h, text: extra, cls: 'more' }] })
		}
		const n = entries.length
		return { w: width, h: n ? Math.ceil(n / cols) * (h + c.pitch) - c.pitch : 0, entries, notes: [] }
	},
	paint(list, c) {
		const rise = num(c.p, 'rise', 6)
		each(list, c, (k, r) => {
			const look = k.look
			const t = look.clock * speed(c.p)
			const rgb = lookColor(k.rgb, look)
			const n = r.cols
			for (let y = 0; y < r.rows; y++) {
				for (let x = 0; x < n; x++) {
					const edge = x === 0 || y === 0 || x === n - 1 || y === r.rows - 1
					const field = clumps(r.cx(x), r.cy(y), t, k.seed, 0, -rise, { scale: 6, sparse: 0.48, dim: 0.35 })
					const run = Math.max(field, edge ? 0.16 : 0.04)
					const cross = x === y || x === n - 1 - y ? 0.9 : 0.1
					const ring = edge ? 0.1 + 0.6 * look.breath : 0.04
					let v = blend(look, run, 0.5, cross, ring)
					if (edge) v = Math.max(v, 0.85 * look.open)
					r.set(x, y, hoverLift(v, look) * PEAK * c.alpha, rgb)
				}
			}
		})
	},
}

// ---------- 3. Segment strip ----------

const strip: Rep = {
	id: 'strip',
	name: 'Segment strip',
	note: 'One shared dot strip the width of the frame; each subagent owns a segment. Running segments flow, done ones fill in, failed ones go red, waiting ones breathe. Names sit under wide segments, or a summary under narrow ones.',
	params: [
		range('speed', 'Speed', 1, 0, 3, 0.05, '×'),
		range('rows', 'Strip height', 3, 2, 6, 1, 'dots'),
		range('crawl', 'Flow', 12, 0, 40, 0.5, 'px/s'),
		range('min', 'Narrowest segment', 3, 2, 10, 1, 'dots'),
		range('labelAt', 'Names from', 70, 40, 160, 2, 'px'),
	],
	measure(kids, width, p, c) {
		const R = num(p, 'rows', 3)
		const sh = R * c.pitch
		const total = Math.floor(width / c.pitch + 1e-6)
		const minSeg = num(p, 'min', 3)
		const n = kids.length
		const perLine = Math.max(1, Math.min(n, Math.floor((total + 1) / (minSeg + 1))))
		const lines = Math.ceil(n / perLine)
		const segFor = (count: number) => (total - (count - 1)) / count
		const named = segFor(perLine) * c.pitch >= num(p, 'labelAt', 70)
		const labelH = named ? 18 : 0
		const lineH = sh + labelH + (named ? 4 : 2 * c.pitch)
		const entries: Entry[] = []
		for (let l = 0; l < lines; l++) {
			const slice = kids.slice(l * perLine, (l + 1) * perLine)
			const seg = segFor(perLine)
			let x = 0
			slice.forEach((k, i) => {
				const end = Math.round((i + 1) * (seg + 1) - 1)
				const w = (end - Math.round(x)) * c.pitch
				const x0 = Math.round(x) * c.pitch
				const texts: Text[] = named ? [label(k, 0, sh + 4, w, 16, 'small')] : []
				entries.push({ id: k.id, rect: { x: x0, y: l * lineH, w, h: sh + labelH }, dots: { x: 0, y: 0, w, h: sh }, texts })
				x = end + 1
			})
		}
		const notes: Text[] = named ? [] : [{ x: 0, y: lines * lineH - 2 * c.pitch + 5, w: width, h: 16, text: summaryText(kids), cls: 'note' }]
		const h = named ? lines * lineH - 4 : lines * lineH - 2 * c.pitch + 21
		return { w: width, h: n ? h : 0, entries, notes }
	},
	paint(list, c) {
		const crawl = num(c.p, 'crawl', 12)
		each(list, c, (k, r) => {
			const look = k.look
			const t = look.clock * speed(c.p)
			const rgb = lookColor(k.rgb, look)
			for (let y = 0; y < r.rows; y++) {
				for (let x = 0; x < r.cols; x++) {
					const field = clumps(r.cx(x) + k.seed * 40, r.cy(y), t, k.seed, crawl, 0, { scale: 8, sparse: 0.5, dim: 0.35 })
					let v = blend(look, Math.max(field, 0.12), 0.45, 0.65, 0.08 + 0.45 * look.breath)
					if (y === 0) v = Math.max(v, 0.95 * look.open)
					r.set(x, y, hoverLift(v, look) * PEAK * c.alpha, rgb)
				}
			}
		})
	},
}

// ---------- 4. Sparklines ----------

const spark: Rep = {
	id: 'spark',
	name: 'Sparklines',
	note: 'A row per subagent: its name, then a dot sparkline of how busy it has been, newest at the right, sliding through the grid while it runs; it stops and dims when done, ends in a red column when it fails, and its last dot breathes while it waits.',
	params: [
		range('speed', 'Speed', 1, 0, 3, 0.05, '×'),
		range('window', 'History', 40, 10, 120, 5, 's'),
		range('height', 'Height', 4, 2, 6, 1, 'dots'),
		range('rows', 'Rows before +N', 6, 2, 14, 1),
		toggle('time', 'Elapsed time', true),
	],
	measure(kids, width, p, c) {
		const H = num(p, 'height', 4)
		const h = H * c.pitch
		const gap = c.pitch
		const { shown, more } = stack(kids, num(p, 'rows', 6), c)
		const nameW = Math.min(220, Math.max(90, width * 0.4), Math.max(0, ...shown.map((k) => labelWidth(k, c))))
		const time = !!p.time && width - nameW > 200
		const timeW = time ? 54 : 0
		const x0 = cellsUp(nameW + 12, c.pitch)
		const sw = Math.max(0, Math.floor((width - x0 - timeW) / c.pitch) * c.pitch)
		const entries: Entry[] = shown.map((k, i) => ({
			id: k.id,
			rect: { x: 0, y: i * (h + gap), w: width, h },
			dots: { x: x0, y: 0, w: sw, h },
			texts: [label(k, 0, 0, nameW, h), ...(time ? [{ x: width - timeW, y: 0, w: timeW, h, text: k.elapsed, cls: 'time', align: 'right' as const }] : [])],
		}))
		if (more) entries.push({ id: MORE, rect: { x: 0, y: shown.length * (h + gap), w: Math.min(width, 120), h }, dots: null, texts: [{ x: 0, y: 0, w: 120, h, text: more, cls: 'more' }] })
		return { w: width, h: entries.length ? entries.length * (h + gap) - gap : 0, entries, notes: [] }
	},
	paint(list, c) {
		const W = num(c.p, 'window', 40)
		each(list, c, (k, r) => {
			const look = k.look
			const rgb = lookColor(k.rgb, look)
			const H = r.rows
			const level = blend(look, 0.85, 0.4, 0.55, 0.55, 0.85)
			for (let x = 0; x < r.cols; x++) {
				const a = k.activity(((r.cols - 1 - x) * W) / r.cols)
				const height = a * (H - 1) + (a > 0.02 ? 1 : 0)
				const newest = x === r.cols - 1
				for (let y = 0; y < H; y++) {
					const fromBottom = H - 1 - y
					let v = clamp01(height - fromBottom) * level
					if (fromBottom === 0) v = Math.max(v, 0.12)
					if (newest) {
						v = Math.max(v, look.fail * 0.95, fromBottom <= 1 ? look.wait * (0.15 + 0.7 * look.breath) : 0)
					}
					r.set(x, y, hoverLift(Math.max(v, fromBottom === 0 ? 0.6 * look.open : 0), look) * PEAK * c.alpha, rgb)
				}
			}
		})
	},
}

// ---------- 5. Dot glyphs ----------

const glyphs: Rep = {
	id: 'glyphs',
	name: 'Dot glyphs',
	note: 'A dot-matrix monogram per subagent (agent and task initials, or its number) in a tight grid: embers drift round the letters while it runs, they settle solid when done, go red when it fails, and turn into a breathing “?” while it waits. Names on hover; running ones are listed underneath.',
	params: [
		range('speed', 'Speed', 1, 0, 3, 0.05, '×'),
		select('glyph', 'Glyph', ['initials', 'number'], 'initials'),
		range('rows', 'Rows before +N', 2, 1, 6, 1),
		toggle('caption', 'Running names', true),
	],
	measure(kids, width, p, c) {
		const gw = 9 * c.pitch
		const gh = 7 * c.pitch
		const f = flow(
			kids.map((k) => ({ id: k.id, w: gw })),
			width,
			gh,
			c.pitch,
			num(p, 'rows', 2),
			c,
		)
		const entries: Entry[] = f.placed.map((it) => ({ id: it.id, rect: { x: it.x, y: it.y, w: gw, h: gh }, dots: { x: 0, y: 0, w: gw, h: gh }, texts: [] }))
		if (f.more) entries.push({ ...f.more, rect: { ...f.more.rect, h: gh }, texts: f.more.texts.map((t) => ({ ...t, h: gh })) })
		const running = kids.filter((k) => k.state === 'running' || k.state === 'waiting')
		const notes: Text[] = []
		let h = f.h
		if (p.caption && running.length) {
			notes.push({ x: 0, y: h + 6, w: width, h: 16, text: running.map((k) => `${k.state === 'waiting' ? '? ' : ''}${k.task}`).join(' · '), cls: 'note' })
			h += 22
		}
		return { w: width, h, entries, notes }
	},
	paint(list, c) {
		each(list, c, (k, r) => {
			const look = k.look
			const t = look.clock * speed(c.p)
			const rgb = lookColor(k.rgb, look)
			const text = c.p.glyph === 'number' ? String(k.index) : `${k.agent[0] ?? ''}${k.task[0] ?? ''}`.toUpperCase()
			const tc = textCols(text)
			const x0 = Math.floor((r.cols - tc) / 2)
			const q0 = Math.floor((r.cols - 3) / 2)
			for (let y = 0; y < r.rows; y++) {
				for (let x = 0; x < r.cols; x++) {
					const letter = textCell(text, x - x0, y - 1)
					const ask = textCell('?', x - q0, y - 1)
					const border = x === 0 || y === 0 || x === r.cols - 1 || y === r.rows - 1
					const shimmer = 0.72 + 0.28 * wobble(t * 1.4 + x * 0.37 + y * 0.53, k.seed)
					// embers only round the tile's edge (a little busy band of its own), so the letters stay clean
					const halo = border ? loopClumps(ringArc(x, y, r.cols, r.rows) * c.g.pitch, (2 * (r.cols + r.rows) - 4) * c.g.pitch, t, k.seed, 8) * 0.7 : 0
					const on = letter ? blend(look, shimmer, 0.62, 0.92, 0, 1) : 0
					const off = letter ? 0 : look.run * halo
					const q = ask ? look.wait * (0.25 + 0.75 * look.breath) : 0
					let v = Math.max(on * (1 - look.wait), off, q)
					if (border) v = Math.max(v, 0.6 * look.open)
					r.set(x, y, hoverLift(v, look) * PEAK * c.alpha, rgb)
				}
			}
		})
	},
}

// ---------- 6. Dot tree ----------

const tree: Rep = {
	id: 'tree',
	name: 'Dot tree',
	note: 'A compact list hanging off a dotted rail, so it reads as the session’s children: embers flow down the rail and out along a running subagent’s branch, a done branch rests dim, a failed one turns red, a waiting one breathes. Elapsed time on the right.',
	params: [
		range('speed', 'Speed', 1, 0, 3, 0.05, '×'),
		range('flow', 'Flow', 14, 0, 40, 0.5, 'px/s'),
		range('rows', 'Rows before +N', 7, 2, 14, 1),
		toggle('time', 'Elapsed time', true),
	],
	measure(kids, width, p, c) {
		const h = 4 * c.pitch
		const pitchY = 5 * c.pitch
		const rail = 4 * c.pitch
		const { shown, more } = stack(kids, num(p, 'rows', 7), c)
		const time = !!p.time && width > 260
		const timeW = time ? 54 : 0
		const entries: Entry[] = shown.map((k, i) => ({
			id: k.id,
			rect: { x: 0, y: i * pitchY, w: width, h },
			// the rail and this row's branch: the column from the top of the list down to its row
			dots: { x: 0, y: -i * pitchY, w: rail, h: i * pitchY + h },
			texts: [label(k, rail + 6, 0, width - rail - 6 - timeW, h), ...(time ? [{ x: width - timeW, y: 0, w: timeW, h, text: k.elapsed, cls: 'time', align: 'right' as const }] : [])],
		}))
		if (more) entries.push({ id: MORE, rect: { x: rail + 6, y: shown.length * pitchY, w: Math.min(width - rail - 6, 120), h }, dots: null, texts: [{ x: 0, y: 0, w: 120, h, text: more, cls: 'more' }] })
		return { w: width, h: entries.length ? (entries.length - 1) * pitchY + h : 0, entries, notes: [] }
	},
	paint(list, c) {
		const flowSpeed = num(c.p, 'flow', 14)
		const pitch = c.g.pitch
		// Later rows paint the rail over earlier ones: draw from the last row up, keeping each cell's brightest.
		const best = new Map<string, { v: number; rgb: RGB; r: Region; x: number; y: number }>()
		each(list, c, (k, r) => {
			const look = k.look
			const t = look.clock * speed(c.p)
			const rgb = lookColor(k.rgb, look)
			const branch = r.rows - 2 // the middle of this row's 4 cells, level with its text
			for (let y = 0; y <= branch; y++) {
				for (let x = 0; x < Math.min(r.cols, 4); x++) {
					const trunk = x === 0 && y < branch
					const arm = y === branch && x <= 3
					if (!trunk && !arm) continue
					const s = (y + x) * pitch
					const field = clumps(s, k.seed * 30, t, k.seed, flowSpeed, 0, { scale: 6, sparse: 0.5, dim: 0.35 })
					let v = trunk ? look.run * field * 0.8 : blend(look, Math.max(field, 0.24), 0.3, 0.62, 0.12 + 0.5 * look.breath)
					if (arm) v = Math.max(v, 0.85 * look.open)
					v = hoverLift(Math.max(v, trunk ? 0.2 : 0), look)
					const key = `${r.ox + x * c.g.pd},${r.oy + y * c.g.pd}`
					const prev = best.get(key)
					if (!prev || v > prev.v) best.set(key, { v, rgb, r, x, y })
				}
			}
		})
		for (const b of best.values()) b.r.set(b.x, b.y, b.v * PEAK * c.alpha, b.rgb)
	},
}

// ---------- 7. Waffle ----------

const waffle: Rep = {
	id: 'waffle',
	name: 'Waffle',
	note: 'The densest: a tiny dot tile per subagent in a tight grid beside a one-line summary, so even dozens fit in one line. Running tiles shimmer, done ones are solid, failed ones red, waiting ones breathe; names on hover.',
	params: [
		range('speed', 'Speed', 1, 0, 3, 0.05, '×'),
		range('tile', 'Tile', 2, 1, 4, 1, 'dots'),
		toggle('text', 'Summary', true),
	],
	measure(kids, width, p, c) {
		const T = num(p, 'tile', 2)
		const ts = T * c.pitch
		const step = ts + c.pitch
		const summary = p.text ? summaryText(kids) : ''
		const textW = summary ? c.text(summary, 500) + 14 : 0
		const fitsBeside = (w: number) => width - w >= textW
		let perRow = Math.max(1, Math.floor((width + c.pitch) / step))
		const oneRow = kids.length * step - c.pitch
		const beside = summary && fitsBeside(Math.min(oneRow, perRow * step)) && oneRow + textW <= width
		if (!beside && summary && kids.length * step - c.pitch + textW > width) perRow = Math.max(1, Math.floor((width + c.pitch) / step))
		const rows = Math.ceil(kids.length / perRow)
		const rowH = Math.max(ts, beside ? 16 : ts)
		const entries: Entry[] = kids.map((k, i) => ({
			id: k.id,
			rect: { x: (i % perRow) * step, y: Math.floor(i / perRow) * step + (rowH - ts) / 2, w: ts, h: ts },
			dots: { x: 0, y: 0, w: ts, h: ts },
			texts: [],
		}))
		const blockH = rows ? (rows - 1) * step + rowH : 0
		const notes: Text[] = []
		let h = blockH
		if (summary && beside) notes.push({ x: Math.min(oneRow, perRow * step) + 10, y: (rowH - 16) / 2, w: textW, h: 16, text: summary, cls: 'note' })
		else if (summary) {
			notes.push({ x: 0, y: blockH + 6, w: width, h: 16, text: summary, cls: 'note' })
			h += 22
		}
		return { w: width, h, entries, notes }
	},
	paint(list, c) {
		each(list, c, (k, r) => {
			const look = k.look
			const t = look.clock * speed(c.p)
			const rgb = lookColor(k.rgb, look)
			for (let y = 0; y < r.rows; y++) {
				for (let x = 0; x < r.cols; x++) {
					const shimmer = 0.3 + 0.7 * smoothstep(0.25, 0.75, noise3(x * 0.9 + k.seed * 3.1, y * 0.9 + k.seed, t * 1.3))
					const v = blend(look, shimmer, 0.5, 0.88, 0.12 + 0.6 * look.breath)
					r.set(x, y, hoverLift(Math.max(v, 0.95 * look.open), look) * PEAK * c.alpha, rgb)
				}
			}
		})
	},
}

// ---------- 8. Progress pills ----------

const pills: Rep = {
	id: 'pills',
	name: 'Progress pills',
	note: 'A pill per subagent with a dotted progress line along its bottom: it creeps on while the subagent runs (subagents don’t report progress, so it eases toward the end and never gets there), an ember front flowing at its edge; done fills it, failed stops it in red, waiting holds it with the front breathing.',
	params: [
		range('speed', 'Speed', 1, 0, 3, 0.05, '×'),
		range('tau', 'Typical run', 90, 20, 600, 10, 's'),
		range('front', 'Front', 3, 1, 6, 1, 'dots'),
		range('rows', 'Rows before +N', 2, 1, 6, 1),
		range('maxw', 'Name width', 190, 80, 320, 4, 'px'),
	],
	measure(kids, width, p, c) {
		const h = 6 * c.pitch
		const items = kids.map((k) => ({ id: k.id, w: cellsUp(Math.min(labelWidth(k, c), num(p, 'maxw', 190)) + 28, c.pitch) }))
		const f = flow(items, width, h, 2 * c.pitch, num(p, 'rows', 2), c)
		const byId = new Map(kids.map((k) => [k.id, k]))
		const entries: Entry[] = f.placed.map((it) => ({
			id: it.id,
			rect: { x: it.x, y: it.y, w: it.w, h },
			dots: { x: c.pitch, y: h - c.pitch, w: it.w - 2 * c.pitch, h: c.pitch },
			texts: [label(byId.get(it.id)!, 14, -2, it.w - 28, h)],
			cls: 'pill',
		}))
		if (f.more) entries.push(f.more)
		return { w: width, h: f.h, entries, notes: [] }
	},
	paint(list, c) {
		const frontW = num(c.p, 'front', 3)
		each(list, c, (k, r) => {
			const look = k.look
			const t = look.clock * speed(c.p)
			const rgb = lookColor(k.rgb, look)
			const n = r.cols
			// Subagents don't report progress: ease toward the end over a typical run, and fill up when done.
			const ran = 1 - Math.exp(-k.ran / num(c.p, 'tau', 90))
			const progress = k.state === 'done' ? ran + (1 - ran) * easeOut(clamp01(k.sinceChange / 0.6)) : ran
			const reach = progress * n
			for (let x = 0; x < n; x++) {
				const filled = clamp01(reach - x)
				const toFront = reach - (x + 0.5)
				const front = toFront >= 0 && toFront < frontW ? 1 - toFront / frontW : 0
				const flow = clumps(r.cx(x), 0, t, k.seed, -10, 0, { scale: 5, sparse: 0.45, dim: 0.4 })
				const base = 0.08 + 0.36 * filled
				const run = Math.max(base, front * (0.45 + 0.55 * flow))
				const wait = Math.max(base, front * (0.2 + 0.7 * look.breath))
				const v = blend(look, run, 0.5, Math.max(0.1, 0.72 * filled), wait)
				r.set(x, 0, hoverLift(Math.max(v, 0.85 * look.open * (filled > 0 ? 1 : 0.4)), look) * PEAK * c.alpha, rgb)
			}
		})
	},
}

export const REPS: Rep[] = [rims, cells, strip, spark, glyphs, tree, waffle, pills]
export const repOf = (id: string) => REPS.find((r) => r.id === id) ?? REPS[0]

// ---------- zoomed out: the summary every representation collapses to ----------

/** A dot per subagent, then "3 running · 5 done" if there's room (and only the dots if not). */
export function measureSummary(kids: KidView[], width: number, c: MeasureContext, text: boolean): ListLayout {
	const step = 2 * c.pitch
	const summary = text ? summaryText(kids) : ''
	const textW = summary ? c.text(summary, 500, 11) + 10 : 0
	const perRow = Math.max(1, Math.floor((width + c.pitch) / step))
	const dotsW = Math.min(kids.length, perRow) * step - c.pitch
	const beside = summary && dotsW + textW <= width
	const rows = Math.ceil(kids.length / perRow)
	const rowH = beside ? 14 : c.pitch
	const entries: Entry[] = kids.map((k, i) => ({
		id: k.id,
		rect: { x: (i % perRow) * step, y: Math.floor(i / perRow) * step + (rowH - c.pitch) / 2, w: c.pitch, h: c.pitch },
		dots: { x: 0, y: 0, w: c.pitch, h: c.pitch },
		texts: [],
	}))
	const notes: Text[] = []
	let h = rows ? (rows - 1) * step + rowH : 0
	if (beside) notes.push({ x: dotsW + 8, y: (rowH - 14) / 2, w: textW, h: 14, text: summary, cls: 'note tiny' })
	else if (summary && textW <= width) {
		notes.push({ x: 0, y: h + 4, w: width, h: 14, text: summary, cls: 'note tiny' })
		h += 18
	}
	return { w: width, h, entries, notes }
}

export function paintSummary(list: ListLayout, c: PaintContext) {
	each(list, c, (k, r) => {
		const look = k.look
		const flicker = 0.45 + 0.55 * smoothstep(0.3, 0.8, noise3(k.seed * 7.3, look.clock * 1.3, 0.5))
		const v = blend(look, flicker, 0.5, 0.92, 0.2 + 0.6 * look.breath)
		r.set(0, 0, hoverLift(Math.max(v, look.open), look) * PEAK * c.alpha, lookColor(k.rgb, look))
	})
}
