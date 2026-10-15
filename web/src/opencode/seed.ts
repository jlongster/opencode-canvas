/**
 * Seeding a canvas from OpenCode sessions, in the browser: finds the images and videos a session
 * output in the last 24 hours (or its latest SEED_FILL if there are fewer), in the order it output
 * them, and uploads each to the canvas server. Read-only on
 * OpenCode: it only reads the session, its messages and the files they point at.
 *
 * Where media turns up in a session's messages (OpenCode v2 message.list):
 * - assistant tool parts whose completed state has file content ({type: "file", uri, mime, name?}):
 *   the read tool on an image returns it as a data: URL with name = the file's path; code mode
 *   (execute) returns screenshots and other images from the tools it called as data: URLs with no name.
 * - synthetic messages that report a finished background image request
 *   (metadata {source: "opencode.image_generate", status, path}).
 * - paths ending in an image/video extension in a tool's input or text output (shell commands that
 *   write screenshots or renders, image_generate/image_edit's "path", files posted elsewhere...). These are
 *   only weak hints, so they count only when the file exists and was modified within the window (for
 *   older media, around or after the time it was mentioned).
 * Media the user attached to their own prompts isn't included: the session didn't produce it.
 *
 * Files are read through OpenCode's file API (GET /api/fs/read/<path>, which also answers HEAD with
 * Last-Modified and Content-Length); data: URLs decode right here.
 */
import type { SeedResult } from '../../../shared/types'
import { uploadItem } from '../sync/client'
import { authHeader, errorText, pairing, withServer, type Pairing } from './pairings'

const MEDIA_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.webm', '.mov'])
const PATH_IN_TEXT = /[\w~./+-]*\.(?:png|jpe?g|webp|gif|mp4|webm|mov)(?![\w/])/gi
const PAGE_SIZE = 200
const MAX_PAGES = 50
/** a tool can finish well after its message started: keep paging this far past the window */
const PAGE_SLACK_MS = 60 * 60 * 1000
const MAX_FILE_BYTES = 200 * 1024 * 1024
const REQUEST_MS = 30_000
export const SEED_WINDOW_MS = 24 * 60 * 60 * 1000
export const SEED_MAX_ITEMS = 100
/** fewer than this in the window: top up with the latest older media */
export const SEED_FILL = 10
export const SEED_GROUP = 'Latest media'

interface SeedMedia {
	/** when it was output (ms) */
	at: number
	data: Blob
	/** file name for the item: the file's basename, or one made up for data: URLs */
	filename: string
	/** short label for the item's title */
	label: string
	/** which tool or message it came from */
	via: string
	/** the path it was output at, also when the file is gone and the data comes from the session */
	source?: string
	/** the file is gone (or unreadable) and this is the copy from the session */
	gone: boolean
}

interface Candidate {
	at: number
	order: number
	path?: string
	data?: Blob
	label: string
	via: string
	/** strong: the session certainly output this (counted as skipped when it's gone); weak: a path mentioned somewhere */
	strong: boolean
}

interface ToolFile {
	type: 'file'
	uri: string
	mime: string
	name?: string | null
}

/**
 * Seeds one session: a frame titled like it, with the media it output in the last day (topped up
 * with its latest older media to SEED_FILL items) in group "Latest media". Items already there (same name and time) aren't added twice.
 */
