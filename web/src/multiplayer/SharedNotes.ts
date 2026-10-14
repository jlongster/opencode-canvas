import * as Y from 'yjs'
import type { Role } from '../sync/client'
import type { NoteSnapshot } from '../editor/Deletions'
import type { Editor } from '../editor/Editor'
import type { Box, Vec } from '../editor/geometry'
import { noteKey } from '../editor/selection'
import { react } from '../state/signals'
import type { Presence } from './Presence'

/** Page-space size of a note; the DOM is scaled with the camera, like the images. */
const NOTE_W = 220
const NOTE_H = 180
export const NOTE_COLORS = ['#fde68a', '#fbcfe8', '#bbf7d0', '#bfdbfe', '#ddd6fe']
/** Each note is tilted by a random angle in ±MAX_TILT degrees, stored with the note so everyone sees the same tilt. */
const MAX_TILT = 2.5
/** Transaction origin for our own typing, so the text observer can skip echoing it back. */
const LOCAL_EDIT = Symbol('local-note-edit')
/** Screen px the pointer moves before a press on a note becomes a drag. */
const DRAG_DISTANCE = 4

/**
 * Sticky notes stored in the room's Y.Doc, so everyone on a canvas sees them live and editors
 * can type into them together. Each note is a Y.Map { x, y, color, rotation, author, createdAt,
 * text: Y.Text }. View links see notes read-only and can't create them.
 *
 * Notes are part of the editor's selection (keys "note:<id>"): a click selects a note, a click on
 * an already-selected note (so also a double-click) starts typing, and the header drags it.
 */
export class SharedNotes {
	private doc: Y.Doc
	private notes: Y.Map<Y.Map<unknown>>
	private host: HTMLDivElement
	private views = new Map<string, NoteView>()
	private disposers: (() => void)[] = []

	constructor(
		private parent: HTMLElement,
		readonly editor: Editor,
		private presence: Presence,
		private role: Role,
	) {
		this.doc = presence.doc
		this.notes = presence.doc.getMap('notes')
		this.host = document.createElement('div')
		this.host.className = 'note-layer'
		parent.appendChild(this.host)

		const onChange = () => this.sync()
		this.notes.observeDeep(onChange)
		this.disposers.push(() => this.notes.unobserveDeep(onChange))
		this.sync()

		// Only edit links get the note tool, and can delete notes.
		if (role === 'edit') {
			editor.createNote = (point) => this.create(point)
			editor.deletions.notes = { remove: (ids) => this.removeNotes(ids), restore: (snaps) => this.restoreNotes(snaps) }
			this.disposers.push(() => {
				editor.createNote = null
				editor.deletions.notes = null
			})
		}
		this.disposers.push(editor.onFrame(() => this.position()))
		// Our selection in accent blue, other people's in their colour.
		this.disposers.push(
			react(() => {
				editor.selectedSet.get()
				presence.peers.get()
				for (const view of this.views.values()) this.showSelection(view)
			}),
		)
	}

	create(point: Vec) {
		const id = crypto.randomUUID().slice(0, 12)
		const note = new Y.Map<unknown>()
		this.doc.transact(() => {
			note.set('x', point.x - NOTE_W / 2)
			note.set('y', point.y - 20)
			note.set('color', NOTE_COLORS[0])
			note.set('rotation', (Math.random() * 2 - 1) * MAX_TILT)
			note.set('author', this.presence.me.peek().name)
			note.set('createdAt', Date.now())
			note.set('text', new Y.Text())
			this.notes.set(id, note)
		})
		this.editor.select([noteKey(id)])
		// sync() ran synchronously from the observer, so the view exists now. Focus on the next frame:
		// the click that created the note would otherwise move focus straight back to the page.
		const view = this.views.get(id)
		if (view) requestAnimationFrame(() => view.textarea.focus())
	}

