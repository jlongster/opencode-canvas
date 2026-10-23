import type { AnnotationView, Canvas, CanvasData, CanvasSummary, Item, ItemDelivery, OpenCodeSessionInfo, ServerEvent, SessionLink } from '../../../shared/types'
import type { Editor } from '../editor/Editor'
import { react, type Atom } from '../state/signals'
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

/**
 * Gives a session a frame (if it has none). `title` is only a fallback, shown until a paired browser
 * reports the session from OpenCode; `serverKey` is the OpenCode it's on.
 */
export const addSessionFrame = (canvasId: string, id: string, meta: { title?: string; serverKey?: string }) =>
	request<unknown>(`/api/canvases/${encodeURIComponent(canvasId)}/sessions/${encodeURIComponent(id)}`, json('PUT', meta))

/** What OpenCode says about the canvas's sessions, for everyone looking (see opencode/live.ts). Sessions without a frame are ignored. */
export const mirrorSessions = (canvasId: string, sessions: ({ sessionId: string; serverKey: string } & OpenCodeSessionInfo)[]) =>
	request<{ updated: string[] }>(`/api/canvases/${encodeURIComponent(canvasId)}/opencode`, json('PUT', { sessions }))

/** Gives the frames' subagents that have none a frame (no items: they show as orbs on their parent's title). */
export const addSubagents = (canvasId: string, sessions: ({ sessionId: string; serverKey: string } & OpenCodeSessionInfo)[]) =>
	request<{ added: string[] }>(`/api/canvases/${encodeURIComponent(canvasId)}/subagents`, json('POST', { sessions }))

/** Hides or shows a session's frame for everyone. */
export const setSessionHidden = (canvasId: string, id: string, hidden: boolean) =>
	request<unknown>(`/api/canvases/${encodeURIComponent(canvasId)}/sessions/${encodeURIComponent(id)}`, json('PATCH', { hidden }))

/** Arranges the canvas's frames, left to right (every session id, hidden ones too). */
export const setSessionOrder = (canvasId: string, sessionIds: string[]) =>
	request<{ sessionIds: string[] }>(`/api/canvases/${encodeURIComponent(canvasId)}/order`, json('PUT', { sessionIds }))

/** Moves an item to the trash; the server deletes its session too if it was the last item. */
export const deleteItem = (id: string) => request<unknown>(`/api/items/${encodeURIComponent(id)}`, { method: 'DELETE' })

/** Brings deleted items and sessions back from the trash (within an hour of deleting them). */
export const restoreDeleted = (canvasId: string, ids: { itemIds: string[]; sessionIds: string[] }) =>
	request<unknown>(`/api/canvases/${encodeURIComponent(canvasId)}/restore`, json('POST', ids))

/** Annotations on a session's items, resolved by the server (pixel bbox, item), without consuming them. */
export const peekAnnotations = (canvasId: string, sessionId: string) =>
	request<AnnotationView[]>(`/api/canvases/${encodeURIComponent(canvasId)}/annotations?sessionId=${encodeURIComponent(sessionId)}&keep=true`)

/** Marks annotations delivered to their session (consumed, as when an agent reads them). */
export const consumeAnnotations = (canvasId: string, ids: string[], sessionId: string) =>
	request<AnnotationView[]>(`/api/canvases/${encodeURIComponent(canvasId)}/annotations/consume`, json('POST', { ids, sessionId }))

/** Uploads media as an item (multipart). createdAt orders it in its group; sessionTitle is its frame's fallback title. */
export function uploadItem(
	canvasId: string,
	sessionId: string,
	data: Blob,
	meta: {
		filename: string
		group?: string
		title?: string
		caption?: string
		createdAt?: number
		sessionTitle?: string
		/** a frame extracted from a video: that video item, and the time in it (seconds) */
		sourceItemId?: string
		sourceTime?: number
		/** a person dragged or pasted it onto the frame: their name (the item becomes a person item, see Item.origin) */
		addedBy?: string
	},
) {
	const form = new FormData()
	form.set('file', data, meta.filename)
	for (const key of ['group', 'title', 'caption', 'createdAt', 'sessionTitle', 'sourceItemId', 'sourceTime', 'addedBy'] as const) {
		const value = meta[key]
		if (value !== undefined && value !== '') form.set(key, String(value))
	}
	return request<Item>(`/api/canvases/${encodeURIComponent(canvasId)}/sessions/${encodeURIComponent(sessionId)}/items`, { method: 'POST', body: form })
}

/**
 * Records that the session now has these person items' media (sent with message `messageId`), or
 * with clear, that it has none of them any more (it compacted). See Item.delivered.
 */
export const markDelivered = (
	canvasId: string,
	sessionId: string,
	body: { itemIds: string[]; messageId?: string; via: ItemDelivery['via'] } | { clear: true },
) => request<{ items: Item[] }>(`/api/canvases/${encodeURIComponent(canvasId)}/sessions/${encodeURIComponent(sessionId)}/delivered`, json('POST', body))

