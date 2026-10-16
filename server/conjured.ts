/**
 * Creatures: real OpenCode sessions on a canvas that people can talk to. The canvas server only
 * keeps the shared records (at most one per session per canvas, saved in data/index.json): which
 * session, which OpenCode it lives on (serverKey, a non-secret id the browser derives from the
 * OpenCode URL), where it sits and who owns it (ownerId, a random id kept in the owner's browser).
 * It never talks to OpenCode and never sees credentials.
 *
 * Everything live happens in the owner's browser tab, which talks to OpenCode directly: it
 * publishes the creature's presence into the canvas's room (thinking, replies, position). With no
 * owner tab open the creature is asleep (`awake` false in list responses).
 *
 * A session that queues something for attention (see attention.ts) without a creature on the canvas
 * gets one without an owner (ownerId and serverKey ""): asleep for good, until someone conjures the
 * session from their browser, which adopts it.
 */
import type { ConjuredAgent, ServerEvent } from '../shared/types'

export class ConjureError extends Error {
	constructor(public status: number, message: string) {
		super(message)
	}
}

export interface ConjuredDeps {
	canvasExists(id: string): boolean
	/** persists the index (which reads all() for its conjured records) */
	save(): void
	broadcast(event: ServerEvent): void
}

const SESSION_ID = /^ses_[A-Za-z0-9]{26}$/
const SERVER_KEY = /^[A-Za-z0-9_-]{1,64}$/
const OWNER_ID = /^[A-Za-z0-9_-]{8,64}$/
const COLORS = ['#f472b6', '#a78bfa', '#fb923c', '#4ade80', '#facc15', '#f87171', '#60a5fa', '#2dd4bf', '#e879f9', '#a3e635']
const TITLE_MAX = 200

const key = (canvasId: string, sessionId: string) => `${canvasId}/${sessionId}`

export function colorFor(sessionId: string) {
	let h = 0
	for (const ch of sessionId) h = (h * 31 + ch.charCodeAt(0)) >>> 0
	return COLORS[h % COLORS.length]
}

function position(x: unknown, y: unknown, hint: string) {
	if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) throw new ConjureError(400, hint)
	return { x: Math.round(x), y: Math.round(y) }
}

function titleField(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined
	if (typeof value !== 'string') throw new ConjureError(400, '"title" must be a string')
	return value.trim().replace(/\s+/g, ' ').slice(0, TITLE_MAX)
}

/** Old records (from when the canvas server ran worms itself) carry fields we no longer keep. */
function clean(r: ConjuredAgent & { directory?: unknown; serverId?: unknown }): ConjuredAgent | null {
	if (!r || typeof r.canvasId !== 'string' || typeof r.sessionId !== 'string') return null
	return {
		canvasId: r.canvasId,
		sessionId: r.sessionId,
		serverKey: typeof r.serverKey === 'string' ? r.serverKey : '',
		title: typeof r.title === 'string' ? r.title : '',
		color: typeof r.color === 'string' ? r.color : colorFor(r.sessionId),
		x: Number(r.x) || 0,
		y: Number(r.y) || 0,
		createdAt: Number(r.createdAt) || Date.now(),
		ownerId: typeof r.ownerId === 'string' ? r.ownerId : '',
	}
}

