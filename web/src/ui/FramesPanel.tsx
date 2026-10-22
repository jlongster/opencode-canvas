import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { sessionColor } from '../../../shared/sessionColor'
import type { Editor } from '../editor/Editor'
import { frameKey } from '../editor/selection'
import { atom } from '../state/signals'
import { useValue } from './useValue'
import './frames.css'

/** Whether the frames list is open (the attention tray opens it for sessions whose frames are hidden). */
export const framesPanelOpen = atom('framesPanelOpen', false)

/** Pointer travel (px) before pressing a row becomes dragging it */
const DRAG_PX = 4

interface Row {
	id: string
	title: string
	untitled: boolean
	color: string
	items: number
	hidden: boolean
	/** hidden, with items posted since it was hidden */
	fresh: boolean
}

/**
 * Bottom left: the connection dot and "6 frames · 2 hidden · 143 items", which opens the list of
 * every session frame in order. On edit links the list hides and shows frames and reorders them
 * by dragging; on view links it only shows them.
 */
export function FramesStatus({ editor, canEdit }: { editor: Editor; canEdit: boolean }) {
	const connection = useValue(() => editor.connection.get())
	const counts = useValue(() => {
		const sessions = Object.values(editor.sessions.get())
		const hidden = sessions.filter((s) => s.hidden).length
		return [sessions.length - hidden, hidden, Object.keys(editor.items.get()).length, editor.selectedIds.get().length].join('·')
	})
	const open = useValue(() => framesPanelOpen.get())
	const rootRef = useRef<HTMLDivElement>(null)
	const [visible, hidden, items, selected] = counts.split('·').map(Number)

	// Close on a press anywhere else, or Escape.
	useEffect(() => {
		if (!open) return
		const onDown = (e: PointerEvent) => {
			if (!rootRef.current?.contains(e.target as Node)) framesPanelOpen.set(false)
		}
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') framesPanelOpen.set(false)
		}
		window.addEventListener('pointerdown', onDown, true)
		window.addEventListener('keydown', onKey)
		return () => {
			window.removeEventListener('pointerdown', onDown, true)
			window.removeEventListener('keydown', onKey)
		}
	}, [open])

	return (
		<div className="status frames-status" ref={rootRef}>
			<span className={`dot ${connection}`} title={connection} />
			<button
				className="counts"
				aria-expanded={open}
				title="All frames: show, hide and reorder them"
				onPointerDown={(e) => e.stopPropagation()}
				onClick={() => framesPanelOpen.set(!open)}
			>
				{plural(visible, 'frame')}
				{hidden > 0 && ` · ${hidden} hidden`} · {plural(items, 'item')}
				{selected > 0 && ` · ${selected} selected`}
				<svg className={`frames-caret${open ? ' open' : ''}`} viewBox="0 0 10 6" width="9" height="6" aria-hidden="true">
					<path d="M1 5l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
				</svg>
			</button>
			{open && <FramesPanel editor={editor} canEdit={canEdit} />}
		</div>
	)
}

