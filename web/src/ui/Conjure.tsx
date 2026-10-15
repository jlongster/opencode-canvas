import { useEffect, useMemo, useRef, useState } from 'react'
import type { OpenCodeSessionSummary, OpenCodeStatus } from '../../../shared/types'
import type { Editor } from '../editor/Editor'
import type { Conjure } from '../multiplayer/Conjure'
import { conjure as conjureSession, listConjured, listOpenCodeSessions, openCodeStatus } from '../sync/client'
import { useValue } from './useValue'

/** The toolbar's Conjure button (edit links): pick an OpenCode session to bring onto the canvas as a worm. */
export function ConjureButton({
	editor,
	conjure,
	canvasId,
	open,
	setOpen,
}: {
	editor: Editor
	conjure: Conjure
	canvasId: string
	open: boolean
	setOpen: (open: boolean) => void
}) {
	return (
		<>
			<button className="conjure-button" title="Conjure an OpenCode session onto the canvas" aria-pressed={open} onClick={() => setOpen(!open)}>
				<WandIcon />
				<span className="wide-only">Conjure</span>
			</button>
			{open && <ConjurePopover editor={editor} conjure={conjure} canvasId={canvasId} onClose={() => setOpen(false)} />}
		</>
	)
}

function ConjurePopover({ editor, conjure, canvasId, onClose }: { editor: Editor; conjure: Conjure; canvasId: string; onClose: () => void }) {
	const [status, setStatus] = useState<OpenCodeStatus | null>(null)
	const [sessions, setSessions] = useState<OpenCodeSessionSummary[] | null>(null)
	const [saved, setSaved] = useState<Set<string>>(new Set())
	const [error, setError] = useState<string | null>(null)
	const [pending, setPending] = useState<string | null>(null)
	const [query, setQuery] = useState('')
	const live = useValue(
		() => conjure.presence.peers.get().filter((p) => p.user.conjured && p.user.sessionId).map((p) => p.user.sessionId!).sort().join(' '),
		[conjure],
	)
	const here = useMemo(() => new Set([...saved, ...live.split(' ').filter(Boolean)]), [saved, live])

	const load = async () => {
		setError(null)
		const s = await openCodeStatus().catch((e: Error) => ({ connected: false, error: e.message }) as OpenCodeStatus)
		setStatus(s)
		if (!s.connected) return
		try {
			const [list, conjured] = await Promise.all([listOpenCodeSessions(), listConjured(canvasId)])
			setSessions(list)
			setSaved(new Set(conjured.map((c) => c.sessionId)))
		} catch (e) {
			setError((e as Error).message)
		}
	}
	useEffect(() => {
		load()
	}, [canvasId])

	const pick = async (s: OpenCodeSessionSummary) => {
		if (here.has(s.id)) {
			conjure.focus(s.id)
			return onClose()
		}
		const view = editor.viewportPageBounds.get()
		setPending(s.id)
		setError(null)
		try {
			await conjureSession(canvasId, s.id, { x: view.x + view.w / 2, y: view.y + view.h / 2 })
			onClose()
		} catch (e) {
			if ((e as { status?: number }).status === 409) {
				conjure.focus(s.id)
				return onClose()
			}
			setError((e as Error).message)
		} finally {
			setPending(null)
		}
	}

	const q = query.trim().toLowerCase()
	const shown = (sessions ?? []).filter((s) => !q || s.title.toLowerCase().includes(q) || s.directory.toLowerCase().includes(q))

	return (
		<div className="share-popover conjure-popover" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
			<div className="share-popover-head">
				<span className="conjure-heading">
					<WandIcon /> Conjure a session
				</span>
				<button title="Close" onClick={onClose}>
					×
				</button>
			</div>
			<p className="conjure-hint">Brings an OpenCode session onto the canvas as a worm. Click it to talk to it.</p>
			{status === null ? (
				<div className="conjure-empty">Looking for OpenCode…</div>
			) : !status.connected ? (
				<div className="conjure-error">
					<strong>OpenCode isn't reachable.</strong>
					{status.error && <span>{status.error}</span>}
					<button onClick={load}>Try again</button>
				</div>
			) : (
				<>
					<input className="conjure-search" autoFocus placeholder="Filter sessions" value={query} onChange={(e) => setQuery(e.target.value)} />
					<div className="conjure-list">
						{sessions === null && !error && <div className="conjure-empty">Loading sessions…</div>}
						{sessions !== null && shown.length === 0 && <div className="conjure-empty">No sessions{q ? ' match' : ''}</div>}
						{shown.map((s) => {
							const isHere = here.has(s.id)
							return (
								<button
									key={s.id}
									className={`conjure-row${isHere ? ' here' : ''}`}
									disabled={pending !== null}
									title={isHere ? 'Already on this canvas: show it' : `Conjure ${s.title || s.id}`}
									onClick={() => pick(s)}
								>
									<span className={`conjure-dot${s.busy ? ' busy' : ''}`} title={s.busy ? 'Working' : 'Idle'} />
									<span className="conjure-row-main">
										<span className="conjure-row-title">{s.title || 'Untitled session'}</span>
										<span className="conjure-row-meta">
											{shortDir(s.directory)} · {relativeTime(s.updatedAt)}
											{s.parentId ? ' · subagent' : ''}
										</span>
									</span>
									{pending === s.id ? <span className="conjure-tag">…</span> : isHere && <span className="conjure-tag">on canvas</span>}
								</button>
							)
						})}
					</div>
				</>
			)}
			{error && <div className="conjure-error">{error}</div>}
		</div>
	)
}

