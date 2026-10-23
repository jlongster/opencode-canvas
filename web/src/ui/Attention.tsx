import { useEffect, useState } from 'react'
import type { Attention, Caller } from '../multiplayer/Attention'
import type { AskingInfo } from '../multiplayer/Presence'
import type { AgentNoteInfo } from '../multiplayer/SharedNotes'
import { sessionsPopover } from './Sessions'
import { useValue } from './useValue'

/**
 * "3 things want your attention" at the top of the screen while any session has sticky notes
 * waiting (MCP say / highlight) or asks something. Its arrows step through the notes, oldest first,
 * gliding the camera to each; the pill opens the breakdown by session, where each session's arrows
 * step through just its notes, and a session asking something shows what it asks.
 */
export function AttentionTray({ attention }: { attention: Attention }) {
	const callers = useValue(() => attention.callers.get(), [attention])
	// hidden frames can't be shown: on edit links their rows open Sessions, where they can be shown again
	const hidden = useValue(() => callers.filter((c) => attention.editor.isSessionHidden(c.sessionId)).map((c) => c.sessionId).join(' '), [attention, callers])
	const [open, setOpen] = useState(false)
	useEffect(() => {
		if (!callers.length) setOpen(false)
	}, [callers.length])
	if (!callers.length) return null
	const total = callers.reduce((n, c) => n + c.notes.length + (c.asking?.count ?? 0), 0)
	const names = callers.map((c) => c.name)
	const askers = callers.filter((c) => c.asking)
	const lone = askers.length === 1 && callers.length === 1 && !callers[0]!.notes.length
	const headline = lone ? `${askers[0]!.name} ${asks(askers[0]!.asking!)}` : `${total} thing${total === 1 ? ' wants' : 's want'} your attention`
	return (
		<div className={`attention-tray${open ? ' open' : ''}`} onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
			<div className="attention-bar">
				<button className="attention-pill" aria-expanded={open} title={`From ${names.join(', ')}`} onClick={() => setOpen(!open)}>
					<span className="attention-dots" aria-hidden="true">
						{callers.slice(0, 4).map((c) => (
							<i key={c.sessionId} style={{ background: c.color }} />
						))}
					</span>
					<span className="attention-pill-text">
						{headline}
						{!lone && (
							<span className="attention-pill-names">
								{' · '}
								{names[0]}
								{names.length > 1 ? ` +${names.length - 1}` : ''}
							</span>
						)}
					</span>
					<span className="attention-caret">{open ? '▴' : '▾'}</span>
				</button>
				<Stepper attention={attention} label="sticky note" />
			</div>
			{open && (
				<div className="attention-list">
					{callers.map((c) => (
						<CallerRow key={c.sessionId} attention={attention} caller={c} hidden={hidden.split(' ').includes(c.sessionId)} />
					))}
				</div>
			)}
		</div>
	)
}

/** One session in the breakdown: what it asks, or its next note, with arrows through its notes. */
function CallerRow({ attention, caller: c, hidden }: { attention: Attention; caller: Caller; hidden: boolean }) {
	const current = useValue(() => attention.current.get()?.id, [attention])
	const shown = c.notes.find((n) => n.id === current) ?? c.notes[0]
	return (
		<div className={`attention-row${c.asking ? ' asking' : ''}${c.parentName ? ' child' : ''}`} style={{ ['--agent-color' as string]: c.color }}>
			<button
				className="attention-row-open"
				title={
					hidden
						? attention.sessions.canEdit
							? 'Its frame is hidden: show it again from Sessions'
							: 'Its frame is hidden on this canvas'
						: c.asking
							? 'Show what it asks'
							: 'Show its next note'
				}
				onClick={() => {
					if (hidden) {
						if (attention.sessions.canEdit) sessionsPopover.set({ focus: c.sessionId })
					} else if (c.asking) attention.answer(c.sessionId)
					else attention.step(1, c.sessionId)
				}}
			>
				<i className="attention-row-dot" />
				<span className="attention-row-main">
					<span className="attention-row-name" title={c.name}>
						{c.parentName && <span className="attention-row-parent">{c.parentName} › </span>}
						{c.ownName}
						{hidden && <span className="attention-row-hidden"> (hidden)</span>}
					</span>
					<span className="attention-row-preview">
						{c.asking ? `${capital(asks(c.asking))}${c.asking.text ? `: ${c.asking.text}` : ''}` : preview(attention, shown)}
					</span>
				</span>
			</button>
			{c.asking && <span className="attention-row-count">?</span>}
			{c.notes.length > 0 && (hidden ? <span className="attention-row-count">{c.notes.length}</span> : <Stepper attention={attention} sessionId={c.sessionId} label={`${c.name} note`} />)}
		</div>
	)
}

/** ← 2/5 → through the notes: everyone's, or one session's. */
function Stepper({ attention, sessionId, label }: { attention: Attention; sessionId?: string; label: string }) {
	const at = useValue(() => {
		const p = attention.position(sessionId)
		return `${p.index} ${p.total}`
	}, [attention, sessionId])
	const [index, total] = at.split(' ').map(Number) as [number, number]
	if (!total) return null
	return (
		<span className={`attention-steps${sessionId ? ' in-row' : ''}`}>
			<button className="attention-arrow" title={`Previous ${label}`} aria-label={`Previous ${label}`} onClick={() => attention.step(-1, sessionId)}>
				←
			</button>
			<span className="attention-pos" aria-live="polite">
				{index ? `${index}/${total}` : total}
			</span>
			<button className="attention-arrow" title={`Next ${label}`} aria-label={`Next ${label}`} onClick={() => attention.step(1, sessionId)}>
				→
			</button>
		</span>
	)
}

/** "is asking a question", "needs your permission" and the like. */
function asks(asking: AskingInfo): string {
	if (asking.kind === 'permission') return asking.count > 1 ? `needs your permission (${asking.count})` : 'needs your permission'
	return asking.count > 1 ? `is asking ${asking.count} questions` : 'is asking a question'
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** The first line of a note, as plain text, for the breakdown. */
function preview(attention: Attention, note: AgentNoteInfo | undefined): string {
	if (!note) return ''
	const text = note.text
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/[`*_~#>]+/g, '')
		.replace(/\s+/g, ' ')
		.trim()
	if (note.kind === 'highlight' && note.target && !text) return `Look at ${attention.notes.targetLabel(note.target)}`
	return text
}
