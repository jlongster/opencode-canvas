import type { ServerEvent, Share, Snapshot } from '../../../shared/types'
import type { Editor } from '../editor/Editor'

/** Freezes the current canvas into a share and returns its full URL. */
export async function createShare(view: Share['view']): Promise<string> {
	const res = await fetch('/api/shares', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ view }),
	})
	if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `share failed: ${res.status}`)
	const { url } = (await res.json()) as { url: string }
	return new URL(url, location.origin).toString()
}

/** Loads a share into the editor (read-only, no live updates). */
export async function loadShare(editor: Editor, id: string): Promise<Share> {
	const res = await fetch(`/api/shares/${id}`)
	if (!res.ok) throw new Error(res.status === 404 ? 'This share link does not exist.' : `Could not load share (${res.status}).`)
	const share = (await res.json()) as Share
	editor.loadSnapshot(share.sessions, share.items)
	return share
}

/** Permanently deletes a session and its media. The canvas updates from the server's event. */
export async function deleteSession(id: string) {
	const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
	if (!res.ok) throw new Error(`delete failed: ${res.status}`)
}

/** Loads a snapshot, then applies live events. Re-syncs from a fresh snapshot after reconnects. */
export function connect(editor: Editor, onFirstLoad: () => void): () => void {
	let source: EventSource | null = null
	let loaded = false
	let closed = false

	const loadSnapshot = async () => {
		const res = await fetch('/api/state')
		const snap = (await res.json()) as Snapshot
		if (closed) return
		editor.loadSnapshot(snap.sessions, snap.items)
		if (!loaded) {
			loaded = true
			onFirstLoad()
		}
	}

	source = new EventSource('/api/events')
	source.onopen = () => {
		editor.connection.set('open')
		loadSnapshot().catch((e) => console.error('snapshot failed', e))
	}
	source.onerror = () => editor.connection.set(source?.readyState === EventSource.CLOSED ? 'closed' : 'connecting')
	source.onmessage = (msg) => {
		const event = JSON.parse(msg.data) as ServerEvent
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

	return () => {
		closed = true
		source?.close()
	}
}
