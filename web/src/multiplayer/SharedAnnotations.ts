import * as Y from 'yjs'
import type { Role } from '../sync/client'
import type { AnnotationSnapshot } from '../editor/Deletions'
import type { Editor } from '../editor/Editor'
import type { Box, Vec } from '../editor/geometry'
import type { Presence } from './Presence'
import '../ui/annotations.css'

/** Below this on-screen item width, notes collapse to their number chip (hover or click to open); strokes stay. */
const COLLAPSE_ITEM_PX = 260
/** Drawing again on the same item within this long of lifting the pen adds to the same annotation. */
const JOIN_MS = 2000
/** A press that moves less than this (screen px) is a click: it drops a text-only note there. */
const CLICK_PX = 4
/** Pointer moves closer than this (screen px) to the last point are skipped; on release the stroke is simplified to within SIMPLIFY_PX. */
const MIN_STEP_PX = 0.75
const SIMPLIFY_PX = 0.6
const MAX_POINTS = 4000
const MAX_STROKES = 60
/** strokes may run a little off their item (circling something at its edge), not further */
const OVERHANG = 0.25
/** Screen px between a drawing and its note card, and between a note's spot and its card. */
const CARD_GAP = 10
/** Gap (screen px) between a text-only note's spot and its collapsed number chip. */
const BADGE_GAP = 9
/** How long a card stays open after the pointer leaves its chip or card. */
const HOVER_GRACE_MS = 250
const TEXT_MAX = 4000
const SVG = 'http://www.w3.org/2000/svg'
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

/** The stroke being drawn: page points, drawn live in page space (see placeLive). */
interface Live {
	itemId: string
	points: Vec[]
	pointerId: number | null
	/** the annotation it joins (drawn again soon on the same item), if any */
	join: string | null
	g: SVGGElement
	path: SVGPathElement
	casing: SVGPathElement
}

/** A text-only note being written: its spot (normalized to the item) and the card with its box. */
interface TextDraft {
	itemId: string
	x: number
	y: number
	view: AnnotationView
}

/**
 * Annotations: freehand pencil drawings on items with an optional text note (or text-only notes on a
 * spot), stored in the room's Y.Doc (map "annotations", see Annotation in shared/types.ts) so everyone
 * sees them live and the server can hand them to agents. Strokes are normalized to their item, so
 * they stay on it whatever the layout or zoom does; they're drawn in an SVG overlay at a constant
 * screen width, with the note's card beside the drawing.
 *
 * Edit links draw with the pencil tool (see PencilTool): a stroke is saved when the pen lifts and a
 * note box opens by it (Enter attaches the text; Esc or a click elsewhere leaves it without), and
 * drawing again on the same item soon after adds to the same annotation. View links only see them.
 */
