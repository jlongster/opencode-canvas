import { Box } from '../../editor/geometry'
import { LAYOUT, type GroupLayout, type Layout, type SectionLayout } from '../../editor/layout'
import { clamp01 } from '../../render/subagents/field'

/*
 * The canvas with detached titles: a post-process of computeLayout. Every session is laid out by the
 * canvas's own rules; then each frame loses its title strip (its content moves up to the padding) and
 * its title goes above it, outside the frame. Subagents (child sessions) are taken out of the row:
 * they only show, as frames of their own, while expanded.
 *
 * An expanded subagent opens at the top of its parent, right under its orb (see Fit): a card whose
 * caret points up at the orb, with its title inside it. Several open side by side in a row under the
 * title (drawers: stacked). "below" is v4's: stacked under the whole parent frame.
 *
 * Titles are a constant size on screen, so their page height depends on the zoom. They sit above the
 * frame, and a frame's content never moves with zoom.
 */

/** Screen px. */
export interface Metrics {
	/** the title's height */
	head: number
	/** between the title and its frame */
	headGap: number
}

/**
 * How an expanded subagent fits with its parent's content:
 * overlay: a raised card over it (nothing moves); push: a card inserted at the top (the content slides
 * down); drawer: a band the width of the frame unfolding from the title row (the content slides down);
 * below: v4, under the whole frame.
 */
export type Fit = 'overlay' | 'push' | 'drawer' | 'below'

export interface PlanKid {
	id: string
	/** 0..1, eased */
	open: number
	/** where it's heading: opening (1) or closing (0) */
	to: number
	/** the subagent it replaced (a click on its orb while that one was open): it takes over that one's card */
	from?: string
}

export interface PlanInput {
	natural: Layout
	/** each parent's subagents, in order */
	families: Map<string, PlanKid[]>
	/** every subagent session (none of them sit in the row) */
	childIds: ReadonlySet<string>
	zoom: number
	/** expanded subagents' frames at this scale */
	childScale: number
	m: Metrics
	fit: Fit
	/** a subagent's orb: screen px from its parent's title's left (null: not drawn yet) */
	anchor: (parentId: string, kidId: string) => number | null
	/** where cards were last laid out while open, and their size (so one closing shrinks where it was); updated */
	memo: Map<string, { dx: number; dy: number; w: number; h: number }>
	/** switching: the card morphs from one subagent to the next (else one shrinks as the other grows) */
	morph: boolean
}

export interface HeadPlan {
	id: string
	/** set for an expanded subagent */
	parentId: string | null
	/** page: the title's top-left and width (its height is m.head / zoom) */
	box: Box
	/** the frame under it (a card: the card it's in) */
	frame: Box
	opacity: number
	/** inside its card (it gets a close button), not above its frame */
	inCard: boolean
}

/** An expanded subagent opened under its orb. */
export interface CardPlan {
	id: string
	parentId: string
	/** page */
	box: Box
	/** page x of its orb */
	orbX: number
	opacity: number
	/** 0..1: the raised card's shadow, as drawn */
	shadow: number
	/** 0..1: the caret and wire (alpha, and the caret's size) */
	caret: number
	/** the open state, eased (0..1) */
	open: number
	fit: Fit
}

export interface Plan {
	layout: Layout
	heads: HeadPlan[]
	cards: CardPlan[]
	zoom: number
}

/** Page px between stacked frames (a subagent under its parent or the one before), besides the title. */
const STACK_GAP = 72
/** Screen px: the card's top below its parent frame's top edge (the caret spans the title gap and this) */
const CARD_TOP = 12
/** Screen px: the orb sits this far in from the card's left edge, when there's room */
const CARET_INSET = 30
/** Screen px: between cards side by side (and drawers stacked) */
const CARD_GAP = 14
/** Screen px: the card's title, from its top, and where its content starts */
const CARD_TITLE_Y = 8
const CARD_CONTENT_Y = 40

