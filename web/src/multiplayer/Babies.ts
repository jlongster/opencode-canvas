import type { Vec } from '../editor/geometry'
import type { SubagentInfo } from './Presence'
import { SIZE, drawBody, drawEye, mixColor, openEye, palette, place, turn, wobble, type EyeState, type Palette } from './Pointer'

/** a baby's length, screen px, and how much bigger its eye is than a grown one's */
const BABY = 12
const EYE = 1.5
/** where they lie, from the parent's middle (screen px): an oval to its lower left, clear of its name tag (lower right) and bubble (above) */
const AREA = { x: -30, y: 14, rx: 34, ry: 20 }
/** the name tag's corner: nothing lies right of x and below y */
const TAG = { x: 8, y: 22 }
/** how far apart their middles keep, and from the parent's */
const APART = 15
const CLEAR = 24
/** a baby wiggles or looks round every so often (ms) */
const ACT_MIN_MS = 3000
const ACT_MAX_MS = 10000
/** they drift about all the time, very slowly: a speed each (px/s), and how fast their way wanders (rad/s) */
const DRIFT_MIN = 3.5
const DRIFT_MAX = 5.5
const WANDER = 0.6
/** how hard they turn back from the colony's edge, the name tag, the parent and each other (rad/s) */
const STEER = 3
/** how far from the parent and from each other they start turning away, px */
const SHY = 10
const TURN_W = 8
const TURN_Z = 0.8
const WIGGLE_MS = 650
const LOOK_MS = 1500
const POP_MS = 380
const LEAVE_MS = 460
/** how close the pointer has to be to a baby for its tooltip, screen px */
const HOVER_PX = 9

type Act = 'wiggle' | 'look'

/** A subagent: a tiny eye pointer drifting about near its parent. */
export interface Baby {
	id: string
	tip: string
	seed: number
	/** from the parent's middle (screen px): where it is */
	rel: Vec
	/** the way it's drifting (radians) and how fast (px/s) */
	way: number
	speed: number
	heading: number
	spin: number
	eye: EyeState
	nextBlink: number
	blinkStart: number
	act: Act | null
	actAt: number
	nextAct: number
	/** a look's target: the parent (null) or a sibling */
	lookAt: string | null
	scale: number
	popStart: number
	leaving: boolean
	leaveStart: number
	/** 1, fading to 0 as it leaves */
	fade: number
	/** on screen as last placed */
	screen: Vec
}

/**
 * A creature's busy subagents, as a little colony of babies near it, each drifting very slowly
 * about on its own wandering way, turning back from the colony's edge and from each other; now
 * and then one wiggles, or looks round at the parent or a sibling.
 * Positions are kept relative to the parent's middle, so its off-screen marker can draw the same
 * colony in miniature (see Offscreen).
 */
export class Colony {
	babies = new Map<string, Baby>()
	private pal: Palette = palette('#22d3ee')
	private color = ''

	get size() {
		return this.babies.size
	}

	/** How many there are, not counting ones leaving. */
	get count() {
		let n = 0
		for (const b of this.babies.values()) if (!b.leaving) n++
		return n
	}

	/** Adds babies for subagents that started (at a free spot) and sends off those whose subagent finished. */
	sync(subagents: SubagentInfo[], color: string, now: number, still: boolean) {
		if (color !== this.color) {
			this.color = color
			this.pal = palette(mixColor(color, 255, 0.35))
		}
		const ids = new Set(subagents.map((s) => s.id))
		for (const b of this.babies.values()) {
			if (!ids.has(b.id) && !b.leaving) {
				b.leaving = true
				b.leaveStart = now
			}
		}
		for (const s of subagents) {
			const tip = s.agent ? `${s.title || 'Subagent'} · @${s.agent}` : s.title || 'Subagent'
			let b = this.babies.get(s.id)
			if (!b || b.leaving) {
				if (b) this.babies.delete(s.id)
				const way = Math.random() * Math.PI * 2
				b = {
					id: s.id,
					tip,
					seed: Math.random() * 1000,
					rel: this.freeSpot(subagents.length),
					way,
					speed: DRIFT_MIN + Math.random() * (DRIFT_MAX - DRIFT_MIN),
					heading: way,
					spin: 0,
					eye: openEye(),
					nextBlink: now + 800 + Math.random() * 4000,
					blinkStart: -1e9,
					act: null,
					actAt: -1e9,
					nextAct: now + ACT_MIN_MS + Math.random() * (ACT_MAX_MS - ACT_MIN_MS),
					lookAt: null,
					scale: still ? 1 : 0,
					popStart: now,
					leaving: false,
					leaveStart: 0,
					fade: 1,
					screen: { x: -1e9, y: -1e9 },
				}
				this.babies.set(s.id, b)
			}
			b.tip = tip
		}
	}

