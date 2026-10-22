/**
 * The smooth fields subagent visuals are seen through (see dots.ts): the Ember busy band's
 * clumps (render/busy/ember.ts) on a plane instead of round a frame, plus the state looks every
 * representation shares. Everything is a continuous function of position and time, so the only
 * motion is the field moving through a fixed grid of dots.
 */

export type RGB = readonly [number, number, number]

export type KidState = 'running' | 'done' | 'failed' | 'waiting'

/** Ember's settings that matter on a plane (CSS px, s). */
export interface ClumpSettings {
	/** noise size, CSS px */
	scale: number
	/** how much of the noise stays dark: higher, sparser clumps */
	sparse: number
	/** the halo round each clump */
	dim: number
}

export const CLUMPS: ClumpSettings = { scale: 9, sparse: 0.525, dim: 0.3 }

/** Failed: a red that isn't one of the session colours. */
export const FAIL_RGB: RGB = [239, 68, 68]

/**
 * How a subagent looks right now: its state weights (summing to 1, crossfading after a change), the
 * resolve flash after it finishes, the field's clock (it stops when the subagent does), and how
 * open (its frame expanded) and hovered it is.
 */
export interface KidLook {
	run: number
	done: number
	fail: number
	wait: number
	/** 0..1: the bright fill a finished subagent resolves through (like a frame's done band) */
	flash: number
	/** the field's time, s: runs while working or waiting, stops when it finishes */
	clock: number
	/** 0..1 */
	open: number
	/** 0..1 */
	hover: number
	/** waiting: 0..1, a slow breath */
	breath: number
}

/** Planar clumps at (x, y) CSS px: two noise layers crawling in opposite directions along x, drifting along y. */
export function clumps(x: number, y: number, t: number, seed: number, crawl: number, drift: number, s: ClumpSettings = CLUMPS) {
	const a = noise3((x - t * crawl) / s.scale + seed * 7.1, (y - t * drift) / s.scale + seed * 3.3, t * 0.11 + seed * 2.9)
	const b = noise3((x + t * crawl) / (s.scale * 1.15) + seed * 5.7 + 9, (y - t * drift * 1.1) / (s.scale * 1.15) + seed * 1.7, t * 0.13 + seed * 4.1 + 9)
	return shape(Math.max(a, b), s)
}

/** Clumps round a loop: `arc` CSS px along it, of `length`, crawling at `crawl` CSS px/s (wraps seamlessly). */
export function loopClumps(arc: number, length: number, t: number, seed: number, crawl: number, s: ClumpSettings = CLUMPS) {
	const R = length / (2 * Math.PI * s.scale)
	const a1 = ((arc - t * crawl) / length) * 2 * Math.PI
	const a2 = ((arc + t * crawl) / length) * 2 * Math.PI
	const a = noise3(Math.cos(a1) * R + seed * 11.7, Math.sin(a1) * R + seed * 5.3, t * 0.11 + seed * 2.9)
	const b = noise3(Math.cos(a2) * R * 0.87 + seed * 3.1 + 9, Math.sin(a2) * R * 0.87 + seed * 7.9, t * 0.13 + seed * 1.3 + 9)
	return shape(Math.max(a, b), s)
}

/** Bright peaks and a dimmer halo round them, as Ember draws them. */
function shape(m: number, s: ClumpSettings) {
	const bright = smoothstep(s.sparse + 0.06, s.sparse + 0.12, m)
	const dim = smoothstep(s.sparse - 0.02, s.sparse + 0.03, m) * s.dim
	return Math.max(bright, dim)
}

/** A smooth 0..1 wobble over time, per seed (activity, shimmer). */
export function wobble(t: number, seed: number, rate = 1) {
	return noise3(t * rate, seed * 13.37, seed * 0.71)
}

/** The colour of a subagent's dots: its colour, going red as it fails. */
export function lookColor(rgb: RGB, look: KidLook): RGB {
	const f = look.fail
	if (f <= 0) return rgb
	return [rgb[0] + (FAIL_RGB[0] - rgb[0]) * f, rgb[1] + (FAIL_RGB[1] - rgb[1]) * f, rgb[2] + (FAIL_RGB[2] - rgb[2]) * f]
}

/** Blends the four state values by the look's weights, then the resolve flash toward `full`. */
export function blend(look: KidLook, run: number, done: number, fail: number, wait: number, full = 1) {
	const v = look.run * run + look.done * done + look.fail * fail + look.wait * wait
	return v + (full - v) * look.flash
}

/** Integer lattice hash in [0, 1). */
export function hash3(x: number, y: number, z: number) {
	let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 1274126177)
	h = Math.imul(h ^ (h >>> 13), 1274126177)
	return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** 3D value noise in [0, 1]. */
export function noise3(x: number, y: number, z: number) {
	const ix = Math.floor(x)
	const iy = Math.floor(y)
	const iz = Math.floor(z)
	let fx = x - ix
	let fy = y - iy
	let fz = z - iz
	fx = fx * fx * (3 - 2 * fx)
	fy = fy * fy * (3 - 2 * fy)
	fz = fz * fz * (3 - 2 * fz)
	const x00 = mix(hash3(ix, iy, iz), hash3(ix + 1, iy, iz), fx)
	const x10 = mix(hash3(ix, iy + 1, iz), hash3(ix + 1, iy + 1, iz), fx)
	const x01 = mix(hash3(ix, iy, iz + 1), hash3(ix + 1, iy, iz + 1), fx)
	const x11 = mix(hash3(ix, iy + 1, iz + 1), hash3(ix + 1, iy + 1, iz + 1), fx)
	return mix(mix(x00, x10, fy), mix(x01, x11, fy), fz)
}

export function mix(a: number, b: number, t: number) {
	return a + (b - a) * t
}

export function smoothstep(e0: number, e1: number, x: number) {
	const t = clamp01((x - e0) / (e1 - e0))
	return t * t * (3 - 2 * t)
}

export function clamp01(x: number) {
	return x < 0 ? 0 : x > 1 ? 1 : x
}

export function hexToRgb(hex: string): RGB {
	const n = parseInt(hex.replace('#', ''), 16)
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
