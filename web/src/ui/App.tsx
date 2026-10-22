import { useEffect, useRef, useState, type JSX } from 'react'
import { Editor, type ToolId } from '../editor/Editor'
import { describeError, Renderer } from '../render/Renderer'
import { atom, react } from '../state/signals'
import { sessionColor } from '../../../shared/sessionColor'
import type { Canvas, SessionLink } from '../../../shared/types'
import { frameKey } from '../editor/selection'
import {
	connectCanvas, deleteItem, deleteSession, editUrl, restoreDeleted, listUrl, renameCanvas, setSessionHidden, setSessionOrder, viewUrl, type CanvasLink,
} from '../sync/client'
import { listenForPastedPages } from './pastePage'
import { Attention } from '../multiplayer/Attention'
import { SessionControl } from '../multiplayer/SessionControl'
import { FrameTitles } from '../opencode/frameTitles'
import { PeerCursors } from '../multiplayer/PeerCursors'
import { Presence } from '../multiplayer/Presence'
import { SharedAnnotations } from '../multiplayer/SharedAnnotations'
import { SubmitAnnotations } from '../multiplayer/SubmitAnnotations'
import { SharedNotes } from '../multiplayer/SharedNotes'
import { AttentionTray } from './Attention'
import { FrameAsks } from './FrameAsks'
import { SessionsButton } from './Sessions'
import { SessionPrompt } from './PromptThread'
import { CursorChat } from './CursorChat'
import { DeepLink } from './deepLink'
import { FramesStatus, HiddenLinkToast } from './FramesPanel'
import { HtmlDrawer } from './HtmlDrawer'
import { NotFound } from './NotFound'
import { SeedPicker } from './SeedPicker'
import { FollowIndicator, PresenceBar } from './PresenceBar'
import { useValue } from './useValue'
import { API_BASE } from '../base'

/** The last used select/hand tool is remembered across reloads; the note and annotate tools never are. */
const TOOL_KEY = 'canvas.tool'

function loadTool(): ToolId {
	try {
		return localStorage.getItem(TOOL_KEY) === 'hand' ? 'hand' : 'select'
	} catch {
		return 'select'
	}
}

function saveTool(tool: ToolId) {
	if (tool !== 'select' && tool !== 'hand') return
	try {
		localStorage.setItem(TOOL_KEY, tool)
	} catch {}
}

/** A canvas page. Edit links (/c/:id) and view links (/v/:viewKey) show the same live canvas. */
export function App({ link }: { link: CanvasLink }) {
	const [gone, setGone] = useState<'missing' | 'deleted' | null>(null)
	if (gone) {
		return gone === 'deleted' ? (
			<NotFound message="This canvas was deleted." hint="Its sessions and notes are gone." />
		) : (
			<NotFound message="This canvas doesn't exist." hint="The link may be wrong, or the canvas was deleted." />
		)
	}
	return <CanvasPage link={link} onGone={(loaded) => setGone(loaded ? 'deleted' : 'missing')} />
}

