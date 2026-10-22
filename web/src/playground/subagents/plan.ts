import { Box } from '../../editor/geometry'
import { LAYOUT, type GroupLayout, type Layout, type SectionLayout } from '../../editor/layout'
import { clamp01 } from '../../render/subagents/field'

/*
 * The canvas with detached headers: a post-process of computeLayout. Every session is laid out by the
 * canvas's own rules; then each frame loses its title strip (its content moves up to the padding),
 * its title goes above it as a header outside the frame, and its subagents' list goes either in the
 * gap between the two or in a band at the top inside the frame. Subagents (child sessions) are taken
 * out of the row: they only show, as frames of their own, while expanded, below their parent, to its
 * right, or inside it pushing its content down.
 *
 * Headers and lists are a constant size on screen (like the busy band's dots), so their page height
 * depends on the zoom. They grow upward, above the frame, and a frame's content never moves with zoom
 * (only its top edge does, with the list inside). Expanded subagents in the row below or to the right
 * move with their parent's header, which is fine: it's all drawn where this says, the same frame.
 */

export type ListPlacement = 'gap' | 'inside'
export type ExpandPlacement = 'below' | 'right' | 'inline'
export type Motion = 'grow' | 'fade'

/** Screen px. */
export interface Metrics {
	/** the header's height */
	head: number
	/** between the header and what's under it */
	headGap: number
	/** between the list and the frame's top edge (the list in the gap): clear of the busy band */
	listGap: number
	/** above and below the list, inside the frame */
	bandPad: number
}

export interface PlanKid {
	id: string
	/** 0..1, eased */
	open: number
	/** where its entry is in its parent's list (list-local screen px), to grow out of */
	chip: Box | null
}

export interface PlanFamily {
	parentId: string
	kids: PlanKid[]
	/** screen px (animated); 0 without a list */
	listH: number
}

export interface PlanInput {
	natural: Layout
	families: Map<string, PlanFamily>
	/** every subagent session (none of them sit in the row) */
	childIds: ReadonlySet<string>
	zoom: number
	list: ListPlacement
	expand: ExpandPlacement
	motion: Motion
	/** expanded subagents' frames at this scale (inline: at most the parent's content width) */
	childScale: number
	m: Metrics
}

export interface HeadPlan {
	id: string
	/** set for an expanded subagent */
	parentId: string | null
	/** page: the header's top-left and width (its height is m.head / zoom) */
	box: Box
	/** the frame under it */
	frame: Box
	opacity: number
}

export interface ListPlan {
	parentId: string
	/** page: the list's top-left and width (and height) */
	box: Box
	inside: boolean
	/** inside: page y of the band's lower edge (a dotted line divides it from the content) */
	divider: number | null
}

export interface Plan {
	layout: Layout
	heads: HeadPlan[]
	lists: Map<string, ListPlan>
	zoom: number
}

/** Page px between stacked frames (a subagent under its parent or the one before), besides the header. */
const STACK_GAP = 72
/** Page px from a parent's right edge to its subagents' column. */
const SIDE_GAP = 120

/** How wide each parent's list is on screen at zoom z (what representations lay out into). */
export function listWidth(natural: Layout, parentId: string, z: number, list: ListPlacement) {
	const s = natural.sections.find((x) => x.id === parentId)
	if (!s) return 0
	return (s.box.w - (list === 'inside' ? LAYOUT.framePadding * 2 : 0)) * z
}

