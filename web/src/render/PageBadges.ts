import type { Item } from '../../../shared/types'
import { Box } from '../editor/geometry'
import type { Editor } from '../editor/Editor'
import { linkCardOpenBox } from './linkCard'
import './pageBadges.css'

/** Badges only show on page items at least this big on screen. */
const MIN_W_PX = 200
const MIN_H_PX = 100
/** A link card's Open button only takes clicks when the card is at least this big on screen. */
const MIN_CARD_W_PX = 160
const MIN_CARD_H_PX = 100
/** a tall page's badge stays this far above the bottom of the screen (clear of the frames list) */
const BOTTOM_CLEAR_PX = 56

export const EXTERNAL_ICON =
	'<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6"/><path d="M20 4 10.5 13.5"/><path d="M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/></svg>'

/** "example.com" from a page item's URL (no "www.") */
export function pageDomain(item: Pick<Item, 'pageUrl' | 'page'>): string {
	try {
		return new URL(item.pageUrl ?? item.page?.url ?? '').hostname.replace(/^www\./, '')
	} catch {
		return 'web page'
	}
}

/**
 * Over each page item on screen: with a screenshot, a small badge in its bottom-left corner with the
 * page's domain and an external-link mark (at a constant size on screen, hidden when the item is
 * small; it never takes input: the hover Open button opens the page); without one, a button on the
 * link card's drawn "Open ↗" (see linkCard.ts) that opens the page.
 */
export class PageBadges {
	private host: HTMLDivElement
	private els = new Map<string, { badge: HTMLDivElement; open: HTMLButtonElement; key: string; item: Item }>()

	constructor(
		parent: HTMLElement,
		private onOpen: (item: Item) => void,
	) {
		this.host = document.createElement('div')
		this.host.className = 'page-badges'
		parent.appendChild(this.host)
	}

	update(items: Record<string, Item>, displayed: Map<string, { x: number; y: number; w: number; h: number; opacity: number }>, view: Box, editor: Editor) {
		const z = editor.camera.peek().z
		const seen = new Set<string>()
		for (const [id, d] of displayed) {
			const item = items[id]
			if (item?.kind !== 'page' || !Box.intersects(d, view)) continue
			const w = d.w * z
			const h = d.h * z
			const card = !item.src
			if (w < (card ? MIN_CARD_W_PX : MIN_W_PX) || h < (card ? MIN_CARD_H_PX : MIN_H_PX)) continue
			seen.add(id)
			let el = this.els.get(id)
			if (!el) {
				const badge = document.createElement('div')
				badge.className = 'page-badge'
				const open = document.createElement('button')
				open.className = 'page-card-open'
				open.setAttribute('aria-label', 'Open')
				open.addEventListener('pointerdown', (e) => e.stopPropagation())
				open.addEventListener('dblclick', (e) => e.stopPropagation())
				open.addEventListener('click', (e) => {
					e.stopPropagation()
					const current = this.els.get(id)
					if (current) this.onOpen(current.item)
				})
				this.host.append(open, badge)
				el = { badge, open, key: '', item }
				this.els.set(id, el)
			}
			el.item = item
			const key = `${pageDomain(item)}|${item.pageUrl ?? ''}`
			if (el.key !== key) {
				el.key = key
				el.badge.innerHTML = `<span class="domain"></span>${EXTERNAL_ICON}`
				el.badge.children[0].textContent = pageDomain(item)
				el.badge.title = item.pageUrl ?? ''
				el.open.title = `Open ${item.pageUrl ?? pageDomain(item)} in a new tab`
			}
			const p = editor.pageToScreen(d)
			el.badge.style.display = card ? 'none' : ''
			el.open.style.display = card ? '' : 'none'
			if (card) {
				const b = linkCardOpenBox(item.width, item.height)
				el.open.style.transform = `translate(${p.x + b.x * w}px, ${p.y + b.y * h}px)`
				el.open.style.width = `${b.w * w}px`
				el.open.style.height = `${b.h * h}px`
				el.open.style.opacity = String(d.opacity)
				continue
			}
			// In the bottom-left corner, or the bottom of the screen while a tall page runs past it.
			const bottom = Math.max(p.y + Math.min(h, 40), Math.min(p.y + h, editor.viewport.peek().h - BOTTOM_CLEAR_PX))
			el.badge.style.transform = `translate(${p.x + 8}px, calc(${bottom - 8}px - 100%))`
			el.badge.style.maxWidth = `${Math.max(0, w - 16)}px`
			el.badge.style.opacity = String(d.opacity)
		}
		for (const [id, el] of this.els) {
			if (seen.has(id)) continue
			el.badge.remove()
			el.open.remove()
			this.els.delete(id)
		}
	}

	destroy() {
		this.host.remove()
	}
}
