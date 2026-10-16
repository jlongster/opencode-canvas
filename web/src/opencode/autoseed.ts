/**
 * Seeding a new canvas by itself: when an empty canvas opens on an edit link in a browser paired
 * with OpenCode, it gets the AUTO_SESSIONS most recently updated top-level sessions (subagents
 * left out) that have media, skipping those that have none, looking at most AUTO_DEPTH sessions
 * deep. Sessions are read a few ahead while the previous one uploads.
 *
 * Each canvas is seeded automatically at most once, ever: right before the first upload the
 * browser claims it on the canvas server (POST /api/canvases/:cid/autoseed, 409 when another tab
 * or person got there first), so emptying the canvas later shows the picker instead.
 */
import type { OpenCodeSessionSummary, SeedResult } from '../../../shared/types'
import { url } from '../base'
import { errorText } from './pairings'
import { readSessionMedia, uploadSessionMedia, type SessionMedia } from './seed'

export const AUTO_SESSIONS = 5
export const AUTO_DEPTH = 25
/** sessions read ahead of the one uploading */
const READ_AHEAD = 3

export type AutoRow =
	| { state: 'reading' }
	| { state: 'uploading'; done: number; total: number }
	| { state: 'done'; result: SeedResult }
	| { state: 'empty' }
	| { state: 'error'; error: string }

export type AutoOutcome =
	/** seeded this many sessions */
	| { kind: 'seeded'; count: number }
	/** none of the sessions looked at had media (nothing claimed) */
	| { kind: 'nothing' }
	/** someone else claimed it first, or it was seeded automatically before */
	| { kind: 'claimed' }
	| { kind: 'stopped' }
	| { kind: 'failed'; error: string }

/** When the canvas was seeded automatically, or null if never. */
export async function autoSeededAt(canvasId: string): Promise<number | null> {
	const res = await fetch(url(`/api/canvases/${encodeURIComponent(canvasId)}/autoseed`))
	if (!res.ok) throw new Error(`autoseed status: HTTP ${res.status}`)
	return ((await res.json()) as { autoSeededAt: number | null }).autoSeededAt
}

/** Claims the canvas's one automatic seeding: true for the first caller only. */
export async function claimAutoSeed(canvasId: string): Promise<boolean> {
	const res = await fetch(url(`/api/canvases/${encodeURIComponent(canvasId)}/autoseed`), { method: 'POST' })
	if (res.status === 409) return false
	if (!res.ok) throw new Error(`couldn't claim seeding: HTTP ${res.status}`)
	return true
}

/** The sessions to look at, newest first (listServerSessions only lists top-level ones). */
export function autoCandidates(sessions: OpenCodeSessionSummary[]): OpenCodeSessionSummary[] {
	return sessions
		.sort((a, b) => b.updatedAt - a.updatedAt)
		.slice(0, AUTO_DEPTH)
}

/**
 * Seeds the canvas with the first AUTO_SESSIONS of `candidates` that have media, in order (so frames
 * go newest first). `onRow` reports each session it looks at; `stopped` is checked between steps.
 */
export async function autoSeed(
	canvasId: string,
	candidates: OpenCodeSessionSummary[],
	opts: {
		existing: (sessionId: string) => Set<string>
		onRow: (session: OpenCodeSessionSummary, row: AutoRow) => void
		onSeeded?: () => void
		stopped: () => boolean
	},
): Promise<AutoOutcome> {
	const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
	const reads = new Map<number, Promise<SessionMedia | Error>>()
	const read = (i: number) => {
		if (i >= candidates.length || reads.has(i)) return
		const s = candidates[i]
		opts.onRow(s, { state: 'reading' })
		reads.set(i, readSessionMedia(s.serverKey, s.id).catch((e) => new Error(errorText(e))))
	}
	let claimed = false
	let count = 0
	for (let i = 0; i < candidates.length && count < AUTO_SESSIONS; i++) {
		for (let j = i; j < i + READ_AHEAD; j++) read(j)
		const session = candidates[i]
		const found = await reads.get(i)!
		if (opts.stopped()) return { kind: 'stopped' }
		if (found instanceof Error) {
			opts.onRow(session, { state: 'error', error: found.message })
			continue
		}
		if (!found.media.length) {
			opts.onRow(session, { state: 'empty' })
			continue
		}
		if (!claimed) {
			try {
				if (!(await claimAutoSeed(canvasId))) return { kind: 'claimed' }
			} catch (e) {
				return { kind: 'failed', error: errorText(e) }
			}
			claimed = true
		}
		opts.onRow(session, { state: 'uploading', done: 0, total: found.media.length })
		const result = await uploadSessionMedia(canvasId, session.id, found, {
			existing: opts.existing(session.id),
			timeZone,
			onUploaded: (done, total) => opts.onRow(session, { state: 'uploading', done, total }),
		})
		opts.onRow(session, { state: 'done', result })
		if (result.added) {
			count++
			opts.onSeeded?.()
		}
		if (opts.stopped()) return { kind: 'stopped' }
	}
	return count ? { kind: 'seeded', count } : claimed ? { kind: 'failed', error: 'no media could be added' } : { kind: 'nothing' }
}
