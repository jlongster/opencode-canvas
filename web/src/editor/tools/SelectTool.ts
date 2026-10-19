import { Box, Vec } from '../geometry'
import { frameKey } from '../selection'
import { StateNode } from '../StateNode'
import type { EventOf } from '../types'

export class SelectTool extends StateNode {
	static override id = 'select'
	static override initial = 'idle'
	static override children = () => [Idle, PointingItem, PointingGroup, PointingCanvas, Brushing, DraggingFrame]

	override onExit() {
		this.editor.setHovered(null)
		this.editor.setHoveredGroup(null)
		this.editor.hoveredFrameId.set(null)
	}
}

class Idle extends StateNode {
	static override id = 'idle'

	override onEnter() {
		this.editor.setCursor('default')
		this.editor.setHoveredGroup(null)
		this.editor.hoveredFrameId.set(null)
		this.updateHover()
	}

	override onPointerMove() {
		this.updateHover()
	}

	override onTick() {
		// The camera can move under a still pointer (wheel, animation), so keep hover honest.
		this.updateHover()
	}

	override onPointerDown(e: EventOf<'pointer_down'>) {
		if (e.button !== 0) return
		if (e.target.type === 'item' || e.target.type === 'frame_title') this.parent!.transition('pointing_item', e)
		else if (e.target.type === 'group_heading') this.parent!.transition('pointing_group', e)
		else this.parent!.transition('pointing_canvas', e)
	}

	override onDoubleClick(e: EventOf<'double_click'>) {
		const { editor } = this
		if (e.target.type === 'item') editor.zoomToItem(e.target.id)
		else if (e.target.type === 'group_heading') editor.zoomToGroup(e.target.id)
		else if (e.target.type === 'section' || e.target.type === 'frame_title') editor.zoomToSection(e.target.id)
		else editor.selectNone()
	}

	override onKeyDown(e: EventOf<'key_down'>) {
		if (e.key === 'Escape') this.editor.selectNone()
	}

	private updateHover() {
		const { editor } = this
		const target = editor.inputs.isPointerInside ? editor.getTargetAt(editor.inputs.currentPagePoint) : null
		editor.setHovered(target?.type === 'item' ? target.id : null)
		const group = target?.type === 'group_heading' ? target.id : null
		const frame = target?.type === 'frame_title' ? target.id : null
		if (group === editor.hoveredGroupId.peek() && frame === editor.hoveredFrameId.peek()) return
		editor.setHoveredGroup(group)
		editor.hoveredFrameId.set(frame)
		if (!editor.inputs.isSpaceDown) editor.setCursor(group ? 'pointer' : frame && editor.frames ? 'grab' : 'default')
	}
}

/**
 * Pointer is down on an item (or a session frame's title, which selects the whole frame) but
 * hasn't moved far enough to count as a drag. Dragging a frame's title picks the frame up (edit
 * links, without shift); dragging anything else brushes.
 */
class PointingItem extends StateNode {
	static override id = 'pointing_item'
	private key = ''
	private deselectOnUp = false
	private frameId: string | null = null

	override onEnter(info: unknown) {
		const e = info as EventOf<'pointer_down'>
		if (e.target.type !== 'item' && e.target.type !== 'frame_title') return
		const { editor } = this
		const id = e.target.type === 'item' ? e.target.id : frameKey(e.target.id)
		this.key = id
		this.frameId = e.target.type === 'frame_title' ? e.target.id : null
		const selected = editor.isSelected(id)
		this.deselectOnUp = e.shiftKey && selected
		if (e.shiftKey && !selected) editor.select([...editor.getSelectedIds(), id])
		else if (!e.shiftKey && !selected) editor.select([id])
	}

	override onPointerMove() {
		const { editor } = this
		if (!editor.inputs.isDragging) return
		if (this.frameId && editor.frames && !editor.inputs.shiftKey) this.parent!.transition('dragging_frame', { sessionId: this.frameId })
		else this.parent!.transition('brushing')
	}

	override onPointerUp(e: EventOf<'pointer_up'>) {
		const { editor } = this
		const id = this.key
		if (this.deselectOnUp) editor.select(editor.getSelectedIds().filter((s) => s !== id))
		else if (!e.shiftKey) editor.select([id])
		this.parent!.transition('idle')
	}

	override onCancel() {
		this.parent!.transition('idle')
	}
}

/**
 * Pointer is down on a group's heading. A click brings the group into view and links to it
 * (without selecting anything); a drag brushes like on empty canvas.
 */
class PointingGroup extends StateNode {
	static override id = 'pointing_group'
	private groupId = ''

	override onEnter(info: unknown) {
		const e = info as EventOf<'pointer_down'>
		this.groupId = e.target.type === 'group_heading' ? e.target.id : ''
	}

	override onPointerMove() {
		if (this.editor.inputs.isDragging) {
			this.editor.setHoveredGroup(null)
			if (!this.editor.inputs.shiftKey) this.editor.selectNone()
			this.parent!.transition('brushing')
		}
	}

	override onPointerUp() {
		this.editor.focusGroup(this.groupId, { animate: true })
		this.parent!.transition('idle')
	}

	override onCancel() {
		this.parent!.transition('idle')
	}
}

/** Pointer is down on empty canvas (or a section background). */
class PointingCanvas extends StateNode {
	static override id = 'pointing_canvas'

