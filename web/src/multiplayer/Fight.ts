import './fight.css'
import type { Editor } from '../editor/Editor'
import type { Vec } from '../editor/geometry'
import type { Worm } from './AgentWorms'
import type { Attention } from './Attention'
import type { Conjure } from './Conjure'
import { LIFT, SIZE, TIP_REACH, turn, wobble, type EyeState } from './Pointer'
import type { FightCall } from './Presence'

/** a creature dropped this close (screen px) to another picks a fight with it */
const NEAR_PX = 70
/** squaring up, pulled back; then two lunges, tip to tip */
const SQUARE_MS = 450
const BUTT_MS = 430
const LUNGE_END = SQUARE_MS + 2 * BUTT_MS
/** scuffling in a dust cloud until they burst apart */
const BURST_MS = 2550
/** the loser lies down dazed by then at the latest */
const DAZE_MS = BURST_MS + 750
const END_MS = 3800
/** reduced motion: a shake and a glare */
const STILL_MS = 900
const SHAKE_MS = 500
/** the same two can fight again this long after their last one ended */
const REMATCH_MS = 2000
/** how long a fight waits for both to be where they were put (others' tabs: crawling over) */
const WAIT_MS = 8000
/** how long a fight call stays in our presence */
const CALL_MS = 6000
/** fight calls stamped this far off our clock are left alone */
const STALE_MS = 5 * 60_000
/** how far out subagents' dots fly while their parent fights */
const SCATTER = 2.2
/** the loser flies this long before it's dazed */
const FLUNG_MS = 650

interface Pending {
	call: FightCall
	since: number
}

interface Bout {
	call: FightCall
	start: number
	still: boolean
	seed: number
	/** where they meet, page space, and each one's spot and which way the other is, by session id */
	center: Vec
	home: Record<string, Vec>
	side: Record<string, number>
	/** lunges landed, by session id */
	hits: Record<string, number>
	clashes: { at: number; p: Vec }[]
	nextJolt: number
	burst: boolean
	/** the loser: when it came to rest dazed, and where (screen px from its spot) */
	flatAt: number
	flatOff: Vec
}

interface Role {
	bout: Bout
	t: number
	foe: string
	side: number
	won: boolean
}

/** How a creature is held while it fights or is knocked about (see AgentWorms.knock and steer). */
export interface Pose {
	/** screen px from its spot it's pulled to, and how stiffly (rad/s) */
	off: Vec
	k: number
	/** thrown: its offset left to fly (only drag) */
	free?: boolean
	/** where it points (radians), or null to spin freely; and how stiffly it turns */
	heading: number | null
	turn?: number
}

/**
 * Creatures dropped next to each other fight: they point at each other and pull back, lunge in
 * twice till their tips clash, scuffle in a puff of dust, then burst apart, one flung off spinning
 * and dazed, the other wiggling proudly. Then they carry on as they were (the loser gliding back
 * to where it was put: positions never change).
 *
 * The tab that dropped one decides (who's nearby, on its screen, and who wins) and broadcasts that
 * as a fight call in its presence; every tab, its own included, plays the fight once both creatures
 * are back where they were put (the dropped one glides over on other tabs first). Each tab runs the
 * motion itself, so the fight looks alike everywhere without sending any of its motion.
 */
export class Fights {
	private bouts: Bout[] = []
	private pending: Pending[] = []
	private seen = new Set<string>()
	/** when each pair last finished fighting */
	private lastEnd = new Map<string, number>()
	private worms = new Map<string, Worm>()
	private clearTimer = 0

	constructor(
		private editor: Editor,
		private conjure: Conjure | null,
		private attention: Attention | null,
		private reducedMotion: MediaQueryList,
	) {}

