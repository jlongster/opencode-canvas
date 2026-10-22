import { clamp, easeInOutCubic } from '../../editor/geometry'
import { columnPoses, deckPoses, tabPoses, tabStep, TITLE_ROW, type ChildPose, type Family, type Size } from '../../editor/subagentLayout'
import type { ParamValues } from '../shared/params'
import type { ConnectorFamily } from '../../render/connectors'
import type { DemoFamily } from './data'
import type { IdeaId } from './ideas'

/**
 * A child's pose plus how stacked it is (k: 0 lying flat in a column … 1 in a stack) and how many
 * tab strips down it sits (t: its strip height depends on the zoom, so it's applied each frame).
 * All of it animates.
 */
interface Pose extends ChildPose {
	k: number
	t: number
}

interface Tween {
	from: Pose
	to: Pose
	start: number
	dur: number
}

/** The whole stagger never takes longer than this (ms), however many children move. */
const STAGGER_CAP = 180

export class FamilyState {
	expanded = false
	/** the stack, front first */
	order: string[]
	/** pulled out of the stack (Pull out) */
	pulled = new Set<string>()
	tweens = new Map<string, Tween>()

	constructor(readonly demo: DemoFamily) {
		this.order = demo.children.map((c) => c.id)
	}

	get ids() {
		return this.demo.children.map((c) => c.id)
	}
}

export interface Frame {
	families: Family[]
	connectors: ConnectorFamily[]
	/** children drawn opaque, back to front, with their shadow */
	raised: { id: string; shadow: number }[]
	/** per child: how visible its title (and busy marker) is, and its scale */
	children: Map<string, { reveal: number; s: number }>
	animating: boolean
}

/**
 * Where every subagent frame should be for the current idea and each family's state, and the
 * staggered, eased motion between them when that changes.
 */
export class Families {
	readonly states: FamilyState[]
	idea: IdeaId = 'column'
	params: ParamValues = {}
	/** the camera's zoom: tab strips stay readable on screen */
	zoom = 1
	sizes: Record<string, Size> = {}

	constructor(demo: DemoFamily[]) {
		this.states = demo.filter((f) => f.children.length).map((f) => new FamilyState(f))
	}

	state(parentId: string) {
		return this.states.find((s) => s.demo.parentId === parentId)
	}

	familyOf(childId: string) {
		return this.states.find((s) => s.demo.children.some((c) => c.id === childId))
	}

	private num(key: string, d: number) {
		const v = this.params[key]
		return typeof v === 'number' ? v : d
	}

	/** Can this idea's families be gathered and spread? */
	get stackable() {
		return this.idea !== 'column'
	}

	isStacked(f: FamilyState) {
		if (this.idea === 'column') return false
		if (this.idea === 'pull') return f.pulled.size < f.ids.length
		return !f.expanded
	}

	private targets(f: FamilyState): Record<string, Pose> {
		const s = this.num('scale', 0.75)
		const gap = this.num('gap', 48)
		const ids = f.ids
		const out: Record<string, Pose> = {}
		const put = (poses: Record<string, ChildPose>, k: number) => {
			for (const [id, p] of Object.entries(poses)) out[id] = { ...p, k, t: 0 }
		}
		// Tabs are laid out one unit apart; frame() turns units into strips for the current zoom.
		const tabs = (order: string[], top: number) => {
			for (const [id, p] of Object.entries(tabPoses(order, s, 1, 0))) out[id] = { x: 0, y: top, s, k: 1, t: p.y }
		}
		const column = () => put(columnPoses(ids, this.sizes, s, gap), 0)
		if (this.idea === 'column') column()
		else if (this.idea === 'deck') {
			const d = this.num('offset', 22)
			if (f.expanded) column()
			else put(deckPoses(f.order, s, d, d), 1)
		} else if (this.idea === 'tabs') {
			if (f.expanded) column()
			else tabs(f.order, 0)
		} else {
			const pulled = ids.filter((id) => f.pulled.has(id))
			const rest = f.order.filter((id) => !f.pulled.has(id))
			put(columnPoses(pulled, this.sizes, s, gap), 0)
			const top = pulled.reduce((y, id) => y + (this.sizes[id]?.h ?? 0) * s + gap, 0)
			tabs(rest, top)
		}
		return out
	}

	/**
	 * Sends children to their targets. `order` is the order they set off in (those that don't move
	 * don't count); each starts `stagger` ms after the one before, the whole stagger capped.
	 */
	retarget(now: number, opts: { order?: string[]; animate?: boolean; families?: FamilyState[] } = {}) {
		const dur = opts.animate === false ? 0 : this.num('dur', 380)
		for (const f of opts.families ?? this.states) {
			const targets = this.targets(f)
			const order = opts.order?.filter((id) => id in targets) ?? f.ids
			const moving = order.filter((id) => {
				const t = f.tweens.get(id)
				const to = targets[id]
				return !t || !same(t.to, to)
			})
			const step = moving.length > 1 ? Math.min(this.num('stagger', 30), STAGGER_CAP / (moving.length - 1)) : 0
			moving.forEach((id, i) => {
				const to = targets[id]
				const t = f.tweens.get(id)
				const from = t ? value(t, now) : to
				f.tweens.set(id, { from, to, start: now + i * step, dur })
			})
		}
	}

