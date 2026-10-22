import '../../ui/styles.css'
import './frames.css'
import { Box } from '../../editor/geometry'
import { bezier } from '../../render/busy/ember'
import { describeError, Renderer } from '../../render/Renderer'
import { clamp01, hexToRgb, type KidLook, type RGB } from '../../render/subagents/field'
import { react } from '../../state/signals'
import { chromeParams, chromeVariations, createChrome, restoreParams, shareParams } from '../shared/chrome'
import { button, el, paramControl, segmentedRow, switchRow } from '../shared/controls'
import { fontReady } from '../shared/font'
import { changed, defaults, resolve, type ParamValues } from '../shared/params'
import { Chrome, HEAD_PX, type HeadInfo, type HeadStyle, type ListInfo } from './chrome'
import { buildDemo, type Demo, type DemoFamily } from './data'
import { SubagentEditor } from './editor'
import { COUNTS, EXPAND_PARAMS, HEAD_NOTES, LAYOUT_PARAMS } from './ideas'
import { listWidth, plan, type ExpandPlacement, type ListPlacement, type Metrics, type Motion, type Plan, type PlanFamily } from './plan'
import { MORE, measureSummary, paintSummary, repOf, REPS, type KidView, type ListLayout, type RepId } from './reps'
import { duration, Sim, type Kid } from './sim'

interface Settings {
	rep: RepId
	params: Record<string, ParamValues>
	layout: ParamValues
	expand: ParamValues
	live: boolean
	count: number
}

const shell = createChrome<Settings>({
	site: 'subagents',
	title: 'Subagents',
	storageKey: 'canvas-playground-subagents-v3',
	defaults: () => ({
		rep: REPS[0].id,
		params: Object.fromEntries(REPS.map((r) => [r.id, defaults(r.params)])),
		layout: defaults(LAYOUT_PARAMS),
		expand: defaults(EXPAND_PARAMS),
		live: true,
		count: 14,
	}),
	restore(saved, s) {
		if (typeof saved.v === 'string' && REPS.some((r) => r.id === saved.v)) s.rep = saved.v as RepId
		restoreParams(REPS, saved.p, s.params)
		if (saved.l) s.layout = resolve(LAYOUT_PARAMS, { ...s.layout, ...(saved.l as ParamValues) })
		if (saved.x) s.expand = resolve(EXPAND_PARAMS, { ...s.expand, ...(saved.x as ParamValues) })
		if (typeof saved.live === 'boolean') s.live = saved.live
		if (typeof saved.n === 'number' && COUNTS.includes(String(saved.n))) s.count = saved.n
	},
	share: (s) => ({ v: s.rep, p: shareParams(REPS, s.params), l: changed(LAYOUT_PARAMS, s.layout), x: changed(EXPAND_PARAMS, s.expand), live: s.live, n: s.count }),
	exportJson: (s) => ({ site: 'subagents', representation: { id: s.rep, name: repOf(s.rep).name, params: s.params[s.rep] }, layout: s.layout, expand: s.expand }),
})
const { settings, demo: demoBox } = shell
demoBox.setAttribute('aria-label', 'The canvas: scroll to pan, pinch or ctrl-scroll to zoom; click a subagent to expand its frame')

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

const rep = () => repOf(settings.rep)
const L = () => settings.layout
const X = () => settings.expand

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

function toggleAll(sectionId: string) {
	const f = familyOf(sectionId)
	if (!f) return
	if (f.parentId !== sectionId) return setOpen(sectionId, false, performance.now())
	setAll(f, !shownKids(f).every((k) => isOpen(k.id)))
}

function expandEverything(on: boolean) {
	for (const f of demo?.families ?? []) setAll(f, on)
}

// ---------- per frame: subagents, lists, the plan ----------

interface ListState {
	mode: 'full' | 'summary' | 'dots'
	h: { from: number; to: number; start: number }
	layout: ListLayout | null
}
const listStates = new Map<string, ListState>()
const showAll = new Set<string>()
const looks = new Map<string, KidLook>()
const views = new Map<string, KidView>()
let dirty = true
let lastSig = ''
const LIST_H_MS = 220

function look(id: string): KidLook {
	let l = looks.get(id)
	if (!l) looks.set(id, (l = { run: 0, done: 0, fail: 0, wait: 0, flash: 0, clock: 0, open: 0, hover: 0, breath: 0 }))
	return l
}

