import type { Editor } from '../editor/Editor'
import type { Vec } from '../editor/geometry'
import type { Worm } from './AgentWorms'
import type { Conjure } from './Conjure'
import { hash, smooth, star, ticks, type FightPosture, type Fights } from './Fight'
import { POINTS, dazedPose, idlePose, place, type EyeState } from './Looper'
import type { SlapCall } from './Presence'

/** the same creature can't be slapped again sooner than this (it would only blur into one) */
const COOLDOWN_MS = 220
/** knocked flying (limp), at most this long before it lies there dazed */
const FLY_MS = 520
/** lying dazed, longer for every slap stacked on top (up to MAX_STACK) */
const DAZE_MS = 950
const DAZE_MORE_MS = 450
const MAX_STACK = 4
/** then up again, glaring */
const GRUMPY_MS = 1400
/** the thwack: a shake right as it's hit */
const SHAKE_MS = 150
/** the flash and ticks at the hit point */
const FLASH_MS = 190
/** reduced motion: a shake, and dazed eyes for a while */
const STILL_SHAKE_MS = 380
const STILL_MS = 1300
/** how long a slap call stays in our presence, and how far off our clock one can be to count */
const CALL_MS = 4000
const STALE_MS = 5 * 60_000
/** how hard (px/s) the hit point is knocked, and how much the rest whips round it */
const BLOW = 500
const SPIN = 650
const LIFT = 330

interface Smack {
	/** when the last slap landed, and how many have stacked up since it was last left alone */
	at: number
	stack: number
	/** which way the last one went, where it hit (page) */
	dir: Vec
	hitAt: Vec
	still: boolean
	shaken: boolean
	/** lying dazed since (0 while it's still flying), and where (page x) */
	flatAt: number
	flatX: number
}

/**
 * Slapping creatures with the slap tool: a hard blow through the body physics where it was hit, so
 * it whips round and tumbles, then lies dazed with stars round its head and gets up grumpy.
 * Slaps stack. Slapping our own working creature interrupts its session.
 *
 * The slapping tab broadcasts each slap (which creature, where on it, which way) in its presence,
 * and every tab plays it on its own bodies. Positions never change: the creature inches back to
 * where it was put.
 */
export class Slaps {
	/** the creature under the pointer while the slap tool is on, highlighted */
	hovered: Worm | null = null
	private smacks = new Map<string, Smack>()
	private seen = new Set<string>()
	private clearTimer = 0

	constructor(
		private editor: Editor,
		private conjure: Conjure | null,
		private fights: Fights,
		private reducedMotion: MediaQueryList,
	) {}

	get active() {
		return this.editor.currentToolId.get() === 'slap' && !!this.conjure?.canEdit
	}

	/** Slaps the creature, hit at `at` (screen): here, for everyone, and interrupts it if it's ours and working. */
	hit(worm: Worm, at: Vec) {
		const c = this.conjure
		const sid = worm.sessionId
		if (!c?.canEdit || !sid || worm.leaving) return
		const now = performance.now()
		const prev = this.smacks.get(sid)
		if ((prev && now - prev.at < COOLDOWN_MS) || this.fights.awake(worm, now)) return
		// hit at the point nearest the pointer, knocked away from the side it came from
		let i = 0
		let best = Infinity
		worm.drawn.forEach((p, j) => {
			const d = Math.hypot(p.x - at.x, p.y - at.y)
			if (d < best) {
				best = d
				i = j
			}
		})
		const pts = worm.drawn
		const mid = pts.length ? { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length } : at
		const side = Math.sign(mid.x - at.x) || -worm.facing
		const dy = Math.max(-0.5, Math.min(0.35, (mid.y - at.y) / 30))
		const l = Math.hypot(1, dy)
		const call: SlapCall = { id: Math.random().toString(36).slice(2, 10), s: sid, i, dx: side / l, dy: dy / l, at: Date.now() }
		this.seen.add(call.id)
		this.apply(worm, call, now)
		const presence = c.presence
		presence.slap.set(call)
		clearTimeout(this.clearTimer)
		this.clearTimer = window.setTimeout(() => presence.slap.peek()?.id === call.id && presence.slap.set(null), CALL_MS)
		if (worm.thinking && c.ours(sid) && !c.stopping.peek()[sid]) {
			const title = c.record(sid)?.title?.trim() || worm.nameText || 'it'
			c.interrupt(sid)
				.then(() => this.editor.deletions.notify(`Slapped: interrupted ${title}`))
				.catch((err: Error) => this.editor.deletions.notify(`Slapped, but couldn't interrupt it: ${err.message}`))
		}
	}

