import type { Editor } from '../../editor/Editor'
import type { OrbLayer } from '../../render/subagents/orbs'
import { OrbRows, type RowInfo, type RowSettings as SharedRowSettings } from '../../render/subagents/row'
import { THEME } from '../../theme'
import type { CardPlan, Plan } from './plan'

export { stateText, summary, type RowInfo, type RowKid } from '../../render/subagents/row'

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

export interface RowSettings extends SharedRowSettings {
	titlePx: number
}

export interface ChromeActions {
	/** a click on its orb (shift: alongside the ones open) or its card's close button */
	toggleKid(id: string, additive: boolean): void
	showAll(parentId: string): void
	zoomTo(sectionId: string): void
}

export const HEAD_PX = 24
interface HeadEl {
	el: HTMLDivElement
	title: HTMLElement
	key: string
	row: boolean
	status: HTMLElement | null
	close: HTMLButtonElement | null
}

interface Link {
	caret: HTMLDivElement
	wire: SVGPathElement
}

export class Chrome {
	readonly host: HTMLDivElement
	private heads = new Map<string, HeadEl>()
	private links = new Map<string, Link>()
	private wires: SVGSVGElement
	private styleCache = new WeakMap<HTMLElement, string>()
	/** the orb rows (shared with the app's frame titles) */
	readonly rows: OrbRows

	constructor(
		overlay: HTMLElement,
		private editor: Editor,
		readonly orbs: OrbLayer,
		private actions: ChromeActions,
	) {
		this.host = document.createElement('div')
		this.host.className = 'sa-chrome'
		overlay.appendChild(this.host)
		this.rows = new OrbRows(this.host, orbs, actions)
		this.wires = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
		this.wires.classList.add('sa-wires')
		this.host.insertBefore(this.wires, this.host.firstChild)
	}

	get text() {
		return this.rows.text
	}

	/** whether anything is still gliding or fading */
	get animating() {
		return this.rows.animating
	}

	/** whether any drawn orb moves on its own (a running clock, a breath, a flash) */
	get alive() {
		return this.rows.alive
	}

	get drawn() {
		return this.rows.drawn
	}

	/**
	 * Where a subagent's orb is (screen px from its parent's title's left), as drawn this frame. The
	 * plan anchors its card here, before the row is drawn; the glides are continuous, so the two agree.
	 */
	anchor(parentId: string, kidId: string, now: number): number | null {
		return this.rows.anchor(parentId, kidId, now)
	}

	/** 0..1: how hovered an orb is (it eases in and out). */
	hover(id: string, now: number) {
		return this.rows.hover(id, now)
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
		const tech = s.tech
		const p = s.p
		const D = Number(p.size)
		const anchorY = snap(tech.anchor === 'baseline' ? HEAD_PX / 2 + 0.363 * s.titlePx : HEAD_PX / 2)
		this.rows.begin(now)

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
				this.rows.element(h.id, el.el)
				el.row = true
				shownTitle = this.rows.layout(h.id, row, s, titleW, w, now)
				const y = py + anchorY
				orbsAt.set(h.id, { px, y })
				this.rows.draw(h.id, row, s, { px, y, w, opacity, anchorY, dpr, vw }, now)
			} else if (el.row) {
				this.rows.remove(h.id)
				el.row = false
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
		const grid = [Math.round(cam.x * cam.z * dpr), Math.round(cam.y * cam.z * dpr), Math.max(2, Math.round(5 * dpr)), Math.max(1, Math.floor(2 * dpr + 0.5))] as const
		this.rows.end(s, dpr, grid, now)
	}

	// ---------- elements ----------

	private createHead(id: string): HeadEl {
		const el = document.createElement('div')
		el.className = 'sa-head'
		el.dataset.session = id
		el.innerHTML = '<span class="title"></span>'
		this.host.insertBefore(el, this.host.firstChild)
		return { el, title: el.firstChild as HTMLElement, key: '', row: false, status: null, close: null }
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
		return this.rows.orbCentre(id, this.host)
	}

	destroy() {
		this.host.remove()
	}
}
