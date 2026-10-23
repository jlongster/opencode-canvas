import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { sessionColor } from '../../../shared/sessionColor'
import type { Item } from '../../../shared/types'
import { opensInDrawer, type Editor } from '../editor/Editor'
import { forDrawer, loadHtml } from '../render/HtmlLinks'
import { pageDomain } from '../render/PageBadges'
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
/**
 * A page item's web page loads straight from the viewer's browser (the canvas server never fetches
 * it). Its own origin keeps its cookies and storage working; it can't reach into this page since
 * that's another origin (unless it is this one: then it stays opaque, like an HTML item).
 */
const PAGE_SANDBOX = `${SANDBOX} allow-same-origin`
/**
 * Browsers don't tell the embedding page when a site refuses to be framed (X-Frame-Options, CSP
 * frame-ancestors): the frame loads an error page that looks like any other cross-origin page. So a
 * page that hasn't loaded after this long shows the fallback (and the page, should it still load).
 */
const PAGE_TIMEOUT_MS = 10_000
/** How long the "Not showing?" hint stays after a page loads. */
const HINT_MS = 8000
/** Sites known to refuse framing everywhere: no point waiting for their error page. */
const REFUSES_FRAMING =
	/(^|\.)(x\.com|twitter\.com|github\.com|facebook\.com|instagram\.com|linkedin\.com|reddit\.com|stackoverflow\.com|news\.ycombinator\.com)$|^(www\.)?google\.com$/i

/** For the page it was made for: an iframe's srcdoc is never changed in place (Chrome can leave it blank). */
type Doc = { key: string; srcdoc?: string; src?: string }
/**
 * "fit": scrolls and fits the drawer's width (see forDrawer). "original": exactly as authored, at
 * its design size like on the canvas, 1:1 in a box the drawer scrolls both ways.
 */
type Mode = 'fit' | 'original'

/**
 * An HTML item, or a page item's live web page, in a large panel over the right of the canvas,
 * where the page takes input (on the canvas, they behave like images). The rest of the app is inert
 * and dimmed until it's closed: with ×, Esc (while focus isn't in the page), or a click on the
 * dimmed canvas. ←/→ step through the other HTML items and pages in its group.
 */
