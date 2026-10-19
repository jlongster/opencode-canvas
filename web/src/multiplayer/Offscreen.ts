import type { Editor } from '../editor/Editor'
import type { Box, Vec } from '../editor/geometry'
import type { Worm } from './AgentWorms'
import type { Conjure } from './Conjure'
import { LIFT, NATIVE, POINTER_EYE, pointerD } from './Pointer'
import './offscreen.css'

/** the arrow's half size, screen px: its centre sits this far inside the edge */
const ARROW = 13
/** between the arrow and its pill, and between neighbours along an edge */
const PILL_GAP = 4
const GAP = 6
const PILL_H = 24
/** the widest a pill gets (see offscreen.css), unless it's hovered open */
const PILL_MAX = 220
/**
 * The room each marker keeps along its edge, whatever its pill says: an arrow's (turned
 * diagonally it takes a little more), or on the top and bottom, a busy one's whole pill. Hovering
 * and changing text never change it; only going busy or quiet does.
 */
const SLOT = ARROW * 2 + 4 + GAP
const BUSY_SLOT = PILL_MAX + GAP
/** gone quiet, a marker keeps a busy one's room this long, so a status flickering off doesn't move its neighbours */
const BUSY_HOLD_MS = 2500
/** quiet markers sharing one stay together until they're this much further apart than MERGE_PX */
const MERGE_SLACK = 10
/** markers moved along the edge by their neighbours (or bars appearing at the edges) get there this smoothly, ms */
const SETTLE_MS = 140
/** how far in from the viewport's sides (and the bars) the markers keep */
const EDGE = 8
/** a creature counts as out of view once none of its body is this far inside, and back in view once some is this far in */
const OUT_PX = 2
const IN_PX = 14
/** quiet markers (pointer only) closer than this along an edge share one, with a count */
const MERGE_PX = 14
/** the marker's pointer: its height, px */
const GLYPH = 21
/** a creature moving less than this (screen px) where it sits, bobbing or trembling, doesn't move its marker */
const STAND_PX = 3
/** how often the bars around the edges are measured again, ms */
const MEASURE_MS = 300
const FADE_MS = 180
/** "interrupted" shows this long after an interrupted session stops */
const INTERRUPTED_MS = 12_000
/** clicked from far out, the camera zooms in to at least this */
const FLY_MIN_ZOOM = 0.35
/** about how long the camera's flight takes (the editor's camera animation) */
const FLY_MS = 320

type Edge = 'left' | 'right' | 'top' | 'bottom'

/** The marker: the eye pointer itself, turned to point at its creature, its pupil looking where it points. */
const GLYPH_SVG = (() => {
	const e = { x: POINTER_EYE.x * GLYPH, y: POINTER_EYE.y * GLYPH, r: POINTER_EYE.r * GLYPH * 1.15 }
	const look = { x: Math.cos(NATIVE) * e.r * 0.35, y: Math.sin(NATIVE) * e.r * 0.35 }
	return (
		`<path d="${pointerD(GLYPH)}"/>` +
		`<circle class="offscreen-eye" cx="${e.x.toFixed(2)}" cy="${e.y.toFixed(2)}" r="${e.r.toFixed(2)}"/>` +
		`<circle class="offscreen-pupil" cx="${(e.x + look.x).toFixed(2)}" cy="${(e.y + look.y).toFixed(2)}" r="${(e.r * 0.58).toFixed(2)}"/>`
	)
})()

/** One creature out of view this frame. */
interface Target {
	worm: Worm
	key: string
	/** its body's middle, on screen */
	at: Vec
	/** where the ray from the middle of the view toward it meets the markers' edge */
	edge: Edge
	s: number
	status: string | null
	/** whether it keeps a busy marker's room (see BUSY_HOLD_MS) */
	busy: boolean
}

/** What's drawn at one spot on an edge: one creature, or several close together. */
interface Group {
	members: Target[]
	edge: Edge
	/** ideal and spread position along the edge (x on top/bottom, y on the sides) */
	s: number
	p: number
	/** its extent along the edge, and how far inward it reaches from the edge */
	ext: number
	depth: number
	min: number
	max: number
	marker: Marker
	busy: boolean
}

