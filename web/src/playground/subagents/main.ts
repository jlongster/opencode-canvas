import '../../ui/styles.css'
import './frames.css'
import { Box } from '../../editor/geometry'
import { naturalSizes, TITLE_ROW } from '../../editor/subagentLayout'
import { Connectors, type ConnectorKind, type ConnectorStyle } from '../../render/connectors'
import { describeError, Renderer } from '../../render/Renderer'
import { react } from '../../state/signals'
import { chromeParams, chromeVariations, createChrome, restoreParams, shareParams } from '../shared/chrome'
import { button, el, paramControl, switchRow } from '../shared/controls'
import { changed, defaults, resolve, type ParamValues } from '../shared/params'
import { buildDemo } from './data'
import { SubagentEditor } from './editor'
import { Families, type Frame } from './families'
import { CONNECTOR_PARAMS, IDEAS, ideaOf, type IdeaId } from './ideas'

interface Settings {
	idea: IdeaId
	params: Record<string, ParamValues>
	lines: ParamValues
	busy: boolean
}

const chrome = createChrome<Settings>({
	site: 'subagents',
	title: 'Subagents',
	storageKey: 'canvas-playground-subagent-frames-v1',
	defaults: () => ({
		idea: IDEAS[0].id,
		params: Object.fromEntries(IDEAS.map((i) => [i.id, defaults(i.params)])),
		lines: defaults(CONNECTOR_PARAMS),
		busy: true,
	}),
	restore(saved, s) {
		if (typeof saved.v === 'string' && IDEAS.some((i) => i.id === saved.v)) s.idea = saved.v as IdeaId
		restoreParams(IDEAS, saved.p, s.params)
		if (saved.l) s.lines = resolve(CONNECTOR_PARAMS, { ...s.lines, ...(saved.l as ParamValues) })
		if (typeof saved.b === 'boolean') s.busy = saved.b
	},
	share: (s) => ({ v: s.idea, p: shareParams(IDEAS, s.params), l: changed(CONNECTOR_PARAMS, s.lines), b: s.busy }),
	exportJson: (s) => ({ site: 'subagents', idea: { id: s.idea, name: ideaOf(s.idea).name, params: s.params[s.idea] }, lines: s.lines }),
})
const { settings, demo } = chrome
demo.setAttribute('aria-label', 'The canvas: drag with space or the hand tool to pan, scroll or pinch to zoom; click a stack to spread it')

// ---------- the real canvas ----------

const container = el('div', 'canvas-container sf-canvas')
const canvasEl = el('canvas', 'canvas')
const overlay = el('div', 'overlay')
const controls = el('div', 'sf-controls')
const loading = el('div', 'sf-loading', 'Drawing the demo canvas…')
container.append(canvasEl, overlay, loading)
demo.prepend(container)

const editor = new SubagentEditor()
editor.mount(container)
editor.setCurrentTool('select')
;(window as unknown as { editor: unknown }).editor = editor

const families = new Families([])
let fam = families
let frame: Frame = { families: [], connectors: [], raised: [], children: new Map(), animating: false }
let dirty = true
let renderer: Renderer | null = null
let connectors: Connectors | null = null
let hoverAction = false

const idea = () => ideaOf(settings.idea)
const values = () => settings.params[settings.idea]

/** Each frame, before the renderer draws: where the families are now. */
/** While families move after a param change, the family nearest the middle of the view stays put on screen. */
let anchor: { id: string; x: number; y: number; until: number } | null = null
function anchorView() {
	const cam = editor.camera.peek()
	const { w, h } = editor.viewport.peek()
	const mid = editor.screenToPage({ x: w / 2, y: h / 2 })
	let best: { id: string; d: number } | null = null
	for (const f of fam.states) {
		const b = shownBox(f.demo.parentId)
		if (!b) continue
		const d = Math.hypot(b.x + b.w / 2 - mid.x, b.y + b.h / 2 - mid.y)
		if (!best || d < best.d) best = { id: f.demo.parentId, d }
	}
	const b = best && shownBox(best.id)
	anchor = best && b ? { id: best.id, x: (b.x + cam.x) * cam.z, y: (b.y + cam.y) * cam.z, until: performance.now() + 1500 } : null
}
function holdAnchor() {
	if (!anchor) return
	if (performance.now() > anchor.until) return void (anchor = null)
	const b = shownBox(anchor.id)
	if (!b) return
	const cam = editor.camera.peek()
	const dx = anchor.x - (b.x + cam.x) * cam.z
	const dy = anchor.y - (b.y + cam.y) * cam.z
	if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) editor.setCamera({ x: cam.x + dx / cam.z, y: cam.y + dy / cam.z, z: cam.z })
}

