import { useEffect, useState } from 'react'
import type { OpenCodeSessionSummary, SeedResult } from '../../../shared/types'
import type { Editor } from '../editor/Editor'
import { listOpenCodeSessions, seedCanvas } from '../sync/client'
import { relativeTime, shortDir } from './Conjure'

type RowStatus = { state: 'waiting' } | { state: 'seeding' } | { state: 'done'; result: SeedResult }

/**
 * The empty canvas's session picker (edit links, OpenCode connected): pick OpenCode sessions and
 * seed the canvas with a frame for each, holding the media it output in the last day. Sessions are
 * seeded one at a time, in list order, so each row shows its own progress and errors; frames fill
 * in live meanwhile. `onBusy` is true from the start of seeding until the results are dismissed,
 * so the picker stays up after the canvas stops being empty.
 */
export function SeedPicker({ editor, canvasId, onBusy }: { editor: Editor; canvasId: string; onBusy: (busy: boolean) => void }) {
	const [sessions, setSessions] = useState<OpenCodeSessionSummary[] | null>(null)
	const [loadError, setLoadError] = useState<string | null>(null)
	const [query, setQuery] = useState('')
	const [showSubagents, setShowSubagents] = useState(false)
	const [selected, setSelected] = useState<string[]>([])
	const [status, setStatus] = useState<Record<string, RowStatus> | null>(null)
	const [running, setRunning] = useState(false)

	const load = async () => {
		setLoadError(null)
		try {
			setSessions(await listOpenCodeSessions())
		} catch (e) {
			setLoadError((e as Error).message)
		}
	}
	useEffect(() => {
		load()
	}, [])

	const q = query.trim().toLowerCase()
	const subagentCount = (sessions ?? []).filter((s) => s.parentId).length
	const shown = (sessions ?? []).filter(
		(s) =>
			(showSubagents || !s.parentId || selected.includes(s.id)) &&
			(!q || s.title.toLowerCase().includes(q) || s.directory.toLowerCase().includes(q) || s.id.toLowerCase().includes(q)),
	)
	const toggle = (id: string) => setSelected((sel) => (sel.includes(id) ? sel.filter((s) => s !== id) : [...sel, id]))

	const seed = async () => {
		// Frames go left to right in the list's order (newest session first).
		const ids = (sessions ?? []).map((s) => s.id).filter((id) => selected.includes(id))
		if (!ids.length || running) return
		setRunning(true)
		onBusy(true)
		setStatus(Object.fromEntries(ids.map((id) => [id, { state: 'waiting' } as RowStatus])))
		let failed = false
		for (const id of ids) {
			setStatus((s) => ({ ...s, [id]: { state: 'seeding' } }))
			let result: SeedResult
			try {
				result = (await seedCanvas(canvasId, [id])).results[0]
			} catch (e) {
				result = { sessionId: id, title: '', added: 0, skipped: 0, error: (e as Error).message }
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
		onBusy(false)
	}

	if (status) {
		const ids = Object.keys(status)
		const byId = new Map((sessions ?? []).map((s) => [s.id, s]))
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
						const title = (s.state === 'done' && s.result.title) || byId.get(id)?.title || id
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

	return (
		<div className="seed-picker" onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
			<div className="seed-head">
				<h2>Seed this canvas from OpenCode</h2>
				<p>Pick sessions: each gets a frame with the images and videos it output in the last 24 hours.</p>
			</div>
			<div className="seed-filters">
				<input className="seed-search" placeholder="Filter sessions" value={query} onChange={(e) => setQuery(e.target.value)} />
				{subagentCount > 0 && (
					<label className="seed-toggle" title="Subagent sessions are started by other sessions">
						<input type="checkbox" checked={showSubagents} onChange={(e) => setShowSubagents(e.target.checked)} />
						Subagents ({subagentCount})
					</label>
				)}
			</div>
			<div className="seed-list">
				{loadError && (
					<div className="seed-message error">
						{loadError} <button onClick={load}>Try again</button>
					</div>
				)}
				{sessions === null && !loadError && <div className="seed-message">Loading sessions…</div>}
				{sessions !== null && shown.length === 0 && <div className="seed-message">No sessions{q ? ' match' : ''}</div>}
				{shown.map((s) => (
					<label key={s.id} className={`seed-row${selected.includes(s.id) ? ' selected' : ''}`} title={`${s.title || s.id}\n${s.directory}\n${s.id}`}>
						<input type="checkbox" checked={selected.includes(s.id)} onChange={() => toggle(s.id)} />
						<span className={`conjure-dot${s.busy ? ' busy' : ''}`} title={s.busy ? 'Working' : 'Idle'} />
						<span className="seed-row-main">
							<span className="seed-row-title">{s.title || 'Untitled session'}</span>
							<span className="seed-row-meta">
								{shortDir(s.directory)} · {relativeTime(s.updatedAt)}
							</span>
						</span>
						{s.parentId && <span className="seed-tag">subagent</span>}
					</label>
				))}
			</div>
			<div className="seed-actions">
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

function rowStatusText(s: RowStatus): string {
	if (s.state === 'waiting') return 'Waiting'
	if (s.state === 'seeding') return 'Finding media…'
	const { added, skipped, error } = s.result
	const skippedText = skipped ? `${skipped} skipped` : ''
	if (error) return [error, skippedText].filter(Boolean).join(' · ')
	return [`${added} item${added === 1 ? '' : 's'} added`, skippedText].filter(Boolean).join(' · ')
}