export function plan(inp: PlanInput): Plan {
	const { natural, zoom: z, m } = inp
	const L = LAYOUT
	const strip = L.frameHeaderHeight
	const out: Layout = { sections: [], groups: [], items: new Map(), sectionOf: natural.sectionOf, groupOf: natural.groupOf, bounds: null }
	const heads: HeadPlan[] = []
	const lists = new Map<string, ListPlan>()
	const byId = new Map(natural.sections.map((s) => [s.id, s]))
	const headSpace = (m.head + m.headGap) / z

	let x = 0
	for (const s of natural.sections) {
		if (inp.childIds.has(s.id)) continue
		const fam = inp.families.get(s.id)
		const listH = fam?.listH ?? 0
		const hasList = !!fam && fam.kids.length > 0
		const inside = inp.list === 'inside' && hasList
		const band = inside ? (m.bandPad * 2 + listH) / z : 0
		const open = (fam?.kids ?? []).filter((k) => k.open > 0.0005 && byId.has(k.id))
		// Fading, a subagent's room opens before it fades in, and it fades out before its room closes (nothing slides over it).
		const room = (k: PlanKid) => (inp.motion === 'fade' ? clamp01(k.open / 0.5) : k.open)

		// Inline subagents sit where the content starts and push it down.
		const innerW = s.box.w - L.framePadding * 2
		const inline: { kid: PlanKid; c: SectionLayout; k: number; top: number }[] = []
		let inlineH = 0
		if (inp.expand === 'inline') {
			for (const kid of open) {
				const c = byId.get(kid.id)!
				const k = Math.min(inp.childScale, innerW / c.box.w)
				inline.push({ kid, c, k, top: inlineH + headSpace })
				inlineH += (headSpace + (c.box.h - strip) * k + STACK_GAP) * room(kid)
			}
		}

		const frame: Box = { x, y: -band, w: s.box.w, h: s.box.h - strip + band + inlineH }
		const parent = place(natural, s, frame.x, 0, 1, inlineH, out.items)
		const listBox: Box | null = !hasList
			? null
			: inside
				? { x: frame.x + L.framePadding, y: frame.y + m.bandPad / z, w: innerW, h: listH / z }
				: { x: frame.x, y: frame.y - (m.listGap + listH) / z, w: frame.w, h: listH / z }
		const headY = (listBox && !inside ? listBox.y : frame.y) - headSpace
		const header: Box = { x: frame.x, y: headY, w: frame.w, h: m.head / z }
		const sections: SectionLayout[] = []
		heads.push({ id: s.id, parentId: null, box: header, frame, opacity: 1 })
		if (listBox) lists.set(s.id, { parentId: s.id, box: listBox, inside, divider: inside ? frame.y + band : null })

		// Subagents' frames: where they end up, and on the way there from their entry in the list.
		let right = frame.x + frame.w
		let cursor = inp.expand === 'below' ? frame.y + frame.h : frame.y
		for (const kid of open) {
			const c = byId.get(kid.id)!
			const h = c.box.h - strip
			let k = inp.childScale
			let fx = 0
			let fy = 0
			if (inp.expand === 'below') {
				fx = frame.x
				fy = cursor + STACK_GAP + headSpace
				cursor += (STACK_GAP + headSpace + h * k) * room(kid)
				right = Math.max(right, frame.x + frame.w + (Math.max(frame.w, c.box.w * k) - frame.w) * room(kid))
			} else if (inp.expand === 'right') {
				fx = frame.x + frame.w + SIDE_GAP
				fy = cursor
				cursor += (h * k + STACK_GAP + headSpace) * room(kid)
				right = Math.max(right, frame.x + frame.w + (SIDE_GAP + c.box.w * k) * room(kid))
			} else {
				const p = inline.find((i) => i.kid === kid)!
				k = p.k
				fx = frame.x + L.framePadding
				fy = frame.y + band + L.framePadding + p.top
			}
			let bx = fx
			let by = fy
			let bk = k
			let opacity = kid.open
			if (inp.motion === 'grow' && kid.chip && listBox) {
				const chip = { x: listBox.x + kid.chip.x / z, y: listBox.y + kid.chip.y / z, w: kid.chip.w / z }
				const e = kid.open
				bk = chip.w / c.box.w + (k - chip.w / c.box.w) * e
				bx = chip.x + (fx - chip.x) * e
				by = chip.y + (fy - chip.y) * e
				opacity = clamp01(e / 0.35)
			} else {
				opacity = clamp01((kid.open - 0.5) / 0.5)
				bk = k * (0.98 + 0.02 * opacity)
				by = fy + (1 - opacity) * (12 / z)
			}
			const child = place(natural, c, bx, by, bk, 0, out.items)
			child.opacity = opacity
			const childFrame = child.box
			child.header = { x: childFrame.x, y: childFrame.y - headSpace, w: childFrame.w, h: m.head / z }
			heads.push({ id: c.id, parentId: s.id, box: child.header, frame: childFrame, opacity })
			sections.push(child)
		}

		parent.box = frame
		parent.header = header
		// Subagents first: inline ones sit inside their parent's box, and hit testing takes the first frame that has the point.
		out.sections.push(...sections, parent)
		x = right + L.frameGap
	}
	out.groups = out.sections.flatMap((s) => s.groups)
	out.bounds = Box.union(out.sections.flatMap((s) => [s.box, s.header]))
	return { layout: out, heads, lists, zoom: z }
}

/**
 * A section without its title strip, its frame's top-left at (x, y), scaled by k about that corner;
 * its content `dy` further down. Its items go into `items`.
 */
function place(natural: Layout, s: SectionLayout, x: number, y: number, k: number, dy: number, items: Map<string, Box>): SectionLayout {
	const strip = LAYOUT.frameHeaderHeight
	const t = (b: Box): Box => ({ x: x + (b.x - s.box.x) * k, y: y + (b.y - s.box.y - strip) * k + dy, w: b.w * k, h: b.h * k })
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
