import { StateNode } from '../StateNode'
import type { EventOf } from '../types'

/** Click to drop a sticky note, then go straight back to the select tool. */
export class NoteTool extends StateNode {
	static override id = 'note'
	static override initial = 'idle'
	static override children = () => [Idle]
}

class Idle extends StateNode {
	static override id = 'idle'

	override onEnter() {
		this.editor.setCursor('crosshair')
	}

	override onPointerDown(e: EventOf<'pointer_down'>) {
		if (e.button !== 0) return
		const { editor } = this
		editor.createNote?.(editor.inputs.currentPagePoint)
		editor.setCurrentTool('select')
	}

	override onKeyDown(e: EventOf<'key_down'>) {
		if (e.key === 'Escape') this.editor.setCurrentTool('select')
	}
}
