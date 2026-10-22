/**
 * Finding what a session involved, in the browser: the images and videos it output, the HTML files
 * it wrote or produced, and the media you attached to your prompts, across the whole session,
 * newest first, up to a cap of each. Read-only on OpenCode: it only reads the session, its messages
 * and the files they point at. See populate.ts for putting them in the session's frame.
 *
 * Where media and HTML turn up in a session's messages (OpenCode v2 message.list):
 * - assistant tool parts whose completed state has file content ({type: "file", uri, mime, name?}):
 *   the read tool on an image returns it as a data: URL with name = the file's path; code mode
 *   (execute) returns screenshots and other images from the tools it called as data: URLs with no
 *   name. Files with an HTML mime type count as HTML.
 * - synthetic messages that report a finished background image request
 *   (metadata {source: "opencode.image_generate", status, path}).
 * - write/edit tool inputs whose path is an .html/.htm file (write's "content" stands in when the
 *   file is gone since), and inline HTML a tool was handed as "html" (canvas post_item and the like).
 * - paths ending in an image/video/HTML extension in a tool's input or text output (shell commands
 *   that write screenshots or renders, image_generate/image_edit's "path", files posted
 *   elsewhere...). These are only weak hints, so they count only when the file exists and was
 *   modified around or after the time it was mentioned.
 * - user messages' attached files ({data: base64, mime, source, name?}) with an image/video mime.
 *
 * Files are read through OpenCode's file API (GET /api/fs/read/<path>, which also answers HEAD with
 * Last-Modified and Content-Length); data: URLs decode right here. Each path is used once (where it
 * was last output, with its current file), and identical files (same bytes) are kept once.
 */
import { pairing, authHeader, withServer, type Pairing } from './pairings'

const MEDIA_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.webm', '.mov'])
const HTML_EXTS = new Set(['.html', '.htm'])
const PATH_IN_TEXT = /[\w~./+-]*\.(?:png|jpe?g|webp|gif|mp4|webm|mov|html?)(?![\w/])/gi
const MEDIA_MIME = /^(image|video)\//
const HTML_MIME = /^text\/html\b/
const PAGE_SIZE = 200
const MAX_PAGES = 50
/** weak hints count when the file was modified this long before they were mentioned, or after */
const HINT_SLACK_MS = 60 * 60 * 1000
const MAX_FILE_BYTES = 200 * 1024 * 1024
/** the canvas server's limit for HTML items */
const MAX_HTML_BYTES = 2 * 1024 * 1024
const REQUEST_MS = 30_000
/** at most this many of each, the latest ones */
export const FIND_LIMITS: Record<FileKind, number> = { media: 100, html: 30, attached: 30 }

/** what a session output (media), the HTML it wrote or produced, and media attached to its prompts */
export type FileKind = 'media' | 'html' | 'attached'

