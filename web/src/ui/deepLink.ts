import type { Editor } from '../editor/Editor'
import type { GroupLayout } from '../editor/layout'
import { frameKey, groupKey, noteKey, parseSelectionId } from '../editor/selection'
import { react } from '../state/signals'

/** Notes come from the Yjs doc, a little after the canvas data; wait this long for a linked one. */
const NOTE_WAIT_MS = 4000

const HASH_KINDS = { item: 'item', session: 'frame', note: 'note' } as const

/**
 * The selection key a hash like "#item=abc", "#session=abc", "#note=abc" or
 * "#group=<session id>/<group name>" points at (a group key for groups; see selection.ts).
 */
export function parseHash(hash: string): string | null {
	const m = /^#(item|session|note|group)=(.*)$/.exec(hash.replace(DRAWER_SUFFIX, ''))
	if (!m) return null
	try {
		if (m[1] === 'group') {
			// The session id and the name are encoded separately; the untitled group has an empty name.
			const raw = m[2].includes('/') ? m[2] : decodeURIComponent(m[2])
			const slash = raw.indexOf('/')
			if (slash < 1) return null
			return groupKey(`${decodeURIComponent(raw.slice(0, slash))}/${decodeURIComponent(raw.slice(slash + 1))}`)
		}
		if (!m[2]) return null
		const id = decodeURIComponent(m[2])
		const kind = HASH_KINDS[m[1] as keyof typeof HASH_KINDS]
		return kind === 'frame' ? frameKey(id) : kind === 'note' ? noteKey(id) : id
	} catch {
		return null
	}
}

/** Added to an item's hash while it's open in the side drawer (see HtmlDrawer). */
const DRAWER_SUFFIX = /&drawer=1$/

/** The item a hash like "#item=abc&drawer=1" opens in the side drawer. */
export function parseDrawerHash(hash: string): string | null {
	if (!DRAWER_SUFFIX.test(hash)) return null
	const key = parseHash(hash)
	return key && parseSelectionId(key).kind === 'item' ? key : null
}

export function hashForDrawer(itemId: string) {
	return `#item=${encodeURIComponent(itemId)}&drawer=1`
}

/** The hash for a linked group (see Editor.focusGroup) or a selection of one thing; anything else gets none. */
export function hashForSelection(ids: string[], group?: GroupLayout | null): string {
	if (group) return `#group=${encodeURIComponent(group.sessionId)}/${encodeURIComponent(group.name ?? '')}`
	if (ids.length !== 1) return ''
	const { kind, id } = parseSelectionId(ids[0])
	return `#${kind === 'frame' ? 'session' : kind}=${encodeURIComponent(id)}`
}

function writeHash(hash: string) {
	if (location.hash === hash || (!hash && !location.hash)) return
	history.replaceState(history.state, '', `${location.pathname}${location.search}${hash}`)
}

/**
 * Keeps the URL hash pointing at the item open in the side drawer, or else the single selected thing, and focuses whatever a hash points
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
				const hash = this.currentHash()
				if (this.ready) writeHash(hash)
			}),
		)
		const onHashChange = () => {
			if (!this.ready) return
			const drawer = parseDrawerHash(location.hash)
			if (drawer && editor.openHtmlDrawer(drawer)) return
			editor.closeHtmlDrawer()
			const key = parseHash(location.hash)
			if (key) this.focus(key, () => this.settle())
		}
		window.addEventListener('hashchange', onHashChange)
		this.disposers.push(() => window.removeEventListener('hashchange', onHashChange))
	}

	/** The opening view: the linked thing if there is one, otherwise `goToInitialView`. */
	focusInitial() {
		// Opening the drawer from a link also shows its item behind it, for when it's closed.
		const drawer = parseDrawerHash(location.hash)
		if (drawer && this.editor.items.peek()[drawer]?.kind === 'html') this.editor.openHtmlDrawer(drawer)
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
		const { kind, id } = parseSelectionId(key)
		// A renamed or removed group: show its session instead, if that's still here.
		if (kind === 'group' && editor.focusMissingGroup(id, { animate: false })) return this.settle()
		if (kind !== 'note') {
			// In a hidden frame: say so (edit links can show it from the toast).
			const hidden = editor.hiddenSessionOf(key)
			editor.hiddenLink.set(hidden ? { key, sessionId: hidden } : null)
			return onMissing()
		}

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
		writeHash(this.currentHash())
	}

	/** The open drawer's item, else the selection; closing the drawer goes back to the selection's hash. */
	private currentHash() {
		const drawer = this.editor.htmlDrawer.get()
		return drawer ? hashForDrawer(drawer) : hashForSelection(this.editor.selectedIds.get(), this.editor.linkedGroup.get())
	}

	destroy() {
		this.cancelWait?.()
		for (const d of this.disposers.splice(0)) d()
	}
}
