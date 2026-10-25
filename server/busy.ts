/**
 * Which sessions are working, for everyone looking at a canvas: the busy band round their frames.
 * The canvas server never talks to OpenCode, so the edit tabs paired with it say so: each reports,
 * over its live socket, the canvas's sessions it sees working ({"type": "busy", "sessionIds"}, the
 * whole set every time), and a session is busy while any tab says it is.
 *
 * A tab's report goes when its socket closes (after CLOSE_GRACE_MS, so a refreshing tab's next
 * report takes over without the band flickering off), or when it isn't refreshed within
 * REPORT_TTL_MS (the tab refreshes it every 20s while anything is working).
 *
 * Which sessions wait on an answer (a question or a permission request: the subagents' orbs show it)
 * is reported the same way ({"type": "asking", "sessionIds"}), by a second one of these.
 */
import type { SessionActivity } from '../shared/types'

export interface BusyDeps {
	/** whether the canvas has a frame for the session (only those are reported) */
	hasSession(canvasId: string, sessionId: string): boolean
	/** a session started (on) or stopped being reported */
	changed(canvasId: string, sessionId: string, on: boolean): void
}

const REPORT_TTL_MS = 60_000
const CLOSE_GRACE_MS = 3_000
const REPORT_MAX = 500

interface Report {
	canvasId: string
	sessionIds: Set<string>
	expires: ReturnType<typeof setTimeout>
}

export function createBusy(deps: BusyDeps) {
	/** each reporting tab's (its live socket's) latest report */
	const reports = new Map<object, Report>()

	const busyOn = (canvasId: string) => {
		const ids = new Set<string>()
		for (const r of reports.values()) if (r.canvasId === canvasId) for (const id of r.sessionIds) ids.add(id)
		return ids
	}

	/** Changes reports on one canvas, broadcasting the sessions that started or stopped working. */
	function change(canvasId: string, fn: () => void) {
		const before = busyOn(canvasId)
		fn()
		const after = busyOn(canvasId)
		for (const id of after) if (!before.has(id)) deps.changed(canvasId, id, true)
		for (const id of before) if (!after.has(id)) deps.changed(canvasId, id, false)
	}

	function drop(reporter: object) {
		const r = reports.get(reporter)
		if (!r) return
		clearTimeout(r.expires)
		change(r.canvasId, () => reports.delete(reporter))
	}

	return {
		/** The sessions working on a canvas right now. */
		list: (canvasId: string): string[] => [...busyOn(canvasId)],

		isBusy: (canvasId: string, sessionId: string) => busyOn(canvasId).has(sessionId),

		/** A tab's report: the sessions on the canvas it sees working (anything else in it is ignored). */
		report(reporter: object, canvasId: string, sessionIds: unknown) {
			if (!Array.isArray(sessionIds)) return
			const ids = new Set(sessionIds.slice(0, REPORT_MAX).filter((id): id is string => typeof id === 'string' && deps.hasSession(canvasId, id)))
			clearTimeout(reports.get(reporter)?.expires)
			change(canvasId, () => {
				if (!ids.size) return void reports.delete(reporter)
				reports.set(reporter, { canvasId, sessionIds: ids, expires: setTimeout(() => drop(reporter), REPORT_TTL_MS) })
			})
		},

		/** The tab's socket closed: its report goes shortly (a reconnecting or reloaded tab reports again meanwhile). */
		closed(reporter: object) {
			if (reports.has(reporter)) setTimeout(() => drop(reporter), CLOSE_GRACE_MS)
		},

		/** A session's frame was deleted (or the whole canvas, with no sessionId). */
		forget(canvasId: string, sessionId?: string) {
			change(canvasId, () => {
				for (const [reporter, r] of reports) {
					if (r.canvasId !== canvasId) continue
					if (sessionId) r.sessionIds.delete(sessionId)
					if (!sessionId || !r.sessionIds.size) {
						clearTimeout(r.expires)
						reports.delete(reporter)
					}
				}
			})
		},
	}
}

