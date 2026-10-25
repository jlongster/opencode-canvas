import * as Y from 'yjs'
import { sessionColor } from '../../../shared/sessionColor'
import type { NoteAnchor } from '../../../shared/types'
import type { Role } from '../sync/client'
import type { NoteSnapshot } from '../editor/Deletions'
import { GROUP_OUTLINE_PADDING, type Editor } from '../editor/Editor'
import { Box, type Vec } from '../editor/geometry'
import { LAYOUT, type Layout } from '../editor/layout'
import { noteKey, parseSelectionId } from '../editor/selection'
import { atom, react } from '../state/signals'
import { markdownToHtml } from '../ui/markdown'
import { NOTE_H, NOTE_W, placeAgentNotes, pointerLine, type AgentNoteInput, type NotePlacement, type PlacementWorld } from './notePlacement'
import type { Presence } from './Presence'

export const NOTE_COLORS = ['#fde68a', '#fbcfe8', '#bbf7d0', '#bfdbfe', '#ddd6fe']
/** Each note is tilted by a random angle in ±MAX_TILT degrees, stored with the note so everyone sees the same tilt. */
const MAX_TILT = 2.5
/** Transaction origin for our own typing, so the text observer can skip echoing it back. */
const LOCAL_EDIT = Symbol('local-note-edit')
/** Screen px the pointer moves before a press on a note becomes a drag. */
const DRAG_DISTANCE = 4
/** How long a note stepped to from the attention bar stays emphasised (ms; see .note.attend) */
const ATTEND_MS = 1600
/** How quickly an agent's note glides to a new place (the others closing up after one is acknowledged, its target moving): ms to cover ~63% of the way */
const GLIDE_MS = 70
/** Screen radius of the ring round the exact point an agent's note points at */
const POINT_RING = 11
const SVG_NS = 'http://www.w3.org/2000/svg'

/** An agent's note (MCP say / highlight), as the attention bar lists it. */
export interface AgentNoteInfo {
	id: string
	sessionId: string
	kind: 'say' | 'highlight'
	text: string
	target?: string
	createdAt: number
	/** on the canvas (false while what it's anchored to is in a hidden frame) */
	shown: boolean
}

/**
 * Sticky notes stored in the room's Y.Doc, so everyone on a canvas sees them live and editors
 * can type into them together. Each note is a Y.Map { x, y, color, rotation, author, createdAt,
 * text: Y.Text }. View links see notes read-only and can't create them.
 *
 * Notes are part of the editor's selection (keys "note:<id>"): a click selects a note, a click on
 * an already-selected note (so also a double-click) starts typing, and the header drags it.
 *
 * Agents' notes (placed by MCP say / highlight, see server/attention.ts) also carry the session and
 * what they point at (NoteAnchor). They're placed here as the layout moves (see notePlacement.ts):
 * beside their target, with a pointer to an exact point or region, or at the top of the session's
 * frame. They show the session's colour and title and their Markdown read-only, and edit links get
 * a button to acknowledge one, which deletes it for everyone. Dragging one keeps it where it's put,
 * relative to what it's anchored to (fields dx, dy).
 */
