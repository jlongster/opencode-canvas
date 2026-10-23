import './orbs.css'
import { bezier } from '../busy/ember'
import { pack, type ParamValues } from '../params'
import { clamp01, toLinear, type KidLook, type KidView, type RGB } from './field'
import type { OrbLayer } from './orbs'
import { shaderOf, type Technique } from './technique'

/*
 * A session's subagents as a row of orbs after its title, drawn on the shader layer (orbs.ts) with
 * DOM hit targets over them, in screen space (a constant size at any zoom). Shared by the app's frame
 * titles (render/subagents/titleOrbs.ts) and the playground's detached titles.
 *
 * The row sits on the title's centre line (or baseline). Past the max, the rest fold into "+N". When
 * there's too little room for two orbs past the title, they flow together into one aggregate orb with
 * a count; with less still, they hide. Orbs glide between these (positions in slot units, so the row
 * never lags its title) and fade; nothing jumps. Hovering one (or focusing it from the keyboard)
 * shows its label after a moment: its title and state.
 */

export interface RowKid {
	view: KidView
	/** the colour its orb is drawn in (its own or its parent's, sRGB 0..255) */
	rgb: RGB
	/** its orb's clock, s */
	time: number
	/** items it posted since it was last expanded (the badge) */
	unread: number
	/** its latest output (the hover preview) */
	thumb: string | null
}

export interface RowInfo {
	parentId: string
	kids: RowKid[]
	/** the parent's colour */
	rgb: RGB
	/** the aggregate orb: its look and clock */
	agg: KidLook
	aggTime: number
	aggPhase: number
}

export interface RowSettings {
	tech: Technique
	p: ParamValues
	/** orbs before +N */
	max: number
	reduced: boolean
	/** the hover label shows the subagent's latest output */
	preview: boolean
	/** between the title and the first orb (default TITLE_GAP) */
	gap?: number
}

export interface RowActions {
	/** a click on its orb (shift: alongside the ones open) */
	toggleKid(id: string, additive: boolean): void
	showAll(parentId: string): void
	/** a click on the aggregate orb */
	zoomTo(parentId: string): void
}

/** Where a row is drawn this frame (CSS px of the layer's container). */
export interface RowPlace {
	/** the title's left edge */
	px: number
	/** the orbs' centre line */
	y: number
	/** how far right the row may reach, from px */
	w: number
	opacity: number
	/** the orbs' centre line from the top of the row's element (its hit targets are ROW_PX tall, from its top) */
	anchorY: number
	dpr: number
	/** the viewport's width (the label stays on screen) */
	vw: number
}

/** Height of the row's hit targets (CSS px). */
export const ROW_PX = 24
/** between the title text and the first orb */
export const TITLE_GAP = 10
const HOVER_MS = 140
const LABEL_WARM_MS = 70
const LABEL_MS = 220
const LABEL_FADE_MS = 120
/** the hover preview shows once the pointer rests on one orb this long (not while sweeping along the row), and fades in */
const PREVIEW_MS = 450
const PREVIEW_FADE_MS = 160
const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter Variable', ui-sans-serif, system-ui, sans-serif`
const ease = bezier(0.4, 0, 0.2, 1)

/** Text widths in CSS px, in the canvas's own font. */
export class TextMeasure {
	private ctx = new OffscreenCanvas(1, 1).getContext('2d')!
	private cache = new Map<string, number>()

	width = (s: string, weight: number, size = 12) => {
		const key = `${weight}|${size}|${s}`
		let w = this.cache.get(key)
		if (w === undefined) {
			this.ctx.font = `${weight} ${size}px ${FONT}`
			w = this.ctx.measureText(s).width
			this.cache.set(key, w)
		}
		return w
	}

	reset() {
		this.cache.clear()
	}
}

/** A value gliding to its target over `dur` ms (standard ease); retargeting starts from where it is. */
export class Glide {
	private from: number
	private to: number
	private start = -1e9

	constructor(
		v: number,
		private dur: number,
	) {
		this.from = this.to = v
	}

	at(now: number) {
		const e = ease(clamp01((now - this.start) / this.dur))
		return this.from + (this.to - this.from) * e
	}

	set(to: number, now: number) {
		if (Math.abs(to - this.to) < 1e-6) return
		this.from = this.at(now)
		this.to = to
		this.start = now
	}

