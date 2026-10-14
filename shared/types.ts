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

export type ServerEvent =
	| { type: 'canvas'; canvas: Canvas }
	| { type: 'canvas_deleted'; id: string }
	| { type: 'session'; session: Session }
	| { type: 'session_deleted'; canvasId: string; id: string }
	| { type: 'item'; item: Item }
	| { type: 'item_deleted'; canvasId: string; id: string }
