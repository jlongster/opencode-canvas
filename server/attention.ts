/**
 * Agent sticky notes: what each session wants the people on a canvas to look at. Agents place them
 * with the MCP say / highlight tools (or POST /api/canvases/:cid/sessions/:sid/notes). Each is a
 * sticky note in the canvas's room document, so it's saved with the canvas and every open canvas
 * sees it live, marked with the session that placed it and what it points at (see NoteAnchor).
 * Browsers place it from that as the layout moves: a highlight right next to its target, a say at
 * the top of the session's frame. Acknowledging it (on an edit link) deletes it for everyone.
 * Fire-and-forget for agents: nothing reports back to them.
 */
import * as Y from 'yjs'
import { sessionColor } from '../shared/sessionColor'
import type { Note, NoteAnchor } from '../shared/types'

export class AttentionError extends Error {
	constructor(public status: number, message: string) {
		super(message)
	}
}

export interface AttentionDeps {
	canvasExists(id: string): boolean
	/** a highlight target as a selection key, checked to exist on the canvas; throws when it doesn't */
	resolveTarget(canvasId: string, target: string): Promise<string>
	/** an item target's original pixel size (null for frames, groups and notes) */
	itemSize(target: string): { width: number; height: number } | null
	/** names the session's frame after its OpenCode session; with `create`, gives it a frame if it has none */
	nameSession(canvasId: string, sessionId: string, title: string | undefined, create: boolean): void
	/** the session's frame title, for the note's author when no title is sent */
	sessionTitle(canvasId: string, sessionId: string): string
	/** about where a note with this anchor lands on the page now (browsers place it exactly), for its stored x/y */
	roughPosition(canvasId: string, sessionId: string, anchor: NoteAnchor): { x: number; y: number }
	/** reads the canvas's room document */
	readDoc<T>(canvasId: string, read: (doc: Y.Doc) => T): Promise<T>
	/** changes the canvas's room document in one transaction: live for everyone on the canvas, and saved */
	changeDoc<T>(canvasId: string, change: (doc: Y.Doc) => T): Promise<T>
}

const SESSION_ID = /^ses_[A-Za-z0-9]{26}$/
export const ATTENTION_TEXT_MAX = 4000
/** unacknowledged notes per session per canvas */
const WAITING_MAX = 50
const TITLE_MAX = 200
/** agent notes tilt a little less than people's (±2.5°), so a stack of them stays tidy */
const MAX_TILT = 1.5

function textField(value: unknown, required: boolean): string | undefined {
	if (value === undefined || value === null) {
		if (required) throw new AttentionError(400, '"text" is required for say')
		return undefined
	}
	if (typeof value !== 'string') throw new AttentionError(400, '"text" must be a string (Markdown)')
	const text = value.trim()
	if (!text) {
		if (required) throw new AttentionError(400, '"text" is empty')
		return undefined
	}
	if (text.length > ATTENTION_TEXT_MAX) throw new AttentionError(400, `"text" is longer than ${ATTENTION_TEXT_MAX} characters`)
	return text
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * A highlight's optional precise spot: point / region on an item (its image pixels, checked against
 * its width × height), or "at" (a canvas page point) on a frame, group or note.
 */
