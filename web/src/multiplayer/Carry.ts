import type { Editor } from '../editor/Editor'
import type { Vec } from '../editor/geometry'
import type { Worm } from './AgentWorms'
import { LIFT, NATIVE, turn, type EyeState } from './Pointer'

/** a dropped creature is held where it was put this long at most while its new position comes back */
const PIN_MS = 5000
/** its radius of gyration about its centre, squared (screen px²) */
const GYRATION2 = 81
/** held: how fast its spin dies away (1/s), and the fastest it spins (rad/s) */
const SPIN_DAMP = 0.8
const SPIN_MAX = 14
/** the hand's acceleration is taken as at most this (screen px/s²); below ACC_MIN it's taken as none, coming in fully by ACC_FULL (so slow drags barely turn it) */
const ACC_MAX = 9000
const ACC_MIN = 500
const ACC_FULL = 2500
/** let go: how fast its drift and its spin die away (1/s), the furthest it drifts (screen px), and when it's still enough to stop */
const DRIFT_DAMP = 4
const DRIFT_SPIN_DAMP = 2.6
const DRIFT_MAX_PX = 240
const DRIFT_STOP_PX = 12
const DRIFT_STOP_SPIN = 0.6
const DRIFT_MAX_MS = 1800

/** Held by the grab point, floating: a rigid body pinned there, turned only by how the hand accelerates. */
interface Swing {
	/** the grab point from its centre, in its own unturned frame (screen px) */
	local: Vec
	len: number
	/** the angle from the grab point to its centre, and how fast that turns */
	a: number
	v: number
	/** the grab point on screen last frame, its velocity and acceleration */
	prev: Vec | null
	vel: Vec
	acc: Vec
	/** where the grab point is carried to (page space) */
	to: Vec
	/** the eyes' darting about */
	dart: Vec
	nextDart: number
}

/** Let go, floating on: drifting (page px/s) and spinning (rad/s), both dying away, until it comes to rest at `to`. */
interface Drift {
	vel: Vec
	spin: number
	to: Vec
	at: number
}

/**
 * Carrying creatures (their owner drags them, see AgentWorms and Conjure.move): picked up by the
 * point under the pointer, a carried one floats from there as if in space: no gravity, it turns only
 * as the hand's acceleration swings it about the grab point (a flick sets it spinning; it keeps
 * turning, slowly slowing). Let go, it drifts and spins on a moment, dying away, to where it comes to
 * rest (which is where it's put: held there until its new position comes back), then turns back the
 * way it points at rest.
 */
export class Carry {
	private swings = new Map<Worm, Swing>()
	private drifts = new Map<Worm, Drift>()
	/** where creatures were just put, by session id */
	private pins = new Map<string, { at: Vec; until: number }>()

	constructor(
		private editor: Editor,
		private reducedMotion: MediaQueryList,
	) {}

	/** Carried, or drifting on from being let go. */
	holds(worm: Worm) {
		return this.swings.has(worm) || this.drifts.has(worm)
	}

	/** Picked up by the point under the pointer (screen `at`; `centre`: its centre on screen). */
	pickUp(worm: Worm, at: Vec, centre: Vec) {
		const rho = worm.heading - NATIVE
		const d = { x: at.x - centre.x, y: at.y - centre.y }
		const local = rotate(d, -rho)
		worm.mode = 'here'
		worm.warpTo = null
		worm.trip = null
		worm.vel = { x: 0, y: 0 }
		worm.off = { x: 0, y: 0 }
		worm.offV = { x: 0, y: 0 }
		if (worm.sessionId) this.pins.delete(worm.sessionId)
		const drift = this.drifts.get(worm)
		this.drifts.delete(worm)
		this.swings.set(worm, {
			local,
			len: Math.hypot(local.x, local.y),
			a: Math.atan2(-d.y, -d.x),
			v: drift?.spin ?? 0,
			prev: null,
			vel: { x: 0, y: 0 },
			acc: { x: 0, y: 0 },
			to: this.editor.screenToPage(at),
			dart: { x: 0, y: 0 },
			nextDart: 0,
		})
	}

