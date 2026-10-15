import type { Editor } from '../editor/Editor'
import type { Vec } from '../editor/geometry'
import type { Conjure } from './Conjure'

const LONG_PRESS_MS = 500
/** screen px a finger may wander and still be a long press */
const LONG_PRESS_SLOP = 8

/**
 * Summoning a session's worm (edit links): press C while the pointer is over anything of a session
 * frame (an item, a group, the frame's title or background), or long-press it on touch. See
 * Conjure.summon for what happens then; when it can't, the reason shows in the toast.
 */
export class Summon {
	private disposers: (() => void)[] = []
	private press: { pointerId: number; start: Vec; timer: number } | null = null

	constructor(
		private editor: Editor,
		private conjure: Conjure,
		private container: HTMLElement,
	) {
		const listen = <K extends keyof HTMLElementEventMap>(el: HTMLElement | Window, type: K, fn: (e: HTMLElementEventMap[K]) => void) => {
			el.addEventListener(type, fn as EventListener)
			this.disposers.push(() => el.removeEventListener(type, fn as EventListener))
		}
		listen(window, 'keydown', this.onKeyDown)
		// On the container, so presses that a worm or a note took never get here.
		listen(container, 'pointerdown', this.onPointerDown)
		listen(window, 'pointermove', this.onPointerMove)
		listen(window, 'pointerup', this.cancelPress)
		listen(window, 'pointercancel', this.cancelPress)
	}

	destroy() {
		this.cancelPress()
		for (const d of this.disposers.splice(0)) d()
	}

	/** The session whose frame is under a page point, if any. */
	private sessionAt(point: Vec): string | null {
		const target = this.editor.getTargetAt(point)
		if (target.type === 'item') return this.editor.items.peek()[target.id]?.sessionId ?? null
		if (target.type === 'section' || target.type === 'frame_title') return target.id
		return null
	}

	private summonAt(point: Vec) {
		const sessionId = this.sessionAt(point)
		if (!sessionId) return
		this.conjure
			.summon(sessionId, point)
			.then((message) => message && this.editor.deletions.notify(message))
			.catch((e: Error) => this.editor.deletions.notify(`Couldn't summon it: ${e.message}`))
	}

	private onKeyDown = (e: KeyboardEvent) => {
		if (e.key !== 'c' && e.key !== 'C') return
		// With a modifier it's Cmd/Ctrl+C (copy) or similar: leave it alone.
		if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || isEditable(e.target)) return
		const point = this.editor.pointerPage.peek()
		if (!point || this.editor.inputs.isPointing) return
		this.summonAt(point)
	}

	private onPointerDown = (e: PointerEvent) => {
		this.cancelPress()
		if (e.pointerType !== 'touch' || !e.isPrimary) return
		const rect = this.container.getBoundingClientRect()
		const start = { x: e.clientX - rect.left, y: e.clientY - rect.top }
		const pointerId = e.pointerId
		const timer = window.setTimeout(() => {
			this.press = null
			if (this.editor.inputs.isPanning) return
			navigator.vibrate?.(15)
			this.summonAt(this.editor.screenToPage(start))
		}, LONG_PRESS_MS)
		this.press = { pointerId, start, timer }
	}

	private onPointerMove = (e: PointerEvent) => {
		const press = this.press
		if (!press) return
		// A second finger (pinch) cancels too.
		if (e.pointerId !== press.pointerId) return this.cancelPress()
		const rect = this.container.getBoundingClientRect()
		if (Math.hypot(e.clientX - rect.left - press.start.x, e.clientY - rect.top - press.start.y) > LONG_PRESS_SLOP) this.cancelPress()
	}

	private cancelPress = () => {
		if (!this.press) return
		clearTimeout(this.press.timer)
		this.press = null
	}
}

function isEditable(target: EventTarget | null) {
	const el = target as HTMLElement | null
	return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}