function metrics(): Metrics {
	return { head: HEAD_PX[String(L().head) as HeadStyle], headGap: 8, listGap: 22, bandPad: 16 }
}

function listHeight(s: ListState, now: number) {
	const e = clamp01((now - s.h.start) / LIST_H_MS)
	return s.h.from + (s.h.to - s.h.from) * (1 - (1 - e) * (1 - e) * (1 - e))
}

const lists = new Map<string, ListInfo>()
const raised: { id: string; shadow: number }[] = []

function update(now: number) {
	if (!demo || !sim) return
	const t = now / 1000
	sim.live = settings.live
	sim.tick(t)
	const z = editor.camera.peek().z
	const natural = editor.naturalLayout.get()
	const m = metrics()
	const families = new Map<string, PlanFamily>()
	const childIds = new Set(demo.families.flatMap((f) => f.kids.map((k) => k.id)))
	const ownColour = L().color === 'own'
	let animating = false
	views.clear()
	lists.clear()
	for (const f of demo.families) {
		const kids = sim.familyKids(f)
		const parentRgb = hexToRgb(f.color)
		const kv: KidView[] = kids.map((k) => {
			const open = openAt(k.demo.id, now)
			if (opens.has(k.demo.id) && open !== opens.get(k.demo.id)!.to) animating = true
			const v = sim!.view(k, t, ownColour ? k.own : parentRgb, sim!.look(k, t, open, ui?.hover(k.demo.id, now) ?? 0, look(k.demo.id)))
			views.set(k.demo.id, v)
			return v
		})
		const fam: PlanFamily = { parentId: f.parentId, kids: [], listH: 0 }
		families.set(f.parentId, fam)
		if (!kv.length) {
			listStates.delete(f.parentId)
			continue
		}
		// zoomed out, every representation collapses to the same summary (with some slack, so it doesn't flap)
		const w = listWidth(natural, f.parentId, z, String(L().list) as ListPlacement)
		let st = listStates.get(f.parentId)
		const at = Number(L().summaryAt)
		const mode = !st ? (w >= at ? 'full' : 'summary') : st.mode === 'full' ? (w < at * 0.96 ? 'summary' : 'full') : w > at * 1.04 ? 'full' : 'summary'
		const mctx = { pitch: ui?.dots.pitch ?? 5, showAll: showAll.has(f.parentId), text: (s: string, weight: 400 | 500 | 600, size?: number) => ui?.text.width(s, weight, size) ?? s.length * 6.5 }
		const layout = mode === 'full' ? rep().measure(kv, w, settings.params[settings.rep], mctx) : measureSummary(kv, w, mctx, w >= 90)
		const target = w < 14 ? 0 : layout.h
		if (!st) {
			st = { mode, h: { from: target, to: target, start: 0 }, layout }
			listStates.set(f.parentId, st)
		}
		st.mode = mode
		st.layout = layout
		if (Math.abs(st.h.to - target) > 0.01) st.h = { from: listHeight(st, now), to: target, start: now }
		if (now - st.h.start < LIST_H_MS) animating = true
		fam.listH = listHeight(st, now)
		const chipOf = (id: string) => layout.entries.find((e) => e.id === id)?.rect ?? layout.entries.find((e) => e.id === MORE)?.rect ?? null
		fam.kids = kids.map((k) => ({ id: k.demo.id, open: openAt(k.demo.id, now), chip: chipOf(k.demo.id) }))
		lists.set(f.parentId, {
			parentId: f.parentId,
			key: mode === 'full' ? settings.rep : 'summary',
			layout,
			paint: mode === 'full' ? rep().paint : paintSummary,
			kids: new Map(kv.map((v) => [v.id, v])),
			p: settings.params[settings.rep],
			zoomable: mode !== 'full',
		})
	}
	const sig = `${z}|${[...families.values()].map((f) => `${f.listH.toFixed(3)}:${f.kids.map((k) => (k.open > 0 ? `${k.open.toFixed(4)}@${k.chip ? `${k.chip.x},${k.chip.y}` : ''}` : '')).join(',')}`).join(';')}`
	if (!dirty && !animating && sig === lastSig && current) return
	dirty = false
	lastSig = sig
	// growing out of (or back into) its entry, a subagent's frame is an opaque card over the rest, with a soft shadow mid-flight
	raised.length = 0
	if (X().motion === 'grow') {
		for (const f of families.values()) for (const k of f.kids) if (k.open > 0.0005 && k.open < 0.9995) raised.push({ id: k.id, shadow: 0.7 * Math.sin(Math.PI * k.open) })
	}
	current = plan({
		natural,
		families,
		childIds,
		zoom: z,
		list: String(L().list) as ListPlacement,
		expand: String(X().expand) as ExpandPlacement,
		motion: String(X().motion) as Motion,
		childScale: Number(X().scale),
		m,
	})
	editor.plan.set(current)
}

