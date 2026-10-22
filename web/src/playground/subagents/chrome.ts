import type { Editor } from '../../editor/Editor'
import { bezier } from '../../render/busy/ember'
import { clamp01, toLinear, type KidLook, type RGB } from '../../render/subagents/field'
import type { OrbLayer } from '../../render/subagents/orbs'
import { pack, type ParamValues } from '../shared/params'
import type { Plan } from './plan'
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
}

export interface RowKid {
	view: KidView
	/** the colour its orb is drawn in (its own or its parent's, sRGB 0..255) */
	rgb: RGB
	/** its orb's clock, s */
	time: number
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
}

export interface ChromeActions {
	toggleKid(id: string): void
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
}

type Mode = 'row' | 'merged' | 'hidden'

interface Slot {
	el: HTMLButtonElement
	/** slot units from the first orb */
	u: Glide
	alpha: Glide
	label: string
}

interface Row {
	el: HTMLElement
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
	private hovered: string | null = null
	private hoveredAt = 0
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
		for (const h of plan.heads) {
			const info = heads.get(h.id)
			if (!info) continue
			const px = snap((h.box.x + cam.x) * cam.z)
			const py = snap((h.box.y + cam.y) * cam.z)
			// a narrow subagent frame's title may run past its right edge (there's room beside it)
			const w = h.parentId ? Math.max(h.box.w * cam.z, Math.min(300, h.box.w * cam.z * 2.5)) : h.box.w * cam.z
			const reachUp = tech.anchor === 'baseline' ? Number(p.height ?? 0) : 0
			const visible = h.opacity > 0.01 && px < vw && px + w > 0 && py - reachUp < vh && py + HEAD_PX + 40 > 0 && w > 24
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
						alpha: alpha * h.opacity,
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
					this.css(slot.el, live ? `transform:translate(${snap(x0 + u * S - hit / 2)}px,0);width:${hit}px` : 'display:none')
					if (live && this.labelFor === k.view.id && h.opacity > 0.5) {
						this.showTip(k.view, px + x0 + u * S, y - D / 2 - 7, tipAlpha)
						tipShown = true
					}
				}
				const aggA = r.agg.alpha.at(now)
				if (aggA > 0.002) push(`agg:${h.id}`, row.kids.length === 1 ? row.kids[0] : null, 0, aggA)
				const aggLive = aggA > 0.5
				const countW = row.kids.length > 1 ? this.text.width(String(row.kids.length), 600, 11) + 6 : 0
				this.css(r.agg.el, aggLive ? `transform:translate(${snap(x0 - D / 2 - 3)}px,0);width:${Math.ceil(D + 10 + countW)}px;--count-x:${D + 9}px` : 'display:none')
				if (aggLive && this.labelFor === `agg:${h.id}`) {
					this.showText(r.agg.label, px + x0, y - D / 2 - 7, tipAlpha)
					tipShown = true
				}
				const moreA = r.more.alpha.at(now)
				const moreX = x0 + r.more.u.at(now) * S + Math.max(D, S) / 2 + 2
				this.css(r.more.el, moreA > 0.01 ? `transform:translate(${snap(moreX - 4)}px,0);opacity:${moreA.toFixed(3)};pointer-events:${moreA > 0.5 ? 'auto' : 'none'}` : 'display:none')
				if (moreA > 0.5 && this.labelFor === `more:${h.id}`) {
					this.showText(r.more.el.dataset.label ?? '', px + moreX + 10, y - D / 2 - 7, tipAlpha)
					tipShown = true
				}
				this.animating ||= this.rowMoving(r, now)
				const count = layer.nOrbs - start
				if (tech.row && count > 0) layer.quad(lo * dpr - reach[0] - S * dpr, y * dpr - reach[1], (hi - lo) * dpr + reach[0] + reach[2] + 2 * S * dpr, reach[1] + reach[3], start, count)
			} else if (el.row) {
				el.row.el.remove()
				el.row = null
			}
			this.fillHead(el, info, shownTitle)
			this.css(el.el, `transform:translate(${px}px,${py}px);width:${Math.max(0, Math.floor(w))}px;opacity:${h.opacity.toFixed(3)};--title:${s.titlePx}px`)
		}
		for (const [id, el] of this.heads) if (!seen.has(id)) this.css(el.el, 'display:none')
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
		return { el, title: el.firstChild as HTMLElement, key: '', row: null }
	}

	private fillHead(h: HeadEl, info: HeadInfo, shown: number) {
		this.css(h.title, `max-width:${Math.ceil(shown)}px`)
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
		b.addEventListener('click', (e) => (e.stopPropagation(), this.actions.toggleKid(id)))
		this.hoverable(b, id)
		r.el.insertBefore(b, r.el.firstChild)
		// a new orb starts where it will be, faded out
		const slot: Slot = { el: b, u: new Glide(r.slots.size, 300), alpha: new Glide(0, 260), label: '' }
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

	private showTip(k: KidView, x: number, y: number, alpha: number) {
		this.showHtml(`<span class="nm"><span class="agent">${esc(k.agent)}:</span> ${esc(k.task)}</span><span class="st ${k.state}">${esc(stateText(k))}</span>`, x, y, alpha)
	}

	private showText(text: string, x: number, y: number, alpha: number) {
		this.showHtml(`<span class="nm">${esc(text)}</span>`, x, y, alpha)
	}

	private showHtml(html: string, x: number, y: number, alpha: number) {
		if (this.tip.innerHTML !== html) this.tip.innerHTML = html
		this.tip.hidden = false
		this.css(this.tip, `transform:translate(${Math.round(x)}px,${Math.round(y)}px) translate(-50%,-100%);opacity:${alpha.toFixed(3)}`)
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
