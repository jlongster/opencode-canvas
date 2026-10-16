import type { Editor } from '../editor/Editor'
import { markdownToHtml } from '../ui/markdown'
import type { Box, Vec } from '../editor/geometry'
import type { Attention } from './Attention'
import type { Conjure } from './Conjure'
import type { Peer, SubagentInfo } from './Presence'
import {
	HEAD_R as BF_HEAD_R,
	SWEEP,
	THORAX,
	WING,
	disc,
	drawAntennae,
	drawBody,
	drawBurst,
	drawCocoon,
	drawShell,
	drawWing,
	ellipse,
	pt,
	sparkle,
	wingSpan,
	type Colors,
	type Pose,
} from './Butterfly'

/** Body joints, head first. Spacing and sizes are screen pixels, so worms look the same at any zoom. */
const JOINTS = 9
const SPACING = 5.2
const HEAD_R = 8.5
const TAIL_R = 3.2
const OUTLINE = 1.6
/** Where the head rests, relative to the top-right corner of what the agent is working on. */
const PERCH: Vec = { x: 14, y: -12 }
/** Trips longer than this (screen px), or entirely off-screen, burrow and pop up instead of crawling. */
const SNAP_PX = 2400
/** Goal moves smaller than this are followed directly rather than with a new trip. */
const NUDGE_PX = 26
const CHAT_MS = 5000
const POP_MS = 380
/** local typewriter speed for speech, catching up faster when it falls behind what has arrived */
const TYPE_CPS = 36
const SPEECH_CLOSE_MS = 220
/** creatures' worm bodies are drawn this much bigger than the base sizes above */
const CONJURED_SIZE = 1.4
/** how long the startled face lasts after a conjured worm is clicked */
const STARTLE_MS = 1100
/** extra screen px around the body that still counts as clicking the worm */
const HIT_SLOP = 4
/** a press on a conjured worm that moves further than this (screen px) drags it instead of clicking */
const DRAG_PX = 5
/** a dropped worm stays where it was put this long at most while waiting for its new position to come back */
const PIN_MS = 5000
/** pull on a carried worm's body, in screen px/s², so it dangles and swings */
const GRAVITY = 2600
/** a conjured worm's finished reply puts itself away (locally) after this long, unless it's pinned */
const REPLY_HIDE_MS = 7000
/** subagents' tiny worms: body size (of a base-size worm), joints and spacing (screen px) */
const TINY_SIZE = 0.56
const TINY_JOINTS = 6
const TINY_SPACING = 3.4
/** how far from the middle of the parent's body they roam, screen px */
const TINY_ORBIT = 54
/** wriggling away when its subagent finishes */
const TINY_LEAVE_MS = 520
/** how close the pointer has to be to a tiny worm's head for its tooltip, screen px */
const TINY_HOVER_PX = 11
/** zoom at and above which speech bubbles are full size; below it they shrink with the canvas */
const FULL_BUBBLE_ZOOM = 0.6
/** butterflies are drawn this much bigger than conjured worms, wings and all, for about the same heft */
const BUTTERFLY_SIZE = 1.15
/** a freshly conjured session's metamorphosis: worm, chrysalis, butterfly */
const MORPH_MS = 1500
/** within the metamorphosis: when the worm starts wrapping up, the chrysalis is done, and it bursts */
const MORPH_WRAP = 0.3
const MORPH_POD = 0.53
const MORPH_BURST = 0.77
/** records created longer ago than this were there already: no metamorphosis */
const FRESH_MS = 15000
/** a butterfly stretching its wings (waking up, coming out of the chrysalis) */
const STRETCH_MS = 900
/** an idle butterfly's occasional flutter hop */
const HOP_MS = 700
/** calling for attention (queued actions): a flutter hop this often, awake or not */
const CALL_HOP_MS = 1700
const DEG = Math.PI / 180

interface Trip {
	from: Vec
	to: Vec
	/** bend of the path, as a fraction of its length, so worms take a squirrely curve rather than a ruler line */
	bend: number
	start: number
	duration: number
	/** inchworm pulses over the trip; whole numbers so the warped clock still ends at 1 */
	pulses: number
}

/** A subagent's tiny worm, roaming around its parent. Positions are screen px from the parent's middle. */
interface Tiny {
	id: string
	tip: string
	seed: number
	/** its place among the parent's tiny worms, which spreads them around */
	slot: number
	scale: number
	popStart: number
	leaving: boolean
	leaveStart: number
	head: Vec
	joints: Vec[]
	wigglePhase: number
	heading: Vec
	/** its head on screen as last drawn, for hovering */
	screen: Vec
	/** 1, fading to 0 as it leaves */
	fade: number
}

interface Worm {
	id: number
	color: string
	palette: { base: string; dark: string; light: string }
	/** page-space joints; [0] is the head */
	joints: Vec[]
	head: Vec
	goal: Vec | null
	/** the box the agent is working on, for the eye to glance at */
	focus: Box | null
	trip: Trip | null
	/** 0..1 how much the worm is moving, eased, drives wiggle and stretch */
	motion: number
	stretch: number
	wigglePhase: number
	heading: Vec
	pupil: Vec
	pupilVel: Vec
	nextBlink: number
	blinkStart: number
	/** pop-in / burrow-out scale */
	scale: number
	popFrom: number
	popStart: number
	leaving: boolean
	seed: number
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
	/** 0..1 how much it's talking, eased, drives the mouth and head bob */
	talk: number
	/** a conjured worm (an OpenCode session people can prompt): bigger, sits still, clickable on edit links */
	conjured: boolean
	/** body size multiplier */
	size: number
	/** conjured: nobody runs it right now (no owner tab open): drawn dimmed, eyes shut, snoozing */
	asleep: boolean
	/** conjured: its session is working on a prompt, and 0..1 eased for the animation */
	thinking: boolean
	think: number
	/** when it was last startled (clicked) */
	startledAt: number
	/** its prompt box is open */
	listening: boolean
	/** the "•••" thought cloud while thinking */
	thought: HTMLDivElement
	bubbleScroll: HTMLDivElement | null
	/** a reply dismissed with × (locally), hidden until the worm says something else */
	dismissed: string | null
	/** the full chat text behind the bubble, and whether it's finished */
	speechText: string | null
	/** conjured: the bubble stays up until × (the pointer went over it, or it was reopened) */
	speechPinned: boolean
	/** conjured: when the reply finished (typed out, nothing more coming), 0 while it isn't */
	speechDoneAt: number
	/** the speech bubbles' and thought cloud's scale for the zoom, last set on el as --bubble-scale */
	bubbleScale: number
	/** screen-space discs covering the body as last drawn, for clicks */
	hit: { x: number; y: number; r: number }[]
	/** where it's being dragged to (page space), while someone here carries it */
	carried: Vec | null
	/** 0..1 how much it's being carried, eased */
	carry: number
	/** head velocity while carried, screen px/s, smoothed */
	carryVel: Vec
	/** where it was dropped, held until its presence catches up */
	pinned: { at: Vec; until: number } | null
	/** joints on the previous frame, so a carried body swings with momentum */
	prevJoints: Vec[]
	/** conjured: tiny worms for its busy subagents, by session id, and when they last moved */
	tinies: Map<string, Tiny>
	tiniesAt?: number
	sessionId: string | null
	/** conjured sessions are butterflies; the rest is theirs */
	butterfly: boolean
	bf: Flight
	/** how many attention actions its session has queued: while any are, it calls (badge, ring, hops), awake */
	calls: number
	/** the count badge, while it calls */
	badge: HTMLButtonElement | null
}

/** A butterfly's pose and wingbeat. */
interface Flight {
	colors: Colors
	/** how far the wings are open (radians): 0 folded upright, ~90° spread flat, beyond that beating down */
	phi: number
	flapPhase: number
	/** hovering height above where it sits, screen px, eased */
	alt: number
	/** which way it faces (1 right, -1 left), and that eased, so it turns through edge-on */
	facing: number
	face: number
	/** nose-up tilt, radians, eased */
	tilt: number
	/** 0..1 eased: folded up asleep */
	sleepy: number
	nextHop: number
	hopStart: number
	stretchStart: number
	morphStart: number
	/** when its record was created (conjured), to tell a new one of the same session from the last */
	conjuredAt: number
	/** the ground under it on screen, which subagents' tiny worms circle */
	center: Vec
}

