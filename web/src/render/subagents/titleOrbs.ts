import { sessionColor } from '../../../../shared/sessionColor'
import type { Editor } from '../../editor/Editor'
import { defaults } from '../params'
import { THEME } from '../../theme'
import { duration, hexToRgb, trackLook, type KidLook, type KidState, type KidTrack, type KidView } from './field'
import { OrbLayer } from './orbs'
import { OrbRows, ROW_PX, RowAggregate, looksMoving, type RowInfo, type RowKid, type RowSettings } from './row'
import { GLASS_TECHNIQUE } from './technique'
import './titleOrbs.css'

/*
 * The app's subagent orbs: a row of Glass orbs after each frame's title, one per subagent on the
 * canvas (see editor/drawers.ts for which frames are whose), showing what each is doing. A click
 * opens (or closes) its drawer in the frame; shift-click opens it alongside the others. The top
 * drawer hangs from its orb by a short wire to a caret on its band's top edge.
 *
 * The renderer's SectionLabels says where each title is as it places it (title()), and the layer is
 * drawn right after the renderer in the same animation frame (frame()), from the same camera, so
 * titles, orbs and frames always move together.
 */

/** What a subagent is doing, as the app knows it (see App: the room, the canvas server, the paired OpenCode). */
export type SubagentState = KidState

const SETTINGS: RowSettings = {
	tech: GLASS_TECHNIQUE,
	p: defaults(GLASS_TECHNIQUE.params),
	max: 8,
	reduced: false,
	preview: false,
}
const SPEED = 1

/** Where a frame's title is this frame (screen px), as SectionLabels placed it. */
export interface TitleGeometry {
	/** the title's left edge */
	left: number
	/** its line's centre */
	y: number
	/** room for the title and the orbs, from left */
	w: number
	/** the title's full width */
	titleW: number
	/** between the title and the first orb */
	gap: number
	opacity: number
}

interface Kid {
	track: KidTrack
	look: KidLook
	clock: number
	seed: number
	/** when its current or last run started and ended (ms), as seen from here */
	startedAt: number | null
	endedAt: number | null
}

export class TitleOrbs {
	private layer: OrbLayer
	private rows: OrbRows
	private host: HTMLDivElement
	private wires: SVGSVGElement
	private wire: SVGPathElement
	private carets: HTMLDivElement[] = []
	/** titles with subagents, as placed since the last frame() (or before, when nothing moved since) */
	private placed = new Map<string, TitleGeometry>()
	private placing = new Map<string, TitleGeometry>()
	private holders = new Map<string, HTMLDivElement>()
	private kids = new Map<string, Kid>()
	private aggs = new Map<string, RowAggregate>()
	private infos = new Map<string, RowInfo>()
	private infosAt = -1
	private lastNow = 0
	private dirty = true
	private reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
	private styles = new WeakMap<HTMLElement, string>()

	constructor(
		overlay: HTMLElement,
		private editor: Editor,
	) {
		// the shader layer: over the WebGPU canvas, under the DOM (frame titles, HTML items)
		this.layer = new OrbLayer(overlay, overlay.firstChild)
		this.host = document.createElement('div')
		this.host.className = 'title-orbs'
		overlay.appendChild(this.host)
		this.wires = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
		this.wires.classList.add('drawer-wire')
		this.wire = document.createElementNS('http://www.w3.org/2000/svg', 'path')
		this.wires.appendChild(this.wire)
		this.host.style.setProperty('--band-fill', `rgba(255, 255, 255, ${whiteOver(THEME.canvas, THEME.frame).toFixed(4)})`)
		this.host.append(this.wires)
		this.rows = new OrbRows(this.host, this.layer, {
			toggleKid: (id, additive) => editor.toggleDrawer(id, additive),
			showAll: () => (this.dirty = true),
			zoomTo: (parentId) => editor.zoomToSection(parentId),
		})
	}

	/**
	 * A frame's title row (SectionLabels, as it places its title): lays out its subagents' orbs in the
	 * room there is. Returns how much of the title to show (screen px), or null when it has none.
	 */
	title(sessionId: string, g: TitleGeometry, now: number): number | null {
		const info = this.info(sessionId, now, 0, false)
		if (!info) return null
		this.placing.set(sessionId, g)
		this.rows.element(sessionId, this.holder(sessionId))
		return this.rows.layout(sessionId, info, { ...this.settings(), gap: g.gap }, g.titleW, g.w, now)
	}

	/** SectionLabels placed every title: those it didn't place this time are gone (off the canvas, or out of subagents). */
	placedAll() {
		this.placed = this.placing
		this.placing = new Map()
		this.dirty = true
	}