interface Marker {
	key: string
	el: HTMLButtonElement
	arrow: HTMLSpanElement
	count: HTMLSpanElement
	pill: HTMLSpanElement
	status: HTMLSpanElement
	title: HTMLSpanElement
	/** what the pill says, and its measured width */
	text: string
	pillW: number
	shown: boolean
	removeAt: number
	/** what a click flies to */
	worms: Worm[]
	color: string
	/** how far it's shown from where its creature's ray meets the edge, eased toward where it's spread to */
	off: Vec | null
}

/**
 * Markers at the edges of the view for creatures out of it, like a game's for teammates off
 * screen: an arrow in the session's colour pointing toward each one, from where the line from the
 * middle of the view to it crosses the edge, and, when there's something to tell (thinking,
 * replying, calling for attention, subagents), a pill saying so. Asleep ones get a dim arrow.
 * Clicking one flies the camera to it. Laid out every frame from the camera, after the creatures
 * are drawn (see AgentWorms).
 */
export class Offscreen {
	private layer: HTMLDivElement
	private markers = new Map<string, Marker>()
	private out = new Set<string>()
	private hovered: string | null = null
	/** the bars along the edges as measured, and as used (eased toward them) */
	private insets: Insets = { top: EDGE, bottom: EDGE, left: EDGE, right: EDGE }
	private shownInsets: Insets | null = null
	/** the attention tray's extent, under the top bar */
	private stack: Span | null = null
	/** where each creature stands (page), held still through fidgets smaller than STAND_PX */
	private stands = new Map<string, Vec>()
	private measuredAt = -Infinity
	private measuredFor = ''
	/** per session: since when it has been thinking, whether it's being stopped, when it was interrupted */
	private since = new Map<string, number>()
	private stopping = new Set<string>()
	private interruptedAt = new Map<string, number>()
	/** per creature: when it last had something to report, and which marker it shared last frame */
	private busyAt = new Map<string, number>()
	private sharedWith = new Map<string, string>()

	constructor(
		parent: HTMLElement,
		private editor: Editor,
		private conjure: Conjure | null,
		private reducedMotion: MediaQueryList,
		private startle: (worm: Worm) => void,
	) {
		this.layer = document.createElement('div')
		this.layer.className = 'offscreen-markers'
		parent.appendChild(this.layer)
	}

	destroy() {
		this.layer.remove()
		this.markers.clear()
	}

