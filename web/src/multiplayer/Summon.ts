import type { Editor } from '../editor/Editor'
import { Box, type Vec } from '../editor/geometry'
import { frameTitleBox } from '../editor/layout'
import type { Conjure } from './Conjure'

const LONG_PRESS_MS = 500
/** screen px a finger may wander and still be a long press */
const LONG_PRESS_SLOP = 8

/**
 * C: press it while the pointer is over anything of a session frame (an item, a group, the frame's
 * title, rail or background), or long-press the frame on touch, to open that session's C dialog
 * (see SessionDialog); C again closes it. Over a frame whose session isn't conjured, the dialog
 * offers to connect it. C anywhere else opens the session picker next to the pointer
 * (Conjure.picking), to conjure one; C again closes it.
 */
export class Summon {
	private disposers: (() => void)[] = []
	private press: { pointerId: number; start: Vec; timer: number } | null = null

	constructor(
		private editor: Editor,
		private conjure: Conjure,
		private container: HTMLElement,
		/** whether C over empty canvas opens the picker (edit links) */
		private canConjure: boolean,
	) {
		const listen = <K extends keyof HTMLElementEventMap>(el: HTMLElement | Window, type: K, fn: (e: HTMLElementEventMap[K]) => void) => {
			el.addEventListener(type, fn as EventListener)
			this.disposers.push(() => el.removeEventListener(type, fn as EventListener))
		}
		listen(window, 'keydown', this.onKeyDown)
		// On the container, so presses that a note or a rail took never get here.
		listen(container, 'pointerdown', this.onPointerDown)
		listen(window, 'pointermove', this.onPointerMove)
		listen(window, 'pointerup', this.cancelPress)
		listen(window, 'pointercancel', this.cancelPress)
	}

	destroy() {
		this.cancelPress()
		for (const d of this.disposers.splice(0)) d()
	}

	/** The session whose frame (title included) contains the page point, whatever is on it. */
	private sessionAt(point: Vec): string | null {
		const z = this.editor.getZoom()
		for (const section of this.editor.layout.get().sections) {
			if (Box.contains(section.box, point) || Box.contains(frameTitleBox(section, z), point)) return section.id
		}
		return null
	}

	private onKeyDown = (e: KeyboardEvent) => {
		if (e.key !== 'c' && e.key !== 'C') return
		// With a modifier it's Cmd/Ctrl+C (copy) or similar: leave it alone.
		if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || isEditable(e.target)) return
		if (this.conjure.picking.peek()) return this.conjure.picking.set(null)
		if (this.conjure.dialog.peek()) return this.conjure.closeDialog()
		const point = this.editor.pointerPage.peek()
		if (!point || this.editor.inputs.isPointing) return
		const sessionId = this.sessionAt(point)
		if (sessionId) {
			e.preventDefault()
			return this.conjure.openDialog(sessionId)
		}
		if (!this.canConjure) return
		// (so the C doesn't land in the picker's filter, focused as it opens)
		e.preventDefault()
		this.conjure.picking.set({ screen: this.editor.pageToScreen(point), page: point })
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
			const sessionId = this.sessionAt(this.editor.screenToPage(start))
			if (!sessionId) return
			navigator.vibrate?.(15)
			this.conjure.openDialog(sessionId)
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
