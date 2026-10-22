export type MediaKind = 'image' | 'video' | 'html' | 'page'

/**
 * A page item's web page. The canvas server never fetches it: a page item shows the screenshot its
 * poster sent (the item's src/thumb), or, without one (src ""), a link card drawn in the browser.
 * Items from before may carry more fields (from when the server took snapshots); they're ignored.
 */
export interface PageInfo {
	/** the URL as posted */
	url: string
}

/** One canvas: a board of sessions, with an edit link (/c/:id) and a view-only link (/v/:viewKey). */
export interface Canvas {
	/** 10 characters [A-Za-z0-9] */
	id: string
	title: string
	createdAt: number
	/** secret for the view-only link; 16 characters [A-Za-z0-9] */
	viewKey: string
	/** when a browser claimed its one automatic seeding from OpenCode (POST /api/canvases/:cid/autoseed) */
	autoSeededAt?: number
	/**
	 * The order of the session frames, left to right, as people arranged them (PUT
	 * /api/canvases/:cid/order). Sessions not in it follow, oldest first; ids of sessions that are
	 * gone are ignored. Missing until someone reorders.
	 */
	sessionOrder?: string[]
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
	/** which OpenCode session each linked frame talks to (see SessionLink) */
	links: SessionLink[]
}

/**
 * A session's frame on a canvas. Each frame is an OpenCode session (the same session may have a
 * frame on several canvases): its title and the rest come from OpenCode, through the browsers
 * paired with it (see `opencode`). The canvas keeps only what's its own: which sessions it shows
 * and how (hidden, the order, the items and notes in them).
 */
export interface Session {
	id: string
	canvasId: string
	/**
	 * What the frame is titled: the OpenCode session's title (`opencode.title`) once a paired browser
	 * has reported it, else the title it was posted with (`postedTitle`), else "".
	 */
	title: string
	/**
	 * The title an agent posted with (`sessionTitle`), or a frame was made with: shown only until a
	 * paired browser reports the session from OpenCode, whose title always wins.
	 */
	postedTitle?: string
	/** The OpenCode server it lives on (a pairing's non-secret key), once a paired browser found it there. */
	serverKey?: string
	/** The session as its OpenCode last reported it, mirrored here by a paired browser for everyone. */
	opencode?: OpenCodeSessionInfo
	createdAt: number
	/**
	 * Hidden from the canvas (PATCH /api/canvases/:cid/sessions/:sid): not laid out or drawn, for
	 * everyone. It still takes posts, which don't unhide it.
	 */
	hidden?: boolean
	/** when it was hidden (ms): items posted since show as new in the frames list */
	hiddenAt?: number
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
	/** Videos: length in seconds (read with ffprobe on the server; missing when it couldn't be) */
	duration?: number
	/**
	 * Which group the item belongs to within its session. Groups are just names: items with the
	 * same name are laid out together under that heading. On the canvas, the group with the newest
	 * item comes first and items run newest first; items without a group form an untitled group.
	 */
	group?: string
	/** Shown above the item on the canvas */
	title?: string
	/** Longer description, shown when hovering */
	caption?: string
	/** A frame extracted from a video: the video item it came from, and when in it (seconds) */
	sourceItemId?: string
	sourceTime?: number
	/** Pages: the web page's URL: what "Open" opens */
	pageUrl?: string
	/** Pages: the web page (src/thumb are its screenshot, or "" for none) */
	page?: PageInfo
	/** Pages from before: when the server took their snapshot (ms) */
	snapshotAt?: number
	/** When it was posted, or its file last replaced (PATCH with a new file): orders it in its group, newest first */
	createdAt: number
}

/** A session as the API presents it to agents: its groups, in order, each with its items. */
export interface SessionView extends Session {
	groups: { name: string | null; items: Item[] }[]
}

/**
 * A sticky note from a canvas's room document, as GET /api/canvases/:cid/notes returns it. Notes
 * with a sessionId were placed by that session's say / highlight (see NoteAnchor): they wait where
 * the session wants people to look until someone acknowledges them, which deletes them.
 */
export interface Note extends Partial<NoteAnchor> {
	id: string
	text: string
	author: string
	color: string
	/** page position of its top-left corner (agent notes follow what they point at, so theirs is where it was placed) */
	x: number
	y: number
	createdAt: number
	/** the session that placed it (MCP say / highlight); missing on people's notes */
	sessionId?: string
}

/**
 * Where an agent's sticky note goes, stored on it in the room document (beside the note's usual
 * fields). Browsers place it from this as the layout moves: a highlight next to its target (with a
 * pointer to the exact point or region), a say at the top of the session's frame.
 */
export interface NoteAnchor {
	kind: 'say' | 'highlight'
	/** highlight: a selection key: an item id, "frame:<sessionId>", "note:<noteId>" or "group:<sessionId>/<name>" */
	target?: string
	/** highlight of an item: the exact spot meant, in pixels of the item's original image/page (like annotation px/py) */
	point?: { x: number; y: number }
	/** highlight of an item: the part meant, in the same pixels as point */
	region?: { x: number; y: number; w: number; h: number }
	/** highlight of a frame, group or note: a spot on the canvas (page coordinates) to point at */
	at?: { x: number; y: number }
}