export class SharedNotes {
	/** agents' notes, oldest first */
	readonly agentNotes = atom<AgentNoteInfo[]>('agentNotes', [], agentNotesEqual)
	/** An agent's note's "Later": on to the next note that wants attention (see App). */
	onLater: (() => void) | null = null
	private doc: Y.Doc
	private notes: Y.Map<Y.Map<unknown>>
	private host: HTMLDivElement
	/** the pointers from agents' notes to the exact spots they point at (screen space, under the notes) */
	private pointers: SVGSVGElement
	private views = new Map<string, NoteView>()
	private disposers: (() => void)[] = []
	/** people's notes' page boxes */
	private peopleBoxes: Record<string, Box> = {}
	/** where agents' notes are (missing: hidden), and what that was worked out for */
	private placements = new Map<string, NotePlacement>()
	private placedFor: { layout: Layout | null; scale: number } = { layout: null, scale: 0 }
	private needsPlacing = false

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
		this.pointers = document.createElementNS(SVG_NS, 'svg')
		this.pointers.classList.add('note-pointers')
		this.host.appendChild(this.pointers)
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
		this.disposers.push(editor.onFrame((_, elapsed) => this.position(elapsed)))
		// Our selection in accent blue, other people's in their colour.
		this.disposers.push(
			react(() => {
				editor.selectedSet.get()
				presence.peers.get()
				for (const view of this.views.values()) this.showSelection(view)
			}),
		)
		// Agents' notes show their session's title, and name what they point at when they say nothing.
		this.disposers.push(
			react(() => {
				editor.sessions.get()
				editor.items.get()
				for (const view of this.views.values()) if (view.agent) view.update()
			}),
		)
		// Agents' notes grow with their text, measured once the font is in.
		document.fonts?.ready.then(() => {
			for (const view of this.views.values()) view.measure()
		})
	}

	create(point: Vec) {
		const id = noteId()
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
		if (view?.textarea) requestAnimationFrame(() => view.textarea!.focus())
	}

	/** Acknowledges an agent's note: it's deleted for everyone, right away (edit links). */
	acknowledge(id: string) {
		if (this.role !== 'edit' || !this.notes.has(id)) return
		const key = noteKey(id)
		if (this.editor.isSelected(key)) this.editor.select(this.editor.getSelectedIds().filter((k) => k !== key))
		this.doc.transact(() => this.notes.delete(id))
	}

	/** Where an agent's note is on the page and what it points at, while it's shown. */
	placementOf(id: string): NotePlacement | undefined {
		// (what it's on may have just been laid out: a subagent's drawer opened to show it)
		if (this.placedFor.layout !== this.editor.layout.get()) this.placeAgents()
		return this.placements.get(id)
	}

	/** Briefly emphasises a note (stepped to from the attention bar), its pointer too. */
	emphasize(id: string) {
		this.views.get(id)?.attend()
	}

	/** A short name for what a highlight points at, e.g. “Header v2” or the group “Palettes”. */
	targetLabel(target: string): string {
		const { kind, id } = parseSelectionId(target)
		if (kind === 'group') return `the group “${id.slice(id.indexOf('/') + 1) || 'Untitled'}”`
		if (kind === 'frame') {
			const s = this.editor.sessions.peek()[id]
			return s?.title.trim() && s.title !== s.id ? `the session “${s.title}”` : 'this session'
		}
		if (kind === 'note') return 'this sticky note'
		const item = this.editor.items.peek()[id]
		return item ? `“${item.title || item.name}”` : 'this'
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
		const people: Record<string, Box> = {}
		const all = [...this.notes.entries()].sort(
			([, a], [, b]) => ((a.get('createdAt') as number) ?? 0) - ((b.get('createdAt') as number) ?? 0),
		)
		for (const [id, note] of all) {
			if (!(note.get('text') instanceof Y.Text)) continue
			live.add(id)
			let view = this.views.get(id)
			if (!view) {
				view = new NoteView(id, note, this, this.role === 'edit', typeof note.get('sessionId') === 'string')
				this.views.set(id, view)
				this.host.appendChild(view.el)
				// e.g. a note restored by undo comes back selected
				this.showSelection(view)
			}
			view.update()
			if (!view.agent) people[id] = { x: note.get('x') as number, y: note.get('y') as number, w: NOTE_W, h: NOTE_H }
		}
		for (const [id, view] of this.views) {
			if (live.has(id)) continue
			view.destroy()
			this.views.delete(id)
		}
		this.peopleBoxes = people
		this.placeAgents()
	}

	/** Works out where agents' notes go (see placeAgentNotes) and tells the editor where every note is. */
	private placeAgents() {
		const editor = this.editor
		const layout = editor.layout.get()
		const z = editor.camera.peek().z
		const items = editor.items.peek()
		const inputs: AgentNoteInput[] = []
		for (const view of this.views.values()) if (view.agent) inputs.push(view.input())
		const world: PlacementWorld = {
			layout,
			z,
			targetBox: (key) => {
				const { kind, id } = parseSelectionId(key)
				if (kind === 'group') {
					const group = layout.groups.find((g) => g.id === id)
					return group && Box.expand(group.box, GROUP_OUTLINE_PADDING)
				}
				if (kind === 'frame') return layout.sections.find((s) => s.id === id)?.box
				if (kind !== 'item') return undefined
				const box = layout.items.get(id)
				return box && items[id]?.title ? { x: box.x, y: box.y - LAYOUT.titleHeight, w: box.w, h: box.h + LAYOUT.titleHeight } : box
			},
			itemPixels: (id) => {
				const box = layout.items.get(id)
				const item = items[id]
				return box && item?.width && item.height ? { box, width: item.width, height: item.height } : undefined
			},
			notes: new Map(Object.entries(this.peopleBoxes)),
			hasFrame: (sessionId) => !!editor.sessions.peek()[sessionId],
			parentOf: (sessionId) => editor.parentOf(sessionId),
		}
		this.placements = placeAgentNotes(inputs, world)
		this.placedFor = { layout, scale: titleScale(z) }
		this.needsPlacing = false
		const boxes = { ...this.peopleBoxes }
		for (const [id, p] of this.placements) boxes[id] = p.box
		editor.setNoteBoxes(boxes)
		this.agentNotes.set(
			inputs
				.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
				.map((n) => ({
					id: n.id,
					sessionId: n.sessionId,
					kind: n.kind,
					text: this.views.get(n.id)!.text.toString(),
					...(n.target ? { target: n.target } : {}),
					createdAt: n.createdAt,
					shown: this.placements.has(n.id),
				})),
		)
	}

	private showSelection(view: NoteView) {
		const key = noteKey(view.id)
		const peer = this.presence.peers.peek().find((p) => p.selection?.includes(key))
		view.setSelected(this.editor.selectedIds.peek().includes(key), peer?.user.color ?? null)
	}

	private position(elapsed: number) {
		const editor = this.editor
		const layout = editor.layout.get()
		if (this.needsPlacing || layout !== this.placedFor.layout || titleScale(editor.camera.peek().z) !== this.placedFor.scale) this.placeAgents()
		for (const view of this.views.values()) {
			if (!view.agent) {
				view.place(editor, null)
				continue
			}
			const placed = this.placements.get(view.id)
			view.place(editor, placed?.box ?? null, elapsed)
			view.point(editor, placed ?? null)
		}
	}

	// ---- used by NoteView ----

	transact(fn: () => void, origin?: unknown) {
		this.doc.transact(fn, origin)
	}

	get noteMap() {
		return this.notes
	}

	get pointerLayer() {
		return this.pointers
	}

	/** An agent's note changed height: place them again. */
	replace() {
		this.needsPlacing = true
	}

	/** A session's name for its notes: its frame's title, else the name it signed the note with. */
	sessionLabel(sessionId: string, signed: string) {
		const title = this.editor.sessions.peek()[sessionId]?.title.trim()
		return title && title !== sessionId ? title : signed.trim() || 'Agent'
	}

	/** Page point under a pointer event. */
	pagePoint(e: PointerEvent): Vec {
		const rect = this.parent.getBoundingClientRect()
		return this.editor.screenToPage({ x: e.clientX - rect.left, y: e.clientY - rect.top })
	}
}

