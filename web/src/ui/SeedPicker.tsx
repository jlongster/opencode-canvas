import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { OpenCodeSessionSummary, SeedResult } from '../../../shared/types'
import type { Editor } from '../editor/Editor'
import { AUTO_SESSIONS, autoCandidates, autoSeed, autoSeededAt, type AutoRow } from '../opencode/autoseed'
import { seedSession } from '../opencode/seed'
import { relativeTime, shortDir } from './Conjure'
import { pairOffer } from '../opencode/pairings'
import { useValue } from './useValue'
import { PairForm, SessionGroups, sessionKey, useOpenCode } from './OpenCodeServers'

type RowStatus = { state: 'waiting' } | { state: 'seeding' } | { state: 'done'; result: SeedResult }

interface AutoState {
	rows: { session: OpenCodeSessionSummary; row: AutoRow }[]
	running: boolean
}

/** how long the finished progress panel stays up (unless hovered) */
const AUTO_LINGER_MS = 3000
/** matches .seed-auto.fading's transition */
const FADE_MS = 500

/**
 * The empty canvas's session picker (edit links): pick OpenCode sessions on the servers paired in
 * this browser and seed the canvas with a frame for each, holding the media it output in the last
 * day (or its latest 10 if there are fewer). The browser reads the sessions from OpenCode and uploads the media itself. Sessions are
 * seeded one at a time, in list order, so each row shows its own progress and errors; frames fill
 * in live meanwhile. `onBusy` is true from the start of seeding until the results are dismissed,
 * so the picker stays up after the canvas stops being empty. With no server paired yet, it asks for
 * a pairing link first. Sessions (and selections) are keyed "<serverKey>/<sessionId>".
 *
 * A brand-new canvas doesn't wait to be picked for: once the paired servers answer, it brings in
 * the latest sessions with media by itself (see opencode/autoseed.ts), showing their progress in
 * a small bar at the top (in `topStack`, above the attention tray) that leaves the canvas free to pan
 * and zoom; the picker stays a click away. Until it knows whether it will (sessions listed, canvas
 * not seeded before), it shows nothing.
 */
