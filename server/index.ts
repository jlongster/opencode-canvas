import { mkdir, rename, rm } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import * as Y from 'yjs'
import type {
	Annotation, AnnotationView, AttentionAction, Canvas, CanvasData, CanvasSummary, ConjuredAgent, Item, MediaKind, Note, PresenceEntry, ResolvedSelection, ServerEvent, Session,
	SessionView,
} from '../shared/types'
import { computeLayout, LAYOUT, orderSessions } from '../web/src/editor/layout'
import { homeSpot, rushSpot } from '../web/src/multiplayer/Pointer'
import { AttentionError, createAttention } from './attention'
import { ConjureError, createConjured } from './conjured'
import { imageSize } from './imageSize'
import { createPages, PAGE_MAX_HEIGHT, PageError } from './pages'
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
	/** OpenCode sessions on canvases as creatures (see conjured.ts) */
	conjured?: ConjuredAgent[]
	/** creatures' queued attention actions (see attention.ts) */
	attention?: AttentionAction[]
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
let storedConjured: ConjuredAgent[] = []
let storedAttention: AttentionAction[] = []
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
		home: (canvasId, sessionId, at) => {
			const frame = canvasLayout(canvasId).sections.find((s) => s.id === sessionId)
			return frame ? homeSpot(at, frame.box) : at
		},
	},
	storedConjured,
)

const attention = createAttention(
	{
		canvasExists: (id) => db.canvases.has(id),
		save,
		broadcast: (event) => broadcast(event),
		resolveTarget: (canvasId, target) => resolveTarget(canvasId, target),
		itemSize: (target) => {
			const item = db.items.get(target)
			return item ? { width: item.width, height: item.height } : null
		},
		ensureCreature: (canvasId, sessionId, title) => {
			// The frame follows the session's title (renames included), when it has a frame.
			if (title && db.sessions.has(sessionKey(canvasId, sessionId))) ensureSession(canvasId, sessionId, title)
			void conjured.ensure(canvasId, sessionId, {
				title: title ?? db.sessions.get(sessionKey(canvasId, sessionId))?.title,
				at: () => creatureSpot(canvasId, sessionId),
			})
		},
	},
	storedAttention,
)

/** how far apart (page px) creatures placed by the server sit */
const CREATURE_GAP = 90
/** a creature this far (page px) above a frame still sits on it, in its title strip, and moves with it */
const CREATURE_REACH = 200

function canvasLayout(canvasId: string) {
	const sessions = Object.fromEntries(canvasSessions(canvasId).map((s) => [s.id, s]))
	const items = Object.fromEntries([...db.items.values()].filter((i) => i.canvasId === canvasId).map((i) => [i.id, i]))
	return computeLayout(sessions, items, db.canvases.get(canvasId)?.sessionOrder)
}

/**
 * Runs a change that moves frames (hiding, showing, reordering them), then moves the creatures
 * along with them: each with its own frame (by which it always stays), or one without a frame with
 * the frame it sits on (or above, in its title strip). Only the server moves creatures.
 */
function framesMoving<T>(canvasId: string, change: () => T): T {
	const before = canvasLayout(canvasId)
	const result = change()
	const after = canvasLayout(canvasId)
	for (const r of conjured.list(canvasId)) {
		const from =
			before.sections.find((s) => s.id === r.sessionId) ??
			before.sections.find((s) => r.x >= s.box.x && r.x <= s.box.x + s.box.w && r.y >= s.box.y - CREATURE_REACH && r.y <= s.box.y + s.box.h)
		const to = from && after.sections.find((s) => s.id === from.id)
		if (to) conjured.shift(canvasId, r.sessionId, to.box.x - from.box.x)
	}
	return result
}

/** a burst of posts to one session: its creature rushes to the last, this long (ms) after it */
const RUSH_SETTLE_MS = 400
const rushes = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * An item was posted to (or replaced in) its session: the session's creature, if it has one, rushes
 * over to point at it, stopping just outside its edge nearest where it was (see rushSpot). The server
 * moves it, for everyone; a burst only sends it to the last.
 */
