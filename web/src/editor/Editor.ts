import type { Item, Session } from '../../../shared/types'
import { atom, computed, getGlobalEpoch, transact } from '../state/signals'
import { Box, clamp, easeInOutCubic, lerp, Vec } from './geometry'
import { computeLayout, LAYOUT, type Layout } from './layout'
import { StateNode } from './StateNode'
import { HandTool } from './tools/HandTool'
import { SelectTool } from './tools/SelectTool'
import type { EditorEvent, Modifiers, Target } from './types'

export interface Camera {
	x: number
	y: number
	z: number
}

const MIN_ZOOM = 0.02
const MAX_ZOOM = 8
const ZOOM_STEPS = [0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8]
const DRAG_DISTANCE = 4
const ANIMATION_MS = 320
const PAN_FRICTION = 0.0045 // per ms
const ZOOM_TO_PADDING = 48

class Root extends StateNode {
	static override id = 'root'
	static override initial = 'select'
	static override children = () => [SelectTool, HandTool]
}

export type ToolId = 'select' | 'hand'

/** Pointer and keyboard state, kept up to date before events reach the state chart. */
export class Inputs {
	originScreenPoint: Vec = { x: 0, y: 0 }
	originPagePoint: Vec = { x: 0, y: 0 }
	currentScreenPoint: Vec = { x: 0, y: 0 }
	currentPagePoint: Vec = { x: 0, y: 0 }
	previousScreenPoint: Vec = { x: 0, y: 0 }
	isPointing = false
	isDragging = false
	isPanning = false
	isPointerInside = false
	isSpaceDown = false
	shiftKey = false
	altKey = false
	ctrlKey = false
	metaKey = false
	/** smoothed pointer velocity in screen px / ms */
	velocity: Vec = { x: 0, y: 0 }
	lastMoveTime = 0
}

/**
 * The single entry point for everything on the canvas, like tldraw's Editor.
 * The renderer and UI only read signals from it and call its methods.
 */
export class Editor {
	// --- records ---
	readonly sessions = atom<Record<string, Session>>('sessions', {})
	readonly items = atom<Record<string, Item>>('items', {})

	// --- instance state ---
	readonly camera = atom<Camera>('camera', { x: 0, y: 0, z: 1 }, (a, b) => a.x === b.x && a.y === b.y && a.z === b.z)
	readonly viewport = atom<{ w: number; h: number }>('viewport', { w: 1, h: 1 }, (a, b) => a.w === b.w && a.h === b.h)
	readonly selectedIds = atom<string[]>('selectedIds', [], arrayEquals)
	readonly hoveredId = atom<string | null>('hoveredId', null)
	readonly brush = atom<Box | null>('brush', null)
	readonly cursor = atom<string>('cursor', 'default')
	/** Reactive copy of inputs.shiftKey, for UI that changes while shift is held. */
	readonly isShiftDown = atom<boolean>('isShiftDown', false)
	readonly toolPath = atom<string>('toolPath', '')
	readonly connection = atom<'connecting' | 'open' | 'closed'>('connection', 'connecting')

	// --- derived ---
	readonly layout = computed<Layout>('layout', () => computeLayout(this.sessions.get(), this.items.get()))
	readonly selectedSet = computed('selectedSet', () => new Set(this.selectedIds.get()))
	readonly currentToolId = computed('currentToolId', () => this.toolPath.get().split('.')[0] as ToolId)
	readonly viewportPageBounds = computed<Box>('viewportPageBounds', () => {
		const { x, y, z } = this.camera.get()
		const { w, h } = this.viewport.get()
		return { x: -x, y: -y, w: w / z, h: h / z }
	})

	readonly inputs = new Inputs()
	readonly root: Root

	private cameraAnimation: { from: Camera; to: Camera; start: number; duration: number } | null = null
	private panVelocity: Vec | null = null
	private frameListeners = new Set<(now: number, elapsed: number) => void>()
	private raf = 0
	private lastFrame = 0
	private disposers: (() => void)[] = []
	private container: HTMLElement | null = null

	constructor() {
		this.root = new Root(this)
		this.root.enter(undefined, '')
		this.onStateChange()
	}

	// ---------- records ----------

	loadSnapshot(sessions: Session[], items: Item[]) {
		transact(() => {
			this.sessions.set(Object.fromEntries(sessions.map((s) => [s.id, s])))
			this.items.set(Object.fromEntries(items.map((i) => [i.id, i])))
			const live = this.items.peek()
			this.selectedIds.update((ids) => ids.filter((id) => id in live))
		})
	}