editor.onFrame((now) => update(now))

// ---------- after the renderer: headers, lists and their dots ----------

let lastCam = ''
let lastDraw = 0
let drawnPlan: Plan | null = null

function headInfos(now: number): Map<string, HeadInfo> {
	const out = new Map<string, HeadInfo>()
	if (!demo || !sim) return out
	const t = now / 1000
	for (const f of demo.families) {
		const kids = sim.familyKids(f)
		const running = kids.filter((k) => k.state === 'running').length
		const l = look(f.parentId)
		l.run = f.busy ? 1 : 0
		l.wait = !f.busy && f.asking ? 1 : 0
		l.done = !f.busy && !f.asking ? 1 : 0
		l.fail = l.flash = l.open = l.hover = 0
		l.clock = t
		l.breath = 0.5 - 0.5 * Math.cos((t / 1.8) * 2 * Math.PI)
		const state = f.busy ? 'Running' : f.asking ? 'Asking a question' : 'Idle'
		const activity = f.busy ? 'active now' : `active ${f.asking ? '2m' : '18m'} ago`
		const subs = kids.length ? `${kids.length} subagent${kids.length === 1 ? '' : 's'}${running ? `, ${running} running` : ''}` : 'no subagents'
		out.set(f.parentId, {
			id: f.parentId,
			title: f.title,
			child: false,
			rgb: hexToRgb(f.color),
			color: f.color,
			look: l,
			state,
			meta: `${state} · ${f.agent} · ${subs} · ${activity}`,
			unread: f.unread,
			asking: f.asking,
			kids: kids.length,
			allOpen: kids.length > 0 && kids.every((k) => isOpen(k.demo.id)),
		})
		for (const k of kids) {
			const v = views.get(k.demo.id)
			if (!v) continue
			const state = k.state === 'running' ? `Running · ${v.elapsed}` : k.state === 'done' ? `Done in ${duration(v.ran)}` : k.state === 'failed' ? `Failed after ${duration(v.ran)}` : 'Waiting for an answer'
			out.set(k.demo.id, {
				id: k.demo.id,
				title: k.demo.title,
				agent: k.demo.agent,
				task: k.demo.task,
				child: true,
				// its own frame: its own colour (as its busy band has), whatever colour its dots have in the list
				rgb: k.own,
				color: rgbHex(k.own),
				look: v.look,
				state,
				meta: `${state} · subagent ${k.index} of “${f.title}”`,
				unread: 0,
				asking: k.state === 'waiting',
				kids: 0,
				allOpen: false,
			})
		}
	}
	return out
}

function drawChrome(now: number) {
	if (!ui || !current) return
	const cam = editor.camera.peek()
	const { w, h } = editor.viewport.peek()
	const dpr = canvasEl.width / Math.max(1, w)
	const camKey = `${cam.x},${cam.y},${cam.z},${w},${h}`
	const resized = ui.dots.setup(w, h, dpr, 5, 2)
	const due = now - lastDraw >= 1000 / 30
	if (!resized && camKey === lastCam && drawnPlan === current && !ui.animating && !due) return
	lastCam = camKey
	lastDraw = now
	drawnPlan = current
	ui.headStyle = String(L().head) as HeadStyle
	ui.titlePx = Number(L().title)
	ui.draw(current, headInfos(now), lists, now, dpr)
	for (const el of overlay.querySelectorAll<HTMLElement>('.sa-head')) el.classList.toggle('hot', el.dataset.session === editor.hoveredFrameId.peek())
	shell.setZoom(cam.z)
}

function rgbHex(c: RGB) {
	return `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`
}

// ---------- boot ----------