function rushTo(item: Item) {
	const k = sessionKey(item.canvasId, item.sessionId)
	clearTimeout(rushes.get(k))
	rushes.set(
		k,
		setTimeout(() => {
			rushes.delete(k)
			const r = conjured.list(item.canvasId).find((c) => c.sessionId === item.sessionId)
			const box = db.items.get(item.id) && canvasLayout(item.canvasId).items.get(item.id)
			if (r && box) conjured.rush(item.canvasId, item.sessionId, item.id, rushSpot(r, box))
		}, RUSH_SETTLE_MS),
	)
}

/**
 * Where a creature the server makes for a session goes: in its frame's title strip, just after the
 * title (roughly: the server can't measure text), or where its frame would appear if it has none;
 * moved along to the right until it's clear of the canvas's other creatures.
 */
function creatureSpot(canvasId: string, sessionId: string) {
	const sessions = Object.fromEntries(canvasSessions(canvasId).map((s) => [s.id, s]))
	const items = Object.fromEntries([...db.items.values()].filter((i) => i.canvasId === canvasId).map((i) => [i.id, i]))
	const layout = computeLayout(sessions, items, db.canvases.get(canvasId)?.sessionOrder)
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

/** fontconfig fonts by pattern, for drawn page cards */
const fonts = new Map<string, Promise<string | null>>()
function fontFor(pattern: string) {
	if (!fonts.has(pattern)) {
		fonts.set(
			pattern,
			Bun.which('fc-match') ? run(['fc-match', '-f', '%{file}', pattern]).then((f) => (f.trim() && existsSync(f.trim()) ? f.trim() : null), () => null) : Promise.resolve(null),
		)
	}
	return fonts.get(pattern)!
}

/**
 * Whether page items may show private and local addresses (localhost, 10.x, 192.168.x, …): yes when
 * the server only listens on this machine (`bunx opencode-canvas` binds 127.0.0.1), so people can
 * put their dev servers on a canvas; no when it listens on every interface (a shared server, like
 * jamesbox), where it would let anyone probe its network. CANVAS_PAGES_PRIVATE=1/0 decides instead.
 */
const PAGES_PRIVATE = process.env.CANVAS_PAGES_PRIVATE
	? /^(1|true|yes)$/i.test(process.env.CANVAS_PAGES_PRIVATE)
	: !!HOSTNAME && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(HOSTNAME)

const pages = createPages({
	mediaDir: MEDIA_DIR,
	hasFfmpeg: HAS_FFMPEG,
	run,
	probe,
	makeThumb,
	font: fontFor,
	allowPrivate: PAGES_PRIVATE,
	log: (m) => !process.env.CANVAS_QUIET && console.log(m),
})

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
	// HTML items have no image thumbnail, nor pages until their first snapshot.
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
	/** the OpenCode session's title: the session's frame is named after it (following renames) */
	sessionTitle?: string
	/** a frame extracted from a video (see Item.sourceItemId) */
	sourceItemId?: string
	sourceTime?: number
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
	ensureSession(canvasId, sessionId, opts.sessionTitle || undefined)
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
		createdAt: opts.createdAt ?? Date.now(),
	}
	db.items.set(id, item)
	save()
	broadcast({ type: 'item', item })
	rushTo(item)
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
	/** a web page to snapshot (a page item) */
	page?: unknown
	fullPage?: unknown
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
		if ([body.path, body.url, body.html].some((v) => v !== undefined && v !== null)) throw new HttpError(400, 'send one of "page", "path", "url" or "html"')
		const { width: _, height: __, ...rest } = meta
		return addPageItem(canvasId, sessionId, await pageField(body.page), pageOptions(body), rest)
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
		if (source) throw new HttpError(400, 'send one of "page", "path", "url" or "html"')
		return replacePage(item, await pageField(body.page), pageOptions(body, item.kind === 'page' ? item.page : undefined), changes)
	}
	if (item.kind === 'page' && !source && (isTrue(body.refresh) || ['width', 'height', 'fullPage'].some((k) => body[k] !== undefined))) {
		return refreshPage(item, pageOptions(body, item.page), changes)
	}
	if (body.refresh !== undefined && !source) throw new HttpError(400, '"refresh" only re-snapshots page items')
	const width = sizeField(body.width, 'width')
	const height = sizeField(body.height, 'height')
	if (!source) {
		const resize = width !== undefined || height !== undefined
		if (resize && item.kind !== 'html') throw new HttpError(400, '"width"/"height" only resize HTML items and re-snapshot pages (or size a new HTML file)')
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
	cancelSnapshot(item.id)
	// No longer a frame of the video it was taken from, nor its old length, nor a web page.
	const { duration: _, sourceItemId: __, sourceTime: ___, pageUrl: _p, page: _pi, snapshotAt: _s, ...rest } = current
	const next = applyChanges(
		{ ...rest, ...media, name: (filename && basename(filename)) || withExtension(current.name, media.src), createdAt: Date.now() },
		changes,
	)
	commitItem(next)
	rushTo(next)
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

// ---------- pages (snapshots of web pages, see pages.ts) ----------

const PAGE_DEFAULT = { width: 1280, height: 800 }
type PageView = { width: number; height: number; fullPage?: true }
const PAGE_MIN = { width: 320, height: 200 }
const PAGE_MAX_WIDTH = 3840

const isTrue = (v: unknown) => v === true || v === 'true' || v === '1'

/** A "page" from the request: an http(s) URL this server may snapshot. */
async function pageField(value: unknown): Promise<string> {
	if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, '"page" must be the URL of a web page')
	return (await pages.checkUrl(value.trim())).href
}

