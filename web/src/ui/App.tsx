import { useEffect, useRef, useState, type JSX } from 'react'
import { Editor, type ToolId } from '../editor/Editor'
import { Renderer } from '../render/Renderer'
import { react } from '../state/signals'
import type { OpenedShare } from '../../../shared/types'
import { connect, createShare, deleteSession, loadShare, type ShareLink, type ShareLinks } from '../sync/client'
import { PeerCursors } from '../multiplayer/PeerCursors'
import { Presence } from '../multiplayer/Presence'
import { SharedNotes } from '../multiplayer/SharedNotes'
import { CursorChat } from './CursorChat'
import { FollowIndicator, PresenceBar } from './PresenceBar'
import { useValue } from './useValue'
import { APP_PATH } from '../base'

/** Set when viewing a shared snapshot: /s/:id is view-only, /e/:editKey can edit. */
const SHARE_LINK: ShareLink | null = (() => {
	const view = /^\/s\/([A-Za-z0-9]{10})\/?$/.exec(APP_PATH)?.[1]
	if (view) return { kind: 'view', id: view }
	const edit = /^\/e\/([A-Za-z0-9]{20})\/?$/.exec(APP_PATH)?.[1]
	return edit ? { kind: 'edit', key: edit } : null
})()

export function App() {
	const containerRef = useRef<HTMLDivElement>(null)
	const canvasRef = useRef<HTMLCanvasElement>(null)
	const overlayRef = useRef<HTMLDivElement>(null)
	const [editor] = useState(() => new Editor())
	const [error, setError] = useState<string | null>(null)
	const [share, setShare] = useState<OpenedShare | null>(null)
	const [presence, setPresence] = useState<Presence | null>(null)

	useEffect(() => {
		const container = containerRef.current!
		let renderer: Renderer | null = null
		let live: Presence | null = null
		let disposed = false
		const disposers: (() => void)[] = []

		editor.mount(container)

		Renderer.create(canvasRef.current!, overlayRef.current!, editor, {
			readOnly: !!SHARE_LINK,
			onCloseSection: (id) => deleteSession(id).catch((e) => console.error(e)),
			getRemoteSelections: () => live?.peers.get().map((p) => ({ ids: p.selection ?? [], color: p.user.color })) ?? [],
		})
			.then((r) => {
				if (disposed) return r.destroy()
				renderer = r
				;(window as any).renderer = r
			})
			.catch((e) => setError(String(e.message ?? e)))

		if (SHARE_LINK) {
			loadShare(editor, SHARE_LINK)
				.then((s) => {
					if (disposed) return
					setShare(s)
					editor.whenViewportReady(() => editor.goToInitialView())
					// Shared pages are multiplayer: everyone on the same share is in one room.
					live = new Presence(editor, `share-${s.id}`, s.editKey)
					const p = live
					const notes = new SharedNotes(overlayRef.current!, editor, p, s.role)
					const cursors = new PeerCursors(overlayRef.current!, editor, p)
					disposers.push(() => cursors.destroy(), () => notes.destroy(), () => p.destroy())
					setPresence(p)
					;(window as any).presence = p
				})
				.catch((e) => setError(String(e.message ?? e)))
		} else {
			disposers.push(connect(editor, () => editor.whenViewportReady(() => editor.goToInitialView())))
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
				<Toolbar editor={editor} canShare={!SHARE_LINK} />
			</div>
			<StatusBar editor={editor} share={share} />
			{!SHARE_LINK && <EmptyState editor={editor} />}
			{error && (
				<div className="error">
					<strong>{SHARE_LINK ? "Can't open this share." : "Can't start the renderer."}</strong>
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
		{ status: 'idle' } | { status: 'sharing' } | { status: 'done'; links: ShareLinks } | { status: 'error'; message: string }
	>({ status: 'idle' })

	const share = async () => {
		setShareState({ status: 'sharing' })
		try {
			const links = await createShare(editor.viewportPageBounds.get())
			setShareState({ status: 'done', links })
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
				<div className="share-popover links">
					<div className="share-popover-head">
						<span className="share-note">Snapshot saved</span>
						<button title="Close" onClick={() => setShareState({ status: 'idle' })}>
							×
						</button>
					</div>
					<ShareLinkRow label="Can edit" hint="Full access: notes, and drawing later" url={shareState.links.editUrl} />
					<ShareLinkRow label="View only" hint="Can look around and leave faded notes" url={shareState.links.viewUrl} />
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

function StatusBar({ editor, share }: { editor: Editor; share: OpenedShare | null }) {
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
				<>
					<span className={`role-badge ${share.role}`}>{share.role === 'edit' ? 'Can edit' : 'View only'}</span>
					<span className="shared-badge" title="A frozen copy. It doesn't update.">
						Shared snapshot · {new Date(share.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
					</span>
				</>
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