let lastZoom = 0
editor.onFrame(() => {
	holdAnchor()
	const z = editor.camera.peek().z
	if (Math.abs(z - lastZoom) > lastZoom * 1e-4) dirty = true
	if (!dirty && !frame.animating) return
	dirty = false
	lastZoom = z
	fam.zoom = z
	fam.params = values()
	// (the clock the tweens started on, not rAF's timestamp: they can differ)
	frame = fam.frame(performance.now())
	editor.families.set({ list: frame.families, gutter: Number(values().gutter) || 180 })
})

react(() => {
	const c = editor.cursor.get()
	container.style.cursor = hoverAction ? 'pointer' : c
})

/** The box a frame is drawn at right now: the renderer's eased one (it trails the layout while things move). */
function shownBox(id: string): (Box & { opacity?: number }) | undefined {
	return renderer?.sectionBox(id) ?? editor.layout.get().sections.find((s) => s.id === id)?.box
}

function lineStyle(): ConnectorStyle {
	const l = settings.lines
	return {
		kind: (l.kind === 'curved bus' ? 'curvedBus' : l.kind) as ConnectorKind,
		width: l.width as number,
		color: l.color as ConnectorStyle['color'],
		opacity: l.opacity as number,
		dashed: !!l.dashed,
		ends: l.ends as ConnectorStyle['ends'],
		from: l.from as ConnectorStyle['from'],
		to: l.to as ConnectorStyle['to'],
		radius: l.radius as number,
	}
}

async function boot() {
	const data = await buildDemo()
	editor.loadSnapshot(data.sessions, data.items)
	fam = new Families(data.families)
	fam.idea = settings.idea
	fam.params = values()
	fam.sizes = naturalSizes(editor.naturalLayout.get(), data.families.flatMap((f) => f.children.map((c) => c.id)))
	fam.reset(performance.now(), false)
	busySessions = new Map(data.families.flatMap((f) => [...(f.busy ? [[f.parentId, f.color] as const] : []), ...f.children.filter((c) => c.busy).map((c) => [c.id, c.color] as const)]))
	dirty = true
	editor.whenViewportReady(() => requestAnimationFrame(() => fit(false)))
	try {
		renderer = await Renderer.create(canvasEl, overlay, editor, { readOnly: true, getRaisedSections: () => frame.raised })
		;(window as unknown as { renderer: unknown }).renderer = renderer
	} catch (e) {
		console.error(e)
		loading.textContent = `Can't start the renderer: ${describeError(e)}`
		return
	}
	loading.remove()
	connectors = new Connectors(overlay, editor, shownBox)
	overlay.append(controls)
	// After the renderer has drawn: lines, titles, markers and chips follow the frames as drawn.
	editor.onFrame(() => {
		connectors!.families = frame.connectors
		connectors!.style = lineStyle()
		connectors!.draw()
		decorate()
		chrome.setZoom(editor.camera.peek().z)
	})
}

function fit(animate = true) {
	const b = editor.layout.get().bounds
	if (b) editor.setCamera(editor.getCameraForBounds(b, { padding: 56 }), { animate, duration: 480 })
}

// ---------- titles, busy markers, family chips ----------

let busySessions = new Map<string, string>()
const covered = new Set<string>()
const labelCache = new Map<string, HTMLElement>()
const markers = new Map<string, HTMLElement>()
const chips = new Map<string, HTMLButtonElement>()
const styleCache = new WeakMap<HTMLElement, string>()

const setStyle = (e: HTMLElement, css: string) => {
	if (styleCache.get(e) === css) return
	styleCache.set(e, css)
	e.style.cssText = css
}

function label(id: string) {
	let e = labelCache.get(id)
	if (!e || !e.isConnected) {
		e = overlay.querySelector<HTMLElement>(`.section-label[data-session="${id}"]`) ?? undefined
		if (e) labelCache.set(id, e)
	}
	return e
}

