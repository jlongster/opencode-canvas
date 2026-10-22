import '../../ui/styles.css'
import './frames.css'
import { Box } from '../../editor/geometry'
import { bezier } from '../../render/busy/ember'
import { describeError, Renderer } from '../../render/Renderer'
import { clamp01, hexToRgb, type KidLook } from '../../render/subagents/field'
import { OrbLayer } from '../../render/subagents/orbs'
import { react } from '../../state/signals'
import { chromeParams, chromeVariations, createChrome, restoreParams, shareParams } from '../shared/chrome'
import { button, el, paramControl, segmentedRow, switchRow } from '../shared/controls'
import { fontReady } from '../shared/font'
import { changed, defaults, resolve, type ParamValues } from '../shared/params'
import { Chrome, HEAD_PX, type HeadInfo, type RowInfo, type RowKid } from './chrome'
import { buildDemo, type Demo, type DemoFamily } from './data'
import { SubagentEditor } from './editor'
import { COUNTS, EXPAND_PARAMS, ROW_PARAMS } from './ideas'
import { plan, type Plan, type PlanKid } from './plan'
import { Sim, type Kid, type KidView } from './sim'
import { techOf, TECHNIQUES, type TechId } from './techniques'

interface Settings {
	tech: TechId
	params: Record<string, ParamValues>
	row: ParamValues
	expand: ParamValues
	live: boolean
	count: number
}

const shell = createChrome<Settings>({
	site: 'subagents',
	title: 'Subagents',
	storageKey: 'canvas-playground-subagents-v4',
	defaults: () => ({
		tech: TECHNIQUES[0].id,
		params: Object.fromEntries(TECHNIQUES.map((t) => [t.id, defaults(t.params)])),
		row: defaults(ROW_PARAMS),
		expand: defaults(EXPAND_PARAMS),
		live: true,
		count: 8,
	}),
	restore(saved, s) {
		if (typeof saved.v === 'string' && TECHNIQUES.some((t) => t.id === saved.v)) s.tech = saved.v as TechId
		restoreParams(TECHNIQUES, saved.p, s.params)
		if (saved.r) s.row = resolve(ROW_PARAMS, { ...s.row, ...(saved.r as ParamValues) })
		if (saved.x) s.expand = resolve(EXPAND_PARAMS, { ...s.expand, ...(saved.x as ParamValues) })
		if (typeof saved.live === 'boolean') s.live = saved.live
		if (typeof saved.n === 'number' && COUNTS.includes(String(saved.n))) s.count = saved.n
	},
	share: (s) => ({ v: s.tech, p: shareParams(TECHNIQUES, s.params), r: changed(ROW_PARAMS, s.row), x: changed(EXPAND_PARAMS, s.expand), live: s.live, n: s.count }),
	exportJson: (s) => ({ site: 'subagents', technique: { id: s.tech, name: techOf(s.tech).name, params: s.params[s.tech] }, row: s.row, expand: s.expand }),
})
const { settings, demo: demoBox } = shell
demoBox.setAttribute('aria-label', 'The canvas: scroll to pan, pinch or ctrl-scroll to zoom; click a subagent’s orb to expand its frame')

// ---------- the real canvas ----------

const container = el('div', 'canvas-container sa-canvas')
const canvasEl = el('canvas', 'canvas')
const overlay = el('div', 'overlay')
const loading = el('div', 'sa-loading', 'Drawing the demo canvas…')
const toast = el('div', 'sa-toast')
container.append(canvasEl, overlay, loading, toast)
demoBox.prepend(container)

const editor = new SubagentEditor()
editor.mount(container)
editor.setCurrentTool('select')
;(window as unknown as { editor: unknown }).editor = editor

let demo: Demo | null = null
let sim: Sim | null = null
let renderer: Renderer | null = null
let ui: Chrome | null = null
let current: Plan | null = null

const tech = () => techOf(settings.tech)
const P = () => settings.params[settings.tech]
const R = () => settings.row
const X = () => settings.expand
const reduced = () => !!R().reduced

// ---------- expanding ----------