	/** A creature was just dropped: picks a fight with the nearest one it landed by, if any. */
	dropped(worm: Worm, worms: Iterable<Worm>) {
		const c = this.conjure
		const a = worm.sessionId
		if (!c?.canEdit || !a) return
		const at = this.editor.pageToScreen(worm.root)
		let best: Worm | null = null
		let bestD = NEAR_PX
		for (const o of worms) {
			if (o === worm || !o.conjured || o.leaving || !o.sessionId || o.sessionId === a || o.mode === 'carried' || o.mode === 'vanish') continue
			const s = this.editor.pageToScreen(o.root)
			const d = Math.hypot(s.x - at.x, s.y - at.y)
			if (d < bestD) {
				bestD = d
				best = o
			}
		}
		const b = best?.sessionId
		if (!best || !b || !this.free(a, b, performance.now())) return
		const ga = worm.goal ?? worm.root
		const gb = best.goal ?? best.root
		const call: FightCall = {
			id: Math.random().toString(36).slice(2, 10),
			a,
			b,
			winner: Math.random() < 0.5 ? a : b,
			d: Math.round(Math.hypot(gb.x - ga.x, gb.y - ga.y)),
			at: Date.now(),
		}
		this.seen.add(call.id)
		this.pending.push({ call, since: performance.now() })
		const presence = c.presence
		presence.fight.set(call)
		clearTimeout(this.clearTimer)
		this.clearTimer = window.setTimeout(() => presence.fight.peek()?.id === call.id && presence.fight.set(null), CALL_MS)
	}

	destroy() {
		clearTimeout(this.clearTimer)
		this.bouts = []
		this.pending = []
	}

	/** Neither is fighting (or about to), nor has its walkthrough open, and they haven't just fought. */
	private free(a: string, b: string, now: number) {
		const busy = (s: string) =>
			this.bouts.some((x) => x.call.a === s || x.call.b === s) || this.pending.some((x) => x.call.a === s || x.call.b === s) || !!this.attention?.isOpen(s)
		return !busy(a) && !busy(b) && now - (this.lastEnd.get(pair(a, b)) ?? -1e9) > REMATCH_MS
	}

	/** Once a frame, after the creatures moved and were drawn: takes fight calls, starts and ends fights, draws the dust. */
	frame(ctx: CanvasRenderingContext2D, now: number, worms: Iterable<Worm>) {
		this.worms.clear()
		for (const w of worms) if (w.sessionId && !w.leaving && !w.gone) this.worms.set(w.sessionId, w)
		for (const peer of this.conjure?.presence.peers.peek() ?? []) {
			const call = peer.fight
			if (!call || this.seen.has(call.id)) continue
			this.seen.add(call.id)
			// (calls stay up a few seconds: one seen on arriving is still on; clocks differ, so only very old ones are skipped)
			if (Math.abs(Date.now() - call.at) < STALE_MS && this.free(call.a, call.b, now)) this.pending.push({ call, since: now })
		}
		this.pending = this.pending.filter((p) => {
			if (now - p.since > WAIT_MS) return false
			const a = this.worms.get(p.call.a)
			const b = this.worms.get(p.call.b)
			if (!a || !b || !this.ready(a, now) || !this.ready(b, now)) return true
			if (this.attention?.isOpen(p.call.a) || this.attention?.isOpen(p.call.b)) return false
			// (on others' tabs, not until the dropped one has its new spot)
			const z = this.editor.camera.peek().z
			if (Math.hypot(a.goal!.x - b.goal!.x, a.goal!.y - b.goal!.y) > p.call.d * 1.25 + 12 / z) return true
			this.start(p.call, a, b, now)
			return false
		})
		this.bouts = this.bouts.filter((bout) => {
			const a = this.worms.get(bout.call.a)
			const b = this.worms.get(bout.call.b)
			const over = now - bout.start > (bout.still ? STILL_MS : END_MS)
			const broken = !a || !b || a.mode !== 'here' || b.mode !== 'here'
			if (!over && !broken) {
				a.el.classList.add('fighting')
				b.el.classList.add('fighting')
				// Tangled up, their name tags would overlap: the loser's fades till it's flung clear.
				const loser = bout.call.winner === bout.call.a ? b : a
				loser.el.classList.toggle('fight-faded', !bout.still && !bout.flatAt)
				if (!bout.still) this.draw(ctx, bout, now)
				return true
			}
			a?.el.classList.remove('fighting', 'fight-faded')
			b?.el.classList.remove('fighting', 'fight-faded')
			this.lastEnd.set(pair(bout.call.a, bout.call.b), now)
			return false
		})
		if (this.seen.size > 200) this.seen = new Set([...this.seen].slice(-100))
	}