export function HtmlDrawer({ editor }: { editor: Editor }) {
	const item = useValue(() => {
		const id = editor.htmlDrawer.get()
		const item = id ? editor.items.get()[id] : undefined
		// (its file may have been replaced by an image or video)
		return opensInDrawer(item) ? item : null
	})
	const openId = useValue(() => editor.htmlDrawer.get())
	// The last item stays on screen while the drawer slides out.
	const [shown, setShown] = useState<Item | null>(item)
	if (item && item !== shown) setShown(item)
	if (!item && shown && reducedMotion()) setShown(null)

	// Its item was deleted, or isn't a page anymore.
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
	const siblings = useValue(() => drawerSiblings(editor, item.id), [item.id])
	const isPage = item.kind === 'page'
	const src = withBase(item.src)
	// What "Open in a new tab" opens and Copy link copies: the web page, or the hosted file.
	const href = isPage ? item.pageUrl! : new URL(src, location.href).href
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
		if (isPage) return
		let live = true
		loadHtml(src).then((html) => {
			if (live) setDoc(html === null ? { key: docKey, src } : { key: docKey, srcdoc: forDrawer(html, src, mode === 'fit') })
		})
		return () => {
			live = false
		}
	}, [isPage, src, mode, docKey])

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

	const domain = isPage ? pageDomain(item) : hostOf(href)
	const title = item.title?.trim() || (isPage ? domain : item.name)
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
						<div className="html-drawer-title-row">
							<div className="html-drawer-title" title={isPage ? title : item.name}>
								{title}
							</div>
							<div className="html-drawer-domain" title={href}>
								{domain}
							</div>
						</div>
						<div className="html-drawer-session">
							<span className="html-drawer-dot" style={{ background: sessionColor(item.sessionId) }} />
							<span className={untitledSession ? 'untitled' : undefined}>{untitledSession ? 'Untitled session' : session!.title}</span>
							{item.group && <span className="html-drawer-group">· {item.group}</span>}
						</div>
					</div>
					{siblings.length > 1 && (
						<div className="html-drawer-steps">
							<button title="Previous page in this group (←)" onClick={() => step(-1)}>
								<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
									<path d="m15 6-6 6 6 6" />
								</svg>
							</button>
							<span>
								{index + 1} / {siblings.length}
							</span>
							<button title="Next page in this group (→)" onClick={() => step(1)}>
								<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
									<path d="m9 6 6 6-6 6" />
								</svg>
							</button>
						</div>
					)}
					{/* A live web page lays itself out for the panel: it has no design size of its own. */}
					{!isPage && (
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
					)}
					<div className="html-drawer-actions">
						<a href={href} target="_blank" rel="noreferrer" title="Open in a new tab" aria-label="Open in a new tab">
							<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
								<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
							</svg>
						</a>
						<button className={copied ? 'copied' : undefined} title={copied ? 'Copied' : isPage ? 'Copy link to the page' : 'Copy link to the file'} onClick={copy}>
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
				<div className={`html-drawer-body ${isPage ? 'fit' : mode}`}>
					{isPage && <PageFrame key={item.id} item={item} url={href} domain={domain} title={title} />}
					{!isPage && doc?.key === docKey && (
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

type Blocked = 'mixed' | 'refused' | 'timeout' | 'chosen'
type PageState = { status: 'loading' | 'loaded' } | { status: 'blocked'; why: Blocked }

/**
 * A page item's web page, loaded by the viewer's browser. Where it can't be shown (see
 * PAGE_TIMEOUT_MS), its screenshot if it has one, with a way to open it in a new tab. Chrome shows
 * its own error page in a frame a site refuses, which looks loaded from here: for a while after
 * loading, a hint offers the same fallback.
 */
function PageFrame({ item, url, domain, title }: { item: Item; url: string; domain: string; title: string }) {
	const frameRef = useRef<HTMLIFrameElement>(null)
	const loadedRef = useRef(false)
	const [state, setState] = useState<PageState>(() => {
		const why = framingBlocked(url)
		return why ? { status: 'blocked', why } : { status: 'loading' }
	})
	const [hint, setHint] = useState(false)
	const neverLoads = state.status === 'blocked' && (state.why === 'mixed' || state.why === 'refused')

	useEffect(() => {
		if (state.status !== 'loading') return
		const timer = setTimeout(() => setState((s) => (s.status === 'loading' ? { status: 'blocked', why: 'timeout' } : s)), PAGE_TIMEOUT_MS)
		return () => clearTimeout(timer)
	}, [state.status])

	useEffect(() => {
		if (!hint) return
		const timer = setTimeout(() => setHint(false), HINT_MS)
		return () => clearTimeout(timer)
	}, [hint])

	const onLoad = () => {
		const frame = frameRef.current
		if (!frame) return
		// Some browsers leave a refused page's frame on a blank document of this origin: one that can
		// be read is not the site. (A loaded cross-origin site can't be read.)
		let readable = false
		try {
			readable = !!frame.contentDocument
		} catch {}
		if (readable && !sameOrigin(url)) return setState({ status: 'blocked', why: 'refused' })
		loadedRef.current = true
		setState((s) => (s.status === 'blocked' && s.why === 'chosen' ? s : { status: 'loaded' }))
		setHint(true)
	}

	return (
		<>
			{!neverLoads && (
				<iframe
					ref={frameRef}
					title={title}
					sandbox={sameOrigin(url) ? SANDBOX : PAGE_SANDBOX}
					src={url}
					referrerPolicy="no-referrer"
					allow="fullscreen; clipboard-write"
					style={state.status === 'blocked' ? { visibility: 'hidden' } : undefined}
					onLoad={onLoad}
				/>
			)}
			{state.status === 'loading' && <div className="html-drawer-loading">Loading {domain}…</div>}
			{state.status === 'loaded' && hint && (
				<div className="html-drawer-hint">
					<span>Not showing?</span>
					{item.src && (
						<>
							<button
								onClick={() => {
									setHint(false)
									setState({ status: 'blocked', why: 'chosen' })
								}}
							>
								Show screenshot
							</button>
							<span className="sep">·</span>
						</>
					)}
					<a href={url} target="_blank" rel="noreferrer">
						Open in new tab ↗
					</a>
				</div>
			)}
			{state.status === 'blocked' && (
				<div className={`html-drawer-fallback${item.src ? '' : ' no-shot'}`}>
					<div className="html-drawer-notice" role="status">
						<div className="html-drawer-notice-text">
							<span>This site can’t be shown here</span>
							<span className="sep">·</span>
							<a href={url} target="_blank" rel="noreferrer">
								Open in new tab ↗
							</a>
						</div>
						<div className="html-drawer-notice-why">
							{blockedReason(state.why, domain)}
							{!neverLoads && (
								<button className="html-drawer-retry" onClick={() => setState({ status: loadedRef.current ? 'loaded' : 'loading' })}>
									Show the page anyway
								</button>
							)}
						</div>
					</div>
					{item.src && (
						<div className="html-drawer-shot">
							<img src={withBase(item.src)} alt={`Screenshot of ${title}`} />
						</div>
					)}
				</div>
			)}
		</>
	)
}

function blockedReason(why: Blocked, domain: string) {
	if (why === 'mixed') return 'It’s an http:// page: browsers block insecure pages inside this https:// canvas.'
	if (why === 'refused') return `${domain} doesn’t allow other sites to show it in a frame.`
	if (why === 'timeout') return `${domain} didn’t load. It may not allow other sites to show it in a frame.`
	return `${domain} may not allow other sites to show it in a frame.`
}

/** Why a page can't load in the drawer at all, when that's known before trying. */
function framingBlocked(url: string): 'mixed' | 'refused' | null {
	let u: URL
	try {
		u = new URL(url)
	} catch {
		return 'refused'
	}
	// Mixed content: blocked, except for local addresses (browsers treat those as secure).
	if (location.protocol === 'https:' && u.protocol === 'http:' && !isLocalHost(u.hostname)) return 'mixed'
	if (REFUSES_FRAMING.test(u.hostname)) return 'refused'
	return null
}

function isLocalHost(host: string) {
	return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host)
}

function sameOrigin(url: string): boolean | null {
	try {
		return new URL(url).origin === location.origin
	} catch {
		return null
	}
}

function hostOf(url: string) {
	try {
		return new URL(url).host.replace(/^www\./, '')
	} catch {
		return ''
	}
}

/** The HTML items and pages in the item's group, in layout order. */
function drawerSiblings(editor: Editor, id: string): string[] {
	const items = editor.items.get()
	const group = editor.layout.get().groups.find((g) => g.itemIds.includes(id))
	return group ? group.itemIds.filter((i) => opensInDrawer(items[i])) : [id]
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
