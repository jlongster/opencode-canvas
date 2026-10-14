#!/usr/bin/env bun
/**
 * MCP server for the review canvas: lets agents list canvases, see what people on a canvas have
 * selected, read notes, inspect items (including the images themselves) and post or edit items.
 * Speaks MCP over stdio and talks to the canvas HTTP API at $CANVAS_API.
 *
 *   CANVAS_API=http://localhost:4410/api bun mcp/server.ts
 *
 * TODO: interactions/annotations tools (e.g. draw attention to an item, reply on a note, annotate a
 * region of an image) once the canvas supports them.
 */
import { resolve } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'
import { z } from 'zod'
import type {
	Canvas, CanvasData, CanvasSummary, Item, Note, PresenceEntry, ResolvedSelection, Session, SessionView,
} from '../shared/types'

const API = (process.env.CANVAS_API ?? 'http://localhost:4410/api').replace(/\/+$/, '')
/** Media URLs are relative to the server root: the API base without its trailing /api. */
const MEDIA_BASE = API.replace(/\/api$/, '')
/** Where people open canvases in a browser, for links in results. */
const WEB_BASE = (process.env.CANVAS_WEB ?? 'https://jamesbox.exe.xyz/canvas').replace(/\/+$/, '')
const HTML_TEXT_MAX = 200_000

// ---------- HTTP ----------

class ApiError extends Error {}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
	let res: Response
	try {
		res = await fetch(API + path, {
			method,
			headers: body === undefined ? undefined : { 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body),
		})
	} catch (e) {
		throw new ApiError(`canvas API unreachable at ${API}: ${(e as Error).message}`)
	}
	const text = await res.text()
	let data: unknown
	try {
		data = text ? JSON.parse(text) : null
	} catch {
		data = text
	}
	if (!res.ok) {
		const message = (data as { error?: string } | null)?.error ?? text
		throw new ApiError(`${method} ${path} → ${res.status}: ${message}`)
	}
	return data as T
}

const mediaUrl = (src: string) => (/^https?:/.test(src) ? src : MEDIA_BASE + src)

// ---------- canvases ----------

const CANVAS_ID = /^[A-Za-z0-9]{10}$/
const VIEW_KEY = /^[A-Za-z0-9]{16}$/

