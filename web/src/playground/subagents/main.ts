import '../../ui/styles.css'
import './frames.css'
import { Box } from '../../editor/geometry'
import { bezier } from '../../render/busy/envelope'
import { describeError, Renderer } from '../../render/Renderer'
import { clamp01, hexToRgb, type KidLook } from '../../render/subagents/field'
import { OrbLayer } from '../../render/subagents/orbs'
import { react } from '../../state/signals'
import { chromeParams, chromeVariations, createChrome, restoreParams, shareParams } from '../shared/chrome'
import { button, el, paramControl, segmentedRow, switchRow } from '../shared/controls'
import { fontReady } from '../shared/font'
import { changed, defaults, resolve, type ParamValues } from '../shared/params'
import { Chrome, HEAD_PX, stateText, type HeadInfo, type RowInfo, type RowKid } from './chrome'
import { buildDemo, type Demo, type DemoFamily } from './data'
import { SubagentEditor } from './editor'
import { COUNTS, EXPAND_PARAMS, IDEA_PARAMS, ROW_PARAMS } from './ideas'
import { plan, type Fit, type Plan, type PlanKid } from './plan'
import { Sim, type Kid, type KidView } from './sim'
import { techOf, TECHNIQUES, type TechId } from './techniques'

interface Settings {
	tech: TechId
	params: Record<string, ParamValues>
	row: ParamValues
	expand: ParamValues
	ideas: ParamValues
	live: boolean
	count: number
}

const shell = createChrome<Settings>({
	site: 'subagents',
	title: 'Subagents',
	storageKey: 'canvas-playground-subagents-v5',
	defaults: () => ({
		tech: TECHNIQUES[0].id,
		params: Object.fromEntries(TECHNIQUES.map((t) => [t.id, defaults(t.params)])),
		row: defaults(ROW_PARAMS),
		expand: defaults(EXPAND_PARAMS),
		ideas: defaults(IDEA_PARAMS),
		live: true,
		count: 8,
	}),
	restore(saved, s) {
		if (typeof saved.v === 'string' && TECHNIQUES.some((t) => t.id === saved.v)) s.tech = saved.v as TechId
		restoreParams(TECHNIQUES, saved.p, s.params)
		if (saved.r) s.row = resolve(ROW_PARAMS, { ...s.row, ...(saved.r as ParamValues) })
		if (saved.x) s.expand = resolve(EXPAND_PARAMS, { ...s.expand, ...(saved.x as ParamValues) })
		if (saved.i) s.ideas = resolve(IDEA_PARAMS, { ...s.ideas, ...(saved.i as ParamValues) })
		if (typeof saved.live === 'boolean') s.live = saved.live
		if (typeof saved.n === 'number' && COUNTS.includes(String(saved.n))) s.count = saved.n
	},
	share: (s) => ({ v: s.tech, p: shareParams(TECHNIQUES, s.params), r: changed(ROW_PARAMS, s.row), x: changed(EXPAND_PARAMS, s.expand), i: changed(IDEA_PARAMS, s.ideas), live: s.live, n: s.count }),
	exportJson: (s) => ({ site: 'subagents', technique: { id: s.tech, name: techOf(s.tech).name, params: s.params[s.tech] }, row: s.row, expand: s.expand, ideas: s.ideas }),
})
const { settings, demo: demoBox } = shell
demoBox.setAttribute('aria-label', 'The canvas: scroll to pan, pinch or ctrl-scroll to zoom; click a subagent’s orb to open its frame under it')

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
const I = () => settings.ideas
const fitOf = () => String(X().fit) as Fit
const reduced = () => !!R().reduced

// ---------- expanding ----------

