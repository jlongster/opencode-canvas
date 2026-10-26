import { sessionColor } from '../../../shared/sessionColor'
import type { Session, SessionActivity } from '../../../shared/types'
import type { Editor, FrameStatus } from '../editor/Editor'
import { Box } from '../editor/geometry'
import { LAYOUT, SHEET, type SectionLayout } from '../editor/layout'
import { clock } from './segments'
import './sheet.css'

/*
 * The Reference Manual's sheet heads (see render/sheet.css): each frame's head is a title row (the
 * session's title, a running or asking cell, its prompt keycap and buttons), inverted while the frame
 * is connected to its live session and greyed when it isn't; while it works, a slim printout of what
 * it's doing under it, fed like a chain printer; and its subagents as a row of documents. Group
 * headings and the "older items hidden" row are here too.
 *
 * Heads are DOM laid out in design px (the mockup's own sizes) and scaled onto the page: a design px
 * is SHEET.k page px, and heads never shrink below LAYOUT.minFrameTitlePx for their title on screen;
 * zoomed out past that, they grow upward out of their frame (see frameTitleBox) and turn to ink.
 */

interface Displayed {
	x: number
	y: number
	w: number
	h: number
	opacity: number
}

type KidState = 'running' | 'waiting' | 'failed' | 'done'

const PROMPT_ICON =
	'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/></svg>'
const EYE_ICON =
	'<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>'
const CLOSE_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>'

const INK = '#151515'
const SHEET_FILL = '#FBFAF6'
const RED = '#C2381F'
const DRAWER_FILL = '#F3F1EA'
/** zoomed out this far past where heads stop shrinking, they turn to ink (A-s3) */
const FAR = 0.7
/** design px: a head is at least this wide (on screen, in design px) for its buttons to show */
const ROOMY_PX = 250

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
/** A subagent's title without OpenCode's "(@explore subagent)" tail. */
const kidTitle = (title: string) => title.replace(/\s*\(@[\w-]+ subagent\)\s*$/, '').trim() || 'Subagent'

interface Head {
	el: HTMLDivElement
	title: HTMLElement
	row: HTMLElement
	/** the title row's state cell (a frame's), or a drawer head's meta */
	block: HTMLElement
	tray: HTMLElement | null
	printout: HTMLElement | null
	notch: SVGSVGElement | null
	keys: Record<string, string>
	/** the printout's current line, and what fed it */
	line: string
	drawer: boolean
}

export class SheetHeads {
	private heads = new Map<string, Head>()
	private others = new Map<string, HTMLDivElement>()
	private host: HTMLDivElement
	/** sessions seen working, and when they started (ms), when activity doesn't say */
	private seenBusy = new Map<string, number>()
	/** running clocks to tick: session id → its clock element and since when */
	private clocks = new Map<string, { el: HTMLElement; since: number; text: string }>()
	private ticker = 0
	/** the zoom the heads were last rastered at, and the pending re-raster once a zoom settles */
	private rasterZ = 0
	private rasterTimer = 0

	constructor(
		parent: HTMLElement,
		private editor: Editor,
		/** null hides the hide buttons (read-only views) */
		private onHide: ((sectionId: string) => void) | null,
		private onShowMore: (sectionId: string, count: number) => void,
		/** a subagent's drawer's × */
		private onCloseDrawer: (sectionId: string) => void,
	) {
		this.host = document.createElement('div')
		this.host.className = 'sheet-heads'
		parent.appendChild(this.host)
		// (whole seconds, no tweening)
		this.ticker = window.setInterval(() => this.tick(), 1000)
	}

	destroy() {
		clearInterval(this.ticker)
		clearTimeout(this.rasterTimer)
		this.host.remove()
	}

	private tick() {
		const now = Date.now()
		for (const c of this.clocks.values()) {
			const text = clock(now - c.since)
			if (text === c.text) continue
			c.text = text
			c.el.textContent = text
		}
	}

