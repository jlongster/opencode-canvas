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
	/** the items laid out, in display order (group by group) */
	itemIds: string[]
	/** the row under the groups saying how many older items are hidden, if any are */
	more: { box: Box; hidden: number } | null
	/** drawn this opaque, items included (default 1; read by a renderer with easeLayout false, and for `snap` frames) */
	opacity?: number
	/** drawn exactly where it's laid out, with its items, without easing (the caller animates it, see drawers.ts) */
	snap?: boolean
	/** a subagent's frame open in a drawer in its parent's frame (see drawers.ts) */
	drawer?: { parentId: string }
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

/**
 * The Reference Manual's sheet head (see render/sheet.css), in design px: the mockup's own sizes.
 * On the page they're SHEET.k times bigger (a design px is k page px), so a head reads like the
 * mockup's beside items of the usual size.
 */
export const SHEET = {
	k: 2.5,
	/** the title row */
	head: 34,
	/** the title block: AGENT, MODEL, ITEMS, UPDATED, STATUS */
	block: 31,
	/** the subagents' row of documents (frames with subagents) */
	tray: 76,
	/** the printout (while it works) */
	printout: 37,
	/** a subagent's drawer's head */
	drawerHead: 32,
}

/** The page height of a frame's sheet head: its title row and title block, and its subagents' row and printout when it has them. */
export function sheetHeadHeight(o: { subagents?: boolean; busy?: boolean } = {}) {
	return (SHEET.head + SHEET.block + (o.subagents ? SHEET.tray : 0) + (o.busy ? SHEET.printout : 0)) * SHEET.k
}

export const LAYOUT = {
	/** widest a row of images gets before wrapping */
	maxRowWidth: 2400,
	rowHeight: 320,
	gap: 24,
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
	/** space reserved above a row that has a titled item, for its name and type tag (the text scales with zoom) */
	titleHeight: 42,
	framePadding: 32,
	/** the sheet head at the top of a frame, without subagents or a printout (see sheetHeadHeight) */
	frameHeaderHeight: sheetHeadHeight(),
	frameGap: 160,
	/** the heading above a named group, its rule included */
	groupHeadingHeight: 64,
	groupGap: 48,
	minFrameWidth: 1000,
	emptyFrameHeight: 160,
	/** a frame shows only its newest items, this many unless the viewer asks for more... */
	visibleItems: 50,
	/** ...this many more at a time */
	showMoreStep: 10,
	/** the row under the groups that says how many older items are hidden */
	moreHeight: 64,
	moreGap: 40,
	/** page-space font size of session titles: the sheet head's 14 design px */
	frameTitlePx: 14 * SHEET.k,
	/** session titles stay at least this big on screen; zoomed far out the sheet head grows upward out of the frame */
	minFrameTitlePx: 12,
}

/**
 * Where a session's title is on the page at zoom z: the header strip, from the top of the frame,
 * extended upward when the title is drawn bigger than page scale (see render/SheetHeads.ts).
 */
