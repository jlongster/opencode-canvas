import type { Editor } from '../editor/Editor'
import { markdownToHtml } from '../ui/markdown'
import type { Box, Vec } from '../editor/geometry'
import type { Attention } from './Attention'
import type { Conjure } from './Conjure'
import { Fights } from './Fight'
import { Slaps } from './Slap'
import type { Peer, SubagentInfo } from './Presence'
import {
	Body,
	HEAD_R,
	LENGTH,
	POINTS,
	TAIL_R,
	archPose,
	curlPose,
	drawLooper,
	drawTiny,
	flatPose,
	idlePose,
	mixColor,
	palette,
	place,
	radius,
	standPose,
	wobble,
	writhePose,
	type EyeState,
	type Writhe,
	type Palette,
} from './Looper'

/** Where it sits, relative to the top-right corner of what the agent is working on. */
const PERCH: Vec = { x: 30, y: -10 }
/** Trips longer than this (screen px), or entirely off-screen, burrow and pop up there instead of inching. */
const CRAWL_MAX = 340
/** Goal moves smaller than this (screen px) are followed by sliding over rather than walking. */
const NUDGE_PX = 10
/** most a stride covers, screen px: from feet a body length apart to an Ω */
const STRIDE = 30
/** a stride's duration (gathering the tail up, then reaching the head forward), long trips quicker */
const STRIDE_MS = 900
const STRIDE_MIN_MS = 540
/** a goal further behind than this turns it around first */
const TURN_PX = 14
const TURN_MS = 760
/** coming up out of the canvas, then a stretch; diving back in */
const EMERGE_MS = 620
const STRETCH_MS = 900
const DIVE_MS = 520
/** waking up: a stretch */
const WAKE_MS = 1100
/** the quick recoil when it's clicked */
const RECOIL_MS = 340
/** thinking: how long a fit lasts (a clench, or its head pressed down), and the gap between fits */
const FIT_MS = { clench: 1700, press: 1500 }
const FIT_GAP_MS = 4200
/** fidgeting while it sits about, and how often */
const FIDGET_MS = 1500
const FIDGET_EVERY_MS = 9000
/** after landing, how long it takes to right itself before it settles where it is */
const SETTLE_MS = 800
/** how far it drops when let go, below where its lowest part hangs, screen px */
const DROP_PX = 16
const CHAT_MS = 5000
const POP_MS = 380
/** local typewriter speed for speech, catching up faster when it falls behind what has arrived */
const TYPE_CPS = 36
const SPEECH_CLOSE_MS = 220
/** how long the startled eye lasts after it's clicked */
const STARTLE_MS = 1100
/** extra screen px around the body that still counts as clicking it */
const HIT_SLOP = 4
/** a press that moves further than this (screen px) drags it instead of clicking */
const DRAG_PX = 5
/** a dropped creature stays where it was put this long at most while waiting for its new position to come back */
const PIN_MS = 5000
/** the pointer this close to its head (screen px) gets stared at */
const STARE_PX = 170
/** a conjured creature's finished reply puts itself away (locally) after this long, unless it's pinned */
const REPLY_HIDE_MS = 7000
/** subagents' tiny loopers: size (of the creature), points, and how far either side of it they roam */
const TINY_SIZE = 0.42
const TINY_POINTS = 8
const TINY_RANGE = 66
/** their lanes, in front of it and behind (screen px below its ground), by slot */
const TINY_LANES = [14, -12, 26, -22, 36]
/** a tiny looper's stride (px), how long one takes, and turning round at the end of its lane */
const TINY_STRIDE = 10
const TINY_STRIDE_MS = 560
const TINY_TURN_MS = 380
/** a tiny looper's feet apart, lying long */
const TINY_FOOT = LENGTH * TINY_SIZE * 0.85
/** wriggling away when its subagent finishes */
const TINY_LEAVE_MS = 520
/** how close the pointer has to be to a tiny looper's head for its tooltip, screen px */
const TINY_HOVER_PX = 11
/** zoom at and above which speech bubbles are full size; below it they shrink with the canvas */
const FULL_BUBBLE_ZOOM = 0.6
/** records created longer ago than this were there already: they pop up rather than wake curled */
const FRESH_MS = 15000

type Mode = 'here' | 'emerge' | 'dive' | 'carried' | 'falling'

/**
 * Inching toward the goal. Feet are x positions in the creature's frame: the tail's and the
 * head's. Each stride first gathers the tail up behind the head (arching the body into an Ω),
 * then reaches the head forward. A goal behind it turns it around: it rears up and flops over.
 */
interface Walk {
	phase: 'turn' | 'gather' | 'reach'
	at: number
	dur: number
	tail: number
	head: number
	/** the moving foot's x when the phase started */
	from: number
	stride: number
	/** the ground's page y over this stride (vertical travel glides) */
	y0: number
	y1: number
	ms: number
	/** turning: where it rears up, and whether it has flipped over yet */
	pivot: number
	flipped: boolean
}

/** A subagent's tiny looper, inching back and forth in its lane by its parent. Feet are x from the parent's middle. */
interface Tiny {
	id: string
	tip: string
	seed: number
	/** its place among the parent's tiny loopers, which spreads them around */
	slot: number
	scale: number
	popStart: number
	leaving: boolean
	leaveStart: number
	tail: number
	head: number
	/** which way it's going */
	dir: number
	phase: 'gather' | 'reach' | 'turn'
	at: number
	from: number
	/** its head on screen as last drawn, for hovering */
	screen: Vec
	/** 1, fading to 0 as it leaves */
	fade: number
}

export interface Worm {
	id: number
	color: string
	palette: Palette
	tinyColor: string
	/** strain marks by its head while it thinks hard */
	stressColor: string
	/** the ground under its middle, page space: where it is. The body is in screen px around it. */
	root: Vec
	goal: Vec | null
	/** the box the agent is working on, for the eye to glance at */
	focus: Box | null
	body: Body
	/** which way the head points: 1 right, -1 left */
	facing: number
	walk: Walk | null
	mode: Mode
	modeAt: number
	/** diving: the body when it started (to slurp it down the hole), and where it pops up, if anywhere */
	dive: { from: Vec[]; to: Vec | null } | null
	/** emerging and diving: the hole's x in its frame */
	hole: number
	/** dived away for good */
	gone: boolean
	leaving: boolean
	seed: number
	eye: EyeState
	nextBlink: number
	blinkStart: number
	glance: Vec
	nextGlance: number
	/** panicking (carried): where the eye darts, and when it darts again */
	dart: Vec
	nextDart: number
	/** 0..1 squashed from a landing, easing back */
	squash: number
	stretchAt: number
	wakeAt: number
	recoilAt: number
	/** sitting about, now and then: a peek round with its head up high, or a scrunch on the spot */
	fidget: 'peek' | 'scrunch'
	fidgetAt: number
	nextFidget: number
	/** thinking hard: a fit of frustration (clenching up, or head pressed down) and when the next comes */
	fit: { kind: 'clench' | 'press'; at: number } | null
	nextFit: number
	/** how it writhes this frame, while thinking (null when it isn't) */
	writhe: (Writhe & { calm: boolean }) | null
	/** when it last landed from a fall, while it rights itself (0 after) */
	landedAt: number
	/** the startle (from conjure.startled) the body last reacted to */
	startleSeen: number
	/** carried: which point is held, and how far from the pointer (screen px) */
	grab: { i: number; off: Vec } | null
	/** where the held point is being carried to (page space), while someone here carries it */
	carried: Vec | null
	/** where it was dropped, held until its presence catches up */
	pinned: { at: Vec; until: number } | null
	/** the points on screen as last drawn */
	drawn: Vec[]
	/** where the labels hang (screen), and the head and body's middle from there, eased */
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
	/** speech bubble from the agent's say tool, while it's showing */
	bubble: HTMLDivElement | null
	bubbleText: HTMLDivElement | null
	/** what has arrived so far, by character, and whether it's complete */
	speech: string[]
	speechDone: boolean
	/** characters typed out locally (fractional) and how many are on screen */
	speechShown: number
	speechDrawn: number
	/** 0..1 how much it's talking, eased */
	talk: number
	/** a conjured creature (an OpenCode session people can prompt): clickable on edit links */
	conjured: boolean
	/** nobody runs it right now (no owner tab open): drawn dimmed, curled up asleep */
	asleep: boolean
	/** its session is working on a prompt, and 0..1 eased */
	thinking: boolean
	think: number
	/** when it was last startled (clicked) */
	startledAt: number
	/** its prompt box is open */
	listening: boolean
	/** the "•••" thought cloud while thinking */
	thought: HTMLDivElement
	bubbleScroll: HTMLDivElement | null
	/** a reply dismissed with × (locally), hidden until it says something else */
	dismissed: string | null
	/** the full chat text behind the bubble, and whether it's finished */
	speechText: string | null
	/** the bubble stays up until × (the pointer went over it, or it was reopened) */
	speechPinned: boolean
	/** when the reply finished (typed out, nothing more coming), 0 while it isn't */
	speechDoneAt: number
	/** the speech bubbles' and thought cloud's scale for the zoom, last set on el as --bubble-scale */
	bubbleScale: number
	/** screen-space discs covering the body as last drawn, for clicks */
	hit: { x: number; y: number; r: number }[]
	/** tiny loopers for its busy subagents, by session id, and when they last moved */
	tinies: Map<string, Tiny>
	tiniesAt?: number
	sessionId: string | null
	/** when its record was created, to tell a new one of the same session from the last */
	conjuredAt: number
	/** how many attention actions its session has queued: while any are, it calls (badge, ring, waving), awake */
	calls: number
	/** the count badge, while it calls */
	badge: HTMLButtonElement | null
}