function CanvasPage({ link, onGone }: { link: CanvasLink; onGone: (wasLoaded: boolean) => void }) {
	const containerRef = useRef<HTMLDivElement>(null)
	const canvasRef = useRef<HTMLCanvasElement>(null)
	const overlayRef = useRef<HTMLDivElement>(null)
	const [editor] = useState(() => new Editor())
	const [error, setError] = useState<string | null>(null)
	const [rendererError, setRendererError] = useState<string | null>(null)
	const [canvas, setCanvas] = useState<Canvas | null>(null)
	const [presence, setPresence] = useState<Presence | null>(null)
	const [sessions, setSessions] = useState<SessionControl | null>(null)
	const [attention, setAttention] = useState<Attention | null>(null)
	// the strip under the top bar where the attention tray and the auto-seed progress stack
	const [topStack, setTopStack] = useState<HTMLDivElement | null>(null)
	const role = link.role
	const onGoneRef = useRef(onGone)
	onGoneRef.current = onGone

	useEffect(() => {
		const container = containerRef.current!
		let renderer: Renderer | null = null
		let live: Presence | null = null
		let disposed = false
		let loaded = false
		const disposers: (() => void)[] = []
		// Which OpenCode session each frame talks to, from the canvas server (loaded with the canvas, then live).
		const links = atom<SessionLink[]>('links', [])
		// Which of them are working, as their owners' tabs report it (loaded with the canvas, then live): for everyone.
		const busy = atom<Set<string>>('busySessions', new Set())
		let canvasTitle = ''

		editor.mount(container)
		editor.setCurrentTool(loadTool())
		// Only edit links can delete (and undo deleting); view links just select.
		if (link.role === 'edit') {
			const id = link.id
			editor.deletions.backend = {
				deleteItem: (itemId) => deleteItem(itemId),
				deleteSession: (sessionId) => deleteSession(id, sessionId),
				restore: (ids) => restoreDeleted(id, ids),
			}
			editor.frames = {
				setHidden: (sessionId, hidden) => setSessionHidden(id, sessionId, hidden),
				setOrder: (sessionIds) => setSessionOrder(id, sessionIds),
			}
			disposers.push(() => (editor.deletions.backend = null), () => (editor.frames = null))
		}
		disposers.push(react(() => saveTool(editor.currentToolId.get())))
		const deepLink = new DeepLink(editor)
		disposers.push(() => deepLink.destroy())

		// The renderer restarts when its GPU device is lost (iOS drops it in background tabs), but
		// gives up if that keeps happening straight after starting.
		let restarts = 0
		let startedAt = 0
		const startRenderer = () => {
			startedAt = performance.now()
			let lost = false
			Renderer.create(canvasRef.current!, overlayRef.current!, editor, {
				readOnly: link.role === 'view',
				onCloseSection: (id) => editor.deletions.delete([frameKey(id)]),
				getRemoteSelections: () => live?.peers.get().map((p) => ({ ids: p.selection ?? [], color: p.user.color })) ?? [],
				busySessions: () => busy.peek(),
				onDeviceLost: (message) => {
					// May be lost before create() resolved; then .then() below cleans up.
					lost = true
					renderer?.destroy()
					renderer = null
					if (disposed) return
					if (performance.now() - startedAt > 30_000) restarts = 0
					if (++restarts > 3) return setRendererError(`WebGPU device lost: ${message}`)
					setTimeout(() => !disposed && startRenderer(), 250 * restarts)
				},
			})
				.then((r) => {
					if (disposed || lost) return r.destroy()
					renderer = r
					;(window as any).renderer = r
				})
				.catch((e) => {
					console.error('Renderer failed to start', e)
					if (!disposed) setRendererError(describeError(e))
				})
		}
		startRenderer()

		disposers.push(
			connectCanvas(editor, link, {
				onLinks: (change) => {
					if ('all' in change) links.set(change.all)
					else if ('put' in change) links.set([...links.peek().filter((r) => r.sessionId !== change.put.sessionId), change.put])
					else links.set(links.peek().filter((r) => r.sessionId !== change.deleted))
				},
				onStatus: (change) => {
					const next = new Set('all' in change ? change.all : busy.peek())
					if ('sessionId' in change) {
						if (change.busy) next.add(change.sessionId)
						else next.delete(change.sessionId)
					}
					const prev = busy.peek()
					if (next.size !== prev.size || [...next].some((id) => !prev.has(id))) busy.set(next)
				},
				onLoad: (c, first) => {
					canvasTitle = c.title
					setCanvas(c)
					if (!first) return
					loaded = true
					// The node in the URL hash, if any, else the usual opening view.
					editor.whenViewportReady(() => {
						if (!disposed) deepLink.focusInitial()
					})
					// Everyone on the same canvas is in one room, whichever link they came from.
					live = new Presence(editor, `canvas-${c.id}`, link.role === 'view')
					const p = live
					const notes = new SharedNotes(overlayRef.current!, editor, p, link.role)
					const annotations = new SharedAnnotations(overlayRef.current!, editor, p, link.role)
					// Edit links can prompt sessions from their frames; view links just watch them work.
					const control = new SessionControl(editor, p, c.id, link.role === 'edit', links, busy, () => canvasTitle)
					// What sessions want people to look at: their sticky notes (and what they ask), for the bar at the top.
					const calls = new Attention(editor, control, notes)
					const cursors = new PeerCursors(overlayRef.current!, editor, p)
					editor.frameChrome = {
						status: (sessionId) => ({
							color: sessionColor(sessionId),
							canPrompt: control.canOpen(sessionId),
							prompting: control.prompting.get() === sessionId,
						}),
						prompt: (sessionId) => control.toggle(sessionId),
					}
					disposers.push(
						() => (editor.frameChrome = null),
						() => cursors.destroy(),
						() => control.destroy(),
						() => notes.destroy(),
						() => annotations.destroy(),
						() => p.destroy(),
					)
					if (link.role === 'edit') {
						const frameTitles = new FrameTitles(editor, c.id)
						const submit = new SubmitAnnotations(overlayRef.current!, editor, p, control, c.id, () => canvasTitle)
						disposers.push(() => frameTitles.destroy(), () => submit.destroy(), listenForPastedPages(editor, c.id))
					}
					setPresence(p)
					setSessions(control)
					setAttention(calls)
					;(window as any).presence = p
					;(window as any).sessions = control
					;(window as any).attention = calls
				},
				onCanvas: (c) => {
					canvasTitle = c.title
					setCanvas(c)
				},
				onGone: () => {
					if (!disposed) onGoneRef.current(loaded)
				},
				onError: (e) => setError(e.message),
			}),
		)
		disposers.push(react(() => (container.style.cursor = editor.cursor.get())))
		;(window as any).editor = editor

		return () => {
			disposed = true
			for (const d of disposers) d()
			editor.dispose()
			renderer?.destroy()
		}
	}, [editor])

	useEffect(() => {
		document.title = canvas ? `${canvas.title} · Canvas` : 'Canvas'
	}, [canvas?.title])

	return (
		<div className="app">
			<div ref={containerRef} className="canvas-container">
				<canvas ref={canvasRef} className="canvas" />
				<div ref={overlayRef} className="overlay" />
			</div>
			<ToolPicker editor={editor} withEditTools={!!presence && role === 'edit'} />
			{presence && <FollowIndicator presence={presence} />}
			{presence && <CursorChat editor={editor} presence={presence} />}
			{sessions?.canPrompt && <SessionPrompt editor={editor} sessions={sessions} />}
			{sessions && attention && <FrameAsks editor={editor} sessions={sessions} attention={attention} />}
			<div className="top-stack" ref={setTopStack}>
				{attention && <AttentionTray attention={attention} />}
			</div>
			<div className="top-bar">
				<TitleBar canvas={canvas} canRename={role === 'edit'} onRenamed={setCanvas} />
				<div className="top-right">
					{role === 'view' && (
						<div className="view-only-badge" title="This is a view-only link. You can look around, chat (/) and follow people, but editing tools are disabled.">
							<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
								<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
								<circle cx="12" cy="12" r="3" />
							</svg>
							<span>
								<strong>View only</strong>
								<small>Editing tools disabled</small>
							</span>
						</div>
					)}
					{presence && <PresenceBar presence={presence} />}
					<Toolbar editor={editor} canvas={role === 'edit' ? canvas : null} sessions={sessions?.canPrompt ? sessions : null} />
				</div>
			</div>
			<FramesStatus editor={editor} canEdit={role === 'edit'} />
			<UndoToast editor={editor} />
			<HiddenLinkToast editor={editor} canEdit={role === 'edit'} />
			{canvas && <EmptyState editor={editor} canvas={canvas} role={role} topStack={topStack} />}
			{(rendererError || error) && (
				<div className="error">
					<strong>{rendererError ? "Can't start the renderer." : "Can't open this canvas."}</strong>
					<span>{rendererError ?? error}</span>
				</div>
			)}
			<HtmlDrawer editor={editor} />
		</div>
	)
}

