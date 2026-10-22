import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { OpenCodeSessionSummary } from '../../../shared/types'
import type { Editor } from '../editor/Editor'
import { frameKey } from '../editor/selection'
import type { SessionControl } from '../multiplayer/SessionControl'
import { liveSessions } from '../opencode/live'
import { atom } from '../state/signals'
import { PairForm, ServerList, sessionKey, useOpenCode } from './OpenCodeServers'
import { useValue } from './useValue'
import './sessions.css'

/** The Sessions popover, while it's open; `focus`: a hidden frame to point out in it (from the attention bar). */
export const sessionsPopover = atom<{ focus?: string } | null>('sessionsPopover', null)

/** sessions coming or going on a server have the popover list them again this long after */
const RELIST_DEBOUNCE_MS = 300

/**
 * The toolbar's Sessions button (edit links): every session on the paired OpenCode servers, in one
 * list, most recently active first. Picking one adds its frame to the canvas (if it has none yet),
 * linked to this browser, with its prompt open there. Also where hidden frames are shown again and
 * OpenCode servers are paired and managed.
 */
export function SessionsButton({ editor, sessions }: { editor: Editor; sessions: SessionControl }) {
	const open = useValue(() => sessionsPopover.get() !== null)
	const wrapRef = useRef<HTMLSpanElement>(null)

	// Close on a press anywhere else.
	useEffect(() => {
		if (!open) return
		const onDown = (e: PointerEvent) => {
			if (!wrapRef.current?.contains(e.target as Node)) sessionsPopover.set(null)
		}
		window.addEventListener('pointerdown', onDown, true)
		return () => window.removeEventListener('pointerdown', onDown, true)
	}, [open])

	return (
		<span className="sp-wrap" ref={wrapRef}>
			<button
				className="sp-trigger"
				title="Sessions: add an OpenCode session’s frame to the canvas, to prompt it from there"
				aria-expanded={open}
				aria-haspopup="dialog"
				aria-pressed={open}
				onClick={() => sessionsPopover.set(open ? null : {})}
			>
				<TerminalIcon />
				<span className="wide-only">Sessions</span>
			</button>
			{open && <SessionsPopover editor={editor} sessions={sessions} onClose={() => sessionsPopover.set(null)} />}
		</span>
	)
}

interface Row extends OpenCodeSessionSummary {
	here: boolean
	hidden: boolean
}

