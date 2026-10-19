import { useEffect, useLayoutEffect, useRef, useState, type DragEvent } from 'react'
import type { Editor } from '../editor/Editor'
import type { Attention } from '../multiplayer/Attention'
import { findSession, type Conjure, type LiveStatus, type PromptAttachment } from '../multiplayer/Conjure'
import { sectionTitle, type Rails } from '../multiplayer/Rails'
import { shortDir } from './Conjure'
import { markdownToHtml } from './markdown'
import { ago, escapeHtml, formatElapsed, glyph, RAIL_KIND, railHtml, tickElapsed } from './rail'
import { useValue } from './useValue'

const DIALOG_W = 440
/** keep the dialog this far inside the screen */
const EDGE = 12
/** subagent lists longer than this start collapsed */
const SUBAGENTS_OPEN_MAX = 4
const CONFIRM_MS = 3000
const SENT_MS = 2200

/** Prompts being written, by session id, so closing and reopening the dialog keeps them. */
const drafts = new Map<string, string>()

/**
 * The C dialog: what C over a frame (or clicking its rail) opens, growing out of the frame's status
 * rail, which becomes its top bar. It shows the session closer up: title, model, agent and
 * directory, its subagents, its last reply (live while it streams in), and for its owner a prompt
 * box: Send when it's idle; Stop, Queue and Steer while it works. Then Open reply, Mute and Banish.
 * Over a frame whose session isn't conjured, it offers to connect it from a paired OpenCode that
 * has it. Everyone else sees the status read-only.
 */
export function SessionDialog({ editor, conjure, attention, rails }: { editor: Editor; conjure: Conjure; attention: Attention; rails: Rails }) {
	const sessionId = useValue(() => conjure.dialog.get(), [conjure])
	if (!sessionId) return null
	return <Dialog key={sessionId} sessionId={sessionId} editor={editor} conjure={conjure} attention={attention} rails={rails} />
}

