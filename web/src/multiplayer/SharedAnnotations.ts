import * as Y from 'yjs'
import type { Role } from '../sync/client'
import type { AnnotationSnapshot } from '../editor/Deletions'
import type { Editor } from '../editor/Editor'
import type { Box, Vec } from '../editor/geometry'
import type { Presence } from './Presence'

/** Below this on-screen item width, annotations collapse to their dot and a badge (hover or click to open). */
const COLLAPSE_ITEM_PX = 260
/** A release closer than this (screen px) to the press is a click: the comment box opens at DEFAULT_OFFSET. */
const CLICK_PX = 12
const DEFAULT_OFFSET = { x: 56, y: -44 }
/** How long (screen px) lines of annotations without a stored length may get (see shownOffset). */
const MAX_LINE_PX = 240
/** Screen px the pointer moves before a press on a card becomes a drag. */
const DRAG_DISTANCE = 4
/** How long a card stays open after the pointer leaves its badge or card. */
const HOVER_GRACE_MS = 250
const TEXT_MAX = 4000
const SVG = 'http://www.w3.org/2000/svg'

/** A comment being written: anchored on an item, its card at (ox, oy) item widths from the anchor. */
interface Draft {
	itemId: string
	x: number
	y: number
	ox: number
	oy: number
	typing: boolean
	view: CardView
}

/**
 * Annotations: comments pinned to a spot on an item, stored in the room's Y.Doc (map
 * "annotations", see Annotation in shared/types.ts) so everyone sees them live and the server can
 * hand them to agents. Each is a line from a dot on the item to a comment card, drawn in the overlay
 * at a constant on-screen size. The anchor is normalized to the item and the card's offset is in
 * item widths, so both follow the item when the layout moves or resizes it.
 *
 * Edit links draw new ones with the annotate tool (see AnnotateTool), and can edit, move and
 * delete any of them; view links only see them.
 */
export class SharedAnnotations {
	private doc: Y.Doc
	private map: Y.Map<Y.Map<unknown>>
	private host: HTMLDivElement
	private svg: SVGSVGElement
	private views = new Map<string, CardView>()
	private draft: Draft | null = null
	/** opened by a click while collapsed (and ones we just wrote), until a press elsewhere */
	private pinned = new Set<string>()
	private hovered: string | null = null
	private hoverTimer = 0
	private disposers: (() => void)[] = []
	readonly editable: boolean

	constructor(
		private parent: HTMLElement,
		readonly editor: Editor,
		private presence: Presence,
		role: Role,
	) {
		this.editable = role === 'edit'
		this.doc = presence.doc
		this.map = presence.doc.getMap('annotations')
		this.host = document.createElement('div')
		this.host.className = 'annotation-layer'
		this.svg = document.createElementNS(SVG, 'svg')
		this.svg.classList.add('annotation-lines')
		this.host.appendChild(this.svg)
		parent.appendChild(this.host)

		const onChange = () => this.sync()
		this.map.observeDeep(onChange)
		this.disposers.push(() => this.map.unobserveDeep(onChange))
		this.sync()

		if (this.editable) {
			editor.annotationDrafts = {
				begin: (itemId, anchor) => this.beginDraft(itemId, anchor),
				move: (point) => this.moveDraft(point),
				finish: (point) => this.finishDraft(point),
				cancel: () => this.cancelDraft(),
			}
			editor.deletions.annotations = { remove: (ids) => this.remove(ids), restore: (snaps) => this.restore(snaps) }
			this.disposers.push(() => {
				editor.annotationDrafts = null
				editor.deletions.annotations = null
				if (editor.toolPath.peek().startsWith('annotate')) editor.setCurrentTool('select')
			})
		}
		this.disposers.push(editor.onFrame(() => this.position()))
		// A press anywhere else closes cards opened by a click.
		const container = parent.parentElement ?? parent
		const onDown = () => {
			if (this.pinned.size) this.pinned.clear()
		}
		container.addEventListener('pointerdown', onDown)
		this.disposers.push(() => container.removeEventListener('pointerdown', onDown))
		const timer = window.setInterval(() => {
			for (const view of this.views.values()) view.updateTime()
		}, 30_000)
		this.disposers.push(() => clearInterval(timer))
	}

