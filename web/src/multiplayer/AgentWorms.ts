import type { Editor } from '../editor/Editor'
import type { Box, Vec } from '../editor/geometry'
import type { Attention } from './Attention'
import type { Conjure } from './Conjure'
import { Colony, type Baby } from './Babies'
import { Offscreen } from './Offscreen'
import { Slaps, type Pose } from './Slap'
import { Carry } from './Carry'
import './farAway.css'
import type { Peer, SubagentInfo } from './Presence'
import { LIFT, NATIVE, SIZE, TIP_REACH, drawPointer, edgeSpot, hits, openEye, palette, place, standOff, turn, wobble, type EyeState, type Palette, type Shape } from './Pointer'

/** Where it sits, relative to the top-right corner of what the agent is working on (page px). */
const PERCH: Vec = { x: 30, y: -10 }
/** put down too far from its frame, it stays where it landed this long (ms) before heading back beside it (see landing) */
const HOME_BEAT_MS = 600
/** ...having got within this many screen px of there; or it heads back after LANDING_MAX_MS whatever */
const LANDED_PX = 3
const LANDING_MAX_MS = 6000
/** Trips longer than this (screen px), or entirely off-screen, blink out and pop up there instead of gliding. */
const GLIDE_MAX = 1600
/** Goal moves smaller than this (screen px) are followed by sliding over rather than a glide. */
const NUDGE_PX = 10
/** a glide's duration: a base plus so much per screen px, within bounds */
const GLIDE_MS = 450
const GLIDE_PER_PX = 0.95
const GLIDE_MIN_MS = 520
const GLIDE_MAX_MS = 1700
/** following its path: a spring (rad/s) and its damping ratio, a little overshoot on arrival */
const FOLLOW_W = 17
const FOLLOW_Z = 0.72
/** turning to where it points: an angular spring */
const TURN_W = 12
const TURN_Z = 0.74
/** springing back to where it sits after a knock */
const SETTLE_W = 11
/** popping up, and blinking out */
const POP_MS = 420
const VANISH_MS = 300
/** waking up: a stretch */
const WAKE_MS = 900
/** the quick hop back when it's clicked */
const RECOIL_MS = 340
/** thinking hard: a fit of frustration now and then */
const FIT_MS = 1500
const FIT_GAP_MS = 5200
const CHAT_MS = 5000
/** how long the startled eye lasts after it's clicked */
const STARTLE_MS = 1100
/** extra screen px around the shape that still counts as clicking it */
const HIT_SLOP = 4
/** a press that moves further than this (screen px) drags it (its owner) or pans the canvas instead of clicking */
const DRAG_PX = 5
/** the pointer this close to its eye (screen px) gets stared at */
const STARE_PX = 170
/** below this zoom the creatures' name tags and attention badges hide; once hidden, they come back at FAR_ZOOM */
const FAR_ZOOM = 0.1
const FAR_SLACK = 0.002
/** zoomed right out, hovering within this (screen px) of a creature's pointer shows its name tag */
const PEEK_SLOP = 10
/** and it stays this long (ms) after the mouse leaves */
const PEEK_LINGER_MS = 200
/** records created longer ago than this were there already: they're just there rather than popping up */
const FRESH_MS = 15000
/** at rest it points at its frame (or what it's working on) when that's within this many screen px */
const POINT_AT_PX = 420
/** a highlight step: it goes this far (screen px) outside the target's edge to point in at it */
const VISIT_PX = 36
/**
 * rushing to an item just posted to its session (see ConjuredAgent.rush): a crouch before it sets
 * off, a quicker glide (a base plus so much per screen px, within bounds), its hop's height (screen
 * px), and the glee on arrival: wide-eyed, with a wiggle
 */
const RUSH_WAIT_MS = 170
const RUSH_MS = 260
const RUSH_PER_PX = 0.45
const RUSH_MIN_MS = 420
const RUSH_MAX_MS = 1000
const RUSH_HOP = 12
const RUSH_GLEE_MS = 900
const WIGGLE_MS = 750
type Mode = 'here' | 'pop' | 'vanish'

/** A glide: a cubic curve in page space, setting off the way it pointed and coming in to the goal. */
interface Trip {
	from: Vec
	c1: Vec
	c2: Vec
	to: Vec
	at: number
	dur: number
	/** a glide, or a rush to a new item (crouching RUSH_WAIT_MS before `at`) */
	kind: 'glide' | 'rush'
}

/**
 * How it's drawn this frame on top of where it sits and points: bobbing, trembling, hopping and
 * wiggling, breathing, popping, its glow. Its off-screen marker (see Offscreen) draws with the same.
 */
export interface Live {
	/** screen px from where it sits */
	dx: number
	dy: number
	/** radians from where it means to point at rest (wiggles, tilts, trembles) */
	turn: number
	scale: number
	glow: number
}

export interface Worm {
	id: number
	color: string
	palette: Palette
	/** the point on the page where it is (its centre is LIFT screen px above) */
	root: Vec
	/** how fast root moves, page units/s */
	vel: Vec
	goal: Vec | null
	/** the goal it last set off for */
	dest: Vec | null
	trip: Trip | null
	/** a highlight step's spot it has gone to (page), while its walkthrough shows it, and the point there it points at */
	visit: Vec | null
	pointAt: Vec | null
	/** the box the agent is working on, for pointing at and glancing at */
	focus: Box | null
	/** which way its tip points (radians, screen), and how fast that turns */
	heading: number
	spin: number
	/** where it points this frame when nothing else is going on */
	rest: number
	/** knocked out of place (screen px), and how fast */
	off: Vec
	offV: Vec
	mode: Mode
	modeAt: number
	/** blinking out: where it pops up next (null: gone for good) */
	warpTo: Vec | null
	gone: boolean
	leaving: boolean
	seed: number
	eye: EyeState
	nextBlink: number
	blinkStart: number
	/** blinking twice in a row this time */
	doubleBlink: boolean
	glance: Vec
	nextGlance: number
	dart: Vec
	nextDart: number
	/** 0..1 squashed (slapped), easing back */
	squash: number
	wakeAt: number
	recoilAt: number
	/** thinking hard (busy, not talking), and its fits of frustration */
	fretting: boolean
	fit: number
	nextFit: number
	/** the startle (from conjure.startled) the body last reacted to */
	startleSeen: number
	/** as last drawn */
	shape: Shape | null
	live: Live
	/** where the labels hang (screen, from root), and its top and middle from there, eased */
	anchor: Vec | null
	headAt: Vec
	middleAt: Vec
	el: HTMLDivElement
	label: HTMLSpanElement
	name: HTMLSpanElement
	message: HTMLSpanElement | null
	chat: string | null
	chatAt: number
	nameText: string
	/** its reply is streaming in (it shows in its prompt box), and 0..1 how much it's talking, eased */
	streaming: boolean
	talk: number
	/** a conjured creature (an OpenCode session people can prompt): clickable on edit links */
	conjured: boolean
	/** nobody runs it right now (no owner tab open): drawn dimmed, eye shut, asleep */
	asleep: boolean
	/** its session is working on a prompt, and 0..1 eased */
	thinking: boolean
	think: number
	/** when it was last startled (clicked) */
	startledAt: number
	/** its prompt box is open */
	listening: boolean
	/** the finished reply this viewer has seen (in its prompt box, or there already when it arrived); undefined until it's first synced */
	replySeen: string | null | undefined
	/** the dot on its name tag for a finished reply not seen yet */
	unread: boolean
	/** the rush (ConjuredAgent.rush's time) it has gone on; one pending, to set off on with its next glide; and when it last got there */
	rushSeen: number
	rushNext: boolean
	rushArriveAt: number
	/** its busy subagents, as babies drifting about near it */
	colony: Colony
	sessionId: string | null
	/** when its record was created, to tell a new one of the same session from the last */
	conjuredAt: number
	/** how many attention actions its session has queued: while any are, it calls (badge, ring, wiggling), awake */
	calls: number
	/** the count badge, while it calls */
	badge: HTMLButtonElement | null
}

/** A pointer that went down on a creature: a click unless it moves, then a drag (its owner) or a pan. */
interface Press {
	pointerId: number
	worm: Worm
	start: Vec
	/** where it was last, while it pans */
	last: Vec
	panning: boolean
	dragging: boolean
}