	putSession(session: Session) {
		this.sessions.update((s) => ({ ...s, [session.id]: session }))
	}

	putItem(item: Item) {
		this.items.update((i) => ({ ...i, [item.id]: item }))
	}

	deleteSession(id: string) {
		transact(() => {
			this.sessions.update(({ [id]: _, ...rest }) => rest)
			this.items.update((items) => Object.fromEntries(Object.entries(items).filter(([, i]) => i.sessionId !== id)))
			const live = this.items.peek()
			this.selectedIds.update((ids) => ids.filter((s) => s in live))
		})
	}

	deleteItem(id: string) {
		transact(() => {
			this.items.update(({ [id]: _, ...rest }) => rest)
			this.selectedIds.update((ids) => ids.filter((s) => s !== id))
		})
	}

	// ---------- selection & hover ----------

	getSelectedIds() {
		return this.selectedIds.peek()
	}
	isSelected(id: string) {
		return this.selectedSet.get().has(id)
	}
	select(ids: string[]) {
		this.selectedIds.set(ids)
	}
	selectNone() {
		this.selectedIds.set([])
	}
	selectAll() {
		this.selectedIds.set([...this.layout.get().items.keys()])
	}
	setHovered(id: string | null) {
		this.hoveredId.set(id)
	}
	setBrush(brush: Box | null) {
		this.brush.set(brush)
	}
	setCursor(cursor: string) {
		this.cursor.set(cursor)
	}

	// ---------- tools ----------

	setCurrentTool(id: ToolId) {
		if (this.currentToolId.get() === id) return
		if (this.inputs.isPointing) this.dispatch({ name: 'cancel' })
		this.root.transition(id)
	}

	/** The cursor the current tool shows at rest (used after a space-pan ends). */
	private restingCursor() {
		return this.currentToolId.get() === 'hand' ? 'grab' : 'default'
	}

	// ---------- hit testing ----------

	getTargetAt(point: Vec): Target {
		const layout = this.layout.get()
		for (const section of layout.sections) {
			if (!Box.contains(section.box, point)) continue
			for (const id of section.itemIds) {
				const box = layout.items.get(id)
				if (box && Box.contains(box, point)) return { type: 'item', id }
			}
			return { type: 'section', id: section.id }
		}
		return { type: 'canvas' }
	}

	getItemsInBox(box: Box): string[] {
		const ids: string[] = []
		const layout = this.layout.get()
		for (const section of layout.sections) {
			if (!Box.intersects(section.box, box)) continue
			for (const id of section.itemIds) if (Box.intersects(layout.items.get(id)!, box)) ids.push(id)
		}
		return ids
	}

	// ---------- camera ----------

	screenToPage(p: Vec): Vec {
		const { x, y, z } = this.camera.peek()
		return { x: p.x / z - x, y: p.y / z - y }
	}

	pageToScreen(p: Vec): Vec {
		const { x, y, z } = this.camera.peek()
		return { x: (p.x + x) * z, y: (p.y + y) * z }
	}

	getZoom() {
		return this.camera.peek().z
	}

	setCamera(camera: Camera, opts: { animate?: boolean } = {}) {
		const next = { x: camera.x, y: camera.y, z: clamp(camera.z, MIN_ZOOM, MAX_ZOOM) }
		if (opts.animate) {
			this.panVelocity = null
			this.cameraAnimation = { from: this.camera.peek(), to: next, start: performance.now(), duration: ANIMATION_MS }
			return
		}
		this.camera.set(next)
		this.inputs.currentPagePoint = this.screenToPage(this.inputs.currentScreenPoint)
	}

	stopCameraMotion() {
		this.cameraAnimation = null
		this.panVelocity = null
	}

	/** Keep the camera gliding with the pointer's release velocity, if it was still moving. */
	flingCamera() {
		const { velocity, lastMoveTime } = this.inputs
		const stale = performance.now() - lastMoveTime > 60
		if (!stale && Math.hypot(velocity.x, velocity.y) > 0.2) this.panVelocity = { ...velocity }
	}

	panBy(dx: number, dy: number) {
		const { x, y, z } = this.camera.peek()
		this.setCamera({ x: x + dx / z, y: y + dy / z, z })
	}