/** A canvas id from an id, an edit URL (…/c/<id>), a view URL (…/v/<viewKey>) or a bare view key. */
async function canvasId(ref: string): Promise<string> {
	const value = ref.trim()
	const edit = /\/c\/([A-Za-z0-9]{10})(?:[/?#]|$)/.exec(value)?.[1]
	if (edit) return edit
	const view = /\/v\/([A-Za-z0-9]{16})(?:[/?#]|$)/.exec(value)?.[1] ?? (VIEW_KEY.test(value) ? value : undefined)
	if (view) return (await api<CanvasData>('GET', `/view/${view}`)).canvas.id
	if (CANVAS_ID.test(value)) return value
	throw new ApiError(`not a canvas id or URL: ${JSON.stringify(ref)} (expected a 10-character id, …/c/<id> or …/v/<viewKey>)`)
}

const canvasLink = (c: Canvas) => `${WEB_BASE}/c/${c.id}`

/** The fields of an item an agent usually needs, with absolute media URLs. */
function itemSummary(item: Item) {
	return {
		id: item.id,
		name: item.name,
		...(item.title ? { title: item.title } : {}),
		kind: item.kind,
		width: item.width,
		height: item.height,
		...(item.group ? { group: item.group } : {}),
		...(item.caption ? { caption: item.caption } : {}),
		url: mediaUrl(item.src),
		...(item.kind === 'video' ? { thumbUrl: mediaUrl(item.thumb) } : {}),
	}
}

function itemDetail(item: Item) {
	return { ...itemSummary(item), canvasId: item.canvasId, sessionId: item.sessionId, createdAt: item.createdAt, thumbUrl: mediaUrl(item.thumb) }
}

const noteSummary = (n: Note) => ({ id: n.id, text: n.text, author: n.author, color: n.color, x: Math.round(n.x), y: Math.round(n.y) })

// ---------- results ----------

const ok = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })

/** Runs a tool body, turning failures into tool errors the model can read. */
function tool<A>(fn: (args: A) => Promise<CallToolResult>) {
	return async (args: A): Promise<CallToolResult> => {
		try {
			return await fn(args)
		} catch (e) {
			return { isError: true, content: [{ type: 'text', text: (e as Error).message }] }
		}
	}
}

// ---------- agent presence ----------
// While an agent works on a canvas it joins the canvas's multiplayer room like a browser does, so
// people see it in the avatar stack: its selection outlines what it's working on and its chat says
// what it just did. It has no cursor or view. It leaves after a while without tool calls.

const ROOMS_URL = API.replace(/^http/, 'ws') + '/rooms'
const AGENT_COLOR = '#22d3ee'
const AGENT_IDLE_MS = 2 * 60_000
/** a little longer than browsers keep a sent chat message up, so the fade-out finishes first */
const AGENT_CHAT_MS = 6000
const SESSION_ID = process.env.OPENCODE_SESSION_ID

interface AgentRoom {
	provider: WebsocketProvider
	doc: Y.Doc
	name: string
	selection: string[]
	chat: string | null
	idleTimer?: ReturnType<typeof setTimeout>
	chatTimer?: ReturnType<typeof setTimeout>
}

const agentRooms = new Map<string, AgentRoom>()

function fallbackAgentName() {
	return SESSION_ID ? `Agent ses_…${SESSION_ID.slice(-6)}` : 'Agent'
}

function agentName(sessions: Session[]) {
	const title = SESSION_ID ? sessions.find((s) => s.id === SESSION_ID)?.title.trim() : undefined
	if (!title) return fallbackAgentName()
	return `Agent · ${title.length > 32 ? title.slice(0, 31) + '…' : title}`
}

/** Joins the canvas's room (once) and shows what the agent is doing there. Never throws. */
function agentActivity(canvasId: string, activity: { selection?: string[]; chat?: string; sessions?: Session[] }) {
	try {
		let room = agentRooms.get(canvasId)
		if (!room) {
			const doc = new Y.Doc()
			const provider = new WebsocketProvider(ROOMS_URL, `canvas-${canvasId}`, doc, {
				WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
				disableBc: true,
			})
			room = { provider, doc, name: fallbackAgentName(), selection: [], chat: null }
			agentRooms.set(canvasId, room)
			if (!activity.sessions) {
				const joined = room
				api<CanvasData>('GET', `/canvases/${canvasId}`)
					.then((data) => {
						if (agentRooms.get(canvasId) !== joined) return
						joined.name = agentName(data.sessions)
						publishAgent(joined)
					})
					.catch(() => {})
			}
		}
		if (activity.sessions) room.name = agentName(activity.sessions)
		if (activity.selection) room.selection = activity.selection
		if (activity.chat !== undefined) {
			room.chat = activity.chat.slice(0, 140)
			clearTimeout(room.chatTimer)
			const r = room
			r.chatTimer = setTimeout(() => {
				r.chat = null
				publishAgent(r)
			}, AGENT_CHAT_MS)
		}
		clearTimeout(room.idleTimer)
		room.idleTimer = setTimeout(() => leaveCanvas(canvasId), AGENT_IDLE_MS)
		publishAgent(room)
	} catch {
		// presence is decoration: never let it break a tool call
	}
}

function publishAgent(room: AgentRoom) {
	room.provider.awareness.setLocalState({
		user: { name: room.name, color: AGENT_COLOR, agent: true },
		cursor: null,
		selection: room.selection,
		view: null,
		chat: room.chat,
		chatSent: true,
	})
}

function leaveCanvas(canvasId: string) {
	const room = agentRooms.get(canvasId)
	if (!room) return
	agentRooms.delete(canvasId)
	clearTimeout(room.idleTimer)
	clearTimeout(room.chatTimer)
	room.provider.awareness.setLocalState(null)
	room.provider.destroy()
	room.doc.destroy()
}

/** The agent's own awareness client id on a canvas, to leave it out of presence results. */
const ownClientId = (canvasId: string) => agentRooms.get(canvasId)?.doc.clientID

const itemLabel = (item: Item) => item.title || item.name

let shuttingDown = false
function shutdown() {
	if (shuttingDown) return
	shuttingDown = true
	for (const id of [...agentRooms.keys()]) leaveCanvas(id)
	// give the awareness removals a moment to reach the server
	setTimeout(() => process.exit(0), 100)
}
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGHUP', shutdown)

// ---------- tools ----------

const server = new McpServer({ name: 'canvas', version: '1.0.0' })

const canvasArg = z
	.string()
	.describe('Canvas id, or a canvas URL such as https://jamesbox.exe.xyz/canvas/c/<id> or a view link …/v/<viewKey>')

server.registerTool(
	'list_canvases',
	{
		description: 'List all review canvases, newest first, with their ids, titles, links and session/item counts.',
		inputSchema: {},
	},
	tool(async () => {
		const canvases = await api<CanvasSummary[]>('GET', '/canvases')
		return ok(
			canvases.map((c) => ({ id: c.id, title: c.title, link: canvasLink(c), sessions: c.sessionCount, items: c.itemCount, createdAt: c.createdAt })),
		)
	}),
)

server.registerTool(
	'get_canvas',
	{
		description:
			'Everything on one canvas: its sessions (one frame per OpenCode session), each with its groups and their items ' +
			'(id, name, title, kind, size, media url), plus its sticky notes.',
		inputSchema: { canvas: canvasArg },
	},
	tool(async ({ canvas }: { canvas: string }) => {
		const id = await canvasId(canvas)
		const [data, sessions, notes] = await Promise.all([
			api<CanvasData>('GET', `/canvases/${id}`),
			api<SessionView[]>('GET', `/canvases/${id}/sessions`),
			api<Note[]>('GET', `/canvases/${id}/notes`),
		])
		const ownFrame = SESSION_ID && sessions.some((s) => s.id === SESSION_ID) ? [`frame:${SESSION_ID}`] : []
		agentActivity(id, { selection: ownFrame, chat: 'Looking over the canvas', sessions: data.sessions })
		return ok({
			id,
			title: data.canvas.title,
			link: canvasLink(data.canvas),
			sessions: sessions.map((s) => ({
				id: s.id,
				title: s.title,
				groups: s.groups.map((g) => ({ name: g.name, items: g.items.map((i) => itemSummary(i)) })),
			})),
			notes: notes.map(noteSummary),
		})
	}),
)

server.registerTool(
	'create_canvas',
	{
		description: 'Create a new canvas. Returns its id and links (edit link and view-only link).',
		inputSchema: { title: z.string().optional().describe('Canvas title (default "Untitled canvas")') },
	},
	tool(async ({ title }: { title?: string }) => {
		const canvas = await api<Canvas>('POST', '/canvases', title === undefined ? {} : { title })
		return ok({ id: canvas.id, title: canvas.title, link: canvasLink(canvas), viewLink: `${WEB_BASE}/v/${canvas.viewKey}` })
	}),
)

server.registerTool(
	'get_selection',
	{
		description:
			'What each person who has the canvas open has selected right now, resolved into the selected items (with ids, ' +
			'names, groups, sessions and media urls), session frames and sticky notes. Use this when the user says ' +
			'"look at what I selected" or refers to "this"/"these" on the canvas. Pass the result\'s item ids to get_item ' +
			'with includeImage to actually see images.',
		inputSchema: { canvas: canvasArg },
	},
	tool(async ({ canvas }: { canvas: string }) => {
		const id = await canvasId(canvas)
		agentActivity(id, { selection: [], chat: 'Checking what you\'ve selected' })
		const own = ownClientId(id)
		const users = (await api<{ users: ResolvedSelection[] }>('GET', `/canvases/${id}/selection`)).users.filter((u) => u.clientId !== own)
		return ok({
			canvasId: id,
			users: users.map((u) => ({
				name: u.user.name,
				color: u.user.color,
				items: u.items.map((i) => ({ ...itemSummary(i), sessionId: i.sessionId })),
				sessions: u.sessions.map((s) => ({ id: s.id, title: s.title, itemCount: s.itemCount })),
				notes: u.notes.map(noteSummary),
				...(u.missing.length ? { missing: u.missing } : {}),
			})),
			...(users.length ? {} : { hint: 'nobody has this canvas open right now' }),
		})
	}),
)

server.registerTool(
	'get_presence',
	{
		description:
			'Who has the canvas open right now: name, colour, cursor position and visible area (page coordinates), ' +
			'cursor-chat message and raw selection ids.',
		inputSchema: { canvas: canvasArg },
	},
	tool(async ({ canvas }: { canvas: string }) => {
		const id = await canvasId(canvas)
		const own = ownClientId(id)
		const people = (await api<PresenceEntry[]>('GET', `/canvases/${id}/presence`)).filter((p) => p.clientId !== own)
		return ok(
			people.map((p) => ({
				clientId: p.clientId,
				name: p.user.name,
				color: p.user.color,
				cursor: p.cursor,
				view: p.view,
				chat: p.chat,
				selection: p.selection,
			})),
		)
	}),
)

server.registerTool(
	'list_notes',
	{
		description: 'The sticky notes on a canvas: id, text, author, colour and position.',
		inputSchema: { canvas: canvasArg },
	},
	tool(async ({ canvas }: { canvas: string }) => {
		const id = await canvasId(canvas)
		agentActivity(id, { selection: [], chat: 'Reading the sticky notes' })
		return ok((await api<Note[]>('GET', `/canvases/${id}/notes`)).map(noteSummary))
	}),
)

server.registerTool(
	'find_items',
	{
		description: 'Search a canvas\'s items: case-insensitive match on file name, title, caption or group. Returns matching items with ids and urls.',
		inputSchema: { canvas: canvasArg, query: z.string().describe('Text to look for') },
	},
	tool(async ({ canvas, query }: { canvas: string; query: string }) => {
		const id = await canvasId(canvas)
		const { items, sessions } = await api<CanvasData>('GET', `/canvases/${id}`)
		const q = query.trim().toLowerCase()
		const titles = new Map(sessions.map((s: Session) => [s.id, s.title]))
		const found = items
			.filter((i) => [i.name, i.title, i.caption, i.group].some((f) => f?.toLowerCase().includes(q)))
			.sort((a, b) => a.createdAt - b.createdAt)
			.map((i) => ({ ...itemSummary(i), sessionId: i.sessionId, session: titles.get(i.sessionId) }))
		agentActivity(id, { selection: found.slice(0, 50).map((i) => i.id), chat: `Searching for "${query.trim()}"`, sessions })
		return ok(found)
	}),
)

server.registerTool(
	'get_item',
	{
		description:
			'One item with its absolute media url. With includeImage, images (and video poster frames) are returned as image ' +
			'content so you can see them; HTML items always include their HTML source.',
		inputSchema: {
			itemId: z.string().describe('Item id'),
			includeImage: z.boolean().optional().describe('Return the image itself (images and videos)'),
			fullSize: z.boolean().optional().describe('With includeImage: send the original image instead of the 512px thumbnail'),
		},
	},
	tool(async ({ itemId, includeImage, fullSize }: { itemId: string; includeImage?: boolean; fullSize?: boolean }) => {
		const item = await api<Item>('GET', `/items/${encodeURIComponent(itemId)}`)
		const zoom = includeImage && fullSize && item.kind === 'image' ? ' (zoomed)' : ''
		agentActivity(item.canvasId, { selection: [item.id], chat: `Looking at ${itemLabel(item)}${zoom}` })
		const result: CallToolResult = { content: [{ type: 'text', text: JSON.stringify(itemDetail(item)) }] }
		if (item.kind === 'html') {
			const res = await fetch(mediaUrl(item.src))
			if (!res.ok) throw new ApiError(`could not fetch the HTML (${res.status})`)
			let html = await res.text()
			if (html.length > HTML_TEXT_MAX) html = html.slice(0, HTML_TEXT_MAX) + '\n<!-- truncated -->'
			result.content.push({ type: 'text', text: html })
		} else if (includeImage) {
			const src = item.kind === 'image' && fullSize ? item.src : item.thumb
			const res = await fetch(mediaUrl(src))
			if (!res.ok) throw new ApiError(`could not fetch the image (${res.status})`)
			const mimeType = res.headers.get('content-type')?.split(';')[0] || 'image/webp'
			const data = Buffer.from(await res.arrayBuffer()).toString('base64')
			result.content.push({ type: 'image', data, mimeType })
		}
		return result
	}),
)

server.registerTool(
	'post_item',
	{
		description:
			'Post an image, video or HTML page to a canvas, into your session\'s frame. Give exactly one of path (a file on ' +
			'this machine), url, or html (inline HTML: diagrams, charts, annotated explanations; set width/height to the CSS ' +
			'pixel size it is designed for, default 800x600). Use group to organise items within the session.',
		inputSchema: {
			canvas: canvasArg,
			sessionId: z.string().optional().describe('Your OpenCode session id ("ses_…"); defaults to $OPENCODE_SESSION_ID'),
			path: z.string().optional().describe('Path of an image/video/HTML file on this machine'),
			url: z.string().optional().describe('URL of an image/video/HTML file to fetch'),
			html: z.string().optional().describe('Inline HTML (a fragment or a full document)'),
			width: z.number().optional().describe('HTML items: CSS pixel width the page is laid out at'),
			height: z.number().optional().describe('HTML items: CSS pixel height'),
			group: z.string().optional().describe('Group name within the session'),
			title: z.string().optional().describe('Shown above the item'),
			caption: z.string().optional().describe('Longer description, shown on hover'),
			name: z.string().optional().describe('File name (defaults to the original file name)'),
		},
	},
	tool(async (args: {
		canvas: string
		sessionId?: string
		path?: string
		url?: string
		html?: string
		width?: number
		height?: number
		group?: string
		title?: string
		caption?: string
		name?: string
	}) => {
		const sources = [args.path, args.url, args.html].filter((s) => s !== undefined)
		if (sources.length !== 1) throw new ApiError('give exactly one of path, url or html')
		const sessionId = args.sessionId ?? process.env.OPENCODE_SESSION_ID
		if (!sessionId) throw new ApiError('no sessionId given and $OPENCODE_SESSION_ID is not set')
		const id = await canvasId(args.canvas)
		const { canvas: _, sessionId: __, path, ...rest } = args
		const body = { ...rest, ...(path !== undefined ? { path: resolve(path) } : {}) }
		const item = await api<Item>('POST', `/canvases/${id}/sessions/${encodeURIComponent(sessionId)}/items`, body)
		agentActivity(id, { selection: [item.id], chat: `Posted ${itemLabel(item)}` })
		// the post may have created our session frame, so pick up its title for the agent's name
		if (sessionId === SESSION_ID) {
			api<CanvasData>('GET', `/canvases/${id}`)
				.then((data) => agentActivity(id, { sessions: data.sessions }))
				.catch(() => {})
		}
		return ok(itemDetail(item))
	}),
)

server.registerTool(
	'update_item',
	{
		description: 'Change an item\'s file name, title, caption or group. Pass null to clear title, caption or group.',
		inputSchema: {
			itemId: z.string(),
			name: z.string().optional(),
			title: z.string().nullable().optional(),
			caption: z.string().nullable().optional(),
			group: z.string().nullable().optional(),
		},
	},
	tool(async ({ itemId, ...changes }: { itemId: string; name?: string; title?: string | null; caption?: string | null; group?: string | null }) => {
		const body = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined))
		if (!Object.keys(body).length) throw new ApiError('nothing to change: give name, title, caption or group')
		const item = await api<Item>('PATCH', `/items/${encodeURIComponent(itemId)}`, body)
		agentActivity(item.canvasId, { selection: [item.id], chat: `Updated ${itemLabel(item)}` })
		return ok(itemDetail(item))
	}),
)