	moving(now: number) {
		return now - this.start < this.dur
	}

	get target() {
		return this.to
	}
}

type Mode = 'row' | 'merged' | 'hidden'

interface Slot {
	el: HTMLButtonElement
	badge: HTMLSpanElement
	unread: number
	/** slot units from the first orb */
	u: Glide
	alpha: Glide
	label: string
}

interface Row {
	el: HTMLElement
	/** where its first orb's centre is, from the title's left, and the orbs' spacing (screen px; last drawn) */
	x0: number
	S: number
	D: number
	mode: Mode
	shown: number
	slots: Map<string, Slot>
	more: { el: HTMLButtonElement; u: Glide; alpha: Glide; text: string }
	agg: { el: HTMLButtonElement; alpha: Glide; text: string; label: string }
}

/** Where an orb was drawn this frame (CSS px), for tracing. */
export interface DrawnOrb {
	id: string
	x: number
	y: number
	alpha: number
}

/**
 * Every row of orbs on one shader layer, and the hover label they share. Each frame: begin(), then
 * for each row in view layout() and draw(), then end() to draw the layer.
 */
export class OrbRows {
	readonly text = new TextMeasure()
	/** whether anything is still gliding or fading */
	animating = false
	/** whether any drawn orb moves on its own (a running clock, a breath, a flash) */
	alive = false
	drawn: DrawnOrb[] = []
	private rows = new Map<string, Row>()
	private tip: HTMLDivElement
	private tipShown = false
	private tipAlpha = 0
	private hovered: string | null = null
	private hoveredAt = 0
	/** the orb just clicked: no preview over the frame it opened, until the pointer leaves it */
	private clicked: string | null = null
	/** what the label shows: what's hovered, once the pointer has rested on it a moment */
	private labelFor: string | null = null
	private labelShownAt = 0
	private labelHiddenAt = -1e9
	private hoverValue = new Map<string, { v: number; at: number; to: number }>()
	private styleCache = new WeakMap<HTMLElement, string>()
	private tipSize = new Map<string, { w: number; h: number }>()
	private params = new Float32Array(16)
	private seen = new Set<string>()

	constructor(
		/** where the label goes */
		tipHost: HTMLElement,
		readonly layer: OrbLayer,
		private actions: RowActions,
	) {
		this.tip = document.createElement('div')
		this.tip.className = 'sa-tip'
		this.tip.hidden = true
		tipHost.appendChild(this.tip)
	}

	/** 0..1: how hovered an orb is (it eases in and out). */
	hover(id: string, now: number) {
		const h = this.hoverValue.get(id)
		if (!h) return 0
		const e = ease(clamp01((now - h.at) / HOVER_MS))
		const v = h.v + (h.to - h.v) * e
		if (e >= 1 && h.to === 0) this.hoverValue.delete(id)
		return v
	}

	/**
	 * Where a subagent's orb is (screen px from its parent's title's left), as drawn this frame: its
	 * slot in the row, the +N it folded into, or the one orb the row merged into.
	 */
	anchor(parentId: string, kidId: string, now: number): number | null {
		const r = this.rows.get(parentId)
		if (!r) return null
		if (r.mode === 'merged') return r.x0
		if (r.mode === 'hidden') return null
		const slot = r.slots.get(kidId)
		if (slot && slot.alpha.target > 0.5) return r.x0 + slot.u.at(now) * r.S
		return r.x0 + r.more.u.at(now) * r.S + Math.max(r.D, r.S) / 2 + 2 + (this.text.width(r.more.text, 600, 12) + 8) / 2
	}

	/** Starts a frame: the layer empties, and the label catches up with the pointer. */
	begin(now: number) {
		this.animating = false
		this.alive = false
		this.drawn = []
		this.seen.clear()
		this.tipShown = false
		this.layer.begin()
		this.updateLabel(now)
		this.tipAlpha = ease(clamp01((now - this.labelShownAt) / LABEL_FADE_MS))
		if (this.hovered !== this.labelFor || this.tipAlpha < 1) this.animating = true
	}

	/** The row's element (made on first use, in `parent`): its hit targets are laid out from its left edge, ROW_PX tall. */
	element(parentId: string, parent: HTMLElement): HTMLElement {
		const r = this.rows.get(parentId) ?? this.createRow(parentId, parent)
		if (r.el.parentElement !== parent) parent.appendChild(r.el)
		return r.el
	}