export interface FoundFile {
	kind: FileKind
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

/** What a session involved, read and ready to upload (see findSessionFiles); each list oldest first. */
export interface SessionFiles {
	title: string
	files: FoundFile[]
	/** files it certainly output that are gone */
	skipped: number
}

interface Candidate {
	kind: FileKind
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

interface Message {
	id: string
	type: string
	time: { created: number }
	metadata?: Record<string, unknown>
	content?: unknown[]
	files?: { data?: string; mime?: string; name?: string; source?: { type: string; uri?: string } }[]
}

type Usable = FoundFile & { hash: string }

/**
 * Everything the session involved, newest first until FIND_LIMITS of each kind are found or the
 * session runs out (messages are fetched a page at a time, only as far as needed).
 */
export async function findSessionFiles(serverKey: string, sessionId: string): Promise<SessionFiles> {
	const session = await withServer(serverKey, (c) => c.session.get({ sessionID: sessionId }, { signal: AbortSignal.timeout(REQUEST_MS) }))
	const p = pairing(serverKey)!
	const directory = session.location.directory
	const home = homeOf(directory)

	let cursor: string | null | undefined
	let pages = 0
	let exhausted = false
	const nextPage = async (): Promise<Message[]> => {
		const res = await withServer(serverKey, (c) =>
			c.message.list(cursor ? { sessionID: sessionId, cursor, limit: PAGE_SIZE } : { sessionID: sessionId, order: 'desc', limit: PAGE_SIZE }, {
				signal: AbortSignal.timeout(REQUEST_MS),
			}),
		)
		cursor = res.cursor.next
		if (!cursor || !res.data.length || ++pages >= MAX_PAGES) exhausted = true
		return res.data as unknown as Message[]
	}

	let order = 0
	const found: Usable[] = []
	const count = (kind: FileKind) => found.filter((f) => f.kind === kind).length
	const full = (kind: FileKind) => count(kind) >= FIND_LIMITS[kind]
	const triedPaths = new Set<string>()
	const gonePaths = new Set<string>()
	/** strong candidates that are gone: by path, or counted when they have none */
	const goneStrong = new Set<string>()
	let skipped = 0
	const queue: Candidate[] = []
	while (!(['media', 'html', 'attached'] as const).every(full)) {
		const c = queue.shift()
		if (!c) {
			if (exhausted) break
			const page = await nextPage()
			// newest first; within one instant, last output first
			const next = page.reverse().flatMap((m) => messageCandidates(m, directory, home, () => order++))
			queue.push(...next.sort((a, b) => b.at - a.at || b.order - a.order))
			continue
		}
		if (full(c.kind)) continue
		if (c.path && triedPaths.has(c.path) && !(gonePaths.has(c.path) && c.data)) continue
		const file = await resolveCandidate(p, c, directory, found)
		if (c.path) triedPaths.add(c.path)
		if (file === 'gone') {
			if (c.path) gonePaths.add(c.path)
			if (c.strong) {
				if (c.path) goneStrong.add(c.path)
				else skipped++
			}
			continue
		}
		if (c.path) {
			gonePaths.delete(c.path)
			goneStrong.delete(c.path)
		}
		if (file && !found.some((u) => u.hash === file.hash)) found.push(file)
	}
	skipped += goneStrong.size

	return {
		title: session.title?.trim() || sessionId,
		files: found.sort((a, b) => a.at - b.at).map(({ hash: _, ...f }) => f),
		skipped,
	}
}

/**
 * The file a candidate points at: its current file, else the copy in the session; 'gone' when
 * neither is there, null when it's to be left out (node_modules, weak hints to old files, HTML
 * over the server's limit). Copies from the session get a file name not yet taken in `taken`.
 */
async function resolveCandidate(p: Pairing, c: Candidate, directory: string, taken: FoundFile[]): Promise<Usable | 'gone' | null> {
	if (c.path && c.path.split('/').some((part) => part === 'node_modules' || part === '.git')) return null
	const max = c.kind === 'html' ? MAX_HTML_BYTES : MAX_FILE_BYTES
	let file: FoundFile | null = null
	if (c.path) {
		const read = await readFile(p, c.path, directory, { strong: c.strong, since: c.at - HINT_SLACK_MS, max }).catch(() => null)
		if (read === 'skip') return null
		if (read) file = { kind: c.kind, at: c.at, data: read, filename: basename(c.path), label: c.label, via: c.via, source: c.path, gone: false }
	}
	if (!file && c.data && c.data.size <= max) {
		let filename = c.path
			? basename(c.path)
			: `${slug(c.label)}-${new Date(c.at).toISOString().replace(/[:.]/g, '-')}${c.kind === 'html' ? '.html' : extFromMime(c.data.type)}`
		// several files from one tool call or prompt
		const stem = filename.slice(0, filename.length - extname(filename).length)
		for (let n = 2; taken.some((u) => u.filename === filename); n++) filename = `${stem}-${n}${extname(filename)}`
		file = { kind: c.kind, at: c.at, data: c.data, filename, label: c.label, via: c.via, source: c.path, gone: !!c.path }
	}
	if (!file) return 'gone'
	return { ...file, hash: await digest(file.data) }
}

/** What one message points at, in the order it output them. */
function messageCandidates(m: Message, directory: string, home: string | null, nextOrder: () => number): Candidate[] {
	const out: Candidate[] = []
	const add = (c: Omit<Candidate, 'order'>) => out.push({ ...c, order: nextOrder() })
	if (m.type === 'synthetic') {
		const md = m.metadata ?? {}
		const path = typeof md.path === 'string' ? md.path : undefined
		if (path && kindOfPath(path) && md.status !== 'error') {
			const source = typeof md.source === 'string' ? md.source.replace(/^opencode\./, '') : 'background task'
			add({ kind: kindOfPath(path)!, at: m.time.created, path: resolvePath(path, directory, home), label: basename(path), via: `${source} (finished)`, strong: true })
		}
		return out
	}
	if (m.type === 'user') {
		for (const f of m.files ?? []) {
			const mime = f.mime ?? ''
			if (!MEDIA_MIME.test(mime)) continue
			const uri = f.source?.type === 'uri' ? f.source.uri : undefined
			const data = f.data ? decodeBase64(f.data, mime) : uri?.startsWith('data:') ? decodeDataUrl(uri, MEDIA_MIME) : null
			const path = uri?.startsWith('file://') ? decodeURIComponent(new URL(uri).pathname) : undefined
			if (!data && !path) continue
			const label = f.name ? basename(f.name) : path ? basename(path) : mime.startsWith('video/') ? 'Video' : 'Image'
			add({ kind: 'attached', at: m.time.created, path, data: data ?? undefined, label, via: 'your prompt', strong: true })
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
		const input = t.state.input ?? {}
		const base = baseDir(input, directory, home)
		const content = t.state.content ?? []

		for (const item of content) {
			const f = item as ToolFile
			if (f.type !== 'file') continue
			const kind: FileKind | null = MEDIA_MIME.test(f.mime) ? 'media' : HTML_MIME.test(f.mime) ? 'html' : null
			if (!kind) continue
			const named = f.name && kindOfPath(f.name) ? resolvePath(f.name, base, home) : undefined
			const fromUri = f.uri.startsWith('file://') ? decodeURIComponent(new URL(f.uri).pathname) : undefined
			const data = f.uri.startsWith('data:') ? decodeDataUrl(f.uri, kind === 'html' ? HTML_MIME : MEDIA_MIME) : null
			const path = named ?? fromUri
			const label = path
				? basename(path)
				: f.name
					? basename(f.name)
					: kind === 'html'
						? 'HTML'
						: /browser|screenshot/i.test(via)
							? 'Screenshot'
							: f.mime.startsWith('video/')
								? 'Video'
								: 'Image'
			add({ kind, at, path, data: data ?? undefined, label, via, strong: true })
		}

		// HTML files it wrote or edited (write's content stands in if the file is gone since)
		const written = [input.path, input.filePath, input.file_path].find((v): v is string => typeof v === 'string')
		if (written && /^(write|edit)$/i.test(t.name) && kindOfPath(written) === 'html') {
			const path = resolvePath(written, base, home)
			const data = typeof input.content === 'string' && input.content.trim() ? new Blob([input.content], { type: 'text/html' }) : undefined
			add({ kind: 'html', at, path, data, label: basename(path), via, strong: true })
		}
		// inline HTML it was handed (canvas post_item and the like)
		if (typeof input.html === 'string' && /<[a-z!]/i.test(input.html)) {
			const label = typeof input.title === 'string' && input.title.trim() ? input.title.trim().slice(0, 80) : 'HTML'
			add({ kind: 'html', at, data: new Blob([input.html], { type: 'text/html' }), label, via, strong: true })
		}

		// weak hints: paths mentioned in the input or the text output
		const texts = [...stringsIn(input), ...content.filter((c) => (c as { type: string }).type === 'text').map((c) => (c as { text: string }).text)]
		for (const text of texts) {
			for (const match of text.matchAll(PATH_IN_TEXT)) {
				const ref = match[0]
				const before = text[(match.index ?? 0) - 1]
				if (before === ':' || before === '@' || before === '$' || /[{}<>*]/.test(ref) || ref.startsWith('//')) continue
				const path = resolvePath(ref, base, home)
				add({ kind: kindOfPath(path)!, at, path, label: basename(path), via, strong: false })
			}
		}
	}
	return out
}

/**
 * A file's bytes through OpenCode's file API: null when it's missing or empty, 'skip' when it's
 * over `max` or (for weak hints) not modified since `since`. Paths in the session's directory are
 * read relative to it; others relative to "/".
 */
async function readFile(p: Pairing, path: string, directory: string, opts: { strong: boolean; since: number; max: number }): Promise<Blob | 'skip' | null> {
	const inside = directory !== '/' && path.startsWith(directory.replace(/\/+$/, '') + '/')
	const location = inside ? directory : '/'
	const rel = inside ? path.slice(directory.replace(/\/+$/, '').length + 1) : path.replace(/^\/+/, '')
	const url = `${p.url}/api/fs/read/${rel.split('/').map(encodeURIComponent).join('/')}?${new URLSearchParams({ 'location[directory]': location })}`
	const headers = { authorization: authHeader(p) }
	const head = await fetch(url, { method: 'HEAD', headers, signal: AbortSignal.timeout(REQUEST_MS) })
	if (!head.ok) return null
	const size = Number(head.headers.get('content-length') ?? NaN)
	if (size === 0) return null
	if (size > opts.max) return 'skip'
	const modified = Date.parse(head.headers.get('last-modified') ?? '')
	// Last-Modified has whole seconds
	if (!opts.strong && !(modified >= opts.since - 1000)) return 'skip'
	const res = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_MS * 4) })
	if (!res.ok) return null
	const blob = await res.blob()
	if (!blob.size) return null
	if (blob.size > opts.max) return 'skip'
	const ext = extname(path).toLowerCase()
	if (HTML_EXTS.has(ext)) return new Blob([blob], { type: 'text/html' })
	return blob.type && blob.type !== 'application/octet-stream' ? blob : new Blob([blob], { type: mimeFromExt(ext) })
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

function kindOfPath(path: string): 'media' | 'html' | null {
	const ext = extname(path).toLowerCase()
	return MEDIA_EXTS.has(ext) ? 'media' : HTML_EXTS.has(ext) ? 'html' : null
}

function stringsIn(value: unknown, out: string[] = []): string[] {
	if (typeof value === 'string') out.push(value)
	else if (Array.isArray(value)) for (const v of value) stringsIn(v, out)
	else if (value && typeof value === 'object') for (const v of Object.values(value)) stringsIn(v, out)
	return out
}

function decodeDataUrl(uri: string, allowed: RegExp): Blob | null {
	const m = /^data:([^;,]+)((?:;[^;,]*)*?)(;base64)?,/.exec(uri)
	if (!m || !allowed.test(m[1])) return null
	const body = uri.slice(m[0].length)
	let bytes: Uint8Array
	try {
		bytes = m[3] ? Uint8Array.from(atob(body), (c) => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(body))
	} catch {
		return null
	}
	return bytes.length ? new Blob([bytes as BlobPart], { type: m[1] }) : null
}

function decodeBase64(data: string, mime: string): Blob | null {
	try {
		const bytes = Uint8Array.from(atob(data.replace(/^data:[^,]*,/, '')), (c) => c.charCodeAt(0))
		return bytes.length ? new Blob([bytes as BlobPart], { type: mime }) : null
	} catch {
		return null
	}
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
	return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'file'
}