/**
 * Sessions' creatures (real OpenCode sessions, see Conjure): eye pointers (see Pointer.ts) that sit
 * where the canvas server put them and glide about when it (or their agent) moves them, the tip
 * always facing the way they go, then turn to point at what they're pointing at. People can't move
 * them: clicking one opens its box, and dragging from one pans the canvas. Their busy subagents are babies drifting about near them (see Babies). They're
 * drawn on one 2D canvas in screen space; the name label, bubbles and badges are DOM, like human
 * cursor labels.
 *
 * A creature whose session queued something for attention (see Attention) calls for it where it
 * sits, even asleep: wide-eyed, wiggling and bobbing, with a count badge and a soft pulsing ring.
 * Clicking it (or the badge) opens its walkthrough, and for each highlight step it glides over to
 * point at the target.
 */
export class AgentWorms {
	private canvas: HTMLCanvasElement
	private ctx: CanvasRenderingContext2D
	/** where sleeping creatures are drawn before they're dimmed onto the canvas */
	private scratch: HTMLCanvasElement | null = null
	private labels: HTMLDivElement
	private worms = new Map<number, Worm>()
	private drewLastFrame = false
	private reducedMotion: MediaQueryList
	/** the canvas container, whose clicks on creatures we take before the editor sees them */
	private container: HTMLElement | null
	/** pointers that went down on a creature: their pointerup isn't the editor's either */
	private swallowed = new Set<number>()
	private press: Press | null = null
	private disposers: (() => void)[] = []
	/** the pointer over the canvas (screen space), for staring at and babies' tooltips */
	private pointer: Vec | null = null
	/** what the mouse was last over, so a peeked creature's tag or badge keeps it peeked */
	private pointerOver: Element | null = null
	/** zoomed right out: the creature whose tag shows while hovered, and when the mouse left it */
	private peeked: Worm | null = null
	private peekLeftAt = 0
	private tip: HTMLDivElement
	private tipFor: Baby | null = null
	/** when this page started showing creatures (wall clock), to tell sessions conjured since from ones already here */
	private bornAt = Date.now()
	/** the slap tool's blows (see Slap) */
	private slaps: Slaps
	/** creatures their owner is dragging (see Carry) */
	private carry: Carry
	/** markers at the edges of the view for creatures out of it */
	private offscreen: Offscreen
	/** spots creatures are sent to point at for a moment (see Creatures in Editor.ts) */
	private reaching = new Map<string, Vec>()

	constructor(
		parent: HTMLElement,
		private editor: Editor,
		private conjure: Conjure | null = null,
		private attention: Attention | null = null,
	) {
		this.canvas = document.createElement('canvas')
		this.canvas.className = 'agent-worms'
		this.ctx = this.canvas.getContext('2d')!
		this.labels = document.createElement('div')
		this.labels.className = 'agent-worm-labels'
		parent.append(this.canvas, this.labels)
		this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
		this.container = parent.closest<HTMLElement>('.canvas-container')
		this.tip = document.createElement('div')
		this.tip.className = 'agent-worm-tiny-tip'
		this.tip.hidden = true
		this.slaps = new Slaps(editor, conjure, this.reducedMotion)
		this.carry = new Carry(editor, this.reducedMotion)
		this.offscreen = new Offscreen(parent, editor, conjure, this.reducedMotion, (worm) => this.startle(worm))
		this.labels.appendChild(this.tip)
		// for poking at from the console, like window.editor
		;(window as any).creatures = this
		editor.creatures = { at: (sessionId) => this.creatureAt(sessionId), reaching: this.reaching }
		const track = (e: PointerEvent) => {
			this.pointer = e.pointerType !== 'touch' && this.overCanvas(e) ? this.local(e) : null
			this.pointerOver = e.target as Element | null
		}
		const untrack = (e: PointerEvent) => {
			if (!e.relatedTarget) this.pointer = this.pointerOver = null
		}
		window.addEventListener('pointermove', track, { capture: true, passive: true })
		document.addEventListener('pointerout', untrack)
		this.disposers.push(() => {
			window.removeEventListener('pointermove', track, true)
			document.removeEventListener('pointerout', untrack)
		})
		if (conjure && this.container) {
			// Capturing on window runs before the editor's own listeners on the container, so a click
			// on a creature never reaches it; everywhere else passes straight through. (View links only
			// click creatures calling for attention.)
			const listen = (type: 'pointerdown' | 'pointerup' | 'pointercancel' | 'pointermove', fn: (e: PointerEvent) => void) => {
				window.addEventListener(type, fn, true)
				this.disposers.push(() => window.removeEventListener(type, fn, true))
			}
			listen('pointerdown', this.onPointerDown)
			listen('pointerup', this.onPointerUp)
			listen('pointercancel', this.onPointerUp)
			listen('pointermove', this.onPointerMove)
		}
	}

	/** Called once per frame with the agent peers. */
	update(now: number, elapsed: number, agents: Peer[]) {
		const seen = new Set<number>()
		for (const peer of agents) {
			seen.add(peer.clientId)
			const target = this.targetFor(peer)
			let worm = this.worms.get(peer.clientId)
			// Hidden until it has somewhere to go.
			if (!worm && !target) continue
			const landing = target ? this.landing(peer, worm, now) : null
			if (!worm) {
				worm = this.spawn(peer, landing ?? target!.point, now)
				worm.rushSeen = target?.rush?.at ?? 0
				this.arrive(worm, peer, now)
				this.worms.set(peer.clientId, worm)
			}
			if (worm.leaving) this.revive(worm, now)
			this.syncCalls(worm)
			if (target) {
				// (landing where it was put, it's no longer held there till its new position comes back: that's elsewhere)
				if (landing) this.carry.unpin(worm.sessionId!)
				const pinned = landing ?? this.carry.pinned(worm, peer.cursor, now)
				const rush = !pinned && target.rush && target.rush.at !== worm.rushSeen ? target.rush : null
				// (A rush to a new item waits while its walkthrough is open or it's held. With its box open
				// it just glides over calmly, staying with the box, which follows where it is.)
				if (!rush || this.mayRush(worm)) {
					if (rush) {
						worm.rushSeen = rush.at
						// (already there, as when its item is replaced in place: nothing to rush to)
						const d = worm.dest
						worm.rushNext = !worm.listening && !(d && Math.hypot(target.point.x - d.x, target.point.y - d.y) <= 1)
					}
					worm.goal = pinned ?? target.point
					worm.focus = target.box
				}
			} else {
				worm.focus = null
			}
			this.syncVisit(worm)
			this.syncLabel(worm, peer, now)
			if (worm.conjured) worm.colony.sync(peer.subagents ?? [], peer.user.color, now, this.reducedMotion.matches)
		}
		for (const worm of this.worms.values()) {
			if (!seen.has(worm.id) && !worm.leaving) this.leave(worm, now)
		}

		// Zoomed right out, the name tags and badges go (a little either side of FAR_ZOOM, so they don't flicker there).
		const zoom = this.editor.camera.peek().z
		const far = this.labels.classList.contains('far')
		if (far ? zoom >= FAR_ZOOM : zoom < FAR_ZOOM - FAR_SLACK) this.labels.classList.toggle('far', !far)
		this.resize()
		const ctx = this.ctx
		const dpr = window.devicePixelRatio || 1
		if (this.worms.size === 0) {
			if (this.drewLastFrame) ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
			this.drewLastFrame = false
			this.offscreen.frame(now, elapsed, [])
			return
		}
		ctx.setTransform(1, 0, 0, 1, 0, 0)
		ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
		this.drewLastFrame = true

		for (const worm of [...this.worms.values()]) {
			this.step(worm, now, elapsed)
			if (worm.gone) {
				worm.el.remove()
				this.worms.delete(worm.id)
				if (this.press?.worm === worm) this.press = null
				continue
			}
			this.draw(worm, now, elapsed)
		}
		this.peek(now)
		this.slaps.frame(ctx, now, this.worms.values())
		this.showTip()
		this.offscreen.frame(now, elapsed, this.worms.values())
	}

	destroy() {
		for (const d of this.disposers.splice(0)) d()
		if (this.editor.creatures?.reaching === this.reaching) this.editor.creatures = null
		this.slaps.destroy()
		this.carry.clear()
		this.offscreen.destroy()
		this.container?.classList.remove('conjure-hover', 'conjure-panning', 'conjure-dragging')
		this.canvas.remove()
		this.labels.remove()
		this.worms.clear()
	}

	/** Zoomed right out, the creature under the mouse shows its name tag (and badge) until a moment after it leaves. */
	private peek(now: number) {
		let over: Worm | null = null
		if (this.labels.classList.contains('far')) {
			const prev = this.peeked
			if (prev && !prev.gone && this.pointerOver && prev.el.contains(this.pointerOver)) over = prev
			const p = this.pointer
			if (!over && p) {
				for (const worm of [...this.worms.values()].reverse()) {
					if (worm.leaving || !worm.shape || worm.mode === 'vanish') continue
					if (hits(worm.shape, p, PEEK_SLOP)) {
						over = worm
						break
					}
				}
			}
		}
		const prev = this.peeked
		if (over) this.peekLeftAt = now
		else if (prev && !prev.gone && this.labels.classList.contains('far') && now - this.peekLeftAt < PEEK_LINGER_MS) over = prev
		if (over === prev) return
		prev?.el.classList.remove('peek')
		over?.el.classList.add('peek')
		this.peeked = over
	}