interface Open {
	from: number
	to: number
	start: number
	/** the subagent this one replaced (its card morphs into this one's) */
	replaced?: string
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

/**
 * A click on a subagent's orb: opens it (closing the other open ones of its parent, so clicking
 * along the row switches between them), or closes it if it's open. Shift keeps the others open.
 */
function toggleKid(id: string, additive = false) {
	const now = performance.now()
	const on = !isOpen(id)
	const closing: string[] = []
	if (on && !additive) {
		const f = familyOf(id)
		for (const k of f ? shownKids(f) : []) if (k.id !== id && isOpen(k.id)) closing.push(k.id)
		for (const k of closing) setOpen(k, false, now)
	}
	setOpen(id, on, now)
	const o = opens.get(id)
	if (o && on) o.replaced = closing.length === 1 ? closing[0] : lastOpened && closing.includes(lastOpened) ? lastOpened : undefined
	if (on) unread.delete(id)
	lastOpened = on ? id : lastOpened
}

let lastOpened: string | null = null

function anyOpen() {
	for (const id of opens.keys()) if (isOpen(id)) return true
	return false
}

/** ←/→ with a subagent open: open the one before or after it instead. */
function stepOpen(dir: number) {
	const id = lastOpened && isOpen(lastOpened) ? lastOpened : [...opens.keys()].find(isOpen)
	const f = id && familyOf(id)
	if (!id || !f) return false
	const order = rowOrder(f).map((k) => k.id)
	const next = order[(order.indexOf(id) + dir + order.length) % order.length]
	if (next && next !== id) toggleKid(next)
	return true
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
	const fit = fitOf()
	let anchors = ''
	const childIds = new Set(demo.families.flatMap((f) => f.kids.map((k) => k.id)))
	let animating = false
	for (const f of demo.families) {
		families.set(
			f.parentId,
			rowOrder(f).map((k) => {
				const open = openAt(k.id, now)
				const to = opens.get(k.id)?.to ?? 0
				if (opens.has(k.id) && open !== to) animating = true
				if (open > 0 && fit !== 'below') anchors += `${k.id}:${(anchor(f.parentId, k.id, now) ?? -1).toFixed(2)},`
				return { id: k.id, open, to, from: opens.get(k.id)?.replaced }
			}),
		)
	}
	const sig = `${z}|${fit}|${anchors}|${[...families.values()].map((ks) => ks.map((k) => (k.open > 0 ? `${k.open.toFixed(4)}${k.to}` : '')).join(',')).join(';')}`
	if (!dirty && !animating && sig === lastSig && current) return
	dirty = false
	lastSig = sig
	current = plan({
		natural: editor.naturalLayout.get(),
		families,
		childIds,
		zoom: z,
		childScale: Number(X().scale),
		m: metrics(),
		fit,
		anchor: (parentId, kidId) => anchor(parentId, kidId, now),
		memo,
		morph: X().switch === 'morph',
	})
	editor.plan.set(current)
}

const memo = new Map<string, { dx: number; dy: number; w: number; h: number }>()
const anchor = (parentId: string, kidId: string, now: number) => ui?.anchor(parentId, kidId, now) ?? null

/** A family's subagents in the order their orbs are drawn (grouped by state, if that's on). */
function rowOrder(f: DemoFamily) {
	const kids = shownKids(f)
	if (!I().group || !sim) return kids
	const rank = { waiting: 0, failed: 1, running: 2, done: 3 } as const
	return kids.map((k, i) => ({ k, i, r: rank[sim!.kids.get(k.id)?.state ?? 'done'] })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.k)
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
		const kids = rowOrder(f).map((k) => sim!.kids.get(k.id)!)
		if (!kids.length) continue
		const parentRgb = hexToRgb(f.color)
		const rows: RowKid[] = kids.map((k) => {
			const l = sim!.look(k, t, openAt(k.demo.id, now), ui!.hover(k.demo.id, now), look(k.demo.id), red)
			const time = (clocks.get(k.demo.id) ?? k.seed * 0.37) + (dt / 1000) * speed * (l.run + 0.35 * l.wait)
			clocks.set(k.demo.id, time)
			const post = posted.get(k.demo.id)
			if (post !== undefined && I().unread && !red) l.flash = Math.max(l.flash, postFlash(now - post))
			return { view: sim!.view(k, t, l), rgb: own ? k.own : parentRgb, time, unread: I().unread ? (unread.get(k.demo.id) ?? 0) : 0, thumb: thumbs.get(k.demo.id) ?? null }
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
		for (const k of f.kids) {
			const v = sim.kids.get(k.id)
			const st = v ? sim.view(v, performance.now() / 1000, look(k.id)) : null
			out.set(k.id, { id: k.id, title: k.title, agent: k.agent, task: k.task, child: true, status: st ? stateText(st) : '', statusKind: st?.state })
		}
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
	ui.draw(current, headInfos(), rows, { tech: tech(), p: P(), max: Number(R().max), titlePx: Number(R().title), reduced: reduced(), preview: !!I().preview }, now, dpr)
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
	// each subagent's latest output, for the hover preview (items are newest first)
	for (const it of data.items) if (!thumbs.has(it.sessionId)) thumbs.set(it.sessionId, it.thumb)
	const c = data.families[0].kids
	unread.set(c[1].id, 2)
	unread.set(c[6].id, 1)
	editor.loadSnapshot(data.sessions, data.items)
	dirty = true
	editor.whenViewportReady(() => requestAnimationFrame(() => fit(false)))
	try {
		renderer = await Renderer.create(canvasEl, overlay, editor, {
			readOnly: true,
			easeLayout: false,
			busySessions: () => busySessions(),
			getRaisedSections: () => raisedSections(),
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
	// a subagent open in a card at the top of its parent shows its state on its orb and in its title instead
	const carded = fitOf() !== 'below'
	for (const f of demo.families) {
		if (f.busy) busySet.add(f.parentId)
		if (!carded) for (const k of sim.familyKids(f)) if (k.state === 'running') busySet.add(k.demo.id)
	}
	return busySet
}

/** The cards, back to front, each over its shadow (the renderer draws them over everything else). */
function raisedSections() {
	return (current?.cards ?? []).map((c) => ({ id: c.id, shadow: c.shadow }))
}

// ---------- new items from subagents (the badge prototype) ----------

/** items a subagent posted since it was last expanded, and when it last posted */
const unread = new Map<string, number>()
const posted = new Map<string, number>()
const thumbs = new Map<string, string>()
const POST_MS = 900
/** a post: the orb brightens briefly (rise 150 ms, fade 750 ms) */
const postFlash = (dt: number) => (dt < 0 ? 0 : dt < 150 ? dt / 150 : Math.max(0, 1 - (dt - 150) / (POST_MS - 150)))

/** Live: every few seconds a working subagent that isn't open posts something. */
let nextPost = 0
function tickPosts(now: number) {
	if (!demo || !sim || !settings.live || !I().unread) return
	if (now < nextPost) return
	nextPost = now + 2600 + ((now * 7) % 1900)
	const working = demo.families.flatMap((f) => sim!.familyKids(f)).filter((k) => k.state === 'running' && !isOpen(k.demo.id))
	if (!working.length) return
	post(working[Math.floor((now / 997) % working.length)].demo.id, now)
}

function post(id: string, now = performance.now()) {
	if (isOpen(id)) return
	unread.set(id, (unread.get(id) ?? 0) + 1)
	posted.set(id, now)
	chromeDirty = true
}

editor.onFrame((now) => tickPosts(now))

// ---------- closing: Esc, clicking outside ----------

/** A click (not a drag) anywhere on the canvas but in an open card closes every card. */
let downAt: { x: number; y: number } | null = null
container.addEventListener('pointerdown', (e) => {
	downAt = e.button === 0 ? { x: e.clientX, y: e.clientY } : null
})
container.addEventListener('pointerup', (e) => {
	const d = downAt
	downAt = null
	if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4 || !anyOpen() || fitOf() === 'below') return
	if ((e.target as HTMLElement).closest('.sa-orb, .sa-agg, .sa-more, .sa-close')) return
	const r = container.getBoundingClientRect()
	const pt = editor.screenToPage({ x: e.clientX - r.left, y: e.clientY - r.top })
	const inCard = (current?.cards ?? []).some((c) => c.open > 0.5 && pt.x >= c.box.x && pt.x <= c.box.x + c.box.w && pt.y >= c.box.y && pt.y <= c.box.y + c.box.h)
	if (!inCard) expandEverything(false)
})

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
		el('p', 'pg-note', 'Every technique: failed is red and still, waiting breathes. Hover an orb for its subagent; click it to open its frame right under it (Fit, below). Zoomed out, the orbs fold into +N, then flow into one.'),
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

const ideasBody = shell.section(
	'Ideas',
	button('Reset', () => {
		settings.ideas = defaults(IDEA_PARAMS)
		renderIdeas()
		dirty = chromeDirty = true
		shell.save()
	}, 'ghost', true),
)
function renderIdeas() {
	ideasBody.replaceChildren(
		...IDEA_PARAMS.map((d) =>
			paramControl(d, settings.ideas, () => {
				dirty = chromeDirty = true
				shell.save()
			}),
		),
		el('p', 'pg-note', 'Prototypes: the hover label shows what the subagent last made; a working subagent that isn’t open gets a count of what it posted since (its orb brightens as it posts); the row orders waiting, failed, running, done.'),
		el('div', 'pg-buttons', button('Post from one', () => postFromOne(), '', true)),
	)
}
renderIdeas()

function postFromOne() {
	const f = demo?.families[0]
	const k = f && shownKids(f).find((x) => !isOpen(x.id))
	if (k) post(k.id)
}

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
	['Click', 'an orb: open its frame under it, or switch to it'],
	['⇧Click', 'open another alongside'],
	['←→', 'with one open: the subagent before or after; on a focused orb: move along the row'],
	['1–8', 'technique'],
	['E', 'expand or collapse every subagent'],
	['Esc', 'or click outside: collapse'],
	['M', 'reduced motion'],
	['⇧1', 'zoom to fit'],
]
shell.section('Keys').append(el('div', 'sa-keys', ...keys.flatMap(([k, v]) => [el('kbd', '', k), el('span', '', v)])))

window.addEventListener('keydown', (e) => {
	if ((e.target as HTMLElement).closest('input, textarea, [role="slider"]') || e.metaKey || e.ctrlKey || e.altKey) return
	if (e.key === 'e' || e.key === 'E') expandEverything(!(demo?.families ?? []).every((f) => shownKids(f).every((k) => isOpen(k.id))))
	else if (e.key === 'Escape') expandEverything(false)
	else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !(e.target as HTMLElement).closest('button') && anyOpen()) {
		if (stepOpen(e.key === 'ArrowLeft' ? -1 : 1)) e.preventDefault()
	}
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
			dirty = chromeDirty = true
		},
		idea(key: string, value: number | string | boolean) {
			settings.ideas[key] = value
			renderIdeas()
			dirty = chromeDirty = true
		},
		toggle: (id: string, additive = false) => toggleKid(id, additive),
		post: (id: string) => post(id),
		cards: () => current?.cards,
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