export async function seedSession(
	canvasId: string,
	serverKey: string,
	sessionId: string,
	opts: { existing: Set<string>; timeZone?: string },
): Promise<SeedResult> {
	const result: SeedResult = { sessionId, title: '', added: 0, skipped: 0 }
	try {
		const found = await findSessionMedia(serverKey, sessionId, { since: Date.now() - SEED_WINDOW_MS, limit: SEED_MAX_ITEMS, fill: SEED_FILL })
		result.title = found.title
		result.skipped = found.skipped
		if (!found.media.length) {
			result.error = found.skipped ? 'its media is gone' : 'no media found in this session'
			return result
		}
		let lastAt = 0
		const failures: string[] = []
		for (const media of found.media) {
			// Strictly increasing, so items output in the same instant keep their order.
			const createdAt = (lastAt = Math.max(Math.round(media.at), lastAt + 1))
			if (opts.existing.has(`${media.filename}@${createdAt}`)) continue
			try {
				await uploadItem(canvasId, sessionId, media.data, {
					filename: media.filename,
					group: SEED_GROUP,
					title: media.label,
					caption: seedCaption(media.at, media.via, media.source, media.gone, opts.timeZone),
					createdAt,
					sessionTitle: found.title,
				})
				result.added++
			} catch (e) {
				if ((e as { status?: number }).status === 404) throw e
				result.skipped++
				failures.push(`${media.filename}: ${(e as Error).message}`)
			}
		}
		if (!result.added && failures.length) result.error = failures[0]
	} catch (e) {
		result.error = (e as { status?: number }).status === 404 ? (e as Error).message : `OpenCode: ${errorText(e)}`
	}
	return result
}

/** "Oct 15, 2026, 2:32:05 PM · via read", then the file's path (noting when it's gone and the copy is from the session) */
function seedCaption(at: number, via: string, path: string | undefined, gone: boolean, timeZone?: string) {
	let when: string
	try {
		when = new Date(at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'medium', timeZone })
	} catch {
		when = new Date(at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'medium' })
	}
	return `${when} · via ${via}${path ? `\n${path}${gone ? ' (since deleted; this is the copy in the session)' : ''}` : ''}`
}

interface Message {
	id: string
	type: string
	time: { created: number }
	metadata?: Record<string, unknown>
	content?: unknown[]
}

type Usable = SeedMedia & { hash: string }

/**
 * The image/video media the session output since `since`, oldest first, de-duplicated, at most
 * `limit` (the latest ones). When that's fewer than `fill`, the latest media it output before
 * `since` tops it up to `fill`: older messages are only fetched until that many are found.
 */
async function findSessionMedia(serverKey: string, sessionId: string, opts: { since: number; limit: number; fill: number }) {
	const session = await withServer(serverKey, (c) => c.session.get({ sessionID: sessionId }, { signal: AbortSignal.timeout(REQUEST_MS) }))
	const p = pairing(serverKey)!
	const directory = session.location.directory
	const home = homeOf(directory)

	// Messages newest first, a page at a time.
	let cursor: string | null | undefined
	let pages = 0
	let exhausted = false
	const nextPage = async (): Promise<Message[]> => {
		if (exhausted) return []
		const res = await withServer(serverKey, (c) =>
			c.message.list(cursor ? { sessionID: sessionId, cursor, limit: PAGE_SIZE } : { sessionID: sessionId, order: 'desc', limit: PAGE_SIZE }, {
				signal: AbortSignal.timeout(REQUEST_MS),
			}),
		)
		cursor = res.cursor.next
		if (!cursor || !res.data.length || ++pages >= MAX_PAGES) exhausted = true
		return res.data as unknown as Message[]
	}

	const recentMessages: Message[] = []
	while (!exhausted) {
		const page = await nextPage()
		recentMessages.push(...page)
		if ((page.at(-1)?.time?.created ?? 0) < opts.since - PAGE_SLACK_MS) break
	}
	let order = 0
	const candidates = recentMessages.reverse().flatMap((m) => messageCandidates(m, directory, home, () => order++))
	const recent = candidates.filter((c) => c.at >= opts.since)

	// One per path: at the place it was first output, with its current file (or the latest copy in the session).
	const byPath = new Map<string, Candidate>()
	const unique: Candidate[] = []
	for (const c of recent) {
		if (!c.path) {
			unique.push(c)
			continue
		}
		const seen = byPath.get(c.path)
		if (!seen) {
			byPath.set(c.path, c)
			unique.push(c)
			continue
		}
		if (c.data) seen.data = c.data
		if (c.strong && !seen.strong) {
			seen.strong = true
			seen.via = c.via
		}
	}

	const usable: Usable[] = []
	let skipped = 0
	for (const c of unique) {
		const media = await resolveCandidate(p, c, directory, opts.since, usable)
		if (media === 'gone') {
			if (c.strong) skipped++
			continue
		}
		if (media && !usable.some((u) => u.hash === media.hash)) usable.push(media)
	}

	usable.sort((a, b) => a.at - b.at)
	const kept = usable.slice(-opts.limit)
	skipped += usable.length - kept.length

	// Fewer than `fill` in the window: the latest older media, newest first, from the messages
	// already fetched and then further pages until there are enough or the session runs out.
	if (kept.length < opts.fill) {
		const older: Usable[] = []
		const triedPaths = new Set(byPath.keys())
		const gonePaths = new Set<string>()
		const queue = descending(candidates.filter((c) => c.at < opts.since))
		while (kept.length + older.length < opts.fill) {
			const c = queue.shift()
			if (!c) {
				if (exhausted) break
				const page = await nextPage()
				queue.push(...descending(page.reverse().flatMap((m) => messageCandidates(m, directory, home, () => order++))))
				continue
			}
			if (c.path && triedPaths.has(c.path) && !(gonePaths.has(c.path) && c.data)) continue
			// weak hints count when the file was modified around (or after) the time it was mentioned
			const media = await resolveCandidate(p, c, directory, c.at - PAGE_SLACK_MS, [...kept, ...older])
			if (c.path) triedPaths.add(c.path)
			if (media === 'gone') {
				if (c.path) gonePaths.add(c.path)
				continue
			}
			if (c.path) gonePaths.delete(c.path)
			if (media && !kept.some((u) => u.hash === media.hash) && !older.some((u) => u.hash === media.hash)) older.push(media)
		}
		kept.unshift(...older)
		kept.sort((a, b) => a.at - b.at)
	}

	return {
		title: session.title?.trim() || sessionId,
		media: kept.map(({ hash: _, ...m }) => m),
		skipped,
	}
}

