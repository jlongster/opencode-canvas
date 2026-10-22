/**
 * Attention queues: what each session wants the people on a canvas to look at. Agents queue
 * actions with the MCP say / highlight tools (or POST /api/canvases/:cid/sessions/:sid/actions);
 * browsers show them as a badge on the session's frame title and in the attention tray, and play
 * them back as a walkthrough (message cards on the frame, the camera gliding to highlights). Stepping past an action on an edit link marks it done, which deletes it: done actions
 * aren't kept. Fire-and-forget for agents: nothing reports back to them.
 */
import type { AttentionAction, ServerEvent } from '../shared/types'

export class AttentionError extends Error {
	constructor(public status: number, message: string) {
		super(message)
	}
}

export interface AttentionDeps {
	canvasExists(id: string): boolean
	/** persists the index (which reads all() for its attention records) */
	save(): void
	broadcast(event: ServerEvent): void
	/** a highlight target as a selection key, checked to exist on the canvas; throws when it doesn't */
	resolveTarget(canvasId: string, target: string): Promise<string>
	/** an item target's original pixel size (null for frames, groups and notes) */
	itemSize(target: string): { width: number; height: number } | null
	/** names the session's frame (if it has one) after its OpenCode session */
	nameSession(canvasId: string, sessionId: string, title: string): void
}

const SESSION_ID = /^ses_[A-Za-z0-9]{26}$/
export const ATTENTION_TEXT_MAX = 4000
/** queued (not yet done) actions per session per canvas */
const QUEUE_MAX = 50
const TITLE_MAX = 200

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
function preciseFields(body: Record<string, unknown> | null, size: { width: number; height: number } | null) {
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

export function createAttention(deps: AttentionDeps, stored: AttentionAction[]) {
	/** every queued action, in the order it was queued */
	let actions: AttentionAction[] = stored.filter(
		(a) => a && typeof a.id === 'string' && typeof a.sessionId === 'string' && deps.canvasExists(a.canvasId),
	)

	const list = (canvasId: string, sessionId?: string) =>
		actions.filter((a) => a.canvasId === canvasId && (sessionId === undefined || a.sessionId === sessionId))

	function remove(canvasId: string, done: AttentionAction[]) {
		if (!done.length) return
		const ids = new Set(done.map((a) => a.id))
		actions = actions.filter((a) => !ids.has(a.id))
		deps.save()
		deps.broadcast({ type: 'attention_done', canvasId, ids: [...ids] })
	}

	return {
		/** every record, for saving */
		all: () => actions,
		list,

		/** Appends one action to the session's queue: {action, position (1-based), queued (the queue's length)}. */
		async queue(canvasId: string, sessionId: string, body: Record<string, unknown> | null) {
			if (!SESSION_ID.test(sessionId)) {
				throw new AttentionError(400, `session id must be an exact OpenCode session id ("ses_" + 26 characters), got ${JSON.stringify(sessionId)}`)
			}
			const kind = body?.kind
			if (kind !== 'say' && kind !== 'highlight') throw new AttentionError(400, 'send {"kind": "say", "text"} or {"kind": "highlight", "target", "point"? | "region"? | "at"?, "text"?}')
			const text = textField(body?.text, kind === 'say')
			let target: string | undefined
			let precise: ReturnType<typeof preciseFields> = {}
			if (kind === 'highlight') {
				if (typeof body?.target !== 'string' || !body.target.trim()) {
					throw new AttentionError(400, '"target" is required for highlight: an item id, "<sessionId>/<group name>", "frame:<sessionId>" or "note:<noteId>"')
				}
				target = await deps.resolveTarget(canvasId, body.target.trim())
				precise = preciseFields(body, deps.itemSize(target))
			}
			const title = typeof body?.sessionTitle === 'string' ? body.sessionTitle.trim().replace(/\s+/g, ' ').slice(0, TITLE_MAX) : undefined
			if (!deps.canvasExists(canvasId)) throw new AttentionError(404, `no canvas ${canvasId}`)
			const queued = list(canvasId, sessionId).length
			if (queued >= QUEUE_MAX) throw new AttentionError(429, `this session already has ${QUEUE_MAX} actions waiting for attention on this canvas`)
			if (title) deps.nameSession(canvasId, sessionId, title)
			const action: AttentionAction = {
				id: crypto.randomUUID().replaceAll('-', '').slice(0, 16),
				canvasId,
				sessionId,
				kind,
				...(text ? { text } : {}),
				...(target ? { target } : {}),
				...precise,
				createdAt: Date.now(),
			}
			actions.push(action)
			deps.save()
			deps.broadcast({ type: 'attention', action })
			return { action, position: queued + 1, queued: queued + 1 }
		},

		/** Marks one action done (it's deleted). False if it isn't queued (any more). */
		done(canvasId: string, sessionId: string, id: string): boolean {
			const found = actions.find((a) => a.id === id && a.canvasId === canvasId && a.sessionId === sessionId)
			if (!found) return false
			remove(canvasId, [found])
			return true
		},

		/** Clears a session's queue (Dismiss all, or its link was dropped). Returns how many went. */
		clear(canvasId: string, sessionId: string): number {
			const gone = list(canvasId, sessionId)
			remove(canvasId, gone)
			return gone.length
		},

		dropCanvas(canvasId: string) {
			const before = actions.length
			actions = actions.filter((a) => a.canvasId !== canvasId)
			if (actions.length !== before) deps.save()
		},
	}
}
