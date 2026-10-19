import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { OpenCodeSessionSummary } from '../../../shared/types'
import type { Editor } from '../editor/Editor'
import type { Vec } from '../editor/geometry'
import type { Conjure } from '../multiplayer/Conjure'
import { PairForm, ServerList, SessionGroups, sessionKey, useOpenCode } from './OpenCodeServers'
import { useValue } from './useValue'

/** The toolbar's Conjure button (edit links): pick an OpenCode session to bring onto the canvas as a live frame. */
export function ConjureButton({
	editor,
	conjure,
	open,
	setOpen,
}: {
	editor: Editor
	conjure: Conjure
	open: boolean
	setOpen: (open: boolean) => void
}) {
	return (
		<>
			<button className="conjure-button" title="Conjure an OpenCode session onto the canvas" aria-pressed={open} onClick={() => setOpen(!open)}>
				<WandIcon />
				<span className="wide-only">Conjure</span>
			</button>
			{open && <ConjurePanel editor={editor} conjure={conjure} onClose={() => setOpen(false)} />}
		</>
	)
}

/** a picker opened by C sits this far from the pointer, and this far inside the window */
const PICKER_GAP = 14
const PICKER_MARGIN = 8

/**
 * The Conjure panel C opens next to the pointer when it isn't over a frame (Conjure.picking). Esc,
 * a click outside or C again closes it.
 */
export function ConjurePicker({ editor, conjure }: { editor: Editor; conjure: Conjure }) {
	const picking = useValue(() => conjure.picking.get(), [conjure])
	const ref = useRef<HTMLDivElement>(null)
	const [pos, setPos] = useState<Vec | null>(null)
	const close = () => conjure.picking.set(null)

	useLayoutEffect(() => {
		const el = ref.current
		if (!picking || !el) return
		// Right of the pointer and from its height down, flipped to the left and upwards near the edges;
		// again whenever its size changes (sessions arriving).
		const place = () => {
			const { width: w, height: h } = el.getBoundingClientRect()
			const { x, y } = picking.screen
			const vw = window.innerWidth
			const vh = window.innerHeight
			let left = x + PICKER_GAP
			if (left + w > vw - PICKER_MARGIN) left = x - PICKER_GAP - w
			let top = y - PICKER_GAP
			if (top + h > vh - PICKER_MARGIN) top = y + PICKER_GAP - h
			const next = {
				x: Math.round(Math.max(PICKER_MARGIN, Math.min(left, vw - w - PICKER_MARGIN))),
				y: Math.round(Math.max(PICKER_MARGIN, Math.min(top, vh - h - PICKER_MARGIN))),
			}
			setPos((prev) => (prev && prev.x === next.x && prev.y === next.y ? prev : next))
		}
		place()
		const observer = new ResizeObserver(place)
		observer.observe(el)
		return () => observer.disconnect()
	}, [picking])
	useEffect(() => {
		if (!picking) return
		const outside = (e: PointerEvent) => {
			if (!ref.current?.contains(e.target as Node)) close()
		}
		const escape = (e: KeyboardEvent) => e.key === 'Escape' && close()
		window.addEventListener('pointerdown', outside, true)
		window.addEventListener('keydown', escape)
		return () => {
			window.removeEventListener('pointerdown', outside, true)
			window.removeEventListener('keydown', escape)
		}
	}, [picking])

	if (!picking) return null
	return (
		<div
			ref={ref}
			key={`${picking.page.x},${picking.page.y}`}
			className="toolbar conjure-picker"
			// (placed properly before it paints; not hidden meanwhile, so its filter can take focus)
			style={pos ? { left: pos.x, top: pos.y } : { left: picking.screen.x + PICKER_GAP, top: picking.screen.y - PICKER_GAP }}
			onPointerDown={(e) => e.stopPropagation()}
			onWheel={(e) => e.stopPropagation()}
		>
			<ConjurePanel editor={editor} conjure={conjure} onClose={close} />
		</div>
	)
}

/**
 * Picking an OpenCode session to conjure: its frame comes alive (made if it has none), and the
 * camera goes to it with its C dialog open. One already conjured here is just shown.
 */
function ConjurePanel({ editor, conjure, onClose }: { editor: Editor; conjure: Conjure; onClose: () => void }) {
	const { servers, byServer, errors, reload, retry } = useOpenCode()
	const [error, setError] = useState<string | null>(null)
	const [pending, setPending] = useState<string | null>(null)
	const [query, setQuery] = useState('')
	const [managing, setManaging] = useState(false)
	const hereKey = useValue(
		() =>
			conjure.records
				.get()
				.map((r) => r.sessionId)
				.sort()
				.join(' '),
		[conjure],
	)
	const here = useMemo(() => new Set(hereKey.split(' ').filter(Boolean)), [hereKey])

	/** Goes to the session's frame (once it's in the layout) and opens its dialog. */
	const show = (sessionId: string) => {
		onClose()
		let tries = 0
		const go = () => {
			if (editor.layout.get().sections.some((s) => s.id === sessionId)) {
				conjure.focus(sessionId)
				conjure.openDialog(sessionId)
			} else if (++tries < 40) setTimeout(go, 50)
		}
		go()
	}

	const pick = async (s: OpenCodeSessionSummary) => {
		if (here.has(s.id)) return show(s.id)
		setPending(sessionKey(s))
		setError(null)
		try {
			const message = await conjure.connect(s.id, { serverKey: s.serverKey, title: s.title })
			if (message) setError(message)
			else show(s.id)
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
		<div className="share-popover conjure-popover" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
			<div className="share-popover-head">
				<span className="conjure-heading">
					<WandIcon /> Conjure a session
				</span>
				<button title="Close" onClick={onClose}>
					×
				</button>
			</div>
			{servers.length === 0 ? (
				<PairForm autoFocus onPaired={() => reload()} />
			) : (
				<>
					<p className="conjure-hint">
						Brings an OpenCode session onto the canvas: its frame shows what it’s doing, live. Press C over it (or click its status rail) to
						talk to it; it’s asleep while this browser isn’t on the canvas.
					</p>
					<input className="conjure-search" autoFocus placeholder="Filter sessions" value={query} onChange={(e) => setQuery(e.target.value)} />
					<div className="conjure-list">
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
											</span>
										</span>
										{pending === k ? <span className="conjure-tag">…</span> : isHere && <span className="conjure-tag">on canvas</span>}
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
			{error && <div className="conjure-error">{error}</div>}
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
