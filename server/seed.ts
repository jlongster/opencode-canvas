/**
 * Seeding a canvas from OpenCode sessions: finds the images and videos a session output recently,
 * in the order it output them. Read-only: it only lists the session and its messages.
 *
 * Where media turns up in a session's messages (OpenCode v2 message.list):
 * - assistant tool parts whose completed state has file content ({type: "file", uri, mime, name?}):
 *   the read tool on an image returns it as a data: URL with name = the file's path; code mode
 *   (execute) returns screenshots and other images from the tools it called as data: URLs with no name.
 * - synthetic messages that report a finished background image request
 *   (metadata {source: "opencode.image_generate", status, path}).
 * - paths ending in an image/video extension in a tool's input or text output (shell commands that
 *   write screenshots or renders, image_generate/image_edit's "path", files posted elsewhere...). These are
 *   only weak hints, so they count only when the file exists and was modified within the window.
 * Media the user attached to their own prompts isn't included: the session didn't produce it.
 */
import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, isAbsolute, resolve, sep } from 'node:path'
import { withOpenCode } from './opencode'

const MEDIA_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.webm', '.mov'])
const PATH_IN_TEXT = /[\w~./+-]*\.(?:png|jpe?g|webp|gif|mp4|webm|mov)(?![\w/])/gi
const PAGE_SIZE = 200
const MAX_PAGES = 50
/** a tool can finish well after its message started: keep paging this far past the window */
const PAGE_SLACK_MS = 60 * 60 * 1000
const MAX_FILE_BYTES = 200 * 1024 * 1024
const REQUEST_MS = 30_000

export interface SeedMedia {
	/** when it was output (ms) */
	at: number
	/** a file on disk, or the decoded bytes of a data: URL when there's no file */
	path?: string
	data?: { bytes: Uint8Array; mime: string }
	/** file name for the item: the file's basename, or one made up for data: URLs */
	filename: string
	/** short label for the item's title */
	label: string
	/** which tool or message it came from */
	via: string
	/** the path it was output at, also when the file is gone and the data comes from the session */
	source?: string
}

export interface SessionMedia {
	title: string
	media: SeedMedia[]
	/** media that was output but can't be added: its file is gone (and there's no copy), or over the cap */
	skipped: number
}