/** Top-left: a link back to the list and the canvas title, renamed inline on edit links. */
function TitleBar({ canvas, canRename, onRenamed }: { canvas: Canvas | null; canRename: boolean; onRenamed: (c: Canvas) => void }) {
	const [draft, setDraft] = useState<string | null>(null)
	const [saving, setSaving] = useState(false)

	const commit = async () => {
		if (draft === null || !canvas) return
		const title = draft.trim()
		setDraft(null)
		if (!title || title === canvas.title) return
		setSaving(true)
		onRenamed({ ...canvas, title })
		try {
			onRenamed(await renameCanvas(canvas.id, title))
		} catch (e) {
			console.error(e)
			onRenamed(canvas)
		} finally {
			setSaving(false)
		}
	}

	return (
		<div className="toolbar title-bar" onPointerDown={(e) => e.stopPropagation()}>
			<a className="back" href={listUrl()} title="All canvases">
				<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
					<rect x="3" y="3" width="7" height="7" rx="1.5" />
					<rect x="14" y="3" width="7" height="7" rx="1.5" />
					<rect x="3" y="14" width="7" height="7" rx="1.5" />
					<rect x="14" y="14" width="7" height="7" rx="1.5" />
				</svg>
				<span>All canvases</span>
			</a>
			<div className="sep" />
			{draft !== null ? (
				<input
					className="title-input"
					autoFocus
					value={draft}
					maxLength={120}
					onChange={(e) => setDraft(e.currentTarget.value)}
					onFocus={(e) => e.currentTarget.select()}
					onBlur={commit}
					onKeyDown={(e) => {
						if (e.key === 'Enter') e.currentTarget.blur()
						if (e.key === 'Escape') setDraft(null)
					}}
				/>
			) : canRename && canvas ? (
				<button className="title" title="Rename" disabled={saving} onClick={() => setDraft(canvas.title)}>
					{canvas.title}
				</button>
			) : (
				<span className="title">{canvas?.title ?? ''}</span>
			)}
		</div>
	)
}