	/** Draws the orbs (every animation frame, right after the renderer); dpr: the WebGPU canvas's pixels per CSS px. */
	frame(now: number, canvas: HTMLCanvasElement) {
		const { w: vw, h: vh } = this.editor.viewport.peek()
		const dpr = canvas.width / Math.max(1, vw)
		const dt = this.lastNow ? Math.min(100, Math.max(0, now - this.lastNow)) : 16
		this.lastNow = now
		this.layer.resize(canvas.width, canvas.height, vw, vh)
		const shown: [string, TitleGeometry, RowInfo][] = []
		for (const [id, g] of this.placed) {
			const info = this.info(id, now, dt)
			// (in view: the orbs reach a little past the title line)
			if (info && g.left < vw && g.left + g.w > 0 && g.y > -ROW_PX && g.y < vh + ROW_PX) shown.push([id, g, info])
		}
		const moving = looksMoving(shown.flatMap(([, , i]) => [...i.kids.map((k) => k.view.look), i.agg]))
		const caret = this.caretAt(now)
		if (!this.dirty && !moving && !this.rows.animating && !this.rows.alive && !caret?.moving) return
		this.dirty = false
		const s = this.settings()
		this.rows.begin(now)
		const drawn = new Set<string>()
		for (const [id, g, info] of shown) {
			drawn.add(id)
			const holder = this.holder(id)
			this.css(holder, `transform:translate(${Math.round(g.left * dpr) / dpr}px,${Math.round((g.y - ROW_PX / 2) * dpr) / dpr}px)`)
			this.rows.draw(id, info, s, { px: g.left, y: g.y, w: g.w, opacity: g.opacity, anchorY: ROW_PX / 2, dpr, vw }, now)
		}
		for (const [id, holder] of this.holders) {
			if (drawn.has(id)) continue
			if (this.placed.has(id) || this.placing.has(id)) this.css(holder, 'display:none')
			else {
				this.rows.remove(id)
				holder.remove()
				this.holders.delete(id)
			}
		}
		this.drawCaret(caret, dpr)
		const cam = this.editor.camera.peek()
		const grid = [Math.round(cam.x * cam.z * dpr), Math.round(cam.y * cam.z * dpr), Math.max(2, Math.round(5 * dpr)), Math.max(1, Math.floor(2 * dpr + 0.5))] as const
		this.rows.end(s, dpr, grid, now)
	}

	/** Screen point (canvas container px) of a subagent's orb, if it's shown (for tests and tours). */
	orbCentre(id: string) {
		return this.rows.orbCentre(id, this.host)
	}

	destroy() {
		this.rows.destroy()
		this.host.remove()
		this.layer.destroy()
	}

	// ---------- what the orbs show ----------

	private settings(): RowSettings {
		SETTINGS.reduced = this.reduced.matches
		return SETTINGS
	}

	/** A parent's row this frame: its subagents' looks (their clocks moved on by dt), or null without any. */
	private info(parentId: string, now: number, dt: number, cache = true): RowInfo | null {
		if (this.infosAt !== now) {
			this.infos.clear()
			this.infosAt = now
		}
		const cached = cache && this.infos.get(parentId)
		if (cached) return cached
		const ids = this.editor.families.get().kids.get(parentId)
		if (!ids?.length) return null
		const sessions = this.editor.sessions.peek()
		const drawers = this.editor.drawers.frame.peek()
		const t = now / 1000
		const red = this.reduced.matches
		const parentRgb = hexToRgb(sessionColor(parentId))
		const kids: RowKid[] = ids.map((id, i) => {
			const k = this.kid(id, this.editor.frameChrome?.subagent?.(id) ?? 'done', now)
			const look = trackLook(k.track, t, drawers.get(id)?.open ?? 0, this.rows.hover(id, now), k.look, red)
			k.clock += (dt / 1000) * SPEED * (look.run + 0.35 * look.wait)
			const session = sessions[id]
			const title = session?.title.trim() && session.title !== id ? session.title : 'Untitled subagent'
			const view: KidView = {
				id,
				title,
				agent: session?.opencode?.agent ?? '',
				task: title,
				index: i + 1,
				own: hexToRgb(sessionColor(id)),
				seed: k.seed,
				state: k.track.state,
				look,
				elapsed: k.startedAt === null ? '' : duration(((k.endedAt ?? Date.now()) - k.startedAt) / 1000),
			}
			return { view, rgb: parentRgb, time: k.clock, unread: 0, thumb: null }
		})
		let agg = this.aggs.get(parentId)
		if (!agg) this.aggs.set(parentId, (agg = new RowAggregate(parentId)))
		const info: RowInfo = { parentId, kids, rgb: parentRgb, ...agg.update(kids.map((k) => k.view), now, dt, SPEED, red, this.rows.hover(`agg:${parentId}`, now)) }
		if (cache) this.infos.set(parentId, info)
		return info
	}

