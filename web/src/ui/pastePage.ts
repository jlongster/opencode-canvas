import type { Editor } from '../editor/Editor'
import { parsePairLink } from '../opencode/pairings'
import { postPage } from '../sync/client'

/**
 * Pasted links go in a frame of their own on each canvas, "Pasted links": a session id no
 * OpenCode session has (the shape of one, which the server requires), so no agent posts there.
 */
export const PASTED_SESSION_ID = 'ses_PastedLinks000000000000000'
const PASTED_TITLE = 'Pasted links'

/**
 * Edit links: pasting a web address (Cmd/Ctrl+V of plain text that is just an http(s) URL) onto
 * the canvas adds a link to that page (a link card: nothing fetches it) to the "Pasted links" frame, then shows it. Pastes into
 * text fields, of files, of other text and of OpenCode pairing links are left alone.
 */
export function listenForPastedPages(editor: Editor, canvasId: string): () => void {
	const onPaste = (e: ClipboardEvent) => {
		if (editable(e.target) || editable(document.activeElement)) return
		const data = e.clipboardData
		if (!data || data.files.length) return
		const text = data.getData('text/plain').trim()
		if (!/^https?:\/\/[^\s]+$/i.test(text) || parsePairLink(text)) return
		let url: URL
		try {
			url = new URL(text)
		} catch {
			return
		}
		e.preventDefault()
		const domain = url.hostname.replace(/^www\./, '')
		editor.deletions.notify(`Adding a link to ${domain}…`)
		postPage(canvasId, PASTED_SESSION_ID, url.href, { sessionTitle: PASTED_TITLE })
			.then((item) => showWhenLaidOut(editor, item.id))
			.catch((err: Error) => editor.deletions.notify(`Couldn't add ${domain}: ${err.message}`))
	}
	document.addEventListener('paste', onPaste)
	return () => document.removeEventListener('paste', onPaste)
}

function editable(el: EventTarget | Element | null): boolean {
	return el instanceof HTMLElement && !!el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]')
}

/** Selects the new item and brings it into view once it's on the canvas (it arrives with the live event). */
function showWhenLaidOut(editor: Editor, id: string, tries = 40) {
	if (editor.layout.get().items.has(id)) {
		editor.select([id])
		editor.zoomToItem(id)
		return
	}
	if (tries > 0) setTimeout(() => showWhenLaidOut(editor, id, tries - 1), 50)
}