	/**
	 * Decides the row's form for the room there is (w px from the title's left, the title titleW
	 * wide; with some slack, so it doesn't flap), sets its orbs' targets, and returns how much of the
	 * title shows.
	 */
	layout(parentId: string, info: RowInfo, s: RowSettings, titleW: number, w: number, now: number) {
		const r = this.rows.get(parentId)
		if (!r) return Math.min(titleW, w)
		const n = info.kids.length
		const D = Number(s.p.size)
		const S = Number(s.p.spacing)
		const showAll = r.more.el.dataset.all === '1'
		const cap = showAll ? n : Math.min(n, Math.max(1, s.max))
		const plusW = (k: number) => (k < n ? this.text.width(`+${n - k}`, 600, 12) + 12 : 0)
		const gap = s.gap ?? TITLE_GAP
		const need = (k: number) => gap + D + (k - 1) * S + (k < n ? Math.max(D, S) / 2 - D / 2 + 2 + plusW(k) : 0)
		const avail = w - titleW
		const slack = (m: Mode) => (r.mode === m ? -4 : 4)
		let k = cap
		while (k > 0 && need(k) > avail - (k > r.shown ? 3 : 0)) k--
		const minK = Math.min(n, 2)
		const countW = n > 1 ? this.text.width(String(n), 600, 11) + 6 : 0
		const aggNeed = gap + D + 8 + countW
		let mode: Mode
		let title = titleW
		if (k >= minK && need(minK) <= avail - slack('row')) mode = 'row'
		else if (aggNeed <= avail - slack('merged')) mode = 'merged'
		else if (w - aggNeed >= 56 + slack('merged')) {
			mode = 'merged'
			title = w - aggNeed
		} else {
			mode = 'hidden'
			title = Math.min(titleW, w)
		}
		if (mode === 'row') k = Math.max(k, minK)
		r.mode = mode
		r.shown = mode === 'row' ? k : 0
		let i = 0
		for (const kid of info.kids) {
			const slot = r.slots.get(kid.view.id) ?? this.createSlot(r, kid.view.id)
			const inRow = mode === 'row' && i < k
			// folded ones slide into the +N, merging ones into the aggregate
			slot.u.set(mode === 'row' ? Math.min(i, k) : 0, now)
			slot.alpha.set(inRow ? 1 : 0, now)
			const label = `${kid.view.title}: ${stateText(kid.view)}${kid.view.look.open > 0.5 ? ', expanded' : ''}`
			if (slot.label !== label) {
				slot.label = label
				slot.el.setAttribute('aria-label', label)
			}
			i++
		}
		for (const [id, slot] of r.slots) {
			if (info.kids.some((k) => k.view.id === id)) continue
			slot.el.remove()
			r.slots.delete(id)
		}
		r.agg.alpha.set(mode === 'merged' ? 1 : 0, now)
		const more = mode === 'row' && k < n ? `+${n - k}` : showAll && mode === 'row' && n > Math.max(1, s.max) ? '−' : ''
		r.more.u.set(Math.max(0, k - 1), now)
		r.more.alpha.set(more ? 1 : 0, now)
		if (more && more !== r.more.text) {
			r.more.text = more
			r.more.el.textContent = more
			const hidden = info.kids.slice(k).map((x) => x.view)
			const label = more === '−' ? 'Show fewer' : `${n - k} more: ${summary(hidden)}`
			r.more.el.dataset.label = label
			r.more.el.setAttribute('aria-label', label)
		}
		const aggText = n > 1 ? String(n) : ''
		if (aggText !== r.agg.text) {
			r.agg.text = aggText
			r.agg.el.textContent = aggText
		}
		const aggLabel = n === 1 ? `${info.kids[0].view.title}: ${stateText(info.kids[0].view)}` : `${n} subagents: ${summary(info.kids.map((x) => x.view))} · click to zoom in`
		if (aggLabel !== r.agg.label) {
			r.agg.label = aggLabel
			r.agg.el.setAttribute('aria-label', aggLabel)
		}
		r.x0 = Math.max(0, Math.min(title, w)) + gap + D / 2
		r.S = S
		r.D = D
		return Math.max(0, Math.min(title, w))
	}

