import { Box } from '../../editor/geometry'
import { LAYOUT, type GroupLayout, type Layout, type SectionLayout } from '../../editor/layout'
import { clamp01 } from '../../render/subagents/field'

/*
 * The canvas with detached titles: a post-process of computeLayout. Every session is laid out by the
 * canvas's own rules; then each frame loses its title strip (its content moves up to the padding) and
 * its title goes above it, outside the frame. Subagents (child sessions) are taken out of the row:
 * they only show, as frames of their own, while expanded, stacked below their parent.
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

export interface PlanKid {
	id: string
	/** 0..1, eased */
	open: number
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
}

export interface HeadPlan {
	id: string
	/** set for an expanded subagent */
	parentId: string | null
	/** page: the title's top-left and width (its height is m.head / zoom) */
	box: Box
	/** the frame under it */
	frame: Box
	opacity: number
}

export interface Plan {
	layout: Layout
	heads: HeadPlan[]
	zoom: number
}

/** Page px between stacked frames (a subagent under its parent or the one before), besides the title. */
const STACK_GAP = 72

export function plan(inp: PlanInput): Plan {
	const { natural, zoom: z, m } = inp
	const L = LAYOUT
	const strip = L.frameHeaderHeight
	const out: Layout = { sections: [], groups: [], items: new Map(), sectionOf: natural.sectionOf, groupOf: natural.groupOf, bounds: null }
	const heads: HeadPlan[] = []
	const byId = new Map(natural.sections.map((s) => [s.id, s]))
	const headSpace = (m.head + m.headGap) / z

	let x = 0
	for (const s of natural.sections) {
		if (inp.childIds.has(s.id)) continue
		const open = (inp.families.get(s.id) ?? []).filter((k) => k.open > 0.0005 && byId.has(k.id))
		// A subagent's room opens before it fades in, and it fades out before its room closes (nothing slides over it).
		const room = (k: PlanKid) => clamp01(k.open / 0.5)
		const frame: Box = { x, y: 0, w: s.box.w, h: s.box.h - strip }
		const parent = place(natural, s, frame.x, 0, 1, out.items)
		const header: Box = { x: frame.x, y: frame.y - headSpace, w: frame.w, h: m.head / z }
		const sections: SectionLayout[] = []
		heads.push({ id: s.id, parentId: null, box: header, frame, opacity: 1 })

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
			const child = place(natural, c, frame.x, fy + (1 - opacity) * (12 / z), k * (0.98 + 0.02 * opacity), out.items)
			child.opacity = opacity
			child.header = { x: child.box.x, y: child.box.y - headSpace, w: child.box.w, h: m.head / z }
			heads.push({ id: c.id, parentId: s.id, box: child.header, frame: child.box, opacity })
			sections.push(child)
		}

		parent.box = frame
		parent.header = header
		out.sections.push(...sections, parent)
		x = right + L.frameGap
	}
	out.groups = out.sections.flatMap((s) => s.groups)
	out.bounds = Box.union(out.sections.flatMap((s) => [s.box, s.header]))
	return { layout: out, heads, zoom: z }
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