	destroy() {
		for (const d of this.disposers.splice(0)) d()
		clearTimeout(this.hoverTimer)
		this.draft?.view.destroy()
		this.draft = null
		for (const view of this.views.values()) view.destroy()
		this.views.clear()
		this.host.remove()
	}

	// ---------- drafts ----------

	private beginDraft(itemId: string, anchor: Vec) {
		this.cancelDraft()
		const me = this.presence.me.peek()
		const view = new CardView(this, null, true)
		view.showDraft(me.name, me.color)
		this.draft = { itemId, x: anchor.x, y: anchor.y, ox: 0, oy: 0, typing: false, view }
		this.addView(view)
	}

	private moveDraft(point: Vec) {
		const d = this.draft
		const box = d && this.itemBox(d.itemId)
		if (!d || !box) return
		d.ox = (point.x - (box.x + d.x * box.w)) / box.w
		d.oy = (point.y - (box.y + d.y * box.h)) / box.w
	}

	private finishDraft(point: Vec) {
		const d = this.draft
		const box = d && this.itemBox(d.itemId)
		if (!d || !box) return this.cancelDraft()
		this.moveDraft(point)
		const z = this.editor.getZoom()
		if (Math.hypot(d.ox * box.w * z, d.oy * box.w * z) < CLICK_PX) {
			d.ox = DEFAULT_OFFSET.x / z / box.w
			d.oy = DEFAULT_OFFSET.y / z / box.w
		}
		d.typing = true
		d.view.startTyping()
	}

	/** Drops the draft (only if it's still `view`'s, when given: a stale box's blur mustn't cancel a newer draft). */
	cancelDraft(view?: CardView) {
		const d = this.draft
		if (!d || (view && d.view !== view)) return
		this.draft = null
		d.view.destroy()
	}

	/** Enter in the draft's box: saves it if there's any text. */
	commitDraft(view: CardView, text: string) {
		const d = this.draft
		if (!d || d.view !== view) return
		this.draft = null
		d.view.destroy()
		const trimmed = text.trim().slice(0, TEXT_MAX)
		const box = this.itemBox(d.itemId)
		if (!trimmed || !box) return
		const me = this.presence.me.peek()
		const id = annotationId()
		const a = new Y.Map<unknown>()
		this.doc.transact(() => {
			a.set('itemId', d.itemId)
			a.set('x', d.x)
			a.set('y', d.y)
			a.set('ox', d.ox)
			a.set('oy', d.oy)
			a.set('len', Math.round(this.screenLength(box, d.ox, d.oy)))
			a.set('text', trimmed)
			a.set('author', me.name)
			a.set('color', me.color)
			a.set('createdAt', Date.now())
			this.map.set(id, a)
		})
		this.pinned.add(id)
	}

	// ---------- the document ----------

	private remove(ids: string[]): AnnotationSnapshot[] {
		const snapshots: AnnotationSnapshot[] = []
		this.doc.transact(() => {
			for (const id of ids) {
				const a = this.map.get(id)
				if (!a) continue
				snapshots.push({ id, fields: Object.fromEntries(a.entries()) })
				this.map.delete(id)
			}
		})
		return snapshots
	}

	private restore(snapshots: AnnotationSnapshot[]) {
		this.doc.transact(() => {
			for (const { id, fields } of snapshots) {
				if (this.map.has(id)) continue
				const a = new Y.Map<unknown>()
				for (const [key, value] of Object.entries(fields)) a.set(key, value)
				this.map.set(id, a)
			}
		})
	}

	setText(id: string, text: string) {
		const a = this.map.get(id)
		const trimmed = text.trim().slice(0, TEXT_MAX)
		if (!a || !trimmed || trimmed === a.get('text')) return
		this.doc.transact(() => {
			a.set('text', trimmed)
			a.set('updatedAt', Date.now())
		})
	}