function preciseFields(body: Record<string, unknown> | null, size: { width: number; height: number } | null): Pick<NoteAnchor, 'point' | 'region' | 'at'> {
	const { point, region, at } = body ?? {}
	const given = (v: unknown) => v !== undefined && v !== null
	if (given(point) && given(region)) throw new AttentionError(400, 'send either "point" or "region", not both')
	const where = size ? `the item's ${size.width}×${size.height} image pixels` : ''
	if (given(point) || given(region)) {
		if (!size) throw new AttentionError(400, '"point" and "region" are for items (in the item\'s image pixels); for a frame, group or note pass "at" (a canvas page point) or nothing')
		if (given(point)) {
			const p = point as Record<string, unknown>
			if (typeof p !== 'object' || !finite(p.x) || !finite(p.y)) throw new AttentionError(400, '"point" must be {"x", "y"} (numbers, in the item\'s image pixels)')
			if (p.x < 0 || p.y < 0 || p.x > size.width || p.y > size.height) {
				throw new AttentionError(400, `"point" (${p.x}, ${p.y}) is outside ${where} (0..${size.width}, 0..${size.height})`)
			}
			return { point: { x: p.x, y: p.y } }
		}
		const r = region as Record<string, unknown>
		if (typeof r !== 'object' || !finite(r.x) || !finite(r.y) || !finite(r.w) || !finite(r.h)) {
			throw new AttentionError(400, '"region" must be {"x", "y", "w", "h"} (numbers, in the item\'s image pixels)')
		}
		if (r.w <= 0 || r.h <= 0) throw new AttentionError(400, '"region" needs a positive "w" and "h"')
		if (r.x < 0 || r.y < 0 || r.x + r.w > size.width || r.y + r.h > size.height) {
			throw new AttentionError(400, `"region" (${r.x}, ${r.y}, ${r.w}×${r.h}) doesn't fit in ${where}`)
		}
		return { region: { x: r.x, y: r.y, w: r.w, h: r.h } }
	}
	if (given(at)) {
		if (size) throw new AttentionError(400, '"at" is for frames, groups and notes; on an item pass "point" or "region" (in its image pixels)')
		const p = at as Record<string, unknown>
		if (typeof p !== 'object' || !finite(p.x) || !finite(p.y)) throw new AttentionError(400, '"at" must be {"x", "y"} (numbers, canvas page coordinates)')
		return { at: { x: p.x, y: p.y } }
	}
	return {}
}

/** A sticky note from the room document (map "notes": id -> Y.Map), with its anchor if a session placed it. */
export function noteFrom(id: string, note: Y.Map<unknown>): Note {
	const text = note.get('text')
	const sessionId = note.get('sessionId')
	const out: Note = {
		id,
		text: text instanceof Y.Text ? text.toString() : typeof text === 'string' ? text : '',
		author: String(note.get('author') ?? ''),
		color: String(note.get('color') ?? ''),
		x: Number(note.get('x') ?? 0),
		y: Number(note.get('y') ?? 0),
		createdAt: Number(note.get('createdAt') ?? 0),
	}
	if (typeof sessionId !== 'string') return out
	const kind = note.get('kind') === 'highlight' ? 'highlight' : 'say'
	const target = note.get('target')
	const vec = (v: unknown) => (v && typeof v === 'object' && finite((v as any).x) && finite((v as any).y) ? (v as { x: number; y: number }) : undefined)
	const point = vec(note.get('point'))
	const at = vec(note.get('at'))
	const r = note.get('region') as Record<string, unknown> | undefined
	const region = r && typeof r === 'object' && finite(r.x) && finite(r.y) && finite(r.w) && finite(r.h) ? { x: r.x, y: r.y, w: r.w, h: r.h } : undefined
	return {
		...out,
		sessionId,
		kind,
		...(typeof target === 'string' ? { target } : {}),
		...(point ? { point: { x: point.x, y: point.y } } : {}),
		...(region ? { region } : {}),
		...(at ? { at: { x: at.x, y: at.y } } : {}),
	}
}

const notesOf = (doc: Y.Doc) => doc.getMap<Y.Map<unknown>>('notes')

/** The session's agent notes in a room document, oldest first. */
function sessionNotes(doc: Y.Doc, sessionId?: string): Note[] {
	const list: Note[] = []
	for (const [id, note] of notesOf(doc)) {
		if (note instanceof Y.Map && typeof note.get('sessionId') === 'string' && (sessionId === undefined || note.get('sessionId') === sessionId)) {
			list.push(noteFrom(id, note))
		}
	}
	return list.sort((a, b) => a.createdAt - b.createdAt)
}