class NoteView {
	readonly el: HTMLDivElement
	/** people's notes: their text, typed into */
	readonly textarea: HTMLTextAreaElement | null = null
	readonly text: Y.Text
	/** agents' notes: their height (page px; they grow with their text) */
	height = NOTE_H
	private author: HTMLSpanElement
	private colorButton: HTMLButtonElement
	/** agents' notes: their Markdown */
	private body: HTMLDivElement | null = null
	/** agents' notes: what's drawn now (to skip redrawing), and their pointer */
	private shown = { label: '', content: '', color: '' }
	private pointer: Pointer | null = null
	/** agents' notes: where it's drawn (page), gliding to where it's placed */
	private drawn: Box | null = null
	private hidden = false
	private attendTimer = 0
	private lastTransform = ''
	private lastZoom = 0
	private unobserve: () => void

	constructor(
		readonly id: string,
		readonly note: Y.Map<unknown>,
		private owner: SharedNotes,
		private editable: boolean,
		readonly agent: boolean,
	) {
		this.text = note.get('text') as Y.Text
		this.el = document.createElement('div')
		this.el.className = `note${agent ? ' agent' : ''}${editable ? '' : ' locked'}`
		this.el.dataset.note = id
		this.el.style.width = `${NOTE_W}px`
		if (agent) {
			const kind = note.get('kind') === 'highlight' ? 'Highlight' : 'Say'
			this.el.innerHTML =
				`<div class="note-header"><i class="note-agent-dot"></i><span class="note-author"></span><span class="note-kind">${kind}</span></div>` +
				'<div class="note-body md-text"></div>' +
				(editable
					? '<div class="note-actions"><button class="note-later" title="Later: on to the next note that wants your attention">Later</button>' +
						'<button class="note-ack" title="Acknowledge it: removes this note for everyone">✓ Got it</button></div>'
					: '')
			this.body = this.el.querySelector('.note-body')!
			this.el.querySelector('.note-ack')?.addEventListener('click', (e) => {
				e.stopPropagation()
				owner.acknowledge(id)
			})
			this.el.querySelector('.note-later')?.addEventListener('click', (e) => {
				e.stopPropagation()
				owner.onLater?.()
			})
			// A long note scrolls instead of zooming the canvas.
			this.body.addEventListener('wheel', (e) => {
				if (this.body!.scrollHeight > this.body!.clientHeight + 1) e.stopPropagation()
			})
		} else {
			this.el.style.height = `${NOTE_H}px`
			this.el.innerHTML =
				'<div class="note-header"><span class="note-author"></span>' +
				(editable ? '<button class="note-color" title="Change colour"></button>' : '') +
				'</div><textarea class="note-text" placeholder="Type something…" spellcheck="false"></textarea>'
			this.textarea = this.el.querySelector('textarea')!
			this.textarea.value = this.text.toString()
			this.textarea.readOnly = !editable
		}
		this.author = this.el.querySelector('.note-author')!
		this.colorButton = this.el.querySelector('.note-color') ?? document.createElement('button')

		// Notes handle their own pointer input (in every tool); the canvas shouldn't select, brush or pan underneath.
		this.el.addEventListener('pointerdown', (e) => this.onPointerDown(e))
		this.el.addEventListener('dblclick', (e) => e.stopPropagation())

		const textarea = this.textarea
		if (textarea) {
			if (editable) {
				this.colorButton.addEventListener('click', () => {
					const i = NOTE_COLORS.indexOf(note.get('color') as string)
					owner.transact(() => note.set('color', NOTE_COLORS[(i + 1) % NOTE_COLORS.length]))
				})
				textarea.addEventListener('input', () => this.applyLocalEdit(textarea))
			}
			textarea.addEventListener('keydown', (e) => {
				if (e.key === 'Escape') textarea.blur()
			})
		}

		const observer = (event: Y.YTextEvent) => this.applyRemoteEdit(event)
		this.text.observe(observer)
		this.unobserve = () => this.text.unobserve(observer)
	}