interface Open {
	from: number
	to: number
	start: number
}
const opens = new Map<string, Open>()
const EASES: Record<string, (x: number) => number> = {
	standard: bezier(0.4, 0, 0.2, 1),
	decelerate: bezier(0, 0, 0.2, 1),
	'in-out': bezier(0.65, 0, 0.35, 1),
}

function openAt(id: string, now: number) {
	const o = opens.get(id)
	if (!o) return 0
	const dur = Number(X().dur)
	const p = dur <= 0 ? 1 : clamp01((now - o.start) / dur)
	if (p >= 1 && o.to === 0) opens.delete(id)
	return o.from + (o.to - o.from) * (EASES[String(X().ease)] ?? EASES.standard)(p)
}

const isOpen = (id: string) => (opens.get(id)?.to ?? 0) > 0.5

function setOpen(id: string, on: boolean, now: number, delay = 0) {
	if (isOpen(id) === on && opens.has(id) === on) return
	opens.set(id, { from: openAt(id, now), to: on ? 1 : 0, start: now + delay })
	dirty = true
}

function familyOf(id: string) {
	return demo?.families.find((f) => f.parentId === id || f.kids.some((k) => k.id === id))
}

function shownKids(f: DemoFamily) {
	return f.kids.slice(0, f.count)
}

function toggleKid(id: string) {
	setOpen(id, !isOpen(id), performance.now())
}

/** Expand (or collapse) a session's subagents, one after another (the whole stagger capped). */
function setAll(f: DemoFamily, on: boolean) {
	const now = performance.now()
	const kids = shownKids(f)
	const order = on ? kids : [...kids].reverse()
	const step = order.length > 1 ? Math.min(Number(X().stagger), 260 / (order.length - 1)) : 0
	let i = 0
	for (const k of order) if (isOpen(k.id) !== on) setOpen(k.id, on, now, step * i++)
}

function expandEverything(on: boolean) {
	for (const f of demo?.families ?? []) setAll(f, on)
}

// ---------- before the renderer: the plan ----------

let dirty = true
let lastSig = ''

function metrics() {
	return { head: HEAD_PX, headGap: 8 }
}

function update(now: number) {
	if (!demo || !sim) return
	sim.live = settings.live
	sim.tick(now / 1000)
	const z = editor.camera.peek().z
	const families = new Map<string, PlanKid[]>()
	const childIds = new Set(demo.families.flatMap((f) => f.kids.map((k) => k.id)))
	let animating = false
	for (const f of demo.families) {
		families.set(
			f.parentId,
			shownKids(f).map((k) => {
				const open = openAt(k.id, now)
				if (opens.has(k.id) && open !== opens.get(k.id)!.to) animating = true
				return { id: k.id, open }
			}),
		)
	}
	const sig = `${z}|${[...families.values()].map((ks) => ks.map((k) => (k.open > 0 ? k.open.toFixed(4) : '')).join(',')).join(';')}`
	if (!dirty && !animating && sig === lastSig && current) return
	dirty = false
	lastSig = sig
	current = plan({ natural: editor.naturalLayout.get(), families, childIds, zoom: z, childScale: Number(X().scale), m: metrics() })
	editor.plan.set(current)
}

editor.onFrame((now) => update(now))

// ---------- after the renderer: titles and orbs ----------

const looks = new Map<string, KidLook>()
const clocks = new Map<string, number>()
interface Agg {
	look: KidLook
	time: number
	phase: number
}
const aggs = new Map<string, Agg>()

function look(id: string): KidLook {
	let l = looks.get(id)
	if (!l) looks.set(id, (l = { run: 0, done: 0, fail: 0, wait: 0, flash: 0, open: 0, hover: 0, breath: 0 }))
	return l
}

/** Every parent's row: its subagents' looks and clocks (which run while they work, speed-scaled, so changing speed never jumps). */
function rowInfos(now: number, dt: number): Map<string, RowInfo> {
	const out = new Map<string, RowInfo>()
	if (!demo || !sim || !ui) return out
	const t = now / 1000
	const speed = Number(P().speed ?? 1)
	const own = P().color === 'own'
	const red = reduced()
	for (const f of demo.families) {
		const kids = sim.familyKids(f)
		if (!kids.length) continue
		const parentRgb = hexToRgb(f.color)
		const rows: RowKid[] = kids.map((k) => {
			const l = sim!.look(k, t, openAt(k.demo.id, now), ui!.hover(k.demo.id, now), look(k.demo.id), red)
			const time = (clocks.get(k.demo.id) ?? k.seed * 0.37) + (dt / 1000) * speed * (l.run + 0.35 * l.wait)
			clocks.set(k.demo.id, time)
			return { view: sim!.view(k, t, l), rgb: own ? k.own : parentRgb, time }
		})
		out.set(f.parentId, { parentId: f.parentId, kids: rows, rgb: parentRgb, ...aggregate(f.parentId, rows.map((r) => r.view), now, dt, speed, red) })
	}
	return out
}

