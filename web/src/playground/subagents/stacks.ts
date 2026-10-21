import { el } from '../shared/controls'
import type { ParamValues } from '../shared/params'
import { EASES, type ConceptId } from './concepts'
import { agentName, deckOrder, relTime, type Frame, type World } from './data'
import { fanLayout, focusLayout, frameGeom, frameMaxRow, FRAME, type FanKind, type FrameGeom, type Rect } from './geometry'
import { Stagger } from './motion'
import { outExtent, outPose, type OutExtra, type OutLayout, type OutParams } from './outlayouts'
import { copyPose, lerpPose, pose, recede, transformOf, type Pose } from './pose'

export interface Cam {
	/** screen = page × z + (x, y), in CSS px */
	x: number
	y: number
	z: number
}

interface Card {
	f: Frame
	g: FrameGeom
	el: HTMLElement
	title: HTMLElement
	titleText: HTMLElement
	meta: HTMLElement | null
	strip: HTMLElement | null
	stripTime: HTMLElement | null
	stripMore: HTMLElement | null
	ring: HTMLElement
	flow: HTMLElement | null
	/** the index tab (zoomed-out "tabs" layout) and the "+N" cover (dock, tabs) */
	tab: HTMLElement | null
	tabMore: HTMLElement | null
	tabFlow: HTMLElement | null
	plus: HTMLElement | null
	/** this frame's zoomed-out extras: tab placement, "+N", rank */
	extra: OutExtra
	/** 0…1: rises when it starts running, resolves over 600 ms when it stops */
	busy: number
	/** its place in the deck this frame, and how many children are hidden below the shown ones */
	slot: number
	hidden: number
	target: Pose
	shown: Pose
	z: number
	/** drawn this frame */
	live: boolean
	lift: Stagger
	last: Record<string, string | number>
}

interface Chip {
	el: HTMLElement
	text: string
	open: boolean
	last: Record<string, string | number>
}

interface FocusLevel {
	root: Card
	si: number
	g: Stagger
	saved: Cam
	/** the root's children, in focus order */
	kids: Card[]
}

interface DeckParams {
	depth: number
	offset: number
	tilt: number
	persp: number
	falloff: number
	dim: number
	shadow: number
}

const COLS = 4
const COL_GAP = 200
const ROW_GAP = 280
const CHIP_SPACE = 96

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v))
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const lerpRect = (a: Rect, b: Rect, t: number): Rect => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), w: lerp(a.w, b.w, t), h: lerp(a.h, b.h, t) })

export class Engine {
	readonly worldEl = el('div', 'sa-world')
	readonly cam: Cam = { x: 0, y: 0, z: 0.2 }
	viewW = 1
	viewH = 1
	concept: ConceptId = 'deck'
	params: Record<string, ParamValues> = {}
	reduced = false
	ghosts = false
	nested = true
	/** the demo clock (s): what "4m ago" counts from */
	clock = 0
	selected: string | null = null

	private cards = new Map<string, Card>()
	private chips: Chip[] = []
	private fan: Stagger[] = []
	private peek: Stagger[] = []
	private order: Frame[][] = []
	private focus: FocusLevel[] = []
	private exiting: FocusLevel[] = []
	private scrims = [el('div', 'sa-scrim'), el('div', 'sa-scrim')]
	private headings: HTMLElement[] = []
	private kidCache: Card[][] = []
	private homes: { x: number; y: number }[] = []
	private boxes: Rect[] = []
	private expansion: number[] = []
	private morph: { snap: Map<string, Pose>; start: number; dur: number } | null = null
	private leaving = new Map<string, { card: Card; si: number }>()
	private anim: { from: Cam; to: Cam; start: number; dur: number; ease: string } | null = null
	private peekSi = -1
	/** the camera before a fan glided it, to glide back on gather if nobody moved it since */
	private fanCam: ({ cam: Cam; at: number } | null)[] = []
	private userMovedAt = -1
	/** which side each session's peek fans out to: 1 right, -1 left (whichever has more room when it starts) */
	private peekSide: number[] = []
	private liftId: string | null = null
	private now = 0
	onFocusChange: () => void = () => {}

	constructor(readonly world: World) {
		this.worldEl.append(...this.scrims)
		world.sessions.forEach((s, si) => {
			this.addCard(s)
			for (const f of world.pools[si]) {
				this.addCard(f)
				for (const g of f.children) this.addCard(g)
			}
			const chip = el('div', 'sa-chip')
			chip.dataset.chip = String(si)
			chip.style.setProperty('--c', s.color)
			this.worldEl.append(chip)
			this.chips.push({ el: chip, text: '', open: false, last: {} })
			this.fan.push(new Stagger())
			this.peek.push(new Stagger())
			this.order.push(deckOrder(s.children))
		})
	}

	// ---------- cards ----------

	private addCard(f: Frame) {
		const child = !!f.parent
		const g = f.ghost ? { w: 980, h: FRAME.head + FRAME.empty + FRAME.pad, tiles: [] } : frameGeom(f.tiles, frameMaxRow(f))
		const card = el('div', `sa-card ${child ? 'child' : 'parent'}`)
		card.dataset.card = f.id
		card.style.setProperty('--c', f.color)
		card.style.setProperty('--diag', `${Math.round(Math.hypot(Math.max(g.w, 1800), Math.max(g.h, 1200)) + 100)}px`)
		const clip = el('div', 'sa-clip')
		g.tiles.forEach((r, i) => {
			const t = el('div', 'sa-tile')
			t.style.cssText = `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;background:${f.tiles[i].bg}`
			clip.append(t)
		})
		const titleText = el('span', 't', f.title)
		const title = el('div', 'sa-title')
		if (child) title.append(el('span', 'sa-dot'), el('span', 'sa-agent', agentName(f.agent)), titleText)
		else title.append(titleText)
		const ring = el('div', 'sa-ring')
		card.append(clip, title, ring)
		// Busy effects start at different points of their cycle, so they don't pulse in step.
		card.style.setProperty('--sweep-delay', `${(-(f.id.length * 7.3 + f.title.length * 1.7) % 6).toFixed(2)}s`)
		let meta: HTMLElement | null = null
		let strip: HTMLElement | null = null
		let stripTime: HTMLElement | null = null
		let stripMore: HTMLElement | null = null
		let flow: HTMLElement | null = null
		let tab: HTMLElement | null = null
		let tabMore: HTMLElement | null = null
		let tabFlow: HTMLElement | null = null
		let plus: HTMLElement | null = null
		if (child) {
			meta = el('div', 'sa-meta')
			stripTime = el('span', 'tm')
			stripMore = el('span', 'more')
			flow = el('div', 'sa-flow')
			strip = el('div', 'sa-strip', el('span', 'sa-dot'), el('span', 'ag', agentName(f.agent)), el('span', 'tt', f.title), stripTime, stripMore, flow)
			tabMore = el('span', 'more')
			tabFlow = el('div', 'sa-flow')
			tab = el('div', 'sa-tab', el('span', 'sa-dot'), el('span', 'ag', agentName(f.agent)), el('span', 'tt', f.title), tabMore, tabFlow)
			plus = el('div', 'sa-plus')
			card.append(meta, strip, tab, plus)
			if (f.ghost) {
				card.classList.add('ghost')
				card.append(el('div', 'sa-empty', 'Running · nothing posted yet'))
			}
		}
		card.style.visibility = 'hidden'
		this.worldEl.append(card)
		this.cards.set(f.id, {
			f,
			g,
			el: card,
			title,
			titleText,
			meta,
			strip,
			stripTime,
			stripMore,
			ring,
			flow,
			tab,
			tabMore,
			tabFlow,
			plus,
			extra: { tabX: 0, tabW: 0, tabH: 0, plus: 0, rank: 0 },
			busy: f.status === 'busy' ? 1 : 0,
			slot: 0,
			hidden: 0,
			target: pose(),
			shown: pose({ o: 0 }),
			z: 0,
			live: false,
			lift: new Stagger(),
			last: {},
		})
	}

