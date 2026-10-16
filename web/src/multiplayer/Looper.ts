import type { Vec } from '../editor/geometry'

/**
 * The Looper: sessions' creatures (see AgentWorms), an inchworm with one eye. Its body is a chain
 * of points simulated with Verlet integration: fixed-length segments, a bending stiffness, gravity,
 * the ground and air drag. Each state (see AgentWorms) gives it a pose to reach for, a target shape
 * the points are pulled toward by damped springs, so it moves between poses with momentum and
 * wobble rather than by tweening, and dangles like a rope when nothing holds it in shape.
 *
 * Everything here is in screen px in a frame local to the creature: x right, y down, the ground at
 * y = 0. Poses are drawn facing right, with the tail at the start; AgentWorms mirrors and places
 * them. Points are head first.
 */

export const POINTS = 14
/** body length, screen px */
export const LENGTH = 50
export const SEG = LENGTH / (POINTS - 1)
export const HEAD_R = 5.9
const MID_R = 6.1
export const TAIL_R = 4.5
/** fixed simulation step, s */
const STEP = 1 / 120
/** most steps per frame, so a stalled tab doesn't spiral */
const MAX_STEPS = 10
const GRAVITY = 1700

/** Body radius at f, 0 at the head to 1 at the tail: a little thicker mid-body, tapering to the tail. */
export function radius(f: number, size = 1) {
	if (f < 0.32) return (HEAD_R + (MID_R - HEAD_R) * Math.sin(((f / 0.32) * Math.PI) / 2)) * size
	return (MID_R + (TAIL_R - MID_R) * Math.pow((f - 0.32) / 0.68, 1.4)) * size
}

export interface Palette {
	base: string
	/** the underside, in shade */
	shade: string
	/** fine lines: the lid's edge, the closed eye */
	edge: string
}

export function palette(color: string, lighten = 0): Palette {
	const base = mixColor(color, 255, lighten)
	return { base, shade: mixColor(base, 0, 0.2), edge: mixColor(base, 0, 0.5) }
}

// ---------- poses ----------

/**
 * A body grown from its tail at `tail`, its heading (radians, 0 is right, positive turns up) at s
 * along it (0 tail, 1 head) given by `angle`. Head first.
 */
function grow(tail: Vec, angle: (s: number) => number, n = POINTS, len = LENGTH): Vec[] {
	const pts: Vec[] = [{ ...tail }]
	let x = tail.x
	let y = tail.y
	const sub = 4
	const ds = len / (n - 1) / sub
	for (let k = 1; k < n; k++) {
		for (let j = 0; j < sub; j++) {
			const a = angle((k - 1 + (j + 0.5) / sub) / (n - 1))
			x += Math.cos(a) * ds
			y -= Math.sin(a) * ds
		}
		pts.push({ x, y })
	}
	return pts.reverse()
}

/** Moves points so their mean x is `x`. */
function centre(pts: Vec[], x = 0): Vec[] {
	const m = pts.reduce((a, p) => a + p.x, 0) / pts.length
	return pts.map((p) => ({ x: p.x - m + x, y: p.y }))
}

const smooth = (t: number) => {
	const u = Math.min(1, Math.max(0, t))
	return u * u * (3 - 2 * u)
}
const span = (s: number, a: number, b: number) => (s - a) / (b - a)

/**
 * Resting: the tail flat, a low arch in the middle, and the head up looking ahead. `t` (s) drives
 * its breathing (0 holds still); `neck` raises the head more (talking), `bob` nods it.
 */
export function idlePose(t: number, neck = 0, bob = 0): Vec[] {
	const breathe = Math.sin(t * 2.2)
	const hump = 0.5 * (1 + 0.18 * breathe) * (1 - 0.3 * neck)
	const rise = 1.15 + 0.3 * neck + 0.05 * breathe
	return centre(
		grow({ x: 0, y: -TAIL_R }, (s) => {
			if (s < 0.24) return 0
			if (s < 0.6) return hump * Math.sin(2 * Math.PI * span(s, 0.24, 0.6)) * Math.sin(Math.PI * span(s, 0.24, 0.6)) * 1.5
			const u = span(s, 0.6, 1)
			return rise * smooth(u / 0.5) - (rise - 0.2 - bob) * smooth((u - 0.55) / 0.45)
		}),
	)
}

