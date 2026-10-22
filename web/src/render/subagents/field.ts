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
