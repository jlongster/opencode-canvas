import { clamp } from '../geometry'
import { StateNode } from '../StateNode'
import type { EventOf } from '../types'

/**
 * Press on a spot of an item and drag: a line follows the pointer from that spot, and releasing
 * opens a comment box at its end (see SharedAnnotations). The tool stays active for the next
 * comment, like comment tools usually do; Escape goes back to select. Pressing anywhere else pans.
 */
export class AnnotateTool extends StateNode {
	static override id = 'annotate'
	static override initial = 'idle'
	static override children = () => [Idle, Drawing, Panning]
}

class Idle extends StateNode {
	static override id = 'idle'

	override onEnter() {
		this.updateCursor()
	}

	override onPointerMove() {
		this.updateCursor()
	}

	override onPointerDown(e: EventOf<'pointer_down'>) {
		if (e.button !== 0) return
		const { editor } = this
		const box = e.target.type === 'item' ? editor.layout.get().items.get(e.target.id) : undefined
		if (e.target.type !== 'item' || !box || !editor.annotationDrafts) return this.parent!.transition('panning', e)
		const p = editor.inputs.currentPagePoint
		editor.annotationDrafts.begin(e.target.id, { x: clamp((p.x - box.x) / box.w, 0, 1), y: clamp((p.y - box.y) / box.h, 0, 1) })
		this.parent!.transition('drawing')
	}

	override onKeyDown(e: EventOf<'key_down'>) {
		if (e.key === 'Escape') this.editor.setCurrentTool('select')
	}

	/** A crosshair over items (where a press starts a comment), the hand elsewhere (a press pans). */
	private updateCursor() {
		const { editor } = this
		if (editor.inputs.isSpaceDown) return
		const target = editor.inputs.isPointerInside ? editor.getTargetAt(editor.inputs.currentPagePoint) : null
		editor.setCursor(!target || target.type === 'item' ? 'crosshair' : 'grab')
	}
}

class Drawing extends StateNode {
	static override id = 'drawing'
	private done = false

	override onEnter() {
		this.done = false
		this.editor.setCursor('crosshair')
	}

	override onExit() {
		if (!this.done) this.editor.annotationDrafts?.cancel()
	}

	override onPointerMove() {
		this.editor.annotationDrafts?.move(this.editor.inputs.currentPagePoint)
	}

	override onPointerUp() {
		this.done = true
		this.editor.annotationDrafts?.finish(this.editor.inputs.currentPagePoint)
		this.parent!.transition('idle')
	}

	override onKeyDown(e: EventOf<'key_down'>) {
		if (e.key === 'Escape') this.parent!.transition('idle')
	}

	override onCancel() {
		this.parent!.transition('idle')
	}
}

class Panning extends StateNode {
	static override id = 'panning'
	private moved = false

	override onEnter() {
		this.moved = false
		this.editor.setCursor('grabbing')
	}

	override onPointerMove() {
		const { currentScreenPoint, previousScreenPoint, isDragging } = this.editor.inputs
		if (isDragging) this.moved = true
		this.editor.panBy(currentScreenPoint.x - previousScreenPoint.x, currentScreenPoint.y - previousScreenPoint.y)
	}

	override onPointerUp() {
		if (this.moved) this.editor.flingCamera()
		this.parent!.transition('idle')
	}

	override onCancel() {
		this.parent!.transition('idle')
	}
}