/**
 * Standing up on its tail like a twig: a short foot, the stem, the head bent over at the top.
 * `sway` bends the stem (radians at the top), `bend` is how far the head tips forward.
 */
export function standPose(sway: number, bend: number, len = LENGTH): Vec[] {
	const pts = grow(
		{ x: 0, y: -TAIL_R },
		(s) => {
			if (s < 0.13) return 0
			if (s < 0.27) return (Math.PI / 2) * smooth(span(s, 0.13, 0.27))
			const stem = Math.min(1, span(s, 0.27, 0.84))
			let a = Math.PI / 2 + sway * stem * stem
			if (s > 0.84) a -= bend * smooth(span(s, 0.84, 1))
			return a
		},
		POINTS,
		len,
	)
	// the stem's foot at x 0
	const foot = pts[Math.round((POINTS - 1) * 0.75)].x
	return pts.map((p) => ({ x: p.x - foot, y: p.y }))
}

/** Smooth value noise, about -1..1: wobbles that never quite repeat. */
export function noise(x: number) {
	const i = Math.floor(x)
	const f = x - i
	const u = f * f * (3 - 2 * f)
	return hash(i) + (hash(i + 1) - hash(i)) * u
}

function hash(i: number) {
	const h = Math.sin(i * 127.1 + 311.7) * 43758.5453
	return (h - Math.floor(h)) * 2 - 1
}

/** Two octaves of noise. */
export function wobble(x: number) {
	return noise(x) * 0.68 + noise(x * 2.3 + 17.3) * 0.32
}

export interface Writhe {
	/** seconds (0 holds still) */
	t: number
	/** 0..1 how worked up it is */
	intensity: number
	/** 0..1 bunched up tight in folds */
	clench: number
	/** 0..1 straining up tall */
	strain: number
	/** 0..1 head pressed down, as if into its hands */
	press: number
}

/**
 * Thinking hard about something maddening: up on its planted tail like standPose, but writhing,
 * with irregular twists running up the body, the head thrashing, the tail coiling and uncoiling;
 * bunched into tight folds when it clenches, pulled tall when it strains, bowed over with its head
 * pressed down.
 */
export function writhePose(w: Writhe): Vec[] {
	const { t, intensity: I, clench, strain, press } = w
	const coil = I * Math.max(0, 0.35 + 0.9 * wobble(t * 0.6 + 40)) * (1 - strain)
	const lean = 0.3 * wobble(t * 0.5 + 7) * I + 1.15 * press
	const thrash = I * 0.7 * wobble(t * 3.4 + 3) * (1 - press)
	const bend = 0.85 + thrash + 2.2 * press - 1.0 * strain
	const pts = grow(
		{ x: 0, y: -TAIL_R - 5 * coil },
		(s) => {
			// the tail tip curled up off the ground
			if (s < 0.13) return -coil * 1.6 * (1 - s / 0.13)
			if (s < 0.27) return (Math.PI / 2) * smooth(span(s, 0.13, 0.27)) - lean * smooth(span(s, 0.13, 0.27)) * 0.5
			const stem = Math.min(1, span(s, 0.27, 0.84))
			// twists travelling up it, never the same twice
			const twist = I * (1 - 0.7 * strain) * (0.95 * wobble(t * 2 - s * 3.1) + 0.5 * wobble(t * 3.8 - s * 5.3 + 9))
			// clenched: folded tight, zig-zag
			const fold = clench * 1.25 * Math.sin(s * 15 - t * 1.5)
			let a = Math.PI / 2 - lean * 0.5 + twist * (0.4 + stem) + fold * stem
			if (s > 0.84) a -= bend * smooth(span(s, 0.84, 1))
			return a
		},
	)
	const foot = pts[Math.round((POINTS - 1) * 0.75)].x
	return pts.map((p) => ({ x: p.x - foot, y: p.y }))
}