	/** The blow itself, on this tab's body of it. */
	private apply(worm: Worm, call: SlapCall, now: number) {
		const sid = call.s
		const prev = this.smacks.get(sid)
		const still = this.reducedMotion.matches
		const hitPt = worm.drawn[call.i] ?? this.editor.pageToScreen(worm.root)
		this.smacks.set(sid, {
			at: now,
			stack: Math.min(MAX_STACK, (prev ? prev.stack : 0) + 1),
			dir: { x: call.dx, y: call.dy },
			hitAt: this.editor.screenToPage(hitPt),
			still,
			shaken: false,
			flatAt: 0,
			flatX: 0,
		})
		worm.walk = null
		worm.landedAt = 0
		worm.writhe = null
		worm.fit = null
		if (still) return
		worm.squash = Math.max(worm.squash, 0.55)
		const body = worm.body
		const d = call.dx
		const e = call.dy
		// the hit point knocked hard, the rest whipping round it, all of it off the ground
		for (let j = 0; j < POINTS; j++) {
			const w = Math.exp(-Math.abs(j - call.i) / 2.2)
			const spin = Math.sign(j - call.i) * SPIN * (1 - w)
			body.push(j, d * BLOW * w - e * spin, e * BLOW * w + d * spin - LIFT * (0.6 + 0.4 * w))
		}
		// (the head snaps round more)
		for (let j = 0; j < 3; j++) body.push(j, d * 220, -180)
	}

	private smack(worm: Worm, now: number): { s: Smack; t: number } | null {
		const s = worm.sessionId ? this.smacks.get(worm.sessionId) : undefined
		return s ? { s, t: now - s.at } : null
	}

	/** Knocked about: it doesn't walk, fidget or fret meanwhile. */
	holds(worm: Worm, now: number) {
		const m = this.smack(worm, now)
		return !!m && !m.s.still && (!m.s.flatAt || now - m.s.flatAt < this.daze(m.s))
	}

	/** Slapped, it wakes up (for the look of it) till it has got over it. */
	awake(worm: Worm, now: number) {
		return !!this.smack(worm, now)
	}

	private daze(s: Smack) {
		return DAZE_MS + DAZE_MORE_MS * (s.stack - 1)
	}

	/** After it moved this frame: the thwack, and settling down dazed once it lands. */
	step(worm: Worm, now: number) {
		const m = this.smack(worm, now)
		if (!m) return
		const { s, t } = m
		const body = worm.body
		const shake = s.still ? STILL_SHAKE_MS : SHAKE_MS
		if (t < shake) body.shift((s.still ? 1.6 : 3) * Math.sin(t * 0.13) * (1 - t / shake), s.still ? 0 : 1.2 * Math.cos(t * 0.17) * (1 - t / shake))
		if (s.still) return
		if (!s.flatAt && ((t > 200 && body.touching && Math.abs(body.velocity(Math.round(POINTS / 2)).y) < 60) || t > FLY_MS)) {
			s.flatAt = now
			s.flatX = worm.root.x
		}
	}

	/** Its pose: limp as it flies, then lying dazed; null once it's getting up. */
	posture(worm: Worm, now: number, z: number): FightPosture | null {
		const m = this.smack(worm, now)
		if (!m || m.s.still || worm.mode !== 'here') return null
		const { s } = m
		if (!s.flatAt) return { shape: place(idlePose(0), worm.facing, 0), k: 0, limp: true }
		if (now - s.flatAt < this.daze(s)) return { shape: place(dazedPose(now / 1000 + worm.seed), worm.facing, (s.flatX - worm.root.x) * z), k: 150 }
		return null
	}

	/** Wide as it's hit, rolling about dazed, then a glare as it gets up. */
	eye(worm: Worm, now: number): Required<EyeState> | null {
		const m = this.smack(worm, now)
		if (!m) return null
		const { s, t } = m
		if (s.still) return { look: { x: 0.45, y: -0.4 }, lid: 0.55, wide: 0, slant: 0, squeeze: 0 }
		if (!s.flatAt) return { look: { x: -s.dir.x * 0.3, y: -0.2 }, lid: 0, wide: 1, slant: 0, squeeze: 0 }
		const lying = now - s.flatAt
		if (lying < this.daze(s)) return { look: { x: 0.8 * Math.cos(t * 0.011), y: 0.6 * Math.sin(t * 0.011) }, lid: 0.55, wide: 0, slant: 0, squeeze: 0 }
		return { look: { x: 0.6 * worm.facing, y: 0.1 }, lid: 0.46, wide: 0, slant: 0.5, squeeze: 0 }
	}