const SHADOW: Record<Fit, number> = { overlay: 1, push: 0.55, drawer: 0.35, below: 0 }

export function plan(inp: PlanInput): Plan {
	const { natural, zoom: z, m } = inp
	const L = LAYOUT
	const strip = L.frameHeaderHeight
	const out: Layout = { sections: [], groups: [], items: new Map(), sectionOf: natural.sectionOf, groupOf: natural.groupOf, bounds: null }
	const heads: HeadPlan[] = []
	const cards: CardPlan[] = []
	const byId = new Map(natural.sections.map((s) => [s.id, s]))
	const headSpace = (m.head + m.headGap) / z

	let x = 0
	for (const s of natural.sections) {
		if (inp.childIds.has(s.id)) continue
		const open = (inp.families.get(s.id) ?? []).filter((k) => k.open > 0.0005 && byId.has(k.id))
		const frame: Box = { x, y: 0, w: s.box.w, h: s.box.h - strip }
		const header: Box = { x: frame.x, y: frame.y - headSpace, w: frame.w, h: m.head / z }
		heads.push({ id: s.id, parentId: null, box: header, frame, opacity: 1, inCard: false })

		if (inp.fit === 'below') {
			const r = below(inp, s, frame, open, out.items, heads)
			const parent = place(natural, s, frame.x, 0, 1, out.items)
			parent.box = frame
			parent.header = header
			out.sections.push(...r.sections, parent)
			x = r.right + L.frameGap
			continue
		}

		const r = atTop(inp, s, frame, open, out.items, heads, cards)
		const parent = place(natural, s, frame.x, frame.y + r.room, 1, out.items)
		parent.box = { ...frame, w: Math.max(frame.w, r.width), h: frame.h + r.room }
		parent.header = header
		const hb = heads.find((h) => h.id === s.id)!
		hb.frame = parent.box
		hb.box = { ...header, w: parent.box.w }
		out.sections.push(...r.sections, parent)
		x = frame.x + Math.max(frame.w, r.reach) + L.frameGap
	}
	out.groups = out.sections.flatMap((s) => s.groups)
	out.bounds = Box.union(out.sections.flatMap((s) => [s.box, s.header]))
	return { layout: out, heads, cards, zoom: z }
}

/** v4: expanded subagents stacked below the whole parent frame. */
function below(inp: PlanInput, s: SectionLayout, frame: Box, open: PlanKid[], items: Map<string, Box>, heads: HeadPlan[]) {
	const { natural, zoom: z, m } = inp
	const strip = LAYOUT.frameHeaderHeight
	const byId = new Map(natural.sections.map((x) => [x.id, x]))
	const headSpace = (m.head + m.headGap) / z
	// A subagent's room opens before it fades in, and it fades out before its room closes (nothing slides over it).
	const room = (k: PlanKid) => clamp01(k.open / 0.5)
	const sections: SectionLayout[] = []
	let right = frame.x + frame.w
	let cursor = frame.y + frame.h
	for (const kid of open) {
		const c = byId.get(kid.id)!
		const h = c.box.h - strip
		const k = inp.childScale
		const fy = cursor + STACK_GAP + headSpace
		cursor += (STACK_GAP + headSpace + h * k) * room(kid)
		right = Math.max(right, frame.x + frame.w + (Math.max(frame.w, c.box.w * k) - frame.w) * room(kid))
		const opacity = clamp01((kid.open - 0.5) / 0.5)
		const child = place(natural, c, frame.x, fy + (1 - opacity) * (12 / z), k * (0.98 + 0.02 * opacity), items)
		child.opacity = opacity
		child.header = { x: child.box.x, y: child.box.y - headSpace, w: child.box.w, h: m.head / z }
		heads.push({ id: c.id, parentId: s.id, box: child.header, frame: child.box, opacity, inCard: false })
		sections.push(child)
	}
	return { sections, right }
}

