import type { Editor } from '../editor/Editor'
import type { Vec } from '../editor/geometry'
import type { Worm } from './AgentWorms'
import { LIFT, NATIVE, turn, type EyeState } from './Pointer'

/** a dropped creature is held where it was put this long at most while its new position comes back */
const PIN_MS = 5000

/** Dangling from where it was picked up: a pendulum about the grab point. */
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
	/** the eyes' darting about, peering down at where it'll land */
	dart: Vec
	nextDart: number
}

/**
 * Carrying creatures (their owner drags them, see AgentWorms and Conjure.move): picked up by the
 * point under the pointer, a carried one dangles from there like a pendulum swung by the hand; let
 * go, it stays where it was put (held there until its new position comes back) and turns back the
 * way it points at rest.
 */
export class Carry {
	private swings = new Map<Worm, Swing>()
	/** where creatures were just put, by session id */
	private pins = new Map<string, { at: Vec; until: number }>()

	constructor(
		private editor: Editor,
		private reducedMotion: MediaQueryList,
	) {}

	holds(worm: Worm) {
		return this.swings.has(worm)
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
		this.swings.set(worm, {
			local,
			len: Math.hypot(local.x, local.y),
			a: Math.atan2(-d.y, -d.x),
			v: 0,
			prev: null,
			vel: { x: 0, y: 0 },
			acc: { x: 0, y: 0 },
			to: this.editor.screenToPage(at),
			dart: { x: 0, y: 1 },
			nextDart: 0,
		})
	}

	/** Carried along to screen point `at`. */
	move(worm: Worm, at: Vec) {
		const sw = this.swings.get(worm)
		if (sw) sw.to = this.editor.screenToPage(at)
	}

	/**
	 * Lets go: it stays where it is, squashed a little, and (`put`) is held there while its new
	 * position comes back. Returns where it was put (page space), or null if it wasn't carried.
	 */
	letGo(worm: Worm, put: boolean): Vec | null {
		if (!this.swings.delete(worm)) return null
		const drop = { x: Math.round(worm.root.x), y: Math.round(worm.root.y) }
		worm.modeAt = performance.now()
		worm.dest = { ...drop }
		worm.goal = { ...drop }
		if (!this.reducedMotion.matches) worm.squash = 0.6
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

	/** Dangling from where it's held: a pendulum about the grab point, swung by the carrying. */
	dangle(worm: Worm, dt: number) {
		const sw = this.swings.get(worm)
		if (!sw) return
		const G = this.editor.pageToScreen(sw.to)
		if (sw.prev && dt > 0) {
			const v = { x: (G.x - sw.prev.x) / dt, y: (G.y - sw.prev.y) / dt }
			const a = { x: (v.x - sw.vel.x) / dt, y: (v.y - sw.vel.y) / dt }
			const lim = 9000
			sw.acc = { x: sw.acc.x * 0.5 + Math.max(-lim, Math.min(lim, a.x)) * 0.5, y: sw.acc.y * 0.5 + Math.max(-lim, Math.min(lim, a.y)) * 0.5 }
			sw.vel = v
		}
		sw.prev = G
		if (!this.reducedMotion.matches) {
			// a compound pendulum (its radius of gyration about its centre ~9px), gravity less the hand's acceleration
			const L = sw.len
			const k = L / (81 + L * L)
			for (let left = dt; left > 1e-6; left -= 1 / 120) {
				const h = Math.min(left, 1 / 120)
				const gx = -sw.acc.x
				const gy = 2600 - sw.acc.y
				const torque = Math.cos(sw.a) * gy - Math.sin(sw.a) * gx
				sw.v += (k * torque - 2.4 * sw.v) * h
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

	/** Carried: squinting, peering down at where it'll be dropped, eyes darting. */
	eye(worm: Worm, now: number): EyeState | null {
		const sw = this.swings.get(worm)
		if (!sw) return null
		if (now > sw.nextDart) {
			sw.dart = { x: (Math.random() - 0.5) * 0.9, y: 0.7 + Math.random() * 0.3 }
			sw.nextDart = now + 160 + Math.random() * 260
		}
		return { look: sw.dart, lid: 0.4, wide: 0, slant: 0.25, squeeze: 0, lower: 0.35, dizzy: 0 }
	}

	/** Its worm object was replaced (it woke up or fell asleep mid-carry). */
	replace(prev: Worm, next: Worm) {
		const sw = this.swings.get(prev)
		if (!sw) return
		this.swings.delete(prev)
		this.swings.set(next, sw)
	}

	clear() {
		this.swings.clear()
		this.pins.clear()
	}
}

function rotate(v: Vec, a: number): Vec {
	const c = Math.cos(a)
	const s = Math.sin(a)
	return { x: v.x * c - v.y * s, y: v.x * s + v.y * c }
}