	// ---------- clicking and dragging creatures (only their owner moves them: on anyone else's a drag pans) ----------

	/** The topmost creature under a point in client coordinates. */
	private hitTest(clientX: number, clientY: number): Worm | null {
		const rect = this.canvas.getBoundingClientRect()
		const p = { x: clientX - rect.left, y: clientY - rect.top }
		const worms = [...this.worms.values()].reverse()
		const now = performance.now()
		for (const worm of worms) {
			if (!worm.conjured || worm.leaving || !worm.shape || worm.mode === 'vanish' || (worm.mode === 'pop' && now - worm.modeAt < POP_MS * 0.5)) continue
			if (!this.conjure?.canPrompt && !worm.calls) continue
			if (hits(worm.shape, p, HIT_SLOP)) return worm
		}
		return null
	}

	/** Pointer events over the canvas itself (not over a bubble, a prompt box or other UI). */
	private overCanvas(e: PointerEvent) {
		const target = e.target as Element | null
		return !!target && !!this.container?.contains(target) && !target.closest('.agent-worm-attention, .offscreen-marker, .pt, .note')
	}

	/** Client coordinates to this layer's screen space (the editor's). */
	private local(e: PointerEvent): Vec {
		const rect = this.canvas.getBoundingClientRect()
		return { x: e.clientX - rect.left, y: e.clientY - rect.top }
	}

	private onPointerDown = (e: PointerEvent) => {
		if (e.pointerType === 'mouse' && e.button !== 0) return
		if (this.press || !this.overCanvas(e)) return
		const worm = this.hitTest(e.clientX, e.clientY)
		const peer = worm && this.conjure?.peer(worm.id)
		if (!worm || !peer) return
		e.stopPropagation()
		e.preventDefault()
		this.swallowed.add(e.pointerId)
		const at = this.local(e)
		if (this.slaps.active) return this.slaps.hit(worm, at)
		this.press = { pointerId: e.pointerId, worm, start: at, last: at, panning: false, dragging: false }
		try {
			;(e.target as Element).setPointerCapture?.(e.pointerId)
		} catch {}
	}

	private onPointerUp = (e: PointerEvent) => {
		if (!this.swallowed.delete(e.pointerId)) return
		e.stopPropagation()
		const press = this.press
		if (press?.pointerId !== e.pointerId) return
		this.press = null
		this.container?.classList.remove('conjure-panning', 'conjure-dragging')
		const worm = press.worm
		const peer = this.conjure?.peer(worm.id)
		if (press.dragging) return this.drop(worm, peer?.user.sessionId ?? null, e.type === 'pointerup')
		if (press.panning || !peer || e.type !== 'pointerup') return
		// Calling for attention: a click opens its walkthrough, and another one (or a click while it
		// isn't calling) the prompt box.
		const sessionId = peer.user.sessionId
		if (sessionId && worm.calls && !this.attention?.isOpen(sessionId)) {
			this.startle(worm)
			return this.attention!.open(sessionId)
		}
		if (this.conjure!.canPrompt) {
			this.attention?.close()
			this.conjure!.open(peer)
		}
	}

	private onPointerMove = (e: PointerEvent) => {
		const press = this.press
		if (press?.pointerId === e.pointerId) {
			e.stopPropagation()
			const at = this.local(e)
			if (!press.panning && !press.dragging) {
				if (Math.hypot(at.x - press.start.x, at.y - press.start.y) < DRAG_PX) return
				this.container?.classList.remove('conjure-hover')
				// Its owner (or anyone, for one nobody owns) picks it up; on anyone else's the canvas pans.
				const sessionId = press.worm.sessionId
				if (sessionId && this.conjure?.canMove(sessionId) && press.worm.mode !== 'vanish') {
					press.dragging = true
					this.conjure.landings.delete(sessionId)
					if (this.conjure.prompting.peek()?.sessionId === sessionId) this.conjure.close()
					this.container?.classList.add('conjure-dragging')
					this.carry.pickUp(press.worm, press.start, press.worm.shape?.centre ?? this.centreOf(press.worm))
				} else {
					press.panning = true
					this.container?.classList.add('conjure-panning')
				}
			}
			if (press.dragging) return this.carry.move(press.worm, at)
			// Pressed on someone else's creature and dragged: the canvas pans, as from anywhere empty.
			const cam = this.editor.camera.peek()
			this.editor.stopCameraMotion()
			this.editor.setCamera({ x: cam.x + (at.x - press.last.x) / cam.z, y: cam.y + (at.y - press.last.y) / cam.z, z: cam.z })
			press.last = at
			return
		}
		if (this.swallowed.has(e.pointerId)) return e.stopPropagation()
		const over = e.buttons === 0 && this.overCanvas(e) ? this.hitTest(e.clientX, e.clientY) : null
		this.slaps.hovered = this.slaps.active ? over : null
		this.container?.classList.toggle('conjure-hover', !!over && !this.slaps.active)
	}

	/** Let go of a dragged creature: put down there for everyone, or back where it was if that's refused. */
	private drop(worm: Worm, sessionId: string | null, ok: boolean) {
		const at = this.carry.letGo(worm, ok && !!sessionId)
		if (!at || !ok || !sessionId) return
		this.conjure!.move(sessionId, at).catch((err: Error) => {
			this.carry.unpin(sessionId)
			this.editor.deletions.notify(`Couldn't move it: ${err.message}`)
		})
	}

	// ---------- state ----------

	/**
	 * A cursor if the agent sends one, else a perch just outside the first selected thing. Where it
	 * rushed to a new item, the spot the server put it at, pointing at it. All page space: zooming
	 * never moves where it rests.
	 */
	private targetFor(peer: Peer): { point: Vec; box: Box | null; rush?: { itemId: string; at: number } } | null {
		if (peer.cursor) return this.rushed(peer.cursor, peer.user.sessionId) ?? { point: { ...peer.cursor }, box: null }
		for (const key of peer.selection ?? []) {
			const box = this.editor.getSelectionBounds(key)
			if (!box) continue
			return { point: { x: box.x + box.w + PERCH.x, y: box.y + PERCH.y }, box }
		}
		return null
	}

	/**
	 * Its record rushed to an item (see ConjuredAgent.rush) and it's still there: right where the
	 * record says (rushSpot, worked out once by the server), facing the item.
	 */
	private rushed(cursor: Vec, sessionId: string | undefined) {
		const r = sessionId ? this.conjure?.record(sessionId) : undefined
		if (!r?.rush || Math.abs(r.x - cursor.x) > 1 || Math.abs(r.y - cursor.y) > 1) return null
		const box = this.editor.getSelectionBounds(r.rush.itemId)
		if (!box) return null
		const { at, out } = edgeSpot({ x: r.x, y: r.y - LIFT }, box)
		// (Unless the item moved without it, as when another one is posted before it: then it stays put.)
		const there = standOff(at, out, 1)
		if (Math.abs(there.x - r.x) > 2 || Math.abs(there.y - r.y) > 2) return null
		return { point: { x: r.x, y: r.y }, box, rush: r.rush }
	}

	/**
	 * Put down (or summoned) too far from its frame, so the server put it back beside it: where it
	 * was put, until it has been there a beat; then it makes its way back to its record's spot.
	 */
	private landing(peer: Peer, worm: Worm | undefined, now: number): Vec | null {
		const sid = peer.user.sessionId
		const l = sid ? this.conjure?.landings.get(sid) : undefined
		if (!l) return null
		const z = this.editor.camera.peek().z
		if (!l.arrived && worm && !this.carry.holds(worm) && Math.hypot(worm.root.x - l.at.x, worm.root.y - l.at.y) * z < LANDED_PX) l.arrived = now
		if (now - l.since > LANDING_MAX_MS || (l.arrived && now - l.arrived > HOME_BEAT_MS)) {
			this.conjure!.landings.delete(sid!)
			return null
		}
		return l.at
	}

	/** Whether it may set off on a rush now: not while its walkthrough is open, or while it's held. */
	private mayRush(worm: Worm) {
		const sid = worm.sessionId
		return !this.carry.holds(worm) && this.press?.worm !== worm && !(sid && this.attention?.isOpen(sid))
	}

