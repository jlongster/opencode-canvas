import { mkdir, rename, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import type { Canvas, CanvasData, CanvasSummary, Item, MediaKind, ServerEvent, Session, SessionView } from '../shared/types'
import { discardRoom, roomSockets, setRoomPersistence, type RoomSocketData } from './rooms'
import type { ServerWebSocket } from 'bun'

const PORT = Number(process.env.PORT ?? 4410)
const DATA_DIR = resolve(process.env.CANVAS_DATA ?? join(import.meta.dir, '../data'))
const MEDIA_DIR = join(DATA_DIR, 'media')
const INDEX_FILE = join(DATA_DIR, 'index.json')
const ROOMS_DIR = join(DATA_DIR, 'rooms')
const WEB_DIST = resolve(import.meta.dir, '../web/dist')
const THUMB_SIZE = 512
const BASE_PATH = '/canvas'

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp'])
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.m4v', '.mkv'])

await mkdir(MEDIA_DIR, { recursive: true })
await mkdir(ROOMS_DIR, { recursive: true })
// One room per canvas ("canvas-<id>"); its document (sticky notes etc.) is saved in data/rooms.
const CANVAS_ROOM = /^canvas-([A-Za-z0-9]{10})$/
const roomFile = (canvasId: string) => join(ROOMS_DIR, `${canvasId}.ydoc`)
setRoomPersistence((room) => {
	const m = CANVAS_ROOM.exec(room)
	return m ? roomFile(m[1]) : null
})

// ---------- persistence ----------

/** data/index.json */
interface StoredIndex {
	canvases: Canvas[]
	sessions: Session[]
	items: Item[]
}

/** Sessions are keyed by canvas and session id: one OpenCode session can post to several canvases. */
const sessionKey = (canvasId: string, sessionId: string) => `${canvasId}/${sessionId}`

const db: { canvases: Map<string, Canvas>; sessions: Map<string, Session>; items: Map<string, Item> } = {
	canvases: new Map(),
	sessions: new Map(),
	items: new Map(),
}

if (existsSync(INDEX_FILE)) {
	const stored = (await Bun.file(INDEX_FILE).json()) as StoredIndex
	for (const c of stored.canvases) db.canvases.set(c.id, c)
	for (const s of stored.sessions) db.sessions.set(sessionKey(s.canvasId, s.id), s)
	for (const i of stored.items) db.items.set(i.id, i)
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
			await Bun.write(tmp, JSON.stringify(storedIndex()))
			await rename(tmp, INDEX_FILE)
		}
	} catch (e) {
		console.error('failed to save index:', e)
	} finally {
		saving = null
	}
}

function storedIndex(): StoredIndex {
	return { canvases: [...db.canvases.values()], sessions: [...db.sessions.values()], items: [...db.items.values()] }
}

// ---------- live events (WebSocket) ----------
// Every change is pushed to open canvases over /api/live. (This used to be server-sent events,
// but long-lived HTTP responses stall unpredictably behind exe.dev's proxy; WebSockets don't.)

/** canvasId: only that canvas's events; null: every event (for the canvas list) */
type LiveSocketData = { kind: 'live'; canvasId: string | null }
type SocketData = LiveSocketData | ({ kind: 'room' } & RoomSocketData)

const liveSockets = new Set<ServerWebSocket<SocketData>>()

function broadcast(event: ServerEvent) {
	const message = JSON.stringify(event)
	const canvasId = eventCanvas(event)
	for (const ws of liveSockets) {
		const data = ws.data as LiveSocketData
		if (data.canvasId === null || data.canvasId === canvasId) ws.send(message)
	}
}

