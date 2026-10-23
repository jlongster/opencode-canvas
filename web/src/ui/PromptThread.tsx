import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react'
import { sessionColor } from '../../../shared/sessionColor'
import type { Editor } from '../editor/Editor'
import { onOpenCodeEvents } from '../opencode/events'
import type { LastExchange, PromptAttachment, SessionControl, TalkBlock } from '../multiplayer/SessionControl'
import { pendingItems } from '../multiplayer/itemAttachments'
import { url as withBase } from '../base'
import { AskBubbles, AskWaiting, useAsking, useSessionAsks } from './AskBubbles'
import { placeAtAnchor } from './frameAnchor'
import { markdownToHtml } from './markdown'
import { useValue } from './useValue'
import './promptThread.css'

/** the widest a bubble gets (the input always is this wide) */
const BUBBLE_MAX = 360
const LINE_PX = 20
/** the input grows to this many lines while focused, then scrolls */
const INPUT_MAX_LINES = 8
/** prompt chips in the one-line bubble: how many before "+n" */
const CHIPS_MAX = 3
const ATTACH_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const ATTACH_MAX = 8
const ATTACH_MAX_BYTES = 20 * 1024 * 1024
const FLASH_MS = 1800
/** streamed text that hasn't changed for this long means it's off doing something else (thinking) */
const STREAM_QUIET_MS = 1500
/** after a turn ends, the exchange is read again from OpenCode this much later (its last message lands) */
const REFETCH_MS = 700
/** a click (not a pan) away from the stack closes it */
const CLICK_SLOP_PX = 5
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform)
const STOP_KEY = IS_MAC ? '⌘.' : 'Ctrl .'

/** The last exchange read from each session (ours), so reopening the stack shows it straight away. */
const exchanges = new Map<string, LastExchange>()
let localIds = 0
let attachmentIds = 0

interface Meta {
	thinking: boolean
	/** its owner's tab is running it (sharing its replies) */
	online: boolean
	block: TalkBlock
	/** why linking it to this browser failed, while it's unlinked */
	linkError: string | null
	color: string
	name: string
}

/** A prompt sent from here: shown until the exchange read back from OpenCode has it. */
interface LocalMessage {
	id: string
	text: string
	images: string[]
	status: 'sending' | 'sent' | 'failed'
	/** sent while it was working (added to the turn in progress) */
	steer: boolean
	error?: string
}

type Expanded = null | 'prompt' | 'reply' | 'note'

/**
 * A session's prompt (its frame's prompt button, or C; see SessionControl): three bubbles floating
 * one above the other where it opened (the input just below and right of the pointer, for C), pinned
 * to that spot on the canvas at a constant size, each one line until clicked (the CSS clips
 * it with an ellipsis): your last prompt and its reply in the session's colour (the reply's live
 * last line while it works), then the input, outlined in that colour, for its owner (send, steer,
 * stop, attach). Everyone else gets a note on whose it is. While the session waits on its owner to
 * answer questions or a permission request, those take the three bubbles' place (see AskBubbles):
 * to answer for its owner, read-only for everyone else.
 */
export function SessionPrompt({ editor, sessions }: { editor: Editor; sessions: SessionControl }) {
	const sessionId = useValue(() => sessions.prompting.get(), [sessions])
	const anchorKey = useValue(() => {
		const a = sessions.promptAnchor.get()
		if (!a) return ''
		editor.camera.get()
		const p = editor.pageToScreen({ x: a.x, y: a.top })
		return JSON.stringify({ x: p.x, top: p.y, bottom: editor.pageToScreen({ x: a.x, y: a.bottom }).y, place: a.place })
	}, [editor, sessions])
	const anchor = useMemo(() => (anchorKey ? (JSON.parse(anchorKey) as ScreenAnchor) : null), [anchorKey])
	/** (a new one for each time it opens: where it goes is worked out then) */
	const opened = useValue(() => sessions.promptAnchor.get(), [sessions])
	const metaKey = useValue(() => {
		const id = sessions.prompting.get()
		if (!id) return ''
		const peer = sessions.live.get().get(id)
		const linking = sessions.linking.get()
		const meta: Meta = {
			thinking: sessions.isBusy(id) || !!peer?.thinking,
			online: !!peer,
			block: sessions.talkBlock(id),
			linkError: linking?.sessionId === id ? linking.error : null,
			color: sessionColor(id),
			name: sessions.label(id),
		}
		return JSON.stringify(meta)
	}, [sessions])
	const meta = useMemo(() => (metaKey ? (JSON.parse(metaKey) as Meta) : null), [metaKey])
	if (!sessionId || !meta || !anchor) return null
	return <PromptStack key={`${sessionId}:${opened?.x},${opened?.top}`} sessions={sessions} sessionId={sessionId} meta={meta} anchor={anchor} />
}

