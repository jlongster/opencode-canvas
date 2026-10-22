/**
 * Session links: which OpenCode session a canvas's session frame talks to. The canvas server only
 * keeps the shared records (at most one per session per canvas, saved in data/index.json): which
 * session, which OpenCode it lives on (serverKey, a non-secret id the browser derives from the
 * OpenCode URL) and whose browser runs it (ownerId, a random id kept in that browser). It never
 * talks to OpenCode and never sees credentials.
 *
 * Everything live happens in the owner's browser tab, which talks to OpenCode directly: it reports
 * whether the session is working (status, below) and shares its streaming reply through the room.
 * With no owner tab open the link is offline (`online` false in list responses).
 *
 * Status: the owner's tab says whether the session is busy (PUT …/sessions/:sid/status). The server
 * keeps that in memory and broadcasts it, so every viewer draws the busy frame. A busy status the
 * owner stops refreshing (its tab closed mid-turn) expires after STATUS_TTL_MS.
 *
 * Deleting a session's frame drops its link (see deleteSession in index.ts); hiding it doesn't.
 */
import { sessionColor } from '../shared/sessionColor'
import type { ServerEvent, SessionLink } from '../shared/types'

export class LinkError extends Error {
	constructor(public status: number, message: string) {
		super(message)
	}
}

export interface LinkDeps {
	canvasExists(id: string): boolean
	/** persists the index (which reads all() for its links) */
	save(): void
	broadcast(event: ServerEvent): void
}

const SESSION_ID = /^ses_[A-Za-z0-9]{26}$/
const SERVER_KEY = /^[A-Za-z0-9_-]{1,64}$/
const OWNER_ID = /^[A-Za-z0-9_-]{8,64}$/
/** a busy status not refreshed for this long is dropped (the owner's tab refreshes it every 20s) */
const STATUS_TTL_MS = 60_000

const key = (canvasId: string, sessionId: string) => `${canvasId}/${sessionId}`

/** Stored records keep only what a link is; anything else (older fields) is dropped. */
function clean(r: Partial<SessionLink> | null): SessionLink | null {
	if (!r || typeof r.canvasId !== 'string' || typeof r.sessionId !== 'string') return null
	return {
		canvasId: r.canvasId,
		sessionId: r.sessionId,
		serverKey: typeof r.serverKey === 'string' ? r.serverKey : '',
		color: typeof r.color === 'string' ? r.color : sessionColor(r.sessionId),
		createdAt: Number(r.createdAt) || Date.now(),
		ownerId: typeof r.ownerId === 'string' ? r.ownerId : '',
	}
}

export function createLinks(deps: LinkDeps, stored: unknown[]) {
	const records = new Map<string, SessionLink>()
	for (const r of stored) {
		const link = clean(r as Partial<SessionLink>)
		if (link && link.ownerId && deps.canvasExists(link.canvasId)) records.set(key(link.canvasId, link.sessionId), link)
	}
	/** busy sessions, by key: when the status expires */
	const busy = new Map<string, ReturnType<typeof setTimeout>>()

	function get(canvasId: string, sessionId: string): SessionLink {
		const r = records.get(key(canvasId, sessionId))
		if (!r) throw new LinkError(404, `${sessionId} isn't linked on this canvas`)
		return r
	}

	function put(record: SessionLink) {
		records.set(key(record.canvasId, record.sessionId), record)
		deps.save()
		deps.broadcast({ type: 'link', link: record })
		return record
	}

	function setBusy(canvasId: string, sessionId: string, on: boolean) {
		const k = key(canvasId, sessionId)
		const was = busy.has(k)
		clearTimeout(busy.get(k))
		busy.delete(k)
		if (on) busy.set(k, setTimeout(() => setBusy(canvasId, sessionId, false), STATUS_TTL_MS))
		if (was !== on) deps.broadcast({ type: 'status', canvasId, sessionId, busy: on })
	}

	function remove(r: SessionLink) {
		if (!records.delete(key(r.canvasId, r.sessionId))) return
		setBusy(r.canvasId, r.sessionId, false)
		deps.save()
		deps.broadcast({ type: 'link_deleted', canvasId: r.canvasId, sessionId: r.sessionId })
	}

	return {
		/** every record, for saving */
		all: (): SessionLink[] => [...records.values()],

		list: (canvasId: string): SessionLink[] =>
			[...records.values()].filter((r) => r.canvasId === canvasId).sort((a, b) => a.createdAt - b.createdAt),

		/** Whether the session is working right now (as its owner's tab last said). */
		isBusy: (canvasId: string, sessionId: string) => busy.has(key(canvasId, sessionId)),

		/** Links a session to this browser: {"sessionId", "serverKey", "ownerId"}. */
		link(canvasId: string, body: Record<string, unknown> | null): SessionLink {
			const { sessionId, serverKey, ownerId } = body ?? {}
			if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
				throw new LinkError(400, `"sessionId" must be an OpenCode session id ("ses_" + 26 characters)`)
			}
			if (typeof serverKey !== 'string' || !SERVER_KEY.test(serverKey)) {
				throw new LinkError(400, '"serverKey" must name the OpenCode it lives on (1-64 characters [A-Za-z0-9_-])')
			}
			if (typeof ownerId !== 'string' || !OWNER_ID.test(ownerId)) {
				throw new LinkError(400, '"ownerId" must be the owner\'s browser id (8-64 characters [A-Za-z0-9_-])')
			}
			if (!deps.canvasExists(canvasId)) throw new LinkError(404, `no canvas ${canvasId}`)
			const existing = records.get(key(canvasId, sessionId))
			if (existing && existing.ownerId !== ownerId) throw new LinkError(409, 'that session is already linked by another browser')
			if (existing) return existing.serverKey === serverKey ? existing : put({ ...existing, serverKey })
			return put({ canvasId, sessionId, serverKey, color: sessionColor(sessionId), createdAt: Date.now(), ownerId })
		},

		/** The owner's tab reports whether the session is working: {"busy", "ownerId"}. */
		status(canvasId: string, sessionId: string, body: Record<string, unknown> | null) {
			const r = get(canvasId, sessionId)
			if (typeof body?.busy !== 'boolean') throw new LinkError(400, 'send {"busy": true|false, "ownerId"}')
			if (body.ownerId !== r.ownerId) throw new LinkError(403, 'only the browser that linked this session reports its status')
			setBusy(canvasId, sessionId, body.busy)
			return { sessionId, busy: body.busy }
		},

		unlink(canvasId: string, sessionId: string) {
			remove(get(canvasId, sessionId))
		},

		/** Drops the session's link if it has one (its frame was deleted). */
		drop(canvasId: string, sessionId: string) {
			const r = records.get(key(canvasId, sessionId))
			if (r) remove(r)
		},

		/** Throws away every link on a canvas (it was deleted). */
		dropCanvas(canvasId: string) {
			for (const r of [...records.values()]) if (r.canvasId === canvasId) remove(r)
		},
	}
}