/** Curled up asleep: a ring on the ground, the head tucked in at the bottom. `breath` -1..1. */
export function curlPose(breath: number): Vec[] {
	const turn = 2 * Math.PI - 0.95
	const k = 1 + 0.035 * breath
	const pts = grow({ x: 0, y: -TAIL_R }, (s) => turn * s)
	// breathing about where it sits on the ground
	return centre(pts).map((p) => ({ x: p.x * k, y: -TAIL_R + (p.y + TAIL_R) * k }))
}

/** Lying flat, from its tail at `tail`, the head lifted a touch: how it lands after turning around. */
export function flatPose(tail: Vec): Vec[] {
	return grow(tail, (s) => (s > 0.8 ? 0.5 * smooth(span(s, 0.8, 1)) : 0))
}

/**
 * Between two feet on the ground: an arch of the body's length, tall and pinched into an Ω when the
 * feet are close, flat when they're a body length apart. `a` is the tail's foot, `b` the head's.
 */
export function archPose(a: Vec, b: Vec, n = POINTS, len = LENGTH): Vec[] {
	const dx = b.x - a.x
	const dy = b.y - a.y
	const F = Math.hypot(dx, dy) || 1e-6
	const ux = dx / F
	const uy = dy / F
	const pinch = Math.max(0, 0.62 * len - F) * 0.24
	const at = (t: number, H: number): Vec => {
		const w = pinch * Math.sin(2 * Math.PI * t)
		return { x: a.x + dx * t - ux * w, y: a.y + dy * t - uy * w - H * Math.pow(Math.sin(Math.PI * t), 0.85) }
	}
	const M = 40
	const length = (H: number) => {
		let l = 0
		let p = at(0, H)
		for (let i = 1; i <= M; i++) {
			const q = at(i / M, H)
			l += Math.hypot(q.x - p.x, q.y - p.y)
			p = q
		}
		return l
	}
	let H = 0
	if (length(0) < len) {
		let lo = 0
		let hi = len
		for (let i = 0; i < 18; i++) {
			const mid = (lo + hi) / 2
			if (length(mid) < len) lo = mid
			else hi = mid
		}
		H = (lo + hi) / 2
	}
	// resample evenly by length
	const samples: Vec[] = []
	const cum: number[] = [0]
	for (let i = 0; i <= M * 2; i++) samples.push(at(i / (M * 2), H))
	for (let i = 1; i < samples.length; i++) cum.push(cum[i - 1] + Math.hypot(samples[i].x - samples[i - 1].x, samples[i].y - samples[i - 1].y))
	const total = cum[cum.length - 1]
	const out: Vec[] = []
	let j = 0
	for (let k = 0; k < n; k++) {
		const want = (k / (n - 1)) * total
		while (j < cum.length - 2 && cum[j + 1] < want) j++
		const f = (want - cum[j]) / (cum[j + 1] - cum[j] || 1)
		out.push({ x: samples[j].x + (samples[j + 1].x - samples[j].x) * f, y: samples[j].y + (samples[j + 1].y - samples[j].y) * f })
	}
	return out.reverse()
}

/** A pose mirrored to face `facing` and moved over by `x`. */
export function place(pose: Vec[], facing: number, x: number, y = 0): Vec[] {
	return pose.map((p) => ({ x: p.x * facing + x, y: p.y + y }))
}

// ---------- physics ----------

export class Body {
	p: Vec[]
	private q: Vec[]
	private acc = 0
	/** the pose it reaches for, and how hard (spring stiffness, 1/s²), per point (weights) */
	target: Vec[] | null = null
	k = 220
	weights: number[] | null = null
	/** 0..1 how much it holds itself up in its pose (0: limp, carried or falling) */
	pose = 1
	/** segment length multiplier */
	stretch = 1
	/** held point: index, where it is, and where it's being taken (it follows quickly, not instantly, so a yank doesn't explode the body) */
	pin: { i: number; at: Vec; to: Vec } | null = null
	ground = true
	/** wriggling (carried), px/s² */
	wriggle = 0
	private phase = 0
	/** the fastest a point hit the ground since it was last read, px/s */
	impact = 0
	touching = false