interface Candidate {
	at: number
	order: number
	path?: string
	data?: { bytes: Uint8Array; mime: string }
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
 * The image/video media `sessionId` output since `since`, oldest first, de-duplicated, at most `limit`
 * (the latest ones). Paths under `excludeDirs` are ignored.
 */
export async function findSessionMedia(sessionId: string, opts: { since: number; limit: number; excludeDirs: string[] }): Promise<SessionMedia> {
	const { session, messages } = await withOpenCode(async (c) => {
		const signal = AbortSignal.timeout(REQUEST_MS)
		const session = await c.session.get({ sessionID: sessionId }, { signal })
		const messages: unknown[] = []
		let cursor: string | null | undefined
		for (let page = 0; page < MAX_PAGES; page++) {
			const res = await c.message.list(
				cursor ? { sessionID: sessionId, cursor, limit: PAGE_SIZE } : { sessionID: sessionId, order: 'desc', limit: PAGE_SIZE },
				{ signal },
			)
			messages.push(...res.data)
			cursor = res.cursor.next
			const oldest = res.data.at(-1) as { time?: { created?: number } } | undefined
			if (!cursor || !res.data.length || (oldest?.time?.created ?? 0) < opts.since - PAGE_SLACK_MS) break
		}
		return { session, messages: messages.reverse() }
	})

	const directory = session.location.directory
	const candidates: Candidate[] = []
	let order = 0
	const add = (c: Omit<Candidate, 'order'>) => {
		if (c.at >= opts.since) candidates.push({ ...c, order: order++ })
	}

	for (const raw of messages) {
		const m = raw as { id: string; type: string; time: { created: number }; metadata?: Record<string, unknown>; content?: unknown[] }
		if (m.type === 'synthetic') {
			const md = m.metadata ?? {}
			const path = typeof md.path === 'string' ? md.path : undefined
			if (path && isMediaPath(path) && md.status !== 'error') {
				const source = typeof md.source === 'string' ? md.source.replace(/^opencode\./, '') : 'background task'
				add({ at: m.time.created, path: resolvePath(path, directory), label: basename(path), via: `${source} (finished)`, strong: true })
			}
			continue
		}
		if (m.type !== 'assistant' || !Array.isArray(m.content)) continue
		for (const part of m.content) {
			const p = part as {
				type: string
				name?: string
				time?: { created: number; ran?: number; completed?: number }
				state?: { status: string; input?: Record<string, unknown>; content?: unknown[]; metadata?: Record<string, unknown> }
			}
			if (p.type !== 'tool' || p.state?.status !== 'completed' || !p.name) continue
			const at = p.time?.completed ?? p.time?.ran ?? p.time?.created ?? m.time.created
			const via = toolLabel(p.name, p.state.metadata)
			const base = baseDir(p.state.input, directory)
			const content = p.state.content ?? []

			for (const item of content) {
				const f = item as ToolFile
				if (f.type !== 'file' || !/^(image|video)\//.test(f.mime)) continue
				const named = f.name && isMediaPath(f.name) ? resolvePath(f.name, base) : undefined
				const fromUri = f.uri.startsWith('file://') ? decodeURIComponent(new URL(f.uri).pathname) : undefined
				const data = f.uri.startsWith('data:') ? decodeDataUrl(f.uri) : undefined
				const path = named ?? fromUri
				const label = path ? basename(path) : f.name ? basename(f.name) : /browser|screenshot/i.test(via) ? 'Screenshot' : f.mime.startsWith('video/') ? 'Video' : 'Image'
				add({ at, path, data: data ?? undefined, label, via, strong: true })
			}

			// weak hints: media paths mentioned in the input or the text output
			const texts = [...stringsIn(p.state.input), ...content.filter((c) => (c as { type: string }).type === 'text').map((c) => (c as { text: string }).text)]
			for (const text of texts) {
				for (const match of text.matchAll(PATH_IN_TEXT)) {
					const ref = match[0]
					const before = text[(match.index ?? 0) - 1]
					if (before === ':' || before === '@' || before === '$' || /[{}<>*]/.test(ref) || ref.startsWith('//')) continue
					const path = resolvePath(ref, base)
					add({ at, path, label: basename(path), via, strong: false })
				}
			}
		}
	}

	// One per path: at the place it was first output, with its current file (or the latest copy in the session).
	const byPath = new Map<string, Candidate>()
	const unique: Candidate[] = []
	for (const c of candidates) {
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

	const excluded = opts.excludeDirs.map((d) => resolve(d) + sep)
	const usable: (SeedMedia & { hash: string })[] = []
	let skipped = 0
	for (const c of unique) {
		if (c.path && excluded.some((d) => c.path!.startsWith(d))) continue
		if (c.path && c.path.split(sep).includes('node_modules')) continue
		let media: SeedMedia | null = null
		let hash: string | null = null
		if (c.path) {
			const info = await stat(c.path).catch(() => null)
			const fresh = info?.isFile() && info.size > 0 && info.size <= MAX_FILE_BYTES && (c.strong || info.mtimeMs >= opts.since)
			if (fresh) {
				hash = createHash('sha1').update(new Uint8Array(await Bun.file(c.path).arrayBuffer())).digest('hex')
				media = { at: c.at, path: c.path, filename: basename(c.path), label: c.label, via: c.via, source: c.path }
			}
		}
		if (!media && c.data) {
			hash = createHash('sha1').update(c.data.bytes).digest('hex')
			let filename = c.path ? basename(c.path) : `${slug(c.label)}-${new Date(c.at).toISOString().replace(/[:.]/g, '-')}${extFromMime(c.data.mime)}`
			// several images from one tool call
			const stem = filename.slice(0, filename.length - extname(filename).length)
			for (let n = 2; usable.some((u) => u.filename === filename); n++) filename = `${stem}-${n}${extname(filename)}`
			media = { at: c.at, data: c.data, filename, label: c.label, via: c.via, source: c.path }
		}
		if (!media || !hash) {
			if (c.strong) skipped++
			continue
		}
		if (usable.some((u) => u.hash === hash)) continue
		usable.push({ ...media, hash })
	}

	usable.sort((a, b) => a.at - b.at)
	const kept = usable.slice(-opts.limit)
	skipped += usable.length - kept.length
	return {
		title: session.title?.trim() || sessionId,
		media: kept.map(({ hash: _, ...m }) => m),
		skipped,
	}
}

/** "read", "shell", or for code mode the tools it called: "execute → browser-control.execute" */
function toolLabel(name: string, metadata: Record<string, unknown> | undefined): string {
	const calls = Array.isArray(metadata?.toolCalls) ? (metadata.toolCalls as { tool?: unknown }[]) : []
	const inner = [...new Set(calls.map((c) => c.tool).filter((t): t is string => typeof t === 'string'))]
	return inner.length ? `${name} → ${inner.slice(0, 3).join(', ')}${inner.length > 3 ? '…' : ''}` : name
}

/** Where relative paths in a tool call point: its workdir, else a leading `cd <dir>`, else the session's directory. */
function baseDir(input: Record<string, unknown> | undefined, directory: string): string {
	if (typeof input?.workdir === 'string') return resolvePath(input.workdir, directory)
	if (typeof input?.command === 'string') {
		const cd = /^\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)/.exec(input.command)
		if (cd) return resolvePath(cd[1].replace(/^["']|["']$/g, ''), directory)
	}
	return directory
}

function resolvePath(path: string, base: string): string {
	if (path === '~' || path.startsWith('~/')) return resolve(homedir(), path.slice(2))
	return isAbsolute(path) ? resolve(path) : resolve(base, path)
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

function decodeDataUrl(uri: string): { bytes: Uint8Array; mime: string } | null {
	const m = /^data:([^;,]+)(;base64)?,/.exec(uri)
	if (!m || !/^(image|video)\//.test(m[1])) return null
	const body = uri.slice(m[0].length)
	const bytes = m[2] ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body))
	return bytes.length ? { bytes: new Uint8Array(bytes), mime: m[1] } : null
}

function extFromMime(mime: string) {
	const sub = mime.split('/')[1]?.split(';')[0] ?? ''
	return sub === 'jpeg' ? '.jpg' : sub === 'quicktime' ? '.mov' : sub ? `.${sub}` : ''
}

function slug(text: string) {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'media'
}
