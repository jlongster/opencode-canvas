import { frameTitle } from '../../../shared/sessionTitle'
import type { Item, OpenCodeSessionInfo, Session, SessionActivity } from '../../../shared/types'
import { atom, computed, getGlobalEpoch, react, transact } from '../state/signals'
import { Box, clamp, easeInOutCubic, lerp, Vec } from './geometry'
import { Deletions } from './Deletions'
import { applyDrawers, Drawers, familiesEqual, subagentFamilies, type Families } from './drawers'
import { computeLayout, frameTitleBox, itemsToReveal, LAYOUT, newestFirst, orderSessions, sheetHeadHeight, shiftSection, type GroupLayout, type Layout } from './layout'
import { groupKey, noteKey, parseSelectionId, type SelectionKind } from './selection'
import { StateNode } from './StateNode'
import { PENCIL_CURSOR, PencilTool } from './tools/PencilTool'
import { HandTool } from './tools/HandTool'
import { NoteTool } from './tools/NoteTool'
import { SelectTool } from './tools/SelectTool'
import type { EditorEvent, EventOf, Modifiers, Target } from './types'

/** HTML items, and page items with a web address, open in the side drawer (see ui/HtmlDrawer.tsx). */
export function opensInDrawer(item: Item | undefined): item is Item {
	return item?.kind === 'html' || (item?.kind === 'page' && !!item.pageUrl && /^https?:\/\//i.test(item.pageUrl))
}

export interface Camera {
	x: number
	y: number
	z: number
}

const MIN_ZOOM = 0.02
const MAX_ZOOM = 8
const ZOOM_STEPS = [0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8]
const DRAG_DISTANCE = 4
/** Screen px a finger moves before a touch counts as a pan rather than a tap */
const TOUCH_SLOP = 8
/** Two taps this close in time (ms) and space (px) are a double-tap */
const DOUBLE_TAP_MS = 300
const DOUBLE_TAP_DISTANCE = 30
const ANIMATION_MS = 320
const PAN_FRICTION = 0.0045 // per ms
const ZOOM_TO_PADDING = 48
/** Opening view: zoom limits, side padding, and where the first row sits (fraction of screen height) */
const INITIAL_ZOOM = { min: 0.3, max: 0.85 }
const INITIAL_PADDING = 48
const INITIAL_FIRST_ROW = 0.3
/** The widest (in screen px) an item gets when focused by double-click */
export const FOCUS_MAX_WIDTH = 1350
/** The highest zoom focusing something (double-click, deep link, zoom-to-selection) goes to */
export const FOCUS_MAX_ZOOM = 2
/** How much a dragged frame follows the pointer up and down (it follows it fully left and right) */
const FRAME_DRAG_Y = 0.3
/** Page px between a hovered or linked group and its outline */
export const GROUP_OUTLINE_PADDING = 14

class Root extends StateNode {
	static override id = 'root'
	static override initial = 'select'
	static override children = () => [SelectTool, HandTool, NoteTool, PencilTool]
}

export type ToolId = 'select' | 'hand' | 'note' | 'pencil'

/**
 * Drawing annotations (set by SharedAnnotations on edit links): the pencil tool starts a stroke on
 * an item (the layer follows the pointer itself, for its coalesced events), ends it on release
 * (a note box opens by the drawing), or drops a text-only note where the pointer is.
 */
export interface AnnotationDrafts {
	/** pen down on an item, at a page point */
	begin(itemId: string, point: Vec): void
	end(): void
	cancel(): void
	/** T or typing with the pencil: a text-only note under the pointer, starting with `text` (false when it isn't over an item) */
	type(text: string): boolean
}

/** What a session's frame title shows besides the title (see FrameChrome). */
export interface FrameStatus {
	/** the session's colour */
	color: string
	/** this browser can open its prompt (edit links: its session is linked, or a paired OpenCode may have it) */
	canPrompt: boolean
	/** its prompt is open */
	prompting: boolean
	/** OpenCode deleted its session: the frame stays, marked as ended */
	ended: boolean
	/** it waits on an answer from you: a question or a permission request */
	asking?: boolean
}

/** What OpenCode says about a frame's session, as this tab read it from the server it's on (see opencode/live.ts). */
export interface LiveSession extends OpenCodeSessionInfo {
	serverKey: string
}

const shownWithLive = new WeakMap<Session, { info: LiveSession; shown: Session }>()

/** A frame's record with what this tab's OpenCode says about its session (the same object while neither changes). */
function withLive(record: Session, info: LiveSession): Session {
	const hit = shownWithLive.get(record)
	if (hit?.info === info) return hit.shown
	const { serverKey, ...opencode } = info
	// (an untitled OpenCode session falls back to what the canvas server shows)
	const shown: Session = { ...record, serverKey, opencode, title: frameTitle(record.postedTitle || record.title, opencode) }
	shownWithLive.set(record, { info, shown })
	return shown
}

/**
 * Sessions' controls on their frame titles (set by the app once the canvas loads; drawn by the
 * renderer's SectionLabels): a prompt button.
 */
export interface FrameChrome {
	/** read while rendering: a change to what it reads makes the renderer redraw */
	status(sessionId: string): FrameStatus | null
	/** the prompt button (`button`: where it is on screen, CSS px in the canvas): opens (or closes) the session's prompt under it */
	prompt(sessionId: string, button?: { x: number; top: number; bottom: number }): void
	/** what a subagent is doing (see render/subagents/titleOrbs.ts) */
	subagent?(sessionId: string): 'running' | 'waiting' | 'failed' | 'done'
}

/** Arranging session frames (edit links): saved on the canvas server, for everyone. */
export interface FrameBackend {
	setHidden(sessionId: string, hidden: boolean): Promise<unknown>
	setOrder(sessionIds: string[]): Promise<unknown>
}

/** A session frame picked up by its title (see SelectTool's DraggingFrame). */
export interface FrameDrag {
	sessionId: string
	/** every session (hidden ones too), left to right, with the dragged one in the slot it would drop into */
	order: string[]
	/** the frame's position at the start, and where the pointer took hold of it then (page) */
	from: Vec
	origin: Vec
	/** where the pointer is now (page) */
	point: Vec
}

/** A link in an HTML item: its URL and rects in the item's document px (see render/HtmlLinks.ts). */
export interface HtmlLink {
	itemId: string
	href: string
	rects: Box[]
}

/** Pointer and keyboard state, kept up to date before events reach the state chart. */
export class Inputs {
	originScreenPoint: Vec = { x: 0, y: 0 }
	originPagePoint: Vec = { x: 0, y: 0 }
	currentScreenPoint: Vec = { x: 0, y: 0 }
	currentPagePoint: Vec = { x: 0, y: 0 }
	previousScreenPoint: Vec = { x: 0, y: 0 }
	isPointing = false
	isDragging = false
	isPanning = false
	isPointerInside = false
	isSpaceDown = false
	shiftKey = false
	altKey = false
	ctrlKey = false
	metaKey = false
	/** smoothed pointer velocity in screen px / ms */
	velocity: Vec = { x: 0, y: 0 }
	lastMoveTime = 0
}

/**
 * The single entry point for everything on the canvas, like tldraw's Editor.
 * The renderer and UI only read signals from it and call its methods.
 */
export class Editor {
	// --- records ---
	/** The canvas's session frames as the canvas server has them (its mirror of what OpenCode says included). */
	readonly sessionRecords = atom<Record<string, Session>>('sessionRecords', {})
	/**
	 * What OpenCode says about the frames' sessions, as this tab read it from its paired servers (see
	 * opencode/live.ts and setLiveSessions): newer than the canvas server's mirror, so it wins.
	 */
	readonly liveSessions = atom<Record<string, LiveSession>>('liveSessions', {})
	/**
	 * The frames as shown: each record with what OpenCode says about its session here (its title,
	 * renames included). Kept in step with sessionRecords and liveSessions by the methods that set them.
	 */
	readonly sessions = atom<Record<string, Session>>('sessions', {})
	readonly items = atom<Record<string, Item>>('items', {})
	/** The canvas's arranged frame order (Canvas.sessionOrder). */
	readonly sessionOrder = atom<string[]>('sessionOrder', [], arrayEquals)
	/**
	 * Sessions' parents as this tab's paired OpenCode knows them, by session id, sessions without a
	 * frame included (see opencode/live.ts): how a subagent's subagent finds its way to a frame.
	 */
	readonly knownParents = atom<Record<string, string>>('knownParents', {}, recordEquals)
	/** The sessions working right now (see LiveSessions.busyFrames): their sheets get a printout and a blue status cell. */
	readonly busy = atom<ReadonlySet<string>>('busy', new Set(), (a, b) => a.size === b.size && [...a].every((id) => b.has(id)))
	/** What the sessions are doing as the canvas server says (other tabs' reports, see server/busy.ts), by session id. */
	readonly reportedActivity = atom<Record<string, SessionActivity>>('reportedActivity', {})
	/** What this tab's paired OpenCodes say the frames' sessions are doing (see opencode/live.ts); edit links report it for everyone. */
	readonly ownActivity = atom<Record<string, SessionActivity>>('ownActivity', {}, activityEquals)
	/** What each frame's session is doing: this tab's own word over the canvas server's. */
	readonly activity = computed<Record<string, SessionActivity>>('activity', () => {
		const own = this.ownActivity.get()
		const reported = this.reportedActivity.get()
		return Object.keys(own).length ? { ...reported, ...own } : reported
	})
	/** Sticky notes' page boxes (ignoring their slight tilt), kept up to date by SharedNotes. */
	readonly noteBoxes = atom<Record<string, Box>>('noteBoxes', {}, boxRecordEquals)

	// --- instance state ---
	readonly camera = atom<Camera>('camera', { x: 0, y: 0, z: 1 }, (a, b) => a.x === b.x && a.y === b.y && a.z === b.z)
	readonly viewport = atom<{ w: number; h: number }>('viewport', { w: 1, h: 1 }, (a, b) => a.w === b.w && a.h === b.h)
	/** Items, session frames and notes; see selection.ts for how the kinds are told apart. */
	readonly selectedIds = atom<string[]>('selectedIds', [], arrayEquals)
	readonly hoveredId = atom<string | null>('hoveredId', null)
	/** The group whose heading is under the pointer. */
	readonly hoveredGroupId = atom<string | null>('hoveredGroupId', null)
	/** The session frame whose title is under the pointer. */
	readonly hoveredFrameId = atom<string | null>('hoveredFrameId', null)
	/**
	 * The group focused by clicking its heading or opening its link, without selecting anything.
	 * The URL links to it until the selection changes (see select).
	 */
	private readonly linkedGroupId = atom<string | null>('linkedGroupId', null)
	/** When a group was last focused (performance.now()), for the renderer's brief outline flash. */
	groupFlash: { id: string; at: number } | null = null
	readonly brush = atom<Box | null>('brush', null)
	readonly cursor = atom<string>('cursor', 'default')
	/** Where the pointer is on the page, or null when it's outside the canvas (used for presence). */
	readonly pointerPage = atom<Vec | null>('pointerPage', null, (a, b) => a === b || (!!a && !!b && a.x === b.x && a.y === b.y))
	/** Reactive copy of inputs.shiftKey, for UI that changes while shift is held. */
	readonly isShiftDown = atom<boolean>('isShiftDown', false)
	readonly toolPath = atom<string>('toolPath', '')
	/** The link in an HTML item under the pointer, which a click opens. */
	readonly hoveredLink = atom<HtmlLink | null>('hoveredLink', null, linkEquals)
	readonly connection = atom<'connecting' | 'open' | 'closed'>('connection', 'connecting')
	/** The frame being dragged by its title, if any. */
	readonly frameDrag = atom<FrameDrag | null>('frameDrag', null)
	/** A deep link that pointed into a hidden frame (see DeepLink), until dismissed. */
	readonly hiddenLink = atom<{ key: string; sessionId: string } | null>('hiddenLink', null)
	/** The HTML or page item open in the side drawer (see ui/HtmlDrawer.tsx); the canvas takes no input meanwhile. */
	readonly htmlDrawer = atom<string | null>('htmlDrawer', null)
	/**
	 * How many of its newest items each frame shows, for frames this viewer has expanded (others
	 * show LAYOUT.visibleItems). Only for this page: a reload goes back to the newest ones.
	 */
	readonly itemLimits = atom<Record<string, number>>('itemLimits', {})

	/** Subagents' drawers in their parents' frames: which this viewer opened (see drawers.ts). */
	readonly drawers = new Drawers()

	// --- derived ---
	/** The sessions with at least one item here. */
	readonly postedSessions = computed<ReadonlySet<string>>(
		'postedSessions',
		() => new Set(Object.values(this.items.get()).map((i) => i.sessionId)),
		(a, b) => a.size === b.size && [...a].every((id) => b.has(id)),
	)
	/** Which frames are subagents of which (they show as orbs on their parent's title, and open in drawers there). */
	readonly families = computed<Families>('families', () => subagentFamilies(this.sessions.get(), this.knownParents.get(), this.postedSessions.get()), familiesEqual)
	/** Every session (hidden ones too) left to right, as arranged; while a frame is dragged, as it would drop. */
	readonly orderedSessions = computed<Session[]>('orderedSessions', () =>
		orderSessions(Object.values(this.sessions.get()), this.frameDrag.get()?.order ?? this.sessionOrder.get()),
	)
	private readonly baseLayout = computed<Layout>('baseLayout', () => {
		const sessions = this.sessions.get()
		const items = this.items.get()
		const { parentOf } = this.families.get()
		// (a subagent with no output shows nothing)
		const posted = this.postedSessions.get()
		const skip = { has: (id: string) => parentOf.has(id) || (!!sessions[id]?.opencode?.parentId && !posted.has(id)) }
		const { kids } = this.families.get()
		const busy = this.busy.get()
		const headHeight = (id: string) => sheetHeadHeight({ subagents: !!kids.get(id)?.length, busy: busy.has(id) })
		return computeLayout(sessions, items, this.frameDrag.get()?.order ?? this.sessionOrder.get(), this.itemLimits.get(), skip, headHeight)
	})
	/** Every subagent laid out as a frame of its own, for its drawer. */
	private readonly kidLayout = computed<Layout>('kidLayout', () => {
		const sessions = this.sessions.get()
		const kids: Record<string, Session> = {}
		for (const id of this.families.get().parentOf.keys()) if (sessions[id]) kids[id] = sessions[id]
		return computeLayout(kids, this.items.get(), undefined, this.itemLimits.get())
	})
	/**
	 * Where everything is. A dragged frame follows the pointer (loosely up and down) while the others
	 * make room for it in the slot it would drop into.
	 */
	readonly layout = computed<Layout>('layout', () => {
		let base = this.baseLayout.get()
		const drag = this.frameDrag.get()
		const section = drag && base.sections.find((s) => s.id === drag.sessionId)
		if (drag && section) {
			const x = drag.from.x + drag.point.x - drag.origin.x
			const y = drag.from.y + (drag.point.y - drag.origin.y) * FRAME_DRAG_Y
			base = shiftSection(base, drag.sessionId, x - section.box.x, y - section.box.y)
		}
		const drawers = this.drawers.frame.get()
		return drawers.size ? applyDrawers(base, this.kidLayout.get(), this.families.get(), drawers) : base
	})
	readonly selectedSet = computed('selectedSet', () => new Set(this.selectedIds.get()))
	/** The linked group (see linkedGroupId), while it still exists. */
	readonly linkedGroup = computed<GroupLayout | null>('linkedGroup', () => {
		const id = this.linkedGroupId.get()
		return id === null ? null : (this.layout.get().groups.find((g) => g.id === id) ?? null)
	})
	readonly currentToolId = computed('currentToolId', () => this.toolPath.get().split('.')[0] as ToolId)
	readonly viewportPageBounds = computed<Box>('viewportPageBounds', () => {
		const { x, y, z } = this.camera.get()
		const { w, h } = this.viewport.get()
		return { x: -x, y: -y, w: w / z, h: h / z }
	})

	readonly inputs = new Inputs()
	/** Set when sticky notes are available (edit role); the note tool calls it to drop a note. */
	createNote: ((point: Vec) => void) | null = null
	/** Set when annotations can be added (edit role); see AnnotationDrafts. */
	annotationDrafts: AnnotationDrafts | null = null
	/** Set by SharedAnnotations: an agent read these annotations (sessionId: its session, if known), animate them away. */
	annotationsConsumed: ((ids: string[], sessionId?: string) => void) | null = null
	/** Set by the app once the canvas loads; see FrameChrome. */
	frameChrome: FrameChrome | null = null
	/** Set by the renderer: the link in an HTML item at a screen point, if any (ignoring what's on top). */
	linkAt: ((point: Vec) => HtmlLink | null) | null = null
	readonly deletions = new Deletions(this)
	/** Set on edit links: hiding, showing and reordering frames. */
	frames: FrameBackend | null = null
	readonly root: Root

	private cameraAnimation: { from: Camera; to: Camera; start: number; duration: number } | null = null
	private panVelocity: Vec | null = null
	private frameListeners = new Set<(now: number, elapsed: number) => void>()
	private raf = 0
	private lastFrame = 0
	private disposers: (() => void)[] = []
	private container: HTMLElement | null = null
	/** Fingers on the canvas (screen points), see the touch handlers. */
	private touches = new Map<number, Vec>()
	private touchMode: 'pending' | 'pan' | 'pinch' | null = null
	private pinch: { startDistance: number; startZoom: number; pagePoint: Vec } | null = null
	private lastTap: { time: number; point: Vec } | null = null
	private lastPointerType = 'mouse'
	/** The cursor the tools asked for; a hovered link shows 'pointer' over it. */
	private toolCursor = 'default'
	/** Whether the pointer is over the canvas itself rather than UI on top of it (notes, buttons…). */
	private pointerOnSurface = false
	/**
	 * Pressed on a link: held back from the state chart until it moves into a drag (then replayed,
	 * so drags start as usual) or is released (then the link opens and nothing gets selected).
	 */
	private linkPress: { href: string; down: EventOf<'pointer_down'> } | null = null
	private lastLinkOpen = 0

	constructor() {
		this.root = new Root(this)
		this.root.enter(undefined, '')
		this.onStateChange()
	}

	// ---------- records ----------

	loadSnapshot(sessions: Session[], items: Item[]) {
		transact(() => {
			this.sessionRecords.set(Object.fromEntries(sessions.map((s) => [s.id, s])))
			this.showSessions()
			this.items.set(Object.fromEntries(items.map((i) => [i.id, i])))
			this.pruneSelection(['item', 'frame'])
		})
	}

	putSession(session: Session) {
		transact(() => {
			this.sessionRecords.update((s) => ({ ...s, [session.id]: session }))
			this.showSessions()
			if (session.hidden) this.pruneSelection(['item', 'frame'])
		})
	}

	/** What this tab's paired OpenCode servers say about the frames' sessions, by session id (see opencode/live.ts). */
	/** What a session is doing changed, as the canvas server says (null: nothing's known any more). */
	putReportedActivity(sessionId: string, activity: SessionActivity | null) {
		const all = { ...this.reportedActivity.peek() }
		if (activity) all[sessionId] = activity
		else delete all[sessionId]
		this.reportedActivity.set(all)
	}

	setLiveSessions(live: Record<string, LiveSession>) {
		transact(() => {
			this.liveSessions.set(live)
			this.showSessions()
		})
	}

	/** Brings `sessions` up to date: each record with what OpenCode says about it here, unchanged objects kept. */
	private showSessions() {
		const records = this.sessionRecords.peek()
		const live = this.liveSessions.peek()
		const prev = this.sessions.peek()
		const next: Record<string, Session> = {}
		let same = Object.keys(prev).length === Object.keys(records).length
		for (const [id, record] of Object.entries(records)) {
			const info = live[id]
			next[id] = info ? withLive(record, info) : record
			if (prev[id] !== next[id]) same = false
		}
		if (!same) this.sessions.set(next)
	}

	setSessionOrder(order: string[] | undefined) {
		this.sessionOrder.set(order ?? [])
	}

	putItem(item: Item) {
		this.items.update((i) => ({ ...i, [item.id]: item }))
	}

	deleteSession(id: string) {
		transact(() => {
			this.sessionRecords.update(({ [id]: _, ...rest }) => rest)
			this.showSessions()
			this.items.update((items) => Object.fromEntries(Object.entries(items).filter(([, i]) => i.sessionId !== id)))
			this.pruneSelection(['item', 'frame'])
		})
	}

	deleteItem(id: string) {
		transact(() => {
			this.items.update(({ [id]: _, ...rest }) => rest)
			this.selectedIds.update((ids) => ids.filter((s) => s !== id))
		})
	}

	setNoteBoxes(boxes: Record<string, Box>) {
		transact(() => {
			this.noteBoxes.set(boxes)
			this.pruneSelection(['note'])
		})
	}

	/** Drop selected things of these kinds that no longer exist. */
	private pruneSelection(kinds: SelectionKind[]) {
		const items = this.items.peek()
		const sessions = this.sessions.peek()
		const notes = this.noteBoxes.peek()
		this.selectedIds.update((ids) =>
			ids.filter((key) => {
				const { kind, id } = parseSelectionId(key)
				if (!kinds.includes(kind)) return true
				if (kind === 'note') return id in notes
				const session = sessions[kind === 'frame' ? id : items[id]?.sessionId]
				return !!session && !session.hidden
			}),
		)
	}

	// ---------- arranging frames ----------

	isSessionHidden(sessionId: string | undefined) {
		return !!sessionId && !!this.sessions.get()[sessionId]?.hidden
	}

	/** The hidden session a selection key (item, frame or group) is in, if it is in one. */
	hiddenSessionOf(key: string): string | null {
		const { kind, id } = parseSelectionId(key)
		const sessionId = kind === 'frame' ? id : kind === 'group' ? id.slice(0, id.indexOf('/')) : kind === 'item' ? this.items.peek()[id]?.sessionId : undefined
		return sessionId && this.sessions.peek()[sessionId]?.hidden ? sessionId : null
	}

	/** Hides or shows a frame for everyone (edit links), straight away here. */
	setFrameHidden(sessionId: string, hidden: boolean) {
		const session = this.sessionRecords.peek()[sessionId]
		if (!this.frames || !session || !!session.hidden === hidden) return
		const { hidden: _, hiddenAt: __, ...rest } = session
		this.putSession(hidden ? { ...rest, hidden: true, hiddenAt: Date.now() } : rest)
		if (!hidden && this.hiddenLink.peek()?.sessionId === sessionId) this.hiddenLink.set(null)
		this.frames.setHidden(sessionId, hidden).catch((e) => {
			console.error('could not change whether the frame is hidden', e)
			const now = this.sessionRecords.peek()[sessionId]
			if (now) this.putSession({ ...now, hidden: session.hidden, hiddenAt: session.hiddenAt })
		})
	}

	/** Arranges the frames for everyone (edit links): every session id, left to right. */
	setFrameOrder(sessionIds: string[]) {
		if (!this.frames) return
		const before = this.sessionOrder.peek()
		const current = orderSessions(Object.values(this.sessions.peek()), before).map((s) => s.id)
		if (arrayEquals(current, sessionIds)) return
		this.sessionOrder.set(sessionIds)
		this.frames.setOrder(sessionIds).catch((e) => {
			console.error('could not save the frame order', e)
			this.sessionOrder.set(before)
		})
	}

	/** Moves a session to an index of the full order (hidden sessions included). */
	moveFrame(sessionId: string, index: number) {
		const ids = this.orderedSessions.get().map((s) => s.id).filter((id) => id !== sessionId)
		ids.splice(clamp(index, 0, ids.length), 0, sessionId)
		this.setFrameOrder(ids)
	}

	// ---------- older items ----------

	/** Shows `count` more of a frame's older items (all of them with Infinity). */
	showMoreItems(sessionId: string, count: number) {
		const current = this.itemLimits.peek()[sessionId] ?? LAYOUT.visibleItems
		this.itemLimits.update((l) => ({ ...l, [sessionId]: current + count }))
	}

	/**
	 * Lays out enough of a frame's older items to include this item, if it's left out. True if the
	 * item exists in a shown frame (and so is now laid out).
	 */
	revealItem(itemId: string): boolean {
		const item = this.items.peek()[itemId]
		if (!item || this.isSessionHidden(item.sessionId)) return false
		this.openDrawerFor(item.sessionId)
		if (this.layout.get().items.has(itemId)) return true
		const needed = itemsToReveal(this.items.peek(), itemId)
		const current = this.itemLimits.peek()[item.sessionId] ?? LAYOUT.visibleItems
		// Round up to whole steps past the default, like clicking "Show more" until it's there.
		const limit = Math.max(current, LAYOUT.visibleItems + Math.ceil((needed - LAYOUT.visibleItems) / LAYOUT.showMoreStep) * LAYOUT.showMoreStep)
		this.itemLimits.update((l) => ({ ...l, [item.sessionId]: limit }))
		return true
	}

	/** Lays out whatever a selection key points at if it's among a frame's hidden older items. */
	revealKey(key: string) {
		const { kind, id } = parseSelectionId(key)
		if (kind === 'frame') this.openDrawerFor(id)
		if (kind === 'group') this.openDrawerFor(id.slice(0, id.indexOf('/')))
		if (kind === 'item') this.revealItem(id)
		if (kind !== 'group' || this.layout.get().groups.some((g) => g.id === id)) return
		// A group whose items are all older than the frame shows: reveal its newest one.
		const slash = id.indexOf('/')
		const sessionId = id.slice(0, slash)
		const name = id.slice(slash + 1)
		const newest = Object.values(this.items.peek())
			.filter((i) => i.sessionId === sessionId && (i.group ?? '') === name)
			.sort(newestFirst)[0]
		if (newest) this.revealItem(newest.id)
	}

	// ---------- subagents' drawers ----------

	/** The frame a subagent's drawer opens in, or null for a frame of its own. */
	parentOf(sessionId: string | undefined): string | null {
		return (sessionId && this.families.get().parentOf.get(sessionId)) || null
	}

	/** A click on a subagent's orb: opens its drawer (switching from its parent's other open one), or closes it. Shift keeps the others open. */
	toggleDrawer(sessionId: string, additive = false) {
		const parent = this.parentOf(sessionId)
		if (!parent) return
		this.drawers.toggle(sessionId, this.families.get().kids.get(parent) ?? [], additive)
	}

	/** Opens a subagent's drawer, straight away (`instant`, so what's in it is laid out now) or eased. False when it's no subagent here. */
	openDrawerFor(sessionId: string, instant = true): boolean {
		if (!this.parentOf(sessionId)) return false
		if (!this.drawers.isOpen(sessionId)) {
			this.drawers.set(sessionId, true, { instant })
			this.drawers.step(performance.now())
		}
		return true
	}

	closeDrawers() {
		this.drawers.closeAll()
	}

	// ---------- selection & hover ----------

	getSelectedIds() {
		return this.selectedIds.peek()
	}
	isSelected(id: string) {
		return this.selectedSet.get().has(id)
	}
	/** Any change to the selection (even clearing an empty one) ends a group link. */
	select(ids: string[]) {
		transact(() => {
			this.linkedGroupId.set(null)
			this.selectedIds.set(ids)
		})
	}
	/** Shift-click: add the key, or remove it if it's already selected. */
	toggleSelected(key: string) {
		const ids = this.selectedIds.peek()
		this.select(ids.includes(key) ? ids.filter((k) => k !== key) : [...ids, key])
	}
	selectNone() {
		this.select([])
	}
	selectAll() {
		this.select([...this.layout.get().items.keys(), ...Object.keys(this.noteBoxes.get()).map(noteKey)])
	}
	setHovered(id: string | null) {
		this.hoveredId.set(id)
	}
	setHoveredGroup(id: string | null) {
		this.hoveredGroupId.set(id)
	}
	setBrush(brush: Box | null) {
		this.brush.set(brush)
	}
	setCursor(cursor: string) {
		this.toolCursor = cursor
		this.cursor.set(this.hoveredLink.peek() ? 'pointer' : cursor)
	}

	// ---------- tools ----------

	setCurrentTool(id: ToolId) {
		if (this.currentToolId.get() === id) return
		if (this.inputs.isPointing) this.dispatch({ name: 'cancel' })
		this.root.transition(id)
	}

	/** The cursor the current tool shows at rest (used after a space-pan ends). */
	private restingCursor() {
		const tool = this.currentToolId.get()
		return tool === 'hand' ? 'grab' : tool === 'note' ? 'crosshair' : tool === 'pencil' ? PENCIL_CURSOR : 'default'
	}

	// ---------- hit testing ----------

	getTargetAt(point: Vec): Target {
		const layout = this.layout.get()
		const z = this.camera.peek().z
		for (const section of layout.sections) {
			if (Box.contains(frameTitleBox(section, z), point)) return { type: 'frame_title', id: section.id }
		}
		for (const section of layout.sections) {
			if (!Box.contains(section.box, point)) continue
			for (const group of section.groups) {
				if (group.heading && Box.contains(group.heading, point)) return { type: 'group_heading', id: group.id }
			}
			for (const id of section.itemIds) {
				const box = layout.items.get(id)
				if (box && Box.contains(box, point)) return { type: 'item', id }
			}
			return { type: 'section', id: section.id }
		}
		return { type: 'canvas' }
	}

	/** Items and notes touching the box (frames are only selected by their title). */
	getSelectableInBox(box: Box): string[] {
		const ids: string[] = []
		const layout = this.layout.get()
		for (const section of layout.sections) {
			if (!Box.intersects(section.box, box)) continue
			for (const id of section.itemIds) if (Box.intersects(layout.items.get(id)!, box)) ids.push(id)
		}
		for (const [id, note] of Object.entries(this.noteBoxes.get())) if (Box.intersects(note, box)) ids.push(noteKey(id))
		return ids
	}

	/** The page box of a selection key, if the thing exists. */
	getSelectionBounds(key: string): Box | undefined {
		const { kind, id } = parseSelectionId(key)
		if (kind === 'frame') return this.layout.get().sections.find((s) => s.id === id)?.box
		if (kind === 'note') return this.noteBoxes.get()[id]
		return this.layout.get().items.get(id)
	}

	/** The openable link under a screen point, if the select tool is idle and nothing covers it. */
	private linkUnder(point: Vec): HtmlLink | null {
		if (!this.linkAt || this.toolPath.peek() !== 'select.idle' || this.inputs.isSpaceDown) return null
		const link = this.linkAt(point)
		if (!link) return null
		const target = this.getTargetAt(this.screenToPage(point))
		return target.type === 'item' && target.id === link.itemId ? link : null
	}

	private updateLinkHover() {
		const { inputs } = this
		const canHover =
			this.lastPointerType !== 'touch' &&
			inputs.isPointerInside &&
			this.pointerOnSurface &&
			!inputs.isPanning &&
			(!inputs.isPointing || (this.linkPress && !inputs.isDragging))
		const link = canHover ? this.linkUnder(inputs.currentScreenPoint) : null
		if (linkEquals(link, this.hoveredLink.peek())) return
		this.hoveredLink.set(link)
		this.cursor.set(link ? 'pointer' : this.toolCursor)
	}

	private openLink(href: string) {
		this.lastLinkOpen = performance.now()
		window.open(href, '_blank', 'noopener,noreferrer')
	}

	/** Whether an event is on the canvas itself, not on UI inside the container (notes, labels, buttons). */
	private isOnSurface(e: Event) {
		const t = e.target
		// data-surface: transparent layers over the canvas that only exist to catch input (see HtmlItems).
		return !!t && (t === this.container || (t as Node).parentNode === this.container || (t as HTMLElement).dataset?.surface !== undefined)
	}

	// ---------- camera ----------

	screenToPage(p: Vec): Vec {
		const { x, y, z } = this.camera.peek()
		return { x: p.x / z - x, y: p.y / z - y }
	}

	pageToScreen(p: Vec): Vec {
		const { x, y, z } = this.camera.peek()
		return { x: (p.x + x) * z, y: (p.y + y) * z }
	}

	getZoom() {
		return this.camera.peek().z
	}

	/** Moves the camera, or glides it there (eased, over `duration` ms) with `animate`. */
	setCamera(camera: Camera, opts: { animate?: boolean; duration?: number } = {}) {
		const next = { x: camera.x, y: camera.y, z: clamp(camera.z, MIN_ZOOM, MAX_ZOOM) }
		if (opts.animate) {
			this.panVelocity = null
			this.cameraAnimation = { from: this.camera.peek(), to: next, start: performance.now(), duration: opts.duration ?? ANIMATION_MS }
			return
		}
		this.camera.set(next)
		this.inputs.currentPagePoint = this.screenToPage(this.inputs.currentScreenPoint)
		if (this.inputs.isPointerInside) this.pointerPage.set(this.inputs.currentPagePoint)
	}

	/** The camera that fits `bounds` in the viewport with `padding` screen px around it. */
	getCameraForBounds(bounds: Box, opts: { padding?: number; maxZoom?: number } = {}): Camera {
		const { w, h } = this.viewport.peek()
		const pad = Math.min(opts.padding ?? ZOOM_TO_PADDING, w / 8, h / 8)
		const z = clamp(Math.min((w - pad * 2) / bounds.w, (h - pad * 2) / bounds.h), MIN_ZOOM, opts.maxZoom ?? MAX_ZOOM)
		return { x: w / 2 / z - (bounds.x + bounds.w / 2), y: h / 2 / z - (bounds.y + bounds.h / 2), z }
	}

	stopCameraMotion() {
		this.cameraAnimation = null
		this.panVelocity = null
	}

	/** Keep the camera gliding with the pointer's release velocity, if it was still moving. */
	flingCamera() {
		const { velocity, lastMoveTime } = this.inputs
		const stale = performance.now() - lastMoveTime > 60
		if (!stale && Math.hypot(velocity.x, velocity.y) > 0.2) this.panVelocity = { ...velocity }
	}

	panBy(dx: number, dy: number) {
		const { x, y, z } = this.camera.peek()
		this.setCamera({ x: x + dx / z, y: y + dy / z, z })
	}

	zoomAt(screenPoint: Vec, zoom: number, opts: { animate?: boolean } = {}) {
		const z = clamp(zoom, MIN_ZOOM, MAX_ZOOM)
		const cam = opts.animate && this.cameraAnimation ? this.cameraAnimation.to : this.camera.peek()
		const p = { x: screenPoint.x / cam.z - cam.x, y: screenPoint.y / cam.z - cam.y }
		this.setCamera({ x: screenPoint.x / z - p.x, y: screenPoint.y / z - p.y, z }, opts)
	}

	zoomIn() {
		const z = (this.cameraAnimation?.to ?? this.camera.peek()).z
		this.zoomAt(this.viewportCenter(), ZOOM_STEPS.find((s) => s > z * 1.01) ?? MAX_ZOOM, { animate: true })
	}

	zoomOut() {
		const z = (this.cameraAnimation?.to ?? this.camera.peek()).z
		this.zoomAt(this.viewportCenter(), [...ZOOM_STEPS].reverse().find((s) => s < z / 1.01) ?? MIN_ZOOM, { animate: true })
	}

	resetZoom() {
		this.zoomAt(this.viewportCenter(), 1, { animate: true })
	}

	/** Fit the bounds to the screen, never zooming past FOCUS_MAX_ZOOM (or opts.maxZoom if lower). */
	zoomToBounds(bounds: Box, opts: { animate?: boolean; maxZoom?: number } = {}) {
		const maxZoom = Math.min(opts.maxZoom ?? FOCUS_MAX_ZOOM, FOCUS_MAX_ZOOM)
		this.setCamera(this.getCameraForBounds(bounds, { maxZoom }), { animate: opts.animate ?? true })
	}

	zoomToFit(opts: { animate?: boolean } = {}) {
		const bounds = this.layout.get().bounds
		if (bounds) this.zoomToBounds(bounds, { ...opts, maxZoom: 1 })
	}

	/**
	 * The view a page opens with: content centred horizontally, zoomed to fit its width (within
	 * INITIAL_ZOOM limits), and the first row of items INITIAL_FIRST_ROW of the way down the screen.
	 */
	goToInitialView() {
		const layout = this.layout.get()
		const { w, h } = this.viewport.peek()
		if (!layout.bounds) return
		const z = clamp((w - INITIAL_PADDING * 2) / layout.bounds.w, INITIAL_ZOOM.min, INITIAL_ZOOM.max)
		const first = layout.sections[0]
		const firstItem = first?.itemIds[0]
		const top = firstItem ? this.getItemBoundsWithTitle(firstItem)!.y : (first?.box.y ?? layout.bounds.y)
		this.stopCameraMotion()
		this.setCamera({
			x: w / 2 / z - (layout.bounds.x + layout.bounds.w / 2),
			y: (h * INITIAL_FIRST_ROW) / z - top,
			z,
		})
	}

	/** Runs fn once the viewport has a real size (the ResizeObserver reports it asynchronously). */
	whenViewportReady(fn: () => void) {
		if (this.viewport.peek().w > 1) return fn()
		const stop = react(() => {
			if (this.viewport.get().w <= 1) return
			queueMicrotask(() => stop())
			fn()
		})
	}

	zoomToSelection() {
		const bounds = Box.union(
			this.selectedIds
				.get()
				.map((key) => this.getSelectionBounds(key))
				.filter((b): b is Box => !!b),
		)
		if (bounds) this.zoomToBounds(bounds)
	}

	/** Pan (keeping the zoom) so the box is centred in the viewport; one taller than it shows its top. */
	centerOn(box: Box, opts: { animate?: boolean } = {}) {
		const { w, h } = this.viewport.peek()
		const z = (this.cameraAnimation?.to ?? this.camera.peek()).z
		const pad = Math.min(ZOOM_TO_PADDING, h / 8)
		const y = box.h * z > h - pad * 2 ? pad / z - box.y : h / 2 / z - (box.y + box.h / 2)
		this.setCamera({ x: w / 2 / z - (box.x + box.w / 2), y, z }, { animate: opts.animate ?? true })
	}

	/**
	 * Select the neighbouring item and bring it into view: left/right steps through the item's
	 * group, up/down moves to the nearest item in the row above/below within the same session
	 * frame. With nothing selected, starts from the item nearest the middle of the screen.
	 */
	selectAdjacent(direction: 'up' | 'down' | 'left' | 'right') {
		const layout = this.layout.get()
		const selected = this.selectedIds.get().filter((key) => parseSelectionId(key).kind === 'item')
		const anchor = selected[selected.length - 1]
		const sectionId = anchor && layout.sectionOf.get(anchor)
		let next: string | undefined

		if (sectionId && (direction === 'left' || direction === 'right')) {
			// Step through the group's items in order; stop at either end.
			const groupId = layout.groupOf.get(anchor)
			const ids = layout.groups.find((g) => g.id === groupId)?.itemIds ?? []
			next = ids[ids.indexOf(anchor) + (direction === 'right' ? 1 : -1)]
			if (!next) return
		} else if (sectionId) {
			// The nearest row above/below within the same session frame (crossing groups), then the
			// item in it closest horizontally. Never jumps to another frame.
			const from = layout.items.get(anchor)!
			const cx = from.x + from.w / 2
			let rowGap = Infinity
			let best = Infinity
			const ids = layout.sections.find((s) => s.id === sectionId)!.itemIds
			for (const id of ids) {
				const b = layout.items.get(id)!
				const gap = direction === 'down' ? b.y - (from.y + from.h) : from.y - (b.y + b.h)
				if (gap < 0) continue
				const dx = Math.max(b.x - cx, 0, cx - (b.x + b.w))
				if (gap < rowGap - 1 || (Math.abs(gap - rowGap) <= 1 && dx < best)) {
					rowGap = Math.min(rowGap, gap)
					best = dx
					next = id
				}
			}
			if (!next) return
		} else {
			const view = this.viewportPageBounds.get()
			const cx = view.x + view.w / 2
			const cy = view.y + view.h / 2
			let best = Infinity
			for (const [id, b] of layout.items) {
				const dx = Math.max(b.x - cx, 0, cx - (b.x + b.w))
				const dy = Math.max(b.y - cy, 0, cy - (b.y + b.h))
				const d = dx * dx + dy * dy
				if (d < best) {
					best = d
					next = id
				}
			}
			if (!next) return
		}

		this.select([next])
		const z = (this.cameraAnimation?.to ?? this.camera.peek()).z
		this.stopCameraMotion()
		// Keep the on-screen width constant when stepping from one item to another.
		const from = anchor && layout.items.get(anchor)
		const to = layout.items.get(next)!
		if (from && from.w > 0 && to.w > 0) this.setCamera({ ...this.camera.peek(), z: clamp((z * from.w) / to.w, MIN_ZOOM, MAX_ZOOM) })
		this.centerOn(this.getItemBoundsWithTitle(next)!, { animate: false })
	}

	/**
	 * Fit the item to the screen, but never wider than FOCUS_MAX_WIDTH screen pixels or past
	 * FOCUS_MAX_ZOOM. Tall items (long pages, screenshots) fit their width instead and show their top.
	 */
	zoomToItem(id: string, opts: { animate?: boolean } = {}) {
		const box = this.getItemBoundsWithTitle(id)
		const item = this.layout.get().items.get(id)
		if (!box || !item) return
		const maxZoom = Math.min(FOCUS_MAX_WIDTH / box.w, FOCUS_MAX_ZOOM)
		const fit = this.getCameraForBounds(box, { maxZoom })
		if (item.w / item.h >= LAYOUT.minRowAspect) return this.setCamera(fit, { animate: opts.animate ?? true })
		const { w, h } = this.viewport.peek()
		const pad = Math.min(ZOOM_TO_PADDING, w / 8, h / 8)
		const z = clamp(Math.min((w - pad * 2) / box.w, maxZoom), MIN_ZOOM, MAX_ZOOM)
		if (z <= fit.z) return this.setCamera(fit, { animate: opts.animate ?? true })
		this.setCamera({ x: w / 2 / z - (box.x + box.w / 2), y: pad / z - box.y, z }, { animate: opts.animate ?? true })
	}

	/** Open an HTML item, or a page item's web page, in the side drawer. Returns false if there's no such item. */
	openHtmlDrawer(id: string): boolean {
		if (!opensInDrawer(this.items.peek()[id])) return false
		transact(() => {
			this.setHovered(null)
			this.htmlDrawer.set(id)
		})
		return true
	}

	closeHtmlDrawer() {
		this.htmlDrawer.set(null)
	}

	/**
	 * Select one thing by its selection key and zoom to it: items like a double-click, session
	 * frames and notes to their whole box. Returns false (and changes nothing) if it doesn't exist.
	 */
	focusSelectionKey(key: string, opts: { animate?: boolean } = {}): boolean {
		const { kind, id } = parseSelectionId(key)
		if (kind === 'group') return this.focusGroup(id, opts)
		this.revealKey(key)
		const box = this.getSelectionBounds(key)
		if (!box) return false
		this.stopCameraMotion()
		this.select([key])
		if (kind === 'item') this.zoomToItem(id, opts)
		else this.zoomToBounds(box, opts)
		return true
	}

	/**
	 * Fit a group, heading included, to the screen and link to it (see linkedGroupId), clearing
	 * the selection. Returns false (and changes nothing) if there's no such group.
	 */
	focusGroup(groupId: string, opts: { animate?: boolean } = {}): boolean {
		this.revealKey(groupKey(groupId))
		if (!this.layout.get().groups.some((g) => g.id === groupId)) return false
		transact(() => {
			this.selectNone()
			this.linkedGroupId.set(groupId)
		})
		this.groupFlash = { id: groupId, at: performance.now() }
		this.stopCameraMotion()
		this.zoomToGroup(groupId, opts)
		return true
	}

	/** Fit the group and its outline to the screen, like an item: never wider than FOCUS_MAX_WIDTH. */
	zoomToGroup(groupId: string, opts: { animate?: boolean } = {}) {
		const group = this.layout.get().groups.find((g) => g.id === groupId)
		if (!group) return
		const box = Box.expand(group.box, GROUP_OUTLINE_PADDING)
		this.zoomToBounds(box, { ...opts, maxZoom: FOCUS_MAX_WIDTH / box.w })
	}

	/** A group link to a group that's gone: show its session if that's still here. */
	focusMissingGroup(groupId: string, opts: { animate?: boolean } = {}): boolean {
		const sessionId = groupId.slice(0, groupId.indexOf('/'))
		if (!this.layout.get().sections.some((s) => s.id === sessionId)) return false
		this.stopCameraMotion()
		this.selectNone()
		this.zoomToSection(sessionId, opts)
		return true
	}

	/** The item's box plus the title strip above it, if it has a title. */
	getItemBoundsWithTitle(id: string): Box | undefined {
		const box = this.layout.get().items.get(id)
		if (!box || !this.items.get()[id]?.title) return box
		return { x: box.x, y: box.y - LAYOUT.titleHeight, w: box.w, h: box.h + LAYOUT.titleHeight }
	}

	zoomToSection(id: string, opts: { animate?: boolean } = {}) {
		const section = this.layout.get().sections.find((s) => s.id === id)
		if (section) this.zoomToBounds(section.box, opts)
	}

	private viewportCenter(): Vec {
		const { w, h } = this.viewport.peek()
		return { x: w / 2, y: h / 2 }
	}

	// ---------- events ----------

	dispatch(event: EditorEvent) {
		transact(() => this.root.handleEvent(event))
	}

	onStateChange() {
		this.toolPath.set(this.root?.getActivePath() ?? '')
	}

	private updateModifiers(e: Modifiers) {
		this.inputs.shiftKey = e.shiftKey
		this.isShiftDown.set(e.shiftKey)
		this.inputs.altKey = e.altKey
		this.inputs.ctrlKey = e.ctrlKey
		this.inputs.metaKey = e.metaKey
	}

	private pointerInfo(e: PointerEvent | MouseEvent) {
		const rect = this.container!.getBoundingClientRect()
		const point = { x: e.clientX - rect.left, y: e.clientY - rect.top }
		return { point, modifiers: { shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey } }
	}

	private handlePointerDown = (e: PointerEvent) => {
		this.lastPointerType = e.pointerType
		if (e.pointerType === 'touch') return this.handleTouchDown(e)
		if (e.button === 2) return
		const { point, modifiers } = this.pointerInfo(e)
		const { inputs } = this
		this.container!.setPointerCapture(e.pointerId)
		this.stopCameraMotion()
		this.updateModifiers(modifiers)
		inputs.originScreenPoint = inputs.currentScreenPoint = inputs.previousScreenPoint = point
		inputs.originPagePoint = inputs.currentPagePoint = this.screenToPage(point)
		inputs.isPointing = true
		inputs.isDragging = false
		inputs.velocity = { x: 0, y: 0 }
		inputs.lastMoveTime = performance.now()

		// Panning (space + drag, or middle mouse) works the same in every tool state.
		if (e.button === 1 || inputs.isSpaceDown) {
			e.preventDefault()
			inputs.isPanning = true
			this.setCursor('grabbing')
			this.setHovered(null)
			this.updateLinkHover()
			return
		}
		const down: EventOf<'pointer_down'> = { name: 'pointer_down', point, button: e.button, target: this.getTargetAt(inputs.currentPagePoint), ...modifiers }
		// Cmd/Ctrl-click still opens a link; shift and alt keep their usual meaning.
		const link = e.button === 0 && !e.shiftKey && !e.altKey && this.isOnSurface(e) ? this.linkUnder(point) : null
		if (link) {
			this.linkPress = { href: link.href, down }
			return
		}
		this.dispatch(down)
		this.updateLinkHover()
	}

	private handlePointerMove = (e: PointerEvent) => {
		if (e.pointerType === 'touch') return this.handleTouchMove(e)
		const { point, modifiers } = this.pointerInfo(e)
		const { inputs } = this
		const now = performance.now()
		const dt = Math.max(1, now - inputs.lastMoveTime)
		const delta = Vec.sub(point, inputs.currentScreenPoint)
		inputs.velocity = {
			x: lerp(inputs.velocity.x, delta.x / dt, 0.5),
			y: lerp(inputs.velocity.y, delta.y / dt, 0.5),
		}
		inputs.lastMoveTime = now
		inputs.isPointerInside = true
		this.updateModifiers(modifiers)
		inputs.previousScreenPoint = inputs.currentScreenPoint
		inputs.currentScreenPoint = point

		if (!inputs.isPointing) this.pointerOnSurface = this.isOnSurface(e)

		if (inputs.isPanning) {
			this.panBy(delta.x, delta.y)
			return
		}
		inputs.currentPagePoint = this.screenToPage(point)
		this.pointerPage.set(inputs.currentPagePoint)
		if (inputs.isPointing && !inputs.isDragging && Vec.dist(point, inputs.originScreenPoint) > DRAG_DISTANCE) {
			inputs.isDragging = true
		}
		// A press on a link became a drag: start it as if the link weren't there.
		const press = this.linkPress
		if (press && inputs.isDragging) {
			this.linkPress = null
			this.dispatch(press.down)
		}
		this.dispatch({ name: 'pointer_move', point, button: e.button, target: this.getTargetAt(inputs.currentPagePoint), ...modifiers })
		this.updateLinkHover()
	}

	private handlePointerUp = (e: PointerEvent) => {
		if (e.pointerType === 'touch') return this.handleTouchUp(e)
		const { point, modifiers } = this.pointerInfo(e)
		const { inputs } = this
		this.updateModifiers(modifiers)
		const wasPanning = inputs.isPanning
		inputs.isPointing = false
		inputs.isDragging = false
		inputs.isPanning = false
		if (this.container!.hasPointerCapture(e.pointerId)) this.container!.releasePointerCapture(e.pointerId)

		const press = this.linkPress
		this.linkPress = null
		if (wasPanning) {
			this.flingCamera()
			this.setCursor(inputs.isSpaceDown ? 'grab' : this.restingCursor())
			this.updateLinkHover()
			return
		}
		if (press) {
			if (e.type === 'pointerup') this.openLink(press.href)
			return
		}
		this.dispatch({ name: 'pointer_up', point, button: e.button, target: this.getTargetAt(inputs.currentPagePoint), ...modifiers })
		this.updateLinkHover()
	}

	private handlePointerLeave = () => {
		if (!this.inputs.isPointing) {
			this.inputs.isPointerInside = false
			this.setHovered(null)
			this.pointerPage.set(null)
			this.updateLinkHover()
		}
	}

	private handleDoubleClick = (e: MouseEvent) => {
		// Touch double-taps are recognised in handleTouchUp; ignore any dblclick the browser adds.
		if (this.inputs.isSpaceDown || this.lastPointerType === 'touch') return
		// The second click of a double-click on a link opened it (again); don't also zoom.
		if (performance.now() - this.lastLinkOpen < DOUBLE_TAP_MS * 2) return
		const { point, modifiers } = this.pointerInfo(e)
		this.dispatch({ name: 'double_click', point, target: this.getTargetAt(this.screenToPage(point)), ...modifiers })
	}

	// ---------- touch ----------
	// One finger: a tap is a click (two quick taps a double-click), a drag pans in every tool.
	// Two fingers: pinch to zoom around their midpoint while panning with it. The state chart only
	// ever sees taps, as a pointer_down/pointer_up pair, so mouse and pen behave exactly as before.

	private handleTouchDown(e: PointerEvent) {
		const { point, modifiers } = this.pointerInfo(e)
		const { inputs } = this
		try {
			this.container!.setPointerCapture(e.pointerId)
		} catch {}
		this.touches.set(e.pointerId, point)
		this.stopCameraMotion()
		if (this.touches.size === 1) {
			this.pointerOnSurface = this.isOnSurface(e)
			this.updateLinkHover()
			this.updateModifiers(modifiers)
			this.touchMode = 'pending'
			inputs.originScreenPoint = inputs.currentScreenPoint = inputs.previousScreenPoint = point
			inputs.originPagePoint = inputs.currentPagePoint = this.screenToPage(point)
			inputs.isPointing = true
			inputs.isDragging = false
			inputs.isPanning = false
			inputs.velocity = { x: 0, y: 0 }
			inputs.lastMoveTime = performance.now()
			return
		}
		this.lastTap = null
		this.startPinch()
	}

	private startPinch() {
		const [a, b] = this.touches.values()
		const center = midpoint(a, b)
		this.touchMode = 'pinch'
		this.pinch = { startDistance: Math.max(1, Vec.dist(a, b)), startZoom: this.camera.peek().z, pagePoint: this.screenToPage(center) }
		this.inputs.isPanning = true
		this.inputs.isDragging = true
		this.setHovered(null)
	}

	private handleTouchMove(e: PointerEvent) {
		if (!this.touches.has(e.pointerId)) return
		const { point } = this.pointerInfo(e)
		this.touches.set(e.pointerId, point)
		const { inputs } = this

		if (this.touchMode === 'pinch' && this.pinch) {
			const [a, b] = this.touches.values()
			const center = midpoint(a, b)
			const { startDistance, startZoom, pagePoint } = this.pinch
			const z = clamp((startZoom * Vec.dist(a, b)) / startDistance, MIN_ZOOM, MAX_ZOOM)
			inputs.currentScreenPoint = center
			// Keep the page point that started under the fingers' midpoint under it.
			this.setCamera({ x: center.x / z - pagePoint.x, y: center.y / z - pagePoint.y, z })
			return
		}

		const now = performance.now()
		const dt = Math.max(1, now - inputs.lastMoveTime)
		const delta = Vec.sub(point, inputs.currentScreenPoint)
		inputs.velocity = { x: lerp(inputs.velocity.x, delta.x / dt, 0.5), y: lerp(inputs.velocity.y, delta.y / dt, 0.5) }
		inputs.lastMoveTime = now
		inputs.previousScreenPoint = inputs.currentScreenPoint
		inputs.currentScreenPoint = point

		if (this.touchMode === 'pending' && Vec.dist(point, inputs.originScreenPoint) > TOUCH_SLOP) {
			this.touchMode = 'pan'
			inputs.isPanning = true
			inputs.isDragging = true
			this.lastTap = null
			// Catch up on the slop the finger moved before it counted as a pan.
			this.panBy(point.x - inputs.originScreenPoint.x, point.y - inputs.originScreenPoint.y)
			return
		}
		if (this.touchMode === 'pan') this.panBy(delta.x, delta.y)
	}

	private handleTouchUp(e: PointerEvent) {
		if (!this.touches.has(e.pointerId)) return
		const { modifiers } = this.pointerInfo(e)
		const { inputs } = this
		this.touches.delete(e.pointerId)
		if (this.container!.hasPointerCapture(e.pointerId)) this.container!.releasePointerCapture(e.pointerId)
		const mode = this.touchMode

		if (this.touches.size > 0) {
			if (mode !== 'pinch') return
			if (this.touches.size >= 2) return this.startPinch()
			// Lifting one finger of a pinch carries on as a one-finger pan.
			const [rest] = this.touches.values()
			this.touchMode = 'pan'
			this.pinch = null
			inputs.currentScreenPoint = inputs.previousScreenPoint = rest
			inputs.velocity = { x: 0, y: 0 }
			inputs.lastMoveTime = performance.now()
			return
		}

		this.touchMode = null
		this.pinch = null
		inputs.isPointing = false
		inputs.isDragging = false
		inputs.isPanning = false
		if (mode === 'pan') return this.flingCamera()
		if (mode !== 'pending' || e.type === 'pointercancel') return

		// A tap: the state chart gets a click at the point the finger went down, unless it's on a link.
		const point = inputs.originScreenPoint
		const link = this.pointerOnSurface ? this.linkUnder(point) : null
		if (link) {
			this.lastTap = null
			this.openLink(link.href)
			return
		}
		inputs.currentScreenPoint = point
		inputs.currentPagePoint = inputs.originPagePoint = this.screenToPage(point)
		const target = this.getTargetAt(inputs.currentPagePoint)
		inputs.isPointing = true
		this.dispatch({ name: 'pointer_down', point, button: 0, target, ...modifiers })
		inputs.isPointing = false
		this.dispatch({ name: 'pointer_up', point, button: 0, target, ...modifiers })

		const now = performance.now()
		const last = this.lastTap
		if (last && now - last.time < DOUBLE_TAP_MS && Vec.dist(point, last.point) < DOUBLE_TAP_DISTANCE) {
			this.lastTap = null
			this.dispatch({ name: 'double_click', point, target, ...modifiers })
		} else {
			this.lastTap = { time: now, point }
		}
	}

	private handleWheel = (e: WheelEvent) => {
		e.preventDefault()
		this.cameraAnimation = null
		this.panVelocity = null
		const { point } = this.pointerInfo(e)
		this.inputs.currentScreenPoint = point
		this.inputs.isPointerInside = true
		const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.viewport.peek().h : 1
		const dx = e.deltaX * scale
		const dy = e.deltaY * scale

		if (e.ctrlKey || e.metaKey || this.inputs.isSpaceDown) {
			// Trackpad pinch arrives as ctrl+wheel with small deltas; mouse wheel + modifier as big ones.
			const delta = dy !== 0 ? dy : dx
			const z = this.camera.peek().z
			const factor = Math.exp(-clamp(delta, -50, 50) * 0.01)
			this.zoomAt(point, z * factor)
		} else if (e.shiftKey) {
			// Some platforms (macOS) already turn shift+wheel into deltaX, so take whichever axis moved.
			this.panBy(-(dy !== 0 ? dy : dx), 0)
		} else {
			this.panBy(-dx, -dy)
		}
	}

	private handleKeyDown = (e: KeyboardEvent) => {
		if (isEditable(e.target) || this.htmlDrawer.peek()) return
		this.updateModifiers(e)
		const mod = e.metaKey || e.ctrlKey

		if (e.code === 'Space') {
			e.preventDefault()
			if (!this.inputs.isSpaceDown) {
				this.inputs.isSpaceDown = true
				this.updateLinkHover()
				if (!this.inputs.isPointing) this.setCursor('grab')
			}
			return
		}

		// Global shortcuts. Everything else goes to the state chart.
		if (e.shiftKey && e.code === 'Digit1') return this.zoomToFit()
		if (e.shiftKey && e.code === 'Digit2') return this.zoomToSelection()
		if (e.shiftKey && e.code === 'Digit0') return this.resetZoom()
		if (!mod && (e.key === '=' || e.key === '+')) return this.zoomIn()
		if (!mod && (e.key === '-' || e.key === '_')) return this.zoomOut()
		if (mod && (e.key === '=' || e.key === '+')) return e.preventDefault(), this.zoomIn()
		if (mod && e.key === '-') return e.preventDefault(), this.zoomOut()
		if (mod && e.key === 'a') return e.preventDefault(), this.selectAll()
		if (mod && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) return e.preventDefault(), this.deletions.undo()
		if (!mod && (e.key === 'Delete' || e.key === 'Backspace')) {
			e.preventDefault()
			if (!this.inputs.isPointing) this.deletions.deleteSelected()
			return
		}
		const arrows = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' } as const
		if (!this.inputs.isPointing && e.key in arrows) {
			e.preventDefault()
			return this.selectAdjacent(arrows[e.key as keyof typeof arrows])
		}
		if (!mod && !e.altKey && (e.key === 'v' || e.key === 'V')) return this.setCurrentTool('select')
		if (!mod && !e.altKey && (e.key === 'h' || e.key === 'H')) return this.setCurrentTool('hand')
		if (!mod && !e.altKey && (e.key === 'n' || e.key === 'N') && this.createNote) return this.setCurrentTool('note')
		if (!mod && !e.altKey && e.key.length === 1 && 'pPaA'.includes(e.key) && this.annotationDrafts) return this.setCurrentTool('pencil')

		// Esc: the selection goes first, then any subagents' drawers.
		if (e.key === 'Escape' && !this.selectedIds.peek().length && this.drawers.openIds().length && !this.inputs.isPointing) return this.closeDrawers()

		const focused = document.activeElement
		this.dispatch({ name: 'key_down', key: e.key, code: e.code, shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey })
		// A key that opened a text box (see PencilTool) isn't typed into it as well.
		if (document.activeElement !== focused && isEditable(document.activeElement)) e.preventDefault()
	}

	private handleKeyUp = (e: KeyboardEvent) => {
		this.updateModifiers(e)
		if (e.code === 'Space') {
			this.inputs.isSpaceDown = false
			if (!this.inputs.isPanning) this.setCursor(this.restingCursor())
			return
		}
		this.dispatch({ name: 'key_up', key: e.key, code: e.code, shiftKey: e.shiftKey, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey })
	}

	private handleBlur = () => {
		this.inputs.isSpaceDown = false
		this.touches.clear()
		this.touchMode = null
		this.pinch = null
		this.linkPress = null
		this.updateModifiers({ shiftKey: false, altKey: false, ctrlKey: false, metaKey: false })
		if (this.inputs.isPointing) {
			this.inputs.isPointing = this.inputs.isDragging = this.inputs.isPanning = false
			this.dispatch({ name: 'cancel' })
		}
	}

	// ---------- lifecycle ----------

	mount(container: HTMLElement) {
		this.container = container
		const listen = <K extends keyof HTMLElementEventMap>(
			el: HTMLElement | Window,
			type: K,
			fn: (e: HTMLElementEventMap[K]) => void,
			opts?: AddEventListenerOptions,
		) => {
			el.addEventListener(type, fn as EventListener, opts)
			this.disposers.push(() => el.removeEventListener(type, fn as EventListener, opts))
		}
		listen(container, 'pointerdown', this.handlePointerDown)
		listen(container, 'pointermove', this.handlePointerMove)
		listen(container, 'pointerup', this.handlePointerUp)
		listen(container, 'pointercancel', this.handlePointerUp)
		listen(container, 'pointerleave', this.handlePointerLeave)
		listen(container, 'dblclick', this.handleDoubleClick)
		listen(container, 'wheel', this.handleWheel, { passive: false })
		listen(container, 'contextmenu', (e) => e.preventDefault())
		listen(window, 'keydown', this.handleKeyDown)
		listen(window, 'keyup', this.handleKeyUp)
		listen(window, 'blur', this.handleBlur)

		const ro = new ResizeObserver(() => {
			const rect = container.getBoundingClientRect()
			this.viewport.set({ w: rect.width, h: rect.height })
		})
		ro.observe(container)
		this.disposers.push(() => ro.disconnect())

		this.lastFrame = performance.now()
		const loop = (now: number) => {
			this.raf = requestAnimationFrame(loop)
			const elapsed = Math.min(now - this.lastFrame, 100)
			this.lastFrame = now
			this.tick(now, elapsed)
			for (const fn of this.frameListeners) fn(now, elapsed)
		}
		this.raf = requestAnimationFrame(loop)
		this.disposers.push(() => cancelAnimationFrame(this.raf))
	}

	dispose() {
		for (const d of this.disposers.splice(0)) d()
		this.container = null
	}

	onFrame(fn: (now: number, elapsed: number) => void) {
		this.frameListeners.add(fn)
		return () => this.frameListeners.delete(fn)
	}

	/** Camera animation and pan inertia, then a tick for the state chart. */
	private tick(now: number, elapsed: number) {
		transact(() => {
			this.drawers.step(now)
			const anim = this.cameraAnimation
			if (anim) {
				const t = clamp((now - anim.start) / anim.duration, 0, 1)
				const k = easeInOutCubic(t)
				// Interpolate zoom geometrically so it feels even, and keep the motion straight in screen space.
				const z = anim.from.z * Math.pow(anim.to.z / anim.from.z, k)
				const { w, h } = this.viewport.peek()
				const cFrom = { x: w / 2 / anim.from.z - anim.from.x, y: h / 2 / anim.from.z - anim.from.y }
				const cTo = { x: w / 2 / anim.to.z - anim.to.x, y: h / 2 / anim.to.z - anim.to.y }
				const zk = anim.from.z === anim.to.z ? k : (1 / z - 1 / anim.from.z) / (1 / anim.to.z - 1 / anim.from.z)
				const cx = lerp(cFrom.x, cTo.x, zk)
				const cy = lerp(cFrom.y, cTo.y, zk)
				this.setCamera(t >= 1 ? anim.to : { x: w / 2 / z - cx, y: h / 2 / z - cy, z })
				if (t >= 1) this.cameraAnimation = null
			}

			const v = this.panVelocity
			if (v) {
				this.panBy(v.x * elapsed, v.y * elapsed)
				const decay = Math.exp(-PAN_FRICTION * elapsed)
				v.x *= decay
				v.y *= decay
				if (Math.hypot(v.x, v.y) < 0.01) this.panVelocity = null
			}

			this.root.handleEvent({ name: 'tick', elapsed })
			// The camera or the document can move a link under a still pointer.
			if (this.lastPointerType !== 'touch' && this.inputs.isPointerInside) this.updateLinkHover()
		})
	}

	isCameraMoving() {
		return this.cameraAnimation !== null || this.panVelocity !== null
	}

	getEpoch() {
		return getGlobalEpoch()
	}
}

function boxRecordEquals(a: Record<string, Box>, b: Record<string, Box>) {
	const keys = Object.keys(a)
	return keys.length === Object.keys(b).length && keys.every((k) => b[k] && Box.equals(a[k], b[k]))
}

function linkEquals(a: HtmlLink | null, b: HtmlLink | null) {
	if (a === b) return true
	if (!a || !b || a.itemId !== b.itemId || a.href !== b.href || a.rects.length !== b.rects.length) return false
	return a.rects.every((r, i) => Box.equals(r, b.rects[i]))
}

function activityEquals(a: Record<string, SessionActivity>, b: Record<string, SessionActivity>) {
	return JSON.stringify(a) === JSON.stringify(b)
}

function recordEquals(a: Record<string, string>, b: Record<string, string>) {
	const keys = Object.keys(a)
	return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k])
}

function arrayEquals(a: string[], b: string[]) {
	return a.length === b.length && a.every((v, i) => v === b[i])
}

function isEditable(target: EventTarget | null) {
	const el = target as HTMLElement | null
	return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}

function midpoint(a: Vec, b: Vec): Vec {
	return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}
