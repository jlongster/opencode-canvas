import { mkdir, rename, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import * as Y from 'yjs'
import type {
	Annotation, AnnotationView, AttentionAction, Canvas, CanvasData, CanvasSummary, ConjuredAgent, Item, MediaKind, Note, PresenceEntry, ResolvedSelection, ServerEvent, Session,
	SessionView,
} from '../shared/types'
import { computeLayout, LAYOUT } from '../web/src/editor/layout'
import { AttentionError, createAttention } from './attention'
import { ConjureError, createConjured } from './conjured'
import { imageSize } from './imageSize'
import { createCanvasMcp } from './mcp'
import { discardRoom, getRoomSnapshot, readRoomDoc, roomSockets, setRoomPersistence, type RoomSocketData } from './rooms'
import type { Server, ServerWebSocket } from 'bun'

const PORT = Number(process.env.PORT ?? 4410)
/** The address to listen on (all interfaces unless set; `bunx opencode-canvas` binds 127.0.0.1). */
const HOSTNAME = process.env.CANVAS_HOST || undefined
const DATA_DIR = resolve(process.env.CANVAS_DATA ?? join(import.meta.dir, '../data'))
const MEDIA_DIR = join(DATA_DIR, 'media')
const INDEX_FILE = join(DATA_DIR, 'index.json')
const ROOMS_DIR = join(DATA_DIR, 'rooms')
const WEB_DIST = resolve(import.meta.dir, '../web/dist')
const THUMB_SIZE = 512
const BASE_PATH = '/canvas'
/** Where selection results point their absolute media URLs. */
const MEDIA_ORIGIN = (process.env.CANVAS_MEDIA_ORIGIN ?? `http://localhost:${PORT}`).replace(/\/+$/, '')
/** Where people open canvases in a browser, for links in MCP tool results. */
const WEB_BASE = (process.env.CANVAS_WEB ?? 'https://jamesbox.exe.xyz/canvas').replace(/\/+$/, '')

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.bmp'])
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.m4v', '.mkv'])
const HTML_EXTS = new Set(['.html', '.htm'])
const HTML_MAX_BYTES = 2 * 1024 * 1024
const HTML_DEFAULT_SIZE = { width: 800, height: 600 }
const HTML_MIN_SIZE = 50
const HTML_MAX_SIZE = 8000

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
	trash?: TrashEntry[]
	/** OpenCode sessions on canvases as creatures (see conjured.ts) */
	conjured?: ConjuredAgent[]
	/** creatures' queued attention actions (see attention.ts) */
	attention?: AttentionAction[]
}

/**
 * Deleted items and sessions wait in the trash for TRASH_MS (their files stay on disk), so they can
 * be restored with POST /api/canvases/:cid/restore. They're hidden from every API response.
 */
type TrashEntry =
	| { kind: 'item'; item: Item; deletedAt: number }
	/** itemIds: the items that were deleted along with the session */
	| { kind: 'session'; session: Session; itemIds: string[]; deletedAt: number }

const TRASH_MS = 60 * 60 * 1000
const TRASH_SWEEP_MS = 5 * 60 * 1000

/** Sessions are keyed by canvas and session id: one OpenCode session can post to several canvases. */
const sessionKey = (canvasId: string, sessionId: string) => `${canvasId}/${sessionId}`

const db: { canvases: Map<string, Canvas>; sessions: Map<string, Session>; items: Map<string, Item> } = {
	canvases: new Map(),
	sessions: new Map(),
	items: new Map(),
}
/** keyed "item:<id>" and "session:<canvasId>/<sessionId>" */
const trash = new Map<string, TrashEntry>()
let storedConjured: ConjuredAgent[] = []
let storedAttention: AttentionAction[] = []
const trashKey = (entry: TrashEntry) =>
	entry.kind === 'item' ? `item:${entry.item.id}` : `session:${sessionKey(entry.session.canvasId, entry.session.id)}`

if (existsSync(INDEX_FILE)) {
	const stored = (await Bun.file(INDEX_FILE).json()) as StoredIndex
	for (const c of stored.canvases) db.canvases.set(c.id, c)
	for (const s of stored.sessions) db.sessions.set(sessionKey(s.canvasId, s.id), s)
	for (const i of stored.items) db.items.set(i.id, withName(i))
	for (const t of stored.trash ?? []) trash.set(trashKey(t), t.kind === 'item' ? { ...t, item: withName(t.item) } : t)
	storedConjured = stored.conjured ?? []
	storedAttention = stored.attention ?? []
}

/** Items saved before they had names get one: their title (or id) plus the file's extension. */
function withName(item: Item): Item {
	if (item.name) return item
	const ext = extname(item.src)
	const base = item.title?.replaceAll('/', '-') || item.id
	return { ...item, name: base.toLowerCase().endsWith(ext.toLowerCase()) ? base : base + ext }
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
	return {
		canvases: [...db.canvases.values()],
		sessions: [...db.sessions.values()],
		items: [...db.items.values()],
		trash: [...trash.values()],
		conjured: conjured.all(),
		attention: attention.all(),
	}
}

const conjured = createConjured(
	{
		canvasExists: (id) => db.canvases.has(id),
		save,
		broadcast: (event) => broadcast(event),
	},
	storedConjured,
)

const attention = createAttention(
	{
		canvasExists: (id) => db.canvases.has(id),
		save,
		broadcast: (event) => broadcast(event),
		resolveTarget: (canvasId, target) => resolveTarget(canvasId, target),
		ensureCreature: (canvasId, sessionId, title) =>
			void conjured.ensure(canvasId, sessionId, {
				title: title ?? db.sessions.get(sessionKey(canvasId, sessionId))?.title,
				at: () => creatureSpot(canvasId, sessionId),
			}),
	},
	storedAttention,
)

/** how far apart (page px) creatures placed by the server sit */
const CREATURE_GAP = 90

/**
 * Where a creature the server makes for a session goes: in its frame's title strip, just after the
 * title (roughly: the server can't measure text), or where its frame would appear if it has none;
 * moved along to the right until it's clear of the canvas's other creatures.
 */
function creatureSpot(canvasId: string, sessionId: string) {
	const sessions = Object.fromEntries(canvasSessions(canvasId).map((s) => [s.id, s]))
	const items = Object.fromEntries([...db.items.values()].filter((i) => i.canvasId === canvasId).map((i) => [i.id, i]))
	const layout = computeLayout(sessions, items)
	const section = layout.sections.find((s) => s.id === sessionId)
	let x: number
	let y: number
	if (section) {
		const title = untitled(sessions[sessionId]) ? 'Untitled session' : section.title
		// (its body and wings reach back about 60px from its head, which sits at x)
		const titleWidth = Array.from(title).length * LAYOUT.frameTitlePx * 0.6
		x = Math.min(section.header.x + titleWidth + 90, section.header.x + section.header.w - 70)
		y = section.header.y + 44
	} else {
		x = layout.bounds ? layout.bounds.x + layout.bounds.w + LAYOUT.frameGap + 60 : 60
		y = LAYOUT.framePadding + 44
	}
	const others = conjured.list(canvasId)
	while (others.some((r) => Math.abs(r.x - x) < CREATURE_GAP && Math.abs(r.y - y) < CREATURE_GAP)) x += CREATURE_GAP
	return { x, y }
}