	/** Carried along to screen point `at`. */
	move(worm: Worm, at: Vec) {
		const sw = this.swings.get(worm)
		if (sw) sw.to = this.editor.screenToPage(at)
	}

	/**
	 * Lets go: (`put`) it drifts on, spinning, to where it comes to rest, and is held there while its
	 * new position comes back. Returns where that is (page space), or null if it wasn't carried. Not
	 * put (it's leaving, or the drop failed), it stops where it is.
	 */
	letGo(worm: Worm, put: boolean): Vec | null {
		this.drifts.delete(worm)
		const sw = this.swings.get(worm)
		if (!sw) return null
		this.swings.delete(worm)
		let drop = { x: Math.round(worm.root.x), y: Math.round(worm.root.y) }
		if (put && !this.reducedMotion.matches) {
			// (it drifts v/DRIFT_DAMP all told, dying away; no further than DRIFT_MAX_PX)
			const z = this.editor.camera.peek().z
			let vel = { x: sw.vel.x / z, y: sw.vel.y / z }
			const far = (Math.hypot(vel.x, vel.y) / DRIFT_DAMP) * z
			if (far > DRIFT_MAX_PX) vel = { x: (vel.x * DRIFT_MAX_PX) / far, y: (vel.y * DRIFT_MAX_PX) / far }
			drop = { x: Math.round(worm.root.x + vel.x / DRIFT_DAMP), y: Math.round(worm.root.y + vel.y / DRIFT_DAMP) }
			this.drifts.set(worm, { vel, spin: sw.v, to: drop, at: performance.now() })
		}
		worm.modeAt = performance.now()
		worm.dest = { ...drop }
		worm.goal = { ...drop }
		if (!this.reducedMotion.matches) worm.squash = 0.35
		if (put && worm.sessionId) this.pins.set(worm.sessionId, { at: drop, until: performance.now() + PIN_MS })
		return drop
	}

	/** It wasn't put there after all (the move was refused): back to where its record says. */
	unpin(sessionId: string) {
		this.pins.delete(sessionId)
	}

	/** Where it was just put, while that holds over where its presence says it is (`cursor`). */
	pinned(worm: Worm, cursor: Vec | null | undefined, now: number): Vec | null {
		const pin = worm.sessionId ? this.pins.get(worm.sessionId) : undefined
		if (!pin) return null
		if (now > pin.until || (cursor && Math.abs(cursor.x - pin.at.x) < 1.5 && Math.abs(cursor.y - pin.at.y) < 1.5)) {
			this.pins.delete(worm.sessionId!)
			return null
		}
		return pin.at
	}

	/**
	 * Floating where it's held: a rigid body pinned at the grab point, with no gravity. Only the
	 * hand's acceleration turns it (in its frame, a pull on its centre the other way), so a steady
	 * drag hardly does and a flick sets it spinning. Let go, it drifts on (see drift).
	 */
	dangle(worm: Worm, dt: number) {
		const sw = this.swings.get(worm)
		if (!sw) return this.drift(worm, dt)
		const G = this.editor.pageToScreen(sw.to)
		if (sw.prev && dt > 0) {
			const v = { x: (G.x - sw.prev.x) / dt, y: (G.y - sw.prev.y) / dt }
			const a = { x: (v.x - sw.vel.x) / dt, y: (v.y - sw.vel.y) / dt }
			const clamp = (n: number) => Math.max(-ACC_MAX, Math.min(ACC_MAX, n))
			sw.acc = { x: sw.acc.x * 0.5 + clamp(a.x) * 0.5, y: sw.acc.y * 0.5 + clamp(a.y) * 0.5 }
			sw.vel = { x: sw.vel.x * 0.35 + v.x * 0.65, y: sw.vel.y * 0.35 + v.y * 0.65 }
		}
		sw.prev = G
		if (!this.reducedMotion.matches) {
			// angular acceleration about the grab point: (centre - grab) × (-acc) / (k² + L²), per unit mass
			const L = sw.len
			const mag = Math.hypot(sw.acc.x, sw.acc.y)
			const u = Math.min(1, Math.max(0, (mag - ACC_MIN) / (ACC_FULL - ACC_MIN)))
			const k = (L / (GYRATION2 + L * L)) * u * u * (3 - 2 * u)
			for (let left = dt; left > 1e-6; left -= 1 / 120) {
				const h = Math.min(left, 1 / 120)
				const torque = Math.sin(sw.a) * sw.acc.x - Math.cos(sw.a) * sw.acc.y
				sw.v += (k * torque - SPIN_DAMP * sw.v) * h
				sw.v = Math.max(-SPIN_MAX, Math.min(SPIN_MAX, sw.v))
				sw.a += sw.v * h
			}
			worm.heading = turn(0, sw.a - Math.atan2(-sw.local.y, -sw.local.x) + NATIVE)
			worm.spin = sw.v
		}
		const l = rotate(sw.local, worm.heading - NATIVE)
		worm.root = this.editor.screenToPage({ x: G.x - l.x, y: G.y - l.y + LIFT })
		worm.dest = { ...worm.root }
		worm.off = { x: 0, y: 0 }
		worm.offV = { x: 0, y: 0 }
	}