/** Newest first; within one instant, last output first. */
function descending(candidates: Candidate[]): Candidate[] {
	return candidates.sort((a, b) => b.at - a.at || b.order - a.order)
}

/**
 * The media a candidate points at: its current file, else the copy in the session; 'gone' when
 * neither is there, null when it's to be left out (node_modules). Copies from the session get a
 * file name not yet taken in `taken`.
 */
async function resolveCandidate(p: Pairing, c: Candidate, directory: string, since: number, taken: SeedMedia[]): Promise<Usable | 'gone' | null> {
	if (c.path && c.path.split('/').includes('node_modules')) return null
	let media: SeedMedia | null = null
	if (c.path) {
		const file = await readFile(p, c.path, directory, { strong: c.strong, since }).catch(() => null)
		if (file) media = { at: c.at, data: file, filename: basename(c.path), label: c.label, via: c.via, source: c.path, gone: false }
	}
	if (!media && c.data) {
		let filename = c.path ? basename(c.path) : `${slug(c.label)}-${new Date(c.at).toISOString().replace(/[:.]/g, '-')}${extFromMime(c.data.type)}`
		// several images from one tool call
		const stem = filename.slice(0, filename.length - extname(filename).length)
		for (let n = 2; taken.some((u) => u.filename === filename); n++) filename = `${stem}-${n}${extname(filename)}`
		media = { at: c.at, data: c.data, filename, label: c.label, via: c.via, source: c.path, gone: !!c.path }
	}
	if (!media) return 'gone'
	return { ...media, hash: await digest(media.data) }
}

