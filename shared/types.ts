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

export type ServerEvent =
	| { type: 'session'; session: Session }
	| { type: 'session_deleted'; id: string }
	| { type: 'item'; item: Item }
	| { type: 'item_deleted'; id: string }