	setOffset(id: string, box: Box, ox: number, oy: number) {
		const a = this.map.get(id)
		if (!a) return
		this.doc.transact(() => {
			a.set('ox', ox)
			a.set('oy', oy)
			a.set('len', Math.round(this.screenLength(box, ox, oy)))
		})
	}

	delete(id: string) {
		this.editor.deletions.deleteAnnotations([id])
	}

	/** Create, update and remove views to match the document. */
	private sync() {
		const live = new Set<string>()
		for (const [id, a] of this.map.entries()) {
			if (!(a instanceof Y.Map)) continue
			live.add(id)
			let view = this.views.get(id)
			if (!view) {
				view = new CardView(this, id, this.editable)
				this.views.set(id, view)
				this.addView(view)
			}
			view.update(a)
		}
		for (const [id, view] of this.views) {
			if (live.has(id)) continue
			view.destroy()
			this.views.delete(id)
			this.pinned.delete(id)
		}
	}

	private addView(view: CardView) {
		this.svg.appendChild(view.lines)
		this.host.appendChild(view.badge)
		this.host.appendChild(view.card)
	}

	// ---------- layout ----------

	itemBox(itemId: string): Box | undefined {
		return this.editor.layout.get().items.get(itemId)
	}

	private position() {
		const { w, h } = this.editor.viewport.peek()
		this.svg.setAttribute('viewBox', `0 0 ${w} ${h}`)
		const z = this.editor.getZoom()
		for (const [id, view] of this.views) {
			const a = view.data
			const box = a && this.itemBox(a.itemId)
			if (!a || !box) {
				view.hide()
				continue
			}
			// Small on screen: just the dot and a badge, which stays put while its card is open so the
			// pointer can stay on it.
			const small = box.w * z < COLLAPSE_ITEM_PX
			view.place(this.points(box, a), !small || this.pinned.has(id) || this.hovered === id || view.busy, small)
		}
		const d = this.draft
		const box = d && this.itemBox(d.itemId)
		if (d && box) d.view.place(this.points(box, d), d.typing, false)
		else if (d) this.cancelDraft()
	}

	/**
	 * The card's offset as drawn: as stored, but never longer on screen than when it was drawn or
	 * last moved (len), so zoomed in on an item its comments stay beside the spot instead of flying
	 * off the screen. Zoomed out, the line shrinks with the item.
	 */
	shownOffset(box: Box, ox: number, oy: number, max = MAX_LINE_PX) {
		const len = this.screenLength(box, ox, oy)
		const k = len > max ? max / len : 1
		return { ox: ox * k, oy: oy * k }
	}

	screenLength(box: Box, ox: number, oy: number) {
		return Math.hypot(ox, oy) * box.w * this.editor.getZoom()
	}

	/** Screen points of an annotation's anchor and its card end. */
	private points(box: Box, a: { x: number; y: number; ox: number; oy: number; len?: number }) {
		const anchor = { x: box.x + a.x * box.w, y: box.y + a.y * box.h }
		const { ox, oy } = a.len === undefined ? a : this.shownOffset(box, a.ox, a.oy, a.len)
		const end = { x: anchor.x + ox * box.w, y: anchor.y + oy * box.w }
		return { anchor: this.editor.pageToScreen(anchor), end: this.editor.pageToScreen(end), box }
	}

	/** Page point under a pointer event. */
	pagePoint(e: PointerEvent): Vec {
		const rect = this.parent.getBoundingClientRect()
		return this.editor.screenToPage({ x: e.clientX - rect.left, y: e.clientY - rect.top })
	}

	setHovered(id: string | null) {
		clearTimeout(this.hoverTimer)
		if (id !== null) this.hovered = id
		else this.hoverTimer = window.setTimeout(() => (this.hovered = null), HOVER_GRACE_MS)
	}

	togglePinned(id: string) {
		if (this.pinned.has(id)) this.pinned.delete(id)
		else this.pinned.add(id)
	}
}