/** The one orb a row merges into: the most pressing state among its subagents (eased between). */
function aggregate(parentId: string, kids: KidView[], now: number, dt: number, speed: number, red: boolean) {
	let a = aggs.get(parentId)
	if (!a) {
		a = { look: { run: 0, done: 1, fail: 0, wait: 0, flash: 0, open: 0, hover: 0, breath: 0 }, time: parentId.length, phase: (parentId.charCodeAt(9) % 17) / 17 }
		aggs.set(parentId, a)
	}
	const has = (s: KidView['state']) => kids.some((k) => k.state === s)
	const target = has('running') ? 'run' : has('waiting') ? 'wait' : has('failed') ? 'fail' : 'done'
	const k = 1 - Math.exp(-dt / 150)
	const l = a.look
	for (const key of ['run', 'done', 'fail', 'wait'] as const) {
		const to = key === target ? 1 : 0
		l[key] += (to - l[key]) * k
		if (Math.abs(to - l[key]) < 0.002) l[key] = to
	}
	l.flash = Math.max(0, ...kids.map((x) => x.look.flash))
	l.hover = ui?.hover(`agg:${parentId}`, now) ?? 0
	l.breath = red ? 0.6 : 0.5 - 0.5 * Math.cos((now / 1000 / 2.4) * 2 * Math.PI)
	a.time += (dt / 1000) * speed * (l.run + 0.35 * l.wait)
	return { agg: l, aggTime: a.time, aggPhase: a.phase }
}

function headInfos(): Map<string, HeadInfo> {
	const out = new Map<string, HeadInfo>()
	if (!demo || !sim) return out
	for (const f of demo.families) {
		out.set(f.parentId, { id: f.parentId, title: f.title, child: false })
		for (const k of f.kids) out.set(k.id, { id: k.id, title: k.title, agent: k.agent, task: k.task, child: true })
	}
	return out
}

let lastCam = ''
let lastNow = 0
let drawnPlan: Plan | null = null
let chromeDirty = true

function drawChrome(now: number) {
	if (!ui || !current) return
	const dt = lastNow ? Math.min(100, Math.max(0, now - lastNow)) : 16
	lastNow = now
	const cam = editor.camera.peek()
	const { w, h } = editor.viewport.peek()
	const dpr = canvasEl.width / Math.max(1, w)
	ui.orbs.resize(canvasEl.width, canvasEl.height, w, h)
	const rows = rowInfos(now, dt)
	const camKey = `${cam.x},${cam.y},${cam.z},${w},${h},${canvasEl.width}`
	if (!chromeDirty && camKey === lastCam && drawnPlan === current && !ui.animating && !ui.alive && !lookMoving(rows)) return
	chromeDirty = false
	lastCam = camKey
	drawnPlan = current
	ui.draw(current, headInfos(), rows, { tech: tech(), p: P(), max: Number(R().max), titlePx: Number(R().title), reduced: reduced() }, now, dpr)
	shell.setZoom(cam.z)
}

/** Whether any orb is still crossfading between states (or flashing, or easing its hover or open). */
function lookMoving(rows: Map<string, RowInfo>) {
	for (const r of rows.values()) {
		for (const l of [...r.kids.map((k) => k.view.look), r.agg]) {
			if (!settled(l.run) || !settled(l.done) || !settled(l.fail) || !settled(l.wait) || l.flash > 0 || !settled(l.open) || !settled(l.hover)) return true
		}
	}
	return false
}

const settled = (v: number) => v < 0.001 || v > 0.999

// ---------- boot ----------