interface Slot {
	kid: PlanKid
	c: SectionLayout
	/** full size, page */
	w: number
	h: number
	/** content's offset under the card's top */
	dy: number
	left: number
	top: number
	orbX: number
}

/**
 * Expanded subagents at the top of the parent, under their orbs. Cards opening (or open) are packed
 * left to right in row order, each as close under its orb as the ones before it allow; a card
 * closing shrinks where it last was. Returns how far the parent's content moves down
 * (push, drawer), how wide its frame gets, and how far right anything reaches (for the next frame).
 */
function atTop(inp: PlanInput, s: SectionLayout, frame: Box, open: PlanKid[], items: Map<string, Box>, heads: HeadPlan[], cards: CardPlan[]) {
	const { natural, zoom: z, fit } = inp
	const L = LAYOUT
	const strip = L.frameHeaderHeight
	const byId = new Map(natural.sections.map((x) => [x.id, x]))
	const k = inp.childScale
	const inset = Math.min(L.framePadding, CARD_TOP / z)
	const top0 = frame.y + CARD_TOP / z
	const gap = CARD_GAP / z
	const dy = Math.max(0, CARD_CONTENT_Y / z - L.framePadding * k)
	const anchorX = (id: string) => {
		const a = inp.anchor(s.id, id)
		return frame.x + (a ?? 40) / z
	}
	const slots: Slot[] = open.map((kid) => {
		const c = byId.get(kid.id)!
		const w = c.box.w * k
		return { kid, c, w, h: dy + (c.box.h - strip) * k, dy, left: 0, top: top0, orbX: anchorX(kid.id) }
	})
	const mine: { card: CardPlan; section: SectionLayout; to: number }[] = []
	const left0 = frame.x + inset
	const drawer = fit === 'drawer'
	let room = 0
	let width = frame.w

	if (drawer) {
		// bands the width of the frame, stacked in row order, each unfolding from the title row
		const bandW = Math.max(frame.w - inset * 2, ...slots.map((t) => t.w))
		const m = slots.length === 2 && inp.morph ? morphPair(slots) : null
		if (m) {
			// switching: the one band changes height as one subagent's content gives way to the next's
			const e = m.to.kid.open
			const box: Box = { x: left0, y: top0, w: bandW, h: m.from.h + (m.to.h - m.from.h) * e }
			const inA = clamp01((e - 0.1) / 0.5)
			const outA = 1 - clamp01((e - 0.6) / 0.25)
			const fa = Math.min(1, box.h / m.from.h)
			const fb = Math.min(1, box.h / m.to.h)
			const a = place(natural, m.from.c, left0, top0 + m.from.dy * fa, k * fa, items)
			const b = place(natural, m.to.c, left0, top0 + m.to.dy * fb, k * fb, items)
			for (const [sec, op, head] of [[a, outA, 1 - clamp01(e / 0.4)], [b, inA, clamp01((e - 0.5) / 0.5)]] as const) {
				sec.box = box
				sec.header = { x: box.x, y: box.y, w: box.w, h: 0 }
				sec.opacity = op
				heads.push(cardHead(sec.id, s.id, box, k, z, head))
			}
			const orbX = m.from.orbX + (m.to.orbX - m.from.orbX) * e
			mine.push({ card: { id: m.from.c.id, parentId: s.id, box, orbX, opacity: 1, shadow: 0, caret: 0, open: 1, fit }, section: a, to: 0 })
			mine.push({ card: { id: m.to.c.id, parentId: s.id, box, orbX, opacity: 1, shadow: SHADOW.drawer, caret: 1, open: 1, fit }, section: b, to: 1 })
			return { sections: order(mine, cards), room: box.y + box.h - frame.y, width: Math.max(frame.w, bandW + inset * 2), reach: Math.max(frame.w, bandW + inset * 2) }
		}
		let y = top0
		let most = 0
		for (const t of slots) {
			const e = t.kid.open
			const unfold = 1 - (1 - clamp01(e / 0.75)) ** 2
			const opacity = clamp01((e - 0.55) / 0.45)
			const h = t.h * unfold
			const box: Box = { x: left0, y, w: bandW, h }
			const child = place(natural, t.c, left0, y + t.dy, k, items)
			child.box = box
			child.header = { x: box.x, y: box.y, w: box.w, h: 0 }
			child.opacity = opacity
			heads.push(cardHead(t.c.id, s.id, box, k, z, opacity))
			const shown = clamp01(e / 0.25)
			mine.push({ card: { id: t.c.id, parentId: s.id, box, orbX: t.orbX, opacity: shown, shadow: SHADOW.drawer * shown, caret: shown * clamp01((e - 0.1) / 0.4), open: e, fit }, section: child, to: t.kid.to })
			y += (h + gap) * unfold
			most = Math.max(most, unfold)
		}
		room = Math.max(0, y - top0 + (top0 - frame.y - gap) * most)
		width = Math.max(frame.w, bandW + inset * 2)
		return { sections: order(mine, cards), room, width, reach: width }
	}

	// pack the ones opening into one row (the wires to them only cross the gap above it), then back
	// it off the frame's right edge as far as the frame allows; a closing one stays where it was
	const limit = frame.x + frame.w - inset
	const packing = slots.filter((t) => t.kid.to > 0.5)
	let cursor = left0
	for (const t of packing) {
		t.left = Math.max(t.orbX - CARET_INSET / z, cursor)
		cursor = t.left + t.w + gap
	}
	if (packing.length) {
		const last = packing[packing.length - 1]
		const over = last.left + last.w - limit
		const shift = over > 0 ? Math.min(over, packing[0].left - left0) : 0
		for (const t of packing) t.left -= shift
	}
	for (const t of packing) inp.memo.set(t.kid.id, { dx: t.left - frame.x, dy: t.top - frame.y, w: t.w, h: t.h })
	for (const t of slots) {
		if (t.kid.to > 0.5) continue
		const was = inp.memo.get(t.kid.id)
		if (was) {
			t.left = frame.x + was.dx
			t.top = frame.y + was.dy
		} else {
			t.left = Math.max(left0, Math.min(t.orbX - CARET_INSET / z, limit - t.w))
		}
	}

	// switching from one to the next: the card moves and resizes from the old one's place to the new
	// one's, the old content giving way to the new (each scaled to fit while the card is smaller)
	const m = inp.morph && packing.length === 1 ? morphPair(slots) : null
	const was = m && inp.memo.get(m.from.kid.id)
	if (m && was) {
		const e = m.to.kid.open
		const t = m.to
		const L0 = frame.x + was.dx
		const T0 = frame.y + was.dy
		const box: Box = { x: L0 + (t.left - L0) * e, y: T0 + (t.top - T0) * e, w: was.w + (t.w - was.w) * e, h: was.h + (t.h - was.h) * e }
		// the new card fades in over the old (still opaque, so nothing shows through), which then goes
		const inA = clamp01((e - 0.1) / 0.5)
		const outA = 1 - clamp01((e - 0.6) / 0.25)
		const orbX = m.from.orbX + (t.orbX - m.from.orbX) * e
		for (const [u, op, to] of [[m.from, outA, 0], [t, inA, 1]] as const) {
			const f = Math.min(1, box.w / u.w, box.h / u.h)
			const sec = place(natural, u.c, box.x, box.y + u.dy * f, k * f, items)
			sec.box = box
			sec.header = { x: box.x, y: box.y, w: box.w, h: 0 }
			sec.opacity = op
			heads.push(cardHead(u.c.id, s.id, box, k * f, z, to ? clamp01((e - 0.5) / 0.5) : 1 - clamp01(e / 0.4)))
			mine.push({ card: { id: u.c.id, parentId: s.id, box, orbX, opacity: op, shadow: to ? SHADOW[fit] * Math.max(inA, outA) : 0, caret: to, open: 1, fit }, section: sec, to })
		}
		if (fit === 'push') {
			room = box.y - frame.y + box.h
			width = Math.max(frame.w, box.x + box.w + inset - frame.x)
		}
	}

	for (const t of slots) {
		if (m && was && (t === m.from || t === m.to)) continue
		// grows from its orb: about the point under it on the card's top edge
		const g = t.kid.open
		const ox = Math.max(t.left, Math.min(t.left + t.w, t.orbX))
		const bx = ox + (t.left - ox) * g
		const box: Box = { x: bx, y: t.top, w: t.w * g, h: t.h * g }
		const opacity = clamp01(g / 0.35)
		const child = place(natural, t.c, bx, t.top + t.dy * g, k * g, items)
		child.box = box
		child.header = { x: box.x, y: box.y, w: box.w, h: 0 }
		child.opacity = opacity
		heads.push(cardHead(t.c.id, s.id, box, k * g, z, clamp01((g - 0.6) / 0.4)))
		mine.push({ card: { id: t.c.id, parentId: s.id, box, orbX: t.orbX, opacity, shadow: SHADOW[fit] * opacity, caret: opacity * clamp01((g - 0.1) / 0.4), open: g, fit }, section: child, to: t.kid.to })
		if (fit === 'push') {
			room = Math.max(room, (t.top - frame.y + t.h) * g)
			width = Math.max(width, frame.w + (t.left + t.w + inset - frame.x - frame.w) * g)
		}
	}
	return { sections: order(mine, cards), room, width, reach: width }
}

