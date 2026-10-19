import { StateNode } from '../StateNode'
import type { EventOf } from '../types'

/** The slap tool's icon (an impact burst with speed lines), as the cursor while slapping. */
const BURST =
	'<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round">' +
	'<path d="M2 7.5h2.5M1.5 12h2M2 16.5h2.5" stroke="#18181b" stroke-width="3.2"/>' +
	'<path d="M2 7.5h2.5M1.5 12h2M2 16.5h2.5" stroke="#fff" stroke-width="1.6"/>' +
	'<path d="M16.2 3.7L17.2 8.5L22.1 8.1L18.9 11.9L22.2 15.5L17.3 15.4L16.6 20.2L13.6 16.3L9.4 18.8L10.6 14L6 12.2L10.5 10.2L9 5.5L13.4 7.7z" fill="#fff" stroke="#18181b" stroke-width="1.5"/></svg>'
export const SLAP_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(BURST)}") 17 14, pointer`

/**
 * Slapping creatures (see multiplayer/Slap): clicking one is handled by the creatures' layer
 * before it gets here, so this tool only shows the burst cursor. Clicks elsewhere do nothing; Escape goes
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