	/** Pushes the row's orbs (as laid out) onto the layer and moves its hit targets and the label. */
	draw(parentId: string, info: RowInfo, s: RowSettings, at: RowPlace, now: number) {
		const r = this.rows.get(parentId)
		if (!r) return
		this.seen.add(parentId)
		const layer = this.layer
		const { tech, p } = s
		const { px, y, w, opacity, dpr, anchorY } = at
		const snap = (v: number) => Math.round(v * dpr) / dpr
		const { x0, S, D } = r
		const start = layer.nOrbs
		let lo = Infinity
		let hi = -Infinity
		const reach = tech.reach(p, (D / 2) * dpr, dpr)
		const push = (id: string, k: RowKid | null, ux: number, alpha: number) => {
			const x = px + x0 + ux * S
			// an orb gliding past the end of its title row (the frame narrowing as it folds) fades out
			alpha *= clamp01((px + w - (x + D / 2)) / 6 + 1)
			const look = k ? k.view.look : info.agg
			const seed = k ? k.view.seed : 500 + parentId.length
			layer.orb({
				x: x * dpr,
				y: y * dpr,
				r: (D / 2) * dpr,
				seed: seed % 97,
				rgb: toLinear(k ? k.rgb : info.rgb),
				alpha: alpha * opacity,
				run: look.run,
				done: look.done,
				fail: look.fail,
				wait: look.wait,
				flash: look.flash,
				t: s.reduced ? tech.still : k ? k.time : info.aggTime,
				hover: look.hover,
				open: look.open,
				breath: look.breath,
				phase: k ? fract(seed * 0.6180339) : info.aggPhase,
				aux: S * dpr,
			})
			if (!tech.row) layer.quad(x * dpr - reach[0], y * dpr - reach[1], reach[0] + reach[2], reach[1] + reach[3], layer.nOrbs - 1, 1)
			lo = Math.min(lo, x)
			hi = Math.max(hi, x)
			this.drawn.push({ id, x, y, alpha })
			if (!s.reduced && (look.run + look.wait > 0.001 || look.flash > 0.001)) this.alive = true
		}
		const visible = opacity > 0.5
		for (const k of info.kids) {
			const slot = r.slots.get(k.view.id)
			if (!slot) continue
			const a = slot.alpha.at(now)
			const u = slot.u.at(now)
			if (a > 0.002) push(k.view.id, k, u, a)
			const hit = Math.max(Math.min(S, D + 8), 12)
			const shown = a > 0.5
			this.css(slot.el, shown ? `transform:translate(${snap(x0 + u * S - hit / 2)}px,0);width:${hit}px;--badge-x:${Math.round(hit / 2 + D / 2 - 3)}px;--badge-y:${Math.max(0, Math.round(anchorY - D / 2 - 7))}px` : 'display:none')
			this.setBadge(slot, k.unread)
			if (shown && visible && this.labelFor === k.view.id) {
				const rest = now - this.hoveredAt - PREVIEW_MS
				const thumb = s.preview && k.view.look.open < 0.5 && rest > 0 && this.clicked !== k.view.id ? k.thumb : null
				if (s.preview && k.thumb && rest < PREVIEW_FADE_MS) this.animating = true
				this.showTip(k.view, px + x0 + u * S, y - D / 2 - 7, thumb, at.vw, y + D / 2 + 7, ease(clamp01(rest / PREVIEW_FADE_MS)))
			}
		}
		const aggA = r.agg.alpha.at(now)
		if (aggA > 0.002) push(`agg:${parentId}`, info.kids.length === 1 ? info.kids[0] : null, 0, aggA)
		const aggLive = aggA > 0.5
		const countW = info.kids.length > 1 ? this.text.width(String(info.kids.length), 600, 11) + 6 : 0
		this.css(r.agg.el, aggLive ? `transform:translate(${snap(x0 - D / 2 - 3)}px,0);width:${Math.ceil(D + 10 + countW)}px;--count-x:${D + 9}px` : 'display:none')
		if (aggLive && visible && this.labelFor === `agg:${parentId}`) this.showText(r.agg.label, px + x0, y - D / 2 - 7, at.vw)
		const moreA = r.more.alpha.at(now)
		const moreX = x0 + r.more.u.at(now) * S + Math.max(D, S) / 2 + 2
		this.css(r.more.el, moreA > 0.01 ? `transform:translate(${snap(moreX - 4)}px,0);opacity:${moreA.toFixed(3)};pointer-events:${moreA > 0.5 ? 'auto' : 'none'}` : 'display:none')
		if (moreA > 0.5 && visible && this.labelFor === `more:${parentId}`) this.showText(r.more.el.dataset.label ?? '', px + moreX + 10, y - D / 2 - 7, at.vw)
		this.animating ||= this.rowMoving(r, now)
		const count = layer.nOrbs - start
		if (tech.row && count > 0) layer.quad(lo * dpr - reach[0] - S * dpr, y * dpr - reach[1], (hi - lo) * dpr + reach[0] + reach[2] + 2 * S * dpr, reach[1] + reach[3], start, count)
	}