/** A pointer that went down on a conjured worm: a click unless it moves, then a drag. */
interface Press {
	pointerId: number
	worm: Worm
	start: Vec
	/** head minus pointer, screen px, so the worm stays where it was grabbed */
	offset: Vec
	dragging: boolean
}

/**
 * Sessions' creatures (real OpenCode sessions, see Conjure): googly-eyed butterflies that sit where
 * they were put (see Butterfly.ts), hatching from a worm's chrysalis when they arrive while you
 * watch. Their busy subagents are tiny worms crawling around them. Bodies are drawn on one 2D canvas
 * in screen space; the name label, bubbles and badges are DOM, like human cursor labels.
 *
 * A creature whose session queued something for attention (see Attention) calls for it where it
 * sits, even asleep: a count badge, a soft pulsing ring and a flutter hop now and then. Clicking it
 * (or the badge) opens its walkthrough.
 */
export class AgentWorms {
	private canvas: HTMLCanvasElement
	private ctx: CanvasRenderingContext2D
	/** where sleeping butterflies are drawn before they're dimmed onto the canvas */
	private scratch: HTMLCanvasElement | null = null
	private labels: HTMLDivElement
	private worms = new Map<number, Worm>()
	private drewLastFrame = false
	private reducedMotion: MediaQueryList
	/** the canvas container, whose clicks on conjured worms we take before the editor sees them */
	private container: HTMLElement | null
	/** pointers that went down on a worm: their pointerup isn't the editor's either */
	private swallowed = new Set<number>()
	private press: Press | null = null
	private disposers: (() => void)[] = []
	/** the pointer over the canvas (screen space), for tiny worms' tooltips */
	private pointer: Vec | null = null
	private tip: HTMLDivElement
	private tipFor: Tiny | null = null
	/** when this page started showing worms (wall clock), to tell sessions conjured since from ones already here */
	private bornAt = Date.now()

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
		this.labels.appendChild(this.tip)
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
			// on a worm never reaches it; everywhere else passes straight through. (View links only
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
				if (worm.butterfly) this.arrive(worm, peer, now)
				this.worms.set(peer.clientId, worm)
			}
			if (worm.leaving) this.revive(worm, now)
			this.syncCalls(worm, now)
			const placed = peer.user.sessionId ? this.conjure?.placing.get(peer.user.sessionId) : undefined
			if (placed) {
				// Summoned here (C): crawl over now rather than waiting for the record to come back.
				this.conjure!.placing.delete(peer.user.sessionId!)
				worm.pinned = { at: placed, until: now + PIN_MS }
			}
			if (worm.pinned && (now > worm.pinned.until || (peer.cursor && near(peer.cursor, worm.pinned.at)))) worm.pinned = null
			if (target) {
				worm.goal = worm.carried ?? worm.pinned?.at ?? target.point
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
			if (worm.leaving && worm.scale <= 0.001) {
				worm.el.remove()
				this.worms.delete(worm.id)
				continue
			}
			this.draw(worm, now)
		}
		this.showTip()
	}

	destroy() {
		for (const d of this.disposers.splice(0)) d()
		this.container?.classList.remove('conjure-hover', 'conjure-dragging')
		this.canvas.remove()
		this.labels.remove()
		this.worms.clear()
	}

	// ---------- clicking and dragging conjured worms ----------

	/** The topmost conjured worm under a point in client coordinates. */
	private hitTest(clientX: number, clientY: number): Worm | null {
		const rect = this.canvas.getBoundingClientRect()
		const x = clientX - rect.left
		const y = clientY - rect.top
		const worms = [...this.worms.values()].reverse()
		for (const worm of worms) {
			if (!worm.conjured || worm.leaving || worm.scale < 0.5) continue
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
		const head = this.editor.pageToScreen(worm.head)
		this.press = { pointerId: e.pointerId, worm, start: at, offset: { x: head.x - at.x, y: head.y - at.y }, dragging: false }
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
		const at = worm.carried
		worm.carried = null
		const sessionId = peer?.user.sessionId
		// A cancelled drag (or a worm that left meanwhile) goes back where it was.
		if (!at || !sessionId || e.type !== 'pointerup') return
		const drop = { x: Math.round(at.x), y: Math.round(at.y) }
		worm.pinned = { at: drop, until: performance.now() + PIN_MS }
		this.conjure!.move(sessionId, drop).catch((err) => {
			console.error('moving the worm failed', err)
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
			}
			press.worm.carried = this.editor.screenToPage({ x: at.x + press.offset.x, y: at.y + press.offset.y })
			return
		}
		if (this.swallowed.has(e.pointerId)) return e.stopPropagation()
		const over = e.buttons === 0 && this.overCanvas(e) && !!this.hitTest(e.clientX, e.clientY)
		this.container?.classList.toggle('conjure-hover', over)
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
		const worm: Worm = {
			id: peer.clientId,
			color: '',
			palette: palette('#22d3ee'),
			joints: [],
			head: { ...at },
			goal: { ...at },
			focus: null,
			trip: null,
			motion: 0,
			stretch: 1,
			wigglePhase: seed,
			heading: { x: 1, y: 0 },
			pupil: { x: 0, y: 0 },
			pupilVel: { x: 0, y: 0 },
			nextBlink: now + 1500 + Math.random() * 3000,
			blinkStart: -1e9,
			scale: 0,
			popFrom: 0,
			popStart: now,
			leaving: false,
			seed,
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
			size: conjured ? CONJURED_SIZE : 1,
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
			carried: null,
			carry: 0,
			carryVel: { x: 0, y: 0 },
			pinned: null,
			prevJoints: [],
			tinies: new Map(),
			calls: 0,
			badge: null,
			sessionId: peer.user.sessionId ?? null,
			butterfly: conjured,
			bf: {
				colors: wingColors('#22d3ee'),
				phi: peer.user.asleep ? 0 : 40 * DEG,
				flapPhase: seed,
				alt: 0,
				facing: 1,
				face: 1,
				tilt: 0.12,
				sleepy: peer.user.asleep ? 1 : 0,
				nextHop: now + 4000 + Math.random() * 6000,
				hopStart: -1e9,
				stretchStart: -1e9,
				morphStart: -1e9,
				conjuredAt: 0,
				center: { x: -1e9, y: -1e9 },
			},
		}
		el.classList.toggle('butterfly', conjured)
		this.layOut(worm)
		return worm
	}

	/**
	 * A butterfly's arrival: the same session just woke up or nodded off (a new presence, so a new
	 * worm), carrying on where the old one was; or a freshly conjured session, which hatches.
	 */
	private arrive(worm: Worm, peer: Peer, now: number) {
		const rec = worm.sessionId ? this.conjure?.record(worm.sessionId) : undefined
		worm.bf.conjuredAt = rec?.createdAt ?? 0
		// (Banished and conjured again, it's a new one.)
		const prev = worm.sessionId
			? [...this.worms.values()].find((w) => w.sessionId === worm.sessionId && w !== worm && w.bf.conjuredAt === worm.bf.conjuredAt)
			: undefined
		if (prev) {
			worm.head = { ...prev.head }
			worm.joints = prev.joints.map((j) => ({ ...j }))
			worm.heading = { ...prev.heading }
			worm.seed = prev.seed
			worm.scale = worm.popFrom = prev.leaving ? 1 : prev.scale
			worm.popStart = now - POP_MS
			// (A freshly conjured one first shows up asleep, until its owner's tab runs it: it keeps hatching.)
			worm.bf = { ...prev.bf, colors: worm.bf.colors, center: { ...prev.bf.center } }
			const hatching = now - worm.bf.morphStart < MORPH_MS
			if (prev.asleep && !peer.user.asleep && !hatching) worm.bf.stretchStart = now
			prev.el.remove()
			this.worms.delete(prev.id)
			if (this.press?.worm === prev) this.press.worm = worm
			return
		}
		const age = rec ? Date.now() - rec.createdAt : Infinity
		if (!rec || this.reducedMotion.matches || age > FRESH_MS || rec.createdAt < this.bornAt - 2000) return
		worm.bf.morphStart = now
		worm.bf.stretchStart = now + MORPH_MS * MORPH_BURST
	}

	/** Puts the body in a gentle curl trailing down-left of the head, as if it just surfaced. */
	private layOut(worm: Worm) {
		const z = this.editor.camera.peek().z
		worm.joints = []
		for (let i = 0; i < JOINTS; i++) {
			const a = Math.PI * 0.85 + i * 0.12
			worm.joints.push({
				x: worm.head.x + (Math.cos(a) * SPACING * worm.size * i) / z,
				y: worm.head.y + ((Math.sin(-a) * SPACING * i * 0.6 + i * 0.8) * worm.size) / z,
			})
		}
		worm.heading = { x: 1, y: 0 }
	}

	private leave(worm: Worm, now: number) {
		worm.leaving = true
		worm.trip = null
		worm.popFrom = worm.scale
		worm.popStart = now
		worm.el.classList.add('leaving')
	}

	private revive(worm: Worm, now: number) {
		worm.leaving = false
		worm.popFrom = worm.scale
		worm.popStart = now
		worm.el.classList.remove('leaving')
	}

	private syncLabel(worm: Worm, peer: Peer, now: number) {
		if (worm.color !== peer.user.color) {
			worm.color = peer.user.color
			worm.palette = palette(worm.color)
			worm.bf.colors = wingColors(worm.color)
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
	private syncCalls(worm: Worm, now: number) {
		const sessionId = worm.sessionId
		const calls = sessionId && worm.conjured ? (this.attention?.count(sessionId) ?? 0) : 0
		const open = !!sessionId && !!this.attention?.isOpen(sessionId)
		worm.el.classList.toggle('attending', open)
		if (calls === worm.calls) return
		// Starting to call: a first hop right away.
		if (calls && !worm.calls) worm.bf.nextHop = now + 250
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

	private step(worm: Worm, now: number, elapsed: number) {
		const still = this.reducedMotion.matches
		const z = this.editor.camera.peek().z
		const dt = elapsed / 1000

		const talking = worm.bubble ? this.typeSpeech(worm, elapsed) : false
		if (worm.conjured && worm.bubble) this.autoHide(worm, talking, now)
		worm.talk += ((talking ? 1 : 0) - worm.talk) * (1 - Math.exp(-elapsed / 90))
		// Busy until its session is idle, whether or not it's saying something meanwhile.
		worm.think += ((worm.thinking ? 1 : 0) - worm.think) * (1 - Math.exp(-elapsed / 200))
		worm.carry += ((worm.carried ? 1 : 0) - worm.carry) * (1 - Math.exp(-elapsed / 120))

		// Scale: pop in, burrow out.
		const popT = Math.min(1, (now - worm.popStart) / POP_MS)
		const popTo = worm.leaving ? 0 : 1
		worm.scale = still ? popTo : worm.popFrom + (popTo - worm.popFrom) * (worm.leaving ? easeInBack(popT) : easeOutBack(popT))
		if (popT >= 1) worm.scale = popTo

		// Plan or adjust a trip toward the goal; carried, the head just follows the pointer.
		const goal = worm.goal
		if (worm.carried && !worm.leaving) {
			worm.trip = null
			const k = 1 - Math.exp(-elapsed / 35)
			const dx = (worm.carried.x - worm.head.x) * k
			const dy = (worm.carried.y - worm.head.y) * k
			worm.head = { x: worm.head.x + dx, y: worm.head.y + dy }
			if (dt > 0) {
				const v = 1 - Math.exp(-elapsed / 80)
				worm.carryVel.x += ((dx * z) / dt - worm.carryVel.x) * v
				worm.carryVel.y += ((dy * z) / dt - worm.carryVel.y) * v
			}
		} else if (goal && !worm.leaving && still && worm.butterfly) {
			// Reduced motion: no flying about, it's just there.
			worm.trip = null
			worm.head = { ...goal }
		} else if (goal && !worm.leaving) {
			const screenDist = Math.hypot(goal.x - worm.head.x, goal.y - worm.head.y) * z
			if (worm.trip) {
				const moved = Math.hypot(goal.x - worm.trip.to.x, goal.y - worm.trip.to.y) * z
				if (moved > NUDGE_PX) worm.trip = this.plan(worm, goal, now)
				else worm.trip.to = { ...goal }
			} else if (screenDist > NUDGE_PX) {
				if (screenDist > SNAP_PX || (!this.onScreen(worm.head, 80) && !this.onScreen(goal, 80))) {
					// Too far to crawl: pop up there instead.
					worm.head = { ...goal }
					this.layOut(worm)
					worm.popFrom = 0
					worm.popStart = now
					worm.scale = still ? 1 : 0
				} else {
					worm.trip = this.plan(worm, goal, now)
				}
			} else {
				// Small drift (zoom, the item moved a little): follow directly.
				const k = 1 - Math.exp(-elapsed / 90)
				worm.head.x += (goal.x - worm.head.x) * k
				worm.head.y += (goal.y - worm.head.y) * k
			}
		}

		// Advance along the trip.
		let pulse = 0
		const trip = worm.trip
		if (trip) {
			const t = Math.min(1, (now - trip.start) / trip.duration)
			let u = t
			if (!still && !worm.butterfly) {
				// Inchworm clock: surges and pauses, but still lands at u = 1.
				const w = 2 * Math.PI * trip.pulses
				u = t + (0.7 * Math.sin(w * t)) / w
				pulse = Math.cos(w * t)
			}
			const s = easeInOutSine(u)
			worm.head = still ? lerp(trip.from, trip.to, s) : bezier(trip, s)
			if (t >= 1) {
				worm.head = { ...trip.to }
				worm.trip = null
			}
		}
		// Carried, it wriggles (a bit less frantically than crawling).
		const moving = worm.trip ? 1 : worm.carried ? 0.6 : 0
		worm.motion += (moving - worm.motion) * (1 - Math.exp(-elapsed / 160))
		if (!worm.carried) worm.carryVel = { x: worm.carryVel.x * 0.9, y: worm.carryVel.y * 0.9 }

		// Stretch with the inchworm surge (and breathe a little at rest); dangling, it hangs long and thin.
		const breathe = still ? 0 : 0.05 * Math.sin(now / 600 + worm.seed)
		const speed = Math.hypot(worm.carryVel.x, worm.carryVel.y)
		const hang = worm.carry * (0.22 + Math.min(0.25, speed / 4000))
		const targetStretch = still ? 1 : 1 + 0.32 * pulse * worm.motion * (1 - worm.carry) + breathe * (1 - worm.motion) + hang
		worm.stretch += (targetStretch - worm.stretch) * (1 - Math.exp(-elapsed / 50))
		worm.wigglePhase += dt * (still ? 0 : 2.6 + 11 * worm.motion)

		// Follow-the-leader chain in page space, spaced in screen pixels. Carried, the joints keep
		// their momentum and fall, so the body trails behind the pointer and swings below the head.
		const spacing = (SPACING * worm.size * worm.stretch * (worm.leaving ? worm.scale : 1)) / z
		const joints = worm.joints
		const before = joints.map((j) => ({ ...j }))
		if (worm.carried && !still && worm.prevJoints.length === joints.length) {
			const h = Math.min(dt, 0.05)
			const damp = Math.exp(-h * 2.2)
			const fall = (GRAVITY * h * h) / z
			for (let i = 1; i < joints.length; i++) {
				const j = joints[i]
				const p = worm.prevJoints[i]
				joints[i] = { x: j.x + (j.x - p.x) * damp, y: j.y + (j.y - p.y) * damp + fall }
			}
		}
		worm.prevJoints = before
		joints[0] = { ...worm.head }
		for (let i = 1; i < joints.length; i++) {
			const prev = joints[i - 1]
			const dx = joints[i].x - prev.x
			const dy = joints[i].y - prev.y
			const len = Math.hypot(dx, dy)
			if (len < 1e-6) joints[i] = { x: prev.x - spacing, y: prev.y }
			else joints[i] = { x: prev.x + (dx / len) * spacing, y: prev.y + (dy / len) * spacing }
		}

		// Heading: where the neck points, nudged toward the destination while travelling.
		let hx = joints[0].x - joints[1].x
		let hy = joints[0].y - joints[1].y
		if (worm.trip) {
			hx += (worm.trip.to.x - worm.head.x) * 0.02
			hy += (worm.trip.to.y - worm.head.y) * 0.02
		}
		const hl = Math.hypot(hx, hy)
		if (hl > 1e-9) {
			const k = 1 - Math.exp(-elapsed / 70)
			worm.heading.x += (hx / hl - worm.heading.x) * k
			worm.heading.y += (hy / hl - worm.heading.y) * k
			const n = Math.hypot(worm.heading.x, worm.heading.y) || 1
			worm.heading.x /= n
			worm.heading.y /= n
		}

		// Googly pupil: springs toward where it's looking, overshooting a little.
		let look: Vec
		const startle = startleAmount(worm, now)
		if (startle > 0) look = { x: 0, y: 0.0001 }
		// Carried: peering down at the drop, glancing the way it's swung.
		else if (worm.carry > 0.3) look = { x: -worm.carryVel.x / 900, y: 1 }
		else if (worm.think > 0.3 && worm.talk <= 0.05) {
			// Thinking (and not talking): the eye rolls round and round.
			const a = now / 260 + worm.seed
			look = { x: Math.cos(a), y: Math.sin(a) }
		} else if (worm.listening) look = { x: 0.15, y: 1 }
		else if (worm.trip) look = { x: worm.trip.to.x - worm.head.x, y: worm.trip.to.y - worm.head.y }
		else if (worm.focus) {
			// Mostly eyeing the work, with the occasional glance around.
			const glance = Math.sin(now / 1700 + worm.seed) > 0.75
			look = glance
				? { x: Math.cos(now / 900 + worm.seed), y: -0.6 }
				: { x: worm.focus.x + worm.focus.w / 2 - worm.head.x, y: worm.focus.y + worm.focus.h / 2 - worm.head.y }
		} else look = { x: Math.cos(now / 1300 + worm.seed), y: Math.sin(now / 1900 + worm.seed) * 0.6 }
		const ll = Math.hypot(look.x, look.y) || 1
		const reach = startle > 0 ? 0 : 2.6
		const want = { x: (look.x / ll) * reach, y: (look.y / ll) * reach }
		if (still) worm.pupil = want
		else {
			const h = Math.min(dt, 0.05)
			worm.pupilVel.x += ((want.x - worm.pupil.x) * 260 - worm.pupilVel.x * 11) * h
			worm.pupilVel.y += ((want.y - worm.pupil.y) * 260 - worm.pupilVel.y * 11) * h
			worm.pupil.x += worm.pupilVel.x * h
			worm.pupil.y += worm.pupilVel.y * h
			const pl = Math.hypot(worm.pupil.x, worm.pupil.y)
			if (pl > 3) {
				worm.pupil.x *= 3 / pl
				worm.pupil.y *= 3 / pl
			}
		}

		if (!still && now > worm.nextBlink && startle === 0) {
			worm.blinkStart = now
			worm.nextBlink = now + 1800 + Math.random() * 4200
		}
		if (worm.butterfly) this.stepWings(worm, now, elapsed)
	}

	/** A butterfly's wingbeat, hover height, facing and tilt. */
	private stepWings(worm: Worm, now: number, elapsed: number) {
		const bf = worm.bf
		const still = this.reducedMotion.matches
		const ease = (ms: number) => (still ? 1 : 1 - Math.exp(-elapsed / ms))
		const z = this.editor.camera.peek().z
		const trip = worm.trip

		// Facing: the way it's flying or being swung; otherwise as it was.
		if (trip && Math.abs(trip.to.x - trip.from.x) * z > 10) bf.facing = Math.sign(trip.to.x - trip.from.x)
		else if (worm.carried && Math.abs(worm.carryVel.x) > 160) bf.facing = Math.sign(worm.carryVel.x)
		bf.face += (bf.facing - bf.face) * ease(120)

		// Now and then, sitting about, a little flutter hop; calling for attention, one every CALL_HOP_MS
		// (until someone is looking at its walkthrough).
		const calling = worm.calls > 0 && !worm.el.classList.contains('attending') && !trip && !worm.carried && now - bf.morphStart > MORPH_MS
		const idle = !trip && !worm.carried && !worm.thinking && !worm.asleep && worm.talk < 0.05 && now - bf.morphStart > MORPH_MS
		if (calling) {
			if (!still && now > bf.nextHop) {
				bf.hopStart = now
				bf.nextHop = now + CALL_HOP_MS
			}
		} else if (!idle) bf.nextHop = Math.max(bf.nextHop, now + 2500)
		else if (!still && now > bf.nextHop) {
			bf.hopStart = now
			bf.nextHop = now + 6000 + Math.random() * 8000
		}
		const hop = this.hopAmount(worm, now)

		// Hover: up while flying, held aloft while thinking, settling softly when it lands.
		const aloft = worm.asleep || worm.carried ? 0 : trip ? 12 : 9 * worm.think
		bf.alt += (aloft - bf.alt) * ease(trip ? 160 : 260)

		// Wingbeat: slow open-and-close at rest, quick beats flying or carried, a fast shimmer thinking.
		const thinkW = worm.think * (1 - worm.motion) * (1 - worm.carry)
		const energy = Math.min(1, Math.max(worm.motion, worm.carry, worm.think, hop))
		const freq = 0.32 + (5.8 + 3.8 * thinkW - 0.32) * energy
		const center = (38 + (55 + 9 * thinkW - 38) * energy) * DEG
		const amp = (30 + (58 - 28 * thinkW - 30) * energy) * DEG
		bf.flapPhase += (elapsed / 1000) * freq * Math.PI * 2
		bf.sleepy += ((worm.asleep ? 1 : 0) - bf.sleepy) * ease(300)
		let phi = still ? 68 * DEG : center + amp * Math.sin(bf.flapPhase)
		// Folded up, asleep.
		phi += (-6 * DEG - phi) * bf.sleepy
		if (!still) {
			// Stretching them out wide (waking, hatching), or flung open when startled.
			const st = (now - bf.stretchStart) / STRETCH_MS
			if (st >= 0 && st < 1) phi += (100 * DEG - phi) * Math.pow(Math.sin(Math.PI * st), 0.6)
			const startle = startleAmount(worm, now)
			if (startle > 0) phi += (100 * DEG - phi) * startle
		}
		bf.phi += (phi - bf.phi) * ease(22)

		// Nose up a little at rest; leaning into a climb or dive; swinging when carried.
		let tilt = worm.asleep ? 0.04 : 0.12
		if (trip) {
			const dx = trip.to.x - trip.from.x
			const dy = trip.to.y - trip.from.y
			tilt += Math.max(-0.3, Math.min(0.3, (-dy / (Math.hypot(dx, dy) || 1)) * 0.3))
		} else if (worm.carried) tilt += Math.max(-0.4, Math.min(0.4, -worm.carryVel.y / 2500))
		bf.tilt += (tilt - bf.tilt) * ease(200)
	}

	/** 0..1..0 over an idle flutter hop. */
	private hopAmount(worm: Worm, now: number) {
		if (this.reducedMotion.matches) return 0
		const t = (now - worm.bf.hopStart) / HOP_MS
		return t >= 0 && t < 1 ? Math.sin(Math.PI * t) : 0
	}

	private plan(worm: Worm, goal: Vec, now: number): Trip {
		const z = this.editor.camera.peek().z
		const dist = Math.hypot(goal.x - worm.head.x, goal.y - worm.head.y) * z
		const duration = worm.butterfly ? Math.min(1700, Math.max(650, 340 + dist * 0.8)) : Math.min(1500, Math.max(500, 260 + dist * 0.95))
		const side = Math.sin(worm.seed + now / 997) > 0 ? 1 : -1
		return {
			from: { ...worm.head },
			to: { ...goal },
			// Butterflies swoop wider.
			bend: side * (0.14 + 0.1 * Math.abs(Math.sin(now / 331))) * (worm.butterfly ? 1.4 : 1),
			start: now,
			duration,
			pulses: Math.max(1, Math.round(duration / 330)),
		}
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

	// ---------- subagents' tiny worms ----------

	/** Adds tiny worms for subagents that started and sends off those whose subagent finished. */
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
				const at = this.tinyTarget(worm, slot, subagents.length, seed, now, 0.4)
				tiny = {
					id: s.id,
					tip,
					seed,
					slot,
					scale: 0,
					popStart: now,
					leaving: false,
					leaveStart: 0,
					head: at,
					joints: Array.from({ length: TINY_JOINTS }, (_, i) => ({ x: at.x - i * TINY_SPACING * 0.8, y: at.y + i * 0.6 })),
					wigglePhase: seed,
					heading: { x: 1, y: 0 },
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
	 * Where a tiny worm is headed: around the parent on a squashed loop, all circling the same way
	 * (spread out by slot), wandering in and out a little. `reach` scales the distance (popping out).
	 */
	private tinyTarget(worm: Worm, slot: number, count: number, seed: number, now: number, reach = 1): Vec {
		const still = this.reducedMotion.matches
		const t = still ? 0 : now / 1000
		const a = worm.seed + (slot / Math.max(1, count)) * Math.PI * 2 + t * 0.45 + (still ? 0 : 0.4 * Math.sin(t * 1.3 + seed))
		const r = (TINY_ORBIT + (still ? 0 : 9 * Math.sin(t * 0.8 + seed * 2))) * reach
		return { x: Math.cos(a) * r * 1.2, y: Math.sin(a) * r * 0.72 }
	}

	/**
	 * Moves and draws the tiny worms around `mid` (screen). Around a butterfly, the ones behind it
	 * (layer "back", moving them) are drawn before it and the ones in front ("front") after.
	 */
	private drawTinies(worm: Worm, now: number, mid: Vec, layer: 'all' | 'back' | 'front' = 'all') {
		const ctx = this.ctx
		const alpha = ctx.globalAlpha
		const still = this.reducedMotion.matches
		const move = layer !== 'front'
		const elapsed = Math.min(100, now - (worm.tiniesAt ?? now))
		if (move) worm.tiniesAt = now
		const count = [...worm.tinies.values()].filter((t) => !t.leaving).length
		const { dark } = worm.palette
		const body = mixColor(worm.color, 255, 0.22)
		for (const tiny of [...worm.tinies.values()]) {
			if (layer !== 'all' && (layer === 'front') !== tiny.head.y > 0) {
				if (move) this.moveTiny(worm, tiny, now, elapsed, count)
				continue
			}
			if (move && !this.moveTiny(worm, tiny, now, elapsed, count)) continue
			const fade = tiny.fade
			const scale = tiny.scale * worm.scale * TINY_SIZE
			if (scale < 0.02) continue
			const amp = still ? 0 : 1.6
			const wiggled = tiny.joints.map((p, i) => {
				const a = tiny.joints[Math.max(0, i - 1)]
				const b = tiny.joints[Math.min(tiny.joints.length - 1, i + 1)]
				const tx = a.x - b.x
				const ty = a.y - b.y
				const tl = Math.hypot(tx, ty) || 1
				const off = amp * Math.sin(tiny.wigglePhase - i * 1.1) * (0.3 + 0.7 * (i / (tiny.joints.length - 1)))
				return { x: mid.x + p.x - (ty / tl) * off, y: mid.y + p.y + (tx / tl) * off }
			})
			const samples = catmullRom(wiggled, 4)
			const n = samples.length
			const radius = (f: number) => (HEAD_R + (TAIL_R - HEAD_R) * Math.pow(f, 1.15)) * scale
			const outline = 1.1 * tiny.scale
			ctx.globalAlpha = alpha * fade
			ctx.fillStyle = 'rgba(0, 0, 0, 0.2)'
			for (let i = n - 1; i >= 0; i--) disc(ctx, samples[i].x, samples[i].y + 1.5, radius(i / (n - 1)) + outline)
			ctx.fillStyle = dark
			for (let i = n - 1; i >= 0; i--) disc(ctx, samples[i].x, samples[i].y, radius(i / (n - 1)) + outline)
			ctx.fillStyle = body
			for (let i = n - 1; i >= 0; i--) disc(ctx, samples[i].x, samples[i].y, radius(i / (n - 1)))
			// One eye, looking where it's going.
			const head = samples[0]
			const hr = radius(0)
			const ex = head.x + tiny.heading.x * hr * 0.25
			const ey = head.y - hr * 0.3
			ctx.fillStyle = '#f8fafc'
			disc(ctx, ex, ey, hr * 0.55)
			ctx.fillStyle = '#111113'
			disc(ctx, ex + tiny.heading.x * hr * 0.2, ey + tiny.heading.y * hr * 0.15, hr * 0.28)
			tiny.screen = { x: head.x, y: head.y }
		}
		ctx.globalAlpha = alpha
	}

	/** One tiny worm's step around its parent; false once it has gone (and is removed). */
	private moveTiny(worm: Worm, tiny: Tiny, now: number, elapsed: number, count: number) {
		const still = this.reducedMotion.matches
		let reach = 1
		let fade = 1
		if (tiny.leaving) {
			const u = still ? 1 : (now - tiny.leaveStart) / TINY_LEAVE_MS
			if (u >= 1 || worm.asleep) {
				worm.tinies.delete(tiny.id)
				if (this.tipFor === tiny) this.tipFor = null
				return false
			}
			// Wriggles off outward and fades.
			reach = 1 + 1.4 * u * u
			fade = 1 - u
			tiny.scale = 1 - 0.5 * u
		} else {
			const popT = Math.min(1, (now - tiny.popStart) / POP_MS)
			tiny.scale = still ? 1 : easeOutBack(popT)
		}
		const target = this.tinyTarget(worm, tiny.slot, Math.max(count, 1), tiny.seed, now, reach)
		if (still) tiny.head = target
		else {
			const k = 1 - Math.exp(-elapsed / (tiny.leaving ? 90 : 220))
			const dx = (target.x - tiny.head.x) * k
			const dy = (target.y - tiny.head.y) * k
			tiny.head = { x: tiny.head.x + dx, y: tiny.head.y + dy }
			const sp = Math.hypot(dx, dy)
			if (sp > 0.05) tiny.heading = { x: dx / sp, y: dy / sp }
			tiny.wigglePhase += (elapsed / 1000) * 14
		}
		// Follow the leader, in screen px.
		tiny.joints[0] = tiny.head
		for (let i = 1; i < tiny.joints.length; i++) {
			const a = tiny.joints[i - 1]
			const b = tiny.joints[i]
			const d = Math.hypot(b.x - a.x, b.y - a.y) || 1
			const spacing = TINY_SPACING * tiny.scale
			if (still || d > spacing) tiny.joints[i] = { x: a.x + ((b.x - a.x) / d) * spacing, y: a.y + ((b.y - a.y) / d) * spacing }
		}
		tiny.fade = fade
		return true
	}

	/** The tooltip of the tiny worm under the pointer, following it. */
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

	private draw(worm: Worm, now: number) {
		if (worm.butterfly && worm.asleep) return this.drawFaded(worm, now)
		this.ctx.save()
		if (worm.asleep) this.ctx.globalAlpha = 0.45
		try {
			if (worm.butterfly) this.drawButterfly(worm, now)
			else {
				if (worm.tinies.size) this.drawTinies(worm, now, this.middle(worm))
				this.drawWorm(worm, now)
			}
		} finally {
			this.ctx.restore()
		}
	}

	/**
	 * A sleeping butterfly, dimmed as a whole: drawn on a scratch layer first, so its overlapping
	 * wings and body don't show through each other.
	 */
	private drawFaded(worm: Worm, now: number) {
		const main = this.ctx
		const dpr = window.devicePixelRatio || 1
		if (!this.scratch) this.scratch = document.createElement('canvas')
		const layer = this.scratch
		if (layer.width !== this.canvas.width || layer.height !== this.canvas.height) {
			layer.width = this.canvas.width
			layer.height = this.canvas.height
		}
		const ctx = layer.getContext('2d')!
		const head = this.editor.pageToScreen(worm.head)
		const R = 160
		const sx = Math.max(0, Math.floor((head.x - R) * dpr))
		const sy = Math.max(0, Math.floor((head.y - R) * dpr))
		const sw = Math.min(layer.width - sx, Math.ceil(R * 2 * dpr))
		const sh = Math.min(layer.height - sy, Math.ceil(R * 2 * dpr))
		ctx.setTransform(1, 0, 0, 1, 0, 0)
		if (sw > 0 && sh > 0) ctx.clearRect(sx, sy, sw, sh)
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
		this.ctx = ctx
		try {
			ctx.save()
			this.drawButterfly(worm, now)
			ctx.restore()
		} finally {
			this.ctx = main
		}
		if (sw <= 0 || sh <= 0) return
		main.save()
		main.globalAlpha = 0.45
		main.drawImage(layer, sx, sy, sw, sh, sx / dpr, sy / dpr, sw / dpr, sh / dpr)
		main.restore()
	}

	/** The middle of a worm's body, on screen. */
	private middle(worm: Worm): Vec {
		const pts = worm.joints.map((j) => this.editor.pageToScreen(j))
		return { x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length }
	}

	/** `shrink` scales it down (curling up into a chrysalis). */
	private drawWorm(worm: Worm, now: number, shrink = 1) {
		const ctx = this.ctx
		const alpha = ctx.globalAlpha
		const still = this.reducedMotion.matches
		const scale = worm.scale * worm.size * shrink
		const { base, dark, light } = worm.palette
		const startle = still ? 0 : startleAmount(worm, now)
		const startleT = (now - worm.startledAt) / STARTLE_MS
		// Startled: a hop straight up and a fast wobble that dies away. Thinking: a slow sway.
		const hop = startle > 0 ? -Math.sin(Math.min(1, startleT * 2.2) * Math.PI) * 16 * worm.size : 0
		const wobble = startle > 0 ? Math.sin(startleT * 42) * 4 * startle * worm.size : 0
		const thinkSway = still ? 0 : Math.sin(now / 700 + worm.seed) * 4 * worm.think * worm.size

		// Joints to screen, then the side-to-side wiggle, strongest toward the tail.
		const pts = worm.joints.map((j) => this.editor.pageToScreen(j))
		const bob = still ? 0 : Math.sin(now / 420 + worm.seed) * 1.6 * (1 - worm.motion)
		// Nodding along while it talks: the head only, fading down the neck.
		const nod = still ? 0 : Math.sin(now / 95 + worm.seed) * 1.5 * worm.talk
		const amp = still ? 0 : 1.4 + 3.6 * worm.motion
		const wiggled = pts.map((p, i) => {
			const a = pts[Math.max(0, i - 1)]
			const b = pts[Math.min(pts.length - 1, i + 1)]
			const tx = a.x - b.x
			const ty = a.y - b.y
			const tl = Math.hypot(tx, ty) || 1
			const f = i / (pts.length - 1)
			const off = amp * Math.sin(worm.wigglePhase - i * 0.95) * (0.25 + 0.75 * f) * scale
			const neck = Math.max(0, 1 - i * 0.4)
			const lift = Math.max(0, 1 - f * 1.6)
			return {
				x: p.x - (ty / tl) * off + (wobble + thinkSway) * lift,
				y: p.y + (tx / tl) * off + (i === 0 ? bob : bob * (1 - f) * 0.6) + nod * neck + hop * lift,
			}
		})
		const samples = catmullRom(wiggled, 5)
		const thin = 1 / Math.sqrt(Math.max(0.6, worm.stretch))
		const radius = (f: number) => (HEAD_R + (TAIL_R - HEAD_R) * Math.pow(f, 1.15)) * thin * scale
		const n = samples.length
		worm.hit = worm.conjured ? samples.map((p, i) => ({ x: p.x, y: p.y, r: radius(i / (n - 1)) + OUTLINE * scale })) : []

		// Shadow, outline, body: tail first so the head ends up on top.
		ctx.fillStyle = 'rgba(0, 0, 0, 0.22)'
		for (let i = n - 1; i >= 0; i--) disc(ctx, samples[i].x, samples[i].y + 2.5 * scale, radius(i / (n - 1)) + OUTLINE * scale)
		ctx.fillStyle = dark
		for (let i = n - 1; i >= 0; i--) disc(ctx, samples[i].x, samples[i].y, radius(i / (n - 1)) + OUTLINE * scale)
		ctx.fillStyle = base
		for (let i = n - 1; i >= 0; i--) disc(ctx, samples[i].x, samples[i].y, radius(i / (n - 1)))

		// Belly stripe along the lower side, then segment rings.
		ctx.lineCap = 'round'
		ctx.strokeStyle = light
		ctx.globalAlpha = 0.55 * alpha
		ctx.lineWidth = 2.2 * scale
		ctx.beginPath()
		const side = normalAt(samples, Math.floor(n / 2)).ny >= 0 ? 1 : -1
		for (let i = Math.floor(n * 0.18); i < n - 2; i++) {
			const { nx, ny } = normalAt(samples, i)
			const r = radius(i / (n - 1)) * 0.45
			const x = samples[i].x + nx * r * side
			const y = samples[i].y + ny * r * side
			if (i === Math.floor(n * 0.18)) ctx.moveTo(x, y)
			else ctx.lineTo(x, y)
		}
		ctx.stroke()
		ctx.globalAlpha = 0.8 * alpha
		ctx.lineWidth = 1.3 * scale
		for (let i = Math.floor(n * 0.25); i < n - 3; i += 4) {
			const { nx, ny } = normalAt(samples, i)
			const r = radius(i / (n - 1)) * 0.78
			ctx.beginPath()
			ctx.moveTo(samples[i].x - nx * r, samples[i].y - ny * r)
			ctx.lineTo(samples[i].x + nx * r, samples[i].y + ny * r)
			ctx.stroke()
		}
		ctx.globalAlpha = alpha

		// Head features. "Up" is screen-up, so the eye stays on top whichever way it faces.
		const head = samples[0]
		const fwd = worm.heading
		const hr = radius(0)
		// The labels and speech bubble follow the head but not its nodding, so the text stays readable.
		this.placeLabels(worm, head.x - wobble, head.y - nod - hop)
		if (scale < 0.05) return

		// Antenna with a twinkling sparkle, like the robot avatar: bolt upright when startled.
		const antennaSway = still ? 0 : Math.sin(now / 260 + worm.seed) * 0.35 + worm.motion * Math.sin(worm.wigglePhase) * 0.3
		const sway = antennaSway * (1 - startle) + (startle > 0 ? Math.sin(startleT * 60) * 0.25 * startle : 0)
		const baseX = head.x - fwd.x * hr * 0.35
		const baseY = head.y - hr * 0.8
		const tipX = baseX - fwd.x * 4 * scale + Math.sin(sway) * 9 * scale
		const tipY = baseY - Math.cos(sway) * 9 * scale
		ctx.strokeStyle = dark
		ctx.lineWidth = 1.5 * scale
		ctx.beginPath()
		ctx.moveTo(baseX, baseY)
		ctx.quadraticCurveTo(baseX - fwd.x * 4 * scale, baseY - 6 * scale, tipX, tipY)
		ctx.stroke()
		const twinkle = still ? 1 : 1 + 0.3 * Math.sin(now / 180 + worm.seed) + 0.5 * startle
		sparkle(ctx, tipX, tipY, 3.6 * scale * twinkle, now / (900 - 650 * worm.think), light, dark)
		this.drawFace(worm, head, fwd, hr, scale, now)
	}

	/**
	 * A conjured session's butterfly: the worm grown up, with the same eye and colours. Freshly
	 * conjured, it first hatches: worm, then a chrysalis that wobbles and bursts open.
	 */
	private drawButterfly(worm: Worm, now: number) {
		const ctx = this.ctx
		const bf = worm.bf
		const still = this.reducedMotion.matches
		const z = this.editor.camera.peek().z
		const morph = still ? 1 : (now - bf.morphStart) / MORPH_MS
		const morphing = morph >= 0 && morph < 1
		const ground = this.editor.pageToScreen(worm.head)
		const startle = still ? 0 : startleAmount(worm, now)
		const startleT = (now - worm.startledAt) / STARTLE_MS
		const hop = startle > 0 ? -Math.sin(Math.min(1, startleT * 2.2) * Math.PI) * 16 * worm.size : 0
		const wobble = startle > 0 ? Math.sin(startleT * 42) * 4 * startle * worm.size : 0

		// Up off the ground: hovering, an arc over the trip, an idle hop; bobbing with the wingbeat.
		const trip = worm.trip
		let arc = 0
		if (trip && !still) {
			const t = Math.min(1, (now - trip.start) / trip.duration)
			arc = Math.sin(Math.PI * t) * Math.min(34, Math.hypot(trip.to.x - trip.from.x, trip.to.y - trip.from.y) * z * 0.12)
		}
		const energy = Math.max(worm.motion, worm.carry, worm.think)
		const bob = still
			? 0
			: Math.sin(now / 520 + worm.seed) * (1.1 + 0.08 * bf.alt) * (1 - worm.carry) * (1 - bf.sleepy) + Math.sin(bf.flapPhase) * 1.5 * energy
		const lift = bf.alt + arc + this.hopAmount(worm, now) * 10
		const size = worm.scale * worm.size * BUTTERFLY_SIZE
		const emerge = !morphing ? 1 : morph < MORPH_BURST ? 0 : 0.35 + 0.65 * easeOutBack((morph - MORPH_BURST) / (1 - MORPH_BURST))
		const s = size * emerge
		const tilt = bf.tilt + (still ? 0 : Math.sin(now / 700 + worm.seed) * 0.08 * worm.think)
		const pose: Pose = {
			o: { x: ground.x + wobble, y: ground.y - lift + bob + hop },
			F: { x: bf.face * Math.cos(tilt), y: -Math.sin(tilt) },
			U: { x: -bf.face * Math.sin(tilt), y: -Math.cos(tilt) },
			s,
		}
		bf.center = { x: ground.x + bf.face * THORAX.x * size, y: ground.y + 4 * size }
		if (worm.tinies.size) this.drawTinies(worm, now, bf.center, 'back')

		const pod = pt({ ...pose, s: size }, THORAX.x, 0)
		if (morphing && morph < MORPH_BURST) this.drawChrysalis(worm, now, morph, pod)
		else if (s >= 0.05) {
			this.drawWings(worm, now, pose, lift, energy, startle)
			if (morphing) {
				const t = (morph - MORPH_BURST) / (1 - MORPH_BURST)
				drawShell(ctx, pod, size, t, bf.colors)
				drawBurst(ctx, pod, size, t, worm.seed, bf.colors)
			}
		} else worm.hit = []

		if (worm.tinies.size) this.drawTinies(worm, now, bf.center, 'front')
		// The labels and bubbles hang off the head, without its bobbing and hopping.
		this.placeLabels(worm, ground.x, ground.y - bf.alt - arc)
	}

	/** The butterfly itself: far wings, body, near wings, head. */
	private drawWings(worm: Worm, now: number, pose: Pose, lift: number, energy: number, startle: number) {
		const ctx = this.ctx
		const alpha = ctx.globalAlpha
		const still = this.reducedMotion.matches
		const bf = worm.bf
		const c = bf.colors
		const { s } = pose

		// Its shadow on the ground, smaller and fainter the higher it flies.
		const ground = { x: pose.o.x + pose.F.x * THORAX.x * s, y: pose.o.y + lift + 8 * s }
		ctx.globalAlpha = alpha * 0.2 * Math.max(0.3, 1 - lift / 50)
		ctx.fillStyle = '#000'
		ellipse(ctx, ground.x, ground.y, 15 * s * (1 - Math.min(0.4, lift / 80)), 3.2 * s)
		ctx.globalAlpha = alpha

		const farRoot = pt(pose, THORAX.x + 2.5, THORAX.y + 2.5)
		const root = pt(pose, THORAX.x + 1, THORAX.y + 2)
		const farSpan = wingSpan(bf.phi, true) * 0.95
		const nearSpan = wingSpan(bf.phi, false)
		// Folded up asleep, they stand straight up.
		const sweep = SWEEP * (1 - 0.9 * bf.sleepy)
		drawWing(ctx, pose, 'hind', farRoot, farSpan, true, c, sweep)
		drawWing(ctx, pose, 'fore', farRoot, farSpan, true, c, sweep)
		drawBody(ctx, pose, c, bf.sleepy + 0.4 * worm.carry)
		drawWing(ctx, pose, 'hind', root, nearSpan, false, c, sweep)
		drawWing(ctx, pose, 'fore', root, nearSpan, false, c, sweep)

		// Antennae (bolt upright when startled), the head, and the worm's sparkle on the near tip.
		const sway = still ? 0 : (Math.sin(now / 300 + worm.seed) * 0.25 + energy * Math.sin(bf.flapPhase) * 0.3) * (1 - startle) - startle * 0.4
		const tip = drawAntennae(ctx, pose, c, sway, 1)
		const hr = BF_HEAD_R * s
		ctx.fillStyle = c.dark
		disc(ctx, pose.o.x, pose.o.y, hr + 1.5 * s)
		ctx.fillStyle = c.base
		disc(ctx, pose.o.x, pose.o.y, hr)
		const twinkle = still ? 1 : 1 + 0.3 * Math.sin(now / 180 + worm.seed) + 0.5 * startle
		sparkle(ctx, tip.x, tip.y, 2.8 * s * twinkle, now / (900 - 650 * worm.think), c.light, c.dark)
		this.drawFace(worm, pose.o, { x: bf.face, y: 0 }, hr, s, now)

		if (!worm.conjured) return
		const hit = [
			{ ...pose.o, r: hr + 1.5 * s },
			{ ...pt(pose, THORAX.x, THORAX.y), r: 7 * s },
			{ ...pt(pose, -19, -2), r: 6 * s },
		]
		for (const [r0, span] of [
			[farRoot, farSpan],
			[root, nearSpan],
		] as const) {
			for (const [p, q, r] of [
				[-3, 13, 11],
				[-11, 8, 8],
			]) {
				const back = sweep * Math.abs(span)
				const w = s * WING
				hit.push({
					x: r0.x + (p * pose.F.x + q * (span * pose.U.x - back * pose.F.x)) * w,
					y: r0.y + (p * pose.F.y + q * (span * pose.U.y - back * pose.F.y)) * w,
					r: r * w * Math.max(0.55, Math.abs(span)),
				})
			}
		}
		worm.hit = hit
	}

	/** Hatching, before the butterfly bursts out: the worm wraps itself up, and the chrysalis wobbles. */
	private drawChrysalis(worm: Worm, now: number, morph: number, pod: Vec) {
		const ctx = this.ctx
		const size = worm.scale * worm.size
		const mid = this.middle(worm)
		const head = this.editor.pageToScreen(worm.joints[0])
		const tail = this.editor.pageToScreen(worm.joints[worm.joints.length - 1])
		let along = Math.atan2(head.y - tail.y, head.x - tail.x)
		if (along > Math.PI / 2) along -= Math.PI
		if (along < -Math.PI / 2) along += Math.PI
		const settle = easeInOutSine((morph - MORPH_WRAP) / (MORPH_BURST - MORPH_WRAP))
		const at = lerp(mid, pod, settle)
		const angle = along * (1 - settle)
		if (morph < MORPH_POD) {
			const wrap = Math.max(0, (morph - MORPH_WRAP) / (MORPH_POD - MORPH_WRAP))
			this.drawWorm(worm, now, 1 - 0.45 * easeInOutSine(wrap))
			if (wrap <= 0) return
			const a = ctx.globalAlpha
			ctx.globalAlpha = a * Math.min(1, wrap * 2.5)
			drawCocoon(ctx, at, size * (0.55 + 0.45 * wrap), angle, wrap, 0, worm.bf.colors)
			ctx.globalAlpha = a
			return
		}
		const t = (morph - MORPH_POD) / (MORPH_BURST - MORPH_POD)
		const shake = Math.sin(now / 38) * 0.2 * t * t
		const crack = Math.max(0, (t - 0.5) / 0.5)
		drawCocoon(ctx, at, size * (1 + 0.05 * Math.sin(now / 60) * t), angle + shake, 1, crack, worm.bf.colors)
		worm.hit = worm.conjured ? [{ ...at, r: 15 * size }] : []
	}

	/** Where the name tag, bubbles and thought cloud hang (screen px), and their scale for the zoom. */
	private placeLabels(worm: Worm, x: number, y: number) {
		worm.el.style.transform = `translate(${x}px, ${y}px)`
		// Zoomed out, the bubbles shrink toward where they attach (the worm and its name tag don't).
		const bubbleScale = Math.min(1, this.editor.camera.peek().z / FULL_BUBBLE_ZOOM)
		if (bubbleScale !== worm.bubbleScale) {
			worm.bubbleScale = bubbleScale
			worm.el.style.setProperty('--bubble-scale', String(bubbleScale))
		}
	}

	/** The googly eye and the mouth (and "!" when startled), on a head of radius hr facing fwd. */
	private drawFace(worm: Worm, head: Vec, fwd: Vec, hr: number, scale: number, now: number) {
		const ctx = this.ctx
		const alpha = ctx.globalAlpha
		const still = this.reducedMotion.matches
		const { dark, light } = worm.palette
		const startle = still ? 0 : startleAmount(worm, now)
		// One big googly eye, bulging when startled and a little wider while listening.
		const ex = head.x + fwd.x * hr * 0.25
		const ey = head.y - hr * 0.22 - hr * 0.12 * startle
		const er = hr * 0.72 * (1 + 0.5 * startle + (worm.listening ? 0.08 : 0))
		const blinkT = (now - worm.blinkStart) / 150
		// asleep: eyes shut (unless something startles it)
		const open = worm.asleep ? Math.max(0, startle) : blinkT >= 0 && blinkT < 1 ? Math.abs(1 - 2 * blinkT) : 1
		ctx.fillStyle = dark
		ellipse(ctx, ex, ey, er + 1.3 * scale, (er + 1.3 * scale) * Math.max(open, 0.25))
		ctx.fillStyle = '#f8fafc'
		ellipse(ctx, ex, ey, er, er * Math.max(open, 0.12))
		if (open > 0.35) {
			const ps = (er / 5.5) * scale / worm.size
			const px = ex + worm.pupil.x * ps
			const py = ey + worm.pupil.y * ps * open
			// a pinprick pupil when startled
			const pr = er * (0.46 - 0.3 * startle)
			ctx.fillStyle = '#111113'
			ellipse(ctx, px, py, pr, pr * open)
			ctx.fillStyle = 'rgba(255, 255, 255, 0.9)'
			disc(ctx, px - pr * 0.33, py - pr * 0.37 * open, pr * 0.28)
		}

		// A small smile under the eye, toward the front; a chattering mouth while it talks, an "o"
		// when startled, a wavering line while it thinks.
		const mx = head.x + fwd.x * hr * 0.55
		const my = head.y + hr * 0.42
		if (startle > 0.05) {
			ctx.fillStyle = dark
			ellipse(ctx, mx, my + 0.5 * scale, 2.1 * scale * (0.6 + 0.4 * startle), 2.8 * scale * startle)
			// and a "!" popping out above
			ctx.save()
			ctx.globalAlpha = Math.min(1, startle * 1.5) * alpha
			ctx.fillStyle = light
			ctx.strokeStyle = dark
			ctx.lineWidth = 2.5
			ctx.font = `800 ${Math.round(15 * worm.size)}px system-ui, sans-serif`
			ctx.textAlign = 'center'
			const bx = head.x + hr * 1.25
			const by = head.y - hr * 1.5 - 6 * startle * worm.size
			ctx.strokeText('!', bx, by)
			ctx.fillText('!', bx, by)
			ctx.restore()
		} else if (worm.carry > 0.3) {
			// a little "o" of surprise at being picked up
			ctx.fillStyle = dark
			ellipse(ctx, mx, my + 0.4 * scale, 1.7 * scale, 2.2 * scale * worm.carry)
		} else if (worm.think > 0.3 && worm.talk <= 0.05) {
			ctx.strokeStyle = dark
			ctx.lineWidth = 1.2 * scale
			ctx.beginPath()
			for (let k = 0; k <= 6; k++) {
				const x = mx - 2.4 * scale + (k / 6) * 4.8 * scale
				const y = my - 0.6 * scale + Math.sin(k * 1.6 + now / 140) * 0.6 * scale
				if (k === 0) ctx.moveTo(x, y)
				else ctx.lineTo(x, y)
			}
			ctx.stroke()
		} else if (worm.talk > 0.05) {
			const flap = still ? 0.6 : 0.5 + 0.3 * Math.sin(now / 62 + worm.seed) + 0.2 * Math.sin(now / 37)
			ctx.fillStyle = dark
			ellipse(ctx, mx, my, 2.4 * scale, (0.5 + 2.1 * flap) * worm.talk * scale)
		} else {
			ctx.strokeStyle = dark
			ctx.lineWidth = 1.2 * scale
			ctx.beginPath()
			ctx.arc(mx, my - 1.6 * scale, 2.2 * scale, Math.PI * 0.2, Math.PI * 0.8)
			ctx.stroke()
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

/** 1 right after a worm is startled, easing to 0 over STARTLE_MS. */
function startleAmount(worm: Worm, now: number) {
	const t = (now - worm.startledAt) / STARTLE_MS
	return t >= 0 && t < 1 ? 1 - t * t : 0
}

/** Unit normal of a polyline at sample i. */
function normalAt(pts: Vec[], i: number) {
	const a = pts[Math.max(0, i - 1)]
	const b = pts[Math.min(pts.length - 1, i + 1)]
	const tx = b.x - a.x
	const ty = b.y - a.y
	const l = Math.hypot(tx, ty) || 1
	return { nx: -ty / l, ny: tx / l }
}

/** Smooth samples through the joints, `per` samples per span. */
function catmullRom(pts: Vec[], per: number): Vec[] {
	const out: Vec[] = []
	for (let i = 0; i < pts.length - 1; i++) {
		const p0 = pts[Math.max(0, i - 1)]
		const p1 = pts[i]
		const p2 = pts[i + 1]
		const p3 = pts[Math.min(pts.length - 1, i + 2)]
		for (let s = 0; s < per; s++) {
			const t = s / per
			const t2 = t * t
			const t3 = t2 * t
			out.push({
				x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
				y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
			})
		}
	}
	out.push(pts[pts.length - 1])
	return out
}

function bezier(trip: Trip, s: number): Vec {
	const { from, to, bend } = trip
	const dx = to.x - from.x
	const dy = to.y - from.y
	const c = { x: (from.x + to.x) / 2 - dy * bend, y: (from.y + to.y) / 2 + dx * bend }
	const u = 1 - s
	return {
		x: u * u * from.x + 2 * u * s * c.x + s * s * to.x,
		y: u * u * from.y + 2 * u * s * c.y + s * s * to.y,
	}
}

function lerp(a: Vec, b: Vec, t: number): Vec {
	return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

function easeInOutSine(t: number) {
	return -(Math.cos(Math.PI * Math.min(1, Math.max(0, t))) - 1) / 2
}

function easeOutBack(t: number) {
	const c = 1.9
	return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2)
}

function easeInBack(t: number) {
	const c = 1.7
	return (c + 1) * t * t * t - c * t * t
}

/** Base colour plus a darker outline and a lighter belly, mixed from any #rgb / #rrggbb. */
function palette(color: string) {
	const rgb = parseHex(color) ?? [34, 211, 238]
	return { base: `rgb(${rgb.join(', ')})`, dark: mixColor(color, 0, 0.62), light: mixColor(color, 255, 0.55) }
}

/** A butterfly's colours: the worm's, plus shaded far wings and a pale chrysalis. */
function wingColors(color: string): Colors {
	return {
		...palette(color),
		far: mixColor(color, 0, 0.14),
		farLight: mixColor(color, 255, 0.4),
		silk: mixColor(color, 255, 0.68),
	}
}

/** The colour mixed toward black (0) or white (255) by k. */
function mixColor(color: string, to: number, k: number) {
	const rgb = parseHex(color) ?? [34, 211, 238]
	return `rgb(${rgb.map((c) => Math.round(c + (to - c) * k)).join(', ')})`
}

function parseHex(color: string): number[] | null {
	const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())
	if (!m) return null
	const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1]
	return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16))
}
