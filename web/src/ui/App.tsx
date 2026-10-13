import { useEffect, useRef, useState, type JSX } from 'react'
import { Editor, type Camera, type ToolId } from '../editor/Editor'
import { Renderer } from '../render/Renderer'
import { react } from '../state/signals'
import type { Share } from '../../../shared/types'
import { connect, createShare, deleteSession, loadShare } from '../sync/client'
import { PeerCursors } from '../multiplayer/PeerCursors'
import { Presence } from '../multiplayer/Presence'
import { SharedNotes } from '../multiplayer/SharedNotes'
import { CursorChat } from './CursorChat'
import { FollowIndicator, PresenceBar } from './PresenceBar'
import { useValue } from './useValue'
import { APP_PATH } from '../base'

const CAMERA_KEY = 'canvas.camera'
/** Set when viewing a shared snapshot at /s/:id */
const SHARE_ID = /^\/s\/([A-Za-z0-9]{10})\/?$/.exec(APP_PATH)?.[1] ?? null

export function App() {
	const containerRef = useRef<HTMLDivElement>(null)
	const canvasRef = useRef<HTMLCanvasElement>(null)
	const overlayRef = useRef<HTMLDivElement>(null)
	const [editor] = useState(() => new Editor())
	const [error, setError] = useState<string | null>(null)
	const [share, setShare] = useState<Share | null>(null)
	const [presence, setPresence] = useState<Presence | null>(null)

	useEffect(() => {
		const container = containerRef.current!
		let renderer: Renderer | null = null
		let disposed = false
		const disposers: (() => void)[] = []

		editor.mount(container)

		// Shared pages are multiplayer: everyone viewing the same share is in one room.
		const live = SHARE_ID ? new Presence(editor, `share-${SHARE_ID}`) : null
		if (live) {
			const notes = new SharedNotes(overlayRef.current!, editor, live.doc, live)
			const cursors = new PeerCursors(overlayRef.current!, editor, live)
			disposers.push(() => cursors.destroy(), () => notes.destroy(), () => live.destroy())
			setPresence(live)
			;(window as any).presence = live
		}

		Renderer.create(canvasRef.current!, overlayRef.current!, editor, {
			readOnly: !!SHARE_ID,
			onCloseSection: (id) => deleteSession(id).catch((e) => console.error(e)),
			getRemoteSelections: live
				? () => live.peers.get().map((p) => ({ ids: p.selection ?? [], color: p.user.color }))
				: undefined,
		})
			.then((r) => {
				if (disposed) return r.destroy()
				renderer = r
				;(window as any).renderer = r
			})
			.catch((e) => setError(String(e.message ?? e)))

		if (SHARE_ID) {
			loadShare(editor, SHARE_ID)
				.then((s) => {
					if (disposed) return
					setShare(s)
					// Viewport sizes differ between people, so frame the same region rather than the same camera.
					if (s.view) editor.zoomToBounds(s.view, { animate: false })
					else editor.zoomToFit({ animate: false })
				})
				.catch((e) => setError(String(e.message ?? e)))
		} else {
			const saved = readCamera()
			if (saved) editor.setCamera(saved)
			disposers.push(
				connect(editor, () => {
					if (!saved) editor.zoomToFit({ animate: false })
				}),
			)
			let saveTimer = 0
			disposers.push(
				react(() => {
					const camera = editor.camera.get()
					clearTimeout(saveTimer)
					saveTimer = window.setTimeout(() => localStorage.setItem(CAMERA_KEY, JSON.stringify(camera)), 300)
				}),
			)
		}
		disposers.push(react(() => (container.style.cursor = editor.cursor.get())))
		;(window as any).editor = editor

		return () => {
			disposed = true
			for (const d of disposers) d()
			editor.dispose()
			renderer?.destroy()
		}
	}, [editor])

	return (
		<div className="app">
			<div ref={containerRef} className="canvas-container">
				<canvas ref={canvasRef} className="canvas" />
				<div ref={overlayRef} className="overlay" />
			</div>
			<ToolPicker editor={editor} withNotes={!!presence} />
			{presence && <FollowIndicator presence={presence} />}
			{presence && <CursorChat editor={editor} presence={presence} />}
			<div className="top-right">
				{presence && <PresenceBar presence={presence} />}
				<Toolbar editor={editor} canShare={!SHARE_ID} />
			</div>
			<StatusBar editor={editor} share={share} />
			{!SHARE_ID && <EmptyState editor={editor} />}
			{error && (
				<div className="error">
					<strong>{SHARE_ID ? "Can't open this share." : "Can't start the renderer."}</strong>
					<span>{error}</span>
				</div>
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

function Toolbar({ editor, canShare }: { editor: Editor; canShare: boolean }) {
	const zoom = useValue(() => Math.round(editor.camera.get().z * 100))
	const hasSelection = useValue(() => editor.selectedIds.get().length > 0)
	const hasContent = useValue(() => Object.keys(editor.sessions.get()).length > 0)
	const [shareState, setShareState] = useState<
		{ status: 'idle' } | { status: 'sharing' } | { status: 'done'; url: string; copied: boolean } | { status: 'error'; message: string }
	>({ status: 'idle' })

	const share = async () => {
		setShareState({ status: 'sharing' })
		try {
			const url = await createShare(editor.viewportPageBounds.get())
			const copied = await navigator.clipboard.writeText(url).then(
				() => true,
				() => false,
			)
			setShareState({ status: 'done', url, copied })
		} catch (e) {
			setShareState({ status: 'error', message: (e as Error).message })
		}
	}

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
			{canShare && (
				<>
					<div className="sep" />
					<button
						title="Save a read-only snapshot and copy its link"
						disabled={!hasContent || shareState.status === 'sharing'}
						onClick={share}
					>
						{shareState.status === 'sharing' ? 'Sharing…' : 'Share'}
					</button>
				</>
			)}
			{shareState.status === 'done' && (
				<div className="share-popover">
					<span className="share-note">{shareState.copied ? 'Link copied' : 'Snapshot saved'}</span>
					<input readOnly value={shareState.url} onFocus={(e) => e.currentTarget.select()} />
					<a href={shareState.url} target="_blank" rel="noreferrer">
						Open
					</a>
					<button title="Close" onClick={() => setShareState({ status: 'idle' })}>
						×
					</button>
				</div>
			)}
			{shareState.status === 'error' && (
				<div className="share-popover error-text">
					<span>{shareState.message}</span>
					<button title="Close" onClick={() => setShareState({ status: 'idle' })}>
						×
					</button>
				</div>
			)}
		</div>
	)
}

function StatusBar({ editor, share }: { editor: Editor; share: Share | null }) {
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
			{share ? (
				<span className="shared-badge" title="A frozen copy. It doesn't update.">
					Shared snapshot · {new Date(share.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
				</span>
			) : (
				<span className={`dot ${connection}`} title={connection} />
			)}
			<span>
				{sessions} sessions · {items} items{selected !== '0' && ` · ${selected} selected`}
			</span>
			{hovered && <span className="hovered">{hovered}</span>}
		</div>
	)
}

function EmptyState({ editor }: { editor: Editor }) {
	const empty = useValue(() => editor.connection.get() === 'open' && Object.keys(editor.sessions.get()).length === 0)
	if (!empty) return null
	const origin = location.origin
	return (
		<div className="empty">
			<h2>No sessions yet</h2>
			<p>Post media from a session and it shows up here live:</p>
			<pre>{`curl -X POST ${origin}/api/sessions/my-run/items \\
  -F file=@output.png -F caption="first try"`}</pre>
		</div>
	)
}

function readCamera(): Camera | null {
	try {
		const c = JSON.parse(localStorage.getItem(CAMERA_KEY) ?? 'null')
		return c && Number.isFinite(c.x) && Number.isFinite(c.y) && c.z > 0 ? c : null
	} catch {
		return null
	}
}