const TOOLS: { id: ToolId; label: string; key: string; icon: JSX.Element }[] = [
	{
		id: 'select',
		label: 'Select',
		key: 'V',
		icon: (
			<svg viewBox="0 0 24 24" width="16" height="16">
				<path d="M5 4l14 8-6.5 1.5L9 20z" fill="currentColor" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
			</svg>
		),
	},
	{
		id: 'hand',
		label: 'Hand',
		key: 'H',
		icon: (
			<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
				<path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8" />
				<path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-5.9-2.4l-3.6-3.6a2 2 0 0 1 2.8-2.8L7 15" />
			</svg>
		),
	},
	{
		id: 'pencil',
		label: 'Pencil · draw on an item, T for a text note',
		key: 'P',
		icon: (
			<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
				<path d="M4 20l1.2-4.4L16.4 4.4a2 2 0 0 1 2.8 0l.4.4a2 2 0 0 1 0 2.8L8.4 18.8z" />
				<path d="M14.5 6.3l3.2 3.2" />
			</svg>
		),
	},
	{
		id: 'note',
		label: 'Sticky note',
		key: 'N',
		icon: (
			<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
				<path d="M4 4h16v10l-6 6H4z" />
				<path d="M14 20v-6h6" />
			</svg>
		),
	},
]

function ToolPicker({ editor, withEditTools }: { editor: Editor; withEditTools: boolean }) {
	const current = useValue(() => editor.currentToolId.get())
	return (
		<div className="toolbar tools" onPointerDown={(e) => e.stopPropagation()}>
			{TOOLS.filter((tool) => withEditTools || (tool.id !== 'note' && tool.id !== 'pencil')).map((tool) => (
				<button
					key={tool.id}
					title={`${tool.label} (${tool.key})`}
					aria-pressed={current === tool.id}
					className={current === tool.id ? 'active' : undefined}
					onClick={() => editor.setCurrentTool(tool.id)}
				>
					{tool.icon}
				</button>
			))}
		</div>
	)
}

