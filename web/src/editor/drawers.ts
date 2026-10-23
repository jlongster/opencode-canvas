import type { Session } from '../../../shared/types'
import { bezier } from '../render/busy/envelope'
import { clamp01 } from '../render/subagents/field'
import { atom } from '../state/signals'
import { Box } from './geometry'
import { LAYOUT, type GroupLayout, type Layout, type SectionLayout } from './layout'

/*
 * Subagents on the canvas. A frame whose session is a subagent (its OpenCode session has a parent)
 * of another frame on the canvas isn't a frame of its own: it's an orb on its parent's title row
 * (see render/subagents/titleOrbs.ts), and opens in a drawer: a band the width of the parent's frame
 * that unfolds from under its title row, holding the subagent's frame (its items, laid out as
 * usual), while the parent's own content moves down. Several drawers stack, in the row's order.
 * Opening another in place of the one open morphs: the band changes height while the content
 * crossfades.
 *
 * Which drawers are open is this viewer's own (not shared), remembered per canvas.
 */

/** A session's subagents on the canvas: each subagent's top-level parent frame, and each parent's subagents in the order they started. */
export interface Families {
	parentOf: ReadonlyMap<string, string>
	kids: ReadonlyMap<string, readonly string[]>
}

const MAX_DEPTH = 8

/**
 * Who's whose subagent: a frame whose session's parent (from OpenCode: mirrored on the canvas, or
 * known to this tab) is a shown frame here belongs to it; a subagent of a subagent belongs to the
 * top-most one shown. `known`: parents this tab's paired OpenCode knows, of sessions without a frame
 * too (so a grandchild finds its way past a parent that has none).
 */
export function subagentFamilies(sessions: Record<string, Session>, known: Readonly<Record<string, string>>): Families {
	const parentOf = new Map<string, string>()
	const kids = new Map<string, string[]>()
	const parentIdOf = (id: string) => sessions[id]?.opencode?.parentId || known[id] || undefined
	for (const s of Object.values(sessions)) {
		if (s.hidden) continue
		let root: string | null = null
		let at = parentIdOf(s.id)
		for (let i = 0; at && i < MAX_DEPTH && at !== s.id; i++) {
			const frame = sessions[at]
			if (frame && !frame.hidden) root = at
			at = parentIdOf(at)
		}
		if (!root) continue
		parentOf.set(s.id, root)
	}
	// (a parent that's itself someone's subagent hands its own on: they're all under the top one)
	const startedAt = (id: string) => sessions[id]?.opencode?.createdAt ?? sessions[id]?.createdAt ?? 0
	for (const [id, parent] of parentOf) {
		let list = kids.get(parent)
		if (!list) kids.set(parent, (list = []))
		list.push(id)
	}
	for (const list of kids.values()) list.sort((a, b) => startedAt(a) - startedAt(b) || a.localeCompare(b))
	return { parentOf, kids }
}

export function familiesEqual(a: Families, b: Families) {
	if (a.parentOf.size !== b.parentOf.size || a.kids.size !== b.kids.size) return false
	for (const [id, list] of a.kids) {
		const other = b.kids.get(id)
		if (!other || other.length !== list.length || list.some((k, i) => other[i] !== k)) return false
	}
	return true
}

// ---------- open and closed ----------

/** How long a drawer takes to open or close (ms), and its easing: restrained, no overshoot. */
export const DRAWER_MS = 360
const ease = bezier(0.4, 0, 0.2, 1)

interface Open {
	from: number
	to: number
	start: number
	/** the subagent whose drawer this one took over (its band morphs into this one's) */
	replaced?: string
}

/** A subagent's drawer this frame. */
export interface DrawerKid {
	id: string
	/** 0..1, eased */
	open: number
	/** where it's heading: opening (1) or closing (0) */
	to: number
	/** the drawer it took over, while it morphs from it */
	from?: string
}

