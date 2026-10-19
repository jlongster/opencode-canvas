import type { Editor } from '../editor/Editor'
import type { Vec } from '../editor/geometry'
import type { Worm } from './AgentWorms'
import type { Conjure } from './Conjure'
import { hash, smooth, star, ticks, type Fights, type Pose } from './Fight'
import { turn, wobble, type EyeState } from './Pointer'
import type { SlapCall } from './Presence'

/** the same creature can't be slapped again sooner than this (it would only blur into one) */
const COOLDOWN_MS = 220
/** knocked flying, spinning, at most this long before it's dazed */
const FLY_MS = 620
/** lying dazed, longer for every slap stacked on top (up to MAX_STACK) */
const DAZE_MS = 950
const DAZE_MORE_MS = 450
const MAX_STACK = 4
/** then up again, glaring */
const GRUMPY_MS = 1400
/** the flash and ticks at the hit point */
const FLASH_MS = 190
/** reduced motion: a shake, and dazed eyes for a while */
const STILL_SHAKE_MS = 380
const STILL_MS = 1300
/** how long a slap call stays in our presence, and how far off our clock one can be to count */
const CALL_MS = 4000
const STALE_MS = 5 * 60_000
/** how hard it's knocked (px/s), and how fast it spins (rad/s), more for each slap stacked on */
const BLOW = 360
const BLOW_MORE = 70
const SPIN = 17
const SPIN_MORE = 4

interface Smack {
	/** when the last slap landed, and how many have stacked up since it was last left alone */
	at: number
	stack: number
	/** which way the last one went, where it hit (page) */
	dir: Vec
	hitAt: Vec
	still: boolean
	/** dazed since (0 while it's still flying), and where it came to rest (screen px from its spot) */
	flatAt: number
	flatOff: Vec
}

/**
 * Slapping creatures with the slap tool: a hard blow where it was hit, so it spins away (the side
 * it was hit on sets which way), then hangs there dizzy with stars round it and comes back grumpy.
 * Slaps stack. Slapping our own working creature interrupts its session.
 *
 * The slapping tab broadcasts each slap (which creature, where on it, which way) in its presence,
 * and every tab plays it itself. Positions never change: the creature glides back to where it was
 * put.
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
		// knocked away from the side it was hit on, spinning the way a blow there would turn it
		const mid = worm.shape?.centre ?? at
		const side = Math.sign(mid.x - at.x) || -Math.sign(Math.cos(worm.heading)) || 1
		const dy = Math.max(-0.5, Math.min(0.35, (mid.y - at.y) / 30))
		const l = Math.hypot(1, dy)
		const dx = side / l
		// (i: which way it spins, 1 clockwise, 0 the other)
		const cross = (at.x - mid.x) * (dy / l) - (at.y - mid.y) * dx
		const call: SlapCall = { id: Math.random().toString(36).slice(2, 10), s: sid, i: cross > 0 ? 0 : 1, dx, dy: dy / l, at: Date.now() }
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
		const c = worm.shape?.centre ?? this.editor.pageToScreen(worm.root)
		const hitPt = { x: c.x - call.dx * 10, y: c.y - call.dy * 10 }
		const stack = Math.min(MAX_STACK, (prev ? prev.stack : 0) + 1)
		this.smacks.set(sid, {
			at: now,
			stack,
			dir: { x: call.dx, y: call.dy },
			hitAt: this.editor.screenToPage(hitPt),
			still,
			flatAt: 0,
			flatOff: { x: 0, y: 0 },
		})
		worm.trip = null
		worm.fretting = false
		if (still) return
		worm.squash = Math.max(worm.squash, 0.55)
		const blow = BLOW + BLOW_MORE * (stack - 1)
		worm.offV.x += call.dx * blow
		worm.offV.y += call.dy * blow - 140
		worm.spin += (call.i ? 1 : -1) * (SPIN + SPIN_MORE * (stack - 1))
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

	/** After it moved this frame: dazed once it has stopped flying. */
	step(worm: Worm, now: number) {
		const m = this.smack(worm, now)
		if (!m) return
		const { s, t } = m
		if (s.still) return
		if (!s.flatAt && ((t > 260 && Math.hypot(worm.offV.x, worm.offV.y) < 70) || t > FLY_MS)) {
			s.flatAt = now
			s.flatOff = { ...worm.off }
		}
	}

	/** How it's held: thrown, spinning, then hanging dizzy where it came to rest; null once it's getting over it. */
	pose(worm: Worm, now: number, _z: number): Pose | null {
		const m = this.smack(worm, now)
		if (!m || worm.mode !== 'here') return null
		const { s, t } = m
		if (s.still) {
			const shake = t < STILL_SHAKE_MS ? 1.6 * Math.sin(t * 0.13) * (1 - t / STILL_SHAKE_MS) : 0
			return { off: { x: shake, y: 0 }, k: 20, heading: worm.rest }
		}
		if (!s.flatAt) return { off: { x: 0, y: 0 }, k: 0, heading: null, free: true }
		if (now - s.flatAt < this.daze(s)) {
			const droop = 0.4 * Math.sign(turn(worm.rest, Math.PI / 2) || 1)
			return { off: s.flatOff, k: 8, heading: worm.rest + droop + 0.3 * wobble(now * 0.002 + worm.seed), turn: 5 }
		}
		return null
	}

	/** Dizzy as it spins away, rolling about dazed, then a glare as it comes back. */
	eye(worm: Worm, now: number): EyeState | null {
		const m = this.smack(worm, now)
		if (!m) return null
		const { s, t } = m
		const eye = (e: Partial<EyeState>): EyeState => ({ look: { x: 0, y: 0 }, lid: 0, wide: 0, slant: 0, squeeze: 0, lower: 0, dizzy: 0, ...e })
		if (s.still) return eye({ look: { x: 0.45, y: -0.4 }, lid: 0.55 })
		if (!s.flatAt) return eye({ wide: 1, dizzy: 1 })
		const lying = now - s.flatAt
		if (lying < this.daze(s)) return eye({ look: { x: 0.8 * Math.cos(t * 0.011), y: 0.6 * Math.sin(t * 0.011) }, lid: 0.5, dizzy: lying < this.daze(s) * 0.5 ? 1 : 0 })
		return eye({ look: { x: -s.dir.x * 0.7, y: 0.1 }, lid: 0.42, slant: 0.5, lower: 0.25 })
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
		if (hovered?.shape) {
			// a soft halo behind it
			ctx.globalCompositeOperation = 'destination-over'
			ctx.globalAlpha = 0.22
			ctx.fillStyle = '#f8fafc'
			ctx.strokeStyle = '#f8fafc'
			ctx.lineWidth = 6
			ctx.lineJoin = 'round'
			ctx.stroke(hovered.shape.path)
			ctx.fill(hovered.shape.path)
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
			const head = w.shape && { x: w.shape.centre.x, y: w.shape.top + 6 }
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
