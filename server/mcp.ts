/**
 * The canvas MCP server, served over Streamable HTTP at /mcp (and /canvas/mcp) by the canvas
 * server itself, so every OpenCode session connects to the same endpoint:
 *
 *   "canvas": { "type": "remote", "url": "http://localhost:4410/mcp" }
 *
 * Tools let agents list canvases, see what people on a canvas have selected, read notes, inspect
 * items (including the images themselves) and post or edit items. They call the server's own
 * functions (see CanvasMcpDeps) rather than its HTTP API.
 *
 * Each MCP client gets its own session (the mcp-session-id header) with its own McpServer and
 * transport. A request for a session the server doesn't know (it was closed after being idle, or
 * the server restarted) quietly starts it again under the same id, since clients don't reconnect
 * by themselves.
 *
 * While an agent works on a canvas it shows up in the canvas's multiplayer room like a browser
 * does (see setServerPresence): its selection outlines what it's working on and its chat says what
 * it just did. It has no cursor or view. With the say tool it talks to the people on the canvas: the
 * message types out in its chat (chatSent false while typing, with speaking: true so browsers draw
 * a speech bubble) and stays up for a while; activity messages don't replace it meanwhile.
 */
import type { BunFile } from 'bun'
import { isAbsolute } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { LATEST_PROTOCOL_VERSION, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import type {
	Canvas, CanvasData, CanvasSummary, Item, Note, PresenceEntry, ResolvedSelection, Session, SessionView,
} from '../shared/types'
import { SERVER_PRESENCE_RENEW_MS, ServerPresence } from './presence'

/** What the MCP tools need from the canvas server. Functions throw (with a readable message) on bad input. */
export interface CanvasMcpDeps {
	listCanvases(): CanvasSummary[]
	getCanvas(id: string): Canvas
	canvasByViewKey(key: string): Canvas
	canvasExists(id: string): boolean
	canvasData(id: string): CanvasData
	sessionViews(canvasId: string): SessionView[]
	notes(canvasId: string): Promise<Note[]>
	presence(canvasId: string): PresenceEntry[]
	selections(canvasId: string): Promise<ResolvedSelection[]>
	createCanvas(title?: string): Canvas
	getItem(id: string): Item
	/** same body and validation as POST /api/canvases/:cid/sessions/:sessionId/items */
	addItem(canvasId: string, sessionId: string, body: Record<string, unknown>): Promise<Item>
	/** same body and validation as PATCH /api/items/:itemId */
	updateItem(id: string, changes: Record<string, unknown>): Item
	deleteItem(id: string): { sessionDeleted: boolean }
	restore(canvasId: string, sessionIds: string[], itemIds: string[]): { sessions: Session[]; items: Item[] }
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
/** MCP sessions without requests for this long are closed (longer while they've joined a canvas) */
const MCP_IDLE_MS = 60 * 60_000
const MCP_JOINED_IDLE_MS = 8 * 60 * 60_000
const MCP_SWEEP_MS = 5 * 60_000

const AGENT_COLOR = '#22d3ee'
const AGENT_IDLE_MS = 2 * 60_000
/** a little longer than browsers keep a sent chat message up, so the fade-out finishes first */
const AGENT_CHAT_MS = 6000
const SAY_MAX = 280
/** typing speed: SAY_TICK_CHARS characters every SAY_TICK_MS (about 33 characters a second) */
const SAY_TICK_MS = 60
const SAY_TICK_CHARS = 2
/** how long a finished message stays up */
const sayHoldMs = (chars: number) => Math.min(20_000, 4000 + 60 * chars)

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
			url: mediaUrl(item.src),
			...(item.kind === 'video' ? { thumbUrl: mediaUrl(item.thumb) } : {}),
		}
	}

	const itemDetail = (item: Item) => ({
		...itemSummary(item), canvasId: item.canvasId, sessionId: item.sessionId, createdAt: item.createdAt, thumbUrl: mediaUrl(item.thumb),
	})

	const noteSummary = (n: Note) => ({ id: n.id, text: n.text, author: n.author, color: n.color, x: Math.round(n.x), y: Math.round(n.y) })

	const itemLabel = (item: Item) => item.title || item.name

	// ---------- agent presence ----------
	// One presence per (MCP session, canvas), each under its own awareness client id, published
	// into the canvas's room by the server. It leaves after AGENT_IDLE_MS without tool calls on
	// that canvas (unless joined with join_canvas), or when its MCP session closes.

	interface Agent {
		key: string
		mcpSession: string
		canvasId: string
		presence: ServerPresence
		/** the OpenCode session it's named after */
		sessionId?: string
		selection: string[]
		chat: string | null
		/** a message from say, typing out or showing; activity chat waits while it's set */
		speech: { chars: string[]; typed: number } | null
		/** joined with join_canvas: stays without an idle timeout */
		joined: boolean
		idleTimer?: Timer
		chatTimer?: Timer
		speechTimer?: Timer
	}

	const agents = new Map<string, Agent>()
	const agentKey = (mcpSession: string, canvasId: string) => `${mcpSession}/${canvasId}`

	function agentName(a: Agent) {
		if (!a.sessionId) return 'Agent'
		const title = deps.canvasData(a.canvasId).sessions.find((s) => s.id === a.sessionId)?.title.trim()
		if (!title || title === a.sessionId) return `Agent ses_…${a.sessionId.slice(-6)}`
		return `Agent · ${title.length > 32 ? title.slice(0, 31) + '…' : title}`
	}

	async function publish(a: Agent) {
		if (agents.get(a.key) !== a) return
		if (!deps.canvasExists(a.canvasId)) return dropAgent(a)
		const speech = a.speech
		await a.presence.set({
			user: { name: agentName(a), color: AGENT_COLOR, agent: true },
			cursor: null,
			selection: a.selection,
			view: null,
			chat: speech ? speech.chars.slice(0, speech.typed).join('') : a.chat,
			chatSent: speech ? speech.typed >= speech.chars.length : true,
			...(speech ? { speaking: true } : {}),
		})
	}

	function dropAgent(a: Agent) {
		if (agents.get(a.key) !== a) return
		agents.delete(a.key)
		clearTimeout(a.idleTimer)
		clearTimeout(a.chatTimer)
		clearTimeout(a.speechTimer)
		a.presence.leave().catch((e) => console.error('agent leave failed:', e))
	}

	/** Types a say message out in the agent's chat, then keeps it up for a while before clearing it. */
	function startSpeech(a: Agent, text: string) {
		clearTimeout(a.speechTimer)
		clearTimeout(a.chatTimer)
		a.chat = null
		const chars = Array.from(text)
		const speech = { chars, typed: Math.min(SAY_TICK_CHARS, chars.length) }
		a.speech = speech
		const tick = () => {
			if (a.speech !== speech) return
			if (speech.typed >= speech.chars.length) {
				a.speechTimer = setTimeout(() => {
					if (a.speech !== speech) return
					a.speech = null
					publish(a).catch(() => {})
				}, sayHoldMs(speech.chars.length))
				return
			}
			speech.typed = Math.min(speech.chars.length, speech.typed + SAY_TICK_CHARS)
			publish(a).catch(() => {})
			a.speechTimer = setTimeout(tick, SAY_TICK_MS)
		}
		a.speechTimer = setTimeout(tick, SAY_TICK_MS)
	}

	/** Shows what the agent is doing on a canvas, joining it first if needed. Never throws. */
	async function agentActivity(
		who: Who,
		canvasId: string,
		activity: { selection?: string[]; chat?: string; join?: boolean; say?: string },
	) {
		try {
			const key = agentKey(who.mcpSession, canvasId)
			let a = agents.get(key)
			if (!a) {
				a = { key, mcpSession: who.mcpSession, canvasId, presence: new ServerPresence(canvasId), selection: [], chat: null, speech: null, joined: false }
				agents.set(key, a)
			}
			if (who.sessionId) a.sessionId = who.sessionId
			if (activity.join) a.joined = true
			if (activity.selection) a.selection = activity.selection
			if (activity.say !== undefined) startSpeech(a, activity.say)
			// what the agent says stays up: activity messages don't replace it
			else if (activity.chat !== undefined && !a.speech) {
				a.chat = activity.chat.slice(0, 140)
				clearTimeout(a.chatTimer)
				const agent = a
				a.chatTimer = setTimeout(() => {
					agent.chat = null
					publish(agent).catch(() => {})
				}, AGENT_CHAT_MS)
			}
			clearTimeout(a.idleTimer)
			if (!a.joined) {
				const agent = a
				a.idleTimer = setTimeout(() => dropAgent(agent), AGENT_IDLE_MS)
			}
			await publish(a)
		} catch (e) {
			// presence is decoration: never let it break a tool call
			console.error('agent presence failed:', e)
		}
	}

	setInterval(() => {
		for (const a of agents.values()) publish(a).catch(() => {})
	}, SERVER_PRESENCE_RENEW_MS)

	/** The calling agent's own awareness client id on a canvas, to leave it out of presence results. */
	const ownClientId = (who: Who, canvasId: string) => agents.get(agentKey(who.mcpSession, canvasId))?.presence.clientId

	// ---------- MCP sessions ----------

	interface McpSession {
		transport: WebStandardStreamableHTTPServerTransport
		lastSeen: number
		/** the OpenCode session id it last told us, to name its agent after */
		opencodeSession?: string
	}

	const sessions = new Map<string, McpSession>()

	/** Who's calling a tool: the MCP session and the OpenCode session it works for (if known). */
	interface Who {
		mcpSession: string
		sessionId?: string
	}

	type Extra = { sessionId?: string; requestInfo?: { headers: Record<string, string | string[] | undefined> } }

	function who(extra: Extra, sessionId: string | undefined): Who {
		const mcpSession = extra.sessionId ?? 'stateless'
		const state = sessions.get(mcpSession)
		const header = extra.requestInfo?.headers['x-opencode-session-id']
		const given = sessionId?.trim() || (Array.isArray(header) ? header[0] : header)?.trim() || undefined
		if (given !== undefined) {
			if (!OPENCODE_SESSION.test(given)) {
				throw new ToolError(`sessionId must be your exact OpenCode session id ($OPENCODE_SESSION_ID: "ses_" + 26 characters), got ${JSON.stringify(given)}`)
			}
			if (state) state.opencodeSession = given
		}
		return { mcpSession, sessionId: given ?? state?.opencodeSession }
	}

	function closeSession(id: string, s: McpSession) {
		if (sessions.get(id) !== s) return
		sessions.delete(id)
		for (const a of [...agents.values()]) if (a.mcpSession === id) dropAgent(a)
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
		// whatever OpenCode session this MCP session named its agents after before
		s.opencodeSession = [...agents.values()].find((a) => a.mcpSession === id && a.sessionId)?.sessionId
		return s
	}

	setInterval(() => {
		const now = Date.now()
		for (const [id, s] of sessions) {
			const joined = [...agents.values()].some((a) => a.mcpSession === id && a.joined)
			if (now - s.lastSeen > (joined ? MCP_JOINED_IDLE_MS : MCP_IDLE_MS)) {
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
		.describe('Canvas id, or a canvas URL such as https://jamesbox.exe.xyz/canvas/c/<id> or a view link …/v/<viewKey>')
	const sessionArg = z
		.string()
		.optional()
		.describe(
			'Your exact OpenCode session id, $OPENCODE_SESSION_ID ("ses_" + 26 characters). Optional here: names you on the ' +
				'canvas after your session. Remembered for later calls.',
		)

	function buildServer() {
		const server = new McpServer(
			{ name: 'canvas', version: '1.0.0' },
			{
				instructions:
					'Review canvases where you post images, videos and HTML for the user. While you use a canvas you appear on it ' +
					'as a little worm showing what you are doing; use say to talk to the people looking at it in a speech bubble ' +
					'(optionally pointing at an item, frame or note with about). When posting with post_item, pass sessionId and ' +
					'sessionTitle (your OpenCode session\'s title) every time so your frame is named after your session.',
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
					'Everything on one canvas: its sessions (one frame per OpenCode session), each with its groups and their items ' +
					'(id, name, title, kind, size, media url), plus its sticky notes.',
				inputSchema: { canvas: canvasArg, sessionId: sessionArg },
			},
			tool(async ({ canvas, sessionId }: { canvas: string; sessionId?: string }, extra) => {
				const caller = who(extra, sessionId)
				const id = canvasId(canvas)
				const data = deps.canvasData(id)
				const [sessions, notes] = [deps.sessionViews(id), await deps.notes(id)]
				const ownFrame = caller.sessionId && sessions.some((s) => s.id === caller.sessionId) ? [`frame:${caller.sessionId}`] : []
				await agentActivity(caller, id, { selection: ownFrame, chat: 'Looking over the canvas' })
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
				inputSchema: { title: z.string().optional().describe('Canvas title (default "Untitled canvas")'), sessionId: sessionArg },
			},
			tool(async ({ title, sessionId }: { title?: string; sessionId?: string }, extra) => {
				who(extra, sessionId)
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
					'with includeImage to actually see images. Other agents are marked agent: true; you are left out.',
				inputSchema: { canvas: canvasArg, sessionId: sessionArg },
			},
			tool(async ({ canvas, sessionId }: { canvas: string; sessionId?: string }, extra) => {
				const caller = who(extra, sessionId)
				const id = canvasId(canvas)
				await agentActivity(caller, id, { selection: [], chat: 'Checking what you\'ve selected' })
				const own = ownClientId(caller, id)
				const users = (await deps.selections(id)).filter((u) => u.clientId !== own)
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
					'cursor-chat message and raw selection ids. Other agents are marked agent: true; you are left out.',
				inputSchema: { canvas: canvasArg, sessionId: sessionArg },
			},
			tool(async ({ canvas, sessionId }: { canvas: string; sessionId?: string }, extra) => {
				const caller = who(extra, sessionId)
				const id = canvasId(canvas)
				const own = ownClientId(caller, id)
				return ok(
					deps
						.presence(id)
						.filter((p) => p.clientId !== own)
						.map((p) => ({
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

		server.registerTool(
			'join_canvas',
			{
				description:
					'Show yourself on a canvas and stay there (in the avatar stack, with your selection and what you\'re doing) ' +
					'until leave_canvas or the end of this MCP session. Without it you still appear while you use a canvas, and ' +
					'leave after two minutes without tool calls on it.',
				inputSchema: { canvas: canvasArg, sessionId: sessionArg },
			},
			tool(async ({ canvas, sessionId }: { canvas: string; sessionId?: string }, extra) => {
				const caller = who(extra, sessionId)
				const id = canvasId(canvas)
				await agentActivity(caller, id, { join: true, chat: 'Joined the canvas' })
				const a = agents.get(agentKey(caller.mcpSession, id))
				return ok({ canvasId: id, joined: true, name: a ? agentName(a) : 'Agent', link: canvasLink(deps.getCanvas(id)) })
			}),
		)

		server.registerTool(
			'leave_canvas',
			{
				description: 'Stop showing yourself on a canvas (after join_canvas, or right away instead of after two idle minutes).',
				inputSchema: { canvas: canvasArg },
			},
			tool(async ({ canvas }: { canvas: string }, extra) => {
				const caller = who(extra, undefined)
				const id = canvasId(canvas)
				const a = agents.get(agentKey(caller.mcpSession, id))
				if (a) dropAgent(a)
				return ok({ canvasId: id, left: !!a })
			}),
		)

		server.registerTool(
			'say',
			{
				description:
					'Talk to the people who have the canvas open: your worm types the message out in a speech bubble, which stays ' +
					'up for a few seconds (longer for longer messages). Use it to point things out, explain what you posted or ' +
					'ask for a look, e.g. "Here are three takes on the logo, the middle one is my favourite". Pass about (an ' +
					'item id, frame:<sessionId> or note:<noteId>) and your worm crawls over to it first. A new message replaces ' +
					'the one showing. Joins the canvas if you are not on it yet.',
				inputSchema: {
					canvas: canvasArg,
					text: z.string().describe(`What to say (1-${SAY_MAX} characters)`),
					about: z
						.string()
						.optional()
						.describe('Something to point at while talking: an item id, "frame:<sessionId>" or "note:<noteId>"'),
					sessionId: sessionArg,
				},
			},
			tool(async ({ canvas, text, about, sessionId }: { canvas: string; text: string; about?: string; sessionId?: string }, extra) => {
				const caller = who(extra, sessionId)
				const id = canvasId(canvas)
				const said = text.trim()
				const length = Array.from(said).length
				if (length < 1 || length > SAY_MAX) throw new ToolError(`text must be 1-${SAY_MAX} characters, got ${length}`)
				let selection: string[] | undefined
				if (about !== undefined) {
					const ref = about.trim()
					if (ref.startsWith('frame:')) {
						if (!deps.canvasData(id).sessions.some((s) => s.id === ref.slice(6))) throw new ToolError(`no session frame ${ref} on this canvas`)
					} else if (ref.startsWith('note:')) {
						if (!(await deps.notes(id)).some((n) => n.id === ref.slice(5))) throw new ToolError(`no sticky note ${ref} on this canvas`)
					} else if (deps.getItem(ref).canvasId !== id) {
						throw new ToolError(`item ${ref} is on another canvas`)
					}
					selection = [ref]
				}
				await agentActivity(caller, id, { selection, say: said })
				const a = agents.get(agentKey(caller.mcpSession, id))
				return ok({ said, canvasId: id, name: a ? agentName(a) : 'Agent' })
			}),
		)

		server.registerTool(
			'list_notes',
			{
				description: 'The sticky notes on a canvas: id, text, author, colour and position.',
				inputSchema: { canvas: canvasArg, sessionId: sessionArg },
			},
			tool(async ({ canvas, sessionId }: { canvas: string; sessionId?: string }, extra) => {
				const caller = who(extra, sessionId)
				const id = canvasId(canvas)
				await agentActivity(caller, id, { selection: [], chat: 'Reading the sticky notes' })
				return ok((await deps.notes(id)).map(noteSummary))
			}),
		)

		server.registerTool(
			'find_items',
			{
				description: 'Search a canvas\'s items: case-insensitive match on file name, title, caption or group. Returns matching items with ids and urls.',
				inputSchema: { canvas: canvasArg, query: z.string().describe('Text to look for'), sessionId: sessionArg },
			},
			tool(async ({ canvas, query, sessionId }: { canvas: string; query: string; sessionId?: string }, extra) => {
				const caller = who(extra, sessionId)
				const id = canvasId(canvas)
				const { items, sessions } = deps.canvasData(id)
				const q = query.trim().toLowerCase()
				const titles = new Map(sessions.map((s) => [s.id, s.title]))
				const found = items
					.filter((i) => [i.name, i.title, i.caption, i.group].some((f) => f?.toLowerCase().includes(q)))
					.sort((a, b) => a.createdAt - b.createdAt)
					.map((i) => ({ ...itemSummary(i), sessionId: i.sessionId, session: titles.get(i.sessionId) }))
				await agentActivity(caller, id, { selection: found.slice(0, 50).map((i) => i.id), chat: `Searching for "${query.trim()}"` })
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
					sessionId: sessionArg,
				},
			},
			tool(async ({ itemId, includeImage, fullSize, sessionId }: { itemId: string; includeImage?: boolean; fullSize?: boolean; sessionId?: string }, extra) => {
				const caller = who(extra, sessionId)
				const item = deps.getItem(itemId)
				const zoom = includeImage && fullSize && item.kind === 'image' ? ' (zoomed)' : ''
				await agentActivity(caller, item.canvasId, { selection: [item.id], chat: `Looking at ${itemLabel(item)}${zoom}` })
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
					'within the session. Pass sessionTitle (your OpenCode session\'s title) on every post: it names your frame ' +
					'while it is new or untitled, and never overwrites a title it already has.',
				inputSchema: {
					canvas: canvasArg,
					sessionId: z
						.string()
						.describe('Your exact OpenCode session id, $OPENCODE_SESSION_ID ("ses_" + 26 characters): your frame on the canvas'),
					sessionTitle: z
						.string()
						.optional()
						.describe(
							'Your OpenCode session\'s title (e.g. from `opencode api get /api/session/$OPENCODE_SESSION_ID` → .data.title). ' +
								'Names your frame; pass it on every post.',
						),
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
				const caller = who(extra, args.sessionId)
				const id = canvasId(args.canvas)
				const { canvas: _, sessionId, ...body } = args
				const item = await deps.addItem(id, sessionId, body)
				await agentActivity(caller, id, { selection: [item.id], chat: `Posted ${itemLabel(item)}` })
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
					sessionId: sessionArg,
				},
			},
			tool(async (
				{ itemId, sessionId, ...changes }: { itemId: string; name?: string; title?: string | null; caption?: string | null; group?: string | null; sessionId?: string },
				extra,
			) => {
				const caller = who(extra, sessionId)
				const body = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined))
				if (!Object.keys(body).length) throw new ToolError('nothing to change: give name, title, caption or group')
				const item = deps.updateItem(itemId, body)
				await agentActivity(caller, item.canvasId, { selection: [item.id], chat: `Updated ${itemLabel(item)}` })
				return ok(itemDetail(item))
			}),
		)

		server.registerTool(
			'delete_item',
			{
				description: 'Delete an item (restorable for an hour with restore). Deleting a session\'s last item removes the session too.',
				inputSchema: { itemId: z.string(), sessionId: sessionArg },
			},
			tool(async ({ itemId, sessionId }: { itemId: string; sessionId?: string }, extra) => {
				const caller = who(extra, sessionId)
				const item = deps.getItem(itemId)
				const { sessionDeleted } = deps.deleteItem(item.id)
				await agentActivity(caller, item.canvasId, { selection: [], chat: `Deleted ${itemLabel(item)}` })
				return ok({ ok: true, sessionDeleted })
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
					sessionId: sessionArg,
				},
			},
			tool(async ({ canvas, itemIds, sessionIds, sessionId }: { canvas: string; itemIds?: string[]; sessionIds?: string[]; sessionId?: string }, extra) => {
				const caller = who(extra, sessionId)
				const id = canvasId(canvas)
				if (!itemIds?.length && !sessionIds?.length) throw new ToolError('give itemIds and/or sessionIds')
				const restored = deps.restore(id, sessionIds ?? [], itemIds ?? [])
				const count = restored.items.length
				await agentActivity(caller, id, {
					selection: [...restored.sessions.map((s) => `frame:${s.id}`), ...restored.items.map((i) => i.id)],
					chat: `Restored ${count} item${count === 1 ? '' : 's'}`,
				})
				return ok({ sessions: restored.sessions.map((s) => ({ id: s.id, title: s.title })), items: restored.items.map(itemSummary) })
			}),
		)

		return server
	}

	return { handle }
}