function FramesPanel({ editor, canEdit }: { editor: Editor; canEdit: boolean }) {
	const json = useValue(() => {
		const counts = new Map<string, number>()
		const latest = new Map<string, number>()
		for (const item of Object.values(editor.items.get())) {
			counts.set(item.sessionId, (counts.get(item.sessionId) ?? 0) + 1)
			latest.set(item.sessionId, Math.max(latest.get(item.sessionId) ?? 0, item.createdAt))
		}
		const rows: Row[] = editor.orderedSessions.get().map((s) => {
			const untitled = !s.title.trim() || s.title === s.id
			return {
				id: s.id,
				title: untitled ? 'Untitled session' : s.title,
				untitled,
				color: sessionColor(s.id),
				items: counts.get(s.id) ?? 0,
				hidden: !!s.hidden,
				fresh: !!s.hidden && !!s.hiddenAt && (latest.get(s.id) ?? 0) > s.hiddenAt,
			}
		})
		return JSON.stringify(rows)
	})
	const rows = useMemo(() => JSON.parse(json) as Row[], [json])
	const [drag, setDrag] = useState<{ id: string; from: number; to: number; dy: number; rowH: number } | null>(null)
	// one frame without transitions after a drop, so rows don't slide from where they were
	const [settling, setSettling] = useState(false)
	const [nudged, setNudged] = useState<string | null>(null)
	const justDragged = useRef(false)

	useEffect(() => {
		if (!settling) return
		const raf = requestAnimationFrame(() => requestAnimationFrame(() => setSettling(false)))
		return () => cancelAnimationFrame(raf)
	}, [settling])

	const press = (e: ReactPointerEvent<HTMLDivElement>, row: Row, index: number) => {
		e.stopPropagation()
		if (!canEdit || e.button !== 0 || (e.target as HTMLElement).closest('button')) return
		const el = e.currentTarget
		const startY = e.clientY
		const rowH = el.offsetHeight + 2
		let dragging = false
		let to = index
		const move = (ev: PointerEvent) => {
			const dy = ev.clientY - startY
			if (!dragging && Math.abs(dy) < DRAG_PX) return
			dragging = true
			to = Math.max(0, Math.min(rows.length - 1, index + Math.round(dy / rowH)))
			setDrag({ id: row.id, from: index, to, dy, rowH })
		}
		const up = (ev: PointerEvent) => {
			window.removeEventListener('pointermove', move)
			window.removeEventListener('pointerup', up)
			window.removeEventListener('pointercancel', up)
			if (!dragging) return
			justDragged.current = true
			setTimeout(() => (justDragged.current = false))
			setSettling(true)
			setDrag(null)
			if (ev.type === 'pointerup' && to !== index) editor.moveFrame(row.id, to)
		}
		window.addEventListener('pointermove', move)
		window.addEventListener('pointerup', up)
		window.addEventListener('pointercancel', up)
	}

	const open = (row: Row) => {
		if (justDragged.current) return
		if (!row.hidden) {
			editor.focusSelectionKey(frameKey(row.id))
			return
		}
		// Hidden frames have nowhere to go: point at the eye instead.
		setNudged(null)
		requestAnimationFrame(() => setNudged(row.id))
	}

	const offset = (index: number) => {
		if (!drag) return 0
		if (index === drag.from) return drag.dy
		if (drag.from < drag.to && index > drag.from && index <= drag.to) return -drag.rowH
		if (drag.from > drag.to && index < drag.from && index >= drag.to) return drag.rowH
		return 0
	}

	return (
		<div className="frames-panel" onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
			<div className="frames-panel-head">
				<span>Frames</span>
				{canEdit && rows.length > 1 && <span className="frames-panel-hint">drag to reorder</span>}
			</div>
			{rows.length === 0 && <div className="frames-empty">No frames yet</div>}
			<div className={`frames-list${drag ? ' dragging' : ''}${settling ? ' settling' : ''}`}>
				{rows.map((row, i) => (
					<div
						key={row.id}
						role="button"
						tabIndex={0}
						className={`frames-row${row.hidden ? ' is-hidden' : ''}${drag?.id === row.id ? ' lifted' : ''}`}
						style={{ transform: offset(i) ? `translateY(${offset(i)}px)` : undefined, ['--session-color' as string]: row.color }}
						title={row.hidden ? 'Hidden for everyone' + (canEdit ? ': show it with the eye' : '') : 'Go to this frame'}
						onPointerDown={(e) => press(e, row, i)}
						onClick={() => open(row)}
						onKeyDown={(e) => {
							if (e.key === 'Enter') open(row)
						}}
					>
						{canEdit && (
							<span className="frames-grip" aria-hidden="true">
								<svg viewBox="0 0 8 14" width="8" height="14">
									{[2, 7, 12].flatMap((y) => [<circle key={`a${y}`} cx="2" cy={y} r="1.2" />, <circle key={`b${y}`} cx="6" cy={y} r="1.2" />])}
								</svg>
							</span>
						)}
						<i className="frames-dot" />
						<span className={`frames-title${row.untitled ? ' untitled' : ''}`}>{row.title}</span>
						{row.fresh && <span className="frames-new" title="New items since it was hidden" />}
						<span className="frames-count">{row.items}</span>
						{canEdit ? (
							<button
								className={`frames-eye${nudged === row.id ? ' nudge' : ''}`}
								aria-pressed={!row.hidden}
								title={row.hidden ? 'Show this frame (for everyone)' : 'Hide this frame (for everyone)'}
								onClick={(e) => {
									e.stopPropagation()
									setNudged(null)
									editor.setFrameHidden(row.id, !row.hidden)
								}}
							>
								{row.hidden ? <EyeOffIcon /> : <EyeIcon />}
							</button>
						) : (
							row.hidden && (
								<span className="frames-eye static" title="Hidden">
									<EyeOffIcon />
								</span>
							)
						)}
					</div>
				))}
			</div>
		</div>
	)
}

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

function plural(n: number, word: string) {
	return `${n} ${word}${n === 1 ? '' : 's'}`
}

function EyeIcon() {
	return (
		<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
			<circle cx="12" cy="12" r="3" />
		</svg>
	)
}

function EyeOffIcon() {
	return (
		<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<path d="M10.7 5.1a10.7 10.7 0 0 1 11.2 6.6 1 1 0 0 1 0 .7 10.7 10.7 0 0 1-1.4 2.5" />
			<path d="M14.1 14.2a3 3 0 0 1-4.2-4.2" />
			<path d="M17.5 17.5a10.8 10.8 0 0 1-15.4-5.2 1 1 0 0 1 0-.7 10.8 10.8 0 0 1 4.4-5.1" />
			<path d="m2 2 20 20" />
		</svg>
	)
}
