import { useState } from 'react'
import type { OpenCodeSessionSummary, SeedResult } from '../../../shared/types'
import type { Editor } from '../editor/Editor'
import { seedSession } from '../opencode/seed'
import { relativeTime, shortDir } from './Conjure'
import { pairOffer } from '../opencode/pairings'
import { useValue } from './useValue'
import { PairForm, SessionGroups, sessionKey, useOpenCode } from './OpenCodeServers'

type RowStatus = { state: 'waiting' } | { state: 'seeding' } | { state: 'done'; result: SeedResult }

/**
 * The empty canvas's session picker (edit links): pick OpenCode sessions on the servers paired in
 * this browser and seed the canvas with a frame for each, holding the media it output in the last
 * day (or its latest 10 if there are fewer). The browser reads the sessions from OpenCode and uploads the media itself. Sessions are
 * seeded one at a time, in list order, so each row shows its own progress and errors; frames fill
 * in live meanwhile. `onBusy` is true from the start of seeding until the results are dismissed,
 * so the picker stays up after the canvas stops being empty. With no server paired yet, it asks for
 * a pairing link first. Sessions (and selections) are keyed "<serverKey>/<sessionId>".
 */
export function SeedPicker({ editor, canvasId, onBusy }: { editor: Editor; canvasId: string; onBusy: (busy: boolean) => void }) {
	const { servers, sessions, errors, reload: load } = useOpenCode()
	const offer = useValue(() => pairOffer.get())
	const [query, setQuery] = useState('')
	const [showSubagents, setShowSubagents] = useState(false)
	const [selected, setSelected] = useState<string[]>([])
	const [status, setStatus] = useState<Record<string, RowStatus> | null>(null)
	const [running, setRunning] = useState(false)

	const q = query.trim().toLowerCase()
	const subagentCount = (sessions ?? []).filter((s) => s.parentId).length
	const shown = (sessions ?? []).filter(
		(s) =>
			(showSubagents || !s.parentId || selected.includes(sessionKey(s))) &&
			(!q || s.title.toLowerCase().includes(q) || s.directory.toLowerCase().includes(q) || s.id.toLowerCase().includes(q)),
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
			// Already seeded items (same name and time) aren't added twice.
			const existing = new Set(
				Object.values(editor.items.peek())
					.filter((i) => i.sessionId === session.id)
					.map((i) => `${i.name}@${i.createdAt}`),
			)
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
		onBusy(false)
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
				{s.parentId && <span className="seed-tag">subagent</span>}
			</label>
		)
	}

	return (
		<div className="seed-picker" onPointerDown={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()}>
			<div className="seed-head">
				<h2>Seed this canvas from OpenCode</h2>
				<p>Pick sessions: each gets a frame with its images and videos from the last 24 hours, or its latest 10 if there are fewer.</p>
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
				{sessions === null && <div className="seed-message">Loading sessions…</div>}
				{sessions !== null && shown.length === 0 && servers.length === 1 && !Object.keys(errors).length && (
					<div className="seed-message">No sessions{q ? ' match' : ''}</div>
				)}
				{sessions !== null && <SessionGroups servers={servers} sessions={shown} errors={errors} render={row} />}
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
