import { frameKey } from '../selection'
import { StateNode } from '../StateNode'
import type { EventOf, Target } from '../types'

/**
 * Click and drag to pan the camera. Releasing mid-drag lets the canvas glide to a stop. A click
 * that doesn't drag selects a frame by its title, or clears the selection on empty canvas.
 */
export class HandTool extends StateNode {
	static override id = 'hand'
	static override initial = 'idle'
	static override children = () => [Idle, Dragging]
}

class Idle extends StateNode {
	static override id = 'idle'

	override onEnter() {
		this.editor.setCursor('grab')
	}

	override onPointerDown(e: EventOf<'pointer_down'>) {
		if (e.button === 0) this.parent!.transition('dragging', e)
	}

	override onDoubleClick(e: EventOf<'double_click'>) {
		if (e.target.type === 'item') {
			this.editor.select([e.target.id])
			this.editor.zoomToItem(e.target.id)
		}
		else if (e.target.type === 'section' || e.target.type === 'frame_title') this.editor.zoomToSection(e.target.id)
		else this.editor.selectNone()
	}

	override onKeyDown(e: EventOf<'key_down'>) {
		if (e.key === 'Escape') this.editor.selectNone()
	}
}

class Dragging extends StateNode {
	static override id = 'dragging'
	private target: Target = { type: 'canvas' }
	private moved = false

	override onEnter(info: unknown) {
		this.target = (info as EventOf<'pointer_down'>).target
		this.moved = false
		this.editor.setCursor('grabbing')
	}

	override onPointerMove() {
		const { currentScreenPoint, previousScreenPoint, isDragging } = this.editor.inputs
		if (isDragging) this.moved = true
		this.editor.panBy(currentScreenPoint.x - previousScreenPoint.x, currentScreenPoint.y - previousScreenPoint.y)
	}

	override onPointerUp(e: EventOf<'pointer_up'>) {
		const { editor, target } = this
		if (this.moved) editor.flingCamera()
		else if (target.type === 'frame_title') {
			const key = frameKey(target.id)
			if (e.shiftKey) editor.toggleSelected(key)
			else editor.select([key])
		} else if (target.type !== 'item' && !e.shiftKey) editor.selectNone()
		this.parent!.transition('idle')
	}

	override onCancel() {
		this.parent!.transition('idle')
	}
}