	update(sections: SectionLayout[], displayed: Map<string, Displayed>, liftedId: string | null) {
		const editor = this.editor
		const z = editor.camera.peek().z
		const sessions = editor.sessions.peek()
		const items = editor.items.peek()
		const activity = editor.activity.get()
		const busy = editor.busy.peek()
		const { kids } = editor.families.get()
		const hoveredGroupId = editor.hoveredGroupId.peek()
		const hoveredFrameId = editor.hoveredFrameId.peek()
		const linkedGroupId = editor.linkedGroup.get()?.id
		const now = Date.now()

		// working, as seen from here
		for (const id of busy) if (!this.seenBusy.has(id)) this.seenBusy.set(id, now)
		for (const id of [...this.seenBusy.keys()]) if (!busy.has(id)) this.seenBusy.delete(id)

		const counts = new Map<string, number>()
		for (const item of Object.values(items)) counts.set(item.sessionId, (counts.get(item.sessionId) ?? 0) + 1)

		const seen = new Set<string>()
		const live = new Set<string>()
		const minScale = LAYOUT.minFrameTitlePx / LAYOUT.frameTitlePx
		for (const s of sections) {
			const d = displayed.get(s.id)
			if (!d) continue
			const dx = d.x - s.box.x
			const dy = d.y - s.box.y
			const shift = (b: Box): Box => ({ x: b.x + dx, y: b.y + dy, w: b.w, h: b.h })
			seen.add(s.id)
			let head = this.heads.get(s.id)
			if (head && head.drawer !== !!s.drawer) {
				head.el.remove()
				head = undefined
			}
			if (!head) {
				head = s.drawer ? this.createDrawerHead(s.id) : this.createHead(s.id)
				this.host.appendChild(head.el)
				this.heads.set(s.id, head)
			}
			const session = sessions[s.id]
			const status = editor.frameChrome?.status(s.id) ?? null
			const act = activity[s.id]
			const count = counts.get(s.id)
			const scale = s.drawer ? z : Math.max(z, minScale)
			const S = scale * SHEET.k
			const header = shift(s.header)
			const b = editor.pageToScreen({ x: header.x, y: header.y + header.h })
			const wD = (header.w * z) / S
			const hD = header.h / SHEET.k
			const el = head.el
			el.style.width = `${wD}px`
			el.style.height = `${hD}px`
			el.style.transform = `translate(${b.x}px, ${b.y - hD}px) scale(${S})`
			el.style.setProperty('--hair', `${1 / S}px`)
			el.style.opacity = String(d.opacity)
			el.classList.toggle('far', !s.drawer && z < minScale * FAR)
			el.classList.toggle('hovered', s.id === hoveredFrameId && !liftedId)
			el.classList.toggle('lifted', s.id === liftedId)
			el.classList.toggle('ended', !!status?.ended)
			head.row.classList.toggle('roomy', wD * S >= ROOMY_PX)

			const untitled = !s.title.trim() || s.title === s.id
			const title = s.drawer ? kidTitle(s.title) : untitled ? 'Untitled session' : s.title
			if (head.title.textContent !== title) {
				head.title.textContent = title
				head.title.title = untitled ? s.id : s.title
				head.title.classList.toggle('untitled', untitled)
			}
			this.showButtons(el, status)

			const working = busy.has(s.id)
			// (working or asking: something reports it live, so it's connected too)
			if (!s.drawer) el.classList.toggle('connected', !status?.ended && !!(status?.connected || status?.asking || working))
			const since = act?.busySince ?? this.seenBusy.get(s.id) ?? now
			if (working) live.add(s.id)
			if (s.drawer) {
				this.fillDrawerHead(head, s.id, session, act, count ?? 0, working)
				continue
			}
			this.fillState(head, s.id, session, status, working, since)
			this.fillPrintout(head, s.id, act, working, since)
			this.fillTray(head, s.id, kids.get(s.id) ?? [], sessions)
		}
		for (const [id, head] of this.heads) {
			if (seen.has(id)) continue
			head.el.remove()
			this.heads.delete(id)
		}
		for (const id of this.clocks.keys()) if (!live.has(id)) this.clocks.delete(id)

		// group headings and "older items hidden" rows
		const seenOther = new Set<string>()
		for (const s of sections) {
			const d = displayed.get(s.id)
			if (!d) continue
			const dx = d.x - s.box.x
			const dy = d.y - s.box.y
			for (const g of s.groups) {
				if (!g.heading) continue
				const key = `g:${g.id}`
				seenOther.add(key)
				let h = this.others.get(key)
				if (!h) {
					h = document.createElement('div')
					h.className = 'sheet-group'
					h.innerHTML = '<span class="name"></span><span class="count"></span>'
					this.host.appendChild(h)
					this.others.set(key, h)
				}
				const [name, count] = h.children as unknown as HTMLElement[]
				if (name.textContent !== g.name) name.textContent = g.name
				const n = g.itemIds.length
				const c = `${n} ${n === 1 ? 'item' : 'items'}`
				if (count.textContent !== c) count.textContent = c
				h.classList.toggle('first', g === s.groups[0])
				this.placeDesign(h, { x: g.heading.x + dx, y: g.heading.y + dy, w: g.heading.w, h: g.heading.h }, z)
				h.style.opacity = String(d.opacity)
				h.classList.toggle('hovered', g.id === hoveredGroupId)
				h.classList.toggle('linked', g.id === linkedGroupId)
			}
			if (s.more) {
				const key = `m:${s.id}`
				seenOther.add(key)
				let m = this.others.get(key)
				if (!m) {
					m = this.createMore(s.id)
					this.host.appendChild(m)
					this.others.set(key, m)
				}
				const { hidden } = s.more
				const [count, more, all] = m.children as unknown as HTMLElement[]
				const label = `${hidden} older ${hidden === 1 ? 'item' : 'items'} hidden`
				if (count.textContent !== label) {
					count.textContent = label
					more.textContent = `Show ${Math.min(hidden, LAYOUT.showMoreStep)} more`
					;(all as HTMLButtonElement).hidden = hidden <= LAYOUT.showMoreStep
				}
				this.placeDesign(m, { x: s.more.box.x + dx, y: s.more.box.y + dy, w: s.more.box.w, h: s.more.box.h }, z)
				m.style.opacity = String(d.opacity)
			}
		}
		for (const [key, el] of this.others) {
			if (seenOther.has(key)) continue
			el.remove()
			this.others.delete(key)
		}
		if (z !== this.rasterZ) this.rerasterSoon(z)
	}