/** SessionControl.promptAnchor on screen (CSS px) */
interface ScreenAnchor {
	x: number
	top: number
	bottom: number
	place: 'cursor' | 'below' | 'above'
}

function PromptStack({ sessions, sessionId, meta, anchor }: { sessions: SessionControl; sessionId: string; meta: Meta; anchor: ScreenAnchor }) {
	const { block, thinking, online, color, name } = meta
	const owner = !block
	const live = useValue(() => {
		const peer = sessions.live.get().get(sessionId)
		return (peer?.speaking && peer.chat) || null
	}, [sessions, sessionId])
	const asking = useAsking(sessions, sessionId)
	const turn = useValue(() => sessions.turns.get()[sessionId] ?? null, [sessions, sessionId])
	const stopping = useValue(() => !!sessions.stopping.get()[sessionId], [sessions, sessionId])

	const [exchange, setExchange] = useState<LastExchange | null>(() => exchanges.get(sessionId) ?? null)
	const [loading, setLoading] = useState(false)
	const [local, setLocal] = useState<LocalMessage[]>([])
	const [text, setText] = useState('')
	const [attachments, setAttachments] = useState<PromptAttachment[]>([])
	const [sending, setSending] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [flash, setFlash] = useState<string | null>(null)
	const [menu, setMenu] = useState<null | 'open' | 'unlink'>(null)
	const [expanded, setExpanded] = useState<Expanded>(null)
	const [typing, setTyping] = useState(false)
	const [dragging, setDragging] = useState(false)
	const [activity, setActivity] = useState<string | null>(null)
	/** its size, and how far down it its input (or read-only note) is: that's what goes at the anchor */
	const [size, setSize] = useState<{ w: number; h: number; inputTop: number } | null>(null)
	/** where it goes from its anchor, worked out once as it opens (see placeAtAnchor) */
	const place = useRef<{ dx: number; dy: number } | null>(null)
	const [inputLines, setInputLines] = useState(1)
	const [, setTick] = useState(0)
	/** media people dragged onto the frame that the session doesn't have yet: goes with the next prompt unless removed here */
	const frameKey = useValue(
		() => pendingItems(sessions.editor.items.get(), sessionId).map((i) => `${i.id}:${i.src}`).join(','),
		[sessions, sessionId],
	)
	const frameItems = useMemo(() => pendingItems(sessions.editor.items.peek(), sessionId), [frameKey])
	const [skipped, setSkipped] = useState<Set<string>>(() => new Set())
	const included = frameItems.filter((i) => !skipped.has(i.id))
	/** what its session waits on us to answer (ours only), as last read from OpenCode */
	const { asks, loading: asksLoading, actions: askActions } = useSessionAsks(sessions, sessionId, owner, asking)
	const expandedRef = useRef(expanded)
	expandedRef.current = expanded

	const rootRef = useRef<HTMLDivElement>(null)
	const inputRef = useRef<HTMLTextAreaElement>(null)
	const fileRef = useRef<HTMLInputElement>(null)
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
		if (!sessions.ours(sessionId)) return
		setLoading(true)
		try {
			const ex = await sessions.lastExchange(sessionId)
			if (!ex) return
			exchanges.set(sessionId, ex)
			setExchange(ex)
			// What we sent is in there now.
			setLocal((l) => l.filter((m) => m.status === 'failed'))
			staleChat.current = undefined
		} catch {
			// (the stack keeps what it has; sending says if OpenCode can't be reached)
		} finally {
			setLoading(false)
		}
	}, [sessions, sessionId])

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
		const r = sessions.record(sessionId)
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
	}, [owner, sessions, sessionId])

	// The elapsed time keeps moving.
	useEffect(() => {
		if (!thinking) return
		const t = window.setInterval(() => setTick((n) => n + 1), 1000)
		return () => window.clearInterval(t)
	}, [thinking])
	useEffect(() => () => window.clearTimeout(flashTimer.current), [])

	// Focused as soon as there's somewhere to type (again after answering what it asked).
	const asksShowing = owner && !!asks?.length
	useEffect(() => {
		if (owner && !asksShowing) inputRef.current?.focus()
	}, [owner, asksShowing])

	// Its size decides where it fits as it opens; then its input stays put as the bubbles above it change.
	const measure = useCallback(() => {
		const el = rootRef.current
		if (!el) return
		const input = el.querySelector<HTMLElement>(':scope > [data-b="input"], :scope > [data-b="note"]')
		const next = { w: el.offsetWidth, h: el.offsetHeight, inputTop: input?.offsetTop ?? 0 }
		setSize((prev) => (prev && prev.w === next.w && prev.h === next.h && prev.inputTop === next.inputTop ? prev : next))
	}, [])
	useLayoutEffect(measure)
	useLayoutEffect(() => {
		const el = rootRef.current
		if (!el) return
		const observer = new ResizeObserver(measure)
		observer.observe(el)
		return () => observer.disconnect()
	}, [measure])

	// A click away (not a drag or a pan) collapses what's open, else closes the stack; unless that
	// click opened it again (its frame's prompt button) or another session's.
	useEffect(() => {
		let down: { x: number; y: number; opened: string | null } | null = null
		const outside = (e: Event) => !rootRef.current?.contains(e.target as Node)
		const onDown = (e: PointerEvent) => {
			down = outside(e) ? { x: e.clientX, y: e.clientY, opened: sessions.prompting.peek() } : null
		}
		const onUp = (e: PointerEvent) => {
			const d = down
			down = null
			if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_SLOP_PX) return
			window.setTimeout(() => {
				if (sessions.prompting.peek() !== d.opened) return
				setMenu(null)
				if (expandedRef.current) setExpanded(null)
				else sessions.close()
			})
		}
		// Esc while not typing somewhere else (after clicking a bubble open, or its frame's prompt
		// button) collapses it too, then closes.
		const onKey = (e: KeyboardEvent) => {
			const active = document.activeElement as HTMLElement | null
			if (e.key !== 'Escape' || rootRef.current?.contains(active) || (active && (active.matches('input, textarea') || active.isContentEditable))) return
			e.preventDefault()
			if (expandedRef.current) setExpanded(null)
			else sessions.close()
		}
		window.addEventListener('pointerdown', onDown, true)
		window.addEventListener('pointerup', onUp, true)
		window.addEventListener('keydown', onKey)
		return () => {
			window.removeEventListener('pointerdown', onDown, true)
			window.removeEventListener('pointerup', onUp, true)
			window.removeEventListener('keydown', onKey)
		}
	}, [sessions])

	// ---------- what the bubbles show ----------

	const pending = local.filter((m) => m.status !== 'failed')
	const failed = local.find((m) => m.status === 'failed') ?? null
	const fresh = pending.length > 0 && !pending[0].steer
	const prompts: { id: string; text: string; images: string[]; dim?: boolean }[] = [
		...(fresh ? [] : (exchange?.prompts ?? [])),
		...pending.map((m) => ({ ...m, dim: m.status === 'sending' })),
		...(failed ? [{ ...failed, dim: true }] : []),
	]
	const lastPrompt = prompts[prompts.length - 1] ?? null
	const usable = (s: string | null) => (s && !s.startsWith('…') ? s : null)
	let reply: string | null
	if (thinking) reply = live
	else if (fresh) reply = live !== staleChat.current ? live : null
	else if (usable(live)) reply = live
	else reply = exchange?.reply?.text ?? live
	const streaming = thinking && !!live && Date.now() - liveChanged.current < STREAM_QUIET_MS
	const turnStart = useMemo(() => {
		const first = !fresh && exchange && !exchange.reply ? exchange.prompts[0]?.at : undefined
		const since = turn?.since
		return first && since ? Math.min(first, since) : (since ?? first ?? Date.now())
	}, [turn?.since, exchange, fresh])
	const replyHtml = useMemo(() => (expanded === 'reply' && reply ? markdownToHtml(reply) : ''), [reply, expanded])

	// One line each: the CSS clips it (with an ellipsis), and whether it did says there's more to show.
	const chips = lastPrompt ? Math.min(lastPrompt.images.length, CHIPS_MAX) + (lastPrompt.images.length > CHIPS_MAX ? 1 : 0) : 0
	const promptLine = useMemo(() => (lastPrompt ? flatten(lastPrompt.text) : ''), [lastPrompt?.text])
	const replyPlain = useMemo(() => (reply ? markdownPlain(reply) : ''), [reply])
	// (while it works, the end of what it's writing: clipped at its start instead)
	const replyTail = thinking && !!replyPlain
	const replyLine = useMemo(() => (replyTail ? tailOf(replyPlain) : flatten(replyPlain)), [replyPlain, replyTail])
	const [promptRef, promptClipped] = useClipped<HTMLSpanElement>()
	const [replyLineRef, replyClipped] = useClipped<HTMLSpanElement>()
	const [roRef, roClipped] = useClipped<HTMLSpanElement>()
	const replyMore = !!replyLine && (replyClipped || /\n/.test(replyPlain.trim()) || (replyTail && replyLine.length < flatten(replyPlain).length))
	const promptMore = !!lastPrompt && (promptClipped || prompts.length > 1 || lastPrompt.images.length > 0 || /\n/.test(lastPrompt.text))

	// The input: one line until it's focused, then as many as it has (its scrollHeight says), up to a point.
	useLayoutEffect(() => {
		const el = inputRef.current
		if (!el) return
		el.style.height = `${LINE_PX}px`
		const lines = text ? Math.max(1, Math.round(el.scrollHeight / LINE_PX)) : 1
		el.style.height = `${(typing ? Math.min(lines, INPUT_MAX_LINES) : 1) * LINE_PX}px`
		el.style.overflowY = typing && lines > INPUT_MAX_LINES ? 'auto' : 'hidden'
		setInputLines(lines)
	})
	const draftLine = !typing && inputLines > 1 ? flatten(text) : null

	// The open reply follows new text unless scrolled up.
	useLayoutEffect(() => {
		const el = replyRef.current
		if (el && streaming && atEnd.current) el.scrollTop = el.scrollHeight
	})
	useEffect(() => {
		atEnd.current = !!thinking
		if (replyRef.current && expanded === 'reply' && !thinking) replyRef.current.scrollTop = 0
	}, [expanded])

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
		if ((!prompt && !attachments.length && !included.length) || sending || !owner) return
		const msg: LocalMessage = { id: `local-${++localIds}`, text: prompt, images: attachments.map((a) => a.dataUrl), status: 'sending', steer: thinking }
		if (!thinking) staleChat.current = live
		setLocal((l) => [...l.filter((m) => m.status !== 'failed'), msg])
		setSending(true)
		setError(null)
		try {
			const { steered } = await sessions.send(sessionId, prompt, attachments, { queue: queue && thinking, frameItems: included })
			setLocal((l) => l.map((m) => (m.id === msg.id ? { ...m, status: 'sent', steer: steered } : m)))
			setText('')
			setAttachments([])
			setSkipped(new Set())
			if (steered) showFlash(queue && thinking ? 'Queued for when it’s done' : 'Steered')
		} catch (e) {
			// Kept in the input too, to retry or change.
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
			await sessions.interrupt(sessionId)
		} catch (e) {
			setError(`Couldn't stop it: ${(e as Error).message}`)
		}
	}

	const unlink = async () => {
		setMenu(null)
		try {
			await sessions.unlink(sessionId)
		} catch (e) {
			setError((e as Error).message)
		}
	}

	const close = () => sessions.close()

	const askView = asksShowing ? (
		<AskBubbles asks={asks!} actions={askActions} more={asks!.length - 1} />
	) : asking && (!owner || (asksLoading && !asks?.length)) ? (
		<AskWaiting asking={asking} loading={owner} />
	) : null

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

	/** Pressing a collapsed bubble opens it (on press, so nothing has moved under the pointer by the click). */
	const expandOn = (which: Exclude<Expanded, null>, can: boolean) => (e: ReactPointerEvent) => {
		if (!can || expanded === which || e.button !== 0) return
		setExpanded(which)
		setMenu(null)
	}

	// ---------- layout ----------

	const vw = window.innerWidth
	const vh = window.innerHeight
	const w = size?.w ?? BUBBLE_MAX
	if (size && !place.current) place.current = placeAtAnchor(anchor, size.w, size.h, size.inputTop, vw, vh)
	const left = Math.round(anchor.x + (place.current?.dx ?? 0))
	const top = Math.round(anchor.top + (place.current?.dy ?? 0) - (size?.inputTop ?? 0))
	/** the ⋯ and × go on the stack's right, or its left with no room there */
	const ctlSide = left + w + 40 > vw ? 'left' : 'right'

	const hasContent = !!text.trim() || attachments.length > 0 || included.length > 0
	const empty = !lastPrompt && !reply && !thinking
	const ink = readableOn(color)
	const busyLine = `${stopping ? 'Stopping' : 'Working'} ${mmss(Date.now() - turnStart)}${activity ? ` · ${activity}` : ''}`
	const linked = block !== 'unlinked'
	const roText =
		block === 'unlinked'
			? (meta.linkError ?? 'Looking for it in the OpenCode paired in this browser…')
			: block === 'not-yours'
				? `Only the browser that linked it to its OpenCode can prompt it. ${online ? 'You can watch it work and reply.' : 'Its owner doesn’t have this canvas open, so its replies don’t show either.'}`
				: 'You linked it, but this browser no longer has its OpenCode paired. Pair it again (Sessions → Servers) to prompt it.'
	const roLabel = block === 'unlinked' ? (meta.linkError ? 'Can’t prompt it · ' : 'Linking · ') : `Read-only${!owner && linked && !online ? ' · offline' : ''} · `
	const roLine = roLabel + roText

	return (
		<div
			ref={rootRef}
			className={`pt${dragging ? ' dragging' : ''}`}
			style={{ left, top, visibility: place.current ? undefined : 'hidden', ['--c' as string]: color, ['--ink' as string]: ink }}
			onPointerDown={(e) => {
				e.stopPropagation()
				const t = e.target as HTMLElement
				if (menu && !t.closest('.pt-menu, .pt-more')) setMenu(null)
				if (expanded && !t.closest(`[data-b="${expanded}"]`)) setExpanded(null)
			}}
			onWheel={(e) => e.stopPropagation()}
			onKeyDown={(e) => {
				e.stopPropagation()
				if (e.key === 'Escape') {
					e.preventDefault()
					if (menu) setMenu(null)
					else if (expanded) setExpanded(null)
					else close()
				} else if (e.key === '.' && (e.metaKey || e.ctrlKey)) {
					e.preventDefault()
					void stop()
				}
			}}
			{...dropHandlers}
		>
			{askView ?? (
				<>
					{lastPrompt &&
						(expanded === 'prompt' ? (
							<div className="pt-b pt-fill pt-open" data-b="prompt">
								<div className="pt-scroll">
									{prompts.map((p) => (
										<div key={p.id} className={`pt-p${p.dim ? ' dim' : ''}`}>
											{p.images.length > 0 && (
												<div className="pt-ims">
													{p.images.map((src, i) => (
														<img key={i} className="pt-th sm" src={src} alt="" />
													))}
												</div>
											)}
											{p.text && <div className="pt-pt">{p.text}</div>}
										</div>
									))}
								</div>
							</div>
						) : (
							<div
								className={`pt-b pt-fill${lastPrompt.dim ? ' dim' : ''}${promptMore ? ' can' : ''}`}
								data-b="prompt"
								title={promptMore ? 'Show the whole prompt' : undefined}
								onPointerDown={expandOn('prompt', promptMore)}
							>
								{chips > 0 && (
									<span className="pt-chips">
										{lastPrompt.images.slice(0, CHIPS_MAX).map((src, i) => (
											<img key={i} src={src} alt="" />
										))}
										{lastPrompt.images.length > CHIPS_MAX && <span className="pt-chip-n">+{lastPrompt.images.length - CHIPS_MAX}</span>}
									</span>
								)}
								{promptLine && (
									<span ref={promptRef} className="pt-line">
										{promptLine}
									</span>
								)}
							</div>
						))}

					{expanded === 'reply' && reply ? (
						<div className={`pt-b pt-fill pt-open${thinking ? ' busy' : ''}`} data-b="reply">
							<div
								ref={replyRef}
								className="pt-scroll pt-md"
								onScroll={(e) => {
									const t = e.currentTarget
									atEnd.current = t.scrollHeight - t.scrollTop - t.clientHeight < 24
								}}
								dangerouslySetInnerHTML={{ __html: streaming ? withCaret(replyHtml) : replyHtml }}
							/>
						</div>
					) : thinking && !replyLine ? (
						<div className="pt-b pt-fill busy" data-b="reply">
							<span className="pt-spin" />
							<span className="pt-line">{busyLine}</span>
						</div>
					) : replyLine ? (
						<div
							className={`pt-b pt-fill${thinking ? ' busy' : ''}${replyMore ? ' can' : ''}`}
							data-b="reply"
							title={replyMore ? 'Show the whole reply' : undefined}
							onPointerDown={expandOn('reply', replyMore)}
						>
							<span ref={replyLineRef} className={`pt-line${replyTail ? ' tail' : ''}`}>
								{replyTail ? <span>{replyLine}</span> : replyLine}
							</span>
						</div>
					) : (
						empty && (
							<div className="pt-b pt-fill pt-idle" data-b="reply">
								{loading ? <span className="pt-spin" /> : <span className="pt-dot" />}
								{loading ? 'Loading the last exchange…' : owner ? 'Idle · nothing said yet' : 'Idle · its replies show here'}
							</div>
						)
					)}

					{block ? (
						<div
							className={`pt-b pt-ro${expanded === 'note' ? ' pt-open' : roClipped ? ' can' : ''}`}
							data-b="note"
							onPointerDown={expandOn('note', roClipped)}
							title={expanded === 'note' ? undefined : roText}
						>
							{expanded === 'note' ? (
								<div className="pt-ro-full">
									<b>
										<LockIcon /> {block === 'unlinked' ? (meta.linkError ? 'Can’t prompt it' : 'Linking') : 'Read-only'}
										{!owner && linked && !online && <span className="pt-offline">offline</span>}
									</b>
									{roText}
								</div>
							) : (
								<>
									<LockIcon />
									<span ref={roRef} className="pt-line">
										{roLine}
									</span>
								</>
							)}
						</div>
					) : (
						<div
							className={`pt-b pt-in${typing ? ' open' : ''}${dragging ? ' drag' : ''}`}
							data-b="input"
							onPointerDown={(e) => {
								// Anywhere in it but its buttons is somewhere to type.
								if (!(e.target as HTMLElement).closest('button, textarea')) {
									e.preventDefault()
									inputRef.current?.focus()
								}
							}}
						>
							{included.length > 0 && (
								<div className="pt-frame-items">
									<span className="pt-frame-label" title="Added to the frame by people, not sent to the session yet: they go with this prompt">
										From the frame
									</span>
									<div className="pt-atts">
										{included.map((item) => (
											<div key={item.id} className="pt-th" title={`${item.name}${item.addedBy ? `, added by ${item.addedBy}` : ''}: goes with this prompt`}>
												{item.kind === 'html' ? <span className="pt-th-doc">HTML</span> : <img src={withBase(item.thumb)} alt={item.name} />}
												<button
													className="pt-th-x"
													title={`Don’t send ${item.name} with this prompt (it stays on the frame, still to send)`}
													disabled={sending}
													onPointerDown={keepFocus}
													onClick={() => setSkipped((prev) => new Set([...prev, item.id]))}
												>
													<XIcon />
												</button>
											</div>
										))}
									</div>
								</div>
							)}
							{attachments.length > 0 && (
								<div className="pt-atts">
									{attachments.map((a) => (
										<div key={a.id} className="pt-th" title={a.name}>
											<img src={a.dataUrl} alt={a.name} />
											<button
												className="pt-th-x"
												title={`Remove ${a.name}`}
												disabled={sending}
												onPointerDown={keepFocus}
												onClick={() => setAttachments((prev) => prev.filter((p) => p.id !== a.id))}
											>
												<XIcon />
											</button>
										</div>
									))}
								</div>
							)}
							<div className="pt-ta">
								<textarea
									ref={inputRef}
									value={text}
									rows={1}
									style={{ color: draftLine ? 'transparent' : undefined }}
									placeholder={thinking ? 'Steer it: added to the work in progress…' : `Message ${name}…`}
									onFocus={() => setTyping(true)}
									onBlur={(e) => {
										if (!e.currentTarget.closest('.pt-in')?.contains(e.relatedTarget as Node)) setTyping(false)
									}}
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
								{draftLine && <div className="pt-ta-line">{draftLine}</div>}
							</div>
							{error && (
								<div className="pt-error">
									<WarnIcon />
									<span>{error}</span>
								</div>
							)}
							<div className="pt-tb">
								<button
									className="pt-ib"
									title={`Attach images (or drop or paste them here; up to ${ATTACH_MAX})`}
									aria-label="Attach images"
									disabled={sending || attachments.length >= ATTACH_MAX}
									onPointerDown={keepFocus}
									onClick={() => fileRef.current?.click()}
								>
									<PaperclipIcon />
								</button>
								{failed ? (
									<span className="pt-h pt-fail" title={failed.error}>
										{/isn't reachable/.test(failed.error ?? '') ? 'Couldn’t reach its OpenCode' : 'Not delivered'} ·{' '}
										<button onPointerDown={keepFocus} onClick={() => send()} disabled={sending}>
											Retry
										</button>
									</span>
								) : (
									flash && (
										<span className="pt-h">
											<span className="pt-flash">
												<CheckIcon /> {flash}
											</span>
										</span>
									)
								)}
								<span className="pt-sp" />
								{thinking ? (
									<>
										<button
											className="pt-btn ghost"
											title={`Stop: interrupt the session (${STOP_KEY})`}
											disabled={stopping}
											onPointerDown={keepFocus}
											onClick={stop}
										>
											{stopping ? <span className="pt-spin pt-spin-xs" /> : <span className="pt-stopi" />}
											Stop
										</button>
										<button
											className={`pt-btn pri${hasContent && !sending ? '' : ' off'}`}
											title="Steer: add this to the work in progress (Enter). Alt+Enter queues it for when it’s done."
											disabled={!hasContent || sending}
											onPointerDown={keepFocus}
											onClick={() => send()}
										>
											{sending ? <span className="pt-spin pt-spin-xs dark" /> : 'Steer'}
										</button>
									</>
								) : (
									<button
										className={`pt-send${hasContent ? ' on' : ''}`}
										title="Send (Enter; Shift+Enter for a new line, Esc closes)"
										disabled={!hasContent || sending}
										onPointerDown={keepFocus}
										onClick={() => send()}
									>
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
				</>
			)}

			<div className={`pt-ctl ${ctlSide}${menu ? ' open' : ''}`}>
				<button className="pt-fb pt-more" title="More" aria-label="More" aria-expanded={!!menu} onClick={() => setMenu(menu ? null : 'open')}>
					<MoreIcon />
				</button>
				<button className="pt-fb" title="Close (Esc)" aria-label="Close" onClick={close}>
					<XIcon />
				</button>
			</div>
			{menu === 'open' && (
				<div className={`pt-menu ${ctlSide}`} role="menu">
					<button
						role="menuitem"
						onClick={() => {
							void navigator.clipboard?.writeText(sessionId)
							setMenu(null)
						}}
					>
						Copy session id
					</button>
					{linked && (
						<button role="menuitem" className="pt-danger" onClick={() => setMenu('unlink')}>
							Unlink… <span className="pt-dim">from its OpenCode, for everyone</span>
						</button>
					)}
				</div>
			)}
			{menu === 'unlink' && (
				<div className={`pt-menu pt-confirm ${ctlSide}`} role="dialog">
					<p>
						Unlink <b>{name}</b> from its OpenCode for everyone? Its frame stays, and the session itself stays in OpenCode; whoever prompts it next
						links it again.
					</p>
					<div className="pt-confirm-row">
						<button className="pt-btn ghost" onClick={() => setMenu(null)}>
							Cancel
						</button>
						<button className="pt-btn danger" autoFocus onClick={unlink}>
							Unlink
						</button>
					</div>
				</div>
			)}
		</div>
	)
}

/** Buttons in the input keep the textarea focused, so it doesn't shrink under the pointer mid-click. */
function keepFocus(e: ReactPointerEvent) {
	e.preventDefault()
}

// ---------- one line ----------

/** `text` on one line: its spaces and line breaks collapsed (the CSS cuts it to fit) */
function flatten(text: string): string {
	const flat = text.replace(/\s+/g, ' ').trim()
	// (one line never shows more than this much of it)
	return flat.length > 400 ? flat.slice(0, 400) : flat
}

/** The end of `text`'s last paragraph (what's being written now), on one line: the CSS cuts it at its start. */
function tailOf(text: string): string {
	const paragraphs = text.split('\n').map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean)
	const last = paragraphs[paragraphs.length - 1] ?? ''
	return last.length > 200 ? last.slice(-200) : last
}

/** A ref for a one-line span, and whether the CSS had to clip it (it's wider than it shows). */
function useClipped<T extends HTMLElement>(): [RefObject<T | null>, boolean] {
	const ref = useRef<T>(null)
	const [clipped, setClipped] = useState(false)
	useLayoutEffect(() => {
		const el = ref.current
		setClipped(!!el && el.scrollWidth > el.clientWidth + 1)
	})
	return [ref, clipped]
}

/** Markdown as the plain words it shows (for its one line), paragraphs kept apart. */
function markdownPlain(md: string): string {
	return md
		.replace(/^\s*(```|~~~).*$/gm, '')
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		.replace(/^\s{0,3}#{1,6}\s+/gm, '')
		.replace(/^\s*>\s?/gm, '')
		.replace(/^\s*([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/gm, '')
		.replace(/^\s*([-*_]\s*){3,}$/gm, '')
		.replace(/(\*\*|__|~~|`)/g, '')
		.replace(/(^|[\s(])[*_](\S(?:.*?\S)?)[*_](?=[\s).,;:!?]|$)/gm, '$1$2')
		.replace(/\n{2,}/g, '\n')
		.trim()
}

/** Dark or white text, whichever reads better on `fill` (a CSS hex or rgb colour). */
function readableOn(fill: string): string {
	const DARK = '#0d0d0f'
	let rgb: number[] | null = null
	const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(fill.trim())
	if (hex) {
		const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1]
		rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
	} else {
		const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(fill.trim())
		if (m) rgb = [m[1], m[2], m[3]].map(Number)
	}
	if (!rgb) return DARK
	const lum = (c: number[]) => {
		const [r, g, b] = c.map((v) => {
			const s = v / 255
			return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
		})
		return 0.2126 * r + 0.7152 * g + 0.0722 * b
	}
	const l = lum(rgb)
	const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
	return contrast(l, lum([13, 13, 15])) >= contrast(l, 1) ? DARK : '#ffffff'
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
		// (its subagents are its own work, not a tool worth naming)
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

function LockIcon() {
	return icon(
		<>
			<rect x="5" y="11" width="14" height="9" rx="2" />
			<path d="M8 11V8a4 4 0 0 1 8 0v3" />
		</>,
		{ width: 12, height: 12, strokeWidth: 2, className: 'pt-lock' },
	)
}

function CheckIcon() {
	return icon(<path d="m5 12 5 5 9-10" />, { width: 12, height: 12, strokeWidth: 2.6, className: 'pt-check' })
}