async function boot() {
	const data = await buildDemo()
	demo = data
	data.families[0].count = settings.count
	sim = new Sim(data.families, performance.now() / 1000)
	editor.loadSnapshot(data.sessions, data.items)
	dirty = true
	editor.whenViewportReady(() => requestAnimationFrame(() => fit(false)))
	try {
		renderer = await Renderer.create(canvasEl, overlay, editor, {
			readOnly: true,
			easeLayout: false,
			busySessions: () => busySessions(),
		})
		;(window as unknown as { renderer: unknown }).renderer = renderer
	} catch (e) {
		console.error(e)
		loading.textContent = `Can't start the renderer: ${describeError(e)}`
		return
	}
	loading.remove()
	let layer: OrbLayer
	try {
		layer = new OrbLayer(overlay)
	} catch (e) {
		loading.textContent = `Can't start WebGL2 for the orbs: ${describeError(e)}`
		container.append(loading)
		return
	}
	ui = new Chrome(overlay, editor, layer, {
		toggleKid,
		showAll: () => (chromeDirty = true),
		zoomTo: (id) =>
			settle(
				() => {
					const s = editor.layout.get().sections.find((x) => x.id === id)
					return s ? Box.union([s.box, s.header]) : null
				},
				64,
				true,
			),
	})
	void fontReady.then(() => {
		ui?.text.reset()
		chromeDirty = true
	})
	editor.onFrame((now) => drawChrome(now))
}

const busySet = new Set<string>()
function busySessions() {
	busySet.clear()
	if (!demo || !sim || !R().busy) return busySet
	for (const f of demo.families) {
		if (f.busy) busySet.add(f.parentId)
		for (const k of sim.familyKids(f)) if (k.state === 'running') busySet.add(k.demo.id)
	}
	return busySet
}

let toastTimer = 0
function say(text: string) {
	toast.textContent = text
	toast.classList.add('on')
	clearTimeout(toastTimer)
	toastTimer = window.setTimeout(() => toast.classList.remove('on'), 2400)
}

function fit(animate = true) {
	settle(() => editor.layout.get().bounds, 48, animate)
}

/**
 * Points the camera at a box that depends on the zoom (titles are a constant size on screen, so
 * their page size changes with it): fits, re-plans at the new zoom, and again until it holds, then
 * glides there from where it was (or jumps).
 */
function settle(target: () => Box | null, padding: number, animate: boolean) {
	const from = editor.camera.peek()
	let cam = from
	for (let i = 0; i < 5; i++) {
		const b = target()
		if (!b) return
		cam = editor.getCameraForBounds(b, { padding })
		editor.setCamera(cam)
		dirty = true
		update(performance.now())
	}
	if (!animate) return
	editor.setCamera(from)
	dirty = true
	update(performance.now())
	editor.setCamera(cam, { animate: true, duration: 480 })
}

react(() => {
	container.style.cursor = editor.cursor.get()
})

// ---------- panel ----------

const refreshCaption = () => shell.setCaption(tech().name, tech().note)

const variations = chromeVariations(shell, TECHNIQUES, settings.tech, (id) => {
	settings.tech = id as TechId
	params.render()
	refreshCaption()
	chromeDirty = true
	shell.save()
})

const params = chromeParams(
	shell,
	'Technique',
	() => tech().params,
	() => P(),
	() => {
		chromeDirty = true
		shell.save()
	},
	() => (settings.params[settings.tech] = defaults(tech().params)),
)

const rowBody = shell.section(
	'Title row',
	button('Reset', () => {
		settings.row = defaults(ROW_PARAMS)
		renderRow()
		dirty = chromeDirty = true
		shell.save()
	}, 'ghost', true),
)
function renderRow() {
	rowBody.replaceChildren(
		...ROW_PARAMS.map((d) =>
			paramControl(d, settings.row, () => {
				dirty = chromeDirty = true
				shell.save()
			}),
		),
		el('p', 'pg-note', 'Every technique: failed is red and still, waiting breathes. Hover an orb for its subagent; click it to expand its frame. Zoomed out, the orbs fold into +N, then flow into one.'),
	)
}
renderRow()

