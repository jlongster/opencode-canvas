import * as Y from 'yjs'
import type { ShareRole } from '../../../shared/types'
import type { Editor } from '../editor/Editor'
import { Box, easeOutCubic, type Vec } from '../editor/geometry'
import { react } from '../state/signals'
import type { Presence } from './Presence'

/** Page-space size of a note; the DOM is scaled with the camera, like the images. */
const NOTE_W = 220
const NOTE_H = 180
export const NOTE_COLORS = ['#fde68a', '#fbcfe8', '#bbf7d0', '#bfdbfe', '#ddd6fe']
/** Each note is tilted by a random angle in ±MAX_TILT degrees, stored with the note so everyone sees the same tilt. */
const MAX_TILT = 2.5
/** Gap kept between a viewer note and the images it was pushed off. */
const CLEARANCE = 28
const SWOOSH_MS = 650
/** Transaction origin for our own typing, so the text observer can skip echoing it back. */
const LOCAL_EDIT = Symbol('local-note-edit')

/**
 * "editor" notes come from edit links and live in the share's main document, which view links
 * can't write. "viewer" notes come from view-only links and live in a second document anyone can
 * write. Viewer notes are drawn faded and are never allowed to sit on top of an image.
 */
export type NoteKind = 'editor' | 'viewer'

/**
 * Sticky notes stored in the room's Y.Doc, so everyone on a shared page sees them and can type
 * into them together. Each note is a Y.Map { x, y, color, rotation, author, createdAt, text: Y.Text,
 * bumpedAt? }.
 */
export class SharedNotes {
	private docs: Record<NoteKind, Y.Doc>
	private maps: Record<NoteKind, Y.Map<Y.Map<unknown>>>
	private host: HTMLDivElement
	private views = new Map<string, NoteView>()
	private disposers: (() => void)[] = []

	constructor(
		private parent: HTMLElement,
		private editor: Editor,
		private presence: Presence,
		private role: ShareRole,
	) {
		this.docs = { editor: presence.doc, viewer: presence.viewerDoc }
		this.maps = { editor: presence.doc.getMap('notes'), viewer: presence.viewerDoc.getMap('notes') }
		this.host = document.createElement('div')
		this.host.className = 'note-layer'
		parent.appendChild(this.host)

		const onChange = () => this.sync()
		for (const map of Object.values(this.maps)) {
			map.observeDeep(onChange)
			this.disposers.push(() => map.unobserveDeep(onChange))
		}
		this.sync()

		editor.createNote = (point) => this.create(point)
		this.disposers.push(() => (editor.createNote = null))
		this.disposers.push(editor.onFrame((now) => this.position(now)))
		// The hand tool pans everywhere, including over notes.
		this.disposers.push(react(() => this.host.classList.toggle('passthrough', editor.currentToolId.get() === 'hand')))
	}

	/** Edit links can change every note; view links only viewer notes. */
	canEdit(kind: NoteKind) {
		return this.role === 'edit' || kind === 'viewer'
	}

	create(point: Vec) {
		const kind: NoteKind = this.role === 'edit' ? 'editor' : 'viewer'
		const id = crypto.randomUUID().slice(0, 12)
		const note = new Y.Map<unknown>()
		this.docs[kind].transact(() => {
			note.set('x', point.x - NOTE_W / 2)
			note.set('y', point.y - 20)
			note.set('color', NOTE_COLORS[0])
			note.set('rotation', (Math.random() * 2 - 1) * MAX_TILT)
			note.set('author', this.presence.me.peek().name)
			note.set('createdAt', Date.now())
			note.set('text', new Y.Text())
			this.maps[kind].set(id, note)
		})
		// sync() ran synchronously from the observer, so the view exists now. Focus on the next frame:
		// the click that created the note would otherwise move focus straight back to the page.
		const view = this.views.get(`${kind}:${id}`)
		if (view) {
			this.settle(view)
			requestAnimationFrame(() => view.textarea.focus())
		}
	}

	destroy() {
		for (const d of this.disposers.splice(0)) d()
		for (const view of this.views.values()) view.destroy()
		this.views.clear()
		this.host.remove()
	}

