import { useEffect, useRef, useState, type JSX } from 'react'
import { Editor, type ToolId } from '../editor/Editor'
import { describeError, Renderer } from '../render/Renderer'
import { atom, react } from '../state/signals'
import { sessionColor } from '../../../shared/sessionColor'
import type { Canvas, Session, SessionLink } from '../../../shared/types'
import {
	connectCanvas, deleteItem, deleteSession, editUrl, restoreDeleted, listUrl, renameCanvas, setSessionHidden, setSessionOrder, viewUrl, type CanvasLink,
} from '../sync/client'
import { listenForPastedPages } from './pastePage'
import { Attention } from '../multiplayer/Attention'
import { SessionControl } from '../multiplayer/SessionControl'
import { FrameSessions, liveSessions } from '../opencode/live'
import { FrameSubagents } from '../opencode/subagents'
import { PeerCursors } from '../multiplayer/PeerCursors'
import { Presence } from '../multiplayer/Presence'
import { SharedAnnotations } from '../multiplayer/SharedAnnotations'
import { SubmitAnnotations } from '../multiplayer/SubmitAnnotations'
import { FrameDrop } from '../multiplayer/FrameDrop'
import { SharedNotes } from '../multiplayer/SharedNotes'
import { AttentionTray } from './Attention'
import { FrameAsks } from './FrameAsks'
import { SessionsButton, sessionsPopover } from './Sessions'
import { SessionPrompt } from './PromptThread'
import { CursorChat } from './CursorChat'
import { DeepLink } from './deepLink'
import { HiddenLinkToast } from './HiddenLinkToast'
import { HtmlDrawer } from './HtmlDrawer'
import { NotFound } from './NotFound'
import { EmptyState } from './EmptyState'
import { PopulateProgress } from './PopulateProgress'
import { FollowIndicator, PresenceBar } from './PresenceBar'
import { useValue } from './useValue'
import { Wordmark } from './Wordmark'
// hiding frames (their title's eye), the hidden-link toast, the attention bar's hidden rows
import './frames.css'

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

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((id) => b.has(id))

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
		// Which frames are working, as the canvas server says (loaded with the canvas, then live)...
		const reportedBusy = atom<Set<string>>('reportedBusy', new Set())
		// ...or this tab's paired OpenCodes, where they have the session; edit links report what they see for everyone.
		const busy = atom<Set<string>>('busySessions', new Set(), sameSet)
		const ownBusy = atom<string[]>('ownBusy', [], (a, b) => a.join() === b.join())
		// Which subagents wait on an answer, the same way: as the canvas server says, or this tab's paired OpenCodes (see opencode/subagents.ts).
		const reportedAsking = atom<Set<string>>('reportedAsking', new Set())
		const ownAsking = atom<string[]>('ownAsking', [], (a, b) => a.join() === b.join())
		disposers.push(
			react(() => {
				const { shown, own } = liveSessions.busyFrames(editor.sessionRecords.get(), reportedBusy.get())
				busy.set(shown)
				editor.busy.set(shown)
				ownBusy.set(own)
			}),
		)
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
					const next = new Set('all' in change ? change.all : reportedBusy.peek())
					if ('sessionId' in change) {
						if (change.busy) next.add(change.sessionId)
						else next.delete(change.sessionId)
					}
					if (!sameSet(next, reportedBusy.peek())) reportedBusy.set(next)
				},
				onAsking: (change) => {
					const next = new Set('all' in change ? change.all : reportedAsking.peek())
					if ('sessionId' in change) {
						if (change.asking) next.add(change.sessionId)
						else next.delete(change.sessionId)
					}
					if (!sameSet(next, reportedAsking.peek())) reportedAsking.set(next)
				},
				...(link.role === 'edit' ? { reportBusy: ownBusy, reportAsking: ownAsking } : {}),
				onLoad: (c, first) => {
					canvasTitle = c.title
					setCanvas(c)
					if (!first) return
					loaded = true
					// Subagents' drawers open here as this viewer left them on this canvas.
					editor.drawers.load(c.id)
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
					// An agent note's "Later": on to the next note that wants attention.
					notes.onLater = () => calls.step(1)
					const cursors = new PeerCursors(overlayRef.current!, editor, p)
					// Every frame is an OpenCode session: what its OpenCode says about it, live (edit links tell everyone).
					const frameSessions = new FrameSessions(editor, c.id, link.role === 'edit')
					// How their subagents (those with output: orbs on their titles) are doing: waiting, failed.
					const kids = new FrameSubagents(editor)
					const asking = (id: string) => kids.asking.peek().has(id) || reportedAsking.peek().has(id)
					editor.frameChrome = {
						status: (sessionId) => ({
							color: sessionColor(sessionId),
							canPrompt: control.canOpen(sessionId),
							prompting: control.prompting.get() === sessionId,
							ended: !!editor.sessions.get()[sessionId]?.opencode?.deleted,
							asking: asking(sessionId) || !!control.live.get().get(sessionId)?.asking?.count,
						}),
						prompt: (sessionId, button) => control.toggle(sessionId, button && control.screenAnchor(button, 'below')),
						subagent: (sessionId) => subagentState(sessionId, editor.parentOf(sessionId), control, editor.sessions.peek()[sessionId], asking(sessionId)),
					}
					disposers.push(
						() => (editor.frameChrome = null),
						react(() => {
							const posted = editor.postedSessions.get()
							ownAsking.set([...kids.asking.get()].filter((id) => posted.has(id)).sort())
						}),
						() => frameSessions.destroy(),
						() => kids.destroy(),
						() => cursors.destroy(),
						() => control.destroy(),
						() => notes.destroy(),
						() => annotations.destroy(),
						() => p.destroy(),
					)
					if (link.role === 'edit') {
						const submit = new SubmitAnnotations(overlayRef.current!, editor, p, control, c.id, () => canvasTitle)
						const drop = new FrameDrop(container, overlayRef.current!, editor, p, control, c.id)
						disposers.push(() => submit.destroy(), () => drop.destroy(), listenForPastedPages(editor, c.id))
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
			<StatusLine editor={editor} />
			{presence && <FollowIndicator presence={presence} />}
			{presence && <CursorChat editor={editor} presence={presence} />}
			{sessions?.canPrompt && <SessionPrompt editor={editor} sessions={sessions} />}
			{sessions && attention && <FrameAsks editor={editor} sessions={sessions} attention={attention} />}
			{sessions?.canPrompt && <PopulateProgress editor={editor} />}
			<div className="top-stack">
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
					<Toolbar editor={editor} canvas={role === 'edit' ? canvas : null} sessions={sessions?.canPrompt ? sessions : null} />
					{presence && <PresenceBar presence={presence} />}
				</div>
			</div>
			<UndoToast editor={editor} />
			<HiddenLinkToast editor={editor} canEdit={role === 'edit'} />
			{canvas && <EmptyState editor={editor} canvasId={canvas.id} canAdd={!!sessions?.canPrompt} viewOnly={role === 'view'} />}
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

/**
 * What a subagent is doing, from what's known here: its parent's live state in the room (its owner's
 * tab follows its subagents: which wait on an answer, which failed), whether it's working as the busy
 * band says (LiveSessions.busyFrames), and this tab's paired OpenCode.
 */
function subagentState(sessionId: string, parentId: string | null, control: SessionControl, session: Session | undefined, asking: boolean): 'running' | 'waiting' | 'failed' | 'done' {
	const live = control.live.get()
	const parent = parentId ? live.get(parentId) : undefined
	const own = live.get(sessionId)
	if (asking || parent?.asking?.sessions?.includes(sessionId) || own?.asking?.count) return 'waiting'
	if (control.busy.peek().has(sessionId)) return 'running'
	if (parent?.failedSubagents?.includes(sessionId) || liveSessions.failed.peek().has(sessionId) || session?.opencode?.failed) return 'failed'
	return 'done'
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
		<div className="title-bar" onPointerDown={(e) => e.stopPropagation()}>
			<a className="back" href={listUrl()} title="All canvases">
				<Wordmark />
			</a>
			<div className="title-bar-main">
				<a className="title-bar-name rm-wide" href={listUrl()} title="All canvases">
					OPENCODE CANVAS
				</a>
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
			{canvas && (
				<>
					<div className="sep wide-only" />
					<span className="title-bar-id wide-only">{canvas.id}</span>
				</>
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
			<svg viewBox="0 0 20 20" width="20" height="20">
				<path d="M5 2.5v13.2l3.3-3.1 2.3 5 2.1-.9-2.3-5h4.5z" fill="currentColor" />
			</svg>
		),
	},
	{
		id: 'hand',
		label: 'Hand',
		key: 'H',
		icon: (
			<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
				<path d="M6.5 10V4.8a1.2 1.2 0 0 1 2.4 0V9M8.9 9V3.6a1.2 1.2 0 0 1 2.4 0V9M11.3 9V4.4a1.2 1.2 0 0 1 2.4 0V10M13.7 10V6.6a1.2 1.2 0 0 1 2.4 0v5.2c0 3.2-2.2 5.7-5.4 5.7-2.2 0-3.4-1-4.6-2.6L3.6 11.3a1.2 1.2 0 0 1 1.8-1.5L6.5 11" />
			</svg>
		),
	},
	{
		id: 'pencil',
		label: 'Pencil · draw on an item, T for a text note',
		key: 'P',
		icon: (
			<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
				<path d="M3.5 16.5l1-4L13 4l3 3-8.5 8.5z" />
				<path d="M11.5 5.5l3 3" />
			</svg>
		),
	},
	{
		id: 'note',
		label: 'Sticky note',
		key: 'N',
		icon: (
			<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.4">
				<path d="M3.5 3.5h13v8.5l-4.5 4.5h-8.5z" />
				<path d="M16.5 12h-4.5v4.5" />
			</svg>
		),
	},
]

/** The tool palette, down the left edge: the active tool in inverse, each with its key. */
function ToolPicker({ editor, withEditTools }: { editor: Editor; withEditTools: boolean }) {
	const current = useValue(() => editor.currentToolId.get())
	return (
		<div className="tools" onPointerDown={(e) => e.stopPropagation()}>
			{TOOLS.filter((tool) => withEditTools || (tool.id !== 'note' && tool.id !== 'pencil')).map((tool) => (
				<button
					key={tool.id}
					title={`${tool.label} (${tool.key})`}
					aria-pressed={current === tool.id}
					className={current === tool.id ? 'active' : undefined}
					onClick={() => editor.setCurrentTool(tool.id)}
				>
					{tool.icon}
					<span className="tool-key">{tool.key}</span>
				</button>
			))}
		</div>
	)
}

/** Scale bars this long in page px, the shortest that is at least SCALE_MIN screen px at the zoom. */
const SCALE_STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000]
const SCALE_MIN = 55

/** Bottom left: a scale bar, the zoom, where the pointer is on the page, and how many things are selected (click: zoom to them). */
function StatusLine({ editor }: { editor: Editor }) {
	const z = useValue(() => editor.camera.get().z)
	const at = useValue(() => {
		const p = editor.pointerPage.get()
		return p ? `${Math.round(p.x)} ${Math.round(p.y)}` : ''
	})
	const selected = useValue(() => editor.selectedIds.get().length)
	const step = SCALE_STEPS.find((s) => s * z >= SCALE_MIN) ?? SCALE_STEPS[SCALE_STEPS.length - 1]!
	const [x, y] = at ? at.split(' ') : []
	return (
		<div className="status-line wide-only">
			<span className="status-scale">
				<i style={{ width: Math.round(step * z) }} />
				{groupDigits(step)} px
			</span>
			<span>{Math.round(z * 100)}%</span>
			{at && (
				<span>
					X {groupDigits(Number(x))}&nbsp; Y {groupDigits(Number(y))}
				</span>
			)}
			{selected > 0 && (
				<button className="status-selected" title="Zoom to the selection (Shift+2)" onPointerDown={(e) => e.stopPropagation()} onClick={() => editor.zoomToSelection()}>
					{selected} SELECTED
				</button>
			)}
		</div>
	)
}

/** 4120 → "4 120", as the manual sets numbers. */
const groupDigits = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')

function Toolbar({ editor, canvas, sessions }: { editor: Editor; canvas: Canvas | null; sessions: SessionControl | null }) {
	const zoom = useValue(() => Math.round(editor.camera.get().z * 100))
	const [sharing, setSharing] = useState(false)
	const adding = useValue(() => sessionsPopover.get() !== null)
	useEffect(() => {
		if (adding) setSharing(false)
	}, [adding])
	useEffect(() => () => sessionsPopover.set(null), [])

	return (
		<div className="toolbar-row" onPointerDown={(e) => e.stopPropagation()}>
			<div className="toolbar zoom-panel">
				{/* wide-only: hidden on narrow screens, where pinch zooms */}
				<button className="wide-only" title="Zoom out (−)" onClick={() => editor.zoomOut()}>
					−
				</button>
				<button title="Reset to 100% (Shift+0)" className="zoom wide-only" onClick={() => editor.resetZoom()}>
					{zoom}%
				</button>
				<button className="wide-only" title="Zoom in (+)" onClick={() => editor.zoomIn()}>
					+
				</button>
				<button title="Zoom to fit (Shift+1)" onClick={() => editor.zoomToFit()}>
					Fit
				</button>
			</div>
			{canvas && (
				<div className="toolbar">
					{sessions && <SessionsButton editor={editor} sessions={sessions} />}
					<button
						title="Links to this canvas"
						aria-pressed={sharing}
						onClick={() => {
							setSharing(!sharing)
							sessionsPopover.set(null)
						}}
					>
						Share
					</button>
					{sharing && (
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
