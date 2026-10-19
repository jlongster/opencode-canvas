import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import type { Editor } from '../editor/Editor'
import { onOpenCodeEvents } from '../opencode/events'
import type { Conjure, LastExchange, PromptAttachment, PromptTarget, TalkBlock } from '../multiplayer/Conjure'
import { relativeTime } from './Conjure'
import { markdownToHtml } from './markdown'
import { useValue } from './useValue'
import './promptThread.css'

/** the panel's corner sits this far from the pointer (left, below; above when it flips) */
const ANCHOR_X = 24
const ANCHOR_Y = 44
/** and stays this far inside the window */
const MARGIN = 8
const WIDTH = 348
const ATTACH_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const ATTACH_MAX = 8
const ATTACH_MAX_BYTES = 20 * 1024 * 1024
const FLASH_MS = 1800
/** the composer grows up to this tall, then scrolls */
const INPUT_MAX_PX = 140
/** a reply taller than this is clamped until "Show full" */
const REPLY_CLAMP_PX = 152
/** streamed text that hasn't changed for this long means it's off doing something else (thinking) */
const STREAM_QUIET_MS = 1500
/** after a turn ends, the exchange is read again from OpenCode this much later (its last message lands) */
const REFETCH_MS = 700
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform)
const STOP_KEY = IS_MAC ? '⌘.' : 'Ctrl .'

/** The last exchange read from each session (ours), so reopening the panel shows it straight away. */
const exchanges = new Map<string, LastExchange>()
let localIds = 0
let attachmentIds = 0

interface Meta {
	x: number
	y: number
	thinking: boolean
	asleep: boolean
	block: TalkBlock
	color: string
	name: string
}

/** A prompt sent from this panel: shown until the exchange read back from OpenCode has it. */
interface LocalMessage {
	id: string
	text: string
	images: string[]
	status: 'sending' | 'sent' | 'failed'
	/** sent while it was working (added to the turn in progress) */
	steer: boolean
	error?: string
}

/**
 * The prompt thread under a clicked conjured worm (direction B, "Mini thread"), headerless (its name
 * is on the pointer's tag; × and ⋯ float over the thread on hover): its last exchange as bubbles
 * (your prompts, its reply streaming in live, what it's doing while it works), and a composer for
 * its owner (send, steer, stop, attach). Everyone else sees the thread and a note on whose it is.
 */
export function ConjurePrompt({ editor, conjure }: { editor: Editor; conjure: Conjure }) {
	const target = useValue(() => conjure.prompting.get(), [conjure])
	const metaKey = useValue(() => {
		const t = conjure.prompting.get()
		if (!t) return ''
		editor.camera.get()
		editor.viewport.get()
		const peer =
			conjure.presence.peers.get().find((p) => p.clientId === t.clientId) ?? conjure.sleepers.get().find((p) => p.clientId === t.clientId)
		if (!peer?.cursor) return 'gone'
		const p = editor.pageToScreen(peer.cursor)
		const meta: Meta = {
			x: Math.round(p.x),
			y: Math.round(p.y),
			thinking: !!peer.thinking,
			asleep: !!peer.user.asleep,
			block: conjure.talkBlock(t.sessionId),
			color: peer.user.color,
			name: peer.user.name,
		}
		return JSON.stringify(meta)
	}, [editor, conjure])

	// The worm was banished: nothing to talk to. (Waking up or falling asleep changes its client id.)
	useEffect(() => {
		if (metaKey !== 'gone' || !target) return
		const worm = conjure.worms().find((p) => p.user.sessionId === target.sessionId)
		if (worm) conjure.prompting.set({ clientId: worm.clientId, sessionId: target.sessionId })
		else conjure.close()
	}, [metaKey])

	const meta = useMemo(() => (metaKey && metaKey !== 'gone' ? (JSON.parse(metaKey) as Meta) : null), [metaKey])
	if (!target || !meta) return null
	return <PromptThread key={target.sessionId} conjure={conjure} target={target} meta={meta} />
}