const expandBody = shell.section(
	'Expanding',
	button('Reset', () => {
		settings.expand = defaults(EXPAND_PARAMS)
		renderExpand()
		dirty = true
		shell.save()
	}, 'ghost', true),
)
function renderExpand() {
	expandBody.replaceChildren(
		...EXPAND_PARAMS.map((d) =>
			paramControl(d, settings.expand, () => {
				dirty = true
				shell.save()
			}),
		),
		el('div', 'pg-buttons', button('Expand all', () => expandEverything(true), '', true), button('Collapse all', () => expandEverything(false), '', true)),
	)
}
renderExpand()

shell.section('Demo').append(
	segmentedRow('Coordinator’s', COUNTS, String(settings.count), (v) => setCount(Number(v))),
	switchRow('Live states', settings.live, (on) => {
		settings.live = on
		shell.save()
	}),
	el('div', 'pg-buttons', button('Fit', () => fit(), '', true), button('Next state', () => nextState(), '', true)),
)

function setCount(n: number) {
	settings.count = n
	const f = demo?.families[0]
	if (f) {
		f.count = n
		for (const k of f.kids.slice(n)) opens.delete(k.id)
	}
	dirty = chromeDirty = true
	shell.save()
}

/** Moves the demo on by one event, as the live states would. */
function nextState() {
	if (!sim) return
	const was = sim.live
	sim.live = true
	;(sim as unknown as { next: number }).next = 0
	sim.tick(performance.now() / 1000)
	sim.live = was
}

const keys: [string, string][] = [
	['Hover', 'an orb: its subagent and state'],
	['Click', 'an orb: expand or collapse its frame'],
	['1–8', 'technique'],
	['E', 'expand or collapse every subagent'],
	['Esc', 'collapse everything'],
	['M', 'reduced motion'],
	['⇧1', 'zoom to fit'],
]
shell.section('Keys').append(el('div', 'sa-keys', ...keys.flatMap(([k, v]) => [el('kbd', '', k), el('span', '', v)])))

window.addEventListener('keydown', (e) => {
	if ((e.target as HTMLElement).closest('input, textarea, [role="slider"]') || e.metaKey || e.ctrlKey || e.altKey) return
	if (e.key === 'e' || e.key === 'E') expandEverything(!(demo?.families ?? []).every((f) => shownKids(f).every((k) => isOpen(k.id))))
	else if (e.key === 'Escape') expandEverything(false)
	else if (e.key === 'm' || e.key === 'M') {
		settings.row.reduced = !settings.row.reduced
		renderRow()
		chromeDirty = true
		say(settings.row.reduced ? 'Reduced motion: every orb holds its pose' : 'Motion on')
		shell.save()
	}
})

shell.toolbar.append(button('Fit', () => fit(), '', true))
refreshCaption()
void boot()

// ---------- for scripted captures ----------

