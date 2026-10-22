import type { Editor } from '../../editor/Editor'
import { easeOut } from '../../render/busy/ember'
import { DotLayer } from '../../render/subagents/dots'
import { blend, clamp01, lookColor, noise3, smoothstep, type KidLook, type RGB } from '../../render/subagents/field'
import type { ParamValues } from '../shared/params'
import type { Plan } from './plan'
import { MORE, type Entry, type KidView, type ListLayout, type PaintContext, type Rect, type Text } from './reps'

/*
 * Everything drawn over the renderer for the detached headers and subagent lists, in screen space:
 * DOM text and buttons, and dots on a DotLayer. Drawn after the renderer, from the same plan it drew,
 * so headers, lists and frames always move together. Entries glide (220 ms, ease-out) when a list
 * reflows, and lists crossfade when they change form (zooming out to the summary, another
 * representation); nothing jumps.
 */

export type HeadStyle = 'line' | 'meta' | 'dot'

export interface HeadInfo {
	id: string
	title: string
	/** a subagent: its name in two parts */
	agent?: string
	task?: string
	child: boolean
	rgb: RGB
	color: string
	look: KidLook
	state: string
	meta: string
	unread: number
	asking: boolean
	/** parents: how many subagents, and whether they're all expanded */
	kids: number
	allOpen: boolean
}

export interface ListInfo {
	parentId: string
	/** what draws it: a representation's id or "summary" (it crossfades when this changes) */
	key: string
	layout: ListLayout
	paint: (list: ListLayout, c: PaintContext) => void
	kids: Map<string, KidView>
	p: ParamValues
	/** clicking its text zooms in (the zoomed-out summary) */
	zoomable: boolean
}

export interface ChromeActions {
	toggleKid(id: string): void
	toggleAll(parentId: string): void
	showAll(parentId: string): void
	zoomTo(sectionId: string): void
	prompt(sectionId: string): void
	attend(sectionId: string): void
}

export const HEAD_PX: Record<HeadStyle, number> = { line: 24, meta: 42, dot: 24 }
const DIVIDER: RGB = [255, 255, 255]
const GLIDE_MS = 220
const FADE_MS = 180
const HOVER_MS = 120
const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter Variable', ui-sans-serif, system-ui, sans-serif`

const PROMPT_ICON =
	'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12.5a7.5 7.5 0 0 1-11.1 6.6L4 20l1-4.4A7.5 7.5 0 1 1 20 12.5z"/><path d="M9 11.5h6M9 14.5h3.5"/></svg>'
const EXPAND_ICON =
	'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>'
const COLLAPSE_ICON =
	'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10l4-4 4 4"/></svg>'
const CLOSE_ICON =
	'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>'

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

interface Tween {
	from: Rect
	to: Rect
	start: number
}

interface EntryEl {
	el: HTMLButtonElement
	entry: Entry
	tween: Tween
	born: number
	/** when it left the layout (it fades out), or 0 */
	gone: number
	style: string
	html: string
}

interface Layer {
	key: string
	el: HTMLDivElement
	layout: ListLayout
	paint: ListInfo['paint']
	kids: Map<string, KidView>
	p: ParamValues
	entries: Map<string, EntryEl>
	notes: HTMLElement[]
	notesHtml: string
	born: number
	/** when it was replaced (it fades out), or 0 */
	gone: number
}

interface ListEl {
	el: HTMLDivElement
	layers: Layer[]
	style: string
	info: ListInfo
}

interface HeadEl {
	el: HTMLDivElement
	title: HTMLElement
	state: HTMLElement
	meta: HTMLElement
	badge: HTMLButtonElement
	prompt: HTMLButtonElement
	toggle: HTMLButtonElement
	style: string
	key: string
	/** where its dot mark is, header-local CSS px */
	mark: { x: number; y: number }
}

