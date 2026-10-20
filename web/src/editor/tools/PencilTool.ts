import { StateNode } from '../StateNode'
import type { EventOf } from '../types'

/** A pencil, its tip at the hotspot (bottom left), as the cursor over items. */
const PENCIL =
	'<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22"><path d="M3 19l1.2-4.6L15.6 3a1.9 1.9 0 0 1 2.7 0l.7.7a1.9 1.9 0 0 1 0 2.7L7.6 17.8z" fill="white" stroke="black" stroke-width="1.4" stroke-linejoin="round"/><path d="M13.6 5l3.4 3.4M4.2 14.4l3.4 3.4" stroke="black" stroke-width="1.2"/><path d="M3 19l.7-2.6 1.9 1.9z" fill="black"/></svg>'
export const PENCIL_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(PENCIL)}") 3 19, crosshair`

/**
 * Draw on items: press on an item and draw a freehand stroke (the layer tracks the pointer itself,
 * coalesced events and all, see SharedAnnotations); on release a note box opens by the drawing.
 * T (or typing) over an item drops a text-only note there. Once the annotation is saved for good
 * (see SharedAnnotations.finished) it goes back to select; Escape does too. Pressing anywhere off
 * an item pans.
 */
export class PencilTool extends StateNode {
	static override id = 'pencil'
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
		if (e.target.type !== 'item' || !editor.annotationDrafts) return this.parent!.transition('panning', e)
		editor.annotationDrafts.begin(e.target.id, editor.inputs.currentPagePoint)
		this.parent!.transition('drawing')
	}

	override onKeyDown(e: EventOf<'key_down'>) {
		if (e.key === 'Escape') return this.editor.setCurrentTool('select')
		if (e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1 || e.key === ' ' || e.key === '/') return
		this.editor.annotationDrafts?.type(e.key === 't' || e.key === 'T' ? '' : e.key)
	}

	/** The pencil over items (where a press draws), the hand elsewhere (a press pans). */
	private updateCursor() {
		const { editor } = this
		if (editor.inputs.isSpaceDown) return
		const target = editor.inputs.isPointerInside ? editor.getTargetAt(editor.inputs.currentPagePoint) : null
		editor.setCursor(!target || target.type === 'item' ? PENCIL_CURSOR : 'grab')
	}
}

class Drawing extends StateNode {
	static override id = 'drawing'
	private done = false

	override onEnter() {
		this.done = false
		this.editor.setCursor(PENCIL_CURSOR)
	}

	override onExit() {
		if (!this.done) this.editor.annotationDrafts?.cancel()
	}

	override onPointerUp() {
		this.done = true
		this.editor.annotationDrafts?.end()
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