Object.assign(window, {
	playground: {
		editor,
		settings,
		get sim() {
			return sim
		},
		get demo() {
			return demo
		},
		ready: () => !!renderer && !!ui && !!current,
		select: (id: string) => variations.select(id),
		param(key: string, value: number | string | boolean) {
			settings.params[settings.tech][key] = value
			params.render()
			chromeDirty = true
		},
		row(key: string, value: number | string | boolean) {
			settings.row[key] = value
			renderRow()
			dirty = chromeDirty = true
		},
		expandParam(key: string, value: number | string | boolean) {
			settings.expand[key] = value
			renderExpand()
			dirty = true
		},
		live(on: boolean) {
			settings.live = on
		},
		state(id: string, s: Kid['state']) {
			sim?.set(id, s, performance.now() / 1000)
		},
		open: (id: string, on = true) => setOpen(id, on, performance.now()),
		expandAll: (parentId: string, on = true) => {
			const f = familyOf(parentId)
			if (f) setAll(f, on)
		},
		expandEverything,
		setCount,
		kids: (parentId: string) => familyOf(parentId)?.kids.slice(0, familyOf(parentId)!.count).map((k) => ({ id: k.id, title: k.title, state: sim?.kids.get(k.id)?.state })),
		families: () => demo?.families.map((f) => ({ id: f.parentId, title: f.title, kids: shownKids(f).length })),
		/** where an orb's hit target is on screen (page coordinates of the browser), for real pointer input; `agg:<parentId>` for the aggregate */
		orbPoint(id: string) {
			const c = ui?.orbCentre(id)
			if (!c) return null
			const r = container.getBoundingClientRect()
			return { x: r.left + c.x, y: r.top + c.y }
		},
		/** frames a session (its title included) and, optionally, room for what expands */
		look(id: string, padding = 48, extraRight = 0, extraBottom = 0, extraTop = 0) {
			settle(
				() => {
					const s = editor.layout.get().sections.find((x) => x.id === id)
					const b = s && Box.union([s.box, s.header])
					return b ? { x: b.x, y: b.y - extraTop, w: b.w + extraRight, h: b.h + extraBottom + extraTop } : null
				},
				padding,
				false,
			)
		},
		/**
		 * Where everything is on screen this frame: the plan, the renderer's drawn frames, the DOM titles,
		 * the orbs the shader drew and their DOM hit targets. They must agree (a title or orb a frame
		 * behind its frame would be a one-frame jump).
		 */
		trace() {
			const cam = editor.camera.peek()
			const sx = (x: number) => (x + cam.x) * cam.z
			const sy = (y: number) => (y + cam.y) * cam.z
			const r = (b: Box) => [sx(b.x), sy(b.y), b.w * cam.z, b.h * cam.z].map((v) => Math.round(v * 100) / 100)
			const plan = drawnPlan
			const box = container.getBoundingClientRect()
			const round = (v: number) => Math.round(v * 100) / 100
			return {
				cam,
				frames: Object.fromEntries((plan?.layout.sections ?? []).map((s) => [s.id, r(s.box)])),
				drawn: Object.fromEntries((plan?.layout.sections ?? []).map((s) => [s.id, renderer?.sectionBox(s.id) ? r(renderer.sectionBox(s.id)!) : null])),
				heads: Object.fromEntries((plan?.heads ?? []).map((h) => [h.id, r(h.box).slice(0, 2)])),
				dom: Object.fromEntries(
					[...overlay.querySelectorAll<HTMLElement>('.sa-head')]
						.filter((e) => e.style.display !== 'none')
						.map((e) => {
							const b = e.getBoundingClientRect()
							return [e.dataset.session!, [round(b.left - box.left), round(b.top - box.top)]]
						}),
				),
				orbs: Object.fromEntries((ui?.drawn ?? []).filter((o) => o.alpha > 0.5).map((o) => [o.id, [round(o.x), round(o.y)]])),
				orbDom: Object.fromEntries(
					[...overlay.querySelectorAll<HTMLElement>('.sa-orb')]
						.filter((e) => e.style.display !== 'none' && e.style.cssText)
						.map((e) => {
							const b = e.getBoundingClientRect()
							return [e.dataset.id!, [round(b.left - box.left + b.width / 2), round(b.top - box.top + b.height / 2)]]
						}),
				),
			}
		},
		/** a session's title row (and, with `frame`, that much of its frame) in browser px, for cropping stills */
		region(id: string, frame = 0, pad = 16, width = 0) {
			const cam = editor.camera.peek()
			const head = current?.heads.find((h) => h.id === id)
			if (!head) return null
			const b = container.getBoundingClientRect()
			const top = (head.box.y + cam.y) * cam.z
			return {
				x: Math.round(b.left + (head.frame.x + cam.x) * cam.z - pad),
				y: Math.round(b.top + top - pad),
				width: Math.round((width || head.frame.w * cam.z) + pad * 2),
				height: Math.round(HEAD_PX + 8 + Math.min(head.frame.h * cam.z, frame) + pad * 2),
			}
		},
		/** zoom z with a session's title at (left, top) on the canvas (CSS px) */
		place(id: string, z: number, left = 40, top = 70) {
			editor.setCamera({ ...editor.camera.peek(), z })
			dirty = true
			update(performance.now())
			const h = current?.heads.find((x) => x.id === id)
			if (!h) return
			editor.setCamera({ x: left / z - h.box.x, y: top / z - h.box.y, z })
			dirty = true
			update(performance.now())
		},
		camera: () => editor.camera.peek(),
		setCamera: (x: number, y: number, z: number) => editor.setCamera({ x, y, z }),
		fit: () => fit(false),
		plan: () => current,
		error: () => ui?.orbs.error ?? null,
	},
})
