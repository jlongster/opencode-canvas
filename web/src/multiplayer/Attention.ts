import { sessionColor } from '../../../shared/sessionColor'
import { FOCUS_MAX_ZOOM, type Editor } from '../editor/Editor'
import { Box, clamp } from '../editor/geometry'
import { frameTitleBox } from '../editor/layout'
import { atom, computed } from '../state/signals'
import type { NotePlacement } from './notePlacement'
import type { AskingInfo } from './Presence'
import type { SessionControl } from './SessionControl'
import type { AgentNoteInfo, SharedNotes } from './SharedNotes'

/** One session calling for attention, as the bar at the top lists it. */
export interface Caller {
	sessionId: string
	name: string
	color: string
	/** the sticky notes it placed that nobody has acknowledged yet, oldest first */
	notes: AgentNoteInfo[]
	/** it waits on its owner to answer questions or permission requests (see SessionHost) */
	asking: AskingInfo | null
}

/** room (screen px) kept around what the camera brings into view */
const REVEAL_PAD = 96
/** what's along the top of the screen (the top bar and the attention bar), kept clear when revealing */
const TOP_INSET = 116
/** room (screen px) kept above a frame's title brought into view, for what's shown there */
const FRAME_CARD_ROOM = 240
/** how long the camera glides to a note stepped to (ms) */
const GLIDE_MS = 560
/** stepping to a note keeps the zoom in this range, so the note can be read... */
const READ_ZOOM = { min: 0.75, max: 1.25 }
/** ...zooming out further only to fit what it points at in too, down to this */
const CONTEXT_MIN_ZOOM = 0.3

/**
 * What sessions want the people on a canvas to look at: the sticky notes they placed (MCP say /
 * highlight, see SharedNotes) until someone acknowledges them, and the questions and permission
 * requests they wait on. The bar at the top counts them by session, and its arrows step through the
 * notes, everyone's or one session's: each step glides the camera to the note and what it points
 * at, and briefly emphasises the note.
 */
export class Attention {
	/** the note last stepped to (its createdAt carries the stepping on from there once it's acknowledged) */
	readonly current = atom<{ id: string; createdAt: number } | null>('attentionCurrent', null)
	/** agents' notes by session, oldest first */
	readonly bySession = computed<Map<string, AgentNoteInfo[]>>('attentionBySession', () => {
		const map = new Map<string, AgentNoteInfo[]>()
		for (const n of this.notes.agentNotes.get()) {
			let list = map.get(n.sessionId)
			if (!list) map.set(n.sessionId, (list = []))
			list.push(n)
		}
		return map
	})
	/** what each linked session is asking its owner, by session (from its live state in the room) */
	readonly asking = computed<Map<string, AskingInfo>>('attentionAsking', () => {
		const map = new Map<string, AskingInfo>()
		for (const [sessionId, p] of this.sessions.live.get()) if (p.asking?.count) map.set(sessionId, p.asking)
		return map
	})
	/** sessions asking something first, then those with notes waiting, in the order they first placed one */
	readonly callers = computed<Caller[]>('attentionCallers', () => {
		const asking = this.asking.get()
		const notes = this.bySession.get()
		return [...new Set([...asking.keys(), ...notes.keys()])].map((sessionId) => ({
			sessionId,
			name: this.sessions.label(sessionId),
			color: sessionColor(sessionId),
			notes: notes.get(sessionId) ?? [],
			asking: asking.get(sessionId) ?? null,
		}))
	})

	constructor(
		readonly editor: Editor,
		readonly sessions: SessionControl,
		readonly notes: SharedNotes,
	) {}

	/** The notes the arrows step through, oldest first: everyone's or one session's, those on the canvas (reactive). */
	steps(sessionId?: string): AgentNoteInfo[] {
		const all = sessionId === undefined ? this.notes.agentNotes.get() : (this.bySession.get().get(sessionId) ?? [])
		return all.filter((n) => n.shown)
	}

	/** Which of those the last step showed (1-based; 0 when it's none of them), and how many there are (reactive). */
	position(sessionId?: string): { index: number; total: number } {
		const list = this.steps(sessionId)
		const id = this.current.get()?.id
		return { index: list.findIndex((n) => n.id === id) + 1, total: list.length }
	}

	/**
	 * Steps to the next (1) or previous (-1) note, everyone's or one session's, wrapping round. After
	 * the note shown last was acknowledged, the next is the one after it.
	 */
	step(dir: 1 | -1, sessionId?: string) {
		const list = this.steps(sessionId)
		if (!list.length) return
		const cur = this.current.peek()
		const at = cur ? list.findIndex((n) => n.id === cur.id) : -1
		let next: AgentNoteInfo
		if (at >= 0) next = list[(at + dir + list.length) % list.length]!
		else if (cur && dir > 0) next = list.find((n) => n.createdAt > cur.createdAt) ?? list[0]!
		else if (cur) next = [...list].reverse().find((n) => n.createdAt < cur.createdAt) ?? list[list.length - 1]!
		else next = dir > 0 ? list[0]! : list[list.length - 1]!
		this.show(next.id)
	}

