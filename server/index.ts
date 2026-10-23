import { mkdir, rename, rm } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import * as Y from 'yjs'
import { frameTitle } from '../shared/sessionTitle'
import type {
	Annotation, AnnotationView, Canvas, CanvasData, CanvasSummary, Item, ItemDelivery, MediaKind, Note, NoteAnchor, OpenCodeSessionInfo, PresenceEntry, ResolvedSelection,
	ServerEvent, Session, SessionLink, SessionView,
} from '../shared/types'
import { computeLayout, orderSessions } from '../web/src/editor/layout'
import { AttentionError, createAttention, noteFrom } from './attention'
import { createBusy } from './busy'
import { imageSize } from './imageSize'
import { createLinks, LinkError } from './links'
import { createCanvasMcp } from './mcp'
import { changeRoomDoc, discardRoom, getRoomSnapshot, readRoomDoc, roomSockets, setRoomPersistence, type RoomSocketData } from './rooms'
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
	/** which OpenCode session each linked frame talks to (see links.ts) */
	links?: SessionLink[]
}

/**
 * Deleted items and sessions, and annotations agents have read, wait in the trash for TRASH_MS
 * (their files stay on disk), so they can be restored with POST /api/canvases/:cid/restore.
 * They're hidden from every API response.
 */
type TrashEntry =
	| { kind: 'item'; item: Item; deletedAt: number }
	/** itemIds: the items that were deleted along with the session */
	| { kind: 'session'; session: Session; itemIds: string[]; deletedAt: number }
	/** fields: the annotation's Y.Map entries in the room document, as they were */
	| { kind: 'annotation'; canvasId: string; id: string; fields: Record<string, unknown>; deletedAt: number }

const TRASH_MS = 60 * 60 * 1000
const TRASH_SWEEP_MS = 5 * 60 * 1000

/** Sessions are keyed by canvas and session id: one OpenCode session can post to several canvases. */
const sessionKey = (canvasId: string, sessionId: string) => `${canvasId}/${sessionId}`

const db: { canvases: Map<string, Canvas>; sessions: Map<string, Session>; items: Map<string, Item> } = {
	canvases: new Map(),
	sessions: new Map(),
	items: new Map(),
}
/** keyed "item:<id>", "session:<canvasId>/<sessionId>" and "annotation:<id>" */
const trash = new Map<string, TrashEntry>()
let storedLinks: unknown[] = []
const trashKey = (entry: TrashEntry) =>
	entry.kind === 'item'
		? `item:${entry.item.id}`
		: entry.kind === 'session'
			? `session:${sessionKey(entry.session.canvasId, entry.session.id)}`
			: `annotation:${entry.id}`
const trashCanvas = (entry: TrashEntry) =>
	entry.kind === 'item' ? entry.item.canvasId : entry.kind === 'session' ? entry.session.canvasId : entry.canvasId

if (existsSync(INDEX_FILE)) {
	const stored = (await Bun.file(INDEX_FILE).json()) as StoredIndex
	for (const c of stored.canvases) db.canvases.set(c.id, c)
	for (const s of stored.sessions) db.sessions.set(sessionKey(s.canvasId, s.id), storedSession(s))
	for (const i of stored.items) db.items.set(i.id, withName(i))
	for (const t of stored.trash ?? []) trash.set(trashKey(t), t.kind === 'item' ? { ...t, item: withName(t.item) } : t)
	storedLinks = stored.links ?? []
}

/** Sessions saved before frames followed OpenCode keep their title as the posted one, until OpenCode reports theirs. */
function storedSession(s: Session): Session {
	if (s.postedTitle !== undefined || s.opencode || !s.title) return s
	return { ...s, postedTitle: s.title }
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
		links: links.all(),
	}
}

const links = createLinks(
	{
		canvasExists: (id) => db.canvases.has(id),
		save,
		broadcast: (event) => broadcast(event),
	},
	storedLinks,
)

/** Which sessions are working, as the edit tabs paired with their OpenCode report it (see busy.ts). */
const busy = createBusy({
	hasSession: (canvasId, sessionId) => db.sessions.has(sessionKey(canvasId, sessionId)),
	broadcast: (event) => broadcast(event),
})

/** Agent sticky notes (MCP say / highlight), kept in each canvas's room document (see attention.ts). */
const attention = createAttention({
	canvasExists: (id) => db.canvases.has(id),
	resolveTarget: (canvasId, target) => resolveTarget(canvasId, target),
	itemSize: (target) => {
		const item = db.items.get(target)
		return item ? { width: item.width, height: item.height } : null
	},
	nameSession: (canvasId, sessionId, title, create) => {
		// The agent's title is a fallback, shown until a paired browser reports the session from OpenCode.
		if (create || db.sessions.has(sessionKey(canvasId, sessionId))) ensureSession(canvasId, sessionId, { postedTitle: title })
	},
	sessionTitle: (canvasId, sessionId) => db.sessions.get(sessionKey(canvasId, sessionId))?.title ?? '',
	roughPosition: (canvasId, sessionId, anchor) => roughNotePosition(canvasId, sessionId, anchor),
	readDoc: (canvasId, read) => readRoomDoc(`canvas-${canvasId}`, read),
	changeDoc: (canvasId, change) => changeRoomDoc(`canvas-${canvasId}`, change),
})

/** Page size of a sticky note, and the gap an agent's note keeps from what it's placed by (as the browser places them). */
const NOTE_SIZE = { w: 220, h: 180, gap: 24 }

/**
 * About where an agent's note lands on the page right now, for its stored x/y (what the notes API
 * reports): beside its target, or above the session's frame. Browsers place it exactly, following
 * its target as the layout changes (see web/src/multiplayer/notePlacement.ts).
 */
function roughNotePosition(canvasId: string, sessionId: string, anchor: NoteAnchor): { x: number; y: number } {
	const items = [...db.items.values()].filter((i) => i.canvasId === canvasId)
	const layout = computeLayout(
		Object.fromEntries(canvasSessions(canvasId).map((s) => [s.id, s])),
		Object.fromEntries(items.map((i) => [i.id, i])),
		db.canvases.get(canvasId)?.sessionOrder,
	)
	const { w, h, gap } = NOTE_SIZE
	const target = anchor.target ?? ''
	const item = layout.items.get(target)
	const source = db.items.get(target)
	if (item && source && (anchor.point || anchor.region)) {
		const sx = item.w / source.width
		const sy = item.h / source.height
		const p = anchor.point ?? { x: anchor.region!.x + anchor.region!.w, y: anchor.region!.y }
		return { x: item.x + p.x * sx + gap * 2, y: item.y + p.y * sy - h / 3 }
	}
	if (anchor.at) return { x: anchor.at.x + gap * 2, y: anchor.at.y - h / 3 }
	const group = target.startsWith('group:') ? layout.groups.find((g) => g.id === target.slice(6)) : undefined
	const box = item ?? group?.box
	if (box) return { x: box.x + box.w + gap, y: box.y }
	const frame = layout.sections.find((s) => s.id === sessionId)
	return frame ? { x: frame.box.x, y: frame.box.y - gap - h } : { x: 0, y: -gap - h }
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

/** A canvas's session links, each online while its owner's tab runs it (its live state is in the room). */
function sessionLinks(canvasId: string): SessionLink[] {
	const online = new Set(presence(canvasId).filter((p) => p.user.agent && p.user.sessionId).map((p) => p.user.sessionId))
	return links.list(canvasId).map((r) => ({ ...r, online: online.has(r.sessionId), busy: busy.isBusy(canvasId, r.sessionId) }))
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
		case 'link':
			return event.link.canvasId
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

/**
 * A video's length in seconds, or undefined if it can't be read. Files without one in their header
 * (MediaRecorder WebM) are read to the end for their last frame's time.
 */
async function probeDuration(file: string): Promise<number | undefined> {
	const valid = (n: number) => (Number.isFinite(n) && n > 0 ? Math.round(n * 1000) / 1000 : undefined)
	try {
		const header = await run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file])
		const d = valid(Number(header.trim()))
		if (d !== undefined) return d
		const packets = await run([
			'ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,duration_time', '-of', 'csv=p=0', file,
		])
		let end = 0
		for (const line of packets.split('\n')) {
			const [pts, dur] = line.split(',').map(Number)
			if (Number.isFinite(pts)) end = Math.max(end, pts + (Number.isFinite(dur) ? dur : 0))
		}
		return valid(end)
	} catch {
		return undefined
	}
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
		links: sessionLinks(canvas.id),
		busy: busy.list(canvas.id),
	}
}

function canvasSummary(canvas: Canvas): CanvasSummary {
	const { sessions, items } = canvasData(canvas)
	// HTML items have no image thumbnail, nor pages without a screenshot.
	const previews = items
		.filter((i) => i.kind !== 'html' && i.thumb)
		.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
		.slice(0, 4)
		.map((i) => i.thumb)
	return { ...canvas, sessionCount: sessions.length, itemCount: items.length, previews }
}

function canvasSessions(canvasId: string): Session[] {
	return [...db.sessions.values()].filter((s) => s.canvasId === canvasId)
}

/** The canvas's sessions in frame order, left to right (hidden ones included, where they'd be). */
function orderedSessions(canvasId: string): Session[] {
	return orderSessions(canvasSessions(canvasId), db.canvases.get(canvasId)?.sessionOrder)
}

/** Hides or shows a session's frame for everyone. */
function setSessionHidden(session: Session, hidden: boolean): Session {
	if (!!session.hidden === hidden) return session
	const { hidden: _, hiddenAt: __, ...rest } = session
	const next: Session = hidden ? { ...rest, hidden: true, hiddenAt: Date.now() } : rest
	db.sessions.set(sessionKey(session.canvasId, session.id), next)
	save()
	broadcast({ type: 'session', session: next })
	return next
}