	/** Hides a row's hit targets this frame (its title is out of view). */
	hide(parentId: string) {
		const r = this.rows.get(parentId)
		if (r) this.css(r.el, 'display:none')
	}

	/** Shows a row hidden before. */
	show(parentId: string) {
		const r = this.rows.get(parentId)
		if (r) this.css(r.el, '')
	}

	/** Forgets a row (its parent is gone). */
	remove(parentId: string) {
		const r = this.rows.get(parentId)
		if (!r) return
		r.el.remove()
		this.rows.delete(parentId)
	}

	/** Parents with a row, drawn or not. */
	ids() {
		return this.rows.keys()
	}

	/** Ends the frame: draws the layer with every orb pushed since begin(). Grid: the dot grid's origin, pitch and dot side, device px. */
	end(s: RowSettings, dpr: number, grid: readonly [number, number, number, number], now: number) {
		if (!this.tipShown) this.tip.hidden = true
		pack(s.tech.params, s.p, this.params)
		this.layer.draw(shaderOf(s.tech), this.params, dpr, grid, s.reduced)
		for (const v of this.hoverValue.values()) if (v.to === 1 ? now - v.at < HOVER_MS : true) this.animating = true
	}

	/** Screen point (relative to `host`) of an orb's hit target, if it's shown; `agg:<parentId>` for the aggregate. */
	orbCentre(id: string, host: HTMLElement): { x: number; y: number } | null {
		let el: HTMLElement | undefined
		if (id.startsWith('agg:')) el = this.rows.get(id.slice(4))?.agg.el
		else for (const r of this.rows.values()) el ??= r.slots.get(id)?.el
		if (!el || !el.offsetParent) return null
		const r = el.getBoundingClientRect()
		if (!r.width) return null
		const c = host.getBoundingClientRect()
		return { x: r.left - c.left + r.width / 2, y: r.top - c.top + r.height / 2 }
	}

	destroy() {
		for (const r of this.rows.values()) r.el.remove()
		this.rows.clear()
		this.tip.remove()
	}

	// ---------- hover and the label ----------

	private setHover(id: string | null, now: number) {
		if (id === this.hovered) return
		for (const key of [this.hovered, id]) {
			if (!key) continue
			const v = this.hover(key, now)
			this.hoverValue.set(key, { v, at: now, to: key === id ? 1 : 0 })
		}
		this.hovered = id
		this.hoveredAt = now
		this.clicked = null
	}

	/**
	 * The label follows the pointer once it rests on an orb (220 ms; 70 ms while a label was just
	 * showing), so sweeping across the row doesn't flash a label per orb; it fades in.
	 */
	private updateLabel(now: number) {
		if (this.hovered === this.labelFor) return
		if (!this.hovered) {
			if (this.labelFor) this.labelHiddenAt = now
			this.labelFor = null
			return
		}
		const warm = !!this.labelFor || now - this.labelHiddenAt < 400
		if (now - this.hoveredAt < (warm ? LABEL_WARM_MS : LABEL_MS)) return
		if (!warm) this.labelShownAt = now
		this.labelFor = this.hovered
	}

	private css(e: HTMLElement, css: string) {
		if (this.styleCache.get(e) === css) return
		this.styleCache.set(e, css)
		e.style.cssText = css
	}

	private rowMoving(r: Row, now: number) {
		if (r.agg.alpha.moving(now) || r.more.alpha.moving(now) || r.more.u.moving(now)) return true
		for (const s of r.slots.values()) if (s.u.moving(now) || s.alpha.moving(now)) return true
		return false
	}