function decorate() {
	const cam = editor.camera.peek()
	const screen = (x: number, y: number) => ({ x: (x + cam.x) * cam.z, y: (y + cam.y) * cam.z })
	// Child titles at their frame's scale (never under the app's 13px on screen), hidden while another frame covers them.
	const labelScale = Math.max(cam.z, 13 / 40)
	covered.clear()
	const front = frame.raised.map((r) => ({ id: r.id, box: shownBox(r.id) }))
	for (const [id, c] of frame.children) {
		const b = shownBox(id)
		if (!b) continue
		const row = { x: b.x + 24 * c.s, y: b.y + 30 * c.s, w: Math.max(1, b.w - 48 * c.s), h: 52 * c.s }
		const i = front.findIndex((f) => f.id === id)
		if (front.some((f, j) => j > i && f.box && Box.intersects(f.box, row))) covered.add(id)
	}
	for (const [id, c] of frame.children) {
		const e = label(id)
		if (!e) continue
		e.style.fontSize = `${(Math.max(40 * c.s * cam.z, 13) / labelScale).toFixed(2)}px`
		const shown = covered.has(id) ? 0 : c.reveal
		e.style.visibility = shown < 0.02 ? 'hidden' : ''
		e.style.filter = shown < 0.98 ? `opacity(${shown.toFixed(3)})` : ''
	}
	// Busy: a small static marker at the right end of the title row.
	for (const [id, color] of busySessions) {
		let m = markers.get(id)
		if (!m) {
			m = el('div', 'sf-busy', 'Running')
			m.style.setProperty('--c', color)
			controls.append(m)
			markers.set(id, m)
		}
		const b = shownBox(id)
		const c = frame.children.get(id)
		const s = c?.s ?? 1
		const reveal = covered.has(id) ? 0 : (c?.reveal ?? 1)
		if (!b || !settings.busy || b.w * cam.z < 200 || reveal < 0.02) {
			setStyle(m, 'display:none')
			continue
		}
		const p = screen(b.x + b.w - 40 * s, b.y + TITLE_ROW * s)
		setStyle(m, `--c:${color};transform:translate(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px) translate(-100%,-50%);opacity:${(reveal * (b.opacity ?? 1)).toFixed(3)}`)
	}
	// A chip over each family's children: how many, how many running, and Expand / Stack.
	for (const f of fam.states) {
		const id = f.demo.parentId
		let chip = chips.get(id)
		if (!chip) {
			chip = el('button', 'sf-chip')
			chip.type = 'button'
			chip.addEventListener('pointerdown', (e) => e.stopPropagation())
			chip.addEventListener('dblclick', (e) => e.stopPropagation())
			chip.addEventListener('click', (e) => {
				e.stopPropagation()
				if (!fam.stackable) return
				fam.setExpanded(f, fam.isStacked(f), performance.now())
				dirty = true
			})
			controls.append(chip)
			chips.set(id, chip)
		}
		const P = shownBox(id)
		if (!P) continue
		const n = f.demo.children.length
		const running = f.demo.children.filter((c) => c.busy).length
		const stacked = fam.isStacked(f)
		const action = !fam.stackable ? '' : fam.idea === 'pull' ? (f.pulled.size ? 'Stack all' : 'Pull all out') : stacked ? 'Expand' : 'Stack'
		const key = `${n}|${running}|${action}|${f.demo.color}`
		if (chip.dataset.key !== key) {
			chip.dataset.key = key
			chip.replaceChildren(el('span', 'n', `${n} subagent${n === 1 ? '' : 's'}`))
			chip.style.setProperty('--c', f.demo.color)
			if (running) chip.append(el('span', 'sep', '·'), el('span', 'run', `${running} running`))
			if (action) {
				const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
				icon.setAttribute('viewBox', '0 0 16 16')
				icon.innerHTML = action === 'Expand' || action === 'Pull all out' ? '<path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' : '<path d="M4 10l4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'
				const act = el('span', 'act', action)
				act.append(icon)
				chip.append(el('span', 'sep', '·'), act)
			}
			chip.setAttribute('aria-disabled', String(!action))
		}
		const gutter = (Number(values().gutter) || 180) * cam.z
		const p = screen(P.x + P.w, P.y)
		const region = fam.sizes[f.ids[0]] ? Math.max(...f.ids.map((c) => (fam.sizes[c]?.w ?? 0) * (frame.children.get(c)?.s ?? 1))) : 0
		const visible = region * cam.z > 170
		setStyle(chip, visible ? `--c:${f.demo.color};transform:translate(${(p.x + gutter).toFixed(1)}px,${(p.y - 40).toFixed(1)}px);opacity:${(P.opacity ?? 1).toFixed(3)}` : 'display:none')
	}
}

