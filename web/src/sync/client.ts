import type { Canvas, CanvasData, CanvasSummary, ConjuredAgent, Item, ServerEvent } from '../../../shared/types'
import type { Editor } from '../editor/Editor'
import { API_BASE, BASE, url as withBase, wsUrl } from '../base'

/** Edit links (/c/:id) open a canvas by id; view links (/v/:viewKey) by its secret view key. */
export type CanvasLink = { role: 'edit'; id: string } | { role: 'view'; viewKey: string }
export type Role = CanvasLink['role']

/** Share links for a canvas, as shown in the UI: on the canvas server, which serves the app too. */
export const editUrl = (canvas: Canvas) => `${API_BASE}/c/${canvas.id}`
export const viewUrl = (canvas: Canvas) => `${API_BASE}/v/${canvas.viewKey}`
export const listUrl = () => `${BASE}/`

/** Fails with an Error carrying the response's status. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(withBase(path), init)
	if (!res.ok) {
		const message = (await res.json().catch(() => null))?.error ?? `request failed: ${res.status}`
		throw Object.assign(new Error(message), { status: res.status })
	}
	return (await res.json()) as T
}

const json = (method: string, body: unknown): RequestInit => ({
	method,
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify(body),
})

export const listCanvases = () => request<CanvasSummary[]>('/api/canvases')
export const createCanvas = (title?: string) => request<Canvas>('/api/canvases', json('POST', title ? { title } : {}))
export const renameCanvas = (id: string, title: string) =>
	request<Canvas>(`/api/canvases/${encodeURIComponent(id)}`, json('PATCH', { title }))
export const deleteCanvas = (id: string) =>
	request<{ ok: boolean }>(`/api/canvases/${encodeURIComponent(id)}`, { method: 'DELETE' })

/** Moves a session and its items to the server's trash (see restore). The canvas updates from the server's event. */
export const deleteSession = (canvasId: string, id: string) =>
	request<unknown>(`/api/canvases/${encodeURIComponent(canvasId)}/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })

/** Moves an item to the trash; the server deletes its session too if it was the last item. */
export const deleteItem = (id: string) => request<unknown>(`/api/items/${encodeURIComponent(id)}`, { method: 'DELETE' })

/** Brings deleted items and sessions back from the trash (within an hour of deleting them). */
export const restoreDeleted = (canvasId: string, ids: { itemIds: string[]; sessionIds: string[] }) =>
	request<unknown>(`/api/canvases/${encodeURIComponent(canvasId)}/restore`, json('POST', ids))

/** Uploads media as an item (multipart). createdAt orders it in its group; sessionTitle names a session this creates. */
export function uploadItem(
	canvasId: string,
	sessionId: string,
	data: Blob,
	meta: { filename: string; group?: string; title?: string; caption?: string; createdAt?: number; sessionTitle?: string },
) {
	const form = new FormData()
	form.set('file', data, meta.filename)
	for (const key of ['group', 'title', 'caption', 'createdAt', 'sessionTitle'] as const) {
		const value = meta[key]
		if (value !== undefined && value !== '') form.set(key, String(value))
	}
	return request<Item>(`/api/canvases/${encodeURIComponent(canvasId)}/sessions/${encodeURIComponent(sessionId)}/items`, { method: 'POST', body: form })
}

// ---------- conjured worms (records; the owner's browser runs them, see multiplayer/WormHost.ts) ----------

const conjuredPath = (canvasId: string, sessionId?: string) =>
	`/api/canvases/${encodeURIComponent(canvasId)}/conjured${sessionId ? `/${encodeURIComponent(sessionId)}` : ''}`

export const listConjured = (canvasId: string) => request<ConjuredAgent[]>(conjuredPath(canvasId))
/** Brings an OpenCode session onto the canvas as a worm at page position (x, y). Fails with status 409 if it's already here. */
export const conjure = (
	canvasId: string,
	worm: { sessionId: string; serverKey: string; ownerId: string; title: string; x: number; y: number },
) => request<ConjuredAgent>(conjuredPath(canvasId), json('POST', worm))
export const banishConjured = (canvasId: string, sessionId: string) =>
	request<unknown>(conjuredPath(canvasId, sessionId), { method: 'DELETE' })
/** Moves the worm and/or renames it. */
export const updateConjured = (canvasId: string, sessionId: string, changes: { x?: number; y?: number; title?: string }) =>
	request<ConjuredAgent>(conjuredPath(canvasId, sessionId), json('PATCH', changes))

/** Thrown when a canvas doesn't exist (or was deleted). */
export class CanvasNotFound extends Error {}

export async function loadCanvas(link: CanvasLink): Promise<CanvasData> {
	const path = link.role === 'edit' ? `/api/canvases/${encodeURIComponent(link.id)}` : `/api/view/${encodeURIComponent(link.viewKey)}`
	const res = await fetch(withBase(path))
	if (res.status === 404) throw new CanvasNotFound('This canvas does not exist.')
	if (!res.ok) throw new Error(`Could not load the canvas (${res.status}).`)
	return (await res.json()) as CanvasData
}

const HEARTBEAT_MS = 4_000
const DEAD_AFTER_MS = 12_000

/**
 * A live event socket at /api/live (optionally for one canvas) that keeps itself alive. onOpen runs
 * on every (re)connect, so callers reload their state there and miss nothing while disconnected.
 *
 * Behind exe.dev's proxy a connection can die silently: no close event, nothing arrives. So we ping
 * every HEARTBEAT_MS, and if nothing (not even a pong) comes back for DEAD_AFTER_MS we abandon the
 * socket and reconnect right away. (Waiting for close() would hang: a close handshake can't
 * complete on a dead connection.)
 */
export function liveSocket(
	canvasId: string | null,
	handlers: {
		onOpen: () => void
		onEvent: (event: ServerEvent) => void
		onStatus?: (status: 'connecting' | 'open') => void
	},
): () => void {
	let socket: WebSocket | null = null
	let closed = false
	let retryMs = 500
	let retryTimer = 0
	let heartbeat = 0
	let lastHeard = 0
	const path = wsUrl(canvasId ? `/api/live?canvas=${encodeURIComponent(canvasId)}` : '/api/live')

	const reconnect = (delay: number) => {
		clearInterval(heartbeat)
		clearTimeout(retryTimer)
		if (closed) return
		handlers.onStatus?.('connecting')
		retryTimer = window.setTimeout(open, delay)
	}

	const open = () => {
		const ws = new WebSocket(path)
		socket = ws
		ws.onopen = () => {
			retryMs = 500
			lastHeard = Date.now()
			handlers.onStatus?.('open')
			handlers.onOpen()
			clearInterval(heartbeat)
			heartbeat = window.setInterval(() => {
				if (Date.now() - lastHeard > DEAD_AFTER_MS) {
					ws.onclose = ws.onmessage = null
					ws.close()
					return reconnect(0)
				}
				ws.send('ping')
			}, HEARTBEAT_MS)
		}
		ws.onmessage = (msg) => {
			lastHeard = Date.now()
			if (msg.data === 'pong') return
			handlers.onEvent(JSON.parse(msg.data) as ServerEvent)
		}
		ws.onclose = () => {
			reconnect(retryMs)
			retryMs = Math.min(retryMs * 2, 5000)
		}
	}
	open()

	// Background tabs get throttled or frozen, so a socket can go stale while hidden. When the tab
	// comes back, reconnect straight away if we haven't heard from the server recently.
	const onVisible = () => {
		if (document.visibilityState !== 'visible' || closed) return
		if (Date.now() - lastHeard > HEARTBEAT_MS * 1.5) {
			if (socket) {
				socket.onclose = socket.onmessage = null
				socket.close()
			}
			reconnect(0)
		}
	}
	document.addEventListener('visibilitychange', onVisible)

	return () => {
		closed = true
		clearTimeout(retryTimer)
		clearInterval(heartbeat)
		document.removeEventListener('visibilitychange', onVisible)
		if (socket) {
			socket.onclose = socket.onmessage = null
			socket.close()
		}
	}
}

/**
 * Loads a canvas into the editor, then applies its live events. Every reconnect reloads the full
 * canvas. onLoad runs after each load with the canvas record; onGone when it doesn't exist (any
 * more); onError for other failures of the first load.
 */
export function connectCanvas(
	editor: Editor,
	link: CanvasLink,
	handlers: {
		onLoad: (canvas: Canvas, first: boolean) => void
		onCanvas: (canvas: Canvas) => void
		/** the canvas's conjured worms: all of them on every load, then each change */
		onConjured?: (change: { all: ConjuredAgent[] } | { put: ConjuredAgent } | { deleted: string }) => void
		onGone: () => void
		onError: (error: Error) => void
	},
): () => void {
	let closed = false
	let loaded = false
	let stopLive: (() => void) | null = null
	let canvasId: string | null = null

	const gone = () => {
		if (closed) return
		closed = true
		stopLive?.()
		editor.connection.set('closed')
		handlers.onGone()
	}

	const load = async () => {
		try {
			const data = await loadCanvas(link)
			if (closed) return
			canvasId = data.canvas.id
			editor.loadSnapshot(data.sessions, data.items)
			const first = !loaded
			loaded = true
			handlers.onConjured?.({ all: data.conjured ?? [] })
			handlers.onLoad(data.canvas, first)
		} catch (e) {
			if (closed) return
			if (e instanceof CanvasNotFound) return gone()
			if (!loaded) handlers.onError(e as Error)
			else console.error('reload failed', e)
		}
	}

	const apply = (event: ServerEvent) => {
		switch (event.type) {
			case 'canvas':
				if (event.canvas.id === canvasId) handlers.onCanvas(event.canvas)
				return
			case 'canvas_deleted':
				if (event.id === canvasId) gone()
				return
			case 'session':
				if (event.session.canvasId === canvasId) editor.putSession(event.session)
				return
			case 'session_deleted':
				if (event.canvasId === canvasId) editor.deleteSession(event.id)
				return
			case 'item':
				if (event.item.canvasId === canvasId) editor.putItem(event.item)
				return
			case 'item_deleted':
				if (event.canvasId === canvasId) editor.deleteItem(event.id)
				return
			case 'conjured':
				if (event.agent.canvasId === canvasId) handlers.onConjured?.({ put: event.agent })
				return
			case 'conjured_deleted':
				if (event.canvasId === canvasId) handlers.onConjured?.({ deleted: event.sessionId })
				return
		}
	}

	const startLive = (id: string) => {
		stopLive = liveSocket(id, {
			onOpen: () => void load(),
			onEvent: apply,
			onStatus: (status) => editor.connection.set(status),
		})
	}

	// Load once before subscribing: view links only learn the canvas id from it, and a missing
	// canvas shows up as a 404 here rather than as a socket that never opens. The socket's first
	// open reloads, so nothing between the two is missed.
	load().then(() => {
		if (!closed && loaded && canvasId) startLive(canvasId)
	})

	return () => {
		closed = true
		stopLive?.()
	}
}