/** A page's viewport: "width"/"height" (CSS px) and "fullPage", each defaulting to `current` (or 1280×800). */
function pageOptions(body: Record<string, unknown> | ItemJson, current?: Item['page']) {
	const num = (value: unknown, name: string, min: number, max: number, fallback: number) => {
		if (value === undefined || value === null || value === '') return fallback
		const n = Number(value)
		if (!Number.isFinite(n)) throw new HttpError(400, `"${name}" must be a number (CSS pixels)`)
		return Math.round(Math.min(max, Math.max(min, n)))
	}
	const fullPage = body.fullPage === undefined || body.fullPage === null ? !!current?.fullPage : isTrue(body.fullPage)
	return {
		width: num(body.width, 'width', PAGE_MIN.width, PAGE_MAX_WIDTH, current?.width ?? PAGE_DEFAULT.width),
		height: num(body.height, 'height', PAGE_MIN.height, PAGE_MAX_HEIGHT, current?.height ?? PAGE_DEFAULT.height),
		...(fullPage ? { fullPage: true as const } : {}),
	}
}

const pageName = (url: string) => `${new URL(url).hostname.replace(/^www\./, '') || 'page'}.png`

/** Posts a page item: it appears straight away, "loading", and its snapshot follows (see snapshotPage). */
async function addPageItem(
	canvasId: string,
	sessionId: string,
	url: string,
	view: PageView,
	opts: Omit<ItemOptions, 'width' | 'height'>,
): Promise<Item> {
	getCanvas(canvasId)
	ensureSession(canvasId, sessionId, opts.sessionTitle || undefined)
	const id = opts.id ?? newId()
	const item: Item = {
		id,
		canvasId,
		sessionId,
		kind: 'page',
		name: opts.name ?? pageName(url),
		src: '',
		thumb: '',
		width: view.width,
		height: view.height,
		...(opts.group ? { group: opts.group } : {}),
		title: opts.title,
		caption: opts.caption,
		pageUrl: url,
		page: { url, ...view, status: 'loading' },
		createdAt: opts.createdAt ?? Date.now(),
	}
	commitItem(item)
	rushTo(item)
	snapshotPage(id)
	return item
}

