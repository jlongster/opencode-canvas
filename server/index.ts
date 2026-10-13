import { copyFile, link, mkdir, rename, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import type { Item, MediaKind, ServerEvent, Session, Share, Snapshot } from '../shared/types'
import { roomSockets, setRoomPersistence, type RoomSocketData } from './rooms'

const PORT = Number(process.env.PORT ?? 4410)
const DATA_DIR = resolve(process.env.CANVAS_DATA ?? join(import.meta.dir, '../data'))
const MEDIA_DIR = join(DATA_DIR, 'media')
const INDEX_FILE = join(DATA_DIR, 'index.json')
const SHARES_DIR = join(DATA_DIR, 'shares')
const WEB_DIST = resolve(import.meta.dir, '../web/dist')
const THUMB_SIZE = 512
const BASE_PATH = '/canvas'
/** Where share links point: the public, port-less address that proxies to this server */
const PUBLIC_URL = (process.env.CANVAS_PUBLIC_URL ?? 'https://jamesbox.exe.xyz/canvas').replace(/\/$/, '')

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp'])
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.m4v', '.mkv'])

await mkdir(MEDIA_DIR, { recursive: true })
await mkdir(SHARES_DIR, { recursive: true })
// Each share's room document (sticky notes etc.) is saved next to the share.
setRoomPersistence((room) => {
	const id = /^share-([A-Za-z0-9]{10})$/.exec(room)?.[1]
	return id ? join(SHARES_DIR, `${id}.ydoc`) : null
})

// ---------- persistence ----------

const db: { sessions: Map<string, Session>; items: Map<string, Item> } = {
	sessions: new Map(),
	items: new Map(),
}

if (existsSync(INDEX_FILE)) {
	const snap = (await Bun.file(INDEX_FILE).json()) as Snapshot
	for (const s of snap.sessions) db.sessions.set(s.id, s)
	for (const i of snap.items) db.items.set(i.id, i)
}

// Saves run one at a time; changes made during a save are picked up by one more pass.
let dirty = false
let saving: Promise<void> | null = null

function save() {
	dirty = true
	saving ??= flush()
}

async function flush() {
	try {
		while (dirty) {
			dirty = false
			const tmp = INDEX_FILE + '.tmp'
			await Bun.write(tmp, JSON.stringify(snapshot()))
			await rename(tmp, INDEX_FILE)
		}
	} catch (e) {
		console.error('failed to save index:', e)
	} finally {
		saving = null
	}
}

function snapshot(): Snapshot {
	return { sessions: [...db.sessions.values()], items: [...db.items.values()] }
}

// ---------- live events (SSE) ----------

const clients = new Set<ReadableStreamDefaultController<Uint8Array>>()
const encoder = new TextEncoder()

function broadcast(event: ServerEvent) {
	const chunk = encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
	for (const c of clients) {
		try {
			c.enqueue(chunk)
		} catch {
			clients.delete(c)
		}
	}
}

setInterval(() => {
	const ping = encoder.encode(`: ping\n\n`)
	for (const c of clients) {
		try {
			c.enqueue(ping)
		} catch {
			clients.delete(c)
		}
	}
}, 15000)

function events(req: Request) {
	let ctrl: ReadableStreamDefaultController<Uint8Array>
	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			ctrl = c
			clients.add(c)
			c.enqueue(encoder.encode(`retry: 1000\n\n`))
		},
		cancel() {
			clients.delete(ctrl)
		},
	})
	req.signal.addEventListener('abort', () => clients.delete(ctrl))
	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache',
			connection: 'keep-alive',
		},
	})
}

// ---------- media processing ----------

async function run(cmd: string[]) {
	const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	])
	if (code !== 0) throw new Error(`${cmd[0]} failed: ${err.trim().split('\n').pop()}`)
	return out
}

async function probe(file: string): Promise<{ width: number; height: number }> {
	const out = await run([
		'ffprobe', '-v', 'error', '-select_streams', 'v:0',
		'-show_entries', 'stream=width,height:stream_side_data=rotation',
		'-of', 'json', file,
	])
	const stream = JSON.parse(out).streams?.[0]
	if (!stream?.width) throw new Error('could not read media dimensions')
	const rotation = Math.abs(Number(stream.side_data_list?.[0]?.rotation ?? 0))
	return rotation === 90 || rotation === 270
		? { width: stream.height, height: stream.width }
		: { width: stream.width, height: stream.height }
}