	/** Deletes notes, returning what's needed to bring them back (for undo). */
	private removeNotes(ids: string[]): NoteSnapshot[] {
		const snapshots: NoteSnapshot[] = []
		this.doc.transact(() => {
			for (const id of ids) {
				const note = this.notes.get(id)
				if (!note) continue
				const fields: Record<string, unknown> = {}
				let text = ''
				for (const [key, value] of note.entries()) {
					if (value instanceof Y.Text) text = value.toString()
					else fields[key] = value
				}
				snapshots.push({ id, fields, text })
				this.notes.delete(id)
			}
		})
		return snapshots
	}

	private restoreNotes(snapshots: NoteSnapshot[]) {
		this.doc.transact(() => {
			for (const { id, fields, text } of snapshots) {
				if (this.notes.has(id)) continue
				const note = new Y.Map<unknown>()
				for (const [key, value] of Object.entries(fields)) note.set(key, value)
				note.set('text', new Y.Text(text))
				this.notes.set(id, note)
			}
		})
	}

	destroy() {
		for (const d of this.disposers.splice(0)) d()
		for (const view of this.views.values()) view.destroy()
		this.views.clear()
		this.host.remove()
	}

	/** Create, update and remove note views to match the document. */
	private sync() {
		const live = new Set<string>()
		const boxes: Record<string, Box> = {}
		const all = [...this.notes.entries()].sort(
			([, a], [, b]) => ((a.get('createdAt') as number) ?? 0) - ((b.get('createdAt') as number) ?? 0),
		)
		for (const [id, note] of all) {
			if (!(note.get('text') instanceof Y.Text)) continue
			const key = id
			live.add(key)
			let view = this.views.get(key)
			if (!view) {
				view = new NoteView(id, note, this, this.role === 'edit')
				this.views.set(key, view)
				this.host.appendChild(view.el)
				// e.g. a note restored by undo comes back selected
				this.showSelection(view)
			}
			view.update()
			boxes[id] = { x: note.get('x') as number, y: note.get('y') as number, w: NOTE_W, h: NOTE_H }
		}
		for (const [key, view] of this.views) {
			if (live.has(key)) continue
			view.destroy()
			this.views.delete(key)
		}
		this.editor.setNoteBoxes(boxes)
	}

	private showSelection(view: NoteView) {
		const key = noteKey(view.id)
		const peer = this.presence.peers.peek().find((p) => p.selection?.includes(key))
		view.setSelected(this.editor.selectedIds.peek().includes(key), peer?.user.color ?? null)
	}

	private position() {
		for (const view of this.views.values()) view.place(this.editor)
	}

	// ---- used by NoteView ----

	transact(fn: () => void, origin?: unknown) {
		this.doc.transact(fn, origin)
	}

	get noteMap() {
		return this.notes
	}

	/** Page point under a pointer event. */
	pagePoint(e: PointerEvent): Vec {
		const rect = this.parent.getBoundingClientRect()
		return this.editor.screenToPage({ x: e.clientX - rect.left, y: e.clientY - rect.top })
	}
}

class NoteView {
	readonly el: HTMLDivElement
	readonly textarea: HTMLTextAreaElement
	private author: HTMLSpanElement
	private colorButton: HTMLButtonElement
	private text: Y.Text
	private lastTransform = ''
	private lastZoom = 0
	private unobserve: () => void