	/** One frame: their little doings, springs and eyes. `c` is the parent's middle on screen. */
	step(now: number, elapsed: number, c: Vec, asleep: boolean, still: boolean) {
		const dt = Math.min(0.05, elapsed / 1000)
		const n = this.count
		for (const b of [...this.babies.values()]) {
			if (b.leaving) {
				const u = still ? 1 : (now - b.leaveStart) / LEAVE_MS
				if (u >= 1) {
					this.babies.delete(b.id)
					continue
				}
				b.fade = 1 - u
			} else b.scale = still ? 1 : easeOutBack(Math.min(1, (now - b.popStart) / POP_MS))
			if (!still && !asleep && !b.leaving && now > b.nextAct) this.begin(b, now)
			if (!still && !asleep) this.drift(b, now, dt, n)
			this.turnTo(b, now, dt, still)
			this.eyes(b, now, elapsed, asleep, still)
			b.screen = { x: c.x + b.rel.x, y: c.y + b.rel.y }
		}
		if (!still) this.separate(dt)
	}

	/** Draws them round `c` (screen), `k` times their size and spread. */
	draw(ctx: CanvasRenderingContext2D, c: Vec, k: number, dpr: number) {
		for (const b of this.babies.values()) {
			const s = (k * BABY * b.scale * (b.leaving ? 1 - 0.5 * (1 - b.fade) : 1)) / SIZE
			if (s < 0.02) continue
			const shape = place({ x: c.x + b.rel.x * k, y: c.y + b.rel.y * k }, b.heading, s)
			ctx.save()
			ctx.globalAlpha *= b.fade
			drawBody(ctx, shape, this.pal, { dpr, shadow: 0.7 })
			drawEye(ctx, shape.eye, shape.eyeR * EYE, b.eye, this.pal, Math.cos(shape.heading) < 0 ? -1 : 1)
			ctx.restore()
		}
	}

	/** The baby under a screen point, for its tooltip (`slop`: a little more to keep one already showing). */
	hit(p: Vec, slop: number): { baby: Baby; d: number } | null {
		let best: { baby: Baby; d: number } | null = null
		for (const b of this.babies.values()) {
			if (b.leaving || b.scale < 0.5) continue
			const d = Math.hypot(b.screen.x - p.x, b.screen.y - p.y)
			if (d < HOVER_PX + slop && (!best || d < best.d)) best = { baby: b, d }
		}
		return best
	}

	// ---------- doings ----------

	private begin(b: Baby, now: number) {
		b.act = Math.random() < 0.5 ? 'wiggle' : 'look'
		b.actAt = now
		b.nextAct = now + ACT_MIN_MS + Math.random() * (ACT_MAX_MS - ACT_MIN_MS)
		if (b.act === 'look') {
			const others = [...this.babies.values()].filter((o) => o !== b && !o.leaving)
			b.lookAt = others.length && Math.random() < 0.5 ? others[Math.floor(Math.random() * others.length)].id : null
			b.blinkStart = now
		}
	}

	/** Drifts along its way, which wanders smoothly and turns back from where it shouldn't go. */
	private drift(b: Baby, now: number, dt: number, n: number) {
		const t = now / 1000
		const p = b.rel
		// what it turns from, summed as one push (so two pushes either side never cancel into a standoff)
		const push = { x: 0, y: 0 }
		const away = (to: Vec, k: number) => {
			const l = Math.hypot(to.x, to.y) || 1
			push.x += (to.x / l) * k
			push.y += (to.y / l) * k
		}
		const grow = Math.max(1, Math.sqrt(n / 4))
		const ex = (p.x - AREA.x) / (AREA.rx * grow)
		const ey = (p.y - AREA.y) / (AREA.ry * grow)
		const e = Math.hypot(ex, ey)
		if (e > 0.55) away({ x: AREA.x - p.x, y: AREA.y - p.y }, Math.min(1.5, (e - 0.55) / 0.3))
		const tag = Math.min(p.x - (TAG.x - SHY), p.y - (TAG.y - SHY))
		if (tag > 0) away({ x: -1, y: -0.6 }, Math.min(1.5, tag / SHY))
		const dp = Math.hypot(p.x, p.y)
		if (dp < CLEAR + SHY) away({ x: p.x, y: p.y }, Math.min(1.5, (CLEAR + SHY - dp) / SHY))
		for (const o of this.babies.values()) {
			if (o === b || o.leaving) continue
			const dx = p.x - o.rel.x
			const dy = p.y - o.rel.y
			const d = Math.hypot(dx, dy)
			if (d < APART + SHY) away({ x: dx, y: dy }, Math.min(1.5, (APART + SHY - d) / SHY))
		}
		let steer = WANDER * wobble(t * 0.13 + b.seed)
		const k = Math.min(1.5, Math.hypot(push.x, push.y))
		// turning toward it, harder the further off its way is
		if (k > 0.01) steer += (STEER * k * turn(b.way, Math.atan2(push.y, push.x))) / (Math.PI / 2)
		b.way = turn(0, b.way + steer * dt)
		const v = b.speed * Math.min(1, b.scale)
		p.x += Math.cos(b.way) * v * dt
		p.y += Math.sin(b.way) * v * dt
	}