	card(id: string) {
		return this.cards.get(id)
	}

	/** the children a session shows, in deck order (ghosts on top when shown) */
	kids(si: number): Card[] {
		const s = this.world.sessions[si]
		const list = this.order[si].filter((f) => s.children.includes(f)).map((f) => this.cards.get(f.id)!)
		if (this.ghosts) for (const f of this.world.pools[si]) if (f.ghost && !s.children.includes(f)) list.unshift(this.cards.get(f.id)!)
		return list
	}

	private grandkids(c: Card): Card[] {
		if (!this.nested) return []
		return c.f.children.map((g) => this.cards.get(g.id)!)
	}

	sessionOf(id: string): number {
		const c = this.cards.get(id)
		if (!c) return -1
		let f = c.f
		while (f.parent) f = f.parent
		return this.world.sessions.indexOf(f)
	}

	// ---------- params ----------

	private get p(): ParamValues {
		return this.params[this.concept]
	}

	private deckParams(): DeckParams {
		const p = this.p
		const num = (k: string, d: number) => (typeof p[k] === 'number' ? (p[k] as number) : d)
		return {
			depth: num('depth', 3),
			// Strips never get thinner than a few screen pixels, so a deck still reads as a deck far out.
			offset: Math.max(num('offset', 40), num('minOff', 0) / this.cam.z),
			tilt: num('tilt', 0),
			persp: num('persp', 2400),
			falloff: num('falloff', 0.94),
			dim: num('dim', 0.12),
			shadow: num('shadow', 0.6),
		}
	}

	/** Semantic zoom's zoomed-out layout. */
	outLayout(): OutLayout {
		return (this.params.zoom?.outLayout as OutLayout) ?? 'tucked'
	}

	private outParams(): OutParams {
		const p = this.params.zoom
		const num = (k: string, d: number) => (typeof p[k] === 'number' ? (p[k] as number) : d)
		const px = 1 / this.cam.z
		return {
			px,
			depth: num('depth', 4),
			offset: Math.max(num('offset', 34), num('minOff', 12) * px),
			falloff: num('falloff', 0.975),
			jitter: num('jitter', 0.5),
			dim: num('dim', 0.1),
			shadow: num('shadow', 0.6),
			perRow: num('perRow', 6),
			overflow: (p.overflow as string) ?? 'wrap',
			dockGap: num('dockGap', 28),
			handSize: num('handSize', 0.26),
			handStep: num('handStep', 6),
			arc: num('arc', 4),
			tuck: num('tuck', 0.22),
			maxHand: num('maxHand', 9),
			maxTabs: num('maxTabs', 6),
			tabStep: num('tabStep', 12),
			tabH: num('tabH', 40),
		}
	}

	private timing() {
		const p = this.p
		return { dur: (p.dur as number) ?? 440, stagger: (p.stagger as number) ?? 30, ease: (p.ease as string) ?? 'in-out' }
	}

	/** "auto", like macOS Stacks' Automatic: a row for a few, a grid for more. */
	private fanKind(n: number): FanKind {
		if (this.concept === 'zoom') return 'below'
		const k = (this.p.fan as string) ?? 'auto'
		return k === 'auto' ? (n <= 4 ? 'row' : 'grid') : (k as FanKind)
	}

	private ease(t: number) {
		return EASES[this.timing().ease](clamp(t))
	}

	/** Semantic zoom: how spread the families are at zoom z (0 gathered … 1 dealt), linear in log zoom. */
	zoomSpread(z = this.cam.z) {
		if (this.concept !== 'zoom') return 0
		const lo = Math.log((this.p.zOut as number) / 100)
		const hi = Math.log(Math.max((this.p.zIn as number) / 100, (this.p.zOut as number) / 100 + 0.01))
		const t = clamp((Math.log(z) - lo) / (hi - lo))
		if (this.reduced) return t >= 0.5 ? 1 : 0
		return t
	}

	// ---------- state changes ----------

	setConcept(id: ConceptId) {
		this.concept = id
		for (const f of this.fan) f.jump(0)
		for (const p of this.peek) p.jump(0)
		this.focus = []
		this.exiting = []
		this.peekSi = -1
		this.liftId = null
		this.hoverPending = null
		this.leavePending = null
		this.world.sessions.forEach((_, si) => this.resort(si))
		this.onFocusChange()
	}

	isFanned(si: number) {
		return this.fan[si].target > 0
	}

	setFan(si: number, on: boolean) {
		const { dur, stagger, ease } = this.timing()
		const n = this.kids(si).length
		if (!n && on) return
		const was = this.fan[si].target
		this.fan[si].set(on ? 1 : 0, this.now, n, dur, stagger, ease, this.reduced)
		if (on) {
			this.peek[si].set(0, this.now, 1, dur * 0.8, 0, ease, this.reduced)
			this.keepInView(si)
		} else if (was > 0) {
			// Gathering: if the fan moved the camera and nobody has moved it since, glide back.
			const saved = this.fanCam[si]
			this.fanCam[si] = null
			if (saved && this.userMovedAt < saved.at && !this.focus.length) this.animateCamera(saved.cam, this.fan[si].span())
		}
	}

	toggleFan(si: number) {
		this.setFan(si, !this.isFanned(si))
	}

	anyFanned() {
		return this.fan.some((f) => f.target > 0)
	}

	collapseAll() {
		this.world.sessions.forEach((_, si) => this.setFan(si, false))
	}

	/** Pointer over a card (or nothing): side peek follows it, with hover intent and a grace period (timed on the engine clock). */
	private hoverPending: { si: number; at: number } | null = null
	private leavePending: { si: number; at: number } | null = null
	hover(id: string | null) {
		if (this.concept !== 'peek' || this.focus.length) return
		const c = id ? this.cards.get(id) : null
		const si = c ? this.sessionOf(c.f.id) : -1
		// On the deck: a child of a collapsed session (stacked or peeked), or the parent of the one peeking.
		const onDeck = !!c && si >= 0 && !this.isFanned(si) && (c.f.parent ? this.kids(si).includes(c) : si === this.peekSi)
		this.liftId = onDeck && c!.f.parent && si === this.peekSi && this.kids(si).indexOf(c!) < this.peekCount(si) ? c!.f.id : null
		if (onDeck) {
			if (this.leavePending?.si === si) this.leavePending = null
			if (this.peekSi === si || !c!.f.parent || this.hoverPending?.si === si) return
			this.hoverPending = { si, at: this.now + (this.reduced ? 0 : (this.p.hoverDelay as number)) }
			return
		}
		this.hoverPending = null
		if (this.peekSi >= 0 && !this.leavePending) this.leavePending = { si: this.peekSi, at: this.now + 160 }
	}