	constructor(pts: Vec[]) {
		this.p = pts.map((v) => ({ ...v }))
		this.q = pts.map((v) => ({ ...v }))
	}

	/** Puts it straight into a shape, at rest. */
	set(pts: Vec[]) {
		for (let i = 0; i < POINTS; i++) {
			this.p[i] = { ...pts[i] }
			this.q[i] = { ...pts[i] }
		}
	}

	shift(dx: number, dy: number) {
		for (let i = 0; i < POINTS; i++) {
			this.p[i].x += dx
			this.p[i].y += dy
			this.q[i].x += dx
			this.q[i].y += dy
		}
		if (this.pin) {
			this.pin.at = { x: this.pin.at.x + dx, y: this.pin.at.y + dy }
			this.pin.to = { x: this.pin.to.x + dx, y: this.pin.to.y + dy }
		}
	}

	/** Holds point i, taking it to `to`; null lets go. */
	hold(i: number | null, to?: Vec) {
		if (i === null || !to) this.pin = null
		else if (this.pin?.i === i) this.pin.to = { ...to }
		else this.pin = { i, at: { ...this.p[i] }, to: { ...to } }
	}

	/** Adds velocity (px/s) to point i. */
	push(i: number, vx: number, vy: number) {
		this.q[i].x -= vx * STEP
		this.q[i].y -= vy * STEP
	}

	velocity(i: number): Vec {
		return { x: (this.p[i].x - this.q[i].x) / STEP, y: (this.p[i].y - this.q[i].y) / STEP }
	}

	/** Runs the fixed-step simulation for `ms`. */
	run(ms: number) {
		this.acc = Math.min(this.acc + ms / 1000, STEP * MAX_STEPS)
		while (this.acc >= STEP) {
			this.acc -= STEP
			this.tick()
		}
	}