	/** Places the markers for this frame. */
	frame(now: number, elapsed: number, worms: Iterable<Worm>) {
		const { w, h } = this.editor.viewport.peek()
		this.measure(now, w, h)
		const ins = this.easeInsets(elapsed)
		// where the markers go (and what counts as in view): the viewport less the bars along its edges
		const R = { l: ins.left, t: ins.top, r: w - ins.right, b: h - ins.bottom }
		if (R.r - R.l < 120 || R.b - R.t < 80) return this.hideAll(now)
		const c = { x: (R.l + R.r) / 2, y: (R.t + R.b) / 2 }
		const inner = { l: R.l + ARROW, t: R.t + ARROW, r: R.r - ARROW, b: R.b - ARROW }

		const targets: Target[] = []
		const seen = new Set<string>()
		for (const worm of worms) {
			if (worm.leaving || worm.gone) continue
			const key = worm.sessionId ?? `w${worm.id}`
			if (seen.has(key)) continue
			seen.add(key)
			const status = this.status(worm, key, now)
			const box = bodyBox(worm, this.editor)
			const was = this.out.has(key)
			const inset = was ? IN_PX : OUT_PX
			const visible = box.x + box.w > R.l + inset && box.x < R.r - inset && box.y + box.h > R.t + inset && box.y < R.b - inset
			if (visible) {
				this.out.delete(key)
				this.stands.delete(key)
				continue
			}
			this.out.add(key)
			// (from where it stands rather than its body, so a creature fidgeting on the spot doesn't nudge its marker)
			const z = this.editor.camera.peek().z
			// (sitting, where it was put; it drifts a little as it's knocked about)
			const at0 = worm.mode === 'here' && !worm.trip && worm.goal ? worm.goal : worm.root
			let stand = this.stands.get(key)
			if (!stand || Math.hypot(at0.x - stand.x, at0.y - stand.y) * z > STAND_PX) this.stands.set(key, (stand = { ...at0 }))
			const ground = this.editor.pageToScreen(stand)
			const at = { x: ground.x, y: ground.y - LIFT }
			const d = { x: at.x - c.x, y: at.y - c.y }
			const kx = d.x ? (inner.r - c.x) / Math.abs(d.x) : Infinity
			const ky = d.y ? (inner.b - c.y) / Math.abs(d.y) : Infinity
			const side = kx < ky
			const k = Math.min(kx, ky)
			const edge: Edge = side ? (d.x < 0 ? 'left' : 'right') : d.y < 0 ? 'top' : 'bottom'
			const s = side ? c.y + d.y * k : c.x + d.x * k
			if (status !== null) this.busyAt.set(key, now)
			const busy = now - (this.busyAt.get(key) ?? -Infinity) < BUSY_HOLD_MS
			targets.push({ worm, key, at, edge, s, status, busy })
		}
		for (const key of [...this.out]) if (!seen.has(key)) this.out.delete(key)
		for (const key of new Set([...this.since.keys(), ...this.busyAt.keys(), ...this.stands.keys()])) if (!seen.has(key)) this.forget(key)

		const groups: Group[] = []
		const ends: Group[] = []
		for (const edge of ['top', 'bottom', 'left', 'right'] as const) {
			const list = targets.filter((t) => t.edge === edge).sort((a, b) => a.s - b.s)
			if (!list.length) continue
			const placed = this.place(edge, list, R, inner, ends)
			groups.push(...placed)
			if (edge === 'top' || edge === 'bottom') ends.push(...placed)
		}

		const used = new Set<string>()
		this.sharedWith.clear()
		for (const g of groups) {
			used.add(g.marker.key)
			for (const t of g.members) this.sharedWith.set(t.key, g.marker.key)
			this.draw(g, R, inner, elapsed)
		}
		// (ones folded into another's marker keep theirs, hidden, for when they're apart again)
		const out = new Set(targets.map((t) => t.key))
		for (const m of this.markers.values()) if (!used.has(m.key)) this.hide(m, now, out.has(m.key))
	}

	// ---------- what each one is doing ----------

	/** What its pill says, or null for nothing to report (just the arrow). */
	private status(worm: Worm, key: string, now: number): string | null {
		const stopping = !!worm.sessionId && !!this.conjure?.stopping.peek()[worm.sessionId]
		if (worm.thinking) {
			if (!this.since.has(key)) this.since.set(key, now)
			if (stopping) this.stopping.add(key)
		} else {
			this.since.delete(key)
			if (this.stopping.delete(key)) this.interruptedAt.set(key, now)
		}
		const subagents = [...worm.dots.values()].filter((t) => !t.leaving).length
		const subs = subagents ? `${subagents} subagent${subagents === 1 ? '' : 's'}` : ''
		const busy = (s: string) => (subs ? `${s} · ${subs}` : s)
		if (worm.calls) return `needs you · ${worm.calls > 99 ? '99+' : worm.calls}`
		if (worm.asleep) return null
		if (worm.thinking && stopping) return busy('stopping')
		if (worm.talk > 0.05) return busy('replying')
		if (worm.thinking) return busy(`thinking · ${clock(now - this.since.get(key)!)}`)
		const interrupted = this.interruptedAt.get(key)
		if (interrupted !== undefined && now - interrupted < INTERRUPTED_MS) return 'interrupted'
		return subs || null
	}

	private forget(key: string) {
		this.since.delete(key)
		this.stopping.delete(key)
		this.interruptedAt.delete(key)
		this.busyAt.delete(key)
		this.stands.delete(key)
	}

	// ---------- layout ----------