	private stepHover() {
		const h = this.hoverPending
		if (h && this.now >= h.at) {
			this.hoverPending = null
			if (this.peekSi >= 0 && this.peekSi !== h.si) this.setPeek(this.peekSi, false)
			this.setPeek(h.si, true)
		}
		const l = this.leavePending
		if (l && this.now >= l.at) {
			this.leavePending = null
			if (this.peekSi === l.si) this.setPeek(l.si, false)
		}
	}

	closePeek() {
		this.hoverPending = null
		this.leavePending = null
		if (this.peekSi >= 0) {
			this.setPeek(this.peekSi, false)
			return true
		}
		return false
	}

	/** Undo a fan that a double-click's first click started (it becomes a focus instead). */
	cancelFan(si: number) {
		this.fan[si].jump(0)
	}

	private peekCount(si: number) {
		return Math.min(this.kids(si).length, (this.p.peekCount as number) ?? 4)
	}

	private setPeek(si: number, on: boolean) {
		const { dur, stagger, ease } = this.timing()
		if (on && this.peek[si].all(this.now) < 0.01) {
			const b = this.screenBox(this.world.sessions[si].id)
			this.peekSide[si] = b && b.x + b.w / 2 > this.viewW / 2 ? -1 : 1
		}
		this.peekSi = on ? si : this.peekSi === si ? -1 : this.peekSi
		// Coming back is a touch quicker than going out.
		this.peek[si].set(on ? 1 : 0, this.now, this.peekCount(si), on ? dur : dur * 0.8, stagger, ease, this.reduced)
		if (!on) {
			this.liftId = null
			this.resortLater(si)
		}
	}

	/** Re-sorts a deck only when nobody's looking at it: never while it's fanned, peeked or focused. */
	resort(si: number) {
		this.order[si] = deckOrder(this.world.sessions[si].children)
	}

	private settled(si: number) {
		return this.fan[si].target === 0 && this.peek[si].target === 0 && !this.focus.some((l) => l.si === si)
	}

	private pendingSort = new Set<number>()
	resortLater(si: number) {
		this.pendingSort.add(si)
	}

	/** The world changed (a child arrived, finished, left): re-sort where allowed and glide everything to its new place. */
	dataChanged(si: number) {
		const before = new Set(this.kids(si).map((c) => c.f.id))
		const s = this.world.sessions[si]
		// Keep the current order for children still there; newcomers go on top.
		const kept = this.order[si].filter((f) => s.children.includes(f))
		const fresh = s.children.filter((f) => !kept.includes(f))
		this.order[si] = [...deckOrder(fresh), ...kept]
		if (this.settled(si)) this.resort(si)
		else this.resortLater(si)
		for (const id of before) if (!this.kids(si).some((c) => c.f.id === id)) this.leaving.set(id, { card: this.cards.get(id)!, si })
		this.startMorph()
	}

	startMorph(dur?: number) {
		const snap = new Map<string, Pose>()
		for (const [id, c] of this.cards) if (c.live) snap.set(id, copyPose(c.shown))
		this.morph = { snap, start: this.now, dur: this.reduced ? 1 : (dur ?? Math.max(240, this.timing().dur)) }
	}

	// ---------- focus ----------

	focused() {
		return this.focus
	}

	focusDepth() {
		return this.focus.length
	}

	/** Steps into a session (or, inside one, into a subagent that ran subagents of its own). */
	enter(id: string) {
		const c = this.cards.get(id)
		if (!c) return
		const si = this.sessionOf(id)
		let root: Card
		if (!this.focus.length) root = this.cards.get(this.world.sessions[si].id)!
		else if (c.f.parent && this.grandkids(c).length && this.focus[this.focus.length - 1].root !== c && this.focus.length < 2) root = c
		else return
		const kids = root.f.parent ? this.grandkids(root) : this.focusOrder(this.kids(si))
		const { dur, stagger, ease } = this.focusTiming()
		const g = new Stagger()
		g.set(1, this.now, kids.length, dur, stagger, ease, this.reduced)
		this.liftId = null
		if (this.peekSi >= 0) this.setPeek(this.peekSi, false)
		const level: FocusLevel = { root, si, g, saved: { ...this.cam }, kids }
		this.focus.push(level)
		if (this.focus.length === 1) this.setFan(si, false)
		this.selected = root.f.id
		this.animateCamera(this.focusCamera(level), dur + Math.min(Stagger.CAP, stagger * Math.max(0, kids.length - 1)), ease)
		this.onFocusChange()
	}

	back() {
		const level = this.focus.pop()
		if (!level) return false
		const { dur, stagger, ease } = this.focusTiming()
		level.g.set(0, this.now, level.kids.length, dur, stagger, ease, this.reduced)
		this.exiting.push(level)
		this.animateCamera(level.saved, level.g.span(), ease)
		this.selected = level.root.f.id
		this.resortLater(level.si)
		this.onFocusChange()
		return true
	}

	private focusOrder(kids: Card[]) {
		const rank = (c: Card) => (c.f.status === 'busy' ? 0 : c.f.status === 'failed' ? 1 : 2)
		return [...kids].sort((a, b) => rank(a) - rank(b) || b.f.at - a.f.at)
	}

	private focusTiming() {
		const p = this.concept === 'focus' ? this.p : this.params.focus
		return { dur: p.dur as number, stagger: p.stagger as number, ease: p.ease as string }
	}

	private focusParams() {
		return this.params.focus
	}

	private focusLayoutFor(level: { root: Card; kids: Card[] }) {
		const fp = this.focusParams()
		const sizes = level.kids.map((k) => ({ size: this.layoutSize(k), group: k.f.status === 'busy' ? 'Running' : k.f.status === 'failed' ? 'Failed' : 'Done' }))
		return focusLayout({ w: level.root.g.w, h: level.root.g.h }, sizes, (fp.focusScale as number) * (level.root.f.parent ? 1.1 : 1), fp.cols as number)
	}

	/** The camera that frames a focus level once it has opened. */
	private focusCamera(level: FocusLevel): Cam {
		const rootPose = level.root.f.parent ? level.root.shown : this.homePose(level.si)
		const lay = this.focusLayoutFor(level)
		const ps = rootPose.s
		const left = rootPose.x - (rootPose.bw * ps) / 2
		const box = { x: left + lay.box.x * ps, y: rootPose.y + lay.box.y * ps - 40 * ps, w: lay.box.w * ps, h: lay.box.h * ps + 40 * ps }
		return this.fitBox(box, 72, 64)
	}

	// ---------- camera ----------

	setView(w: number, h: number) {
		this.viewW = w
		this.viewH = h
	}

	fitBox(b: Rect, pad = 56, top = 0): Cam {
		const z = Math.min((this.viewW - pad * 2) / b.w, (this.viewH - pad * 2 - top - 24) / b.h, 1.2)
		return { z, x: (this.viewW - b.w * z) / 2 - b.x * z, y: top + (this.viewH - top - b.h * z) / 2 - b.y * z - 12 }
	}

