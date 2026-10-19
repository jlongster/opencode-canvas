/**
 * Creatures: real OpenCode sessions on a canvas that people can talk to. The canvas server only
 * keeps the shared records (at most one per session per canvas, saved in data/index.json): which
 * session, which OpenCode it lives on (serverKey, a non-secret id the browser derives from the
 * OpenCode URL), where it sits and who owns it (ownerId, a random id kept in the owner's browser).
 * It never talks to OpenCode and never sees credentials.
 *
 * A creature the server makes goes beside its session's frame (see creatureSpot in index.ts) and
 * moves along with its frame, and rushes over to an item posted to its session (see rushTo in
 * index.ts). Only its owner moves it from a browser (summoning it with C, picking it
 * in the Conjure menu, dragging it), through `move`, which checks the ownerId; the generic `update`
 * never takes a position.
 *
 * Everything live happens in the owner's browser tab, which talks to OpenCode directly: it
 * publishes the creature's presence into the canvas's room (thinking, replies, position). With no
 * owner tab open the creature is asleep (`awake` false in list responses).
 *
 * A session that queues something for attention (see attention.ts) without a creature on the canvas
 * gets one without an owner (ownerId and serverKey ""): asleep for good, until someone conjures the
 * session from their browser, which adopts it.
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

function position(x: unknown, y: unknown): { x: number; y: number } {
	if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
		throw new ConjureError(400, '"x" and "y" must be the page position (numbers)')
	}
	return { x: Math.round(x), y: Math.round(y) }
}

function titleField(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined
	if (typeof value !== 'string') throw new ConjureError(400, '"title" must be a string')
	return value.trim().replace(/\s+/g, ' ').slice(0, TITLE_MAX)
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * Old records (from when the canvas server ran worms itself) carry fields we no longer keep. Ones
 * saved without a usable position come back at 0,0 with `stray` set, to be placed (see placeStrays).
 */
function clean(r: ConjuredAgent & { directory?: unknown; serverId?: unknown }): (ConjuredAgent & { stray: boolean }) | null {
	if (!r || typeof r.canvasId !== 'string' || typeof r.sessionId !== 'string') return null
	return {
		stray: !finite(r.x) || !finite(r.y) || (r.x === 0 && r.y === 0),
		canvasId: r.canvasId,
		sessionId: r.sessionId,
		serverKey: typeof r.serverKey === 'string' ? r.serverKey : '',
		title: typeof r.title === 'string' ? r.title : '',
		color: typeof r.color === 'string' ? r.color : sessionColor(r.sessionId),
		x: Number(r.x) || 0,
		y: Number(r.y) || 0,
		createdAt: Number(r.createdAt) || Date.now(),
		ownerId: typeof r.ownerId === 'string' ? r.ownerId : '',
		...(r.rush && typeof r.rush.itemId === 'string' && finite(r.rush.at) ? { rush: { itemId: r.rush.itemId, at: r.rush.at } } : {}),
	}
}

/** The record somewhere else: no longer where it rushed to. */
function moved({ rush: _, ...r }: ConjuredAgent, at: { x: number; y: number }): ConjuredAgent {
	return { ...r, ...at }
}