	/**
	 * Heads are design px scaled up onto the page in their own layers (will-change: transform), which
	 * Chrome keeps at the scale it first rastered them at, blurry when zoomed in. Once a zoom settles,
	 * dropping the hint for a frame has them rastered again at the new scale.
	 */
	private rerasterSoon(z: number) {
		clearTimeout(this.rasterTimer)
		this.rasterTimer = window.setTimeout(() => {
			this.rasterZ = z
			this.host.classList.add('reraster')
			requestAnimationFrame(() => requestAnimationFrame(() => this.host.classList.remove('reraster')))
		}, 200)
	}

	/** A page box as design px, scaled with the zoom like the items. */
	private placeDesign(el: HTMLElement, box: Box, z: number) {
		const S = z * SHEET.k
		const p = this.editor.pageToScreen(box)
		el.style.width = `${box.w / SHEET.k}px`
		el.style.height = `${box.h / SHEET.k}px`
		el.style.transform = `translate(${p.x}px, ${p.y}px) scale(${S})`
		el.style.setProperty('--hair', `${1 / S}px`)
	}

	// ---------- a frame's head ----------

	private createHead(id: string): Head {
		const el = document.createElement('div')
		el.className = 'sheet-head sheet-frame-head'
		el.dataset.session = id
		el.innerHTML = '<div class="sh-row"><span class="title"></span><span class="sh-state"></span><span class="frame-buttons sh-act"></span></div>'
		const row = el.children[0] as HTMLElement
		const buttons = row.children[2] as HTMLElement
		buttons.append(...this.promptButtons(id))
		if (this.onHide) {
			const onHide = this.onHide
			buttons.appendChild(button('sh-ico hide-frame', EYE_ICON, 'Hide this frame (for everyone; show it again from Sessions, top right)', () => onHide(id)))
		}
		// (its subagents' documents, by delegation)
		el.addEventListener('pointerdown', (e) => {
			if ((e.target as Element).closest('[data-kid]')) e.stopPropagation()
		})
		el.addEventListener('dblclick', (e) => {
			if ((e.target as Element).closest('[data-kid]')) e.stopPropagation()
		})
		el.addEventListener('click', (e) => {
			const doc = (e.target as Element).closest<HTMLElement>('[data-kid]')
			if (!doc) return
			e.stopPropagation()
			this.editor.toggleDrawer(doc.dataset.kid!, e.shiftKey)
		})
		return { el, row, title: row.children[0] as HTMLElement, block: row.children[1] as HTMLElement, tray: null, printout: null, notch: null, keys: {}, line: '', drawer: false }
	}