	/** Everything, fitted (semantic zoom settles the layout at the zoom it fits at). */
	fitAll(): Cam {
		let cam = { ...this.cam }
		for (let k = 0; k < 4; k++) {
			const b = this.layoutBounds(this.expansionsAt(cam.z))
			cam = this.fitBox(b)
		}
		return cam
	}

	animateCamera(to: Cam, dur: number, ease = this.timing().ease) {
		if (this.reduced || dur <= 1) {
			Object.assign(this.cam, to)
			this.anim = null
			return
		}
		this.anim = { from: { ...this.cam }, to, start: this.now, dur, ease }
	}

	stopCamera() {
		this.anim = null
	}

	cameraMoving() {
		return !!this.anim
	}

	/** Zooms about a screen point; with semantic zoom, the family under the pointer stays put as the layout changes. */
	zoomAt(sx: number, sy: number, z: number) {
		z = clamp(z, 0.03, 4)
		const old = this.cam.z
		let anchor: { si: number; x: number; y: number } | null = null
		if (!this.focus.length) {
			const px = (sx - this.cam.x) / old
			const py = (sy - this.cam.y) / old
			let best = Infinity
			this.boxes.forEach((b, si) => {
				const dx = Math.max(b.x - px, 0, px - b.x - b.w)
				const dy = Math.max(b.y - py, 0, py - b.y - b.h)
				const d = Math.hypot(dx, dy)
				if (d < best) {
					best = d
					anchor = { si, x: this.homes[si].x, y: this.homes[si].y }
				}
			})
		}
		this.cam.x = sx - ((sx - this.cam.x) * z) / old
		this.cam.y = sy - ((sy - this.cam.y) * z) / old
		this.cam.z = z
		this.anim = null
		this.userMovedAt = this.now
		if (anchor) {
			// The layout can depend on zoom (semantic zoom, minimum strip offsets): keep that family put.
			const a = anchor as { si: number; x: number; y: number }
			const homes = this.layoutHomes(this.expansionsAt(z))
			this.cam.x += (a.x - homes[a.si].x) * z
			this.cam.y += (a.y - homes[a.si].y) * z
		}
	}

	pan(dx: number, dy: number) {
		this.cam.x += dx
		this.cam.y += dy
		this.anim = null
		this.userMovedAt = this.now
	}

	/** After a fan: glide the camera (same curve and time) so the whole family stays in view. */
	private keepInView(si: number) {
		if (this.focus.length) return
		const ex = this.expansionsAt(this.cam.z)
		ex.e[si] = 1
		const homes = this.layoutHomes(ex)
		const rel = this.familyBox(si, 1)
		const b = { x: homes[si].x + rel.x, y: homes[si].y + rel.y, w: rel.w, h: rel.h }
		const z = this.cam.z
		const pad = 40
		const sx = b.x * z + this.cam.x
		const sy = b.y * z + this.cam.y
		if (sx >= pad && sy >= pad && sx + b.w * z <= this.viewW - pad && sy + b.h * z <= this.viewH - pad - 24) return
		// Zoom out only so far (never below 70% of where you were); past that, pan to keep the parent and the start of the fan.
		const fitted = this.fitBox(b, 64)
		const minZ = z * 0.7
		const to: Cam = fitted.z >= minZ ? (fitted.z < z ? fitted : { z, x: this.cam.x, y: this.cam.y }) : { z: minZ, x: 0, y: 0 }
		if (fitted.z < minZ) {
			to.x = 64 - b.x * minZ
			to.y = Math.max(64 - b.y * minZ, (this.viewH - b.h * minZ) / 2 - b.y * minZ)
		} else if (fitted.z >= z) {
			if (sx + b.w * z > this.viewW - pad) to.x -= sx + b.w * z - (this.viewW - pad)
			if (sx + (to.x - this.cam.x) < pad) to.x += pad - (sx + (to.x - this.cam.x))
			if (sy + b.h * z > this.viewH - pad - 24) to.y -= sy + b.h * z - (this.viewH - pad - 24)
			if (sy + (to.y - this.cam.y) < pad) to.y += pad - (sy + (to.y - this.cam.y))
		}
		const { dur, stagger } = this.timing()
		const n = this.kids(si).length
		this.fanCam[si] = { cam: { ...this.cam }, at: this.now }
		this.animateCamera(to, dur + Math.min(Stagger.CAP, stagger * Math.max(0, n - 1)))
	}

	// ---------- layout ----------

	/** A child's footprint when laid out: its frame, plus room for its own mini deck if it ran subagents. */
	private layoutSize(c: Card) {
		const gk = this.grandkids(c).length
		return { w: c.g.w, h: c.g.h + (gk ? this.deckParams().offset * Math.min(gk, 3) + 24 : 0) }
	}

	/** Each family's spread: 0 gathered (zoomed-out layout or deck) … 1 dealt into rows. */
	private spreadsAt(z: number) {
		const zs = this.zoomSpread(z)
		const e = this.world.sessions.map((_, si) => Math.max(this.concept === 'zoom' ? this.ease(zs) : 0, this.fan[si].all(this.now)))
		return { e }
	}

	private expansionsAt(z: number) {
		return this.spreadsAt(z)
	}

	/** Semantic zoom: every child's zoomed-out pose around a parent pose, with its extras. */
	private outPoses(P: Pose, kids: Card[], into?: Pose[]) {
		const layout = this.outLayout()
		const q = this.outParams()
		return kids.map((c, i) => {
			const out = into?.[i] ?? pose()
			outPose(layout, P, i, kids.length, c.g, q, out, c.extra)
			if (into) into[i] = out
			return out
		})
	}

	/** The family's extent relative to the parent's top-left, at spread e. */
	private familyBox(si: number, e: number): Rect {
		const parent = this.cards.get(this.world.sessions[si].id)!
		const pw = parent.g.w
		const ph = parent.g.h
		const kids = this.kids(si)
		if (!kids.length) return { x: 0, y: 0, w: pw, h: ph }
		const d = this.deckParams()
		const shown = Math.min(kids.length, d.depth)
		let deck: Rect = { x: 0, y: 0, w: pw, h: ph + d.offset * shown + CHIP_SPACE }
		if (this.concept === 'zoom') {
			const P = pose({ x: pw / 2, y: 0, s: 1, bw: pw, bh: ph })
			const poses = this.outPoses(P, kids)
			const ext = outExtent(this.outLayout(), poses, kids.map((k) => ({ ...k.extra })), { w: pw, h: ph })
			deck = { ...ext, h: ext.h + CHIP_SPACE }
		}
		if (e <= 0) return deck
		const fan = this.fanFor(si, kids).box
		const spread = { ...fan, h: Math.max(fan.h, ph + CHIP_SPACE) }
		return lerpRect(deck, spread, e)
	}

	private fanFor(si: number, kids: Card[]) {
		const parent = this.cards.get(this.world.sessions[si].id)!
		const p = this.p
		return fanLayout(this.fanKind(kids.length), { w: parent.g.w, h: parent.g.h }, kids.map((k) => this.layoutSize(k)), (p.fanScale as number) ?? 0.6, (p.cols as number) ?? 3)
	}

	private layoutHomes(ex: { e: number[] }) {
		return this.layout(ex).homes
	}