async function boot() {
	const data = await buildDemo()
	demo = data
	const coordinator = data.families[0]
	coordinator.count = settings.count
	sim = new Sim(data.families, performance.now() / 1000)
	editor.loadSnapshot(data.sessions, data.items)
	dirty = true
	editor.whenViewportReady(() => requestAnimationFrame(() => fit(false)))
	try {
		renderer = await Renderer.create(canvasEl, overlay, editor, {
			readOnly: true,
			easeLayout: false,
			busySessions: () => busySessions(),
			getRaisedSections: () => raised,
		})
		;(window as unknown as { renderer: unknown }).renderer = renderer
	} catch (e) {
		console.error(e)
		loading.textContent = `Can't start the renderer: ${describeError(e)}`
		return
	}
	loading.remove()
	ui = new Chrome(overlay, editor, {
		toggleKid,
		toggleAll,
		showAll: (id) => {
			if (showAll.has(id)) showAll.delete(id)
			else showAll.add(id)
			dirty = true
		},
		zoomTo: (id) =>
			settle(
				() => {
					const s = editor.layout.get().sections.find((x) => x.id === id)
					const list = current?.lists.get(id)
					return s ? Box.union([s.box, s.header, ...(list ? [list.box] : [])]) : null
				},
				64,
				true,
			),
		prompt: (id) => say(`Prompting “${titleOf(id)}” opens its prompt in the app (not in this demo)`),
		attend: (id) => {
			const f = demo?.families.find((x) => x.parentId === id)
			say(f?.asking ? `“${titleOf(id)}” is asking a question (the app shows it here)` : `Plays the ${f?.unread ?? 0} steps “${titleOf(id)}” queued (in the app)`)
			if (f && !f.asking) f.unread = 0
		},
	})
	void fontReady.then(() => {
		ui?.text.reset()
		dirty = true
	})
	editor.onFrame((now) => drawChrome(now))
}

const busySet = new Set<string>()
function busySessions() {
	busySet.clear()
	if (!demo || !sim) return busySet
	for (const f of demo.families) {
		if (f.busy && L().busy) busySet.add(f.parentId)
		for (const k of sim.familyKids(f)) if (k.state === 'running' && L().busy) busySet.add(k.demo.id)
	}
	return busySet
}

function titleOf(id: string) {
	return editor.sessions.peek()[id]?.title ?? id
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
 * Points the camera at a box that depends on the zoom (headers and lists are a constant size on
 * screen, so their page size changes with it): fits, re-plans at the new zoom, and again until it
 * holds, then glides there from where it was (or jumps).
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

const refreshCaption = () => shell.setCaption(rep().name, rep().note)

chromeVariations(shell, REPS, settings.rep, (id) => {
	settings.rep = id as RepId
	params.render()
	refreshCaption()
	dirty = true
	shell.save()
})

const params = chromeParams(
	shell,
	'Representation',
	() => rep().params,
	() => settings.params[settings.rep],
	() => {
		dirty = true
		shell.save()
	},
	() => (settings.params[settings.rep] = defaults(rep().params)),
)

const layoutBody = shell.section(
	'Frame & header',
	button('Reset', () => {
		settings.layout = defaults(LAYOUT_PARAMS)
		renderLayout()
		dirty = true
		shell.save()
	}, 'ghost', true),
)
const headNote = el('p', 'pg-note')
function renderLayout() {
	headNote.textContent = HEAD_NOTES[String(L().head)] ?? ''
	layoutBody.replaceChildren(
		...LAYOUT_PARAMS.map((d) =>
			paramControl(d, settings.layout, () => {
				headNote.textContent = HEAD_NOTES[String(L().head)] ?? ''
				dirty = true
				shell.save()
			}),
		),
		headNote,
	)
}
renderLayout()

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
	dirty = true
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
	['Click', 'a subagent: expand or collapse its frame'],
	['1–8', 'representation'],
	['E', 'expand or collapse every subagent'],
	['Esc', 'collapse everything'],
	['H', 'next header style'],
	['L', 'subagents in the gap or inside'],
	['P', 'next expand placement'],
	['⇧1', 'zoom to fit'],
]
shell.section('Keys').append(el('div', 'sa-keys', ...keys.flatMap(([k, v]) => [el('kbd', '', k), el('span', '', v)])))

function cycle(values: ParamValues, key: string, options: string[]) {
	values[key] = options[(options.indexOf(String(values[key])) + 1) % options.length]
	dirty = true
	shell.save()
}

