import type { Editor } from '../editor/Editor'
import { openSessionsRequests } from './Sessions'
import { useValue } from './useValue'
import './emptyState.css'

/**
 * An empty canvas: on edit links, one "Add a session" button that opens the Sessions popover (top
 * right), where the session picked gets a frame that fills in with its media and HTML.
 */
export function EmptyState({ editor, canAdd, viewOnly }: { editor: Editor; canAdd: boolean; viewOnly: boolean }) {
	const empty = useValue(() => editor.connection.get() === 'open' && Object.keys(editor.sessions.get()).length === 0)
	if (!empty) return null
	if (viewOnly) {
		return (
			<div className="empty">
				<h2>Nothing here yet</h2>
				<p>Media posted to this canvas shows up here live.</p>
			</div>
		)
	}
	if (!canAdd) return null
	return (
		<div className="empty-add" onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
			<button className="empty-add-button" onClick={() => openSessionsRequests.set(openSessionsRequests.peek() + 1)}>
				<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
					<path d="M12 5v14M5 12h14" />
				</svg>
				Add a session
			</button>
		</div>
	)
}