	private layoutBounds(ex: { e: number[] }): Rect {
		const { boxes } = this.layout(ex)
		let x0 = Infinity
		let y0 = Infinity
		let x1 = -Infinity
		let y1 = -Infinity
		for (const b of boxes) {
			x0 = Math.min(x0, b.x)
			y0 = Math.min(y0, b.y)
			x1 = Math.max(x1, b.x + b.w)
			y1 = Math.max(y1, b.y + b.h)
		}
		return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
	}

	/** Families in rows of four; columns and rows grow and shrink with each family's spread, so neighbours reflow. */
	private layout(ex: { e: number[] }) {
		const n = this.world.sessions.length
		const rel = this.world.sessions.map((_, si) => this.familyBox(si, ex.e[si]))
		const homes: { x: number; y: number }[] = new Array(n)
		const boxes: Rect[] = new Array(n)
		let top = 0
		for (let r = 0; r * COLS < n; r++) {
			const idx = Array.from({ length: Math.min(COLS, n - r * COLS) }, (_, k) => r * COLS + k)
			const minY = Math.min(...idx.map((i) => rel[i].y))
			const maxY = Math.max(...idx.map((i) => rel[i].y + rel[i].h))
			let x = 0
			for (const i of idx) {
				homes[i] = { x: x - rel[i].x, y: top - minY }
				boxes[i] = { x, y: top - minY + rel[i].y, w: rel[i].w, h: rel[i].h }
				x += rel[i].w + COL_GAP
			}
			top += maxY - minY + ROW_GAP
		}
		return { homes, boxes }
	}

	private homePose(si: number): Pose {
		const c = this.cards.get(this.world.sessions[si].id)!
		const h = this.homes[si] ?? { x: 0, y: 0 }
		return pose({ x: h.x + c.g.w / 2, y: h.y, s: 1, bw: c.g.w, bh: c.g.h, pox: h.x + c.g.w / 2, poy: h.y + c.g.h / 2 })
	}

	// ---------- poses ----------

	private deckPose(P: Pose, i: number, c: Card, d: DeckParams, out: Pose) {
		const ps = P.s
		const pw = P.bw * ps
		const ph = P.bh * ps
		const slot = Math.max(0, Math.min(i, d.depth - 1))
		const k = Math.pow(d.falloff, slot + 1)
		const w = pw * k
		const s = Math.min(ps, w / c.g.w)
		const off = d.offset * ps * (slot + 1)
		out.x = P.x
		out.s = s
		out.bw = w / s
		out.bh = (ph * k) / s
		out.ry = 0
		out.rz = 0
		out.tab = 0
		out.pox = P.x
		out.poy = P.y + ph / 2
		out.persp = d.persp * ps
		out.o = clamp(d.depth - i)
		out.shade = Math.min(0.85, d.dim * (slot + 1))
		out.strip = 1
		out.sh = d.shadow
		out.y = P.y + ph + off - ph * k
		out.hy = 1
		out.rx = d.tilt
		out.tz = 0
		out.grx = 0
		out.gx = P.x
		out.gy = P.y + ph
		return out
	}

	private placedPose(P: Pose, pl: { x: number; y: number; s: number }, c: Card, out: Pose) {
		const ps = P.s
		const left = P.x - (P.bw * ps) / 2
		const s = pl.s * ps
		out.x = left + pl.x * ps + (c.g.w * s) / 2
		out.y = P.y + pl.y * ps
		out.s = s
		out.bw = c.g.w
		out.bh = c.g.h
		out.hy = 0.5
		out.rx = 0
		out.ry = 0
		out.rz = 0
		out.tz = 0
		out.tab = 0
		out.grx = 0
		out.gx = out.x
		out.gy = out.y
		out.pox = out.x
		out.poy = out.y + (c.g.h * s) / 2
		out.persp = P.persp
		out.o = 1
		out.shade = 0
		out.strip = 0
		out.sh = 0
		return out
	}

	private peekPose(P: Pose, i: number, c: Card, out: Pose, side: number) {
		const p = this.p
		const ps = P.s
		const edge = P.x + (side * (P.bw * ps)) / 2
		const s = (p.peekScale as number) * ps * Math.min(1.25, 1000 / c.g.w)
		// Spread is a fraction of a peeked card's width: 1 lays them edge to edge, less overlaps them like a hand.
		const near = edge + side * (80 * ps + i * (p.spread as number) * 1000 * (p.peekScale as number) * ps)
		out.x = near + (side * (c.g.w * s)) / 2
		out.y = P.y + i * (p.drop as number) * ps
		out.s = s
		out.bw = c.g.w
		out.bh = c.g.h
		out.hy = 0.5
		out.rx = 0
		out.ry = side * (p.angle as number)
		out.rz = 0
		out.tab = 0
		out.tz = 0
		out.grx = 0
		out.gx = out.x
		out.gy = out.y
		out.pox = edge + side * 160 * ps
		out.poy = P.y + (P.bh * ps) / 2
		out.persp = (p.persp as number) * ps
		out.o = 1
		out.shade = Math.min(0.5, i * 0.07)
		out.strip = 0
		out.sh = 1
		return out
	}

	// ---------- the frame ----------

