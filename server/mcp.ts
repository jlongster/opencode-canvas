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
 * people's attention, say and highlight place a sticky note for the calling session (see
 * attention.ts) where it wants people to look: a say at the top of its frame, a highlight right
 * next to what it points at. People acknowledge a note to remove it.
 */
import type { BunFile } from 'bun'
import { isAbsolute } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { LATEST_PROTOCOL_VERSION, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type {
	Annotation, AnnotationView, Canvas, CanvasData, CanvasSummary, Item, Note, NoteAnchor, PresenceEntry, ResolvedSelection, Session, SessionView,
} from '../shared/types'
import { ATTENTION_TEXT_MAX } from './attention'

/** A highlight's optional precise spot (see NoteAnchor). */
type Precise = Pick<NoteAnchor, 'point' | 'region' | 'at'>

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
	 * the ones returned are consumed: taken off the canvas (into readerSessionId's frame) and trashed.
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
	/** same body and validation as POST /api/canvases/:cid/sessions/:sessionId/notes: the note, and how many of the session's wait */
	placeNote(canvasId: string, sessionId: string, body: Record<string, unknown>): Promise<{ note: Note; waiting: number }>
	/** a /media/… path as a file */
	mediaFile(src: string): BunFile
	/** an annotation's marked image (see GET /api/canvases/:cid/annotations/:id/image) as PNG bytes, fit in max px */
	markedImage(canvasId: string, annotationId: string, max?: number): Promise<Uint8Array>
	/** one of an item's stored images (src or thumb), scaled to fit max px when the original is bigger */
	imageForAgent(item: Item, src: string, max: number): Promise<{ data: Uint8Array; mimeType: string }>
	/** records that the session has seen these person items (their current file); others are ignored */
	markDelivered(canvasId: string, sessionId: string, itemIds: string[]): Item[]
	/** absolute base for /media/… URLs in results */
	mediaOrigin: string
	/** where people open canvases in a browser, for links in results */
	webBase: string
}

const HTML_TEXT_MAX = 200_000
/** list_annotations returns at most this many marked images as image content */
const ANNOTATION_IMAGES_MAX = 8
const ANNOTATION_IMAGE_PX = 1280
/** get_item fullSize sends originals at most this big (models scale bigger ones down anyway) */
const FULL_SIZE_PX = 2000
/** what OpenCode puts in every MCP tool call's _meta: the calling session */
const OPENCODE_SESSION_META = 'ai.opencode/sessionID'
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
			...(item.src ? { url: mediaUrl(item.src) } : {}),
			...(item.kind === 'page'
				? {
						pageUrl: item.pageUrl,
						screenshot: !!item.src,
					}
				: {}),
			...(item.kind === 'video' ? { thumbUrl: mediaUrl(item.thumb) } : {}),
			...(item.duration !== undefined ? { duration: item.duration } : {}),
			...(item.origin ? { origin: item.origin, ...(item.addedBy ? { addedBy: item.addedBy } : {}) } : {}),
		}
	}

	/** The OpenCode session making a tool call, from the _meta OpenCode sends with it (undefined from other clients). */
	const callerSession = (extra: Extra): string | undefined => {
		const id = extra._meta?.[OPENCODE_SESSION_META]
		return typeof id === 'string' && OPENCODE_SESSION.test(id) ? id : undefined
	}

	/** The caller saw these items' images: person items in its own frame count as delivered to it. */
	function sawItems(extra: Extra, items: { id: string; canvasId: string; sessionId: string; origin?: 'person' }[]) {
		const caller = callerSession(extra)
		if (!caller) return
		const byCanvas = new Map<string, string[]>()
		for (const i of items) if (i.origin === 'person' && i.sessionId === caller) byCanvas.set(i.canvasId, [...(byCanvas.get(i.canvasId) ?? []), i.id])
		for (const [canvasId, ids] of byCanvas) deps.markDelivered(canvasId, caller, ids)
	}

	const itemDetail = (item: Item) => ({
		...itemSummary(item), canvasId: item.canvasId, sessionId: item.sessionId, createdAt: item.createdAt, ...(item.thumb ? { thumbUrl: mediaUrl(item.thumb) } : {}),
	})

	/** An annotation as get_canvas lists it: what it says and where, with the item referred to by id. */
	const annotationSummary = (a: AnnotationView) => ({
		id: a.id, text: a.text, author: a.author, itemId: a.item.id, anchor: a.anchor, ...(a.bbox ? { bbox: a.bbox, strokes: a.strokes.length } : {}), createdAt: a.createdAt,
	})

	const noteSummary = (n: Note) => ({
		id: n.id,
		text: n.text,
		author: n.author,
		color: n.color,
		x: Math.round(n.x),
		y: Math.round(n.y),
		...(n.sessionId ? { sessionId: n.sessionId, kind: n.kind, ...(n.target ? { target: n.target } : {}) } : {}),
	})

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

	type Extra = { sessionId?: string; requestInfo?: { headers: Record<string, string | string[] | undefined> }; _meta?: Record<string, unknown> }

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
		.describe('Your exact OpenCode session id, $OPENCODE_SESSION_ID ("ses_" + 26 characters): your frame on the canvas')
	const sessionTitleArg = z
		.string()
		.optional()
		.describe(
			'Optional: your OpenCode session\'s title. Only a fallback: your frame shows it until a browser paired with your ' +
				'OpenCode reports the session, whose live title (renames included) always wins.',
		)

	function buildServer() {
		const server = new McpServer(
			{ name: 'canvas', version: '1.0.0' },
			{
				instructions:
					'Review canvases where you post images, videos, HTML and links to web pages for the user. These are tools only: you have no ' +
					'presence on the canvas yourself. Your OpenCode session has a frame (what you post); people can prompt your session ' +
					'from it and see when it is working. To get the user\'s attention, say (a Markdown message) and highlight ' +
					'(point at an item, group, frame or note) place a sticky note from your session where you want the user to look: ' +
					'say at the top of your frame, highlight right next to what you point at. Notes stay until the user acknowledges ' +
					'them, which removes them; the user steps through them from the bar at the top. Point at what you mean: pass highlight ' +
					'a point {x,y} or region {x,y,w,h} in the item\'s image pixels (same units as annotation px/py and get_item\'s ' +
					'width/height): the note sits beside it with a pointer to it; omit them only to mean the whole item. Pass sessionId on every post_item, say and highlight (your ' +
					'frame is titled after your OpenCode session; sessionTitle is an optional fallback). The user gives feedback on a specific spot of an image with ' +
					'annotations: check list_annotations (filter by your sessionId) for feedback on what you posted: freehand ' +
					'drawings with optional text (strokes and bbox in pixels of the original image; look at markedImageUrl to ' +
					'see what was circled; list_annotations also returns those marked images as image content). People can also drag media of their own ' +
					'into your frame (items with origin "person" and addedBy: who added it): those are references they give you, not your output, so ' +
					'don\'t update_item them; post what you make from them as new items. Reading annotations consumes them: they disappear from ' +
					'the canvas once you\'ve read them (pass keep: true to peek; restore brings them back). To show a new version of something you posted, replace ' +
					'it in place with update_item (path, url, html or page) rather than posting it again: it keeps its place and comments. ' +
					'To post a link (a website, a dev server, a running deployment), post_item with page (its URL) and include a ' +
					'screenshot of it (path) whenever you can: take one with your browser tooling. The canvas never fetches the URL ' +
					'itself (any address works, localhost and Tailscale too); without a screenshot it shows as a link card people ' +
					'can open. update_item with a new path replaces the screenshot. url is for media files.',
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
					'(pencil drawings and notes on items; see list_annotations). People can hide frames ("hidden": true): a ' +
					'hidden frame isn\'t shown on the canvas but still takes posts (posting doesn\'t unhide it). Frames are titled ' +
					'after their OpenCode session; "ended": true means OpenCode deleted the session (its frame and items stay).',
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
						...(s.opencode?.deleted ? { ended: true } : {}),
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
					'with includeImage to actually see images. Linked sessions\' live state shows as users marked agent: true.',
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
					'cursor-chat message and raw selection ids. Linked sessions\' live state shows as users marked agent: true (no cursor).',
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

		/** Places one sticky note for the caller's session. */
		async function place(
			args: { canvas: string; sessionId: string; sessionTitle?: string; text?: string; target?: string } & Precise,
			kind: 'say' | 'highlight',
			extra: Extra,
		) {
			const sessionId = sessionOf(extra, args.sessionId)
			const id = canvasId(args.canvas)
			const { note, waiting } = await deps.placeNote(id, sessionId, {
				kind,
				text: args.text,
				target: args.target,
				point: args.point,
				region: args.region,
				at: args.at,
				sessionTitle: args.sessionTitle,
			})
			return ok({ noteId: note.id, canvasId: id, kind, ...(note.target ? { target: note.target } : {}), waiting, link: canvasLink(deps.getCanvas(id)) })
		}

		server.registerTool(
			'say',
			{
				description:
					'Place a sticky note with a message for the people on the canvas, from your session (in its colour, with its title), ' +
					'at the top of your session\'s frame (made for you if you haven\'t posted yet). Markdown. It stays there, and counts in ' +
					'the "things want your attention" bar at the top, until the user acknowledges it, which removes it. Several stack ' +
					'neatly, oldest first: e.g. say what you did, highlight the item to look at, say what you want to know. To ' +
					'point at something specific, use highlight instead. Returns the note\'s id (noteId) and how many of your notes ' +
					'are waiting. Fire-and-forget: you are not told when it is acknowledged.',
				inputSchema: {
					canvas: canvasArg,
					sessionId: sessionIdArg,
					sessionTitle: sessionTitleArg,
					text: z.string().describe(`The message, in Markdown (1-${ATTENTION_TEXT_MAX} characters)`),
				},
			},
			tool(async (args: { canvas: string; sessionId: string; sessionTitle?: string; text: string }, extra) => place(args, 'say', extra)),
		)

		server.registerTool(
			'highlight',
			{
				description:
					'Place a sticky note from your session right next to something on the canvas, where you want the user to look, ' +
					'with your optional Markdown message on it. It never covers the spot it points at and follows it as the canvas ' +
					'rearranges; it stays until the user acknowledges it, which removes it. Point at what you mean: pass point ' +
					'{x,y} or region {x,y,w,h} in the item\'s image pixels (same units as annotation px/py and get_item\'s ' +
					'width/height): the note gets a pointer to that point (a ring) or region (an outline); omit them only to mean ' +
					'the whole item. Target: an item id, a group as "<sessionId>/<group name>", a session frame "frame:<sessionId>", or a ' +
					'sticky note "note:<noteId>" (for these, "at" {x,y} in canvas page coordinates points at a spot; a frame without ' +
					'"at" gets the note at its top). Returns the note\'s id (noteId) and how many of your notes are waiting.',
				inputSchema: {
					canvas: canvasArg,
					sessionId: sessionIdArg,
					sessionTitle: sessionTitleArg,
					target: z.string().describe('What to point at: an item id, "<sessionId>/<group name>", "frame:<sessionId>" or "note:<noteId>"'),
					point: z
						.object({ x: z.number(), y: z.number() })
						.optional()
						.describe('Items only: the exact spot, in the item\'s image pixels (0..width, 0..height), like annotation px/py'),
					region: z
						.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
						.optional()
						.describe('Items only: the part to look at (top-left x, y and size w, h), in the item\'s image pixels'),
					at: z
						.object({ x: z.number(), y: z.number() })
						.optional()
						.describe('Frames, groups and notes only: a spot on the canvas to point at, in page coordinates'),
					text: z.string().optional().describe('What to say about it, in Markdown'),
				},
			},
			tool(async (args: { canvas: string; sessionId: string; sessionTitle?: string; target: string; text?: string } & Precise, extra) =>
				place(args, 'highlight', extra),
			),
		)

		server.registerTool(
			'list_notes',
			{
				description:
					'The sticky notes on a canvas: id, text, author, colour and position. Notes a session placed with say / highlight ' +
					'(waiting to be acknowledged) also have sessionId, kind and target.',
				inputSchema: { canvas: canvasArg },
			},
			tool(async ({ canvas }: { canvas: string }) => ok((await deps.notes(canvasId(canvas))).map(noteSummary))),
		)

		server.registerTool(
			'list_annotations',
			{
				description:
					'The user\'s annotations, oldest first: freehand pencil drawings on an item (an image, video or HTML page) — ' +
					'circling, underlining, crossing out, arrows — with an optional text note, or text-only notes dropped on a ' +
					'spot. Each has id, text (may be empty for a drawing), author, color, createdAt, the item (id, title, name, ' +
					'group, sessionId, kind, width, height, url of the original file, canvas link; sourceItemId and sourceTime in ' +
					'seconds when it is a frame extracted from a video), strokes (each stroke a list of [x, y] pixel points in the ' +
					'original image; [] for a text-only note), bbox (the drawing\'s bounding box in pixels: what it marks) and ' +
					'anchor (where the note sits, or a text-only note\'s spot: x/y normalized 0..1, px/py in pixels). Filter by ' +
					'sessionId (yours, for feedback on what you posted) or itemId. The item\'s origin "person" (with addedBy) means someone ' +
					'dragged it into the frame: a reference to work from, not something you posted, so don\'t update_item it. ' +
					`Unless includeImages is false, the first ${ANNOTATION_IMAGES_MAX} marked images (the image with the strokes and the ` +
					'annotation\'s number drawn on it, scaled to fit 1280 px) follow as image content, each after a line naming its ' +
					'annotation; markedImageUrl is the same image at full size. Reading consumes them: the ' +
					'annotations returned are taken off the canvas (people see them fly into your frame) and come back with ' +
					'consumed: true, so act on them now; they wait in the trash for an hour (restore with annotationIds brings ' +
					'them back). Pass keep: true to just peek.',
				inputSchema: {
					canvas: canvasArg,
					sessionId: z.string().optional().describe('Only annotations on this session\'s items (pass yours)'),
					itemId: z.string().optional().describe('Only annotations on this item'),
					keep: z.boolean().optional().describe('Leave them on the canvas instead of consuming them (default false)'),
					includeImages: z
						.boolean()
						.optional()
						.describe(`Return the marked images as image content (default true; the first ${ANNOTATION_IMAGES_MAX})`),
				},
			},
			tool(async (
				{ canvas, sessionId, itemId, keep, includeImages }: { canvas: string; sessionId?: string; itemId?: string; keep?: boolean; includeImages?: boolean },
				extra,
			) => {
				const id = canvasId(canvas)
				const sid = sessionId?.trim() || undefined
				const list = await deps.annotations(id, { sessionId: sid, itemId: itemId?.trim() || undefined, keep: !!keep, readerSessionId: sid })
				const result = ok(list.map((a) => ({ ...a, ...(a.item.kind !== 'html' ? { markedImageUrl: `${deps.mediaOrigin}/api/canvases/${id}/annotations/${a.id}/image` } : {}) })))
				if (includeImages === false) return result
				const marked = list.filter((a) => a.item.kind !== 'html' && (a.item.kind !== 'page' || a.item.url))
				const seen: AnnotationView['item'][] = []
				for (const a of marked.slice(0, ANNOTATION_IMAGES_MAX)) {
					const bytes = await deps.markedImage(id, a.id, ANNOTATION_IMAGE_PX).catch(() => null)
					if (!bytes) continue
					result.content.push(
						{ type: 'text', text: `annotation ${a.id} on item ${a.item.id}${a.text.trim() ? ` ("${a.text.trim().slice(0, 80)}")` : ''}:` },
						{ type: 'image', mimeType: 'image/png', data: Buffer.from(bytes).toString('base64') },
					)
					seen.push(a.item)
				}
				if (marked.length > ANNOTATION_IMAGES_MAX) {
					result.content.push({ type: 'text', text: `${marked.length - ANNOTATION_IMAGES_MAX} more marked images not shown: get_item with includeImage to see their items` })
				}
				sawItems(extra, seen.map((i) => ({ id: i.id, canvasId: id, sessionId: i.sessionId, origin: i.origin })))
				return result
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
					'One item with its absolute media url. With includeImage, images (video poster frames, page screenshots) are returned as image ' +
					'content so you can see them; HTML items always include their HTML source. Page items (kind "page") have pageUrl ' +
					'(the web page), screenshot (whether one was posted) and, with one, url (the screenshot). origin "person" (with addedBy) ' +
					'means someone dragged it into the frame: a reference for you, not your output, so don\'t update_item it.',
				inputSchema: {
					itemId: z.string().describe('Item id'),
					includeImage: z.boolean().optional().describe('Return the image itself (images, videos and page screenshots)'),
					fullSize: z
						.boolean()
						.optional()
						.describe(`With includeImage: send the original image (scaled to fit ${FULL_SIZE_PX} px) instead of the 512px thumbnail`),
				},
			},
			tool(async ({ itemId, includeImage, fullSize }: { itemId: string; includeImage?: boolean; fullSize?: boolean }, extra) => {
				const item = deps.getItem(itemId)
				const result: CallToolResult = { content: [{ type: 'text', text: JSON.stringify(itemDetail(item)) }] }
				if (item.kind === 'html') {
					const file = deps.mediaFile(item.src)
					if (!(await file.exists())) throw new ToolError('the HTML file is missing')
					let html = await file.text()
					if (html.length > HTML_TEXT_MAX) html = html.slice(0, HTML_TEXT_MAX) + '\n<!-- truncated -->'
					result.content.push({ type: 'text', text: html })
				} else if (includeImage && !item.thumb) {
					result.content.push({ type: 'text', text: 'this link has no screenshot (it shows as a link card); update_item with path adds one' })
				} else if (includeImage) {
					const { data, mimeType } = await deps.imageForAgent(item, (item.kind === 'image' || item.kind === 'page') && fullSize ? item.src : item.thumb, FULL_SIZE_PX)
					result.content.push({ type: 'image', data: Buffer.from(data).toString('base64'), mimeType })
					sawItems(extra, [item])
				}
				return result
			}),
		)

		server.registerTool(
			'post_item',
			{
				description:
					'Post an image, video or HTML page to a canvas, into your session\'s frame. Give exactly one of path (an ' +
					'absolute path of a file on this machine), url (a media file to download), html (inline HTML: diagrams, charts, annotated explanations; ' +
					'set width/height to the CSS pixel size it is designed for, default 800x600), or page (the URL of a web page: a site, ' +
					'a dev server, a running deployment). To post a link, use page with the URL and include a screenshot of it (path) ' +
					'whenever you can: take one with your browser tooling. The canvas never fetches the URL itself, so any address works ' +
					'(localhost, Tailscale, private networks); without a screenshot it shows as a link card (title, or the host, and the URL). ' +
					'People open the real page from it. Use group to organise items ' +
					'within the session. Your frame is titled after your OpenCode session (sessionTitle is only a fallback ' +
					'until a paired browser reports it). Posting to a frame people hid ' +
					'works but doesn\'t unhide it. For a new version of something you already posted, replace that item with ' +
					'update_item instead.',
				inputSchema: {
					canvas: canvasArg,
					sessionId: sessionIdArg,
					sessionTitle: sessionTitleArg,
					path: z.string().optional().describe('Absolute path of an image/video/HTML file on this machine. With page: the page\'s screenshot (an image)'),
					url: z.string().optional().describe('URL of an image/video/HTML file to fetch (to post a link to a web page, use page). With page: its screenshot\'s URL'),
					html: z.string().optional().describe('Inline HTML (a fragment or a full document)'),
					page: z.string().optional().describe('URL of a web page to post as a link (http/https; never fetched by the canvas). Send its screenshot as path when you can'),
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
				page?: string
				width?: number
				height?: number
				group?: string
				title?: string
				caption?: string
				name?: string
			}, extra) => {
				const files = [args.path, args.url, args.html].filter((s) => s !== undefined)
				if (args.page !== undefined ? args.html !== undefined || files.length > 1 : files.length !== 1) {
					throw new ToolError('give exactly one of path, url, html or page (with page, path or url is its screenshot)')
				}
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
					'(width/height alone resize an HTML item). On a page item (a link), path or url replaces its screenshot (an image) ' +
					'and page points it at another URL (keeping its screenshot unless you send a new one); page on any other item ' +
					'turns it into a link (with path as its screenshot). Post a new item instead only when both versions should be seen ' +
					'side by side.',
				inputSchema: {
					itemId: z.string(),
					path: z.string().optional().describe('Replace the file: absolute path of an image/video/HTML file on this machine (page items: a new screenshot)'),
					url: z.string().optional().describe('Replace the file: URL of an image/video/HTML file to fetch (page items: a new screenshot)'),
					html: z.string().optional().describe('Replace the file with inline HTML (a fragment or a full document)'),
					page: z.string().optional().describe('Make it a link to this web page URL (or point a page item at another URL)'),
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
				page?: string
				width?: number
				height?: number
				name?: string
				title?: string | null
				caption?: string | null
				group?: string | null
			}) => {
				const body = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined))
				if (!Object.keys(body).length) throw new ToolError('nothing to change: give path, url, html or page (new content), and/or name, title, caption or group')
				if ([changes.path, changes.url, changes.html].filter((s) => s !== undefined).length > 1) throw new ToolError('give at most one of path, url or html')
				if (changes.page !== undefined && changes.html !== undefined) throw new ToolError('give page (with path or url as its screenshot) or html, not both')
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