interface AnnotationData {
	itemId: string
	x: number
	y: number
	ox: number
	oy: number
	text: string
	author: string
	color: string
	createdAt: number
	updatedAt?: number
	/** screen px of the line when it was drawn or last moved (see shownOffset) */
	len: number
}

/** One annotation (or the draft): its line and dot in the shared SVG, its collapsed badge and its card. */
class CardView {
	readonly lines: SVGGElement
	readonly badge: HTMLDivElement
	readonly card: HTMLDivElement
	data: AnnotationData | null = null
	private shadow: SVGLineElement
	private line: SVGLineElement
	private dot: SVGCircleElement
	private author: HTMLSpanElement
	private time: HTMLSpanElement
	private text: HTMLDivElement
	private input: HTMLTextAreaElement | null = null
	private dragging = false
	private lastKey = ''
	private shown = ''

	constructor(
		private owner: SharedAnnotations,
		readonly id: string | null,
		private editable: boolean,
	) {
		this.lines = document.createElementNS(SVG, 'g')
		this.shadow = document.createElementNS(SVG, 'line')
		this.shadow.classList.add('annotation-line-shadow')
		this.line = document.createElementNS(SVG, 'line')
		this.line.classList.add('annotation-line')
		this.dot = document.createElementNS(SVG, 'circle')
		this.dot.classList.add('annotation-dot')
		this.dot.setAttribute('r', '5')
		this.lines.append(this.shadow, this.line, this.dot)

		this.badge = document.createElement('div')
		this.badge.className = 'annotation-badge'
		this.card = document.createElement('div')
		this.card.className = 'annotation-card'
		this.card.innerHTML =
			'<div class="annotation-head"><span class="annotation-swatch"></span><span class="annotation-author"></span>' +
			'<span class="annotation-time"></span>' +
			(editable && id ? '<button class="annotation-edit" title="Edit">Edit</button><button class="annotation-delete" title="Delete">×</button>' : '') +
			'</div><div class="annotation-text"></div>'
		this.author = this.card.querySelector('.annotation-author')!
		this.time = this.card.querySelector('.annotation-time')!
		this.text = this.card.querySelector('.annotation-text')!

		for (const el of [this.badge, this.card]) {
			el.addEventListener('pointerdown', (e) => this.onPointerDown(e, el === this.badge))
			el.addEventListener('dblclick', (e) => {
				e.stopPropagation()
				if (el === this.card && this.editable && this.id && !this.input) this.startEditing()
			})
			if (id) {
				el.addEventListener('pointerenter', () => owner.setHovered(id))
				el.addEventListener('pointerleave', () => owner.setHovered(null))
			}
		}
		this.card.querySelector('.annotation-edit')?.addEventListener('click', () => this.startEditing())
		this.card.querySelector('.annotation-delete')?.addEventListener('click', () => this.id && owner.delete(this.id))
	}

	/** Busy views stay open whatever the zoom: being typed in or dragged. */
	get busy() {
		return this.input !== null || this.dragging
	}

	update(a: Y.Map<unknown>) {
		const updatedAt = Number(a.get('updatedAt') ?? 0) || undefined
		this.data = {
			itemId: String(a.get('itemId') ?? ''),
			x: Number(a.get('x') ?? 0) || 0,
			y: Number(a.get('y') ?? 0) || 0,
			ox: Number(a.get('ox') ?? 0) || 0,
			oy: Number(a.get('oy') ?? 0) || 0,
			text: String(a.get('text') ?? ''),
			author: String(a.get('author') ?? ''),
			color: String(a.get('color') ?? '#f87171'),
			createdAt: Number(a.get('createdAt') ?? 0) || 0,
			updatedAt,
			len: Number(a.get('len') ?? MAX_LINE_PX) || MAX_LINE_PX,
		}
		const d = this.data
		this.setColor(d.color)
		if (this.author.textContent !== d.author) this.author.textContent = d.author || 'Someone'
		if (!this.input && this.text.textContent !== d.text) this.text.textContent = d.text
		this.badge.textContent = (d.author.trim()[0] ?? '?').toUpperCase()
		this.badge.title = `${d.author}: ${d.text}`
		this.updateTime()
	}