	/** Spread or gather one family; the top child sets off first going out, the bottom one first coming back. */
	setExpanded(f: FamilyState, on: boolean, now: number, animate = true) {
		if (this.idea === 'pull') {
			if (on) for (const id of f.ids) f.pulled.add(id)
			else f.pulled.clear()
		} else f.expanded = on
		const ids = f.ids
		this.retarget(now, { families: [f], order: on ? ids : [...ids].reverse(), animate })
	}

	/** Peeking titles: a card to the front of its stack; it moves first. */
	bringToFront(f: FamilyState, id: string, now: number) {
		if (f.order[0] === id) return
		f.order = [id, ...f.order.filter((x) => x !== id)]
		this.retarget(now, { families: [f], order: [id, ...f.ids.filter((x) => x !== id)] })
	}

	/** Pull out: one frame out of the stack into the column above it, or back. */
	togglePulled(f: FamilyState, id: string, now: number) {
		if (f.pulled.has(id)) f.pulled.delete(id)
		else f.pulled.add(id)
		// The one clicked moves first; the stack below shifts after it.
		this.retarget(now, { families: [f], order: [id, ...f.ids.filter((x) => x !== id)] })
	}

	/** New idea: every family back to its starting state, gliding there. */
	reset(now: number, animate: boolean) {
		for (const f of this.states) {
			f.expanded = false
			f.pulled.clear()
			f.order = f.ids
		}
		this.retarget(now, { animate })
	}

	frame(now: number): Frame {
		const out: Frame = { families: [], connectors: [], raised: [], children: new Map(), animating: false }
		const shadow = this.num('shadow', 0.6)
		const raised: { id: string; shadow: number; depth: number }[] = []
		for (const f of this.states) {
			const poses: Record<string, Pose> = {}
			for (const id of f.ids) {
				const t = f.tweens.get(id)
				if (!t) continue
				const p = value(t, now)
				poses[id] = { ...p, y: p.y + p.t * tabStep(p.s, this.zoom) }
				if (now < t.start + t.dur) out.animating = true
			}
			// Depth: 0 is the front of the stack; children lying in a column count as in front of it.
			const depth = (id: string) => {
				if (this.idea === 'pull' && f.pulled.has(id)) return -1
				const i = f.order.indexOf(id)
				return this.idea === 'column' || (this.idea !== 'pull' && f.expanded) ? f.ids.indexOf(id) : i
			}
			const childIds = [...f.ids].sort((a, b) => depth(a) - depth(b))
			out.families.push({ parentId: f.demo.parentId, childIds, poses })
			const frontId = childIds.find((id) => (poses[id]?.k ?? 0) > 0.5) ?? childIds[0]
			for (const c of f.demo.children) {
				const p = poses[c.id]
				if (!p) continue
				const moving = (() => {
					const t = f.tweens.get(c.id)!
					return now < t.start + t.dur
				})()
				if (p.k > 0.001 || moving) raised.push({ id: c.id, shadow: p.k * shadow, depth: depth(c.id) })
				// In the deck a child behind the front card is hidden: its title (drawn over every frame) shows only
				// once the card is nearly clear of the stack, and goes as soon as it heads back in.
				const reveal = this.idea === 'deck' && c.id !== frontId ? clamp((0.4 - p.k) / 0.4, 0, 1) : 1
				out.children.set(c.id, { reveal, s: p.s })
			}
			out.connectors.push({
				parentId: f.demo.parentId,
				color: f.demo.color,
				titleY: TITLE_ROW,
				links: f.demo.children.map((c) => ({
					childId: c.id,
					color: c.color,
					titleY: TITLE_ROW * (poses[c.id]?.s ?? 1),
					reveal: out.children.get(c.id)?.reveal ?? 1,
					frontId: this.idea === 'deck' ? frontId : c.id,
				})),
			})
		}
		out.raised = raised.sort((a, b) => b.depth - a.depth).map(({ id, shadow }) => ({ id, shadow }))
		return out
	}
}

function value(t: Tween, now: number): Pose {
	if (t.dur <= 0) return now >= t.start ? t.to : t.from
	const e = easeInOutCubic(clamp((now - t.start) / t.dur, 0, 1))
	return {
		x: t.from.x + (t.to.x - t.from.x) * e,
		y: t.from.y + (t.to.y - t.from.y) * e,
		s: t.from.s + (t.to.s - t.from.s) * e,
		k: t.from.k + (t.to.k - t.from.k) * e,
		t: t.from.t + (t.to.t - t.from.t) * e,
	}
}

const same = (a: Pose, b: Pose) =>
	Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01 && Math.abs(a.s - b.s) < 1e-4 && Math.abs(a.k - b.k) < 1e-4 && Math.abs(a.t - b.t) < 1e-4