	zoomAt(screenPoint: Vec, zoom: number, opts: { animate?: boolean } = {}) {
		const z = clamp(zoom, MIN_ZOOM, MAX_ZOOM)
		const cam = opts.animate && this.cameraAnimation ? this.cameraAnimation.to : this.camera.peek()
		const p = { x: screenPoint.x / cam.z - cam.x, y: screenPoint.y / cam.z - cam.y }
		this.setCamera({ x: screenPoint.x / z - p.x, y: screenPoint.y / z - p.y, z }, opts)
	}

	zoomIn() {
		const z = (this.cameraAnimation?.to ?? this.camera.peek()).z
		this.zoomAt(this.viewportCenter(), ZOOM_STEPS.find((s) => s > z * 1.01) ?? MAX_ZOOM, { animate: true })
	}

	zoomOut() {
		const z = (this.cameraAnimation?.to ?? this.camera.peek()).z
		this.zoomAt(this.viewportCenter(), [...ZOOM_STEPS].reverse().find((s) => s < z / 1.01) ?? MIN_ZOOM, { animate: true })
	}

	resetZoom() {
		this.zoomAt(this.viewportCenter(), 1, { animate: true })
	}

	zoomToBounds(bounds: Box, opts: { animate?: boolean; maxZoom?: number } = {}) {
		const { w, h } = this.viewport.peek()
		const pad = Math.min(ZOOM_TO_PADDING, w / 8, h / 8)
		const z = clamp(
			Math.min((w - pad * 2) / bounds.w, (h - pad * 2) / bounds.h),
			MIN_ZOOM,
			opts.maxZoom ?? MAX_ZOOM,
		)
		this.setCamera(
			{ x: w / 2 / z - (bounds.x + bounds.w / 2), y: h / 2 / z - (bounds.y + bounds.h / 2), z },
			{ animate: opts.animate ?? true },
		)
	}

	zoomToFit(opts: { animate?: boolean } = {}) {
		const bounds = this.layout.get().bounds
		if (bounds) this.zoomToBounds(bounds, { ...opts, maxZoom: 1 })
	}

	zoomToSelection() {
		const layout = this.layout.get()
		const bounds = Box.union(this.selectedIds.get().map((id) => layout.items.get(id)!).filter(Boolean))
		if (bounds) this.zoomToBounds(bounds)
	}

	/** Pan (keeping the zoom) so the box is centred in the viewport. */
	centerOn(box: Box, opts: { animate?: boolean } = {}) {
		const { w, h } = this.viewport.peek()
		const z = (this.cameraAnimation?.to ?? this.camera.peek()).z
		this.setCamera({ x: w / 2 / z - (box.x + box.w / 2), y: h / 2 / z - (box.y + box.h / 2), z }, { animate: opts.animate ?? true })
	}

	/**
	 * Select the neighbouring item and bring it into view: up/down within the column, left/right
	 * to the item at about the same height in the next column. With nothing selected, starts
	 * from the item nearest the middle of the screen.
	 */
	selectAdjacent(direction: 'up' | 'down' | 'left' | 'right') {
		const layout = this.layout.get()
		const selected = this.selectedIds.get()
		const anchor = selected[selected.length - 1]
		const sectionId = anchor && layout.sectionOf.get(anchor)
		let next: string | undefined

		if (sectionId && (direction === 'up' || direction === 'down')) {
			const ids = layout.sections.find((s) => s.id === sectionId)!.itemIds
			next = ids[ids.indexOf(anchor) + (direction === 'down' ? 1 : -1)]
			if (!next) return
		} else if (sectionId) {
			const from = layout.items.get(anchor)!
			const cy = from.y + from.h / 2
			const step = direction === 'right' ? 1 : -1
			const sections = layout.sections
			// Skip over empty columns.
			for (let i = sections.findIndex((s) => s.id === sectionId) + step; i >= 0 && i < sections.length; i += step) {
				let best = Infinity
				for (const id of sections[i].itemIds) {
					const b = layout.items.get(id)!
					const d = Math.max(b.y - cy, 0, cy - (b.y + b.h))
					if (d < best) {
						best = d
						next = id
					}
				}
				if (next) break
			}
			if (!next) return
		} else {
			const view = this.viewportPageBounds.get()
			const cx = view.x + view.w / 2
			const cy = view.y + view.h / 2
			let best = Infinity
			for (const [id, b] of layout.items) {
				const dx = Math.max(b.x - cx, 0, cx - (b.x + b.w))
				const dy = Math.max(b.y - cy, 0, cy - (b.y + b.h))
				const d = dx * dx + dy * dy
				if (d < best) {
					best = d
					next = id
				}
			}
			if (!next) return
		}

		this.select([next])
		this.stopCameraMotion()
		this.centerOn(this.getItemBoundsWithTitle(next)!, { animate: false })
	}

