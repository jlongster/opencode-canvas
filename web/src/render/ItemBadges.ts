import type { Item } from '../../../shared/types'
import { Box } from '../editor/geometry'
import type { Editor } from '../editor/Editor'
import { inContext } from '../multiplayer/itemAttachments'
import './itemBadges.css'

/** Badges only show on items at least this big on screen. */
const MIN_W_PX = 120
const MIN_H_PX = 60

/**
 * Over each item a person dragged onto its frame (Item.origin 'person'), on screen: a small chip
 * in its top-left corner with who added it, and whether its session has it: a hollow ring until
 * it's sent (with the next prompt or Submit annotations), a filled dot once it is. Items the
 * session posted have none.
 */
export class ItemBadges {
	private host: HTMLDivElement
	private els = new Map<string, { el: HTMLDivElement; key: string }>()

	constructor(parent: HTMLElement) {
		this.host = document.createElement('div')
		this.host.className = 'item-badges'
		parent.appendChild(this.host)
	}

	update(items: Record<string, Item>, displayed: Map<string, { x: number; y: number; w: number; h: number; opacity: number }>, view: Box, editor: Editor) {
		const z = editor.camera.peek().z
		const seen = new Set<string>()
		for (const [id, d] of displayed) {
			const item = items[id]
			if (item?.origin !== 'person' || !Box.intersects(d, view)) continue
			const w = d.w * z
			if (w < MIN_W_PX || d.h * z < MIN_H_PX) continue
			seen.add(id)
			let entry = this.els.get(id)
			if (!entry) {
				const el = document.createElement('div')
				el.className = 'item-badge'
				el.innerHTML = '<span class="mark"></span><span class="who"></span>'
				this.host.appendChild(el)
				entry = { el, key: '' }
				this.els.set(id, entry)
			}
			const sent = inContext(item)
			const who = item.addedBy || 'someone'
			const key = `${who}|${sent}|${item.delivered?.at ?? 0}`
			if (entry.key !== key) {
				entry.key = key
				entry.el.classList.toggle('sent', sent)
				entry.el.children[1].textContent = who
				entry.el.title = sent
					? `Added by ${who} · sent to the session at ${new Date(item.delivered!.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
					: `Added by ${who} · not sent yet. It goes with your next prompt or Submit annotations`
			}
			const p = editor.pageToScreen(d)
			entry.el.style.transform = `translate(${Math.round(p.x + 8)}px, ${Math.round(p.y + 8)}px)`
			entry.el.style.maxWidth = `${Math.max(0, w - 16)}px`
			entry.el.style.opacity = String(d.opacity)
		}
		for (const [id, entry] of this.els) {
			if (seen.has(id)) continue
			entry.el.remove()
			this.els.delete(id)
		}
	}

	destroy() {
		this.host.remove()
	}
}