async function makeThumb(input: string, output: string) {
	await run([
		'ffmpeg', '-y', '-v', 'error', '-i', input, '-frames:v', '1',
		'-vf', `scale='min(${THUMB_SIZE},iw)':'min(${THUMB_SIZE},ih)':force_original_aspect_ratio=decrease`,
		'-quality', '85', output,
	])
}

function kindOf(ext: string, mime?: string): MediaKind | null {
	if (VIDEO_EXTS.has(ext) || mime?.startsWith('video/')) return 'video'
	if (IMAGE_EXTS.has(ext) || mime?.startsWith('image/')) return 'image'
	return null
}

function extFromMime(mime: string) {
	const sub = mime.split('/')[1]?.split(';')[0] ?? ''
	return sub === 'jpeg' ? '.jpg' : sub === 'quicktime' ? '.mov' : sub ? `.${sub}` : ''
}

// Sessions are keyed by the real OpenCode session id, so one session can only ever be one column.
const SESSION_ID = /^ses_[A-Za-z0-9]{8,}$/

function assertSessionId(id: string | undefined): string {
	if (!id || !SESSION_ID.test(id)) {
		throw new HttpError(400, `session id must be the OpenCode session id ($OPENCODE_SESSION_ID, like "ses_…"), got ${JSON.stringify(id ?? null)}`)
	}
	return id
}

function textField(value: unknown): string | undefined {
	const text = typeof value === 'string' ? value.trim() : undefined
	return text || undefined
}

function newId() {
	return crypto.randomUUID().replaceAll('-', '').slice(0, 16)
}

async function addItem(
	sessionId: string,
	data: Blob,
	opts: { filename?: string; title?: string; caption?: string; id?: string },
): Promise<Item> {
	const ext = (extname(opts.filename ?? '').toLowerCase() || extFromMime(data.type)).toLowerCase()
	const kind = kindOf(ext, data.type)
	if (!kind) throw new HttpError(415, `unsupported media type (${ext || data.type || 'unknown'})`)

	const id = opts.id ?? newId()
	const file = `${id}${ext}`
	const thumbFile = `${id}.thumb.webp`
	const path = join(MEDIA_DIR, file)
	await Bun.write(path, data)

	try {
		const { width, height } = await probe(path)
		await makeThumb(path, join(MEDIA_DIR, thumbFile))
		ensureSession(sessionId)
		const item: Item = {
			id,
			sessionId,
			kind,
			src: `/media/${file}`,
			thumb: `/media/${thumbFile}`,
			width,
			height,
			title: opts.title,
			caption: opts.caption,
			createdAt: Date.now(),
		}
		db.items.set(id, item)
		save()
		broadcast({ type: 'item', item })
		return item
	} catch (e) {
		await rm(path, { force: true })
		throw e instanceof HttpError ? e : new HttpError(422, (e as Error).message)
	}
}

function ensureSession(id: string, title?: string): Session {
	const existing = db.sessions.get(id)
	if (existing && (title === undefined || existing.title === title)) return existing
	const session: Session = existing
		? { ...existing, title: title! }
		: { id, title: title ?? id, createdAt: Date.now() }
	db.sessions.set(id, session)
	save()
	broadcast({ type: 'session', session })
	return session
}

async function deleteItem(id: string) {
	const item = db.items.get(id)
	if (!item) return false
	db.items.delete(id)
	await rm(join(MEDIA_DIR, item.src.replace('/media/', '')), { force: true })
	await rm(join(MEDIA_DIR, item.thumb.replace('/media/', '')), { force: true })
	save()
	broadcast({ type: 'item_deleted', id })
	return true
}

// ---------- shares ----------

const SHARE_ID = /^[A-Za-z0-9]{10}$/

function newShareId() {
	const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
	const bytes = crypto.getRandomValues(new Uint8Array(10))
	return [...bytes].map((b) => alphabet[b % alphabet.length]).join('')
}

/**
 * Freezes the given sessions (default: all) into a share. Media files are hard-linked into the
 * share's own folder, so the share keeps working after the originals are deleted, without
 * using extra disk space.
 */