	update() {
		if (this.agent) return this.updateAgent()
		const color = (this.note.get('color') as string) ?? NOTE_COLORS[0]
		this.el.style.setProperty('--note-color', color)
		const author = (this.note.get('author') as string) ?? ''
		if (this.author.textContent !== author) this.author.textContent = author
	}

	/** An agent's note: its session's colour and title, and its Markdown (or what it points at, if it says nothing). */
	private updateAgent() {
		const sessionId = this.note.get('sessionId') as string
		const color = sessionColor(sessionId)
		if (color !== this.shown.color) {
			this.shown.color = color
			this.el.style.setProperty('--agent-color', color)
			this.pointer?.g.style.setProperty('--agent-color', color)
		}
		const label = this.owner.sessionLabel(sessionId, (this.note.get('author') as string) ?? '')
		if (label !== this.shown.label) {
			this.shown.label = label
			this.author.textContent = label
			this.author.title = label
		}
		const text = this.text.toString().trim()
		const target = this.note.get('target')
		const hint = text
			? ''
			: this.note.get('point') || this.note.get('region') || this.note.get('at')
				? 'Have a look here.'
				: typeof target === 'string'
					? `Have a look at ${this.owner.targetLabel(target)}.`
					: 'Have a look.'
		const content = text || `\u0000${hint}`
		if (content !== this.shown.content) {
			this.shown.content = content
			this.body!.innerHTML = text ? markdownToHtml(text) : `<p class="note-hint">${escapeHtml(hint)}</p>`
			this.measure()
		}
	}

