import type { Editor } from '../editor/Editor'
import { Box, type Vec } from '../editor/geometry'
import { frameTitleBox } from '../editor/layout'
import type { Conjure } from './Conjure'

const LONG_PRESS_MS = 500
/** screen px a finger may wander and still be a long press */
const LONG_PRESS_SLOP = 8
/** screen px from a creature's spot that still counts as over it */
const CREATURE_REACH = 36

/**
 * Calling up a session's worm (edit links): press C while the pointer is over anything of a session
 * frame (an item, a group, the frame's title or background) or its worm, or long-press it on touch.
 * A worm that's here already gets its box opened where it is; otherwise it's conjured beside its
 * frame (see Conjure.summon); when it can't, the reason shows in the toast. Nothing here moves a
 * worm. C anywhere else opens the session picker next to the pointer (Conjure.picking); C again
 * closes it.
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

	/**
	 * The session under a page point, if any: a creature's (near where it's perched), else the
	 * session whose frame (title strip included) contains the point, whatever is on it.
	 */
	private sessionAt(point: Vec): string | null {
		const z = this.editor.getZoom()
		let best: { sessionId: string; d: number } | null = null
		for (const peer of this.conjure.worms()) {
			const at = peer.cursor
			const sessionId = peer.user.sessionId
			if (!at || !sessionId || this.editor.isSessionHidden(sessionId)) continue
			const d = Math.hypot(at.x - point.x, at.y - point.y) * z
			if (d <= CREATURE_REACH && (!best || d < best.d)) best = { sessionId, d }
		}
		if (best) return best.sessionId
		for (const section of this.editor.layout.get().sections) {
			if (Box.contains(section.box, point) || Box.contains(frameTitleBox(section, z), point)) return section.id
		}
		return null
	}

	private summonAt(point: Vec) {
		const sessionId = this.sessionAt(point)
		if (!sessionId) return
		this.conjure
			.summon(sessionId)
			.then((message) => message && this.editor.deletions.notify(message))
			.catch((e: Error) => this.editor.deletions.notify(`Couldn't summon it: ${e.message}`))
	}

	private onKeyDown = (e: KeyboardEvent) => {
		if (e.key !== 'c' && e.key !== 'C') return
		// With a modifier it's Cmd/Ctrl+C (copy) or similar: leave it alone.
		if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || isEditable(e.target)) return
		if (this.conjure.picking.peek()) return this.conjure.picking.set(null)
		const point = this.editor.pointerPage.peek()
		if (!point || this.editor.inputs.isPointing) return
		if (this.sessionAt(point)) return this.summonAt(point)
		// (so the C doesn't land in the picker's filter, focused as it opens)
		e.preventDefault()
		this.conjure.close()
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