function PromptThread({ conjure, target, meta }: { conjure: Conjure; target: PromptTarget; meta: Meta }) {
	const sessionId = target.sessionId
	const { block, thinking, asleep, color, name } = meta
	const owner = !block
	const live = useValue(() => {
		const peer = conjure.presence.peers.get().find((p) => p.user.conjured && p.user.sessionId === sessionId)
		return (peer?.speaking && peer.chat) || null
	}, [conjure, sessionId])
	const turn = useValue(() => conjure.turns.get()[sessionId] ?? null, [conjure, sessionId])
	const stopping = useValue(() => !!conjure.stopping.get()[sessionId], [conjure, sessionId])

	const [exchange, setExchange] = useState<LastExchange | null>(() => exchanges.get(sessionId) ?? null)
	const [loading, setLoading] = useState(false)
	const [local, setLocal] = useState<LocalMessage[]>([])
	const [text, setText] = useState('')
	const [attachments, setAttachments] = useState<PromptAttachment[]>([])
	const [sending, setSending] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [flash, setFlash] = useState<string | null>(null)
	const [menu, setMenu] = useState<null | 'open' | 'banish'>(null)
	const [expanded, setExpanded] = useState(false)
	const [canExpand, setCanExpand] = useState(false)
	const [dragging, setDragging] = useState(false)
	const [activity, setActivity] = useState<string | null>(null)
	const [size, setSize] = useState<{ w: number; h: number } | null>(null)
	const [, setTick] = useState(0)

	const rootRef = useRef<HTMLDivElement>(null)
	const inputRef = useRef<HTMLTextAreaElement>(null)
	const fileRef = useRef<HTMLInputElement>(null)
	const threadRef = useRef<HTMLDivElement>(null)
	const replyRef = useRef<HTMLDivElement>(null)
	const atEnd = useRef(true)
	const dragDepth = useRef(0)
	const flashTimer = useRef<number>(undefined)
	/** the reply showing when we sent a new prompt: not this turn's, so it isn't shown under it */
	const staleChat = useRef<string | null | undefined>(undefined)
	const liveChanged = useRef(0)
	const prevLive = useRef(live)
	if (prevLive.current !== live) {
		prevLive.current = live
		liveChanged.current = Date.now()
	}

	const refetch = useCallback(async () => {
		if (!conjure.ours(sessionId)) return
		setLoading(true)
		try {
			const ex = await conjure.lastExchange(sessionId)
			if (!ex) return
			exchanges.set(sessionId, ex)
			setExchange(ex)
			// What we sent is in there now.
			setLocal((l) => l.filter((m) => m.status === 'failed'))
			staleChat.current = undefined
		} catch {
			// (the thread keeps what it has; sending says if OpenCode can't be reached)
		} finally {
			setLoading(false)
		}
	}, [conjure, sessionId])

	useEffect(() => {
		if (owner) void refetch()
	}, [owner, refetch])

	// A turn ended: read the exchange again (its prompts and its whole reply).
	const wasThinking = useRef(thinking)
	useEffect(() => {
		const was = wasThinking.current
		wasThinking.current = thinking
		if (!was || thinking) return
		setActivity(null)
		if (!owner) return
		const t = window.setTimeout(() => void refetch(), REFETCH_MS)
		return () => window.clearTimeout(t)
	}, [thinking, owner, refetch])

	// What it's doing (tools), from its OpenCode's events: only its owner has them.
	useEffect(() => {
		const r = conjure.record(sessionId)
		if (!owner || !r) return
		const tools = new Map<string, string>()
		return onOpenCodeEvents(r.serverKey, {
			onEvent: (ev) => {
				const d = ev.data
				if (d?.sessionID !== sessionId) return
				if (ev.type === 'session.tool.input.started') {
					tools.set(String(d.id), String(d.name ?? ''))
					setActivity(toolActivity(String(d.name ?? '')))
				} else if (ev.type === 'session.tool.called') {
					setActivity(toolActivity(tools.get(String(d.id)) ?? '', d.input as Record<string, unknown> | undefined))
				} else if (ev.type === 'session.text.started') setActivity(null)
			},
		})
	}, [owner, conjure, sessionId])

	// Elapsed times and "3m ago" keep moving.
	useEffect(() => {
		const t = window.setInterval(() => setTick((n) => n + 1), thinking ? 1000 : 30_000)
		return () => window.clearInterval(t)
	}, [thinking])
	useEffect(() => () => window.clearTimeout(flashTimer.current), [])

	// Focused as soon as there's somewhere to type.
	useEffect(() => {
		if (owner) inputRef.current?.focus()
	}, [owner])

	// Grows with what's typed, up to a point.
	useLayoutEffect(() => {
		const el = inputRef.current
		if (!el) return
		el.style.height = 'auto'
		el.style.height = `${Math.min(el.scrollHeight, INPUT_MAX_PX)}px`
		el.style.overflowY = el.scrollHeight > INPUT_MAX_PX ? 'auto' : 'hidden'
	}, [text])

	// Kept on screen: its size decides whether it fits below the pointer.
	useLayoutEffect(() => {
		const el = rootRef.current
		if (!el) return
		const measure = () => setSize((prev) => (prev && prev.w === el.offsetWidth && prev.h === el.offsetHeight ? prev : { w: el.offsetWidth, h: el.offsetHeight }))
		measure()
		const observer = new ResizeObserver(measure)
		observer.observe(el)
		return () => observer.disconnect()
	}, [])

	// ---------- what the thread shows ----------

	const pending = local.filter((m) => m.status !== 'failed')
	const failed = local.find((m) => m.status === 'failed') ?? null
	const fresh = pending.length > 0 && !pending[0].steer
	const prompts: { id: string; text: string; images: string[]; dim?: boolean }[] = [...(fresh ? [] : (exchange?.prompts ?? [])), ...pending]
	const usable = (s: string | null) => (s && !s.startsWith('…') ? s : null)
	let reply: string | null
	let replyAt: number | null = null
	if (thinking) reply = live
	else if (fresh) reply = live !== staleChat.current ? live : null
	else if (usable(live)) reply = live
	else reply = exchange?.reply?.text ?? live
	if (exchange?.reply && reply === exchange.reply.text) replyAt = exchange.reply.at
	const streaming = thinking && !!live && Date.now() - liveChanged.current < STREAM_QUIET_MS
	const turnStart = useMemo(() => {
		const first = !fresh && exchange && !exchange.reply ? exchange.prompts[0]?.at : undefined
		const since = turn?.since
		return first && since ? Math.min(first, since) : (since ?? first ?? Date.now())
	}, [turn?.since, exchange, fresh])
	const replyHtml = useMemo(() => (reply ? markdownToHtml(reply) : ''), [reply])

	// Long replies clamp until "Show full"; the thread follows new text unless scrolled up.
	useLayoutEffect(() => {
		const el = replyRef.current
		setCanExpand(!!el && !streaming && el.scrollHeight > REPLY_CLAMP_PX + 4)
	}, [replyHtml, streaming, expanded])
	// A finished exchange shows from your last prompt; one in progress follows its end.
	const anchorKey = !thinking && !failed ? `${prompts.map((p) => p.id).join(' ')}|${reply?.length ?? 0}` : ''
	const anchored = useRef('')
	useLayoutEffect(() => {
		const thread = threadRef.current
		if (!thread) return
		if (anchorKey) {
			if (anchored.current === anchorKey) return
			anchored.current = anchorKey
			const mine = thread.querySelectorAll<HTMLElement>('.pt-me')
			const last = mine[mine.length - 1]
			thread.scrollTop = last ? last.offsetTop - 12 : thread.scrollHeight
			return
		}
		anchored.current = ''
		if (atEnd.current && thread.scrollHeight - thread.scrollTop - thread.clientHeight > 1) thread.scrollTop = thread.scrollHeight
	})
	useEffect(() => {
		if (thinking) atEnd.current = true
	}, [thinking])

	// ---------- actions ----------

	const showFlash = (message: string) => {
		setFlash(message)
		window.clearTimeout(flashTimer.current)
		flashTimer.current = window.setTimeout(() => setFlash(null), FLASH_MS)
	}

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

	const send = async (queue = false) => {
		const prompt = text.trim()
		if ((!prompt && !attachments.length) || sending || !owner) return
		const msg: LocalMessage = { id: `local-${++localIds}`, text: prompt, images: attachments.map((a) => a.dataUrl), status: 'sending', steer: thinking }
		if (!thinking) staleChat.current = live
		atEnd.current = true
		setLocal((l) => [...l.filter((m) => m.status !== 'failed'), msg])
		setSending(true)
		setError(null)
		try {
			const { steered } = await conjure.send(target, prompt, attachments, { queue: queue && thinking })
			setLocal((l) => l.map((m) => (m.id === msg.id ? { ...m, status: 'sent', steer: steered } : m)))
			setText('')
			setAttachments([])
			if (steered) showFlash(queue && thinking ? 'Queued for when it’s done' : 'Steered')
		} catch (e) {
			// Kept in the composer too, to retry or change.
			setLocal((l) => l.map((m) => (m.id === msg.id ? { ...m, status: 'failed', error: (e as Error).message } : m)))
		} finally {
			setSending(false)
			inputRef.current?.focus()
		}
	}

	const stop = async () => {
		if (!thinking || stopping || !owner) return
		setError(null)
		try {
			await conjure.interrupt(sessionId)
		} catch (e) {
			setError(`Couldn't stop it: ${(e as Error).message}`)
		}
	}

	const banish = async () => {
		setMenu(null)
		try {
			await conjure.banish(sessionId)
		} catch (e) {
			setError((e as Error).message)
		}
	}

	const close = () => conjure.close()

	const isFileDrag = (e: DragEvent) => e.dataTransfer.types.includes('Files')
	const dropHandlers = {
		onDragEnter: (e: DragEvent) => {
			if (!isFileDrag(e)) return
			e.preventDefault()
			e.stopPropagation()
			dragDepth.current++
			if (owner) setDragging(true)
		},
		onDragOver: (e: DragEvent) => {
			if (!isFileDrag(e)) return
			e.preventDefault()
			e.stopPropagation()
			e.dataTransfer.dropEffect = owner ? 'copy' : 'none'
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
			if (owner) attach([...e.dataTransfer.files])
		},
	}

	// ---------- layout ----------

	const vw = window.innerWidth
	const vh = window.innerHeight
	const w = size?.w ?? WIDTH
	const h = size?.h ?? 0
	let left = meta.x - ANCHOR_X
	let top = meta.y + ANCHOR_Y
	if (top + h > vh - MARGIN && meta.y - ANCHOR_Y - h >= MARGIN) top = meta.y - ANCHOR_Y - h
	left = Math.round(Math.max(MARGIN, Math.min(left, vw - w - MARGIN)))
	top = Math.round(Math.max(MARGIN, Math.min(top, vh - h - MARGIN)))

	const hasContent = !!text.trim() || attachments.length > 0
	const empty = !prompts.length && !reply && !thinking && !failed
	const busyRow = thinking && (!streaming || stopping)

	return (
		<div
			ref={rootRef}
			className={`pt${dragging ? ' dragging' : ''}`}
			style={{ left, top, ['--c' as string]: color }}
			onPointerDown={(e) => {
				e.stopPropagation()
				if (menu && !(e.target as HTMLElement).closest('.pt-menu, .pt-more-button')) setMenu(null)
			}}
			onWheel={(e) => e.stopPropagation()}
			onKeyDown={(e) => {
				e.stopPropagation()
				if (e.key === 'Escape') {
					e.preventDefault()
					if (menu) setMenu(null)
					else close()
				} else if (e.key === '.' && (e.metaKey || e.ctrlKey)) {
					e.preventDefault()
					void stop()
				}
			}}
			{...dropHandlers}
		>
			<div className="pt-body">
				<div
					ref={threadRef}
					className={`pt-thread${expanded ? ' expanded' : ''}`}
					onScroll={(e) => {
						const t = e.currentTarget
						atEnd.current = t.scrollHeight - t.scrollTop - t.clientHeight < 24
					}}
				>
					{empty &&
						(loading ? (
							<div className="pt-empty">
								<span className="pt-spin" /> Loading the last exchange…
							</div>
						) : (
							<div className="pt-empty">
								<span className="pt-dot" />
								{owner ? 'Idle · nothing said yet' : 'Idle · its replies show here'}
							</div>
						))}
					{prompts.map((m) => (
						<MeBubble key={m.id} text={m.text} images={m.images} />
					))}
					{reply && (
						<div className="pt-it">
							<div className="pt-who">
								{name}
								{!streaming && !thinking && replyAt ? ` · ${relativeTime(replyAt)}` : ''}
							</div>
							<div
								ref={replyRef}
								className={`pt-md${!expanded && !streaming ? ' clamped' : ''}${canExpand && !expanded ? ' faded' : ''}`}
								dangerouslySetInnerHTML={{ __html: streaming ? withCaret(replyHtml) : replyHtml }}
							/>
							{canExpand && (
								<button
									className="pt-expand"
									onClick={() => {
										atEnd.current = false
										setExpanded(!expanded)
									}}
								>
									{expanded ? 'Show less' : 'Show full'}
								</button>
							)}
						</div>
					)}
					{busyRow && (
						<div className="pt-think">
							<div className="pt-row">
								<span className="pt-spin" />
								<b>{mmss(Date.now() - turnStart)}</b> {stopping ? 'Stopping' : 'Thinking'}
								{activity ? ` · ${activity}` : ''}
							</div>
						</div>
					)}
					{failed && (
						<>
							<MeBubble text={failed.text} images={failed.images} dim />
							<div className="pt-fail" title={failed.error}>
								<WarnIcon />
								<span>
									{/isn't reachable/.test(failed.error ?? '') ? 'Couldn’t reach its OpenCode.' : (failed.error ?? 'Not delivered.')}{' '}
									<button onClick={() => send()} disabled={sending}>
										Retry
									</button>
								</span>
							</div>
						</>
					)}
				</div>
				<div className={`pt-float${menu ? ' open' : ''}`}>
					<button className="pt-fb pt-more-button" title="More" aria-label="More" aria-expanded={!!menu} onClick={() => setMenu(menu ? null : 'open')}>
						<MoreIcon />
					</button>
					<button className="pt-fb" title="Close (Esc)" aria-label="Close" onClick={close}>
						<XIcon />
					</button>
				</div>
				{menu === 'open' && (
					<div className="pt-menu" role="menu">
						<button
							role="menuitem"
							disabled={!canExpand && !expanded}
							onClick={() => {
								atEnd.current = false
								setExpanded(!expanded)
								setMenu(null)
							}}
						>
							{expanded ? 'Show less of the reply' : 'Show full reply'}
						</button>
						<button
							role="menuitem"
							onClick={() => {
								void navigator.clipboard?.writeText(sessionId)
								setMenu(null)
							}}
						>
							Copy session id
						</button>
						<button role="menuitem" className="pt-danger" onClick={() => setMenu('banish')}>
							Banish… <span className="pt-dim">removes it for everyone</span>
						</button>
					</div>
				)}
				{menu === 'banish' && (
					<div className="pt-menu pt-confirm" role="dialog">
						<p>
							Banish <b>{name}</b> from this canvas for everyone? The session itself stays in OpenCode.
						</p>
						<div className="pt-confirm-row">
							<button className="pt-btn ghost" onClick={() => setMenu(null)}>
								Cancel
							</button>
							<button className="pt-btn danger" autoFocus onClick={banish}>
								Banish
							</button>
						</div>
					</div>
				)}
			</div>

			{error && (
				<div className="pt-error">
					<WarnIcon />
					<span>{error}</span>
				</div>
			)}

			{block ? (
				<div className="pt-ro">
					<b>
						<LockIcon /> Read-only
						{asleep && (
							<span className="pt-asleep">
								<MoonIcon /> asleep
							</span>
						)}
					</b>
					{block === 'unowned'
						? 'Nobody has conjured it: its session called it up to show you something. To talk to it, conjure the session from your OpenCode (Conjure, or C over its frame).'
						: block === 'not-yours'
							? `Only the browser that conjured it can talk to it. ${asleep ? 'It wakes up when its owner opens this canvas.' : 'You can watch it think and reply.'}`
							: 'You conjured it, but this browser no longer has its OpenCode. Pair it again (Conjure → Servers) to wake it.'}
				</div>
			) : (
				<div className={`pt-comp${dragging ? ' drag' : ''}`}>
					{attachments.length > 0 && (
						<div className="pt-atts">
							{attachments.map((a) => (
								<div key={a.id} className="pt-th" title={a.name}>
									<img src={a.dataUrl} alt={a.name} />
									<button
										className="pt-th-x"
										title={`Remove ${a.name}`}
										disabled={sending}
										onClick={() => setAttachments((prev) => prev.filter((p) => p.id !== a.id))}
									>
										<XIcon />
									</button>
								</div>
							))}
						</div>
					)}
					<textarea
						ref={inputRef}
						value={text}
						rows={2}
						placeholder={thinking ? 'Steer it: added to the work in progress…' : `Message ${name}…`}
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
								void send(e.altKey)
							}
						}}
					/>
					<div className="pt-tb">
						<button
							className="pt-ib"
							title={`Attach images (or drop or paste them here; up to ${ATTACH_MAX})`}
							aria-label="Attach images"
							disabled={sending || attachments.length >= ATTACH_MAX}
							onClick={() => fileRef.current?.click()}
						>
							<PaperclipIcon />
						</button>
						{flash && (
							<span className="pt-h">
								<span className="pt-flash">
									<CheckIcon /> {flash}
								</span>
							</span>
						)}
						<span className="pt-sp" />
						{thinking ? (
							<>
								<button className="pt-btn ghost" title={`Stop: interrupt the session (${STOP_KEY})`} disabled={stopping} onClick={stop}>
									{stopping ? <span className="pt-spin pt-spin-xs" /> : <span className="pt-stopi" />}
									Stop
								</button>
								<button
									className={`pt-btn pri${hasContent && !sending ? '' : ' off'}`}
									title="Steer: add this to the work in progress (Enter). Alt+Enter queues it for when it’s done."
									disabled={!hasContent || sending}
									onClick={() => send()}
								>
									{sending ? <span className="pt-spin pt-spin-xs dark" /> : 'Steer'}
								</button>
							</>
						) : (
							<button className={`pt-send${hasContent ? ' on' : ''}`} title="Send (Enter; Shift+Enter for a new line, Esc closes)" disabled={!hasContent || sending} onClick={() => send()}>
								{sending ? <span className="pt-spin pt-spin-xs dark" /> : <UpIcon />}
							</button>
						)}
					</div>
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
					{dragging && <div className="pt-drop">Drop images to attach</div>}
				</div>
			)}
		</div>
	)
}