/** A pointer that went down on a creature: a click unless it moves, then a drag. */
interface Press {
	pointerId: number
	worm: Worm
	start: Vec
	/** the point nearest the pointer, and its offset from it (screen px) */
	grab: { i: number; off: Vec }
	dragging: boolean
}

/** What a state asks of the body: a pose, how hard to hold it, and per-point weights. */
interface Posture {
	shape: Vec[]
	k: number
	weights?: number[]
	/** no pose at all: limp (carried, falling) */
	limp?: boolean
	stretch?: number
}

/**
 * Sessions' creatures (real OpenCode sessions, see Conjure): loopers, one-eyed inchworms (see
 * Looper.ts) that sit where they were put and inch about when moved. Their busy subagents are tiny
 * loopers inching round them. Bodies are drawn on one 2D canvas in screen space; the name label,
 * bubbles and badges are DOM, like human cursor labels.
 *
 * A creature whose session queued something for attention (see Attention) calls for it where it
 * sits, even asleep: standing up and waving its head about, with a count badge and a soft pulsing
 * ring. Clicking it (or the badge) opens its walkthrough.
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
	/** the pointer over the canvas (screen space), for staring at and tiny loopers' tooltips */
	private pointer: Vec | null = null
	private tip: HTMLDivElement
	private tipFor: Tiny | null = null
	/** when this page started showing creatures (wall clock), to tell sessions conjured since from ones already here */
	private bornAt = Date.now()
	/** creatures dropped by each other, fighting (see Fight) */
	private fights: Fights
	/** the slap tool's blows (see Slap) */
	private slaps: Slaps

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
		this.fights = new Fights(editor, conjure, attention, this.reducedMotion)
		this.slaps = new Slaps(editor, conjure, this.fights, this.reducedMotion)
		this.labels.appendChild(this.tip)
		// for poking at from the console, like window.editor
		;(window as any).creatures = this
		const track = (e: PointerEvent) => {
			this.pointer = e.pointerType !== 'touch' && this.overCanvas(e) ? this.local(e) : null
		}
		const untrack = (e: PointerEvent) => {
			if (!e.relatedTarget) this.pointer = null
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
			if (!worm) {
				worm = this.spawn(peer, target!.point, now)
				this.arrive(worm, peer, now)
				this.worms.set(peer.clientId, worm)
			}
			if (worm.leaving) this.revive(worm, now)
			this.syncCalls(worm)
			const placed = peer.user.sessionId ? this.conjure?.placing.get(peer.user.sessionId) : undefined
			if (placed) {
				// Summoned here (C): inch over now rather than waiting for the record to come back.
				this.conjure!.placing.delete(peer.user.sessionId!)
				worm.pinned = { at: placed, until: now + PIN_MS }
			}
			if (worm.pinned && (now > worm.pinned.until || (peer.cursor && near(peer.cursor, worm.pinned.at)))) worm.pinned = null
			if (target) {
				worm.goal = worm.pinned?.at ?? target.point
				worm.focus = target.box
			} else {
				worm.focus = null
			}
			this.syncLabel(worm, peer, now)
			if (worm.conjured) this.syncTinies(worm, peer.user.asleep ? [] : (peer.subagents ?? []), now)
		}
		for (const worm of this.worms.values()) {
			if (!seen.has(worm.id) && !worm.leaving) this.leave(worm, now)
		}

		this.resize()
		const ctx = this.ctx
		const dpr = window.devicePixelRatio || 1
		if (this.worms.size === 0) {
			if (this.drewLastFrame) ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
			this.drewLastFrame = false
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
		this.fights.frame(ctx, now, this.worms.values())
		this.slaps.frame(ctx, now, this.worms.values())
		this.showTip()
	}

	destroy() {
		for (const d of this.disposers.splice(0)) d()
		this.fights.destroy()
		this.slaps.destroy()
		this.container?.classList.remove('conjure-hover', 'conjure-dragging')
		this.canvas.remove()
		this.labels.remove()
		this.worms.clear()
	}

	// ---------- clicking and dragging creatures ----------

	/** The topmost creature under a point in client coordinates. */
	private hitTest(clientX: number, clientY: number): Worm | null {
		const rect = this.canvas.getBoundingClientRect()
		const x = clientX - rect.left
		const y = clientY - rect.top
		const worms = [...this.worms.values()].reverse()
		for (const worm of worms) {
			if (!worm.conjured || worm.leaving || worm.mode === 'dive' || (worm.mode === 'emerge' && performance.now() - worm.modeAt < EMERGE_MS * 0.6)) continue
			if (!this.conjure?.canPrompt && !worm.calls) continue
			if (worm.hit.some((d) => Math.hypot(d.x - x, d.y - y) <= d.r + HIT_SLOP)) return worm
		}
		return null
	}

	/** Pointer events over the canvas itself (not over a bubble, a prompt box or other UI). */
	private overCanvas(e: PointerEvent) {
		const target = e.target as Element | null
		return !!target && !!this.container?.contains(target) && !target.closest('.agent-worm-speech, .agent-worm-attention, .conjure-prompt, .note')
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
		// It's picked up by the bit of it under the pointer.
		let i = 0
		let best = Infinity
		worm.drawn.forEach((p, j) => {
			const d = Math.hypot(p.x - at.x, p.y - at.y)
			if (d < best) {
				best = d
				i = j
			}
		})
		const p = worm.drawn[i] ?? at
		this.press = { pointerId: e.pointerId, worm, start: at, grab: { i, off: { x: p.x - at.x, y: p.y - at.y } }, dragging: false }
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
		this.container?.classList.remove('conjure-dragging')
		const worm = press.worm
		const peer = this.conjure?.peer(worm.id)
		if (!press.dragging) {
			if (!peer || e.type !== 'pointerup') return
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
			return
		}
		const sessionId = peer?.user.sessionId
		// A cancelled drag (or a creature that left meanwhile) lands and inches back where it was.
		const ok = !!sessionId && e.type === 'pointerup' && worm.mode === 'carried'
		this.letGo(worm)
		if (!ok) return
		const drop = { x: Math.round(worm.root.x), y: Math.round(worm.root.y) }
		worm.goal = drop
		worm.pinned = { at: drop, until: performance.now() + PIN_MS }
		this.fights.dropped(worm, this.worms.values())
		this.conjure!.move(sessionId!, drop).catch((err) => {
			console.error('moving the creature failed', err)
			worm.pinned = null
		})
	}

	private onPointerMove = (e: PointerEvent) => {
		const press = this.press
		if (press?.pointerId === e.pointerId) {
			e.stopPropagation()
			const at = this.local(e)
			if (!press.dragging) {
				if (!this.conjure?.canEdit || Math.hypot(at.x - press.start.x, at.y - press.start.y) < DRAG_PX) return
				press.dragging = true
				press.worm.pinned = null
				if (this.conjure?.prompting.peek()?.clientId === press.worm.id) this.conjure.close()
				this.container?.classList.remove('conjure-hover')
				this.container?.classList.add('conjure-dragging')
				this.pickUp(press.worm, press.grab)
			}
			press.worm.carried = this.editor.screenToPage({ x: at.x + press.grab.off.x, y: at.y + press.grab.off.y })
			return
		}
		if (this.swallowed.has(e.pointerId)) return e.stopPropagation()
		const over = e.buttons === 0 && this.overCanvas(e) ? this.hitTest(e.clientX, e.clientY) : null
		this.slaps.hovered = this.slaps.active ? over : null
		this.container?.classList.toggle('conjure-hover', !!over && !this.slaps.active)
	}

	private pickUp(worm: Worm, grab: { i: number; off: Vec }) {
		if (worm.mode === 'emerge' || worm.mode === 'dive') this.settle(worm)
		worm.mode = 'carried'
		worm.modeAt = performance.now()
		worm.walk = null
		worm.grab = { ...grab }
		worm.nextDart = 0
	}

	/** Lets go of a carried creature: it falls a little way to new ground there. */
	private letGo(worm: Worm) {
		worm.carried = null
		worm.grab = null
		if (worm.mode !== 'carried') return
		const body = worm.body
		body.hold(null)
		body.wriggle = 0
		let bottom = -Infinity
		body.p.forEach((p, i) => (bottom = Math.max(bottom, p.y + radius(i / (POINTS - 1)))))
		const ground = bottom + DROP_PX
		const z = this.editor.camera.peek().z
		worm.root = { x: worm.root.x, y: worm.root.y + ground / z }
		body.shift(0, -ground)
		worm.mode = 'falling'
		worm.modeAt = performance.now()
		if (this.reducedMotion.matches) this.land(worm)
	}

	private land(worm: Worm) {
		const body = worm.body
		const speed = body.impact
		worm.mode = 'here'
		worm.modeAt = performance.now()
		if (!this.reducedMotion.matches) worm.squash = Math.min(1, Math.max(worm.squash, (speed - 120) / 900))
		const dx = body.p[0].x - body.p[POINTS - 1].x
		if (Math.abs(dx) > 8) worm.facing = Math.sign(dx)
		worm.landedAt = performance.now()
	}

	/** Dropped here, it stays where it came to rest rather than inching back to where it was let go. */
	private stayPut(worm: Worm) {
		const pinned = worm.pinned
		const z = this.editor.camera.peek().z
		const at = { x: Math.round(worm.root.x), y: Math.round(worm.root.y) }
		if (!pinned || !worm.sessionId || Math.hypot(at.x - pinned.at.x, at.y - pinned.at.y) * z <= 3) return
		worm.pinned = { at, until: performance.now() + PIN_MS }
		worm.goal = at
		this.conjure?.move(worm.sessionId, at).catch((err) => console.error('moving the creature failed', err))
	}

	// ---------- state ----------

	/** A cursor if the agent sends one, else a perch just outside the first selected thing. */
	private targetFor(peer: Peer): { point: Vec; box: Box | null } | null {
		const z = this.editor.camera.peek().z
		if (peer.cursor) return { point: { ...peer.cursor }, box: null }
		for (const key of peer.selection ?? []) {
			const box = this.editor.getSelectionBounds(key)
			if (!box) continue
			return { point: { x: box.x + box.w + PERCH.x / z, y: box.y + PERCH.y / z }, box }
		}
		return null
	}

	private spawn(peer: Peer, at: Vec, now: number): Worm {
		const el = document.createElement('div')
		el.className = 'agent-worm'
		el.innerHTML =
			'<span class="peer-cursor-label agent-worm-label"><span class="peer-cursor-name"></span></span>' +
			'<div class="agent-worm-thought" aria-hidden="true"><b></b><b></b><span class="agent-worm-thought-cloud"><i></i><i></i><i></i></span></div>' +
			'<div class="agent-worm-zzz" aria-hidden="true"><i>z</i><i>z</i><i>z</i></div>'
		const label = el.querySelector<HTMLSpanElement>('.agent-worm-label')!
		const name = el.querySelector<HTMLSpanElement>('.peer-cursor-name')!
		const thought = el.querySelector<HTMLDivElement>('.agent-worm-thought')!
		const conjured = !!peer.user.conjured
		el.classList.toggle('conjured', conjured)
		this.labels.appendChild(el)
		const seed = Math.random() * 1000
		const facing = Math.random() < 0.5 ? -1 : 1
		const worm: Worm = {
			id: peer.clientId,
			color: '',
			palette: palette('#22d3ee'),
			tinyColor: mixColor('#22d3ee', 255, 0.3),
			stressColor: mixColor('#22d3ee', 255, 0.45),
			root: { ...at },
			goal: { ...at },
			focus: null,
			body: new Body(place(peer.user.asleep ? curlPose(0) : idlePose(0), facing, 0)),
			facing,
			walk: null,
			mode: 'here',
			modeAt: now,
			dive: null,
			hole: 0,
			gone: false,
			leaving: false,
			seed,
			eye: { look: { x: 0.4 * facing, y: 0 }, lid: peer.user.asleep ? 1 : 0.3, wide: 0 },
			nextBlink: now + 1500 + Math.random() * 3000,
			blinkStart: -1e9,
			glance: { x: 0.6 * facing, y: 0.1 },
			nextGlance: now + 1000,
			dart: { x: 0, y: 1 },
			nextDart: 0,
			squash: 0,
			stretchAt: -1e9,
			wakeAt: -1e9,
			recoilAt: -1e9,
			fidget: 'peek',
			fidgetAt: -1e9,
			fit: null,
			nextFit: 0,
			writhe: null,
			nextFidget: now + 6000 + Math.random() * 8000,
			startleSeen: -1e9,
			landedAt: 0,
			grab: null,
			carried: null,
			pinned: null,
			drawn: [],
			anchor: null,
			headAt: { x: 0, y: -12 },
			middleAt: { x: 0, y: -10 },
			el,
			label,
			name,
			message: null,
			chat: null,
			chatAt: 0,
			nameText: '',
			bubble: null,
			bubbleText: null,
			speech: [],
			speechDone: false,
			speechShown: 0,
			speechDrawn: 0,
			talk: 0,
			conjured,
			asleep: false,
			thinking: false,
			think: 0,
			startledAt: -1e9,
			listening: false,
			thought,
			bubbleScroll: null,
			dismissed: null,
			speechText: null,
			speechPinned: false,
			speechDoneAt: 0,
			bubbleScale: 1,
			hit: [],
			tinies: new Map(),
			calls: 0,
			badge: null,
			sessionId: peer.user.sessionId ?? null,
			conjuredAt: 0,
		}
		return worm
	}

	/**
	 * A creature's arrival: the same session just woke up or nodded off (a new presence, so a new
	 * creature), carrying on where the old one was; otherwise it pops up out of the canvas (unless
	 * it was already here asleep when the page opened: then it's just there, curled up).
	 */
	private arrive(worm: Worm, peer: Peer, now: number) {
		const rec = worm.sessionId ? this.conjure?.record(worm.sessionId) : undefined
		worm.conjuredAt = rec?.createdAt ?? 0
		// (Banished and conjured again, it's a new one.)
		const prev = worm.sessionId
			? [...this.worms.values()].find((w) => w.sessionId === worm.sessionId && w !== worm && w.conjuredAt === worm.conjuredAt)
			: undefined
		if (prev) {
			// Leaving, it was diving away: back up as it was.
			if (prev.leaving && prev.mode === 'dive' && prev.dive) {
				prev.body.set(prev.dive.from)
				prev.mode = 'here'
				prev.dive = null
			}
			for (const key of ['root', 'body', 'facing', 'walk', 'mode', 'modeAt', 'dive', 'hole', 'seed', 'eye', 'glance', 'squash', 'stretchAt', 'wakeAt', 'recoilAt', 'grab', 'carried', 'anchor', 'headAt', 'middleAt', 'drawn', 'tinies', 'tiniesAt'] as const) {
				;(worm as unknown as Record<string, unknown>)[key] = prev[key]
			}
			worm.startleSeen = prev.startleSeen
			if (prev.asleep && !peer.user.asleep && worm.mode !== 'emerge') worm.wakeAt = now
			prev.el.remove()
			this.worms.delete(prev.id)
			if (this.press?.worm === prev) this.press.worm = worm
			return
		}
		if (this.reducedMotion.matches) return
		const age = rec ? Date.now() - rec.createdAt : Infinity
		if (peer.user.asleep && (age > FRESH_MS || (rec && rec.createdAt < this.bornAt - 2000))) return
		this.emerge(worm, now)
	}

	/** Pops up out of the canvas at its goal. */
	private emerge(worm: Worm, now: number) {
		worm.mode = 'emerge'
		worm.modeAt = now
		worm.walk = null
		worm.dive = null
		const z = this.editor.camera.peek().z
		worm.hole = worm.goal ? (worm.goal.x - worm.root.x) * z : 0
		worm.body.set(this.risen(worm, 0))
	}

	/** Dives into the canvas, to pop up at `to` (or gone, leaving). */
	private dive(worm: Worm, now: number, to: Vec | null) {
		if (worm.mode === 'emerge') this.settle(worm)
		worm.mode = 'dive'
		worm.modeAt = now
		worm.walk = null
		worm.dive = { from: worm.body.p.map((p) => ({ ...p })), to }
		worm.hole = worm.body.p[0].x
	}

	/** Ends an emerge or dive where it is. */
	private settle(worm: Worm) {
		if (worm.mode === 'dive' && worm.dive) worm.body.set(worm.dive.from)
		if (worm.mode === 'emerge') worm.body.set(this.risen(worm, 1))
		worm.mode = 'here'
		worm.dive = null
	}

	private leave(worm: Worm, now: number) {
		worm.leaving = true
		worm.el.classList.add('leaving')
		if (this.press?.worm === worm) {
			this.press = null
			this.container?.classList.remove('conjure-dragging')
		}
		this.letGo(worm)
		if (this.reducedMotion.matches) worm.gone = true
		else this.dive(worm, now, null)
	}

	private revive(worm: Worm, now: number) {
		worm.leaving = false
		worm.gone = false
		worm.el.classList.remove('leaving')
		if (worm.mode === 'dive' && !worm.dive?.to) {
			this.settle(worm)
			this.emerge(worm, now)
		}
	}

	private syncLabel(worm: Worm, peer: Peer, now: number) {
		if (worm.color !== peer.user.color) {
			worm.color = peer.user.color
			worm.palette = palette(worm.color)
			worm.tinyColor = mixColor(worm.color, 255, 0.3)
			worm.stressColor = mixColor(worm.color, 255, 0.45)
			worm.label.style.background = worm.color
			worm.el.style.setProperty('--agent-color', worm.color)
		}
		if (worm.nameText !== peer.user.name) {
			worm.nameText = peer.user.name
			worm.name.textContent = worm.nameText
		}
		const speaking = !!peer.speaking && !!peer.chat
		let speech = speaking ? peer.chat! : null
		let speechSent = !!peer.chatSent
		let replayed = false
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
			// A reply reopened from the prompt box ("Show last reply"), until the worm moves on.
			const sessionId = peer.user.sessionId
			const replay = sessionId ? this.conjure?.replays.get(sessionId) : undefined
			if (replay && (peer.chat ?? null) !== replay.baseChat) this.conjure!.replays.delete(sessionId!)
			else if (replay) {
				speech = replay.text
				speechSent = true
				replayed = true
				worm.dismissed = null
			}
			// A dismissed (or auto-hidden) reply stays hidden until the worm says something else.
			if (worm.dismissed !== null && speech !== worm.dismissed) worm.dismissed = null
		}
		const hidden = worm.dismissed !== null
		this.syncSpeech(worm, hidden ? null : speech, speechSent)
		if (replayed) worm.speechPinned = true
		if (worm.conjured) {
			// Working: the thought cloud, or while it's saying something, a little "•••" in the bubble.
			worm.el.classList.toggle('thinking', worm.thinking && !worm.bubble)
			worm.el.classList.toggle('working', worm.thinking && !!worm.bubble)
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

	/** Opens, extends, replaces or closes the speech bubble. */
	private syncSpeech(worm: Worm, text: string | null, sent: boolean) {
		if (text === null) {
			if (worm.bubble) {
				const bubble = worm.bubble
				bubble.classList.add('closing')
				setTimeout(() => bubble.remove(), this.reducedMotion.matches ? 0 : SPEECH_CLOSE_MS)
				worm.bubble = worm.bubbleText = worm.bubbleScroll = null
				worm.speech = []
				worm.speechText = null
				worm.speechPinned = false
				worm.speechDoneAt = 0
			}
			return
		}
		worm.speechText = text
		const chars = Array.from(text)
		if (!worm.bubble) {
			worm.bubble = document.createElement('div')
			worm.bubble.className = 'agent-worm-speech'
			worm.bubbleScroll = document.createElement('div')
			worm.bubbleScroll.className = 'agent-worm-speech-scroll'
			worm.bubbleText = document.createElement('div')
			worm.bubbleText.className = 'agent-worm-speech-text'
			worm.bubbleScroll.appendChild(worm.bubbleText)
			worm.bubble.appendChild(worm.bubbleScroll)
			if (worm.conjured) {
				const working = document.createElement('div')
				working.className = 'agent-worm-speech-working'
				working.title = 'Still working'
				working.innerHTML = '<i></i><i></i><i></i>'
				worm.bubble.appendChild(working)
				this.makeDismissable(worm, worm.bubble)
			}
			// Links in it are for clicking, not for starting a selection on the canvas underneath.
			else worm.bubble.addEventListener('pointerdown', (e) => (e.target as Element).closest?.('a') && e.stopPropagation())
			worm.el.appendChild(worm.bubble)
			worm.speech = []
			// Arriving at a message that's already finished: show it whole.
			worm.speechShown = sent ? chars.length : 0
			worm.speechDrawn = -1
			worm.speechPinned = false
			worm.speechDoneAt = 0
		} else if (chars.length < worm.speech.length || worm.speech.some((c, i) => chars[i] !== c)) {
			// A new message replaced the one showing: type it from the start. (A long reply that only
			// keeps its end drops characters off the front as it grows: keep showing it whole.)
			const kept = chars[0] === '…' && worm.speech[0] === '…'
			worm.speechShown = kept ? chars.length : 0
			worm.speechDrawn = -1
			if (!kept) {
				worm.speechPinned = false
				worm.speechDoneAt = 0
			}
		}
		worm.speech = chars
		worm.speechDone = sent
		worm.bubble.classList.toggle('done', sent)
	}

	/** Conjured worms' replies can be long: they scroll, and × puts them away. */
	private makeDismissable(worm: Worm, bubble: HTMLDivElement) {
		const close = document.createElement('button')
		close.className = 'agent-worm-speech-close'
		close.title = 'Dismiss'
		close.textContent = '×'
		close.addEventListener('click', () => {
			const text = worm.speechText
			if (text === null) return
			worm.dismissed = text
			this.syncSpeech(worm, null, true)
			const sessionId = this.conjure?.peer(worm.id)?.user.sessionId
			if (sessionId) {
				this.conjure?.replays.delete(sessionId)
				this.conjure?.dismiss(sessionId)
			}
		})
		bubble.appendChild(close)
		// Once the pointer has been over it, it stays until ×.
		bubble.addEventListener('pointerenter', () => {
			if (worm.bubble === bubble) worm.speechPinned = true
		})
		// Scrolling and clicking the bubble shouldn't pan or select on the canvas underneath.
		for (const type of ['pointerdown', 'wheel', 'dblclick'] as const) bubble.addEventListener(type, (e) => e.stopPropagation())
	}

	/** Types the speech out locally, smoothing over the server's bursts. */
	private typeSpeech(worm: Worm, elapsed: number) {
		const total = worm.speech.length
		if (this.reducedMotion.matches) worm.speechShown = total
		else {
			const behind = total - worm.speechShown
			worm.speechShown = Math.min(total, worm.speechShown + (Math.max(TYPE_CPS, behind * 4) * elapsed) / 1000)
		}
		const shown = Math.floor(worm.speechShown)
		if (shown !== worm.speechDrawn && worm.bubbleText) {
			const scroll = worm.bubbleScroll
			// Follow the text as it types, unless someone scrolled up to read.
			const atEnd = !scroll || scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 24
			worm.speechDrawn = shown
			renderSpeech(worm.bubbleText, worm.speech.slice(0, shown).join(''))
			if (scroll && atEnd) scroll.scrollTop = scroll.scrollHeight
		}
		// Caught up with a working session that's off doing something else (tools, more steps): it
		// isn't talking, it's thinking (see 'working'), until the next text or the end of the turn.
		const typing = shown < total || (!worm.speechDone && !worm.thinking)
		worm.bubble?.classList.toggle('typing', typing)
		return typing
	}

	/** A finished reply nobody pinned goes away after a while, here only; a new one shows again. */
	private autoHide(worm: Worm, talking: boolean, now: number) {
		if (talking || !worm.speechDone || worm.thinking || worm.speechPinned) {
			worm.speechDoneAt = 0
			return
		}
		if (!worm.speechDoneAt) worm.speechDoneAt = now
		else if (now - worm.speechDoneAt > REPLY_HIDE_MS && worm.speechText !== null) {
			worm.dismissed = worm.speechText
			this.syncSpeech(worm, null, true)
		}
	}

	// ---------- moving ----------

	private step(worm: Worm, now: number, elapsed: number) {
		const still = this.reducedMotion.matches
		const z = this.editor.camera.peek().z
		const ease = (ms: number) => (still ? 1 : 1 - Math.exp(-elapsed / ms))

		const talking = worm.bubble ? this.typeSpeech(worm, elapsed) : false
		if (worm.conjured && worm.bubble) this.autoHide(worm, talking, now)
		worm.talk += ((talking ? 1 : 0) - worm.talk) * ease(120)
		// Busy until its session is idle, whether or not it's saying something meanwhile.
		worm.think += ((worm.thinking ? 1 : 0) - worm.think) * ease(200)

		// Clicked (here or elsewhere, see Conjure.startled): a quick recoil.
		if (worm.startledAt !== worm.startleSeen) {
			worm.startleSeen = worm.startledAt
			if (now - worm.startledAt < 300 && worm.mode === 'here' && !still) this.recoil(worm, now)
		}

		if (!this.fights.holds(worm, now) && !this.slaps.holds(worm, now)) {
			this.locomote(worm, now, elapsed, z)
			this.maybeFidget(worm, now)
			this.agonise(worm, now)
		}
		const body = worm.body
		if (worm.mode === 'emerge' || worm.mode === 'dive') this.kinematic(worm, now)
		else {
			const pose = this.posture(worm, now, z)
			if (still) {
				if (worm.mode === 'carried' && worm.carried && worm.grab) {
					// Held still: the resting pose, hung from the pointer.
					const at = this.toLocal(worm, worm.carried)
					const g = pose.shape[worm.grab.i]
					body.set(pose.shape.map((p) => ({ x: p.x - g.x + at.x, y: p.y - g.y + at.y })))
				} else body.set(pose.shape)
			} else {
				body.target = pose.shape
				body.k = pose.k
				body.weights = pose.weights ?? null
				body.pose += ((pose.limp ? 0 : 1) - body.pose) * ease(pose.limp ? 50 : 240)
				body.stretch += ((pose.stretch ?? 1) - body.stretch) * ease(160)
				body.ground = worm.mode !== 'carried'
				body.wriggle = worm.mode === 'carried' ? 480 : 0
				body.impact = 0
				body.run(elapsed)
				if (worm.mode === 'falling' && body.touching) this.land(worm)
				else if (worm.mode === 'here' && body.impact > 500) worm.squash = Math.max(worm.squash, Math.min(0.6, (body.impact - 500) / 1200))
			}
		}
		this.recentre(worm, z)
		this.fights.step(worm, now, elapsed, z)
		this.slaps.step(worm, now)
		worm.squash *= 1 - ease(110)
		this.eyes(worm, now, elapsed)
	}

	/**
	 * Keeps the creature's frame on its body: root (page) follows the body's middle, and the body,
	 * its feet and hole shift back the other way, so nothing moves on screen.
	 */
	private recentre(worm: Worm, z: number) {
		if (worm.mode === 'emerge' || worm.mode === 'dive') return
		const p = worm.body.p
		const mx = p.reduce((a, v) => a + v.x, 0) / p.length
		const my = worm.mode === 'carried' ? p.reduce((a, v) => a + v.y, 0) / p.length : 0
		if (Math.abs(mx) < 1e-4 && Math.abs(my) < 1e-4) return
		worm.root = { x: worm.root.x + mx / z, y: worm.root.y + my / z }
		worm.body.shift(-mx, -my)
		const w = worm.walk
		if (w) {
			w.tail -= mx
			w.head -= mx
			w.from -= mx
			w.pivot -= mx
		}
	}

	/** A page point in the creature's frame (screen px from its root). */
	private toLocal(worm: Worm, at: Vec): Vec {
		const z = this.editor.camera.peek().z
		return { x: (at.x - worm.root.x) * z, y: (at.y - worm.root.y) * z }
	}

	/** Heads for the goal: walking, sliding over a little, or burrowing when it's far. Carried, it's held. */
	private locomote(worm: Worm, now: number, elapsed: number, z: number) {
		const still = this.reducedMotion.matches
		const body = worm.body
		if (worm.mode === 'carried') {
			if (worm.carried && worm.grab) body.hold(worm.grab.i, this.toLocal(worm, worm.carried))
			return
		}
		body.hold(null)
		const goal = worm.goal
		if (worm.mode !== 'here' || worm.leaving || !goal) return
		if (still) {
			worm.root = { ...goal }
			worm.walk = null
			return
		}
		if (worm.landedAt) {
			// Righting itself after a fall: wait till it has, then stay there (see stayPut).
			if (now - worm.landedAt < SETTLE_MS) return
			worm.landedAt = 0
			this.stayPut(worm)
		}
		if (worm.walk) return this.advance(worm, now, z)
		const dx = (goal.x - worm.root.x) * z
		const dy = (goal.y - worm.root.y) * z
		const dist = Math.hypot(dx, dy)
		if (dist <= NUDGE_PX) {
			// Close enough: it slides over (see posture), and the ground glides under it.
			worm.root.y += (goal.y - worm.root.y) * (1 - Math.exp(-elapsed / 120))
			return
		}
		if (dist > CRAWL_MAX || (!this.onScreen(worm.root, 80) && !this.onScreen(goal, 80))) return this.dive(worm, now, goal)
		const p = body.p
		const walk: Walk = { phase: 'gather', at: now, dur: 0, tail: p[POINTS - 1].x, head: p[0].x, from: 0, stride: 0, y0: 0, y1: 0, ms: STRIDE_MS, pivot: 0, flipped: false }
		if (this.stride(worm, walk, now, z, true)) worm.walk = walk
	}

	/** Plans the next stride (or turn) toward the goal; false when it's there. */
	private stride(worm: Worm, walk: Walk, now: number, z: number, first = false): boolean {
		const goal = worm.goal!
		const f = worm.facing
		const gx = (goal.x - worm.root.x) * z
		const dy = (goal.y - worm.root.y) * z
		const ahead = f * (gx - (walk.tail + walk.head) / 2)
		if (ahead < -TURN_PX) {
			walk.phase = 'turn'
			walk.at = now
			walk.dur = TURN_MS
			walk.pivot = (walk.tail + walk.head) / 2
			walk.flipped = false
			return true
		}
		const fwd = Math.max(0, ahead)
		if (fwd < 4 && Math.abs(dy) < 4) return false
		const n = Math.max(1, Math.ceil(Math.max(fwd, Math.abs(dy)) / STRIDE))
		walk.stride = (f * fwd) / n
		walk.y0 = worm.root.y
		walk.y1 = worm.root.y + (goal.y - worm.root.y) / n
		walk.ms = Math.max(STRIDE_MIN_MS, STRIDE_MS - Math.hypot(fwd, dy) * 1.3)
		walk.at = now
		walk.dur = walk.ms / 2
		// Standing or curled up, it starts by reaching out; lying long, by gathering up its tail.
		const reach = first && Math.abs(walk.head - walk.tail) < LENGTH * 0.55
		walk.phase = reach ? 'reach' : 'gather'
		walk.from = reach ? walk.head : walk.tail
		return true
	}

	private advance(worm: Worm, now: number, z: number) {
		const walk = worm.walk!
		const p = worm.body.p
		const e = Math.min(1, (now - walk.at) / walk.dur)
		if (walk.phase === 'turn') {
			if (!walk.flipped && e > 0.42) {
				worm.facing = -worm.facing
				walk.flipped = true
				walk.tail = p[POINTS - 1].x
			}
			if (e < 1) return
			walk.tail = p[POINTS - 1].x
			walk.head = p[0].x
			if (!this.stride(worm, walk, now, z, true)) worm.walk = null
			return
		}
		const s = easeInOutSine(e)
		if (walk.phase === 'gather') walk.tail = walk.from + walk.stride * s
		else walk.head = walk.from + walk.stride * s
		// Up or down the screen, the ground glides with the stride.
		const progress = walk.phase === 'gather' ? e * 0.5 : 0.5 + e * 0.5
		worm.root.y = walk.y0 + (walk.y1 - walk.y0) * easeInOutSine(progress)
		if (e < 1) return
		if (walk.phase === 'gather') {
			walk.phase = 'reach'
			walk.at = now
			walk.dur = walk.ms / 2
			walk.from = walk.head
			return
		}
		if (!this.stride(worm, walk, now, z)) worm.walk = null
	}

	/**
	 * Thinking (busy, not talking): how it writhes. Worked up in waves, with calmer breaths between,
	 * and now and then a fit: it clenches up tight and trembles, then strains up tall; or it bows
	 * over with its head pressed down. Saying something meanwhile (the bubble is up), it keeps it
	 * down to a mild squirm so the text stays easy to read.
	 */
	private agonise(worm: Worm, now: number) {
		const still = this.reducedMotion.matches
		const busy = worm.think > 0.5 && worm.talk < 0.3 && worm.mode === 'here' && !worm.walk && !worm.asleep
		if (!busy) {
			worm.writhe = null
			worm.fit = null
			worm.nextFit = 0
			return
		}
		const calm = !!worm.bubble
		if (still) {
			// a single scrunched-up pose
			worm.writhe = { t: 0, intensity: 0.7, clench: 0.25, strain: 0, press: 0.15, calm }
			return
		}
		const t = now / 1000 + worm.seed
		// waves of frustration, and calmer breaths
		const intensity = Math.min(1, Math.max(0.12, 0.6 + 0.5 * wobble(t * 0.17 + 11)))
		if (!worm.nextFit) worm.nextFit = now + 1500 + Math.random() * 2000
		if (!calm && !worm.fit && now > worm.nextFit) {
			worm.fit = { kind: Math.random() < 0.55 ? 'clench' : 'press', at: now }
			worm.nextFit = now + FIT_GAP_MS * (0.6 + Math.random()) * (1.4 - intensity * 0.6)
		}
		let clench = 0
		let strain = 0
		let press = 0
		const fit = worm.fit
		if (fit) {
			const u = (now - fit.at) / FIT_MS[fit.kind]
			if (u >= 1 || calm) worm.fit = null
			else if (fit.kind === 'clench') {
				// bunching up tight, trembling; then straining up tall
				clench = u < 0.55 ? smoothstep(u / 0.2) : 1 - smoothstep((u - 0.55) / 0.15)
				strain = u < 0.55 ? 0 : Math.sin(Math.PI * Math.min(1, (u - 0.55) / 0.45))
			} else press = Math.sin(Math.PI * u) ** 0.6
		}
		const k = calm ? 0.3 : 1
		worm.writhe = { t, intensity: intensity * k, clench: clench * k, strain: strain * k, press: press * k, calm }
	}

	private maybeFidget(worm: Worm, now: number) {
		const idle = worm.mode === 'here' && !worm.walk && !worm.asleep && !worm.calls && !worm.listening && worm.think < 0.1 && worm.talk < 0.05
		if (!idle || this.reducedMotion.matches) {
			worm.nextFidget = Math.max(worm.nextFidget, now + 3000)
			return
		}
		if (now < worm.nextFidget) return
		worm.fidget = Math.random() < 0.55 ? 'peek' : 'scrunch'
		worm.fidgetAt = now
		worm.nextFidget = now + FIDGET_EVERY_MS * (0.7 + Math.random())
		// peeking round, it looks about
		if (worm.fidget === 'peek') worm.nextGlance = now
	}

	/** Clicked: it flinches back and up. */
	private recoil(worm: Worm, now: number) {
		worm.recoilAt = now
		const f = worm.facing
		for (let i = 0; i < 7; i++) {
			const k = 1 - i / 7
			worm.body.push(i, -f * 120 * k, -330 * k)
		}
	}

	/** The pose for what it's doing. */
	private posture(worm: Worm, now: number, z: number): Posture {
		const still = this.reducedMotion.matches
		const t = still ? 0 : now / 1000 + worm.seed
		const f = worm.facing
		const gx = worm.goal && worm.mode === 'here' && !worm.walk ? (worm.goal.x - worm.root.x) * z : 0
		if (worm.mode === 'carried' || (worm.mode === 'falling' && !still)) return { shape: place(idlePose(t), f, 0), k: 0, limp: true }
		const fighting = this.fights.posture(worm, now, z) ?? this.slaps.posture(worm, now, z)
		if (fighting) return fighting
		const walk = worm.walk
		if (walk && !still) {
			if (walk.phase === 'turn') {
				const e = (now - walk.at) / walk.dur
				// It rears up, then flops over the other way.
				if (!walk.flipped) return { shape: place(standPose(0, 0.2 + 0.6 * e), f, walk.pivot), k: 260, weights: footWeights(4) }
				return { shape: place(flatPose({ x: 0, y: -TAIL_R }), f, walk.tail), k: 170, weights: footWeights(3) }
			}
			const e = Math.min(1, (now - walk.at) / walk.dur)
			const gather = walk.phase === 'gather'
			const lift = Math.sin(Math.PI * e)
			const a = { x: walk.tail, y: -TAIL_R - (gather ? 4 * lift : 0) }
			const b = { x: walk.head, y: -HEAD_R - (gather ? 0 : 7 * lift) }
			const w = Array.from({ length: POINTS }, (_, i) => {
				if (i < 2) return gather ? 5 : 2
				if (i > POINTS - 3) return gather ? 2 : 5
				return 1
			})
			return { shape: archPose(a, b), k: 300, weights: w }
		}
		const wake = (now - worm.wakeAt) / WAKE_MS
		const stretch = (now - worm.stretchAt) / STRETCH_MS
		if (!still && ((wake >= 0 && wake < 1) || (stretch >= 0 && stretch < 1))) {
			// Up on its tail, stretching tall, head tipped back, then down to rest.
			const u = wake >= 0 && wake < 1 ? wake : stretch
			const tall = Math.sin(Math.PI * Math.min(1, u * 1.15))
			if (u < 0.8) return { shape: place(standPose(0.12 * Math.sin(u * 9), -0.35 * tall, LENGTH), f, gx), k: 230, weights: footWeights(4), stretch: 1 + 0.12 * tall }
		}
		if (!still && now - worm.recoilAt < RECOIL_MS) {
			return { shape: archPose({ x: gx - f * LENGTH * 0.2, y: -TAIL_R }, { x: gx + f * LENGTH * 0.18, y: -HEAD_R - 4 }), k: 420, stretch: 0.92 }
		}
		if (worm.asleep) return { shape: place(curlPose(Math.sin(t * 1.25)), f, gx), k: 150 }
		const calling = worm.calls > 0 && !worm.el.classList.contains('attending')
		if (calling) {
			// Up and waving its head side to side: over here!
			const wave = Math.sin(t * 4.4)
			return { shape: place(standPose(0.55 * wave, 0.15 - 0.35 * wave), f, gx), k: 260, weights: footWeights(4) }
		}
		if (worm.writhe) {
			// Thinking: up on its tail, writhing in frustration (see agonise).
			const w = worm.writhe
			return { shape: place(writhePose(w), f, gx), k: w.calm ? 200 : 300, weights: footWeights(4), stretch: 1 + 0.1 * w.strain - 0.06 * w.clench }
		}
		if (worm.talk > 0.05) {
			// Head up, bobbing along with the text as it types.
			const beat = worm.speechShown * 0.7
			const nod = still ? 0 : Math.sin(beat) * worm.talk
			return { shape: place(idlePose(t, worm.talk * (0.9 + 0.35 * nod), 0.5 * nod), f, gx), k: 260 }
		}
		const fidget = (now - worm.fidgetAt) / FIDGET_MS
		if (!still && !worm.listening && fidget >= 0 && fidget < 1) {
			const u = Math.sin(Math.PI * fidget)
			if (worm.fidget === 'scrunch' && fidget < 0.5) {
				// bunching up into a hump, as if to set off, then thinking better of it
				const foot = LENGTH * (0.86 - 0.36 * Math.sin(Math.PI * fidget * 2))
				return { shape: archPose({ x: gx - (f * foot) / 2, y: -TAIL_R }, { x: gx + (f * foot) / 2, y: -HEAD_R }), k: 230 }
			}
			if (worm.fidget === 'peek') return { shape: place(idlePose(t, 1.3 * u, -0.25 * u), f, gx), k: 200 }
		}
		return { shape: place(idlePose(t, worm.listening ? 0.4 : 0), f, gx), k: 170 }
	}

	/** Emerging (rising straight up out of its hole) and diving (slurped down it). */
	private kinematic(worm: Worm, now: number) {
		const still = this.reducedMotion.matches
		const e = (now - worm.modeAt) / (worm.mode === 'emerge' ? EMERGE_MS : DIVE_MS)
		const body = worm.body
		if (worm.mode === 'emerge') {
			if (still || e >= 1) {
				body.set(this.risen(worm, 1))
				worm.mode = 'here'
				worm.modeAt = now
				if (!still) worm.stretchAt = now
				return
			}
			body.set(this.risen(worm, e))
			return
		}
		const dive = worm.dive!
		if (still || e >= 1) {
			if (dive.to && !worm.leaving) {
				// Under the canvas and up again over there, facing the way it went.
				const to = worm.goal ?? dive.to
				if (Math.abs(to.x - worm.root.x) > 1e-6) worm.facing = Math.sign(to.x - worm.root.x)
				worm.root = { ...to }
				worm.dive = null
				this.emerge(worm, now)
			} else worm.gone = true
			return
		}
		// Down the hole head first, the rest following along its own body.
		const from = dive.from
		const deep = LENGTH + 12
		const path: Vec[] = [{ x: worm.hole, y: deep }, { x: worm.hole, y: -HEAD_R }, ...from]
		const cum = [0]
		for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y))
		const travel = cum[cum.length - 1] - cum[1] + HEAD_R + TAIL_R * 2 + 2
		const pull = travel * e * e
		body.set(from.map((_, i) => along(path, cum, cum[i + 2] - pull)))
	}

	/** Rising out of the hole, u 0..1: straight up, head first, with a little overshoot and wobble. */
	private risen(worm: Worm, u: number): Vec[] {
		const rise = u >= 1 ? 1 : easeOutBack(u)
		const depth = (1 - rise) * (LENGTH + 10)
		return Array.from({ length: POINTS }, (_, i) => {
			const k = 1 - i / (POINTS - 1)
			return {
				x: worm.hole + 2.2 * Math.sin(u * 14 + i * 0.6) * (1 - u) * k,
				y: -TAIL_R - (POINTS - 1 - i) * (LENGTH / (POINTS - 1)) + depth,
			}
		})
	}

	/** Where the eye looks, how open it is, and its blinks. */
	private eyes(worm: Worm, now: number, elapsed: number) {
		const still = this.reducedMotion.matches
		const eye = worm.eye
		const f = worm.facing
		const t = now / 1000 + worm.seed
		const startle = still ? 0 : startleAmount(worm, now)
		const head = worm.drawn[0] ?? this.editor.pageToScreen(worm.root)
		const toward = (p: Vec): Vec => {
			const dx = p.x - head.x
			const dy = p.y - head.y
			const l = Math.hypot(dx, dy) || 1
			return { x: dx / l, y: dy / l }
		}
		const stare = this.pointer && !this.press && Math.hypot(this.pointer.x - head.x, this.pointer.y - head.y) < STARE_PX ? this.pointer : null
		const calling = worm.calls > 0 && !worm.el.classList.contains('attending')
		let look: Vec
		let lid = 0.3
		let wide = 0
		let slant = 0
		let squeeze = 0
		const fighting = this.fights.eye(worm, now) ?? this.slaps.eye(worm, now)
		if (fighting) ({ look, lid, wide, slant, squeeze } = fighting)
		else if (worm.mode === 'carried') {
			// Panicking: darting about, mostly down at the drop.
			if (now > worm.nextDart) {
				const a = Math.PI / 2 + (Math.random() - 0.5) * 2.6
				worm.dart = { x: Math.cos(a), y: Math.sin(a) }
				worm.nextDart = now + 110 + Math.random() * 170
			}
			look = worm.dart
			lid = 0
			wide = 1
		} else if (worm.mode === 'falling') {
			look = { x: 0, y: 1 }
			lid = 0
			wide = 1
		} else if (startle > 0) {
			look = { x: 0, y: 0 }
			lid = 0
			wide = startle
		} else if (worm.mode === 'emerge' || worm.mode === 'dive') {
			look = { x: 0.3 * f, y: -0.7 }
			lid = 0.15
		} else if (worm.asleep) {
			look = { x: 0, y: 0.4 }
			lid = 1
		} else if (worm.walk) {
			look = { x: 0.85 * f, y: 0.35 }
			lid = 0.25
		} else if (calling) {
			look = stare ? toward(stare) : { x: 0.3 * Math.sin(t * 2.2), y: 0.2 }
			lid = 0
			wide = 0.7
		} else if (worm.writhe) {
			// Scrunched up and furrowed, rolling upward with strain and darting about; screwed shut in a fit.
			const w = worm.writhe
			if (now > worm.nextDart) {
				worm.dart = { x: (Math.random() - 0.5) * 0.7, y: (Math.random() - 0.5) * 0.5 }
				worm.nextDart = now + 180 + Math.random() * 520
			}
			const k = w.calm ? 0.3 : 1
			// (kept below the half-shut lid, so it stays in sight)
			look = { x: 0.7 * wobble(t * 0.8 + 5) + worm.dart.x * k, y: 0.15 + 0.4 * wobble(t * 0.6 + 21) + worm.dart.y * k * 0.5 }
			const shut = Math.max(w.clench * (1 - w.strain), w.press)
			lid = (w.calm ? 0.3 : 0.42 + 0.12 * w.intensity) + (1 - 0.42) * Math.min(1, shut * 1.6)
			slant = w.calm ? 0.25 : 0.45
			squeeze = shut > 0.4 ? 1 : 0
			wide = 0
		} else if (worm.talk > 0.05) {
			look = { x: 0.55 * f + 0.3 * Math.sin(t * 3.1), y: -0.45 + 0.25 * Math.sin(t * 4.7) }
			lid = 0.15 + 0.55 * Math.pow(Math.max(0, Math.sin(t * 2.3)), 10)
		} else if (worm.listening) {
			look = { x: -0.2, y: 0.95 }
			lid = 0.1
		} else if (stare) {
			look = toward(stare)
			lid = 0.12
		} else {
			if (now > worm.nextGlance) {
				const box = worm.focus
				if (box && Math.random() < 0.6) {
					const c = this.editor.pageToScreen({ x: box.x + box.w / 2, y: box.y + box.h / 2 })
					worm.glance = toward(c)
				} else {
					const a = (f > 0 ? 0 : Math.PI) + (Math.random() - 0.5) * 2.4
					worm.glance = { x: Math.cos(a) * 0.9, y: Math.sin(a) * 0.6 }
				}
				worm.nextGlance = now + 900 + Math.random() * 2600
			}
			look = worm.glance
		}
		if (!still && worm.mode !== 'carried' && !worm.asleep && now > worm.nextBlink) {
			worm.blinkStart = now
			worm.nextBlink = now + (calling ? 1600 : 2000 + Math.random() * 3600)
		}
		const blink = (now - worm.blinkStart) / 170
		if (!still && blink >= 0 && blink < 1) lid = Math.max(lid, Math.sin(Math.PI * blink))
		const k = still ? 1 : 1 - Math.exp(-elapsed / (worm.mode === 'carried' ? 28 : 60))
		eye.look = { x: eye.look.x + (look.x - eye.look.x) * k, y: eye.look.y + (look.y - eye.look.y) * k }
		eye.lid += (lid - eye.lid) * (still ? 1 : blink >= 0 && blink < 1 ? 1 : 1 - Math.exp(-elapsed / 70))
		eye.wide += (wide - eye.wide) * (still ? 1 : 1 - Math.exp(-elapsed / 90))
		eye.slant = (eye.slant ?? 0) + (slant - (eye.slant ?? 0)) * (still ? 1 : 1 - Math.exp(-elapsed / 120))
		eye.squeeze = squeeze
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

	// ---------- subagents' tiny loopers ----------

	/** Adds tiny loopers for subagents that started and sends off those whose subagent finished. */
	private syncTinies(worm: Worm, subagents: SubagentInfo[], now: number) {
		const ids = new Set(subagents.map((s) => s.id))
		for (const tiny of worm.tinies.values()) {
			if (!ids.has(tiny.id) && !tiny.leaving) {
				tiny.leaving = true
				tiny.leaveStart = now
			}
		}
		subagents.forEach((s, slot) => {
			const tip = s.agent ? `${s.title || 'Subagent'} · @${s.agent}` : s.title || 'Subagent'
			let tiny = worm.tinies.get(s.id)
			if (!tiny || tiny.leaving) {
				const seed = Math.random() * 1000
				const dir = slot % 2 ? -1 : 1
				const start = (Math.random() - 0.5) * TINY_RANGE
				tiny = {
					id: s.id,
					tip,
					seed,
					slot,
					scale: 0,
					popStart: now,
					leaving: false,
					leaveStart: 0,
					head: start + (dir * TINY_FOOT) / 2,
					tail: start - (dir * TINY_FOOT) / 2,
					dir,
					phase: 'gather',
					at: now + Math.random() * TINY_STRIDE_MS * 0.5,
					from: start - (dir * TINY_FOOT) / 2,
					screen: { x: -1e9, y: -1e9 },
					fade: 1,
				}
				worm.tinies.set(s.id, tiny)
			}
			tiny.slot = slot
			tiny.tip = tip
		})
	}

	/**
	 * Moves and draws the tiny loopers by `mid` (screen, the ground under the parent): those behind
	 * it (layer "back", moving them all) before it and those in front ("front") after.
	 */
	private drawTinies(worm: Worm, now: number, mid: Vec, layer: 'back' | 'front') {
		const ctx = this.ctx
		const alpha = ctx.globalAlpha
		const still = this.reducedMotion.matches
		if (layer === 'back') worm.tiniesAt = now
		for (const tiny of [...worm.tinies.values()]) {
			if (layer === 'back' && !this.moveTiny(worm, tiny, now)) continue
			const lane = TINY_LANES[tiny.slot % TINY_LANES.length]
			if ((layer === 'front') !== lane > 0) continue
			const size = TINY_SIZE * tiny.scale
			if (size < 0.02) continue
			// Leaving, it wriggles off outward.
			const away = (tiny.leaving ? 1 + 1.4 * Math.pow(Math.min(1, (now - tiny.leaveStart) / TINY_LEAVE_MS), 2) : 1) * this.fights.scatter(worm, now)
			const y = mid.y + lane * away
			const tr = TAIL_R * size
			const hr = HEAD_R * size
			const e = still ? 0 : Math.min(1, Math.max(0, (now - tiny.at) / (tiny.phase === 'turn' ? TINY_TURN_MS : TINY_STRIDE_MS / 2)))
			const lift = Math.sin(Math.PI * e)
			const a = { x: mid.x + tiny.tail * away, y: y - tr - (tiny.phase === 'gather' ? 2 * lift : 0) }
			let b = { x: mid.x + tiny.head * away, y: y - hr - (tiny.phase === 'reach' ? 3 * lift : 0) }
			if (tiny.phase === 'turn') {
				// up and over its tail to face the other way
				const th = Math.PI * easeInOutSine(e)
				b = { x: a.x + tiny.dir * TINY_FOOT * Math.cos(th), y: y - hr - TINY_FOOT * 1.1 * Math.sin(th) }
			}
			const pts = archPose(a, b, TINY_POINTS, LENGTH * size)
			// a soft shadow under it
			ctx.globalAlpha = alpha * tiny.fade * 0.16
			ctx.fillStyle = '#000'
			ctx.beginPath()
			ctx.ellipse((a.x + b.x) / 2, y + 0.5, Math.abs(b.x - a.x) / 2 + 3, 1.6, 0, 0, Math.PI * 2)
			ctx.fill()
			ctx.globalAlpha = alpha * tiny.fade
			drawTiny(ctx, pts, size, worm.tinyColor, { x: Math.sign(b.x - a.x) * 0.8 || 0, y: 0.2 })
			tiny.screen = { ...pts[0] }
		}
		ctx.globalAlpha = alpha
	}

	/** One tiny looper's step along its lane; false once it has gone (and is removed). */
	private moveTiny(worm: Worm, tiny: Tiny, now: number) {
		const still = this.reducedMotion.matches
		if (tiny.leaving) {
			const u = still ? 1 : (now - tiny.leaveStart) / TINY_LEAVE_MS
			if (u >= 1 || worm.asleep) {
				worm.tinies.delete(tiny.id)
				if (this.tipFor === tiny) this.tipFor = null
				return false
			}
			tiny.fade = 1 - u
			tiny.scale = 1 - 0.5 * u
		} else {
			const popT = Math.min(1, (now - tiny.popStart) / POP_MS)
			tiny.scale = still ? 1 : easeOutBack(popT)
		}
		if (still) return true
		// Inching: the tail gathers up behind the head, then the head reaches on; at the end of its
		// lane it rears up over its tail and heads back.
		for (;;) {
			const dur = tiny.phase === 'turn' ? TINY_TURN_MS : TINY_STRIDE_MS / 2
			if (now - tiny.at < dur) break
			tiny.at += dur
			if (tiny.phase === 'gather') {
				tiny.tail = tiny.from + tiny.dir * TINY_STRIDE
				tiny.phase = 'reach'
				tiny.from = tiny.head
			} else if (tiny.phase === 'reach') {
				tiny.head = tiny.from + tiny.dir * TINY_STRIDE
				const end = tiny.dir * tiny.head > TINY_RANGE
				tiny.phase = end ? 'turn' : 'gather'
				tiny.from = tiny.tail
			} else {
				tiny.dir = -tiny.dir
				tiny.head = tiny.tail + tiny.dir * TINY_FOOT
				tiny.phase = 'gather'
				tiny.from = tiny.tail
			}
		}
		const e = easeInOutSine((now - tiny.at) / (TINY_STRIDE_MS / 2))
		if (tiny.phase === 'gather') tiny.tail = tiny.from + tiny.dir * TINY_STRIDE * e
		else if (tiny.phase === 'reach') tiny.head = tiny.from + tiny.dir * TINY_STRIDE * e
		return true
	}

	/** The tooltip of the tiny looper under the pointer, following it. */
	private showTip() {
		let best: Tiny | null = null
		const p = this.pointer
		if (p && !this.press) {
			let bestD = TINY_HOVER_PX + (this.tipFor ? 4 : 0)
			for (const worm of this.worms.values()) {
				if (worm.leaving || worm.asleep) continue
				for (const tiny of worm.tinies.values()) {
					if (tiny.leaving || tiny.scale < 0.5) continue
					const d = Math.hypot(tiny.screen.x - p.x, tiny.screen.y - p.y)
					if (d < bestD) {
						bestD = d
						best = tiny
					}
				}
			}
		}
		if (best !== this.tipFor) {
			this.tipFor = best
			this.tip.hidden = !best
			if (best) this.tip.textContent = best.tip
		}
		if (best) this.tip.style.transform = `translate(${best.screen.x}px, ${best.screen.y - 10}px) translate(-50%, -100%)`
	}

	// ---------- drawing ----------

	private draw(worm: Worm, now: number, elapsed: number) {
		if (worm.asleep && !this.fights.awake(worm, now) && !this.slaps.awake(worm, now)) return this.drawFaded(worm, now, elapsed, 0.5)
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
		const at = this.editor.pageToScreen(worm.root)
		const R = 120
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
		const ctx = this.ctx
		const ground = this.editor.pageToScreen(worm.root)
		// A landing squashes it flat and wide for a moment, about the ground under its middle.
		const sq = worm.squash
		const sx = 1 + 0.14 * sq
		const sy = 1 - 0.26 * sq
		const pts = worm.body.p.map((p) => ({ x: ground.x + p.x * sx, y: ground.y + p.y * sy }))
		const writhe = worm.writhe
		if (writhe && !this.reducedMotion.matches) {
			// a shiver over the writhing, stronger in a clench
			const amp = (writhe.calm ? 0.15 : 0.35 + 0.9 * writhe.clench) * writhe.intensity
			pts.forEach((p, i) => {
				const f = i / (POINTS - 1)
				p.x += Math.sin(now * 0.071 + i * 1.7) * amp * (1 - f * 0.7)
				p.y += Math.sin(now * 0.063 + i * 2.3 + 1) * amp * 0.5 * (1 - f * 0.7)
			})
		}
		if (worm.tinies.size) this.drawTinies(worm, now, ground, 'back')

		const kinematic = worm.mode === 'emerge' || worm.mode === 'dive'
		if (worm.mode === 'here' || worm.mode === 'falling') {
			// its shadow, fainter the higher it is
			let lo = Infinity
			let hi = -Infinity
			let bottom = -Infinity
			pts.forEach((p, i) => {
				lo = Math.min(lo, p.x)
				hi = Math.max(hi, p.x)
				bottom = Math.max(bottom, p.y + radius(i / (POINTS - 1)))
			})
			const height = Math.max(0, ground.y - bottom)
			ctx.save()
			ctx.globalAlpha *= 0.2 * Math.max(0, 1 - height / 90)
			ctx.fillStyle = '#000'
			ctx.beginPath()
			ctx.ellipse((lo + hi) / 2, ground.y + 0.5, (hi - lo) / 2 + 5, 2.6, 0, 0, Math.PI * 2)
			ctx.fill()
			ctx.restore()
		}
		if (kinematic) {
			// the hole it comes out of or goes down
			const e = (now - worm.modeAt) / (worm.mode === 'emerge' ? EMERGE_MS : DIVE_MS)
			const open = worm.mode === 'emerge' ? Math.min(1, (1 - e) / 0.35, e / 0.1) : Math.min(1, e / 0.15, (1 - e) / 0.12)
			ctx.save()
			ctx.globalAlpha *= 0.55 * Math.max(0, open)
			ctx.fillStyle = '#000'
			ctx.beginPath()
			ctx.ellipse(ground.x + worm.hole, ground.y, 10 * Math.max(0.3, open), 3, 0, 0, Math.PI * 2)
			ctx.fill()
			ctx.restore()
			ctx.save()
			ctx.beginPath()
			ctx.rect(-1e5, -1e5, 2e5, 1e5 + ground.y + 0.5)
			ctx.clip()
		}
		const stress = writhe && !writhe.calm ? { amount: Math.min(1, 0.35 + writhe.intensity * 0.5 + writhe.clench + writhe.press), t: this.reducedMotion.matches ? 0 : now / 1000 + worm.seed, color: worm.stressColor } : undefined
		const samples = drawLooper(ctx, pts, worm.eye, worm.palette, 1, true, stress)
		if (kinematic) ctx.restore()
		if (worm.tinies.size) this.drawTinies(worm, now, ground, 'front')

		worm.drawn = pts
		const n = samples.length
		worm.hit = []
		for (let i = 0; i < n; i += 2) {
			if (kinematic && samples[i].y > ground.y) continue
			worm.hit.push({ x: samples[i].x, y: samples[i].y, r: radius(i / (n - 1)) + 1 })
		}
		this.placeLabels(worm, pts, ground, elapsed)
	}

	/**
	 * Where the name tag hangs (under it, on the ground), and the head and middle of its body from
	 * there (CSS --hx/--hy and --mx/--my), which the bubbles, thought cloud, zzz and ring follow.
	 * Placed from this frame's camera (`ground`, its root on screen), so they move with the canvas
	 * exactly; only how they sit on the body is eased, in the creature's own frame.
	 */
	private placeLabels(worm: Worm, pts: Vec[], ground: Vec, elapsed: number) {
		const still = this.reducedMotion.matches
		let lo = Infinity
		let hi = -Infinity
		let top = Infinity
		let bottom = -Infinity
		pts.forEach((p, i) => {
			const r = radius(i / (POINTS - 1))
			lo = Math.min(lo, p.x - ground.x)
			hi = Math.max(hi, p.x - ground.x)
			top = Math.min(top, p.y - ground.y - r)
			bottom = Math.max(bottom, p.y - ground.y + r)
		})
		const off = worm.mode === 'carried' || worm.mode === 'falling'
		const want = { x: (lo + hi) / 2, y: off ? Math.max(0, bottom) : 0 }
		const k = (ms: number) => (still || !worm.anchor ? 1 : 1 - Math.exp(-elapsed / ms))
		const a = worm.anchor ?? want
		worm.anchor = { x: a.x + (want.x - a.x) * k(45), y: a.y + (want.y - a.y) * k(45) }
		const anchor = worm.anchor
		const head = { x: pts[0].x - ground.x - anchor.x, y: Math.min(pts[0].y - ground.y, 0) - HEAD_R - anchor.y }
		// The bubbles follow the head, but not every little bob of it.
		worm.headAt = { x: worm.headAt.x + (head.x - worm.headAt.x) * k(110), y: worm.headAt.y + (head.y - worm.headAt.y) * k(110) }
		worm.middleAt = { x: (lo + hi) / 2 - anchor.x, y: (Math.max(top, -90) + Math.min(bottom, 0)) / 2 - anchor.y }
		const el = worm.el
		el.style.transform = `translate(${ground.x + anchor.x}px, ${ground.y + anchor.y}px)`
		el.style.setProperty('--hx', `${worm.headAt.x.toFixed(1)}px`)
		el.style.setProperty('--hy', `${worm.headAt.y.toFixed(1)}px`)
		el.style.setProperty('--mx', `${worm.middleAt.x.toFixed(1)}px`)
		el.style.setProperty('--my', `${worm.middleAt.y.toFixed(1)}px`)
		// Zoomed out, the bubbles shrink toward where they attach (the creature and its name tag don't).
		const bubbleScale = Math.min(1, this.editor.camera.peek().z / FULL_BUBBLE_ZOOM)
		if (bubbleScale !== worm.bubbleScale) {
			worm.bubbleScale = bubbleScale
			el.style.setProperty('--bubble-scale', String(bubbleScale))
		}
	}
}