	/** Sitting where it was put, done landing and walking. */
	private ready(w: Worm, now: number) {
		if (w.mode !== 'here' || w.trip || !w.goal || now - w.modeAt < 300) return false
		const z = this.editor.camera.peek().z
		return Math.hypot(w.goal.x - w.root.x, w.goal.y - w.root.y) * z <= 14
	}

	private start(call: FightCall, a: Worm, b: Worm, now: number) {
		const ga = { ...a.goal! }
		const gb = { ...b.goal! }
		const s = Math.sign(gb.x - ga.x) || (call.a < call.b ? 1 : -1)
		const bout: Bout = {
			call,
			start: now,
			still: this.reducedMotion.matches,
			seed: hash(call.id) * 100,
			center: { x: (ga.x + gb.x) / 2, y: (ga.y + gb.y) / 2 },
			home: { [call.a]: ga, [call.b]: gb },
			side: { [call.a]: s, [call.b]: -s },
			hits: { [call.a]: 0, [call.b]: 0 },
			clashes: [],
			nextJolt: now + LUNGE_END,
			burst: false,
			flatAt: 0,
			flatOff: { x: 0, y: 0 },
		}
		for (const w of [a, b]) {
			w.trip = null
			w.fretting = false
			w.el.classList.add('fighting')
		}
		this.bouts.push(bout)
	}

	private role(worm: Worm, now: number): Role | null {
		const id = worm.sessionId
		if (!id) return null
		const bout = this.bouts.find((b) => b.call.a === id || b.call.b === id)
		if (!bout) return null
		return { bout, t: now - bout.start, foe: bout.call.a === id ? bout.call.b : bout.call.a, side: bout.side[id], won: bout.call.winner === id }
	}

	/** In a fight: it doesn't walk, fidget or fret meanwhile. */
	holds(worm: Worm, now: number) {
		const r = this.role(worm, now)
		return !!r && !r.bout.still
	}

	/** Fighting wakes it up (for the look of it), and it's drawn awake. */
	awake(worm: Worm, now: number) {
		return !!this.role(worm, now)
	}

	/** How far out its dots fly: 1 normally. */
	scatter(worm: Worm, now: number) {
		const r = this.role(worm, now)
		if (!r || r.bout.still) return 1
		const out = smooth(r.t / 400) * (1 - smooth((r.t - (END_MS - 700)) / 700))
		return 1 + (SCATTER - 1) * out
	}

	/** Where it and its foe are (from where they were put): the way to the foe, and where its centre goes for their tips to meet. */
	private geo(worm: Worm, r: Role, z: number) {
		const id = worm.sessionId!
		const me = this.editor.pageToScreen(r.bout.home[id])
		const foe = this.editor.pageToScreen(r.bout.home[r.foe])
		const d = Math.hypot(foe.x - me.x, foe.y - me.y)
		const dir = d > 1e-6 ? { x: (foe.x - me.x) / d, y: (foe.y - me.y) / d } : { x: r.side, y: 0 }
		const reach = TIP_REACH * SIZE * 0.92
		const meet = { x: dir.x * (d / 2 - reach), y: dir.y * (d / 2 - reach) }
		// (it may sit a little off where it was put)
		const base = { x: (r.bout.home[id].x - worm.root.x) * z, y: (r.bout.home[id].y - worm.root.y) * z }
		return { dir, meet, base, face: Math.atan2(dir.y, dir.x) }
	}

