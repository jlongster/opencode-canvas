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
		const { users } = await api<{ users: ResolvedSelection[] }>('GET', `/canvases/${id}/selection`)
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
		const people = await api<PresenceEntry[]>('GET', `/canvases/${id}/presence`)
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
		return ok(itemDetail(await api<Item>('PATCH', `/items/${encodeURIComponent(itemId)}`, body)))
	}),
)

server.registerTool(
	'delete_item',
	{
		description: 'Delete an item (restorable for an hour with restore). Deleting a session\'s last item removes the session too.',
		inputSchema: { itemId: z.string() },
	},
	tool(async ({ itemId }: { itemId: string }) => ok(await api('DELETE', `/items/${encodeURIComponent(itemId)}`))),
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
		return ok({ sessions: restored.sessions.map((s) => ({ id: s.id, title: s.title })), items: restored.items.map(itemSummary) })
	}),
)

await server.connect(new StdioServerTransport())