/** Speech as Markdown, with the typing caret after its last character (shown while typing, see CSS). */
function renderSpeech(el: HTMLElement, text: string) {
	el.innerHTML = markdownToHtml(text)
	const caret = document.createElement('span')
	caret.className = 'agent-worm-caret'
	const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
	let last: Node | null = null
	for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent!.trim()) last = n
	if (last) last.parentNode!.insertBefore(caret, last.nextSibling)
	else el.appendChild(caret)
}

/** Same spot, give or take the server rounding it to whole page units. */
function near(a: Vec, b: Vec) {
	return Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1
}

/** 1 right after a creature is startled, easing to 0 over STARTLE_MS. */
function startleAmount(worm: Worm, now: number) {
	const t = (now - worm.startledAt) / STARTLE_MS
	return t >= 0 && t < 1 ? 1 - t * t : 0
}

/** Heavier tail points, to keep a standing creature's foot planted. */
function footWeights(n: number) {
	return Array.from({ length: POINTS }, (_, i) => (i >= POINTS - n ? 3 : 1))
}

/** The point `s` along a polyline (with cumulative lengths `cum`). */
function along(path: Vec[], cum: number[], s: number): Vec {
	if (s <= 0) return { ...path[0] }
	let i = 1
	while (i < cum.length - 1 && cum[i] < s) i++
	const f = Math.min(1, (s - cum[i - 1]) / (cum[i] - cum[i - 1] || 1))
	return { x: path[i - 1].x + (path[i].x - path[i - 1].x) * f, y: path[i - 1].y + (path[i].y - path[i - 1].y) * f }
}

function smoothstep(t: number) {
	const u = Math.min(1, Math.max(0, t))
	return u * u * (3 - 2 * u)
}

function easeInOutSine(t: number) {
	return -(Math.cos(Math.PI * Math.min(1, Math.max(0, t))) - 1) / 2
}

function easeOutBack(t: number) {
	const c = 1.9
	return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2)
}
