import { useMemo, useState } from 'react'
import type { OpenCodeSessionSummary } from '../../../shared/types'
import type { Editor } from '../editor/Editor'
import type { SessionControl } from '../multiplayer/SessionControl'
import { PairForm, ServerList, SessionGroups, sessionKey, useOpenCode } from './OpenCodeServers'
import { useValue } from './useValue'

/**
 * The toolbar's Sessions button (edit links): pick a session from a paired OpenCode to add its frame
 * to the canvas (if it has none yet), linked to this browser, with its prompt open there. Also where
 * OpenCode servers are paired and managed.
 */
export function SessionsButton({ editor, sessions, open, setOpen }: { editor: Editor; sessions: SessionControl; open: boolean; setOpen: (open: boolean) => void }) {
	return (
		<>
			<button className="sessions-button" title="Add an OpenCode session to the canvas, to prompt it from its frame" aria-pressed={open} onClick={() => setOpen(!open)}>
				<TerminalIcon />
				<span className="wide-only">Sessions</span>
			</button>
			{open && <SessionsPanel editor={editor} sessions={sessions} onClose={() => setOpen(false)} />}
		</>
	)
}

function SessionsPanel({ editor, sessions, onClose }: { editor: Editor; sessions: SessionControl; onClose: () => void }) {
	const { servers, byServer, errors, reload, retry } = useOpenCode()
	const [error, setError] = useState<string | null>(null)
	const [pending, setPending] = useState<string | null>(null)
	const [query, setQuery] = useState('')
	const [managing, setManaging] = useState(false)
	const hereKey = useValue(() => Object.keys(editor.sessions.get()).sort().join(' '), [editor])
	const here = useMemo(() => new Set(hereKey.split(' ').filter(Boolean)), [hereKey])

	const pick = async (s: OpenCodeSessionSummary) => {
		setPending(sessionKey(s))
		setError(null)
		try {
			const message = await sessions.add(s.id, { serverKey: s.serverKey, title: s.title })
			if (message) setError(message)
			else onClose()
		} catch (e) {
			setError((e as Error).message)
		} finally {
			setPending(null)
		}
	}

	const q = query.trim().toLowerCase()
	// Each server's sessions show as soon as it answers, without waiting for slower ones.
	const loading = servers.filter((p) => !byServer[p.key] || byServer[p.key].status === 'loading').map((p) => p.key)
	const shown = servers
		.flatMap((p) => {
			const l = byServer[p.key]
			return l?.status === 'ok' ? l.sessions : []
		})
		.filter((s) => !q || s.title.toLowerCase().includes(q) || s.directory.toLowerCase().includes(q))
	const failing = Object.keys(errors).length

	return (
		<div className="share-popover sessions-popover" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
			<div className="share-popover-head">
				<span className="sessions-heading">
					<TerminalIcon /> Add a session
				</span>
				<button title="Close" onClick={onClose}>
					×
				</button>
			</div>
			{servers.length === 0 ? (
				<PairForm autoFocus onPaired={() => reload()} />
			) : (
				<>
					<p className="sessions-hint">
						Adds the session’s frame to this canvas and links it to this browser: prompt it from its frame, and everyone sees when it’s working.
					</p>
					<input className="sessions-search" autoFocus placeholder="Filter sessions" value={query} onChange={(e) => setQuery(e.target.value)} />
					<div className="sessions-list">
						<SessionGroups
							servers={servers}
							sessions={shown}
							errors={errors}
							loading={loading}
							onRetry={retry}
							empty={q ? 'No sessions match' : 'No sessions'}
							render={(s) => {
								const isHere = here.has(s.id)
								const k = sessionKey(s)
								return (
									<button
										key={k}
										className={`sessions-row${isHere ? ' here' : ''}`}
										disabled={pending !== null}
										title={isHere ? 'Already on this canvas: go to its frame and prompt it' : `Add ${s.title || s.id}`}
										onClick={() => pick(s)}
									>
										<span className={`sessions-dot${s.busy ? ' busy' : ''}`} title={s.busy ? 'Working' : 'Idle'} />
										<span className="sessions-row-main">
											<span className="sessions-row-title">{s.title || 'Untitled session'}</span>
											<span className="sessions-row-meta">
												{shortDir(s.directory)} · {relativeTime(s.updatedAt)}
											</span>
										</span>
										{pending === k ? <span className="sessions-tag">…</span> : isHere && <span className="sessions-tag">on canvas</span>}
									</button>
								)
							}}
						/>
					</div>
					<div className="oc-manage">
						<button className="oc-manage-toggle" aria-expanded={managing} onClick={() => setManaging(!managing)}>
							<span className="oc-manage-caret">{managing ? '▾' : '▸'}</span>
							Servers ({servers.length})
							{failing > 0 && <span className="oc-manage-warn">{failing} not reachable</span>}
						</button>
						{managing && <ServerList servers={servers} errors={errors} />}
					</div>
				</>
			)}
			{error && <div className="sessions-error">{error}</div>}
		</div>
	)
}

function TerminalIcon() {
	return (
		<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<rect x="3" y="4.5" width="18" height="15" rx="2.5" />
			<path d="m7.5 10 2.5 2-2.5 2M12.5 14.5h4" />
		</svg>
	)
}

/** "~/projects/canvas" style: home shortened, and only the last two folders of long paths. */
export function shortDir(dir: string) {
	const home = dir.replace(/^\/(?:root|home\/[^/]+)(?=\/|$)/, '~')
	const parts = home.split('/').filter(Boolean)
	return parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : home || '/'
}

export function relativeTime(at: number) {
	const s = Math.max(0, (Date.now() - at) / 1000)
	if (s < 45) return 'just now'
	if (s < 3600) return `${Math.round(s / 60)}m ago`
	if (s < 86400) return `${Math.round(s / 3600)}h ago`
	if (s < 86400 * 30) return `${Math.round(s / 86400)}d ago`
	return new Date(at).toLocaleDateString()
}