/**
 * A highlight target as a selection key, checked against the canvas: an item id, "frame:<sessionId>"
 * (or a bare session id), "note:<noteId>", or a group as "<sessionId>/<group name>" (or
 * "group:<sessionId>/<group name>"; an empty name is the untitled group).
 */
async function resolveTarget(canvasId: string, ref: string): Promise<string> {
	if (ref.startsWith('frame:') || SESSION_ID.test(ref)) {
		const id = ref.startsWith('frame:') ? ref.slice(6) : ref
		if (!db.sessions.has(sessionKey(canvasId, id))) throw new AttentionError(404, `no session frame ${id} on this canvas`)
		return `frame:${id}`
	}
	if (ref.startsWith('note:')) {
		const notes = await readRoomDoc(`canvas-${canvasId}`, readNotes)
		if (!notes.some((n) => n.id === ref.slice(5))) throw new AttentionError(404, `no sticky note ${ref} on this canvas`)
		return ref
	}
	const group = ref.startsWith('group:') ? ref.slice(6) : ref.includes('/') ? ref : null
	if (group !== null) {
		const slash = group.indexOf('/')
		const sessionId = slash < 0 ? group : group.slice(0, slash)
		const name = slash < 0 ? '' : group.slice(slash + 1).trim()
		const found = sessionItems(canvasId, sessionId).some((i) => (i.group ?? '') === name)
		if (!found) throw new AttentionError(404, `no group ${JSON.stringify(name)} in session ${sessionId} on this canvas (groups are "<sessionId>/<group name>")`)
		return `group:${sessionId}/${name}`
	}
	if (db.items.get(ref)?.canvasId !== canvasId) {
		throw new AttentionError(404, `no item ${ref} on this canvas (targets: an item id, "<sessionId>/<group name>", "frame:<sessionId>" or "note:<noteId>")`)
	}
	return ref
}

/** A canvas's conjured worms, each awake while its owner's tab publishes its presence in the room. */
function conjuredWorms(canvasId: string): ConjuredAgent[] {
	const awake = new Set(presence(canvasId).filter((p) => p.user.conjured && p.user.sessionId).map((p) => p.user.sessionId))
	return conjured.list(canvasId).map((r) => ({ ...r, awake: awake.has(r.sessionId) }))
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
		case 'conjured':
			return event.agent.canvasId
		case 'attention':
			return event.action.canvasId
		default:
			return event.canvasId
	}
}

// ---------- media processing ----------

/** Without ffmpeg (e.g. a fresh machine running `bunx opencode-canvas`) images still work, unthumbnailed; videos don't. */
const HAS_FFMPEG = !!Bun.which('ffmpeg') && !!Bun.which('ffprobe')
if (!HAS_FFMPEG) console.warn('ffmpeg/ffprobe not found: images are shown without thumbnails and videos can\'t be posted (install ffmpeg to fix)')

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
	if (HTML_EXTS.has(ext) || mime?.startsWith('text/html')) return 'html'
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
		conjured: conjuredWorms(canvas.id),
		attention: attention.list(canvas.id),
	}
}

function canvasSummary(canvas: Canvas): CanvasSummary {
	const { sessions, items } = canvasData(canvas)
	// HTML items have no image thumbnail.
	const previews = items
		.filter((i) => i.kind !== 'html')
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

function updateItem(item: Item, changes: Partial<Pick<Item, 'group' | 'title' | 'caption' | 'name'>>): Item {
	const next: Item = { ...item }
	for (const key of ['group', 'title', 'caption'] as const) {
		if (!(key in changes)) continue
		const value = changes[key]
		if (value === undefined || value === null) delete next[key]
		else next[key] = value
	}
	if (changes.name) next.name = changes.name
	db.items.set(next.id, next)
	save()
	broadcast({ type: 'item', item: next })
	return next
}

/** The changes of PATCH /api/items/:itemId (also used by the MCP update_item tool). */
function itemChanges(body: Record<string, unknown>): Partial<Pick<Item, 'group' | 'title' | 'caption' | 'name'>> {
	const changes: Partial<Pick<Item, 'group' | 'title' | 'caption' | 'name'>> = {}
	if ('group' in body) changes.group = groupField(body.group) ?? undefined
	if ('title' in body) changes.title = body.title === null ? undefined : textField(body.title)
	if ('caption' in body) changes.caption = body.caption === null ? undefined : textField(body.caption)
	if ('name' in body) {
		changes.name = nameField(body.name)
		if (!changes.name) throw new HttpError(400, '"name" can\'t be empty')
	}
	if (!Object.keys(changes).length) throw new HttpError(400, 'send any of {"group", "title", "caption", "name"} (null clears, except name)')
	return changes
}

/** A multipart "createdAt": ms since the epoch, not in the future. */
function timeField(value: unknown): number | undefined {
	if (value === undefined || value === null || value === '') return undefined
	const n = Number(value)
	if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, '"createdAt" must be a time in ms since the epoch')
	return Math.min(Math.round(n), Date.now())
}

function textField(value: unknown): string | undefined {
	const text = typeof value === 'string' ? value.trim() : undefined
	return text || undefined
}

const NAME_MAX = 200

/** An item's "name" (file name) from the request; undefined when not given. */
function nameField(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined
	if (typeof value !== 'string') throw new HttpError(400, '"name" must be a string')
	const name = basename(value.trim())
	if (name.length > NAME_MAX) throw new HttpError(400, `"name" is longer than ${NAME_MAX} characters`)
	return name || undefined
}

function newId() {
	return crypto.randomUUID().replaceAll('-', '').slice(0, 16)
}

interface ItemOptions {
	/** original file name or path: gives the extension, and the item's name unless `name` is set */
	filename?: string
	name?: string
	group?: string | null
	title?: string
	caption?: string
	id?: string
	/** HTML items: the CSS pixel size the page is designed for */
	width?: number
	height?: number
	/** defaults to now; seeded items get the time they were output, which orders them in their group */
	createdAt?: number
	/** the OpenCode session's title: names the session if it's new or still untitled */
	sessionTitle?: string
}