	/** An agent's note's height, as its text lays out (between NOTE_H and AGENT_NOTE_MAX_H, see .note.agent). */
	measure() {
		if (!this.agent || this.hidden) return
		const h = this.el.offsetHeight
		if (!h || h === this.height) return
		this.height = h
		this.owner.replace()
	}

	/** What placing an agent's note needs to know about it. */
	input(): AgentNoteInput {
		const get = (key: string) => this.note.get(key)
		const dx = get('dx')
		const dy = get('dy')
		const anchor: Partial<NoteAnchor> = {}
		for (const key of ['target', 'point', 'region', 'at'] as const) {
			const value = get(key)
			if (value !== undefined && value !== null) (anchor as Record<string, unknown>)[key] = value
		}
		return {
			...anchor,
			id: this.id,
			sessionId: get('sessionId') as string,
			kind: get('kind') === 'highlight' ? 'highlight' : 'say',
			createdAt: (get('createdAt') as number) ?? 0,
			h: this.height,
			x: (get('x') as number) ?? 0,
			y: (get('y') as number) ?? 0,
			...(typeof dx === 'number' && typeof dy === 'number' ? { moved: { x: dx, y: dy } } : {}),
		}
	}

	/** Our selection (accent outline) and the colour of someone else's, if they've selected it. */
	setSelected(selected: boolean, peerColor: string | null) {
		this.el.classList.toggle('selected', selected)
		this.el.classList.toggle('remote-selected', peerColor !== null)
		if (peerColor) this.el.style.setProperty('--peer', peerColor)
	}

	/**
	 * Puts the note on screen: people's at their x/y, agents' where they were placed (null: hidden),
	 * gliding there when that changes (straight there while it's dragged).
	 */
	place(editor: Editor, box: Box | null, elapsed = 0) {
		const hidden = this.agent && !box
		if (hidden !== this.hidden) {
			this.hidden = hidden
			this.el.hidden = hidden
			this.drawn = null
			if (!hidden) this.measure()
		}
		if (hidden) return
		if (box) {
			const d = this.drawn
			const k = d && !this.el.classList.contains('dragging') ? 1 - Math.exp(-elapsed / GLIDE_MS) : 1
			const next = d ? { x: d.x + (box.x - d.x) * k, y: d.y + (box.y - d.y) * k, w: box.w, h: box.h } : { ...box }
			if (Math.abs(next.x - box.x) < 0.25 && Math.abs(next.y - box.y) < 0.25) {
				next.x = box.x
				next.y = box.y
			}
			box = this.drawn = next
		}
		const p = editor.pageToScreen(box ?? { x: this.note.get('x') as number, y: this.note.get('y') as number })
		const z = editor.camera.peek().z
		// Outlines are scaled with the note, so they divide by the zoom to stay the same width on screen.
		if (z !== this.lastZoom) {
			this.lastZoom = z
			this.el.style.setProperty('--z', String(z))
		}
		// Scaled from the top-left, so x/y stay the note's corner. Notes sit square on the sheet: the
		// tilt stored with people's notes isn't drawn.
		const transform = `translate(${p.x}px, ${p.y}px) scale(${z})`
		if (transform === this.lastTransform) return
		this.lastTransform = transform
		this.el.style.transform = transform
	}

