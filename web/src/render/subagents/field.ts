import { easeOut } from '../busy/ember'

/**
 * What every subagent indicator shares: its state, and how it looks right now (state weights that
 * crossfade after a change, the resolve flash, hover and open), plus a few small helpers.
 */

export type RGB = readonly [number, number, number]

export type KidState = 'running' | 'done' | 'failed' | 'waiting'

/** Failed: a red that isn't one of the session colours. */
export const FAIL_RGB: RGB = [239, 68, 68]

/**
 * How a subagent looks right now: its state weights (summing to 1, crossfading after a change), the
 * resolve flash after it finishes, and how open (its frame expanded) and hovered it is.
 */
export interface KidLook {
	run: number
	done: number
	fail: number
	wait: number
	/** 0..1: a brief brightening as a run finishes (rises, holds, fades) */
	flash: number
	/** 0..1 */
	open: number
	/** 0..1 */
	hover: number
	/** waiting: 0..1, a slow breath */
	breath: number
}

export function clamp01(x: number) {
	return x < 0 ? 0 : x > 1 ? 1 : x
}

export function smoothstep(e0: number, e1: number, x: number) {
	const t = clamp01((x - e0) / (e1 - e0))
	return t * t * (3 - 2 * t)
}

export function hexToRgb(hex: string): RGB {
	const n = parseInt(hex.replace('#', ''), 16)
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function rgbHex(c: RGB) {
	return `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`
}

/** sRGB 0..255 to linear 0..1. */
export function toLinear(c: RGB): [number, number, number] {
	const f = (v: number) => {
		const s = v / 255
		return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
	}
	return [f(c[0]), f(c[1]), f(c[2])]
}

/** A subagent as the indicators see it. */
export interface KidView {
	id: string
	title: string
	agent: string
	task: string
	/** 1-based, in the order the session started them */
	index: number
	/** its own session colour */
	own: RGB
	seed: number
	state: KidState
	look: KidLook
	/** "1m 04s" (its current or last run), or "" when that isn't known */
	elapsed: string
}

/** A subagent's state over time: what it is, what it was before, and since when (s). */
export interface KidTrack {
	state: KidState
	prev: KidState
	since: number
}

/** a state change crossfades over this long (s) */
const FADE_S = 0.45
/** done after running: a brief brightening rises, holds, then settles (s), like a frame's done band */
const FLASH = { fill: 0.2, hold: 0.15, fade: 0.7 }
const BREATH_S = 2.4

/** How a subagent looks at `now` (s): its state weights crossfading from the one before, the flash, the breath. */
export function trackLook(k: KidTrack, now: number, open: number, hover: number, out: KidLook, reduced: boolean): KidLook {
	const e = easeOut(clamp01((now - k.since) / FADE_S))
	out.run = out.done = out.fail = out.wait = 0
	const add = (s: KidState, w: number) => {
		if (s === 'running') out.run += w
		else if (s === 'done') out.done += w
		else if (s === 'failed') out.fail += w
		else out.wait += w
	}
	add(k.state, e)
	add(k.prev, 1 - e)
	const dt = now - k.since
	out.flash =
		!reduced && k.state === 'done' && k.prev === 'running'
			? dt < FLASH.fill
				? easeOut(dt / FLASH.fill)
				: 1 - easeOut(clamp01((dt - FLASH.fill - FLASH.hold) / FLASH.fade))
			: 0
	out.open = open
	out.hover = hover
	out.breath = reduced ? 0.6 : 0.5 - 0.5 * Math.cos((dt / BREATH_S) * 2 * Math.PI)
	return out
}

/** A run's length: "45s", "1m 04s", "2h 05m". */
export function duration(s: number) {
	const t = Math.max(0, Math.floor(s))
	if (t < 60) return `${t}s`
	const m = Math.floor(t / 60)
	if (m < 60) return `${m}m ${String(t % 60).padStart(2, '0')}s`
	return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}
