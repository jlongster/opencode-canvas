import * as Y from 'yjs'
import type { Role } from '../sync/client'
import type { AnnotationSnapshot } from '../editor/Deletions'
import type { Editor } from '../editor/Editor'
import type { Box, Vec } from '../editor/geometry'
import type { Presence } from './Presence'
import '../ui/annotations.css'

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
/** Radius (screen px) of the anchor's ring; the line starts at its edge. */
const RING_R = 6
/** Gap (screen px) between the anchor and its collapsed number chip. */
const BADGE_GAP = 9
/**
 * Annotations an agent read (consumed, see consume): its creature visits at most this many in turn,
 * waiting up to VISIT_MS for it to get to each (close: within VISIT_NEAR_PX screen px of the anchor),
 * then the annotation shrinks into it over PICKUP_MS. The rest fade out over FADE_MS.
 */
const MAX_VISITS = 6
const VISIT_MS = 1300
const VISIT_NEAR_PX = 110
const VISIT_SETTLE_MS = 90
const PICKUP_MS = 320
const FADE_MS = 280
/** a removal from elsewhere waits this long for the annotations_consumed event that may explain it */
const ORPHAN_WAIT_MS = 400

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
	/** views going away (consumed by an agent, or removed elsewhere), kept until their animation ends */
	private leaving = new Set<string>()
	/** removed elsewhere, waiting a moment in case it was consumed (see ORPHAN_WAIT_MS) */
	private orphans = new Map<string, number>()
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

		const onChange = (_: unknown, tx: Y.Transaction) => this.sync(!tx.local)
		this.map.observeDeep(onChange)
		this.disposers.push(() => this.map.unobserveDeep(onChange))
		this.sync()

		editor.annotationsConsumed = (ids, sessionId) => void this.consume(ids, sessionId)
		this.disposers.push(() => {
			editor.annotationsConsumed = null
			for (const t of this.orphans.values()) clearTimeout(t)
		})

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
		// Drawn right away (not on the next frame) so the dot and line show with the press.
		this.placeDraft()
	}

	private moveDraft(point: Vec) {
		const d = this.draft
		const box = d && this.itemBox(d.itemId)
		if (!d || !box) return
		d.ox = (point.x - (box.x + d.x * box.w)) / box.w
		d.oy = (point.y - (box.y + d.y * box.h)) / box.w
		this.placeDraft()
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
		this.placeDraft()
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

	/**
	 * An agent read these annotations, and they're about to go from the document (or just went):
	 * with its creature on the canvas, it glides over to each in turn and the annotation shrinks into
	 * it; otherwise (or for ones off-screen, or too many) they fade out.
	 */
	private async consume(ids: string[], sessionId?: string) {
		const views = ids
			.filter((id) => this.views.has(id) && !this.leaving.has(id))
			.map((id) => this.views.get(id)!)
			.sort((a, b) => a.data!.createdAt - b.data!.createdAt)
		for (const view of views) {
			this.leaving.add(view.id!)
			clearTimeout(this.orphans.get(view.id!))
			this.orphans.delete(view.id!)
			view.setLeaving()
		}
		const creatures = this.editor.creatures
		const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
		const fade: CardView[] = []
		let visits = 0
		for (const view of views) {
			const anchor = this.anchorOf(view)
			const can = !still && sessionId && creatures?.at(sessionId) && anchor && visits < MAX_VISITS && this.onScreen(anchor)
			if (!can) {
				fade.push(view)
				continue
			}
			visits++
			creatures!.reaching.set(sessionId!, anchor!)
			const reached = await this.until(() => {
				const at = creatures!.at(sessionId!)
				const a = this.anchorOf(view)
				if (!at || !a) return true
				const s = this.editor.pageToScreen(at)
				const t = this.editor.pageToScreen(a)
				return Math.hypot(s.x - t.x, s.y - t.y) < VISIT_NEAR_PX
			}, VISIT_MS)
			if (reached) await wait(VISIT_SETTLE_MS)
			const at = creatures!.at(sessionId!)
			if (at) await view.shrinkInto(this.editor.pageToScreen(at), PICKUP_MS)
			else await view.fadeOut(FADE_MS)
			this.finishLeaving(view)
		}
		if (sessionId && visits && creatures?.reaching.get(sessionId)) creatures.reaching.delete(sessionId)
		await Promise.all(fade.map(async (view) => (await view.fadeOut(FADE_MS), this.finishLeaving(view))))
	}

	/** A view's animation ended: it goes, unless it came back into the document meanwhile (restored). */
	private finishLeaving(view: CardView) {
		const id = view.id!
		if (!this.leaving.delete(id)) return
		if (this.map.has(id)) return view.setLeaving(false)
		view.destroy()
		if (this.views.get(id) === view) this.views.delete(id)
		this.pinned.delete(id)
	}

	private anchorOf(view: CardView): Vec | null {
		const a = view.data
		const box = a && this.itemBox(a.itemId)
		return a && box ? { x: box.x + a.x * box.w, y: box.y + a.y * box.h } : null
	}

	private onScreen(page: Vec) {
		const p = this.editor.pageToScreen(page)
		const { w, h } = this.editor.viewport.peek()
		return p.x >= 0 && p.y >= 0 && p.x <= w && p.y <= h
	}

	/** Resolves true once `done()` holds (checked every animation frame), or false after `ms`. */
	private until(done: () => boolean, ms: number): Promise<boolean> {
		const start = performance.now()
		return new Promise((resolve) => {
			const check = () => {
				if (done()) return resolve(true)
				if (performance.now() - start > ms) return resolve(false)
				requestAnimationFrame(check)
			}
			check()
		})
	}

	/** Create, update and remove views to match the document (`remote`: the change came from elsewhere). */
	private sync(remote = false) {
		const live = new Set<string>()
		const byItem = new Map<string, CardView[]>()
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
			const itemId = view.data!.itemId
			byItem.set(itemId, [...(byItem.get(itemId) ?? []), view])
		}
		// Numbered per item, oldest first, like the marked images agents get (see markedImage on the server).
		for (const list of byItem.values()) {
			list.sort((a, b) => a.data!.createdAt - b.data!.createdAt)
			list.forEach((view, i) => view.setNumber(i + 1))
		}
		for (const [id, view] of this.views) {
			if (live.has(id) || this.leaving.has(id) || this.orphans.has(id)) continue
			// Gone from elsewhere: it may be an agent reading it, whose event (on another socket) can
			// come a moment later; if it doesn't, it just fades out.
			if (remote) {
				view.setLeaving()
				this.orphans.set(
					id,
					window.setTimeout(() => {
						this.orphans.delete(id)
						if (this.leaving.has(id)) return
						this.leaving.add(id)
						void view.fadeOut(FADE_MS).then(() => this.finishLeaving(view))
					}, ORPHAN_WAIT_MS),
				)
				continue
			}
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
			const open = !small || this.pinned.has(id) || this.hovered === id || view.busy
			view.place(this.points(box, a), { card: open, line: open && !small, badge: small, active: this.pinned.has(id) || view.busy })
		}
		this.placeDraft()
	}

	/**
	 * While drawing, the line ends exactly under the pointer (its current screen point, so a camera
	 * change mid-drag can't pull it away); once released, at the stored offset like the others.
	 */
	private placeDraft() {
		const d = this.draft
		if (!d) return
		const box = this.itemBox(d.itemId)
		if (!box) return this.cancelDraft()
		if (d.typing) return d.view.place(this.points(box, d), { card: true, line: true, badge: false, active: true })
		const anchor = this.editor.pageToScreen({ x: box.x + d.x * box.w, y: box.y + d.y * box.h })
		const { x, y } = this.editor.inputs.currentScreenPoint
		d.view.place({ anchor, end: { x, y } }, { card: false, line: true, badge: false, active: true, tip: true })
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

const EDIT_ICON =
	'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M10.2 3.3l2.5 2.5L6 12.5H3.5V10z"/></svg>'
const DELETE_ICON =
	'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/></svg>'

/** What a view shows: its card, its line (else just the anchor), the collapsed number chip, and the live end of a line being drawn. */
interface Placement {
	card: boolean
	line: boolean
	badge: boolean
	active: boolean
	tip?: boolean
}

/** One annotation (or the draft): its line and anchor in the shared SVG, its collapsed number chip and its card. */
class CardView {
	readonly lines: SVGGElement
	readonly badge: HTMLDivElement
	readonly card: HTMLDivElement
	data: AnnotationData | null = null
	private casing: SVGLineElement
	private line: SVGLineElement
	private ring: SVGCircleElement
	private dot: SVGCircleElement
	private tip: SVGCircleElement
	private author: HTMLSpanElement
	private time: HTMLSpanElement
	private text: HTMLDivElement
	private input: HTMLTextAreaElement | null = null
	private hint: HTMLDivElement | null = null
	private dragging = false
	private lastKey = ''
	private shown = ''
	private active = false

	constructor(
		private owner: SharedAnnotations,
		readonly id: string | null,
		private editable: boolean,
	) {
		this.lines = document.createElementNS(SVG, 'g')
		this.lines.classList.add('annotation-g')
		this.casing = svgEl('line', 'annotation-casing')
		this.line = svgEl('line', 'annotation-line')
		this.ring = svgEl('circle', 'annotation-ring')
		this.ring.setAttribute('r', String(RING_R))
		this.dot = svgEl('circle', 'annotation-dot')
		this.dot.setAttribute('r', '2.5')
		this.tip = svgEl('circle', 'annotation-tip')
		this.tip.setAttribute('r', '2.5')
		this.lines.append(this.casing, this.line, this.ring, this.dot, this.tip)

		this.badge = document.createElement('div')
		this.badge.className = 'annotation-badge'
		this.card = document.createElement('div')
		this.card.className = 'annotation-card'
		this.card.innerHTML =
			'<div class="annotation-head"><span class="annotation-swatch"></span><span class="annotation-author"></span>' +
			'<span class="annotation-time"></span>' +
			(editable && id
				? `<span class="annotation-actions"><button class="annotation-edit" title="Edit" aria-label="Edit">${EDIT_ICON}</button>` +
					`<button class="annotation-delete" title="Delete" aria-label="Delete">${DELETE_ICON}</button></span>`
				: '') +
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
				el.addEventListener('pointerenter', () => {
					this.lines.classList.add('hover')
					owner.setHovered(id)
				})
				el.addEventListener('pointerleave', () => {
					this.lines.classList.remove('hover')
					owner.setHovered(null)
				})
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
		this.badge.title = `${d.author}: ${d.text}`
		this.updateTime()
	}

	/** Its number among its item's annotations, shown on the collapsed chip. */
	setNumber(n: number) {
		const label = String(n)
		if (this.badge.textContent !== label) this.badge.textContent = label
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
		this.lines.classList.add('drawing')
	}

	startTyping() {
		this.lines.classList.remove('drawing')
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
		input.placeholder = this.id ? 'Edit comment' : 'Add a comment'
		input.rows = 1
		input.maxLength = TEXT_MAX
		input.value = value
		input.spellcheck = false
		this.input = input
		this.text.replaceWith(input)
		const hint = document.createElement('div')
		hint.className = 'annotation-hint'
		hint.textContent = 'Enter to save · Esc to cancel'
		this.hint = hint
		input.after(hint)
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
		this.hint?.remove()
		this.hint = null
		input.replaceWith(this.text)
		this.card.classList.remove('editing')
		if (this.data) this.text.textContent = this.data.text
	}

	private setColor(color: string) {
		for (const el of [this.card, this.badge, this.lines]) el.style.setProperty('--author', color)
	}

	hide() {
		if (this.lastKey === 'hidden') return
		this.lastKey = 'hidden'
		this.lines.style.display = 'none'
		this.badge.style.display = 'none'
		this.card.style.display = 'none'
		this.shown = ''
	}

	place({ anchor, end }: { anchor: Vec; end: Vec }, p: Placement) {
		const tip = !!p.tip
		const key = `${anchor.x},${anchor.y},${end.x},${end.y},${p.card},${p.line},${p.badge},${p.active},${tip}`
		if (key === this.lastKey) return
		this.lastKey = key
		const state = `${p.card},${p.line},${p.badge},${tip}`
		if (state !== this.shown) {
			this.shown = state
			this.lines.style.display = ''
			this.badge.style.display = p.badge ? '' : 'none'
			this.card.style.display = p.card ? '' : 'none'
			this.line.style.display = this.casing.style.display = p.line ? '' : 'none'
			this.tip.style.display = tip ? '' : 'none'
		}
		if (p.active !== this.active) {
			this.active = p.active
			for (const el of [this.card, this.badge, this.lines]) el.classList.toggle('active', p.active)
		}
		for (const c of [this.ring, this.dot]) {
			c.setAttribute('cx', String(anchor.x))
			c.setAttribute('cy', String(anchor.y))
		}
		if (p.badge) this.badge.style.transform = `translate(${anchor.x + BADGE_GAP}px, ${anchor.y}px) translate(0, -50%)`
		if (p.line) {
			// From the ring's edge to the end; shorter than the ring, just a point at the end.
			const dx = end.x - anchor.x
			const dy = end.y - anchor.y
			const len = Math.hypot(dx, dy)
			const k = len > RING_R ? RING_R / len : 1
			for (const l of [this.casing, this.line]) {
				l.setAttribute('x1', String(anchor.x + dx * k))
				l.setAttribute('y1', String(anchor.y + dy * k))
				l.setAttribute('x2', String(end.x))
				l.setAttribute('y2', String(end.y))
			}
		}
		if (tip) {
			this.tip.setAttribute('cx', String(end.x))
			this.tip.setAttribute('cy', String(end.y))
		}
		if (!p.card) return
		// Opened from its chip: the card sits beside the chip, without the (tiny) line.
		if (p.badge) {
			const x = anchor.x + BADGE_GAP + this.badge.offsetWidth + 6
			this.card.style.transform = `translate(${x}px, ${anchor.y - this.badge.offsetHeight / 2}px)`
			return
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

	/** Going away: no longer interactive (or back to normal, when it came back). */
	setLeaving(on = true) {
		for (const el of [this.card, this.badge, this.lines]) {
			el.classList.toggle('leaving', on)
			if (!on) for (const anim of el.getAnimations()) anim.cancel()
		}
	}

	/** Picked up: the card, chip and line shrink into a screen point (a creature) as they fade. */
	shrinkInto(point: Vec, ms: number): Promise<unknown> {
		const easing = 'cubic-bezier(0.5, 0, 0.75, 0)'
		const origin = `${point.x}px ${point.y}px`
		// Card and chip are placed with transform, so they shrink with scale (applied around the point:
		// they sit at the layer's origin untransformed); the SVG line has no transform of its own.
		const anims = [this.card, this.badge].map((el) => {
			el.style.transformOrigin = origin
			return el.animate([{ scale: '1', opacity: 1 }, { scale: '0.04', opacity: 0 }], { duration: ms, easing, fill: 'forwards' })
		})
		this.lines.style.transformOrigin = origin
		anims.push(this.lines.animate([{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(0.04)', opacity: 0 }], { duration: ms, easing, fill: 'forwards' }))
		return Promise.all(anims.map((a) => a.finished.catch(() => {})))
	}

	fadeOut(ms: number): Promise<unknown> {
		const anims = [this.card, this.badge, this.lines].map((el) =>
			el.animate([{ opacity: 1, scale: '1' }, { opacity: 0, scale: '0.92' }], { duration: ms, easing: 'ease-in', fill: 'forwards' }),
		)
		return Promise.all(anims.map((a) => a.finished.catch(() => {})))
	}

	/**
	 * A press on the card or chip: the canvas underneath never sees it. Dragging moves the card
	 * (edit links); a click on a collapsed chip keeps the card open.
	 */
	private onPointerDown(e: PointerEvent, onBadge: boolean) {
		if (e.button === 1 || this.owner.editor.inputs.isSpaceDown) return
		e.stopPropagation()
		if (e.button !== 0) return
		const target = e.target as HTMLElement
		if (target.closest('button') || target.tagName === 'TEXTAREA') return
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

function svgEl<K extends 'line' | 'circle'>(tag: K, className: string): SVGElementTagNameMap[K] {
	const el = document.createElementNS(SVG, tag)
	el.classList.add(className)
	return el
}

function wait(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms))
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