async function createShare(body: { sessionIds?: string[]; view?: Share['view'] }): Promise<Share> {
	const wanted = body.sessionIds ? new Set(body.sessionIds) : null
	const sessions = [...db.sessions.values()].filter((s) => !wanted || wanted.has(s.id))
	if (!sessions.length) throw new HttpError(400, 'nothing to share')
	const sessionIds = new Set(sessions.map((s) => s.id))

	const id = newShareId()
	const dir = join(SHARES_DIR, id)
	await mkdir(dir, { recursive: true })
	const keep = async (url: string) => {
		const file = url.replace('/media/', '')
		const dest = join(dir, file)
		await link(join(MEDIA_DIR, file), dest).catch(() => copyFile(join(MEDIA_DIR, file), dest))
		return `/shares/${id}/${file}`
	}

	const items: Item[] = []
	for (const item of db.items.values()) {
		if (!sessionIds.has(item.sessionId)) continue
		items.push({ ...item, src: await keep(item.src), thumb: await keep(item.thumb) })
	}
	const share: Share = { id, createdAt: Date.now(), view: body.view, sessions, items }
	await Bun.write(join(SHARES_DIR, `${id}.json`), JSON.stringify(share))
	return share
}

// ---------- http ----------

class HttpError extends Error {
	constructor(public status: number, message: string) {
		super(message)
	}
}

/**
 * The website proxies https://jamesbox.exe.xyz/canvas/* here unchanged, and the web build
 * references /canvas/assets/*, so every route also answers with a /canvas prefix.
 */
function stripBase(pathname: string) {
	return pathname === BASE_PATH ? '/' : pathname.startsWith(BASE_PATH + '/') ? pathname.slice(BASE_PATH.length) : pathname
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function serveFile(req: Request, path: string, cache: string) {
	const file = Bun.file(path)
	const size = file.size
	const range = req.headers.get('range')
	const headers: Record<string, string> = {
		'accept-ranges': 'bytes',
		'cache-control': cache,
		'content-type': file.type,
	}
	if (range) {
		const m = /bytes=(\d*)-(\d*)/.exec(range)
		if (m) {
			let start = m[1] ? Number(m[1]) : NaN
			let end = m[2] ? Number(m[2]) : size - 1
			if (isNaN(start)) {
				start = size - end
				end = size - 1
			}
			end = Math.min(end, size - 1)
			if (start > end || start >= size) {
				return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } })
			}
			return new Response(file.slice(start, end + 1), {
				status: 206,
				headers: { ...headers, 'content-range': `bytes ${start}-${end}/${size}` },
			})
		}
	}
	return new Response(file, { headers })
}