export class SharedAnnotations {
	private doc: Y.Doc
	private map: Y.Map<Y.Map<unknown>>
	private host: HTMLDivElement
	private svg: SVGSVGElement
	private views = new Map<string, AnnotationView>()
	private live: Live | null = null
	private textDraft: TextDraft | null = null
	/** the annotation last drawn on (strokes join it for JOIN_MS after the pen lifts), till Enter or Esc in its box */
	private recent: { id: string; itemId: string; endedAt: number } | null = null
	private joinTimer = 0
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
		this.svg.classList.add('annotation-strokes')
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
				begin: (itemId, point) => this.beginStroke(itemId, point),
				end: () => this.endStroke(),
				cancel: () => this.cancelStroke(),
				type: (text) => this.typeNote(text),
			}
			editor.deletions.annotations = { remove: (ids) => this.remove(ids), restore: (snaps) => this.restore(snaps) }
			this.disposers.push(() => {
				editor.annotationDrafts = null
				editor.deletions.annotations = null
				if (editor.toolPath.peek().startsWith('pencil')) editor.setCurrentTool('select')
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
		clearTimeout(this.joinTimer)
		this.cancelStroke()
		this.textDraft?.view.destroy()
		this.textDraft = null
		for (const view of this.views.values()) view.destroy()
		this.views.clear()
		this.host.remove()
	}

	// ---------- drawing ----------

	private beginStroke(itemId: string, point: Vec) {
		this.cancelStroke()
		clearTimeout(this.joinTimer)
		const recent = this.recent
		const join = recent && recent.itemId === itemId && this.map.has(recent.id) && performance.now() - recent.endedAt < JOIN_MS ? recent.id : null
		if (join) {
			const strokes = this.views.get(join)?.data?.strokes.length ?? 0
			if (strokes >= MAX_STROKES) this.recent = null
		}
		const me = this.presence.me.peek()
		const g = document.createElementNS(SVG, 'g')
		g.classList.add('annotation-g', 'live')
		g.style.setProperty('--author', me.color)
		const casing = svgEl('path', 'annotation-casing')
		const path = svgEl('path', 'annotation-stroke')
		g.append(casing, path)
		this.svg.appendChild(g)
		this.live = { itemId, points: [point], pointerId: null, join: join && this.recent?.id === join ? join : null, g, path, casing }
		window.addEventListener('pointermove', this.onLiveMove, true)
		this.placeLive()
		// Open boxes save what's typed and close (with the stroke live, so that doesn't count as done
		// with the annotation it joins); a joined drawing's box opens again after the stroke.
		this.textDraft?.view.blurInput()
		for (const view of this.views.values()) view.blurInput()
		if (this.recent && this.recent.id !== this.live.join) this.recent = null
	}

	/**
	 * Every pointer position since the last event (coalesced events: the browser batches moves per
	 * frame), drawn straight away so the line stays under the pointer.
	 */
	private onLiveMove = (e: PointerEvent) => {
		const live = this.live
		if (!live) return
		if (live.pointerId === null) live.pointerId = e.pointerId
		if (e.pointerId !== live.pointerId) return
		const z = this.editor.getZoom()
		const events = e.getCoalescedEvents?.() ?? []
		for (const ev of events.length ? events : [e]) {
			if (live.points.length >= MAX_POINTS) break
			const p = this.pagePoint(ev)
			const last = live.points[live.points.length - 1]
			if (Math.hypot(p.x - last.x, p.y - last.y) * z < MIN_STEP_PX) continue
			live.points.push(p)
		}
		this.drawLive()
	}

	private drawLive() {
		const live = this.live
		if (!live) return
		const d = smoothPath(live.points.map((p) => [p.x, p.y]), 2)
		live.path.setAttribute('d', d)
		live.casing.setAttribute('d', d)
	}

	/** The live stroke is in page coordinates: one transform follows the camera. */
	private placeLive() {
		const live = this.live
		if (!live) return
		const z = this.editor.getZoom()
		const o = this.editor.pageToScreen({ x: 0, y: 0 })
		live.g.setAttribute('transform', `matrix(${z} 0 0 ${z} ${o.x} ${o.y})`)
		this.drawLive()
	}

	private stopLive() {
		const live = this.live
		if (!live) return null
		window.removeEventListener('pointermove', this.onLiveMove, true)
		live.g.remove()
		this.live = null
		return live
	}

	private cancelStroke() {
		this.stopLive()
	}

	/** Pen up: a click drops a text-only note; a stroke is saved (new, or added to the one it joins) and its note box opens. */
	private endStroke() {
		const live = this.stopLive()
		const box = live && this.itemBox(live.itemId)
		if (!live || !box) return
		const z = this.editor.getZoom()
		const [first] = live.points
		const reach = Math.max(...live.points.map((p) => Math.hypot(p.x - first.x, p.y - first.y))) * z
		if (reach < CLICK_PX) {
			this.recent = null
			this.startTextDraft(live.itemId, first, '', false)
			return
		}
		const points = simplify(live.points, SIMPLIFY_PX / z)
		const flat: number[] = []
		for (const p of points) {
			flat.push(round4(clamp((p.x - box.x) / box.w, -OVERHANG, 1 + OVERHANG)), round4(clamp((p.y - box.y) / box.h, -OVERHANG, 1 + OVERHANG)))
		}
		const existing = live.join ? this.map.get(live.join) : undefined
		let id: string
		if (existing) {
			id = live.join!
			const strokes = [...strokesOf(existing.get('strokes')), flat]
			this.doc.transact(() => {
				existing.set('strokes', strokes)
				const at = noteSpot(strokes)
				existing.set('x', at.x)
				existing.set('y', at.y)
			})
		} else {
			id = annotationId()
			const me = this.presence.me.peek()
			const at = noteSpot([flat])
			const a = new Y.Map<unknown>()
			this.doc.transact(() => {
				a.set('itemId', live.itemId)
				a.set('strokes', [flat])
				a.set('x', at.x)
				a.set('y', at.y)
				a.set('text', '')
				a.set('author', me.name)
				a.set('color', me.color)
				a.set('createdAt', Date.now())
				this.map.set(id, a)
			})
		}
		this.recent = { id, itemId: live.itemId, endedAt: performance.now() }
		// (the box first: placed right away, so it's showing when it takes focus)
		this.views.get(id)?.openNote()
		this.position()
		// Not drawn on again in time: it's finished (the box stays open for typing meanwhile).
		this.joinTimer = window.setTimeout(() => this.recent?.id === id && this.finished(), JOIN_MS)
	}

	/** T or typing over an item with the pencil: a text-only note at the pointer. */
	private typeNote(text: string) {
		const { inputs } = this.editor
		if (!inputs.isPointerInside || inputs.isPointing) return false
		const target = this.editor.getTargetAt(inputs.currentPagePoint)
		if (target.type !== 'item') return false
		this.startTextDraft(target.id, inputs.currentPagePoint, text, true)
		return true
	}

	private startTextDraft(itemId: string, point: Vec, text: string, focusNow: boolean) {
		const box = this.itemBox(itemId)
		if (!box) return
		this.textDraft?.view.destroy()
		for (const view of this.views.values()) view.blurInput()
		const me = this.presence.me.peek()
		const view = new AnnotationView(this, null, true)
		view.showDraft(me.name, me.color)
		const draft: TextDraft = { itemId, x: round4(clamp((point.x - box.x) / box.w, 0, 1)), y: round4(clamp((point.y - box.y) / box.h, 0, 1)), view }
		this.textDraft = draft
		this.addView(view)
		view.openInput(text, 'Add a note…', (value) => this.commitTextDraft(view, value), () => this.dropTextDraft(view), focusNow)
		this.placeTextDraft()
	}

	/** Drops the text draft (only if it's still `view`'s: a stale box's blur mustn't drop a newer draft). */
	private dropTextDraft(view: AnnotationView) {
		if (this.textDraft?.view !== view) return
		this.textDraft = null
		view.destroy()
	}

	private commitTextDraft(view: AnnotationView, text: string) {
		const d = this.textDraft
		if (!d || d.view !== view) return
		this.dropTextDraft(view)
		const trimmed = text.trim().slice(0, TEXT_MAX)
		if (!trimmed || !this.itemBox(d.itemId)) return
		const me = this.presence.me.peek()
		const id = annotationId()
		const a = new Y.Map<unknown>()
		this.doc.transact(() => {
			a.set('itemId', d.itemId)
			a.set('strokes', [])
			a.set('x', d.x)
			a.set('y', d.y)
			a.set('text', trimmed)
			a.set('author', me.name)
			a.set('color', me.color)
			a.set('createdAt', Date.now())
			this.map.set(id, a)
		})
		this.pinned.add(id)
		this.finished()
	}

	/**
	 * A drawing's note box closed: Enter, Esc, or a click elsewhere finish it (a pen going down that
	 * joins it doesn't, see beginStroke), unless it was already finished.
	 */
	noteClosed(id: string, how: 'enter' | 'escape' | 'blur') {
		if (this.recent?.id !== id || (how === 'blur' && this.live)) return
		this.finished()
	}

	/**
	 * The annotation being made is saved for good: the next stroke starts a new one, and the pencil
	 * goes back to select (once the pointer is up, so a click-away's pan isn't cut short; not while
	 * another stroke is being drawn).
	 */
	private finished() {
		clearTimeout(this.joinTimer)
		this.recent = null
		if (this.live) return
		const toSelect = () => {
			if (!this.live && this.editor.toolPath.peek().startsWith('pencil')) this.editor.setCurrentTool('select')
		}
		if (!this.editor.inputs.isPointing) return toSelect()
		window.addEventListener('pointerup', () => setTimeout(toSelect), { once: true, capture: true })
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

	/** A drawing's note can be cleared; a text-only note keeps its text (delete it instead). */
	setText(id: string, text: string) {
		const a = this.map.get(id)
		const trimmed = text.trim().slice(0, TEXT_MAX)
		if (!a || trimmed === a.get('text')) return
		if (!trimmed && !strokesOf(a.get('strokes')).length) return
		this.doc.transact(() => {
			a.set('text', trimmed)
			if (a.get('createdAt') && Date.now() - Number(a.get('createdAt')) > 60_000) a.set('updatedAt', Date.now())
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
		const fade: AnnotationView[] = []
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
	private finishLeaving(view: AnnotationView) {
		const id = view.id!
		if (!this.leaving.delete(id)) return
		if (this.map.has(id)) return view.setLeaving(false)
		view.destroy()
		if (this.views.get(id) === view) this.views.delete(id)
		this.pinned.delete(id)
	}

	/** Where a creature goes to pick it up (page): the middle of the drawing, or a text note's spot. */
	private anchorOf(view: AnnotationView): Vec | null {
		const a = view.data
		const box = a && this.itemBox(a.itemId)
		if (!a || !box) return null
		const b = a.bounds
		const x = b ? (b.x0 + b.x1) / 2 : a.x
		const y = b ? (b.y0 + b.y1) / 2 : a.y
		return { x: box.x + x * box.w, y: box.y + y * box.h }
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
		const byItem = new Map<string, AnnotationView[]>()
		for (const [id, a] of this.map.entries()) {
			if (!(a instanceof Y.Map)) continue
			live.add(id)
			let view = this.views.get(id)
			if (!view) {
				view = new AnnotationView(this, id, this.editable)
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

	private addView(view: AnnotationView) {
		this.svg.insertBefore(view.g, this.live?.g ?? null)
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
			// Small on screen: the strokes and a number chip, which stays put while its card is open so
			// the pointer can stay on it. A drawing without a note shows just its chip at any size.
			const small = box.w * z < COLLAPSE_ITEM_PX
			const open = (!small && !!a.text) || this.pinned.has(id) || this.hovered === id || view.busy
			view.place(this.screenBox(box), w, { card: open, badge: (small || !a.text) && !view.busy, active: this.pinned.has(id) || view.busy })
		}
		this.placeTextDraft()
		this.placeLive()
	}

	private placeTextDraft() {
		const d = this.textDraft
		if (!d) return
		const box = this.itemBox(d.itemId)
		if (!box) return this.dropTextDraft(d.view)
		d.view.placeAt(this.screenBox(box), d, this.editor.viewport.peek().w)
	}

	/** An item's box on screen. */
	private screenBox(box: Box): Box {
		const z = this.editor.getZoom()
		const o = this.editor.pageToScreen(box)
		return { x: o.x, y: o.y, w: box.w * z, h: box.h * z }
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
	/** where the note sits, normalized: beside the drawing, or a text-only note's spot */
	x: number
	y: number
	strokes: number[][]
	/** the drawing's bounds, normalized (null for a text-only note) */
	bounds: { x0: number; y0: number; x1: number; y1: number } | null
	text: string
	author: string
	color: string
	createdAt: number
	updatedAt?: number
}

const EDIT_ICON =
	'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M10.2 3.3l2.5 2.5L6 12.5H3.5V10z"/></svg>'
const DELETE_ICON =
	'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/></svg>'

/** What a view shows: its card, its collapsed number chip, and whether it's highlighted. */
interface Placement {
	card: boolean
	badge: boolean
	active: boolean
}

/**
 * One annotation (or a text-only draft): its strokes (or a text note's dot) in the shared SVG, its
 * number chip and its note card. The strokes are kept in item-normalized units and placed with one
 * transform per frame (non-scaling, so 3px on screen at any zoom).
 */
class AnnotationView {
	/** outer group: animated when it leaves (a CSS transform would replace the inner one's attribute) */
	readonly g: SVGGElement
	readonly badge: HTMLDivElement
	readonly card: HTMLDivElement
	data: AnnotationData | null = null
	private inner: SVGGElement
	private casing: SVGPathElement
	private stroke: SVGPathElement
	private ring: SVGCircleElement
	private dot: SVGCircleElement
	private author: HTMLSpanElement
	private time: HTMLSpanElement
	private text: HTMLDivElement
	private input: HTMLTextAreaElement | null = null
	private hint: HTMLDivElement | null = null
	private closeInputNow: ((keep: boolean) => void) | null = null
	private rawStrokes: unknown = null
	private lastKey = ''
	private shown = ''
	private active = false

	constructor(
		private owner: SharedAnnotations,
		readonly id: string | null,
		private editable: boolean,
	) {
		this.g = document.createElementNS(SVG, 'g')
		this.g.classList.add('annotation-g')
		this.inner = document.createElementNS(SVG, 'g')
		this.casing = svgEl('path', 'annotation-casing')
		this.stroke = svgEl('path', 'annotation-stroke')
		this.inner.append(this.casing, this.stroke)
		this.ring = svgEl('circle', 'annotation-ring')
		this.ring.setAttribute('r', '6')
		this.dot = svgEl('circle', 'annotation-dot')
		this.dot.setAttribute('r', '2.5')
		this.g.append(this.inner, this.ring, this.dot)

		this.badge = document.createElement('div')
		this.badge.className = 'annotation-badge'
		this.card = document.createElement('div')
		this.card.className = 'annotation-card'
		this.card.innerHTML =
			'<div class="annotation-head"><span class="annotation-swatch"></span><span class="annotation-author"></span>' +
			'<span class="annotation-time"></span>' +
			(editable && id
				? `<span class="annotation-actions"><button class="annotation-edit" title="Edit note" aria-label="Edit note">${EDIT_ICON}</button>` +
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
					this.g.classList.add('hover')
					owner.setHovered(id)
				})
				el.addEventListener('pointerleave', () => {
					this.g.classList.remove('hover')
					owner.setHovered(null)
				})
			}
		}
		this.card.querySelector('.annotation-edit')?.addEventListener('click', () => this.startEditing())
		this.card.querySelector('.annotation-delete')?.addEventListener('click', () => this.id && owner.delete(this.id))
	}

	/** Busy views stay open whatever the zoom: being typed in. */
	get busy() {
		return this.input !== null
	}

	update(a: Y.Map<unknown>) {
		const updatedAt = Number(a.get('updatedAt') ?? 0) || undefined
		const raw = a.get('strokes')
		const strokes = raw === this.rawStrokes && this.data ? this.data.strokes : strokesOf(raw)
		this.data = {
			itemId: String(a.get('itemId') ?? ''),
			x: Number(a.get('x') ?? 0) || 0,
			y: Number(a.get('y') ?? 0) || 0,
			strokes,
			bounds: boundsOf(strokes),
			text: String(a.get('text') ?? ''),
			author: String(a.get('author') ?? ''),
			color: String(a.get('color') ?? '#f87171'),
			createdAt: Number(a.get('createdAt') ?? 0) || 0,
			updatedAt,
		}
		if (raw !== this.rawStrokes) {
			this.rawStrokes = raw
			// in item-normalized units, scaled up so the curves keep their precision
			const d = strokes.map((flat) => smoothPath(pairs(flat, NORM), 1)).join('')
			this.stroke.setAttribute('d', d)
			this.casing.setAttribute('d', d)
			this.lastKey = ''
		}
		const d = this.data
		const drawing = !!d.bounds
		this.ring.style.display = this.dot.style.display = drawing ? 'none' : ''
		this.inner.style.display = drawing ? '' : 'none'
		this.setColor(d.color)
		if (this.author.textContent !== d.author) this.author.textContent = d.author || 'Someone'
		if (!this.input) this.showText()
		this.badge.title = `${d.author}${d.text ? `: ${d.text}` : ' (drawing)'}`
		this.updateTime()
	}

	private showText() {
		const t = this.data?.text ?? ''
		if (this.text.textContent !== (t || 'No note')) this.text.textContent = t || 'No note'
		this.text.classList.toggle('empty', !t)
	}

	/** Its number among its item's annotations, shown on the chip (the same number agents see). */
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

	/** A text-only draft: our name and colour, no text yet. */
	showDraft(author: string, color: string) {
		this.setColor(color)
		this.author.textContent = author
		this.time.textContent = ''
		this.card.classList.add('draft')
		this.inner.style.display = 'none'
	}

	/** Just drawn: the note box opens beside the drawing. */
	openNote() {
		const d = this.data
		if (!d || !this.id || this.input) return
		const id = this.id
		this.openInput(
			d.text,
			'Add a note…',
			(text) => this.owner.setText(id, text),
			() => {},
			false,
			(how) => {
				this.closeInput()
				this.owner.noteClosed(id, how)
			},
		)
	}

	private startEditing() {
		const d = this.data
		if (!d || !this.id) return
		const id = this.id
		this.openInput(d.text, d.bounds ? 'Add a note…' : 'Edit note', (text) => this.owner.setText(id, text), () => {}, false, () => this.closeInput())
	}

	/** Closes the box, keeping what's typed (a pen going down elsewhere). */
	blurInput() {
		this.closeInputNow?.(true)
	}

	/**
	 * Swap the text for a box: Enter saves (Shift+Enter is a new line), Escape leaves it as it was,
	 * and so does a blur with nothing typed. `focusNow`: opened by a key, so the next keys land in it.
	 */
	openInput(
		value: string,
		placeholder: string,
		save: (text: string) => void,
		cancel: () => void,
		focusNow: boolean,
		closed?: (how: 'enter' | 'escape' | 'blur') => void,
	) {
		if (this.input) return
		const input = document.createElement('textarea')
		input.className = 'annotation-input'
		input.placeholder = placeholder
		input.rows = 1
		input.maxLength = TEXT_MAX
		input.value = value
		input.spellcheck = false
		this.input = input
		this.text.replaceWith(input)
		const hint = document.createElement('div')
		hint.className = 'annotation-hint'
		hint.textContent = this.data?.bounds && !value ? 'Enter to save · Esc to skip' : 'Enter to save · Esc to cancel'
		this.hint = hint
		input.after(hint)
		this.card.classList.add('editing')
		const fit = () => {
			input.style.height = 'auto'
			input.style.height = `${Math.min(input.scrollHeight, 220)}px`
		}
		let done = false
		const finish = (keep: boolean, how: 'enter' | 'escape' | 'blur') => {
			if (done) return
			done = true
			this.closeInputNow = null
			if (keep && (input.value.trim() || (this.data?.bounds && value))) save(input.value)
			else cancel()
			closed?.(how)
		}
		this.closeInputNow = (keep) => finish(keep, 'blur')
		input.addEventListener('input', fit)
		input.addEventListener('keydown', (e) => {
			e.stopPropagation()
			if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
				e.preventDefault()
				finish(true, 'enter')
			} else if (e.key === 'Escape') {
				e.preventDefault()
				finish(false, 'escape')
			}
		})
		input.addEventListener('blur', () => finish(true, 'blur'))
		const focus = () => {
			fit()
			input.focus()
			input.setSelectionRange(input.value.length, input.value.length)
		}
		// A press that opened it would otherwise move focus straight back to the page.
		if (focusNow) focus()
		else requestAnimationFrame(focus)
	}

	private closeInput() {
		if (!this.input) return
		const input = this.input
		this.input = null
		this.closeInputNow = null
		this.hint?.remove()
		this.hint = null
		input.replaceWith(this.text)
		this.card.classList.remove('editing')
		this.showText()
	}

	private setColor(color: string) {
		for (const el of [this.card, this.badge, this.g]) el.style.setProperty('--author', color)
	}

	hide() {
		if (this.lastKey === 'hidden') return
		this.lastKey = 'hidden'
		this.g.style.display = 'none'
		this.badge.style.display = 'none'
		this.card.style.display = 'none'
		this.shown = ''
	}

	/** Places the strokes on the item (screen box), and the chip and card beside the drawing (or the note's spot). */
	place(box: Box, viewW: number, p: Placement) {
		const d = this.data!
		const cardW = p.card ? this.card.offsetWidth : 0
		const key = `${box.x},${box.y},${box.w},${box.h},${viewW},${cardW},${p.card},${p.badge},${p.active}`
		if (key === this.lastKey) return
		this.lastKey = key
		const state = `${p.card},${p.badge}`
		if (state !== this.shown) {
			this.shown = state
			this.g.style.display = ''
			this.badge.style.display = p.badge ? '' : 'none'
			this.card.style.display = p.card ? '' : 'none'
		}
		if (p.active !== this.active) {
			this.active = p.active
			for (const el of [this.card, this.badge, this.g]) el.classList.toggle('active', p.active)
		}
		const b = d.bounds
		if (b) {
			this.inner.setAttribute('transform', `matrix(${box.w / NORM} 0 0 ${box.h / NORM} ${box.x} ${box.y})`)
			const left = box.x + b.x0 * box.w
			const right = box.x + b.x1 * box.w
			const top = box.y + b.y0 * box.h
			if (p.badge) this.badge.style.transform = `translate(${right + 4}px, ${top}px) translate(0, -50%)`
			if (!p.card) return
			if (p.badge) {
				this.card.style.transform = `translate(${right + 4 + this.badge.offsetWidth + 6}px, ${top - this.badge.offsetHeight / 2}px)`
				return
			}
			// Beside the drawing, at its top: on the right, or on the left when it would run off the screen.
			const x = right + CARD_GAP + cardW > viewW && left - CARD_GAP - cardW >= 0 ? left - CARD_GAP - cardW : right + CARD_GAP
			this.card.style.transform = `translate(${x}px, ${top}px)`
			return
		}
		this.placeSpot(box, d, viewW, p, cardW)
	}

	/** A text-only draft at its spot. */
	placeAt(box: Box, spot: { x: number; y: number }, viewW: number) {
		const cardW = this.card.offsetWidth
		const key = `draft,${box.x},${box.y},${box.w},${box.h},${viewW},${cardW}`
		if (key === this.lastKey) return
		this.lastKey = key
		this.g.style.display = ''
		this.badge.style.display = 'none'
		this.card.style.display = ''
		this.ring.style.display = this.dot.style.display = ''
		for (const el of [this.card, this.g]) el.classList.add('active')
		this.placeSpot(box, spot, viewW, { card: true, badge: false, active: true }, cardW)
	}

	private placeSpot(box: Box, spot: { x: number; y: number }, viewW: number, p: Placement, cardW: number) {
		const at = { x: box.x + spot.x * box.w, y: box.y + spot.y * box.h }
		for (const c of [this.ring, this.dot]) {
			c.setAttribute('cx', String(at.x))
			c.setAttribute('cy', String(at.y))
		}
		if (p.badge) this.badge.style.transform = `translate(${at.x + BADGE_GAP}px, ${at.y}px) translate(0, -50%)`
		if (!p.card) return
		if (p.badge) {
			const x = at.x + BADGE_GAP + this.badge.offsetWidth + 6
			this.card.style.transform = `translate(${x}px, ${at.y - this.badge.offsetHeight / 2}px)`
			return
		}
		const x = at.x + CARD_GAP + cardW > viewW && at.x - CARD_GAP - cardW >= 0 ? at.x - CARD_GAP - cardW : at.x + CARD_GAP
		this.card.style.transform = `translate(${x}px, ${at.y}px) translate(0, -50%)`
	}

	destroy() {
		this.closeInputNow = null
		this.g.remove()
		this.badge.remove()
		this.card.remove()
	}

	/** Going away: no longer interactive (or back to normal, when it came back). */
	setLeaving(on = true) {
		for (const el of [this.card, this.badge, this.g]) {
			el.classList.toggle('leaving', on)
			if (!on) for (const anim of el.getAnimations()) anim.cancel()
		}
	}

	/** Picked up: the card, chip and strokes shrink into a screen point (a creature) as they fade. */
	shrinkInto(point: Vec, ms: number): Promise<unknown> {
		const easing = 'cubic-bezier(0.5, 0, 0.75, 0)'
		const origin = `${point.x}px ${point.y}px`
		// Card and chip are placed with transform, so they shrink with scale (applied around the point:
		// they sit at the layer's origin untransformed); the outer SVG group has no transform of its own.
		const anims = [this.card, this.badge].map((el) => {
			el.style.transformOrigin = origin
			return el.animate([{ scale: '1', opacity: 1 }, { scale: '0.04', opacity: 0 }], { duration: ms, easing, fill: 'forwards' })
		})
		this.g.style.transformOrigin = origin
		anims.push(this.g.animate([{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(0.04)', opacity: 0 }], { duration: ms, easing, fill: 'forwards' }))
		return Promise.all(anims.map((a) => a.finished.catch(() => {})))
	}

	fadeOut(ms: number): Promise<unknown> {
		const anims = [this.card, this.badge, this.g].map((el) =>
			el.animate([{ opacity: 1, scale: '1' }, { opacity: 0, scale: '0.92' }], { duration: ms, easing: 'ease-in', fill: 'forwards' }),
		)
		return Promise.all(anims.map((a) => a.finished.catch(() => {})))
	}

	/** A press on the card or chip: the canvas underneath never sees it; a click on a chip keeps the card open. */
	private onPointerDown(e: PointerEvent, onBadge: boolean) {
		if (e.button === 1 || this.owner.editor.inputs.isSpaceDown) return
		e.stopPropagation()
		if (e.button !== 0) return
		const target = e.target as HTMLElement
		if (target.closest('button') || target.tagName === 'TEXTAREA') return
		// Keep focus where it is (a click shouldn't blur someone's typing elsewhere into a save).
		e.preventDefault()
		if (onBadge && this.id) this.owner.togglePinned(this.id)
	}
}

/** Strokes are drawn in item-normalized units times this (SVG keeps more precision than 0..1 coordinates). */
const NORM = 1000

/**
 * A smooth SVG path through the points: straight to the first midpoint, quadratic curves through
 * each point to the next midpoint, and straight on to the last point (so a live stroke ends right
 * under the pointer). A single point is a dot.
 */
function smoothPath(points: number[][], digits: number): string {
	const f = (v: number) => (Math.round(v * 10 ** digits) / 10 ** digits).toString()
	if (!points.length) return ''
	const [x0, y0] = points[0]
	if (points.length === 1) return `M${f(x0)} ${f(y0)}h0.01`
	if (points.length === 2) return `M${f(x0)} ${f(y0)}L${f(points[1][0])} ${f(points[1][1])}`
	let d = `M${f(x0)} ${f(y0)}L${f((x0 + points[1][0]) / 2)} ${f((y0 + points[1][1]) / 2)}`
	for (let i = 1; i < points.length - 1; i++) {
		const [cx, cy] = points[i]
		const [nx, ny] = points[i + 1]
		d += `Q${f(cx)} ${f(cy)} ${f((cx + nx) / 2)} ${f((cy + ny) / 2)}`
	}
	const [lx, ly] = points[points.length - 1]
	return d + `L${f(lx)} ${f(ly)}`
}

/** A flat [x, y, …] list as points, scaled. */
function pairs(flat: number[], k: number): number[][] {
	const out: number[][] = []
	for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i] * k, flat[i + 1] * k])
	return out
}

/** Ramer–Douglas–Peucker: drops points within `tolerance` of the line between the ones kept around them. */
function simplify(points: Vec[], tolerance: number): Vec[] {
	if (points.length < 3) return points
	const keep = new Uint8Array(points.length)
	keep[0] = keep[points.length - 1] = 1
	const stack: [number, number][] = [[0, points.length - 1]]
	while (stack.length) {
		const [a, b] = stack.pop()!
		let worst = -1
		let far = tolerance
		const A = points[a]
		const B = points[b]
		const dx = B.x - A.x
		const dy = B.y - A.y
		const l2 = dx * dx + dy * dy
		for (let i = a + 1; i < b; i++) {
			const P = points[i]
			const t = l2 ? clamp(((P.x - A.x) * dx + (P.y - A.y) * dy) / l2, 0, 1) : 0
			const dist = Math.hypot(P.x - A.x - t * dx, P.y - A.y - t * dy)
			if (dist > far) {
				far = dist
				worst = i
			}
		}
		if (worst < 0) continue
		keep[worst] = 1
		stack.push([a, worst], [worst, b])
	}
	return points.filter((_, i) => keep[i])
}

function strokesOf(value: unknown): number[][] {
	if (!Array.isArray(value)) return []
	return value.filter((s): s is number[] => Array.isArray(s) && s.length >= 2 && s.every((v) => typeof v === 'number' && Number.isFinite(v)))
}

function boundsOf(strokes: number[][]) {
	if (!strokes.length) return null
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
	for (const flat of strokes) {
		for (let i = 0; i + 1 < flat.length; i += 2) {
			x0 = Math.min(x0, flat[i])
			x1 = Math.max(x1, flat[i])
			y0 = Math.min(y0, flat[i + 1])
			y1 = Math.max(y1, flat[i + 1])
		}
	}
	return { x0, y0, x1, y1 }
}

/** Where a drawing's note sits (what agents get as its anchor): the drawing's top-right corner, on the item. */
function noteSpot(strokes: number[][]) {
	const b = boundsOf(strokes)!
	return { x: round4(clamp(b.x1, 0, 1)), y: round4(clamp(b.y0, 0, 1)) }
}

function clamp(v: number, lo: number, hi: number) {
	return Math.min(hi, Math.max(lo, v))
}

function round4(v: number) {
	return Math.round(v * 10000) / 10000
}

function svgEl<K extends 'path' | 'circle'>(tag: K, className: string): SVGElementTagNameMap[K] {
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
