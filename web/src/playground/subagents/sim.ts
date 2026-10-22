import { easeOut } from '../../render/busy/ember'
import { clamp01, hexToRgb, type KidLook, type KidState, type RGB } from '../../render/subagents/field'
import { sessionColor } from '../../../../shared/sessionColor'
import { rng, type DemoFamily, type DemoKid } from './data'

/*
 * What every subagent is doing, over time: its state, when that changed and what it was before (so
 * looks crossfade), and its run times. Live, it moves on by itself every few seconds
 * (deterministically: seeded, on performance.now).
 */

/** a state change crossfades over this long (s) */
const FADE_S = 0.45
/** done after running: a brief brightening rises, holds, then settles (s), like a frame's done band */
const FLASH = { fill: 0.2, hold: 0.15, fade: 0.7 }
const BREATH_S = 2.4

export interface Kid {
	demo: DemoKid
	parentId: string
	index: number
	seed: number
	own: RGB
	state: KidState
	prev: KidState
	/** s (performance.now / 1000) */
	since: number
	/** when its current (or last) run started, and when it finished */
	started: number
	finished: number | null
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
	/** "1m 04s" (its current or last run) */
	elapsed: string
}

export class Sim {
	readonly kids = new Map<string, Kid>()
	live = false
	private next = 0
	private r = rng(42)

	constructor(
		readonly families: DemoFamily[],
		now: number,
	) {
		for (const f of families) {
			f.kids.forEach((d, i) => {
				const working = d.state === 'running' || d.state === 'waiting'
				const started = now - d.startedAgo
				const seed = 1 + ((i * 7919 + f.parentId.length * 104729 + d.id.charCodeAt(23) * 31) % 997)
				this.kids.set(d.id, {
					demo: d,
					parentId: f.parentId,
					index: i + 1,
					seed,
					own: hexToRgb(sessionColor(d.id)),
					state: d.state,
					prev: d.state,
					since: now - 60,
					started,
					finished: working ? null : started + d.ran,
				})
			})
		}
		this.next = now + 2.5
	}

	familyKids(f: DemoFamily) {
		return f.kids.slice(0, f.count).map((k) => this.kids.get(k.id)!)
	}

	set(id: string, state: KidState, now: number) {
		const k = this.kids.get(id)
		if (!k || k.state === state) return
		const working = (s: KidState) => s === 'running' || s === 'waiting'
		if (working(state) && !working(k.state)) {
			k.started = now
			k.finished = null
		} else if (!working(state) && working(k.state)) k.finished = now
		k.prev = k.state
		k.state = state
		k.since = now
	}

	/** Live: every few seconds something finishes, fails, asks, gets its answer, or runs again. */
	tick(now: number) {
		if (!this.live || now < this.next) return
		this.next = now + 2.2 + this.r() * 1.6
		const shown = this.families.flatMap((f) => this.familyKids(f))
		const pick = (s: KidState) => {
			const list = shown.filter((k) => k.state === s && now - k.since > 2)
			return list.length ? list[Math.floor(this.r() * list.length)] : undefined
		}
		const roll = this.r()
		const running = pick('running')
		const waiting = pick('waiting')
		if (waiting && roll < 0.2) return this.set(waiting.demo.id, 'running', now)
		if (running && roll < 0.62) return this.set(running.demo.id, this.r() < 0.18 ? 'failed' : this.r() < 0.12 ? 'waiting' : 'done', now)
		const idle = pick('done') ?? pick('failed')
		if (idle) this.set(idle.demo.id, 'running', now)
	}

	look(k: Kid, now: number, open: number, hover: number, out: KidLook, reduced: boolean): KidLook {
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

	view(k: Kid, now: number, look: KidLook): KidView {
		return {
			id: k.demo.id,
			title: k.demo.title,
			agent: k.demo.agent,
			task: k.demo.task,
			index: k.index,
			own: k.own,
			seed: k.seed,
			state: k.state,
			look,
			elapsed: duration((k.finished ?? now) - k.started),
		}
	}
}

export function duration(s: number) {
	const t = Math.max(0, Math.floor(s))
	if (t < 60) return `${t}s`
	const m = Math.floor(t / 60)
	if (m < 60) return `${m}m ${String(t % 60).padStart(2, '0')}s`
	return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}
