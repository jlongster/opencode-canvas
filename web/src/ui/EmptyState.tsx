import { useEffect } from 'react'
import type { Editor } from '../editor/Editor'
import { sessionsPopover } from './Sessions'
import { useOpenCode } from './OpenCodeServers'
import { useValue } from './useValue'
import './emptyState.css'

/**
 * An empty canvas, laid out like a manual's cover: "No sessions on this canvas yet", a faint sheet
 * where the first session's frame lands, and on edit links one ringed "Add a session" button (or S)
 * that opens the Sessions popover (top right), where the session picked gets a frame that fills in
 * with its media and HTML.
 */
export function EmptyState({ editor, canvasId, canAdd, viewOnly }: { editor: Editor; canvasId: string; canAdd: boolean; viewOnly: boolean }) {
	const empty = useValue(() => editor.connection.get() === 'open' && Object.keys(editor.sessions.get()).length === 0)
	if (!empty || (!viewOnly && !canAdd)) return null
	return (
		<div className="empty-state" onWheel={(e) => e.stopPropagation()}>
			<div className="empty-sheet" aria-hidden="true">
				<div className="empty-sheet-head">Your first session’s sheet lands here.</div>
				<div className="empty-sheet-body" />
			</div>
			<div className="empty-cover">
				<h2 className="empty-title rm-wide">No sessions</h2>
				<div className="empty-sub">on this canvas yet.</div>
				{viewOnly ? (
					<p className="empty-text">Media posted to this canvas shows up here live.</p>
				) : (
					<>
						<p className="empty-text">Add a session from a paired OpenCode. Its frame fills in with the images, videos and pages it made.</p>
						<AddSession />
						<EmptyFacts canvasId={canvasId} />
					</>
				)}
			</div>
		</div>
	)
}

function AddSession() {
	// S opens Sessions, while the canvas is empty and nothing else has the keyboard.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== 's' && e.key !== 'S') return
			if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return
			const active = document.activeElement as HTMLElement | null
			if (active && (active.matches('input, textarea, select') || active.isContentEditable)) return
			if (sessionsPopover.peek() !== null) return
			e.preventDefault()
			e.stopPropagation()
			sessionsPopover.set({})
		}
		window.addEventListener('keydown', onKey, true)
		return () => window.removeEventListener('keydown', onKey, true)
	}, [])
	return (
		<div className="empty-add" onPointerDown={(e) => e.stopPropagation()}>
			<button className="empty-add-button rm-ringed" onClick={() => sessionsPopover.set({})}>
				+ Add a session
			</button>
			<span className="empty-add-hint">
				or press <kbd className="rm-key">S</kbd>
			</span>
		</div>
	)
}

/** What's paired, and where agents post. */
function EmptyFacts({ canvasId }: { canvasId: string }) {
	const { servers, sessions } = useOpenCode()
	const paired = servers.length
		? `OpenCode on ${servers.map((s) => s.name).join(', ')}${sessions ? ` · ${sessions.length} session${sessions.length === 1 ? '' : 's'}` : ''}`
		: 'No OpenCode yet: connect one from Sessions'
	return (
		<div className="empty-facts">
			<div className="empty-fact">
				<span className="empty-fact-k">Paired</span>
				<span>{paired}</span>
			</div>
			<div className="empty-fact">
				<span className="empty-fact-k">Agents post</span>
				<span className="empty-fact-mono">POST /api/canvases/{canvasId.slice(0, 4)}…/items</span>
			</div>
		</div>
	)
}