	/**
	 * One edge's markers: close quiet ones share a marker, then they're spread along the edge so
	 * none overlap (in order), merging neighbours while they don't fit. The sides keep clear of
	 * what's already on the top and bottom edges (`ends`). Only where the creatures are and each
	 * marker's fixed room (see SLOT) count: never what the pills say or which one is hovered.
	 */
	private place(edge: Edge, list: Target[], R: Rect, inner: Rect, ends: Group[]): Group[] {
		const side = edge === 'left' || edge === 'right'
		let groups: Group[] = []
		for (const t of list) {
			const last = groups[groups.length - 1]
			const prev = last?.members[last.members.length - 1]
			const together = !!prev && this.sharedWith.has(t.key) && this.sharedWith.get(t.key) === this.sharedWith.get(prev.key)
			if (last && !t.busy && !last.busy && t.s - prev!.s < MERGE_PX + (together ? MERGE_SLACK : 0)) {
				last.members.push(t)
			} else groups.push(this.group(edge, [t]))
		}
		for (let tries = 0; tries <= list.length; tries++) {
			groups = groups.map((g) => this.group(edge, g.members))
			for (const g of groups) {
				if (!side) {
					const half = (g.ext - GAP) / 2
					g.min = Math.max(inner.l, R.l + half)
					g.max = Math.min(inner.r, R.r - half)
					continue
				}
				// clear of the top and bottom markers it would run into
				const x0 = edge === 'left' ? R.l : R.r - g.depth
				const x1 = edge === 'left' ? R.l + g.depth : R.r
				let min = inner.t
				let max = inner.b
				for (const e of ends) {
					const half = e.ext / 2
					if (e.p + half < x0 || e.p - half > x1) continue
					if (e.edge === 'top') min = Math.max(min, R.t + e.depth + GAP + g.ext / 2)
					else max = Math.min(max, R.b - e.depth - GAP - g.ext / 2)
				}
				g.min = min
				g.max = Math.max(min, max)
			}
			if (spread(groups)) break
			// Too many to fit: the two nearest neighbours share one.
			let best = -1
			let gap = Infinity
			for (let i = 0; i + 1 < groups.length; i++) {
				const d = groups[i + 1].s - groups[i].s
				if (d < gap) {
					gap = d
					best = i
				}
			}
			if (best < 0) break
			groups.splice(best, 2, this.group(edge, [...groups[best].members, ...groups[best + 1].members]))
		}
		return groups
	}

	private group(edge: Edge, members: Target[]): Group {
		const marker = this.marker(members[0].key)
		const s = members.reduce((a, m) => a + m.s, 0) / members.length
		const busy = members.some((m) => m.busy)
		const side = edge === 'left' || edge === 'right'
		const reach = busy ? ARROW * 2 + PILL_GAP + (side ? PILL_MAX : PILL_H) : ARROW * 2
		const ext = busy && !side ? BUSY_SLOT : SLOT
		return { members, edge, s, p: s, ext, depth: reach, min: -Infinity, max: Infinity, marker, busy }
	}

	/** The pill's line for these creatures (null: no pill, just the arrow). */
	private pillText(members: Target[]): { status: string; title: string } | null {
		const hovered = members.some((m) => m.key === this.hovered)
		if (members.length === 1) {
			const m = members[0]
			const title = m.worm.nameText || 'Untitled session'
			if (m.status) return { status: m.status, title }
			return hovered ? { status: m.worm.asleep ? 'asleep' : 'idle', title } : null
		}
		const calls = members.reduce((a, m) => a + m.worm.calls, 0)
		const busy = members.filter((m) => m.status).length
		if (calls) return { status: `needs you · ${calls}`, title: `${members.length} agents` }
		if (busy) return { status: `${busy} busy`, title: `${members.length} agents` }
		return hovered ? { status: `${members.length} agents`, title: members.map((m) => m.worm.nameText).join(', ') } : null
	}

	// ---------- markers ----------

