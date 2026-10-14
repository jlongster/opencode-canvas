import type { Editor } from '../editor/Editor'
import { frameKey, noteKey, parseSelectionId } from '../editor/selection'
import { react } from '../state/signals'

/** Notes come from the Yjs doc, a little after the canvas data; wait this long for a linked one. */
const NOTE_WAIT_MS = 4000

const HASH_KINDS = { item: 'item', session: 'frame', note: 'note' } as const

/** The selection key a hash like "#item=abc", "#session=abc" or "#note=abc" points at. */
export function parseHash(hash: string): string | null {
	const m = /^#(item|session|note)=(.+)$/.exec(hash)
	if (!m) return null
	let id: string
	try {
		id = decodeURIComponent(m[2])
	} catch {
		return null
	}
	const kind = HASH_KINDS[m[1] as keyof typeof HASH_KINDS]
	return kind === 'frame' ? frameKey(id) : kind === 'note' ? noteKey(id) : id
}

/** The hash for a selection: one thing gets a link, anything else none. */
export function hashForSelection(ids: string[]): string {
	if (ids.length !== 1) return ''
	const { kind, id } = parseSelectionId(ids[0])
	return `#${kind === 'frame' ? 'session' : kind}=${encodeURIComponent(id)}`
}

/** This page's URL pointing at the selection (or at nothing, if it isn't exactly one thing). */
export function urlForSelection(ids: string[]): string {
	return `${location.origin}${location.pathname}${location.search}${hashForSelection(ids)}`
}

function writeHash(hash: string) {
	if (location.hash === hash || (!hash && !location.hash)) return
	history.replaceState(history.state, '', `${location.pathname}${location.search}${hash}`)
}

/**
 * Keeps the URL hash pointing at the single selected thing, and focuses whatever a hash points
 * at: once on load (call `focusInitial` when the canvas data is in and the viewport has a size)
 * and whenever the hash is changed by hand. Until the load-time focus is settled the hash is
 * left alone, so the empty selection at startup doesn't wipe it.
 */
export class DeepLink {
	private ready = false
	/** Stops waiting for a linked note that hasn't arrived yet. */
	private cancelWait: (() => void) | null = null
	private disposers: (() => void)[] = []

	constructor(private editor: Editor) {
		this.disposers.push(
			react(() => {
				const ids = editor.selectedIds.get()
				if (this.ready) writeHash(hashForSelection(ids))
			}),
		)
		const onHashChange = () => {
			if (!this.ready) return
			const key = parseHash(location.hash)
			if (key) this.focus(key, () => this.settle())
		}
		window.addEventListener('hashchange', onHashChange)
		this.disposers.push(() => window.removeEventListener('hashchange', onHashChange))
	}

	/** The opening view: the linked thing if there is one, otherwise `goToInitialView`. */
	focusInitial() {
		const key = parseHash(location.hash)
		if (!key) {
			this.editor.goToInitialView()
			return this.settle()
		}
		this.focus(key, () => {
			this.editor.goToInitialView()
			this.settle()
		})
	}

	/** Focus the key now, or (for notes) once it shows up; calls onMissing if it never does. */
	private focus(key: string, onMissing: () => void) {
		this.cancelWait?.()
		const { editor } = this
		if (editor.focusSelectionKey(key, { animate: false })) return this.settle()
		if (parseSelectionId(key).kind !== 'note') return onMissing()

		// Show the normal view meanwhile; give up if the person starts looking around themselves.
		if (!this.ready) editor.goToInitialView()
		const camera = editor.camera.peek()
		const selection = editor.selectedIds.peek()
		let done = false
		const end = () => {
			done = true
			clearTimeout(timer)
			stop()
			this.cancelWait = null
		}
		const timer = setTimeout(() => {
			end()
			onMissing()
		}, NOTE_WAIT_MS)
		const stop = react(() => {
			const found = !!editor.noteBoxes.get()[parseSelectionId(key).id]
			const moved = editor.camera.get() !== camera || editor.selectedIds.get() !== selection
			if (done || (!found && !moved)) return
			queueMicrotask(() => {
				if (done) return
				end()
				if (!moved) editor.focusSelectionKey(key, { animate: false })
				this.settle()
			})
		})
		this.cancelWait = end
	}

	/** From here on the hash follows the selection (clearing a link to something missing). */
	private settle() {
		this.ready = true
		writeHash(hashForSelection(this.editor.selectedIds.peek()))
	}

	destroy() {
		this.cancelWait?.()
		for (const d of this.disposers.splice(0)) d()
	}
}
