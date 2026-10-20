import { clearCache, layout, layoutNextLine, layoutWithLines, measureNaturalWidth, prepare, prepareWithSegments } from '@chenglou/pretext'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import type { Editor } from '../editor/Editor'
import { onOpenCodeEvents } from '../opencode/events'
import type { Conjure, LastExchange, PromptAttachment, PromptTarget, TalkBlock } from '../multiplayer/Conjure'
import { markdownToHtml } from './markdown'
import { useValue } from './useValue'
import './promptThread.css'

/** the stack's corner sits this far from the pointer (left, below; above when it flips) */
const ANCHOR_X = 24
const ANCHOR_Y = 44
/** and stays this far inside the window */
const MARGIN = 8
/** the widest a bubble gets (the input always is this wide) */
const BUBBLE_MAX = 360
/** a bubble's horizontal padding, and the input's border */
const PAD_X = 12
const INPUT_BORDER = 3
/** the text in the bubbles: pretext measures with this, so the CSS uses the same (named fonts measure true on every platform) */
const FONT_FAMILY = `Inter, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`
const FONT = `13px ${FONT_FAMILY}`
const LINE_PX = 20
/** room for one line of text in a full-width bubble */
const LINE_MAX = BUBBLE_MAX - 2 * PAD_X
/** the textarea's width: the input bubble less its border and padding (10 left, 8 right) */
const TEXTAREA_W = BUBBLE_MAX - 2 * INPUT_BORDER - 18
/** the input grows to this many lines while focused, then scrolls */
const INPUT_MAX_LINES = 8
/** prompt chips in the one-line bubble: size, gap, how many before "+n" */
const CHIP_PX = 18
const CHIP_GAP = 4
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
	x: number
	y: number
	thinking: boolean
	asleep: boolean
	block: TalkBlock
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
 * The prompt stack under a clicked conjured worm: three bubbles floating one above the other, each
 * one line until clicked (pretext lays the text out to find that line): your last prompt and its
 * reply in the worm's colour (the reply's live last line while it works), then the input, outlined
 * in that colour, for its owner (send, steer, stop, attach). Everyone else gets a note on whose it is.
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
	return <PromptStack key={target.sessionId} conjure={conjure} target={target} meta={meta} />
}