// ---------- clicking a stack ----------

type Action = { kind: 'expand' | 'front' | 'pull'; family: ReturnType<Families['familyOf']> & object; id: string }

function actionAt(clientX: number, clientY: number): Action | null {
	if (!fam.stackable) return null
	const r = container.getBoundingClientRect()
	const page = editor.screenToPage({ x: clientX - r.left, y: clientY - r.top })
	const t = editor.getTargetAt(page)
	const id = t.type === 'item' ? editor.layout.get().sectionOf.get(t.id) : t.type === 'section' || t.type === 'frame_title' ? t.id : undefined
	const f = id ? fam.familyOf(id) : undefined
	if (!f || !id) return null
	if (fam.idea === 'deck') return fam.isStacked(f) ? { kind: 'expand', family: f, id } : null
	if (fam.idea === 'tabs') return !f.expanded && f.order[0] !== id ? { kind: 'front', family: f, id } : null
	// Pull out: a stacked card anywhere; a pulled one by its title.
	return !f.pulled.has(id) || t.type === 'frame_title' ? { kind: 'pull', family: f, id } : null
}

let press: { action: Action; x: number; y: number } | null = null
let lastAction = 0
container.addEventListener('wheel', () => (anchor = null), { capture: true, passive: true })
container.addEventListener(
	'pointerdown',
	(e) => {
		anchor = null
		if (e.button !== 0 || e.shiftKey || e.metaKey || e.ctrlKey || editor.inputs.isSpaceDown || editor.currentToolId.get() !== 'select') return
		if ((e.target as HTMLElement).closest('.sf-chip')) return
		const action = actionAt(e.clientX, e.clientY)
		if (!action) return
		press = { action, x: e.clientX, y: e.clientY }
		e.stopPropagation()
	},
	true,
)
container.addEventListener(
	'pointerup',
	(e) => {
		if (!press) return
		const { action, x, y } = press
		press = null
		e.stopPropagation()
		if (Math.hypot(e.clientX - x, e.clientY - y) > 5) return
		perform(action)
	},
	true,
)

function perform(action: Action) {
	const now = performance.now()
	if (action.kind === 'expand') fam.setExpanded(action.family, true, now)
	else if (action.kind === 'front') fam.bringToFront(action.family, action.id, now)
	else fam.togglePulled(action.family, action.id, now)
	lastAction = now
	dirty = true
}
container.addEventListener(
	'dblclick',
	(e) => {
		if (performance.now() - lastAction < 500) e.stopPropagation()
	},
	true,
)
container.addEventListener('pointermove', (e) => {
	const on = e.buttons === 0 && !!actionAt(e.clientX, e.clientY)
	if (on === hoverAction) return
	hoverAction = on
	container.style.cursor = on ? 'pointer' : editor.cursor.peek()
})

// ---------- panel ----------

const refreshCaption = () => chrome.setCaption(idea().name, idea().note)

chromeVariations(chrome, IDEAS, settings.idea, (id) => {
	settings.idea = id as IdeaId
	fam.idea = settings.idea
	fam.params = values()
	fam.reset(performance.now(), true)
	dirty = true
	params.render()
	refreshCaption()
	chrome.save()
})

const onParam = () => {
	anchorView()
	fam.params = values()
	fam.retarget(performance.now())
	dirty = true
	chrome.save()
}
const params = chromeParams(
	chrome,
	'Placement',
	() => idea().params,
	values,
	onParam,
	() => (settings.params[settings.idea] = defaults(idea().params)),
)

const linesBody = chrome.section(
	'Lines',
	button('Reset', () => {
		settings.lines = defaults(CONNECTOR_PARAMS)
		renderLines()
		chrome.save()
	}, 'ghost', true),
)
function renderLines() {
	linesBody.replaceChildren(...CONNECTOR_PARAMS.map((d) => paramControl(d, settings.lines, () => chrome.save())))
}
renderLines()

chrome
	.section('Families')
	.append(
		switchRow('Busy markers', settings.busy, (on) => {
			settings.busy = on
			chrome.save()
		}),
		el(
			'div',
			'pg-buttons',
			button('Expand all', () => setAll(true), '', true),
			button('Stack all', () => setAll(false), '', true),
			button('Fit', () => fit(), '', true),
		),
	)

