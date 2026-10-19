import type { Item, Session } from '../../../shared/types'
import { Box } from './geometry'

export interface GroupLayout {
	/** stable key: `${sessionId}/${name}` ("" for the untitled group) */
	id: string
	sessionId: string
	name: string | null
	/** the group's whole area, including its heading */
	box: Box
	/** where the heading text goes (null for the untitled group) */
	heading: Box | null
	itemIds: string[]
}

export interface SectionLayout {
	id: string
	title: string
	/** the session's frame */
	box: Box
	/** where the session title goes, inside the top of the frame */
	header: Box
	/** page height of the band kept clear along the top of the frame for its status rail (0: no rail) */
	rail: number
	groups: GroupLayout[]
	/** all items in display order (group by group) */
	itemIds: string[]
}

export interface Layout {
	sections: SectionLayout[]
	groups: GroupLayout[]
	items: Map<string, Box>
	/** item id -> section id */
	sectionOf: Map<string, string>
	/** item id -> group id */
	groupOf: Map<string, string>
	bounds: Box | null
}

export const LAYOUT = {
	/** widest a row of images gets before wrapping */
	maxRowWidth: 2400,
	rowHeight: 320,
	gap: 16,
	/**
	 * Items that would be unreadable squeezed into a row get one of their own: HTML always, and
	 * images and videos whose aspect is extreme (taller than minRowAspect, wider than maxRowAspect)
	 * or more than outlierRatio times off their group's median aspect.
	 */
	minRowAspect: 0.6,
	maxRowAspect: 3.5,
	outlierRatio: 2.5,
	/** a portrait item alone on its row is at most this wide... */
	tallMaxWidth: 900,
	/** ...and at most this tall, unless that would make it narrower than tallMinWidth */
	tallMaxHeight: 2400,
	tallMinWidth: 600,
	/** space reserved above a row that has a titled item (the text scales with zoom) */
	titleHeight: 26,
	framePadding: 40,
	/** the session title strip at the top of a frame */
	frameHeaderHeight: 96,
	/** the band above it on frames with a status rail (live sessions, see Rails) */
	frameRailHeight: 28,
	frameGap: 160,
	/** the heading above a named group */
	groupHeadingHeight: 52,
	groupGap: 56,
	minFrameWidth: 480,
	emptyFrameHeight: 160,
	/** page-space font size of session titles (see .section-label in styles.css) */
	frameTitlePx: 40,
	/** session titles stay at least this big on screen; zoomed far out they grow upward out of the frame */
	minFrameTitlePx: 13,
}

/**
 * How a session's title is drawn at zoom z: the header box it's anchored to (at its bottom-left)
 * and the scale it's drawn at. Below page scale it stays readable by growing upward out of the
 * frame; a frame with a status rail then moves its title above the frame, clear of the rail.
 */
export function frameTitlePlacement(section: SectionLayout, z: number): { anchor: Box; scale: number } {
	const scale = Math.max(z, LAYOUT.minFrameTitlePx / LAYOUT.frameTitlePx)
	if (!section.rail || scale <= z) return { anchor: section.header, scale }
	// The title's line (4px padding + 1.2 × 40px) sits at the top of the 96px label: its text then
	// ends 4 screen px above the frame.
	const h = section.header.h
	const bottom = section.box.y + ((h - 52) * scale - 4) / z
	return { anchor: { ...section.header, y: bottom - h }, scale }
}

/**
 * Where a session's title is on the page at zoom z: the header strip, from the top of the frame,
 * extended upward when the title is drawn bigger than page scale (see SectionLabels).
 */
export function frameTitleBox(section: SectionLayout, z: number): Box {
	const { anchor, scale } = frameTitlePlacement(section, z)
	const bottom = anchor.y + anchor.h
	const top = Math.min(section.box.y, bottom - (anchor.h * scale) / z)
	return { x: section.box.x, y: top, w: section.box.w, h: bottom - top }
}

/**
 * Sessions in frame order, left to right: those in `order` (the canvas's sessionOrder) first, as
 * arranged, then the rest oldest first, so new sessions appear on the far right.
 */
