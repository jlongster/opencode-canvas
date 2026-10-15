export type MediaKind = 'image' | 'video' | 'html'

/** One canvas: a board of sessions, with an edit link (/c/:id) and a view-only link (/v/:viewKey). */
export interface Canvas {
	/** 10 characters [A-Za-z0-9] */
	id: string
	title: string
	createdAt: number
	/** secret for the view-only link; 16 characters [A-Za-z0-9] */
	viewKey: string
}

/** A canvas as the list page shows it. */
export interface CanvasSummary extends Canvas {
	sessionCount: number
	itemCount: number
	/** up to 4 thumbnail URLs, newest first */
	previews: string[]
}

/** What GET /api/canvases/:id and GET /api/view/:viewKey return. */
export interface CanvasData {
	canvas: Canvas
	sessions: Session[]
	items: Item[]
}

/** Sessions belong to a canvas; the same OpenCode session id may appear in several canvases. */
export interface Session {
	id: string
	canvasId: string
	title: string
	createdAt: number
}

export interface Item {
	id: string
	canvasId: string
	sessionId: string
	kind: MediaKind
	/**
	 * File name: the uploaded file's original name (or the URL's last path segment); inline HTML
	 * gets "<title or id>.html". Can be set explicitly when posting or with PATCH.
	 */
	name: string
	/** URL of the original file */
	src: string
	/** URL of a small preview (for video, the poster frame; for html, the page itself: there is no image) */
	thumb: string
	/** Pixel size; for html, the CSS pixel size the page is laid out at */
	width: number
	height: number
	/**
	 * Which group the item belongs to within its session. Groups are just names: items with the
	 * same name are laid out together under that heading, groups in the order they first appeared.
	 * Items without a group go in an untitled group at the top of the session.
	 */
	group?: string
	/** Shown above the item on the canvas */
	title?: string
	/** Longer description, shown when hovering */
	caption?: string
	createdAt: number
}

/** A session as the API presents it to agents: its groups, in order, each with its items. */
export interface SessionView extends Session {
	groups: { name: string | null; items: Item[] }[]
}

/** A sticky note from a canvas's room document, as GET /api/canvases/:cid/notes returns it. */
export interface Note {
	id: string
	text: string
	author: string
	color: string
	x: number
	y: number
	createdAt: number
}

/** Someone on a canvas right now, from the room's Yjs awareness (GET /api/canvases/:cid/presence). */
export interface PresenceEntry {
	clientId: number
	/** agent: an AI agent (no pointer); conjured: a worm for an OpenCode session you can talk to (see ConjuredAgent) */
	user: { name: string; color: string; agent?: boolean; conjured?: boolean; sessionId?: string }
	/** item ids as they are, "frame:<sessionId>" for session frames, "note:<noteId>" for sticky notes */
	selection: string[]
	/** page coordinates, or null when their pointer is off the canvas */
	cursor: { x: number; y: number } | null
	/** the part of the page they're looking at */
	view: { x: number; y: number; w: number; h: number } | null
	chat: string | null
	/** false while the chat message is still being typed (or, for agents, streamed) */
	chatSent?: boolean
	/** conjured worms: their OpenCode session is working on a prompt */
	thinking?: boolean
}

/** GET /api/opencode/status */
export interface OpenCodeStatus {
	connected: boolean
	url?: string
	error?: string
}

/** One OpenCode session as GET /api/opencode/sessions lists it. */
export interface OpenCodeSessionSummary {
	id: string
	title: string
	directory: string
	updatedAt: number
	/** running a prompt right now */
	busy: boolean
	/** set on subagent sessions */
	parentId?: string
}

/**
 * An OpenCode session brought onto a canvas as a worm people can prompt (at most one per session
 * per canvas). It sits at (x, y) in page coordinates and is present in the canvas's room.
 */
export interface ConjuredAgent {
	canvasId: string
	sessionId: string
	title: string
	directory: string
	color: string
	x: number
	y: number
	createdAt: number
}

/** One person's selection, resolved into objects (GET /api/canvases/:cid/selection). */
export interface ResolvedSelection {
	clientId: number
	user: PresenceEntry['user']
	selection: string[]
	/** selected items, each with absolute URLs to its media */
	items: (Item & { url: string; thumbUrl: string })[]
	/** selected session frames */
	sessions: (Session & { itemCount: number })[]
	notes: Note[]
	/** selection ids that no longer exist */
	missing: string[]
}

export type ServerEvent =
	| { type: 'canvas'; canvas: Canvas }
	| { type: 'canvas_deleted'; id: string }
	| { type: 'session'; session: Session }
	| { type: 'session_deleted'; canvasId: string; id: string }
	| { type: 'item'; item: Item }
	| { type: 'item_deleted'; canvasId: string; id: string }