const STORAGE = 'canvas.drawers.'

/**
 * Which subagents' drawers are open, as this viewer opened them, and how far each is open each frame
 * (step() eases them; `frame` is what the layout reads).
 */
export class Drawers {
	/** each drawer opening, open or closing, by subagent id, this frame */
	readonly frame = atom<ReadonlyMap<string, DrawerKid>>('drawers', new Map())
	private opens = new Map<string, Open>()
	private key: string | null = null
	private dirty = false

	/** Remembers what's open on this canvas from now on, and opens what was open on it last time. */
	load(canvasId: string) {
		this.key = STORAGE + canvasId
		let ids: unknown = []
		try {
			ids = JSON.parse(localStorage.getItem(this.key) ?? '[]')
		} catch {}
		if (!Array.isArray(ids)) return
		for (const id of ids) if (typeof id === 'string') this.opens.set(id, { from: 1, to: 1, start: 0 })
		this.dirty = true
		this.step(performance.now())
	}

	isOpen(id: string) {
		return (this.opens.get(id)?.to ?? 0) > 0.5
	}

	/** The open ones (or opening). */
	openIds() {
		return [...this.opens].filter(([, o]) => o.to > 0.5).map(([id]) => id)
	}

	/** Opens or closes a subagent's drawer: eased, or straight away (`instant`). */
	set(id: string, on: boolean, opts: { instant?: boolean; replaced?: string } = {}) {
		const now = performance.now()
		if (opts.instant) {
			if (on) this.opens.set(id, { from: 1, to: 1, start: 0 })
			else this.opens.delete(id)
		} else {
			if (this.isOpen(id) === on && this.opens.has(id) === on) return
			this.opens.set(id, { from: this.at(id, now), to: on ? 1 : 0, start: now, ...(opts.replaced ? { replaced: opts.replaced } : {}) })
		}
		this.dirty = true
		this.save()
	}

	/**
	 * A click on a subagent's orb: opens its drawer, closing the others of its parent (so clicking
	 * along the row switches between them: one band morphing), or closes it if it's open. `additive`
	 * (shift) keeps the others open.
	 */
	toggle(id: string, siblings: readonly string[], additive: boolean) {
		const on = !this.isOpen(id)
		const closing = on && !additive ? siblings.filter((k) => k !== id && this.isOpen(k)) : []
		for (const k of closing) this.set(k, false)
		this.set(id, on, { replaced: closing.length === 1 ? closing[0] : undefined })
	}

	/** Closes every drawer (or every one of these subagents'). */
	closeAll(ids?: readonly string[]) {
		for (const id of ids ?? this.openIds()) this.set(id, false)
	}

	/** Whether any drawer is still opening or closing. */
	get animating() {
		const now = performance.now()
		for (const o of this.opens.values()) if (now - o.start < DRAWER_MS) return true
		return false
	}

	/** Eases the drawers to `now` (ms), for the layout. */
	step(now: number) {
		let moving = this.dirty
		this.dirty = false
		const prev = this.frame.peek()
		const next = new Map<string, DrawerKid>()
		for (const [id, o] of this.opens) {
			const open = this.at(id, now)
			if (open !== prev.get(id)?.open) moving = true
			if (o.to === 0 && open <= 0) {
				this.opens.delete(id)
				moving = true
				continue
			}
			const from = o.replaced && this.opens.get(o.replaced)?.to === 0 && open < 1 ? o.replaced : undefined
			next.set(id, { id, open, to: o.to, ...(from ? { from } : {}) })
		}
		if (moving) this.frame.set(next)
	}

	private at(id: string, now: number) {
		const o = this.opens.get(id)
		if (!o) return 0
		const p = clamp01((now - o.start) / DRAWER_MS)
		return o.from + (o.to - o.from) * ease(p)
	}

