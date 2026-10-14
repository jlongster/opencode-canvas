import * as Y from 'yjs'
import type { ShareRole } from '../../../shared/types'
import type { Editor } from '../editor/Editor'
import type { Vec } from '../editor/geometry'
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

/**
 * Sticky notes stored in the room's Y.Doc, so everyone on a shared page sees them live and editors
 * can type into them together. Each note is a Y.Map { x, y, color, rotation, author, createdAt,
 * text: Y.Text }. View links see notes read-only and can't create them.
 */
export class SharedNotes {
	private doc: Y.Doc
	private notes: Y.Map<Y.Map<unknown>>
	private host: HTMLDivElement
	private views = new Map<string, NoteView>()
	private disposers: (() => void)[] = []

	constructor(
		private parent: HTMLElement,
		private editor: Editor,
		private presence: Presence,
		private role: ShareRole,
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

		// Only edit links get the note tool.
		if (role === 'edit') {
			editor.createNote = (point) => this.create(point)
			this.disposers.push(() => (editor.createNote = null))
		}
		this.disposers.push(editor.onFrame(() => this.position()))
		// The hand tool pans everywhere, including over notes.
		this.disposers.push(react(() => this.host.classList.toggle('passthrough', editor.currentToolId.get() === 'hand')))
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
		// sync() ran synchronously from the observer, so the view exists now. Focus on the next frame:
		// the click that created the note would otherwise move focus straight back to the page.
		const view = this.views.get(id)
		if (view) requestAnimationFrame(() => view.textarea.focus())
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
			}
			view.update()
		}
		for (const [key, view] of this.views) {
			if (live.has(key)) continue
			view.destroy()
			this.views.delete(key)
		}
	}

	private position() {
		for (const view of this.views.values()) view.place(this.editor)
	}

	// ---- used by NoteView ----

	transact(fn: () => void, origin?: unknown) {
		this.doc.transact(fn, origin)
	}

	remove(view: NoteView) {
		this.notes.delete(view.id)
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
			(editable
				? '<button class="note-color" title="Change colour"></button><button class="note-delete" title="Delete note">×</button>'
				: '') +
			'</div><textarea class="note-text" placeholder="Type something…" spellcheck="false"></textarea>'
		this.author = this.el.querySelector('.note-author')!
		this.colorButton = this.el.querySelector('.note-color') ?? document.createElement('button')
		this.textarea = this.el.querySelector('textarea')!
		this.textarea.value = this.text.toString()
		this.textarea.readOnly = !editable

		// Notes handle their own pointer input; the canvas shouldn't select or brush underneath.
		this.el.addEventListener('pointerdown', (e) => e.stopPropagation())
		this.el.addEventListener('dblclick', (e) => e.stopPropagation())

		if (editable) {
			this.el.querySelector<HTMLButtonElement>('.note-delete')!.addEventListener('click', () => owner.remove(this))
			this.colorButton.addEventListener('click', () => {
				const i = NOTE_COLORS.indexOf(note.get('color') as string)
				owner.transact(() => note.set('color', NOTE_COLORS[(i + 1) % NOTE_COLORS.length]))
			})
			this.textarea.addEventListener('input', () => this.applyLocalEdit())
			this.setupDrag()
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

	place(editor: Editor) {
		const tilt = (this.note.get('rotation') as number | undefined) ?? tiltFromId(this.id)
		const p = editor.pageToScreen(this.target())
		const z = editor.camera.peek().z
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

	/** Drag the note by its header. */
	private setupDrag() {
		const header = this.el.querySelector<HTMLDivElement>('.note-header')!
		let start: { pointer: Vec; note: Vec } | null = null
		header.addEventListener('pointerdown', (e) => {
			if (e.button !== 0 || (e.target as HTMLElement).tagName === 'BUTTON') return
			e.preventDefault()
			header.setPointerCapture(e.pointerId)
			start = { pointer: this.owner.pagePoint(e), note: this.target() }
			this.el.classList.add('dragging')
		})
		header.addEventListener('pointermove', (e) => {
			if (!start) return
			const p = this.owner.pagePoint(e)
			const s = start
			this.owner.transact(() => {
				this.note.set('x', s.note.x + p.x - s.pointer.x)
				this.note.set('y', s.note.y + p.y - s.pointer.y)
			})
		})
		const end = (e: PointerEvent) => {
			if (!start) return
			start = null
			this.el.classList.remove('dragging')
			if (header.hasPointerCapture(e.pointerId)) header.releasePointerCapture(e.pointerId)
		}
		header.addEventListener('pointerup', end)
		header.addEventListener('pointercancel', end)
	}
}

/** A stable tilt for notes created before tilts were stored. */
function tiltFromId(id: string) {
	let h = 0
	for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
	return ((((h % 1000) + 1000) % 1000) / 1000 * 2 - 1) * MAX_TILT
}