export class Chrome {
	readonly dots: DotLayer
	readonly host: HTMLDivElement
	private tip: HTMLDivElement
	private heads = new Map<string, HeadEl>()
	private lists = new Map<string, ListEl>()
	private hovered: string | null = null
	private hoverValue = new Map<string, { v: number; at: number; to: number }>()
	private styleCache = new WeakMap<HTMLElement, string>()
	readonly text = new TextMeasure()
	headStyle: HeadStyle = 'line'
	titlePx = 14
	/** whether anything is still gliding or fading */
	animating = false

	constructor(
		overlay: HTMLElement,
		private editor: Editor,
		private actions: ChromeActions,
	) {
		this.dots = new DotLayer(overlay)
		this.host = document.createElement('div')
		this.host.className = 'sa-chrome'
		overlay.appendChild(this.host)
		this.tip = document.createElement('div')
		this.tip.className = 'sa-tip'
		this.tip.hidden = true
		this.host.appendChild(this.tip)
	}

	/** 0..1: how hovered a subagent's entry is (it eases in and out). */
	hover(id: string, now: number) {
		const h = this.hoverValue.get(id)
		if (!h) return 0
		const e = clamp01((now - h.at) / HOVER_MS)
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
	}

	private css(e: HTMLElement, css: string) {
		if (this.styleCache.get(e) === css) return
		this.styleCache.set(e, css)
		e.style.cssText = css
	}

	draw(plan: Plan, heads: Map<string, HeadInfo>, lists: Map<string, ListInfo>, now: number, dpr: number) {
		const cam = this.editor.camera.peek()
		const { w: vw, h: vh } = this.editor.viewport.peek()
		const snap = (v: number) => Math.round(v * dpr) / dpr
		const screen = (x: number, y: number) => ({ x: snap((x + cam.x) * cam.z), y: snap((y + cam.y) * cam.z) })
		this.dots.clear()
		this.animating = false
		const headH = HEAD_PX[this.headStyle]

		// ---- headers ----
		const seenHeads = new Set<string>()
		for (const h of plan.heads) {
			const info = heads.get(h.id)
			if (!info) continue
			const p = screen(h.box.x, h.box.y)
			// a narrow subagent frame's header may run past its right edge (there's room beside it)
			const w = h.parentId ? Math.max(h.box.w * cam.z, Math.min(300, h.box.w * cam.z * 2.5)) : h.box.w * cam.z
			const visible = h.opacity > 0.01 && p.x < vw && p.x + w > 0 && p.y < vh && p.y + headH > 0 && w > 24
			let el = this.heads.get(h.id)
			if (!visible) {
				if (el) this.css(el.el, 'display:none')
				continue
			}
			seenHeads.add(h.id)
			if (!el) {
				el = this.createHead(h.id)
				this.heads.set(h.id, el)
			}
			this.fillHead(el, info, w)
			this.css(el.el, `transform:translate(${p.x}px,${p.y}px);width:${Math.max(0, Math.floor(w))}px;opacity:${h.opacity.toFixed(3)}`)
			this.paintMark(info, p.x + el.mark.x, p.y + el.mark.y, h.opacity)
		}
		for (const [id, el] of this.heads) if (!seenHeads.has(id)) this.css(el.el, 'display:none')

		// ---- lists ----
		const seenLists = new Set<string>()
		for (const [parentId, lp] of plan.lists) {
			const info = lists.get(parentId)
			if (!info) continue
			seenLists.add(parentId)
			let list = this.lists.get(parentId)
			if (!list) {
				const el = document.createElement('div')
				el.className = 'sa-list'
				this.host.insertBefore(el, this.tip)
				list = { el, layers: [], style: '', info }
				this.lists.set(parentId, list)
			}
			list.info = info
			const p = screen(lp.box.x, lp.box.y)
			const w = lp.box.w * cam.z
			const h = lp.box.h * cam.z
			const visible = p.x < vw && p.x + w > 0 && p.y < vh && p.y + Math.max(h, 40) > 0
			this.updateLayers(list, info, now)
			this.css(list.el, visible ? `transform:translate(${p.x}px,${p.y}px);width:${Math.floor(w)}px` : 'display:none')
			if (!visible) continue
			for (const layer of list.layers) this.drawLayer(list, layer, p.x, p.y, now)
			if (lp.divider !== null && h > 0.5) {
				const d = this.dots.region(p.x, snap((lp.divider + cam.y) * cam.z) - this.dots.pitch / 2, w, this.dots.pitch)
				for (let x = 0; x < d.cols; x++) d.set(x, 0, 0.16, DIVIDER)
			}
		}
		for (const [id, list] of this.lists) {
			if (seenLists.has(id)) continue
			list.el.remove()
			this.lists.delete(id)
		}
		if (this.hovered && !this.findEntry(this.hovered)) {
			this.setHover(null, now)
			this.tip.hidden = true
		}
	}