export function orderSessions<S extends Session>(sessions: Iterable<S>, order?: readonly string[]): S[] {
	const rank = new Map(order?.map((id, i) => [id, i]))
	return [...sessions].sort((a, b) => {
		const ra = rank.get(a.id) ?? Infinity
		const rb = rank.get(b.id) ?? Infinity
		if (ra !== rb) return ra - rb
		return a.createdAt - b.createdAt || a.id.localeCompare(b.id)
	})
}

/**
 * Positions are a pure function of the data. Each session is a frame; frames sit side by side in
 * frame order (see orderSessions), and hidden sessions take no space. Inside a frame, groups stack top to
 * bottom: the untitled group first, then named groups in the order they first appeared. Each group's
 * items flow left to right into justified rows that keep every item's aspect ratio. A frame is as
 * wide as its widest group, so a wider row pushes every frame to its right further out. Frames
 * of sessions in `railed` keep a band clear along their top for their status rail.
 */
export function computeLayout(
	sessions: Record<string, Session>,
	items: Record<string, Item>,
	order?: readonly string[],
	railed?: ReadonlySet<string>,
): Layout {
	const L = LAYOUT
	const bySession = new Map<string, Item[]>()
	for (const item of Object.values(items)) {
		let list = bySession.get(item.sessionId)
		if (!list) bySession.set(item.sessionId, (list = []))
		list.push(item)
	}

	const ordered = orderSessions(Object.values(sessions), order).filter((s) => !s.hidden)
	const layout: Layout = { sections: [], groups: [], items: new Map(), sectionOf: new Map(), groupOf: new Map(), bounds: null }
	let frameX = 0

	for (const session of ordered) {
		const list = (bySession.get(session.id) ?? []).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))

		// Group in first-appearance order, with the untitled group first.
		const named = new Map<string | null, Item[]>()
		for (const item of list) {
			const key = item.group ?? null
			if (!named.has(key)) named.set(key, [])
			named.get(key)!.push(item)
		}
		const groups = [...named.entries()].sort(([a], [b]) => (a === null ? -1 : b === null ? 1 : 0))

		// Lay out each group relative to the frame's content origin, then shift into place.
		const rail = railed?.has(session.id) ? L.frameRailHeight : 0
		const contentX = frameX + L.framePadding
		const contentY = rail + L.framePadding + L.frameHeaderHeight
		let y = contentY
		let contentWidth = 0
		const sectionGroups: GroupLayout[] = []

		for (const [name, groupItems] of groups) {
			const top = y
			if (name !== null) y += L.groupHeadingHeight
			const { boxes, width, height } = flowRows(groupItems, y)
			for (const [id, box] of boxes) {
				layout.items.set(id, { ...box, x: box.x + contentX })
				layout.sectionOf.set(id, session.id)
			}
			const group: GroupLayout = {
				id: `${session.id}/${name ?? ''}`,
				sessionId: session.id,
				name,
				box: { x: contentX, y: top, w: width, h: y + height - top },
				heading: name === null ? null : { x: contentX, y: top, w: width, h: L.groupHeadingHeight },
				itemIds: groupItems.map((i) => i.id),
			}
			for (const i of groupItems) layout.groupOf.set(i.id, group.id)
			sectionGroups.push(group)
			contentWidth = Math.max(contentWidth, width)
			y += height + L.groupGap
		}

		const innerWidth = Math.max(contentWidth, L.minFrameWidth)
		const contentHeight = sectionGroups.length ? y - L.groupGap - contentY : L.emptyFrameHeight
		const box = { x: frameX, y: 0, w: innerWidth + L.framePadding * 2, h: rail + L.frameHeaderHeight + contentHeight + L.framePadding * 2 }
		// Headings span the frame so long group names have room.
		for (const g of sectionGroups) if (g.heading) g.heading.w = innerWidth

		layout.sections.push({
			id: session.id,
			title: session.title,
			box,
			header: { x: contentX, y: rail + L.framePadding, w: innerWidth, h: L.frameHeaderHeight },
			rail,
			groups: sectionGroups,
			itemIds: sectionGroups.flatMap((g) => g.itemIds),
		})
		layout.groups.push(...sectionGroups)
		frameX += box.w + L.frameGap
	}

	layout.bounds = Box.union(layout.sections.map((s) => s.box))
	return layout
}

