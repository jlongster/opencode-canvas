import { copyFile, link, mkdir, rename, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import type { Item, MediaKind, OpenedShare, ServerEvent, Session, Share, Snapshot } from '../shared/types'
import { roomSockets, setRoomPersistence, type RoomSocketData } from './rooms'
import { readdir } from 'node:fs/promises'
import type { ServerWebSocket } from 'bun'

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
const SHARE_ROOM = /^share-([A-Za-z0-9]{10})$/
setRoomPersistence((room) => {
	const m = SHARE_ROOM.exec(room)
	return m ? join(SHARES_DIR, `${m[1]}.ydoc`) : null
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

// ---------- live events (WebSocket) ----------
// Every change is pushed to open canvases over /api/live. (This used to be server-sent events,
// but long-lived HTTP responses stall unpredictably behind exe.dev's proxy; WebSockets don't.)

type LiveSocketData = { kind: 'live' }
type SocketData = LiveSocketData | ({ kind: 'room' } & RoomSocketData)

const liveSockets = new Set<ServerWebSocket<SocketData>>()

function broadcast(event: ServerEvent) {
	const message = JSON.stringify(event)
	for (const ws of liveSockets) ws.send(message)
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
const EDIT_KEY = /^[A-Za-z0-9]{20}$/

/** A share as stored on disk. The edit key is secret: it's never sent with the view-only share. */
type StoredShare = Share & { editKey: string }

function randomId(length: number) {
	const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
	const bytes = crypto.getRandomValues(new Uint8Array(length))
	return [...bytes].map((b) => alphabet[b % alphabet.length]).join('')
}

const shares = new Map<string, StoredShare>()
const shareByEditKey = new Map<string, string>()

async function writeShare(share: StoredShare) {
	shares.set(share.id, share)
	shareByEditKey.set(share.editKey, share.id)
	await Bun.write(join(SHARES_DIR, `${share.id}.json`), JSON.stringify(share))
}

// Load every share, giving older ones (made before edit links existed) an edit key.
for (const file of await readdir(SHARES_DIR)) {
	const id = file.endsWith('.json') ? file.slice(0, -5) : null
	if (!id || !SHARE_ID.test(id)) continue
	const share = (await Bun.file(join(SHARES_DIR, file)).json()) as Partial<StoredShare> & Share
	if (share.editKey) {
		shares.set(id, share as StoredShare)
		shareByEditKey.set(share.editKey, id)
	} else {
		await writeShare({ ...share, editKey: randomId(20) })
	}
}

function openShare(share: StoredShare, role: OpenedShare['role']): OpenedShare {
	const { editKey, ...rest } = share
	return role === 'edit' ? { ...rest, role, editKey } : { ...rest, role }
}

function shareLinks(share: StoredShare) {
	return { id: share.id, viewUrl: `${PUBLIC_URL}/s/${share.id}`, editUrl: `${PUBLIC_URL}/e/${share.editKey}` }
}

/**
 * Freezes the given sessions (default: all) into a share. Media files are hard-linked into the
 * share's own folder, so the share keeps working after the originals are deleted, without
 * using extra disk space.
 */
async function createShare(body: { sessionIds?: string[]; view?: Share['view'] }): Promise<StoredShare> {
	const wanted = body.sessionIds ? new Set(body.sessionIds) : null
	const sessions = [...db.sessions.values()].filter((s) => !wanted || wanted.has(s.id))
	if (!sessions.length) throw new HttpError(400, 'nothing to share')
	const sessionIds = new Set(sessions.map((s) => s.id))

	const id = randomId(10)
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
	const share: StoredShare = { id, createdAt: Date.now(), view: body.view, sessions, items, editKey: randomId(20) }
	await writeShare(share)
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
		return json(shareLinks(share), 201)
	}

	// Edit links: /e/<editKey> in the browser, /api/edit/<editKey> for the data.
	m = /^\/api\/edit\/([^/]+)$/.exec(p)
	if (m && method === 'GET') {
		const share = EDIT_KEY.test(m[1]) ? shares.get(shareByEditKey.get(m[1]) ?? '') : undefined
		if (!share) throw new HttpError(404, 'share not found')
		return json(openShare(share, 'edit'))
	}

	m = /^\/api\/shares\/([^/]+)\/links$/.exec(p)
	if (m && method === 'GET') {
		const share = shares.get(m[1])
		if (!share) throw new HttpError(404, 'share not found')
		return json(shareLinks(share))
	}

	m = /^\/api\/shares\/([^/]+)$/.exec(p)
	if (m && SHARE_ID.test(m[1])) {
		const share = shares.get(m[1])
		if (!share) throw new HttpError(404, 'share not found')
		if (method === 'GET') return json(openShare(share, 'view'))
		if (method === 'DELETE') {
			shares.delete(share.id)
			shareByEditKey.delete(share.editKey)
			await rm(join(SHARES_DIR, `${m[1]}.json`), { force: true })
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

Bun.serve<SocketData, never>({
	port: PORT,
	idleTimeout: 0,
	maxRequestBodySize: 1024 * 1024 * 1024,
	websocket: {
		open(ws) {
			if (ws.data.kind === 'live') liveSockets.add(ws)
			else roomSockets.open(ws as ServerWebSocket<RoomSocketData & { kind: 'room' }>)
		},
		message(ws, message) {
			if (ws.data.kind === 'room') roomSockets.message(ws as ServerWebSocket<RoomSocketData & { kind: 'room' }>, message)
			// Live clients heartbeat so proxies don't drop the idle connection (see web/src/sync/client.ts).
			else if (message === 'ping') ws.send('pong')
		},
		close(ws) {
			if (ws.data.kind === 'live') liveSockets.delete(ws)
			else roomSockets.close(ws as ServerWebSocket<RoomSocketData & { kind: 'room' }>)
		},
	},
	async fetch(req, server) {
		const reqUrl = new URL(req.url)
		if (stripBase(reqUrl.pathname) === '/api/live') {
			if (server.upgrade(req, { data: { kind: 'live' } })) return
			return json({ error: 'expected a websocket upgrade' }, 426)
		}
		const room = /^\/api\/rooms\/([^/]+)$/.exec(stripBase(reqUrl.pathname))?.[1]
		if (room !== undefined) {
			// One room per share: "share-<id>". Without the edit key the connection is read-only:
			// view links get live notes and presence, but can't change anything.
			const m = SHARE_ROOM.exec(room)
			const share = shares.get(m?.[1] ?? '')
			if (!share) return json({ error: 'no such room' }, 404)
			const readOnly = reqUrl.searchParams.get('key') !== share.editKey
			if (server.upgrade(req, { data: { kind: 'room', room, readOnly } })) return
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
