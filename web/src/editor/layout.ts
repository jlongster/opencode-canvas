import type { Item, Session } from '../../../shared/types'
import type { Box } from './geometry'

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
	columnWidth: 720,
	gap: 16,
	sectionPadding: 24,
	sectionGap: 96,
	emptySectionHeight: 160,
	/** Space reserved above an item that has a title (page units; the text scales with zoom) */
	titleHeight: 40,
}

/**
 * Positions are a pure function of the data: each session is a column, columns run left to
 * right (newest first), and a session's items stack top to bottom at the column's width.
 */
export function computeLayout(sessions: Record<string, Session>, items: Record<string, Item>): Layout {
	const { columnWidth: W, gap, sectionPadding: pad, sectionGap } = LAYOUT
	const bySession = new Map<string, Item[]>()
	for (const item of Object.values(items)) {
		let list = bySession.get(item.sessionId)
		if (!list) bySession.set(item.sessionId, (list = []))
		list.push(item)
	}

	const ordered = Object.values(sessions).sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
	const layout: Layout = { sections: [], items: new Map(), sectionOf: new Map(), bounds: null }
	let x = 0
	let maxHeight = 0

	for (const session of ordered) {
		const list = (bySession.get(session.id) ?? []).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
		let y = pad
		for (const item of list) {
			if (item.title) y += LAYOUT.titleHeight
			const h = (item.height / item.width) * W
			layout.items.set(item.id, { x: x + pad, y, w: W, h })
			layout.sectionOf.set(item.id, session.id)
			y += h + gap
		}

		const contentHeight = list.length ? y - gap - pad : LAYOUT.emptySectionHeight
		const box = { x, y: 0, w: W + pad * 2, h: contentHeight + pad * 2 }
		layout.sections.push({ id: session.id, title: session.title, box, itemIds: list.map((i) => i.id) })
		maxHeight = Math.max(maxHeight, box.h)
		x += box.w + sectionGap
	}

	if (layout.sections.length) layout.bounds = { x: 0, y: 0, w: x - sectionGap, h: maxHeight }
	return layout
}