export function SeedPicker({
	editor,
	canvasId,
	onBusy,
	topStack,
}: {
	editor: Editor
	canvasId: string
	onBusy: (busy: boolean) => void
	topStack?: HTMLElement | null
}) {
	const { servers, sessions, errors, reload: load } = useOpenCode()
	const offer = useValue(() => pairOffer.get())
	const [query, setQuery] = useState('')
	const [selected, setSelected] = useState<string[]>([])
	const [status, setStatus] = useState<Record<string, RowStatus> | null>(null)
	const [running, setRunning] = useState(false)
	const [auto, setAuto] = useState<AutoState | null>(null)
	const [note, setNote] = useState<string | null>(null)
	// the picker is held open over a canvas that isn't empty any more ("Choose sessions" while seeding)
	const [held, setHeld] = useState(false)
	// deciding whether to seed by itself: nothing shows meanwhile
	const [pending, setPending] = useState(() => servers.length > 0)
	const [expanded, setExpanded] = useState(false)
	const [fading, setFading] = useState(false)
	const autoTried = useRef(false)
	const autoStopped = useRef(false)
	const lingerTimer = useRef(0)
	const hasFrames = useValue(() => Object.keys(editor.sessions.get()).length > 0)

	useEffect(() => {
		if (pending) onBusy(true)
		return () => {
			autoStopped.current = true
			clearTimeout(lingerTimer.current)
		}
	}, [])

	const settle = () => {
		if (!pending) return
		setPending(false)
		onBusy(false)
	}

	// Seed a new canvas by itself as soon as the paired servers list their sessions.
	useEffect(() => {
		if (servers.length && !sessions) return
		if (autoTried.current || !sessions || running || status) return settle()
		const candidates = autoCandidates(sessions)
		if (!candidates.length || Object.keys(editor.sessions.peek()).length) return settle()
		autoTried.current = true
		runAuto(candidates)
	}, [sessions])

	const runAuto = async (candidates: OpenCodeSessionSummary[]) => {
		let seededBefore = true
		try {
			seededBefore = !!(await autoSeededAt(canvasId))
		} catch {}
		if (autoStopped.current) return
		setPending(false)
		if (seededBefore) return onBusy(false)
		onBusy(true)
		setAuto({ rows: [], running: true })
		const outcome = await autoSeed(canvasId, candidates, {
			existing: (sessionId) => existingItems(sessionId),
			onRow: (session, row) =>
				setAuto((a) => {
					if (!a) return a
					const rows = a.rows.some((r) => r.session === session)
						? a.rows.map((r) => (r.session === session ? { session, row } : r))
						: [...a.rows, { session, row }]
					return { ...a, rows }
				}),
			onSeeded: () => editor.zoomToFit({ animate: true }),
			stopped: () => autoStopped.current,
		})
		if (outcome.kind === 'stopped') return
		if (outcome.kind === 'seeded') {
			setAuto((a) => a && { rows: a.rows.filter((r) => r.row.state !== 'reading'), running: false })
			lingerTimer.current = window.setTimeout(fadeOut, AUTO_LINGER_MS)
			return
		}
		setAuto(null)
		onBusy(false)
		if (outcome.kind === 'nothing') {
			setNote(`None of your ${candidates.length} latest sessions has images or videos yet.`)
		} else if (outcome.kind === 'claimed') {
			setNote('Someone else is already bringing in their latest sessions here.')
		} else if (outcome.kind === 'failed') {
			setNote(`Couldn't bring in your latest sessions: ${outcome.error}`)
		}
	}

	const finishAuto = () => {
		clearTimeout(lingerTimer.current)
		setAuto(null)
		onBusy(false)
	}

	const fadeOut = () => {
		setFading(true)
		lingerTimer.current = window.setTimeout(finishAuto, FADE_MS)
	}

	/** Leaves the progress for the picker (stopping after the session uploading now). */
	const chooseInstead = () => {
		autoStopped.current = true
		clearTimeout(lingerTimer.current)
		setFading(false)
		setAuto(null)
		setHeld(true)
		onBusy(true)
	}

	const closeHeld = () => {
		setHeld(false)
		onBusy(false)
	}

	// Items already seeded (same name and time) aren't added twice.
	const existingItems = (sessionId: string) =>
		new Set(
			Object.values(editor.items.peek())
				.filter((i) => i.sessionId === sessionId)
				.map((i) => `${i.name}@${i.createdAt}`),
		)

	const q = query.trim().toLowerCase()
	const shown = (sessions ?? []).filter(
		(s) => !q || s.title.toLowerCase().includes(q) || s.directory.toLowerCase().includes(q) || s.id.toLowerCase().includes(q),
	)
	const toggle = (id: string) => setSelected((sel) => (sel.includes(id) ? sel.filter((s) => s !== id) : [...sel, id]))

	const seed = async () => {
		// Frames go left to right in the list's order (newest session first).
		const ids = (sessions ?? []).map(sessionKey).filter((k) => selected.includes(k))
		const byKey = new Map((sessions ?? []).map((s) => [sessionKey(s), s]))
		const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
		if (!ids.length || running) return
		setRunning(true)
		onBusy(true)
		setStatus(Object.fromEntries(ids.map((id) => [id, { state: 'waiting' } as RowStatus])))
		let failed = false
		for (const id of ids) {
			const session = byKey.get(id)!
			setStatus((s) => ({ ...s, [id]: { state: 'seeding' } }))
			const existing = existingItems(session.id)
			let result: SeedResult
			try {
				result = await seedSession(canvasId, session.serverKey, session.id, { existing, timeZone })
			} catch (e) {
				result = { sessionId: session.id, title: '', added: 0, skipped: 0, error: (e as Error).message }
			}
			if (result.error || result.skipped) failed = true
			setStatus((s) => ({ ...s, [id]: { state: 'done', result } }))
			if (result.added) editor.zoomToFit({ animate: true })
		}
		setRunning(false)
		// Everything went in: nothing more to say, the canvas shows it.
		if (!failed) finish()
	}

	const finish = () => {
		setStatus(null)
		setSelected([])
		setHeld(false)
		onBusy(false)
	}

	if (pending) return null

	if (auto) {
		const seeded = auto.rows.filter((r) => r.row.state === 'done' && r.row.result.added).length
		const current = auto.rows.find((r) => r.row.state === 'uploading') ?? auto.rows.find((r) => r.row.state === 'reading')
		const currentText = !current
			? ''
			: current.row.state === 'uploading'
				? `${current.session.title || 'Untitled session'} uploading ${current.row.done}/${current.row.total}`
				: `reading ${current.session.title || 'Untitled session'}`
		const bar = (
			<div
				className={`seed-picker seed-auto${auto.running ? '' : ' done'}${fading ? ' fading' : ''}`}
				onPointerDown={(e) => e.stopPropagation()}
				onWheel={(e) => e.stopPropagation()}
				onPointerEnter={() => {
					clearTimeout(lingerTimer.current)
					setFading(false)
				}}
				onPointerLeave={() => {
					if (!auto.running) lingerTimer.current = window.setTimeout(fadeOut, AUTO_LINGER_MS)
				}}
			>
				<div className="seed-bar">
					<span className="seed-state">{auto.running ? <span className="seed-spinner" /> : '✓'}</span>
					<span className="seed-bar-text" title={currentText}>
						{auto.running ? (
							<>
								Bringing in your latest sessions · {seeded}/{AUTO_SESSIONS}
								{currentText && <span className="seed-bar-current"> · {currentText}</span>}
							</>
						) : (
							`Brought in your latest ${seeded} session${seeded === 1 ? '' : 's'}`
						)}
					</span>
					{auto.rows.length > 0 && (
						<button className="seed-bar-toggle" title={expanded ? 'Hide sessions' : 'Show sessions'} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
							{expanded ? '▴' : '▾'}
						</button>
					)}
					<button className="seed-secondary" onClick={chooseInstead}>
						{auto.running ? 'Choose sessions instead' : 'Add more sessions'}
					</button>
					{!auto.running && (
						<button className="seed-bar-toggle" title="Dismiss" onClick={finishAuto}>
							×
						</button>
					)}
				</div>
				<div className="seed-progress">
					<div style={{ width: `${auto.running ? (seeded / AUTO_SESSIONS) * 100 : 100}%` }} />
				</div>
				{expanded && (
					<div className="seed-list">
						{auto.rows.map(({ session, row }) => (
							<div
								key={sessionKey(session)}
								className={`seed-row seed-${row.state === 'reading' || row.state === 'uploading' ? 'seeding' : 'done'}${row.state === 'empty' ? ' seed-skip' : ''}${
									row.state === 'error' || (row.state === 'done' && row.result.error) ? ' failed' : ''
								}`}
								title={`${session.title || session.id}\n${session.directory}`}
							>
								<span className="seed-state">
									{row.state === 'reading' || row.state === 'uploading' ? (
										<span className="seed-spinner" />
									) : row.state === 'empty' ? (
										'–'
									) : row.state === 'error' || (row.state === 'done' && row.result.error) ? (
										'!'
									) : (
										'✓'
									)}
								</span>
								<span className="seed-row-main">
									<span className="seed-row-title">{session.title || 'Untitled session'}</span>
									<span className="seed-row-meta">{autoRowText(row, session)}</span>
								</span>
							</div>
						))}
					</div>
				)}
			</div>
		)
		// First in the strip under the top bar, so the attention tray stacks below it.
		return topStack ? createPortal(bar, topStack) : bar
	}

	if (status) {
		const ids = Object.keys(status)
		const byId = new Map((sessions ?? []).map((s) => [sessionKey(s), s]))
		const done = ids.filter((id) => status[id].state === 'done').length
		return (
			<div className="seed-picker" onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
				<div className="seed-head">
					<h2>{running ? `Seeding… ${done} of ${ids.length}` : 'Seeded the canvas'}</h2>
				</div>
				<div className="seed-progress">
					<div style={{ width: `${(done / ids.length) * 100}%` }} />
				</div>
				<div className="seed-list">
					{ids.map((id) => {
						const s = status[id]
						const title = (s.state === 'done' && s.result.title) || byId.get(id)?.title || id.split('/')[1]
						return (
							<div key={id} className={`seed-row seed-${s.state}${s.state === 'done' && s.result.error ? ' failed' : ''}`}>
								<span className="seed-state">{s.state === 'waiting' ? '·' : s.state === 'seeding' ? <span className="seed-spinner" /> : s.result.error ? '!' : '✓'}</span>
								<span className="seed-row-main">
									<span className="seed-row-title">{title}</span>
									<span className="seed-row-meta">{rowStatusText(s)}</span>
								</span>
							</div>
						)
					})}
				</div>
				{!running && (
					<div className="seed-actions">
						<button className="seed-primary" onClick={finish}>
							Done
						</button>
					</div>
				)}
			</div>
		)
	}

	if (servers.length === 0) {
		return (
			<div className="seed-picker" onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
				<div className="seed-head">
					<h2>{offer ? 'Connect OpenCode to get started' : 'Seed this canvas from OpenCode'}</h2>
					<p>
						{offer ? 'Then' : 'Connect your OpenCode, then'} pick sessions: each gets a frame with its images and videos from the last 24 hours, or its
						latest 10 if there are fewer.
					</p>
				</div>
				<PairForm large onPaired={() => load()} />
			</div>
		)
	}

	const row = (s: OpenCodeSessionSummary) => {
		const k = sessionKey(s)
		return (
			<label key={k} className={`seed-row${selected.includes(k) ? ' selected' : ''}`} title={`${s.title || s.id}\n${s.directory}\n${s.id} on ${s.serverName}`}>
				<input type="checkbox" checked={selected.includes(k)} onChange={() => toggle(k)} />
				<span className={`conjure-dot${s.busy ? ' busy' : ''}`} title={s.busy ? 'Working' : 'Idle'} />
				<span className="seed-row-main">
					<span className="seed-row-title">{s.title || 'Untitled session'}</span>
					<span className="seed-row-meta">
						{shortDir(s.directory)} · {relativeTime(s.updatedAt)}
					</span>
				</span>
			</label>
		)
	}

	return (
		<div className="seed-picker" onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
			<div className="seed-head">
				<h2>{held && hasFrames ? 'Add sessions to this canvas' : 'Seed this canvas from OpenCode'}</h2>
				<p>Pick sessions: each gets a frame with its images and videos from the last 24 hours, or its latest 10 if there are fewer.</p>
				{note && <p className="seed-note">{note}</p>}
			</div>
			<div className="seed-filters">
				<input className="seed-search" placeholder="Filter sessions" value={query} onChange={(e) => setQuery(e.target.value)} />
			</div>
			<div className="seed-list">
				{sessions === null && <div className="seed-message">Loading sessions…</div>}
				{sessions !== null && shown.length === 0 && servers.length === 1 && !Object.keys(errors).length && (
					<div className="seed-message">No sessions{q ? ' match' : ''}</div>
				)}
				{sessions !== null && <SessionGroups servers={servers} sessions={shown} errors={errors} render={row} />}
			</div>
			<div className="seed-actions">
				{held && (
					<button className="seed-secondary seed-close" onClick={closeHeld}>
						Close
					</button>
				)}
				{selected.length > 0 && (
					<button className="seed-secondary" onClick={() => setSelected([])}>
						Clear
					</button>
				)}
				<button className="seed-primary" disabled={!selected.length} onClick={seed}>
					{selected.length ? `Seed canvas with ${selected.length} session${selected.length === 1 ? '' : 's'}` : 'Select sessions to seed'}
				</button>
			</div>
		</div>
	)
}

function autoRowText(row: AutoRow, session: OpenCodeSessionSummary): string {
	if (row.state === 'reading') return 'Reading…'
	if (row.state === 'uploading') return `Uploading ${row.done}/${row.total}`
	if (row.state === 'empty') return `No media · ${relativeTime(session.updatedAt)}`
	if (row.state === 'error') return row.error
	return rowStatusText({ state: 'done', result: row.result })
}

function rowStatusText(s: RowStatus): string {
	if (s.state === 'waiting') return 'Waiting'
	if (s.state === 'seeding') return 'Finding media…'
	const { added, skipped, error } = s.result
	const skippedText = skipped ? `${skipped} skipped` : ''
	if (error) return [error, skippedText].filter(Boolean).join(' · ')
	return [`${added} item${added === 1 ? '' : 's'} added`, skippedText].filter(Boolean).join(' · ')
}