	zoomToItem(id: string) {
		const box = this.getItemBoundsWithTitle(id)
		if (box) this.zoomToBounds(box)
	}

	/** The item's box plus the title strip above it, if it has a title. */
	getItemBoundsWithTitle(id: string): Box | undefined {
		const box = this.layout.get().items.get(id)
		if (!box || !this.items.get()[id]?.title) return box
		return { x: box.x, y: box.y - LAYOUT.titleHeight, w: box.w, h: box.h + LAYOUT.titleHeight }
	}

	zoomToSection(id: string) {
		const section = this.layout.get().sections.find((s) => s.id === id)
		if (section) this.zoomToBounds(section.box)
	}

	private viewportCenter(): Vec {
		const { w, h } = this.viewport.peek()
		return { x: w / 2, y: h / 2 }
	}

	// ---------- events ----------

	dispatch(event: EditorEvent) {
		transact(() => this.root.handleEvent(event))
	}

	onStateChange() {
		this.toolPath.set(this.root?.getActivePath() ?? '')
	}

	private updateModifiers(e: Modifiers) {
		this.inputs.shiftKey = e.shiftKey
		this.isShiftDown.set(e.shiftKey)
		this.inputs.altKey = e.altKey
		this.inputs.ctrlKey = e.ctrlKey
		this.inputs.metaKey = e.metaKey
	}

	private pointerInfo(e: PointerEvent | MouseEvent) {
		const rect = this.container!.getBoundingClientRect()
		const point = { x: e.clientX - rect.left, y: e.clientY - rect.top }
		return { point, modifiers: { shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey } }
	}

	private handlePointerDown = (e: PointerEvent) => {
		if (e.button === 2) return
		const { point, modifiers } = this.pointerInfo(e)
		const { inputs } = this
		this.container!.setPointerCapture(e.pointerId)
		this.stopCameraMotion()
		this.updateModifiers(modifiers)
		inputs.originScreenPoint = inputs.currentScreenPoint = inputs.previousScreenPoint = point
		inputs.originPagePoint = inputs.currentPagePoint = this.screenToPage(point)
		inputs.isPointing = true
		inputs.isDragging = false
		inputs.velocity = { x: 0, y: 0 }
		inputs.lastMoveTime = performance.now()

		// Panning (space + drag, or middle mouse) works the same in every tool state.
		if (e.button === 1 || inputs.isSpaceDown) {
			e.preventDefault()
			inputs.isPanning = true
			this.setCursor('grabbing')
			this.setHovered(null)
			return
		}
		this.dispatch({ name: 'pointer_down', point, button: e.button, target: this.getTargetAt(inputs.currentPagePoint), ...modifiers })
	}

	private handlePointerMove = (e: PointerEvent) => {
		const { point, modifiers } = this.pointerInfo(e)
		const { inputs } = this
		const now = performance.now()
		const dt = Math.max(1, now - inputs.lastMoveTime)
		const delta = Vec.sub(point, inputs.currentScreenPoint)
		inputs.velocity = {
			x: lerp(inputs.velocity.x, delta.x / dt, 0.5),
			y: lerp(inputs.velocity.y, delta.y / dt, 0.5),
		}
		inputs.lastMoveTime = now
		inputs.isPointerInside = true
		this.updateModifiers(modifiers)
		inputs.previousScreenPoint = inputs.currentScreenPoint
		inputs.currentScreenPoint = point

		if (inputs.isPanning) {
			this.panBy(delta.x, delta.y)
			return
		}
		inputs.currentPagePoint = this.screenToPage(point)
		if (inputs.isPointing && !inputs.isDragging && Vec.dist(point, inputs.originScreenPoint) > DRAG_DISTANCE) {
			inputs.isDragging = true
		}
		this.dispatch({ name: 'pointer_move', point, button: e.button, target: this.getTargetAt(inputs.currentPagePoint), ...modifiers })
	}

