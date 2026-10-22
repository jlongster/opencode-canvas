import { useMemo } from 'react'
import type { Editor } from '../editor/Editor'
import { frameTitleBox } from '../editor/layout'
import { useValue } from './useValue'

/** Where a session's frame title is on screen (CSS px), for what's shown at the frame. */
export interface FrameAnchor {
	/** the title's left edge, its top and bottom, and the frame's right edge */
	x: number
	top: number
	bottom: number
	right: number
	/** whether any of the title is on screen */
	onScreen: boolean
}

/** keep cards this far inside the window, and below the top bar and the attention tray under it */
const MARGIN = 8
const TOP_ROOM = 112
/** between a card and the frame's title */
const GAP = 10

/** The session's frame title on screen, or null without a frame showing (reactive). */
export function frameAnchor(editor: Editor, sessionId: string): FrameAnchor | null {
	const section = editor.layout.get().sections.find((s) => s.id === sessionId)
	if (!section || editor.isSessionHidden(sessionId)) return null
	const z = editor.camera.get().z
	const { w: vw, h: vh } = editor.viewport.get()
	const title = frameTitleBox(section, z)
	const a = editor.pageToScreen({ x: section.header.x, y: title.y })
	const b = editor.pageToScreen({ x: section.box.x + section.box.w, y: title.y + title.h })
	return {
		x: Math.round(a.x),
		top: Math.round(a.y),
		bottom: Math.round(b.y),
		right: Math.round(b.x),
		onScreen: b.x > 0 && a.x < vw && b.y > 0 && a.y < vh,
	}
}

/** frameAnchor for a component: re-renders only when it moves. */
export function useFrameAnchor(editor: Editor, sessionId: string | null): FrameAnchor | null {
	const key = useValue(() => (sessionId ? JSON.stringify(frameAnchor(editor, sessionId)) : 'null'), [editor, sessionId])
	return useMemo(() => JSON.parse(key) as FrameAnchor | null, [key])
}

/**
 * Where a w × h card goes at a frame: above its title, left-aligned with it, when there's room
 * there; else just under the title (over the top of the frame). Always kept on screen.
 */
export function placeAtFrame(a: FrameAnchor, w: number, h: number, vw: number, vh: number): { left: number; top: number; above: boolean } {
	const left = Math.round(Math.max(MARGIN, Math.min(a.x, vw - w - MARGIN)))
	const above = a.top - GAP - h
	if (above >= TOP_ROOM && a.top - GAP <= vh - MARGIN) return { left, top: Math.round(above), above: true }
	const below = Math.max(TOP_ROOM, Math.min(a.bottom + GAP, vh - h - MARGIN))
	return { left, top: Math.round(Math.max(MARGIN, below)), above: false }
}