export function frameTitleBox(section: SectionLayout, z: number): Box {
	// (a drawer's title stays in its band)
	if (section.drawer) return { x: section.box.x, y: section.box.y, w: section.box.w, h: section.header.y + section.header.h - section.box.y }
	const grow = Math.max(1, LAYOUT.minFrameTitlePx / LAYOUT.frameTitlePx / z)
	const bottom = section.header.y + section.header.h
	const top = Math.min(section.box.y, bottom - section.header.h * grow)
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

/** Newest first; ties broken by id so the order is stable. */
export function newestFirst(a: Item, b: Item) {
	return b.createdAt - a.createdAt || b.id.localeCompare(a.id)
}

/**
 * Positions are a pure function of the data. Each session is a frame; frames sit side by side in
 * frame order (see orderSessions), and hidden sessions take no space. A frame lays out only its
 * newest `limits[sessionId]` items (LAYOUT.visibleItems by default) and says how many older ones
 * it leaves out in a row at the bottom (`more`). Inside a frame, groups stack top to bottom, the
 * one with the newest item first. Each group's items flow newest first, left to right, into
 * justified rows that keep every item's aspect ratio (frames extracted from a video follow it). A
 * frame is as wide as its widest group, so a wider row pushes every frame to its right further out.
 */
export function computeLayout(
	sessions: Record<string, Session>,
	items: Record<string, Item>,
	order?: readonly string[],
	limits?: Readonly<Record<string, number>>,
	/** sessions not laid out as frames of their own (subagents, see drawers.ts) */
	skip?: { has(sessionId: string): boolean },
	/** each frame's sheet head height (page px; see sheetHeadHeight) */
	headHeight?: (sessionId: string) => number,
): Layout {
	const L = LAYOUT
	const bySession = new Map<string, Item[]>()
	for (const item of Object.values(items)) {
		let list = bySession.get(item.sessionId)
		if (!list) bySession.set(item.sessionId, (list = []))
		list.push(item)
	}

	const ordered = orderSessions(Object.values(sessions), order).filter((s) => !s.hidden && !skip?.has(s.id))
	const layout: Layout = { sections: [], groups: [], items: new Map(), sectionOf: new Map(), groupOf: new Map(), bounds: null }
	let frameX = 0

	for (const session of ordered) {
		const all = (bySession.get(session.id) ?? []).sort(newestFirst)
		const shown = all.slice(0, Math.max(0, limits?.[session.id] ?? L.visibleItems))
		const hidden = all.length - shown.length

		// Group in first-appearance order of the newest-first list: the group with the newest item first.
		const groups = new Map<string | null, Item[]>()
		for (const item of shown) {
			const key = item.group ?? null
			if (!groups.has(key)) groups.set(key, [])
			groups.get(key)!.push(item)
		}

		// Lay out each group relative to the frame's content origin, then shift into place.
		const headH = headHeight?.(session.id) ?? L.frameHeaderHeight
		const contentX = frameX + L.framePadding
		const contentY = headH + L.framePadding
		let y = contentY
		let contentWidth = 0
		const sectionGroups: GroupLayout[] = []

		for (const [name, list] of groups) {
			const groupItems = framesAfterVideos(list)
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
		let contentHeight = sectionGroups.length ? y - L.groupGap - contentY : L.emptyFrameHeight
		let more: SectionLayout['more'] = null
		if (hidden > 0) {
			more = { box: { x: contentX, y: contentY + contentHeight + L.moreGap, w: innerWidth, h: L.moreHeight }, hidden }
			contentHeight += L.moreGap + L.moreHeight
		}
		const box = { x: frameX, y: 0, w: innerWidth + L.framePadding * 2, h: headH + contentHeight + L.framePadding * 2 }
		// Headings span the frame so long group names have room.
		for (const g of sectionGroups) if (g.heading) g.heading.w = innerWidth

		layout.sections.push({
			id: session.id,
			title: session.title,
			box,
			header: { x: frameX, y: 0, w: box.w, h: headH },
			groups: sectionGroups,
			itemIds: sectionGroups.flatMap((g) => g.itemIds),
			more,
		})
		layout.groups.push(...sectionGroups)
		frameX += box.w + L.frameGap
	}

	layout.bounds = Box.union(layout.sections.map((s) => s.box))
	return layout
}

/**
 * How many of a session's newest items a frame has to lay out to include this one (its position,
 * newest first, plus one), or 0 if the session doesn't have it.
 */
export function itemsToReveal(items: Record<string, Item>, itemId: string): number {
	const item = items[itemId]
	if (!item) return 0
	let newer = 0
	for (const other of Object.values(items)) if (other.sessionId === item.sessionId && newestFirst(other, item) < 0) newer++
	return newer + 1
}

/**
 * A group's items (newest first) with frames extracted from one of its videos moved right after
 * that video, in the order they were taken, instead of up among the newest.
 */
function framesAfterVideos(items: Item[]): Item[] {
	const videos = new Set(items.filter((i) => i.kind === 'video').map((i) => i.id))
	const frames = new Map<string, Item[]>()
	for (const item of items) {
		if (!item.sourceItemId || !videos.has(item.sourceItemId)) continue
		let list = frames.get(item.sourceItemId)
		if (!list) frames.set(item.sourceItemId, (list = []))
		list.unshift(item)
	}
	if (!frames.size) return items
	const out: Item[] = []
	for (const item of items) {
		if (item.sourceItemId && videos.has(item.sourceItemId)) continue
		out.push(item)
		const taken = frames.get(item.id)
		if (taken) out.push(...taken)
	}
	return out
}

/** The layout with one frame (and everything in it) moved by (dx, dy), e.g. while it's dragged. */
export function shiftSection(layout: Layout, id: string, dx: number, dy: number): Layout {
	const shift = (b: Box): Box => ({ x: b.x + dx, y: b.y + dy, w: b.w, h: b.h })
	const index = layout.sections.findIndex((s) => s.id === id)
	if (index < 0 || (dx === 0 && dy === 0)) return layout
	const old = layout.sections[index]
	const groups = old.groups.map((g) => ({ ...g, box: shift(g.box), heading: g.heading && shift(g.heading) }))
	const more = old.more && { ...old.more, box: shift(old.more.box) }
	const section: SectionLayout = { ...old, box: shift(old.box), header: shift(old.header), groups, more }
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