	private spawn(peer: Peer, at: Vec, now: number): Worm {
		const el = document.createElement('div')
		el.className = 'agent-worm'
		el.innerHTML =
			'<span class="peer-cursor-label agent-worm-label"><span class="peer-cursor-name"></span></span>' +
			'<div class="agent-worm-zzz" aria-hidden="true"><i>z</i><i>z</i><i>z</i></div>'
		const label = el.querySelector<HTMLSpanElement>('.agent-worm-label')!
		const name = el.querySelector<HTMLSpanElement>('.peer-cursor-name')!
		const conjured = !!peer.user.conjured
		el.classList.toggle('conjured', conjured)
		this.labels.appendChild(el)
		const seed = Math.random() * 1000
		const eye = openEye()
		eye.lid = peer.user.asleep ? 1 : 0
		const worm: Worm = {
			id: peer.clientId,
			color: '',
			palette: palette('#22d3ee'),
			root: { ...at },
			vel: { x: 0, y: 0 },
			goal: { ...at },
			dest: { ...at },
			trip: null,
			visit: null,
			pointAt: null,
			focus: null,
			heading: NATIVE,
			spin: 0,
			rest: NATIVE,
			off: { x: 0, y: 0 },
			offV: { x: 0, y: 0 },
			mode: 'here',
			modeAt: now,
			warpTo: null,
			gone: false,
			leaving: false,
			seed,
			eye,
			nextBlink: now + 1500 + Math.random() * 3000,
			blinkStart: -1e9,
			doubleBlink: false,
			glance: { x: -0.4, y: -0.5 },
			nextGlance: now + 1000,
			dart: { x: 0, y: 0 },
			nextDart: 0,
			squash: 0,
			wakeAt: -1e9,
			recoilAt: -1e9,
			fretting: false,
			fit: -1e9,
			nextFit: 0,
			startleSeen: -1e9,
			shape: null,
			live: { dx: 0, dy: 0, turn: 0, scale: 1, glow: 0 },
			anchor: null,
			headAt: { x: 0, y: -SIZE },
			middleAt: { x: 0, y: -LIFT },
			el,
			label,
			name,
			message: null,
			chat: null,
			chatAt: 0,
			nameText: '',
			streaming: false,
			talk: 0,
			conjured,
			asleep: false,
			thinking: false,
			think: 0,
			startledAt: -1e9,
			listening: false,
			replySeen: undefined,
			unread: false,
			rushSeen: 0,
			rushNext: false,
			rushArriveAt: -1e9,
			colony: new Colony(),
			calls: 0,
			badge: null,
			sessionId: peer.user.sessionId ?? null,
			conjuredAt: 0,
		}
		return worm
	}

	/**
	 * A creature's arrival: the same session just woke up or nodded off (a new presence, so a new
	 * creature), carrying on where the old one was; otherwise it pops up (unless it was already here
	 * asleep when the page opened: then it's just there, eye shut).
	 */
	private arrive(worm: Worm, peer: Peer, now: number) {
		const rec = worm.sessionId ? this.conjure?.record(worm.sessionId) : undefined
		worm.conjuredAt = rec?.createdAt ?? 0
		// (Banished and conjured again, it's a new one.)
		const prev = worm.sessionId
			? [...this.worms.values()].find((w) => w.sessionId === worm.sessionId && w !== worm && w.conjuredAt === worm.conjuredAt)
			: undefined
		if (prev) {
			// Leaving, it was blinking out: back as it was.
			if (prev.leaving && prev.mode === 'vanish' && !prev.warpTo) prev.mode = 'here'
			for (const key of ['root', 'vel', 'dest', 'trip', 'heading', 'spin', 'off', 'offV', 'mode', 'modeAt', 'warpTo', 'seed', 'eye', 'glance', 'squash', 'wakeAt', 'recoilAt', 'anchor', 'headAt', 'middleAt', 'shape', 'colony', 'rushSeen', 'rushNext', 'rushArriveAt'] as const) {
				;(worm as unknown as Record<string, unknown>)[key] = prev[key]
			}
			worm.startleSeen = prev.startleSeen
			if (prev.asleep && !peer.user.asleep && worm.mode !== 'pop') worm.wakeAt = now
			prev.el.remove()
			this.worms.delete(prev.id)
			if (this.press?.worm === prev) this.press.worm = worm
			this.carry.replace(prev, worm)
			return
		}
		if (this.reducedMotion.matches) return
		const age = rec ? Date.now() - rec.createdAt : Infinity
		if (peer.user.asleep && (age > FRESH_MS || (rec && rec.createdAt < this.bornAt - 2000))) return
		this.pop(worm, now)
	}

	/** Pops up where it is. */
	private pop(worm: Worm, now: number) {
		worm.mode = 'pop'
		worm.modeAt = now
		worm.warpTo = null
	}

	/** Blinks out, to pop up at `to` (or gone, leaving). */
	private vanish(worm: Worm, now: number, to: Vec | null) {
		worm.mode = 'vanish'
		worm.modeAt = now
		worm.trip = null
		worm.warpTo = to
	}

	/** Ends a pop or a vanish where it is. */
	private settle(worm: Worm) {
		worm.mode = 'here'
		worm.warpTo = null
	}

	private leave(worm: Worm, now: number) {
		worm.leaving = true
		worm.el.classList.add('leaving')
		if (this.press?.worm === worm) {
			this.press = null
			this.container?.classList.remove('conjure-panning', 'conjure-dragging')
		}
		this.carry.letGo(worm, false)
		if (this.reducedMotion.matches) worm.gone = true
		else this.vanish(worm, now, null)
	}

	private revive(worm: Worm, now: number) {
		worm.leaving = false
		worm.gone = false
		worm.el.classList.remove('leaving')
		if (worm.mode === 'vanish' && !worm.warpTo) this.pop(worm, now)
	}

	/**
	 * Its walkthrough showing a highlight step: it goes to just outside the target's edge nearest
	 * where it sits, to point in at it. (Here only: where it is doesn't change.)
	 */
	private syncVisit(worm: Worm) {
		const a = this.attention
		const sid = worm.sessionId
		let box: Box | undefined
		if (a && sid && a.isOpen(sid)) {
			const walk = a.walk.peek()
			const step = walk?.steps[walk.index]
			if (step?.kind === 'highlight' && step.target) box = a.targetBox(step.target)
		}
		const spot = sid ? this.reaching.get(sid) : undefined
		if (!box && spot) box = { x: spot.x, y: spot.y, w: 0, h: 0 }
		if (!box) {
			worm.visit = null
			worm.pointAt = null
			return
		}
		// (page space, as at 100% zoom, so zooming never moves it)
		const home = worm.goal ?? worm.root
		const from = { x: home.x, y: home.y - LIFT }
		const { at, out } = edgeNear(from, box)
		const reach = VISIT_PX + TIP_REACH * SIZE
		worm.pointAt = at
		worm.visit = { x: at.x + out.x * reach, y: at.y + out.y * reach + LIFT }
	}

	private creatureAt(sessionId: string): Vec | null {
		for (const w of this.worms.values()) {
			if (w.sessionId === sessionId && !w.gone && !w.leaving) return { x: w.root.x, y: w.root.y - LIFT / this.editor.camera.peek().z }
		}
		return null
	}

	private syncLabel(worm: Worm, peer: Peer, now: number) {
		if (worm.color !== peer.user.color) {
			worm.color = peer.user.color
			worm.palette = palette(worm.color)
			worm.label.style.background = worm.color
			worm.el.style.setProperty('--agent-color', worm.color)
		}
		if (worm.nameText !== peer.user.name) {
			worm.nameText = peer.user.name
			worm.name.textContent = worm.nameText
		}
		const speaking = !!peer.speaking && !!peer.chat
		worm.streaming = speaking && !peer.chatSent
		if (worm.conjured) {
			// Calling for attention wakes it up (for the look of it: nobody runs it any more than before).
			const asleep = !!peer.user.asleep && !worm.calls
			if (worm.asleep !== asleep) {
				worm.asleep = asleep
				worm.el.classList.toggle('asleep', worm.asleep)
				worm.label.title = worm.asleep ? 'Asleep: its owner\'s tab isn\'t open' : ''
			}
			worm.thinking = !!peer.thinking
			worm.startledAt = this.conjure?.startled.get(worm.id) ?? worm.startledAt
			worm.listening = this.conjure?.prompting.peek()?.clientId === worm.id
			// Its replies show in its prompt box, not on the canvas: a finished one this viewer hasn't
			// seen there gets a dot on its name tag until the box is opened.
			const reply = speaking && peer.chatSent && !worm.thinking ? peer.chat : null
			if (worm.listening || worm.replySeen === undefined) worm.replySeen = reply
			const unread = !!reply && reply !== worm.replySeen
			if (worm.unread !== unread) {
				worm.unread = unread
				worm.label.classList.toggle('unread', unread)
			}
		}
		const chat = (!speaking && peer.chat) || null
		if (worm.chat !== chat) {
			worm.chat = chat
			worm.chatAt = now
			// A fresh element per message so its fade animation starts over.
			worm.message?.remove()
			worm.message = null
			if (chat) {
				worm.message = document.createElement('span')
				worm.message.className = 'peer-cursor-message'
				worm.message.textContent = chat
				worm.label.appendChild(worm.message)
			}
		}
		const sent = !!peer.chatSent
		const showing = !!chat && (!sent || now - worm.chatAt < CHAT_MS)
		worm.label.classList.toggle('chatting', showing)
		worm.message?.classList.toggle('sent', sent)
	}