/** The media one message points at, in the order it output them. */
function messageCandidates(m: Message, directory: string, home: string | null, nextOrder: () => number): Candidate[] {
	const out: Candidate[] = []
	const add = (c: Omit<Candidate, 'order'>) => out.push({ ...c, order: nextOrder() })
	if (m.type === 'synthetic') {
		const md = m.metadata ?? {}
		const path = typeof md.path === 'string' ? md.path : undefined
		if (path && isMediaPath(path) && md.status !== 'error') {
			const source = typeof md.source === 'string' ? md.source.replace(/^opencode\./, '') : 'background task'
			add({ at: m.time.created, path: resolvePath(path, directory, home), label: basename(path), via: `${source} (finished)`, strong: true })
		}
		return out
	}
	if (m.type !== 'assistant' || !Array.isArray(m.content)) return out
	for (const part of m.content) {
		const t = part as {
			type: string
			name?: string
			time?: { created: number; ran?: number; completed?: number }
			state?: { status: string; input?: Record<string, unknown>; content?: unknown[]; metadata?: Record<string, unknown> }
		}
		if (t.type !== 'tool' || t.state?.status !== 'completed' || !t.name) continue
		const at = t.time?.completed ?? t.time?.ran ?? t.time?.created ?? m.time.created
		const via = toolLabel(t.name, t.state.metadata)
		const base = baseDir(t.state.input, directory, home)
		const content = t.state.content ?? []

		for (const item of content) {
			const f = item as ToolFile
			if (f.type !== 'file' || !/^(image|video)\//.test(f.mime)) continue
			const named = f.name && isMediaPath(f.name) ? resolvePath(f.name, base, home) : undefined
			const fromUri = f.uri.startsWith('file://') ? decodeURIComponent(new URL(f.uri).pathname) : undefined
			const data = f.uri.startsWith('data:') ? decodeDataUrl(f.uri) : null
			const path = named ?? fromUri
			const label = path ? basename(path) : f.name ? basename(f.name) : /browser|screenshot/i.test(via) ? 'Screenshot' : f.mime.startsWith('video/') ? 'Video' : 'Image'
			add({ at, path, data: data ?? undefined, label, via, strong: true })
		}

		// weak hints: media paths mentioned in the input or the text output
		const texts = [...stringsIn(t.state.input), ...content.filter((c) => (c as { type: string }).type === 'text').map((c) => (c as { text: string }).text)]
		for (const text of texts) {
			for (const match of text.matchAll(PATH_IN_TEXT)) {
				const ref = match[0]
				const before = text[(match.index ?? 0) - 1]
				if (before === ':' || before === '@' || before === '$' || /[{}<>*]/.test(ref) || ref.startsWith('//')) continue
				const path = resolvePath(ref, base, home)
				add({ at, path, label: basename(path), via, strong: false })
			}
		}
	}
	return out
}

/**
 * A file's bytes through OpenCode's file API, or null when it's missing, empty, too big or (for
 * weak hints) not modified within the window. Paths in the session's directory are read relative to
 * it; others relative to "/".
 */
async function readFile(p: Pairing, path: string, directory: string, opts: { strong: boolean; since: number }): Promise<Blob | null> {
	const inside = directory !== '/' && path.startsWith(directory.replace(/\/+$/, '') + '/')
	const location = inside ? directory : '/'
	const rel = inside ? path.slice(directory.replace(/\/+$/, '').length + 1) : path.replace(/^\/+/, '')
	const url = `${p.url}/api/fs/read/${rel.split('/').map(encodeURIComponent).join('/')}?${new URLSearchParams({ 'location[directory]': location })}`
	const headers = { authorization: authHeader(p) }
	const head = await fetch(url, { method: 'HEAD', headers, signal: AbortSignal.timeout(REQUEST_MS) })
	if (!head.ok) return null
	const size = Number(head.headers.get('content-length') ?? NaN)
	if (size === 0 || size > MAX_FILE_BYTES) return null
	const modified = Date.parse(head.headers.get('last-modified') ?? '')
	// Last-Modified has whole seconds
	if (!opts.strong && !(modified >= opts.since - 1000)) return null
	const res = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_MS * 4) })
	if (!res.ok) return null
	const blob = await res.blob()
	if (!blob.size || blob.size > MAX_FILE_BYTES) return null
	return blob.type && blob.type !== 'application/octet-stream' ? blob : new Blob([blob], { type: mimeFromExt(extname(path)) })
}

