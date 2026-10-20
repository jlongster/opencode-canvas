import { atom } from '../state/signals'
import type { Editor } from './Editor'
import { frameKey, noteKey, parseSelectionId } from './selection'

/** Everything needed to put a deleted sticky note back exactly as it was. */
export interface NoteSnapshot {
	id: string
	fields: Record<string, unknown>
	text: string
}

/** A deleted annotation's fields, to put it back (see SharedAnnotations). */
export interface AnnotationSnapshot {
	id: string
	fields: Record<string, unknown>
}

/** The annotations document (edit role only). */
export interface AnnotationStore {
	remove(ids: string[]): AnnotationSnapshot[]
	restore(snapshots: AnnotationSnapshot[]): void
}

/** Server side of deleting: items and sessions go to the server's trash and can be restored from it. */
export interface DeleteBackend {
	deleteItem(id: string): Promise<unknown>
	deleteSession(id: string): Promise<unknown>
	restore(ids: { itemIds: string[]; sessionIds: string[] }): Promise<unknown>
}

/** The sticky notes document (edit role only). */
export interface NoteStore {
	remove(ids: string[]): NoteSnapshot[]
	restore(snapshots: NoteSnapshot[]): void
}

interface Batch {
	itemIds: string[]
	sessionIds: string[]
	notes: NoteSnapshot[]
	annotations?: AnnotationSnapshot[]
}

export interface Toast {
	id: number
	message: string
	/** show the Undo button */
	undo: boolean
}

const MAX_UNDO = 30
const TOAST_MS = 5000

/**
 * Deleting the selection (items, session frames and notes together) and undoing it, batch by
 * batch. Only edit links set a backend and note store; without them, delete and undo do nothing.
 */
export class Deletions {
	backend: DeleteBackend | null = null
	notes: NoteStore | null = null
	annotations: AnnotationStore | null = null
	readonly toast = atom<Toast | null>('toast', null)
	private stack: Batch[] = []
	private toastTimer = 0
	private toastId = 0

	constructor(private editor: Editor) {}

	get canEdit() {
		return this.backend !== null
	}

	deleteSelected() {
		this.delete(this.editor.getSelectedIds())
	}

	/** Deletes the given selection keys (see selection.ts) as one undoable batch. */
	delete(keys: string[]) {
		const { backend, editor } = this
		if (!backend || !keys.length) return
		const sessionIds: string[] = []
		const itemIds: string[] = []
		const noteIds: string[] = []
		for (const key of keys) {
			const { kind, id } = parseSelectionId(key)
			if (kind === 'frame' && editor.sessions.peek()[id]) sessionIds.push(id)
			else if (kind === 'note') noteIds.push(id)
			else if (kind === 'item' && editor.items.peek()[id]) itemIds.push(id)
		}
		// Items in a deleted frame go with it.
		const frames = new Set(sessionIds)
		const looseItems = itemIds.filter((id) => !frames.has(editor.items.peek()[id].sessionId))
		const notes = noteIds.length ? (this.notes?.remove(noteIds) ?? []) : []
		if (!sessionIds.length && !looseItems.length && !notes.length) return

		const deleted = new Set([...keys])
		editor.select(editor.getSelectedIds().filter((k) => !deleted.has(k)))
		// Show the result straight away; the server's events confirm it.
		for (const id of looseItems) editor.deleteItem(id)
		for (const id of sessionIds) editor.deleteSession(id)

		this.stack.push({ itemIds: looseItems, sessionIds, notes })
		if (this.stack.length > MAX_UNDO) this.stack.shift()
		this.showToast(`Deleted ${describe(looseItems.length, sessionIds.length, notes.length)}`, true)

		Promise.all([...looseItems.map((id) => backend.deleteItem(id)), ...sessionIds.map((id) => backend.deleteSession(id))]).catch(
			(e) => {
				console.error(e)
				this.showToast("Couldn't delete everything", false)
			},
		)
	}

	/** Deletes annotations (their × button) as one undoable batch. */
	deleteAnnotations(ids: string[]) {
		if (!this.backend || !this.annotations || !ids.length) return
		const annotations = this.annotations.remove(ids)
		if (!annotations.length) return
		this.stack.push({ itemIds: [], sessionIds: [], notes: [], annotations })
		if (this.stack.length > MAX_UNDO) this.stack.shift()
		this.showToast(`Deleted ${annotations.length === 1 ? 'annotation' : `${annotations.length} annotations`}`, true)
	}

	/** Restores the most recent delete batch. */
	undo() {
		const { backend } = this
		if (!backend) return
		const batch = this.stack.pop()
		if (!batch) return
		if (batch.annotations?.length) {
			this.annotations?.restore(batch.annotations)
			if (!batch.itemIds.length && !batch.sessionIds.length && !batch.notes.length) {
				this.showToast(`Restored ${batch.annotations.length === 1 ? 'comment' : `${batch.annotations.length} comments`}`, false)
				return
			}
		}
		if (batch.notes.length) this.notes?.restore(batch.notes)
		if (batch.itemIds.length || batch.sessionIds.length) {
			backend.restore({ itemIds: batch.itemIds, sessionIds: batch.sessionIds }).catch((e) => {
				console.error(e)
				this.showToast("Couldn't restore (deleted over an hour ago?)", false)
			})
		}
		this.editor.select([...batch.itemIds, ...batch.sessionIds.map(frameKey), ...batch.notes.map((n) => noteKey(n.id))])
		this.showToast(`Restored ${describe(batch.itemIds.length, batch.sessionIds.length, batch.notes.length)}`, false)
	}

	/** Shows a plain message in the toast (no Undo). */
	notify(message: string) {
		this.showToast(message, false)
	}

	hideToast() {
		clearTimeout(this.toastTimer)
		this.toast.set(null)
	}

	private showToast(message: string, undo: boolean) {
		clearTimeout(this.toastTimer)
		this.toast.set({ id: ++this.toastId, message, undo })
		this.toastTimer = window.setTimeout(() => this.toast.set(null), TOAST_MS)
	}
}

/** "3 items", "1 session", "2 notes" (mixed kinds count as items). */
function describe(items: number, sessions: number, notes: number) {
	const total = items + sessions + notes
	const noun = sessions === total ? 'session' : notes === total ? 'note' : 'item'
	return `${total} ${noun}${total === 1 ? '' : 's'}`
}