function MeBubble({ text, images, dim }: { text: string; images: string[]; dim?: boolean }) {
	return (
		<div className={`pt-me${dim ? ' dim' : ''}`}>
			{images.length > 0 && (
				<div className="pt-ims">
					{images.map((src, i) => (
						<img key={i} className="pt-th sm" src={src} alt="" />
					))}
				</div>
			)}
			{text}
		</div>
	)
}

/** "editing Minimap.tsx" and the like, for a tool call (its name, then its input once it's called). */
function toolActivity(name: string, input?: Record<string, unknown>): string {
	const str = (v: unknown) => (typeof v === 'string' ? v : '')
	const file = str(input?.filePath ?? input?.file_path ?? input?.path ?? input?.file)
	const base = file.split('/').filter(Boolean).pop() ?? ''
	switch (name.toLowerCase()) {
		case 'edit':
		case 'multiedit':
		case 'write':
		case 'patch':
		case 'apply_patch':
			return base ? `editing ${base}` : 'editing'
		case 'read':
			return base ? `reading ${base}` : 'reading'
		case 'bash':
		case 'shell': {
			const cmd = str(input?.command).split('\n')[0].trim()
			return cmd ? `running ${cmd.length > 40 ? cmd.slice(0, 39) + '…' : cmd}` : 'running a command'
		}
		case 'grep':
		case 'glob':
		case 'list':
		case 'ls':
		case 'codesearch':
			return 'searching'
		case 'webfetch':
		case 'websearch':
			return 'looking on the web'
		// (subagents show on the canvas as baby pointers, never in the thread)
		case 'task':
		case 'subagent':
			return ''
		case 'todowrite':
		case 'todoread':
			return 'planning'
		case '':
			return 'working'
		default:
			return `using ${name}`
	}
}

