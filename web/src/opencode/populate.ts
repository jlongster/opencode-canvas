/**
 * Populating a session's frame when it's added to a canvas with nothing in it yet: the browser
 * finds the media and HTML the session involved (see seed.ts) and uploads them into its frame, in
 * groups "Media", "HTML" and "Attached" (media attached to its prompts).
 *
 * Once per session per canvas: before reading anything, the browser claims it on the canvas server
 * (POST /api/canvases/:cid/sessions/:sid/populate; 409 when another tab got there first, it was
 * populated before, or the frame already has items). If OpenCode can't be read, the claim is given
 * back (DELETE) so adding it again tries again. Nothing found leaves the frame empty.
 */
import { url } from '../base'
import { atom } from '../state/signals'
import { uploadItem } from '../sync/client'
import { errorText } from './pairings'
import { findSessionFiles, type FileKind, type SessionFiles } from './seed'

export const POPULATE_GROUPS: Record<FileKind, string> = { media: 'Media', html: 'HTML', attached: 'Attached' }

export type PopulateStatus = { state: 'finding' } | { state: 'adding'; done: number; total: number }

/** Sessions being populated from this tab, by session id (for the progress shown at their frames). */
export const populating = atom<Record<string, PopulateStatus>>('populating', {})

export interface PopulateResult {
	added: number
	/** found but couldn't be added, or output but gone */
	skipped: number
	error?: string
}

/**
 * Fills the session's frame with what it involved, if nobody has yet. Resolves to null when it
 * wasn't this tab's to do (claimed already).
 */
export async function populateSession(canvasId: string, serverKey: string, sessionId: string): Promise<PopulateResult | null> {
	if (populating.peek()[sessionId]) return null
	try {
		if (!(await claimPopulate(canvasId, sessionId))) return null
	} catch (e) {
		return { added: 0, skipped: 0, error: errorText(e) }
	}
	setStatus(sessionId, { state: 'finding' })
	try {
		let found: SessionFiles
		try {
			found = await findSessionFiles(serverKey, sessionId)
		} catch (e) {
			await releasePopulate(canvasId, sessionId).catch(() => {})
			return { added: 0, skipped: 0, error: `OpenCode: ${errorText(e)}` }
		}
		return await upload(canvasId, sessionId, found)
	} finally {
		setStatus(sessionId, null)
	}
}

async function upload(canvasId: string, sessionId: string, found: SessionFiles): Promise<PopulateResult> {
	const result: PopulateResult = { added: 0, skipped: found.skipped }
	const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
	const total = found.files.length
	setStatus(sessionId, { state: 'adding', done: 0, total })
	let lastAt = 0
	let done = 0
	for (const file of found.files) {
		// Strictly increasing, so files output in the same instant keep their order.
		const createdAt = (lastAt = Math.max(Math.round(file.at), lastAt + 1))
		try {
			await uploadItem(canvasId, sessionId, file.data, {
				filename: file.filename,
				group: POPULATE_GROUPS[file.kind],
				title: file.label,
				caption: caption(file.at, file.via, file.source, file.gone, timeZone),
				createdAt,
				sessionTitle: found.title,
			})
			result.added++
		} catch (e) {
			// the canvas is gone
			if ((e as { status?: number }).status === 404) {
				result.error = (e as Error).message
				break
			}
			result.skipped++
		}
		setStatus(sessionId, { state: 'adding', done: ++done, total })
	}
	return result
}

const populatePath = (canvasId: string, sessionId: string) =>
	url(`/api/canvases/${encodeURIComponent(canvasId)}/sessions/${encodeURIComponent(sessionId)}/populate`)

/** Claims the session's one populating on this canvas: true for the first caller only. */
async function claimPopulate(canvasId: string, sessionId: string): Promise<boolean> {
	const res = await fetch(populatePath(canvasId, sessionId), { method: 'POST' })
	if (res.status === 409) return false
	if (!res.ok) throw new Error(`couldn't claim populating: HTTP ${res.status}`)
	return true
}

async function releasePopulate(canvasId: string, sessionId: string) {
	await fetch(populatePath(canvasId, sessionId), { method: 'DELETE' })
}

function setStatus(sessionId: string, status: PopulateStatus | null) {
	const { [sessionId]: _, ...rest } = populating.peek()
	populating.set(status ? { ...rest, [sessionId]: status } : rest)
}

/** "Oct 15, 2026, 2:32:05 PM · via read", then the file's path (noting when it's gone and the copy is from the session) */
function caption(at: number, via: string, path: string | undefined, gone: boolean, timeZone?: string) {
	let when: string
	try {
		when = new Date(at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'medium', timeZone })
	} catch {
		when = new Date(at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'medium' })
	}
	return `${when} · via ${via}${path ? `\n${path}${gone ? ' (since deleted; this is the copy in the session)' : ''}` : ''}`
}
