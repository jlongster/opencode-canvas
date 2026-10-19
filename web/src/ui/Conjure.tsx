import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import type { OpenCodeSessionSummary } from '../../../shared/types'
import type { Editor } from '../editor/Editor'
import type { Vec } from '../editor/geometry'
import type { Conjure, PromptAttachment } from '../multiplayer/Conjure'
import { PairForm, ServerList, SessionGroups, sessionKey, useOpenCode } from './OpenCodeServers'
import { useValue } from './useValue'

/** The toolbar's Conjure button (edit links): pick an OpenCode session to bring onto the canvas as an eye pointer. */
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
			{open && <ConjurePanel conjure={conjure} at={() => conjure.menuSpot()} onClose={() => setOpen(false)} />}
		</>
	)
}

/** a picker opened by C sits this far from the pointer, and this far inside the window */
const PICKER_GAP = 14
const PICKER_MARGIN = 8

/**
 * The Conjure panel C opens next to the pointer when it isn't over a session (Conjure.picking):
 * the session picked comes to where the pointer was. Esc, a click outside or C again closes it.
 */
export function ConjurePicker({ editor, conjure, canvasId }: { editor: Editor; conjure: Conjure; canvasId: string }) {
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
			<ConjurePanel conjure={conjure} at={() => picking.page} onClose={close} />
		</div>
	)
}

/**
 * Picking an OpenCode session to conjure (the toolbar's button, or C's picker): its worm comes to
 * `at()` (a page point: where C was pressed, or where the pointer last was on the canvas), new or
 * already here, with its prompt box open (see Conjure.summon).
 */