	/** Its tip turning, gently, to the way it drifts (with a wiggle now and then). */
	private turnTo(b: Baby, now: number, dt: number, still: boolean) {
		if (still) {
			b.heading = b.way
			b.spin = 0
			return
		}
		let want = b.way
		const u = (now - b.actAt) / WIGGLE_MS
		if (b.act === 'wiggle') {
			if (u >= 1) b.act = null
			else want += 0.4 * Math.sin(u * Math.PI * 4) * (1 - u)
		}
		const tw = b.act === 'wiggle' ? TURN_W * 3 : TURN_W
		for (let left = dt; left > 1e-6; left -= 1 / 120) {
			const h = Math.min(left, 1 / 120)
			b.spin += (tw * tw * turn(b.heading, want) - 2 * TURN_Z * tw * b.spin) * h
			b.heading += b.spin * h
		}
		b.heading = turn(0, b.heading)
	}

	private eyes(b: Baby, now: number, elapsed: number, asleep: boolean, still: boolean) {
		const eye = b.eye
		const ahead = { x: Math.cos(b.heading) * 0.6, y: Math.sin(b.heading) * 0.6 }
		let look = ahead
		let lid = 0
		if (asleep) {
			look = { x: 0, y: 0.4 }
			lid = 1
		} else if (b.act === 'look') {
			if (now - b.actAt > LOOK_MS) b.act = null
			const to = b.lookAt ? this.babies.get(b.lookAt)?.rel : { x: 0, y: 0 }
			if (to) {
				const dx = to.x - b.rel.x
				const dy = to.y - b.rel.y
				const l = Math.hypot(dx, dy) || 1
				look = { x: dx / l, y: dy / l }
			}
		}
		if (!asleep && now > b.nextBlink) {
			b.blinkStart = now
			b.nextBlink = now + 2500 + Math.random() * 5000
		}
		const blink = (now - b.blinkStart) / 150
		const blinking = blink >= 0 && blink < 1
		if (blinking) lid = Math.max(lid, Math.sin(Math.PI * blink))
		const k = still ? 1 : 1 - Math.exp(-elapsed / 40)
		eye.look = { x: eye.look.x + (look.x - eye.look.x) * k, y: eye.look.y + (look.y - eye.look.y) * k }
		eye.lid += (lid - eye.lid) * (still || blinking ? 1 : 1 - Math.exp(-elapsed / 90))
	}

	/** Keeps them off each other and the parent, should their turning away not be enough: a gentle push apart. */
	private separate(dt: number) {
		const list = [...this.babies.values()].filter((b) => !b.leaving)
		const k = Math.min(1, dt * 8)
		for (let i = 0; i < list.length; i++) {
			const a = list[i]
			const dp = Math.hypot(a.rel.x, a.rel.y)
			if (dp < CLEAR) {
				const f = ((CLEAR - dp) * k) / (dp || 1)
				a.rel.x += a.rel.x * f
				a.rel.y += a.rel.y * f
			}
			for (let j = i + 1; j < list.length; j++) {
				const b = list[j]
				const dx = b.rel.x - a.rel.x
				const dy = b.rel.y - a.rel.y
				const d = Math.hypot(dx, dy)
				if (d >= APART) continue
				const f = ((APART - d) * k * 0.5) / (d || 1)
				const ux = d ? dx : 1
				const uy = d ? dy : 0
				a.rel.x -= ux * f
				a.rel.y -= uy * f
				b.rel.x += ux * f
				b.rel.y += uy * f
			}
		}
	}

	/** A spot in the colony's area clear of the others, or the clearest one tried. */
	private freeSpot(n: number): Vec {
		const grow = Math.max(1, Math.sqrt(n / 4))
		const others = [...this.babies.values()].filter((o) => !o.leaving)
		let best: Vec = { x: AREA.x, y: AREA.y }
		let bestRoom = -Infinity
		for (let i = 0; i < 48; i++) {
			const a = Math.random() * Math.PI * 2
			const r = Math.sqrt(Math.random()) * 0.8
			const p = { x: AREA.x + Math.cos(a) * r * AREA.rx * grow, y: AREA.y + Math.sin(a) * r * AREA.ry * grow }
			if (p.x > TAG.x && p.y > TAG.y) continue
			let room = Math.hypot(p.x, p.y) - CLEAR + APART
			for (const o of others) room = Math.min(room, Math.hypot(o.rel.x - p.x, o.rel.y - p.y))
			if (room >= APART + 2) return p
			if (room > bestRoom) {
				bestRoom = room
				best = p
			}
		}
		return best
	}
}

function easeOutBack(t: number) {
	const c = 1.9
	return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2)
}