	// ---------- elements ----------

	private createRow(parentId: string, parent: HTMLElement): Row {
		const holder = document.createElement('div')
		holder.className = 'sa-orbs'
		holder.dataset.session = parentId
		parent.appendChild(holder)
		const button = (cls: string, onClick: () => void, hoverKey: string) => {
			const b = document.createElement('button')
			b.type = 'button'
			b.className = cls
			b.addEventListener('pointerdown', (e) => e.stopPropagation())
			b.addEventListener('dblclick', (e) => e.stopPropagation())
			b.addEventListener('click', (e) => (e.stopPropagation(), onClick()))
			this.hoverable(b, hoverKey)
			holder.appendChild(b)
			return b
		}
		const more = button(
			'sa-more',
			() => {
				more.dataset.all = more.dataset.all === '1' ? '' : '1'
				this.actions.showAll(parentId)
			},
			`more:${parentId}`,
		)
		const agg = button('sa-agg', () => this.actions.zoomTo(parentId), `agg:${parentId}`)
		const row: Row = {
			el: holder,
			x0: 0,
			S: 16,
			D: 10,
			mode: 'row',
			shown: 0,
			slots: new Map(),
			more: { el: more, u: new Glide(0, 240), alpha: new Glide(0, 200), text: '' },
			agg: { el: agg, alpha: new Glide(0, 320), text: '', label: '' },
		}
		this.rows.set(parentId, row)
		return row
	}

	private createSlot(r: Row, id: string): Slot {
		const b = document.createElement('button')
		b.type = 'button'
		b.className = 'sa-orb'
		b.dataset.id = id
		b.addEventListener('pointerdown', (e) => e.stopPropagation())
		b.addEventListener('dblclick', (e) => e.stopPropagation())
		b.addEventListener('click', (e) => {
			e.stopPropagation()
			this.clicked = id
			this.actions.toggleKid(id, e.shiftKey)
		})
		// arrow keys move between the orbs of a row (in the order they're drawn)
		b.addEventListener('keydown', (e) => {
			if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
			const all = [...r.slots.values()].filter((x) => x.alpha.target > 0.5).sort((a, c) => a.u.target - c.u.target)
			const i = all.findIndex((x) => x.el === b)
			const next = all[i + (e.key === 'ArrowLeft' ? -1 : 1)]
			if (next) {
				e.preventDefault()
				e.stopPropagation()
				next.el.focus()
			}
		})
		this.hoverable(b, id)
		r.el.insertBefore(b, r.el.firstChild)
		const badge = document.createElement('span')
		badge.className = 'sa-badge'
		badge.hidden = true
		b.appendChild(badge)
		// a new orb starts where it will be, faded out
		const slot: Slot = { el: b, badge, unread: 0, u: new Glide(r.slots.size, 300), alpha: new Glide(0, 260), label: '' }
		r.slots.set(id, slot)
		return slot
	}

	/** Pointing at it (or focusing it from the keyboard) shows its label. */
	private hoverable(b: HTMLElement, key: string) {
		const on = () => this.setHover(key, performance.now())
		const off = () => {
			if (this.hovered === key) this.setHover(null, performance.now())
		}
		b.addEventListener('pointerenter', on)
		b.addEventListener('pointerleave', off)
		b.addEventListener('focus', () => b.matches(':focus-visible') && on())
		b.addEventListener('blur', off)
	}

	private showTip(k: KidView, x: number, y: number, thumb: string | null, vw: number, below: number, thumbAlpha: number) {
		const line = `<span class="line"><span class="nm">${k.agent ? `<span class="agent">${esc(k.agent)}:</span> ` : ''}${esc(k.task)}</span><span class="st ${k.state}">${esc(stateText(k))}</span></span>`
		this.showHtml(thumb ? `<img class="thumb" src="${esc(thumb)}" alt="">${line}` : line, x, y, vw, !!thumb, below, thumbAlpha)
	}

	private showText(text: string, x: number, y: number, vw: number) {
		this.showHtml(`<span class="line"><span class="nm">${esc(text)}</span></span>`, x, y, vw, false)
	}

