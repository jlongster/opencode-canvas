/**
 * How a busy frame's band comes and goes, whatever draws it (see render/busy/brain.ts): it rises as
 * a session starts working and, when it stops, resolves (a bright rim fills in, holds, then fades).
 */

/** How a frame that stops working resolves. */
export interface DoneSettings {
	/** play the resolve (else the band just fades) */
	enabled: boolean
	/** the rim fills in over this long, s */
	fill: number
	/** then holds, s */
	hold: number
	/** then fades out, s */
	fade: number
}

export const DONE: DoneSettings = { enabled: true, fill: 0.2, hold: 0.15, fade: 0.7 }

/** A frame starting to work: its band rises from nothing over this long (s, ease-out). */
export const ENTER_S = 0.3
/** Done without the resolve (or with reduced motion): the band fades over this long (s). */
const QUICK_FADE_S = 0.2
/** The frames' corner radius (page units), as the renderer draws them. */
export const FRAME_RADIUS = 20

/** CSS cubic-bezier(0.23, 1, 0.32, 1): the band's ease-out. */
export const easeOut = bezier(0.23, 1, 0.32, 1)

/** Whether a frame is working, since when (s), and whether it stopped after working (so resolves). */
export interface BusyState {
	working: boolean
	since: number
	finished: boolean
}

/**
 * How present a frame's band is (0..1) and how far its done fill has gone (0..1), `now` (s) on the
 * same clock as `state.since`. Settled (nothing left to animate) once presence is 0 while idle.
 */
export function envelope(state: BusyState, now: number, done: DoneSettings, reduced: boolean): [presence: number, fill: number] {
	const dt = now - state.since
	if (state.working) return [easeOut(Math.min(1, dt / ENTER_S)), 0]
	if (!state.finished) return [0, 0]
	if (reduced || !done.enabled) return [1 - easeOut(Math.min(1, dt / QUICK_FADE_S)), 0]
	return [1 - easeOut(clamp01((dt - done.fill - done.hold) / done.fade)), easeOut(Math.min(1, dt / done.fill))]
}

/** How long after it stops working a frame's band is gone (s). */
export function doneDuration(done: DoneSettings, reduced: boolean) {
	return reduced || !done.enabled ? QUICK_FADE_S : done.fill + done.hold + done.fade
}

function clamp01(x: number) {
	return x < 0 ? 0 : x > 1 ? 1 : x
}

/** CSS cubic-bezier(x1, y1, x2, y2) as a function of progress. */
export function bezier(x1: number, y1: number, x2: number, y2: number) {
	const cx = 3 * x1
	const bx = 3 * (x2 - x1) - cx
	const ax = 1 - cx - bx
	const cy = 3 * y1
	const by = 3 * (y2 - y1) - cy
	const ay = 1 - cy - by
	const sx = (t: number) => ((ax * t + bx) * t + cx) * t
	return (x: number) => {
		if (x <= 0) return 0
		if (x >= 1) return 1
		let lo = 0
		let hi = 1
		let t = x
		for (let i = 0; i < 24; i++) {
			if (sx(t) < x) lo = t
			else hi = t
			t = (lo + hi) / 2
		}
		return ((ay * t + by) * t + cy) * t
	}
}

/** A stable seed and time offset for a frame, from its session id, so frames run out of phase. */
export function frameSeed(id: string): { seed: number; offset: number } {
	let h = 2166136261
	for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619)
	h >>>= 0
	return { seed: 1 + (h % 997), offset: ((h >>> 10) % 10000) / 10 }
}