	/** The prompt keycap and button: open (or close) the session's prompt under them. */
	private promptButtons(id: string) {
		const open = (from: HTMLElement) => {
			const r = from.getBoundingClientRect()
			const origin = this.host.parentElement!.getBoundingClientRect()
			this.editor.frameChrome?.prompt(id, { x: r.left - origin.left, top: r.top - origin.top, bottom: r.bottom - origin.top })
		}
		const key: HTMLButtonElement = button('sh-key prompt-key', 'C', 'Prompt this session (C)', () => open(key))
		const prompt: HTMLButtonElement = button('sh-ico prompt-frame', PROMPT_ICON, 'Prompt this session (C)', () => open(prompt))
		key.hidden = prompt.hidden = true
		return [key, prompt]
	}

	private showButtons(el: HTMLElement, status: FrameStatus | null) {
		const can = !!status?.canPrompt
		for (const b of el.querySelectorAll<HTMLButtonElement>('.prompt-key, .prompt-frame')) {
			b.hidden = !can
			if (!can) continue
			b.title = status!.prompting ? 'Close its prompt (Esc)' : 'Prompt this session (C)'
			b.classList.toggle('active', status!.prompting)
		}
	}

	/**
	 * The title row's state cell: running (blue, with its clock) or asking (red); failed, quietly.
	 * Nothing while it's idle or done.
	 */
	private fillState(head: Head, id: string, session: Session | undefined, status: FrameStatus | null, working: boolean, since: number) {
		const state = status?.ended ? 'ended' : status?.asking ? 'ask' : working ? 'run' : session?.opencode?.failed ? 'failed' : 'idle'
		const key = JSON.stringify([state, state === 'run' ? since : 0])
		if (head.keys.state === key) return
		head.keys.state = key
		const cell = head.block
		cell.className = `sh-state st-${state}`
		this.clocks.delete(id)
		if (state === 'run') {
			const text = clock(Date.now() - since)
			cell.innerHTML = '<span class="w">Running</span><span class="clk"></span>'
			const el = cell.lastElementChild as HTMLElement
			el.textContent = text
			this.clocks.set(id, { el, since, text })
		} else {
			cell.textContent = state === 'ask' ? 'Asking' : state === 'failed' ? 'Failed' : ''
		}
	}