	/** The attention badge (with its count) and calling state, from its session's queue. */
	private syncCalls(worm: Worm) {
		const sessionId = worm.sessionId
		const calls = sessionId && worm.conjured ? (this.attention?.count(sessionId) ?? 0) : 0
		const open = !!sessionId && !!this.attention?.isOpen(sessionId)
		worm.el.classList.toggle('attending', open)
		if (calls === worm.calls) return
		worm.calls = calls
		worm.el.classList.toggle('calling', calls > 0)
		if (!calls) {
			worm.badge?.remove()
			worm.badge = null
			return
		}
		if (!worm.badge) {
			const badge = document.createElement('button')
			badge.className = 'agent-worm-attention'
			badge.addEventListener('pointerdown', (e) => e.stopPropagation())
			badge.addEventListener('click', (e) => {
				e.stopPropagation()
				if (worm.sessionId) this.attention?.open(worm.sessionId)
			})
			const ring = document.createElement('span')
			ring.className = 'agent-worm-call-ring'
			ring.setAttribute('aria-hidden', 'true')
			worm.el.append(ring, badge)
			worm.badge = badge
		}
		worm.badge.textContent = calls > 99 ? '99+' : String(calls)
		worm.badge.title = `${calls} thing${calls === 1 ? '' : 's'} for you to look at: click to go through ${calls === 1 ? 'it' : 'them'}`
	}

	/** A jolt, as when it's clicked. */
	private startle(worm: Worm) {
		const now = performance.now()
		worm.startledAt = now
		this.conjure?.startled.set(worm.id, now)
	}

	// ---------- moving ----------

	/** Its centre on screen where it sits (before knocks, bobbing and dangling). */
	private centreOf(worm: Worm): Vec {
		const g = this.editor.pageToScreen(worm.root)
		return { x: g.x, y: g.y - LIFT }
	}

	private step(worm: Worm, now: number, elapsed: number) {
		const still = this.reducedMotion.matches
		const z = this.editor.camera.peek().z
		const dt = Math.min(0.05, elapsed / 1000)
		const ease = (ms: number) => (still ? 1 : 1 - Math.exp(-elapsed / ms))

		worm.talk += ((worm.streaming ? 1 : 0) - worm.talk) * ease(120)
		// Busy until its session is idle, whether or not it's saying something meanwhile.
		worm.think += ((worm.thinking ? 1 : 0) - worm.think) * ease(200)

		// Clicked (here or elsewhere, see Conjure.startled): a quick hop back.
		if (worm.startledAt !== worm.startleSeen) {
			worm.startleSeen = worm.startledAt
			if (now - worm.startledAt < 300 && worm.mode === 'here' && !still) this.recoil(worm, now)
		}

		worm.rest = this.restHeading(worm, this.centreOf(worm))
		const carried = this.carry.holds(worm)
		const held = carried || this.slaps.holds(worm, now)
		if (!held) {
			this.locomote(worm, now, dt, z)
			this.fret(worm, now)
		} else {
			worm.vel = { x: 0, y: 0 }
		}
		if (worm.mode === 'pop' || worm.mode === 'vanish') this.popping(worm, now)
		this.slaps.step(worm, now)
		const pose = this.slaps.pose(worm, now, z)
		if (carried) this.carry.dangle(worm, dt)
		else {
			this.knock(worm, pose, dt)
			this.steer(worm, pose, now, dt, z)
		}
		worm.squash *= 1 - ease(140)
		this.eyes(worm, now, elapsed)
	}

	/** Heads for its goal (or a highlight step's spot): gliding along a curve, sliding over a little, or blinking over when it's far. */
	private locomote(worm: Worm, now: number, dt: number, z: number) {
		const goal = worm.visit ?? worm.goal
		if (worm.mode !== 'here' || worm.leaving || !goal) return
		if (this.reducedMotion.matches) {
			worm.root = { ...goal }
			worm.dest = { ...goal }
			worm.trip = null
			worm.vel = { x: 0, y: 0 }
			return
		}
		const dest = worm.dest
		if (!dest || Math.hypot(goal.x - dest.x, goal.y - dest.y) > 1) {
			// Somewhere new.
			worm.dest = { ...goal }
			const rush = worm.rushNext
			worm.rushNext = false
			const d = Math.hypot(goal.x - worm.root.x, goal.y - worm.root.y) * z
			if (d > GLIDE_MAX || (!this.onScreen(worm.root, 80) && !this.onScreen(goal, 80))) return this.vanish(worm, now, goal)
			if (d > NUDGE_PX) this.plan(worm, goal, now, z, rush ? 'rush' : 'glide')
			else {
				worm.trip = null
				if (rush) worm.rushArriveAt = now
			}
		}
		let aim = goal
		const trip = worm.trip
		if (trip) {
			const u = (now - trip.at) / trip.dur
			if (u >= 1) {
				worm.trip = null
				if (trip.kind === 'rush') worm.rushArriveAt = now
			} else if (u < 0) {
				// crouching to set off: drawing back a little
				const l = Math.hypot(trip.to.x - trip.from.x, trip.to.y - trip.from.y) || 1
				const back = (8 * Math.sin((Math.PI / 2) * (1 + (u * trip.dur) / RUSH_WAIT_MS))) / z
				aim = { x: trip.from.x - ((trip.to.x - trip.from.x) / l) * back, y: trip.from.y - ((trip.to.y - trip.from.y) / l) * back }
			} else aim = bezier(trip, tripEase(trip, u))
		}
		// root follows its path on a spring, page space (livelier rushing, and arriving from a rush)
		const lively = trip?.kind === 'rush' || now - worm.rushArriveAt < 600
		const w = lively ? FOLLOW_W * 1.3 : FOLLOW_W
		const zeta = lively ? 0.62 : FOLLOW_Z
		for (let left = dt; left > 1e-6; left -= 1 / 120) {
			const h = Math.min(left, 1 / 120)
			worm.vel.x += (w * w * (aim.x - worm.root.x) - 2 * zeta * w * worm.vel.x) * h
			worm.vel.y += (w * w * (aim.y - worm.root.y) - 2 * zeta * w * worm.vel.y) * h
			worm.root.x += worm.vel.x * h
			worm.root.y += worm.vel.y * h
		}
	}

	/**
	 * A glide to `goal`: it sets off the way it's pointing (or already going) and comes in to the
	 * goal on a smooth curve, so where it came from shapes the path.
	 */
	private plan(worm: Worm, goal: Vec, now: number, z: number, kind: Trip['kind']) {
		const from = { ...worm.root }
		const dx = goal.x - from.x
		const dy = goal.y - from.y
		const d = Math.hypot(dx, dy) * z
		const dir = { x: dx / (Math.hypot(dx, dy) || 1), y: dy / (Math.hypot(dx, dy) || 1) }
		const speed = Math.hypot(worm.vel.x, worm.vel.y) * z
		const h = speed > 60 ? Math.atan2(worm.vel.y, worm.vel.x) : worm.heading
		// (rushing, it turns to face the item as it crouches and makes straight for it)
		const hv = kind === 'rush' ? dir : { x: Math.cos(h), y: Math.sin(h) }
		const along = hv.x * dir.x + hv.y * dir.y
		const lead = Math.min(150, d * (0.16 + 0.2 * (1 + along))) / z
		const back = (d * 0.3) / z
		worm.trip = {
			from,
			c1: { x: from.x + hv.x * lead, y: from.y + hv.y * lead },
			c2: { x: goal.x - dir.x * back, y: goal.y - dir.y * back },
			to: { ...goal },
			at: kind === 'rush' ? now + RUSH_WAIT_MS : now,
			dur:
				kind === 'rush'
					? Math.min(RUSH_MAX_MS, Math.max(RUSH_MIN_MS, RUSH_MS + d * RUSH_PER_PX))
					: Math.min(GLIDE_MAX_MS, Math.max(GLIDE_MIN_MS, GLIDE_MS + d * GLIDE_PER_PX)),
			kind,
		}
	}