	/** After it moved this frame: the knocks of the clashes, the shoving, the loser flung spinning. */
	step(worm: Worm, now: number, _elapsed: number, z: number) {
		const r = this.role(worm, now)
		if (!r || r.bout.still) return
		const { bout, t, side, won } = r
		const { dir } = this.geo(worm, r, z)
		const id = worm.sessionId!
		// lunges: a knock back at the moment their tips clash
		const butt = Math.floor((t - SQUARE_MS - 0.55 * BUTT_MS) / BUTT_MS) + 1
		if (t >= SQUARE_MS && butt > bout.hits[id] && butt <= 2) {
			bout.hits[id] = butt
			worm.offV.x -= dir.x * 300
			worm.offV.y -= dir.y * 300 + 40
			worm.spin += side * 4
			const foe = this.worms.get(r.foe)
			if (side > 0 && foe?.shape && worm.shape) {
				const p = { x: (worm.shape.tip.x + foe.shape.tip.x) / 2, y: (worm.shape.tip.y + foe.shape.tip.y) / 2 }
				bout.clashes.push({ at: now, p: this.editor.screenToPage(p) })
			}
		}
		// tangled: shoved about at random
		if (t >= LUNGE_END && t < BURST_MS && now > bout.nextJolt && side > 0) {
			bout.nextJolt = now + 90 + Math.random() * 110
			const foe = this.worms.get(r.foe)
			for (const w of [worm, foe]) {
				if (!w) continue
				w.offV.x += (Math.random() - 0.5) * 420
				w.offV.y += (Math.random() - 0.5) * 300
				w.spin += (Math.random() - 0.5) * 10
			}
		}
		if (t >= BURST_MS && !bout.hits[id + ':burst']) {
			bout.hits[id + ':burst'] = 1
			if (won) worm.offV.y -= 160
			else {
				// flung off: up and away, spinning
				const v = 380 + 60 * hash(bout.call.id + 'v')
				worm.offV.x = -dir.x * v
				worm.offV.y = -dir.y * v - 220
				worm.spin = -side * 24
				bout.burst = true
			}
		}
		if (!won && bout.burst && !bout.flatAt && t - BURST_MS > FLUNG_MS) {
			bout.flatAt = t
			bout.flatOff = { ...worm.off }
		}
	}

	/** How it's held while it fights (see AgentWorms.knock and steer), or null when it isn't fighting. */
	pose(worm: Worm, now: number, z: number): Pose | null {
		const r = this.role(worm, now)
		if (!r || worm.mode !== 'here') return null
		const { bout, t, side, won } = r
		const { dir, meet, base, face } = this.geo(worm, r, z)
		const add = (a: Vec, b: Vec, k = 1): Vec => ({ x: a.x + b.x * k, y: a.y + b.y * k })
		if (bout.still) {
			// a shake and a glare
			const shake = t < SHAKE_MS ? 1.8 * Math.sin(t * 0.11) * (1 - t / SHAKE_MS) : 0
			return { off: add(base, { x: shake, y: 0 }), k: 20, heading: face }
		}
		const back = { x: -dir.x * 9, y: -dir.y * 9 }
		if (t < SQUARE_MS) {
			// pulling back, pointed at each other, trembling with rage
			const u = smooth(t / 250)
			const tremble = 0.9 * Math.sin(t * 0.09)
			return { off: add(add(base, back, u), { x: -dir.y * tremble, y: dir.x * tremble }), k: 22, heading: face + 0.06 * Math.sin(t * 0.06), turn: 16 }
		}
		if (t < LUNGE_END) {
			// lunging in till the tips clash, twice
			const u = ((t - SQUARE_MS) % BUTT_MS) / BUTT_MS
			const a = u < 0.55 ? Math.pow(u / 0.55, 2) : 1 - 0.9 * smooth((u - 0.55) / 0.45)
			return { off: add(base, { x: back.x + (meet.x - back.x) * a, y: back.y + (meet.y - back.y) * a }), k: 38, heading: face, turn: 20 }
		}
		if (t < BURST_MS) {
			// a scuffle, jostling about together
			const s = t / 1000
			const jostle = { x: 6 * wobble(s * 3 + bout.seed + side), y: 5 * wobble(s * 2.6 + bout.seed * 2 + side) }
			return { off: add(add(base, meet, 0.85), jostle), k: 26, heading: face + 0.55 * wobble(s * 2.2 + bout.seed + side * 7), turn: 18 }
		}
		const after = t - BURST_MS
		if (won) {
			// a proud little hop and wiggle
			const decay = Math.max(0, 1 - after / 1100)
			const hop = -7 * Math.abs(Math.sin(after * 0.012)) * decay
			return { off: add(add(base, meet, 0.5 * (1 - smooth(after / 450))), { x: 0, y: hop }), k: 18, heading: face + 0.45 * Math.sin(after * 0.025) * decay }
		}
		if (!bout.flatAt) return { off: base, k: 0, heading: null, free: true }
		// dazed where it landed, drooping
		return { off: bout.flatOff, k: 9, heading: worm.rest + 0.35 * Math.sign(turn(worm.rest, Math.PI / 2) || 1) + 0.25 * wobble(t * 0.002 + bout.seed), turn: 6 }
	}