async function digest(blob: Blob): Promise<string> {
	const bytes = new Uint8Array(await blob.arrayBuffer())
	if (crypto.subtle) {
		const hash = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes))
		return [...hash].map((b) => b.toString(16).padStart(2, '0')).join('')
	}
	// insecure contexts have no crypto.subtle; FNV-1a is plenty to spot duplicates
	let h = 0x811c9dc5
	for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0
	return `${bytes.length}:${h.toString(16)}`
}

/** "read", "shell", or for code mode the tools it called: "execute → browser-control.execute" */
function toolLabel(name: string, metadata: Record<string, unknown> | undefined): string {
	const calls = Array.isArray(metadata?.toolCalls) ? (metadata.toolCalls as { tool?: unknown }[]) : []
	const inner = [...new Set(calls.map((c) => c.tool).filter((t): t is string => typeof t === 'string'))]
	return inner.length ? `${name} → ${inner.slice(0, 3).join(', ')}${inner.length > 3 ? '…' : ''}` : name
}

/** Where relative paths in a tool call point: its workdir, else a leading `cd <dir>`, else the session's directory. */
function baseDir(input: Record<string, unknown> | undefined, directory: string, home: string | null): string {
	if (typeof input?.workdir === 'string') return resolvePath(input.workdir, directory, home)
	if (typeof input?.command === 'string') {
		const cd = /^\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)/.exec(input.command)
		if (cd) return resolvePath(cd[1].replace(/^["']|["']$/g, ''), directory, home)
	}
	return directory
}

/** The home directory, guessed from the session's directory (OpenCode doesn't say). */
function homeOf(directory: string): string | null {
	return /^(\/root|\/home\/[^/]+|\/Users\/[^/]+)(?=\/|$)/.exec(directory)?.[1] ?? null
}

// ---------- POSIX paths ----------

function resolvePath(path: string, base: string, home: string | null): string {
	if ((path === '~' || path.startsWith('~/')) && home) return normalize(`${home}/${path.slice(2)}`)
	return normalize(path.startsWith('/') ? path : `${base}/${path}`)
}

function normalize(path: string): string {
	const out: string[] = []
	for (const part of path.split('/')) {
		if (!part || part === '.') continue
		if (part === '..') out.pop()
		else out.push(part)
	}
	return '/' + out.join('/')
}

function basename(path: string) {
	return path.replace(/\/+$/, '').split('/').pop() ?? ''
}

function extname(path: string) {
	const name = basename(path)
	const dot = name.lastIndexOf('.')
	return dot > 0 ? name.slice(dot) : ''
}

function isMediaPath(path: string) {
	return MEDIA_EXTS.has(extname(path).toLowerCase())
}

function stringsIn(value: unknown, out: string[] = []): string[] {
	if (typeof value === 'string') out.push(value)
	else if (Array.isArray(value)) for (const v of value) stringsIn(v, out)
	else if (value && typeof value === 'object') for (const v of Object.values(value)) stringsIn(v, out)
	return out
}

function decodeDataUrl(uri: string): Blob | null {
	const m = /^data:([^;,]+)(;base64)?,/.exec(uri)
	if (!m || !/^(image|video)\//.test(m[1])) return null
	const body = uri.slice(m[0].length)
	let bytes: Uint8Array
	try {
		bytes = m[2] ? Uint8Array.from(atob(body), (c) => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(body))
	} catch {
		return null
	}
	return bytes.length ? new Blob([bytes as BlobPart], { type: m[1] }) : null
}

function extFromMime(mime: string) {
	const sub = mime.split('/')[1]?.split(';')[0] ?? ''
	return sub === 'jpeg' ? '.jpg' : sub === 'quicktime' ? '.mov' : sub ? `.${sub}` : ''
}

function mimeFromExt(ext: string) {
	const e = ext.toLowerCase().slice(1)
	if (e === 'jpg' || e === 'jpeg') return 'image/jpeg'
	if (e === 'mov') return 'video/quicktime'
	if (e === 'mp4' || e === 'webm') return `video/${e}`
	return `image/${e}`
}

function slug(text: string) {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'media'
}