	/** Let go: drifting on and spinning, dying away; once it's still enough, it rests where it was put. */
	private drift(worm: Worm, dt: number) {
		const d = this.drifts.get(worm)
		if (!d) return
		const z = this.editor.camera.peek().z
		const fade = Math.exp(-DRIFT_DAMP * dt)
		worm.root = { x: worm.root.x + d.vel.x * dt, y: worm.root.y + d.vel.y * dt }
		d.vel = { x: d.vel.x * fade, y: d.vel.y * fade }
		worm.heading = turn(0, worm.heading + d.spin * dt)
		d.spin *= Math.exp(-DRIFT_SPIN_DAMP * dt)
		worm.spin = d.spin
		worm.vel = { x: 0, y: 0 }
		worm.dest = { ...d.to }
		worm.off = { x: 0, y: 0 }
		worm.offV = { x: 0, y: 0 }
		const still = Math.hypot(d.vel.x, d.vel.y) * z < DRIFT_STOP_PX && Math.abs(d.spin) < DRIFT_STOP_SPIN
		if (still || performance.now() - d.at > DRIFT_MAX_MS) {
			// (the rest of the way, and turning back how it points at rest, are its usual settling)
			this.drifts.delete(worm)
			worm.vel = { x: d.vel.x, y: d.vel.y }
		}
	}

	/** Carried or drifting: eyes darting about, wide and dizzy while it spins fast. */
	eye(worm: Worm, now: number): EyeState | null {
		const sw = this.swings.get(worm)
		const d = this.drifts.get(worm)
		if (!sw && !d) return null
		const spin = Math.abs(sw ? sw.v : d!.spin)
		if (sw && now > sw.nextDart) {
			const a = Math.random() * Math.PI * 2
			const r = 0.4 + Math.random() * 0.5
			sw.dart = { x: Math.cos(a) * r, y: Math.sin(a) * r }
			sw.nextDart = now + 160 + Math.random() * 260
		}
		const dizzy = Math.min(1, Math.max(0, (spin - 5) / 6))
		const look = sw ? sw.dart : { x: 0, y: 0 }
		return { look, lid: dizzy ? 0 : 0.2, wide: Math.min(1, spin / 8), slant: 0, squeeze: 0, lower: 0, dizzy }
	}

	/** Its worm object was replaced (it woke up or fell asleep mid-carry). */
	replace(prev: Worm, next: Worm) {
		const sw = this.swings.get(prev)
		const d = this.drifts.get(prev)
		this.swings.delete(prev)
		this.drifts.delete(prev)
		if (sw) this.swings.set(next, sw)
		if (d) this.drifts.set(next, d)
	}

	clear() {
		this.swings.clear()
		this.drifts.clear()
		this.pins.clear()
	}
}

function rotate(v: Vec, a: number): Vec {
	const c = Math.cos(a)
	const s = Math.sin(a)
	return { x: v.x * c - v.y * s, y: v.x * s + v.y * c }
}