	override onEnter(info: unknown) {
		const e = info as EventOf<'pointer_down'>
		if (!e.shiftKey) this.editor.selectNone()
	}

	override onPointerMove() {
		if (this.editor.inputs.isDragging) this.parent!.transition('brushing')
	}

	override onPointerUp() {
		this.parent!.transition('idle')
	}

	override onCancel() {
		this.parent!.transition('idle')
	}
}

/** Dragging out a selection box. Holding shift adds to the selection that existed beforehand. */
class Brushing extends StateNode {
	static override id = 'brushing'
	private initialSelection: string[] = []
	private lastPoint: Vec | null = null
	private lastShift = false

	override onEnter() {
		const { editor } = this
		editor.setHovered(null)
		editor.setCursor('crosshair')
		this.initialSelection = editor.inputs.shiftKey ? editor.getSelectedIds() : []
		this.lastPoint = null
		this.update()
	}

	override onExit() {
		this.editor.setBrush(null)
	}

	override onPointerMove() {
		this.update()
	}

	override onTick() {
		// The camera may have moved (wheel/inertia) while the pointer stayed put.
		this.update()
	}

	override onKeyDown(e: EventOf<'key_down'>) {
		if (e.key === 'Escape') this.cancel()
		else this.update()
	}

	override onKeyUp() {
		this.update()
	}

	override onPointerUp() {
		this.parent!.transition('idle')
	}

	override onCancel() {
		this.cancel()
	}

	private cancel() {
		this.editor.select(this.initialSelection)
		this.parent!.transition('idle')
	}

	private update() {
		const { editor } = this
		const { originPagePoint, currentPagePoint, shiftKey } = editor.inputs
		if (this.lastPoint && Vec.equals(this.lastPoint, currentPagePoint) && this.lastShift === shiftKey) return
		this.lastPoint = currentPagePoint
		this.lastShift = shiftKey
		const brush = Box.fromPoints(originPagePoint, currentPagePoint)
		editor.setBrush(brush)
		const hits = editor.getSelectableInBox(brush)
		editor.select(shiftKey ? [...new Set([...this.initialSelection, ...hits])] : hits)
	}
}

/** Screen px from the left or right edge where dragging a frame pans the canvas, and how fast (px/ms at the edge) */
const EDGE_PAN = { zone: 56, speed: 1.2 }

/**
 * A session frame picked up by its title: it follows the pointer while the other frames slide
 * apart to show where it would drop. Releasing saves the new order for everyone; Escape puts it back.
 */
class DraggingFrame extends StateNode {
	static override id = 'dragging_frame'
	private sessionId = ''

	override onEnter(info: unknown) {
		const { editor } = this
		this.sessionId = (info as { sessionId: string }).sessionId
		const section = editor.layout.get().sections.find((s) => s.id === this.sessionId)
		if (!section) return this.parent!.transition('idle')
		editor.setHovered(null)
		editor.hoveredFrameId.set(null)
		editor.setCursor('grabbing')
		editor.frameDrag.set({
			sessionId: this.sessionId,
			order: editor.orderedSessions.get().map((s) => s.id),
			from: { x: section.box.x, y: section.box.y },
			origin: editor.inputs.originPagePoint,
			point: editor.inputs.currentPagePoint,
		})
		this.update()
	}

	override onExit() {
		this.editor.frameDrag.set(null)
	}

	override onPointerMove() {
		this.update()
	}

	override onTick(e: EventOf<'tick'>) {
		const { editor } = this
		const x = editor.inputs.currentScreenPoint.x
		const { w } = editor.viewport.peek()
		const edge = x < EDGE_PAN.zone ? (EDGE_PAN.zone - x) / EDGE_PAN.zone : x > w - EDGE_PAN.zone ? -(x - (w - EDGE_PAN.zone)) / EDGE_PAN.zone : 0
		if (edge) editor.panBy(Math.max(-1, Math.min(1, edge)) * EDGE_PAN.speed * e.elapsed, 0)
		this.update()
	}

	override onPointerUp() {
		const { editor } = this
		const drag = editor.frameDrag.peek()
		if (drag) editor.setFrameOrder(drag.order)
		this.parent!.transition('idle')
	}

	override onKeyDown(e: EventOf<'key_down'>) {
		if (e.key === 'Escape') this.parent!.transition('idle')
	}

	override onCancel() {
		this.parent!.transition('idle')
	}

	/** Follow the pointer, then pick the slot: after every other visible frame whose middle it's past. */
	private update() {
		const { editor } = this
		const drag = editor.frameDrag.peek()
		if (!drag) return
		const point = editor.inputs.currentPagePoint
		if (!Vec.equals(point, drag.point)) editor.frameDrag.set({ ...drag, point })
		const layout = editor.layout.get()
		const dragged = layout.sections.find((s) => s.id === drag.sessionId)
		if (!dragged) return
		const middle = dragged.box.x + dragged.box.w / 2
		const others = layout.sections.filter((s) => s.id !== drag.sessionId)
		const before = others.filter((s) => s.box.x + s.box.w / 2 < middle).length
		const order = drag.order.filter((id) => id !== drag.sessionId)
		const index = before === 0 ? (others.length ? order.indexOf(others[0].id) : 0) : order.indexOf(others[before - 1].id) + 1
		order.splice(index, 0, drag.sessionId)
		if (order.some((id, i) => id !== drag.order[i])) editor.frameDrag.set({ ...editor.frameDrag.peek()!, order })
	}
}
