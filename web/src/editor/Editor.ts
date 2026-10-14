import type { Item, Session } from '../../../shared/types'
import { atom, computed, getGlobalEpoch, react, transact } from '../state/signals'
import { Box, clamp, easeInOutCubic, lerp, Vec } from './geometry'
import { Deletions } from './Deletions'
import { computeLayout, frameTitleBox, LAYOUT, type Layout } from './layout'
import { noteKey, parseSelectionId, type SelectionKind } from './selection'
import { StateNode } from './StateNode'
import { HandTool } from './tools/HandTool'
import { NoteTool } from './tools/NoteTool'
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
/** Screen px a finger moves before a touch counts as a pan rather than a tap */
const TOUCH_SLOP = 8
/** Two taps this close in time (ms) and space (px) are a double-tap */
const DOUBLE_TAP_MS = 300
const DOUBLE_TAP_DISTANCE = 30
const ANIMATION_MS = 320
const PAN_FRICTION = 0.0045 // per ms
const ZOOM_TO_PADDING = 48
/** Opening view: zoom limits, side padding, and where the first row sits (fraction of screen height) */
const INITIAL_ZOOM = { min: 0.3, max: 0.85 }
const INITIAL_PADDING = 48
const INITIAL_FIRST_ROW = 0.3
/** The widest (in screen px) an item gets when focused by double-click */
const FOCUS_MAX_WIDTH = 1350
/** The highest zoom focusing something (double-click, deep link, zoom-to-selection) goes to */
const FOCUS_MAX_ZOOM = 2

class Root extends StateNode {
	static override id = 'root'
	static override initial = 'select'
	static override children = () => [SelectTool, HandTool, NoteTool]
}