	update(now: number) {
		this.now = now
		this.stepCamera(now)
		this.stepHover()
		for (const si of [...this.pendingSort]) {
			if (this.settled(si) && !this.fan[si].busy(now) && !this.peek[si].busy(now)) {
				this.pendingSort.delete(si)
				const before = this.order[si].map((f) => f.id).join()
				this.resort(si)
				if (this.order[si].map((f) => f.id).join() !== before) this.startMorph()
			}
		}
		this.exiting = this.exiting.filter((l) => l.g.busy(now))

		const z = this.cam.z
		const zs = this.zoomSpread(z)
		const d = this.deckParams()
		this.kidCache = this.world.sessions.map((_, si) => this.kids(si))
		const spreads = this.spreadsAt(z)
		this.expansion = spreads.e
		const lay = this.layout(spreads)
		this.homes = lay.homes
		this.boxes = lay.boxes

		for (const c of this.cards.values()) c.live = false
		const tmpA = pose()
		const tmpB = pose()
		const outs: Pose[] = []
		this.worldEl.classList.toggle('out-tabs', this.concept === 'zoom' && this.outLayout() === 'tabs')

		this.world.sessions.forEach((s, si) => {
			const parent = this.cards.get(s.id)!
			const P = this.homePose(si)
			const e = this.expansion[si]
			const kids = this.kids(si)
			const fan = this.fan[si]
			const dip = fan.dip(now) * this.peek[si].dip(now)
			const boost = fan.target > 0 || fan.busy(now) || this.peek[si].target > 0 || this.peek[si].busy(now) || this.selected === s.id ? 10000 : 0
			const B = 100 + si * 1000 + boost
			parent.target = P
			parent.z = B + 900
			parent.live = true

			const fanLay = kids.length ? this.fanFor(si, kids) : null
			const zsCount = kids.length
			const peel = (this.p.peel as number) ?? 0
			// Each card's flight is short (≥ 20% of the range), so at any resting zoom only one or two are mid-air.
			const peelStep = zsCount > 1 ? Math.min(peel, 0.8 / (zsCount - 1)) : 0
			// While a side peek is out, the children left in the deck slide up into the slots it vacated.
			const K = this.concept === 'peek' ? this.peekCount(si) : 0
			const vacated = K ? K * this.peek[si].all(now) : 0
			const zoomed = this.concept === 'zoom'
			if (zoomed) this.outPoses(P, kids, outs)
			kids.forEach((c, i) => {
				c.slot = i >= K ? i - vacated : i
				c.hidden = kids.length - Math.round(vacated) - d.depth
				if (!zoomed) c.extra.rank = i
				const deck = zoomed ? outs[i] : this.deckPose(P, c.slot, c, d, tmpA)
				const spread = this.placedPose(P, fanLay!.at[i], c, tmpB)
				let t = fan.value(i, now)
				if (zoomed) {
					// Zooming in deals the cards out of the gathered layout one after another (top first).
					const zt = clamp((zs - i * peelStep) / Math.max(0.01, 1 - (zsCount - 1) * peelStep))
					t = Math.max(t, this.reduced ? (zs >= 0.5 ? 1 : 0) : this.ease(zt))
				}
				const out = lerpPose(deck, spread, t, c.target)
				out.o *= dip
				this.gatheredBy.set(c.f.id, zoomed ? 1 - t : 0)
				// Side peek
				if (this.concept === 'peek' && i < this.peekCount(si)) {
					const q = this.peek[si].value(i, now)
					if (q > 0) {
						const pk = this.peekPose(P, i, c, pose(), this.peekSide[si] ?? 1)
						const lift = c.lift
						lift.set(this.liftId === c.f.id ? 1 : 0, now, 1, 200, 0, 'out', this.reduced)
						const l = lift.value(0, now)
						if (l > 0) {
							pk.ry *= 1 - l
							pk.s *= 1 + 0.16 * l
							pk.x += (this.peekSide[si] ?? 1) * (c.g.w * pk.s * 0.06 - 40 * P.s) * l
							pk.y -= 48 * P.s * l
							pk.shade *= 1 - l
						}
						lerpPose(c.target, pk, q * (1 - t), c.target)
					}
				}
				c.z = B + 800 - c.extra.rank * 20 + (this.liftId === c.f.id ? 400 : 0)
				c.live = true
				this.grandkidPoses(c, d, c.z, t)
			})
			this.chipFor(si, P, kids, e, d, B, zoomed ? outs : null)
		})

		this.applyFocus(now)
		this.applyLeaving()
		this.applyMorph(now)
		this.render()
	}

	/** A subagent's own subagents: a mini deck under it once it lies flat (fanned or focused). */
	private grandkidPoses(c: Card, d: DeckParams, z: number, flat: number) {
		const gk = this.grandkids(c)
		if (!gk.length) return
		const below: DeckParams = { ...d, depth: 3, tilt: 0 }
		const P = c.target
		gk.forEach((g, j) => {
			this.deckPose(P, j, g, below, g.target)
			g.target.o *= clamp(flat * 1.4 - 0.4) * P.o
			g.target.sh = 0.5
			g.z = z - 1 - j
			g.live = true
		})
	}

	private chipFor(si: number, P: Pose, kids: Card[], e: number, d: DeckParams, B: number, outs: Pose[] | null) {
		const chip = this.chips[si]
		const n = kids.filter((k) => !k.f.ghost).length
		const running = kids.filter((k) => k.f.status === 'busy').length
		const ph = P.bh * P.s
		const shown = Math.min(kids.length, d.depth)
		let deckBottom = P.y + ph + d.offset * shown
		if (outs && kids.length) {
			const ext = outExtent(this.outLayout(), outs.slice(0, kids.length), kids.map((k) => k.extra), { w: P.bw * P.s, h: ph })
			deckBottom = P.y + ext.y + ext.h
		}
		const y = lerp(deckBottom + 28, P.y + ph + 20, e)
		const focusedHere = this.focus.some((l) => l.si === si) || this.exiting.some((l) => l.si === si)
		let o = kids.length ? 1 : 0
		if (focusedHere) {
			const l = this.focus.find((x) => x.si === si) ?? this.exiting.find((x) => x.si === si)!
			o *= 1 - l.g.all(this.now)
		}
		const text = `${n}|${running}|${kids.length - n}`
		if (text !== chip.text) {
			chip.text = text
			chip.el.replaceChildren(el('span', 'n', `${n} subagent${n === 1 ? '' : 's'}`))
			if (running) chip.el.append(el('span', 'sep', '·'), el('span', 'run', `${running} running`))
			const chev = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
			chev.setAttribute('viewBox', '0 0 16 16')
			chev.classList.add('chev')
			chev.innerHTML = '<path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'
			chip.el.append(chev)
		}
		const open = this.fan[si].target > 0
		if (open !== chip.open) {
			chip.open = open
			chip.el.classList.toggle('open', open)
		}
		const sc = Math.max(1, 12 / (22 * this.cam.z * P.s)) * P.s
		this.write(chip.last, chip.el, {
			transform: `translate(${(P.x).toFixed(1)}px,${y.toFixed(1)}px) scale(${sc.toFixed(4)}) translateX(-50%)`,
			opacity: o,
			z: this.concept === 'peek' && this.peek[si].all(this.now) * (1 - this.fan[si].all(this.now)) > 0 ? 20000 + 1050 : B + 950,
		})
	}

	private applyFocus(now: number) {
		// Outer levels first: an inner level is laid out around where the outer one put its root.
		const levels = [...this.exiting, ...this.focus].sort((a, b) => (a.root.f.parent ? 1 : 0) - (b.root.f.parent ? 1 : 0))
		const scrimLevel = [0, 0]
		levels.forEach((level) => {
			const depth = level.root.f.parent ? 1 : 0
			const fp = this.focusParams()
			const fAll = level.g.all(now)
			if (fAll <= 0) return
			scrimLevel[depth] = Math.max(scrimLevel[depth], fAll)
			const family = new Set<Card>([level.root, ...level.kids])
			for (const k of level.kids) for (const g of this.grandkids(k)) family.add(g)
			const rootPose = level.root.target
			const lay = this.focusLayoutFor(level)
			const ps = rootPose.s
			const left = rootPose.x - (rootPose.bw * ps) / 2
			const cx = left + (lay.box.x + lay.box.w / 2) * ps
			const cy = rootPose.y + (lay.box.y + lay.box.h / 2) * ps
			// Everything else recedes (pushed back toward the focused family's centre) under a scrim.
			const k = lerp(1, fp.recede as number, fAll)
			for (const c of this.cards.values()) if (c.live && !family.has(c)) recede(c.target, cx, cy, k)
			const lift = 20000 * (depth + 1)
			level.kids.forEach((c, i) => {
				const q = level.g.value(i, now)
				const target = this.placedPose(rootPose, lay.at[i], c, pose())
				lerpPose(c.target, target, q, c.target)
				c.target.o = Math.max(c.target.o, q) * level.g.dip(now)
				c.z += lift
				c.live = true
				for (const g of this.grandkids(c)) {
					this.deckPose(c.target, this.grandkids(c).indexOf(g), g, { ...this.deckParams(), depth: 3, tilt: 0 }, g.target)
					g.target.o *= q
					g.z = c.z - 1 - this.grandkids(c).indexOf(g)
					g.live = true
				}
			})
			level.root.z += lift
			this.headingsFor(depth, lay.headings, rootPose, fAll, lift)
		})
		// An open side peek floats over its neighbours: a lighter scrim sets it apart.
		let peekScrim = 0
		this.world.sessions.forEach((s, si) => {
			const q = this.concept === 'peek' ? this.peek[si].all(now) * (1 - this.fan[si].all(now)) : 0
			if (q <= 0) return
			peekScrim = Math.max(peekScrim, q)
			const lift = 20000 - (100 + si * 1000 + 10000) + 100
			this.cards.get(s.id)!.z += lift
			for (const c of this.kidCache[si]) {
				c.z += lift
				for (const g of this.grandkids(c)) g.z += lift
			}
		})
		this.scrims.forEach((s, i) => {
			const a = Math.max(scrimLevel[i] * ((this.focusParams().scrim as number) ?? 0.8), i === 0 ? peekScrim * 0.5 : 0)
			s.style.opacity = a.toFixed(3)
			s.style.zIndex = String(20000 * (i + 1) - 10)
			s.style.visibility = a > 0.001 ? 'visible' : 'hidden'
			const z = this.cam.z
			s.style.width = `${this.viewW}px`
			s.style.height = `${this.viewH}px`
			s.style.transform = `translate(${(-this.cam.x / z).toFixed(1)}px,${(-this.cam.y / z).toFixed(1)}px) scale(${(1 / z).toFixed(5)})`
		})
		if (!levels.some((l) => l.g.all(now) > 0)) for (const h of this.headings) h.style.visibility = 'hidden'
	}

