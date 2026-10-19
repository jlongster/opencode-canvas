import type { Camera, Editor } from '../editor/Editor'
import type { Box, Vec } from '../editor/geometry'
import type { SectionLayout } from '../editor/layout'
import { RAIL_KIND, railHtml, tickElapsed, type RailLevel } from '../ui/rail'
import type { Attention } from './Attention'
import type { Conjure, LiveStatus } from './Conjure'

/** the frame's corner radius on the page (see SECTION_RADIUS in the renderer) */
const FRAME_RADIUS = 20
/** on-screen height of a rail: pinned rails are always RAIL_H; ones on their frame scale down to RAIL_MIN_H far out */
const RAIL_H = 28
const RAIL_MIN_H = 18
/** zoom at and above which the rail on its frame shows everything, and below which only glyph and counts */
const FULL_ZOOM = 0.28
const MIN_ZOOM = 0.13
/** a rail narrower than this drops the step in progress; narrower than TINY_W, its state word too */
const NARROW_W = 260
const TINY_W = 120
/** rails are left out when less than this much of their frame is on screen */
const VISIBLE_MIN_W = 24
/** room kept under the top bar (and the tray under it) for pinned rails */
const INSET_GAP = 6
const INSET_MEASURE_MS = 400

/** Where a frame's rail is on screen. */
export interface RailBox {
	x: number
	y: number
	w: number
	h: number
	/** stuck to the top of the screen: its frame's top is above it */
	pinned: boolean
	level: RailLevel
	/** its left/right ends are the frame's (not clipped to the screen) */
	leftEdge: boolean
	rightEdge: boolean
	/** the frame on screen */
	frame: Box
	/** frame corner radius on screen */
	radius: number
}

/**
 * Where a frame's rail goes (screen px): along the top edge of the frame, or, once the frame's top
 * is above `inset` while the frame is still on screen, pinned at `inset`, clipped to the frame's
 * on-screen left and right; the frame's bottom pushes a pinned rail up and away. Null when the
 * frame isn't on screen.
 */
export function railBox(section: SectionLayout, shift: Vec | undefined, camera: Camera, viewport: { w: number; h: number }, inset: number): RailBox | null {
	const z = camera.z
	const fx = (section.box.x + (shift?.x ?? 0) + camera.x) * z
	const fy = (section.box.y + (shift?.y ?? 0) + camera.y) * z
	const fw = section.box.w * z
	const fh = section.box.h * z
	if (fx >= viewport.w || fx + fw <= 0 || fy >= viewport.h || fy + fh <= 0) return null
	const left = Math.max(fx + 1, 0)
	const right = Math.min(fx + fw - 1, viewport.w)
	if (right - left < VISIBLE_MIN_W) return null
	const pinned = fy < inset && fy + fh > inset
	const h = pinned ? RAIL_H : Math.round(Math.min(RAIL_H, Math.max(RAIL_MIN_H, 44 * z)))
	const y = pinned ? Math.min(inset, fy + fh - h - 1) : fy + 1
	if (y + h <= 0 || y >= viewport.h) return null
	const w = right - left
	const level: RailLevel = pinned ? (w < TINY_W ? 'min' : 'full') : z >= FULL_ZOOM ? 'full' : z >= MIN_ZOOM ? 'compact' : 'min'
	return {
		x: left,
		y,
		w,
		h,
		pinned,
		level: w < TINY_W && level === 'full' ? 'compact' : level,
		leftEdge: left === fx + 1,
		rightEdge: right === fx + fw - 1,
		frame: { x: fx, y: fy, w: fw, h: fh },
		radius: Math.min(FRAME_RADIUS * z, FRAME_RADIUS),
	}
}

interface RailView {
	el: HTMLDivElement
	key: string
}

/**
 * The status rails along the top of live frames (conjured sessions, and sessions with something
 * queued for attention), drawn as DOM in screen space over the canvas: they stay crisp and keep
 * their size at any zoom, degrade to glyph and counts far out, and stick to the top of the screen
 * while their frame is scrolled up past it (see railBox). Clicking a rail opens the session's C
 * dialog; clicking its queued count plays the walkthrough.
 */
export class Rails {
	private host: HTMLDivElement
	private views = new Map<string, RailView>()
	private dispose: () => void
	private lastTick = 0
	private lastMeasure = -Infinity
	/** where pinned rails go (screen px from the top of the canvas): under the top bar and tray */
	inset = 58

