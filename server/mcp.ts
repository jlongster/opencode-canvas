/**
 * The canvas MCP server, served over Streamable HTTP at /mcp (and /canvas/mcp) by the canvas
 * server itself, so every OpenCode session connects to the same endpoint:
 *
 *   "canvas": { "type": "remote", "url": "http://localhost:4410/mcp" }
 *
 * Tools let agents list canvases, see what people on a canvas have selected, read notes, inspect
 * items (including the images themselves) and post, edit or replace items. They call the server's own
 * functions (see CanvasMcpDeps) rather than its HTTP API.
 *
 * Each MCP client gets its own session (the mcp-session-id header) with its own McpServer and
 * transport. A request for a session the server doesn't know (it was closed after being idle, or
 * the server restarted) quietly starts it again under the same id, since clients don't reconnect
 * by themselves.
 *
 * MCP is only a way to call tools: agents have no presence of their own on a canvas. To get
 * people's attention, say and highlight queue actions on the calling session's creature (see
 * attention.ts), which people step through on the canvas.
 */
import type { BunFile } from 'bun'
import { isAbsolute } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { LATEST_PROTOCOL_VERSION, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type {
	Annotation, AnnotationView, AttentionAction, Canvas, CanvasData, CanvasSummary, Item, Note, PresenceEntry, ResolvedSelection, Session, SessionView,
} from '../shared/types'
import { ATTENTION_TEXT_MAX } from './attention'

/** What the MCP tools need from the canvas server. Functions throw (with a readable message) on bad input. */
export interface CanvasMcpDeps {
	listCanvases(): CanvasSummary[]
	getCanvas(id: string): Canvas
	canvasByViewKey(key: string): Canvas
	canvasData(id: string): CanvasData
	sessionViews(canvasId: string): SessionView[]
	notes(canvasId: string): Promise<Note[]>
	/**
	 * annotations resolved against their items (see GET /api/canvases/:cid/annotations). Unless `keep`,
	 * the ones returned are consumed: taken off the canvas (into readerSessionId's creature) and trashed.
	 */
	annotations(
		canvasId: string,
		filter?: { sessionId?: string; itemId?: string; keep?: boolean; readerSessionId?: string },
	): Promise<AnnotationView[]>
	presence(canvasId: string): PresenceEntry[]
	selections(canvasId: string): Promise<ResolvedSelection[]>
	createCanvas(title?: string): Canvas
	getItem(id: string): Item
	/** same body and validation as POST /api/canvases/:cid/sessions/:sessionId/items */
	addItem(canvasId: string, sessionId: string, body: Record<string, unknown>): Promise<Item>
	/** same JSON body and validation as PATCH /api/items/:itemId: metadata changes and/or a new file */
	updateItem(id: string, body: Record<string, unknown>): Promise<Item>
	deleteItem(id: string): { sessionDeleted: boolean }
	restore(
		canvasId: string,
		sessionIds: string[],
		itemIds: string[],
		annotationIds?: string[],
	): Promise<{ sessions: Session[]; items: Item[]; annotations: Annotation[] }>
	/** same body and validation as POST /api/canvases/:cid/sessions/:sessionId/actions */
	queueAction(canvasId: string, sessionId: string, body: Record<string, unknown>): Promise<{ action: AttentionAction; position: number; queued: number }>
	/** a /media/… path as a file */
	mediaFile(src: string): BunFile
	/** absolute base for /media/… URLs in results */
	mediaOrigin: string
	/** where people open canvases in a browser, for links in results */
	webBase: string
}

const HTML_TEXT_MAX = 200_000
const CANVAS_ID = /^[A-Za-z0-9]{10}$/
const VIEW_KEY = /^[A-Za-z0-9]{16}$/
const OPENCODE_SESSION = /^ses_[A-Za-z0-9]{26}$/
/** MCP sessions without requests for this long are closed */
const MCP_IDLE_MS = 60 * 60_000
const MCP_SWEEP_MS = 5 * 60_000

class ToolError extends Error {}

export function createCanvasMcp(deps: CanvasMcpDeps) {
	const mediaUrl = (src: string) => (/^https?:/.test(src) ? src : deps.mediaOrigin + src)
	const canvasLink = (c: Canvas) => `${deps.webBase}/c/${c.id}`

	/** A canvas id from an id, an edit URL (…/c/<id>), a view URL (…/v/<viewKey>) or a bare view key. */
	function canvasId(ref: string): string {
		const value = ref.trim()
		const edit = /\/c\/([A-Za-z0-9]{10})(?:[/?#]|$)/.exec(value)?.[1]
		if (edit) return deps.getCanvas(edit).id
		const view = /\/v\/([A-Za-z0-9]{16})(?:[/?#]|$)/.exec(value)?.[1] ?? (VIEW_KEY.test(value) ? value : undefined)
		if (view) return deps.canvasByViewKey(view).id
		if (CANVAS_ID.test(value)) return deps.getCanvas(value).id
		throw new ToolError(`not a canvas id or URL: ${JSON.stringify(ref)} (expected a 10-character id, …/c/<id> or …/v/<viewKey>)`)
	}

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
			...(item.sourceItemId ? { sourceItemId: item.sourceItemId, sourceTime: item.sourceTime } : {}),
			url: mediaUrl(item.src),
			...(item.kind === 'video' ? { thumbUrl: mediaUrl(item.thumb) } : {}),
			...(item.duration !== undefined ? { duration: item.duration } : {}),
		}
	}

	const itemDetail = (item: Item) => ({
		...itemSummary(item), canvasId: item.canvasId, sessionId: item.sessionId, createdAt: item.createdAt, thumbUrl: mediaUrl(item.thumb),
	})

	/** An annotation as get_canvas lists it: what it says and where, with the item referred to by id. */
	const annotationSummary = (a: AnnotationView) => ({
		id: a.id, text: a.text, author: a.author, itemId: a.item.id, anchor: a.anchor, createdAt: a.createdAt,
	})

	const noteSummary = (n: Note) => ({ id: n.id, text: n.text, author: n.author, color: n.color, x: Math.round(n.x), y: Math.round(n.y) })

	// ---------- MCP sessions ----------

	interface McpSession {
		transport: WebStandardStreamableHTTPServerTransport
		lastSeen: number
	}

	const sessions = new Map<string, McpSession>()

	/** The calling OpenCode session: the sessionId argument, else an x-opencode-session-id header. */
	function sessionOf(extra: Extra, sessionId: string | undefined): string {
		const header = extra.requestInfo?.headers['x-opencode-session-id']
		const given = sessionId?.trim() || (Array.isArray(header) ? header[0] : header)?.trim() || ''
		if (!OPENCODE_SESSION.test(given)) {
			throw new ToolError(`sessionId must be your exact OpenCode session id ($OPENCODE_SESSION_ID: "ses_" + 26 characters), got ${JSON.stringify(given)}`)
		}
		return given
	}

	type Extra = { sessionId?: string; requestInfo?: { headers: Record<string, string | string[] | undefined> } }

	function closeSession(id: string, s: McpSession) {
		if (sessions.get(id) === s) sessions.delete(id)
	}

	function newSession(id: string = crypto.randomUUID()): McpSession {
		const s: McpSession = {
			transport: new WebStandardStreamableHTTPServerTransport({
				sessionIdGenerator: () => id,
				enableJsonResponse: true,
				onsessioninitialized: () => void sessions.set(id, s),
			}),
			lastSeen: Date.now(),
		}
		s.transport.onclose = () => closeSession(id, s)
		buildServer().connect(s.transport).catch((e) => console.error('mcp connect failed:', e))
		return s
	}

	/** Starts a session the client thinks exists (we closed it or restarted) under the same id. */
	async function reviveSession(id: string, req: Request): Promise<McpSession> {
		const s = newSession(id)
		const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
		const protocolVersion = req.headers.get('mcp-protocol-version') ?? LATEST_PROTOCOL_VERSION
		const init = await s.transport.handleRequest(new Request(req.url, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				jsonrpc: '2.0', id: 0, method: 'initialize',
				params: { protocolVersion, capabilities: {}, clientInfo: { name: 'revived', version: '0' } },
			}),
		}))
		await init.text()
		if (!init.ok) throw new Error(`could not revive MCP session (${init.status})`)
		const initialized = await s.transport.handleRequest(new Request(req.url, {
			method: 'POST',
			headers: { ...headers, 'mcp-session-id': id, 'mcp-protocol-version': protocolVersion },
			body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
		}))
		await initialized.text()
		return s
	}

	setInterval(() => {
		const now = Date.now()
		for (const [id, s] of sessions) {
			if (now - s.lastSeen > MCP_IDLE_MS) {
				closeSession(id, s)
				s.transport.close().catch(() => {})
			}
		}
	}, MCP_SWEEP_MS)

	const mcpError = (status: number, message: string) =>
		new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }), {
			status,
			headers: { 'content-type': 'application/json' },
		})

	/** Handles a request to /mcp. */
	async function handle(req: Request): Promise<Response> {
		const id = req.headers.get('mcp-session-id')
		if (!id) {
			// a new client: the transport checks it's an initialize request and registers the session
			if (req.method !== 'POST') return mcpError(400, 'Bad Request: Mcp-Session-Id header is required')
			return newSession().transport.handleRequest(req)
		}
		let s = sessions.get(id)
		if (!s) {
			if (req.method === 'DELETE') return mcpError(404, 'Session not found')
			if (!/^[\x21-\x7e]{1,128}$/.test(id)) return mcpError(400, 'Bad Request: invalid Mcp-Session-Id')
			s = await reviveSession(id, req)
		}
		s.lastSeen = Date.now()
		return s.transport.handleRequest(req)
	}

	// ---------- tools ----------

	const ok = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })

	/** Runs a tool body, turning failures into tool errors the model can read. */
	function tool<A>(fn: (args: A, extra: Extra) => Promise<CallToolResult>) {
		return async (args: A, extra: Extra): Promise<CallToolResult> => {
			try {
				return await fn(args, extra)
			} catch (e) {
				return { isError: true, content: [{ type: 'text', text: (e as Error).message }] }
			}
		}
	}

	const canvasArg = z
		.string()
		.describe(`Canvas id, or a canvas URL such as ${deps.webBase}/c/<id> or a view link …/v/<viewKey>`)
	const sessionIdArg = z
		.string()
		.describe('Your exact OpenCode session id, $OPENCODE_SESSION_ID ("ses_" + 26 characters): your frame and creature on the canvas')
	const sessionTitleArg = z
		.string()
		.optional()
		.describe(
			'Your OpenCode session\'s title (e.g. from `opencode api get /api/session/$OPENCODE_SESSION_ID` → .data.title). ' +
				'Keeps your frame and creature named after your session, following renames; pass it every time.',
		)

	function buildServer() {
		const server = new McpServer(
			{ name: 'canvas', version: '1.0.0' },
			{
				instructions:
					'Review canvases where you post images, videos and HTML for the user. These are tools only: you have no ' +
					'presence on the canvas yourself. Your OpenCode session has a frame (what you post) and a creature (a small ' +
					'character beside the frame). To get the user\'s attention, say (a Markdown message) and highlight (point at an ' +
					'item, group, frame or note) queue steps on your creature, which the user plays through when they look; ' +
					'queue them in the order they should be read. Pass sessionId and sessionTitle (your OpenCode session\'s ' +
					'title) on every post_item, say and highlight. The user gives feedback on a specific spot of an image with ' +
					'annotations: check list_annotations (filter by your sessionId) for comments on what you posted; their ' +
					'px/py are pixel coordinates in the original image. Reading annotations consumes them: they disappear from ' +
					'the canvas once you\'ve read them (pass keep: true to peek; restore brings them back). To show a new version of something you posted, replace ' +
					'it in place with update_item (path, url or html) rather than posting it again: it keeps its place and comments.',
			},
		)

		server.registerTool(
			'list_canvases',
			{
				description: 'List all review canvases, newest first, with their ids, titles, links and session/item counts.',
				inputSchema: {},
			},
			tool(async () =>
				ok(
					deps
						.listCanvases()
						.map((c) => ({ id: c.id, title: c.title, link: canvasLink(c), sessions: c.sessionCount, items: c.itemCount, createdAt: c.createdAt })),
				),
			),
		)

		server.registerTool(
			'get_canvas',
			{
				description:
					'Everything on one canvas: its sessions (one frame per OpenCode session) in frame order, left to right, each ' +
					'with its groups and their items (id, name, title, kind, size, media url), plus its sticky notes and annotations ' +
					'(comments pinned to a spot on an item; see list_annotations). People can hide frames ("hidden": true): a ' +
					'hidden frame isn\'t shown on the canvas but still takes posts (posting doesn\'t unhide it).',
				inputSchema: { canvas: canvasArg },
			},
			tool(async ({ canvas }: { canvas: string }) => {
				const id = canvasId(canvas)
				const data = deps.canvasData(id)
				const [sessions, notes, annotations] = [deps.sessionViews(id), await deps.notes(id), await deps.annotations(id, { keep: true })]
				return ok({
					id,
					title: data.canvas.title,
					link: canvasLink(data.canvas),
					sessions: sessions.map((s) => ({
						id: s.id,
						title: s.title,
						...(s.hidden ? { hidden: true } : {}),
						groups: s.groups.map((g) => ({ name: g.name, items: g.items.map((i) => itemSummary(i)) })),
					})),
					notes: notes.map(noteSummary),
					annotations: annotations.map(annotationSummary),
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
				const canvas = deps.createCanvas(title)
				return ok({ id: canvas.id, title: canvas.title, link: canvasLink(canvas), viewLink: `${deps.webBase}/v/${canvas.viewKey}` })
			}),
		)

		server.registerTool(
			'get_selection',
			{
				description:
					'What each person who has the canvas open has selected right now, resolved into the selected items (with ids, ' +
					'names, groups, sessions and media urls), session frames and sticky notes. Use this when the user says ' +
					'"look at what I selected" or refers to "this"/"these" on the canvas. Pass the result\'s item ids to get_item ' +
					'with includeImage to actually see images. Creatures (conjured sessions) are marked agent: true.',
				inputSchema: { canvas: canvasArg },
			},
			tool(async ({ canvas }: { canvas: string }) => {
				const id = canvasId(canvas)
				const users = await deps.selections(id)
				return ok({
					canvasId: id,
					users: users.map((u) => ({
						name: u.user.name,
						color: u.user.color,
						...(u.user.agent ? { agent: true } : {}),
						items: u.items.map((i) => ({ ...itemSummary(i), sessionId: i.sessionId })),
						sessions: u.sessions.map((s) => ({ id: s.id, title: s.title, itemCount: s.itemCount })),
						notes: u.notes.map(noteSummary),
						...(u.missing.length ? { missing: u.missing } : {}),
					})),
					...(users.some((u) => !u.user.agent) ? {} : { hint: 'nobody has this canvas open right now' }),
				})
			}),
		)

		server.registerTool(
			'get_presence',
			{
				description:
					'Who has the canvas open right now: name, colour, cursor position and visible area (page coordinates), ' +
					'cursor-chat message and raw selection ids. Creatures (conjured sessions) are marked agent: true.',
				inputSchema: { canvas: canvasArg },
			},
			tool(async ({ canvas }: { canvas: string }) => {
				const id = canvasId(canvas)
				return ok(
					deps.presence(id).map((p) => ({
						clientId: p.clientId,
						name: p.user.name,
						color: p.user.color,
						...(p.user.agent ? { agent: true } : {}),
						cursor: p.cursor,
						view: p.view,
						chat: p.chat,
						selection: p.selection,
					})),
				)
			}),
		)

		/** Queues one attention action on the caller's creature. */
		async function queue(
			args: { canvas: string; sessionId: string; sessionTitle?: string; text?: string; target?: string },
			kind: 'say' | 'highlight',
			extra: Extra,
		) {
			const sessionId = sessionOf(extra, args.sessionId)
			const id = canvasId(args.canvas)
			const { action, position, queued } = await deps.queueAction(id, sessionId, {
				kind,
				text: args.text,
				target: args.target,
				sessionTitle: args.sessionTitle,
			})
			return ok({ id: action.id, position, queued, canvasId: id, ...(action.target ? { target: action.target } : {}), link: canvasLink(deps.getCanvas(id)) })
		}

		server.registerTool(
			'say',
			{
				description:
					'Queue a message for the people on the canvas, from your session\'s creature (it appears beside your frame if ' +
					'it is not there yet, and calls for attention until someone reads it). Markdown. Each call adds one step to ' +
					'your queue, played in order with highlight steps: e.g. say what you did, highlight the item to look at, say ' +
					'what you want to know. Returns the step\'s id and position in your queue. Fire-and-forget: you are not told ' +
					'when it is read.',
				inputSchema: {
					canvas: canvasArg,
					sessionId: sessionIdArg,
					sessionTitle: sessionTitleArg,
					text: z.string().describe(`The message, in Markdown (1-${ATTENTION_TEXT_MAX} characters)`),
				},
			},
			tool(async (args: { canvas: string; sessionId: string; sessionTitle?: string; text: string }, extra) => queue(args, 'say', extra)),
		)

		server.registerTool(
			'highlight',
			{
				description:
					'Queue a step that points the people on the canvas at something: the canvas outlines it and brings it into ' +
					'view when they reach this step, with your optional Markdown message beside it. Like say, it goes on your ' +
					'creature\'s queue, in order. Target: an item id, a group as "<sessionId>/<group name>", a session frame ' +
					'"frame:<sessionId>", or a sticky note "note:<noteId>".',
				inputSchema: {
					canvas: canvasArg,
					sessionId: sessionIdArg,
					sessionTitle: sessionTitleArg,
					target: z.string().describe('What to point at: an item id, "<sessionId>/<group name>", "frame:<sessionId>" or "note:<noteId>"'),
					text: z.string().optional().describe('What to say about it, in Markdown'),
				},
			},
			tool(async (args: { canvas: string; sessionId: string; sessionTitle?: string; target: string; text?: string }, extra) =>
				queue(args, 'highlight', extra),
			),
		)

		server.registerTool(
			'list_notes',
			{
				description: 'The sticky notes on a canvas: id, text, author, colour and position.',
				inputSchema: { canvas: canvasArg },
			},
			tool(async ({ canvas }: { canvas: string }) => ok((await deps.notes(canvasId(canvas))).map(noteSummary))),
		)

		server.registerTool(
			'list_annotations',
			{
				description:
					'The user\'s annotations: comments pinned to a spot on an item (an image, video or HTML page), oldest first. ' +
					'Each has id, text, author, createdAt, the item (id, title, name, group, sessionId, kind, width, height, url ' +
					'of the original file, canvas link; sourceItemId and sourceTime in seconds when it is a frame extracted from a ' +
					'video) and the anchor: x/y normalized to the item (0..1) and px/py, pixel ' +
					'coordinates in the original image (x × width, y × height). Filter by sessionId (yours, for feedback on what ' +
					'you posted) or itemId. markedImageUrl is the image with the spot circled. Reading consumes them: the ' +
					'annotations returned are taken off the canvas (people see them fly into your creature) and come back with ' +
					'consumed: true, so act on them now; they wait in the trash for an hour (restore with annotationIds brings ' +
					'them back). Pass keep: true to just peek.',
				inputSchema: {
					canvas: canvasArg,
					sessionId: z.string().optional().describe('Only annotations on this session\'s items (pass yours: your creature picks them up)'),
					itemId: z.string().optional().describe('Only annotations on this item'),
					keep: z.boolean().optional().describe('Leave them on the canvas instead of consuming them (default false)'),
				},
			},
			tool(async ({ canvas, sessionId, itemId, keep }: { canvas: string; sessionId?: string; itemId?: string; keep?: boolean }) => {
				const id = canvasId(canvas)
				const sid = sessionId?.trim() || undefined
				const list = await deps.annotations(id, { sessionId: sid, itemId: itemId?.trim() || undefined, keep: !!keep, readerSessionId: sid })
				return ok(list.map((a) => ({ ...a, ...(a.item.kind !== 'html' ? { markedImageUrl: `${deps.mediaOrigin}/api/canvases/${id}/annotations/${a.id}/image` } : {}) })))
			}),
		)

		server.registerTool(
			'find_items',
			{
				description: 'Search a canvas\'s items: case-insensitive match on file name, title, caption or group. Returns matching items with ids and urls.',
				inputSchema: { canvas: canvasArg, query: z.string().describe('Text to look for') },
			},
			tool(async ({ canvas, query }: { canvas: string; query: string }) => {
				const id = canvasId(canvas)
				const { items, sessions } = deps.canvasData(id)
				const q = query.trim().toLowerCase()
				const titles = new Map(sessions.map((s) => [s.id, s.title]))
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
				const item = deps.getItem(itemId)
				const result: CallToolResult = { content: [{ type: 'text', text: JSON.stringify(itemDetail(item)) }] }
				if (item.kind === 'html') {
					const file = deps.mediaFile(item.src)
					if (!(await file.exists())) throw new ToolError('the HTML file is missing')
					let html = await file.text()
					if (html.length > HTML_TEXT_MAX) html = html.slice(0, HTML_TEXT_MAX) + '\n<!-- truncated -->'
					result.content.push({ type: 'text', text: html })
				} else if (includeImage) {
					const file = deps.mediaFile(item.kind === 'image' && fullSize ? item.src : item.thumb)
					if (!(await file.exists())) throw new ToolError('the image file is missing')
					const mimeType = file.type.split(';')[0] || 'image/webp'
					result.content.push({ type: 'image', data: Buffer.from(await file.arrayBuffer()).toString('base64'), mimeType })
				}
				return result
			}),
		)

		server.registerTool(
			'post_item',
			{
				description:
					'Post an image, video or HTML page to a canvas, into your session\'s frame. Give exactly one of path (an ' +
					'absolute path of a file on this machine), url, or html (inline HTML: diagrams, charts, annotated explanations; ' +
					'set width/height to the CSS pixel size it is designed for, default 800x600). Use group to organise items ' +
					'within the session. Pass sessionTitle (your OpenCode session\'s title) on every post: it keeps your ' +
					'frame named after your session and follows renames. Posting to a frame people hid ' +
					'works but doesn\'t unhide it. For a new version of something you already posted, replace that item with ' +
					'update_item instead.',
				inputSchema: {
					canvas: canvasArg,
					sessionId: sessionIdArg,
					sessionTitle: sessionTitleArg,
					path: z.string().optional().describe('Absolute path of an image/video/HTML file on this machine'),
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
				sessionId: string
				sessionTitle?: string
				path?: string
				url?: string
				html?: string
				width?: number
				height?: number
				group?: string
				title?: string
				caption?: string
				name?: string
			}, extra) => {
				const sources = [args.path, args.url, args.html].filter((s) => s !== undefined)
				if (sources.length !== 1) throw new ToolError('give exactly one of path, url or html')
				if (args.path !== undefined && !isAbsolute(args.path)) {
					throw new ToolError(`path must be absolute (the canvas server doesn't share your working directory), got ${JSON.stringify(args.path)}`)
				}
				const sessionId = sessionOf(extra, args.sessionId)
				const id = canvasId(args.canvas)
				const { canvas: _, sessionId: __, ...body } = args
				const item = await deps.addItem(id, sessionId, body)
				const hidden = deps.canvasData(id).sessions.some((s) => s.id === sessionId && s.hidden)
				return ok(hidden ? { ...itemDetail(item), note: 'Your frame is hidden on this canvas: the item is saved, but people only see it once they show the frame again.' } : itemDetail(item))
			}),
		)

		server.registerTool(
			'update_item',
			{
				description:
					'Change an item: replace its image, video or HTML page in place, and/or change its file name, title, caption ' +
					'or group (null clears title, caption or group). To show a new version of the same image/page, update it in ' +
					'place instead of posting a new item: give exactly one of path, url or html, as for post_item. The item keeps ' +
					'its id, link, place in your frame, group, title, caption and the user\'s annotations, takes the new file\'s ' +
					'kind, size and file name (unless name is given), and moves to the top of its group like a new post; open ' +
					'canvases show the new version right away. HTML pages keep their width/height unless you give new ones ' +
					'(width/height alone resize an HTML item). Post a new item instead only when both versions should be seen ' +
					'side by side.',
				inputSchema: {
					itemId: z.string(),
					path: z.string().optional().describe('Replace the file: absolute path of an image/video/HTML file on this machine'),
					url: z.string().optional().describe('Replace the file: URL of an image/video/HTML file to fetch'),
					html: z.string().optional().describe('Replace the file with inline HTML (a fragment or a full document)'),
					width: z.number().optional().describe('HTML items: CSS pixel width the page is laid out at (default: unchanged)'),
					height: z.number().optional().describe('HTML items: CSS pixel height (default: unchanged)'),
					name: z.string().optional().describe('File name (defaults to the new file\'s name when replacing)'),
					title: z.string().nullable().optional(),
					caption: z.string().nullable().optional(),
					group: z.string().nullable().optional(),
				},
			},
			tool(async ({ itemId, ...changes }: {
				itemId: string
				path?: string
				url?: string
				html?: string
				width?: number
				height?: number
				name?: string
				title?: string | null
				caption?: string | null
				group?: string | null
			}) => {
				const body = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined))
				if (!Object.keys(body).length) throw new ToolError('nothing to change: give path, url or html (a new file), and/or name, title, caption or group')
				if ([changes.path, changes.url, changes.html].filter((s) => s !== undefined).length > 1) throw new ToolError('give at most one of path, url or html')
				if (changes.path !== undefined && !isAbsolute(changes.path)) {
					throw new ToolError(`path must be absolute (the canvas server doesn't share your working directory), got ${JSON.stringify(changes.path)}`)
				}
				return ok(itemDetail(await deps.updateItem(itemId, body)))
			}),
		)

		server.registerTool(
			'delete_item',
			{
				description: 'Delete an item (restorable for an hour with restore). Deleting a session\'s last item removes the session too.',
				inputSchema: { itemId: z.string() },
			},
			tool(async ({ itemId }: { itemId: string }) => {
				const { sessionDeleted } = deps.deleteItem(deps.getItem(itemId).id)
				return ok({ ok: true, sessionDeleted })
			}),
		)

		server.registerTool(
			'restore',
			{
				description:
					'Undo deletes made within the last hour: items by id and/or whole sessions by session id, and annotations ' +
					'consumed by list_annotations by annotation id (they go back on the canvas). Returns what was restored.',
				inputSchema: {
					canvas: canvasArg,
					itemIds: z.array(z.string()).optional(),
					sessionIds: z.array(z.string()).optional(),
					annotationIds: z.array(z.string()).optional().describe('Annotations consumed by reading them'),
				},
			},
			tool(async ({ canvas, itemIds, sessionIds, annotationIds }: { canvas: string; itemIds?: string[]; sessionIds?: string[]; annotationIds?: string[] }) => {
				const id = canvasId(canvas)
				if (!itemIds?.length && !sessionIds?.length && !annotationIds?.length) throw new ToolError('give itemIds, sessionIds and/or annotationIds')
				const restored = await deps.restore(id, sessionIds ?? [], itemIds ?? [], annotationIds ?? [])
				return ok({
					sessions: restored.sessions.map((s) => ({ id: s.id, title: s.title })),
					items: restored.items.map(itemSummary),
					annotations: restored.annotations.map((a) => ({ id: a.id, itemId: a.itemId, text: a.text })),
				})
			}),
		)

		return server
	}

	return { handle }
}