	/** Glides the camera to a note and what it points at, and briefly emphasises it. */
	show(id: string) {
		const info = this.notes.agentNotes.peek().find((n) => n.id === id)
		const placed = this.notes.placementOf(id)
		if (!info || !placed) return
		this.current.set({ id, createdAt: info.createdAt })
		this.sessions.close()
		this.glideTo(placed)
		this.notes.emphasize(id)
	}

	/**
	 * A session asking its owner something: brings its frame into view, where what it asks shows (to
	 * answer for its owner, read-only for everyone else; see FrameAsks).
	 */
	answer(sessionId: string) {
		this.sessions.showAsks(sessionId)
		this.revealFrame(sessionId)
	}

	/**
	 * Centres a note and what it points at below the top bar, at a zoom the note reads at (keeping
	 * the current one if it does), zooming out as needed to fit both, but not so far the note can't
	 * be made out: then it centres the note and the part of the target nearest it.
	 */
	private glideTo(placed: NotePlacement) {
		const editor = this.editor
		const cam = editor.camera.peek()
		const { w, h } = editor.viewport.peek()
		const pad = Math.min(REVEAL_PAD, w / 8, h / 8)
		const top = Math.min(Math.max(pad, TOP_INSET), h / 4)
		const roomW = w - pad * 2
		const roomH = h - pad - top
		const fit = (b: Box) => Math.min(roomW / Math.max(b.w, 1), roomH / Math.max(b.h, 1))
		const note = placed.box
		// A note at the top of its frame shows with the part of the title row under it.
		const title = placed.frameTitle
		const spot = placed.spot?.box ?? (title && { x: note.x, y: title.y, w: note.w, h: title.h })
		let box = spot ? Box.union([note, spot])! : note
		let z = clamp(cam.z, READ_ZOOM.min, READ_ZOOM.max)
		if (fit(box) < z) {
			z = Math.max(fit(box), CONTEXT_MIN_ZOOM)
			if (spot && fit(box) < CONTEXT_MIN_ZOOM) {
				const c = { x: note.x + note.w / 2, y: note.y + note.h / 2 }
				const near = { x: clamp(c.x, spot.x, spot.x + spot.w), y: clamp(c.y, spot.y, spot.y + spot.h), w: 0, h: 0 }
				box = Box.union([note, near])!
				z = clamp(fit(box), CONTEXT_MIN_ZOOM, z)
			}
		}
		z = Math.min(z, FOCUS_MAX_ZOOM)
		editor.stopCameraMotion()
		editor.setCamera({ x: w / 2 / z - (box.x + box.w / 2), y: (top + roomH / 2) / z - (box.y + box.h / 2), z }, { animate: true, duration: GLIDE_MS })
	}

	/** Slides the camera to bring the session's frame title (and room above it for a card) into view. */
	revealFrame(sessionId: string) {
		const section = this.editor.layout.get().sections.find((s) => s.id === sessionId)
		if (!section) return
		const z = this.editor.camera.peek().z
		const title = frameTitleBox(section, z)
		const { w } = this.editor.viewport.peek()
		const width = Math.min(title.w, (w - 48) / z)
		this.reveal({ x: title.x, y: title.y - FRAME_CARD_ROOM / z, w: width, h: title.h + FRAME_CARD_ROOM / z }, 24)
	}

	/**
	 * The smallest camera move that shows the box with `pad` screen px around it: a pan at the
	 * current zoom, or zoomed out to fit if it's too big for the screen at this zoom.
	 */
	private reveal(box: Box, pad: number) {
		const editor = this.editor
		const cam = editor.camera.peek()
		const { w, h } = editor.viewport.peek()
		const p = Math.min(pad, w / 6, h / 6)
		const top = Math.min(Math.max(p, TOP_INSET), h / 4)
		const fit = Math.min((w - p * 2) / box.w, (h - p - top) / box.h)
		if (fit < cam.z) {
			// Fit it between the top bar and the bottom, centred.
			const z = Math.max(fit, 0.02)
			editor.stopCameraMotion()
			editor.setCamera(
				{ x: w / 2 / z - (box.x + box.w / 2), y: (top + (h - p - top) / 2) / z - (box.y + box.h / 2), z },
				{ animate: true },
			)
			return
		}
		const z = cam.z
		const view = { x: -cam.x, y: -cam.y, w: w / z, h: h / z }
		const shift = (lo: number, size: number, vLo: number, vSize: number, padLo: number, padHi: number) =>
			lo - padLo < vLo ? lo - padLo - vLo : lo + size + padHi > vLo + vSize ? lo + size + padHi - (vLo + vSize) : 0
		const dx = shift(box.x, box.w, view.x, view.w, p / z, p / z)
		const dy = shift(box.y, box.h, view.y, view.h, top / z, p / z)
		if (!dx && !dy) return
		editor.stopCameraMotion()
		editor.setCamera({ x: cam.x - dx, y: cam.y - dy, z }, { animate: true })
	}
}
