import type { Editor } from '../../editor/Editor'
import { bezier } from '../../render/busy/ember'
import { clamp01, toLinear, type KidLook, type RGB } from '../../render/subagents/field'
import type { OrbLayer } from '../../render/subagents/orbs'
import { pack, type ParamValues } from '../shared/params'
import { THEME } from '../../theme'
import type { CardPlan, Plan } from './plan'
import type { KidView } from './sim'
import { shaderOf, type Technique } from './techniques'

/*
 * Everything drawn over the renderer for the detached titles, in screen space: DOM text and hit
 * targets, and the subagent orbs on the shader layer. Drawn after the renderer, from the same plan
 * and camera, so titles, orbs and frames always move together.
 *
 * A parent's subagents are a row of orbs after its title, on the title's centre line (or baseline).
 * Past the max, the rest fold into "+N". When the frame gets too narrow for two orbs past its
 * title, they flow together into one aggregate orb with a count; narrower still, they hide. Orbs
 * glide between these (positions in slot units, so the row never lags its title) and fade; nothing
 * jumps.
 */

export interface HeadInfo {
	id: string
	title: string
	/** a subagent: its name in two parts */
	agent?: string
	task?: string
	child: boolean
	/** a subagent's state, shown after its title inside its card */
	status?: string
	statusKind?: string
}

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
	titlePx: number
	reduced: boolean
	/** the hover label shows the subagent's latest output */
	preview: boolean
}

export interface ChromeActions {
	/** a click on its orb (shift: alongside the ones open) or its card's close button */
	toggleKid(id: string, additive: boolean): void
	showAll(parentId: string): void
	zoomTo(sectionId: string): void
}

export const HEAD_PX = 24
/** between the title text and the first orb */
const TITLE_GAP = 10
const HOVER_MS = 140
const LABEL_MS = 220
const LABEL_WARM_MS = 70
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
class Glide {
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

interface HeadEl {
	el: HTMLDivElement
	title: HTMLElement
	key: string
	row: Row | null
	status: HTMLElement | null
	close: HTMLButtonElement | null
}

interface Link {
	caret: HTMLDivElement
	wire: SVGPathElement
}

/** Where an orb was drawn this frame (CSS px, canvas container), for tracing. */
export interface DrawnOrb {
	id: string
	x: number
	y: number
	alpha: number
}

export class Chrome {
	readonly host: HTMLDivElement
	private tip: HTMLDivElement
	private heads = new Map<string, HeadEl>()
	private links = new Map<string, Link>()
	private wires: SVGSVGElement
	private hovered: string | null = null
	private hoveredAt = 0
	/** the orb just clicked: no preview over the card it opened, until the pointer leaves it */
	private clicked: string | null = null
	/** what the label shows: what's hovered, once the pointer has rested on it a moment */
	private labelFor: string | null = null
	private labelShownAt = 0
	private labelHiddenAt = -1e9
	private hoverValue = new Map<string, { v: number; at: number; to: number }>()
	private styleCache = new WeakMap<HTMLElement, string>()
	readonly text = new TextMeasure()
	private params = new Float32Array(16)
	/** whether anything is still gliding or fading */
	animating = false
	/** whether any drawn orb moves on its own (a running clock, a breath, a flash) */
	alive = false
	drawn: DrawnOrb[] = []

	constructor(
		overlay: HTMLElement,
		private editor: Editor,
		readonly orbs: OrbLayer,
		private actions: ChromeActions,
	) {
		this.host = document.createElement('div')
		this.host.className = 'sa-chrome'
		overlay.appendChild(this.host)
		this.tip = document.createElement('div')
		this.tip.className = 'sa-tip'
		this.tip.hidden = true
		this.host.appendChild(this.tip)
		this.wires = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
		this.wires.classList.add('sa-wires')
		this.host.insertBefore(this.wires, this.host.firstChild)
	}