	/** Centred over the point (under it, `below`, if there's no room over it), kept on screen. */
	private showHtml(html: string, x: number, y: number, vw: number, wide: boolean, below = y, thumbAlpha = 1) {
		this.tipShown = true
		if (this.tip.innerHTML !== html) this.tip.innerHTML = html
		this.tip.hidden = false
		this.tip.classList.toggle('with-thumb', wide)
		if (this.tipSize.size > 200) this.tipSize.clear()
		let size = this.tipSize.get(html)
		if (!size) this.tipSize.set(html, (size = { w: this.tip.offsetWidth, h: wide ? 126 + 8 + 36 : this.tip.offsetHeight }))
		const cx = Math.max(size.w / 2 + 6, Math.min(vw - size.w / 2 - 6, x))
		const under = y - size.h < 4
		this.css(this.tip, `transform:translate(${Math.round(cx)}px,${Math.round(under ? below : y)}px) translate(-50%,${under ? 0 : -100}%);opacity:${this.tipAlpha.toFixed(3)};--thumb:${thumbAlpha.toFixed(3)}`)
	}

	private setBadge(slot: Slot, n: number) {
		if (slot.unread === n) return
		const rose = n > slot.unread
		slot.unread = n
		slot.badge.hidden = n === 0
		slot.badge.textContent = n > 9 ? '9+' : String(n)
		if (rose) {
			slot.badge.classList.remove('pop')
			void slot.badge.offsetWidth
			slot.badge.classList.add('pop')
		}
	}
}

/**
 * The one orb a row merges into, zoomed out: the most pressing state among its subagents (eased
 * between: running, waiting, failed, done), the brightest flash, and its own clock.
 */
export class RowAggregate {
	readonly look: KidLook = { run: 0, done: 1, fail: 0, wait: 0, flash: 0, open: 0, hover: 0, breath: 0 }
	time: number
	readonly phase: number

	constructor(parentId: string) {
		this.time = parentId.length
		this.phase = (parentId.charCodeAt(9) % 17) / 17
	}

	update(kids: KidView[], now: number, dt: number, speed: number, reduced: boolean, hover: number) {
		const has = (s: KidView['state']) => kids.some((k) => k.state === s)
		const target = has('running') ? 'run' : has('waiting') ? 'wait' : has('failed') ? 'fail' : 'done'
		const k = 1 - Math.exp(-dt / 150)
		const l = this.look
		for (const key of ['run', 'done', 'fail', 'wait'] as const) {
			const to = key === target ? 1 : 0
			l[key] += (to - l[key]) * k
			if (Math.abs(to - l[key]) < 0.002) l[key] = to
		}
		l.flash = Math.max(0, ...kids.map((x) => x.look.flash))
		l.hover = hover
		l.breath = reduced ? 0.6 : 0.5 - 0.5 * Math.cos((now / 1000 / 2.4) * 2 * Math.PI)
		this.time += (dt / 1000) * speed * (l.run + 0.35 * l.wait)
		return { agg: l, aggTime: this.time, aggPhase: this.phase }
	}
}

/** Whether any of these looks is still changing on its own (crossfading, flashing, easing its hover or open). */
export function looksMoving(looks: Iterable<KidLook>) {
	const settled = (v: number) => v < 0.001 || v > 0.999
	for (const l of looks) if (!settled(l.run) || !settled(l.done) || !settled(l.fail) || !settled(l.wait) || l.flash > 0 || !settled(l.open) || !settled(l.hover)) return true
	return false
}

export function stateText(k: KidView) {
	const e = k.elapsed
	if (k.state === 'running') return e ? `running · ${e}` : 'running'
	if (k.state === 'done') return e ? `done in ${e}` : 'done'
	if (k.state === 'failed') return e ? `failed after ${e}` : 'failed'
	return 'waiting for an answer'
}

export function summary(kids: KidView[]) {
	const n = { running: 0, waiting: 0, failed: 0, done: 0 }
	for (const k of kids) n[k.state]++
	const parts: string[] = []
	if (n.running) parts.push(`${n.running} running`)
	if (n.waiting) parts.push(`${n.waiting} waiting`)
	if (n.failed) parts.push(`${n.failed} failed`)
	if (n.done) parts.push(`${n.done} done`)
	return parts.join(' · ')
}

const fract = (x: number) => x - Math.floor(x)

export function esc(s: string) {
	return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}