	private headingsFor(depth: number, list: { text: string; x: number; y: number; w: number }[], P: Pose, a: number, lift: number) {
		const base = depth * 3
		while (this.headings.length < base + 3) {
			const h = el('div', 'sa-heading')
			this.worldEl.append(h)
			this.headings.push(h)
		}
		for (let k = 0; k < 3; k++) {
			const h = this.headings[base + k]
			const item = list[k]
			if (!item) {
				h.style.visibility = 'hidden'
				continue
			}
			if (h.textContent !== item.text) h.textContent = item.text
			const ps = P.s
			const left = P.x - (P.bw * ps) / 2
			const sc = Math.max(1, 12 / (26 * this.cam.z * ps)) * ps
			h.style.visibility = 'visible'
			h.style.opacity = (a * a).toFixed(3)
			h.style.zIndex = String(lift + 50)
			// Kept readable when zoomed out: the text grows up from its baseline.
			const bottom = P.y + (item.y + 44) * ps
			h.style.transform = `translate(${(left + item.x * ps).toFixed(1)}px,${(bottom - 32 * sc).toFixed(1)}px) scale(${sc.toFixed(4)})`
		}
	}

	private applyLeaving() {
		for (const [id, { card, si }] of this.leaving) {
			if (card.live) {
				this.leaving.delete(id)
				continue
			}
			// Slides back in behind its parent and fades.
			const P = this.homePose(si)
			const t = card.target
			Object.assign(t, card.shown)
			t.x = P.x
			t.y = P.y + 20
			t.o = 0
			card.live = true
			card.z = 100 + si * 1000 + 700
		}
		if (!this.morph) this.leaving.clear()
	}

	private applyMorph(now: number) {
		const m = this.morph
		if (!m) {
			for (const c of this.cards.values()) if (c.live) Object.assign(c.shown, c.target)
			return
		}
		const t = clamp((now - m.start) / m.dur)
		const e = EASES['in-out'](t)
		for (const [id, c] of this.cards) {
			if (!c.live) continue
			let from = m.snap.get(id)
			if (!from) {
				// A newcomer: slides down out from behind its parent's top edge.
				from = copyPose(c.target)
				from.y -= 60 * c.target.s
				from.o = 0
				m.snap.set(id, from)
			}
			lerpPose(from, c.target, e, c.shown)
		}
		if (t >= 1) {
			this.morph = null
			this.leaving.clear()
		}
	}

	private stepCamera(now: number) {
		const a = this.anim
		if (!a) return
		const t = clamp((now - a.start) / a.dur)
		const e = EASES[a.ease](t)
		const { from, to } = a
		const z = from.z * Math.pow(to.z / from.z, e)
		const cx = this.viewW / 2
		const cy = this.viewH / 2
		const fx = (cx - from.x) / from.z
		const fy = (cy - from.y) / from.z
		const px = fx + ((cx - to.x) / to.z - fx) * e
		const py = fy + ((cy - to.y) / to.z - fy) * e
		Object.assign(this.cam, { z, x: cx - px * z, y: cy - py * z })
		if (t >= 1) {
			Object.assign(this.cam, to)
			this.anim = null
		}
	}

	// ---------- DOM ----------

	private write(last: Record<string, string | number>, e: HTMLElement, v: { transform?: string; opacity?: number; z?: number }) {
		if (v.transform !== undefined && last.transform !== v.transform) {
			e.style.transform = v.transform
			last.transform = v.transform
		}
		if (v.opacity !== undefined) {
			const o = Math.round(v.opacity * 1000) / 1000
			if (last.opacity !== o) {
				e.style.opacity = String(o)
				e.style.visibility = o <= 0.002 ? 'hidden' : 'visible'
				last.opacity = o
			}
		}
		if (v.z !== undefined && last.z !== v.z) {
			e.style.zIndex = String(v.z)
			last.z = v.z
		}
	}

	private lastRender = 0