/** Posts a link to a web page as a page item (without a screenshot: a link card). */
export const postPage = (canvasId: string, sessionId: string, page: string, meta: { sessionTitle?: string; group?: string } = {}) =>
	request<Item>(`/api/canvases/${encodeURIComponent(canvasId)}/sessions/${encodeURIComponent(sessionId)}/items`, json('POST', { page, ...meta }))

// ---------- session links (records; the owner's browser talks to OpenCode, see multiplayer/SessionHost.ts) ----------

const linksPath = (canvasId: string, sessionId?: string) =>
	`/api/canvases/${encodeURIComponent(canvasId)}/links${sessionId ? `/${encodeURIComponent(sessionId)}` : ''}`

/** Links an OpenCode session to this browser (409 if another browser linked it). */
export const linkSession = (canvasId: string, link: { sessionId: string; serverKey: string; ownerId: string }) =>
	request<SessionLink>(linksPath(canvasId), json('POST', link))
export const unlinkSession = (canvasId: string, sessionId: string) => request<unknown>(linksPath(canvasId, sessionId), { method: 'DELETE' })

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
/** while any session we report is working, the report is sent again this often (the server drops one a minute old) */
const BUSY_REFRESH_MS = 20_000

/**
 * A live event socket at /api/live (optionally for one canvas) that keeps itself alive. onOpen runs
 * on every (re)connect, so callers reload their state there and miss nothing while disconnected; it
 * gets a function that sends a message on that connection.
 *
 * Behind exe.dev's proxy a connection can die silently: no close event, nothing arrives. So we ping
 * every HEARTBEAT_MS, and if nothing (not even a pong) comes back for DEAD_AFTER_MS we abandon the
 * socket and reconnect right away. (Waiting for close() would hang: a close handshake can't
 * complete on a dead connection.)
 */
export function liveSocket(
	canvasId: string | null,
	handlers: {
		onOpen: (send: (message: string) => void) => void
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
			handlers.onOpen((message) => ws.readyState === WebSocket.OPEN && ws.send(message))
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
		/** the canvas's session links: all of them on every load, then each change */
		onLinks?: (change: { all: SessionLink[] } | { put: SessionLink } | { deleted: string }) => void
		/** which sessions are working: all of them on every load, then each change */
		onStatus?: (change: { all: string[] } | { sessionId: string; busy: boolean }) => void
		/** the canvas's sessions this tab sees working, to report to the canvas server for everyone (edit links) */
		reportBusy?: Atom<string[]>
		/** which sessions wait on an answer: all of them on every load, then each change */
		onAsking?: (change: { all: string[] } | { sessionId: string; asking: boolean }) => void
		/** the canvas's sessions this tab sees waiting on an answer, reported the same way (edit links) */
		reportAsking?: Atom<string[]>
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
			editor.setSessionOrder(data.canvas.sessionOrder)
			const first = !loaded
			loaded = true
			handlers.onLinks?.({ all: data.links ?? [] })
			handlers.onStatus?.({ all: data.busy ?? [] })
			handlers.onAsking?.({ all: data.asking ?? [] })
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
				if (event.canvas.id !== canvasId) return
				editor.setSessionOrder(event.canvas.sessionOrder)
				handlers.onCanvas(event.canvas)
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
			case 'link':
				if (event.link.canvasId === canvasId) handlers.onLinks?.({ put: event.link })
				return
			case 'link_deleted':
				if (event.canvasId === canvasId) handlers.onLinks?.({ deleted: event.sessionId })
				return
			case 'status':
				if (event.canvasId === canvasId) handlers.onStatus?.({ sessionId: event.sessionId, busy: event.busy })
				return
			case 'asking':
				if (event.canvasId === canvasId) handlers.onAsking?.({ sessionId: event.sessionId, asking: event.asking })
				return
			case 'annotations_consumed':
				if (event.canvasId === canvasId) editor.annotationsConsumed?.(event.ids, event.sessionId)
				return
		}
	}

	// What we report is sent on every connection (the server drops it when the socket closes), on every change, and while anything's working, every BUSY_REFRESH_MS.
	let send: ((message: string) => void) | null = null
	let reportTimer = 0
	const report = () => {
		clearInterval(reportTimer)
		const ids = handlers.reportBusy?.peek()
		const asking = handlers.reportAsking?.peek()
		if (!send) return
		const messages = [
			...(ids ? [JSON.stringify({ type: 'busy', sessionIds: ids })] : []),
			...(asking ? [JSON.stringify({ type: 'asking', sessionIds: asking })] : []),
		]
		for (const m of messages) send(m)
		if (ids?.length || asking?.length) reportTimer = window.setInterval(() => messages.forEach((m) => send?.(m)), BUSY_REFRESH_MS)
	}
	const stopReport =
		handlers.reportBusy || handlers.reportAsking
			? react(() => {
					handlers.reportBusy?.get()
					handlers.reportAsking?.get()
					report()
				})
			: null

	const startLive = (id: string) => {
		stopLive = liveSocket(id, {
			onOpen: (sendOn) => {
				send = sendOn
				report()
				void load()
			},
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
		stopReport?.()
		clearInterval(reportTimer)
	}
}