	private marker(key: string): Marker {
		const m = this.markers.get(key)
		if (m) return m
		const el = document.createElement('button')
		el.type = 'button'
		el.className = 'offscreen-marker'
		el.innerHTML =
			'<span class="offscreen-body">' +
			`<span class="offscreen-arrow"><svg viewBox="-13 -13 26 26" width="26" height="26" aria-hidden="true">${GLYPH_SVG}</svg></span>` +
			'<span class="offscreen-count" hidden></span>' +
			'<span class="offscreen-pill" hidden><span class="offscreen-status"></span><span class="offscreen-title"></span></span>' +
			'</span>'
		const made: Marker = {
			key,
			el,
			arrow: el.querySelector<HTMLSpanElement>('.offscreen-arrow')!,
			count: el.querySelector<HTMLSpanElement>('.offscreen-count')!,
			pill: el.querySelector<HTMLSpanElement>('.offscreen-pill')!,
			status: el.querySelector<HTMLSpanElement>('.offscreen-status')!,
			title: el.querySelector<HTMLSpanElement>('.offscreen-title')!,
			text: '',
			pillW: 0,
			shown: false,
			removeAt: 0,
			worms: [],
			color: '',
			off: null,
		}
		// It's for clicking, not for starting a selection or a pan on the canvas underneath.
		el.addEventListener('pointerdown', (e) => {
			e.stopPropagation()
			e.preventDefault()
		})
		el.addEventListener('click', (e) => {
			e.stopPropagation()
			this.fly(made.worms)
		})
		// (nor for hovering what's under it)
		el.addEventListener('pointermove', (e) => e.stopPropagation())
		el.addEventListener('pointerenter', () => {
			this.hovered = key
			this.editor.setHovered(null)
		})
		el.addEventListener('pointerleave', () => this.hovered === key && (this.hovered = null))
		this.layer.appendChild(el)
		this.markers.set(key, made)
		return made
	}

	/** Fills in the pill (when its text changed) and returns its width, 0 without one. Drawing only: layout never reads it. */
	private setPill(m: Marker, members: Target[], pill: { status: string; title: string } | null): number {
		const open = members.some((t) => t.key === this.hovered)
		const text = pill ? `${pill.status}\n${pill.title}\n${open}` : ''
		if (text !== m.text) {
			m.text = text
			m.pill.hidden = !pill
			m.el.classList.toggle('open', open)
			if (pill) {
				m.status.textContent = pill.status
				m.title.textContent = pill.title
				m.pillW = m.pill.offsetWidth
			} else m.pillW = 0
		}
		return m.pillW
	}

