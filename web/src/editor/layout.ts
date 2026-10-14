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
	/** space reserved above a row that has a titled item (the text scales with zoom) */
	titleHeight: 26,
	framePadding: 40,
	/** the session title strip at the top of a frame */
	frameHeaderHeight: 96,
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
 * Where a session's title is on the page at zoom z: the header strip, from the top of the frame,
 * extended upward when the title is drawn bigger than page scale (see SectionLabels).
 */
export function frameTitleBox(section: SectionLayout, z: number): Box {
	const grow = Math.max(1, LAYOUT.minFrameTitlePx / LAYOUT.frameTitlePx / z)
	const bottom = section.header.y + section.header.h
	const top = Math.min(section.box.y, bottom - section.header.h * grow)
	return { x: section.box.x, y: top, w: section.box.w, h: bottom - top }
}

/**
 * Positions are a pure function of the data. Each session is a frame; frames sit side by side,
 * oldest on the left, so new sessions appear on the far right. Inside a frame, groups stack top to
 * bottom: the untitled group first, then named groups in the order they first appeared. Each group's
 * items flow left to right into justified rows that keep every item's aspect ratio. A frame is as
 * wide as its widest group, so a wider row pushes every frame to its right further out.
 */
export function computeLayout(sessions: Record<string, Session>, items: Record<string, Item>): Layout {
	const L = LAYOUT
	const bySession = new Map<string, Item[]>()
	for (const item of Object.values(items)) {
		let list = bySession.get(item.sessionId)
		if (!list) bySession.set(item.sessionId, (list = []))
		list.push(item)
	}

	const ordered = Object.values(sessions).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
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
		const contentX = frameX + L.framePadding
		const contentY = L.framePadding + L.frameHeaderHeight
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
		const box = { x: frameX, y: 0, w: innerWidth + L.framePadding * 2, h: L.frameHeaderHeight + contentHeight + L.framePadding * 2 }
		// Headings span the frame so long group names have room.
		for (const g of sectionGroups) if (g.heading) g.heading.w = innerWidth

		layout.sections.push({
			id: session.id,
			title: session.title,
			box,
			header: { x: contentX, y: L.framePadding, w: innerWidth, h: L.frameHeaderHeight },
			groups: sectionGroups,
			itemIds: sectionGroups.flatMap((g) => g.itemIds),
		})
		layout.groups.push(...sectionGroups)
		frameX += box.w + L.frameGap
	}

	layout.bounds = Box.union(layout.sections.map((s) => s.box))
	return layout
}

/**
 * Justified rows starting at (0, top): fill a row until it would pass maxRowWidth, then scale it
 * down to exactly fit. The last row keeps the natural row height. Rows with a titled item get a
 * strip above them for the titles.
 */
function flowRows(items: Item[], top: number) {
	const { maxRowWidth: W, rowHeight: H, gap, titleHeight } = LAYOUT
	const boxes = new Map<string, Box>()
	let rowY = top
	let width = 0
	let row: Item[] = []
	let rowAspect = 0

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
		row.push(item)
		rowAspect += item.width / item.height
		if (rowAspect * H + gap * (row.length - 1) >= W) placeRow((W - gap * (row.length - 1)) / rowAspect)
	}
	if (row.length) placeRow(H)

	return { boxes, width, height: rowY - gap - top }
}
