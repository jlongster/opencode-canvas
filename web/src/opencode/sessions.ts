import type { OpenCodeSessionSummary } from '../../../shared/types'
import { errorText, pairings, withServer } from './pairings'

const SESSIONS_LIMIT = 50
const REQUEST_MS = 10_000

export interface SessionListing {
	/** recent sessions on every paired server that answered, newest first */
	sessions: OpenCodeSessionSummary[]
	/** servers whose sessions couldn't be listed, by pairing key */
	errors: Record<string, string>
}

/** Recent sessions across all projects on every paired server. */
export async function listSessions(): Promise<SessionListing> {
	const all = pairings.peek()
	const results = await Promise.allSettled(all.map((p) => serverSessions(p.key)))
	const listing: SessionListing = { sessions: [], errors: {} }
	results.forEach((r, i) => {
		if (r.status === 'fulfilled') listing.sessions.push(...r.value)
		else listing.errors[all[i].key] = errorText(r.reason)
	})
	listing.sessions.sort((a, b) => b.updatedAt - a.updatedAt)
	return listing
}

function serverSessions(key: string): Promise<OpenCodeSessionSummary[]> {
	return withServer(key, async (c, p) => {
		const signal = AbortSignal.timeout(REQUEST_MS)
		const [list, active] = await Promise.all([
			c.session.list({ limit: SESSIONS_LIMIT, order: 'desc' }, { signal }),
			c.session.active({ signal }).catch(() => ({}) as Record<string, unknown>),
		])
		return list.data
			.filter((s) => !s.time.archived)
			.map((s) => ({
				id: s.id,
				serverKey: key,
				serverName: p.name,
				title: s.title?.trim() || '',
				directory: s.location.directory,
				updatedAt: s.time.updated,
				busy: s.id in active,
				...(s.parentID ? { parentId: s.parentID } : {}),
			}))
	})
}