/**
 * An annotation as stored in a canvas's room document (map "annotations": id -> Y.Map of these
 * fields): freehand pencil strokes on an item with an optional text note, or a text-only note on
 * a spot. Everything is normalized to the item (0..1 across its width and height), so it stays on
 * the same spot of the image however the layout sizes the item. (Older pin annotations also have
 * ox/oy/len, ignored: they show as text-only notes.)
 */
export interface Annotation {
	id: string
	itemId: string
	/** where its note sits (normalized 0..1 to the item): beside the drawing, or the spot of a text-only note */
	x: number
	y: number
	/** freehand strokes drawn with the pencil, each flat [x0, y0, x1, y1, …] normalized to the item (empty: a text-only note) */
	strokes: number[][]
	/** may be empty for a drawing */
	text: string
	author: string
	color: string
	createdAt: number
	updatedAt?: number
}

/** An annotation resolved against its item, as GET /api/canvases/:cid/annotations and list_annotations return it. */
export interface AnnotationView {
	id: string
	text: string
	author: string
	createdAt: number
	updatedAt?: number
	item: {
		id: string
		kind: MediaKind
		name: string
		title?: string
		group?: string
		sessionId: string
		sessionTitle?: string
		/** pixel size of the original file (CSS px for html) */
		width: number
		height: number
		/** absolute URL of the original file (for a page, its screenshot; absent when it has none) */
		url?: string
		/** pages: the web page itself */
		pageUrl?: string
		/** the item on the canvas */
		link: string
		/** a frame extracted from a video: the video item and the time in it (seconds) */
		sourceItemId?: string
		sourceTime?: number
	}
	/** where its note sits (a text-only note's spot, else beside the drawing): normalized (0..1) and in pixels of the original image (px = x × width) */
	anchor: { x: number; y: number; px: number; py: number }
	/** the freehand strokes, as [x, y] pixel points in the original image (empty for a text-only note) */
	strokes: [number, number][][]
	/** the drawing's bounding box in pixels of the original image (absent for a text-only note) */
	bbox?: { x: number; y: number; width: number; height: number }
	/** the author's colour, the strokes' colour on the canvas */
	color: string
	/** reading it took it off the canvas (into the trash for an hour: restore brings it back) */
	consumed?: true
}

/** Someone on a canvas right now, from the room's Yjs awareness (GET /api/canvases/:cid/presence). */
export interface PresenceEntry {
	clientId: number
	/** agent: not a person (no pointer); with sessionId, a linked session's live state, published by its owner's tab */
	user: { name: string; color: string; agent?: boolean; sessionId?: string; serverKey?: string }
	/** item ids as they are, "frame:<sessionId>" for session frames, "note:<noteId>" for sticky notes */
	selection: string[]
	/** page coordinates, or null when their pointer is off the canvas */
	cursor: { x: number; y: number } | null
	/** the part of the page they're looking at */
	view: { x: number; y: number; w: number; h: number } | null
	chat: string | null
	/** false while the chat message is still being typed (or, for agents, streamed) */
	chatSent?: boolean
	/** linked sessions: working (on a canvas prompt or anything else) */
	thinking?: boolean
}

/**
 * What OpenCode says about a session, as a paired browser read it (web/src/opencode/live.ts) and
 * mirrored it onto the canvas's frames (PUT /api/canvases/:cid/opencode).
 */
export interface OpenCodeSessionInfo {
	/** "" while it has none */
	title: string
	/** a subagent's parent session */
	parentId?: string
	agent?: string
	directory?: string
	createdAt?: number
	updatedAt?: number
	/** OpenCode deleted it: its frame and items stay, marked as ended */
	deleted?: boolean
}

/** One OpenCode session, as the browser lists it from a paired OpenCode (see web/src/opencode). */
export interface OpenCodeSessionSummary {
	id: string
	/** the pairing (OpenCode server) it lives on */
	serverKey: string
	serverName: string
	title: string
	directory: string
	updatedAt: number
	/** running a prompt right now */
	busy: boolean
}

/** One session's outcome of seeding a canvas from it (done in the browser, see web/src/opencode/seed.ts). */
export interface SeedResult {
	sessionId: string
	/** the OpenCode session's title ("" when it couldn't be read) */
	title: string
	/** items added to its frame */
	added: number
	/** media it output that couldn't be added (file gone, failed to process, over the cap) */
	skipped: number
	/** set when nothing was added: no media found, OpenCode unreachable, … */
	error?: string
}

/**
 * Which OpenCode session a canvas's session frame talks to (at most one per session per canvas).
 * The canvas server keeps only this record, with no credentials: the owner's browser (ownerId)
 * talks to OpenCode, runs prompts from the frame, and reports whether the session is working.
 */
export interface SessionLink {
	canvasId: string
	sessionId: string
	/** non-secret id of the OpenCode server the session lives on (a hash of its URL) */
	serverKey: string
	color: string
	createdAt: number
	/** random id kept in the owner browser's localStorage; only that browser can prompt it */
	ownerId: string
	/** in list responses: an owner tab is running it right now */
	online?: boolean
	/** in list responses: the session is working */
	busy?: boolean
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
	| { type: 'link'; link: SessionLink }
	| { type: 'link_deleted'; canvasId: string; sessionId: string }
	/** a linked session started or stopped working */
	| { type: 'status'; canvasId: string; sessionId: string; busy: boolean }
	/**
	 * Annotations an agent just read, sent right before they're removed from the room document, so
	 * open canvases can animate them away (into the reading session's frame).
	 */
	| { type: 'annotations_consumed'; canvasId: string; sessionId?: string; ids: string[] }