/** A card opening that replaces one closing (see PlanKid.from), if there is one. */
function morphPair(slots: Slot[]) {
	const to = slots.find((t) => t.kid.to > 0.5 && t.kid.from)
	const from = to && slots.find((t) => t.kid.id === to.kid.from && t.kid.to < 0.5)
	return to && from ? { from, to } : null
}

/** The title inside a card, aligned with its content. */
function cardHead(id: string, parentId: string, box: Box, k: number, z: number, opacity: number): HeadPlan {
	const pad = LAYOUT.framePadding * k
	return { id, parentId, box: { x: box.x + pad, y: box.y + CARD_TITLE_Y / z, w: Math.max(0, box.w - pad * 2), h: 24 / z }, frame: box, opacity, inCard: true }
}

/**
 * Cards in drawing order, back to front: closing ones under the ones opening. Sections are hit
 * tested in order, so they go front to back.
 */
function order(mine: { card: CardPlan; section: SectionLayout; to: number }[], cards: CardPlan[]) {
	const sorted = mine.map((m, i) => ({ ...m, i })).sort((a, b) => a.to - b.to || a.i - b.i)
	cards.push(...sorted.map((m) => m.card))
	return sorted.map((m) => m.section).reverse()
}

/** A section without its title strip, its frame's top-left at (x, y), scaled by k about that corner. Its items go into `items`. */
function place(natural: Layout, s: SectionLayout, x: number, y: number, k: number, items: Map<string, Box>): SectionLayout {
	const strip = LAYOUT.frameHeaderHeight
	const t = (b: Box): Box => ({ x: x + (b.x - s.box.x) * k, y: y + (b.y - s.box.y - strip) * k, w: b.w * k, h: b.h * k })
	for (const id of s.itemIds) {
		const b = natural.items.get(id)
		if (b) items.set(id, t(b))
	}
	const groups: GroupLayout[] = s.groups.map((g) => ({ ...g, box: t(g.box), heading: g.heading && t(g.heading) }))
	return {
		...s,
		box: { x, y, w: s.box.w * k, h: (s.box.h - strip) * k },
		header: { x, y, w: s.box.w * k, h: 0 },
		groups,
		more: s.more && { ...s.more, box: t(s.more.box) },
	}
}