export interface ActivityDeps {
	hasSession(canvasId: string, sessionId: string): boolean
	/** what a session is doing changed (null: no tab says anything about it any more) */
	changed(canvasId: string, sessionId: string, activity: SessionActivity | null): void
}

const ACTIVITY_MAX = 200
const TEXT_MAX = 160

interface ActivityReport {
	canvasId: string
	sessions: Map<string, SessionActivity>
	at: number
	expires: ReturnType<typeof setTimeout>
}

/** One session's activity as a tab reported it, with anything malformed left out. */
function cleanActivity(value: unknown): SessionActivity | null {
	if (!value || typeof value !== 'object') return null
	const v = value as Record<string, unknown>
	const out: SessionActivity = {}
	for (const k of ['model', 'agent', 'step'] as const) {
		const s = v[k]
		if (typeof s === 'string' && s.trim()) out[k] = s.trim().slice(0, TEXT_MAX)
	}
	for (const k of ['stepAt', 'busySince'] as const) {
		const n = v[k]
		if (typeof n === 'number' && Number.isFinite(n) && n > 0) out[k] = n
	}
	return Object.keys(out).length ? out : null
}

const sameActivity = (a: SessionActivity | null | undefined, b: SessionActivity | null | undefined) =>
	JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/**
 * What the canvas's sessions are doing (their frames' title blocks and printouts: model, agent, the
 * step they're on, since when they work), for everyone looking at it. Reported like busy above
 * ({"type": "activity", "sessions": {id: activity}}, the whole set every time, throttled by the tab),
 * and dropped the same way: when the tab's socket closes or its report isn't refreshed in time. Where
 * several tabs report a session, the latest report wins.
 */
export function createActivity(deps: ActivityDeps) {
	const reports = new Map<object, ActivityReport>()

	const on = (canvasId: string) => {
		const out = new Map<string, SessionActivity>()
		const list = [...reports.values()].filter((r) => r.canvasId === canvasId).sort((a, b) => a.at - b.at)
		for (const r of list) for (const [id, a] of r.sessions) out.set(id, a)
		return out
	}

	function change(canvasId: string, fn: () => void) {
		const before = on(canvasId)
		fn()
		const after = on(canvasId)
		for (const [id, a] of after) if (!sameActivity(before.get(id), a)) deps.changed(canvasId, id, a)
		for (const id of before.keys()) if (!after.has(id)) deps.changed(canvasId, id, null)
	}

	function drop(reporter: object) {
		const r = reports.get(reporter)
		if (!r) return
		clearTimeout(r.expires)
		change(r.canvasId, () => reports.delete(reporter))
	}

	return {
		/** What the canvas's sessions are doing, by session id. */
		list: (canvasId: string): Record<string, SessionActivity> => Object.fromEntries(on(canvasId)),

		report(reporter: object, canvasId: string, sessions: unknown) {
			if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) return
			const map = new Map<string, SessionActivity>()
			for (const [id, value] of Object.entries(sessions as Record<string, unknown>).slice(0, ACTIVITY_MAX)) {
				const a = deps.hasSession(canvasId, id) ? cleanActivity(value) : null
				if (a) map.set(id, a)
			}
			clearTimeout(reports.get(reporter)?.expires)
			change(canvasId, () => {
				if (!map.size) return void reports.delete(reporter)
				reports.set(reporter, { canvasId, sessions: map, at: Date.now(), expires: setTimeout(() => drop(reporter), REPORT_TTL_MS) })
			})
		},

		closed(reporter: object) {
			if (reports.has(reporter)) setTimeout(() => drop(reporter), CLOSE_GRACE_MS)
		},

		forget(canvasId: string, sessionId?: string) {
			change(canvasId, () => {
				for (const [reporter, r] of reports) {
					if (r.canvasId !== canvasId) continue
					if (sessionId) r.sessions.delete(sessionId)
					if (!sessionId || !r.sessions.size) {
						clearTimeout(r.expires)
						reports.delete(reporter)
					}
				}
			})
		},
	}
}
