import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { sessionColor } from '../../../shared/sessionColor'
import type { Item } from '../../../shared/types'
import type { Editor } from '../editor/Editor'
import { forDrawer, loadHtml } from '../render/HtmlLinks'
import { copyText } from '../render/Renderer'
import { url as withBase } from '../base'
import { useValue } from './useValue'
import './htmlDrawer.css'

const WIDTH_KEY = 'canvas.htmlDrawerWidth'
const MODE_KEY = 'canvas.htmlDrawerMode'
const MIN_WIDTH = 360
/** The canvas always shows at least this much to the left of a resized drawer. */
const MIN_GAP = 48
const COPIED_MS = 1400

/**
 * Scripts and forms work, and links open in new tabs (popups, which leave the sandbox so the sites
 * they open work normally). No allow-same-origin: with scripts that would let the page reach into
 * this one (its storage and the canvas API), so it keeps the opaque origin it has on the canvas.
 */
const SANDBOX = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads'

/** For the page it was made for: an iframe's srcdoc is never changed in place (Chrome can leave it blank). */
type Doc = { key: string; srcdoc?: string; src?: string }
/**
 * "fit": scrolls and fits the drawer's width (see forDrawer). "original": exactly as authored, at
 * its design size like on the canvas, 1:1 in a box the drawer scrolls both ways.
 */
type Mode = 'fit' | 'original'

/**
 * An HTML item in a large panel over the right of the canvas, where the page takes input (on the
 * canvas, HTML items behave like images). The rest of the app is inert and dimmed until it's
 * closed: with ×, Esc (while focus isn't in the page), or a click on the dimmed canvas.
 * ←/→ step through the other HTML items in its group.
 */
export function HtmlDrawer({ editor }: { editor: Editor }) {
	const item = useValue(() => {
		const id = editor.htmlDrawer.get()
		return id ? (editor.items.get()[id] ?? null) : null
	})
	const openId = useValue(() => editor.htmlDrawer.get())
	// The last item stays on screen while the drawer slides out.
	const [shown, setShown] = useState<Item | null>(item)
	if (item && item !== shown) setShown(item)
	if (!item && shown && reducedMotion()) setShown(null)

	// Its item was deleted.
	useEffect(() => {
		if (openId && !item) editor.closeHtmlDrawer()
	}, [openId, item, editor])

	if (!shown) return null
	return <Drawer editor={editor} item={shown} closing={!item} onClosed={() => setShown(null)} />
}

