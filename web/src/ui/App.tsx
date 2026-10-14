import { useEffect, useRef, useState, type JSX } from 'react'
import { Editor, type ToolId } from '../editor/Editor'
import { Renderer } from '../render/Renderer'
import { react } from '../state/signals'
import type { Canvas } from '../../../shared/types'
import { connectCanvas, deleteSession, editUrl, listUrl, renameCanvas, viewUrl, type CanvasLink } from '../sync/client'
import { PeerCursors } from '../multiplayer/PeerCursors'
import { Presence } from '../multiplayer/Presence'
import { SharedNotes } from '../multiplayer/SharedNotes'
import { CursorChat } from './CursorChat'
import { NotFound } from './NotFound'
import { FollowIndicator, PresenceBar } from './PresenceBar'
import { useValue } from './useValue'
import { BASE } from '../base'

/** The last used select/hand tool is remembered across reloads; the one-shot note tool never is. */
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
	const [canvas, setCanvas] = useState<Canvas | null>(null)
	const [presence, setPresence] = useState<Presence | null>(null)
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

		editor.mount(container)
		editor.setCurrentTool(loadTool())
		disposers.push(react(() => saveTool(editor.currentToolId.get())))

		Renderer.create(canvasRef.current!, overlayRef.current!, editor, {
			readOnly: link.role === 'view',
			onCloseSection: (id) => {
				if (link.role === 'edit') deleteSession(link.id, id).catch((e) => console.error(e))
			},
			getRemoteSelections: () => live?.peers.get().map((p) => ({ ids: p.selection ?? [], color: p.user.color })) ?? [],
		})
			.then((r) => {
				if (disposed) return r.destroy()
				renderer = r
				;(window as any).renderer = r
			})
			.catch((e) => setError(String(e.message ?? e)))

		disposers.push(
			connectCanvas(editor, link, {
				onLoad: (c, first) => {
					setCanvas(c)
					if (!first) return
					loaded = true
					editor.whenViewportReady(() => editor.goToInitialView())
					// Everyone on the same canvas is in one room, whichever link they came from.
					live = new Presence(editor, `canvas-${c.id}`, link.role === 'view')
					const p = live
					const notes = new SharedNotes(overlayRef.current!, editor, p, link.role)
					const cursors = new PeerCursors(overlayRef.current!, editor, p)
					disposers.push(() => cursors.destroy(), () => notes.destroy(), () => p.destroy())
					setPresence(p)
					;(window as any).presence = p
				},
				onCanvas: setCanvas,
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
			<TitleBar canvas={canvas} canRename={role === 'edit'} onRenamed={setCanvas} />
			<ToolPicker editor={editor} withNotes={!!presence && role === 'edit'} />
			{presence && <FollowIndicator presence={presence} />}
			{presence && <CursorChat editor={editor} presence={presence} />}
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
				<Toolbar editor={editor} canvas={role === 'edit' ? canvas : null} />
			</div>
			<StatusBar editor={editor} />
			{canvas && <EmptyState editor={editor} canvas={canvas} role={role} />}
			{error && (
				<div className="error">
					<strong>{canvas ? "Can't start the renderer." : "Can't open this canvas."}</strong>
					<span>{error}</span>
				</div>
			)}
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
]

function ToolPicker({ editor, withNotes }: { editor: Editor; withNotes: boolean }) {
	const current = useValue(() => editor.currentToolId.get())
	return (
		<div className="toolbar tools" onPointerDown={(e) => e.stopPropagation()}>
			{TOOLS.filter((tool) => withNotes || tool.id !== 'note').map((tool) => (
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

function Toolbar({ editor, canvas }: { editor: Editor; canvas: Canvas | null }) {
	const zoom = useValue(() => Math.round(editor.camera.get().z * 100))
	const hasSelection = useValue(() => editor.selectedIds.get().length > 0)
	const [sharing, setSharing] = useState(false)

	return (
		<div className="toolbar" onPointerDown={(e) => e.stopPropagation()}>
			<button title="Zoom out (−)" onClick={() => editor.zoomOut()}>−</button>
			<button title="Reset to 100% (Shift+0)" className="zoom" onClick={() => editor.resetZoom()}>
				{zoom}%
			</button>
			<button title="Zoom in (+)" onClick={() => editor.zoomIn()}>+</button>
			<div className="sep" />
			<button title="Zoom to fit (Shift+1)" onClick={() => editor.zoomToFit()}>Fit</button>
			<button title="Zoom to selection (Shift+2)" disabled={!hasSelection} onClick={() => editor.zoomToSelection()}>
				Selection
			</button>
			{canvas && (
				<>
					<div className="sep" />
					<button title="Links to this canvas" aria-pressed={sharing} onClick={() => setSharing(!sharing)}>
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

function StatusBar({ editor }: { editor: Editor }) {
	const connection = useValue(() => editor.connection.get())
	const counts = useValue(
		() => `${Object.keys(editor.sessions.get()).length}·${Object.keys(editor.items.get()).length}·${editor.selectedIds.get().length}`,
	)
	const hovered = useValue(() => {
		const id = editor.hoveredId.get()
		const item = id ? editor.items.get()[id] : null
		if (!item) return null
		const text = [item.title, item.caption].filter(Boolean).join(': ') || item.id
		return `${text} — ${item.width}×${item.height}`
	})
	const [sessions, items, selected] = counts.split('·')
	return (
		<div className="status">
			<span className={`dot ${connection}`} title={connection} />
			<span>
				{sessions} sessions · {items} items{selected !== '0' && ` · ${selected} selected`}
			</span>
			{hovered && <span className="hovered">{hovered}</span>}
		</div>
	)
}

function EmptyState({ editor, canvas, role }: { editor: Editor; canvas: Canvas; role: CanvasLink['role'] }) {
	const empty = useValue(() => editor.connection.get() === 'open' && Object.keys(editor.sessions.get()).length === 0)
	if (!empty) return null
	if (role === 'view') {
		return (
			<div className="empty">
				<h2>Nothing here yet</h2>
				<p>Media posted to this canvas shows up here live.</p>
			</div>
		)
	}
	return (
		<div className="empty">
			<h2>No sessions yet</h2>
			<p>Post media from a session and it shows up here live:</p>
			<pre>{`curl -X POST ${location.origin}${BASE}/api/canvases/${canvas.id}/sessions/$SESSION_ID/items \\
  -F file=@output.png -F caption="first try"`}</pre>
		</div>
	)
}
