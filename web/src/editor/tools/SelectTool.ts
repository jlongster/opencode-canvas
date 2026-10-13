import { Box, Vec } from '../geometry'
import { StateNode } from '../StateNode'
import type { EventOf, Target } from '../types'

export class SelectTool extends StateNode {
	static override id = 'select'
	static override initial = 'idle'
	static override children = () => [Idle, PointingItem, PointingCanvas, Brushing]

	override onExit() {
		this.editor.setHovered(null)
	}
}

class Idle extends StateNode {
	static override id = 'idle'

	override onEnter() {
		this.editor.setCursor('default')
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
		if (e.target.type === 'item') this.parent!.transition('pointing_item', e)
		else this.parent!.transition('pointing_canvas', e)
	}

	override onDoubleClick(e: EventOf<'double_click'>) {
		const { editor } = this
		if (e.target.type === 'item') editor.zoomToItem(e.target.id)
		else if (e.target.type === 'section') editor.zoomToSection(e.target.id)
		else editor.zoomToFit()
	}

	override onKeyDown(e: EventOf<'key_down'>) {
		if (e.key === 'Escape') this.editor.selectNone()
	}

	private updateHover() {
		const { editor } = this
		if (!editor.inputs.isPointerInside) return editor.setHovered(null)
		const target = editor.getTargetAt(editor.inputs.currentPagePoint)
		editor.setHovered(target.type === 'item' ? target.id : null)
	}
}

/** Pointer is down on an item but hasn't moved far enough to count as a drag. */
class PointingItem extends StateNode {
	static override id = 'pointing_item'
	private target: Extract<Target, { type: 'item' }> | null = null
	private deselectOnUp = false

	override onEnter(info: unknown) {
		const e = info as EventOf<'pointer_down'>
		if (e.target.type !== 'item') return
		const { editor } = this
		const id = e.target.id
		this.target = e.target
		const selected = editor.isSelected(id)
		this.deselectOnUp = e.shiftKey && selected
		if (e.shiftKey && !selected) editor.select([...editor.getSelectedIds(), id])
		else if (!e.shiftKey && !selected) editor.select([id])
	}

	override onPointerMove() {
		if (this.editor.inputs.isDragging) this.parent!.transition('brushing')
	}

	override onPointerUp(e: EventOf<'pointer_up'>) {
		const { editor } = this
		const id = this.target!.id
		if (this.deselectOnUp) editor.select(editor.getSelectedIds().filter((s) => s !== id))
		else if (!e.shiftKey) editor.select([id])
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
		const hits = editor.getItemsInBox(brush)
		editor.select(shiftKey ? [...new Set([...this.initialSelection, ...hits])] : hits)
	}
}