	/** A subagent's track, moved to its state now (crossfading from the one before). */
	private kid(id: string, state: SubagentState, now: number): Kid {
		let k = this.kids.get(id)
		if (!k) {
			let seed = 0
			for (let i = 0; i < id.length; i++) seed = (seed * 31 + id.charCodeAt(i)) % 997
			k = { track: { state, prev: state, since: now / 1000 - 60 }, look: { run: 0, done: 0, fail: 0, wait: 0, flash: 0, open: 0, hover: 0, breath: 0 }, clock: seed * 0.37, seed: 1 + seed, startedAt: null, endedAt: null }
			this.kids.set(id, k)
		}
		if (k.track.state !== state) {
			const working = (s: SubagentState) => s === 'running' || s === 'waiting'
			if (working(state) && !working(k.track.state)) {
				k.startedAt = Date.now()
				k.endedAt = null
			} else if (!working(state) && working(k.track.state) && k.startedAt !== null) k.endedAt = Date.now()
			k.track = { state, prev: k.track.state, since: now / 1000 }
			this.dirty = true
		}
		return k
	}

	// ---------- elements ----------

	private holder(parentId: string) {
		let h = this.holders.get(parentId)
		if (!h) {
			h = document.createElement('div')
			h.className = 'title-orbs-row'
			h.dataset.session = parentId
			this.host.appendChild(h)
			this.holders.set(parentId, h)
		}
		return h
	}

	/**
	 * The top drawer of each parent hangs from its orb: where the caret goes on its band's top edge
	 * (between two orbs while one band morphs into the other's), and the orb it leaves from.
	 */
	private caretAt(now: number) {
		const drawers = this.editor.drawers.frame.peek()
		if (!drawers.size) return null
		const layout = this.editor.layout.get()
		const cam = this.editor.camera.peek()
		const out: { x: number; orbY: number; top: number; left: number; right: number; alpha: number }[] = []
		let moving = false
		for (const [parentId, g] of this.placed) {
			const bands = layout.sections.filter((s) => s.drawer?.parentId === parentId)
			if (!bands.length) continue
			const top = bands.reduce((a, b) => (b.box.y < a.box.y || (b.box.y === a.box.y && (drawers.get(b.id)?.to ?? 0) > (drawers.get(a.id)?.to ?? 0)) ? b : a))
			const kid = drawers.get(top.id)
			if (!kid) continue
			const at = this.rows.anchor(parentId, top.id, now)
			const from = kid.from !== undefined ? this.rows.anchor(parentId, kid.from, now) : null
			if (at === null) continue
			const x = g.left + (from === null ? at : from + (at - from) * kid.open)
			const alpha = kid.from !== undefined ? 1 : Math.min(1, kid.open / 0.25) * Math.min(1, Math.max(0, (kid.open - 0.1) / 0.4))
			if (kid.open !== kid.to) moving = true
			out.push({ x, orbY: g.y, top: (top.box.y + cam.y) * cam.z, left: (top.box.x + cam.x) * cam.z, right: (top.box.x + top.box.w + cam.x) * cam.z, alpha: alpha * g.opacity })
		}
		return { list: out, moving }
	}

	/** The wire from the top drawer's orb down to its caret (just one: the drawer most recently placed on top). */
	private drawCaret(at: ReturnType<TitleOrbs['caretAt']>, dpr: number) {
		const snap = (v: number) => Math.round(v * dpr) / dpr
		const D = Number(SETTINGS.p.size)
		let d = ''
		const list = (at?.list ?? []).filter((c) => c.alpha >= 0.01)
		list.forEach((c, i) => {
			const cx = snap(Math.max(c.left + 12, Math.min(c.right - 12, c.x)))
			const y0 = snap(c.orbY + D / 2 + 3)
			const y1 = snap(c.top - 7)
			if (y1 - y0 > 2) d += Math.abs(cx - snap(c.x)) < 1 ? `M${cx} ${y0}V${y1}` : `M${snap(c.x)} ${y0}V${Math.round((y0 + y1) / 2)}H${cx}V${y1}`
			let caret = this.carets[i]
			if (!caret) {
				caret = this.carets[i] = document.createElement('div')
				caret.className = 'drawer-caret'
				this.host.insertBefore(caret, this.wires.nextSibling)
			}
			this.css(caret, `transform:translate(${cx - 6}px,${snap(c.top) - 6}px) rotate(45deg);opacity:${c.alpha.toFixed(3)}`)
		})
		for (const caret of this.carets.slice(list.length)) this.css(caret, 'display:none')
		if (this.wire.getAttribute('d') !== d) this.wire.setAttribute('d', d)
		this.wires.style.opacity = list.length ? String(Math.min(...list.map((c) => c.alpha))) : '0'
	}

	private css(e: HTMLElement, css: string) {
		if (this.styles.get(e) === css) return
		this.styles.set(e, css)
		e.style.cssText = css
	}
}

/** How much white over `base` makes `target` (see the renderer's frame fill). */
function whiteOver(base: string, target: string) {
	const b = hexToRgb(base)
	const t = hexToRgb(target)
	return [0, 1, 2].reduce((sum, i) => sum + (t[i] - b[i]) / (255 - b[i]), 0) / 3
}