	/** An agent's note's pointer to the exact point or region it points at, in screen space. */
	point(editor: Editor, placed: NotePlacement | null) {
		const spot = placed?.spot
		if (!placed || !spot || spot.kind === 'target') {
			this.pointer?.g.remove()
			this.pointer = null
			return
		}
		if (!this.pointer || this.pointer.kind !== spot.kind) {
			this.pointer?.g.remove()
			this.pointer = createPointer(spot.kind)
			this.pointer.g.style.setProperty('--agent-color', this.shown.color)
			this.owner.pointerLayer.appendChild(this.pointer.g)
		}
		const z = editor.camera.peek().z
		const line = pointerLine(this.drawn ?? placed.box, spot)
		const s = editor.pageToScreen(spot.box)
		let d = ''
		if (line) {
			const a = editor.pageToScreen(line.from)
			const b = editor.pageToScreen(line.to)
			// It ends at the ring round a point.
			const len = Math.hypot(b.x - a.x, b.y - a.y)
			const cut = spot.kind === 'point' ? Math.min(POINT_RING, len) : 0
			const end = len ? { x: b.x - ((b.x - a.x) * cut) / len, y: b.y - ((b.y - a.y) * cut) / len } : b
			d = `M${a.x.toFixed(1)} ${a.y.toFixed(1)}L${end.x.toFixed(1)} ${end.y.toFixed(1)}`
		}
		const key = `${d}|${s.x.toFixed(1)},${s.y.toFixed(1)},${(spot.box.w * z).toFixed(1)},${(spot.box.h * z).toFixed(1)}`
		if (key === this.pointer.key) return
		this.pointer.key = key
		for (const path of this.pointer.lines) path.setAttribute('d', d)
		if (spot.kind === 'point') {
			for (const c of this.pointer.marks) {
				c.setAttribute('cx', s.x.toFixed(1))
				c.setAttribute('cy', s.y.toFixed(1))
			}
		} else {
			for (const r of this.pointer.marks) {
				r.setAttribute('x', s.x.toFixed(1))
				r.setAttribute('y', s.y.toFixed(1))
				r.setAttribute('width', Math.max(1, spot.box.w * z).toFixed(1))
				r.setAttribute('height', Math.max(1, spot.box.h * z).toFixed(1))
			}
		}
	}

	/** A brief emphasis (stepped to from the attention bar): a ring round the note, and its pointer pulsing. */
	attend() {
		clearTimeout(this.attendTimer)
		for (const el of [this.el, this.pointer?.g]) {
			if (!el) continue
			el.classList.remove('attend')
			// restart the animation
			void el.getBoundingClientRect()
			el.classList.add('attend')
		}
		this.attendTimer = window.setTimeout(() => {
			this.el.classList.remove('attend')
			this.pointer?.g.classList.remove('attend')
		}, ATTEND_MS)
	}

	destroy() {
		clearTimeout(this.attendTimer)
		this.unobserve()
		this.el.remove()
		this.pointer?.g.remove()
	}

	/** Turn the textarea's new value into a minimal delete + insert on the shared text. */
	private applyLocalEdit(textarea: HTMLTextAreaElement) {
		const before = this.text.toString()
		const after = textarea.value
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
		const textarea = this.textarea
		if (event.transaction.origin === LOCAL_EDIT || !textarea) return
		const focused = document.activeElement === textarea
		const { selectionStart, selectionEnd } = textarea
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
		textarea.value = this.text.toString()
		if (focused) textarea.setSelectionRange(shift(selectionStart), shift(selectionEnd))
	}