	private draw(g: Group, R: Rect, inner: Rect, elapsed: number) {
		const m = g.marker
		const lead = g.members[0]
		m.worms = g.members.map((t) => t.worm)
		const side = g.edge === 'left' || g.edge === 'right'
		const onEdge = (s: number) => (side ? { x: g.edge === 'left' ? inner.l : inner.r, y: s } : { x: s, y: g.edge === 'top' ? inner.t : inner.b })
		// Where its creature's ray meets the edge, exactly (so it's locked to the camera), plus how far
		// its neighbours moved it along, which eases.
		const anchor = onEdge(lead.s)
		const spot = onEdge(g.p)
		const stack = this.stack
		if (g.edge === 'top' && stack) {
			const half = g.busy ? PILL_MAX / 2 : ARROW + 2
			if (spot.x + half > stack.l - GAP && spot.x - half < stack.r + GAP) spot.y = Math.max(spot.y, stack.b + EDGE + ARROW)
		}
		const want = { x: spot.x - anchor.x, y: spot.y - anchor.y }
		const k = !m.off || !m.shown || this.reducedMotion.matches ? 1 : 1 - Math.exp(-elapsed / SETTLE_MS)
		const off = m.off ?? want
		m.off = { x: off.x + (want.x - off.x) * k, y: off.y + (want.y - off.y) * k }
		const x = anchor.x + m.off.x
		const y = anchor.y + m.off.y
		// pointing at the one it's for, or the middle of a group
		const aim = g.members.reduce((a, t) => ({ x: a.x + t.at.x / g.members.length, y: a.y + t.at.y / g.members.length }), { x: 0, y: 0 })
		const angle = Math.atan2(aim.y - y, aim.x - x)
		m.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`
		m.arrow.style.transform = `rotate(${(angle - NATIVE).toFixed(3)}rad)`
		if (m.color !== lead.worm.color) {
			m.color = lead.worm.color
			m.el.style.setProperty('--marker-color', m.color)
		}
		m.el.classList.toggle('asleep', g.members.every((t) => t.worm.asleep))
		m.el.classList.toggle('calling', g.members.some((t) => t.worm.calls > 0))
		const n = g.members.length
		m.count.hidden = n < 2
		if (n > 1) m.count.textContent = String(n)
		const pillW = this.setPill(m, g.members, this.pillText(g.members))
		if (pillW) {
			// inward from the arrow; on the top and bottom, kept inside the edges
			let px: number
			let py: number
			if (side) {
				px = g.edge === 'left' ? ARROW + PILL_GAP : -ARROW - PILL_GAP - pillW
				py = -PILL_H / 2
			} else {
				const left = Math.min(Math.max(x - pillW / 2, R.l), R.r - pillW)
				px = left - x
				py = g.edge === 'top' ? ARROW + PILL_GAP : -ARROW - PILL_GAP - PILL_H
			}
			m.pill.style.transform = `translate(${px.toFixed(1)}px, ${py.toFixed(1)}px)`
		}
		const titles = g.members.map((t) => `${t.worm.nameText || 'Untitled session'}${t.status ? ` (${t.status})` : t.worm.asleep ? ' (asleep)' : ''}`)
		const label = n > 1 ? `${n} agents off screen: ${titles.join('; ')}` : `${titles[0]}: click to go there`
		if (m.el.title !== label) {
			m.el.title = label
			m.el.setAttribute('aria-label', label)
		}
		this.show(m)
	}

	private show(m: Marker) {
		m.removeAt = 0
		if (m.shown) return
		m.shown = true
		if (this.reducedMotion.matches) m.el.classList.add('in')
		// (a frame at its start state first, so it fades and grows in)
		else requestAnimationFrame(() => m.shown && m.el.classList.add('in'))
	}

	private hide(m: Marker, now: number, keep = false) {
		if (m.shown) {
			m.shown = false
			m.el.classList.remove('in')
			m.off = null
			m.removeAt = now + (this.reducedMotion.matches ? 0 : FADE_MS)
			if (this.hovered === m.key) this.hovered = null
		}
		if (!keep && now >= m.removeAt) {
			m.el.remove()
			this.markers.delete(m.key)
		}
	}

	private hideAll(now: number) {
		this.out.clear()
		for (const m of this.markers.values()) this.hide(m, now)
	}

	/** Flies the camera over to them (all of a group), zooming in a little if it's right out. */
	private fly(worms: Worm[]) {
		const live = worms.filter((w) => !w.leaving && !w.gone)
		if (!live.length) return
		const editor = this.editor
		const { w, h } = editor.viewport.peek()
		const z = Math.max(editor.camera.peek().z, FLY_MIN_ZOOM)
		const animate = !this.reducedMotion.matches
		// its body's middle, page space (the body stands up from its root)
		const pts = live.map((worm) => editor.screenToPage(centre(bodyBox(worm, editor))))
		let lo = { x: Infinity, y: Infinity }
		let hi = { x: -Infinity, y: -Infinity }
		for (const p of pts) {
			lo = { x: Math.min(lo.x, p.x), y: Math.min(lo.y, p.y) }
			hi = { x: Math.max(hi.x, p.x), y: Math.max(hi.y, p.y) }
		}
		const ins = this.insets
		const cx = (ins.left + w - ins.right) / 2
		const cy = (ins.top + h - ins.bottom) / 2
		const room = { w: w - ins.left - ins.right - 160, h: h - ins.top - ins.bottom - 160 }
		const fit = Math.min(z, room.w / Math.max(1, hi.x - lo.x), room.h / Math.max(1, hi.y - lo.y))
		const zz = Math.max(0.02, fit)
		const mid = { x: (lo.x + hi.x) / 2, y: (lo.y + hi.y) / 2 }
		editor.setCamera({ x: cx / zz - mid.x, y: cy / zz - mid.y, z: zz }, { animate })
		// (a jolt as it comes into view, like being focused)
		if (live.length === 1) window.setTimeout(() => this.startle(live[0]), animate ? FLY_MS : 0)
	}

	/** The insets to lay out with this frame: the measured ones, eased (a tray appearing slides the markers down). */
	private easeInsets(elapsed: number): Insets {
		const to = this.insets
		const from = this.shownInsets
		if (!from || this.reducedMotion.matches) return (this.shownInsets = { ...to })
		const k = 1 - Math.exp(-elapsed / SETTLE_MS)
		const ease = (a: number, b: number) => (Math.abs(b - a) < 0.1 ? b : a + (b - a) * k)
		return (this.shownInsets = { top: ease(from.top, to.top), bottom: ease(from.bottom, to.bottom), left: ease(from.left, to.left), right: ease(from.right, to.right) })
	}

	/** The bars along the viewport's edges (title, toolbar, tray; frames status), measured now and then. */
	private measure(now: number, w: number, h: number) {
		const size = `${w}x${h}`
		if (now - this.measuredAt < MEASURE_MS && size === this.measuredFor) return
		this.measuredAt = now
		this.measuredFor = size
		const host = this.layer.getBoundingClientRect()
		let top = 0
		let bottom = 0
		for (const el of document.querySelectorAll<HTMLElement>('.top-bar > *, .toolbar.tools, .frames-status, .follow-tag')) {
			const r = el.getBoundingClientRect()
			if (!r.width || !r.height) continue
			const t = r.top - host.top
			const b = r.bottom - host.top
			if (b < 0 || t > h) continue
			if (t + b < h) top = Math.max(top, b)
			else bottom = Math.max(bottom, h - t)
		}
		this.insets = { top: top + EDGE, bottom: bottom + EDGE, left: EDGE, right: EDGE }
		// The attention tray comes and goes under the middle of the top bar: only the markers under it
		// make way (see draw), so it doesn't move the rest.
		let stack: Span | null = null
		for (const el of document.querySelectorAll<HTMLElement>('.top-stack > *')) {
			const r = el.getBoundingClientRect()
			if (!r.width || !r.height) continue
			const span = { l: r.left - host.left, r: r.right - host.left, b: r.bottom - host.top }
			stack = stack ? { l: Math.min(stack.l, span.l), r: Math.max(stack.r, span.r), b: Math.max(stack.b, span.b) } : span
		}
		this.stack = stack
	}
}

interface Span {
	l: number
	r: number
	b: number
}

interface Insets {
	top: number
	bottom: number
	left: number
	right: number
}

interface Rect {
	l: number
	t: number
	r: number
	b: number
}

/**
 * Spreads groups along their edge so neighbours don't overlap, each within its min..max, keeping
 * their order. False when they don't all fit.
 */
function spread(groups: Group[]): boolean {
	const n = groups.length
	const need = (i: number) => (groups[i - 1].ext + groups[i].ext) / 2
	for (let i = 0; i < n; i++) {
		const g = groups[i]
		g.p = Math.min(Math.max(g.s, g.min), g.max)
		if (i) g.p = Math.max(g.p, groups[i - 1].p + need(i))
	}
	for (let i = n - 1; i >= 0; i--) {
		const g = groups[i]
		g.p = Math.min(g.p, g.max)
		if (i < n - 1) g.p = Math.min(g.p, groups[i + 1].p - need(i + 1))
	}
	for (let i = 0; i < n; i++) {
		if (groups[i].p < groups[i].min - 0.5) return false
		if (i && groups[i].p - groups[i - 1].p < need(i) - 0.5) return false
	}
	return true
}

/** Its shape on screen as last drawn (or about where it sits, before it's drawn). */
function bodyBox(worm: Worm, editor: Editor): Box {
	const pts = worm.shape?.poly
	if (!pts) {
		const at = editor.pageToScreen(worm.root)
		return { x: at.x - 18, y: at.y - LIFT - 18, w: 36, h: 36 }
	}
	let x0 = Infinity
	let y0 = Infinity
	let x1 = -Infinity
	let y1 = -Infinity
	for (const p of pts) {
		x0 = Math.min(x0, p.x)
		y0 = Math.min(y0, p.y)
		x1 = Math.max(x1, p.x)
		y1 = Math.max(y1, p.y)
	}
	return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

function centre(b: Box): Vec {
	return { x: b.x + b.w / 2, y: b.y + b.h / 2 }
}

function clock(ms: number) {
	const s = Math.max(0, Math.floor(ms / 1000))
	const m = Math.floor(s / 60)
	return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}:${String(s % 60).padStart(2, '0')}`
}
