/**
 * Conjured sessions: real OpenCode sessions brought onto a canvas, whose frames come alive with a
 * status rail people can talk to the session from. The canvas server only keeps the shared records
 * (at most one per session per canvas, saved in data/index.json): which session, which OpenCode it
 * lives on (serverKey, a non-secret id the browser derives from the OpenCode URL) and who owns it
 * (ownerId, a random id kept in the owner's browser). It never talks to OpenCode and never sees
 * credentials.
 *
 * Everything live happens in the owner's browser tab, which talks to OpenCode directly: it
 * publishes the session's status into the canvas's room (working, current step, reply, subagents).
 * With no owner tab open the session is asleep (`awake` false in list responses).
 */
import { sessionColor } from '../shared/sessionColor'
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
const TITLE_MAX = 200

const key = (canvasId: string, sessionId: string) => `${canvasId}/${sessionId}`

function titleField(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined
	if (typeof value !== 'string') throw new ConjureError(400, '"title" must be a string')
	return value.trim().replace(/\s+/g, ' ').slice(0, TITLE_MAX)
}

/** Only the fields we keep; records nobody owns (older versions made them for attention actions) are dropped. */
function clean(r: ConjuredAgent): ConjuredAgent | null {
	if (!r || typeof r.canvasId !== 'string' || typeof r.sessionId !== 'string' || typeof r.ownerId !== 'string' || !r.ownerId) return null
	return {
		canvasId: r.canvasId,
		sessionId: r.sessionId,
		serverKey: typeof r.serverKey === 'string' ? r.serverKey : '',
		title: typeof r.title === 'string' ? r.title : '',
		color: typeof r.color === 'string' ? r.color : sessionColor(r.sessionId),
		createdAt: Number(r.createdAt) || Date.now(),
		ownerId: r.ownerId,
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
		if (!r) throw new ConjureError(404, `${sessionId} isn't conjured on this canvas`)
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

		has: (canvasId: string, sessionId: string) => records.has(key(canvasId, sessionId)),

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
			if (!deps.canvasExists(canvasId)) throw new ConjureError(404, `no canvas ${canvasId}`)
			if (records.has(key(canvasId, sessionId))) throw new ConjureError(409, 'that session is already conjured on this canvas')
			return put({
				canvasId,
				sessionId,
				serverKey,
				title: titleField(body?.title) ?? '',
				color: sessionColor(sessionId),
				createdAt: Date.now(),
				ownerId,
			})
		},

		/** Renames it (its session's title changed). */
		update(canvasId: string, sessionId: string, body: Record<string, unknown> | null): ConjuredAgent {
			const r = get(canvasId, sessionId)
			const title = titleField(body?.title)
			if (title === undefined) throw new ConjureError(400, 'send {"title"}')
			if (title === r.title) return r
			return put({ ...r, title })
		},

		banish(canvasId: string, sessionId: string) {
			remove(get(canvasId, sessionId))
		},

		/** Banishes it if it's conjured (its frame was removed). */
		drop(canvasId: string, sessionId: string) {
			const r = records.get(key(canvasId, sessionId))
			if (r) remove(r)
		},

		/** Throws away every record on a canvas (it was deleted). */
		dropCanvas(canvasId: string) {
			for (const r of [...records.values()]) if (r.canvasId === canvasId) remove(r)
		},
	}
}