	// ---------- headers ----------

	private createHead(id: string): HeadEl {
		const el = document.createElement('div')
		el.className = 'sa-head'
		el.dataset.session = id
		el.innerHTML =
			'<div class="row"><span class="title"></span><span class="state"><span class="mark"></span><span class="text"></span></span><span class="spacer"></span>' +
			'<span class="controls"><button class="badge" type="button"></button><button class="ctl prompt" type="button" title="Prompt this session (demo)"></button><button class="ctl toggle" type="button"></button></span></div>' +
			'<div class="meta"><span class="mark"></span><span class="text"></span></div>'
		const q = <T extends HTMLElement>(s: string) => el.querySelector(s) as T
		const head: HeadEl = {
			el,
			title: q('.title'),
			state: q('.state .text'),
			meta: q('.meta .text'),
			badge: q('.badge'),
			prompt: q('.prompt'),
			toggle: q('.toggle'),
			style: '',
			key: '',
			mark: { x: 0, y: 0 },
		}
		head.prompt.innerHTML = PROMPT_ICON
		for (const b of [head.badge, head.prompt, head.toggle]) {
			b.addEventListener('pointerdown', (e) => e.stopPropagation())
			b.addEventListener('dblclick', (e) => e.stopPropagation())
		}
		head.badge.addEventListener('click', (e) => (e.stopPropagation(), this.actions.attend(id)))
		head.prompt.addEventListener('click', (e) => (e.stopPropagation(), this.actions.prompt(id)))
		head.toggle.addEventListener('click', (e) => {
			e.stopPropagation()
			this.actions.toggleAll(id)
		})
		this.host.insertBefore(el, this.host.firstChild)
		return head
	}

