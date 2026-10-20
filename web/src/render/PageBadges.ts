import type { Item } from '../../../shared/types'
import { Box } from '../editor/geometry'
import type { Editor } from '../editor/Editor'
import './pageBadges.css'

/** Badges only show on page items at least this big on screen. */
const MIN_W_PX = 200
const MIN_H_PX = 100
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
 * Over each page item on screen: a small badge in its bottom-left corner with the page's domain
 * and an external-link mark (at a constant size on screen, hidden when the item is small), and,
 * while it has no snapshot yet, a "Loading snapshot…" (or failure) note in its middle. They never
 * take input: the hover Open button opens the page.
 */
export class PageBadges {
	private host: HTMLDivElement
	private els = new Map<string, { badge: HTMLDivElement; note: HTMLDivElement; key: string }>()

	constructor(parent: HTMLElement) {
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
			const pending = !item.src
			if (!pending && (w < MIN_W_PX || h < MIN_H_PX)) continue
			seen.add(id)
			let el = this.els.get(id)
			if (!el) {
				const badge = document.createElement('div')
				badge.className = 'page-badge'
				const note = document.createElement('div')
				note.className = 'page-note'
				this.host.append(note, badge)
				el = { badge, note, key: '' }
				this.els.set(id, el)
			}
			const status = item.page?.status ?? 'ready'
			const key = `${pageDomain(item)}|${status}|${pending}|${item.page?.error ?? ''}`
			if (el.key !== key) {
				el.key = key
				const state = status === 'loading' ? (pending ? '' : ' · refreshing…') : status === 'failed' && !pending ? ' · refresh failed' : ''
				el.badge.innerHTML = `<span class="domain"></span><span class="state"></span>${EXTERNAL_ICON}`
				el.badge.children[0].textContent = pageDomain(item)
				el.badge.children[1].textContent = state
				el.badge.title = item.page?.error ? `Last snapshot failed: ${item.page.error}` : (item.pageUrl ?? '')
				el.badge.classList.toggle('failed', status === 'failed')
				el.note.textContent = !pending ? '' : status === 'failed' ? `Couldn't take a snapshot${item.page?.error ? `: ${item.page.error}` : ''}` : 'Loading snapshot…'
				el.note.classList.toggle('failed', status === 'failed')
				el.note.classList.toggle('loading', status === 'loading')
			}
			const p = editor.pageToScreen(d)
			const small = w < MIN_W_PX || h < MIN_H_PX
			el.badge.style.display = small ? 'none' : ''
			// In the bottom-left corner, or the bottom of the screen while a tall page runs past it.
			const bottom = Math.max(p.y + Math.min(h, 40), Math.min(p.y + h, editor.viewport.peek().h - BOTTOM_CLEAR_PX))
			el.badge.style.transform = `translate(${p.x + 8}px, calc(${bottom - 8}px - 100%))`
			el.badge.style.maxWidth = `${Math.max(0, w - 16)}px`
			el.badge.style.opacity = String(d.opacity)
			el.note.style.display = pending && w >= 60 && h >= 30 ? '' : 'none'
			el.note.style.transform = `translate(${p.x}px, ${p.y}px)`
			el.note.style.width = `${w}px`
			el.note.style.height = `${h}px`
			el.note.style.fontSize = `${Math.max(10, Math.min(14, 13 * z * 1.5))}px`
		}
		for (const [id, el] of this.els) {
			if (seen.has(id)) continue
			el.badge.remove()
			el.note.remove()
			this.els.delete(id)
		}
	}

	destroy() {
		this.host.remove()
	}
}