function setAll(on: boolean) {
	if (!fam.stackable) return
	const now = performance.now()
	for (const f of fam.states) fam.setExpanded(f, on, now)
	dirty = true
}

const keys: [string, string][] = [
	['Click', 'a stack: spread it (deck), a title: to the front (tabs) or out (pull)'],
	['E', 'expand or stack every family'],
	['Esc', 'stack everything'],
	['L', 'next line style'],
	['1–4', 'switch idea'],
	['⇧1', 'zoom to fit'],
]
chrome.section('Keys').append(el('div', 'sf-keys', ...keys.flatMap(([k, v]) => [el('kbd', '', k), el('span', '', v)])))

window.addEventListener('keydown', (e) => {
	if ((e.target as HTMLElement).closest('input, textarea, [role="slider"]') || e.metaKey || e.ctrlKey || e.altKey) return
	if (e.key === 'e' || e.key === 'E') setAll(fam.states.some((f) => fam.isStacked(f)))
	else if (e.key === 'Escape') setAll(false)
	else if (e.key === 'l' || e.key === 'L') {
		const kinds = ['elbow', 'bus', 'curve', 'curved bus']
		settings.lines.kind = kinds[(kinds.indexOf(settings.lines.kind as string) + 1) % kinds.length]
		renderLines()
		chrome.save()
	}
})

chrome.toolbar.append(button('Fit', () => fit(), '', true))
refreshCaption()
void boot()

// ---------- for scripted captures ----------

Object.assign(window, {
	playground: {
		editor,
		settings,
		get families() {
			return fam
		},
		select: (id: string) => document.querySelector<HTMLElement>(`[role="option"][data-id="${id}"]`)?.click(),
		ready: () => !!renderer && !!editor.layout.get().bounds,
		expand(parentId: string, on: boolean) {
			const f = fam.state(parentId)
			if (f) fam.setExpanded(f, on, performance.now())
			dirty = true
		},
		front(childId: string) {
			const f = fam.familyOf(childId)
			if (f) fam.bringToFront(f, childId, performance.now())
			dirty = true
		},
		pull(childId: string) {
			const f = fam.familyOf(childId)
			if (f) fam.togglePulled(f, childId, performance.now())
			dirty = true
		},
		setAll,
		param(key: string, value: number) {
			values()[key] = value
			params.render()
			onParam()
		},
		/** a click in the middle of a frame's title row, as a person would (through the same hit test) */
		click(id: string) {
			const b = shownBox(id)
			if (!b) return false
			const r = container.getBoundingClientRect()
			const cam = editor.camera.peek()
			const s = frame.children.get(id)?.s ?? 1
			const action = actionAt(r.left + (b.x + b.w / 2 + cam.x) * cam.z, r.top + (b.y + TITLE_ROW * s + cam.y) * cam.z)
			if (action) perform(action)
			return !!action
		},
		line(key: string, value: string | number | boolean) {
			settings.lines[key] = value
			renderLines()
		},
		/** frames a family (its parent and children, as laid out now; expanded: as it would be spread) */
		look(parentId: string, padding = 64, extraRight = 0, expanded = false, extraBottom = 0) {
			const f = fam.state(parentId)
			const was = f && { expanded: f.expanded, pulled: new Set(f.pulled) }
			if (f && expanded) {
				fam.setExpanded(f, true, performance.now(), false)
				editor.families.set({ list: fam.frame(performance.now()).families, gutter: Number(values().gutter) || 180 })
			}
			const layout = editor.layout.get()
			const ids = [parentId, ...(f?.ids ?? [])]
			const boxes = layout.sections.filter((s) => ids.includes(s.id)).map((s) => s.box)
			if (!boxes.length) return
			const x0 = Math.min(...boxes.map((b) => b.x))
			const y0 = Math.min(...boxes.map((b) => b.y))
			const x1 = Math.max(...boxes.map((b) => b.x + b.w)) + extraRight
			const y1 = Math.max(...boxes.map((b) => b.y + b.h)) + extraBottom
			editor.setCamera(editor.getCameraForBounds({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, { padding }))
			if (f && was && expanded) {
				f.pulled = was.pulled
				if (fam.idea === 'pull') fam.retarget(performance.now(), { families: [f], animate: false })
				else fam.setExpanded(f, was.expanded, performance.now(), false)
				dirty = true
			}
		},
		fit: () => fit(false),
	},
})
