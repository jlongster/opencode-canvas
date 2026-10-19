/**
 * Attention queues: what each session wants the people on a canvas to look at. Agents queue actions
 * with the MCP say / highlight tools (or POST /api/canvases/:cid/sessions/:sid/actions); browsers
 * show them as a count on the session frame's status rail and in the attention tray, and play them
 * back as a walkthrough from the rail. Stepping past an action on an edit link marks it done, which
 * deletes it: done actions aren't kept. Fire-and-forget for agents: nothing reports back to them.
 *
 * Queuing for a session with no frame on the canvas makes an empty one (see ensureFrame), so the
 * rail has somewhere to be.
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
	/** makes sure the session has a frame on the canvas (named after title when it's new or untitled) */
	ensureFrame(canvasId: string, sessionId: string, title?: string): void
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
			if (kind !== 'say' && kind !== 'highlight') throw new AttentionError(400, 'send {"kind": "say", "text"} or {"kind": "highlight", "target", "text"?}')
			const text = textField(body?.text, kind === 'say')
			let target: string | undefined
			if (kind === 'highlight') {
				if (typeof body?.target !== 'string' || !body.target.trim()) {
					throw new AttentionError(400, '"target" is required for highlight: an item id, "<sessionId>/<group name>", "frame:<sessionId>" or "note:<noteId>"')
				}
				target = await deps.resolveTarget(canvasId, body.target.trim())
			}
			const title = typeof body?.sessionTitle === 'string' ? body.sessionTitle.trim().replace(/\s+/g, ' ').slice(0, TITLE_MAX) : undefined
			if (!deps.canvasExists(canvasId)) throw new AttentionError(404, `no canvas ${canvasId}`)
			const queued = list(canvasId, sessionId).length
			if (queued >= QUEUE_MAX) throw new AttentionError(429, `this session already has ${QUEUE_MAX} actions waiting for attention on this canvas`)
			deps.ensureFrame(canvasId, sessionId, title || undefined)
			const action: AttentionAction = {
				id: crypto.randomUUID().replaceAll('-', '').slice(0, 16),
				canvasId,
				sessionId,
				kind,
				...(text ? { text } : {}),
				...(target ? { target } : {}),
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

		/** Clears a session's queue (Dismiss all, or its frame was removed). Returns how many went. */
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