	updateTime() {
		const d = this.data
		if (!d) return
		const t = relativeTime(d.createdAt) + (d.updatedAt ? ' · edited' : '')
		if (this.time.textContent !== t) this.time.textContent = t
		this.time.title = new Date(d.updatedAt ?? d.createdAt).toLocaleString()
	}

	/** The draft: our name and colour, no text yet (the box opens on release, see startTyping). */
	showDraft(author: string, color: string) {
		this.setColor(color)
		this.author.textContent = author
		this.time.textContent = ''
		this.card.classList.add('draft')
	}

	startTyping() {
		this.openInput('', (text) => this.owner.commitDraft(this, text), () => this.owner.cancelDraft(this))
	}

	private startEditing() {
		const d = this.data
		if (!d || !this.id) return
		const id = this.id
		this.openInput(d.text, (text) => {
			this.closeInput()
			this.owner.setText(id, text)
		}, () => this.closeInput())
	}

	/** Swap the text for a box: Enter saves (Shift+Enter is a new line), Escape cancels, and so does leaving it empty. */
	private openInput(value: string, save: (text: string) => void, cancel: () => void) {
		if (this.input) return
		const input = document.createElement('textarea')
		input.className = 'annotation-input'
		input.placeholder = 'Add a comment…'
		input.rows = 1
		input.maxLength = TEXT_MAX
		input.value = value
		input.spellcheck = false
		this.input = input
		this.text.replaceWith(input)
		this.card.classList.add('editing')
		const fit = () => {
			input.style.height = 'auto'
			input.style.height = `${Math.min(input.scrollHeight, 220)}px`
		}
		let done = false
		const finish = (keep: boolean) => {
			if (done) return
			done = true
			if (keep && input.value.trim()) save(input.value)
			else cancel()
		}
		input.addEventListener('input', fit)
		input.addEventListener('keydown', (e) => {
			e.stopPropagation()
			if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
				e.preventDefault()
				finish(true)
			} else if (e.key === 'Escape') {
				e.preventDefault()
				finish(false)
			}
		})
		input.addEventListener('blur', () => finish(true))
		// The press that opened it would otherwise move focus straight back to the page.
		requestAnimationFrame(() => {
			fit()
			input.focus()
			input.setSelectionRange(input.value.length, input.value.length)
		})
	}

	private closeInput() {
		if (!this.input) return
		const input = this.input
		this.input = null
		input.replaceWith(this.text)
		this.card.classList.remove('editing')
		if (this.data) this.text.textContent = this.data.text
	}

	private setColor(color: string) {
		this.card.style.setProperty('--author', color)
		this.badge.style.setProperty('--author', color)
		this.line.style.stroke = color
		this.dot.style.fill = color
	}

	hide() {
		if (this.lastKey === 'hidden') return
		this.lastKey = 'hidden'
		this.lines.style.display = 'none'
		this.badge.style.display = 'none'
		this.card.style.display = 'none'
		this.shown = ''
	}

	place({ anchor, end }: { anchor: Vec; end: Vec }, open: boolean, badge: boolean) {
		const key = `${anchor.x.toFixed(1)},${anchor.y.toFixed(1)},${end.x.toFixed(1)},${end.y.toFixed(1)},${open},${badge}`
		if (key === this.lastKey) return
		this.lastKey = key
		const state = `${open},${badge}`
		if (state !== this.shown) {
			this.shown = state
			this.lines.style.display = ''
			this.badge.style.display = badge ? '' : 'none'
			this.card.style.display = open ? '' : 'none'
			this.line.style.display = this.shadow.style.display = open ? '' : 'none'
		}
		this.dot.setAttribute('cx', String(anchor.x))
		this.dot.setAttribute('cy', String(anchor.y))
		if (badge) this.badge.style.transform = `translate(${anchor.x + 3}px, ${anchor.y - 3}px) translate(0, -100%)`
		if (!open) return
		// Opened from its badge: the card sits beside the badge, without the (tiny) line.
		this.line.style.display = this.shadow.style.display = badge ? 'none' : ''
		if (badge) {
			this.card.style.transform = `translate(${anchor.x + 3 + this.badge.offsetWidth + 6}px, ${anchor.y - 3}px) translate(0, -100%)`
			return
		}
		for (const l of [this.shadow, this.line]) {
			l.setAttribute('x1', String(anchor.x))
			l.setAttribute('y1', String(anchor.y))
			l.setAttribute('x2', String(end.x))
			l.setAttribute('y2', String(end.y))
		}
		// The card hangs off the line's end, away from the anchor: by its near side's middle when the
		// line is mostly horizontal, by its top or bottom middle when it's mostly vertical.
		const dx = end.x - anchor.x
		const dy = end.y - anchor.y
		const shift = Math.abs(dx) >= Math.abs(dy) ? `${dx < 0 ? '-100%' : '0'}, -50%` : `-50%, ${dy < 0 ? '-100%' : '0'}`
		this.card.style.transform = `translate(${end.x}px, ${end.y}px) translate(${shift})`
	}

	destroy() {
		this.lines.remove()
		this.badge.remove()
		this.card.remove()
	}

	/**
	 * A press on the card or badge: the canvas underneath never sees it. Dragging moves the card
	 * (edit links); a click on a collapsed badge keeps the card open.
	 */
	private onPointerDown(e: PointerEvent, onBadge: boolean) {
		if (e.button === 1 || this.owner.editor.inputs.isSpaceDown) return
		e.stopPropagation()
		if (e.button !== 0) return
		const target = e.target as HTMLElement
		if (target.tagName === 'BUTTON' || target.tagName === 'TEXTAREA') return
		const id = this.id
		const box = this.data && this.owner.itemBox(this.data.itemId)
		if (!id || !this.data || !box) return
		// Keep focus where it is (a click shouldn't blur someone's typing elsewhere into a save).
		e.preventDefault()
		const el = e.currentTarget as HTMLElement
		const start = this.owner.shownOffset(box, this.data.ox, this.data.oy, this.data.len)
		const origin = this.owner.pagePoint(e)
		const originScreen = { x: e.clientX, y: e.clientY }
		let moved = false
		el.setPointerCapture(e.pointerId)

		const move = (ev: PointerEvent) => {
			if (ev.pointerId !== e.pointerId || !this.editable || onBadge) return
			if (!moved && Math.hypot(ev.clientX - originScreen.x, ev.clientY - originScreen.y) < DRAG_DISTANCE) return
			if (!moved) {
				moved = true
				this.dragging = true
				this.card.classList.add('dragging')
			}
			const p = this.owner.pagePoint(ev)
			this.owner.setOffset(id, box, start.ox + (p.x - origin.x) / box.w, start.oy + (p.y - origin.y) / box.w)
		}
		const end = (ev: PointerEvent) => {
			if (ev.pointerId !== e.pointerId) return
			if (el.hasPointerCapture(ev.pointerId)) el.releasePointerCapture(ev.pointerId)
			el.removeEventListener('pointermove', move)
			el.removeEventListener('pointerup', end)
			el.removeEventListener('pointercancel', end)
			this.dragging = false
			this.card.classList.remove('dragging')
			if (!moved && ev.type === 'pointerup' && onBadge) this.owner.togglePinned(id)
		}
		el.addEventListener('pointermove', move)
		el.addEventListener('pointerup', end)
		el.addEventListener('pointercancel', end)
	}
}

/** "just now", "5m ago", "3h ago", "2d ago", then the date. */
function relativeTime(ms: number) {
	const s = (Date.now() - ms) / 1000
	if (s < 60) return 'just now'
	if (s < 3600) return `${Math.floor(s / 60)}m ago`
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`
	if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`
	return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** crypto.randomUUID only exists in secure contexts; fall back to getRandomValues. */
function annotationId() {
	if (typeof crypto.randomUUID === 'function') return crypto.randomUUID().slice(0, 12)
	const bytes = crypto.getRandomValues(new Uint8Array(6))
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