	/** Once a frame, after the creatures were drawn: takes slap calls, draws the hits, stars and the hover highlight. */
	frame(ctx: CanvasRenderingContext2D, now: number, worms: Iterable<Worm>) {
		const byId = new Map<string, Worm>()
		for (const w of worms) if (w.sessionId && !w.leaving && !w.gone) byId.set(w.sessionId, w)
		for (const peer of this.conjure?.presence.peers.peek() ?? []) {
			const call = peer.slap
			if (!call || this.seen.has(call.id)) continue
			this.seen.add(call.id)
			const w = byId.get(call.s)
			if (w && Math.abs(Date.now() - call.at) < STALE_MS && !this.fights.awake(w, now)) this.apply(w, call, now)
		}
		if (this.seen.size > 200) this.seen = new Set([...this.seen].slice(-100))
		if (this.hovered && (!this.active || this.hovered.leaving || !byId.has(this.hovered.sessionId ?? ''))) this.hovered = null
		const hovered = this.hovered
		ctx.save()
		if (hovered && hovered.hit.length) {
			// a soft halo behind it
			ctx.globalCompositeOperation = 'destination-over'
			ctx.globalAlpha = 0.2
			ctx.fillStyle = '#f8fafc'
			ctx.beginPath()
			for (const d of hovered.hit) {
				ctx.moveTo(d.x + d.r + 2.5, d.y)
				ctx.arc(d.x, d.y, d.r + 2.5, 0, Math.PI * 2)
			}
			ctx.fill()
			ctx.globalCompositeOperation = 'source-over'
		}
		for (const [sid, s] of this.smacks) {
			const t = now - s.at
			const w = byId.get(sid)
			const over = s.still ? t > STILL_MS : s.flatAt ? now - s.flatAt > this.daze(s) + GRUMPY_MS : t > FLY_MS + 5000
			if (!w || over || (w.mode !== 'here' && !s.still)) {
				this.smacks.delete(sid)
				continue
			}
			if (s.still) continue
			if (t < FLASH_MS) this.flash(ctx, s, t / FLASH_MS)
			// dazed: stars round its head, more for every slap stacked on
			const head = w.drawn[0]
			if (s.flatAt && head) {
				const lying = now - s.flatAt
				const fade = smooth(lying / 200) * (1 - smooth((lying - this.daze(s) + 250) / 300))
				const n = 2 + s.stack
				for (let k = 0; k < n; k++) {
					const a = now * 0.006 + (k * Math.PI * 2) / n
					const depth = (Math.sin(a) + 1) / 2
					star(ctx, head.x + Math.cos(a) * (9 + s.stack), head.y - 10 + Math.sin(a) * 3, (1.8 + 0.9 * depth) * fade, '#facc15', 0.6 + 0.4 * depth)
				}
			}
		}
		ctx.restore()
	}

	/** The impact: a flat white burst at the hit point, and ticks flying off the way the blow went. */
	private flash(ctx: CanvasRenderingContext2D, s: Smack, u: number) {
		const p = this.editor.pageToScreen(s.hitAt)
		const a = Math.atan2(s.dir.y, s.dir.x)
		const r = 7 + 11 * Math.sqrt(u)
		const spikes = 9
		ctx.globalAlpha = 1 - u * u
		ctx.fillStyle = '#ffffff'
		ctx.beginPath()
		for (let k = 0; k < spikes * 2; k++) {
			const rr = k % 2 ? r * 0.45 : r * (0.8 + 0.4 * hash(`${s.at}:${k}`))
			const b = (k / (spikes * 2)) * Math.PI * 2 + a
			const x = p.x + Math.cos(b) * rr
			const y = p.y + Math.sin(b) * rr
			if (k) ctx.lineTo(x, y)
			else ctx.moveTo(x, y)
		}
		ctx.closePath()
		ctx.fill()
		// ticks thrown back toward the hand
		ticks(ctx, p, r + 2 + 6 * u, r + 9 + 10 * u, 4, a + Math.PI, (1 - u) * 0.95, '#fde68a')
		ticks(ctx, p, r + 4 + 8 * u, r + 8 + 12 * u, 3, a, (1 - u) * 0.7, '#e5e7eb')
	}

	destroy() {
		clearTimeout(this.clearTimer)
		this.smacks.clear()
	}
}