	private render() {
		const dt = Math.min(100, Math.max(0, this.now - this.lastRender))
		this.lastRender = this.now
		const z = this.cam.z
		this.worldEl.style.transform = `translate(${this.cam.x.toFixed(2)}px,${this.cam.y.toFixed(2)}px) scale(${z.toFixed(5)})`
		const iz = (1 / z).toFixed(3)
		if (this.worldEl.style.getPropertyValue('--iz') !== iz) this.worldEl.style.setProperty('--iz', iz)
		for (const c of this.cards.values()) {
			const L = c.last
			if (!c.live) {
				if (L.opacity !== 0) this.write(L, c.el, { opacity: 0 })
				continue
			}
			const p = c.shown
			this.write(L, c.el, { transform: transformOf(p), opacity: p.o, z: c.z })
			if (p.o <= 0.002) continue
			const bw = Math.round(p.bw)
			const bh = Math.round(p.bh)
			if (L.bw !== bw) {
				c.el.style.width = `${bw}px`
				L.bw = bw
			}
			if (L.bh !== bh) {
				c.el.style.height = `${bh}px`
				L.bh = bh
			}
			const shade = Math.round(p.shade * 100) / 100
			if (L.shade !== shade) {
				c.el.style.filter = shade > 0 ? `brightness(${(1 - shade).toFixed(2)})` : ''
				L.shade = shade
			}
			const sh = Math.round(p.sh * 100) / 100
			if (L.sh !== sh) {
				c.el.style.setProperty('--sh', String(sh))
				L.sh = sh
			}
			const is = (1 / Math.max(0.05, p.s)).toFixed(2)
			if (L.is !== is) {
				c.el.style.setProperty('--is', is)
				L.is = is
			}
			// Status
			const f = c.f
			const status = f.status
			if (L.status !== status) {
				c.el.classList.toggle('busy', status === 'busy')
				c.el.classList.toggle('failed', status === 'failed')
				L.status = status
			}
			const want = status === 'busy' ? 1 : 0
			if (c.busy !== want) c.busy = want > c.busy ? Math.min(1, c.busy + dt / 300) : Math.max(0, c.busy - dt / 600)
			const flat = 1 - p.strip
			const ring = Math.round(c.busy * flat * (f.parent ? 0.7 : 1) * 100) / 100
			if (L.ring !== ring) {
				c.ring.style.opacity = String(ring)
				c.ring.style.visibility = ring > 0 ? 'visible' : 'hidden'
				L.ring = ring
			}
			if (c.flow) {
				const fl = Math.round(c.busy * 100) / 100
				if (L.flow !== fl) {
					c.flow.style.opacity = String(fl)
					c.flow.style.visibility = fl > 0 ? 'visible' : 'hidden'
					L.flow = fl
				}
			}
			const sel = this.selected === f.id
			if (L.sel !== String(sel)) {
				c.el.classList.toggle('selected', sel)
				L.sel = String(sel)
			}
			if (!f.parent) {
				// Parent titles stay ≥ 13px on screen and grow up out of the frame, as in the app.
				const ts = Math.max(1, 13 / (FRAME.title * z * p.s))
				const key = ts.toFixed(3) + '|' + bw
				if (L.title !== key) {
					c.title.style.transform = ts > 1 ? `scale(${ts.toFixed(4)})` : ''
					c.title.style.maxWidth = `${((bw - 80) / ts).toFixed(0)}px`
					L.title = key
				}
				continue
			}
			const time = status === 'busy' ? 'running' : `${status === 'failed' ? 'failed · ' : ''}${relTime(f.at, this.clock)}`
			const metaText = f.ghost ? 'starting' : status === 'busy' ? 'Running' : status === 'failed' ? `Failed · ${relTime(f.at, this.clock)}` : `Done · ${relTime(f.at, this.clock)}`
			if (L.meta !== metaText) {
				c.meta!.textContent = metaText
				L.meta = metaText
			}
			if (L.tw !== bw) {
				c.title.style.maxWidth = `${bw - 80 - 230}px`
				L.tw = bw
			}
			// Deck strip: drawn at page size whatever the card's scale.
			const so = Math.round(p.strip * 100) / 100
			if (L.so !== so) {
				c.strip!.style.opacity = String(so)
				c.strip!.style.visibility = so > 0 ? 'visible' : 'hidden'
				L.so = so
			}
			if (so > 0) {
				const off = this.concept === 'zoom' ? this.outParams().offset : this.deckParams().offset
				const sw = Math.round(p.bw * p.s)
				const key = `${sw}|${p.s.toFixed(3)}|${off.toFixed(1)}`
				if (L.strip !== key) {
					c.strip!.style.width = `${sw}px`
					c.strip!.style.height = `${off.toFixed(1)}px`
					c.strip!.style.fontSize = `${clamp(off * 0.5, 11, 72).toFixed(1)}px`
					c.strip!.style.paddingLeft = c.strip!.style.paddingRight = `${clamp(off * 0.6, 22, 80).toFixed(0)}px`
					c.strip!.style.transform = `scale(${(1 / p.s).toFixed(4)})`
					L.strip = key
				}
				if (L.time !== time) {
					c.stripTime!.textContent = f.ghost ? 'starting' : time
					L.time = time
				}
				const depth = this.concept === 'zoom' ? this.outParams().depth : this.deckParams().depth
				const more = !f.parent?.parent && Math.round(c.slot) === depth - 1 && c.hidden > 0 ? `+${c.hidden} more` : ''
				if (L.more !== more) {
					c.stripMore!.textContent = more
					L.more = more
				}
			}
			// Index tab (zoomed-out "tabs" layout): hangs below the sheet at page size, whatever the card's scale.
			const to = Math.round(p.tab * 100) / 100
			if (L.to !== to) {
				c.tab!.style.opacity = String(to)
				c.tab!.style.visibility = to > 0 ? 'visible' : 'hidden'
				L.to = to
			}
			if (to > 0) {
				const x = c.extra
				const key = `${x.tabX.toFixed(1)}|${x.tabW.toFixed(1)}|${x.tabH.toFixed(1)}|${p.s.toFixed(4)}`
				if (L.tabk !== key) {
					c.tab!.style.left = `${(x.tabX / p.s).toFixed(1)}px`
					c.tab!.style.width = `${x.tabW.toFixed(1)}px`
					c.tab!.style.height = `${x.tabH.toFixed(1)}px`
					c.tab!.style.fontSize = `${(x.tabH * 0.46).toFixed(1)}px`
					c.tab!.style.padding = `0 ${(x.tabH * 0.36).toFixed(1)}px`
					c.tab!.style.gap = `${(x.tabH * 0.2).toFixed(1)}px`
					c.tab!.style.transform = `scale(${(1 / p.s).toFixed(4)})`
					L.tabk = key
				}
				const more = x.plus > 0 ? `+${x.plus}` : ''
				if (L.tmore !== more) {
					c.tabMore!.textContent = more
					c.tab!.classList.toggle('has-more', !!more)
					L.tmore = more
				}
			}
			if (c.tabFlow) {
				const fl = Math.round(c.busy * to * 100) / 100
				if (L.tflow !== fl) {
					c.tabFlow.style.opacity = String(fl)
					c.tabFlow.style.visibility = fl > 0 ? 'visible' : 'hidden'
					L.tflow = fl
				}
			}
			// "+N" cover on the last docked card: fades as the dock deals out.
			const plusN = this.concept === 'zoom' && this.outLayout() === 'dock' ? c.extra.plus : 0
			const po = plusN > 0 ? Math.round(this.gathered(c) * 100) / 100 : 0
			if (L.po !== po || L.pn !== plusN) {
				c.plus!.textContent = plusN > 0 ? `+${plusN}` : ''
				c.plus!.style.opacity = String(po)
				c.plus!.style.visibility = po > 0 ? 'visible' : 'hidden'
				c.plus!.style.fontSize = `${Math.round(p.bh * 0.34)}px`
				L.po = po
				L.pn = plusN
			}
		}
	}

	/** How gathered (zoomed-out) a semantic-zoom child is this frame: 1 in its layout … 0 dealt. */
	private gatheredBy = new Map<string, number>()
	private gathered(c: Card) {
		return this.gatheredBy.get(c.f.id) ?? 0
	}

	/** For captures and tests: a card's box on screen (ignoring its tilt). */
	screenBox(id: string) {
		const c = this.cards.get(id)
		if (!c) return null
		const p = c.shown
		const z = this.cam.z
		return { x: (p.x - (p.bw * p.s) / 2) * z + this.cam.x, y: p.y * z + this.cam.y, w: p.bw * p.s * z, h: p.bh * p.s * z }
	}

	/** Busy: something is in motion (the loop can idle otherwise). */
	moving() {
		return !!this.anim || !!this.morph || this.fan.some((f) => f.busy(this.now)) || this.peek.some((p) => p.busy(this.now)) || this.focus.some((l) => l.g.busy(this.now)) || this.exiting.length > 0
	}
}