/** Arranges the canvas's frames: these sessions first, in this order (unknown ids are dropped). */
function setSessionOrder(canvas: Canvas, value: unknown): Canvas {
	if (!Array.isArray(value) || value.some((id) => typeof id !== 'string')) throw new HttpError(400, 'send {"sessionIds": ["<sessionId>", ...]}, left to right')
	const known = new Set(canvasSessions(canvas.id).map((s) => s.id))
	const sessionOrder = [...new Set(value as string[])].filter((id) => known.has(id))
	const next: Canvas = { ...canvas, sessionOrder }
	db.canvases.set(next.id, next)
	save()
	broadcast({ type: 'canvas', canvas: next })
	return next
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

type ItemChanges = Partial<Pick<Item, 'group' | 'title' | 'caption' | 'name'>>

/** Changes an item's metadata (and an HTML item's size) for everyone. */
function updateItem(item: Item, changes: ItemChanges, size?: { width: number; height: number }): Item {
	const next = applyChanges(item, changes)
	if (size) Object.assign(next, size)
	commitItem(next)
	return next
}

function applyChanges(item: Item, changes: ItemChanges): Item {
	const next: Item = { ...item }
	for (const key of ['group', 'title', 'caption'] as const) {
		if (!(key in changes)) continue
		const value = changes[key]
		if (value === undefined || value === null) delete next[key]
		else next[key] = value
	}
	if (changes.name) next.name = changes.name
	return next
}

function commitItem(item: Item) {
	db.items.set(item.id, item)
	save()
	broadcast({ type: 'item', item })
}

/** The metadata changes of PATCH /api/items/:itemId (also used by the MCP update_item tool); see patchItem. */
function itemChanges(body: Record<string, unknown>): ItemChanges {
	const changes: ItemChanges = {}
	if ('group' in body) changes.group = groupField(body.group) ?? undefined
	if ('title' in body) changes.title = body.title === null ? undefined : textField(body.title)
	if ('caption' in body) changes.caption = body.caption === null ? undefined : textField(body.caption)
	if ('name' in body) {
		changes.name = nameField(body.name)
		if (!changes.name) throw new HttpError(400, '"name" can\'t be empty')
	}
	return changes
}

/** Multipart "sourceItemId" + "sourceTime": a video on this canvas and a time in it (seconds), or neither. */
function sourceFields(canvasId: string, itemId: unknown, time: unknown): { sourceItemId?: string; sourceTime?: number } {
	const id = textField(itemId)
	if (!id) return {}
	const source = db.items.get(id)
	if (!source || source.canvasId !== canvasId) throw new HttpError(400, `"sourceItemId": no item ${id} on this canvas`)
	const t = Number(time)
	if (time === null || time === '' || !Number.isFinite(t) || t < 0) throw new HttpError(400, '"sourceTime" must be a time in seconds')
	return { sourceItemId: id, sourceTime: Math.round(t * 1000) / 1000 }
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
const ADDED_BY_MAX = 60

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
	/** the OpenCode session's title as the poster knows it: the frame's title until a paired browser reports the session's own */
	sessionTitle?: string
	/** a frame extracted from a video (see Item.sourceItemId) */
	sourceItemId?: string
	sourceTime?: number
	/** someone dragged or pasted it onto the frame in a browser (multipart "addedBy"): a person item (see Item.origin) */
	addedBy?: string
}

/** An item's media: what posting a file (or replacing an item's file) sets. */
type Media = Pick<Item, 'kind' | 'src' | 'thumb' | 'width' | 'height' | 'duration'>

/**
 * What a post or a replacement brings: a file, with its original name or path (which gives the
 * extension, and the item's name unless one is sent), or inline HTML.
 */
type MediaSource = { data: Blob; filename?: string } | { html: string }

/**
 * Writes posted media into the media folder as "<base><ext>" (plus "<base>.thumb.webp") and reads
 * its kind, size and (videos) length. HTML pages are laid out at `size` (default 800x600) and have
 * no thumbnail.
 */
async function storeMedia(base: string, source: MediaSource, size: { width?: number; height?: number }): Promise<Media> {
	if ('html' in source) return storeHtml(base, source.html, size)
	const { data, filename } = source
	const ext = (extname(filename ?? '').toLowerCase() || extFromMime(data.type)).toLowerCase()
	const kind = kindOf(ext, data.type)
	if (!kind) throw new HttpError(415, `unsupported media type (${ext || data.type || 'unknown'})`)
	if (kind === 'html') {
		if (data.size > HTML_MAX_BYTES) throw new HttpError(413, `HTML is larger than ${HTML_MAX_BYTES / 1024 / 1024} MB`)
		return storeHtml(base, await data.text(), size)
	}

	const file = `${base}${ext}`
	const thumbFile = `${base}.thumb.webp`
	const path = join(MEDIA_DIR, file)
	await Bun.write(path, data)

	try {
		let dims: { width: number; height: number } | null
		let thumb = `/media/${thumbFile}`
		if (HAS_FFMPEG) {
			dims = await probe(path)
			await makeThumb(path, join(MEDIA_DIR, thumbFile))
		} else {
			if (kind === 'video') throw new Error('posting videos needs ffmpeg installed on the canvas server\'s machine')
			dims = imageSize(new Uint8Array(await Bun.file(path).arrayBuffer()))
			if (!dims) throw new Error('can\'t read this image\'s size without ffmpeg (PNG, JPEG, GIF and WebP work; install ffmpeg for others)')
			thumb = `/media/${file}`
		}
		const duration = kind === 'video' && HAS_FFMPEG ? await probeDuration(path) : undefined
		return { kind, src: `/media/${file}`, thumb, width: dims.width, height: dims.height, ...(duration !== undefined ? { duration } : {}) }
	} catch (e) {
		await rm(path, { force: true })
		await rm(join(MEDIA_DIR, thumbFile), { force: true })
		throw e instanceof HttpError ? e : new HttpError(422, (e as Error).message)
	}
}

/** An HTML page, shown on the canvas in a sandboxed iframe at the size it was designed for. No thumbnail. */
async function storeHtml(base: string, html: string, size: { width?: number; height?: number }): Promise<Media> {
	if (Buffer.byteLength(html) > HTML_MAX_BYTES) throw new HttpError(413, `HTML is larger than ${HTML_MAX_BYTES / 1024 / 1024} MB`)
	if (!html.trim()) throw new HttpError(400, '"html" is empty')
	const src = `/media/${base}.html`
	await Bun.write(join(MEDIA_DIR, basename(src)), htmlDocument(html))
	return { kind: 'html', src, thumb: src, width: size.width ?? HTML_DEFAULT_SIZE.width, height: size.height ?? HTML_DEFAULT_SIZE.height }
}

async function addItem(canvasId: string, sessionId: string, source: MediaSource, opts: ItemOptions): Promise<Item> {
	const id = opts.id ?? newId()
	const media = await storeMedia(id, source, opts)
	try {
		// The canvas may have been deleted while the media was processed.
		getCanvas(canvasId)
	} catch (e) {
		await removeItemFiles(media)
		throw e
	}
	ensureSession(canvasId, sessionId, { postedTitle: opts.sessionTitle })
	const filename = 'data' in source ? source.filename : undefined
	const name =
		opts.name ??
		(filename ? basename(filename) || undefined : undefined) ??
		(media.kind === 'html' ? `${opts.title?.replaceAll('/', '-') ?? id}.html` : basename(media.src))
	const item: Item = {
		id,
		canvasId,
		sessionId,
		name,
		...media,
		...(opts.group ? { group: opts.group } : {}),
		title: opts.title,
		caption: opts.caption,
		...(opts.sourceItemId ? { sourceItemId: opts.sourceItemId, sourceTime: opts.sourceTime } : {}),
		...(opts.addedBy ? { origin: 'person' as const, addedBy: opts.addedBy } : {}),
		createdAt: opts.createdAt ?? Date.now(),
	}
	db.items.set(id, item)
	save()
	broadcast({ type: 'item', item })
	return item
}

/** The JSON body of POST /api/canvases/:cid/sessions/:sessionId/items (also used by the MCP post_item tool). */
interface ItemJson {
	path?: unknown
	url?: unknown
	html?: unknown
	width?: unknown
	height?: unknown
	group?: unknown
	title?: string
	caption?: string
	name?: unknown
	sessionTitle?: unknown
	/** a web page's URL (a page item); "path"/"url" then send its screenshot */
	page?: unknown
}

/** The file a JSON post or PATCH sends: {"html"}, {"path"} (a file on this machine) or {"url"}; null for none. */
async function jsonSource(body: ItemJson | null): Promise<MediaSource | null> {
	if (body?.html !== undefined && body.html !== null) {
		if (typeof body.html !== 'string') throw new HttpError(400, '"html" must be a string')
		return { html: body.html }
	}
	if (body?.path) {
		if (typeof body.path !== 'string') throw new HttpError(400, '"path" must be a string')
		const f = Bun.file(body.path)
		if (!(await f.exists())) throw new HttpError(404, `no file at ${body.path}`)
		return { data: f, filename: body.path }
	}
	if (body?.url) {
		if (typeof body.url !== 'string') throw new HttpError(400, '"url" must be a string')
		let pathname: string
		try {
			pathname = new URL(body.url).pathname
		} catch {
			throw new HttpError(400, `not a URL: ${body.url}`)
		}
		const res = await fetch(body.url)
		if (!res.ok) throw new HttpError(502, `fetch ${body.url} failed: ${res.status}`)
		const data = await res.blob()
		let filename = pathname
		try {
			filename = decodeURIComponent(pathname)
		} catch {}
		return { data, filename }
	}
	return null
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
	if (body?.page !== undefined && body.page !== null) {
		if (body.html !== undefined && body.html !== null) throw new HttpError(400, 'send "page" (with an optional screenshot as "path" or "url"), or "html"')
		const { width: _, height: __, ...rest } = meta
		const url = pageField(body.page)
		return addPageItem(canvasId, sessionId, url, await jsonSource(body), rest)
	}
	const source = await jsonSource(body)
	if (!source) throw new HttpError(400, 'send multipart "file", or JSON {"path"}, {"url"}, {"html"} or {"page"}')
	return addItem(canvasId, sessionId, source, meta)
}

/**
 * PATCH /api/items/:itemId (and the MCP update_item tool): changes the item's name, title, caption
 * or group, and/or replaces its file in place with `source` (sent like a post's). A replaced item
 * keeps its id, session, group, title, caption (unless changed too) and annotations, and gets a new
 * media URL, so every viewer loads the new file; it moves to the top of its group, like a new post.
 * Metadata-only edits leave it where it is. "width"/"height" alone resize an HTML item.
 */
async function patchItem(item: Item, body: Record<string, unknown>, source: MediaSource | null): Promise<Item> {
	const changes = itemChanges(body)
	if (body.page !== undefined && body.page !== null) {
		if (source && 'html' in source) throw new HttpError(400, 'send "page" (with an optional screenshot as "path", "url" or multipart "file"), or "html"')
		return replacePage(item, pageField(body.page), source, changes)
	}
	// A page item's new file is its new screenshot.
	if (item.kind === 'page' && source) return replacePage(item, null, source, changes)
	const width = sizeField(body.width, 'width')
	const height = sizeField(body.height, 'height')
	if (!source) {
		const resize = width !== undefined || height !== undefined
		if (resize && item.kind !== 'html') throw new HttpError(400, '"width"/"height" only resize HTML items (or size a new HTML file)')
		if (!resize && !Object.keys(changes).length) {
			throw new HttpError(
				400,
				'send a new file (multipart "file", or JSON {"path"}, {"url"}, {"html"} or {"page"}) and/or any of {"group", "title", "caption", "name"} (null clears, except name)',
			)
		}
		return updateItem(item, changes, resize ? { width: width ?? item.width, height: height ?? item.height } : undefined)
	}
	// An HTML page replaced by another keeps its size unless it's given a new one.
	const keep = item.kind === 'html' ? { width: item.width, height: item.height } : {}
	const media = await storeMedia(`${item.id}-${randomId(8)}`, source, { width: width ?? keep.width, height: height ?? keep.height })
	const current = db.items.get(item.id)
	if (!current) {
		await removeItemFiles(media)
		throw new HttpError(404, `item ${item.id} was deleted while its new file was processed`)
	}
	const filename = 'data' in source ? source.filename : undefined
	// No longer a frame of the video it was taken from, nor its old length, nor a web page; and a
	// person's item replaced (by its session's update_item) is now the session's output.
	const { duration: _, sourceItemId: __, sourceTime: ___, pageUrl: _p, page: _pi, snapshotAt: _s, origin: _o, addedBy: _a, delivered: _d, ...rest } = current
	const next = applyChanges(
		{ ...rest, ...media, name: (filename && basename(filename)) || withExtension(current.name, media.src), createdAt: Date.now() },
		changes,
	)
	commitItem(next)
	await removeItemFiles(current)
	return next
}

/** A file name with the extension of `src` (an item's name after its file is replaced by one of another type). */
function withExtension(name: string, src: string) {
	const ext = extname(src)
	const old = extname(name)
	if (old.toLowerCase() === ext.toLowerCase()) return name
	return (old ? name.slice(0, -old.length) : name) + ext
}

// ---------- pages (links to web pages, with a screenshot when the poster sends one) ----------
//
// The canvas server never fetches a page's URL: it can be anything that opens in a browser (localhost,
// a Tailscale address, a private network). A screenshot, when there is one, is an image the poster
// took and sent along; without one, people's browsers draw a link card at PAGE_CARD's size.

const PAGE_CARD = { width: 800, height: 500 }

/** A "page" from the request: any http(s) URL (never contacted by this server). */
function pageField(value: unknown): string {
	if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, '"page" must be the URL of a web page')
	let url: URL
	try {
		url = new URL(value.trim())
	} catch {
		throw new HttpError(400, `"page" is not a URL: ${value}`)
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new HttpError(400, '"page" must be an http(s) URL')
	return url.href
}

const pageHost = (url: string) => new URL(url).hostname.replace(/^www\./, '') || 'page'

/** Stores a page's screenshot (which must be an image) as "<base><ext>". */
async function storeScreenshot(base: string, source: MediaSource): Promise<Media> {
	if ('html' in source) throw new HttpError(400, 'a page\'s screenshot must be an image (send it as "path", "url" or multipart "file")')
	const media = await storeMedia(base, source, {})
	if (media.kind !== 'image') {
		await removeItemFiles(media)
		throw new HttpError(415, 'a page\'s screenshot must be an image')
	}
	return media
}

/** A page item's media without a screenshot: drawn as a link card by the browsers showing it. */
const pageCard = (): Media => ({ kind: 'page', src: '', thumb: '', width: PAGE_CARD.width, height: PAGE_CARD.height })

/** Posts a page item: a link to `url`, shown as `screenshot` (an image the poster sent) or as a link card. */
async function addPageItem(
	canvasId: string,
	sessionId: string,
	url: string,
	screenshot: MediaSource | null,
	opts: Omit<ItemOptions, 'width' | 'height'>,
): Promise<Item> {
	getCanvas(canvasId)
	const id = opts.id ?? newId()
	const media = screenshot ? { ...(await storeScreenshot(id, screenshot)), kind: 'page' as const } : pageCard()
	try {
		getCanvas(canvasId)
	} catch (e) {
		await removeItemFiles(media)
		throw e
	}
	ensureSession(canvasId, sessionId, { postedTitle: opts.sessionTitle })
	const item: Item = {
		id,
		canvasId,
		sessionId,
		name: opts.name ?? (media.src ? `${pageHost(url)}${extname(media.src)}` : pageHost(url)),
		...media,
		...(opts.group ? { group: opts.group } : {}),
		title: opts.title,
		caption: opts.caption,
		pageUrl: url,
		page: { url },
		createdAt: opts.createdAt ?? Date.now(),
	}
	commitItem(item)
	return item
}

/**
 * Makes an item a page item in place, or changes a page item: `url` (null: keep its URL) and/or a new
 * screenshot. A page item pointed at another URL keeps its screenshot unless it's sent a new one; any
 * other item turned into a page loses its file (and shows a link card unless a screenshot comes with it).
 */
async function replacePage(item: Item, url: string | null, screenshot: MediaSource | null, changes: ItemChanges): Promise<Item> {
	const wasPage = item.kind === 'page'
	const pageUrl = url ?? item.pageUrl ?? item.page?.url
	if (!pageUrl) throw new HttpError(400, 'send "page" (the URL) to turn this item into a page')
	const media = screenshot ? { ...(await storeScreenshot(`${item.id}-${randomId(8)}`, screenshot)), kind: 'page' as const } : wasPage ? null : pageCard()
	const current = db.items.get(item.id)
	if (!current) {
		if (media) await removeItemFiles(media)
		throw new HttpError(404, `item ${item.id} was deleted while its screenshot was processed`)
	}
	const { duration: _, sourceItemId: __, sourceTime: ___, snapshotAt: _s, origin: _o, addedBy: _a, delivered: _d, ...rest } = current
	const name = media?.src ? `${pageHost(pageUrl)}${extname(media.src)}` : media || url ? pageHost(pageUrl) : current.name
	const next = applyChanges({ ...rest, ...(media ?? {}), kind: 'page', name, pageUrl, page: { url: pageUrl }, createdAt: Date.now() }, changes)
	commitItem(next)
	if (media) await removeItemFiles(current)
	return next
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

/**
 * Gets a session's frame, making it if needed. `postedTitle` (a post's `sessionTitle`, or PUT
 * /sessions/:sid's title) is only a fallback: the frame shows its OpenCode session's title once a
 * paired browser has reported it (see mirrorSessions). `serverKey` says which OpenCode it's on,
 * when that isn't known yet.
 */
function ensureSession(canvasId: string, id: string, opts: { postedTitle?: string; serverKey?: string } = {}): Session {
	const key = sessionKey(canvasId, id)
	const existing = db.sessions.get(key) ?? { id, canvasId, title: '', createdAt: Date.now() }
	const postedTitle = opts.postedTitle?.trim() || existing.postedTitle
	const serverKey = existing.serverKey ?? opts.serverKey
	const next = withTitle({ ...existing, ...(postedTitle ? { postedTitle } : {}), ...(serverKey ? { serverKey } : {}) })
	if (db.sessions.has(key) && JSON.stringify(next) === JSON.stringify(existing)) return existing
	return commitSession(next)
}

/** A session with its title worked out again from what OpenCode said and what it was posted with. */
const withTitle = (s: Session): Session => ({ ...s, title: frameTitle(s.postedTitle, s.opencode) })

function commitSession(session: Session): Session {
	db.sessions.set(sessionKey(session.canvasId, session.id), session)
	save()
	broadcast({ type: 'session', session })
	return session
}

const SERVER_KEY = /^[A-Za-z0-9_-]{1,64}$/
const AGENT_MAX = 64
const DIRECTORY_MAX = 1000

/** One entry of PUT /api/canvases/:cid/opencode: a session as its OpenCode reported it to a paired browser. */
function mirrorEntry(value: unknown): { sessionId: string; serverKey: string; info: OpenCodeSessionInfo } {
	const v = (value ?? {}) as Record<string, unknown>
	const bad = (what: string): never => {
		throw new HttpError(400, `each session needs ${what}`)
	}
	const sessionId = typeof v.sessionId === 'string' && SESSION_ID.test(v.sessionId) ? v.sessionId : bad('"sessionId" (an OpenCode session id)')
	const serverKey = typeof v.serverKey === 'string' && SERVER_KEY.test(v.serverKey) ? v.serverKey : bad('"serverKey" (the OpenCode it lives on)')
	if (typeof v.title !== 'string') bad('"title" (a string, "" for none)')
	const text = (key: string, max: number) => (typeof v[key] === 'string' && v[key] ? { [key]: (v[key] as string).slice(0, max) } : {})
	const time = (key: string) => (typeof v[key] === 'number' && Number.isFinite(v[key]) ? { [key]: v[key] as number } : {})
	const info: OpenCodeSessionInfo = {
		title: (v.title as string).trim().replace(/\s+/g, ' ').slice(0, TITLE_MAX),
		...(typeof v.parentId === 'string' && SESSION_ID.test(v.parentId) ? { parentId: v.parentId } : {}),
		...text('agent', AGENT_MAX),
		...text('directory', DIRECTORY_MAX),
		...time('createdAt'),
		...time('updatedAt'),
		...(v.deleted === true ? { deleted: true } : {}),
	}
	return { sessionId, serverKey, info }
}

/**
 * What paired browsers report about the canvas's sessions from OpenCode (their titles, renames
 * included, and whether they were deleted), saved on the frames and broadcast, so everyone sees the
 * same, even without a pairing. Only sessions with a frame here are updated: this never makes one.
 */
function mirrorSessions(canvasId: string, entries: ReturnType<typeof mirrorEntry>[]): string[] {
	const updated: string[] = []
	for (const { sessionId, serverKey, info } of entries) {
		const existing = db.sessions.get(sessionKey(canvasId, sessionId))
		if (!existing) continue
		const next = withTitle({ ...existing, serverKey, opencode: info })
		if (JSON.stringify(next) === JSON.stringify(existing)) continue
		commitSession(next)
		updated.push(sessionId)
	}
	return updated
}

/** Marks a session populated from OpenCode (POST .../populate), or unmarks it. */
function setPopulated(session: Session, populatedAt: number | undefined): Session {
	const { populatedAt: _, ...rest } = session
	return commitSession(populatedAt ? { ...rest, populatedAt } : rest)
}

async function removeItemFiles(item: Pick<Item, 'src' | 'thumb'>) {
	for (const src of new Set([item.src, item.thumb])) {
		if (src?.startsWith('/media/')) await rm(join(MEDIA_DIR, basename(src)), { force: true })
	}
}

function sessionItems(canvasId: string, sessionId: string) {
	return [...db.items.values()].filter((i) => i.canvasId === canvasId && i.sessionId === sessionId)
}

type DeliveryChange = { itemIds: string[]; messageId?: string; via: ItemDelivery['via'] } | { clear: true }

/**
 * Records that a session now has these person items' media (sent with a prompt or seen through a
 * tool), as of their current file; or, with clear, that it has none of them any more (it compacted).
 * Other sessions' items and items people didn't add are left alone. Returns the items changed.
 */
function markDelivered(canvasId: string, sessionId: string, change: DeliveryChange): Item[] {
	const changed: Item[] = []
	const at = Date.now()
	const ids = 'clear' in change ? null : new Set(change.itemIds)
	for (const item of sessionItems(canvasId, sessionId)) {
		if (item.origin !== 'person') continue
		if (!ids) {
			if (!item.delivered) continue
			const { delivered: _, ...next } = item
			changed.push(next)
			continue
		}
		if (!ids.has(item.id) || 'clear' in change) continue
		const delivered: ItemDelivery = { sessionId, src: item.src, at, ...(change.messageId ? { messageId: change.messageId } : {}), via: change.via }
		changed.push({ ...item, delivered })
	}
	for (const item of changed) {
		db.items.set(item.id, item)
		broadcast({ type: 'item', item })
	}
	if (changed.length) save()
	return changed
}

const DELIVERY_VIA = new Set<ItemDelivery['via']>(['submit', 'prompt', 'tool'])
const MESSAGE_ID_MAX = 128

/** The body of POST /api/canvases/:cid/sessions/:sid/delivered. */
function deliveryChange(body: Record<string, unknown> | null): DeliveryChange {
	if (body?.clear === true) return { clear: true }
	const itemIds = idList(body?.itemIds, 'itemIds')
	const via = (body?.via ?? 'prompt') as ItemDelivery['via']
	if (!itemIds.length || !DELIVERY_VIA.has(via)) throw new HttpError(400, 'send {"itemIds": [...], "messageId"?, "via": "submit"|"prompt"|"tool"} or {"clear": true}')
	const messageId = typeof body?.messageId === 'string' && body.messageId.trim() ? body.messageId.trim().slice(0, MESSAGE_ID_MAX) : undefined
	return { itemIds, via, ...(messageId ? { messageId } : {}) }
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

/**
 * Moves a session and all its items to the trash, drops its link and deletes the sticky notes it
 * placed (say / highlight). Restoring the session doesn't bring those back: it can be linked again.
 */
function deleteSession(session: Session) {
	const items = sessionItems(session.canvasId, session.id)
	for (const item of items) deleteItem(item.id, { keepSession: true })
	db.sessions.delete(sessionKey(session.canvasId, session.id))
	const entry: TrashEntry = { kind: 'session', session, itemIds: items.map((i) => i.id), deletedAt: Date.now() }
	trash.set(trashKey(entry), entry)
	save()
	broadcast({ type: 'session_deleted', canvasId: session.canvasId, id: session.id })
	links.drop(session.canvasId, session.id)
	busy.forget(session.canvasId, session.id)
	// A canvas being deleted throws its whole room away.
	if (db.canvases.has(session.canvasId)) {
		attention.dropSession(session.canvasId, session.id).catch((e) => console.error('could not remove the session\'s notes:', e))
	}
}

/** Takes a session out of the trash (with the items deleted along with it). */
function restoreSession(canvasId: string, sessionId: string, restored: { sessions: Session[]; items: Item[] }) {
	const key = `session:${sessionKey(canvasId, sessionId)}`
	const entry = trash.get(key)
	if (entry?.kind !== 'session') return
	trash.delete(key)
	// The session may have been recreated since (by posting to it again): then only its items come back.
	if (!db.sessions.has(sessionKey(canvasId, sessionId))) {
		const session = storedSession(entry.session)
		db.sessions.set(sessionKey(canvasId, sessionId), session)
		broadcast({ type: 'session', session })
		restored.sessions.push(session)
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

async function restore(canvasId: string, sessionIds: string[], itemIds: string[], annotationIds: string[] = []) {
	const restored: { sessions: Session[]; items: Item[]; annotations: Annotation[] } = { sessions: [], items: [], annotations: [] }
	for (const id of sessionIds) restoreSession(canvasId, id, restored)
	for (const id of itemIds) restoreItem(canvasId, id, restored)
	if (annotationIds.length) restored.annotations = await restoreAnnotations(canvasId, annotationIds)
	return restored
}

/** Puts annotations from the trash back into the canvas's room document (live for everyone there). */
async function restoreAnnotations(canvasId: string, ids: string[]): Promise<Annotation[]> {
	const entries = ids.flatMap((id) => {
		const entry = trash.get(`annotation:${id}`)
		return entry?.kind === 'annotation' && entry.canvasId === canvasId ? [entry] : []
	})
	if (!entries.length) return []
	const restored = await changeRoomDoc(`canvas-${canvasId}`, (doc) => {
		const map = doc.getMap<Y.Map<unknown>>('annotations')
		const back: Annotation[] = []
		for (const entry of entries) {
			if (!map.has(entry.id)) {
				const a = new Y.Map<unknown>()
				for (const [key, value] of Object.entries(entry.fields)) a.set(key, value)
				map.set(entry.id, a)
			}
			back.push(annotationFrom(entry.id, map.get(entry.id)!))
		}
		return back
	})
	for (const entry of entries) trash.delete(trashKey(entry))
	save()
	return restored
}

/** Permanently removes trash older than TRASH_MS (or everything of one canvas), with its files. */
async function purgeTrash(opts: { canvasId?: string } = {}) {
	const cutoff = Date.now() - TRASH_MS
	let changed = false
	for (const [key, entry] of [...trash]) {
		const canvasId = trashCanvas(entry)
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
	links.dropCanvas(canvas.id)
	busy.forget(canvas.id)
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
				...(typeof user.sessionId === 'string' ? { sessionId: user.sessionId } : {}),
				...(typeof user.serverKey === 'string' ? { serverKey: user.serverKey } : {}),
			},
			selection: Array.isArray(state.selection) ? state.selection.filter((s): s is string => typeof s === 'string') : [],
			cursor: (state.cursor as PresenceEntry['cursor']) ?? null,
			view: (state.view as PresenceEntry['view']) ?? null,
			chat: typeof state.chat === 'string' ? state.chat : null,
			...(typeof state.chatSent === 'boolean' ? { chatSent: state.chatSent } : {}),
			...(user.agent === true && typeof user.sessionId === 'string' ? { thinking: state.thinking === true } : {}),
		})
	}
	return entries.sort((a, b) => a.clientId - b.clientId)
}

/**
 * Sticky notes in a room document (map "notes": id -> Y.Map {x, y, color, author, createdAt, text:
 * Y.Text}, plus sessionId and the NoteAnchor fields on notes agents placed).
 */
function readNotes(doc: Y.Doc): Note[] {
	const notes: Note[] = []
	for (const [id, note] of doc.getMap<Y.Map<unknown>>('notes')) if (note instanceof Y.Map) notes.push(noteFrom(id, note))
	return notes.sort((a, b) => a.createdAt - b.createdAt)
}

/** Annotations in a room document (map "annotations": id -> Y.Map, see Annotation in shared/types.ts). */
function readAnnotations(doc: Y.Doc): Annotation[] {
	const list: Annotation[] = []
	for (const [id, a] of doc.getMap<Y.Map<unknown>>('annotations')) {
		if (a instanceof Y.Map) list.push(annotationFrom(id, a))
	}
	return list.sort((a, b) => a.createdAt - b.createdAt)
}

/** One annotation from its fields: a room document's Y.Map, or a trash entry's copy of one. */
function annotationFrom(id: string, a: Y.Map<unknown> | Record<string, unknown>): Annotation {
	const get = (key: string) => (a instanceof Y.Map ? a.get(key) : a[key])
	const num = (key: string) => Number(get(key) ?? 0) || 0
	const updatedAt = num('updatedAt')
	return {
		id,
		itemId: String(get('itemId') ?? ''),
		x: num('x'),
		y: num('y'),
		strokes: strokesFrom(get('strokes')),
		text: String(get('text') ?? ''),
		author: String(get('author') ?? ''),
		color: String(get('color') ?? ''),
		createdAt: num('createdAt'),
		...(updatedAt ? { updatedAt } : {}),
	}
}

/** Pencil strokes as stored (flat normalized [x, y, …] arrays), with anything malformed dropped (old pin annotations have none). */
function strokesFrom(value: unknown): number[][] {
	if (!Array.isArray(value)) return []
	const strokes: number[][] = []
	for (const s of value) {
		if (!Array.isArray(s) || s.length < 2) continue
		const flat = s.slice(0, s.length - (s.length % 2)).map((v) => Number(v))
		if (flat.every(Number.isFinite)) strokes.push(flat)
	}
	return strokes
}

type AnnotationFilter = { sessionId?: string; itemId?: string; ids?: string[] }

/**
 * A canvas's annotations resolved against their items, oldest first, optionally only those on one
 * session's items or one item. Annotations on deleted items are left out (they come back with an undo).
 */
async function annotationViews(canvasId: string, filter: AnnotationFilter = {}): Promise<AnnotationView[]> {
	const canvas = getCanvas(canvasId)
	return resolveAnnotations(canvas, await readRoomDoc(`canvas-${canvas.id}`, readAnnotations), filter)
}

/**
 * Reads annotations the way an agent does: like annotationViews, but unless `keep`, the ones
 * returned are taken off the canvas (live for everyone looking, who first get an
 * annotations_consumed event to animate them away, into `readerSessionId`'s frame)
 * and wait in the trash for an hour (see restore). Read and removal are one step, so two readers
 * never both get the same annotation.
 */
async function readAnnotationsAsAgent(
	canvasId: string,
	filter: AnnotationFilter & { keep?: boolean; readerSessionId?: string } = {},
): Promise<AnnotationView[]> {
	const canvas = getCanvas(canvasId)
	if (filter.keep) return annotationViews(canvas.id, filter)
	const deletedAt = Date.now()
	const taken = await changeRoomDoc(`canvas-${canvas.id}`, (doc) => {
		const map = doc.getMap<Y.Map<unknown>>('annotations')
		const views = resolveAnnotations(canvas, readAnnotations(doc), filter)
		if (!views.length) return null
		broadcast({
			type: 'annotations_consumed',
			canvasId: canvas.id,
			...(filter.readerSessionId ? { sessionId: filter.readerSessionId } : {}),
			ids: views.map((v) => v.id),
		})
		const entries: TrashEntry[] = []
		for (const v of views) {
			const a = map.get(v.id)
			if (!(a instanceof Y.Map)) continue
			entries.push({ kind: 'annotation', canvasId: canvas.id, id: v.id, fields: a.toJSON(), deletedAt })
			map.delete(v.id)
		}
		return { views, entries }
	})
	if (!taken) return []
	for (const entry of taken.entries) trash.set(trashKey(entry), entry)
	save()
	return taken.views.map((v) => ({ ...v, consumed: true as const }))
}

/** Annotations resolved against their items (see annotationViews). */
function resolveAnnotations(canvas: Canvas, list: Annotation[], filter: AnnotationFilter): AnnotationView[] {
	const views: AnnotationView[] = []
	for (const a of list) {
		const item = db.items.get(a.itemId)
		if (!item || item.canvasId !== canvas.id) continue
		if (filter.itemId && item.id !== filter.itemId) continue
		if (filter.sessionId && item.sessionId !== filter.sessionId) continue
		if (filter.ids && !filter.ids.includes(a.id)) continue
		const x = clamp01(a.x)
		const y = clamp01(a.y)
		const { strokes, bbox } = strokePixels(a.strokes, item.width, item.height)
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
				...(item.src ? { url: /^https?:/.test(item.src) ? item.src : MEDIA_ORIGIN + item.src } : {}),
				...(item.pageUrl ? { pageUrl: item.pageUrl } : {}),
				link: `${WEB_BASE}/c/${canvas.id}#item=${encodeURIComponent(item.id)}`,
				...(item.sourceItemId ? { sourceItemId: item.sourceItemId, sourceTime: item.sourceTime } : {}),
				...(item.origin ? { origin: item.origin, ...(item.addedBy ? { addedBy: item.addedBy } : {}) } : {}),
			},
			anchor: { x: round4(x), y: round4(y), px: Math.round(x * item.width), py: Math.round(y * item.height) },
			strokes,
			...(bbox ? { bbox } : {}),
			color: a.color,
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
 * Strokes in pixels of an image (or page) `width` × `height`, simplified (to within about a pixel)
 * so long scribbles stay readable, and the drawing's bounding box.
 */
function strokePixels(strokes: number[][], width: number, height: number) {
	const tolerance = Math.max(1, Math.hypot(width, height) / 1000)
	const out: [number, number][][] = []
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
	for (const flat of strokes) {
		const points: [number, number][] = []
		for (let i = 0; i + 1 < flat.length; i += 2) points.push([flat[i] * width, flat[i + 1] * height])
		for (const [x, y] of points) {
			x0 = Math.min(x0, x)
			y0 = Math.min(y0, y)
			x1 = Math.max(x1, x)
			y1 = Math.max(y1, y)
		}
		out.push(simplify(points, tolerance).map(([x, y]) => [Math.round(x), Math.round(y)]))
	}
	if (!out.length) return { strokes: out, bbox: undefined }
	const bx = Math.max(0, Math.floor(x0))
	const by = Math.max(0, Math.floor(y0))
	const bbox = { x: bx, y: by, width: Math.max(0, Math.min(width, Math.ceil(x1)) - bx), height: Math.max(0, Math.min(height, Math.ceil(y1)) - by) }
	return { strokes: out, bbox }
}

/** Ramer–Douglas–Peucker: the polyline with points closer than `tolerance` to the line between their neighbours dropped. */
function simplify(points: [number, number][], tolerance: number): [number, number][] {
	if (points.length < 3) return points
	const keep = new Uint8Array(points.length)
	keep[0] = keep[points.length - 1] = 1
	const stack: [number, number][] = [[0, points.length - 1]]
	while (stack.length) {
		const [a, b] = stack.pop()!
		let worst = -1
		let far = tolerance
		for (let i = a + 1; i < b; i++) {
			const d = segmentDistance(points[i][0], points[i][1], points[a], points[b])
			if (d > far) {
				far = d
				worst = i
			}
		}
		if (worst < 0) continue
		keep[worst] = 1
		stack.push([a, worst], [worst, b])
	}
	return points.filter((_, i) => keep[i])
}

function segmentDistance(px: number, py: number, a: [number, number], b: [number, number]) {
	const dx = b[0] - a[0]
	const dy = b[1] - a[1]
	const l2 = dx * dx + dy * dy
	const t = l2 ? Math.min(1, Math.max(0, ((px - a[0]) * dx + (py - a[1]) * dy) / l2)) : 0
	return Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy)
}

/** The stroke as the canvas draws it: through the midpoints between its points, as quadratic curves, sampled finely. */
function smoothStroke(points: [number, number][]): [number, number][] {
	if (points.length < 3) return points
	const out: [number, number][] = [points[0]]
	const mid = (a: [number, number], b: [number, number]): [number, number] => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
	let from = mid(points[0], points[1])
	out.push(from)
	for (let i = 1; i < points.length - 1; i++) {
		const c = points[i]
		const to = mid(c, points[i + 1])
		const steps = Math.min(24, Math.max(2, Math.ceil((Math.hypot(c[0] - from[0], c[1] - from[1]) + Math.hypot(to[0] - c[0], to[1] - c[1])) / 3)))
		for (let k = 1; k <= steps; k++) {
			const t = k / steps
			const u = 1 - t
			out.push([u * u * from[0] + 2 * u * t * c[0] + t * t * to[0], u * u * from[1] + 2 * u * t * c[1] + t * t * to[1]])
		}
		from = to
	}
	out.push(points[points.length - 1])
	return out
}

function hexColor(color: string): [number, number, number] {
	const m = /^#?([0-9a-f]{6})$/i.exec(color.trim())
	const n = m ? parseInt(m[1], 16) : 0xff3b30
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/**
 * The strokes rasterised (anti-aliased) into an RGBA patch covering just the drawing, to overlay
 * on the image with ffmpeg: the author's colour with a dark edge, so it shows on light and dark images.
 */
function rasterStrokes(lines: [number, number][][], imageW: number, imageH: number, width: number, color: [number, number, number]) {
	const core = width / 2
	const edge = core + Math.max(1.5, width / 3)
	let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
	for (const line of lines) {
		for (const [x, y] of line) {
			x0 = Math.min(x0, x)
			y0 = Math.min(y0, y)
			x1 = Math.max(x1, x)
			y1 = Math.max(y1, y)
		}
	}
	const pad = Math.ceil(edge) + 2
	const left = Math.max(0, Math.floor(x0) - pad)
	const top = Math.max(0, Math.floor(y0) - pad)
	const w = Math.min(imageW, Math.ceil(x1) + pad) - left
	const h = Math.min(imageH, Math.ceil(y1) + pad) - top
	if (w <= 0 || h <= 0) return null
	const coreCover = new Float32Array(w * h)
	const edgeCover = new Float32Array(w * h)
	for (const line of lines) {
		for (let i = 0; i < line.length; i++) {
			const a = line[i]
			const b = line[Math.min(i + 1, line.length - 1)]
			const sx0 = Math.max(0, Math.floor(Math.min(a[0], b[0]) - edge - 1) - left)
			const sx1 = Math.min(w - 1, Math.ceil(Math.max(a[0], b[0]) + edge + 1) - left)
			const sy0 = Math.max(0, Math.floor(Math.min(a[1], b[1]) - edge - 1) - top)
			const sy1 = Math.min(h - 1, Math.ceil(Math.max(a[1], b[1]) + edge + 1) - top)
			for (let py = sy0; py <= sy1; py++) {
				for (let px = sx0; px <= sx1; px++) {
					const d = segmentDistance(px + left + 0.5, py + top + 0.5, a, b)
					if (d > edge + 0.5) continue
					const k = py * w + px
					coreCover[k] = Math.max(coreCover[k], Math.min(1, Math.max(0, core + 0.5 - d)))
					edgeCover[k] = Math.max(edgeCover[k], Math.min(1, Math.max(0, edge + 0.5 - d)))
				}
			}
		}
	}
	const rgba = new Uint8Array(w * h * 4)
	for (let k = 0; k < w * h; k++) {
		const e = edgeCover[k]
		if (!e) continue
		const c = coreCover[k]
		// the edge is black at 60%: where the core covers, its colour, opaque
		const alpha = c + (1 - c) * 0.6 * e
		const mix = alpha ? c / alpha : 0
		rgba[k * 4] = Math.round(color[0] * mix)
		rgba[k * 4 + 1] = Math.round(color[1] * mix)
		rgba[k * 4 + 2] = Math.round(color[2] * mix)
		rgba[k * 4 + 3] = Math.round(255 * alpha)
	}
	return { rgba, left, top, w, h }
}

/**
 * GET /api/canvases/:cid/annotations/:id/image: the annotated image (a video's poster frame) as a
 * PNG, with the pencil strokes drawn on it (a ring round the spot for a text-only note) and the
 * annotation's number on its item beside them.
 *
 * The strokes are rasterised here, in plain TypeScript, into an RGBA patch that ffmpeg overlays (it
 * already reads and writes every format we accept): no browser, native module or SVG renderer needed.
 */
async function markedImageBytes(canvasId: string, annotationId: string, opts: { max?: number } = {}): Promise<Uint8Array> {
	if (!HAS_FFMPEG) throw new HttpError(501, 'marking images needs ffmpeg on the canvas server')
	// Annotations an agent has read are in the trash, but the image it was handed still works.
	const canvas = getCanvas(canvasId)
	const trashed = [...trash.values()].flatMap((t) => (t.kind === 'annotation' && t.canvasId === canvas.id ? [t] : []))
	const live = await readRoomDoc(`canvas-${canvas.id}`, readAnnotations)
	// Numbered as on the canvas: among the live ones, or for one an agent read, among those read with it.
	const gone = trashed.find((t) => t.id === annotationId)
	const list = (gone ? [...live, ...trashed.filter((t) => t.deletedAt === gone.deletedAt).map((t) => annotationFrom(t.id, t.fields))] : live).sort(
		(a, b) => a.createdAt - b.createdAt,
	)
	const all = resolveAnnotations(canvas, list, {})
	const a = all.find((v) => v.id === annotationId)
	const raw = list.find((v) => v.id === annotationId)
	if (!a || !raw) throw new HttpError(404, `no annotation ${annotationId} on this canvas`)
	const item = getItem(a.item.id)
	if (item.kind === 'html') throw new HttpError(400, 'HTML items have no image to mark; use the strokes\' and anchor\'s pixel coordinates on the page')
	const src = item.src
	if (!src) throw new HttpError(409, 'this link has no screenshot to mark')
	if (/^https?:/.test(src)) throw new HttpError(400, 'this item\'s media is not stored on the canvas server')
	const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
	// A video is marked on its first frame at full size (its poster is that frame, at 512 px).
	const frameFile = item.kind === 'video' ? join(DATA_DIR, `.mark-${stamp}-frame.png`) : null
	if (frameFile) await run(['ffmpeg', '-y', '-v', 'error', '-i', join(MEDIA_DIR, basename(src)), '-frames:v', '1', frameFile])
	const input = frameFile ?? join(MEDIA_DIR, basename(src))
	try {
		return await drawMarks(input, item.id, a, raw, all, stamp, opts.max)
	} finally {
		if (frameFile) await rm(frameFile, { force: true })
	}
}

/** The marked image: `raw`'s strokes (or a ring) and its number drawn on `input`, optionally scaled to fit `max` px. */
async function drawMarks(input: string, itemId: string, a: AnnotationView, raw: Annotation, all: AnnotationView[], stamp: string, max?: number): Promise<Uint8Array> {
	const size = await probe(input)
	const number = all.filter((v) => v.item.id === itemId).findIndex((v) => v.id === a.id) + 1
	const short = Math.min(size.width, size.height)
	const width = Math.max(3, Math.round(short / 180))
	let lines: [number, number][][] = raw.strokes.map((flat) => {
		const points: [number, number][] = []
		for (let i = 0; i + 1 < flat.length; i += 2) points.push([flat[i] * size.width, flat[i + 1] * size.height])
		return smoothStroke(points)
	})
	if (!lines.length) {
		// a text-only note: a ring round its spot
		const cx = clamp01(raw.x) * size.width
		const cy = clamp01(raw.y) * size.height
		const r = Math.max(12, short * 0.035)
		lines = [Array.from({ length: 49 }, (_, i): [number, number] => [cx + r * Math.cos((i / 48) * Math.PI * 2), cy + r * Math.sin((i / 48) * Math.PI * 2)])]
	}
	const color = hexColor(a.color)
	const patch = rasterStrokes(lines, size.width, size.height, width, color)
	if (!patch) throw new HttpError(400, 'this annotation is drawn outside its image')
	const patchFile = join(DATA_DIR, `.mark-${stamp}.rgba`)
	const output = join(DATA_DIR, `.mark-${stamp}.png`)
	try {
		await Bun.write(patchFile, patch.rgba)
		const font = await findMarkFont()
		const fontSize = Math.max(14, Math.round(short * 0.03))
		const hex = color.map((c) => c.toString(16).padStart(2, '0')).join('')
		// the number just outside the drawing's top-right corner, kept inside the image
		const lx = patch.left + patch.w
		const ly = patch.top - fontSize
		const text = font
			? `,drawtext=fontfile='${font.replace(/'/g, '')}':text='${number}':fontsize=${fontSize}:fontcolor=0x111111:box=1:boxcolor=0x${hex}:` +
				`boxborderw=${Math.round(fontSize / 4)}:x='min(max(${Math.round(fontSize / 4)},${lx}),w-tw-${Math.round(fontSize / 4)})':y='min(max(${Math.round(fontSize / 4)},${ly}),h-th-${Math.round(fontSize / 4)})'`
			: ''
		await run([
			'ffmpeg', '-y', '-v', 'error', '-i', input,
			'-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${patch.w}x${patch.h}`, '-i', patchFile,
			'-filter_complex', `[0:v][1:v]overlay=${patch.left}:${patch.top}:format=auto${text}${max ? `,${fitFilter(max)}` : ''}`,
			'-frames:v', '1', output,
		])
		return new Uint8Array(await Bun.file(output).arrayBuffer())
	} finally {
		await rm(patchFile, { force: true })
		await rm(output, { force: true })
	}
}

/** ffmpeg's scale filter that fits a picture inside max×max px (never enlarging it). */
const fitFilter = (max: number) => `scale='min(${max},iw)':'min(${max},ih)':force_original_aspect_ratio=decrease`

/** A "?max=" size limit in px (64-8000), or undefined for none. */
function sizeLimit(value: string | null): number | undefined {
	if (value === null || value === '') return undefined
	const n = Math.round(Number(value))
	if (!Number.isFinite(n) || n < 64 || n > 8000) throw new HttpError(400, '"max" must be a size in px from 64 to 8000')
	return n
}

const SHEET_FRAMES = 6
const SHEET_TILE_W = 640

/**
 * A video's contact sheet: SHEET_FRAMES frames at evenly spaced times, 3×2 tiles SHEET_TILE_W px
 * wide (each stamped with its time when a font is found), as a JPEG. For handing a video to a
 * model, which can't take the video itself.
 */
async function contactSheet(item: Item): Promise<{ bytes: Uint8Array; times: number[] }> {
	if (item.kind !== 'video') throw new HttpError(400, 'only videos have a contact sheet')
	if (!HAS_FFMPEG) throw new HttpError(501, 'contact sheets need ffmpeg on the canvas server')
	if (!item.src.startsWith('/media/')) throw new HttpError(400, 'this item\'s media is not stored on the canvas server')
	const input = join(MEDIA_DIR, basename(item.src))
	const times = sheetTimes(item.duration)
	const font = await findMarkFont()
	const output = join(DATA_DIR, `.sheet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`)
	const tiles = times.map((t, i) => {
		const label = font
			? `,drawtext=fontfile='${font.replace(/'/g, '')}':text='${t.toFixed(1)} s':fontsize=22:fontcolor=white:box=1:boxcolor=0x000000AA:boxborderw=6:x=10:y=h-th-12`
			: ''
		return `[${i}:v]trim=end_frame=1,setpts=PTS-STARTPTS,scale=${SHEET_TILE_W}:-2,setsar=1${label}[t${i}]`
	})
	const filter = `${tiles.join(';')};[t0][t1][t2]hstack=3[r0];[t3][t4][t5]hstack=3[r1];[r0][r1]vstack=2`
	try {
		await run([
			'ffmpeg', '-y', '-v', 'error',
			...times.flatMap((t) => ['-ss', String(t), '-i', input]),
			'-filter_complex', filter, '-frames:v', '1', '-q:v', '4', output,
		])
		return { bytes: new Uint8Array(await Bun.file(output).arrayBuffer()), times }
	} finally {
		await rm(output, { force: true })
	}
}

/** The times (seconds) a contact sheet shows: the middles of SHEET_FRAMES equal parts of the video. */
function sheetTimes(duration: number | undefined): number[] {
	const d = duration && duration > 0 ? duration : 0
	return Array.from({ length: SHEET_FRAMES }, (_, i) => Math.round(((d * (i + 0.5)) / SHEET_FRAMES) * 100) / 100)
}

/** A stored image as image content for an agent: as it is, or scaled to fit `max` px when it's bigger. */
async function imageForAgent(item: Item, src: string, max: number): Promise<{ data: Uint8Array; mimeType: string }> {
	const path = join(MEDIA_DIR, basename(src))
	const file = Bun.file(path)
	if (!(await file.exists())) throw new HttpError(404, 'the image file is missing')
	const big = src === item.src && Math.max(item.width, item.height) > max
	if (!big || !HAS_FFMPEG) return { data: new Uint8Array(await file.arrayBuffer()), mimeType: file.type.split(';')[0] || 'image/webp' }
	const png = extname(path).toLowerCase() === '.png'
	const output = join(DATA_DIR, `.fit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${png ? 'png' : 'jpg'}`)
	try {
		await run(['ffmpeg', '-y', '-v', 'error', '-i', path, '-frames:v', '1', '-vf', fitFilter(max), ...(png ? [] : ['-q:v', '3']), output])
		return { data: new Uint8Array(await Bun.file(output).arrayBuffer()), mimeType: png ? 'image/png' : 'image/jpeg' }
	} finally {
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
					resolved.items.push({ ...item, url: item.src ? MEDIA_ORIGIN + item.src : (item.pageUrl ?? ''), thumbUrl: item.thumb ? MEDIA_ORIGIN + item.thumb : '' })
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
		'get_item, post_item, update_item, delete_item, restore, plus say and highlight, which place a sticky note ' +
		'where you want people to look (they acknowledge it to remove it). OpenCode config: ' +
		`{"mcp": {"canvas": {"type": "remote", "url": "http://localhost:${PORT}/mcp"}}}. Pass your $OPENCODE_SESSION_ID ` +
		'as "sessionId" to post_item, say and highlight ("sessionTitle" is optional, see "frames").',
	frames:
		'Each frame is an OpenCode session. Its title, renames included, comes from OpenCode through the browsers ' +
		'paired with it (this server never talks to OpenCode): they report it, and whether the session was deleted, to ' +
		'PUT /api/canvases/:cid/opencode, and everyone sees that. A post\'s "sessionTitle" is only a fallback, shown ' +
		'until a paired browser has reported the session; it never replaces the title from OpenCode. A session OpenCode ' +
		'deleted keeps its frame and items, marked as ended ("opencode": {"deleted": true}).',
	endpoints: {
		'GET /api/canvases': 'All canvases, newest first, with session/item counts and preview thumbnails',
		'POST /api/canvases': 'Create a canvas. Body: {"title"} (optional). Returns it, with its id and viewKey',
		'GET /api/canvases/:cid': 'One canvas with all its sessions and items, its links, and "busy": the sessions working right now',
		'PATCH /api/canvases/:cid': 'Rename a canvas. Body: {"title"}',
		'DELETE /api/canvases/:cid': 'Delete a canvas with all its sessions, items and notes',
		'GET /api/view/:viewKey': 'A canvas by its view-only key (same body as GET /api/canvases/:cid)',
		'GET /api/canvases/:cid/sessions':
			'The canvas\'s sessions, each with its groups and their items, in frame order (left to right; hidden ones ' +
			'included where they\'d be, with "hidden": true)',
		'GET /api/canvases/:cid/sessions/:sessionId':
			'One session with its groups and items. "title" is what its frame shows; "opencode" is what its OpenCode last said ' +
			'about it (title, parentId, agent, directory, times, deleted), "postedTitle" the fallback it was posted with',
		'PUT /api/canvases/:cid/sessions/:sessionId':
			'Give a session a frame (if it has none). Body: {"title"?, "serverKey"?}: title is a fallback, shown until a paired ' +
			'browser reports the session from OpenCode (see "frames")',
		'PATCH /api/canvases/:cid/sessions/:sessionId':
			'Hide or show a session\'s frame for everyone: {"hidden": true|false}. A hidden frame isn\'t drawn but keeps its ' +
			'items and still takes posts; posting doesn\'t unhide it. Frames can\'t be renamed: rename the session in OpenCode',
		'PUT /api/canvases/:cid/opencode':
			'Paired browsers report the canvas\'s sessions as OpenCode has them: {"sessions": [{"sessionId", "serverKey", ' +
			'"title", "parentId"?, "agent"?, "directory"?, "createdAt"?, "updatedAt"?, "deleted"?}]}. Saved on the frames ' +
			'(sessions without one are ignored) and broadcast. Returns {"updated": [sessionId, …]}',
		'GET /api/canvases/:cid/order': 'The frames\' order, left to right: {"sessionIds"} (hidden sessions included)',
		'PUT /api/canvases/:cid/order':
			'Arrange the frames. Body: {"sessionIds": [...]} left to right; sessions left out follow, oldest first, and new ' +
			'sessions appear on the right. Returns the resulting {"sessionIds"}',
		'DELETE /api/canvases/:cid/sessions/:sessionId':
			'Delete a session and all its items (restorable for an hour, see restore), dropping its link to OpenCode (restoring doesn\'t bring it back)',
		'POST /api/canvases/:cid/sessions/:sessionId/populate':
			'Claim populating an empty session frame with what its OpenCode session involved (browsers do this when a session ' +
			'is added): {"ok": true, "populatedAt"} for the first caller, 409 once populated or when it has items. DELETE gives the claim back',
		'POST /api/canvases/:cid/sessions/:sessionId/items':
			'Add an image, video or HTML page. JSON {"path"} (file on this machine) or {"url"}, or multipart "file"; ' +
			'or JSON {"html": "<html source>"} for an HTML item, or {"page": "<URL>"} for a link to a web page, with its ' +
			'screenshot as "path"/"url" (or multipart "page" + "file") whenever you can (see "pages"). Plus optional "group", "title", "caption", "name". ' +
			'Optional "sessionTitle" (your OpenCode session\'s title): your frame\'s title until a browser paired with your ' +
			'OpenCode reports the session\'s own (see "frames"). Multipart uploads may also send "createdAt" ' +
			'(ms; orders the item in its group), and "sourceItemId" + "sourceTime" (a frame extracted from that video item, ' +
			'at that many seconds; kept on the item), and "addedBy" (browsers: a person dragged or pasted it onto the frame; ' +
			'the item gets "origin": "person" and "addedBy", see "person items"). Creates the session if needed. Iterating on something already ' +
			'posted? Replace it with PATCH /api/items/:itemId instead (post again only to show both versions side by side).',
		'GET /api/items/:itemId': 'One item',
		'GET /api/items/:itemId/sheet':
			'A video\'s contact sheet: 6 frames at evenly spaced times (the middles of 6 equal parts), 3×2 tiles 640 px wide, ' +
			'each stamped with its time, as a JPEG (the times, in seconds, also in the x-sheet-times header)',
		'POST /api/canvases/:cid/sessions/:sessionId/delivered':
			'Record what the session has of the person items in its frame (see "person items"): {"itemIds": [...], "messageId"?, ' +
			'"via": "submit"|"prompt"|"tool"} sets "delivered" on them (as of their current file); {"clear": true} clears it on ' +
			'all of the session\'s items (it compacted). Returns {"items"}: those changed',
		'PATCH /api/items/:itemId':
			'Change an item\'s "group", "title", "caption" (null clears) or "name", and/or replace its file in place: send a ' +
			'new file exactly as when posting (JSON {"path"}, {"url"} or {"html", "width", "height"}, or multipart "file" with ' +
			'the other fields as form fields). To show a new version of the same image, video or page, replace it instead of ' +
			'posting a new item: it keeps its id, link, session, group, title, caption and annotations (pinned to the same ' +
			'relative spots), gets a new media url (open canvases swap it live), takes the new file\'s kind, size and name ' +
			'(unless "name" is sent), and moves to the top of its group like a new post; HTML pages keep their width/height ' +
			'unless given new ones. Metadata-only changes don\'t move it. "width"/"height" alone resize an HTML item. ' +
			'{"page": "<URL>"} turns an item into a link to that page (or points a page item at another URL, keeping its screenshot ' +
			'unless a new one comes with it); on a page item, a new image file ("path", "url" or multipart "file") replaces its screenshot',
		'DELETE /api/items/:itemId':
			'Delete an item (restorable for an hour). Deleting a session\'s last item deletes the session too ' +
			'(the response says {"sessionDeleted": true})',
		'POST /api/canvases/:cid/restore':
			'Undo deletes within an hour of them. Body: {"itemIds": [...], "sessionIds": [...], "annotationIds": [...]} ' +
			'(any of them; annotationIds: annotations consumed by reading them). A session comes back with the items ' +
			'deleted along with it; an item brings back its session if that was deleted too. Returns {"sessions", ' +
			'"items", "annotations"}: what was restored',
		'PATCH /api/canvases/:cid/sessions/:sessionId/groups/:group': 'Rename a group. Body: {"name"} (null ungroups its items)',
		'DELETE /api/canvases/:cid/sessions/:sessionId/groups/:group': 'Delete a group and all its items (restorable for an hour)',
		'GET /api/canvases/:cid/presence':
			'Who has the canvas open right now: [{"clientId", "user": {"name", "color"}, "selection", "cursor", "view", "chat"}]. ' +
			'selection holds item ids as they are, "frame:<sessionId>" for session frames and "note:<noteId>" for sticky notes; ' +
			'cursor and view are in page coordinates. A linked session\'s live state (shared by its owner\'s tab) shows as a user ' +
			'with "agent": true and its "sessionId", without a cursor, plus "thinking" while it works. [] when nobody is there',
		'GET /api/canvases/:cid/notes':
			'The canvas\'s sticky notes: [{"id", "text", "author", "color", "x", "y", "createdAt"}]. Notes a session placed (say / ' +
			'highlight) also have "sessionId", "kind" and what they point at ("target", "point", "region", "at"); their x/y is where ' +
			'they were placed (on the canvas they follow their target)',
		'DELETE /api/canvases/:cid/notes/:noteId': 'Acknowledge (delete) a sticky note, for everyone: {"ok", "removed"}',
		'GET /api/canvases/:cid/annotations':
			'The user\'s annotations: freehand pencil drawings on an item (circling, underlining, arrows) with an optional ' +
			'text note, or text-only notes dropped on a spot, oldest first. Optional ?sessionId= (only that ' +
			'session\'s items) and ?itemId=. Reading with ?sessionId= consumes them: the ones returned are taken off the ' +
			'canvas (they fly into your frame, and wait in the trash for an hour: restore them with ' +
			'POST /api/canvases/:cid/restore {"annotationIds"}) and come back with "consumed": true. ?keep=true peeks ' +
			'instead; without ?sessionId= nothing is consumed unless you send ?keep=false. Each: {"id", "text", "author", "createdAt", "item": {"id", "kind", "name", "title", ' +
			'"group", "sessionId", "sessionTitle", "width", "height", "url" (the original file), "link", "sourceItemId" and ' +
			'"sourceTime" (seconds) when the item is a frame extracted from a video}, "strokes": [[[x, y], …], …] (each pencil ' +
			'stroke as pixel points in the original image; [] for a text-only note), "bbox": {"x", "y", "width", "height"} ' +
			'(the drawing\'s bounding box in pixels), "color", "anchor": {"x", "y" (0..1 across the item), "px", "py" ' +
			'(pixels in the original image: where the note sits, or a text-only note\'s spot)}}',
		'POST /api/canvases/:cid/annotations/consume':
			'Marks annotations delivered (the canvas\'s Submit annotations button sent them to their session as a prompt): ' +
			'they\'re consumed like a read with ?sessionId=. Body: {"ids": [...], "sessionId"}',
		'GET /api/canvases/:cid/annotations/:id/image':
			'The annotated image (or a video\'s poster frame) as a PNG with the annotation\'s pencil strokes drawn on it ' +
			'(a ring round the spot for a text-only note) and its number on that item: look at it to see what was circled. ' +
			'Videos are marked on their first frame at full size. ?max=<px> scales it to fit that size',
		'GET /api/canvases/:cid/selection':
			'What each person on the canvas has selected, resolved: {"users": [{"user", "selection", "items" (full items ' +
			'with absolute "url"/"thumbUrl"), "sessions" (with "itemCount"), "notes", "missing"}]}. Use this to answer ' +
			'"what have I selected?"',
		'GET /api/canvases/:cid/links':
			'Which browser runs each linked frame\'s session: [{"sessionId", "serverKey", "color", "ownerId", "online", "busy"}]. ' +
			'The canvas server never talks to OpenCode: the owner\'s browser does (people prompt the session from its frame), shares its ' +
			'streaming reply through the room while its tab is open ("online"); "busy": the session is working',
		'POST /api/canvases/:cid/links':
			'Link an OpenCode session to this browser. Body: {"sessionId", "serverKey" (non-secret id of its OpenCode), "ownerId" ' +
			'(the owner browser\'s random id)}. 409 if another browser linked it',
		'DELETE /api/canvases/:cid/links/:sessionId': 'Unlink a session',
		'GET /api/canvases/:cid/sessions/:sessionId/notes': 'The sticky notes the session placed that nobody has acknowledged yet, oldest first',
		'POST /api/canvases/:cid/sessions/:sessionId/notes':
			'Place a sticky note where you want people to look, from your session (its colour and title): it stays on the canvas, ' +
			'and in the "N things want your attention" bar at the top, until someone acknowledges it, which removes it. Body: ' +
			'{"kind": "say", "text"} (Markdown; the note goes at the top of your session\'s frame, which it creates if you have none yet) ' +
			'or {"kind": "highlight", "target", "text"?} (the note goes right next to the target) with target an item id, ' +
			'"<sessionId>/<group name>", "frame:<sessionId>" or "note:<noteId>". Point at what you mean: on an item pass "point": {"x", "y"} or ' +
			'"region": {"x", "y", "w", "h"} in the item\'s image pixels (same units as annotation px/py and the item\'s width/height): the note ' +
			'sits beside the spot without covering it, with a pointer to it; omit them only to mean the whole item. On a frame, group or note, ' +
			'"at": {"x", "y"} (canvas page coordinates) points at a spot. Plus "sessionTitle"? (a fallback title for your frame, see "frames"). ' +
			'Returns {"noteId", "waiting" (your notes not yet acknowledged on this canvas), "note"}. Fire-and-forget: you aren\'t told when it\'s acknowledged',
	},
	items:
		'Every item has a "name": its file name. On upload it is the original file name (the path\'s basename, the ' +
		'URL\'s last path segment or the multipart file name); inline {"html"} items get "<title or id>.html". Send ' +
		'"name" to choose it yourself.',
	'person items':
		'People can drag or paste media of their own (images, videos, HTML files) onto a session\'s frame: those items have ' +
		'"origin": "person" and "addedBy" (who). They are references people give the session, not its output: don\'t ' +
		'replace them (PATCH with a file makes an item the session\'s own, clearing origin). "delivered": {"sessionId", "src", ' +
		'"at", "messageId", "via"} says when the session last got its media; it no longer counts when the item\'s src or ' +
		'session differ, or the session compacted since. The canvas sends the ones the session doesn\'t have along with ' +
		'Submit annotations and prompts from the frame; an agent viewing one (MCP get_item with includeImage, list_annotations) ' +
		'counts too.',
	html:
		'HTML items are for diagrams, charts, SVG drawings and annotated explanations. Send {"html", "width", ' +
		'"height"} (or a .html/.htm file by path, url or multipart, with "width"/"height" as fields). width/height ' +
		`are the CSS pixel size the page is designed for (default ${HTML_DEFAULT_SIZE.width}x${HTML_DEFAULT_SIZE.height}, ` +
		`clamped to ${HTML_MIN_SIZE}-${HTML_MAX_SIZE}); the page is laid out at that size and scaled with the canvas, so ` +
		'it stays crisp at any zoom. Max 2 MB. It runs in a sandboxed iframe (scripts allowed, no same-origin access, ' +
		'no interaction: the canvas takes all input) so make it static and fit the given size without scrolling. ' +
		'A fragment is wrapped in a minimal page (UTF-8, no margin, white background); send a full document to ' +
		'control everything. Inline everything (styles, scripts, images as data: URLs).',
	pages:
		'Page items are links to web pages (a site, a dev server, a running deployment): send {"page": "<http(s) URL>"} ' +
		'(not "url" alone, which downloads a media file) and include a screenshot of it whenever you can — take one with ' +
		'your browser tooling and send it as "path" (or "url", or multipart "file" with a "page" field). The canvas server ' +
		'never fetches the URL itself, so any address works (localhost, Tailscale, private networks). With a screenshot the ' +
		'item shows it (with the link\'s domain); without one it shows as a link card (' + `${PAGE_CARD.width}x${PAGE_CARD.height}` + ') ' +
		'with the title (if you give one) or the host, and the URL. People open the real page from it. To update it, PATCH ' +
		'with a new screenshot and/or "page". pageUrl is the link; url (when there is a screenshot) is the screenshot.',
	layout:
		'Sessions sit side by side, newest on the right, unless people arranged them (see /order); hidden ones aren\'t shown. In a session, the group posted to most recently ' +
		'comes first; each group\'s items flow left to right in rows, newest first (an item whose file was replaced counts as ' +
		'new; frames taken from a video follow it). A session shows ' +
		'its newest 50 items; older ones stay stored and listed, and viewers can show more of them.',
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
		return json(orderedSessions(canvas.id).map(sessionView))
	}

	m = /^\/api\/canvases\/([^/]+)\/sessions\/([^/]+)\/populate$/.exec(p)
	if (m && (method === 'POST' || method === 'DELETE')) {
		const canvas = getCanvas(decodeURIComponent(m[1]))
		const session = getSession(canvas.id, decodeURIComponent(m[2]))
		if (method === 'POST') {
			// Once per session per canvas, and only into an empty frame.
			if (session.populatedAt) return json({ error: 'this session was already populated', populatedAt: session.populatedAt }, 409)
			if (sessionItems(canvas.id, session.id).length) return json({ error: 'this session already has items' }, 409)
			return json({ ok: true, populatedAt: setPopulated(session, Date.now()).populatedAt })
		}
		setPopulated(session, undefined)
		return json({ ok: true })
	}

	m = /^\/api\/canvases\/([^/]+)\/sessions\/([^/]+)$/.exec(p)
	if (m) {
		const canvas = getCanvas(decodeURIComponent(m[1]))
		const id = decodeURIComponent(m[2])
		if (method === 'GET') return json(sessionView(getSession(canvas.id, id)))
		if (method === 'PUT') {
			const body = (await req.json().catch(() => ({}))) as { title?: unknown; serverKey?: unknown }
			const existed = db.sessions.has(sessionKey(canvas.id, id))
			const serverKey = typeof body?.serverKey === 'string' && SERVER_KEY.test(body.serverKey) ? body.serverKey : undefined
			const session = ensureSession(canvas.id, assertSessionId(id), { postedTitle: textField(body?.title)?.slice(0, TITLE_MAX), serverKey })
			return json(sessionView(session), existed ? 200 : 201)
		}
		if (method === 'PATCH') {
			const body = (await req.json().catch(() => ({}))) as { title?: unknown; hidden?: unknown }
			if (body?.title !== undefined) throw new HttpError(400, 'frames are titled after their OpenCode session: rename the session in OpenCode')
			if (typeof body?.hidden !== 'boolean') throw new HttpError(400, 'send {"hidden": true|false}')
			return json(sessionView(setSessionHidden(getSession(canvas.id, id), body.hidden)))
		}
		if (method === 'DELETE') {
			deleteSession(getSession(canvas.id, id))
			return json({ ok: true })
		}
	}

	// Paired browsers mirror what OpenCode says about the canvas's sessions (see mirrorSessions).
	m = /^\/api\/canvases\/([^/]+)\/opencode$/.exec(p)
	if (m && method === 'PUT') {
		const canvas = getCanvas(decodeURIComponent(m[1]))
		const body = (await req.json().catch(() => null)) as { sessions?: unknown } | null
		if (!Array.isArray(body?.sessions)) throw new HttpError(400, 'send {"sessions": [{"sessionId", "serverKey", "title", …}]}')
		if (body.sessions.length > 500) throw new HttpError(400, 'at most 500 sessions at a time')
		return json({ updated: mirrorSessions(canvas.id, body.sessions.map(mirrorEntry)) })
	}

	m = /^\/api\/canvases\/([^/]+)\/order$/.exec(p)
	if (m) {
		const canvas = getCanvas(decodeURIComponent(m[1]))
		if (method === 'GET') return json({ sessionIds: orderedSessions(canvas.id).map((s) => s.id) })
		if (method === 'PUT') {
			const body = (await req.json().catch(() => ({}))) as { sessionIds?: unknown }
			const next = setSessionOrder(canvas, body?.sessionIds)
			return json({ sessionIds: orderedSessions(next.id).map((s) => s.id) })
		}
	}

	m = /^\/api\/canvases\/([^/]+)\/restore$/.exec(p)
	if (m && method === 'POST') {
		const canvas = getCanvas(decodeURIComponent(m[1]))
		const body = (await req.json().catch(() => ({}))) as { itemIds?: unknown; sessionIds?: unknown; annotationIds?: unknown }
		const sessionIds = idList(body?.sessionIds, 'sessionIds')
		const itemIds = idList(body?.itemIds, 'itemIds')
		const annotationIds = idList(body?.annotationIds, 'annotationIds')
		if (!sessionIds.length && !itemIds.length && !annotationIds.length) {
			throw new HttpError(400, 'send {"itemIds": [...]}, {"sessionIds": [...]} and/or {"annotationIds": [...]}')
		}
		return json(await restore(canvas.id, sessionIds, itemIds, annotationIds))
	}

	// ---- live room state: presence, notes, selections ----

	m = /^\/api\/canvases\/([^/]+)\/annotations$/.exec(p)
	if (m && method === 'GET') {
		const q = new URL(req.url).searchParams
		const sessionId = q.get('sessionId') || undefined
		// Agents read their feedback with ?sessionId=, which consumes it; anything else peeks unless it asks.
		const keepParam = q.get('keep')
		const keep = keepParam === null ? !sessionId : !/^(0|false|no)$/i.test(keepParam)
		return json(await readAnnotationsAsAgent(decodeURIComponent(m[1]), { sessionId, itemId: q.get('itemId') || undefined, keep, readerSessionId: sessionId }))
	}

	// The canvas submitted these annotations to their session as a prompt (see SubmitAnnotations):
	// delivered, so they're consumed the way an agent reading them would.
	m = /^\/api\/canvases\/([^/]+)\/annotations\/consume$/.exec(p)
	if (m && method === 'POST') {
		const body = (await req.json().catch(() => ({}))) as { ids?: unknown; sessionId?: unknown }
		const ids = idList(body?.ids, 'ids')
		if (!ids.length) throw new HttpError(400, 'send {"ids": [...], "sessionId"}')
		const sessionId = typeof body?.sessionId === 'string' && body.sessionId.trim() ? body.sessionId.trim() : undefined
		return json(await readAnnotationsAsAgent(decodeURIComponent(m[1]), { ids, sessionId, keep: false, readerSessionId: sessionId }))
	}

	m = /^\/api\/canvases\/([^/]+)\/annotations\/([^/]+)\/image$/.exec(p)
	if (m && method === 'GET') {
		const max = sizeLimit(url.searchParams.get('max'))
		const bytes = await markedImageBytes(decodeURIComponent(m[1]), decodeURIComponent(m[2]), { max })
		return new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { 'content-type': 'image/png', 'cache-control': 'no-store' } })
	}

	m = /^\/api\/canvases\/([^/]+)\/(presence|notes|selection)$/.exec(p)
	if (m && method === 'GET') {
		const canvas = getCanvas(decodeURIComponent(m[1]))
		if (m[2] === 'presence') return json(presence(canvas.id))
		if (m[2] === 'notes') return json(await readRoomDoc(`canvas-${canvas.id}`, readNotes))
		return json({ canvasId: canvas.id, users: await resolveSelections(canvas.id) })
	}

	// ---- session links (records only: owners' browsers talk to OpenCode) ----

	m = /^\/api\/canvases\/([^/]+)\/links$/.exec(p)
	if (m) {
		const canvas = getCanvas(decodeURIComponent(m[1]))
		if (method === 'GET') return json(sessionLinks(canvas.id))
		if (method === 'POST') return json(links.link(canvas.id, (await req.json().catch(() => null)) as Record<string, unknown> | null), 201)
	}

	m = /^\/api\/canvases\/([^/]+)\/links\/([^/]+)$/.exec(p)
	if (m && method === 'DELETE') {
		const canvas = getCanvas(decodeURIComponent(m[1]))
		const sessionId = decodeURIComponent(m[2])
		links.unlink(canvas.id, sessionId)
		return json({ ok: true })
	}

	// What a session has of the person items in its frame (see markDelivered).
	m = /^\/api\/canvases\/([^/]+)\/sessions\/([^/]+)\/delivered$/.exec(p)
	if (m && method === 'POST') {
		const canvas = getCanvas(decodeURIComponent(m[1]))
		const session = getSession(canvas.id, decodeURIComponent(m[2]))
		const changed = markDelivered(canvas.id, session.id, deliveryChange((await req.json().catch(() => null)) as Record<string, unknown> | null))
		return json({ items: changed })
	}

	// ---- agent sticky notes: what sessions want people to look at ----

	m = /^\/api\/canvases\/([^/]+)\/sessions\/([^/]+)\/notes$/.exec(p)
	if (m) {
		const canvas = getCanvas(decodeURIComponent(m[1]))
		const sessionId = decodeURIComponent(m[2])
		if (method === 'GET') return json(await attention.list(canvas.id, sessionId))
		if (method === 'POST') {
			const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
			const { note, waiting } = await attention.place(canvas.id, sessionId, body)
			return json({ noteId: note.id, waiting, note }, 201)
		}
	}

	m = /^\/api\/canvases\/([^/]+)\/notes\/([^/]+)$/.exec(p)
	if (m && method === 'DELETE') {
		const canvas = getCanvas(decodeURIComponent(m[1]))
		return json({ ok: true, removed: await attention.acknowledge(canvas.id, decodeURIComponent(m[2])) })
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
			const page = form.get('page')
			if (file !== null && !(file instanceof Blob)) throw new HttpError(400, '"file" must be a file')
			if (!file && !page) throw new HttpError(400, 'missing "file" field (or "page", a web page\'s URL)')
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
				...sourceFields(canvasId, form.get('sourceItemId'), form.get('sourceTime')),
				addedBy: textField(form.get('addedBy'))?.slice(0, ADDED_BY_MAX),
			}
			const source = file ? { data: file, filename: file instanceof File ? file.name : undefined } : null
			if (page) {
				const { width: _, height: __, ...rest } = meta
				return json(await addPageItem(canvasId, sessionId, pageField(page), source, rest), 201)
			}
			return json(await addItem(canvasId, sessionId, source!, meta), 201)
		}
		return json(await addItemFromJson(canvasId, sessionId, (await req.json().catch(() => null)) as ItemJson | null), 201)
	}

	m = /^\/api\/items\/([^/]+)\/sheet$/.exec(p)
	if (m && method === 'GET') {
		const { bytes, times } = await contactSheet(getItem(decodeURIComponent(m[1])))
		return new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'no-store', 'x-sheet-times': times.join(',') } })
	}

	m = /^\/api\/items\/([^/]+)$/.exec(p)
	if (m) {
		const item = getItem(decodeURIComponent(m[1]))
		if (method === 'GET') return json(item)
		if (method === 'PATCH') {
			if ((req.headers.get('content-type') ?? '').includes('multipart/form-data')) {
				const form = await req.formData()
				const file = form.get('file')
				if (file !== null && !(file instanceof Blob)) throw new HttpError(400, '"file" must be a file')
				const body: Record<string, unknown> = {}
				for (const key of ['group', 'title', 'caption', 'name', 'width', 'height', 'page']) if (form.has(key)) body[key] = form.get(key)
				// browsers send multipart text with CRLF line breaks
				if (typeof body.caption === 'string') body.caption = body.caption.replace(/\r\n?/g, '\n')
				return json(await patchItem(item, body, file ? { data: file, filename: file instanceof File ? file.name : undefined } : null))
			}
			const body = ((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>
			return json(await patchItem(item, body, await jsonSource(body)))
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
		// Other pages of the build answer without ".html" too: /playground, /playground/busy (web/playground/*.html).
		const file = (rel: string) => {
			const path = join(WEB_DIST, rel)
			return path.startsWith(WEB_DIST) && existsSync(path) && statSync(path).isFile() && statSync(path).size > 0 ? path : null
		}
		const bare = p.replace(/\/+$/, '')
		const path = p === '/' ? file('index.html') : (file(p) ?? (bare ? (file(`${bare}.html`) ?? file(`${bare}/index.html`)) : null))
		if (path) return serveFile(req, path, path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store')
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
	sessionViews: (canvasId) => orderedSessions(canvasId).map(sessionView),
	notes: (canvasId) => readRoomDoc(`canvas-${canvasId}`, readNotes),
	annotations: readAnnotationsAsAgent,
	presence,
	selections: resolveSelections,
	createCanvas: (title) => createCanvas(canvasTitle(title)),
	getItem,
	addItem: (canvasId, sessionId, body) => addItemFromJson(getCanvas(canvasId).id, assertSessionId(sessionId), body as ItemJson),
	updateItem: async (id, body) => patchItem(getItem(id), body, await jsonSource(body)),
	deleteItem: (id) => deleteItem(getItem(id).id),
	restore,
	placeNote: (canvasId, sessionId, body) => attention.place(getCanvas(canvasId).id, sessionId, body),
	mediaFile: (src) => Bun.file(join(MEDIA_DIR, basename(src))),
	markedImage: (canvasId, annotationId, max) => markedImageBytes(canvasId, annotationId, { max }),
	imageForAgent: (item, src, max) => imageForAgent(item, src, max),
	markDelivered: (canvasId, sessionId, itemIds) => markDelivered(canvasId, sessionId, { itemIds, via: 'tool' }),
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
			// Edit tabs paired with OpenCode say which of the canvas's sessions are working (see busy.ts).
			else if (ws.data.canvasId && typeof message === 'string') busyReport(ws, ws.data.canvasId, message)
		},
		close(ws) {
			if (ws.data.kind === 'live') {
				liveSockets.delete(ws)
				busy.closed(ws)
			}
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

function busyReport(ws: object, canvasId: string, message: string) {
	let data: { type?: unknown; sessionIds?: unknown } | null = null
	try {
		data = JSON.parse(message)
	} catch {}
	if (data?.type === 'busy') busy.report(ws, canvasId, data.sessionIds)
}

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
		if (e instanceof HttpError || e instanceof LinkError || e instanceof AttentionError) return json({ error: e.message }, e.status)
		console.error(e)
		return json({ error: 'internal error' }, 500)
	}
}

if (!process.env.CANVAS_QUIET) console.log(`canvas server on http://localhost:${PORT}  (data: ${DATA_DIR})`)

backfillDurations()


/** Videos posted before items had a duration get one, read in the background one at a time. */
async function backfillDurations() {
	if (!HAS_FFMPEG) return
	for (const item of [...db.items.values()]) {
		if (item.kind !== 'video' || item.duration !== undefined || !item.src.startsWith('/media/')) continue
		const path = join(MEDIA_DIR, basename(item.src))
		if (!existsSync(path)) continue
		const duration = await probeDuration(path)
		const current = db.items.get(item.id)
		if (duration === undefined || !current || current.duration !== undefined) continue
		const next = { ...current, duration }
		db.items.set(next.id, next)
		save()
		broadcast({ type: 'item', item: next })
	}
}