function Dialog({ sessionId, editor, conjure, attention, rails }: { sessionId: string; editor: Editor; conjure: Conjure; attention: Attention; rails: Rails }) {
	const statusJson = useValue(() => JSON.stringify(conjure.status(sessionId) ?? null), [conjure, sessionId])
	const s = JSON.parse(statusJson) as LiveStatus | null
	const block = useValue(() => conjure.talkBlock(sessionId), [conjure, sessionId])
	const stopping = useValue(() => !!conjure.stopping.get()[sessionId], [conjure, sessionId])
	const frameTitle = useValue(() => {
		const section = editor.layout.get().sections.find((x) => x.id === sessionId)
		return section ? sectionTitle(section) : null
	}, [editor, sessionId])
	// Where it hangs: from the rail (pinned or not), else from the frame's top.
	const anchor = useValue(() => {
		const box = rails.box(sessionId)
		if (box) return `${Math.round(box.x)}|${Math.round(box.y)}|${Math.round(box.w)}|${box.h}`
		const section = editor.layout.get().sections.find((x) => x.id === sessionId)
		if (!section) return ''
		const p = editor.pageToScreen(section.box)
		return `${Math.round(p.x)}|${Math.round(Math.max(p.y, rails.inset))}|${Math.round(section.box.w * editor.camera.get().z)}|0`
	}, [editor, rails, sessionId])
	const lastAnchor = useRef(anchor)
	if (anchor) lastAnchor.current = anchor
	const [ax, ay] = (lastAnchor.current || `${EDGE}|${rails.inset}|0|0`).split('|').map(Number)

	const rootRef = useRef<HTMLDivElement>(null)
	const inputRef = useRef<HTMLTextAreaElement>(null)
	const fileRef = useRef<HTMLInputElement>(null)
	const dragDepth = useRef(0)
	const [text, setTextState] = useState(() => drafts.get(sessionId) ?? '')
	const [attachments, setAttachments] = useState<PromptAttachment[]>([])
	const [dragging, setDragging] = useState(false)
	const [sending, setSending] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [sent, setSent] = useState<string | null>(null)
	const [fullReply, setFullReply] = useState<string | null>(null)
	const [expanded, setExpanded] = useState(false)
	const [loadingReply, setLoadingReply] = useState(false)
	const [subsOpen, setSubsOpen] = useState<boolean | null>(null)
	const [confirmBanish, setConfirmBanish] = useState(false)
	const [found, setFound] = useState<{ serverKey: string; title: string } | null | 'checking'>(block === 'not-conjured' && conjure.canEdit ? 'checking' : null)
	const [connecting, setConnecting] = useState(false)
	const [height, setHeight] = useState(400)

	const setText = (t: string) => {
		setTextState(t)
		if (t) drafts.set(sessionId, t)
		else drafts.delete(sessionId)
	}

	useLayoutEffect(() => {
		const h = rootRef.current?.offsetHeight
		if (h && Math.abs(h - height) > 1) setHeight(h)
	})
	useEffect(() => {
		if (!block) inputRef.current?.focus({ preventScroll: true })
	}, [block])
	// The live clocks in it (the rail's and the subagents').
	useEffect(() => {
		const timer = window.setInterval(() => rootRef.current && tickElapsed(rootRef.current), 500)
		return () => window.clearInterval(timer)
	}, [])
	// A new turn's reply replaces one fetched in full.
	useEffect(() => {
		if (s?.replyLive) setFullReply(null)
	}, [s?.replyLive])
	useEffect(() => {
		if (!confirmBanish) return
		const timer = window.setTimeout(() => setConfirmBanish(false), CONFIRM_MS)
		return () => window.clearTimeout(timer)
	}, [confirmBanish])
	useEffect(() => {
		if (!sent) return
		const timer = window.setTimeout(() => setSent(null), SENT_MS)
		return () => window.clearTimeout(timer)
	}, [sent])
	// Not conjured: can a paired OpenCode here connect it?
	useEffect(() => {
		if (block !== 'not-conjured' || !conjure.canEdit) return
		let live = true
		setFound('checking')
		findSession(sessionId).then(
			(f) => live && setFound(f),
			() => live && setFound(null),
		)
		return () => {
			live = false
		}
	}, [block, sessionId])
	// Esc closes, ⌘. stops; a press outside (but not on a rail: that opens its own) closes.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape' && !e.defaultPrevented) return conjure.closeDialog()
			if (e.key === '.' && (e.metaKey || e.ctrlKey)) {
				e.preventDefault()
				stop()
			}
		}
		const onDown = (e: PointerEvent) => {
			const t = e.target as Element
			if (rootRef.current?.contains(t) || t.closest?.('.rail')) return
			conjure.closeDialog()
		}
		window.addEventListener('keydown', onKey)
		window.addEventListener('pointerdown', onDown, true)
		return () => {
			window.removeEventListener('keydown', onKey)
			window.removeEventListener('pointerdown', onDown, true)
		}
	})

	const busy = !!s?.busy
	const canTalk = !block && !!s?.conjured
	const title = frameTitle ?? (s?.title || `ses_…${sessionId.slice(-6)}`)
	const reply = fullReply ?? s?.reply ?? null

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
			if (canTalk) setDragging(true)
		},
		onDragOver: (e: DragEvent) => {
			if (!isFileDrag(e)) return
			e.preventDefault()
			e.stopPropagation()
			e.dataTransfer.dropEffect = canTalk ? 'copy' : 'none'
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
			if (canTalk) attach([...e.dataTransfer.files])
		},
	}

	const send = async (delivery: 'steer' | 'queue') => {
		const prompt = text.trim()
		if ((!prompt && !attachments.length) || sending || !canTalk) return
		setSending(true)
		setError(null)
		setSent(null)
		try {
			const { running } = await conjure.send(sessionId, prompt, attachments, delivery)
			setText('')
			setAttachments([])
			setSent(!running ? 'Sent' : delivery === 'queue' ? 'Queued: it runs when this turn ends' : 'Steered: added to the work in progress')
		} catch (e) {
			setError((e as Error).message)
		} finally {
			setSending(false)
			inputRef.current?.focus()
		}
	}

	const stop = async () => {
		if (!canTalk || !busy) return
		setError(null)
		try {
			await conjure.interrupt(sessionId)
		} catch (e) {
			setError(`Couldn't stop it: ${(e as Error).message}`)
		}
	}

	const showFull = async () => {
		setExpanded(true)
		if (s?.replyLive) return
		setLoadingReply(true)
		setError(null)
		try {
			const full = await conjure.lastReply(sessionId, true)
			if (full) setFullReply(full)
			else setError('No reply yet')
		} catch (e) {
			setError((e as Error).message)
		} finally {
			setLoadingReply(false)
		}
	}

	const openReply = async () => {
		const win = window.open('', '_blank')
		try {
			const full = fullReply ?? (await conjure.lastReply(sessionId, true))
			if (!win) return
			const doc = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)} · reply</title><style>${REPLY_DOC_CSS}</style></head><body><h1>${escapeHtml(title)}</h1>${markdownToHtml(full || '(no reply yet)')}</body></html>`
			win.location.href = URL.createObjectURL(new Blob([doc], { type: 'text/html' }))
		} catch (e) {
			win?.close()
			setError((e as Error).message)
		}
	}

	const banish = async () => {
		if (!confirmBanish) return setConfirmBanish(true)
		setConfirmBanish(false)
		try {
			await conjure.banish(sessionId)
		} catch (e) {
			setError((e as Error).message)
		}
	}

	const connect = async () => {
		setConnecting(true)
		setError(null)
		try {
			const message = await conjure.connect(sessionId, found === 'checking' ? undefined : found)
			if (message) setError(message)
		} catch (e) {
			setError((e as Error).message)
		} finally {
			setConnecting(false)
		}
	}

	// Placement: the rail is its top bar, so it starts where the rail is; kept on screen.
	const vw = window.innerWidth
	const vh = window.innerHeight
	const width = Math.min(DIALOG_W, vw - EDGE * 2)
	const left = Math.round(Math.min(Math.max(ax, EDGE), vw - width - EDGE))
	const top = Math.round(Math.max(EDGE, Math.min(ay, vh - EDGE - Math.min(height, vh - EDGE * 2))))
	const color = s?.color ?? '#a1a1aa'

	const subagents = s?.subagents ?? []
	const done = subagents.length - (s?.running ?? 0)
	const subsShown = subsOpen ?? subagents.length <= SUBAGENTS_OPEN_MAX
	const meta = [s?.model, s?.agent && `${s.agent} agent`, s?.directory && shortDir(s.directory)].filter(Boolean).join(' · ')

	return (
		<div
			ref={rootRef}
			className={`live-dialog${dragging ? ' dragging' : ''}`}
			role="dialog"
			aria-label={title}
			style={{ left, top, width, maxHeight: vh - top - EDGE, ['--c' as string]: color }}
			onPointerDown={(e) => e.stopPropagation()}
			onWheel={(e) => e.stopPropagation()}
			onDoubleClick={(e) => e.stopPropagation()}
			onKeyDown={(e) => {
				// Keys stay in here (the canvas's shortcuts don't fire), apart from closing and stopping.
				e.stopPropagation()
				const t = e.target as HTMLElement
				const typing = t.tagName === 'TEXTAREA' || t.tagName === 'INPUT'
				if (e.key === 'Escape') conjure.closeDialog()
				else if (e.key === '.' && (e.metaKey || e.ctrlKey)) {
					e.preventDefault()
					stop()
				} else if ((e.key === 'c' || e.key === 'C') && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) conjure.closeDialog()
			}}
			{...dropHandlers}
		>
			{s ? (
				<div
					className={`rail ld-rail rail-${RAIL_KIND[s.state]}`}
					onClick={(e) => (e.target as Element).closest('[data-calls]') && attention.open(sessionId, { fromRail: true })}
					dangerouslySetInnerHTML={{ __html: railHtml(s, { level: 'full', queuedText: s.firstQueued ? attention.preview(s.firstQueued) : undefined }) }}
				/>
			) : (
				<div className="rail ld-rail rail-none">
					<span className="rw">not connected</span>
				</div>
			)}
			<div className="ld-body">
				<div className="ld-head">
					<div className="ld-title">{title}</div>
					{meta && <div className="ld-meta">{meta}</div>}
				</div>

				{subagents.length > 0 && (
					<div className="ld-sec">
						<button className="ld-sh ld-toggle" aria-expanded={subsShown} onClick={() => setSubsOpen(!subsShown)}>
							<span>Subagents</span>
							<span className="ld-sv">
								{s!.running} running{done ? ` · ${done} done` : ''}
								<Chevron open={subsShown} />
							</span>
						</button>
						{subsShown && (
							<div className="ld-subs">
								{subagents.map((a) => (
									<div key={a.id} className={`ld-sub${a.done ? ' done' : ''}`} title={a.id}>
										<span dangerouslySetInnerHTML={{ __html: glyph(a.done ? 'done' : 'work') }} />
										<span className="ld-sub-n">{a.title || (a.agent ? `${a.agent} agent` : `ses_…${a.id.slice(-6)}`)}</span>
										{a.done ? (
											<span className="ld-sub-s">done</span>
										) : a.since ? (
											<span className="ld-sub-s" data-since={a.since}>
												{formatElapsed(Date.now() - a.since)}
											</span>
										) : (
											<span className="ld-sub-s">running</span>
										)}
									</div>
								))}
							</div>
						)}
					</div>
				)}

				{s?.conjured && (
					<div className="ld-sec">
						<div className="ld-sh">
							<span>
								{s.replyLive ? (
									<>
										Replying <span className="ld-live">● live</span>
									</>
								) : (
									<>
										Last reply{s.endedAt && reply ? <span className="ld-mut"> · {ago(s.endedAt)}</span> : null}
									</>
								)}
							</span>
							{reply && !expanded && (
								<button className="ld-link" onClick={showFull}>
									Show full
								</button>
							)}
							{!reply && s.ours && !s.busy && (
								<button className="ld-link" disabled={loadingReply} onClick={showFull}>
									{loadingReply ? 'Loading…' : 'Show last reply'}
								</button>
							)}
						</div>
						{reply ? (
							<div
								className={`ld-reply md-text${expanded ? ' full' : ''}${s.replyLive ? ' streaming' : ''}`}
								dangerouslySetInnerHTML={{ __html: markdownToHtml(reply) }}
							/>
						) : (
							<div className="ld-reply ld-mut">{s.busy ? 'Working on it…' : s.awake ? 'No reply yet.' : 'Nothing to show while it’s asleep.'}</div>
						)}
						{s.state === 'error' && s.error && s.error !== 'interrupted' && <div className="ld-error">⚠ {s.error}</div>}
					</div>
				)}

				{canTalk ? (
					<div className="ld-inp">
						<textarea
							ref={inputRef}
							value={text}
							rows={2}
							placeholder={busy ? 'Steer — lands after the current step…' : 'Prompt this session…'}
							onChange={(e) => setText(e.target.value)}
							onPaste={(e) => {
								const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'))
								if (!files.length) return
								if (!e.clipboardData.getData('text/plain')) e.preventDefault()
								attach(files)
							}}
							onKeyDown={(e) => {
								if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
									e.preventDefault()
									send(e.altKey && busy ? 'queue' : 'steer')
								}
							}}
						/>
						{attachments.length > 0 && (
							<div className="ld-attachments">
								{attachments.map((a) => (
									<div key={a.id} className="ld-attachment" title={a.name}>
										<img src={a.dataUrl} alt={a.name} />
										<button title={`Remove ${a.name}`} disabled={sending} onClick={() => setAttachments((prev) => prev.filter((p) => p.id !== a.id))}>
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
						<div className="ld-bar">
							<button
								className="ld-ib"
								title={`Attach images (or drop or paste them here; up to ${ATTACH_MAX})`}
								aria-label="Attach images"
								disabled={sending || attachments.length >= ATTACH_MAX}
								onClick={() => fileRef.current?.click()}
							>
								<PaperclipIcon />
							</button>
							<span className="ld-kb">{busy ? '⌥↵ queue' : '⇧↵ newline'}</span>
							{busy ? (
								<>
									<button className="ld-btn stop" title="Interrupt the turn in progress (⌘.)" disabled={stopping} onClick={stop}>
										{stopping ? <Spinner /> : <i className="ld-sq" />}
										{stopping ? 'Stopping' : 'Stop'}
									</button>
									<button className="ld-btn" title="Send it when this turn ends (⌥↵)" disabled={sending || (!text.trim() && !attachments.length)} onClick={() => send('queue')}>
										Queue
									</button>
									<button className="ld-btn pri" title="Add it to the work in progress (↵)" disabled={sending || (!text.trim() && !attachments.length)} onClick={() => send('steer')}>
										{sending ? <Spinner /> : 'Steer'} <span className="ld-k">↵</span>
									</button>
								</>
							) : (
								<button className="ld-btn pri" title="Send (↵)" disabled={sending || (!text.trim() && !attachments.length)} onClick={() => send('steer')}>
									{sending ? <Spinner /> : 'Send'} <span className="ld-k">↵</span>
								</button>
							)}
						</div>
						{dragging && <div className="ld-drop">Drop images to attach</div>}
					</div>
				) : (
					<Note block={block} status={s} found={found} connecting={connecting} canEdit={conjure.canEdit} onConnect={connect} />
				)}
				{error && <div className="ld-msg error">{error}</div>}
				{sent && !error && <div className="ld-msg ok">{sent}</div>}
			</div>

			<div className="ld-actions">
				{s?.conjured && (
					<button disabled={!reply && !s.ours} title="Open the whole reply as a page" onClick={openReply}>
						<FileIcon /> Open reply
					</button>
				)}
				{s && (s.queued > 0 || s.conjured) && (
					<button
						aria-pressed={s.muted}
						title={s.muted ? 'Show its calls for attention again (in this browser)' : 'Stop it calling for your attention here: no “needs you”, not in the tray (this browser only)'}
						onClick={() => conjure.toggleMute(sessionId)}
					>
						<BellIcon off={!s.muted} /> {s.muted ? 'Unmute' : 'Mute'}
					</button>
				)}
				{s?.conjured && conjure.canEdit && (
					<button className={`danger${confirmBanish ? ' armed' : ''}`} title="Disconnect the session from the canvas, for everyone (its frame and the session itself stay)" onClick={banish}>
						<PowerIcon /> {confirmBanish ? 'Banish? Click again' : 'Banish'}
					</button>
				)}
			</div>
			<div className="ld-foot">
				<span>
					<kbd>C</kbd> toggle
				</span>
				<span>
					<kbd>Esc</kbd> close
				</span>
				{canTalk && busy && (
					<span>
						<kbd>⌘.</kbd> stop
					</span>
				)}
			</div>
		</div>
	)
}

function Note({
	block,
	status,
	found,
	connecting,
	canEdit,
	onConnect,
}: {
	block: string | null
	status: LiveStatus | null
	found: { serverKey: string; title: string } | null | 'checking'
	connecting: boolean
	canEdit: boolean
	onConnect: () => void
}) {
	if (block === 'not-conjured' || !status?.conjured) {
		if (!canEdit) {
			return (
				<div className="ld-note">
					<strong>Not connected</strong>
					<span>This session isn’t conjured onto the canvas, so there’s nothing live to show.</span>
				</div>
			)
		}
		return (
			<div className="ld-note">
				<strong>Not connected</strong>
				{found === 'checking' ? (
					<span>Looking for it in your paired OpenCode servers…</span>
				) : found ? (
					<>
						<span>Connect it to see what it’s doing here and talk to it from the canvas. It runs while this browser has the canvas open.</span>
						<button className="ld-btn pri ld-connect" disabled={connecting} onClick={onConnect}>
							{connecting ? <Spinner /> : 'Connect'}
						</button>
					</>
				) : (
					<span>
						No OpenCode paired in this browser has this session. Pair the OpenCode it runs on (Conjure → Servers) to connect it.
					</span>
				)}
			</div>
		)
	}
	if (block === 'view-only') {
		return (
			<div className="ld-note">
				<strong>View only</strong>
				<span>You can watch it work; only its owner can prompt it, from an edit link.</span>
			</div>
		)
	}
	if (block === 'not-paired') {
		return (
			<div className="ld-note">
				<strong>Its OpenCode isn’t paired here</strong>
				<span>You conjured it, but this browser no longer has its OpenCode. Pair it again (Conjure → Servers) to wake it.</span>
			</div>
		)
	}
	return (
		<div className="ld-note">
			<strong>{status.awake ? 'Owned by someone else' : 'Asleep · owned by someone else'}</strong>
			<span>
				Only the browser that conjured it can prompt it.
				{status.awake ? ' You can watch it work.' : ' It wakes up when its owner opens this canvas.'}
			</span>
		</div>
	)
}

const ATTACH_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const ATTACH_MAX = 8
const ATTACH_MAX_BYTES = 20 * 1024 * 1024
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

const REPLY_DOC_CSS =
	'body{font:15px/1.6 system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;color:#18181b}' +
	'h1{font-size:20px}pre{background:#f4f4f5;padding:12px;border-radius:8px;overflow:auto}' +
	'code{font:13px ui-monospace,Menlo,monospace}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:4px 8px}'

function Spinner() {
	return <span className="conjure-spinner" aria-hidden="true" />
}

function Chevron({ open }: { open: boolean }) {
	return (
		<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<path d={open ? 'M6 9l6 6 6-6' : 'M9 6l6 6-6 6'} />
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

function FileIcon() {
	return (
		<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6M16 13H8M16 17H8" />
		</svg>
	)
}

function BellIcon({ off }: { off: boolean }) {
	return (
		<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			{off ? (
				<path d="M13.73 21a2 2 0 01-3.46 0M18.63 13A17.89 17.89 0 0118 8M6.26 6.26A5.86 5.86 0 006 8c0 7-3 9-3 9h14M18 8a6 6 0 00-9.33-5M1 1l22 22" />
			) : (
				<path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0" />
			)}
		</svg>
	)
}

function PowerIcon() {
	return (
		<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<path d="M18.36 6.64a9 9 0 11-12.73 0M12 2v10" />
		</svg>
	)
}