	private save() {
		if (!this.key) return
		try {
			const ids = this.openIds()
			if (ids.length) localStorage.setItem(this.key, JSON.stringify(ids))
			else localStorage.removeItem(this.key)
		} catch {}
	}
}

// ---------- the layout ----------

/** Page px: a drawer's band starts this far below its parent's title row's top... */
const BAND_TOP = 64
/** ...stacked bands are this far apart, and the parent's content follows the last one this far below */
const BAND_GAP = 20
const CONTENT_GAP = LAYOUT.framePadding
/** in a band: the subagent's title strip (its frame's is frameHeaderHeight), from the band's top */
export const DRAWER_TITLE = { top: 16, h: 48 }
/** how much higher a subagent's content sits in its band than in a frame of its own */
const LIFT = LAYOUT.frameHeaderHeight + LAYOUT.framePadding - (DRAWER_TITLE.top + DRAWER_TITLE.h + 16)

/**
 * The canvas with its subagents' drawers open: each parent with open drawers gets their bands under
 * its title row (its content moved down, its frame widened if a band is wider), and the frames to its
 * right make room. Subagents' frames come before their parent's in `sections`, as hit testing goes
 * front to back. `kids`: every subagent laid out as a frame of its own (where, doesn't matter).
 */
export function applyDrawers(base: Layout, kids: Layout, families: Families, drawers: ReadonlyMap<string, DrawerKid>): Layout {
	if (!drawers.size) return base
	const kidSections = new Map(kids.sections.map((s) => [s.id, s]))
	const out: Layout = { sections: [], groups: [], items: new Map(base.items), sectionOf: new Map(base.sectionOf), groupOf: new Map(base.groupOf), bounds: null }
	let shiftX = 0
	let changed = false
	/** a frame to the left is opening or closing a drawer: the frames it moves move with it, without easing */
	let pushing = false
	for (const s of base.sections) {
		const open = (families.kids.get(s.id) ?? []).map((id) => drawers.get(id)).filter((k): k is DrawerKid => !!k && k.open > 0.0005 && kidSections.has(k.id))
		if (!open.length) {
			out.sections.push(shiftX ? { ...shift(s, shiftX, 0, out.items), ...(pushing ? { snap: true } : {}) } : s)
			continue
		}
		changed = true
		const parent = shiftX ? shift(s, shiftX, 0, out.items) : s
		const r = bands(parent, open, kidSections, kids, out)
		const moved = shift(parent, 0, r.room, out.items)
		const animating = open.some((k) => k.open !== k.to)
		const grown: SectionLayout = { ...moved, box: { ...parent.box, w: Math.max(parent.box.w, r.width), h: parent.box.h + r.room }, header: { ...parent.header, w: Math.max(parent.header.w, r.width - LAYOUT.framePadding * 2) }, ...(animating || pushing ? { snap: true } : {}) }
		for (const k of r.sections) if (animating) k.snap = true
		out.sections.push(...r.sections, grown)
		shiftX += grown.box.w - parent.box.w
		pushing ||= animating && grown.box.w !== parent.box.w
	}
	if (!changed) return base
	out.groups = out.sections.flatMap((s) => s.groups)
	out.bounds = Box.union(out.sections.map((s) => s.box))
	return out
}