export function createConjured(deps: ConjuredDeps, stored: ConjuredAgent[]) {
	const records = new Map<string, ConjuredAgent>()
	for (const r of stored) {
		const record = clean(r)
		if (record && deps.canvasExists(record.canvasId)) records.set(key(record.canvasId, record.sessionId), record)
	}

	function get(canvasId: string, sessionId: string): ConjuredAgent {
		const r = records.get(key(canvasId, sessionId))
		if (!r) throw new ConjureError(404, `no conjured worm for ${sessionId} on this canvas`)
		return r
	}

	function put(record: ConjuredAgent) {
		records.set(key(record.canvasId, record.sessionId), record)
		deps.save()
		deps.broadcast({ type: 'conjured', agent: record })
		return record
	}

	function remove(r: ConjuredAgent) {
		if (!records.delete(key(r.canvasId, r.sessionId))) return
		deps.save()
		deps.broadcast({ type: 'conjured_deleted', canvasId: r.canvasId, sessionId: r.sessionId })
	}

	return {
		/** every record, for saving */
		all: (): ConjuredAgent[] => [...records.values()],

		list: (canvasId: string): ConjuredAgent[] =>
			[...records.values()].filter((r) => r.canvasId === canvasId).sort((a, b) => a.createdAt - b.createdAt),

		conjure(canvasId: string, body: Record<string, unknown> | null): ConjuredAgent {
			const { sessionId, serverKey, ownerId } = body ?? {}
			if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
				throw new ConjureError(400, `"sessionId" must be an OpenCode session id ("ses_" + 26 characters)`)
			}
			if (typeof serverKey !== 'string' || !SERVER_KEY.test(serverKey)) {
				throw new ConjureError(400, '"serverKey" must name the OpenCode it lives on (1-64 characters [A-Za-z0-9_-])')
			}
			if (typeof ownerId !== 'string' || !OWNER_ID.test(ownerId)) {
				throw new ConjureError(400, '"ownerId" must be the owner\'s browser id (8-64 characters [A-Za-z0-9_-])')
			}
			const at = position(body?.x, body?.y, 'send {"sessionId", "serverKey", "ownerId", "x", "y"} with x/y the page position')
			if (!deps.canvasExists(canvasId)) throw new ConjureError(404, `no canvas ${canvasId}`)
			const existing = records.get(key(canvasId, sessionId))
			// One without an owner (made for an agent's attention actions) is adopted.
			if (existing?.ownerId) throw new ConjureError(409, 'that session is already conjured on this canvas')
			if (existing) return put({ ...existing, serverKey, ownerId, title: titleField(body?.title) || existing.title, ...at })
			return put({
				canvasId,
				sessionId,
				serverKey,
				title: titleField(body?.title) ?? '',
				color: colorFor(sessionId),
				...at,
				createdAt: Date.now(),
				ownerId,
			})
		},

		/**
		 * The session's creature, made without an owner at `at` if there's none yet. A title names a
		 * new or untitled one.
		 */
		ensure(canvasId: string, sessionId: string, opts: { title?: string; at: () => { x: number; y: number } }): ConjuredAgent {
			const r = records.get(key(canvasId, sessionId))
			const title = titleField(opts.title)
			if (r) return title && !r.title ? put({ ...r, title }) : r
			if (!SESSION_ID.test(sessionId)) throw new ConjureError(400, `"sessionId" must be an OpenCode session id ("ses_" + 26 characters)`)
			if (!deps.canvasExists(canvasId)) throw new ConjureError(404, `no canvas ${canvasId}`)
			const at = opts.at()
			return put({ canvasId, sessionId, serverKey: '', title: title ?? '', color: colorFor(sessionId), x: Math.round(at.x), y: Math.round(at.y), createdAt: Date.now(), ownerId: '' })
		},

		/** Moves the worm (it was dragged) and/or renames it (its session's title changed). */
		update(canvasId: string, sessionId: string, body: Record<string, unknown> | null): ConjuredAgent {
			const r = get(canvasId, sessionId)
			const next = { ...r }
			if (body && ('x' in body || 'y' in body)) Object.assign(next, position(body.x, body.y, 'send {"x", "y"} with the new page position'))
			const title = titleField(body?.title)
			if (title !== undefined) next.title = title
			if (next.x === r.x && next.y === r.y && next.title === r.title) return r
			return put(next)
		},

		banish(canvasId: string, sessionId: string) {
			remove(get(canvasId, sessionId))
		},

		/** Throws away every worm on a canvas (it was deleted). */
		dropCanvas(canvasId: string) {
			for (const r of [...records.values()]) if (r.canvasId === canvasId) remove(r)
		},
	}
}