	constructor(
		readonly id: string,
		readonly note: Y.Map<unknown>,
		private owner: SharedNotes,
		private editable: boolean,
	) {
		this.text = note.get('text') as Y.Text
		this.el = document.createElement('div')
		this.el.className = `note${editable ? '' : ' locked'}`
		this.el.style.width = `${NOTE_W}px`
		this.el.style.height = `${NOTE_H}px`
		this.el.innerHTML =
			'<div class="note-header"><span class="note-author"></span>' +
			(editable ? '<button class="note-color" title="Change colour"></button>' : '') +
			'</div><textarea class="note-text" placeholder="Type something…" spellcheck="false"></textarea>'
		this.author = this.el.querySelector('.note-author')!
		this.colorButton = this.el.querySelector('.note-color') ?? document.createElement('button')
		this.textarea = this.el.querySelector('textarea')!
		this.textarea.value = this.text.toString()
		this.textarea.readOnly = !editable

		// Notes handle their own pointer input (in every tool); the canvas shouldn't select, brush or pan underneath.
		this.el.addEventListener('pointerdown', (e) => this.onPointerDown(e))
		this.el.addEventListener('dblclick', (e) => e.stopPropagation())

		if (editable) {
			this.colorButton.addEventListener('click', () => {
				const i = NOTE_COLORS.indexOf(note.get('color') as string)
				owner.transact(() => note.set('color', NOTE_COLORS[(i + 1) % NOTE_COLORS.length]))
			})
			this.textarea.addEventListener('input', () => this.applyLocalEdit())
		}
		this.textarea.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') this.textarea.blur()
		})

		const observer = (event: Y.YTextEvent) => this.applyRemoteEdit(event)
		this.text.observe(observer)
		this.unobserve = () => this.text.unobserve(observer)
	}

	update() {
		const color = (this.note.get('color') as string) ?? NOTE_COLORS[0]
		this.el.style.background = color
		this.colorButton.style.background = color
		const author = (this.note.get('author') as string) ?? ''
		if (this.author.textContent !== author) this.author.textContent = author

	}

	/** Our selection (accent outline) and the colour of someone else's, if they've selected it. */
	setSelected(selected: boolean, peerColor: string | null) {
		this.el.classList.toggle('selected', selected)
		this.el.classList.toggle('remote-selected', peerColor !== null)
		if (peerColor) this.el.style.setProperty('--peer', peerColor)
	}

	place(editor: Editor) {
		const tilt = (this.note.get('rotation') as number | undefined) ?? tiltFromId(this.id)
		const p = editor.pageToScreen(this.target())
		const z = editor.camera.peek().z
		// Outlines are scaled with the note, so they divide by the zoom to stay the same width on screen.
		if (z !== this.lastZoom) {
			this.lastZoom = z
			this.el.style.setProperty('--z', String(z))
		}
		// Scale from the top-left (so x/y stay the note's corner), but tilt around the centre.
		const transform =
			`translate(${p.x}px, ${p.y}px) scale(${z}) translate(${NOTE_W / 2}px, ${NOTE_H / 2}px) ` +
			`rotate(${tilt}deg) translate(${-NOTE_W / 2}px, ${-NOTE_H / 2}px)`
		if (transform === this.lastTransform) return
		this.lastTransform = transform
		this.el.style.transform = transform
	}

	destroy() {
		this.unobserve()
		this.el.remove()
	}

	private target(): Vec {
		return { x: this.note.get('x') as number, y: this.note.get('y') as number }
	}

	/** Turn the textarea's new value into a minimal delete + insert on the shared text. */
	private applyLocalEdit() {
		const before = this.text.toString()
		const after = this.textarea.value
		let start = 0
		while (start < before.length && start < after.length && before[start] === after[start]) start++
		let endBefore = before.length
		let endAfter = after.length
		while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
			endBefore--
			endAfter--
		}
		this.owner.transact(() => {
			if (endBefore > start) this.text.delete(start, endBefore - start)
			if (endAfter > start) this.text.insert(start, after.slice(start, endAfter))
		}, LOCAL_EDIT)
	}

	/** Show someone else's typing, keeping our own caret where it was relative to the text. */
	private applyRemoteEdit(event: Y.YTextEvent) {
		if (event.transaction.origin === LOCAL_EDIT) return
		const focused = document.activeElement === this.textarea
		const { selectionStart, selectionEnd } = this.textarea
		const shift = (pos: number) => {
			let index = 0
			let result = pos
			for (const op of event.delta) {
				if (op.retain) index += op.retain
				else if (typeof op.insert === 'string') {
					if (index <= result) result += op.insert.length
					index += op.insert.length
				} else if (op.delete) {
					if (index < result) result -= Math.min(op.delete, result - index)
				}
			}
			return result
		}
		this.textarea.value = this.text.toString()
		if (focused) this.textarea.setSelectionRange(shift(selectionStart), shift(selectionEnd))
	}

	/**
	 * A press on the note: shift toggles it in the selection; a press on the text of a note that's
	 * already selected (or being edited) is left to the textarea, so it focuses with the caret where
	 * you clicked; anything else selects the note (without focusing the text) and starts a drag.
	 */
	private onPointerDown(e: PointerEvent) {
		// Space-drag and middle-drag pan the canvas, even over notes.
		if (e.button === 1 || this.owner.editor.inputs.isSpaceDown) return
		e.stopPropagation()
		if (e.button !== 0) return
		const target = e.target as HTMLElement
		if (target.tagName === 'BUTTON') return
		const editor = this.owner.editor
		const key = noteKey(this.id)
		const onText = target === this.textarea
		if (onText && document.activeElement === this.textarea) return
		const selected = editor.isSelected(key)
		if (onText && selected && this.editable && !e.shiftKey) {
			editor.select([key])
			return
		}
		e.preventDefault()
		// Preventing the default keeps focus where it was, so let go of any other note's text.
		const active = document.activeElement as HTMLElement | null
		if (active && active !== this.textarea && active !== document.body) active.blur()
		if (e.shiftKey) return editor.toggleSelected(key)
		if (!selected) editor.select([key])
		if (this.editable) this.drag(e)
	}

	/** Drags this note, and any other selected notes along with it. */
	private drag(down: PointerEvent) {
		const editor = this.owner.editor
		const notes = this.owner.noteMap
		const ids = new Set([this.id])
		for (const key of editor.getSelectedIds()) if (key.startsWith('note:') && notes.has(key.slice(5))) ids.add(key.slice(5))
		const starts = [...ids].map((id) => {
			const note = notes.get(id)!
			return { note, x: note.get('x') as number, y: note.get('y') as number }
		})
		const origin = this.owner.pagePoint(down)
		const originScreen = { x: down.clientX, y: down.clientY }
		let dragging = false
		this.el.setPointerCapture(down.pointerId)

		const move = (e: PointerEvent) => {
			if (e.pointerId !== down.pointerId) return
			if (!dragging && Math.hypot(e.clientX - originScreen.x, e.clientY - originScreen.y) < DRAG_DISTANCE) return
			if (!dragging) {
				dragging = true
				this.el.classList.add('dragging')
			}
			const p = this.owner.pagePoint(e)
			this.owner.transact(() => {
				for (const s of starts) {
					s.note.set('x', s.x + p.x - origin.x)
					s.note.set('y', s.y + p.y - origin.y)
				}
			})
		}
		const end = (e: PointerEvent) => {
			if (e.pointerId !== down.pointerId) return
			this.el.classList.remove('dragging')
			if (this.el.hasPointerCapture(e.pointerId)) this.el.releasePointerCapture(e.pointerId)
			this.el.removeEventListener('pointermove', move)
			this.el.removeEventListener('pointerup', end)
			this.el.removeEventListener('pointercancel', end)
			this.el.removeEventListener('lostpointercapture', end)
		}
		this.el.addEventListener('pointermove', move)
		this.el.addEventListener('pointerup', end)
		this.el.addEventListener('pointercancel', end)
		this.el.addEventListener('lostpointercapture', end)
	}
}

/** A stable tilt for notes created before tilts were stored. */
function tiltFromId(id: string) {
	let h = 0
	for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
	return ((((h % 1000) + 1000) % 1000) / 1000 * 2 - 1) * MAX_TILT
}