	/** Its subagents as documents: click one to unfold its sheet. */
	private fillTray(head: Head, id: string, kids: readonly string[], sessions: Record<string, Session>) {
		if (!kids.length) {
			head.tray?.remove()
			head.tray = null
			head.notch?.remove()
			head.notch = null
			return
		}
		if (!head.tray) {
			head.tray = document.createElement('div')
			head.tray.className = 'sh-tray'
			head.el.insertBefore(head.tray, head.notch)
		}
		const chrome = this.editor.frameChrome
		const docs = kids.map((k) => ({ id: k, title: kidTitle(sessions[k]?.title || 'Subagent'), state: (chrome?.subagent?.(k) ?? 'done') as KidState, open: this.editor.drawers.isOpen(k) }))
		const key = JSON.stringify(docs)
		if (head.keys.tray !== key) {
			head.keys.tray = key
			head.tray.innerHTML =
				`<div class="k">Subagents <span class="n">${kids.length}</span></div>` +
				`<div class="docs">${docs.map((d) => docIcon(d.id, d.title, d.state, d.open)).join('')}</div>`
		}
		// the notch: where the open drawer unfolds from (the first open one)
		const open = docs.find((d) => d.open)
		if (!open) {
			head.notch?.remove()
			head.notch = null
			return
		}
		if (!head.notch) {
			head.notch = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
			head.notch.classList.add('sh-notch')
			head.notch.setAttribute('width', '40')
			head.notch.setAttribute('height', '8')
			head.notch.innerHTML = `<path d="M0 .5H14L20 7 26 .5H40" fill="${DRAWER_FILL}" stroke="${INK}"/>`
			head.el.appendChild(head.notch)
		}
		const doc = head.tray.querySelector<HTMLElement>(`[data-kid="${CSS.escape(open.id)}"]`)
		if (doc) head.notch.style.left = `${doc.offsetLeft + doc.offsetWidth / 2 - 20}px`
	}

	/** What it's doing now, one line at a time, fed like a chain printer (a new line in 120 ms, two steps). */
	private fillPrintout(head: Head, id: string, act: SessionActivity | undefined, working: boolean, since: number) {
		if (!working) {
			head.printout?.remove()
			head.printout = null
			head.line = ''
			return
		}
		if (!head.printout) {
			head.printout = document.createElement('div')
			head.printout.className = 'sh-printout'
			head.printout.innerHTML = '<div class="roll"></div>'
			head.row.after(head.printout)
		}
		const step = act?.step ?? 'Working'
		const at = clock(Math.max(0, (act?.stepAt ?? since) - since))
		const line = `${at}|${step}`
		if (head.line === line) return
		const prev = head.line
		head.line = line
		const roll = head.printout.firstElementChild as HTMLElement
		const ln = (l: string, old: boolean) => {
			const [t, ...rest] = l.split('|')
			return `<div class="ln${old ? ' old' : ''}"><span class="t">${esc(t)}</span><span>${old ? '' : '▸ '}${esc(rest.join('|'))}</span></div>`
		}
		roll.innerHTML = (prev ? ln(prev, true) : '<div class="ln old"></div>') + ln(line, false)
		if (!prev) return
		roll.classList.remove('feed')
		void roll.offsetWidth
		roll.classList.add('feed')
	}

	// ---------- a subagent's head, in its drawer ----------

	private createDrawerHead(id: string): Head {
		const el = document.createElement('div')
		el.className = 'sheet-head sheet-drawer-head'
		el.dataset.session = id
		el.innerHTML = '<div class="sh-row"><span class="sw"></span><span class="title"></span><span class="sh-meta"></span><span class="frame-buttons sh-act"></span></div>'
		const row = el.children[0] as HTMLElement
		const buttons = row.children[3] as HTMLElement
		buttons.append(...this.promptButtons(id))
		buttons.appendChild(button('sh-ico close-drawer', CLOSE_ICON, 'Close (Esc)', () => this.onCloseDrawer(id)))
		return { el, row, title: row.children[1] as HTMLElement, block: row.children[2] as HTMLElement, tray: null, printout: null, notch: null, keys: {}, line: '', drawer: true }
	}

	private fillDrawerHead(head: Head, id: string, session: Session | undefined, act: SessionActivity | undefined, n: number, working: boolean) {
		const state = (this.editor.frameChrome?.subagent?.(id) ?? (working ? 'running' : 'done')) as KidState
		const created = session?.opencode?.createdAt
		const updated = session?.opencode?.updatedAt
		const min = created && updated && updated > created ? Math.max(1, Math.round((updated - created) / 60_000)) : 0
		const word = { running: 'Running', waiting: 'Asking', failed: 'Failed', done: 'Done' }[state]
		const meta = [`${n} ${n === 1 ? 'item' : 'items'}`, ...(min ? [`${min} min`] : []), ...(act?.model ? [act.model] : [])].join(' · ')
		const key = JSON.stringify([state, meta, sessionColor(id)])
		if (head.keys.meta === key) return
		head.keys.meta = key
		;(head.row.children[0] as HTMLElement).style.background = sessionColor(id)
		head.block.innerHTML = `<span class="k st-${state}">${word}</span><span class="m">${esc(meta)}</span>`
	}