	private tick() {
		const h = STEP
		const { p, q, target, pose } = this
		const k = this.k * pose
		const g = GRAVITY * (1 - 0.85 * pose)
		const drag = 1.5 + 2 * pose
		const pin = this.pin
		if (pin) {
			const f = 1 - Math.exp(-h / 0.02)
			pin.at = { x: pin.at.x + (pin.to.x - pin.at.x) * f, y: pin.at.y + (pin.to.y - pin.at.y) * f }
		}
		this.phase += h * 13
		for (let i = 0; i < POINTS; i++) {
			const vx = (p[i].x - q[i].x) / h
			const vy = (p[i].y - q[i].y) / h
			let ax = -drag * vx
			let ay = g - drag * vy
			if (target && k > 0) {
				const ki = k * (this.weights?.[i] ?? 1)
				const c = 2 * 0.5 * Math.sqrt(ki)
				ax += ki * (target[i].x - p[i].x) - c * vx
				ay += ki * (target[i].y - p[i].y) - c * vy
			}
			if (this.wriggle) {
				// a wave down the body, side to side across it, strongest at the free end
				const a = p[Math.max(0, i - 1)]
				const b = p[Math.min(POINTS - 1, i + 1)]
				const tl = Math.hypot(b.x - a.x, b.y - a.y) || 1
				const w = this.wriggle * Math.sin(this.phase - i * 0.8) * (0.3 + 0.7 * Math.abs(i - (this.pin?.i ?? 0)) / POINTS)
				ax += (-(b.y - a.y) / tl) * w
				ay += ((b.x - a.x) / tl) * w
			}
			// (and never faster than this, however hard it's yanked)
			let nx = vx + ax * h
			let ny = vy + ay * h
			const sp = Math.hypot(nx, ny)
			if (sp > 2600) {
				nx *= 2600 / sp
				ny *= 2600 / sp
			}
			q[i] = { x: p[i].x, y: p[i].y }
			p[i] = { x: p[i].x + nx * h, y: p[i].y + ny * h }
		}
		const rest = SEG * this.stretch
		// limp, it hardly holds a shape: it hangs and folds like a rope
		const posed = !!target && pose > 0.05
		const bend = posed ? 0.07 * pose : 0
		this.touching = false
		for (let it = 0; it < 8; it++) {
			for (let i = 0; i < POINTS - 1; i++) {
				const a = p[i]
				const b = p[i + 1]
				const dx = b.x - a.x
				const dy = b.y - a.y
				const d = Math.hypot(dx, dy) || 1e-6
				const diff = (d - rest) / d
				const pa = this.pin?.i === i
				const pb = this.pin?.i === i + 1
				const wa = pa ? 0 : pb ? 1 : 0.5
				const wb = pb ? 0 : pa ? 1 : 0.5
				a.x += dx * diff * wa
				a.y += dy * diff * wa
				b.x -= dx * diff * wb
				b.y -= dy * diff * wb
			}
			// Limp, it can't pass through itself: hanging halves stay side by side, not one inside the other.
			if (!posed) {
				for (let i = 0; i < POINTS; i++) {
					for (let j = i + 4; j < POINTS; j++) {
						const dx = p[j].x - p[i].x
						const dy = p[j].y - p[i].y
						const d = Math.hypot(dx, dy) || 1e-6
						const min = (radius(i / (POINTS - 1)) + radius(j / (POINTS - 1))) * 0.9
						if (d >= min) continue
						const push = ((min - d) / d) * 0.5
						const wi = pin?.i === i ? 0 : pin?.i === j ? 2 : 1
						const wj = pin?.i === j ? 0 : pin?.i === i ? 2 : 1
						p[i].x -= dx * push * wi * 0.5
						p[i].y -= dy * push * wi * 0.5
						p[j].x += dx * push * wj * 0.5
						p[j].y += dy * push * wj * 0.5
					}
				}
			}
			// Bending: each joint's curvature toward the pose's. Limp, a little toward straight once a
			// step, and stiffer right by a held point, so it hangs from a short level stretch.
			for (let i = 1; i < POINTS - 1 && (posed || it === 0); i++) {
				let bx = 0
				let by = 0
				if (target && pose > 0.05) {
					bx = target[i - 1].x + target[i + 1].x - 2 * target[i].x
					by = target[i - 1].y + target[i + 1].y - 2 * target[i].y
				}
				const cx = p[i - 1].x + p[i + 1].x - 2 * p[i].x
				const cy = p[i - 1].y + p[i + 1].y - 2 * p[i].y
				const k = posed ? bend : pin && Math.abs(i - pin.i) <= 2 ? 0.3 : 0.035
				const dx = (bx - cx) * k
				const dy = (by - cy) * k
				p[i].x -= dx / 3
				p[i].y -= dy / 3
				p[i - 1].x += dx / 6
				p[i - 1].y += dy / 6
				p[i + 1].x += dx / 6
				p[i + 1].y += dy / 6
			}
			if (this.ground) {
				for (let i = 0; i < POINTS; i++) {
					const floor = -radius(i / (POINTS - 1))
					if (p[i].y > floor) {
						if (it === 0) this.impact = Math.max(this.impact, (p[i].y - q[i].y) / h)
						p[i].y = floor
						this.touching = true
					}
				}
			}
			if (pin) p[pin.i] = { ...pin.at }
		}
		// Friction where it touches the ground, so planted feet stay put.
		if (this.ground) {
			for (let i = 0; i < POINTS; i++) {
				if (p[i].y >= -radius(i / (POINTS - 1)) - 0.3) q[i].x = p[i].x - (p[i].x - q[i].x) * 0.7
			}
		}
	}
}

// ---------- drawing ----------