	/** How its eye looks while it fights: glaring, dizzy as it's flung, rolling about dazed, smug. */
	eye(worm: Worm, now: number): EyeState | null {
		const r = this.role(worm, now)
		if (!r) return null
		const { bout, t, won } = r
		const me = worm.shape?.eye
		const other = this.worms.get(r.foe)?.shape?.centre
		let glare: Vec = { x: r.side, y: 0 }
		if (me && other) {
			const l = Math.hypot(other.x - me.x, other.y - me.y) || 1
			glare = { x: ((other.x - me.x) / l) * 0.9, y: ((other.y - me.y) / l) * 0.9 }
		}
		const eye = (e: Partial<EyeState>): EyeState => ({ look: glare, lid: 0, wide: 0, slant: 0, squeeze: 0, lower: 0, dizzy: 0, ...e })
		if (bout.still || t < BURST_MS) {
			const u = ((t - SQUARE_MS) % BUTT_MS) / BUTT_MS
			const wince = !bout.still && t > SQUARE_MS && t < LUNGE_END && u > 0.52 && u < 0.7
			const scrunch = !bout.still && t > LUNGE_END && wobble(t * 0.004 + bout.seed + (won ? 3 : 0)) > 0.45
			if (wince || scrunch) return eye({ lid: 1, slant: 0.5, squeeze: 1 })
			return eye({ lid: 0.4, slant: 0.5, lower: 0.25 })
		}
		const after = t - BURST_MS
		if (won) return eye({ look: { x: 0.5 * Math.cos(worm.heading), y: -0.5 }, lid: 0.4, slant: -0.2, lower: 0.3 })
		if (!bout.flatAt) return eye({ look: { x: 0, y: 0 }, wide: 1, dizzy: 1 })
		return eye({ look: { x: 0.8 * Math.cos(after * 0.011), y: 0.6 * Math.sin(after * 0.011) }, lid: 0.5 })
	}

