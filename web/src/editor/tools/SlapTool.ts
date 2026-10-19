import { StateNode } from '../StateNode'
import type { EventOf } from '../types'

/** An open hand, as the cursor while slapping. */
const HAND =
	'<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="#fff" stroke="#18181b" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
	'<path d="M7 12.5V6.2a1.5 1.5 0 0 1 3 0V11V4.6a1.5 1.5 0 0 1 3 0V11V5.6a1.5 1.5 0 0 1 3 0V12V8.6a1.5 1.5 0 0 1 3 0v5.4a7 7 0 0 1-7 7h-.8a6.5 6.5 0 0 1-5-2.4l-3.1-3.8a1.5 1.5 0 0 1 2.3-1.9z"/></svg>'
export const SLAP_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(HAND)}") 13 12, pointer`

/**
 * Slapping creatures (see multiplayer/Slap): clicking one is handled by the creatures' layer
 * before it gets here, so this tool only shows the hand. Clicks elsewhere do nothing; Escape goes
 * back to selecting.
 */
export class SlapTool extends StateNode {
	static override id = 'slap'
	static override initial = 'idle'
	static override children = () => [Idle]
}

class Idle extends StateNode {
	static override id = 'idle'

	override onEnter() {
		this.editor.setCursor(SLAP_CURSOR)
	}

	override onKeyDown(e: EventOf<'key_down'>) {
		if (e.key === 'Escape') this.editor.setCurrentTool('select')
	}
}