/** The layout with one frame (and everything in it) moved by (dx, dy), e.g. while it's dragged. */
export function shiftSection(layout: Layout, id: string, dx: number, dy: number): Layout {
	const shift = (b: Box): Box => ({ x: b.x + dx, y: b.y + dy, w: b.w, h: b.h })
	const index = layout.sections.findIndex((s) => s.id === id)
	if (index < 0 || (dx === 0 && dy === 0)) return layout
	const old = layout.sections[index]
	const groups = old.groups.map((g) => ({ ...g, box: shift(g.box), heading: g.heading && shift(g.heading) }))
	const section: SectionLayout = { ...old, box: shift(old.box), header: shift(old.header), groups }
	const sections = layout.sections.map((s, i) => (i === index ? section : s))
	const items = new Map(layout.items)
	for (const itemId of old.itemIds) items.set(itemId, shift(items.get(itemId)!))
	return {
		...layout,
		sections,
		groups: sections.flatMap((s) => s.groups),
		items,
		bounds: Box.union(sections.map((s) => s.box)),
	}
}

/**
 * Justified rows starting at (0, top): fill a row until it would pass maxRowWidth, then scale it
 * down to exactly fit. The last row keeps the natural row height. Items that need their own row
 * (see ownRowSize) close the row before them and sit alone at their own size. Rows with a titled
 * item get a strip above them for the titles.
 */
function flowRows(items: Item[], top: number) {
	const { maxRowWidth: W, rowHeight: H, gap, titleHeight } = LAYOUT
	const boxes = new Map<string, Box>()
	let rowY = top
	let width = 0
	let row: Item[] = []
	let rowAspect = 0
	const median = medianAspect(items)

	const placeRow = (height: number) => {
		if (row.some((item) => item.title)) rowY += titleHeight
		let x = 0
		for (const item of row) {
			const w = (item.width / item.height) * height
			boxes.set(item.id, { x, y: rowY, w, h: height })
			x += w + gap
		}
		width = Math.max(width, x - gap)
		rowY += height + gap
		row = []
		rowAspect = 0
	}

	for (const item of items) {
		const own = ownRowSize(item, median)
		if (own) {
			if (row.length) placeRow(H)
			if (item.title) rowY += titleHeight
			boxes.set(item.id, { x: 0, y: rowY, ...own })
			width = Math.max(width, own.w)
			rowY += own.h + gap
			continue
		}
		row.push(item)
		rowAspect += item.width / item.height
		if (rowAspect * H + gap * (row.length - 1) >= W) placeRow((W - gap * (row.length - 1)) / rowAspect)
	}
	if (row.length) placeRow(H)

	return { boxes, width, height: rowY - gap - top }
}

/** The median aspect of the group's images and videos (HTML always gets its own row anyway). */
function medianAspect(items: Item[]): number | null {
	const aspects = items
		.filter((i) => i.kind !== 'html')
		.map((i) => i.width / i.height)
		.sort((a, b) => a - b)
	if (!aspects.length) return null
	const mid = aspects.length >> 1
	return aspects.length % 2 ? aspects[mid]! : (aspects[mid - 1]! + aspects[mid]!) / 2
}

/**
 * The size of an item that gets a row to itself, or null if it joins the justified rows. HTML is
 * drawn at its design width (so its iframe renders at page scale), at most a row wide. Outlier
 * images and videos keep their natural width up to a row; portrait ones are kept between
 * tallMinWidth and tallMaxWidth wide, shrinking toward tallMinWidth to stay under tallMaxHeight.
 */
function ownRowSize(item: Item, median: number | null): { w: number; h: number } | null {
	const L = LAYOUT
	const aspect = item.width / item.height
	if (item.kind === 'html') {
		const w = Math.min(item.width, L.maxRowWidth)
		return { w, h: w / aspect }
	}
	const ratio = median ? Math.max(aspect / median, median / aspect) : 1
	if (aspect >= L.minRowAspect && aspect <= L.maxRowAspect && ratio <= L.outlierRatio) return null
	let w = Math.min(item.width, L.maxRowWidth)
	if (aspect < 1) {
		w = Math.min(w, L.tallMaxWidth)
		if (w / aspect > L.tallMaxHeight) w = Math.max(L.tallMaxHeight * aspect, Math.min(item.width, L.tallMinWidth))
	}
	return { w, h: w / aspect }
}
