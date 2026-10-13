import { useEffect, useRef, useState, type JSX } from 'react'
import { Editor, type Camera, type ToolId } from '../editor/Editor'
import { Renderer } from '../render/Renderer'
import { react } from '../state/signals'
import { connect, deleteSession } from '../sync/client'
import { useValue } from './useValue'

const CAMERA_KEY = 'canvas.camera'

export function App() {
	const containerRef = useRef<HTMLDivElement>(null)
	const canvasRef = useRef<HTMLCanvasElement>(null)
	const overlayRef = useRef<HTMLDivElement>(null)
	const [editor] = useState(() => new Editor())
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		const container = containerRef.current!
		let renderer: Renderer | null = null
		let disposed = false
		const disposers: (() => void)[] = []

		editor.mount(container)
		const saved = readCamera()
		if (saved) editor.setCamera(saved)

		Renderer.create(canvasRef.current!, overlayRef.current!, editor, {
			onCloseSection: (id) => deleteSession(id).catch((e) => console.error(e)),
		})
			.then((r) => {
				if (disposed) return r.destroy()
				renderer = r
				;(window as any).renderer = r
			})
			.catch((e) => setError(String(e.message ?? e)))

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
			<ToolPicker editor={editor} />
			<Toolbar editor={editor} />
			<StatusBar editor={editor} />
			<EmptyState editor={editor} />
			{error && (
				<div className="error">
					<strong>Can't start the renderer.</strong>
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
				<path d="M5 3l14 8-6.5 1.5L9 19z" fill="currentColor" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
			</svg>
		),
	},
	{
		id: 'hand',
		label: 'Hand',
		key: 'H',
		icon: (
			<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
				<path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8" />
				<path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-5.9-2.4l-3.6-3.6a2 2 0 0 1 2.8-2.8L7 15" />
			</svg>
		),
	},
]

function ToolPicker({ editor }: { editor: Editor }) {
	const current = useValue(() => editor.currentToolId.get())
	return (
		<div className="toolbar tools" onPointerDown={(e) => e.stopPropagation()}>
			{TOOLS.map((tool) => (
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

function Toolbar({ editor }: { editor: Editor }) {
	const zoom = useValue(() => Math.round(editor.camera.get().z * 100))
	const hasSelection = useValue(() => editor.selectedIds.get().length > 0)
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
		return item ? `${item.caption ?? item.id} — ${item.width}×${item.height}` : null
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
