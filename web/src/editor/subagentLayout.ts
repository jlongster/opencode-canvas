import { Box } from './geometry'
import { LAYOUT, type GroupLayout, type Layout, type SectionLayout } from './layout'

/*
 * Subagent frames: a session's subagents (child sessions) laid out to the right of its frame as
 * mini session frames. This is a post-process of computeLayout: every session is laid out by the
 * canvas's own rules (header, groups, justified rows), then each child frame is lifted out of the
 * row, scaled, and placed in its parent's "family" to the right of the parent; families sit side
 * by side in frame order, as wide as their children make them, so neighbours make room.
 *
 * Positions inside a family are given per child (`poses`): relative to the family's children
 * origin, one gutter to the right of the parent's top-right corner. The arrangements below (a
 * column, a deck, title tabs) produce them; callers can animate between them.
 */

/** A child frame's place in its family: top-left relative to the children origin, and its scale. */
export interface ChildPose {
	x: number
	y: number
	s: number
}

export interface Family {
	parentId: string
	/** in hit-test order: frontmost first (for overlapping stacks) */
	childIds: string[]
	poses: Record<string, ChildPose>
}

export interface FamilyOptions {
	/** page px between the parent's right edge and the children */
	gutter: number
}

/** A frame's natural size, as computeLayout made it. */
export interface Size {
	w: number
	h: number
}

/** Page px from the top of a frame (at scale 1) to the middle of its title row. */
export const TITLE_ROW = LAYOUT.framePadding + 24
/** Page px of a frame's title strip at scale 1: padding, the title line and a little air. */
export const TITLE_STRIP = LAYOUT.framePadding + 48 + 18

export function naturalSizes(base: Layout, ids: readonly string[]): Record<string, Size> {
	const out: Record<string, Size> = {}
	for (const s of base.sections) if (ids.includes(s.id)) out[s.id] = { w: s.box.w, h: s.box.h }
	return out
}

/** A column: top-aligned, natural sizes at scale s, `gap` apart. */
export function columnPoses(ids: readonly string[], sizes: Record<string, Size>, s: number, gap: number): Record<string, ChildPose> {
	const out: Record<string, ChildPose> = {}
	let y = 0
	for (const id of ids) {
		out[id] = { x: 0, y, s }
		y += (sizes[id]?.h ?? 0) * s + gap
	}
	return out
}

/**
 * A deck (front first in `order`): every card at its natural size, the front one top-left (level
 * with the parent's title) and each one further back offset by (dx, dy), so their edges show.
 */
export function deckPoses(order: readonly string[], s: number, dx: number, dy: number): Record<string, ChildPose> {
	const out: Record<string, ChildPose> = {}
	order.forEach((id, depth) => (out[id] = { x: depth * dx, y: depth * dy, s }))
	return out
}

/**
 * Title tabs (front first in `order`): every card at its natural size, each one further back a
 * strip `step` higher (at least a title strip), so all the titles show; the back card is at the
 * top, level with the parent.
 */
export function tabPoses(order: readonly string[], s: number, step = TITLE_STRIP * s, top = 0): Record<string, ChildPose> {
	const out: Record<string, ChildPose> = {}
	const n = order.length
	order.forEach((id, depth) => (out[id] = { x: 0, y: top + (n - 1 - depth) * step, s }))
	return out
}

/** A tab strip that keeps a readable title (≥ minPx on screen) at zoom z. */
export function tabStep(s: number, z: number, minPx = 28) {
	return Math.max(TITLE_STRIP * s, minPx / z)
}

/** The extent of a family's children (relative to the children origin), or null without children. */
export function childrenExtent(ids: readonly string[], poses: Record<string, ChildPose>, sizes: Record<string, Size>): Box | null {
	const boxes: Box[] = []
	for (const id of ids) {
		const p = poses[id]
		const sz = sizes[id]
		if (p && sz) boxes.push({ x: p.x, y: p.y, w: sz.w * p.s, h: sz.h * p.s })
	}
	return boxes.length ? Box.union(boxes) : null
}

/**
 * The canvas laid out with families: parents in frame order (as `base` has them), each followed by
 * its children region; sessions that are someone's child are taken out of the row. Sections come
 * out as parent, then its children frontmost first, so hit testing finds the card on top.
 */
export function layoutFamilies(base: Layout, families: readonly Family[], opts: FamilyOptions): Layout {
	const byParent = new Map(families.map((f) => [f.parentId, f]))
	const children = new Set(families.flatMap((f) => f.childIds))
	const sectionById = new Map(base.sections.map((s) => [s.id, s]))
	const out: Layout = { sections: [], groups: [], items: new Map(), sectionOf: base.sectionOf, groupOf: base.groupOf, bounds: null }

	let x = 0
	for (const parent of base.sections) {
		if (children.has(parent.id)) continue
		out.sections.push(place(base, parent, x, 0, 1, out.items))
		let right = x + parent.box.w
		const family = byParent.get(parent.id)
		if (family) {
			const ox = right + opts.gutter
			const sizes: Record<string, Size> = {}
			for (const id of family.childIds) {
				const s = sectionById.get(id)
				const p = family.poses[id]
				if (!s || !p) continue
				sizes[id] = { w: s.box.w, h: s.box.h }
				out.sections.push(place(base, s, ox + p.x, p.y, p.s, out.items))
			}
			const ext = childrenExtent(family.childIds, family.poses, sizes)
			if (ext) right = Math.max(right, ox + ext.x + ext.w)
		}
		x = right + LAYOUT.frameGap
	}
	out.groups = out.sections.flatMap((s) => s.groups)
	out.bounds = Box.union(out.sections.map((s) => s.box))
	return out
}

/** A section (and its items) moved so its top-left is at (x, y) and scaled by s about that corner. */
function place(base: Layout, section: SectionLayout, x: number, y: number, s: number, items: Map<string, Box>): SectionLayout {
	const ox = section.box.x
	const oy = section.box.y
	const t = (b: Box): Box => ({ x: x + (b.x - ox) * s, y: y + (b.y - oy) * s, w: b.w * s, h: b.h * s })
	for (const id of section.itemIds) {
		const b = base.items.get(id)
		if (b) items.set(id, t(b))
	}
	const groups: GroupLayout[] = section.groups.map((g) => ({ ...g, box: t(g.box), heading: g.heading && t(g.heading) }))
	return {
		...section,
		box: t(section.box),
		header: t(section.header),
		groups,
		more: section.more && { ...section.more, box: t(section.more.box) },
	}
}