/** Turns an item into a snapshot of `url` (or points a page at another URL), in place. */
async function replacePage(item: Item, url: string, view: PageView, changes: ItemChanges): Promise<Item> {
	cancelSnapshot(item.id)
	const wasPage = item.kind === 'page'
	const { duration: _, sourceItemId: __, sourceTime: ___, ...rest } = item
	// A title that was the old page's own follows the new page's.
	if (wasPage && item.title && item.title === item.page?.title) delete rest.title
	const next = applyChanges(
		{
			...rest,
			kind: 'page',
			// a page keeps showing its last snapshot until the new one is ready
			...(wasPage ? {} : { src: '', thumb: '', width: view.width, height: view.height }),
			name: pageName(url),
			pageUrl: url,
			page: { url, ...view, status: 'loading' },
			createdAt: Date.now(),
		},
		changes,
	)
	commitItem(next)
	rushTo(next)
	if (!wasPage) await removeItemFiles(item)
	snapshotPage(item.id)
	return next
}

/** Takes a page item's snapshot again (POST /api/items/:id/refresh, update_item refresh), optionally with a new viewport. */
function refreshPage(item: Item, view?: PageView, changes: ItemChanges = {}): Item {
	if (item.kind !== 'page' || !item.page) throw new HttpError(400, 'only page items have a snapshot to refresh')
	cancelSnapshot(item.id)
	const { fullPage: _, error: __, ...page } = item.page
	const next = applyChanges({ ...item, page: { ...page, ...(view ?? { width: page.width, height: page.height, ...(item.page.fullPage ? { fullPage: true } : {}) }), status: 'loading' } }, changes)
	commitItem(next)
	snapshotPage(item.id)
	return next
}

/** The latest snapshot job of each page item: older ones finishing late are thrown away. */
const snapshotJobs = new Map<string, { token: number; done: Promise<void> }>()
let snapshotToken = 0

function cancelSnapshot(id: string) {
	snapshotJobs.delete(id)
}

/** Waits (up to `ms`) for a page item's snapshot in progress, if there is one. */
async function snapshotSettled(id: string, ms: number) {
	const job = snapshotJobs.get(id)
	if (job) await Promise.race([job.done, Bun.sleep(ms)])
}