	/** Header contents; positions of its parts are worked out here (not measured from the DOM). */
	private fillHead(h: HeadEl, info: HeadInfo, width: number) {
		const style = this.headStyle
		const tp = this.titlePx
		const badge = info.asking ? '?' : info.unread ? String(info.unread) : ''
		const toggle = info.child ? 'close' : info.kids ? (info.allOpen ? 'collapse' : 'expand') : ''
		const titleW = info.child ? this.text.width(info.agent ?? '', 500, tp) + 5 + this.text.width(info.task ?? '', 600, tp) : this.text.width(info.title, 600, tp)
		const badgeW = badge ? 26 : 0
		const buttonsW = 26 + (toggle === 'close' ? 26 : toggle ? 26 + this.text.width(String(info.kids), 600, 11) + 6 : 0)
		const stateW = style === 'line' ? this.text.width(info.state, 500, 12) + 6 : 0
		const fixed = (style === 'dot' ? 16 : 0) + (style === 'line' ? 20 : 0) + 8 + badgeW
		// The title comes first: then the state's words, then the buttons give way (the mark and badge stay).
		let roomy = width >= 200 && fixed + titleW + stateW + buttonsW <= width
		let stated = roomy
		if (!roomy && width >= 200 && fixed + titleW + buttonsW <= width) roomy = true
		else if (!roomy && fixed + titleW + stateW <= width) stated = true
		const room = Math.max(0, width - fixed - (roomy ? buttonsW : 0) - (stated ? stateW : 0))
		const shownTitle = Math.min(titleW, room)
		const key = [style, tp, info.title, info.agent, info.task, info.state, info.meta, badge, toggle, info.kids, roomy, stated, Math.round(shownTitle), info.color].join('|')
		const line = HEAD_PX.line
		if (style === 'line') h.mark = { x: shownTitle + 10, y: (line - 10) / 2 }
		else if (style === 'dot') h.mark = { x: 0, y: (line - 10) / 2 }
		else h.mark = { x: 0, y: line + (18 - 10) / 2 }
		if (h.key === key) return
		h.key = key
		h.el.className = `sa-head s-${style}${info.child ? ' child' : ''}${roomy ? ' roomy' : ''}${stated ? '' : ' terse'}`
		// (on the row: the header's own style is rewritten every frame)
		const row = h.el.firstElementChild as HTMLElement
		row.style.setProperty('--c', info.color)
		row.style.setProperty('--title', `${tp}px`)
		if (info.child) h.title.innerHTML = `<span class="agent"></span><span class="task"></span>`
		else h.title.innerHTML = `<span class="task"></span>`
		if (info.child) (h.title.firstChild as HTMLElement).textContent = info.agent ?? ''
		;(h.title.lastChild as HTMLElement).textContent = info.child ? (info.task ?? '') : info.title
		h.title.style.maxWidth = `${Math.floor(room)}px`
		h.state.textContent = info.state
		h.meta.textContent = info.meta
		h.badge.hidden = !badge
		h.badge.textContent = badge
		h.badge.classList.toggle('asking', info.asking)
		h.badge.title = info.asking ? 'Asking a question: show it' : `${info.unread} step${info.unread === 1 ? '' : 's'} to look at`
		h.toggle.hidden = !toggle
		h.toggle.innerHTML = toggle === 'close' ? CLOSE_ICON : toggle === 'collapse' ? `${COLLAPSE_ICON}<span>${info.kids}</span>` : toggle ? `${EXPAND_ICON}<span>${info.kids}</span>` : ''
		h.toggle.title = toggle === 'close' ? 'Collapse this subagent' : toggle === 'collapse' ? 'Collapse its subagents' : `Expand all ${info.kids} subagents`
	}

	/** The header's mark: a 2×2 dot square in the session colour, flowing while it works. */
	private paintMark(info: HeadInfo, x: number, y: number, alpha: number) {
		const r = this.dots.region(x, y, 10, 10, false)
		if (!r.visible) return
		const look = info.look
		const rgb = lookColor(info.rgb, look)
		for (let cy = 0; cy < r.rows; cy++) {
			for (let cx = 0; cx < r.cols; cx++) {
				const flicker = 0.45 + 0.55 * smoothstep(0.3, 0.8, noise3(cx * 0.8 + info.id.length, cy * 0.8, look.clock * 1.4))
				const v = blend(look, flicker, 0.62, 0.9, 0.2 + 0.7 * look.breath)
				r.set(cx, cy, v * 0.95 * alpha, rgb)
			}
		}
	}

	// ---------- lists ----------

	/** The current layer follows the newest layout; a list that changes form fades the old layer out. */
	private updateLayers(list: ListEl, info: ListInfo, now: number) {
		let top = list.layers[list.layers.length - 1]
		const fresh = !top || top.key !== info.key || !!top.gone
		if (fresh) {
			if (top) top.gone = top.gone || now
			const el = document.createElement('div')
			el.className = 'sa-layer'
			list.el.appendChild(el)
			top = { key: info.key, el, layout: info.layout, paint: info.paint, kids: info.kids, p: info.p, entries: new Map(), notes: [], notesHtml: '', born: list.layers.length ? now : 0, gone: 0 }
			list.layers.push(top)
		}
		top.layout = info.layout
		top.paint = info.paint
		top.kids = info.kids
		top.p = info.p
		// entries: glide to their new place, fade in new ones, fade out the ones that left
		const seen = new Set<string>()
		for (const e of info.layout.entries) {
			seen.add(e.id)
			let el = top.entries.get(e.id)
			if (!el) {
				el = this.createEntry(info.parentId, e)
				top.el.appendChild(el.el)
				// (a new layer fades in as a whole)
				el.born = fresh ? 0 : now
				top.entries.set(e.id, el)
			} else if (!sameRect(el.tween.to, e.rect)) {
				el.tween = { from: rectAt(el.tween, now), to: e.rect, start: now }
			}
			el.entry = e
			el.gone = 0
		}
		for (const [id, el] of top.entries) if (!seen.has(id) && !el.gone) el.gone = now
		// old layers go once faded
		list.layers = list.layers.filter((l) => {
			if (!l.gone || now - l.gone < FADE_MS) return true
			l.el.remove()
			return false
		})
	}