window.addEventListener('keydown', (e) => {
	if ((e.target as HTMLElement).closest('input, textarea, [role="slider"]') || e.metaKey || e.ctrlKey || e.altKey) return
	if (e.key === 'e' || e.key === 'E') expandEverything(!(demo?.families ?? []).every((f) => shownKids(f).every((k) => isOpen(k.id))))
	else if (e.key === 'Escape') expandEverything(false)
	else if (e.key === 'h' || e.key === 'H') (cycle(settings.layout, 'head', ['line', 'meta', 'dot']), renderLayout())
	else if (e.key === 'l' || e.key === 'L') (cycle(settings.layout, 'list', ['gap', 'inside']), renderLayout())
	else if (e.key === 'p' || e.key === 'P') (cycle(settings.expand, 'expand', ['below', 'right', 'inline']), renderExpand())
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
		select: (id: string) => document.querySelector<HTMLElement>(`[role="option"][data-id="${id}"]`)?.click(),
		param(key: string, value: number | string | boolean) {
			settings.params[settings.rep][key] = value
			params.render()
			dirty = true
		},
		layout(key: string, value: number | string | boolean) {
			settings.layout[key] = value
			renderLayout()
			dirty = true
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
		showAll: (id: string, on = true) => {
			if (on) showAll.add(id)
			else showAll.delete(id)
			dirty = true
		},
		/** the subagents a list draws (not folded under +N), in order */
		visible: (parentId: string) => (listStates.get(parentId)?.layout?.entries ?? []).filter((e) => views.has(e.id)).map((e) => e.id),
		kids: (parentId: string) => familyOf(parentId)?.kids.map((k) => ({ id: k.id, title: k.title, state: sim?.kids.get(k.id)?.state })),
		families: () => demo?.families.map((f) => ({ id: f.parentId, title: f.title, kids: shownKids(f).length })),
		/** where a subagent's entry is on screen (page coordinates of the browser), for real clicks */
		entryPoint(id: string) {
			const c = ui?.entryCentre(id)
			if (!c) return null
			const r = container.getBoundingClientRect()
			return { x: r.left + c.x, y: r.top + c.y }
		},
		/** frames a session (its header and list included) and, optionally, room for what expands */
		look(id: string, padding = 48, extraRight = 0, extraBottom = 0, extraTop = 0) {
			settle(
				() => {
					const s = editor.layout.get().sections.find((x) => x.id === id)
					const list = current?.lists.get(id)
					const b = s && Box.union([s.box, s.header, ...(list ? [list.box] : [])])
					return b ? { x: b.x, y: b.y - extraTop, w: b.w + extraRight, h: b.h + extraBottom + extraTop } : null
				},
				padding,
				false,
			)
		},
		/**
		 * Where everything is on screen this frame, three ways: the plan, the renderer's drawn frames and
		 * the DOM headers. They must agree (a header a frame behind its frame would be a one-frame jump).
		 */
		trace() {
			const cam = editor.camera.peek()
			const sx = (x: number) => (x + cam.x) * cam.z
			const sy = (y: number) => (y + cam.y) * cam.z
			const r = (b: Box) => [sx(b.x), sy(b.y), b.w * cam.z, b.h * cam.z].map((v) => Math.round(v * 100) / 100)
			const plan = drawnPlan
			const box = container.getBoundingClientRect()
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
							return [e.dataset.session!, [Math.round((b.left - box.left) * 100) / 100, Math.round((b.top - box.top) * 100) / 100]]
						}),
				),
			}
		},
		/** a session's header and list (and, with `frame`, that much of its frame) in browser px, for cropping stills */
		region(id: string, frame = 0, pad = 16) {
			const cam = editor.camera.peek()
			const p = current
			const head = p?.heads.find((h) => h.id === id)
			if (!p || !head) return null
			const list = p.lists.get(id)
			const top = head.box.y
			const bottom = Math.max(head.box.y + head.box.h, list ? list.box.y + list.box.h : 0, head.frame.y + Math.min(head.frame.h, frame / cam.z))
			const b = container.getBoundingClientRect()
			return {
				x: Math.round(b.left + (head.frame.x + cam.x) * cam.z - pad),
				y: Math.round(b.top + (top + cam.y) * cam.z - pad),
				width: Math.round(head.frame.w * cam.z + pad * 2),
				height: Math.round((bottom - top) * cam.z + pad * 2),
			}
		},
		camera: () => editor.camera.peek(),
		setCamera: (x: number, y: number, z: number) => editor.setCamera({ x, y, z }),
		fit: () => fit(false),
		plan: () => current,
	},
})
