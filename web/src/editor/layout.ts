import type { Item, Session } from '../../../shared/types'
import { Box } from './geometry'

export interface SectionLayout {
	id: string
	title: string
	box: Box
	itemIds: string[]
}

export interface Layout {
	sections: SectionLayout[]
	items: Map<string, Box>
	/** item id -> section id */
	sectionOf: Map<string, string>
	bounds: Box | null
}

export const LAYOUT = {
	contentWidth: 2400,
	rowHeight: 320,
	gap: 16,
	sectionPadding: 32,
	sectionGap: 120,
	emptySectionHeight: 160,
	emptySectionWidth: 480,
	/** Space reserved above a row that has a titled item (page units; the text scales with zoom) */
	titleHeight: 40,
}

/**
 * Positions are a pure function of the data: sessions are stacked vertically (newest first),
 * and each session's items flow left to right into justified rows that keep every item's
 * aspect ratio.
 */
export function computeLayout(sessions: Record<string, Session>, items: Record<string, Item>): Layout {
	const { contentWidth: W, rowHeight: H, gap, sectionPadding: pad, sectionGap, titleHeight } = LAYOUT
	const bySession = new Map<string, Item[]>()
	for (const item of Object.values(items)) {
		let list = bySession.get(item.sessionId)
		if (!list) bySession.set(item.sessionId, (list = []))
		list.push(item)
	}

	const ordered = Object.values(sessions).sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
	const layout: Layout = { sections: [], items: new Map(), sectionOf: new Map(), bounds: null }
	let y = 0

	for (const session of ordered) {
		const list = (bySession.get(session.id) ?? []).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
		const top = y
		let rowY = y + pad
		let row: Item[] = []
		let rowAspect = 0
		// The section is as wide as its widest row, so a short last-and-only row doesn't leave empty background.
		let contentWidth = 0

		const placeRow = (height: number) => {
			if (row.some((item) => item.title)) rowY += titleHeight
			let x = pad
			for (const item of row) {
				const w = (item.width / item.height) * height
				layout.items.set(item.id, { x, y: rowY, w, h: height })
				layout.sectionOf.set(item.id, session.id)
				x += w + gap
			}
			contentWidth = Math.max(contentWidth, x - gap - pad)
			rowY += height + gap
			row = []
			rowAspect = 0
		}

		for (const item of list) {
			row.push(item)
			rowAspect += item.width / item.height
			const naturalWidth = rowAspect * H + gap * (row.length - 1)
			if (naturalWidth >= W) placeRow((W - gap * (row.length - 1)) / rowAspect)
		}
		if (row.length) placeRow(H)

		const contentHeight = list.length ? rowY - gap - (y + pad) : LAYOUT.emptySectionHeight
		const width = list.length ? contentWidth : LAYOUT.emptySectionWidth
		const box = { x: 0, y: top, w: width + pad * 2, h: contentHeight + pad * 2 }
		layout.sections.push({ id: session.id, title: session.title, box, itemIds: list.map((i) => i.id) })
		y = top + box.h + sectionGap
	}

	layout.bounds = Box.union(layout.sections.map((s) => s.box))
	return layout
}