	private createEntry(parentId: string, e: Entry): EntryEl {
		const el = document.createElement('button')
		el.type = 'button'
		el.className = 'sa-entry'
		el.dataset.id = e.id
		el.addEventListener('pointerdown', (ev) => ev.stopPropagation())
		el.addEventListener('dblclick', (ev) => ev.stopPropagation())
		el.addEventListener('click', (ev) => {
			ev.stopPropagation()
			const id = el.dataset.id!
			if (id === MORE) this.actions.showAll(parentId)
			else this.actions.toggleKid(id)
		})
		el.addEventListener('pointerenter', () => this.setHover(el.dataset.id!, performance.now()))
		el.addEventListener('pointerleave', () => {
			if (this.hovered === el.dataset.id) this.setHover(null, performance.now())
			this.tip.hidden = true
		})
		return { el, entry: e, tween: { from: e.rect, to: e.rect, start: 0 }, born: 0, gone: 0, style: '', html: '' }
	}

	private drawLayer(list: ListEl, layer: Layer, x: number, y: number, now: number) {
		const layerAlpha = layer.gone ? 1 - easeOut(clamp01((now - layer.gone) / FADE_MS)) : layer.born ? easeOut(clamp01((now - layer.born) / FADE_MS)) : 1
		if (layer.gone || (layer.born && now - layer.born < FADE_MS)) this.animating = true
		this.css(layer.el, `opacity:${layerAlpha.toFixed(3)}`)
		const rects = new Map<string, Rect>()
		const alphas = new Map<string, number>()
		for (const [id, el] of layer.entries) {
			const r = rectAt(el.tween, now)
			if (now - el.tween.start < GLIDE_MS) this.animating = true
			let a = el.born ? easeOut(clamp01((now - el.born) / FADE_MS)) : 1
			if (el.gone) {
				a *= 1 - easeOut(clamp01((now - el.gone) / FADE_MS))
				if (now - el.gone >= FADE_MS) {
					el.el.remove()
					layer.entries.delete(id)
					continue
				}
			}
			if (a < 1) this.animating = true
			rects.set(id, r)
			alphas.set(id, a)
			const k = layer.kids.get(id)
			const open = k ? k.look.open > 0.5 : false
			const css = `transform:translate(${r.x}px,${r.y}px);width:${r.w}px;height:${r.h}px;opacity:${a.toFixed(3)}`
			if (el.style !== css) {
				el.style = css
				el.el.style.cssText = css
			}
			const html = entryHtml(el.entry)
			if (el.html !== html) {
				el.html = html
				el.el.innerHTML = html
				el.el.className = `sa-entry${el.entry.cls ? ` ${el.entry.cls}` : ''}`
				el.el.setAttribute('aria-label', k ? `${k.title}: ${k.state}${open ? ', expanded' : ''}` : el.entry.texts[0]?.text ?? '')
			}
			el.el.classList.toggle('open', open)
			el.el.classList.toggle('busy', !!k && (k.state === 'running' || k.state === 'waiting'))
			el.el.classList.toggle('failed', !!k && k.state === 'failed')
			if (this.hovered === id && k && !layer.gone) this.showTip(k, x + r.x, y + r.y, r.w)
		}
		const notesHtml = layer.layout.notes.map((t) => textHtml(t, list.info.zoomable)).join('')
		if (notesHtml !== layer.notesHtml) {
			layer.notesHtml = notesHtml
			for (const n of layer.notes) n.remove()
			layer.notes = []
			const holder = document.createElement('div')
			holder.innerHTML = notesHtml
			for (const n of [...holder.children] as HTMLElement[]) {
				if (list.info.zoomable) {
					n.addEventListener('pointerdown', (e) => e.stopPropagation())
					n.addEventListener('click', (e) => (e.stopPropagation(), this.actions.zoomTo(list.info.parentId)))
				}
				layer.el.appendChild(n)
				layer.notes.push(n)
			}
		}
		// dots: each entry at its own alpha (entries fading in or out), the whole layer at the layer's
		const groups = new Map<number, Entry[]>()
		for (const e of layer.layout.entries) {
			const a = Math.round((alphas.get(e.id) ?? 0) * 20) / 20
			if (a <= 0) continue
			let g = groups.get(a)
			if (!g) groups.set(a, (g = []))
			g.push(e)
		}
		for (const [id, el] of layer.entries) {
			if (!el.gone) continue
			const a = Math.round((alphas.get(id) ?? 0) * 20) / 20
			if (a <= 0) continue
			let g = groups.get(a)
			if (!g) groups.set(a, (g = []))
			g.push(el.entry)
		}
		for (const [a, entries] of groups) {
			layer.paint({ ...layer.layout, entries }, { g: this.dots, x, y, rect: (id) => rects.get(id), kids: layer.kids, p: layer.p, alpha: a * layerAlpha })
		}
	}