/** Smooth samples through points, `per` samples per span. */
export function catmullRom(pts: Vec[], per: number): Vec[] {
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

/** The tube as one path: a disc at every sample, filled as their union. */
function tube(samples: Vec[], size: number) {
	const path = new Path2D()
	const n = samples.length
	for (let i = 0; i < n; i++) {
		const r = radius(i / (n - 1), size)
		const p = samples[i]
		path.moveTo(p.x + r, p.y)
		path.arc(p.x, p.y, r, 0, Math.PI * 2)
	}
	return path
}

export interface EyeState {
	/** where it looks, -1..1 across the eye */
	look: Vec
	/** 0 open .. 1 shut */
	lid: number
	/** 0..1 wide open (alarm), a bigger eye and smaller pupil */
	wide: number
	/** a furrowed lid: its edge sloping down toward the front, radians */
	slant?: number
	/** 0..1 shut tight (a hard straight line rather than a sleepy curve) */
	squeeze?: number
}

/** Little strain marks by the head, flicking in and out (thinking hard), and a bead of sweat. */
export interface Stress {
	amount: number
	t: number
	color: string
}

/**
 * The Looper on screen (points in screen px, head first): a smooth tube in its colour with a
 * slightly darker underside, and its eye on the head. Returns the samples, for hit testing.
 */
export function drawLooper(ctx: CanvasRenderingContext2D, pts: Vec[], eye: EyeState, pal: Palette, size = 1, shaded = true, stress?: Stress): Vec[] {
	const samples = catmullRom(pts, 4)
	const path = tube(samples, size)
	if (shaded) {
		ctx.save()
		ctx.clip(path)
		ctx.fillStyle = pal.shade
		ctx.fill(path)
		// light from above: the body again, nudged up, leaves its underside in shade
		ctx.translate(0, -1.5 * size)
		ctx.fillStyle = pal.base
		ctx.fill(path)
		ctx.restore()
	} else {
		ctx.fillStyle = pal.base
		ctx.fill(path)
	}
	const head = samples[0]
	const neck = samples[Math.min(samples.length - 1, 3)]
	const fl = Math.hypot(head.x - neck.x, head.y - neck.y) || 1
	const fwd = { x: (head.x - neck.x) / fl, y: (head.y - neck.y) / fl }
	drawEye(ctx, head, fwd, radius(0, size), eye, pal)
	if (stress && stress.amount > 0.02) drawStress(ctx, head, fwd, radius(0, size), stress)
	return samples
}

function drawStress(ctx: CanvasRenderingContext2D, head: Vec, fwd: Vec, r: number, s: Stress) {
	const side = fwd.x < 0 ? -1 : 1
	const a0 = ctx.globalAlpha
	ctx.save()
	ctx.strokeStyle = s.color
	ctx.lineCap = 'round'
	ctx.lineWidth = Math.max(1, r * 0.2)
	// three ticks fanned over the back of the head
	const cx = head.x - side * r * 0.2
	const cy = head.y - r * 0.4
	for (let i = 0; i < 3; i++) {
		const on = Math.min(1, Math.max(0, (wobble(s.t * 2.6 + i * 7.1) + 0.15) * 3))
		if (on <= 0.01) continue
		const a = -Math.PI / 2 + side * (i - 1) * 0.55 - side * 0.35
		const d0 = r * 1.55
		const d1 = d0 + r * (0.55 + 0.25 * on)
		ctx.globalAlpha = a0 * s.amount * on
		ctx.beginPath()
		ctx.moveTo(cx + Math.cos(a) * d0, cy + Math.sin(a) * d0)
		ctx.lineTo(cx + Math.cos(a) * d1, cy + Math.sin(a) * d1)
		ctx.stroke()
	}
	// a bead of sweat sliding down the front of the head now and then
	const u = (s.t * 0.45) % 1
	if (u < 0.6) {
		const k = u / 0.6
		const x = head.x + side * r * 1.05
		const y = head.y - r * 0.5 + k * r * 1.1
		const dr = r * 0.26
		ctx.globalAlpha = a0 * s.amount * Math.min(1, (1 - k) * 3, k * 6) * 0.9
		ctx.fillStyle = '#e0f2fe'
		ctx.beginPath()
		ctx.moveTo(x, y - dr * 2)
		ctx.quadraticCurveTo(x + dr * 1.2, y + dr * 0.2, x, y + dr)
		ctx.quadraticCurveTo(x - dr * 1.2, y + dr * 0.2, x, y - dr * 2)
		ctx.fill()
	}
	ctx.restore()
}

function drawEye(ctx: CanvasRenderingContext2D, head: Vec, fwd: Vec, r: number, eye: EyeState, pal: Palette) {
	const er = r * (0.66 + 0.12 * eye.wide)
	const cx = head.x + fwd.x * r * 0.18
	const cy = head.y + fwd.y * r * 0.18 - r * 0.06
	ctx.save()
	ctx.beginPath()
	ctx.arc(cx, cy, er, 0, Math.PI * 2)
	ctx.fillStyle = '#f8fafc'
	ctx.fill()
	ctx.clip()
	const pr = er * (0.52 - 0.14 * eye.wide)
	const reach = er - pr - 0.35
	const ll = Math.hypot(eye.look.x, eye.look.y)
	const k = ll > 1 ? 1 / ll : 1
	ctx.beginPath()
	ctx.arc(cx + eye.look.x * k * reach, cy + eye.look.y * k * reach, pr, 0, Math.PI * 2)
	ctx.fillStyle = '#16161a'
	ctx.fill()
	// The lid, in the body's colour, coming down from the top.
	const lid = Math.min(1, Math.max(0, eye.lid))
	const squeeze = eye.squeeze ?? 0
	if (lid > 0.02) {
		const edge = cy - er + 2 * er * lid
		// sloping down toward the front: a furrowed brow
		const tilt = Math.tan(eye.slant ?? 0) * er * (fwd.x < 0 ? -1 : 1)
		ctx.fillStyle = pal.base
		ctx.beginPath()
		ctx.moveTo(cx - er - 1, cy - er - 1)
		ctx.lineTo(cx + er + 1, cy - er - 1)
		ctx.lineTo(cx + er + 1, edge + tilt)
		ctx.lineTo(cx - er - 1, edge - tilt)
		ctx.closePath()
		ctx.fill()
		ctx.strokeStyle = pal.edge
		ctx.lineWidth = Math.max(0.9, r * (lid > 0.92 ? 0.2 : 0.14))
		ctx.lineCap = 'round'
		ctx.beginPath()
		if (lid > 0.92 && squeeze > 0.5) {
			// screwed shut: a hard line, a crease under it
			ctx.moveTo(cx - er * 0.85, cy - tilt * 0.85)
			ctx.lineTo(cx + er * 0.85, cy + tilt * 0.85)
			ctx.moveTo(cx - er * 0.45, cy + er * 0.45 - tilt * 0.4)
			ctx.lineTo(cx + er * 0.45, cy + er * 0.45 + tilt * 0.4)
		} else if (lid > 0.92) {
			// shut: a soft curve
			ctx.arc(cx, cy - er * 0.3, er * 0.72, Math.PI * 0.2, Math.PI * 0.8)
		} else {
			ctx.moveTo(cx - er, edge - tilt)
			ctx.lineTo(cx + er, edge + tilt)
		}
		ctx.stroke()
	}
	ctx.restore()
}

/** A subagent's tiny looper: flat colour, a dot of an eye. */
export function drawTiny(ctx: CanvasRenderingContext2D, pts: Vec[], size: number, color: string, look: Vec) {
	const samples = catmullRom(pts, 3)
	ctx.fillStyle = color
	ctx.fill(tube(samples, size))
	const head = samples[0]
	const r = radius(0, size)
	ctx.fillStyle = '#f8fafc'
	ctx.beginPath()
	ctx.arc(head.x, head.y - r * 0.05, r * 0.7, 0, Math.PI * 2)
	ctx.fill()
	ctx.fillStyle = '#16161a'
	ctx.beginPath()
	ctx.arc(head.x + look.x * r * 0.28, head.y - r * 0.05 + look.y * r * 0.22, r * 0.36, 0, Math.PI * 2)
	ctx.fill()
	return samples
}

/** The colour mixed toward black (0) or white (255) by k. */
export function mixColor(color: string, to: number, k: number) {
	const rgb = parseColor(color) ?? [34, 211, 238]
	return `rgb(${rgb.map((c) => Math.round(c + (to - c) * k)).join(', ')})`
}

function parseColor(color: string): number[] | null {
	const rgb = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(color.trim())
	if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
	const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())
	if (!m) return null
	const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1]
	return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16))
}
