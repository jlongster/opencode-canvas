/**
 * Which sessions are working, for everyone looking at a canvas: the busy band round their frames.
 * The canvas server never talks to OpenCode, so the edit tabs paired with it say so: each reports,
 * over its live socket, the canvas's sessions it sees working ({"type": "busy", "sessionIds"}, the
 * whole set every time), and a session is busy while any tab says it is.
 *
 * A tab's report goes when its socket closes (after CLOSE_GRACE_MS, so a refreshing tab's next
 * report takes over without the band flickering off), or when it isn't refreshed within
 * REPORT_TTL_MS (the tab refreshes it every 20s while anything is working).
 */
import type { ServerEvent } from '../shared/types'

export interface BusyDeps {
	/** whether the canvas has a frame for the session (only those are reported) */
	hasSession(canvasId: string, sessionId: string): boolean
	broadcast(event: ServerEvent): void
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
		for (const id of after) if (!before.has(id)) deps.broadcast({ type: 'status', canvasId, sessionId: id, busy: true })
		for (const id of before) if (!after.has(id)) deps.broadcast({ type: 'status', canvasId, sessionId: id, busy: false })
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