	private handlePointerUp = (e: PointerEvent) => {
		const { point, modifiers } = this.pointerInfo(e)
		const { inputs } = this
		this.updateModifiers(modifiers)
		const wasPanning = inputs.isPanning
		inputs.isPointing = false
		inputs.isDragging = false
		inputs.isPanning = false
		if (this.container!.hasPointerCapture(e.pointerId)) this.container!.releasePointerCapture(e.pointerId)

		if (wasPanning) {
			this.flingCamera()
			this.setCursor(inputs.isSpaceDown ? 'grab' : this.restingCursor())
			return
		}
		this.dispatch({ name: 'pointer_up', point, button: e.button, target: this.getTargetAt(inputs.currentPagePoint), ...modifiers })
	}

	private handlePointerLeave = () => {
		if (!this.inputs.isPointing) {
			this.inputs.isPointerInside = false
			this.setHovered(null)
		}
	}

	private handleDoubleClick = (e: MouseEvent) => {
		if (this.inputs.isSpaceDown) return
		const { point, modifiers } = this.pointerInfo(e)
		this.dispatch({ name: 'double_click', point, target: this.getTargetAt(this.screenToPage(point)), ...modifiers })
	}

	private handleWheel = (e: WheelEvent) => {
		e.preventDefault()
		this.cameraAnimation = null
		this.panVelocity = null
		const { point } = this.pointerInfo(e)
		this.inputs.currentScreenPoint = point
		this.inputs.isPointerInside = true
		const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.viewport.peek().h : 1
		const dx = e.deltaX * scale
		const dy = e.deltaY * scale

		if (e.ctrlKey || e.metaKey || e.shiftKey) {
			// Trackpad pinch arrives as ctrl+wheel with small deltas; mouse wheel + modifier as big ones.
			// With shift held, some platforms (macOS) report the wheel as horizontal, so take either axis.
			const delta = dy !== 0 ? dy : dx
			const z = this.camera.peek().z
			const factor = Math.exp(-clamp(delta, -50, 50) * 0.01)
			this.zoomAt(point, z * factor)
		} else {
			this.panBy(-dx, -dy)
		}
	}

	private handleKeyDown = (e: KeyboardEvent) => {
		if (isEditable(e.target)) return
		this.updateModifiers(e)
		const mod = e.metaKey || e.ctrlKey

		if (e.code === 'Space') {
			e.preventDefault()
			if (!this.inputs.isSpaceDown) {
				this.inputs.isSpaceDown = true
				if (!this.inputs.isPointing) this.setCursor('grab')
			}
			return
		}

		// Global shortcuts. Everything else goes to the state chart.
		if (e.shiftKey && e.code === 'Digit1') return this.zoomToFit()
		if (e.shiftKey && e.code === 'Digit2') return this.zoomToSelection()
		if (e.shiftKey && e.code === 'Digit0') return this.resetZoom()
		if (!mod && (e.key === '=' || e.key === '+')) return this.zoomIn()
		if (!mod && (e.key === '-' || e.key === '_')) return this.zoomOut()
		if (mod && (e.key === '=' || e.key === '+')) return e.preventDefault(), this.zoomIn()
		if (mod && e.key === '-') return e.preventDefault(), this.zoomOut()
		if (mod && e.key === 'a') return e.preventDefault(), this.selectAll()
		const arrows = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' } as const
		if (!this.inputs.isPointing && e.key in arrows) {
			e.preventDefault()
			return this.selectAdjacent(arrows[e.key as keyof typeof arrows])
		}
		if (!mod && !e.altKey && (e.key === 'v' || e.key === 'V')) return this.setCurrentTool('select')
		if (!mod && !e.altKey && (e.key === 'h' || e.key === 'H')) return this.setCurrentTool('hand')

		this.dispatch({ name: 'key_down', key: e.key, code: e.code, shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey })
	}

	private handleKeyUp = (e: KeyboardEvent) => {
		this.updateModifiers(e)
		if (e.code === 'Space') {
			this.inputs.isSpaceDown = false
			if (!this.inputs.isPanning) this.setCursor(this.restingCursor())
			return
		}
		this.dispatch({ name: 'key_up', key: e.key, code: e.code, shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey })
	}