/** Snapshots a page item in the background and swaps it in for everyone (or marks it failed). */
function snapshotPage(id: string) {
	const token = ++snapshotToken
	const done = (async () => {
		const item = db.items.get(id)
		if (!item?.page) return
		const { url, width, height, fullPage } = item.page
		const base = `${id}-${randomId(8)}`
		let shot: Awaited<ReturnType<typeof pages.snapshot>> | null = null
		let error: string | null = null
		try {
			shot = await pages.snapshot(url, { width, height, fullPage }, base)
		} catch (e) {
			error = (e as Error).message || 'the snapshot failed'
		}
		const current = db.items.get(id)
		if (!current?.page || current.kind !== 'page' || snapshotJobs.get(id)?.token !== token) {
			if (shot) await removeItemFiles({ src: `/media/${shot.file}`, thumb: `/media/${shot.thumb}` })
			return
		}
		snapshotJobs.delete(id)
		if (!shot) {
			if (!process.env.CANVAS_QUIET) console.warn(`snapshot of ${url} failed: ${error}`)
			commitItem({ ...current, page: { ...current.page, status: 'failed', error: error! } })
			return
		}
		const { error: _, title: oldTitle, ...page } = current.page
		const next: Item = {
			...current,
			src: `/media/${shot.file}`,
			thumb: `/media/${shot.thumb}`,
			width: shot.width,
			height: shot.height,
			pageUrl: shot.finalUrl,
			snapshotAt: Date.now(),
			page: { ...page, status: 'ready', via: shot.via, ...(shot.title ? { title: shot.title } : {}) },
		}
		// The page's own title, unless someone gave the item another.
		if (shot.title && (!current.title || current.title === oldTitle)) next.title = shot.title
		commitItem(next)
		await removeItemFiles(current)
	})().catch((e) => console.error('page snapshot failed:', e))
	snapshotJobs.set(id, { token, done })
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
 * Gets a session, creating it if needed. `title` renames it: PUT /sessions/:sid, and a post's
 * `sessionTitle`, which keeps the frame named after its OpenCode session as that is renamed.
 */
function ensureSession(canvasId: string, id: string, title?: string): Session {
	const key = sessionKey(canvasId, id)
	const existing = db.sessions.get(key)
	if (existing && (title === undefined || existing.title === title)) return existing
	const session: Session = existing
		? { ...existing, title: title! }
		: { id, canvasId, title: title ?? '', createdAt: Date.now() }
	db.sessions.set(key, session)
	save()
	broadcast({ type: 'session', session })
	return session
}

async function removeItemFiles(item: Pick<Item, 'src' | 'thumb'>) {
	for (const src of new Set([item.src, item.thumb])) {
		if (src?.startsWith('/media/')) await rm(join(MEDIA_DIR, basename(src)), { force: true })
	}
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

/**
 * Moves a session and all its items to the trash, and banishes its creature (clearing its attention
 * queue). Restoring the session doesn't bring the creature back: it can be conjured again.
 */
function deleteSession(session: Session) {
	const items = sessionItems(session.canvasId, session.id)
	for (const item of items) deleteItem(item.id, { keepSession: true })
	db.sessions.delete(sessionKey(session.canvasId, session.id))
	const entry: TrashEntry = { kind: 'session', session, itemIds: items.map((i) => i.id), deletedAt: Date.now() }
	trash.set(trashKey(entry), entry)
	save()
	broadcast({ type: 'session_deleted', canvasId: session.canvasId, id: session.id })
	conjured.drop(session.canvasId, session.id)
	attention.clear(session.canvasId, session.id)
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
	// a page deleted while its snapshot was being taken
	if (item.kind === 'page' && item.page?.status === 'loading' && !snapshotJobs.has(id)) snapshotPage(id)
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

// Creatures saved without a position (by a server that didn't keep them) go beside their frame's
// title, unless 0,0 is somewhere on a frame (its very corner doesn't count).
conjured.placeStrays((r) => {
	const sessions = Object.fromEntries(canvasSessions(r.canvasId).map((s) => [s.id, s]))
	const items = Object.fromEntries([...db.items.values()].filter((i) => i.canvasId === r.canvasId).map((i) => [i.id, i]))
	const layout = computeLayout(sessions, items, db.canvases.get(r.canvasId)?.sessionOrder)
	const onFrame = layout.sections.some(({ box }) => r.x > box.x && r.x < box.x + box.w && r.y > box.y && r.y < box.y + box.h)
	return onFrame ? null : creatureSpot(r.canvasId, r.sessionId)
})
// Ones left far from their frame (before creatures kept by it) come back beside it.
conjured.bringHome()
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
 * annotations_consumed event to animate them away, into `readerSessionId`'s creature if it has one)
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
				url: /^https?:/.test(item.src) ? item.src : MEDIA_ORIGIN + item.src,
				...(item.pageUrl ? { pageUrl: item.pageUrl } : {}),
				link: `${WEB_BASE}/c/${canvas.id}#item=${encodeURIComponent(item.id)}`,
				...(item.sourceItemId ? { sourceItemId: item.sourceItemId, sourceTime: item.sourceTime } : {}),
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
async function markedImage(canvasId: string, annotationId: string): Promise<Response> {
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
	const src = item.kind === 'video' ? item.thumb : item.src
	if (!src) throw new HttpError(409, 'this page\'s snapshot isn\'t ready yet')
	if (/^https?:/.test(src)) throw new HttpError(400, 'this item\'s media is not stored on the canvas server')
	const input = join(MEDIA_DIR, basename(src))
	const size = await probe(input)
	const number = all.filter((v) => v.item.id === item.id).findIndex((v) => v.id === a.id) + 1
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
	const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
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
			'-filter_complex', `[0:v][1:v]overlay=${patch.left}:${patch.top}:format=auto${text}`,
			'-frames:v', '1', output,
		])
		const bytes = await Bun.file(output).arrayBuffer()
		return new Response(bytes, { headers: { 'content-type': 'image/png', 'cache-control': 'no-store' } })
	} finally {
		await rm(patchFile, { force: true })
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
		'GET /api/canvases/:cid/sessions':
			'The canvas\'s sessions, each with its groups and their items, in frame order (left to right; hidden ones ' +
			'included where they\'d be, with "hidden": true)',
		'GET /api/canvases/:cid/sessions/:sessionId': 'One session with its groups and items',
		'PUT /api/canvases/:cid/sessions/:sessionId': 'Create or rename a session. Body: {"title"}',
		'PATCH /api/canvases/:cid/sessions/:sessionId':
			'Hide or show a session\'s frame for everyone: {"hidden": true|false} (and/or {"title"} to rename). A hidden ' +
			'frame isn\'t drawn but keeps its items and still takes posts; posting doesn\'t unhide it',
		'GET /api/canvases/:cid/order': 'The frames\' order, left to right: {"sessionIds"} (hidden sessions included)',
		'PUT /api/canvases/:cid/order':
			'Arrange the frames. Body: {"sessionIds": [...]} left to right; sessions left out follow, oldest first, and new ' +
			'sessions appear on the right. Returns the resulting {"sessionIds"}',
		'DELETE /api/canvases/:cid/sessions/:sessionId':
			'Delete a session and all its items (restorable for an hour, see restore), banishing its creature (restoring doesn\'t bring it back)',
		'POST /api/canvases/:cid/sessions/:sessionId/items':
			'Add an image, video or HTML page. JSON {"path"} (file on this machine) or {"url"}, or multipart "file"; ' +
			'or JSON {"html": "<html source>"} for an HTML item, or JSON {"page": "<https URL>", "width"?, "height"?, "fullPage"?} ' +
			'for a snapshot of a live web page (see "pages"). Plus optional "group", "title", "caption", "name". ' +
			'Send "sessionTitle" (your OpenCode session\'s title, from `opencode api get /api/session/$OPENCODE_SESSION_ID` ' +
			'→ .data.title) with every post, JSON or multipart: it keeps the session\'s frame named after your session, ' +
			'following renames. Multipart uploads may also send "createdAt" ' +
			'(ms; orders the item in its group), and "sourceItemId" + "sourceTime" (a frame extracted from that video item, ' +
			'at that many seconds; kept on the item). Creates the session if needed. Iterating on something already ' +
			'posted? Replace it with PATCH /api/items/:itemId instead (post again only to show both versions side by side).',
		'GET /api/items/:itemId': 'One item',
		'POST /api/items/:itemId/refresh':
			'Take a page item\'s snapshot again (after the site changed): it shows "loading" (keeping the old snapshot) and updates live. Returns the item',
		'PATCH /api/items/:itemId':
			'Change an item\'s "group", "title", "caption" (null clears) or "name", and/or replace its file in place: send a ' +
			'new file exactly as when posting (JSON {"path"}, {"url"} or {"html", "width", "height"}, or multipart "file" with ' +
			'the other fields as form fields). To show a new version of the same image, video or page, replace it instead of ' +
			'posting a new item: it keeps its id, link, session, group, title, caption and annotations (pinned to the same ' +
			'relative spots), gets a new media url (open canvases swap it live), takes the new file\'s kind, size and name ' +
			'(unless "name" is sent), and moves to the top of its group like a new post; HTML pages keep their width/height ' +
			'unless given new ones. Metadata-only changes don\'t move it. "width"/"height" alone resize an HTML item. ' +
			'{"page": "<URL>"} points an item at a web page (re-snapshotted); on a page item {"refresh": true}, or "width"/"height"/"fullPage" alone, re-snapshots it',
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
			'cursor and view are in page coordinates. [] when nobody is there',
		'GET /api/canvases/:cid/notes': 'The canvas\'s sticky notes: [{"id", "text", "author", "color", "x", "y", "createdAt"}]',
		'GET /api/canvases/:cid/annotations':
			'The user\'s annotations: freehand pencil drawings on an item (circling, underlining, arrows) with an optional ' +
			'text note, or text-only notes dropped on a spot, oldest first. Optional ?sessionId= (only that ' +
			'session\'s items) and ?itemId=. Reading with ?sessionId= consumes them: the ones returned are taken off the ' +
			'canvas (they fly into your creature, and wait in the trash for an hour: restore them with ' +
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
			'(a ring round the spot for a text-only note) and its number on that item: look at it to see what was circled',
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
			'(the owner browser\'s random id), "title"?, "x"?, "y"?}. It goes at x/y (page position) when given, else beside its ' +
			'session\'s frame. Adopts an ownerless one (moved to x/y if given, else where it is); 409 if that session is already here',
		'POST /api/canvases/:cid/conjured/:sessionId/move':
			'Its owner moves a creature (summoning it, dragging it). Body: {"x", "y" (page position), "ownerId"}. 403 unless ownerId is ' +
			'its owner\'s; an ownerless one is adopted on the way when "serverKey" (and "title"?) is sent too',
		'PATCH /api/canvases/:cid/conjured/:sessionId':
			'Rename a creature. Body: {"title"} (sending "x"/"y" is refused with 403: only its owner moves it, with POST …/move)',
		'DELETE /api/canvases/:cid/conjured/:sessionId': 'Banish a creature (and clear its attention queue)',
		'GET /api/canvases/:cid/actions': 'Every queued attention action on the canvas, oldest first: [{"id", "sessionId", "kind", "text"?, "target"?, "point"?, "region"?, "at"?, "createdAt"}]',
		'GET /api/canvases/:cid/sessions/:sessionId/actions': 'The session\'s queued attention actions, in order',
		'POST /api/canvases/:cid/sessions/:sessionId/actions':
			'Queue something for people to look at, on the session\'s creature (made beside its frame if it has none). Body: ' +
			'{"kind": "say", "text"} (Markdown) or {"kind": "highlight", "target", "text"?} with target an item id, ' +
			'"<sessionId>/<group name>", "frame:<sessionId>" or "note:<noteId>". Point at what you mean: on an item pass "point": {"x", "y"} or ' +
			'"region": {"x", "y", "w", "h"} in the item\'s image pixels (same units as annotation px/py and the item\'s width/height); omit them only ' +
			'to highlight the whole item. On a frame, group or note, "at": {"x", "y"} (canvas page coordinates) points at a spot. Plus "sessionTitle" (names the creature, and the session\'s frame if it has one, after your session). ' +
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
	pages:
		'Page items put a real, live web page (a site, a running deployment) on the canvas as a snapshot: send {"page": ' +
		'"https://…"} (not "url", which downloads a media file). The canvas server opens it in a headless Chromium at ' +
		`"width" (default ${PAGE_DEFAULT.width}) × "height" (default ${PAGE_DEFAULT.height}) CSS px, or the whole page with ` +
		`"fullPage": true (up to ${PAGE_MAX_HEIGHT}px tall), waits for the network to go quiet (about 15s at most) and stores ` +
		'a PNG. The post returns at once (201) with page.status "loading"; the snapshot follows live (status "ready", or ' +
		'"failed" with page.error). Without a browser on the server it falls back to the page\'s preview (og:image) or a ' +
		'drawn card (page.via "card"). The item\'s title becomes the page\'s <title> unless you give one; pageUrl is the URL ' +
		'after redirects, snapshotAt when it was taken. People see the snapshot (with a link badge) and open the real page ' +
		'from it. After the site changes, refresh it (POST /api/items/:itemId/refresh). ' +
		(PAGES_PRIVATE ? 'This server may snapshot local and private addresses (it only listens on this machine).' : 'Private and local addresses (localhost, 10.x, 192.168.x, …) are refused on this server.'),
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
		return json(orderedSessions(canvas.id).map(sessionView))
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
		if (method === 'PATCH') {
			const body = (await req.json().catch(() => ({}))) as { title?: unknown; hidden?: unknown }
			if (body?.hidden !== undefined && typeof body.hidden !== 'boolean') throw new HttpError(400, '"hidden" must be true or false')
			if (body?.hidden === undefined && body?.title === undefined) throw new HttpError(400, 'send {"hidden": true|false} and/or {"title"}')
			let session = getSession(canvas.id, id)
			const title = textField(body.title)
			if (title !== undefined) session = ensureSession(canvas.id, id, title)
			if (typeof body.hidden === 'boolean') {
				const hidden = body.hidden
				const current = session
				session = framesMoving(canvas.id, () => setSessionHidden(current, hidden))
			}
			return json(sessionView(session))
		}
		if (method === 'DELETE') {
			deleteSession(getSession(canvas.id, id))
			return json({ ok: true })
		}
	}

	m = /^\/api\/canvases\/([^/]+)\/order$/.exec(p)
	if (m) {
		const canvas = getCanvas(decodeURIComponent(m[1]))
		if (method === 'GET') return json({ sessionIds: orderedSessions(canvas.id).map((s) => s.id) })
		if (method === 'PUT') {
			const body = (await req.json().catch(() => ({}))) as { sessionIds?: unknown }
			const next = framesMoving(canvas.id, () => setSessionOrder(canvas, body?.sessionIds))
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
			const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
			return json(conjured.conjure(canvas.id, body, () => creatureSpot(canvas.id, sessionId)), 201)
		}
	}

	m = /^\/api\/canvases\/([^/]+)\/conjured\/([^/]+)\/move$/.exec(p)
	if (m && method === 'POST') {
		const canvas = getCanvas(decodeURIComponent(m[1]))
		const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
		return json(conjured.move(canvas.id, decodeURIComponent(m[2]), body))
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
				...sourceFields(canvasId, form.get('sourceItemId'), form.get('sourceTime')),
			}
			const filename = file instanceof File ? file.name : undefined
			return json(await addItem(canvasId, sessionId, { data: file, filename }, meta), 201)
		}
		return json(await addItemFromJson(canvasId, sessionId, (await req.json().catch(() => null)) as ItemJson | null), 201)
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
				for (const key of ['group', 'title', 'caption', 'name', 'width', 'height']) if (form.has(key)) body[key] = form.get(key)
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

	m = /^\/api\/items\/([^/]+)\/refresh$/.exec(p)
	if (m && method === 'POST') return json(refreshPage(getItem(decodeURIComponent(m[1]))))

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
	snapshotSettled,
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
		if (e instanceof HttpError || e instanceof ConjureError || e instanceof AttentionError || e instanceof PageError) return json({ error: e.message }, e.status)
		console.error(e)
		return json({ error: 'internal error' }, 500)
	}
}

if (!process.env.CANVAS_QUIET) console.log(`canvas server on http://localhost:${PORT}  (data: ${DATA_DIR})`)

backfillDurations()

// Page snapshots the server was taking when it stopped are taken again.
for (const item of db.items.values()) if (item.kind === 'page' && item.page?.status === 'loading') snapshotPage(item.id)

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