	/**
	 * A press on the note: shift toggles it in the selection; a press on the text of a note that's
	 * already selected (or being edited) is left to the textarea, so it focuses with the caret where
	 * you clicked; anything else selects the note (without focusing the text) and starts a drag.
	 * Buttons and links in it take their own clicks.
	 */
	private onPointerDown(e: PointerEvent) {
		// Space-drag and middle-drag pan the canvas, even over notes.
		if (e.button === 1 || this.owner.editor.inputs.isSpaceDown) return
		e.stopPropagation()
		if (e.button !== 0) return
		const target = e.target as HTMLElement
		if (target.closest('button, a')) return
		const editor = this.owner.editor
		const key = noteKey(this.id)
		const onText = !!this.textarea && target === this.textarea
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

	/**
	 * Drags this note, and any other selected notes along with it. An agent's note keeps its offset
	 * from what it's anchored to (dx, dy), so it stays put relative to that as the layout moves.
	 */
	private drag(down: PointerEvent) {
		const editor = this.owner.editor
		const notes = this.owner.noteMap
		const ids = new Set([this.id])
		for (const key of editor.getSelectedIds()) if (key.startsWith('note:') && notes.has(key.slice(5))) ids.add(key.slice(5))
		const starts = [...ids].map((id) => {
			const note = notes.get(id)!
			const placed = typeof note.get('sessionId') === 'string' ? this.owner.placementOf(id) : undefined
			if (placed) return { note, x: placed.box.x, y: placed.box.y, ref: placed.ref }
			return { note, x: note.get('x') as number, y: note.get('y') as number, ref: null }
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
					const x = s.x + p.x - origin.x
					const y = s.y + p.y - origin.y
					s.note.set('x', x)
					s.note.set('y', y)
					if (s.ref) {
						s.note.set('dx', x - s.ref.x)
						s.note.set('dy', y - s.ref.y)
					}
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

/** An agent's note's pointer: a leader from the note (over a paper keyline), and a ring on a point or an outline round a region. */
interface Pointer {
	kind: 'point' | 'region'
	g: SVGGElement
	lines: SVGPathElement[]
	marks: SVGElement[]
	key: string
}

function createPointer(kind: 'point' | 'region'): Pointer {
	const g = document.createElementNS(SVG_NS, 'g')
	g.classList.add('note-pointer', kind)
	const make = <K extends keyof SVGElementTagNameMap>(tag: K, cls: string, attrs: Record<string, string> = {}) => {
		const el = document.createElementNS(SVG_NS, tag)
		el.classList.add(cls)
		for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
		g.appendChild(el)
		return el
	}
	const lines = [make('path', 'np-keyline'), make('path', 'np-line')]
	const marks: SVGElement[] =
		kind === 'point'
			? [
					make('circle', 'np-pulse', { r: String(POINT_RING) }),
					make('circle', 'np-keyline', { r: String(POINT_RING) }),
					make('circle', 'np-ring', { r: String(POINT_RING) }),
					make('circle', 'np-dot', { r: '3.5' }),
				]
			: [make('rect', 'np-pulse'), make('rect', 'np-keyline'), make('rect', 'np-ring')]
	return { kind, g, lines, marks, key: '' }
}

/**
 * Session titles stay this big at least, growing upward out of the frame when zoomed far out (see
 * frameTitleBox): below that zoom their page height changes with every zoom, above it it doesn't.
 */
const titleScale = (z: number) => Math.min(z, LAYOUT.minFrameTitlePx / LAYOUT.frameTitlePx)

function agentNotesEqual(a: AgentNoteInfo[], b: AgentNoteInfo[]) {
	return (
		a.length === b.length &&
		a.every((n, i) => {
			const m = b[i]!
			return n.id === m.id && n.text === m.text && n.shown === m.shown && n.sessionId === m.sessionId && n.target === m.target
		})
	)
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** crypto.randomUUID only exists in secure contexts (and Safari 15.4+); fall back to getRandomValues. */
function noteId() {
	if (typeof crypto.randomUUID === 'function') return crypto.randomUUID().slice(0, 12)
	const bytes = crypto.getRandomValues(new Uint8Array(6))
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