export type ToolId = 'select' | 'hand' | 'note'

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
	/** Sticky notes' page boxes (ignoring their slight tilt), kept up to date by SharedNotes. */
	readonly noteBoxes = atom<Record<string, Box>>('noteBoxes', {}, boxRecordEquals)

	// --- instance state ---
	readonly camera = atom<Camera>('camera', { x: 0, y: 0, z: 1 }, (a, b) => a.x === b.x && a.y === b.y && a.z === b.z)
	readonly viewport = atom<{ w: number; h: number }>('viewport', { w: 1, h: 1 }, (a, b) => a.w === b.w && a.h === b.h)
	/** Items, session frames and notes; see selection.ts for how the kinds are told apart. */
	readonly selectedIds = atom<string[]>('selectedIds', [], arrayEquals)
	readonly hoveredId = atom<string | null>('hoveredId', null)
	readonly brush = atom<Box | null>('brush', null)
	readonly cursor = atom<string>('cursor', 'default')
	/** Where the pointer is on the page, or null when it's outside the canvas (used for presence). */
	readonly pointerPage = atom<Vec | null>('pointerPage', null, (a, b) => a === b || (!!a && !!b && a.x === b.x && a.y === b.y))
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
	/** Set when sticky notes are available (edit role); the note tool calls it to drop a note. */
	createNote: ((point: Vec) => void) | null = null
	readonly deletions = new Deletions(this)
	readonly root: Root

	private cameraAnimation: { from: Camera; to: Camera; start: number; duration: number } | null = null
	private panVelocity: Vec | null = null
	private frameListeners = new Set<(now: number, elapsed: number) => void>()
	private raf = 0
	private lastFrame = 0
	private disposers: (() => void)[] = []
	private container: HTMLElement | null = null
	/** Fingers on the canvas (screen points), see the touch handlers. */
	private touches = new Map<number, Vec>()
	private touchMode: 'pending' | 'pan' | 'pinch' | null = null
	private pinch: { startDistance: number; startZoom: number; pagePoint: Vec } | null = null
	private lastTap: { time: number; point: Vec } | null = null
	private lastPointerType = 'mouse'

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
			this.pruneSelection(['item', 'frame'])
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
			this.pruneSelection(['item', 'frame'])
		})
	}

	deleteItem(id: string) {
		transact(() => {
			this.items.update(({ [id]: _, ...rest }) => rest)
			this.selectedIds.update((ids) => ids.filter((s) => s !== id))
		})
	}

	setNoteBoxes(boxes: Record<string, Box>) {
		transact(() => {
			this.noteBoxes.set(boxes)
			this.pruneSelection(['note'])
		})
	}

	/** Drop selected things of these kinds that no longer exist. */
	private pruneSelection(kinds: SelectionKind[]) {
		const items = this.items.peek()
		const sessions = this.sessions.peek()
		const notes = this.noteBoxes.peek()
		this.selectedIds.update((ids) =>
			ids.filter((key) => {
				const { kind, id } = parseSelectionId(key)
				if (!kinds.includes(kind)) return true
				return kind === 'frame' ? id in sessions : kind === 'note' ? id in notes : id in items
			}),
		)
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
	/** Shift-click: add the key, or remove it if it's already selected. */
	toggleSelected(key: string) {
		const ids = this.selectedIds.peek()
		this.selectedIds.set(ids.includes(key) ? ids.filter((k) => k !== key) : [...ids, key])
	}
	selectNone() {
		this.selectedIds.set([])
	}
	selectAll() {
		this.selectedIds.set([...this.layout.get().items.keys(), ...Object.keys(this.noteBoxes.get()).map(noteKey)])
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
		const tool = this.currentToolId.get()
		return tool === 'hand' ? 'grab' : tool === 'note' ? 'crosshair' : 'default'
	}

	// ---------- hit testing ----------

	getTargetAt(point: Vec): Target {
		const layout = this.layout.get()
		const z = this.camera.peek().z
		for (const section of layout.sections) {
			if (Box.contains(frameTitleBox(section, z), point)) return { type: 'frame_title', id: section.id }
		}
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

	/** Items and notes touching the box (frames are only selected by their title). */
	getSelectableInBox(box: Box): string[] {
		const ids: string[] = []
		const layout = this.layout.get()
		for (const section of layout.sections) {
			if (!Box.intersects(section.box, box)) continue
			for (const id of section.itemIds) if (Box.intersects(layout.items.get(id)!, box)) ids.push(id)
		}
		for (const [id, note] of Object.entries(this.noteBoxes.get())) if (Box.intersects(note, box)) ids.push(noteKey(id))
		return ids
	}

	/** The page box of a selection key, if the thing exists. */
	getSelectionBounds(key: string): Box | undefined {
		const { kind, id } = parseSelectionId(key)
		if (kind === 'frame') return this.layout.get().sections.find((s) => s.id === id)?.box
		if (kind === 'note') return this.noteBoxes.get()[id]
		return this.layout.get().items.get(id)
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
		if (this.inputs.isPointerInside) this.pointerPage.set(this.inputs.currentPagePoint)
	}

	/** The camera that fits `bounds` in the viewport with `padding` screen px around it. */
	getCameraForBounds(bounds: Box, opts: { padding?: number; maxZoom?: number } = {}): Camera {
		const { w, h } = this.viewport.peek()
		const pad = Math.min(opts.padding ?? ZOOM_TO_PADDING, w / 8, h / 8)
		const z = clamp(Math.min((w - pad * 2) / bounds.w, (h - pad * 2) / bounds.h), MIN_ZOOM, opts.maxZoom ?? MAX_ZOOM)
		return { x: w / 2 / z - (bounds.x + bounds.w / 2), y: h / 2 / z - (bounds.y + bounds.h / 2), z }
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

	/** Fit the bounds to the screen, never zooming past FOCUS_MAX_ZOOM (or opts.maxZoom if lower). */
	zoomToBounds(bounds: Box, opts: { animate?: boolean; maxZoom?: number } = {}) {
		const maxZoom = Math.min(opts.maxZoom ?? FOCUS_MAX_ZOOM, FOCUS_MAX_ZOOM)
		this.setCamera(this.getCameraForBounds(bounds, { maxZoom }), { animate: opts.animate ?? true })
	}

	zoomToFit(opts: { animate?: boolean } = {}) {
		const bounds = this.layout.get().bounds
		if (bounds) this.zoomToBounds(bounds, { ...opts, maxZoom: 1 })
	}

	/**
	 * The view a page opens with: content centred horizontally, zoomed to fit its width (within
	 * INITIAL_ZOOM limits), and the first row of items INITIAL_FIRST_ROW of the way down the screen.
	 */
	goToInitialView() {
		const layout = this.layout.get()
		const { w, h } = this.viewport.peek()
		if (!layout.bounds) return
		const z = clamp((w - INITIAL_PADDING * 2) / layout.bounds.w, INITIAL_ZOOM.min, INITIAL_ZOOM.max)
		const first = layout.sections[0]
		const firstItem = first?.itemIds[0]
		const top = firstItem ? this.getItemBoundsWithTitle(firstItem)!.y : (first?.box.y ?? layout.bounds.y)
		this.stopCameraMotion()
		this.setCamera({
			x: w / 2 / z - (layout.bounds.x + layout.bounds.w / 2),
			y: (h * INITIAL_FIRST_ROW) / z - top,
			z,
		})
	}

	/** Runs fn once the viewport has a real size (the ResizeObserver reports it asynchronously). */
	whenViewportReady(fn: () => void) {
		if (this.viewport.peek().w > 1) return fn()
		const stop = react(() => {
			if (this.viewport.get().w <= 1) return
			queueMicrotask(() => stop())
			fn()
		})
	}

	zoomToSelection() {
		const bounds = Box.union(
			this.selectedIds
				.get()
				.map((key) => this.getSelectionBounds(key))
				.filter((b): b is Box => !!b),
		)
		if (bounds) this.zoomToBounds(bounds)
	}

	/** Pan (keeping the zoom) so the box is centred in the viewport. */
	centerOn(box: Box, opts: { animate?: boolean } = {}) {
		const { w, h } = this.viewport.peek()
		const z = (this.cameraAnimation?.to ?? this.camera.peek()).z
		this.setCamera({ x: w / 2 / z - (box.x + box.w / 2), y: h / 2 / z - (box.y + box.h / 2), z }, { animate: opts.animate ?? true })
	}

	/**
	 * Select the neighbouring item and bring it into view: left/right steps through the item's
	 * group, up/down moves to the nearest item in the row above/below within the same session
	 * frame. With nothing selected, starts from the item nearest the middle of the screen.
	 */
	selectAdjacent(direction: 'up' | 'down' | 'left' | 'right') {
		const layout = this.layout.get()
		const selected = this.selectedIds.get().filter((key) => parseSelectionId(key).kind === 'item')
		const anchor = selected[selected.length - 1]
		const sectionId = anchor && layout.sectionOf.get(anchor)
		let next: string | undefined

		if (sectionId && (direction === 'left' || direction === 'right')) {
			// Step through the group's items in order; stop at either end.
			const groupId = layout.groupOf.get(anchor)
			const ids = layout.groups.find((g) => g.id === groupId)?.itemIds ?? []
			next = ids[ids.indexOf(anchor) + (direction === 'right' ? 1 : -1)]
			if (!next) return
		} else if (sectionId) {
			// The nearest row above/below within the same session frame (crossing groups), then the
			// item in it closest horizontally. Never jumps to another frame.
			const from = layout.items.get(anchor)!
			const cx = from.x + from.w / 2
			let rowGap = Infinity
			let best = Infinity
			const ids = layout.sections.find((s) => s.id === sectionId)!.itemIds
			for (const id of ids) {
				const b = layout.items.get(id)!
				const gap = direction === 'down' ? b.y - (from.y + from.h) : from.y - (b.y + b.h)
				if (gap < 0) continue
				const dx = Math.max(b.x - cx, 0, cx - (b.x + b.w))
				if (gap < rowGap - 1 || (Math.abs(gap - rowGap) <= 1 && dx < best)) {
					rowGap = Math.min(rowGap, gap)
					best = dx
					next = id
				}
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

	/** Fit the item to the screen, but never wider than FOCUS_MAX_WIDTH screen pixels or past FOCUS_MAX_ZOOM. */
	zoomToItem(id: string, opts: { animate?: boolean } = {}) {
		const box = this.getItemBoundsWithTitle(id)
		if (box) this.zoomToBounds(box, { ...opts, maxZoom: FOCUS_MAX_WIDTH / box.w })
	}

	/**
	 * Select one thing by its selection key and zoom to it: items like a double-click, session
	 * frames and notes to their whole box. Returns false (and changes nothing) if it doesn't exist.
	 */
	focusSelectionKey(key: string, opts: { animate?: boolean } = {}): boolean {
		const { kind, id } = parseSelectionId(key)
		const box = this.getSelectionBounds(key)
		if (!box) return false
		this.stopCameraMotion()
		this.select([key])
		if (kind === 'item') this.zoomToItem(id, opts)
		else this.zoomToBounds(box, opts)
		return true
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
		this.lastPointerType = e.pointerType
		if (e.pointerType === 'touch') return this.handleTouchDown(e)
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
		if (e.pointerType === 'touch') return this.handleTouchMove(e)
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
		this.pointerPage.set(inputs.currentPagePoint)
		if (inputs.isPointing && !inputs.isDragging && Vec.dist(point, inputs.originScreenPoint) > DRAG_DISTANCE) {
			inputs.isDragging = true
		}
		this.dispatch({ name: 'pointer_move', point, button: e.button, target: this.getTargetAt(inputs.currentPagePoint), ...modifiers })
	}

	private handlePointerUp = (e: PointerEvent) => {
		if (e.pointerType === 'touch') return this.handleTouchUp(e)
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
			this.pointerPage.set(null)
		}
	}

	private handleDoubleClick = (e: MouseEvent) => {
		// Touch double-taps are recognised in handleTouchUp; ignore any dblclick the browser adds.
		if (this.inputs.isSpaceDown || this.lastPointerType === 'touch') return
		const { point, modifiers } = this.pointerInfo(e)
		this.dispatch({ name: 'double_click', point, target: this.getTargetAt(this.screenToPage(point)), ...modifiers })
	}

	// ---------- touch ----------
	// One finger: a tap is a click (two quick taps a double-click), a drag pans in every tool.
	// Two fingers: pinch to zoom around their midpoint while panning with it. The state chart only
	// ever sees taps, as a pointer_down/pointer_up pair, so mouse and pen behave exactly as before.

	private handleTouchDown(e: PointerEvent) {
		const { point, modifiers } = this.pointerInfo(e)
		const { inputs } = this
		try {
			this.container!.setPointerCapture(e.pointerId)
		} catch {}
		this.touches.set(e.pointerId, point)
		this.stopCameraMotion()
		if (this.touches.size === 1) {
			this.updateModifiers(modifiers)
			this.touchMode = 'pending'
			inputs.originScreenPoint = inputs.currentScreenPoint = inputs.previousScreenPoint = point
			inputs.originPagePoint = inputs.currentPagePoint = this.screenToPage(point)
			inputs.isPointing = true
			inputs.isDragging = false
			inputs.isPanning = false
			inputs.velocity = { x: 0, y: 0 }
			inputs.lastMoveTime = performance.now()
			return
		}
		this.lastTap = null
		this.startPinch()
	}

	private startPinch() {
		const [a, b] = this.touches.values()
		const center = midpoint(a, b)
		this.touchMode = 'pinch'
		this.pinch = { startDistance: Math.max(1, Vec.dist(a, b)), startZoom: this.camera.peek().z, pagePoint: this.screenToPage(center) }
		this.inputs.isPanning = true
		this.inputs.isDragging = true
		this.setHovered(null)
	}

	private handleTouchMove(e: PointerEvent) {
		if (!this.touches.has(e.pointerId)) return
		const { point } = this.pointerInfo(e)
		this.touches.set(e.pointerId, point)
		const { inputs } = this

		if (this.touchMode === 'pinch' && this.pinch) {
			const [a, b] = this.touches.values()
			const center = midpoint(a, b)
			const { startDistance, startZoom, pagePoint } = this.pinch
			const z = clamp((startZoom * Vec.dist(a, b)) / startDistance, MIN_ZOOM, MAX_ZOOM)
			inputs.currentScreenPoint = center
			// Keep the page point that started under the fingers' midpoint under it.
			this.setCamera({ x: center.x / z - pagePoint.x, y: center.y / z - pagePoint.y, z })
			return
		}

		const now = performance.now()
		const dt = Math.max(1, now - inputs.lastMoveTime)
		const delta = Vec.sub(point, inputs.currentScreenPoint)
		inputs.velocity = { x: lerp(inputs.velocity.x, delta.x / dt, 0.5), y: lerp(inputs.velocity.y, delta.y / dt, 0.5) }
		inputs.lastMoveTime = now
		inputs.previousScreenPoint = inputs.currentScreenPoint
		inputs.currentScreenPoint = point

		if (this.touchMode === 'pending' && Vec.dist(point, inputs.originScreenPoint) > TOUCH_SLOP) {
			this.touchMode = 'pan'
			inputs.isPanning = true
			inputs.isDragging = true
			this.lastTap = null
			// Catch up on the slop the finger moved before it counted as a pan.
			this.panBy(point.x - inputs.originScreenPoint.x, point.y - inputs.originScreenPoint.y)
			return
		}
		if (this.touchMode === 'pan') this.panBy(delta.x, delta.y)
	}

	private handleTouchUp(e: PointerEvent) {
		if (!this.touches.has(e.pointerId)) return
		const { modifiers } = this.pointerInfo(e)
		const { inputs } = this
		this.touches.delete(e.pointerId)
		if (this.container!.hasPointerCapture(e.pointerId)) this.container!.releasePointerCapture(e.pointerId)
		const mode = this.touchMode

		if (this.touches.size > 0) {
			if (mode !== 'pinch') return
			if (this.touches.size >= 2) return this.startPinch()
			// Lifting one finger of a pinch carries on as a one-finger pan.
			const [rest] = this.touches.values()
			this.touchMode = 'pan'
			this.pinch = null
			inputs.currentScreenPoint = inputs.previousScreenPoint = rest
			inputs.velocity = { x: 0, y: 0 }
			inputs.lastMoveTime = performance.now()
			return
		}

		this.touchMode = null
		this.pinch = null
		inputs.isPointing = false
		inputs.isDragging = false
		inputs.isPanning = false
		if (mode === 'pan') return this.flingCamera()
		if (mode !== 'pending' || e.type === 'pointercancel') return

		// A tap: the state chart gets a click at the point the finger went down.
		const point = inputs.originScreenPoint
		inputs.currentScreenPoint = point
		inputs.currentPagePoint = inputs.originPagePoint = this.screenToPage(point)
		const target = this.getTargetAt(inputs.currentPagePoint)
		inputs.isPointing = true
		this.dispatch({ name: 'pointer_down', point, button: 0, target, ...modifiers })
		inputs.isPointing = false
		this.dispatch({ name: 'pointer_up', point, button: 0, target, ...modifiers })

		const now = performance.now()
		const last = this.lastTap
		if (last && now - last.time < DOUBLE_TAP_MS && Vec.dist(point, last.point) < DOUBLE_TAP_DISTANCE) {
			this.lastTap = null
			this.dispatch({ name: 'double_click', point, target, ...modifiers })
		} else {
			this.lastTap = { time: now, point }
		}
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

		if (e.ctrlKey || e.metaKey || this.inputs.isSpaceDown) {
			// Trackpad pinch arrives as ctrl+wheel with small deltas; mouse wheel + modifier as big ones.
			const delta = dy !== 0 ? dy : dx
			const z = this.camera.peek().z
			const factor = Math.exp(-clamp(delta, -50, 50) * 0.01)
			this.zoomAt(point, z * factor)
		} else if (e.shiftKey) {
			// Some platforms (macOS) already turn shift+wheel into deltaX, so take whichever axis moved.
			this.panBy(-(dy !== 0 ? dy : dx), 0)
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
		if (mod && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) return e.preventDefault(), this.deletions.undo()
		if (!mod && (e.key === 'Delete' || e.key === 'Backspace')) {
			e.preventDefault()
			if (!this.inputs.isPointing) this.deletions.deleteSelected()
			return
		}
		const arrows = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' } as const
		if (!this.inputs.isPointing && e.key in arrows) {
			e.preventDefault()
			return this.selectAdjacent(arrows[e.key as keyof typeof arrows])
		}
		if (!mod && !e.altKey && (e.key === 'v' || e.key === 'V')) return this.setCurrentTool('select')
		if (!mod && !e.altKey && (e.key === 'h' || e.key === 'H')) return this.setCurrentTool('hand')
		if (!mod && !e.altKey && (e.key === 'n' || e.key === 'N') && this.createNote) return this.setCurrentTool('note')

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
		this.touches.clear()
		this.touchMode = null
		this.pinch = null
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

function boxRecordEquals(a: Record<string, Box>, b: Record<string, Box>) {
	const keys = Object.keys(a)
	return keys.length === Object.keys(b).length && keys.every((k) => b[k] && Box.equals(a[k], b[k]))
}

function arrayEquals(a: string[], b: string[]) {
	return a.length === b.length && a.every((v, i) => v === b[i])
}

function isEditable(target: EventTarget | null) {
	const el = target as HTMLElement | null
	return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}

function midpoint(a: Vec, b: Vec): Vec {
	return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}