	private handleBlur = () => {
		this.inputs.isSpaceDown = false
		this.updateModifiers({ shiftKey: false, altKey: false, ctrlKey: false, metaKey: false })
		if (this.inputs.isPointing) {
			this.inputs.isPointing = this.inputs.isDragging = this.inputs.isPanning = false
			this.dispatch({ name: 'cancel' })
		}
	}

	// ---------- lifecycle ----------

	mount(container: HTMLElement) {
		this.container = container
		const listen = <K extends keyof HTMLElementEventMap>(
			el: HTMLElement | Window,
			type: K,
			fn: (e: HTMLElementEventMap[K]) => void,
			opts?: AddEventListenerOptions,
		) => {
			el.addEventListener(type, fn as EventListener, opts)
			this.disposers.push(() => el.removeEventListener(type, fn as EventListener, opts))
		}
		listen(container, 'pointerdown', this.handlePointerDown)
		listen(container, 'pointermove', this.handlePointerMove)
		listen(container, 'pointerup', this.handlePointerUp)
		listen(container, 'pointercancel', this.handlePointerUp)
		listen(container, 'pointerleave', this.handlePointerLeave)
		listen(container, 'dblclick', this.handleDoubleClick)
		listen(container, 'wheel', this.handleWheel, { passive: false })
		listen(container, 'contextmenu', (e) => e.preventDefault())
		listen(window, 'keydown', this.handleKeyDown)
		listen(window, 'keyup', this.handleKeyUp)
		listen(window, 'blur', this.handleBlur)

		const ro = new ResizeObserver(() => {
			const rect = container.getBoundingClientRect()
			this.viewport.set({ w: rect.width, h: rect.height })
		})
		ro.observe(container)
		this.disposers.push(() => ro.disconnect())

		this.lastFrame = performance.now()
		const loop = (now: number) => {
			this.raf = requestAnimationFrame(loop)
			const elapsed = Math.min(now - this.lastFrame, 100)
			this.lastFrame = now
			this.tick(now, elapsed)
			for (const fn of this.frameListeners) fn(now, elapsed)
		}
		this.raf = requestAnimationFrame(loop)
		this.disposers.push(() => cancelAnimationFrame(this.raf))
	}

	dispose() {
		for (const d of this.disposers.splice(0)) d()
		this.container = null
	}

	onFrame(fn: (now: number, elapsed: number) => void) {
		this.frameListeners.add(fn)
		return () => this.frameListeners.delete(fn)
	}

	/** Camera animation and pan inertia, then a tick for the state chart. */
	private tick(now: number, elapsed: number) {
		transact(() => {
			const anim = this.cameraAnimation
			if (anim) {
				const t = clamp((now - anim.start) / anim.duration, 0, 1)
				const k = easeInOutCubic(t)
				// Interpolate zoom geometrically so it feels even, and keep the motion straight in screen space.
				const z = anim.from.z * Math.pow(anim.to.z / anim.from.z, k)
				const { w, h } = this.viewport.peek()
				const cFrom = { x: w / 2 / anim.from.z - anim.from.x, y: h / 2 / anim.from.z - anim.from.y }
				const cTo = { x: w / 2 / anim.to.z - anim.to.x, y: h / 2 / anim.to.z - anim.to.y }
				const zk = anim.from.z === anim.to.z ? k : (1 / z - 1 / anim.from.z) / (1 / anim.to.z - 1 / anim.from.z)
				const cx = lerp(cFrom.x, cTo.x, zk)
				const cy = lerp(cFrom.y, cTo.y, zk)
				this.setCamera(t >= 1 ? anim.to : { x: w / 2 / z - cx, y: h / 2 / z - cy, z })
				if (t >= 1) this.cameraAnimation = null
			}

			const v = this.panVelocity
			if (v) {
				this.panBy(v.x * elapsed, v.y * elapsed)
				const decay = Math.exp(-PAN_FRICTION * elapsed)
				v.x *= decay
				v.y *= decay
				if (Math.hypot(v.x, v.y) < 0.01) this.panVelocity = null
			}

			this.root.handleEvent({ name: 'tick', elapsed })
		})
	}

	isCameraMoving() {
		return this.cameraAnimation !== null || this.panVelocity !== null
	}

	getEpoch() {
		return getGlobalEpoch()
	}
}

function arrayEquals(a: string[], b: string[]) {
	return a.length === b.length && a.every((v, i) => v === b[i])
}

function isEditable(target: EventTarget | null) {
	const el = target as HTMLElement | null
	return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}