	/**
	 * Viewer notes can't cover images. If one does, move it to the nearest free spot; the
	 * `bumpedAt` stamp tells every client to animate the move as a swoosh.
	 */
	settle(view: NoteView) {
		if (view.kind !== 'viewer') return
		const at = { x: view.note.get('x') as number, y: view.note.get('y') as number }
		const obstacles = [...this.editor.layout.get().items.values()].map((b) => Box.expand(b, CLEARANCE))
		const spot = findFreeSpot(at, obstacles)
		if (spot.x === at.x && spot.y === at.y) return
		this.docs.viewer.transact(() => {
			view.note.set('x', spot.x)
			view.note.set('y', spot.y)
			view.note.set('swooshFrom', at)
			view.note.set('bumpedAt', Date.now())
		})
	}

	/** Create, update and remove note views to match the document. */
	private sync() {
		const live = new Set<string>()
		const all = (Object.keys(this.maps) as NoteKind[]).flatMap((kind) =>
			[...this.maps[kind].entries()].map(([id, note]) => ({ kind, id, note })),
		)
		all.sort((a, b) => ((a.note.get('createdAt') as number) ?? 0) - ((b.note.get('createdAt') as number) ?? 0))
		for (const { kind, id, note } of all) {
			if (!(note.get('text') instanceof Y.Text)) continue
			const key = `${kind}:${id}`
			live.add(key)
			let view = this.views.get(key)
			if (!view) {
				view = new NoteView(kind, id, note, this, this.canEdit(kind))
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

	private position(now: number) {
		for (const view of this.views.values()) view.place(now, this.editor)
	}

	// ---- used by NoteView ----

	transact(kind: NoteKind, fn: () => void, origin?: unknown) {
		this.docs[kind].transact(fn, origin)
	}

	remove(view: NoteView) {
		this.maps[view.kind].delete(view.id)
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
	/** Where the note is drawn (page coords); differs from its stored x/y only while swooshing. */
	private shown: Vec | null = null
	private swoosh: { from: Vec; to: Vec; start: number; spin: number } | null = null
	private lastBumpedAt: number

	constructor(
		readonly kind: NoteKind,
		readonly id: string,
		readonly note: Y.Map<unknown>,
		private owner: SharedNotes,
		private editable: boolean,
	) {
		this.text = note.get('text') as Y.Text
		this.lastBumpedAt = 0
		this.el = document.createElement('div')
		this.el.className = `note${kind === 'viewer' ? ' from-viewer' : ''}${editable ? '' : ' locked'}`
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
				owner.transact(kind, () => note.set('color', NOTE_COLORS[(i + 1) % NOTE_COLORS.length]))
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

		// A new bumpedAt means the note was pushed off an image: swoosh from where it was dropped.
		// (Also when the note first appears, if the push just happened, e.g. a fresh drop.)
		const bumpedAt = (this.note.get('bumpedAt') as number) ?? 0
		if (bumpedAt !== this.lastBumpedAt) {
			const isFresh = this.lastBumpedAt !== 0 || Date.now() - bumpedAt < SWOOSH_MS
			this.lastBumpedAt = bumpedAt
			const from = (this.note.get('swooshFrom') as Vec | undefined) ?? this.shown
			const to = this.target()
			if (isFresh && from && (from.x !== to.x || from.y !== to.y)) {
				this.swoosh = { from: { ...from }, to, start: performance.now(), spin: Math.sign(to.x - from.x || 1) * 12 }
			}
		}
	}

	place(now: number, editor: Editor) {
		const target = this.target()
		let tilt = (this.note.get('rotation') as number | undefined) ?? tiltFromId(this.id)
		let scale = 1
		if (this.swoosh) {
			const t = Math.min(1, (now - this.swoosh.start) / SWOOSH_MS)
			// Overshoot a little and settle, with a spin that unwinds: a quick "swoosh" off the image.
			const k = easeOutBack(t)
			this.swoosh.to = target
			this.shown = {
				x: this.swoosh.from.x + (target.x - this.swoosh.from.x) * k,
				y: this.swoosh.from.y + (target.y - this.swoosh.from.y) * k,
			}
			tilt += this.swoosh.spin * (1 - easeOutCubic(t))
			scale = 1 + 0.06 * Math.sin(Math.PI * t)
			this.el.classList.toggle('swooshing', t < 1)
			if (t >= 1) this.swoosh = null
		} else {
			this.shown = target
		}

		const p = editor.pageToScreen(this.shown)
		const z = editor.camera.peek().z
		// Scale from the top-left (so x/y stay the note's corner), but tilt around the centre.
		const transform =
			`translate(${p.x}px, ${p.y}px) scale(${z}) translate(${NOTE_W / 2}px, ${NOTE_H / 2}px) ` +
			`rotate(${tilt}deg) scale(${scale}) translate(${-NOTE_W / 2}px, ${-NOTE_H / 2}px)`
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
		this.owner.transact(this.kind, () => {
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

	/** Drag the note by its header. Viewer notes settle off any image when dropped. */
	private setupDrag() {
		const header = this.el.querySelector<HTMLDivElement>('.note-header')!
		let start: { pointer: Vec; note: Vec } | null = null
		header.addEventListener('pointerdown', (e) => {
			if (e.button !== 0 || (e.target as HTMLElement).tagName === 'BUTTON') return
			e.preventDefault()
			header.setPointerCapture(e.pointerId)
			this.swoosh = null
			start = { pointer: this.owner.pagePoint(e), note: this.target() }
			this.el.classList.add('dragging')
		})
		header.addEventListener('pointermove', (e) => {
			if (!start) return
			const p = this.owner.pagePoint(e)
			const s = start
			this.owner.transact(this.kind, () => {
				this.note.set('x', s.note.x + p.x - s.pointer.x)
				this.note.set('y', s.note.y + p.y - s.pointer.y)
			})
		})
		const end = (e: PointerEvent) => {
			if (!start) return
			start = null
			this.el.classList.remove('dragging')
			if (header.hasPointerCapture(e.pointerId)) header.releasePointerCapture(e.pointerId)
			this.owner.settle(this)
		}
		header.addEventListener('pointerup', end)
		header.addEventListener('pointercancel', end)
	}
}

/**
 * Where a viewer note should go so it doesn't cover any image. First choice is "off to the side":
 * just past the left or right end of the run of images in the note's row. If neither side is free,
 * it escapes the whole block of images it landed on (images close enough to touch count as one
 * block), growing the block whenever an exit runs into another one.
 */
function findFreeSpot(at: Vec, obstacles: Box[]): Vec {
	const noteAt = (p: Vec): Box => ({ x: p.x, y: p.y, w: NOTE_W, h: NOTE_H })
	// Strict overlap: a note exactly touching an image's edge is fine.
	const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
	const hits = (p: Vec) => obstacles.filter((o) => overlaps(o, noteAt(p)))
	const nearest = (candidates: Vec[]) =>
		candidates
			.sort((p, q) => Math.hypot(p.x - at.x, p.y - at.y) - Math.hypot(q.x - at.x, q.y - at.y))
			.find((c) => !hits(c).length)

	if (!hits(at).length) return at

	// 1. Sideways: the images in the note's row band, chained left and right from the ones it covers.
	const inBand = obstacles.filter((o) => o.y < at.y + NOTE_H && o.y + o.h > at.y)
	let left = Math.min(...hits(at).map((o) => o.x))
	let right = Math.max(...hits(at).map((o) => o.x + o.w))
	for (let changed = true; changed; ) {
		changed = false
		for (const o of inBand) {
			if (o.x + o.w < left || o.x > right) continue
			if (o.x < left || o.x + o.w > right) changed = true
			left = Math.min(left, o.x)
			right = Math.max(right, o.x + o.w)
		}
	}
	const sideways = nearest([
		{ x: left - NOTE_W, y: at.y },
		{ x: right, y: at.y },
	])
	if (sideways) return sideways

	// 2. Otherwise, out of the whole block in whichever direction is closest.
	let block = new Set(hits(at))
	// Grow to every image connected to the ones under the note.
	const grow = () => {
		for (let changed = true; changed; ) {
			changed = false
			for (const o of obstacles) {
				if (block.has(o) || ![...block].some((b) => overlaps(o, b))) continue
				block.add(o)
				changed = true
			}
		}
	}
	for (let round = 0; round < 6; round++) {
		grow()
		const b = Box.union(block)!
		const candidates = [
			{ x: b.x - NOTE_W, y: at.y },
			{ x: b.x + b.w, y: at.y },
			{ x: at.x, y: b.y - NOTE_H },
			{ x: at.x, y: b.y + b.h },
		]
		const free = nearest(candidates)
		if (free) return free
		for (const c of candidates) for (const o of hits(c)) block.add(o)
	}
	const all = Box.union(obstacles)!
	return { x: all.x - NOTE_W, y: at.y }
}

function easeOutBack(t: number) {
	const c1 = 1.70158
	const c3 = c1 + 1
	return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)
}

/** A stable tilt for notes created before tilts were stored. */
function tiltFromId(id: string) {
	let h = 0
	for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
	return ((((h % 1000) + 1000) % 1000) / 1000 * 2 - 1) * MAX_TILT
}