async function addItem(canvasId: string, sessionId: string, data: Blob, opts: ItemOptions): Promise<Item> {
	const ext = (extname(opts.filename ?? '').toLowerCase() || extFromMime(data.type)).toLowerCase()
	const kind = kindOf(ext, data.type)
	if (!kind) throw new HttpError(415, `unsupported media type (${ext || data.type || 'unknown'})`)
	const name = opts.name ?? (opts.filename ? basename(opts.filename) || undefined : undefined)
	if (kind === 'html') {
		if (data.size > HTML_MAX_BYTES) throw new HttpError(413, `HTML is larger than ${HTML_MAX_BYTES / 1024 / 1024} MB`)
		return addHtmlItem(canvasId, sessionId, await data.text(), { ...opts, name })
	}

	const id = opts.id ?? newId()
	const file = `${id}${ext}`
	const thumbFile = `${id}.thumb.webp`
	const path = join(MEDIA_DIR, file)
	await Bun.write(path, data)

	try {
		let size: { width: number; height: number } | null
		let thumb = `/media/${thumbFile}`
		if (HAS_FFMPEG) {
			size = await probe(path)
			await makeThumb(path, join(MEDIA_DIR, thumbFile))
		} else {
			if (kind === 'video') throw new Error('posting videos needs ffmpeg installed on the canvas server\'s machine')
			size = imageSize(new Uint8Array(await Bun.file(path).arrayBuffer()))
			if (!size) throw new Error('can\'t read this image\'s size without ffmpeg (PNG, JPEG, GIF and WebP work; install ffmpeg for others)')
			thumb = `/media/${file}`
		}
		const { width, height } = size
		// The canvas may have been deleted while the media was processed.
		getCanvas(canvasId)
		ensureSession(canvasId, sessionId, opts.sessionTitle, { onlyIfUntitled: true })
		const item: Item = {
			id,
			canvasId,
			sessionId,
			kind,
			name: name ?? file,
			src: `/media/${file}`,
			thumb,
			width,
			height,
			...(opts.group ? { group: opts.group } : {}),
			title: opts.title,
			caption: opts.caption,
			createdAt: opts.createdAt ?? Date.now(),
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

/** The JSON body of POST /api/canvases/:cid/sessions/:sessionId/items (also used by the MCP post_item tool). */
interface ItemJson {
	path?: string
	url?: string
	html?: unknown
	width?: unknown
	height?: unknown
	group?: unknown
	title?: string
	caption?: string
	name?: unknown
	sessionTitle?: unknown
}

async function addItemFromJson(canvasId: string, sessionId: string, body: ItemJson | null): Promise<Item> {
	const meta = {
		group: groupField(body?.group),
		title: textField(body?.title),
		caption: textField(body?.caption),
		name: nameField(body?.name),
		width: sizeField(body?.width, 'width'),
		height: sizeField(body?.height, 'height'),
		sessionTitle: textField(body?.sessionTitle)?.slice(0, TITLE_MAX),
	}
	if (body?.html !== undefined) {
		if (typeof body.html !== 'string') throw new HttpError(400, '"html" must be a string')
		return addHtmlItem(canvasId, sessionId, body.html, meta)
	}
	if (body?.path) {
		const f = Bun.file(body.path)
		if (!(await f.exists())) throw new HttpError(404, `no file at ${body.path}`)
		return addItem(canvasId, sessionId, f, { filename: body.path, ...meta })
	}
	if (body?.url) {
		const res = await fetch(body.url)
		if (!res.ok) throw new HttpError(502, `fetch ${body.url} failed: ${res.status}`)
		const blob = await res.blob()
		const pathname = new URL(body.url).pathname
		let filename = pathname
		try {
			filename = decodeURIComponent(pathname)
		} catch {}
		return addItem(canvasId, sessionId, blob, { filename, ...meta })
	}
	throw new HttpError(400, 'send multipart "file", or JSON {"path"}, {"url"} or {"html"}')
}

/** An HTML page, shown on the canvas in a sandboxed iframe at the size it was designed for. No thumbnail. */
async function addHtmlItem(canvasId: string, sessionId: string, html: string, opts: ItemOptions): Promise<Item> {
	if (Buffer.byteLength(html) > HTML_MAX_BYTES) throw new HttpError(413, `HTML is larger than ${HTML_MAX_BYTES / 1024 / 1024} MB`)
	if (!html.trim()) throw new HttpError(400, '"html" is empty')
	const id = opts.id ?? newId()
	const file = `${id}.html`
	await Bun.write(join(MEDIA_DIR, file), htmlDocument(html))
	getCanvas(canvasId)
	ensureSession(canvasId, sessionId, opts.sessionTitle, { onlyIfUntitled: true })
	const item: Item = {
		id,
		canvasId,
		sessionId,
		kind: 'html',
		name: opts.name ?? `${opts.title?.replaceAll('/', '-') ?? id}.html`,
		src: `/media/${file}`,
		thumb: `/media/${file}`,
		width: opts.width ?? HTML_DEFAULT_SIZE.width,
		height: opts.height ?? HTML_DEFAULT_SIZE.height,
		...(opts.group ? { group: opts.group } : {}),
		title: opts.title,
		caption: opts.caption,
		createdAt: opts.createdAt ?? Date.now(),
	}
	db.items.set(id, item)
	save()
	broadcast({ type: 'item', item })
	return item
}

/** Full documents are kept as they are; fragments get a minimal page: UTF-8, no margin, white background. */
function htmlDocument(html: string) {
	if (/^\s*(<!--[\s\S]*?-->\s*)*<(!doctype|html|head)\b/i.test(html)) return html
	return (
		'<!doctype html>\n<html><head><meta charset="utf-8">' +
		'<style>html{background:#fff;color:#111;font-family:system-ui,sans-serif}body{margin:0}</style>' +
		'</head><body>\n' + html + '\n</body></html>\n'
	)
}

/** An HTML item's "width"/"height": a CSS pixel size, clamped to sane bounds. */
function sizeField(value: unknown, name: string): number | undefined {
	if (value === undefined || value === null || value === '') return undefined
	const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
	if (!Number.isFinite(n)) throw new HttpError(400, `"${name}" must be a number (CSS pixels)`)
	return Math.round(Math.min(HTML_MAX_SIZE, Math.max(HTML_MIN_SIZE, n)))
}

/** A session's title is a placeholder when it's empty or just the session id. */
const untitled = (s: Session) => !s.title?.trim() || s.title === s.id

/**
 * Gets a session, creating it if needed. `title` renames it (PUT /sessions/:sid). A posted item's
 * `sessionTitle` is passed with `onlyIfUntitled`: it names a new or still untitled session, but
 * never replaces a real title.
 */
function ensureSession(canvasId: string, id: string, title?: string, opts: { onlyIfUntitled?: boolean } = {}): Session {
	const key = sessionKey(canvasId, id)
	const existing = db.sessions.get(key)
	if (existing && (title === undefined || existing.title === title || (opts.onlyIfUntitled && !untitled(existing)))) return existing
	const session: Session = existing
		? { ...existing, title: title! }
		: { id, canvasId, title: title ?? '', createdAt: Date.now() }
	db.sessions.set(key, session)
	save()
	broadcast({ type: 'session', session })
	return session
}

async function removeItemFiles(item: Item) {
	await rm(join(MEDIA_DIR, item.src.replace('/media/', '')), { force: true })
	if (item.thumb && item.thumb !== item.src) await rm(join(MEDIA_DIR, item.thumb.replace('/media/', '')), { force: true })
}

function sessionItems(canvasId: string, sessionId: string) {
	return [...db.items.values()].filter((i) => i.canvasId === canvasId && i.sessionId === sessionId)
}

/** Moves an item to the trash. Without `keepSession`, a session left empty is trashed too. */
function deleteItem(id: string, opts: { keepSession?: boolean } = {}) {
	const item = db.items.get(id)
	if (!item) return { deleted: false, sessionDeleted: false }
	db.items.delete(id)
	const entry: TrashEntry = { kind: 'item', item, deletedAt: Date.now() }
	trash.set(trashKey(entry), entry)
	save()
	broadcast({ type: 'item_deleted', canvasId: item.canvasId, id })
	// Empty frames disappear for everyone.
	const session = db.sessions.get(sessionKey(item.canvasId, item.sessionId))
	if (!opts.keepSession && session && !sessionItems(item.canvasId, item.sessionId).length) {
		deleteSession(session)
		return { deleted: true, sessionDeleted: true }
	}
	return { deleted: true, sessionDeleted: false }
}

/** Moves a session and all its items to the trash. */
function deleteSession(session: Session) {
	const items = sessionItems(session.canvasId, session.id)
	for (const item of items) deleteItem(item.id, { keepSession: true })
	db.sessions.delete(sessionKey(session.canvasId, session.id))
	const entry: TrashEntry = { kind: 'session', session, itemIds: items.map((i) => i.id), deletedAt: Date.now() }
	trash.set(trashKey(entry), entry)
	save()
	broadcast({ type: 'session_deleted', canvasId: session.canvasId, id: session.id })
}

/** Takes a session out of the trash (with the items deleted along with it). */
function restoreSession(canvasId: string, sessionId: string, restored: { sessions: Session[]; items: Item[] }) {
	const key = `session:${sessionKey(canvasId, sessionId)}`
	const entry = trash.get(key)
	if (entry?.kind !== 'session') return
	trash.delete(key)
	// The session may have been recreated since (by posting to it again): then only its items come back.
	if (!db.sessions.has(sessionKey(canvasId, sessionId))) {
		db.sessions.set(sessionKey(canvasId, sessionId), entry.session)
		broadcast({ type: 'session', session: entry.session })
		restored.sessions.push(entry.session)
	}
	save()
	for (const id of entry.itemIds) restoreItem(canvasId, id, restored)
}

/** Takes an item out of the trash, bringing back its session first if that was deleted too. */
function restoreItem(canvasId: string, id: string, restored: { sessions: Session[]; items: Item[] }) {
	const entry = trash.get(`item:${id}`)
	if (entry?.kind !== 'item' || entry.item.canvasId !== canvasId || db.items.has(id)) return
	const { item } = entry
	if (!db.sessions.has(sessionKey(canvasId, item.sessionId))) {
		restoreSession(canvasId, item.sessionId, restored)
		// The session restore may have brought this item back already.
		if (db.items.has(id)) return
		if (!db.sessions.has(sessionKey(canvasId, item.sessionId))) ensureSession(canvasId, item.sessionId)
	}
	trash.delete(`item:${id}`)
	db.items.set(id, item)
	save()
	broadcast({ type: 'item', item })
	restored.items.push(item)
}

function restore(canvasId: string, sessionIds: string[], itemIds: string[]) {
	const restored: { sessions: Session[]; items: Item[] } = { sessions: [], items: [] }
	for (const id of sessionIds) restoreSession(canvasId, id, restored)
	for (const id of itemIds) restoreItem(canvasId, id, restored)
	return restored
}

/** Permanently removes trash older than TRASH_MS (or everything of one canvas), with its files. */
async function purgeTrash(opts: { canvasId?: string } = {}) {
	const cutoff = Date.now() - TRASH_MS
	let changed = false
	for (const [key, entry] of [...trash]) {
		const canvasId = entry.kind === 'item' ? entry.item.canvasId : entry.session.canvasId
		if (opts.canvasId ? canvasId !== opts.canvasId : entry.deletedAt > cutoff) continue
		trash.delete(key)
		changed = true
		if (entry.kind === 'item') await removeItemFiles(entry.item)
	}
	if (changed) save()
}

await purgeTrash()
setInterval(() => purgeTrash().catch((e) => console.error('trash sweep failed:', e)), TRASH_SWEEP_MS)

function idList(value: unknown, name: string): string[] {
	if (value === undefined || value === null) return []
	if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new HttpError(400, `"${name}" must be an array of strings`)
	return value as string[]
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
	conjured.dropCanvas(canvas.id)
	attention.dropCanvas(canvas.id)
	for (const session of canvasSessions(canvas.id)) deleteSession(session)
	// items whose session record is missing, just in case
	for (const item of [...db.items.values()]) if (item.canvasId === canvas.id) deleteItem(item.id)
	// A deleted canvas can't be restored, so its trash goes right away.
	await purgeTrash({ canvasId: canvas.id })
	await discardRoom(`canvas-${canvas.id}`)
	await rm(roomFile(canvas.id), { force: true })
	save()
	broadcast({ type: 'canvas_deleted', id: canvas.id })
}

// ---------- room state (presence, notes) ----------

/** Who's on a canvas right now: the awareness states of its room. Empty when nobody has it open. */
function presence(canvasId: string): PresenceEntry[] {
	const snapshot = getRoomSnapshot(`canvas-${canvasId}`)
	if (!snapshot) return []
	const entries: PresenceEntry[] = []
	for (const [clientId, state] of snapshot.states) {
		const user = state?.user as Partial<PresenceEntry['user']> | undefined
		if (!user || typeof user !== 'object') continue
		entries.push({
			clientId,
			user: {
				name: String(user.name ?? ''),
				color: String(user.color ?? ''),
				...(user.agent === true ? { agent: true } : {}),
				...(user.conjured === true ? { conjured: true } : {}),
				...(typeof user.sessionId === 'string' ? { sessionId: user.sessionId } : {}),
				...(typeof user.serverKey === 'string' ? { serverKey: user.serverKey } : {}),
			},
			selection: Array.isArray(state.selection) ? state.selection.filter((s): s is string => typeof s === 'string') : [],
			cursor: (state.cursor as PresenceEntry['cursor']) ?? null,
			view: (state.view as PresenceEntry['view']) ?? null,
			chat: typeof state.chat === 'string' ? state.chat : null,
			...(typeof state.chatSent === 'boolean' ? { chatSent: state.chatSent } : {}),
			...(user.conjured === true ? { thinking: state.thinking === true } : {}),
		})
	}
	return entries.sort((a, b) => a.clientId - b.clientId)
}

/** Sticky notes in a room document (map "notes": id -> Y.Map {x, y, color, author, createdAt, text: Y.Text}). */
function readNotes(doc: Y.Doc): Note[] {
	const notes: Note[] = []
	for (const [id, note] of doc.getMap<Y.Map<unknown>>('notes')) {
		if (!(note instanceof Y.Map)) continue
		const text = note.get('text')
		notes.push({
			id,
			text: text instanceof Y.Text ? text.toString() : typeof text === 'string' ? text : '',
			author: String(note.get('author') ?? ''),
			color: String(note.get('color') ?? ''),
			x: Number(note.get('x') ?? 0),
			y: Number(note.get('y') ?? 0),
			createdAt: Number(note.get('createdAt') ?? 0),
		})
	}
	return notes.sort((a, b) => a.createdAt - b.createdAt)
}

/** Annotations in a room document (map "annotations": id -> Y.Map, see Annotation in shared/types.ts). */
function readAnnotations(doc: Y.Doc): Annotation[] {
	const list: Annotation[] = []
	for (const [id, a] of doc.getMap<Y.Map<unknown>>('annotations')) {
		if (!(a instanceof Y.Map)) continue
		const num = (key: string) => Number(a.get(key) ?? 0) || 0
		const updatedAt = num('updatedAt')
		list.push({
			id,
			itemId: String(a.get('itemId') ?? ''),
			x: num('x'),
			y: num('y'),
			ox: num('ox'),
			oy: num('oy'),
			...(num('len') ? { len: num('len') } : {}),
			text: String(a.get('text') ?? ''),
			author: String(a.get('author') ?? ''),
			color: String(a.get('color') ?? ''),
			createdAt: num('createdAt'),
			...(updatedAt ? { updatedAt } : {}),
		})
	}
	return list.sort((a, b) => a.createdAt - b.createdAt)
}

/**
 * A canvas's annotations resolved against their items, oldest first, optionally only those on one
 * session's items or one item. Annotations on deleted items are left out (they come back with an undo).
 */
async function annotationViews(canvasId: string, filter: { sessionId?: string; itemId?: string } = {}): Promise<AnnotationView[]> {
	const canvas = getCanvas(canvasId)
	const views: AnnotationView[] = []
	for (const a of await readRoomDoc(`canvas-${canvas.id}`, readAnnotations)) {
		const item = db.items.get(a.itemId)
		if (!item || item.canvasId !== canvas.id) continue
		if (filter.itemId && item.id !== filter.itemId) continue
		if (filter.sessionId && item.sessionId !== filter.sessionId) continue
		const x = clamp01(a.x)
		const y = clamp01(a.y)
		const sessionTitle = db.sessions.get(sessionKey(canvas.id, item.sessionId))?.title
		views.push({
			id: a.id,
			text: a.text,
			author: a.author,
			createdAt: a.createdAt,
			...(a.updatedAt ? { updatedAt: a.updatedAt } : {}),
			item: {
				id: item.id,
				kind: item.kind,
				name: item.name,
				...(item.title ? { title: item.title } : {}),
				...(item.group ? { group: item.group } : {}),
				sessionId: item.sessionId,
				...(sessionTitle ? { sessionTitle } : {}),
				width: item.width,
				height: item.height,
				url: /^https?:/.test(item.src) ? item.src : MEDIA_ORIGIN + item.src,
				link: `${WEB_BASE}/c/${canvas.id}#item=${encodeURIComponent(item.id)}`,
			},
			anchor: { x: round4(x), y: round4(y), px: Math.round(x * item.width), py: Math.round(y * item.height) },
		})
	}
	return views
}

/** A bold font for ffmpeg's drawtext, if fontconfig can find one (the number is left off otherwise). */
let markFont: Promise<string | null> | null = null
function findMarkFont() {
	markFont ??= Bun.which('fc-match')
		? run(['fc-match', '-f', '%{file}', 'sans:bold']).then((f) => (f.trim() && existsSync(f.trim()) ? f.trim() : null), () => null)
		: Promise.resolve(null)
	return markFont
}

/**
 * GET /api/canvases/:cid/annotations/:id/image: the annotated image (a video's poster frame) as a
 * PNG, with a red ring around the anchor and the annotation's number on its item beside it.
 */
async function markedImage(canvasId: string, annotationId: string): Promise<Response> {
	if (!HAS_FFMPEG) throw new HttpError(501, 'marking images needs ffmpeg on the canvas server')
	const all = await annotationViews(canvasId)
	const a = all.find((v) => v.id === annotationId)
	if (!a) throw new HttpError(404, `no annotation ${annotationId} on this canvas`)
	const item = getItem(a.item.id)
	if (item.kind === 'html') throw new HttpError(400, 'HTML items have no image to mark; use the anchor\'s px/py on the page')
	const src = item.kind === 'video' ? item.thumb : item.src
	if (/^https?:/.test(src)) throw new HttpError(400, 'this item\'s media is not stored on the canvas server')
	const input = join(MEDIA_DIR, basename(src))
	const size = await probe(input)
	const number = all.filter((v) => v.item.id === item.id).findIndex((v) => v.id === a.id) + 1
	const cx = Math.round(a.anchor.x * size.width)
	const cy = Math.round(a.anchor.y * size.height)
	const r = Math.max(12, Math.round(Math.min(size.width, size.height) * 0.035))
	const stroke = Math.max(3, Math.round(r / 4))
	const half = r + stroke + 3
	const side = half * 2
	// The ring: red, with a thin white edge so it shows on any background.
	const ring = new Uint8Array(side * side * 4)
	for (let py = 0; py < side; py++) {
		for (let px = 0; px < side; px++) {
			const off = Math.abs(Math.hypot(px + 0.5 - half, py + 0.5 - half) - r)
			const red = Math.min(1, Math.max(0, stroke / 2 + 0.5 - off))
			const edge = Math.min(1, Math.max(0, stroke / 2 + 2 - off))
			const i = (py * side + px) * 4
			ring[i] = 255
			ring[i + 1] = ring[i + 2] = Math.round(255 * (1 - red))
			ring[i + 3] = Math.round(255 * edge)
		}
	}
	const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
	const ringFile = join(DATA_DIR, `.mark-${stamp}.rgba`)
	const output = join(DATA_DIR, `.mark-${stamp}.png`)
	try {
		await Bun.write(ringFile, ring)
		const font = await findMarkFont()
		const fontSize = Math.max(14, Math.round(r * 1.1))
		const text = font
			? `,drawtext=fontfile='${font.replace(/'/g, '')}':text='${number}':fontsize=${fontSize}:fontcolor=white:box=1:boxcolor=red:` +
				`boxborderw=${Math.round(fontSize / 4)}:x='min(max(0,${cx + half}),w-tw)':y='min(max(0,${cy - half - fontSize}),h-th)'`
			: ''
		await run([
			'ffmpeg', '-y', '-v', 'error', '-i', input,
			'-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${side}x${side}`, '-i', ringFile,
			'-filter_complex', `[0:v][1:v]overlay=${cx - half}:${cy - half}:format=auto${text}`,
			'-frames:v', '1', output,
		])
		const bytes = await Bun.file(output).arrayBuffer()
		return new Response(bytes, { headers: { 'content-type': 'image/png', 'cache-control': 'no-store' } })
	} finally {
		await rm(ringFile, { force: true })
		await rm(output, { force: true })
	}
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const round4 = (v: number) => Math.round(v * 10000) / 10000

/** Everyone's selection on a canvas, resolved into items, session frames and notes. */
async function resolveSelections(canvasId: string): Promise<ResolvedSelection[]> {
	const people = presence(canvasId)
	if (!people.length) return []
	const notes = new Map((await readRoomDoc(`canvas-${canvasId}`, readNotes)).map((n) => [n.id, n]))
	return people.map(({ clientId, user, selection }) => {
		const resolved: ResolvedSelection = { clientId, user, selection, items: [], sessions: [], notes: [], missing: [] }
		for (const key of selection) {
			if (key.startsWith('frame:')) {
				const session = db.sessions.get(sessionKey(canvasId, key.slice(6)))
				if (session) resolved.sessions.push({ ...session, itemCount: sessionItems(canvasId, session.id).length })
				else resolved.missing.push(key)
			} else if (key.startsWith('note:')) {
				const note = notes.get(key.slice(5))
				if (note) resolved.notes.push(note)
				else resolved.missing.push(key)
			} else {
				const item = db.items.get(key)
				if (item?.canvasId === canvasId) {
					resolved.items.push({ ...item, url: MEDIA_ORIGIN + item.src, thumbUrl: MEDIA_ORIGIN + item.thumb })
				} else resolved.missing.push(key)
			}
		}
		return resolved
	})
}

// ---------- http ----------

/** GET /api: a short, self-describing map of the API for agents. */
const API_INDEX = {
	about:
		'Review canvases. There are several canvases, each with its own id (:cid). On a canvas, each OpenCode ' +
		'session is one frame; inside it, items (images, videos or HTML pages) are organised into named groups. Use your exact ' +
		'$OPENCODE_SESSION_ID as the session id; the same session can post to several canvases.',
	mcp:
		'This server is also an MCP server (Streamable HTTP) at /mcp (or /canvas/mcp): tools only, for everything ' +
		'below: list_canvases, get_canvas, create_canvas, get_selection, get_presence, list_notes, list_annotations, find_items, ' +
		'get_item, post_item, update_item, delete_item, restore, plus say and highlight, which queue things for ' +
		'people to look at on your session\'s creature. OpenCode config: ' +
		`{"mcp": {"canvas": {"type": "remote", "url": "http://localhost:${PORT}/mcp"}}}. Pass your $OPENCODE_SESSION_ID ` +
		'as "sessionId" and your session\'s title as "sessionTitle" to post_item, say and highlight.',
	endpoints: {
		'GET /api/canvases': 'All canvases, newest first, with session/item counts and preview thumbnails',
		'POST /api/canvases': 'Create a canvas. Body: {"title"} (optional). Returns it, with its id and viewKey',
		'GET /api/canvases/:cid': 'One canvas with all its sessions and items',
		'PATCH /api/canvases/:cid': 'Rename a canvas. Body: {"title"}',
		'DELETE /api/canvases/:cid': 'Delete a canvas with all its sessions, items and notes',
		'GET /api/canvases/:cid/autoseed': 'Whether the canvas has been seeded automatically: {"autoSeededAt"} (ms, or null)',
		'POST /api/canvases/:cid/autoseed':
			'Claim the canvas\'s one automatic seeding (browsers do this before seeding a new canvas with their latest ' +
			'OpenCode sessions): {"ok": true, "autoSeededAt"} for the first caller, 409 for anyone after',
		'GET /api/view/:viewKey': 'A canvas by its view-only key (same body as GET /api/canvases/:cid)',
		'GET /api/canvases/:cid/sessions': 'The canvas\'s sessions, each with its groups and their items, in canvas order',
		'GET /api/canvases/:cid/sessions/:sessionId': 'One session with its groups and items',
		'PUT /api/canvases/:cid/sessions/:sessionId': 'Create or rename a session. Body: {"title"} (always replaces the title, unlike a post\'s "sessionTitle")',
		'DELETE /api/canvases/:cid/sessions/:sessionId': 'Delete a session and all its items (restorable for an hour, see restore)',
		'POST /api/canvases/:cid/sessions/:sessionId/items':
			'Add an image, video or HTML page. JSON {"path"} (file on this machine) or {"url"}, or multipart "file"; ' +
			'or JSON {"html": "<html source>"} for an HTML item. Plus optional "group", "title", "caption", "name". ' +
			'Send "sessionTitle" (your OpenCode session\'s title, from `opencode api get /api/session/$OPENCODE_SESSION_ID` ' +
			'→ .data.title) with every post, JSON or multipart: it names the session\'s frame when the session is new or ' +
			'still untitled, and never replaces a real title (rename with PUT). Multipart uploads may also send "createdAt" ' +
			'(ms; orders the item in its group). Creates the session if needed.',
		'GET /api/items/:itemId': 'One item',
		'PATCH /api/items/:itemId': 'Change an item\'s "group", "title", "caption" (null clears) or "name"',
		'DELETE /api/items/:itemId':
			'Delete an item (restorable for an hour). Deleting a session\'s last item deletes the session too ' +
			'(the response says {"sessionDeleted": true})',
		'POST /api/canvases/:cid/restore':
			'Undo deletes within an hour of them. Body: {"itemIds": [...], "sessionIds": [...]} (either or both). ' +
			'A session comes back with the items deleted along with it; an item brings back its session if that was ' +
			'deleted too. Returns {"sessions", "items"}: what was restored',
		'PATCH /api/canvases/:cid/sessions/:sessionId/groups/:group': 'Rename a group. Body: {"name"} (null ungroups its items)',
		'DELETE /api/canvases/:cid/sessions/:sessionId/groups/:group': 'Delete a group and all its items (restorable for an hour)',
		'GET /api/canvases/:cid/presence':
			'Who has the canvas open right now: [{"clientId", "user": {"name", "color"}, "selection", "cursor", "view", "chat"}]. ' +
			'selection holds item ids as they are, "frame:<sessionId>" for session frames and "note:<noteId>" for sticky notes; ' +
			'cursor and view are in page coordinates. [] when nobody is there',
		'GET /api/canvases/:cid/notes': 'The canvas\'s sticky notes: [{"id", "text", "author", "color", "x", "y", "createdAt"}]',
		'GET /api/canvases/:cid/annotations':
			'The user\'s annotations: comments pinned to a spot on an item, oldest first. Optional ?sessionId= (only that ' +
			'session\'s items) and ?itemId=. Each: {"id", "text", "author", "createdAt", "item": {"id", "kind", "name", "title", ' +
			'"group", "sessionId", "sessionTitle", "width", "height", "url" (the original file), "link"}, "anchor": {"x", "y" ' +
			'(0..1 across the item), "px", "py" (pixels in the original image: x × width, y × height)}}',
		'GET /api/canvases/:cid/annotations/:id/image':
			'The annotated image (or a video\'s poster frame) as a PNG with the spot marked by a red circle and the ' +
			'annotation\'s number on that item',
		'GET /api/canvases/:cid/selection':
			'What each person on the canvas has selected, resolved: {"users": [{"user", "selection", "items" (full items ' +
			'with absolute "url"/"thumbUrl"), "sessions" (with "itemCount"), "notes", "missing"}]}. Use this to answer ' +
			'"what have I selected?"',
		'GET /api/canvases/:cid/conjured':
			'OpenCode sessions on the canvas as creatures: [{"sessionId", "serverKey", "title", "color", "x", "y", "ownerId", "awake"}]. ' +
			'The canvas server never talks to OpenCode: the owner\'s browser does, and publishes the creature\'s presence (thinking, replies) ' +
			'into the room while its tab is open ("awake"); otherwise it sleeps. Creatures made for attention actions have no owner ("")',
		'POST /api/canvases/:cid/conjured':
			'Conjure an OpenCode session as a creature. Body: {"sessionId", "serverKey" (non-secret id of its OpenCode), "ownerId" ' +
			'(the owner browser\'s random id), "title"?, "x", "y"} (page position). Adopts an ownerless one; 409 if that session is already here',
		'PATCH /api/canvases/:cid/conjured/:sessionId': 'Move and/or rename a creature. Body: {"x", "y"} and/or {"title"}',
		'DELETE /api/canvases/:cid/conjured/:sessionId': 'Banish a creature (and clear its attention queue)',
		'GET /api/canvases/:cid/actions': 'Every queued attention action on the canvas, oldest first: [{"id", "sessionId", "kind", "text"?, "target"?, "createdAt"}]',
		'GET /api/canvases/:cid/sessions/:sessionId/actions': 'The session\'s queued attention actions, in order',
		'POST /api/canvases/:cid/sessions/:sessionId/actions':
			'Queue something for people to look at, on the session\'s creature (made beside its frame if it has none). Body: ' +
			'{"kind": "say", "text"} (Markdown) or {"kind": "highlight", "target", "text"?} with target an item id, ' +
			'"<sessionId>/<group name>", "frame:<sessionId>" or "note:<noteId>"; plus "sessionTitle" (names a new creature). ' +
			'Returns {"id", "position", "queued", "action"}. Fire-and-forget: people step through the queue on the canvas',
		'DELETE /api/canvases/:cid/sessions/:sessionId/actions': 'Clear the session\'s queue: {"ok", "cleared"}',
		'DELETE /api/canvases/:cid/sessions/:sessionId/actions/:actionId': 'Mark one action done (removes it): {"ok", "done"}',
	},
	items:
		'Every item has a "name": its file name. On upload it is the original file name (the path\'s basename, the ' +
		'URL\'s last path segment or the multipart file name); inline {"html"} items get "<title or id>.html". Send ' +
		'"name" to choose it yourself.',
	html:
		'HTML items are for diagrams, charts, SVG drawings and annotated explanations. Send {"html", "width", ' +
		'"height"} (or a .html/.htm file by path, url or multipart, with "width"/"height" as fields). width/height ' +
		`are the CSS pixel size the page is designed for (default ${HTML_DEFAULT_SIZE.width}x${HTML_DEFAULT_SIZE.height}, ` +
		`clamped to ${HTML_MIN_SIZE}-${HTML_MAX_SIZE}); the page is laid out at that size and scaled with the canvas, so ` +
		'it stays crisp at any zoom. Max 2 MB. It runs in a sandboxed iframe (scripts allowed, no same-origin access, ' +
		'no interaction: the canvas takes all input) so make it static and fit the given size without scrolling. ' +
		'A fragment is wrapped in a minimal page (UTF-8, no margin, white background); send a full document to ' +
		'control everything. Inline everything (styles, scripts, images as data: URLs).',
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

// ---------- cross-origin access ----------
// The app can also be served from the user's own machine (`bunx opencode-canvas` serves it on
// http://localhost:<port>, so it can talk to their local OpenCode), and then uses this server's API,
// media and WebSockets from there. So besides this server's own pages, http://localhost:* and
// http://127.0.0.1:* may use it too. Nothing here is behind cookies, so this exposes nothing new.

const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/
/** origins of this server's own pages: where people open canvases (CANVAS_WEB), plus CANVAS_ORIGINS (comma separated) */
const OWN_ORIGINS = new Set(
	[WEB_BASE, ...(process.env.CANVAS_ORIGINS ?? '').split(',')]
		.map((u) => {
			try {
				return new URL(u.trim()).origin
			} catch {
				return ''
			}
		})
		.filter(Boolean),
)

/** The request's Origin when it may use this server cross-origin (localhost pages), else null. */
function corsOrigin(req: Request): string | null {
	const origin = req.headers.get('origin')
	return origin && LOCAL_ORIGIN.test(origin) ? origin : null
}

/**
 * WebSockets aren't covered by CORS, so rooms and live events check the Origin themselves: no
 * Origin (not a browser), the page's own host, this server's public pages, or localhost.
 */
function socketOriginAllowed(req: Request): boolean {
	const origin = req.headers.get('origin')
	if (!origin || LOCAL_ORIGIN.test(origin) || OWN_ORIGINS.has(origin)) return true
	try {
		const host = new URL(origin).host
		return host === req.headers.get('host') || host === req.headers.get('x-forwarded-host')
	} catch {
		return false
	}
}

function withCors(req: Request, res: Response): Response {
	const origin = corsOrigin(req)
	if (!origin) return res
	try {
		res.headers.set('access-control-allow-origin', origin)
		res.headers.append('vary', 'Origin')
		res.headers.set('access-control-expose-headers', 'content-length, content-range, accept-ranges')
		// Private Network Access: a page on localhost may reach this server's private address.
		if (req.headers.get('access-control-request-private-network') === 'true') res.headers.set('access-control-allow-private-network', 'true')
		return res
	} catch {
		// immutable headers (a static Response): copy it
		const copy = new Response(res.body, res)
		return withCors(req, copy)
	}
}

function preflight(req: Request): Response {
	const origin = corsOrigin(req)
	if (!origin) return new Response(null, { status: 204 })
	const headers: Record<string, string> = {
		'access-control-allow-origin': origin,
		'access-control-allow-methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
		'access-control-allow-headers': req.headers.get('access-control-request-headers') ?? 'content-type',
		'access-control-max-age': '86400',
		vary: 'Origin',
	}
	if (req.headers.get('access-control-request-private-network') === 'true') headers['access-control-allow-private-network'] = 'true'
	return new Response(null, { status: 204, headers })
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
	// lets `bunx opencode-canvas` recognise an instance of itself already on the port
	if (p === '/api/health' && method === 'GET') return json({ app: 'opencode-canvas', web: WEB_BASE })

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

	m = /^\/api\/canvases\/([^/]+)\/autoseed$/.exec(p)
	if (m) {
		const canvas = getCanvas(decodeURIComponent(m[1]))
		if (method === 'GET') return json({ autoSeededAt: canvas.autoSeededAt ?? null })
		if (method === 'POST') {
			// Once per canvas, ever: emptying it later doesn't seed it again.
			if (canvas.autoSeededAt) return json({ error: 'this canvas was already seeded automatically', autoSeededAt: canvas.autoSeededAt }, 409)
			const next: Canvas = { ...canvas, autoSeededAt: Date.now() }
			db.canvases.set(next.id, next)
			save()
			broadcast({ type: 'canvas', canvas: next })
			return json({ ok: true, autoSeededAt: next.autoSeededAt })
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
			deleteSession(getSession(canvas.id, id))
			return json({ ok: true })
		}
	}

	m = /^\/api\/canvases\/([^/]+)\/restore$/.exec(p)
	if (m && method === 'POST') {
		const canvas = getCanvas(decodeURIComponent(m[1]))
		const body = (await req.json().catch(() => ({}))) as { itemIds?: unknown; sessionIds?: unknown }
		const sessionIds = idList(body?.sessionIds, 'sessionIds')
		const itemIds = idList(body?.itemIds, 'itemIds')
		if (!sessionIds.length && !itemIds.length) throw new HttpError(400, 'send {"itemIds": [...]} and/or {"sessionIds": [...]}')
		return json(restore(canvas.id, sessionIds, itemIds))
	}

	// ---- live room state: presence, notes, selections ----

	m = /^\/api\/canvases\/([^/]+)\/annotations$/.exec(p)
	if (m && method === 'GET') {
		const q = new URL(req.url).searchParams
		return json(await annotationViews(decodeURIComponent(m[1]), { sessionId: q.get('sessionId') ?? undefined, itemId: q.get('itemId') ?? undefined }))
	}

	m = /^\/api\/canvases\/([^/]+)\/annotations\/([^/]+)\/image$/.exec(p)
	if (m && method === 'GET') return markedImage(decodeURIComponent(m[1]), decodeURIComponent(m[2]))

	m = /^\/api\/canvases\/([^/]+)\/(presence|notes|selection)$/.exec(p)
	if (m && method === 'GET') {
		const canvas = getCanvas(decodeURIComponent(m[1]))
		if (m[2] === 'presence') return json(presence(canvas.id))
		if (m[2] === 'notes') return json(await readRoomDoc(`canvas-${canvas.id}`, readNotes))
		return json({ canvasId: canvas.id, users: await resolveSelections(canvas.id) })
	}

	// ---- conjured worms (records only: owners' browsers run them) ----

	m = /^\/api\/canvases\/([^/]+)\/conjured$/.exec(p)
	if (m) {
		const canvas = getCanvas(decodeURIComponent(m[1]))
		if (method === 'GET') return json(conjuredWorms(canvas.id))
		if (method === 'POST') {
			const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
			return json(conjured.conjure(canvas.id, body), 201)
		}
	}

	m = /^\/api\/canvases\/([^/]+)\/conjured\/([^/]+)$/.exec(p)
	if (m && method === 'DELETE') {
		const canvas = getCanvas(decodeURIComponent(m[1]))
		const sessionId = decodeURIComponent(m[2])
		conjured.banish(canvas.id, sessionId)
		attention.clear(canvas.id, sessionId)
		return json({ ok: true })
	}
	if (m && method === 'PATCH') {
		const canvas = getCanvas(decodeURIComponent(m[1]))
		const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
		return json(conjured.update(canvas.id, decodeURIComponent(m[2]), body))
	}

	// ---- attention: what creatures want people to look at ----

	m = /^\/api\/canvases\/([^/]+)\/actions$/.exec(p)
	if (m && method === 'GET') return json(attention.list(getCanvas(decodeURIComponent(m[1])).id))

	m = /^\/api\/canvases\/([^/]+)\/sessions\/([^/]+)\/actions$/.exec(p)
	if (m) {
		const canvas = getCanvas(decodeURIComponent(m[1]))
		const sessionId = decodeURIComponent(m[2])
		if (method === 'GET') return json(attention.list(canvas.id, sessionId))
		if (method === 'POST') {
			const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
			const { action, position, queued } = await attention.queue(canvas.id, sessionId, body)
			return json({ id: action.id, position, queued, action }, 201)
		}
		if (method === 'DELETE') return json({ ok: true, cleared: attention.clear(canvas.id, sessionId) })
	}

	m = /^\/api\/canvases\/([^/]+)\/sessions\/([^/]+)\/actions\/([^/]+)$/.exec(p)
	if (m && method === 'DELETE') {
		const canvas = getCanvas(decodeURIComponent(m[1]))
		return json({ ok: true, done: attention.done(canvas.id, decodeURIComponent(m[2]), decodeURIComponent(m[3])) })
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
			let sessionDeleted = false
			for (const item of items) sessionDeleted = deleteItem(item.id).sessionDeleted || sessionDeleted
			return json({ ok: true, deleted: items.length, sessionDeleted })
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
				// browsers send multipart text with CRLF line breaks
				caption: textField(form.get('caption'))?.replace(/\r\n?/g, '\n'),
				name: nameField(form.get('name') ?? undefined),
				width: sizeField(form.get('width') ?? undefined, 'width'),
				height: sizeField(form.get('height') ?? undefined, 'height'),
				createdAt: timeField(form.get('createdAt')),
				sessionTitle: textField(form.get('sessionTitle'))?.slice(0, TITLE_MAX),
			}
			const filename = file instanceof File ? file.name : undefined
			return json(await addItem(canvasId, sessionId, file, { filename, ...meta }), 201)
		}
		return json(await addItemFromJson(canvasId, sessionId, (await req.json().catch(() => null)) as ItemJson | null), 201)
	}

	m = /^\/api\/items\/([^/]+)$/.exec(p)
	if (m) {
		const item = getItem(decodeURIComponent(m[1]))
		if (method === 'GET') return json(item)
		if (method === 'PATCH') {
			const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
			return json(updateItem(item, itemChanges(body)))
		}
		if (method === 'DELETE') {
			const { sessionDeleted } = deleteItem(item.id)
			return json({ ok: true, sessionDeleted })
		}
	}

	m = /^\/media\/([\w.-]+)$/.exec(p)
	if (m && method === 'GET') {
		const path = join(MEDIA_DIR, m[1])
		if (!existsSync(path)) throw new HttpError(404, 'not found')
		const res = serveFile(req, path, 'public, max-age=31536000, immutable')
		// Agent-written HTML gets an opaque origin even when opened directly, so it can't use this site's cookies or API.
		if (HTML_EXTS.has(extname(path).toLowerCase())) res.headers.set('content-security-policy', 'sandbox allow-scripts')
		return res
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

const mcp = createCanvasMcp({
	listCanvases: () => [...db.canvases.values()].sort((a, b) => b.createdAt - a.createdAt).map(canvasSummary),
	getCanvas,
	canvasByViewKey(key) {
		const canvas = [...db.canvases.values()].find((c) => c.viewKey === key)
		if (!canvas) throw new HttpError(404, 'canvas not found')
		return canvas
	},
	canvasData: (id) => canvasData(getCanvas(id)),
	sessionViews: (canvasId) => canvasSessions(canvasId).sort((a, b) => a.createdAt - b.createdAt).map(sessionView),
	notes: (canvasId) => readRoomDoc(`canvas-${canvasId}`, readNotes),
	annotations: annotationViews,
	presence,
	selections: resolveSelections,
	createCanvas: (title) => createCanvas(canvasTitle(title)),
	getItem,
	addItem: (canvasId, sessionId, body) => addItemFromJson(getCanvas(canvasId).id, assertSessionId(sessionId), body as ItemJson),
	updateItem: (id, changes) => updateItem(getItem(id), itemChanges(changes)),
	deleteItem: (id) => deleteItem(getItem(id).id),
	restore,
	queueAction: (canvasId, sessionId, body) => attention.queue(getCanvas(canvasId).id, sessionId, body),
	mediaFile: (src) => Bun.file(join(MEDIA_DIR, basename(src))),
	mediaOrigin: MEDIA_ORIGIN,
	webBase: WEB_BASE,
})

Bun.serve<SocketData, never>({
	port: PORT,
	hostname: HOSTNAME,
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
		const path = stripBase(reqUrl.pathname)
		const upgrade = path === '/api/live' || path.startsWith('/api/rooms/')
		if (upgrade && !socketOriginAllowed(req)) return json({ error: 'this origin may not connect' }, 403)
		if (req.method === 'OPTIONS' && path !== '/mcp') return preflight(req)
		if (path === '/mcp') {
			try {
				return await mcp.handle(req)
			} catch (e) {
				console.error('mcp request failed:', e)
				return json({ jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: null }, 500)
			}
		}
		const res = await route(req, server, reqUrl)
		return res && withCors(req, res)
	},
})

/** Everything but /mcp and preflights: WebSocket upgrades (undefined once upgraded), then the HTTP API and files. */
async function route(req: Request, server: Server<SocketData>, reqUrl: URL): Promise<Response | undefined> {
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
		if (e instanceof HttpError || e instanceof ConjureError || e instanceof AttentionError) return json({ error: e.message }, e.status)
		console.error(e)
		return json({ error: 'internal error' }, 500)
	}
}

if (!process.env.CANVAS_QUIET) console.log(`canvas server on http://localhost:${PORT}  (data: ${DATA_DIR})`)