function Toolbar({ editor, canvas, sessions }: { editor: Editor; canvas: Canvas | null; sessions: SessionControl | null }) {
	const zoom = useValue(() => Math.round(editor.camera.get().z * 100))
	const hasSelection = useValue(() => editor.selectedIds.get().length > 0)
	const [sharing, setSharing] = useState(false)
	const [adding, setAdding] = useState(false)

	return (
		<div className="toolbar" onPointerDown={(e) => e.stopPropagation()}>
			{/* wide-only: hidden on narrow screens, where pinch zooms */}
			<button className="wide-only" title="Zoom out (−)" onClick={() => editor.zoomOut()}>−</button>
			<button title="Reset to 100% (Shift+0)" className="zoom wide-only" onClick={() => editor.resetZoom()}>
				{zoom}%
			</button>
			<button className="wide-only" title="Zoom in (+)" onClick={() => editor.zoomIn()}>+</button>
			<div className="sep wide-only" />
			<button title="Zoom to fit (Shift+1)" onClick={() => editor.zoomToFit()}>Fit</button>
			<button className="wide-only" title="Zoom to selection (Shift+2)" disabled={!hasSelection} onClick={() => editor.zoomToSelection()}>
				Selection
			</button>
			{canvas && <div className="sep" />}
			{canvas && (
				<>
					{sessions && (
						<SessionsButton
							editor={editor}
							sessions={sessions}
							open={adding}
							setOpen={(open) => {
								setAdding(open)
								if (open) setSharing(false)
							}}
						/>
					)}
					<button
						title="Links to this canvas"
						aria-pressed={sharing}
						onClick={() => {
							setSharing(!sharing)
							setAdding(false)
						}}
					>
						Share
					</button>
				</>
			)}
			{canvas && sharing && (
				<div className="share-popover links">
					<div className="share-popover-head">
						<span className="share-note">Share this canvas</span>
						<button title="Close" onClick={() => setSharing(false)}>
							×
						</button>
					</div>
					<ShareLinkRow label="Can edit" hint="Full access: notes, removing sessions, renaming" url={editUrl(canvas)} />
					<ShareLinkRow label="View only" hint="Can look around and chat, but not edit" url={viewUrl(canvas)} />
				</div>
			)}
		</div>
	)
}

function ShareLinkRow({ label, hint, url }: { label: string; hint: string; url: string }) {
	const [copied, setCopied] = useState(false)
	const copy = () =>
		navigator.clipboard.writeText(url).then(() => {
			setCopied(true)
			setTimeout(() => setCopied(false), 1500)
		})
	return (
		<div className="share-row">
			<div className="share-row-label">
				<strong>{label}</strong>
				<span>{hint}</span>
			</div>
			<input readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
			<button className="share-copy" onClick={copy}>
				{copied ? 'Copied' : 'Copy'}
			</button>
			<a href={url} target="_blank" rel="noreferrer">
				Open
			</a>
		</div>
	)
}

/** "Deleted 3 items · Undo" at the bottom centre for a few seconds after deleting. */
function UndoToast({ editor }: { editor: Editor }) {
	const toast = useValue(() => editor.deletions.toast.get())
	if (!toast) return null
	return (
		<div className="toast" key={toast.id} role="status" onPointerDown={(e) => e.stopPropagation()}>
			<span>{toast.message}</span>
			{toast.undo && (
				<>
					<span className="toast-sep">·</span>
					<button onClick={() => editor.deletions.undo()}>Undo</button>
				</>
			)}
		</div>
	)
}

function EmptyState({ editor, canvas, role, topStack }: { editor: Editor; canvas: Canvas; role: CanvasLink['role']; topStack: HTMLElement | null }) {
	const empty = useValue(() => editor.connection.get() === 'open' && Object.keys(editor.sessions.get()).length === 0)
	// Seeding fills the canvas, but the picker stays up with its progress until it's done. With no
	// OpenCode paired in this browser, the picker asks to connect one first.
	const [seeding, setSeeding] = useState(false)
	const showPicker = role === 'edit' && (empty || seeding)
	if (!empty && !showPicker) return null
	if (role === 'view') {
		return (
			<div className="empty">
				<h2>Nothing here yet</h2>
				<p>Media posted to this canvas shows up here live.</p>
			</div>
		)
	}
	const curl = `curl -X POST ${API_BASE}/api/canvases/${canvas.id}/sessions/$SESSION_ID/items \\
  -F file=@output.png -F caption="first try"`
	return (
		<div className="empty seeding">
			<SeedPicker editor={editor} canvasId={canvas.id} onBusy={setSeeding} topStack={topStack} />
			{empty && !seeding && (
				<div className="seed-curl">
					<p>Or post media from a session yourself:</p>
					<pre>{curl}</pre>
				</div>
			)}
		</div>
	)
}
