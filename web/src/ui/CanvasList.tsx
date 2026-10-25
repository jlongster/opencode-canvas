import { useEffect, useRef, useState } from 'react'
import type { CanvasSummary } from '../../../shared/types'
import { createCanvas, deleteCanvas, listCanvases, liveSocket } from '../sync/client'
import { BASE, url } from '../base'
import { ConnectOpenCode } from './ConnectOpenCode'
import { Wordmark } from './Wordmark'

/**
 * The home page: connecting OpenCode (first, until it's connected), then every canvas as a card,
 * kept up to date live. With no canvases yet, a prominent button makes the first.
 */
export function CanvasList() {
	const [canvases, setCanvases] = useState<CanvasSummary[] | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [creating, setCreating] = useState(false)
	const [connection, setConnection] = useState<'connecting' | 'open'>('connecting')

	useEffect(() => {
		document.title = 'Canvases'
		let disposed = false
		let timer = 0
		const refresh = () => {
			listCanvases()
				.then((list) => {
					if (disposed) return
					setCanvases(list)
					setError(null)
				})
				.catch((e) => !disposed && setError((e as Error).message))
		}
		// Bursts of events (e.g. an agent posting many items) refetch once.
		const scheduleRefresh = () => {
			clearTimeout(timer)
			timer = window.setTimeout(refresh, 150)
		}
		refresh()
		const stop = liveSocket(null, { onOpen: refresh, onEvent: scheduleRefresh, onStatus: setConnection })
		return () => {
			disposed = true
			clearTimeout(timer)
			stop()
		}
	}, [])

	const create = async () => {
		setCreating(true)
		try {
			const canvas = await createCanvas()
			location.href = `${BASE}/c/${canvas.id}`
		} catch (e) {
			setError((e as Error).message)
			setCreating(false)
		}
	}

	const remove = (id: string) => {
		setCanvases((list) => list?.filter((c) => c.id !== id) ?? null)
		deleteCanvas(id).catch((e) => setError((e as Error).message))
	}

	return (
		<div className="canvas-list">
			<header className="canvas-list-head">
				<div className="canvas-list-mark">
					<Wordmark size={44} />
					<div>
						<h1>Canvases</h1>
						<span className="canvas-list-sub">
							<span className={`dot ${connection}`} title={connection} />
							OpenCode Canvas · {canvases ? `${canvases.length} canvas${canvases.length === 1 ? '' : 'es'}` : 'Loading…'}
						</span>
					</div>
				</div>
				{canvases?.length !== 0 && <NewCanvasButton creating={creating} onClick={create} />}
			</header>
			<ConnectOpenCode />
			{error && <div className="canvas-list-error">{error}</div>}
			{canvases && canvases.length === 0 && (
				<div className="canvas-list-empty">
					<h2>No canvases yet</h2>
					<p>A canvas collects the images, videos and HTML your sessions make. Seed it from your OpenCode sessions, or let agents post to it.</p>
					<NewCanvasButton creating={creating} onClick={create} label="Create your first canvas" />
				</div>
			)}
			{canvases && canvases.length > 0 && (
				<div className="canvas-grid">
					{canvases.map((c) => (
						<CanvasCard key={c.id} canvas={c} onDelete={() => remove(c.id)} />
					))}
				</div>
			)}
		</div>
	)
}

function NewCanvasButton({ creating, onClick, label = 'New canvas' }: { creating: boolean; onClick: () => void; label?: string }) {
	return (
		<button className="new-canvas" disabled={creating} onClick={onClick}>
			<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
				<path d="M12 5v14M5 12h14" />
			</svg>
			{creating ? 'Creating…' : label}
		</button>
	)
}

function CanvasCard({ canvas, onDelete }: { canvas: CanvasSummary; onDelete: () => void }) {
	const previews = canvas.previews.slice(0, 4)
	return (
		<div className="canvas-card">
			<a href={`${BASE}/c/${canvas.id}`} className="canvas-card-link">
				<div className={`canvas-card-previews n${previews.length}`}>
					{previews.length === 0 ? (
						<span className="canvas-card-blank">Empty</span>
					) : (
						previews.map((src, i) => <img key={i} src={url(src)} alt="" loading="lazy" draggable={false} />)
					)}
				</div>
				<div className="canvas-card-info">
					<strong title={canvas.title}>{canvas.title}</strong>
					<span>
						{canvas.sessionCount} session{canvas.sessionCount === 1 ? '' : 's'} · {canvas.itemCount} item
						{canvas.itemCount === 1 ? '' : 's'}
					</span>
					<span className="canvas-card-date" title={new Date(canvas.createdAt).toLocaleString()}>
						Created {relativeTime(canvas.createdAt)}
					</span>
				</div>
			</a>
			<DeleteButton onConfirm={onDelete} />
		</div>
	)
}

/** Deleting is permanent, so it takes two clicks: the first arms the button, the second deletes. */
function DeleteButton({ onConfirm }: { onConfirm: () => void }) {
	const [armed, setArmed] = useState(false)
	const timer = useRef(0)
	const disarm = () => {
		clearTimeout(timer.current)
		setArmed(false)
	}
	useEffect(() => () => clearTimeout(timer.current), [])
	return (
		<button
			className={`canvas-card-delete${armed ? ' armed' : ''}`}
			title="Delete this canvas"
			onPointerLeave={disarm}
			onClick={() => {
				if (!armed) {
					setArmed(true)
					timer.current = window.setTimeout(disarm, 3000)
					return
				}
				disarm()
				onConfirm()
			}}
		>
			{armed ? 'Delete' : '×'}
		</button>
	)
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
	['year', 365 * 24 * 3600],
	['month', 30 * 24 * 3600],
	['week', 7 * 24 * 3600],
	['day', 24 * 3600],
	['hour', 3600],
	['minute', 60],
]

function relativeTime(at: number) {
	const seconds = (at - Date.now()) / 1000
	const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
	for (const [unit, size] of UNITS) {
		if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit)
	}
	return 'just now'
}
