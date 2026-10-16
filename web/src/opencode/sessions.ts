import type { OpenCodeSessionSummary } from '../../../shared/types'
import { pairing, withServer } from './pairings'

const SESSIONS_LIMIT = 50
/** a server that hasn't listed its sessions by then counts as failed (it can be retried) */
const LIST_TIMEOUT_MS = 8_000

/** One server's recent top-level sessions (no subagents) across all its projects, newest first; fails if it doesn't answer within LIST_TIMEOUT_MS. */
export function listServerSessions(key: string): Promise<OpenCodeSessionSummary[]> {
	const abort = new AbortController()
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(`${pairing(key)?.name ?? 'It'} didn't answer within ${LIST_TIMEOUT_MS / 1000}s`))
			abort.abort()
		}, LIST_TIMEOUT_MS)
		serverSessions(key, abort.signal)
			.then(resolve, reject)
			.finally(() => clearTimeout(timer))
	})
}

function serverSessions(key: string, signal: AbortSignal): Promise<OpenCodeSessionSummary[]> {
	return withServer(key, async (c, p) => {
		const [list, active] = await Promise.all([
			// parentID: null asks for top-level sessions only, so subagents don't use up the limit.
			c.session.list({ limit: SESSIONS_LIMIT, order: 'desc', parentID: null }, { signal }),
			c.session.active({ signal }).catch(() => ({}) as Record<string, unknown>),
		])
		return list.data
			.filter((s) => !s.time.archived && !s.parentID)
			.map((s) => ({
				id: s.id,
				serverKey: key,
				serverName: p.name,
				title: s.title?.trim() || '',
				directory: s.location?.directory ?? '',
				updatedAt: s.time.updated,
				busy: s.id in active,
			}))
			.sort((a, b) => b.updatedAt - a.updatedAt)
	})
}