function eventCanvas(event: ServerEvent): string {
	switch (event.type) {
		case 'canvas':
			return event.canvas.id
		case 'canvas_deleted':
			return event.id
		case 'session':
			return event.session.canvasId
		case 'item':
			return event.item.canvasId
		default:
			return event.canvasId
	}
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

// Sessions are keyed by the real OpenCode session id, so one session is one column per canvas.
// Exactly the shape of a real OpenCode session id: "ses_" + 26 characters. Anything longer (like a
// real id with a suffix) is rejected; use groups to organise items within a session instead.
const SESSION_ID = /^ses_[A-Za-z0-9]{26}$/

function assertSessionId(id: string | undefined): string {
	if (!id || !SESSION_ID.test(id)) {
		throw new HttpError(
			400,
			`session id must be your exact OpenCode session id ($OPENCODE_SESSION_ID: "ses_" + 26 characters), got ${JSON.stringify(id ?? null)}. ` +
				'Use "group" on items to organise them within one session.',
		)
	}
	return id
}

const GROUP_MAX = 120

/** A group name from the request: trimmed; "" or null means no group. */
function groupField(value: unknown): string | null | undefined {
	if (value === undefined) return undefined
	if (value === null) return null
	if (typeof value !== 'string') throw new HttpError(400, '"group" must be a string or null')
	const name = value.trim()
	if (name.length > GROUP_MAX) throw new HttpError(400, `"group" is longer than ${GROUP_MAX} characters`)
	return name || null
}

/** A session with its items arranged into groups, in the order the canvas shows them. */
function sessionView(session: Session): SessionView {
	const items = [...db.items.values()]
		.filter((i) => i.canvasId === session.canvasId && i.sessionId === session.id)
		.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
	const groups = new Map<string | null, Item[]>()
	for (const item of items) {
		const key = item.group ?? null
		if (!groups.has(key)) groups.set(key, [])
		groups.get(key)!.push(item)
	}
	// The untitled group always comes first; named groups in order of their first item.
	const ordered = [...groups.entries()].sort(([a], [b]) => (a === null ? -1 : b === null ? 1 : 0))
	return { ...session, groups: ordered.map(([name, items]) => ({ name, items })) }
}

const CANVAS_ID = /^[A-Za-z0-9]{10}$/

function getCanvas(id: string): Canvas {
	const canvas = CANVAS_ID.test(id) ? db.canvases.get(id) : undefined
	if (!canvas) throw new HttpError(404, `no canvas ${id}`)
	return canvas
}

function canvasData(canvas: Canvas): CanvasData {
	return {
		canvas,
		sessions: [...db.sessions.values()].filter((s) => s.canvasId === canvas.id),
		items: [...db.items.values()].filter((i) => i.canvasId === canvas.id),
	}
}

function canvasSummary(canvas: Canvas): CanvasSummary {
	const { sessions, items } = canvasData(canvas)
	const previews = items
		.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
		.slice(0, 4)
		.map((i) => i.thumb)
	return { ...canvas, sessionCount: sessions.length, itemCount: items.length, previews }
}

function canvasSessions(canvasId: string): Session[] {
	return [...db.sessions.values()].filter((s) => s.canvasId === canvasId)
}

function getSession(canvasId: string, id: string): Session {
	const session = db.sessions.get(sessionKey(canvasId, id))
	if (!session) throw new HttpError(404, `no session ${id} in canvas ${canvasId}`)
	return session
}

function getItem(id: string): Item {
	const item = db.items.get(id)
	if (!item) throw new HttpError(404, `no item ${id}`)
	return item
}

function updateItem(item: Item, changes: Partial<Pick<Item, 'group' | 'title' | 'caption'>>): Item {
	const next: Item = { ...item }
	for (const key of ['group', 'title', 'caption'] as const) {
		if (!(key in changes)) continue
		const value = changes[key]
		if (value === undefined || value === null) delete next[key]
		else next[key] = value
	}
	db.items.set(next.id, next)
	save()
	broadcast({ type: 'item', item: next })
	return next
}

function textField(value: unknown): string | undefined {
	const text = typeof value === 'string' ? value.trim() : undefined
	return text || undefined
}

function newId() {
	return crypto.randomUUID().replaceAll('-', '').slice(0, 16)
}

async function addItem(
	canvasId: string,
	sessionId: string,
	data: Blob,
	opts: { filename?: string; group?: string | null; title?: string; caption?: string; id?: string },
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
		// The canvas may have been deleted while the media was processed.
		getCanvas(canvasId)
		ensureSession(canvasId, sessionId)
		const item: Item = {
			id,
			canvasId,
			sessionId,
			kind,
			src: `/media/${file}`,
			thumb: `/media/${thumbFile}`,
			width,
			height,
			...(opts.group ? { group: opts.group } : {}),
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

function ensureSession(canvasId: string, id: string, title?: string): Session {
	const key = sessionKey(canvasId, id)
	const existing = db.sessions.get(key)
	if (existing && (title === undefined || existing.title === title)) return existing
	const session: Session = existing
		? { ...existing, title: title! }
		: { id, canvasId, title: title ?? id, createdAt: Date.now() }
	db.sessions.set(key, session)
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
	broadcast({ type: 'item_deleted', canvasId: item.canvasId, id })
	return true
}

async function deleteSession(session: Session) {
	for (const item of [...db.items.values()]) {
		if (item.canvasId === session.canvasId && item.sessionId === session.id) await deleteItem(item.id)
	}
	db.sessions.delete(sessionKey(session.canvasId, session.id))
	save()
	broadcast({ type: 'session_deleted', canvasId: session.canvasId, id: session.id })
}

// ---------- canvases ----------

function randomId(length: number) {
	const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
	const bytes = crypto.getRandomValues(new Uint8Array(length))
	return [...bytes].map((b) => alphabet[b % alphabet.length]).join('')
}

const TITLE_MAX = 200

function canvasTitle(value: unknown): string | undefined {
	if (value === undefined) return undefined
	if (typeof value !== 'string') throw new HttpError(400, '"title" must be a string')
	const title = value.trim()
	if (title.length > TITLE_MAX) throw new HttpError(400, `"title" is longer than ${TITLE_MAX} characters`)
	return title || undefined
}

function createCanvas(title?: string): Canvas {
	let id = randomId(10)
	while (db.canvases.has(id)) id = randomId(10)
	const canvas: Canvas = { id, title: title ?? 'Untitled canvas', createdAt: Date.now(), viewKey: randomId(16) }
	db.canvases.set(id, canvas)
	save()
	broadcast({ type: 'canvas', canvas })
	return canvas
}

async function deleteCanvas(canvas: Canvas) {
	db.canvases.delete(canvas.id)
	for (const session of canvasSessions(canvas.id)) await deleteSession(session)
	// items whose session record is missing, just in case
	for (const item of [...db.items.values()]) if (item.canvasId === canvas.id) await deleteItem(item.id)
	await discardRoom(`canvas-${canvas.id}`)
	await rm(roomFile(canvas.id), { force: true })
	save()
	broadcast({ type: 'canvas_deleted', id: canvas.id })
}

// ---------- http ----------

/** GET /api: a short, self-describing map of the API for agents. */
const API_INDEX = {
	about:
		'Review canvases. There are several canvases, each with its own id (:cid). On a canvas, each OpenCode ' +
		'session is one frame; inside it, items (images/videos) are organised into named groups. Use your exact ' +
		'$OPENCODE_SESSION_ID as the session id; the same session can post to several canvases.',
	endpoints: {
		'GET /api/canvases': 'All canvases, newest first, with session/item counts and preview thumbnails',
		'POST /api/canvases': 'Create a canvas. Body: {"title"} (optional). Returns it, with its id and viewKey',
		'GET /api/canvases/:cid': 'One canvas with all its sessions and items',
		'PATCH /api/canvases/:cid': 'Rename a canvas. Body: {"title"}',
		'DELETE /api/canvases/:cid': 'Delete a canvas with all its sessions, items and notes',
		'GET /api/view/:viewKey': 'A canvas by its view-only key (same body as GET /api/canvases/:cid)',
		'GET /api/canvases/:cid/sessions': 'The canvas\'s sessions, each with its groups and their items, in canvas order',
		'GET /api/canvases/:cid/sessions/:sessionId': 'One session with its groups and items',
		'PUT /api/canvases/:cid/sessions/:sessionId': 'Create or rename a session. Body: {"title"}',
		'DELETE /api/canvases/:cid/sessions/:sessionId': 'Delete a session and all its items',
		'POST /api/canvases/:cid/sessions/:sessionId/items':
			'Add an image or video. JSON {"path"} (file on this machine) or {"url"}, or multipart "file"; ' +
			'plus optional "group", "title", "caption". Creates the session if needed.',
		'GET /api/items/:itemId': 'One item',
		'PATCH /api/items/:itemId': 'Change an item\'s "group", "title" or "caption" (null clears)',
		'DELETE /api/items/:itemId': 'Delete an item',
		'PATCH /api/canvases/:cid/sessions/:sessionId/groups/:group': 'Rename a group. Body: {"name"} (null ungroups its items)',
		'DELETE /api/canvases/:cid/sessions/:sessionId/groups/:group': 'Delete a group and all its items',
	},
	layout:
		'Sessions sit side by side, newest on the right. In a session, the untitled group comes first, then named ' +
		'groups in the order they were first posted to; each group\'s items flow left to right in rows, in posting order.',
}

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

	// The exe.dev proxy adds this header for visitors who are logged in to exe.dev.
	if (p === '/api/me' && method === 'GET') return json({ email: req.headers.get('x-exedev-email') || null })

	if (p === '/api' && method === 'GET') return json(API_INDEX)

	// ---- canvases ----

	if (p === '/api/canvases' && method === 'GET') {
		return json([...db.canvases.values()].sort((a, b) => b.createdAt - a.createdAt).map(canvasSummary))
	}
	if (p === '/api/canvases' && method === 'POST') {
		const body = (await req.json().catch(() => ({}))) as { title?: unknown }
		return json(createCanvas(canvasTitle(body?.title)), 201)
	}

	let m = /^\/api\/canvases\/([^/]+)$/.exec(p)
	if (m) {
		const canvas = getCanvas(decodeURIComponent(m[1]))
		if (method === 'GET') return json(canvasData(canvas))
		if (method === 'PATCH') {
			const body = (await req.json().catch(() => ({}))) as { title?: unknown }
			const title = canvasTitle(body?.title)
			if (!title) throw new HttpError(400, 'send {"title": "<new title>"}')
			const next: Canvas = { ...canvas, title }
			db.canvases.set(next.id, next)
			save()
			broadcast({ type: 'canvas', canvas: next })
			return json(next)
		}
		if (method === 'DELETE') {
			await deleteCanvas(canvas)
			return json({ ok: true })
		}
	}

	m = /^\/api\/view\/([^/]+)$/.exec(p)
	if (m && method === 'GET') {
		const key = decodeURIComponent(m[1])
		const canvas = [...db.canvases.values()].find((c) => c.viewKey === key)
		if (!canvas) throw new HttpError(404, 'canvas not found')
		return json(canvasData(canvas))
	}

	// ---- sessions ----

	m = /^\/api\/canvases\/([^/]+)\/sessions$/.exec(p)
	if (m && method === 'GET') {
		const canvas = getCanvas(decodeURIComponent(m[1]))
		return json(canvasSessions(canvas.id).sort((a, b) => a.createdAt - b.createdAt).map(sessionView))
	}

	m = /^\/api\/canvases\/([^/]+)\/sessions\/([^/]+)$/.exec(p)
	if (m) {
		const canvas = getCanvas(decodeURIComponent(m[1]))
		const id = decodeURIComponent(m[2])
		if (method === 'GET') return json(sessionView(getSession(canvas.id, id)))
		if (method === 'PUT') {
			const body = (await req.json().catch(() => ({}))) as { title?: unknown }
			const existed = db.sessions.has(sessionKey(canvas.id, id))
			const session = ensureSession(canvas.id, assertSessionId(id), textField(body?.title))
			return json(sessionView(session), existed ? 200 : 201)
		}
		if (method === 'DELETE') {
			await deleteSession(getSession(canvas.id, id))
			return json({ ok: true })
		}
	}

	// ---- groups (named sets of items within a session) ----

	m = /^\/api\/canvases\/([^/]+)\/sessions\/([^/]+)\/groups\/([^/]+)$/.exec(p)
	if (m) {
		const canvas = getCanvas(decodeURIComponent(m[1]))
		const session = getSession(canvas.id, decodeURIComponent(m[2]))
		const name = decodeURIComponent(m[3])
		const items = [...db.items.values()].filter(
			(i) => i.canvasId === canvas.id && i.sessionId === session.id && i.group === name,
		)
		if (!items.length) throw new HttpError(404, `no group ${JSON.stringify(name)} in ${session.id}`)
		if (method === 'PATCH') {
			const body = (await req.json().catch(() => ({}))) as { name?: unknown }
			const next = groupField(body.name)
			if (next === undefined) throw new HttpError(400, 'send {"name": "<new name>"} (or null to ungroup)')
			for (const item of items) updateItem(item, { group: next ?? undefined })
			return json(sessionView(session))
		}
		if (method === 'DELETE') {
			for (const item of items) await deleteItem(item.id)
			return json({ ok: true, deleted: items.length })
		}
	}

	// ---- items ----

	m = /^\/api\/canvases\/([^/]+)\/sessions\/([^/]+)\/items$/.exec(p)
	if (m && method === 'POST') {
		const canvasId = getCanvas(decodeURIComponent(m[1])).id
		const sessionId = assertSessionId(decodeURIComponent(m[2]))
		const type = req.headers.get('content-type') ?? ''
		if (type.includes('multipart/form-data')) {
			const form = await req.formData()
			const file = form.get('file')
			if (!(file instanceof Blob)) throw new HttpError(400, 'missing "file" field')
			const meta = {
				group: groupField(form.get('group') ?? undefined),
				title: textField(form.get('title')),
				caption: textField(form.get('caption')),
			}
			const filename = file instanceof File ? file.name : undefined
			return json(await addItem(canvasId, sessionId, file, { filename, ...meta }), 201)
		}
		const body = (await req.json().catch(() => null)) as
			| { path?: string; url?: string; group?: unknown; title?: string; caption?: string }
			| null
		const meta = { group: groupField(body?.group), title: textField(body?.title), caption: textField(body?.caption) }
		if (body?.path) {
			const f = Bun.file(body.path)
			if (!(await f.exists())) throw new HttpError(404, `no file at ${body.path}`)
			return json(await addItem(canvasId, sessionId, f, { filename: body.path, ...meta }), 201)
		}
		if (body?.url) {
			const res = await fetch(body.url)
			if (!res.ok) throw new HttpError(502, `fetch ${body.url} failed: ${res.status}`)
			const blob = await res.blob()
			return json(await addItem(canvasId, sessionId, blob, { filename: new URL(body.url).pathname, ...meta }), 201)
		}
		throw new HttpError(400, 'send multipart "file", or JSON {"path"} or {"url"}')
	}

	m = /^\/api\/items\/([^/]+)$/.exec(p)
	if (m) {
		const item = getItem(decodeURIComponent(m[1]))
		if (method === 'GET') return json(item)
		if (method === 'PATCH') {
			const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
			const changes: Partial<Pick<Item, 'group' | 'title' | 'caption'>> = {}
			if ('group' in body) changes.group = groupField(body.group) ?? undefined
			if ('title' in body) changes.title = body.title === null ? undefined : textField(body.title)
			if ('caption' in body) changes.caption = body.caption === null ? undefined : textField(body.caption)
			if (!Object.keys(changes).length) throw new HttpError(400, 'send any of {"group", "title", "caption"} (null clears)')
			return json(updateItem(item, changes))
		}
		if (method === 'DELETE') {
			await deleteItem(item.id)
			return json({ ok: true })
		}
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
			return serveFile(req, path, path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store')
		}
		return serveFile(req, join(WEB_DIST, 'index.html'), 'no-store')
	}

	throw new HttpError(404, p.startsWith('/api') ? `no route ${method} ${p}; GET /api lists the endpoints` : 'not found')
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
			const canvasId = reqUrl.searchParams.get('canvas')
			if (canvasId !== null && !db.canvases.has(canvasId)) return json({ error: `no canvas ${canvasId}` }, 404)
			if (server.upgrade(req, { data: { kind: 'live', canvasId } })) return
			return json({ error: 'expected a websocket upgrade' }, 426)
		}
		const room = /^\/api\/rooms\/([^/]+)$/.exec(stripBase(reqUrl.pathname))?.[1]
		if (room !== undefined) {
			// One room per canvas: "canvas-<id>". View links join with ?view=1 and are read-only:
			// they get live notes and presence, but can't change anything.
			const canvasId = CANVAS_ROOM.exec(room)?.[1]
			if (!canvasId || !db.canvases.has(canvasId)) return json({ error: 'no such room' }, 404)
			const readOnly = reqUrl.searchParams.get('view') === '1'
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