async function handle(req: Request): Promise<Response> {
	const url = new URL(req.url)
	const p = stripBase(url.pathname)
	const method = req.method

	if (p === '/api/state' && method === 'GET') return json(snapshot())
	// The exe.dev proxy adds this header for visitors who are logged in to exe.dev.
	if (p === '/api/me' && method === 'GET') return json({ email: req.headers.get('x-exedev-email') || null })
	if (p === '/api/events' && method === 'GET') return events(req)

	if (p === '/api/sessions' && method === 'POST') {
		const body = (await req.json().catch(() => ({}))) as { id?: string; title?: string }
		return json(ensureSession(assertSessionId(body.id), body.title), 201)
	}

	let m = /^\/api\/sessions\/([^/]+)$/.exec(p)
	if (m && method === 'DELETE') {
		const id = decodeURIComponent(m[1])
		if (!db.sessions.has(id)) throw new HttpError(404, 'session not found')
		for (const item of [...db.items.values()]) if (item.sessionId === id) await deleteItem(item.id)
		db.sessions.delete(id)
		save()
		broadcast({ type: 'session_deleted', id })
		return json({ ok: true })
	}

	m = /^\/api\/sessions\/([^/]+)\/items$/.exec(p)
	if (m && method === 'POST') {
		const sessionId = assertSessionId(decodeURIComponent(m[1]))
		const type = req.headers.get('content-type') ?? ''
		if (type.includes('multipart/form-data')) {
			const form = await req.formData()
			const file = form.get('file')
			if (!(file instanceof Blob)) throw new HttpError(400, 'missing "file" field')
			const meta = { title: textField(form.get('title')), caption: textField(form.get('caption')) }
			const filename = file instanceof File ? file.name : undefined
			return json(await addItem(sessionId, file, { filename, ...meta }), 201)
		}
		const body = (await req.json().catch(() => null)) as
			| { path?: string; url?: string; title?: string; caption?: string }
			| null
		const meta = { title: textField(body?.title), caption: textField(body?.caption) }
		if (body?.path) {
			const f = Bun.file(body.path)
			if (!(await f.exists())) throw new HttpError(404, `no file at ${body.path}`)
			return json(await addItem(sessionId, f, { filename: body.path, ...meta }), 201)
		}
		if (body?.url) {
			const res = await fetch(body.url)
			if (!res.ok) throw new HttpError(502, `fetch ${body.url} failed: ${res.status}`)
			const blob = await res.blob()
			return json(await addItem(sessionId, blob, { filename: new URL(body.url).pathname, ...meta }), 201)
		}
		throw new HttpError(400, 'send multipart "file", or JSON {"path"} or {"url"}')
	}

	m = /^\/api\/items\/([^/]+)$/.exec(p)
	if (m && method === 'DELETE') {
		if (!(await deleteItem(decodeURIComponent(m[1])))) throw new HttpError(404, 'item not found')
		return json({ ok: true })
	}

	if (p === '/api/shares' && method === 'POST') {
		const body = (await req.json().catch(() => ({}))) as { sessionIds?: string[]; view?: Share['view'] }
		const share = await createShare(body)
		return json({ id: share.id, url: `${PUBLIC_URL}/s/${share.id}` }, 201)
	}

	m = /^\/api\/shares\/([^/]+)$/.exec(p)
	if (m && SHARE_ID.test(m[1])) {
		const file = join(SHARES_DIR, `${m[1]}.json`)
		if (!existsSync(file)) throw new HttpError(404, 'share not found')
		if (method === 'GET') return serveFile(req, file, 'public, max-age=31536000, immutable')
		if (method === 'DELETE') {
			await rm(file, { force: true })
			await rm(join(SHARES_DIR, `${m[1]}.ydoc`), { force: true })
			await rm(join(SHARES_DIR, m[1]), { recursive: true, force: true })
			return json({ ok: true })
		}
	}

	m = /^\/shares\/([A-Za-z0-9]{10})\/([\w.-]+)$/.exec(p)
	if (m && method === 'GET') {
		const path = join(SHARES_DIR, m[1], m[2])
		if (!existsSync(path)) throw new HttpError(404, 'not found')
		return serveFile(req, path, 'public, max-age=31536000, immutable')
	}

	m = /^\/media\/([\w.-]+)$/.exec(p)
	if (m && method === 'GET') {
		const path = join(MEDIA_DIR, m[1])
		if (!existsSync(path)) throw new HttpError(404, 'not found')
		return serveFile(req, path, 'public, max-age=31536000, immutable')
	}

	if (method === 'GET' && existsSync(WEB_DIST) && !p.startsWith('/api/')) {
		const path = join(WEB_DIST, p === '/' ? 'index.html' : p)
		if (path.startsWith(WEB_DIST) && existsSync(path) && Bun.file(path).size > 0) {
			return serveFile(req, path, 'no-cache')
		}
		return serveFile(req, join(WEB_DIST, 'index.html'), 'no-cache')
	}

	throw new HttpError(404, 'not found')
}

Bun.serve<RoomSocketData, never>({
	port: PORT,
	idleTimeout: 0,
	maxRequestBodySize: 1024 * 1024 * 1024,
	websocket: roomSockets,
	async fetch(req, server) {
		const room = /^\/api\/rooms\/([^/]+)$/.exec(stripBase(new URL(req.url).pathname))?.[1]
		if (room !== undefined) {
			// Rooms exist for shares only: "share-<shareId>".
			const shareId = /^share-([A-Za-z0-9]{10})$/.exec(room)?.[1]
			if (!shareId || !existsSync(join(SHARES_DIR, `${shareId}.json`))) return json({ error: 'no such room' }, 404)
			if (server.upgrade(req, { data: { room } })) return
			return json({ error: 'expected a websocket upgrade' }, 426)
		}
		try {
			return await handle(req)
		} catch (e) {
			if (e instanceof HttpError) return json({ error: e.message }, e.status)
			console.error(e)
			return json({ error: 'internal error' }, 500)
		}
	},
})

console.log(`canvas server on http://localhost:${PORT}  (data: ${DATA_DIR})`)