export function createAttention(deps: AttentionDeps) {
	return {
		/** The canvas's unacknowledged agent notes (only the session's, given one), oldest first. */
		list: (canvasId: string, sessionId?: string) => deps.readDoc(canvasId, (doc) => sessionNotes(doc, sessionId)),

		/**
		 * Places one sticky note for the session: {"kind": "say", "text"} or {"kind": "highlight",
		 * "target", "point"? | "region"? | "at"?, "text"?}. Returns it, and how many of the session's
		 * notes now wait on the canvas.
		 */
		async place(canvasId: string, sessionId: string, body: Record<string, unknown> | null): Promise<{ note: Note; waiting: number }> {
			if (!SESSION_ID.test(sessionId)) {
				throw new AttentionError(400, `session id must be an exact OpenCode session id ("ses_" + 26 characters), got ${JSON.stringify(sessionId)}`)
			}
			const kind = body?.kind
			if (kind !== 'say' && kind !== 'highlight') throw new AttentionError(400, 'send {"kind": "say", "text"} or {"kind": "highlight", "target", "point"? | "region"? | "at"?, "text"?}')
			const text = textField(body?.text, kind === 'say')
			const anchor: NoteAnchor = { kind }
			if (kind === 'highlight') {
				if (typeof body?.target !== 'string' || !body.target.trim()) {
					throw new AttentionError(400, '"target" is required for highlight: an item id, "<sessionId>/<group name>", "frame:<sessionId>" or "note:<noteId>"')
				}
				anchor.target = await deps.resolveTarget(canvasId, body.target.trim())
				Object.assign(anchor, preciseFields(body, deps.itemSize(anchor.target)))
			}
			const title = typeof body?.sessionTitle === 'string' ? body.sessionTitle.trim().replace(/\s+/g, ' ').slice(0, TITLE_MAX) : undefined
			if (!deps.canvasExists(canvasId)) throw new AttentionError(404, `no canvas ${canvasId}`)
			const waiting = await deps.readDoc(canvasId, (doc) => sessionNotes(doc, sessionId).length)
			if (waiting >= WAITING_MAX) throw new AttentionError(429, `this session already has ${WAITING_MAX} sticky notes waiting to be acknowledged on this canvas`)
			// A say goes at the top of the session's frame, so it gets one if it has none yet.
			deps.nameSession(canvasId, sessionId, title || undefined, kind === 'say')
			const { x, y } = deps.roughPosition(canvasId, sessionId, anchor)
			const author = title || deps.sessionTitle(canvasId, sessionId)
			const id = crypto.randomUUID().slice(0, 12)
			const note = await deps.changeDoc(canvasId, (doc) => {
				const map = new Y.Map<unknown>()
				notesOf(doc).set(id, map)
				map.set('x', x)
				map.set('y', y)
				map.set('color', sessionColor(sessionId))
				map.set('rotation', (Math.random() * 2 - 1) * MAX_TILT)
				map.set('author', author)
				map.set('createdAt', Date.now())
				map.set('text', new Y.Text(text ?? ''))
				map.set('sessionId', sessionId)
				for (const [key, value] of Object.entries(anchor)) map.set(key, value)
				return noteFrom(id, map)
			})
			return { note, waiting: waiting + 1 }
		},

		/** Acknowledges (deletes) a sticky note, for everyone. False if it isn't there (any more). */
		acknowledge: (canvasId: string, noteId: string) =>
			deps.changeDoc(canvasId, (doc) => {
				if (!notesOf(doc).has(noteId)) return false
				notesOf(doc).delete(noteId)
				return true
			}),

		/** Deletes the session's agent notes (its frame was deleted). Returns how many went. */
		async dropSession(canvasId: string, sessionId: string): Promise<number> {
			if (!(await deps.readDoc(canvasId, (doc) => sessionNotes(doc, sessionId).length))) return 0
			return deps.changeDoc(canvasId, (doc) => {
				const gone = sessionNotes(doc, sessionId)
				for (const n of gone) notesOf(doc).delete(n.id)
				return gone.length
			})
		},
	}
}