function Drawer({ editor, item, closing, onClosed }: { editor: Editor; item: Item; closing: boolean; onClosed: () => void }) {
	const rootRef = useRef<HTMLDivElement>(null)
	const panelRef = useRef<HTMLDivElement>(null)
	const [width, setWidth] = useState(loadWidth)
	const [resizing, setResizing] = useState(false)
	const [copied, setCopied] = useState(false)
	const [doc, setDoc] = useState<Doc | null>(null)
	const [mode, setMode] = useState(loadMode)
	const session = useValue(() => editor.sessions.get()[item.sessionId], [item.sessionId])
	const siblings = useValue(() => htmlSiblings(editor, item.id), [item.id])
	const src = withBase(item.src)
	const href = new URL(src, location.href).href
	const close = () => editor.closeHtmlDrawer()
	const step = (by: number) => {
		const i = siblings.indexOf(item.id)
		if (i < 0 || siblings.length < 2) return
		editor.openHtmlDrawer(siblings[(i + by + siblings.length) % siblings.length])
	}
	const stepRef = useRef(step)
	stepRef.current = step

	const docKey = `${item.id}:${mode}`
	useEffect(() => {
		let live = true
		loadHtml(src).then((html) => {
			if (live) setDoc(html === null ? { key: docKey, src } : { key: docKey, srcdoc: forDrawer(html, src, mode === 'fit') })
		})
		return () => {
			live = false
		}
	}, [src, mode, docKey])

	// The rest of the app takes no input (pointer, focus or keys) while the drawer is open.
	useLayoutEffect(() => {
		const root = rootRef.current!
		const others = Array.from(root.parentElement?.children ?? []).filter((el): el is HTMLElement => el !== root && el instanceof HTMLElement && !el.inert)
		for (const el of others) el.inert = true
		const before = document.activeElement as HTMLElement | null
		panelRef.current?.focus({ preventScroll: true })
		return () => {
			for (const el of others) el.inert = false
			if (before?.isConnected) before.focus({ preventScroll: true })
		}
	}, [])

	// Keys pressed outside the page (which gets its own while focused) never reach the canvas.
	useEffect(() => {
		if (closing) return
		const onKey = (e: KeyboardEvent) => {
			e.stopPropagation()
			if (e.key === 'Escape') {
				e.preventDefault()
				editor.closeHtmlDrawer()
			} else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
				e.preventDefault()
				stepRef.current(e.key === 'ArrowLeft' ? -1 : 1)
			}
		}
		window.addEventListener('keydown', onKey, true)
		return () => window.removeEventListener('keydown', onKey, true)
	}, [closing, editor])

	const copy = async () => {
		try {
			await copyText(href)
			setCopied(true)
			setTimeout(() => setCopied(false), COPIED_MS)
		} catch (e) {
			console.error('copying the link failed', e)
		}
	}

	const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
		if (e.button !== 0) return
		e.preventDefault()
		const handle = e.currentTarget
		handle.setPointerCapture(e.pointerId)
		setResizing(true)
		let w = panelRef.current?.offsetWidth ?? width ?? MIN_WIDTH
		const move = (ev: PointerEvent) => {
			w = clampWidth(window.innerWidth - ev.clientX)
			setWidth(w)
		}
		const up = () => {
			handle.removeEventListener('pointermove', move)
			handle.removeEventListener('pointerup', up)
			handle.removeEventListener('pointercancel', up)
			setResizing(false)
			saveWidth(w)
		}
		handle.addEventListener('pointermove', move)
		handle.addEventListener('pointerup', up)
		handle.addEventListener('pointercancel', up)
	}

	const title = item.title || item.name
	const untitledSession = !session?.title.trim() || session.title === session.id
	const index = siblings.indexOf(item.id)

	return (
		<div
			ref={rootRef}
			className={`html-drawer${closing ? ' closing' : ''}${resizing ? ' resizing' : ''}`}
			onAnimationEnd={(e) => closing && e.target === panelRef.current && onClosed()}
		>
			<div className="html-drawer-scrim" onClick={close} />
			<div
				ref={panelRef}
				className="html-drawer-panel"
				role="dialog"
				aria-modal="true"
				aria-label={title}
				tabIndex={-1}
				style={width ? { width: `min(${width}px, calc(100vw - ${MIN_GAP}px))` } : undefined}
			>
				<div
					className="html-drawer-resize"
					title="Drag to resize · double-click to reset"
					onPointerDown={startResize}
					onDoubleClick={() => {
						setWidth(null)
						saveWidth(null)
					}}
				/>
				<div className="html-drawer-head">
					<div className="html-drawer-titles">
						<div className="html-drawer-title" title={item.name}>
							{title}
						</div>
						<div className="html-drawer-session">
							<span className="html-drawer-dot" style={{ background: sessionColor(item.sessionId) }} />
							<span className={untitledSession ? 'untitled' : undefined}>{untitledSession ? 'Untitled session' : session!.title}</span>
							{item.group && <span className="html-drawer-group">· {item.group}</span>}
						</div>
					</div>
					{siblings.length > 1 && (
						<div className="html-drawer-steps">
							<button title="Previous HTML page in this group (←)" onClick={() => step(-1)}>
								<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
									<path d="m15 6-6 6 6 6" />
								</svg>
							</button>
							<span>
								{index + 1} / {siblings.length}
							</span>
							<button title="Next HTML page in this group (→)" onClick={() => step(1)}>
								<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
									<path d="m9 6 6 6-6 6" />
								</svg>
							</button>
						</div>
					)}
					<div className="html-drawer-mode" role="group" aria-label="Page size">
						{(['fit', 'original'] as const).map((m) => (
							<button
								key={m}
								aria-pressed={mode === m}
								title={m === 'fit' ? 'Reflow the page to the panel’s width, scrolling down' : 'The page exactly as on the canvas, at its design size'}
								onClick={() => {
									setMode(m)
									saveMode(m)
								}}
							>
								{m === 'fit' ? 'Fit width' : 'Original size'}
							</button>
						))}
					</div>
					<div className="html-drawer-actions">
						<a href={href} target="_blank" rel="noreferrer" title="Open in a new tab">
							<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
								<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
							</svg>
						</a>
						<button className={copied ? 'copied' : undefined} title={copied ? 'Copied' : 'Copy link to the file'} onClick={copy}>
							{copied ? (
								<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
									<path d="m5 12.5 4.5 4.5L19 7.5" />
								</svg>
							) : (
								<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
									<path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5" />
									<path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5" />
								</svg>
							)}
						</button>
						<button className="html-drawer-close" title="Close (Esc)" onClick={close}>
							<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
								<path d="M6 6l12 12M18 6 6 18" />
							</svg>
						</button>
					</div>
				</div>
				<div className={`html-drawer-body ${mode}`}>
					{doc?.key === docKey && (
						<iframe
							key={doc.key}
							title={title}
							sandbox={SANDBOX}
							style={mode === 'original' ? { width: item.width, height: item.height } : undefined}
							srcDoc={doc.srcdoc}
							src={doc.src}
						/>
					)}
				</div>
			</div>
		</div>
	)
}

/** The HTML items in the item's group, in layout order. */
function htmlSiblings(editor: Editor, id: string): string[] {
	const items = editor.items.get()
	const group = editor.layout.get().groups.find((g) => g.itemIds.includes(id))
	return group ? group.itemIds.filter((i) => items[i]?.kind === 'html') : [id]
}

function reducedMotion() {
	return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

function clampWidth(w: number) {
	return Math.round(Math.max(MIN_WIDTH, Math.min(w, window.innerWidth - MIN_GAP)))
}

function loadWidth(): number | null {
	try {
		const n = Number(localStorage.getItem(WIDTH_KEY))
		return Number.isFinite(n) && n >= MIN_WIDTH ? n : null
	} catch {
		return null
	}
}

function loadMode(): Mode {
	try {
		return localStorage.getItem(MODE_KEY) === 'original' ? 'original' : 'fit'
	} catch {
		return 'fit'
	}
}

function saveMode(mode: Mode) {
	try {
		localStorage.setItem(MODE_KEY, mode)
	} catch {}
}

function saveWidth(w: number | null) {
	try {
		if (w === null) localStorage.removeItem(WIDTH_KEY)
		else localStorage.setItem(WIDTH_KEY, String(w))
	} catch {}
}
