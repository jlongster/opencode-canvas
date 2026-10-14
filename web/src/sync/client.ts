import type { OpenedShare, ServerEvent, Share, Snapshot } from '../../../shared/types'
import type { Editor } from '../editor/Editor'
import { url as withBase } from '../base'

export interface ShareLinks {
	id: string
	viewUrl: string
	editUrl: string
}

/** Freezes the current canvas into a share and returns its view and edit links. */
export async function createShare(view: Share['view']): Promise<ShareLinks> {
	const res = await fetch(withBase('/api/shares'), {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ view }),
	})
	if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `share failed: ${res.status}`)
	return (await res.json()) as ShareLinks
}

export type ShareLink = { kind: 'view'; id: string } | { kind: 'edit'; key: string }

/** Loads a share into the editor (no live updates). Edit links come back with role "edit". */
export async function loadShare(editor: Editor, link: ShareLink): Promise<OpenedShare> {
	const res = await fetch(withBase(link.kind === 'edit' ? `/api/edit/${link.key}` : `/api/shares/${link.id}`))
	if (!res.ok) throw new Error(res.status === 404 ? 'This share link does not exist.' : `Could not load share (${res.status}).`)
	const share = (await res.json()) as OpenedShare
	editor.loadSnapshot(share.sessions, share.items)
	return share
}

/** Permanently deletes a session and its media. The canvas updates from the server's event. */
export async function deleteSession(id: string) {
	const res = await fetch(withBase(`/api/sessions/${encodeURIComponent(id)}`), { method: 'DELETE' })
	if (!res.ok) throw new Error(`delete failed: ${res.status}`)
}

/** Loads a snapshot, then applies live events. Re-syncs from a fresh snapshot after reconnects. */
const HEARTBEAT_MS = 4_000
const DEAD_AFTER_MS = 12_000

export function connect(editor: Editor, onFirstLoad: () => void): () => void {
	let socket: WebSocket | null = null
	let loaded = false
	let closed = false
	let retryMs = 500
	let retryTimer = 0
	let heartbeat = 0
	let lastHeard = 0

	const loadSnapshot = async () => {
		const res = await fetch(withBase('/api/state'))
		const snap = (await res.json()) as Snapshot
		if (closed) return
		editor.loadSnapshot(snap.sessions, snap.items)
		if (!loaded) {
			loaded = true
			onFirstLoad()
		}
	}

	const apply = (event: ServerEvent) => {
		switch (event.type) {
			case 'session':
				return editor.putSession(event.session)
			case 'session_deleted':
				return editor.deleteSession(event.id)
			case 'item':
				return editor.putItem(event.item)
			case 'item_deleted':
				return editor.deleteItem(event.id)
		}
	}

	// Live changes arrive over a WebSocket. Every (re)connect reloads the full state, so nothing
	// that happened while disconnected is missed.
	//
	// Behind exe.dev's proxy a connection can die silently: no close event, nothing arrives. So we
	// ping every HEARTBEAT_MS, and if nothing (not even a pong) comes back for DEAD_AFTER_MS we
	// abandon the socket and reconnect right away. (Waiting for close() would hang: a close
	// handshake can't complete on a dead connection.)
	const reconnect = (delay: number) => {
		clearInterval(heartbeat)
		clearTimeout(retryTimer)
		if (closed) return
		editor.connection.set('connecting')
		retryTimer = window.setTimeout(open, delay)
	}

	const open = () => {
		const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${withBase('/api/live')}`)
		socket = ws
		ws.onopen = () => {
			retryMs = 500
			lastHeard = Date.now()
			editor.connection.set('open')
			loadSnapshot().catch((e) => console.error('snapshot failed', e))
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
			apply(JSON.parse(msg.data) as ServerEvent)
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
		socket?.close()
	}
}