export function createConjured(deps: ConjuredDeps, stored: ConjuredAgent[]) {
	const records = new Map<string, ConjuredAgent>()
	/** loaded records without a usable position; at 0,0 until placeStrays runs */
	const strays: ConjuredAgent[] = []
	for (const r of stored) {
		const cleaned = clean(r)
		if (!cleaned || !deps.canvasExists(cleaned.canvasId)) continue
		const { stray, ...record } = cleaned
		records.set(key(record.canvasId, record.sessionId), record)
		if (stray) strays.push(record)
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

		/**
		 * Conjures a session (or adopts its ownerless creature). With "x"/"y" it goes there (a new or an
		 * adopted one); without, a new one goes at `at` and an adopted one stays where it is.
		 */
		conjure(canvasId: string, body: Record<string, unknown> | null, at: () => { x: number; y: number }): ConjuredAgent {
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
			const given = body && ('x' in body || 'y' in body) ? position(body.x, body.y) : null
			if (!deps.canvasExists(canvasId)) throw new ConjureError(404, `no canvas ${canvasId}`)
			const existing = records.get(key(canvasId, sessionId))
			// One without an owner (made for an agent's attention actions) is adopted.
			if (existing?.ownerId) throw new ConjureError(409, 'that session is already conjured on this canvas')
			if (existing) return put({ ...(given ? moved(existing, given) : existing), serverKey, ownerId, title: titleField(body?.title) || existing.title })
			const spot = given ?? at()
			return put({
				canvasId,
				sessionId,
				serverKey,
				title: titleField(body?.title) ?? '',
				color: sessionColor(sessionId),
				x: Math.round(spot.x),
				y: Math.round(spot.y),
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
			return put({ canvasId, sessionId, serverKey: '', title: title ?? '', color: sessionColor(sessionId), x: Math.round(at.x), y: Math.round(at.y), createdAt: Date.now(), ownerId: '' })
		},

		/**
		 * Places the records loaded without a position (or at exactly 0,0, where a server that didn't
		 * keep positions left them), one by one so each spot clears the ones placed before it, and
		 * saves. `at` returns null to leave one where it is (a 0,0 that really is on a frame).
		 */
		placeStrays(at: (r: ConjuredAgent) => { x: number; y: number } | null) {
			const moved: ConjuredAgent[] = []
			for (const r of strays) records.delete(key(r.canvasId, r.sessionId))
			for (const r of strays.splice(0)) {
				const spot = at(r)
				const placed = spot ? { ...r, x: Math.round(spot.x), y: Math.round(spot.y) } : r
				records.set(key(r.canvasId, r.sessionId), placed)
				if (spot) moved.push(placed)
			}
			if (!moved.length) return
			deps.save()
			for (const r of moved) deps.broadcast({ type: 'conjured', agent: r })
		},

		/**
		 * Its owner moves it (summoned with C, picked in the Conjure menu, dragged): {"x", "y",
		 * "ownerId"}. One nobody owns is adopted on the way, given "serverKey" (and "title"?) too, as
		 * conjuring it would; someone else's is refused.
		 */
		move(canvasId: string, sessionId: string, body: Record<string, unknown> | null): ConjuredAgent {
			const r = get(canvasId, sessionId)
			const owner = body?.ownerId
			if (typeof owner !== 'string' || !OWNER_ID.test(owner)) {
				throw new ConjureError(400, '"ownerId" must be the owner\'s browser id (8-64 characters [A-Za-z0-9_-])')
			}
			const at = position(body?.x, body?.y)
			if (r.ownerId && r.ownerId !== owner) throw new ConjureError(403, 'only the browser that conjured this creature can move it')
			if (!r.ownerId) {
				const serverKey = body?.serverKey
				if (typeof serverKey !== 'string' || !SERVER_KEY.test(serverKey)) {
					throw new ConjureError(400, 'nobody owns this creature yet: send "serverKey" (its OpenCode) to adopt it as you move it')
				}
				return put({ ...moved(r, at), serverKey, ownerId: owner, title: titleField(body?.title) || r.title })
			}
			return at.x === r.x && at.y === r.y && !r.rush ? r : put(moved(r, at))
		},

		/** Renames the worm (its session's title changed). Moving it is its owner's, through `move`. */
		update(canvasId: string, sessionId: string, body: Record<string, unknown> | null): ConjuredAgent {
			const r = get(canvasId, sessionId)
			if (body && ('x' in body || 'y' in body)) throw new ConjureError(403, 'only a creature\'s owner moves it: POST …/conjured/:sessionId/move with {"x", "y", "ownerId"}')
			const title = titleField(body?.title)
			if (title === undefined) throw new ConjureError(400, 'send {"title"}')
			return title === r.title ? r : put({ ...r, title })
		},

		/**
		 * It rushes to point at an item just posted to (or replaced in) its session, at `at`: the
		 * server's move, so no owner check. (Nothing happens without a creature.)
		 */
		rush(canvasId: string, sessionId: string, itemId: string, at: { x: number; y: number }) {
			const r = records.get(key(canvasId, sessionId))
			if (r) put({ ...r, x: Math.round(at.x), y: Math.round(at.y), rush: { itemId, at: Date.now() } })
		},

		/** Moves the worm by dx (page px): its frame moved along (server-side only). */
		shift(canvasId: string, sessionId: string, dx: number) {
			const r = records.get(key(canvasId, sessionId))
			if (r && dx) put({ ...r, x: Math.round(r.x + dx) })
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