function SessionsPopover({ editor, sessions, onClose }: { editor: Editor; sessions: SessionControl; onClose: () => void }) {
	const { servers, byServer, errors, reload, retry } = useOpenCode()
	const [error, setError] = useState<string | null>(null)
	const [pending, setPending] = useState<string | null>(null)
	const [query, setQuery] = useState('')
	const [managing, setManaging] = useState(false)
	const focus = useValue(() => sessionsPopover.get()?.focus)
	const known = useValue(() => liveSessions.sessions.get())
	const busyNow = useValue(() => liveSessions.busy.get())
	const listVersion = useValue(() => liveSessions.listVersion.get())
	const frames = useValue(() => editor.sessions.get(), [editor])
	const rootRef = useRef<HTMLDivElement>(null)
	const inputRef = useRef<HTMLInputElement>(null)

	// Sessions came or went on a server (or its stream reconnected): list again, keeping what's shown meanwhile.
	const firstVersion = useRef(listVersion)
	useEffect(() => {
		if (listVersion === firstVersion.current) return
		const timer = setTimeout(() => void reload(), RELIST_DEBOUNCE_MS)
		return () => clearTimeout(timer)
	}, [listVersion])

	const multi = servers.length > 1
	const q = query.trim().toLowerCase()
	const loading = servers.filter((p) => !byServer[p.key] || byServer[p.key].status === 'loading')
	const answered = servers.length - loading.length
	const failing = servers.filter((p) => errors[p.key])

	// Every server's sessions in one list, with what their event streams said since they were listed.
	const rows = useMemo(() => {
		const list: Row[] = []
		for (const p of servers) {
			const l = byServer[p.key]
			if (l?.status !== 'ok') continue
			const busy = liveSessions.busyOn(p.key)
			for (const s of l.sessions) {
				const k = known[s.id]
				if (k?.deleted) continue
				const live = k?.serverKey === p.key ? k : undefined
				const frame = frames[s.id]
				list.push({
					...s,
					title: live?.title ?? s.title,
					directory: live?.directory ?? s.directory,
					updatedAt: Math.max(s.updatedAt, live?.updatedAt ?? 0),
					busy: busy ? busy.has(s.id) : s.busy,
					here: !!frame,
					hidden: !!frame?.hidden,
				})
			}
		}
		return list.sort((a, b) => b.updatedAt - a.updatedAt)
	}, [servers, byServer, known, busyNow, frames])
	const shown = q
		? rows.filter((s) => [s.title, s.directory, multi ? s.serverName : ''].some((f) => f.toLowerCase().includes(q)) || s.id.toLowerCase() === q)
		: rows

	// each frame's item count and newest item, for the hidden ones
	const itemStats = useValue(() => {
		const stats: Record<string, [count: number, latest: number]> = {}
		for (const item of Object.values(editor.items.get())) {
			const [count, latest] = stats[item.sessionId] ?? [0, 0]
			stats[item.sessionId] = [count + 1, Math.max(latest, item.createdAt)]
		}
		return JSON.stringify(stats)
	}, [editor])
	const hiddenFrames = useMemo(() => {
		const stats = JSON.parse(itemStats) as Record<string, [number, number]>
		return Object.values(frames)
			.filter((s) => s.hidden)
			.map((s) => {
				const untitled = !s.title.trim() || s.title === s.id
				const [items, latest] = stats[s.id] ?? [0, 0]
				return { id: s.id, title: untitled ? 'Untitled session' : s.title, untitled, items, fresh: !!s.hiddenAt && latest > s.hiddenAt }
			})
	}, [frames, itemStats])
	const [showHidden, setShowHidden] = useState(!!focus)
	useEffect(() => {
		if (focus) setShowHidden(true)
	}, [focus])

	const pick = async (s: Row) => {
		setPending(sessionKey(s))
		setError(null)
		try {
			if (s.hidden) editor.setFrameHidden(s.id, false)
			const message = await sessions.add(s.id, { serverKey: s.serverKey, title: s.title })
			if (message) setError(message)
			else onClose()
		} catch (e) {
			setError((e as Error).message)
		} finally {
			setPending(null)
		}
	}

	const showFrame = (id: string) => {
		editor.setFrameHidden(id, false)
		onClose()
		requestAnimationFrame(() => editor.focusSelectionKey(frameKey(id)))
	}

	// Arrow keys move between the search field and the rows; Escape closes.
	const onKeyDown = (e: ReactKeyboardEvent) => {
		if (e.key === 'Escape') {
			e.stopPropagation()
			return onClose()
		}
		if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
		const stops = [inputRef.current, ...(rootRef.current?.querySelectorAll<HTMLElement>('.sp-row:not(:disabled)') ?? [])].filter(Boolean) as HTMLElement[]
		const at = stops.indexOf(document.activeElement as HTMLElement)
		if (at < 0) return
		e.preventDefault()
		stops[Math.max(0, Math.min(stops.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus()
	}

	return (
		<div className="sp" ref={rootRef} role="dialog" aria-label="Sessions" onKeyDown={onKeyDown} onWheel={(e) => e.stopPropagation()}>
			<div className="sp-head">
				<span className="sp-title">Sessions</span>
				{servers.length > 0 && answered > 0 && (
					<span className="sp-count">
						{rows.length}
						{multi ? ` · ${servers.length} servers` : ''}
					</span>
				)}
				<button className="sp-close" title="Close (Esc)" aria-label="Close" onClick={onClose}>
					<CloseIcon />
				</button>
			</div>

			{servers.length === 0 ? (
				<div className="sp-pair">
					<PairForm autoFocus onPaired={() => reload()} title="Connect OpenCode to add its sessions" />
				</div>
			) : (
				<>
					<label className="sp-search">
						<SearchIcon />
						<input
							ref={inputRef}
							autoFocus
							placeholder={multi ? 'Search sessions, folders, servers' : 'Search sessions and folders'}
							aria-label="Search sessions"
							spellCheck={false}
							autoComplete="off"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === 'Enter' && shown[0] && pending === null) pick(shown[0])
							}}
						/>
					</label>

					<div className="sp-list">
						{answered === 0 && !failing.length ? (
							<SkeletonRows />
						) : (
							<>
								{shown.map((s) => {
									const k = sessionKey(s)
									return (
										<button
											key={k}
											className={`sp-row${s.here ? ' is-here' : ''}`}
											disabled={pending !== null}
											title={s.here ? (s.hidden ? 'Hidden on this canvas: show its frame and prompt it' : 'Go to its frame and prompt it') : 'Add its frame to this canvas and prompt it'}
											onClick={() => pick(s)}
										>
											<span className="sp-row-main">
												<span className={`sp-row-title${s.title ? '' : ' is-untitled'}`}>{s.title || 'Untitled session'}</span>
												<span className="sp-row-meta">
													{s.busy && (
														<span className="sp-busy">
															<span className="sp-spin" aria-hidden="true" />
															Working
														</span>
													)}
													<span className="sp-meta-part sp-dir" title={s.directory}>
														{shortDir(s.directory)}
													</span>
													{!s.busy && <span className="sp-meta-part">{relativeTime(s.updatedAt)}</span>}
													{multi && <span className="sp-meta-part sp-server">{s.serverName}</span>}
												</span>
											</span>
											{pending === k ? (
												<span className="sp-spin" aria-label="Adding" />
											) : s.here ? (
												<span className="sp-chip">{s.hidden ? 'Hidden' : 'On canvas'}</span>
											) : null}
										</button>
									)
								})}
								{answered > 0 && !shown.length && !loading.length && (
									<div className="sp-empty">
										{q ? (
											<>No sessions match “{query.trim()}”</>
										) : (
											<>
												<strong>No sessions yet</strong>
												<span>Sessions you start in OpenCode show up here.</span>
											</>
										)}
									</div>
								)}
								{answered > 0 &&
									loading.map((p) => (
										<div key={p.key} className="sp-status">
											<span className="sp-spin" aria-hidden="true" />
											Loading {p.name}…
										</div>
									))}
							</>
						)}
						{failing.map((p) => (
							<div key={p.key} className="sp-status is-error">
								<span className="sp-status-text">{errors[p.key]}</span>
								<button className="sp-text-button" onClick={() => retry(p.key)}>
									Retry
								</button>
							</div>
						))}
					</div>
				</>
			)}

			{error && (
				<div className="sp-error" role="alert">
					{error}
				</div>
			)}

			{(hiddenFrames.length > 0 || servers.length > 0) && (
				<div className="sp-foot">
					{hiddenFrames.length > 0 && (
						<div className="sp-section">
							<button className="sp-toggle" aria-expanded={showHidden} onClick={() => setShowHidden(!showHidden)}>
								<Caret open={showHidden} />
								Hidden frames
								<span className="sp-toggle-count">{hiddenFrames.length}</span>
							</button>
							{showHidden && (
								<div className="sp-hidden-list">
									{hiddenFrames.map((f) => (
										<div key={f.id} className={`sp-hidden${focus === f.id ? ' is-focus' : ''}`} ref={focus === f.id ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}>
											<span className={`sp-hidden-title${f.untitled ? ' is-untitled' : ''}`} title={f.untitled ? f.id : f.title}>
												{f.title}
											</span>
											<span className="sp-hidden-meta" title={f.fresh ? 'Items were posted to it since it was hidden' : undefined}>
												{plural(f.items, 'item')}
												{f.fresh && ' · new'}
											</span>
											<button className="sp-text-button" autoFocus={focus === f.id} title="Show this frame again, for everyone" onClick={() => showFrame(f.id)}>
												Show
											</button>
										</div>
									))}
								</div>
							)}
						</div>
					)}
					{servers.length > 0 && (
						<div className="sp-section">
							<button className="sp-toggle" aria-expanded={managing} onClick={() => setManaging(!managing)}>
								<Caret open={managing} />
								{servers.length === 1 ? 'Server' : 'Servers'}
								<span className="sp-toggle-count">{servers.length}</span>
								{failing.length > 0 && <span className="sp-toggle-warn">{failing.length} not reachable</span>}
							</button>
							{managing && (
								<div className="sp-servers">
									<ServerList servers={servers} errors={errors} />
								</div>
							)}
						</div>
					)}
				</div>
			)}
		</div>
	)
}

function SkeletonRows() {
	return (
		<div className="sp-skeleton" aria-label="Loading sessions">
			{[72, 54, 64].map((w, i) => (
				<div key={i} className="sp-skeleton-row">
					<span style={{ width: `${w}%` }} />
					<span style={{ width: `${w - 22}%` }} />
				</div>
			))}
		</div>
	)
}

function Caret({ open }: { open: boolean }) {
	return (
		<svg className={`sp-caret${open ? ' is-open' : ''}`} viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
			<path d="M3.5 2l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
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

function SearchIcon() {
	return (
		<svg className="sp-search-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
			<circle cx="11" cy="11" r="6.5" />
			<path d="m16 16 4 4" />
		</svg>
	)
}

function CloseIcon() {
	return (
		<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
			<path d="M6 6l12 12M18 6 6 18" />
		</svg>
	)
}

function plural(n: number, word: string) {
	return `${n} ${word}${n === 1 ? '' : 's'}`
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
