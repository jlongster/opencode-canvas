export type MediaKind = 'image' | 'video' | 'html'

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
	/** OpenCode sessions on it as creatures (conjured from a browser, or called up by an agent's say/highlight) */
	conjured: ConjuredAgent[]
	/** what sessions' creatures want people to look at, oldest first (see AttentionAction) */
	attention: AttentionAction[]
}

/** Sessions belong to a canvas; the same OpenCode session id may appear in several canvases. */
export interface Session {
	id: string
	canvasId: string
	title: string
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
	/** When it was posted, or its file last replaced (PATCH with a new file): orders it in its group, newest first */
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
		/** absolute URL of the original file */
		url: string
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
	/** agent: not a person (no pointer); conjured: a creature for an OpenCode session you can talk to (see ConjuredAgent) */
	user: { name: string; color: string; agent?: boolean; conjured?: boolean; sessionId?: string; serverKey?: string }
	/** item ids as they are, "frame:<sessionId>" for session frames, "note:<noteId>" for sticky notes */
	selection: string[]
	/** page coordinates, or null when their pointer is off the canvas */
	cursor: { x: number; y: number } | null
	/** the part of the page they're looking at */
	view: { x: number; y: number; w: number; h: number } | null
	chat: string | null
	/** false while the chat message is still being typed (or, for agents, streamed) */
	chatSent?: boolean
	/** conjured worms: their OpenCode session is working (on a canvas prompt or anything else) */
	thinking?: boolean
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
 * An OpenCode session on a canvas as a creature (at most one per session per canvas). It sits at
 * (x, y) in page coordinates. The canvas server keeps only this record, with no credentials: the
 * owner's browser (ownerId) talks to OpenCode and publishes the creature's presence into the room
 * while its tab is open; otherwise it sleeps. Creatures the server made for an agent's say/highlight
 * have no owner (ownerId and serverKey ""), until someone conjures that session and adopts it.
 */
export interface ConjuredAgent {
	canvasId: string
	sessionId: string
	/** non-secret id of the OpenCode server the session lives on (a hash of its URL) */
	serverKey: string
	title: string
	color: string
	x: number
	y: number
	createdAt: number
	/** random id kept in the owner browser's localStorage; only that browser can prompt it ("" for none) */
	ownerId: string
	/**
	 * It rushed (server-side) to point at an item just posted to (or replaced in) its session: the item
	 * and when. x/y are then just outside that item's nearest edge (at 100% zoom); moving it clears this.
	 */
	rush?: { itemId: string; at: number }
	/** in list responses: an owner tab is publishing its presence right now */
	awake?: boolean
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

/**
 * One thing a session's creature wants people on the canvas to look at, queued with the MCP say /
 * highlight tools (or POST /api/canvases/:cid/sessions/:sid/actions). The queue plays in order;
 * stepping past an action on an edit link marks it done, which removes it for everyone.
 */
export interface AttentionAction {
	id: string
	canvasId: string
	sessionId: string
	kind: 'say' | 'highlight'
	/** Markdown: the message (say), or what to say about the target (highlight, optional) */
	text?: string
	/** highlight: a selection key: an item id, "frame:<sessionId>", "note:<noteId>" or "group:<sessionId>/<name>" */
	target?: string
	createdAt: number
}

export type ServerEvent =
	| { type: 'canvas'; canvas: Canvas }
	| { type: 'canvas_deleted'; id: string }
	| { type: 'session'; session: Session }
	| { type: 'session_deleted'; canvasId: string; id: string }
	| { type: 'item'; item: Item }
	| { type: 'item_deleted'; canvasId: string; id: string }
	| { type: 'conjured'; agent: ConjuredAgent }
	| { type: 'conjured_deleted'; canvasId: string; sessionId: string }
	| { type: 'attention'; action: AttentionAction }
	| { type: 'attention_done'; canvasId: string; ids: string[] }
	/**
	 * Annotations an agent just read, sent right before they're removed from the room document, so
	 * open canvases can animate them away (into the reading session's creature, if it has one).
	 */
	| { type: 'annotations_consumed'; canvasId: string; sessionId?: string; ids: string[] }