/** A parent's open drawers: their frames, how far its content moves down, and how wide it gets. */
function bands(s: SectionLayout, open: DrawerKid[], kidSections: Map<string, SectionLayout>, kids: Layout, out: Layout) {
	const inset = LAYOUT.framePadding
	const left = s.box.x + inset
	const top0 = s.header.y + BAND_TOP
	const contentY = s.header.y + s.header.h
	const slots = open.map((kid) => {
		const c = kidSections.get(kid.id)!
		return { kid, c, w: c.box.w, h: c.box.h - LIFT }
	})
	const bandW = Math.max(s.box.w - inset * 2, ...slots.map((t) => t.w))
	const width = bandW + inset * 2
	const sections: SectionLayout[] = []

	// switching: the one band changes height as one subagent's content gives way to the next's
	const to = slots.length === 2 ? slots.find((t) => t.kid.from && t.kid.to > 0.5) : undefined
	const from = to && slots.find((t) => t.kid.id === to.kid.from && t.kid.to < 0.5)
	if (to && from) {
		const e = to.kid.open
		const box: Box = { x: left, y: top0, w: bandW, h: from.h + (to.h - from.h) * e }
		const inA = clamp01((e - 0.1) / 0.5)
		const outA = 1 - clamp01((e - 0.6) / 0.25)
		for (const [t, opacity] of [[to, inA], [from, outA]] as const) {
			const k = Math.min(1, box.h / t.h)
			const sec = place(t.c, s.id, kids, box, k, out)
			sec.opacity = opacity
			sections.push(sec)
		}
		return { sections, room: box.y + box.h + CONTENT_GAP - contentY, width }
	}

	let y = top0
	let most = 0
	for (const t of slots) {
		const e = t.kid.open
		const unfold = 1 - (1 - clamp01(e / 0.75)) ** 2
		const box: Box = { x: left, y, w: bandW, h: t.h * unfold }
		const sec = place(t.c, s.id, kids, box, 1, out)
		sec.opacity = e >= 1 ? 1 : clamp01((e - 0.55) / 0.45)
		sections.push(sec)
		y += (box.h + BAND_GAP) * unfold
		most = Math.max(most, unfold)
	}
	// (front to back: the ones opening over the ones closing)
	const order = sections.map((sec, i) => ({ sec, to: slots[i].kid.to, i })).sort((a, b) => b.to - a.to || a.i - b.i)
	return { sections: order.map((o) => o.sec), room: Math.max(0, y - top0 + (top0 - BAND_GAP + CONTENT_GAP - contentY) * most), width }
}

/**
 * A subagent's frame in a band (its box): its title strip in the band's top, its content under it,
 * scaled by k about the band's top-left. Its items go into `out`.
 */
function place(c: SectionLayout, parentId: string, kids: Layout, band: Box, k: number, out: Layout): SectionLayout {
	const t = (b: Box): Box => ({ x: band.x + (b.x - c.box.x) * k, y: band.y + (b.y - c.box.y - LIFT) * k, w: b.w * k, h: b.h * k })
	for (const id of c.itemIds) {
		const b = kids.items.get(id)
		if (!b) continue
		out.items.set(id, t(b))
		out.sectionOf.set(id, c.id)
		const g = kids.groupOf.get(id)
		if (g) out.groupOf.set(id, g)
	}
	const groups: GroupLayout[] = c.groups.map((g) => ({ ...g, box: t(g.box), heading: g.heading && t(g.heading) }))
	return {
		...c,
		box: band,
		header: { x: band.x + LAYOUT.framePadding * k, y: band.y + DRAWER_TITLE.top * k, w: Math.max(0, band.w - LAYOUT.framePadding * 2 * k), h: DRAWER_TITLE.h * k },
		groups,
		more: c.more && { ...c.more, box: t(c.more.box) },
		drawer: { parentId },
	}
}

/** A frame (and what's in it) moved by (dx, dy); its items' boxes in `items` too. */
function shift(s: SectionLayout, dx: number, dy: number, items: Map<string, Box>): SectionLayout {
	if (!dx && !dy) return s
	const m = (b: Box): Box => ({ x: b.x + dx, y: b.y + dy, w: b.w, h: b.h })
	for (const id of s.itemIds) {
		const b = items.get(id)
		if (b) items.set(id, m(b))
	}
	return {
		...s,
		box: dx ? m(s.box) : s.box,
		header: dx ? m(s.header) : s.header,
		groups: s.groups.map((g) => ({ ...g, box: m(g.box), heading: g.heading && m(g.heading) })),
		more: s.more && { ...s.more, box: m(s.more.box) },
	}
}