	/** Popping up and blinking out (then popping up again where it was going). */
	private popping(worm: Worm, now: number) {
		const still = this.reducedMotion.matches
		const u = (now - worm.modeAt) / (worm.mode === 'pop' ? POP_MS : VANISH_MS)
		if (worm.mode === 'pop') {
			if (still || u >= 1) this.settle(worm)
			return
		}
		if (!still && u < 1) return
		const to = worm.warpTo
		if (to && !worm.leaving) {
			const at = worm.visit ?? worm.goal ?? to
			// facing the way it went
			worm.heading = Math.atan2(at.y - worm.root.y, at.x - worm.root.x)
			worm.spin = 0
			worm.root = { ...at }
			worm.dest = { ...at }
			worm.vel = { x: 0, y: 0 }
			this.pop(worm, now)
		} else worm.gone = true
	}

	/** Knocked out of place (slaps, recoils): sprung back, or thrown and left to fly. */
	private knock(worm: Worm, pose: Pose | null, dt: number) {
		const to = pose?.off ?? { x: 0, y: 0 }
		if (this.reducedMotion.matches) {
			worm.off = { ...to }
			worm.offV = { x: 0, y: 0 }
			return
		}
		const w = pose?.k ?? SETTLE_W
		for (let left = dt; left > 1e-6; left -= 1 / 120) {
			const h = Math.min(left, 1 / 120)
			if (pose?.free) {
				const drag = Math.exp(-3 * h)
				worm.offV.x *= drag
				worm.offV.y *= drag
			} else {
				worm.offV.x += (w * w * (to.x - worm.off.x) - 2 * 0.8 * w * worm.offV.x) * h
				worm.offV.y += (w * w * (to.y - worm.off.y) - 2 * 0.8 * w * worm.offV.y) * h
			}
			worm.off.x += worm.offV.x * h
			worm.off.y += worm.offV.y * h
		}
	}

	/** Turns it toward where it should point, on an angular spring (or lets it spin, thrown). */
	private steer(worm: Worm, pose: Pose | null, now: number, dt: number, z: number) {
		const want = pose ? pose.heading : this.heading(worm, now, z)
		if (this.reducedMotion.matches) {
			worm.heading = want ?? worm.rest
			worm.spin = 0
			return
		}
		const w = pose?.turn ?? (worm.trip ? TURN_W * 1.25 : TURN_W)
		for (let left = dt; left > 1e-6; left -= 1 / 120) {
			const h = Math.min(left, 1 / 120)
			const acc = want === null ? -1.6 * worm.spin : w * w * turn(worm.heading, want) - 2 * TURN_Z * w * worm.spin
			worm.spin += acc * h
			worm.heading += worm.spin * h
		}
		worm.heading = turn(0, worm.heading)
	}

	/** Where it wants to point, from what it's doing: the way it's going while it moves. */
	private heading(worm: Worm, now: number, z: number): number {
		const t = now / 1000 + worm.seed
		const rest = worm.rest
		if (this.reducedMotion.matches) return rest
		let base = rest
		const calling = worm.calls > 0 && !worm.el.classList.contains('attending')
		if (worm.mode === 'vanish') base = rest + 2.2 * ((now - worm.modeAt) / VANISH_MS)
		else if (worm.asleep) base = rest + 0.28 * Math.sign(turn(rest, Math.PI / 2) || 1)
		else if (calling) base = rest + 0.36 * Math.sin(t * 7.5)
		else if (worm.fretting) base = rest + 0.07 * wobble(t * 0.5 + 3)
		else if (worm.talk > 0.05) base = rest + 0.08 * Math.sin(t * 20) * worm.talk
		else if (!worm.pointAt) {
			base = rest + 0.07 * wobble(t * 0.25)
			// a slight turn toward someone's pointer nearby
			const c = worm.shape?.centre
			const p = this.pointer
			if (c && p && !this.press && !worm.listening && Math.hypot(p.x - c.x, p.y - c.y) < STARE_PX) {
				base += Math.max(-0.2, Math.min(0.2, turn(rest, Math.atan2(p.y - c.y, p.x - c.x)) * 0.25))
			}
		}
		const recoil = (now - worm.recoilAt) / RECOIL_MS
		if (recoil >= 0 && recoil < 1) base -= 0.35 * Math.sin(Math.PI * recoil)
		// got to a new item: a happy wiggle
		const wiggle = (now - worm.rushArriveAt) / WIGGLE_MS
		if (wiggle >= 0 && wiggle < 1) base += 0.45 * Math.sin(wiggle * Math.PI * 5) * (1 - wiggle)
		// moving: the tip facing where it's going, then turning to point where it should as it arrives
		let travel = 0
		let way = base
		const trip = worm.trip
		if (trip) {
			const u = Math.min(1, Math.max(0, (now - trip.at) / trip.dur))
			const tan = bezierTangent(trip, tripEase(trip, u))
			if (Math.hypot(tan.x, tan.y) > 1e-9) {
				way = Math.atan2(tan.y, tan.x)
				travel = 1 - smoothstep((u - 0.8) / 0.2)
			}
		} else {
			const vx = worm.vel.x * z + worm.offV.x
			const vy = worm.vel.y * z + worm.offV.y
			const speed = Math.hypot(vx, vy)
			if (speed > 140) {
				way = Math.atan2(vy, vx)
				travel = smoothstep((speed - 140) / 260)
			}
		}
		// (blended as turns from where it points now, so a way half round from where it'll rest never flips)
		const h = worm.heading
		return travel ? h + turn(h, way) * travel + turn(h, base) * (1 - travel) : base
	}

	/**
	 * Where it points at rest: at a highlight step's target, else at what it's working on or its
	 * frame when one is close by (and it isn't on it), else up and to the left, like a pointer.
	 */
	private restHeading(worm: Worm, centre: Vec): number {
		const aim = (p: Vec) => Math.atan2(p.y - centre.y, p.x - centre.x)
		if (worm.pointAt) return aim(this.editor.pageToScreen(worm.pointAt))
		const frame = worm.sessionId ? this.editor.getSelectionBounds(`frame:${worm.sessionId}`) : undefined
		const z = this.editor.camera.peek().z
		for (const box of [worm.focus, frame]) {
			if (!box) continue
			const s = this.editor.pageToScreen(box)
			const near = { x: Math.min(Math.max(centre.x, s.x), s.x + box.w * z), y: Math.min(Math.max(centre.y, s.y), s.y + box.h * z) }
			const d = Math.hypot(near.x - centre.x, near.y - centre.y)
			if (d > 14 && d < POINT_AT_PX) return aim(near)
			if (d <= 14) break
		}
		return NATIVE
	}

	/** Thinking (busy, not talking): fretting, and now and then a fit of frustration. */
	private fret(worm: Worm, now: number) {
		const busy = worm.think > 0.5 && worm.talk < 0.3 && worm.mode === 'here' && !worm.trip && !worm.asleep
		worm.fretting = busy
		if (!busy || this.reducedMotion.matches) {
			worm.nextFit = 0
			return
		}
		if (!worm.nextFit) worm.nextFit = now + 2500 + Math.random() * 2500
		if (now > worm.nextFit) {
			worm.fit = now
			worm.nextFit = now + FIT_GAP_MS * (0.7 + Math.random() * 0.8)
		}
	}

	/** Clicked: it hops back from its tip. */
	private recoil(worm: Worm, now: number) {
		worm.recoilAt = now
		worm.offV.x -= Math.cos(worm.heading) * 150
		worm.offV.y -= Math.sin(worm.heading) * 150 + 60
	}