	private showTip(k: KidView, x: number, y: number, w: number) {
		const state = k.state === 'running' ? `running · ${k.elapsed}` : k.state === 'done' ? `done in ${k.elapsed}` : k.state === 'failed' ? 'failed' : 'waiting for an answer'
		const html = `<span class="nm"><b>${esc(k.agent)}</b> ${esc(k.task)}</span><span class="st ${k.state}">${esc(state)}</span><span class="hint">${k.look.open > 0.5 ? 'Click to collapse' : 'Click to expand its frame'}</span>`
		if (this.tip.innerHTML !== html) this.tip.innerHTML = html
		this.tip.hidden = false
		this.css(this.tip, `transform:translate(${Math.round(x + w / 2)}px,${Math.round(y - 8)}px) translate(-50%,-100%)`)
	}

	private findEntry(id: string) {
		for (const l of this.lists.values()) for (const layer of l.layers) if (!layer.gone && layer.entries.has(id)) return true
		return false
	}

	/** Screen point (canvas container px) of a subagent's entry centre, if it's drawn. */
	entryCentre(id: string): { x: number; y: number } | null {
		for (const l of this.lists.values()) {
			for (const layer of l.layers) {
				const el = layer.entries.get(id)
				if (!el || layer.gone) continue
				const r = el.el.getBoundingClientRect()
				const c = this.host.getBoundingClientRect()
				return { x: r.left - c.left + r.width / 2, y: r.top - c.top + r.height / 2 }
			}
		}
		return null
	}

	destroy() {
		this.host.remove()
		this.dots.canvas.remove()
	}
}

function rectAt(t: Tween, now: number): Rect {
	const e = easeOut(clamp01((now - t.start) / GLIDE_MS))
	if (e >= 1) return t.to
	return { x: t.from.x + (t.to.x - t.from.x) * e, y: t.from.y + (t.to.y - t.from.y) * e, w: t.from.w + (t.to.w - t.from.w) * e, h: t.from.h + (t.to.h - t.from.h) * e }
}

const sameRect = (a: Rect, b: Rect) => Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01 && Math.abs(a.w - b.w) < 0.01 && Math.abs(a.h - b.h) < 0.01

function entryHtml(e: Entry) {
	return e.texts.map((t) => textHtml(t, false)).join('')
}

function textHtml(t: Text, zoomable: boolean) {
	const style = `left:${t.x}px;top:${t.y}px;width:${Math.max(0, t.w)}px;height:${t.h}px;line-height:${t.h}px;text-align:${t.align ?? 'left'}`
	const cls = `sa-text${t.cls ? ` ${t.cls}` : ''}${zoomable ? ' zoomable' : ''}`
	const body = t.agent !== undefined ? `<span class="agent">${esc(t.agent)}</span><span class="task">${esc(t.task ?? '')}</span>` : esc(t.text ?? '')
	return `<span class="${cls}" style="${style}">${body}</span>`
}

function esc(s: string) {
	return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}
