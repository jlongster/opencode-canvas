import { useEffect } from 'react'
import type { Editor } from '../editor/Editor'
import { frameKey } from '../editor/selection'
import { useValue } from './useValue'

/**
 * "That's in a hidden frame" at the bottom centre when a link points into one; edit links can
 * show the frame from here.
 */
export function HiddenLinkToast({ editor, canEdit }: { editor: Editor; canEdit: boolean }) {
	const link = useValue(() => editor.hiddenLink.get())
	useEffect(() => {
		if (!link) return
		const timer = setTimeout(() => editor.hiddenLink.set(null), 12_000)
		return () => clearTimeout(timer)
	}, [link])
	if (!link) return null
	const show = () => {
		editor.setFrameHidden(link.sessionId, false)
		editor.hiddenLink.set(null)
		if (!editor.focusSelectionKey(link.key)) editor.focusSelectionKey(frameKey(link.sessionId))
	}
	return (
		<div className="toast" role="status" onPointerDown={(e) => e.stopPropagation()}>
			<span>{canEdit ? "That's in a hidden frame" : "That's in a frame that's hidden on this canvas"}</span>
			{canEdit && (
				<>
					<span className="toast-sep">·</span>
					<button onClick={show}>Show it</button>
				</>
			)}
			<button className="toast-dismiss" title="Dismiss" onClick={() => editor.hiddenLink.set(null)}>
				×
			</button>
		</div>
	)
}