	/** Where the eye looks, how open it is, and its blinks. */
	private eyes(worm: Worm, now: number, elapsed: number) {
		const still = this.reducedMotion.matches
		const eye = worm.eye
		const t = now / 1000 + worm.seed
		const startle = still ? 0 : startleAmount(worm, now)
		const at = worm.shape?.eye ?? this.centreOf(worm)
		const toward = (p: Vec): Vec => {
			const dx = p.x - at.x
			const dy = p.y - at.y
			const l = Math.hypot(dx, dy) || 1
			return { x: dx / l, y: dy / l }
		}
		const stare = this.pointer && !this.press && Math.hypot(this.pointer.x - at.x, this.pointer.y - at.y) < STARE_PX ? this.pointer : null
		const calling = worm.calls > 0 && !worm.el.classList.contains('attending')
		const ahead = { x: Math.cos(worm.heading) * 0.75, y: Math.sin(worm.heading) * 0.75 }
		let look: Vec = ahead
		let lid = 0
		let wide = 0
		let slant = 0
		let squeeze = 0
		let lower = 0
		let dizzy = 0
		const slapped = this.carry.eye(worm, now) ?? this.slaps.eye(worm, now)
		if (slapped) ({ look, lid, wide, slant, squeeze, lower, dizzy } = slapped)
		else if (startle > 0) {
			look = { x: 0, y: 0 }
			wide = startle
		} else if (worm.mode === 'pop' || worm.mode === 'vanish') {
			look = ahead
			wide = 0.4
		} else if (worm.asleep) {
			look = { x: 0, y: 0.4 }
			lid = 1
		} else if (worm.trip?.kind === 'rush' || now - worm.rushArriveAt < RUSH_GLEE_MS) {
			// excited: wide-eyed on the way, then at what it came to see
			const box = worm.focus
			look = worm.trip || !box ? { x: ahead.x * 1.2, y: ahead.y * 1.2 } : toward(this.editor.pageToScreen({ x: box.x + box.w / 2, y: box.y + box.h / 2 }))
			wide = worm.trip ? 1 : 1 - (now - worm.rushArriveAt) / RUSH_GLEE_MS
		} else if (worm.trip) {
			look = { x: ahead.x * 1.2, y: ahead.y * 1.2 }
		} else if (calling) {
			look = stare ? toward(stare) : { x: 0.5 * Math.sin(t * 2.2), y: -0.15 }
			wide = 0.85
		} else if (worm.fretting) {
			// looking up and about, thinking, darting; squinting now and then; screwed up in a fit
			if (now > worm.nextDart) {
				worm.dart = { x: (Math.random() - 0.5) * 0.9, y: (Math.random() - 0.5) * 0.5 }
				worm.nextDart = now + 220 + Math.random() * 600
			}
			look = { x: 0.5 * wobble(t * 0.7 + 5) + worm.dart.x, y: -0.55 + 0.25 * wobble(t * 0.6 + 21) + worm.dart.y * 0.4 }
			const squint = Math.max(0, wobble(t * 0.35 + 3))
			lid = 0.08 + 0.4 * squint
			lower = 0.4 * squint
			const fit = (now - worm.fit) / FIT_MS
			if (!still && fit >= 0 && fit < 1) {
				const shut = Math.pow(Math.sin(Math.PI * fit), 0.5)
				lid = Math.max(lid, 0.3 + 0.7 * shut)
				squeeze = shut > 0.75 ? 1 : 0
				// the lid flicking from one angle to the other
				slant = 0.38 * (Math.sin(now * 0.03) > 0 ? 1 : -1) * Math.min(1, shut * 1.4)
				lower = Math.max(lower, 0.3 * shut)
			}
		} else if (worm.talk > 0.05) {
			look = { x: ahead.x * 0.5 + 0.25 * Math.sin(t * 3.1), y: -0.35 + 0.2 * Math.sin(t * 4.7) }
		} else if (worm.listening) {
			look = { x: -0.1, y: 0.95 }
		} else if (worm.pointAt) {
			look = toward(this.editor.pageToScreen(worm.pointAt))
		} else if (stare) {
			look = toward(stare)
		} else {
			if (now > worm.nextGlance) {
				const box = worm.focus
				const r = Math.random()
				if (box && r < 0.5) {
					worm.glance = toward(this.editor.pageToScreen({ x: box.x + box.w / 2, y: box.y + box.h / 2 }))
				} else if (r < 0.75) {
					worm.glance = { ...ahead }
				} else {
					const a = worm.heading + (Math.random() - 0.5) * 3
					worm.glance = { x: Math.cos(a) * 0.85, y: Math.sin(a) * 0.7 }
				}
				worm.nextGlance = now + 800 + Math.random() * 2600
			}
			look = worm.glance
		}
		// blinks (even with reduced motion: they're the one thing it keeps); calling, in twos
		if (!worm.asleep && now > worm.nextBlink) {
			worm.blinkStart = now
			worm.doubleBlink = calling || Math.random() < 0.2
			worm.nextBlink = now + (calling ? 1700 : 2200 + Math.random() * 3600)
		}
		const blink = (now - worm.blinkStart) / 150
		const again = (now - worm.blinkStart - 240) / 150
		let blinking = false
		if (blink >= 0 && blink < 1) {
			lid = Math.max(lid, Math.sin(Math.PI * blink))
			blinking = true
		} else if (worm.doubleBlink && again >= 0 && again < 1) {
			lid = Math.max(lid, Math.sin(Math.PI * again))
			blinking = true
		}
		const wake = (now - worm.wakeAt) / WAKE_MS
		if (!still && wake >= 0 && wake < 1) lid = Math.max(lid, 1 - smoothstep(wake / 0.6))
		// saccades: the pupil snaps over, rather than drifting
		const k = still ? 1 : 1 - Math.exp(-elapsed / 32)
		eye.look = { x: eye.look.x + (look.x - eye.look.x) * k, y: eye.look.y + (look.y - eye.look.y) * k }
		eye.lid += (lid - eye.lid) * (still || blinking ? 1 : 1 - Math.exp(-elapsed / 60))
		eye.wide += (wide - eye.wide) * (still ? 1 : 1 - Math.exp(-elapsed / 90))
		eye.slant += (slant - eye.slant) * (still ? 1 : 1 - Math.exp(-elapsed / 50))
		eye.lower += (lower - eye.lower) * (still ? 1 : 1 - Math.exp(-elapsed / 80))
		eye.squeeze = squeeze
		eye.dizzy = dizzy
	}

	private onScreen(p: Vec, margin: number) {
		const s = this.editor.pageToScreen(p)
		const { w, h } = this.editor.viewport.peek()
		return s.x > -margin && s.y > -margin && s.x < w + margin && s.y < h + margin
	}

	private resize() {
		const { w, h } = this.editor.viewport.peek()
		const dpr = window.devicePixelRatio || 1
		const cw = Math.round(w * dpr)
		const ch = Math.round(h * dpr)
		if (this.canvas.width !== cw || this.canvas.height !== ch) {
			this.canvas.width = cw
			this.canvas.height = ch
			this.canvas.style.width = `${w}px`
			this.canvas.style.height = `${h}px`
		}
	}

	/** The tooltip of the baby under the pointer, following it. */
	private showTip() {
		let best: Baby | null = null
		const p = this.pointer
		if (p && !this.press) {
			let bestD = Infinity
			for (const worm of this.worms.values()) {
				if (worm.leaving) continue
				const hit = worm.colony.hit(p, this.tipFor ? 4 : 0)
				if (hit && hit.d < bestD) {
					bestD = hit.d
					best = hit.baby
				}
			}
		}
		if (best !== this.tipFor) {
			this.tipFor = best
			this.tip.hidden = !best
			if (best) this.tip.textContent = best.tip
		}
		if (best) this.tip.style.transform = `translate(${best.screen.x}px, ${best.screen.y - 8}px) translate(-50%, -100%)`
	}

	// ---------- drawing ----------

	private draw(worm: Worm, now: number, elapsed: number) {
		if (worm.asleep && !this.slaps.awake(worm, now)) return this.drawFaded(worm, now, elapsed, 0.5)
		this.ctx.save()
		try {
			this.drawCreature(worm, now, elapsed)
		} finally {
			this.ctx.restore()
		}
	}

	/** Dimmed as a whole (asleep): drawn on a scratch layer first, so its shading doesn't show through. */
	private drawFaded(worm: Worm, now: number, elapsed: number, alpha: number) {
		const main = this.ctx
		const dpr = window.devicePixelRatio || 1
		if (!this.scratch) this.scratch = document.createElement('canvas')
		const layer = this.scratch
		if (layer.width !== this.canvas.width || layer.height !== this.canvas.height) {
			layer.width = this.canvas.width
			layer.height = this.canvas.height
		}
		const ctx = layer.getContext('2d')!
		const at = this.centreOf(worm)
		const R = 90
		const sx = Math.max(0, Math.floor((at.x - R) * dpr))
		const sy = Math.max(0, Math.floor((at.y - R) * dpr))
		const sw = Math.min(layer.width - sx, Math.ceil(R * 2 * dpr))
		const sh = Math.min(layer.height - sy, Math.ceil(R * 2 * dpr))
		ctx.setTransform(1, 0, 0, 1, 0, 0)
		if (sw > 0 && sh > 0) ctx.clearRect(sx, sy, sw, sh)
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
		this.ctx = ctx
		try {
			ctx.save()
			this.drawCreature(worm, now, elapsed)
			ctx.restore()
		} finally {
			this.ctx = main
		}
		if (sw <= 0 || sh <= 0) return
		main.save()
		main.globalAlpha = alpha
		main.drawImage(layer, sx, sy, sw, sh, sx / dpr, sy / dpr, sw / dpr, sh / dpr)
		main.restore()
	}