function mmss(ms: number) {
	const s = Math.max(0, Math.floor(ms / 1000))
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** The typing caret at the end of streamed Markdown, inside its last paragraph when it ends with one. */
function withCaret(html: string) {
	const caret = '<span class="pt-caret"></span>'
	const m = /<\/(p|li)>\s*(<\/(ul|ol)>\s*)?$/.exec(html)
	return m ? html.slice(0, m.index) + caret + html.slice(m.index) : html + caret
}

function readAttachment(file: File): Promise<PromptAttachment> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader()
		reader.onload = () =>
			resolve({ id: String(++attachmentIds), name: file.name || `image.${file.type.split('/')[1]}`, mime: file.type, dataUrl: reader.result as string })
		reader.onerror = () => reject(new Error(`couldn't read ${file.name || 'that image'}`))
		reader.readAsDataURL(file)
	})
}

const icon = (children: ReactNode, props: Record<string, unknown> = {}) => (
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
		{children}
	</svg>
)

function PaperclipIcon() {
	return icon(<path d="m21 11.5-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9" />)
}

function UpIcon() {
	return icon(<path d="M12 19V5M5 12l7-7 7 7" />, { strokeWidth: 2.2 })
}

function XIcon() {
	return icon(<path d="M6 6l12 12M18 6 6 18" />, { strokeWidth: 2.4 })
}

function MoreIcon() {
	return (
		<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
			<circle cx="5" cy="12" r="1.7" />
			<circle cx="12" cy="12" r="1.7" />
			<circle cx="19" cy="12" r="1.7" />
		</svg>
	)
}

function WarnIcon() {
	return icon(
		<>
			<circle cx="12" cy="12" r="9" />
			<path d="M12 7.5v5.5M12 16.5v.01" />
		</>,
		{ strokeWidth: 2 },
	)
}

function MoonIcon() {
	return (
		<svg className="pt-moon" viewBox="0 0 24 24" width="11" height="11" fill="currentColor" aria-hidden="true">
			<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
		</svg>
	)
}

function LockIcon() {
	return icon(
		<>
			<rect x="5" y="11" width="14" height="9" rx="2" />
			<path d="M8 11V8a4 4 0 0 1 8 0v3" />
		</>,
		{ width: 12, height: 12, strokeWidth: 2 },
	)
}

function CheckIcon() {
	return icon(<path d="m5 12 5 5 9-10" />, { width: 12, height: 12, strokeWidth: 2.6, className: 'pt-check' })
}