	/** The dust, motion ticks and little stars, over the creatures. */
	private draw(ctx: CanvasRenderingContext2D, bout: Bout, now: number) {
		const t = now - bout.start
		const c = this.editor.pageToScreen(bout.center)
		c.y -= LIFT - 12
		c.x += 5 * wobble((t / 1000) * 1.3 + bout.seed)
		ctx.save()
		// clashing tips: a burst of ticks and a star
		for (const clash of bout.clashes) {
			const age = (now - clash.at) / 220
			if (age >= 1) continue
			const p = this.editor.pageToScreen(clash.p)
			ticks(ctx, p, 6 + 6 * age, 11 + 8 * age, 4, -Math.PI / 2, (1 - age) * 0.9, '#a8a29e')
			star(ctx, p.x, p.y - 9, 3.6 * Math.sin(Math.PI * Math.min(1, age * 1.4)), '#facc15', 1 - age)
		}
		// the dust cloud round the scuffle
		const dust = smooth((t - LUNGE_END + 150) / 250) * (1 - smooth((t - BURST_MS - 100) / 350))
		if (dust > 0.01) {
			const s = t / 1000
			for (let k = 0; k < 9; k++) {
				const x = c.x + (k - 4) * 6.5 * (0.8 + 0.2 * dust) + 3 * wobble(s * 4 + k * 3.3)
				const y = c.y - 3 - 4 * Math.abs(wobble(s * 5 + k * 5.1)) - (k % 3 === 1 ? 6 : 0)
				const rr = (5.5 + 2.5 * wobble(s * 6 + k * 1.7) - Math.abs(k - 4) * 0.35) * dust
				if (rr <= 0.3) continue
				ctx.globalAlpha = 0.92
				ctx.fillStyle = '#d6d3d1'
				ctx.beginPath()
				ctx.arc(x, y, rr, 0, Math.PI * 2)
				ctx.fill()
				ctx.fillStyle = '#e7e5e4'
				ctx.beginPath()
				ctx.arc(x - rr * 0.2, y - rr * 0.25, rr * 0.62, 0, Math.PI * 2)
				ctx.fill()
			}
			// quick motion ticks flicking in and out round it
			for (let k = 0; k < 6; k++) {
				const on = Math.min(1, Math.max(0, (wobble(s * 7 + k * 9.7) + 0.1) * 3)) * dust
				if (on < 0.05) continue
				const a = -Math.PI * (0.1 + 0.8 * (k / 5)) + 0.25 * wobble(s * 2 + k)
				const d0 = 24 + ((3 * k) % 7)
				ticks(ctx, { x: c.x, y: c.y - 16 }, d0, d0 + 7, 1, a, on * 0.85, '#a8a29e')
			}
			// and a few tiny stars popping
			for (let k = 0; k < 3; k++) {
				const cycle = Math.floor(t / 340 + k / 3)
				const u = t / 340 + k / 3 - cycle
				const h1 = hash(bout.call.id + k + ':' + cycle)
				const h2 = hash(cycle + ':' + k + bout.call.id)
				star(ctx, c.x + (h1 - 0.5) * 50, c.y - 22 - h2 * 22, 3.2 * Math.sin(Math.PI * u) * dust, '#facc15', 1)
			}
		}
		// bursting apart: the dust thrown out
		const burst = (t - BURST_MS) / 420
		if (burst > 0 && burst < 1) {
			ctx.globalAlpha = 0.85 * (1 - burst)
			ctx.fillStyle = '#d6d3d1'
			for (let k = 0; k < 6; k++) {
				const a = Math.PI + (k / 5) * Math.PI
				const d = 10 + 26 * Math.sqrt(burst)
				ctx.beginPath()
				ctx.arc(c.x + Math.cos(a) * d * 1.3, c.y - 6 + Math.sin(a) * d * 0.45, 4.5 * (1 - burst * 0.6), 0, Math.PI * 2)
				ctx.fill()
			}
		}
		// the loser's dazed stars, round its head
		const loser = this.worms.get(bout.call.winner === bout.call.a ? bout.call.b : bout.call.a)
		const head = loser?.shape && { x: loser.shape.centre.x, y: loser.shape.top + 6 }
		if (bout.flatAt && head) {
			const fade = smooth((t - bout.flatAt) / 200) * (1 - smooth((t - (END_MS - 350)) / 300))
			for (let k = 0; k < 3; k++) {
				const a = t * 0.006 + (k * Math.PI * 2) / 3
				const depth = (Math.sin(a) + 1) / 2
				star(ctx, head.x + Math.cos(a) * 10, head.y - 10 + Math.sin(a) * 3, (1.8 + 0.9 * depth) * fade, '#facc15', 0.6 + 0.4 * depth)
			}
		}
		ctx.restore()
	}
}

/** Short strokes radiating from `p`, from radius r0 to r1, n of them fanned about angle a. */
export function ticks(ctx: CanvasRenderingContext2D, p: Vec, r0: number, r1: number, n: number, a: number, alpha: number, color: string) {
	ctx.globalAlpha = Math.max(0, alpha)
	ctx.strokeStyle = color
	ctx.lineWidth = 1.6
	ctx.lineCap = 'round'
	ctx.beginPath()
	for (let i = 0; i < n; i++) {
		const b = a + (n > 1 ? (i / (n - 1) - 0.5) * Math.PI * 1.1 : 0)
		ctx.moveTo(p.x + Math.cos(b) * r0, p.y + Math.sin(b) * r0)
		ctx.lineTo(p.x + Math.cos(b) * r1, p.y + Math.sin(b) * r1)
	}
	ctx.stroke()
}

/** A small flat four-pointed star. */
export function star(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, alpha: number) {
	if (r <= 0.2) return
	ctx.globalAlpha = Math.max(0, Math.min(1, alpha))
	ctx.fillStyle = color
	const w = r * 0.32
	ctx.beginPath()
	ctx.moveTo(x, y - r)
	ctx.quadraticCurveTo(x + w, y - w, x + r, y)
	ctx.quadraticCurveTo(x + w, y + w, x, y + r)
	ctx.quadraticCurveTo(x - w, y + w, x - r, y)
	ctx.quadraticCurveTo(x - w, y - w, x, y - r)
	ctx.fill()
}

function pair(a: string, b: string) {
	return a < b ? `${a}|${b}` : `${b}|${a}`
}

/** 0..1 from a string. */
export function hash(s: string) {
	let h = 2166136261
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0
	return h / 4294967296
}

export function smooth(t: number) {
	const u = Math.min(1, Math.max(0, t))
	return u * u * (3 - 2 * u)
}