	private drawCreature(worm: Worm, now: number, elapsed: number) {
		const still = this.reducedMotion.matches
		const t = now / 1000 + worm.seed
		const home = this.centreOf(worm)
		const c = { x: home.x + worm.off.x, y: home.y + worm.off.y }
		let scale = 1 - 0.12 * worm.squash * Math.cos((now - worm.modeAt) * 0.03)
		let heading = worm.heading
		const calling = worm.calls > 0 && !worm.el.classList.contains('attending')
		if (worm.mode === 'pop') scale *= easeOutBack(Math.min(1, (now - worm.modeAt) / POP_MS))
		else if (worm.mode === 'vanish') scale *= 1 - Math.pow(Math.min(1, (now - worm.modeAt) / VANISH_MS), 2)
		if (!still) {
			// hovering: a gentle bob; asleep, slow breaths; calling, little hops
			if (worm.asleep) scale *= 1 + 0.035 * Math.sin(t * 1.3)
			else if (calling) c.y -= 3.5 * Math.abs(Math.sin(t * 4.2))
			else c.y += 1.6 * Math.sin(t * 2.3)
			// thinking: a fine fast tremble
			if (worm.fretting) {
				c.x += 0.5 * Math.sin(now * 0.11)
				c.y += 0.4 * Math.sin(now * 0.093 + 1)
				heading += 0.03 * Math.sin(now * 0.077)
			}
			const wake = (now - worm.wakeAt) / WAKE_MS
			if (wake >= 0 && wake < 1) scale *= 1 + 0.14 * Math.sin(Math.PI * wake)
			// rushing: a crouch, a hop all the way there, and a little bounce on landing
			const trip = worm.trip
			if (trip?.kind === 'rush') {
				const u = (now - trip.at) / trip.dur
				if (u < 0) {
					const a = 1 + (u * trip.dur) / RUSH_WAIT_MS
					scale *= 1 - 0.12 * Math.sin(Math.PI * a)
					c.y += 3 * Math.sin(Math.PI * a)
				} else c.y -= RUSH_HOP * Math.sin(Math.PI * Math.min(1, u))
			}
			const land = (now - worm.rushArriveAt) / 360
			if (land >= 0 && land < 1) scale *= 1 + 0.12 * Math.sin(Math.PI * land)
		}
		const shape = place(c, heading, Math.max(0.001, scale))
		worm.shape = shape
		if (worm.colony.size) {
			// (drifting about where it sits, not bobbing with it; blinking out with it)
			worm.colony.step(now, elapsed, home, worm.asleep, still)
			const carry = worm.mode === 'pop' || worm.mode === 'vanish' ? scale : 1
			this.ctx.save()
			this.ctx.globalAlpha *= Math.min(1, Math.max(0, carry))
			worm.colony.draw(this.ctx, home, 1, window.devicePixelRatio || 1)
			this.ctx.restore()
		}
		// thinking: a soft glow pulsing in its colour
		const glow = worm.think * (still ? 0.6 : 0.5 + 0.3 * Math.sin(now * 0.0055))
		drawPointer(this.ctx, shape, worm.palette, worm.eye, { dpr: window.devicePixelRatio || 1, glow, glowColor: worm.color })
		// (where it goes and the way it travels aren't part of it: its marker stays put, pointing at it)
		const posed = worm.mode === 'here' && !worm.trip && !this.slaps.holds(worm, now)
		worm.live = { dx: c.x - worm.off.x - home.x, dy: c.y - worm.off.y - home.y, turn: posed ? turn(worm.rest, heading) : heading - worm.heading, scale, glow }
		this.placeLabels(worm, shape, elapsed)
	}

	/**
	 * Where the name tag hangs (under it, where it is on the page, following knocks and dangling),
	 * and its top and middle from there (CSS --hx/--hy and --mx/--my), which the bubbles, zzz
	 * and ring follow. Placed from this frame's camera, so they move with the canvas
	 * exactly; only how they sit on the shape is eased.
	 */
	private placeLabels(worm: Worm, shape: Shape, elapsed: number) {
		const still = this.reducedMotion.matches
		const ground = this.editor.pageToScreen(worm.root)
		const want = { x: worm.off.x, y: worm.off.y }
		const k = (ms: number) => (still || !worm.anchor ? 1 : 1 - Math.exp(-elapsed / ms))
		const a = worm.anchor ?? want
		worm.anchor = { x: a.x + (want.x - a.x) * k(45), y: a.y + (want.y - a.y) * k(45) }
		const anchor = worm.anchor
		const c = shape.centre
		const head = { x: c.x - ground.x - anchor.x, y: Math.min(shape.top, c.y - SIZE * 0.45) - ground.y - anchor.y }
		// The bubbles follow its top, but not every little bob of it.
		worm.headAt = { x: worm.headAt.x + (head.x - worm.headAt.x) * k(110), y: worm.headAt.y + (head.y - worm.headAt.y) * k(110) }
		worm.middleAt = { x: c.x - ground.x - anchor.x, y: c.y - ground.y - anchor.y }
		const el = worm.el
		el.style.transform = `translate(${ground.x + anchor.x}px, ${ground.y + anchor.y}px)`
		el.style.setProperty('--hx', `${worm.headAt.x.toFixed(1)}px`)
		el.style.setProperty('--hy', `${worm.headAt.y.toFixed(1)}px`)
		el.style.setProperty('--mx', `${worm.middleAt.x.toFixed(1)}px`)
		el.style.setProperty('--my', `${worm.middleAt.y.toFixed(1)}px`)
	}
}

/** 1 right after a creature is startled, easing to 0 over STARTLE_MS. */
function startleAmount(worm: Worm, now: number) {
	const t = (now - worm.startledAt) / STARTLE_MS
	return t >= 0 && t < 1 ? 1 - t * t : 0
}

/**
 * The point on a box's edge nearest `p`, and the outward direction there (from inside, the nearest
 * edge's normal; from outside, the way to `p`).
 */
function edgeNear(p: Vec, b: Box): { at: Vec; out: Vec } {
	const inside = p.x > b.x && p.x < b.x + b.w && p.y > b.y && p.y < b.y + b.h
	if (!inside) {
		const at = { x: Math.min(Math.max(p.x, b.x), b.x + b.w), y: Math.min(Math.max(p.y, b.y), b.y + b.h) }
		const l = Math.hypot(p.x - at.x, p.y - at.y) || 1
		return { at, out: { x: (p.x - at.x) / l, y: (p.y - at.y) / l } }
	}
	const d = [p.x - b.x, b.x + b.w - p.x, p.y - b.y, b.y + b.h - p.y]
	const i = d.indexOf(Math.min(...d))
	if (i === 0) return { at: { x: b.x, y: p.y }, out: { x: -1, y: 0 } }
	if (i === 1) return { at: { x: b.x + b.w, y: p.y }, out: { x: 1, y: 0 } }
	if (i === 2) return { at: { x: p.x, y: b.y }, out: { x: 0, y: -1 } }
	return { at: { x: p.x, y: b.y + b.h }, out: { x: 0, y: 1 } }
}

function bezier(t: Trip, s: number): Vec {
	const u = 1 - s
	const a = u * u * u
	const b = 3 * u * u * s
	const c = 3 * u * s * s
	const d = s * s * s
	return { x: a * t.from.x + b * t.c1.x + c * t.c2.x + d * t.to.x, y: a * t.from.y + b * t.c1.y + c * t.c2.y + d * t.to.y }
}

function bezierTangent(t: Trip, s: number): Vec {
	const u = 1 - s
	const a = 3 * u * u
	const b = 6 * u * s
	const c = 3 * s * s
	return {
		x: a * (t.c1.x - t.from.x) + b * (t.c2.x - t.c1.x) + c * (t.to.x - t.c2.x),
		y: a * (t.c1.y - t.from.y) + b * (t.c2.y - t.c1.y) + c * (t.to.y - t.c2.y),
	}
}

function smoothstep(t: number) {
	const u = Math.min(1, Math.max(0, t))
	return u * u * (3 - 2 * u)
}

/** How far along its path a trip is at u (0..1): rushes dash off and ease in. */
function tripEase(trip: Trip, u: number) {
	return trip.kind === 'rush' ? 1 - Math.pow(1 - Math.min(1, Math.max(0, u)), 2.4) : easeInOutSine(u)
}

function easeInOutSine(t: number) {
	return -(Math.cos(Math.PI * Math.min(1, Math.max(0, t))) - 1) / 2
}

function easeOutBack(t: number) {
	const c = 1.9
	return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2)
}