function PromptStack({ conjure, target, meta }: { conjure: Conjure; target: PromptTarget; meta: Meta }) {
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
	const [expanded, setExpanded] = useState<Expanded>(null)
	const [typing, setTyping] = useState(false)
	const [dragging, setDragging] = useState(false)
	const [activity, setActivity] = useState<string | null>(null)
	const [size, setSize] = useState<{ w: number; h: number } | null>(null)
	const [fonts, setFonts] = useState(0)
	const [, setTick] = useState(0)
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
			// (the stack keeps what it has; sending says if OpenCode can't be reached)
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

	// The elapsed time keeps moving.
	useEffect(() => {
		if (!thinking) return
		const t = window.setInterval(() => setTick((n) => n + 1), 1000)
		return () => window.clearInterval(t)
	}, [thinking])
	useEffect(() => () => window.clearTimeout(flashTimer.current), [])

	// Widths measured before a font loaded are the fallback's: lay the lines out again.
	useEffect(() => {
		const fontSet = document.fonts
		if (!fontSet) return
		const reflow = () => {
			clearCache()
			setFonts((n) => n + 1)
		}
		fontSet.addEventListener('loadingdone', reflow)
		return () => fontSet.removeEventListener('loadingdone', reflow)
	}, [])

	// Focused as soon as there's somewhere to type.
	useEffect(() => {
		if (owner) inputRef.current?.focus()
	}, [owner])

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

	// A click away (not a drag or a pan) collapses what's open, else closes the stack; unless that
	// click opened it again (on its pointer) or another worm's.
	useEffect(() => {
		let down: { x: number; y: number; opened: PromptTarget | null } | null = null
		const outside = (e: Event) => !rootRef.current?.contains(e.target as Node)
		const onDown = (e: PointerEvent) => {
			down = outside(e) ? { x: e.clientX, y: e.clientY, opened: conjure.prompting.peek() } : null
		}
		const onUp = (e: PointerEvent) => {
			const d = down
			down = null
			if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_SLOP_PX) return
			window.setTimeout(() => {
				if (conjure.prompting.peek() !== d.opened) return
				setMenu(null)
				if (expandedRef.current) setExpanded(null)
				else conjure.close()
			})
		}
		// Esc with nothing focused (after clicking a bubble open) collapses it too, then closes.
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== 'Escape' || (document.activeElement && document.activeElement !== document.body)) return
			e.preventDefault()
			if (expandedRef.current) setExpanded(null)
			else conjure.close()
		}
		window.addEventListener('pointerdown', onDown, true)
		window.addEventListener('pointerup', onUp, true)
		window.addEventListener('keydown', onKey)
		return () => {
			window.removeEventListener('pointerdown', onDown, true)
			window.removeEventListener('pointerup', onUp, true)
			window.removeEventListener('keydown', onKey)
		}
	}, [conjure])

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

	// One line each, laid out by pretext.
	const chips = lastPrompt ? Math.min(lastPrompt.images.length, CHIPS_MAX) + (lastPrompt.images.length > CHIPS_MAX ? 1 : 0) : 0
	const chipsW = chips ? chips * (CHIP_PX + CHIP_GAP) : 0
	const promptLine = useMemo(() => (lastPrompt ? firstLine(lastPrompt.text, LINE_MAX - chipsW) : null), [lastPrompt?.text, chipsW, fonts])
	const replyPlain = useMemo(() => (reply ? markdownPlain(reply) : ''), [reply])
	const replyLine = useMemo(() => (replyPlain ? (thinking ? lastLine(replyPlain, LINE_MAX) : firstLine(replyPlain, LINE_MAX)) : null), [replyPlain, thinking, fonts])
	const replyMore = !!replyLine && (replyLine.cut || /\n/.test(replyPlain))
	const promptMore = !!lastPrompt && (!!promptLine?.cut || prompts.length > 1 || lastPrompt.images.length > 0 || /\n/.test(lastPrompt.text))

	// The input: one line until it's focused, then as many as it has (pretext counts them), up to a point.
	const inputLines = useMemo(() => (text ? layout(prepare(text, FONT, { whiteSpace: 'pre-wrap' }), TEXTAREA_W, LINE_PX).lineCount + (text.endsWith('\n') ? 1 : 0) : 1), [text, fonts])
	const draftLine = useMemo(() => (!typing && inputLines > 1 ? firstLine(text, TEXTAREA_W) : null), [typing, inputLines, text, fonts])

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
		if ((!prompt && !attachments.length) || sending || !owner) return
		const msg: LocalMessage = { id: `local-${++localIds}`, text: prompt, images: attachments.map((a) => a.dataUrl), status: 'sending', steer: thinking }
		if (!thinking) staleChat.current = live
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
	const h = size?.h ?? 0
	let left = meta.x - ANCHOR_X
	let top = meta.y + ANCHOR_Y
	if (top + h > vh - MARGIN && meta.y - ANCHOR_Y - h >= MARGIN) top = meta.y - ANCHOR_Y - h
	left = Math.round(Math.max(MARGIN, Math.min(left, vw - w - MARGIN)))
	top = Math.round(Math.max(MARGIN, Math.min(top, vh - h - MARGIN)))
	/** the ⋯ and × go on the stack's right, or its left with no room there */
	const ctlSide = left + w + 40 > vw ? 'left' : 'right'

	const hasContent = !!text.trim() || attachments.length > 0
	const empty = !lastPrompt && !reply && !thinking
	const ink = readableOn(color)
	const busyLine = `${stopping ? 'Stopping' : 'Thinking'} ${mmss(Date.now() - turnStart)}${activity ? ` · ${activity}` : ''}`
	const busyFit = useMemo(() => firstLine(busyLine, LINE_MAX - 18), [busyLine, fonts])
	const roText =
		block === 'unowned'
			? 'Nobody has conjured it: its session called it up to show you something. To talk to it, conjure the session from your OpenCode (Conjure, or C over its frame).'
			: block === 'not-yours'
				? `Only the browser that conjured it can talk to it. ${asleep ? 'It wakes up when its owner opens this canvas.' : 'You can watch it think and reply.'}`
				: 'You conjured it, but this browser no longer has its OpenCode. Pair it again (Conjure → Servers) to wake it.'
	const roLabel = `Read-only${asleep ? ' · asleep' : ''} · `
	const roLine = useMemo(() => firstLine(roLabel + roText, LINE_MAX - 18), [roLabel, roText, fonts])

	return (
		<div
			ref={rootRef}
			className={`pt${dragging ? ' dragging' : ''}`}
			style={{ left, top, ['--c' as string]: color, ['--ink' as string]: ink }}
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
						{promptLine && promptLine.text && (
							<span className="pt-line" style={{ width: promptLine.width }}>
								{promptLine.text}
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
					<span className="pt-line" style={{ width: busyFit.width }}>
						{busyFit.text}
					</span>
				</div>
			) : replyLine ? (
				<div
					className={`pt-b pt-fill${thinking ? ' busy' : ''}${replyMore ? ' can' : ''}`}
					data-b="reply"
					title={replyMore ? 'Show the whole reply' : undefined}
					onPointerDown={expandOn('reply', replyMore)}
				>
					<span className="pt-line" style={{ width: replyLine.width }}>
						{replyLine.text}
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
					className={`pt-b pt-ro${expanded === 'note' ? ' pt-open' : roLine.cut ? ' can' : ''}`}
					data-b="note"
					onPointerDown={expandOn('note', roLine.cut)}
					title={expanded === 'note' ? undefined : roText}
				>
					{expanded === 'note' ? (
						<div className="pt-ro-full">
							<b>
								<LockIcon /> Read-only
								{asleep && (
									<span className="pt-asleep">
										<MoonIcon /> asleep
									</span>
								)}
							</b>
							{roText}
						</div>
					) : (
						<>
							<LockIcon />
							<span className="pt-line" style={{ width: roLine.width }}>
								{roLine.text}
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
							style={{
								height: (typing ? Math.min(inputLines, INPUT_MAX_LINES) : 1) * LINE_PX,
								overflowY: typing && inputLines > INPUT_MAX_LINES ? 'auto' : 'hidden',
								color: draftLine ? 'transparent' : undefined,
							}}
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
						{draftLine && <div className="pt-ta-line">{draftLine.text}</div>}
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
					<button role="menuitem" className="pt-danger" onClick={() => setMenu('banish')}>
						Banish… <span className="pt-dim">removes it for everyone</span>
					</button>
				</div>
			)}
			{menu === 'banish' && (
				<div className={`pt-menu pt-confirm ${ctlSide}`} role="dialog">
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
	)
}

/** Buttons in the input keep the textarea focused, so it doesn't shrink under the pointer mid-click. */
function keepFocus(e: ReactPointerEvent) {
	e.preventDefault()
}

// ---------- one line, by pretext ----------

interface Line {
	text: string
	/** its width in px, as pretext measured it (the bubble shrink-wraps to it) */
	width: number
	/** there's more than this line */
	cut: boolean
}

const ELLIPSIS = '…'
let ellipsisWidth = 0
function ellipsisPx() {
	return (ellipsisWidth ||= measureNaturalWidth(prepare(ELLIPSIS, FONT)))
}

/** The first line `text` (its spaces and line breaks collapsed) takes at `max` px, with … when there's more. */
function firstLine(text: string, max: number): Line {
	const flat = text.replace(/\s+/g, ' ').trim()
	if (!flat) return { text: '', width: 0, cut: false }
	// (one line never needs more than this much of it)
	const head = flat.length > 400 ? flat.slice(0, 400) : flat
	const prepared = prepareWithSegments(head, FONT)
	const whole = layoutNextLine(prepared, max)
	if (whole && head === flat && layoutNextLine(prepared, max, whole.end) === null) return { text: flat, width: Math.ceil(whole.width), cut: false }
	const line = layoutNextLine(prepared, max - ellipsisPx())
	const kept = (line?.text ?? '').trimEnd().replace(/[\s,;:.\-–—]+$/, '')
	const cut = kept + ELLIPSIS
	return { text: cut, width: Math.min(max, Math.ceil(measureNaturalWidth(prepare(cut, FONT)))), cut: true }
}

/** The last line of `text`'s last paragraph at `max` px (what's being written now), with … before it when there's more. */
function lastLine(text: string, max: number): Line {
	const paragraphs = text.split('\n').map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean)
	const last = paragraphs[paragraphs.length - 1]
	if (!last) return { text: '', width: 0, cut: false }
	const earlier = paragraphs.length > 1
	const one = layoutWithLines(prepareWithSegments(last, FONT), max, LINE_PX)
	if (one.lineCount <= 1 && !earlier) return { text: last, width: Math.ceil(one.lines[0]?.width ?? 0), cut: false }
	const { lines } = layoutWithLines(prepareWithSegments(last, FONT), max - ellipsisPx(), LINE_PX)
	const line = lines[lines.length - 1]
	return { text: ELLIPSIS + (line?.text ?? '').trim(), width: Math.min(max, Math.ceil((line?.width ?? 0) + ellipsisPx())), cut: true }
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
		// (subagents show on the canvas as baby pointers, never here)
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
		{ width: 12, height: 12, strokeWidth: 2, className: 'pt-lock' },
	)
}

function CheckIcon() {
	return icon(<path d="m5 12 5 5 9-10" />, { width: 12, height: 12, strokeWidth: 2.6, className: 'pt-check' })
}
