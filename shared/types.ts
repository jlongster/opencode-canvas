export type MediaKind = 'image' | 'video'

export interface Session {
	id: string
	title: string
	createdAt: number
}

export interface Item {
	id: string
	sessionId: string
	kind: MediaKind
	/** URL of the original file */
	src: string
	/** URL of a small preview (for video, the poster frame) */
	thumb: string
	width: number
	height: number
	/** Shown above the item on the canvas */
	title?: string
	/** Longer description, shown when hovering */
	caption?: string
	createdAt: number
}

export interface Snapshot {
	sessions: Session[]
	items: Item[]
}

/** A frozen, read-only copy of the canvas that can be opened at /s/:id */
export interface Share {
	id: string
	createdAt: number
	/** The part of the canvas that was on screen when it was shared (page coordinates) */
	view?: { x: number; y: number; w: number; h: number }
	sessions: Session[]
	/** Items whose src/thumb point at the share's own copies of the media */
	items: Item[]
}

export type ShareRole = 'edit' | 'view'

/** What the browser gets when it opens a share link: the share plus what this link may do. */
export interface OpenedShare extends Share {
	role: ShareRole
	/** only present on edit links; needed to join the room with edit rights */
	editKey?: string
}

export type ServerEvent =
	| { type: 'session'; session: Session }
	| { type: 'session_deleted'; id: string }
	| { type: 'item'; item: Item }
	| { type: 'item_deleted'; id: string }
