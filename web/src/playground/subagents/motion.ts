import { EASES } from './concepts'

/**
 * A staggered 0↔1 transition for a set of cards (a deck dealing out, a peek, a focus). Cards start
 * one after another: going out, the top card first; coming back, the bottom card first, so the top
 * card lands last, on top. The whole stagger is capped so big decks don't crawl. Reversing midway
 * starts from where each card is.
 */
export class Stagger {
	target = 0
	private start = -1e9
	private dur = 0
	private step = 0
	private n = 0
	private from: number[] = []
	private fromAll = 0
	private ease = 'in-out'
	/** reduced motion: values jump at the midpoint (the caller dips opacity around it) */
	private snap = false

	/** total stagger never exceeds this (ms) */
	static CAP = 200

	constructor(initial = 0) {
		this.target = initial
		this.fromAll = initial
	}

	set(target: number, now: number, n: number, dur: number, stagger: number, ease: string, snap = false) {
		if (target === this.target) return
		const from: number[] = []
		for (let i = 0; i < Math.max(n, this.n); i++) from.push(this.value(i, now))
		this.fromAll = this.all(now)
		this.from = from
		this.target = target
		this.start = now
		this.n = n
		this.snap = snap
		this.dur = snap ? 220 : Math.max(1, dur)
		this.step = snap || n < 2 ? 0 : Math.min(stagger, Stagger.CAP / (n - 1))
		this.ease = ease
	}

	/** jumps straight to a value (no transition) */
	jump(v: number) {
		this.target = v
		this.fromAll = v
		this.from = []
		this.start = -1e9
	}

	private delay(i: number) {
		const k = this.target >= (this.from[i] ?? this.fromAll) ? i : this.n - 1 - i
		return Math.max(0, Math.min(k, this.n - 1)) * this.step
	}

	private linear(i: number, now: number) {
		return Math.min(1, Math.max(0, (now - this.start - this.delay(i)) / this.dur))
	}

	value(i: number, now: number) {
		const from = this.from[i] ?? this.fromAll
		const t = this.linear(i, now)
		if (this.snap) return t < 0.5 ? from : this.target
		return from + (this.target - from) * EASES[this.ease](t)
	}

	/** the set as one: spans the whole staggered transition (drives reflow and the camera) */
	all(now: number) {
		const span = this.dur + this.step * Math.max(0, this.n - 1)
		const t = Math.min(1, Math.max(0, (now - this.start) / span))
		if (this.snap) return t < 0.5 ? this.fromAll : this.target
		return this.fromAll + (this.target - this.fromAll) * EASES[this.ease](t)
	}

	/** reduced motion's opacity dip around the jump: 1 → 0 → 1 */
	dip(now: number) {
		if (!this.snap) return 1
		const t = Math.min(1, Math.max(0, (now - this.start) / this.dur))
		return t >= 1 ? 1 : Math.abs(1 - 2 * t)
	}

	busy(now: number) {
		return now - this.start < this.dur + this.step * Math.max(0, this.n - 1) + 20
	}

	/** how long the whole transition takes (ms) */
	span() {
		return this.dur + this.step * Math.max(0, this.n - 1)
	}
}