server.registerTool(
	'delete_item',
	{
		description: 'Delete an item (restorable for an hour with restore). Deleting a session\'s last item removes the session too.',
		inputSchema: { itemId: z.string() },
	},
	tool(async ({ itemId }: { itemId: string }) => {
		const item = await api<Item>('GET', `/items/${encodeURIComponent(itemId)}`).catch(() => null)
		const result = await api('DELETE', `/items/${encodeURIComponent(itemId)}`)
		if (item) agentActivity(item.canvasId, { selection: [], chat: `Deleted ${itemLabel(item)}` })
		return ok(result)
	}),
)

server.registerTool(
	'restore',
	{
		description:
			'Undo deletes made within the last hour: items by id and/or whole sessions by session id. Returns what was restored.',
		inputSchema: {
			canvas: canvasArg,
			itemIds: z.array(z.string()).optional(),
			sessionIds: z.array(z.string()).optional(),
		},
	},
	tool(async ({ canvas, itemIds, sessionIds }: { canvas: string; itemIds?: string[]; sessionIds?: string[] }) => {
		const id = await canvasId(canvas)
		const restored = await api<{ sessions: Session[]; items: Item[] }>('POST', `/canvases/${id}/restore`, { itemIds, sessionIds })
		const count = restored.items.length
		agentActivity(id, {
			selection: [...restored.sessions.map((s) => `frame:${s.id}`), ...restored.items.map((i) => i.id)],
			chat: `Restored ${count} item${count === 1 ? '' : 's'}`,
		})
		return ok({ sessions: restored.sessions.map((s) => ({ id: s.id, title: s.title })), items: restored.items.map(itemSummary) })
	}),
)

await server.connect(new StdioServerTransport())