	/**
	 * Where a subagent's orb is (screen px from its parent's title's left), as drawn this frame: its
	 * slot in the row, the +N it folded into, or the one orb the row merged into. The plan anchors
	 * its card here, before the row is drawn; the glides are continuous, so the two agree.
	 */
	anchor(parentId: string, kidId: string, now: number): number | null {
		const r = this.heads.get(parentId)?.row
		if (!r) return null
		if (r.mode === 'merged') return r.x0
		if (r.mode === 'hidden') return null
		const slot = r.slots.get(kidId)
		if (slot && slot.alpha.target > 0.5) return r.x0 + slot.u.at(now) * r.S
		return r.x0 + r.more.u.at(now) * r.S + Math.max(r.D, r.S) / 2 + 2 + (this.text.width(r.more.text, 600, 12) + 8) / 2
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

	draw(plan: Plan, heads: Map<string, HeadInfo>, rows: Map<string, RowInfo>, s: RowSettings, now: number, dpr: number) {
		const cam = this.editor.camera.peek()
		const { w: vw, h: vh } = this.editor.viewport.peek()
		const snap = (v: number) => Math.round(v * dpr) / dpr
		const layer = this.orbs
		const tech = s.tech
		const p = s.p
		const D = Number(p.size)
		const S = Number(p.spacing)
		const anchorY = snap(tech.anchor === 'baseline' ? HEAD_PX / 2 + 0.363 * s.titlePx : HEAD_PX / 2)
		this.animating = false
		this.alive = false
		this.drawn = []
		layer.begin()
		this.updateLabel(now)
		const tipAlpha = ease(clamp01((now - this.labelShownAt) / LABEL_FADE_MS))
		if (this.hovered !== this.labelFor || tipAlpha < 1) this.animating = true
		let tipShown = false

		const seen = new Set<string>()
		const toScreen = (b: { x: number; y: number; w: number; h: number }) => ({ x: (b.x + cam.x) * cam.z, y: (b.y + cam.y) * cam.z, w: b.w * cam.z, h: b.h * cam.z })
		const floating = plan.cards.filter((c) => c.fit === 'overlay' && c.opacity > 0.01).map((c) => ({ c, b: toScreen(c.box) }))
		const orbsAt = new Map<string, { px: number; y: number }>()
		for (const h of plan.heads) {
			const info = heads.get(h.id)
			if (!info) continue
			const px = snap((h.box.x + cam.x) * cam.z)
			const py = snap((h.box.y + cam.y) * cam.z)
			// a narrow subagent frame's title may run past its right edge (there's room beside it); one in a card stays in it
			const w = h.inCard ? h.box.w * cam.z : h.parentId ? Math.max(h.box.w * cam.z, Math.min(300, h.box.w * cam.z * 2.5)) : h.box.w * cam.z
			// a card floating over a neighbouring frame hides the title it covers
			let covered = 0
			for (const { c, b } of floating) {
				if (c.parentId === h.id || c.parentId === h.parentId || c.id === h.id) continue
				if (px < b.x + b.w && px + w > b.x && py < b.y + b.h && py + HEAD_PX > b.y) covered = Math.max(covered, c.opacity)
			}
			const opacity = h.opacity * (1 - covered)
			const reachUp = tech.anchor === 'baseline' ? Number(p.height ?? 0) : 0
			const visible = opacity > 0.01 && px < vw && px + w > 0 && py - reachUp < vh && py + HEAD_PX + 40 > 0 && w > 24
			let el = this.heads.get(h.id)
			if (!visible) {
				if (el) this.css(el.el, 'display:none')
				continue
			}
			seen.add(h.id)
			if (!el) {
				el = this.createHead(h.id)
				this.heads.set(h.id, el)
			}
			const row = rows.get(h.id)
			const titleW = info.child ? this.text.width(info.agent ?? '', 500, s.titlePx) + 5 + this.text.width(info.task ?? '', 600, s.titlePx) : this.text.width(info.title, 600, s.titlePx)
			let shownTitle = Math.min(titleW, w)
			if (row && row.kids.length) {
				const r = (el.row ??= this.createRow(el, h.id))
				shownTitle = this.layoutRow(r, row, s, titleW, w, now)
				const x0 = shownTitle + TITLE_GAP + D / 2
				const y = py + anchorY
				r.x0 = x0
				r.S = S
				r.D = D
				orbsAt.set(h.id, { px, y })
				const start = layer.nOrbs
				let lo = Infinity
				let hi = -Infinity
				const reach = tech.reach(p, (D / 2) * dpr, dpr)
				const push = (id: string, k: RowKid | null, ux: number, alpha: number) => {
					const x = px + x0 + ux * S
					// an orb gliding past the end of its title row (the frame narrowing as it folds) fades out
					alpha *= clamp01((px + w - (x + D / 2)) / 6 + 1)
					const look = k ? k.view.look : row.agg
					const rgb = toLinear(k ? k.rgb : row.rgb)
					const seed = k ? k.view.seed : 500 + h.id.length
					const phase = k ? fract(seed * 0.6180339) : row.aggPhase
					layer.orb({
						x: x * dpr,
						y: y * dpr,
						r: (D / 2) * dpr,
						seed: seed % 97,
						rgb,
						alpha: alpha * opacity,
						run: look.run,
						done: look.done,
						fail: look.fail,
						wait: look.wait,
						flash: look.flash,
						t: s.reduced ? tech.still : k ? k.time : row.aggTime,
						hover: look.hover,
						open: look.open,
						breath: look.breath,
						phase,
						aux: S * dpr,
					})
					if (!tech.row) layer.quad(x * dpr - reach[0], y * dpr - reach[1], reach[0] + reach[2], reach[1] + reach[3], layer.nOrbs - 1, 1)
					lo = Math.min(lo, x)
					hi = Math.max(hi, x)
					this.drawn.push({ id, x, y, alpha })
					if (!s.reduced && (look.run + look.wait > 0.001 || look.flash > 0.001)) this.alive = true
				}
				for (const k of row.kids) {
					const slot = r.slots.get(k.view.id)
					if (!slot) continue
					const a = slot.alpha.at(now)
					const u = slot.u.at(now)
					if (a > 0.002) push(k.view.id, k, u, a)
					const hit = Math.max(Math.min(S, D + 8), 12)
					const live = a > 0.5
					this.css(slot.el, live ? `transform:translate(${snap(x0 + u * S - hit / 2)}px,0);width:${hit}px;--badge-x:${Math.round(hit / 2 + D / 2 - 3)}px;--badge-y:${Math.max(0, Math.round(anchorY - D / 2 - 7))}px` : 'display:none')
					this.setBadge(slot, k.unread)
					if (live && this.labelFor === k.view.id && opacity > 0.5) {
						const rest = now - this.hoveredAt - PREVIEW_MS
						const thumb = s.preview && k.view.look.open < 0.5 && rest > 0 && this.clicked !== k.view.id ? k.thumb : null
						if (s.preview && k.thumb && rest < PREVIEW_FADE_MS) this.animating = true
						this.showTip(k.view, px + x0 + u * S, y - D / 2 - 7, tipAlpha, thumb, vw, y + D / 2 + 7, ease(clamp01(rest / PREVIEW_FADE_MS)))
						tipShown = true
					}
				}
				const aggA = r.agg.alpha.at(now)
				if (aggA > 0.002) push(`agg:${h.id}`, row.kids.length === 1 ? row.kids[0] : null, 0, aggA)
				const aggLive = aggA > 0.5
				const countW = row.kids.length > 1 ? this.text.width(String(row.kids.length), 600, 11) + 6 : 0
				this.css(r.agg.el, aggLive ? `transform:translate(${snap(x0 - D / 2 - 3)}px,0);width:${Math.ceil(D + 10 + countW)}px;--count-x:${D + 9}px` : 'display:none')
				if (aggLive && this.labelFor === `agg:${h.id}`) {
					this.showText(r.agg.label, px + x0, y - D / 2 - 7, tipAlpha, vw)
					tipShown = true
				}
				const moreA = r.more.alpha.at(now)
				const moreX = x0 + r.more.u.at(now) * S + Math.max(D, S) / 2 + 2
				this.css(r.more.el, moreA > 0.01 ? `transform:translate(${snap(moreX - 4)}px,0);opacity:${moreA.toFixed(3)};pointer-events:${moreA > 0.5 ? 'auto' : 'none'}` : 'display:none')
				if (moreA > 0.5 && this.labelFor === `more:${h.id}`) {
					this.showText(r.more.el.dataset.label ?? '', px + moreX + 10, y - D / 2 - 7, tipAlpha, vw)
					tipShown = true
				}
				this.animating ||= this.rowMoving(r, now)
				const count = layer.nOrbs - start
				if (tech.row && count > 0) layer.quad(lo * dpr - reach[0] - S * dpr, y * dpr - reach[1], (hi - lo) * dpr + reach[0] + reach[2] + 2 * S * dpr, reach[1] + reach[3], start, count)
			} else if (el.row) {
				el.row.el.remove()
				el.row = null
			}
			// in a card: the title, then its state if there's room for both (else the title gets it all)
			let status = info.status ?? ''
			if (h.inCard) {
				const room = w - 30
				if (status && titleW + this.text.width(status, 500, 12) + 10 > room) status = ''
				shownTitle = Math.max(0, Math.min(titleW, room))
			}
			this.fillHead(el, { ...info, status }, shownTitle, h.inCard)
			this.css(el.el, `transform:translate(${px}px,${py}px);width:${Math.max(0, Math.floor(w))}px;opacity:${opacity.toFixed(3)};--title:${s.titlePx}px;--status-x:${Math.ceil(shownTitle) + 8}px`)
		}
		for (const [id, el] of this.heads) if (!seen.has(id)) this.css(el.el, 'display:none')
		this.drawLinks(plan.cards, orbsAt, anchorY, D, now, snap)
		if (!tipShown) this.tip.hidden = true
		pack(tech.params, p, this.params)
		const grid = [Math.round(cam.x * cam.z * dpr), Math.round(cam.y * cam.z * dpr), Math.max(2, Math.round(5 * dpr)), Math.max(1, Math.floor(2 * dpr + 0.5))] as const
		layer.draw(shaderOf(tech), this.params, dpr, grid, s.reduced)
		for (const v of this.hoverValue.values()) if (v.to === 1 ? now - v.at < HOVER_MS : true) this.animating = true
	}

	private rowMoving(r: Row, now: number) {
		if (r.agg.alpha.moving(now) || r.more.alpha.moving(now) || r.more.u.moving(now)) return true
		for (const s of r.slots.values()) if (s.u.moving(now) || s.alpha.moving(now)) return true
		return false
	}

	/**
	 * Decides the row's form for the room there is (with some slack, so it doesn't flap), sets its
	 * orbs' targets, and returns how much of the title shows.
	 */
	private layoutRow(r: Row, info: RowInfo, s: RowSettings, titleW: number, w: number, now: number) {
		const n = info.kids.length
		const D = Number(s.p.size)
		const S = Number(s.p.spacing)
		const showAll = r.more.el.dataset.all === '1'
		const cap = showAll ? n : Math.min(n, Math.max(1, s.max))
		const plusW = (k: number) => (k < n ? this.text.width(`+${n - k}`, 600, 12) + 12 : 0)
		const need = (k: number) => TITLE_GAP + D + (k - 1) * S + (k < n ? Math.max(D, S) / 2 - D / 2 + 2 + plusW(k) : 0)
		const avail = w - titleW
		const slack = (m: Mode) => (r.mode === m ? -4 : 4)
		let k = cap
		while (k > 0 && need(k) > avail - (k > r.shown ? 3 : 0)) k--
		const minK = Math.min(n, 2)
		const countW = n > 1 ? this.text.width(String(n), 600, 11) + 6 : 0
		const aggNeed = TITLE_GAP + D + 8 + countW
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
		return Math.max(0, Math.min(title, w))
	}

	// ---------- elements ----------

	private createHead(id: string): HeadEl {
		const el = document.createElement('div')
		el.className = 'sa-head'
		el.dataset.session = id
		el.innerHTML = '<span class="title"></span>'
		this.host.insertBefore(el, this.host.firstChild)
		return { el, title: el.firstChild as HTMLElement, key: '', row: null, status: null, close: null }
	}

	private fillHead(h: HeadEl, info: HeadInfo, shown: number, inCard: boolean) {
		this.css(h.title, `max-width:${Math.max(0, Math.ceil(shown))}px`)
		if (inCard && !h.close) {
			h.status = document.createElement('span')
			h.status.className = 'status'
			h.close = document.createElement('button')
			h.close.type = 'button'
			h.close.className = 'sa-close'
			h.close.textContent = '×'
			h.close.setAttribute('aria-label', `Collapse ${info.title}`)
			h.close.addEventListener('pointerdown', (e) => e.stopPropagation())
			h.close.addEventListener('click', (e) => (e.stopPropagation(), this.actions.toggleKid(info.id, true)))
			h.el.append(h.status, h.close)
		} else if (!inCard && h.close) {
			h.status?.remove()
			h.close.remove()
			h.status = h.close = null
		}
		h.el.classList.toggle('in-card', inCard)
		if (h.status) {
			const text = info.status ?? ''
			if (h.status.textContent !== text) h.status.textContent = text
			const cls = `status ${info.statusKind ?? ''}`
			if (h.status.className !== cls) h.status.className = cls
		}
		const key = `${info.title}|${info.child}`
		if (h.key === key) return
		h.key = key
		h.el.classList.toggle('child', info.child)
		if (info.child) h.title.innerHTML = `<span class="agent"></span><span class="task"></span>`
		else h.title.innerHTML = `<span class="task"></span>`
		if (info.child) (h.title.firstChild as HTMLElement).textContent = info.agent ?? ''
		;(h.title.lastChild as HTMLElement).textContent = info.child ? (info.task ?? '') : info.title
	}

	private createRow(head: HeadEl, parentId: string): Row {
		const holder = document.createElement('div')
		holder.className = 'sa-orbs'
		head.el.appendChild(holder)
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
		return {
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

	private showTip(k: KidView, x: number, y: number, alpha: number, thumb: string | null, vw: number, below: number, thumbAlpha: number) {
		const line = `<span class="line"><span class="nm"><span class="agent">${esc(k.agent)}:</span> ${esc(k.task)}</span><span class="st ${k.state}">${esc(stateText(k))}</span></span>`
		this.showHtml(thumb ? `<img class="thumb" src="${esc(thumb)}" alt="">${line}` : line, x, y, alpha, vw, !!thumb, below, thumbAlpha)
	}

	private showText(text: string, x: number, y: number, alpha: number, vw: number) {
		this.showHtml(`<span class="line"><span class="nm">${esc(text)}</span></span>`, x, y, alpha, vw, false)
	}

	/** Centred over the point (under it, `below`, if there's no room over it), kept on screen. */
	private showHtml(html: string, x: number, y: number, alpha: number, vw: number, wide: boolean, below = y, thumbAlpha = 1) {
		if (this.tip.innerHTML !== html) this.tip.innerHTML = html
		this.tip.hidden = false
		this.tip.classList.toggle('with-thumb', wide)
		if (this.tipSize.size > 200) this.tipSize.clear()
		let size = this.tipSize.get(html)
		if (!size) this.tipSize.set(html, (size = { w: this.tip.offsetWidth, h: wide ? 126 + 8 + 36 : this.tip.offsetHeight }))
		const cx = Math.max(size.w / 2 + 6, Math.min(vw - size.w / 2 - 6, x))
		const under = y - size.h < 4
		this.css(this.tip, `transform:translate(${Math.round(cx)}px,${Math.round(under ? below : y)}px) translate(-50%,${under ? 0 : -100}%);opacity:${alpha.toFixed(3)};--thumb:${thumbAlpha.toFixed(3)}`)
	}

	private tipSize = new Map<string, { w: number; h: number }>()

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

	/**
	 * Each card's caret, on its top edge right under its orb (as near as the card allows), and the wire
	 * from the orb down to it: straight when it's right under, else round the corner.
	 */
	private drawLinks(cards: CardPlan[], orbs: Map<string, { px: number; y: number }>, anchorY: number, D: number, now: number, snap: (v: number) => number) {
		const cam = this.editor.camera.peek()
		const seen = new Set<string>()
		// several open: the ones further right turn the corner higher up, so no two wires cross
		const rank = new Map<string, { i: number; n: number }>()
		const byParent = new Map<string, CardPlan[]>()
		for (const c of cards) if (c.fit !== 'drawer') byParent.set(c.parentId, [...(byParent.get(c.parentId) ?? []), c])
		for (const list of byParent.values()) list.sort((a, b) => a.orbX - b.orbX).forEach((c, i) => rank.set(c.id, { i, n: list.length }))
		// drawers stack: only the top one hangs from its orb (a wire to one lower down would cross it)
		const topDrawer = new Map<string, CardPlan>()
		for (const c of cards) if (c.fit === 'drawer' && c.caret > 0.01 && (!topDrawer.has(c.parentId) || c.box.y < topDrawer.get(c.parentId)!.box.y)) topDrawer.set(c.parentId, c)
		for (const c of cards) {
			const at = orbs.get(c.parentId)
			if (!at || c.caret < 0.01 || (c.fit === 'drawer' && topDrawer.get(c.parentId) !== c)) continue
			// the wire leaves its orb; the caret is where the plan anchored the card (between two orbs, mid-switch)
			const a = this.anchor(c.parentId, c.id, now)
			const ox = at.px + (a ?? 40)
			const px = (c.orbX + cam.x) * cam.z
			const top = snap((c.box.y + cam.y) * cam.z)
			const left = (c.box.x + cam.x) * cam.z
			const w = c.box.w * cam.z
			const grow = c.caret
			const cx = snap(Math.max(left + 12, Math.min(left + w - 12, px)))
			let link = this.links.get(c.id)
			if (!link) {
				const caret = document.createElement('div')
				caret.className = 'sa-caret'
				caret.style.setProperty('--fill', THEME.frame)
				this.host.insertBefore(caret, this.wires.nextSibling)
				const wire = document.createElementNS('http://www.w3.org/2000/svg', 'path')
				this.wires.appendChild(wire)
				link = { caret, wire }
				this.links.set(c.id, link)
			}
			seen.add(c.id)
			const alpha = grow
			this.css(link.caret, `transform:translate(${cx - 6}px,${top - 6}px) scale(${(0.4 + 0.6 * grow).toFixed(3)}) rotate(45deg);opacity:${alpha.toFixed(3)}`)
			const y0 = snap(at.y + D / 2 + 3)
			const y1 = top - 8
			const xo = snap(ox)
			let d = ''
			if (y1 - y0 > 2) {
				if (Math.abs(cx - xo) < 1) d = `M${xo} ${y0}V${y1}`
				else {
					const k = rank.get(c.id)
					const mid = k && k.n > 1 ? Math.round(Math.max(y0 + 3, y1 - 4 - (k.n - 1 - k.i) * Math.min(4, (y1 - y0 - 7) / Math.max(1, k.n - 1)))) : Math.round((y0 + y1) / 2)
					const r = Math.min(4, Math.abs(cx - xo) / 2, (y1 - y0) / 4)
					const sx = Math.sign(cx - xo)
					d = `M${xo} ${y0}V${mid - r}Q${xo} ${mid} ${xo + sx * r} ${mid}H${cx - sx * r}Q${cx} ${mid} ${cx} ${mid + r}V${y1}`
				}
			}
			if (link.wire.getAttribute('d') !== d) link.wire.setAttribute('d', d)
			const wa = alpha.toFixed(3)
			if (link.wire.getAttribute('opacity') !== wa) link.wire.setAttribute('opacity', wa)
		}
		for (const [id, link] of this.links) {
			if (seen.has(id)) continue
			link.caret.remove()
			link.wire.remove()
			this.links.delete(id)
		}
	}

	/** Screen point (canvas container px) of an orb's hit target, if it's shown. */
	orbCentre(id: string): { x: number; y: number } | null {
		const el = this.host.querySelector<HTMLElement>(id.startsWith('agg:') ? `.sa-head[data-session="${id.slice(4)}"] .sa-agg` : `.sa-orb[data-id="${id}"]`)
		if (!el || el.style.display === 'none') return null
		const r = el.getBoundingClientRect()
		if (!r.width) return null
		const c = this.host.getBoundingClientRect()
		return { x: r.left - c.left + r.width / 2, y: r.top - c.top + r.height / 2 }
	}

	destroy() {
		this.host.remove()
	}
}

export function stateText(k: KidView) {
	return k.state === 'running' ? `running · ${k.elapsed}` : k.state === 'done' ? `done in ${k.elapsed}` : k.state === 'failed' ? `failed after ${k.elapsed}` : 'waiting for an answer'
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

function esc(s: string) {
	return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}