/** The box under a clicked conjured worm: type a prompt for its OpenCode session. */
export function ConjurePrompt({ editor, conjure }: { editor: Editor; conjure: Conjure }) {
	const target = useValue(() => conjure.prompting.get(), [conjure])
	const info = useValue(() => {
		const t = conjure.prompting.get()
		if (!t) return null
		editor.camera.get()
		editor.viewport.get()
		const peer = conjure.presence.peers.get().find((p) => p.clientId === t.clientId)
		if (!peer?.cursor) return 'gone'
		const p = editor.pageToScreen(peer.cursor)
		return `${Math.round(p.x)}|${Math.round(p.y)}|${peer.thinking ? 1 : 0}|${peer.user.color}|${peer.user.name}`
	}, [editor, conjure])
	const [text, setText] = useState('')
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	const inputRef = useRef<HTMLTextAreaElement>(null)

	useEffect(() => {
		setText('')
		setError(null)
		if (target) inputRef.current?.focus()
	}, [target?.clientId])
	// The worm was banished (or left): nothing to talk to.
	useEffect(() => {
		if (info === 'gone') conjure.close()
	}, [info])

	if (!target || !info || info === 'gone') return null
	const [x, y, thinking, color, ...name] = info.split('|')

	const send = async () => {
		const prompt = text.trim()
		if (!prompt || busy) return
		setBusy(true)
		setError(null)
		try {
			await conjure.send(target, prompt)
			conjure.close()
		} catch (e) {
			setError((e as Error).message)
		} finally {
			setBusy(false)
		}
	}

	const banish = async () => {
		setBusy(true)
		try {
			await conjure.banish(target.sessionId)
		} catch (e) {
			setError((e as Error).message)
		} finally {
			setBusy(false)
		}
	}

	return (
		<div
			className="conjure-prompt"
			style={{ transform: `translate(${Number(x) - 24}px, ${Number(y) + 44}px)`, ['--agent-color' as string]: color }}
			onPointerDown={(e) => e.stopPropagation()}
			onWheel={(e) => e.stopPropagation()}
		>
			<div className="conjure-prompt-head">
				<span>Ask {name.join('|')}</span>
				<button title="Close (Esc)" onClick={() => conjure.close()}>
					×
				</button>
			</div>
			<textarea
				ref={inputRef}
				value={text}
				rows={3}
				placeholder={thinking === '1' ? 'Still thinking about the last one…' : 'Say something… (Enter sends, Shift+Enter for a new line)'}
				onChange={(e) => setText(e.target.value)}
				onKeyDown={(e) => {
					e.stopPropagation()
					if (e.key === 'Escape') conjure.close()
					if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
						e.preventDefault()
						send()
					}
				}}
			/>
			{error && <div className="conjure-prompt-error">{error}</div>}
			<div className="conjure-prompt-actions">
				<button className="conjure-banish" title="Send this worm away (the session itself stays)" disabled={busy} onClick={banish}>
					Banish
				</button>
				<button className="conjure-send" disabled={busy || !text.trim()} onClick={send}>
					{busy ? 'Sending…' : 'Send'}
				</button>
			</div>
		</div>
	)
}

function WandIcon() {
	return (
		<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<path d="M4 20 15 9" />
			<path d="m13.5 7.5 3 3" />
			<path d="M18 2.5v3M16.5 4h3M20.5 9v2M19.5 10h2M9 3v2M8 4h2" />
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