	/** The row under a frame's groups: how many older items it leaves out, and buttons to show them. */
	private createMore(id: string) {
		const el = document.createElement('div')
		el.className = 'sheet-more'
		el.innerHTML = '<span class="count"></span><button class="show-more"></button><button class="show-all">Show all</button>'
		const [, more, all] = el.children as unknown as [HTMLElement, HTMLButtonElement, HTMLButtonElement]
		for (const [b, count] of [[more, LAYOUT.showMoreStep], [all, Infinity]] as const) {
			b.addEventListener('pointerdown', (e) => e.stopPropagation())
			b.addEventListener('dblclick', (e) => e.stopPropagation())
			b.addEventListener('click', (e) => {
				e.stopPropagation()
				this.onShowMore(id, count)
			})
		}
		return el
	}
}

function button(cls: string, html: string, title: string, onClick: () => void) {
	const b = document.createElement('button')
	b.className = cls
	b.innerHTML = html
	b.title = title
	b.addEventListener('pointerdown', (e) => e.stopPropagation())
	b.addEventListener('dblclick', (e) => e.stopPropagation())
	b.addEventListener('click', (e) => {
		e.stopPropagation()
		onClick()
	})
	return b
}

/**
 * A Star-style document icon for a subagent: a page with a folded corner and its title. Inverted:
 * its drawer is open; ✓ done; a line being typed: running; a red corner: waiting on you; ✕ failed.
 */
function docIcon(id: string, title: string, state: KidState, open: boolean) {
	const w = 48
	const h = 52
	const f = 10
	const fg = open ? SHEET_FILL : INK
	const bg = open ? INK : SHEET_FILL
	let mark = ''
	if (state === 'done') mark = `<path d="M5 9.5l2.4 2.4L12 6.6" fill="none" stroke="${fg}" stroke-width="1.5"/>`
	if (state === 'failed') mark = `<path d="M5.5 6l6 6M11.5 6l-6 6" stroke="${RED}" stroke-width="1.6"/>`
	if (state === 'waiting') mark = `<rect x="5" y="5" width="7" height="7" fill="${RED}"/>`
	if (state === 'running')
		mark =
			`<rect x="5" y="6" width="${w - 20}" height="1.6" fill="${fg}"/>` +
			`<rect x="5" y="10" width="${w - 24}" height="1.6" fill="${fg}"><animate attributeName="width" values="2;${(w - 24) / 3};${((w - 24) * 2) / 3};${w - 24};${w - 24}" dur="1.6s" repeatCount="indefinite" calcMode="discrete"/></rect>`
	const fold =
		state === 'waiting'
			? `<path d="M${w - f - 0.5} .5V${f + 0.5}H${w - 0.5}z" fill="${RED}" stroke="${fg}"/>`
			: `<path d="M${w - f - 0.5} .5V${f + 0.5}H${w - 0.5}" fill="none" stroke="${fg}"/>`
	const label = { running: 'running', waiting: 'waiting on you', failed: 'failed', done: 'done' }[state]
	return (
		`<button class="doc${open ? ' open' : ''}" data-kid="${esc(id)}" title="${esc(title)} · ${label}${open ? ' (open: click to fold it away)' : ''}">` +
		`<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><path class="pg" d="M.5 .5H${w - f - 0.5}L${w - 0.5} ${f + 0.5}V${h - 0.5}H.5z" fill="${bg}" stroke="${fg}"/>${fold}${mark}</svg>` +
		`<span class="lbl">${esc(title)}</span></button>`
	)
}
