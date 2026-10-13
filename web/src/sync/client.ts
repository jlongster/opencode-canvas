import type { ServerEvent, Snapshot } from '../../../shared/types'
import type { Editor } from '../editor/Editor'

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