	constructor(
		parent: HTMLElement,
		private editor: Editor,
		private conjure: Conjure,
		private attention: Attention,
	) {
		this.host = document.createElement('div')
		this.host.className = 'rails'
		parent.appendChild(this.host)
		this.host.addEventListener('pointerdown', (e) => {
			if ((e.target as Element).closest('.rail')) e.stopPropagation()
		})
		this.host.addEventListener('dblclick', (e) => e.stopPropagation())
		this.host.addEventListener('click', (e) => {
			const target = e.target as Element
			const rail = target.closest<HTMLElement>('.rail')
			const sessionId = rail?.dataset.session
			if (!sessionId) return
			e.stopPropagation()
			if (target.closest('[data-calls]')) this.attention.open(sessionId, { fromRail: true })
			else if (this.conjure.dialog.peek() === sessionId) this.conjure.closeDialog()
			else this.conjure.openDialog(sessionId)
		})
		this.dispose = editor.onFrame((now) => this.update(now))
	}

	/** The rail of a session's frame on screen right now, if it has one and it's showing. */
	box(sessionId: string): RailBox | null {
		const section = this.editor.layout.get().sections.find((s) => s.id === sessionId)
		if (!section || !this.conjure.status(sessionId)) return null
		return railBox(section, this.editor.frameShift.get(sessionId), this.editor.camera.get(), this.editor.viewport.get(), this.inset)
	}

	private measureInset(now: number) {
		if (now - this.lastMeasure < INSET_MEASURE_MS) return
		this.lastMeasure = now
		const top = this.host.getBoundingClientRect().top
		let bottom = 0
		for (const el of document.querySelectorAll<HTMLElement>('.top-bar > *, .toolbar.tools, .top-stack > *')) {
			const r = el.getBoundingClientRect()
			if (r.height && r.bottom - top < 200) bottom = Math.max(bottom, r.bottom - top)
		}
		if (bottom) this.inset = Math.round(bottom + INSET_GAP)
	}

	private update(now: number) {
		this.measureInset(now)
		const editor = this.editor
		const statuses = this.conjure.statuses.get()
		const camera = editor.camera.peek()
		const viewport = editor.viewport.peek()
		const open = this.conjure.dialog.peek()
		const walking = this.attention.walk.peek()?.sessionId
		const seen = new Set<string>()
		for (const section of editor.layout.get().sections) {
			const s = statuses.get(section.id)
			if (!s) continue
			const box = railBox(section, editor.frameShift.get(section.id), camera, viewport, this.inset)
			if (!box) continue
			seen.add(section.id)
			let view = this.views.get(section.id)
			if (!view) {
				const el = document.createElement('div')
				el.className = 'rail'
				el.dataset.session = section.id
				el.setAttribute('role', 'button')
				this.host.appendChild(el)
				view = { el, key: '' }
				this.views.set(section.id, view)
			}
			this.render(view, s, section, box, open === section.id || walking === section.id)
			const { el } = view
			el.style.transform = `translate(${Math.round(box.x)}px, ${Math.round(box.y)}px)`
			el.style.width = `${Math.round(box.w)}px`
			el.style.height = `${box.h}px`
			const r = box.pinned ? 0 : Math.max(0, box.radius - 1)
			el.style.borderRadius = `${box.leftEdge ? r : 0}px ${box.rightEdge ? r : 0}px 0 0`
			el.style.paddingLeft = `${box.leftEdge && !box.pinned ? Math.max(10, Math.min(40 * camera.z, 40)) : 12}px`
		}
		for (const [id, view] of this.views) {
			if (seen.has(id)) continue
			view.el.remove()
			this.views.delete(id)
		}
		if (now - this.lastTick > 500) {
			this.lastTick = now
			tickElapsed(this.host)
		}
	}

	private render(view: RailView, s: LiveStatus, section: SectionLayout, box: RailBox, active: boolean) {
		const narrow = box.w < NARROW_W
		const title = box.pinned ? sectionTitle(section) : undefined
		const queuedText = s.firstQueued ? this.attention.preview(s.firstQueued) : undefined
		const key = JSON.stringify([s, box.level, box.pinned, narrow, title, queuedText, active, s.endedAt ? Math.floor(Date.now() / 30_000) : 0])
		if (key === view.key) return
		view.key = key
		view.el.className = `rail rail-${RAIL_KIND[s.state]} lv-${box.level}${box.pinned ? ' pinned' : ''}${narrow ? ' narrow' : ''}${active ? ' active' : ''}`
		view.el.style.setProperty('--c', s.color)
		view.el.title = railTooltip(s)
		view.el.innerHTML = railHtml(s, { level: box.level, title, queuedText, narrow })
	}

	destroy() {
		this.dispose()
		this.host.remove()
	}
}

export function sectionTitle(section: SectionLayout) {
	return !section.title.trim() || section.title === section.id ? 'Untitled session' : section.title
}

function railTooltip(s: LiveStatus) {
	if (!s.conjured) return s.queued ? 'Wants to show you something: click for its session' : ''
	if (s.state === 'asleep') return 'Asleep: its owner’s tab isn’t open. Click for more (C)'
	return 'Click for the session (C)'
}