function ConjurePanel({ conjure, at, onClose }: { conjure: Conjure; at: () => Vec; onClose: () => void }) {
	const { servers, byServer, errors, reload, retry } = useOpenCode()
	const [error, setError] = useState<string | null>(null)
	const [pending, setPending] = useState<string | null>(null)
	const [query, setQuery] = useState('')
	const [managing, setManaging] = useState(false)
	const hereKey = useValue(
		() =>
			[
				// (ones nobody owns can be conjured: that adopts them)
				...conjure.records.get().filter((r) => r.ownerId).map((r) => r.sessionId),
				...conjure.presence.peers.get().filter((p) => p.user.conjured && p.user.sessionId).map((p) => p.user.sessionId!),
			]
				.sort()
				.join(' '),
		[conjure],
	)
	const here = useMemo(() => new Set(hereKey.split(' ').filter(Boolean)), [hereKey])

	const pick = async (s: OpenCodeSessionSummary) => {
		setPending(sessionKey(s))
		setError(null)
		try {
			const message = await conjure.summon(s.id, at(), { serverKey: s.serverKey, title: s.title })
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
					<p className="conjure-hint">Brings an OpenCode session onto the canvas as an eye pointer. Click it to talk to it; it sleeps while this browser isn't on the canvas.</p>
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
										title={isHere ? 'Already on this canvas: bring it here' : `Conjure ${s.title || s.id}`}
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

/**
 * The box under a clicked conjured worm: its owner types a prompt for its OpenCode session; anyone
 * else learns whose it is (and whether it's asleep).
 */
export function ConjurePrompt({ editor, conjure }: { editor: Editor; conjure: Conjure }) {
	const target = useValue(() => conjure.prompting.get(), [conjure])
	const info = useValue(() => {
		const t = conjure.prompting.get()
		if (!t) return null
		editor.camera.get()
		editor.viewport.get()
		const peer =
			conjure.presence.peers.get().find((p) => p.clientId === t.clientId) ?? conjure.sleepers.get().find((p) => p.clientId === t.clientId)
		if (!peer?.cursor) return 'gone'
		const p = editor.pageToScreen(peer.cursor)
		const block = conjure.talkBlock(t.sessionId) ?? ''
		return `${Math.round(p.x)}|${Math.round(p.y)}|${peer.thinking ? 1 : 0}|${peer.user.asleep ? 1 : 0}|${block}|${peer.user.color}|${peer.user.name}`
	}, [editor, conjure])
	// A reply to reopen: one it's saying in the room, or (our own worm) its session's last one.
	const canReplay = useValue(() => {
		const t = conjure.prompting.get()
		return !!t && (!!conjure.saying(t.sessionId) || conjure.talkBlock(t.sessionId) === null)
	}, [conjure])
	const stopping = useValue(() => {
		const t = conjure.prompting.get()
		return !!t && !!conjure.stopping.get()[t.sessionId]
	}, [conjure])
	const [text, setText] = useState('')
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	const [replaying, setReplaying] = useState(false)
	const [attachments, setAttachments] = useState<PromptAttachment[]>([])
	const [dragging, setDragging] = useState(false)
	const inputRef = useRef<HTMLTextAreaElement>(null)
	const fileRef = useRef<HTMLInputElement>(null)
	const dragDepth = useRef(0)
	const [steered, setSteered] = useState(false)
	const steerTimer = useRef<number>(undefined)

	useEffect(() => () => window.clearTimeout(steerTimer.current), [])
	useEffect(() => {
		setText('')
		setError(null)
		setAttachments([])
		setSteered(false)
		window.clearTimeout(steerTimer.current)
	}, [target?.sessionId])
	// Focused as soon as there's somewhere to type (a worm just conjured shows up a moment later).
	const canType = !!target && !!info && info !== 'gone' && !info.split('|')[4]
	useEffect(() => {
		if (canType) inputRef.current?.focus()
	}, [target?.sessionId, canType])
	// The worm was banished: nothing to talk to. (Waking up or falling asleep changes its client id.)
	useEffect(() => {
		if (info !== 'gone' || !target) return
		const worm = conjure.worms().find((p) => p.user.sessionId === target.sessionId)
		if (worm) conjure.prompting.set({ clientId: worm.clientId, sessionId: target.sessionId })
		else conjure.close()
	}, [info])

	if (!target || !info || info === 'gone') return null
	const [x, y, thinking, asleep, block, color, ...name] = info.split('|')

	const canAttach = !block
	const working = thinking === '1'

	const attach = async (files: File[]) => {
		if (!files.length) return
		setError(null)
		const problems: string[] = []
		const images = files.filter((f) => {
			if (!ATTACH_TYPES.includes(f.type)) problems.push(`${f.name || 'that file'} isn't a PNG, JPEG, GIF or WebP image`)
			else if (f.size > ATTACH_MAX_BYTES) problems.push(`${f.name} is over ${ATTACH_MAX_BYTES / 1024 / 1024} MB`)
			else return true
			return false
		})
		const room = ATTACH_MAX - attachments.length
		if (images.length > room) problems.push(`at most ${ATTACH_MAX} images per prompt`)
		try {
			const added = await Promise.all(images.slice(0, Math.max(0, room)).map(readAttachment))
			setAttachments((prev) => [...prev, ...added].slice(0, ATTACH_MAX))
		} catch (e) {
			problems.push((e as Error).message)
		}
		if (problems.length) setError(problems.join('; '))
		inputRef.current?.focus()
	}

	const isFileDrag = (e: DragEvent) => e.dataTransfer.types.includes('Files')
	const dropHandlers = {
		onDragEnter: (e: DragEvent) => {
			if (!isFileDrag(e)) return
			e.preventDefault()
			e.stopPropagation()
			dragDepth.current++
			if (canAttach) setDragging(true)
		},
		onDragOver: (e: DragEvent) => {
			if (!isFileDrag(e)) return
			e.preventDefault()
			e.stopPropagation()
			e.dataTransfer.dropEffect = canAttach ? 'copy' : 'none'
		},
		onDragLeave: (e: DragEvent) => {
			if (!isFileDrag(e)) return
			e.stopPropagation()
			dragDepth.current = Math.max(0, dragDepth.current - 1)
			if (!dragDepth.current) setDragging(false)
		},
		onDrop: (e: DragEvent) => {
			if (!isFileDrag(e)) return
			// Swallowed even when we can't attach, so the browser doesn't navigate to the file.
			e.preventDefault()
			e.stopPropagation()
			dragDepth.current = 0
			setDragging(false)
			if (canAttach) attach([...e.dataTransfer.files])
		},
	}

	const send = async () => {
		const prompt = text.trim()
		if ((!prompt && !attachments.length) || busy) return
		setBusy(true)
		setError(null)
		setSteered(false)
		try {
			const { steered } = await conjure.send(target, prompt, attachments)
			setAttachments([])
			if (steered) {
				// Stays open a moment to confirm, then closes unless they keep typing.
				setText('')
				setSteered(true)
				window.clearTimeout(steerTimer.current)
				steerTimer.current = window.setTimeout(() => {
					if (!inputRef.current?.value) conjure.close()
					setSteered(false)
				}, STEER_CONFIRM_MS)
			} else conjure.close()
		} catch (e) {
			setError((e as Error).message)
		} finally {
			setBusy(false)
		}
	}

	const stop = async () => {
		setError(null)
		try {
			await conjure.interrupt(target.sessionId)
		} catch (e) {
			setError(`Couldn't stop it: ${(e as Error).message}`)
		}
	}

	const showLastReply = async () => {
		setReplaying(true)
		setError(null)
		try {
			const reply = await conjure.lastReply(target.sessionId)
			if (reply) conjure.showReply(target.sessionId, reply)
			else setError('No reply yet')
		} catch (e) {
			setError((e as Error).message)
		} finally {
			setReplaying(false)
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
			className={`conjure-prompt${dragging ? ' dragging' : ''}`}
			{...dropHandlers}
			style={{ left: Number(x) - 24, top: Number(y) + 44, ['--agent-color' as string]: color }}
			onPointerDown={(e) => e.stopPropagation()}
			onWheel={(e) => e.stopPropagation()}
		>
			<div className="conjure-prompt-head">
				<span>
					{block ? '' : 'Ask '}
					{name.join('|')}
					{asleep === '1' ? ' (asleep)' : ''}
				</span>
				<button className="conjure-banish" title="Send this agent away for everyone (the session itself stays)" disabled={busy} onClick={banish}>
					Banish
				</button>
				<button title="Close (Esc)" onClick={() => conjure.close()}>
					×
				</button>
			</div>
			{block ? (
				<div className="conjure-note" onKeyDown={(e) => e.key === 'Escape' && conjure.close()}>
					{block === 'unowned' ? (
						<>
							<strong>Nobody has conjured it</strong>
							<span>
								Its session called it up to show you something, through the canvas tools. To talk to it, conjure the session from your
								OpenCode (Conjure, or C over its frame).
							</span>
						</>
					) : block === 'not-yours' ? (
						<>
							<strong>{asleep === '1' ? 'Asleep · owned by someone else' : 'Owned by someone else'}</strong>
							<span>
								Only the browser that conjured it can talk to it.
								{asleep === '1' ? ' It wakes up when its owner opens this canvas.' : ' You can watch it think and reply.'}
							</span>
						</>
					) : (
						<>
							<strong>Its OpenCode isn't paired here</strong>
							<span>You conjured it, but this browser no longer has its OpenCode. Pair it again (Conjure → Servers) to wake it.</span>
						</>
					)}
				</div>
			) : (
				<>
					<textarea
						ref={inputRef}
						value={text}
						rows={3}
						placeholder={
							working
								? 'It’s working: anything you send steers it, added to the work in progress…'
								: 'Say something… (Enter sends, Shift+Enter for a new line)'
						}
						onChange={(e) => setText(e.target.value)}
						onPaste={(e) => {
							const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'))
							if (!files.length) return
							if (!e.clipboardData.getData('text/plain')) e.preventDefault()
							attach(files)
						}}
						onKeyDown={(e) => {
							e.stopPropagation()
							if (e.key === 'Escape') conjure.close()
							if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
								e.preventDefault()
								send()
							}
						}}
					/>
					{attachments.length > 0 && (
						<div className="conjure-attachments">
							{attachments.map((a) => (
								<div key={a.id} className="conjure-attachment" title={a.name}>
									<img src={a.dataUrl} alt={a.name} />
									<button
										className="conjure-attachment-remove"
										title={`Remove ${a.name}`}
										disabled={busy}
										onClick={() => setAttachments((prev) => prev.filter((p) => p.id !== a.id))}
									>
										×
									</button>
								</div>
							))}
						</div>
					)}
					<input
						ref={fileRef}
						type="file"
						accept={ATTACH_TYPES.join(',')}
						multiple
						hidden
						onChange={(e) => {
							attach([...(e.target.files ?? [])])
							e.target.value = ''
						}}
					/>
					{dragging && <div className="conjure-drop-hint">Drop images to attach</div>}
				</>
			)}
			{error && <div className="conjure-prompt-error">{error}</div>}
			{steered && !error && <div className="conjure-prompt-ok">Steered: added to the work in progress</div>}
			<div className="conjure-prompt-actions">
				<button
					className={`conjure-replay${block ? '' : ' conjure-icon'}`}
					title={canReplay ? 'Show its most recent reply again' : 'Nothing to show: only its owner can fetch earlier replies'}
					aria-label="Show last reply"
					disabled={!canReplay || replaying}
					onClick={showLastReply}
				>
					{block ? (replaying ? 'Loading…' : 'Show last reply') : replaying ? <Spinner /> : <ReplayIcon />}
				</button>
				{!block && (
					<button
						className="conjure-attach conjure-icon"
						title={`Attach images (or drop or paste them here; up to ${ATTACH_MAX})`}
						aria-label="Attach images"
						disabled={busy || attachments.length >= ATTACH_MAX}
						onClick={() => fileRef.current?.click()}
					>
						<PaperclipIcon />
					</button>
				)}
				{!block && working && (
					<button className="conjure-stop" title={stopping ? 'Stopping…' : 'Interrupt the session'} disabled={stopping} onClick={stop}>
						{stopping ? <Spinner /> : <StopIcon />} Stop
					</button>
				)}
				{!block && (
					<button
						className="conjure-send"
						title={
							busy
								? working
									? 'Steering…'
									: 'Sending…'
								: working
									? 'It’s working: this is added to the work in progress (steering it) instead of waiting for it to finish'
									: 'Send (Enter)'
						}
						disabled={busy || (!text.trim() && !attachments.length)}
						onClick={send}
					>
						{busy ? <Spinner /> : working ? 'Steer' : 'Send'}
					</button>
				)}
			</div>
		</div>
	)
}

const ATTACH_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const ATTACH_MAX = 8
const ATTACH_MAX_BYTES = 20 * 1024 * 1024
const STEER_CONFIRM_MS = 1800
let attachmentIds = 0

function readAttachment(file: File): Promise<PromptAttachment> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader()
		reader.onload = () =>
			resolve({ id: String(++attachmentIds), name: file.name || `image.${file.type.split('/')[1]}`, mime: file.type, dataUrl: reader.result as string })
		reader.onerror = () => reject(new Error(`couldn't read ${file.name || 'that image'}`))
		reader.readAsDataURL(file)
	})
}

function Spinner() {
	return <span className="conjure-spinner" aria-hidden="true" />
}

function ReplayIcon() {
	return (
		<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
			<path d="M3 3v5h5" />
			<path d="M12 7v5l3 2" />
		</svg>
	)
}

function StopIcon() {
	return (
		<svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true">
			<rect x="1" y="1" width="8" height="8" rx="1.5" fill="currentColor" />
		</svg>
	)
}

function PaperclipIcon() {
	return (
		<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<path d="m21 11.5-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9" />
		</svg>
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
