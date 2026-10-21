import { EDGES, type EdgeVariant } from './edges'
import { DemoGL, type Camera, type FrameDraw } from './gl'
import { applyParams, createHeader, HEADERS, resetHeader, type HeaderVariant, type Slots } from './headers'
import { changed, hexToRgb, pack, range, resolve, select, toggle, type ParamDef, type ParamValues } from './params'
import { buildLayout, defaultFrames, SESSION_COLORS, type FrameState } from './scene'
import { LAYOUT, type Layout } from '../editor/layout'
import type { Box } from '../editor/geometry'
import './playground.css'

// ---------- settings ----------

const DONE_PARAMS: ParamDef[] = [
	toggle('enabled', 'Flash when work finishes', true),
	range('duration', 'Duration', 1.5, 0.4, 4, 0.05, 's'),
	range('distance', 'Ring travel', 26, 0, 80, 1, 'px'),
	range('intensity', 'Intensity', 0.85, 0, 1, 0.01),
]

const GLOBAL_PARAMS: ParamDef[] = [
	toggle('reduced', 'Preview reduced motion', matchMedia('(prefers-reduced-motion: reduce)').matches),
	toggle('pageUnits', 'Effect widths in page units (scale with zoom)', false),
	toggle('desync', 'Desynchronise frames', true),
	toggle('simulate', 'Simulate activity (random state changes)', false),
	select('wheel', 'Scroll wheel', ['zoom', 'pan'], 'zoom'),
]

interface Settings {
	edge: string
	header: string
	edgeParams: Record<string, ParamValues>
	headerParams: Record<string, ParamValues>
	done: ParamValues
	global: ParamValues
	frames: FrameState[]
}

const STORAGE_KEY = 'canvas-playground-v1'

function loadSettings(): Settings {
	let saved: Partial<Settings> = {}
	try {
		saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
	} catch {}
	const s: Settings = {
		edge: EDGES.some((e) => e.id === saved.edge) ? saved.edge! : EDGES[1].id,
		header: HEADERS.some((h) => h.id === saved.header) ? saved.header! : HEADERS[0].id,
		edgeParams: Object.fromEntries(EDGES.map((e) => [e.id, resolve(e.params, saved.edgeParams?.[e.id])])),
		headerParams: Object.fromEntries(HEADERS.map((h) => [h.id, resolve(h.params, saved.headerParams?.[h.id])])),
		done: resolve(DONE_PARAMS, saved.done),
		global: resolve(GLOBAL_PARAMS, saved.global),
		frames: defaultFrames(),
	}
	if (Array.isArray(saved.frames)) s.frames = mergeFrames(s.frames, saved.frames)
	try {
		const m = /[#&]s=([^&]+)/.exec(location.hash)
		if (m) {
			const h = JSON.parse(decodeURIComponent(m[1]))
			if (EDGES.some((e) => e.id === h.e)) s.edge = h.e
			if (HEADERS.some((v) => v.id === h.h)) s.header = h.h
			const edge = EDGES.find((e) => e.id === s.edge)!
			const header = HEADERS.find((v) => v.id === s.header)!
			if (h.ep) s.edgeParams[edge.id] = resolve(edge.params, h.ep)
			if (h.hp) s.headerParams[header.id] = resolve(header.params, h.hp)
			if (h.d) s.done = resolve(DONE_PARAMS, h.d)
			if (h.g) s.global = resolve(GLOBAL_PARAMS, { ...s.global, ...h.g })
			if (Array.isArray(h.f))
				s.frames = mergeFrames(
					s.frames,
					h.f.map(([working, subagents, color]: [number, number, string]) => ({ working: !!working, subagents, color })),
				)
		}
	} catch (e) {
		console.warn('ignoring an unreadable settings hash', e)
	}
	return s
}

function mergeFrames(base: FrameState[], saved: Partial<FrameState>[]): FrameState[] {
	return base.map((f, i) => {
		const o = saved[i] ?? {}
		return {
			...f,
			working: typeof o.working === 'boolean' ? o.working : f.working,
			subagents: typeof o.subagents === 'number' ? Math.max(0, Math.min(8, Math.round(o.subagents))) : f.subagents,
			color: typeof o.color === 'string' && /^#[0-9a-f]{6}$/i.test(o.color) ? o.color : f.color,
		}
	})
}

const settings = loadSettings()
const edge = (): EdgeVariant => EDGES.find((e) => e.id === settings.edge)!
const header = (): HeaderVariant => HEADERS.find((h) => h.id === settings.header)!
const edgeValues = () => settings.edgeParams[settings.edge]
const headerValues = () => settings.headerParams[settings.header]

/** What "Copy settings" gives you: the chosen variations with every parameter, ready to bake in. */
function exportSettings() {
	const e = edge()
	const h = header()
	return {
		edge: { id: e.id, name: e.name, params: edgeValues() },
		header: { id: h.id, name: h.name, params: headerValues() },
		done: settings.done,
		pageUnits: settings.global.pageUnits,
		desync: settings.global.desync,
	}
}
;(window as unknown as { playgroundSettings: () => unknown }).playgroundSettings = exportSettings

let saveTimer = 0
function persist() {
	clearTimeout(saveTimer)
	saveTimer = window.setTimeout(() => {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
		const share = {
			e: settings.edge,
			h: settings.header,
			ep: changed(edge().params, edgeValues()),
			hp: changed(header().params, headerValues()),
			d: changed(DONE_PARAMS, settings.done),
			g: changed(GLOBAL_PARAMS, settings.global),
			f: settings.frames.map((f) => [f.working ? 1 : 0, f.subagents, f.color]),
		}
		history.replaceState(null, '', `#s=${encodeURIComponent(JSON.stringify(share))}`)
	}, 150)
}

// ---------- DOM ----------

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...children: (Node | string)[]) {
	const e = document.createElement(tag)
	const { class: cls, ...rest } = props
	if (cls) e.className = cls
	Object.assign(e, rest)
	e.append(...children)
	return e
}

const root = document.getElementById('pg')!
const demo = h('div', { class: 'pg-demo' })
const canvas = h('canvas', { class: 'pg-canvas' })
const overlay = h('div', { class: 'pg-overlay' })
const hud = h('div', { class: 'pg-hud' })
const fpsEl = h('span', { class: 'pg-fps' })
const zoomEl = h('span', { class: 'pg-zoom' })
const fitButton = h('button', { class: 'pg-btn', textContent: 'Fit', title: 'Zoom to fit all frames' })
const oneButton = h('button', { class: 'pg-btn', textContent: '100%', title: 'Zoom to 100% around the centre' })
hud.append(fpsEl, zoomEl, oneButton, fitButton)
demo.append(canvas, overlay, hud, h('div', { class: 'pg-hint', textContent: 'Scroll or pinch to zoom · drag to pan · ←/→ edge · ↑/↓ header' }))

const specimens = h('div', { class: 'pg-specimens' })
const specSlots: { n: number; slots: Slots }[] = []
for (const n of [0, 1, 3, 8]) {
	const slots = createHeader('Canvas build: coordinator')
	const card = h('div', { class: 'pg-spec' }, h('div', { class: 'pg-spec-label', textContent: n === 0 ? 'no subagents' : n === 1 ? '1 subagent' : `${n} subagents` }), h('div', { class: 'pg-spec-frame' }, slots.root))
	specimens.append(card)
	specSlots.push({ n, slots })
}

const main = h('main', { class: 'pg-main' }, demo, h('div', { class: 'pg-spec-title', textContent: 'Header at 0, 1, 3 and 8 subagents (first frame’s colour)' }), specimens)

const side = h('aside', { class: 'pg-side' })
root.append(main, side)

const edgeList = h('div', { class: 'pg-list' })
const edgeParamsEl = h('div', { class: 'pg-params' })
const headerList = h('div', { class: 'pg-list' })
const headerParamsEl = h('div', { class: 'pg-params' })
const doneEl = h('div', { class: 'pg-params' })
const globalEl = h('div', { class: 'pg-params' })
const statesEl = h('div', { class: 'pg-states' })
const copyButton = h('button', { class: 'pg-btn primary', textContent: 'Copy settings' })

function section(title: string, ...children: Node[]) {
	return h('section', { class: 'pg-section' }, h('h2', { textContent: title }), ...children)
}

function resetButton(onClick: () => void) {
	const b = h('button', { class: 'pg-link', textContent: 'Reset' })
	b.addEventListener('click', onClick)
	return b
}

side.append(
	h('header', { class: 'pg-top' }, h('h1', { textContent: 'Frame status playground' }), copyButton),
	section('Working · frame edge', edgeList),
	section('Edge parameters', edgeParamsEl, resetButton(() => {
		settings.edgeParams[settings.edge] = resolve(edge().params, {})
		renderEdgeParams()
		persist()
	})),
	section('Subagents · title', headerList),
	section('Title parameters', headerParamsEl, resetButton(() => {
		settings.headerParams[settings.header] = resolve(header().params, {})
		renderHeaderParams()
		renderHeaders()
		persist()
	})),
	section('Done flash (shared)', doneEl),
	section('Frames', statesEl),
	section('Preview', globalEl),
)

copyButton.addEventListener('click', async () => {
	const text = JSON.stringify(exportSettings(), null, 2)
	try {
		await navigator.clipboard.writeText(text)
	} catch {
		const ta = h('textarea', { value: text })
		document.body.append(ta)
		ta.select()
		document.execCommand('copy')
		ta.remove()
	}
	console.log(text)
	copyButton.textContent = 'Copied'
	setTimeout(() => (copyButton.textContent = 'Copy settings'), 1200)
})

function fmt(d: Extract<ParamDef, { type: 'range' }>, v: number) {
	const decimals = d.step >= 1 ? 0 : d.step >= 0.1 ? 1 : d.step >= 0.01 ? 2 : 3
	return `${v.toFixed(decimals)}${d.unit ? (d.unit.startsWith('×') && d.unit.length > 1 ? ' ' : '') + d.unit : ''}`
}

/** One control for a param: slider, colour, switch or segmented buttons. */
function control(d: ParamDef, values: ParamValues, onChange: () => void): HTMLElement {
	const row = h('label', { class: `pg-row pg-${d.type}` })
	const name = h('span', { class: 'pg-name', textContent: d.label })
	if (d.type === 'range') {
		const out = h('span', { class: 'pg-value', textContent: fmt(d, values[d.key] as number) })
		const input = h('input', { type: 'range', min: String(d.min), max: String(d.max), step: String(d.step), value: String(values[d.key]) })
		input.dataset.key = d.key
		input.addEventListener('input', () => {
			values[d.key] = Number(input.value)
			out.textContent = fmt(d, values[d.key] as number)
			onChange()
		})
		input.addEventListener('dblclick', () => {
			values[d.key] = d.value
			input.value = String(d.value)
			out.textContent = fmt(d, d.value)
			onChange()
		})
		row.append(h('span', { class: 'pg-line' }, name, out), input)
	} else if (d.type === 'color') {
		const input = h('input', { type: 'color', value: values[d.key] as string })
		input.addEventListener('input', () => {
			values[d.key] = input.value
			onChange()
		})
		row.append(name, input)
	} else if (d.type === 'toggle') {
		const input = h('input', { type: 'checkbox', checked: !!values[d.key] })
		input.dataset.key = d.key
		input.addEventListener('change', () => {
			values[d.key] = input.checked
			onChange()
		})
		row.append(input, h('span', { class: 'pg-switch' }), name)
	} else {
		const seg = h('span', { class: 'pg-seg' })
		for (const o of d.options) {
			const b = h('button', { type: 'button', textContent: o, className: values[d.key] === o ? 'on' : '' })
			b.addEventListener('click', (e) => {
				e.preventDefault()
				values[d.key] = o
				for (const c of seg.children) c.classList.toggle('on', c === b)
				onChange()
			})
			seg.append(b)
		}
		row.append(name, seg)
	}
	return row
}

function renderLists() {
	edgeList.replaceChildren(
		...EDGES.map((e, i) => {
			const b = h('button', { class: `pg-item${e.id === settings.edge ? ' on' : ''}`, title: e.blurb }, h('span', { class: 'pg-num', textContent: String(i + 1) }), h('span', { class: 'pg-item-name', textContent: e.name }))
			b.dataset.edge = e.id
			b.addEventListener('click', () => selectEdge(e.id))
			return b
		}),
	)
	headerList.replaceChildren(
		...HEADERS.map((v, i) => {
			const b = h('button', { class: `pg-item${v.id === settings.header ? ' on' : ''}`, title: v.blurb }, h('span', { class: 'pg-num', textContent: String.fromCharCode(65 + i) }), h('span', { class: 'pg-item-name', textContent: v.name }))
			b.dataset.header = v.id
			b.addEventListener('click', () => selectHeader(v.id))
			return b
		}),
	)
}

function renderEdgeParams() {
	const values = edgeValues()
	edgeParamsEl.replaceChildren(h('p', { class: 'pg-blurb', textContent: edge().blurb }), ...edge().params.map((d) => control(d, values, persist)))
}

function renderHeaderParams() {
	const values = headerValues()
	headerParamsEl.replaceChildren(
		h('p', { class: 'pg-blurb', textContent: header().blurb }),
		...header().params.map((d) =>
			control(d, values, () => {
				renderHeaders()
				persist()
			}),
		),
	)
}

function selectEdge(id: string) {
	settings.edge = id
	try {
		gl.prepare(edge())
	} catch (e) {
		console.error(e)
	}
	renderLists()
	renderEdgeParams()
	persist()
}

function selectHeader(id: string) {
	settings.header = id
	renderLists()
	renderHeaderParams()
	renderHeaders()
	persist()
}

doneEl.append(...DONE_PARAMS.map((d) => control(d, settings.done, persist)))
const flashAll = h('button', { class: 'pg-btn', textContent: 'Flash all' })
flashAll.addEventListener('click', () => settings.frames.forEach((_, i) => finish(i, false)))
doneEl.append(flashAll)

globalEl.append(
	...GLOBAL_PARAMS.map((d) =>
		control(d, settings.global, () => {
			applyReduced()
			persist()
		}),
	),
)

function applyReduced() {
	const reduced = !!settings.global.reduced
	demo.classList.toggle('pg-reduced', reduced)
	specimens.classList.toggle('pg-reduced', reduced)
}

// ---------- frame states ----------

const work: number[] = settings.frames.map((f) => (f.working ? 1 : 0))
const doneAt: number[] = settings.frames.map(() => -1)
let clock = 0

function finish(i: number, stop = true) {
	if (stop) {
		settings.frames[i].working = false
		settings.frames[i].subagents = 0
	}
	doneAt[i] = clock
}

function setWorking(i: number, working: boolean) {
	const f = settings.frames[i]
	if (f.working && !working) finish(i, false)
	f.working = working
}

function renderStates() {
	const rows = settings.frames.map((f, i) => {
		const color = h('input', { type: 'color', value: f.color, title: 'Session colour' })
		color.addEventListener('input', () => {
			f.color = color.value
			renderHeaders()
			persist()
		})
		const seg = h('span', { class: 'pg-seg' })
		for (const [label, on] of [
			['Idle', false],
			['Working', true],
		] as const) {
			const b = h('button', { type: 'button', textContent: label, className: f.working === on ? 'on' : '' })
			b.addEventListener('click', () => {
				setWorking(i, on)
				renderStates()
				persist()
			})
			seg.append(b)
		}
		const done = h('button', { class: 'pg-btn small', textContent: 'Done', title: 'Finish: stop working, clear subagents and flash' })
		done.addEventListener('click', () => {
			finish(i)
			renderStates()
			renderHeaders()
			persist()
		})
		const out = h('span', { class: 'pg-value', textContent: String(f.subagents) })
		const slider = h('input', { type: 'range', min: '0', max: '8', step: '1', value: String(f.subagents) })
		slider.dataset.frame = String(i)
		slider.addEventListener('input', () => {
			f.subagents = Number(slider.value)
			out.textContent = String(f.subagents)
			renderHeaders()
			persist()
		})
		return h(
			'div',
			{ class: 'pg-state' },
			h('div', { class: 'pg-line' }, color, h('span', { class: 'pg-state-title', textContent: f.title }), seg, done),
			h('label', { class: 'pg-line pg-sub' }, h('span', { class: 'pg-name', textContent: 'Subagents' }), slider, out),
		)
	})
	const randomise = h('button', { class: 'pg-btn', textContent: 'Randomise states' })
	randomise.addEventListener('click', () => {
		settings.frames.forEach((f, i) => {
			setWorking(i, Math.random() < 0.65)
			const r = Math.random()
			f.subagents = r < 0.3 ? 0 : r < 0.55 ? 1 : Math.ceil(Math.random() * 8)
		})
		refreshFrames()
	})
	const allWorking = h('button', { class: 'pg-btn', textContent: 'All working' })
	allWorking.addEventListener('click', () => {
		settings.frames.forEach((_, i) => setWorking(i, true))
		refreshFrames()
	})
	const allIdle = h('button', { class: 'pg-btn', textContent: 'All idle' })
	allIdle.addEventListener('click', () => {
		settings.frames.forEach((f, i) => {
			setWorking(i, false)
			f.subagents = 0
		})
		refreshFrames()
	})
	const colours = h('button', { class: 'pg-btn', textContent: 'Shuffle colours' })
	colours.addEventListener('click', () => {
		const pool = [...SESSION_COLORS].sort(() => Math.random() - 0.5)
		settings.frames.forEach((f, i) => (f.color = pool[i % pool.length]))
		refreshFrames()
	})
	statesEl.replaceChildren(...rows, h('div', { class: 'pg-buttons' }, randomise, allWorking, allIdle, colours))
}

function refreshFrames() {
	renderStates()
	renderHeaders()
	persist()
}

// ---------- labels (DOM, like the app's SectionLabels) ----------

const layout: Layout = buildLayout(settings.frames)
interface FrameLabel {
	outer: HTMLDivElement
	slots: Slots
}
const frameLabels: FrameLabel[] = []
const groupLabels: { el: HTMLDivElement; box: Box }[] = []
for (const s of layout.sections) {
	const outer = h('div', { class: 'pg-label' })
	const slots = createHeader(s.title)
	outer.append(slots.root)
	overlay.append(outer)
	frameLabels.push({ outer, slots })
	for (const g of s.groups) {
		if (!g.heading) continue
		const el = h('div', { class: 'pg-group' }, h('span', { class: 'name', textContent: g.name ?? '' }))
		overlay.append(el)
		groupLabels.push({ el, box: g.heading })
	}
}

const applied = new WeakMap<Slots, string>()

function paintHeader(slots: Slots, n: number, colour: string) {
	const v = header()
	if (applied.get(slots) !== v.id) {
		resetHeader(slots)
		slots.root.classList.add(`hv-${v.id}`)
		applied.set(slots, v.id)
	}
	slots.root.style.setProperty('--c', colour)
	slots.root.style.setProperty('--c-hi', mixWhite(colour, 0.45))
	applyParams(slots.root, v, headerValues())
	slots.root.classList.toggle('has-agents', n > 0)
	v.render(slots, n, headerValues())
}

function renderHeaders() {
	layout.sections.forEach((_, i) => paintHeader(frameLabels[i].slots, settings.frames[i].subagents, settings.frames[i].color))
	for (const s of specSlots) paintHeader(s.slots, s.n, settings.frames[0].color)
}

function mixWhite(hex: string, m: number) {
	const [r, g, b] = hexToRgb(hex).map((c) => Math.round((c + (1 - c) * m) * 255))
	return `rgb(${r}, ${g}, ${b})`
}

let labelsDirty = true
function placeLabels() {
	const { x, y, z } = camera
	const scale = Math.max(z, LAYOUT.minFrameTitlePx / LAYOUT.frameTitlePx)
	const place = (el: HTMLElement, box: Box, s: number) => {
		el.style.width = `${(box.w * z) / s}px`
		el.style.height = `${box.h}px`
		el.style.transform = `translate(${box.x * z + x}px, ${(box.y + box.h) * z + y - box.h}px) scale(${s})`
	}
	layout.sections.forEach((s, i) => place(frameLabels[i].outer, s.header, scale))
	for (const g of groupLabels) place(g.el, g.box, z)
	zoomEl.textContent = `${Math.round(z * 100)}%`
}

// ---------- camera ----------

const MIN_ZOOM = 0.02
const MAX_ZOOM = 8
const camera: Camera = { x: 0, y: 0, z: 0.3 }
let cameraAnim: { from: Camera; to: Camera; start: number } | null = null
let viewW = 1
let viewH = 1

function zoomAt(sx: number, sy: number, z: number) {
	z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))
	camera.x = sx - ((sx - camera.x) * z) / camera.z
	camera.y = sy - ((sy - camera.y) * z) / camera.z
	camera.z = z
	cameraAnim = null
	labelsDirty = true
}

function fitCamera(): Camera {
	const b = layout.bounds!
	const pad = 48
	const z = Math.min((viewW - pad * 2) / b.w, (viewH - pad * 2 - 30) / b.h, 1)
	return { z, x: (viewW - b.w * z) / 2 - b.x * z, y: (viewH - b.h * z) / 2 - b.y * z + 14 }
}

function animateTo(to: Camera) {
	cameraAnim = { from: { ...camera }, to, start: performance.now() }
}

fitButton.addEventListener('click', () => animateTo(fitCamera()))
oneButton.addEventListener('click', () => {
	const z = 1
	animateTo({ z, x: viewW / 2 - ((viewW / 2 - camera.x) * z) / camera.z, y: viewH / 2 - ((viewH / 2 - camera.y) * z) / camera.z })
})

const pointers = new Map<number, { x: number; y: number }>()
let pinch: { dist: number; mx: number; my: number } | null = null

function local(e: { clientX: number; clientY: number }) {
	const r = demo.getBoundingClientRect()
	return { x: e.clientX - r.left, y: e.clientY - r.top }
}

demo.addEventListener('pointerdown', (e) => {
	if ((e.target as HTMLElement).closest('button')) return
	demo.setPointerCapture(e.pointerId)
	pointers.set(e.pointerId, local(e))
	cameraAnim = null
	demo.classList.add('dragging')
	if (pointers.size === 2) {
		const [a, b] = [...pointers.values()]
		pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }
	}
})
demo.addEventListener('pointermove', (e) => {
	const prev = pointers.get(e.pointerId)
	if (!prev) return
	const p = local(e)
	pointers.set(e.pointerId, p)
	if (pointers.size >= 2 && pinch) {
		const [a, b] = [...pointers.values()]
		const dist = Math.hypot(a.x - b.x, a.y - b.y)
		const mx = (a.x + b.x) / 2
		const my = (a.y + b.y) / 2
		camera.x += mx - pinch.mx
		camera.y += my - pinch.my
		zoomAt(mx, my, (camera.z * dist) / pinch.dist)
		pinch = { dist, mx, my }
	} else {
		camera.x += p.x - prev.x
		camera.y += p.y - prev.y
		labelsDirty = true
	}
})
const release = (e: PointerEvent) => {
	pointers.delete(e.pointerId)
	if (pointers.size < 2) pinch = null
	if (!pointers.size) demo.classList.remove('dragging')
}
demo.addEventListener('pointerup', release)
demo.addEventListener('pointercancel', release)
demo.addEventListener(
	'wheel',
	(e) => {
		e.preventDefault()
		const p = local(e)
		const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? viewH : 1
		const dx = e.deltaX * scale
		const dy = e.deltaY * scale
		if (e.ctrlKey || e.metaKey) zoomAt(p.x, p.y, camera.z * Math.exp(-Math.max(-50, Math.min(50, dy || dx)) * 0.01))
		else if (settings.global.wheel === 'zoom') zoomAt(p.x, p.y, camera.z * Math.exp(-Math.max(-120, Math.min(120, dy)) * 0.0022))
		else {
			camera.x -= dx
			camera.y -= dy
			cameraAnim = null
			labelsDirty = true
		}
	},
	{ passive: false },
)

window.addEventListener('keydown', (e) => {
	if ((e.target as HTMLElement).closest('input, textarea, select')) return
	const step = (list: { id: string }[], id: string, d: number) => list[(list.findIndex((x) => x.id === id) + d + list.length) % list.length].id
	if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') selectEdge(step(EDGES, settings.edge, e.key === 'ArrowRight' ? 1 : -1))
	else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') selectHeader(step(HEADERS, settings.header, e.key === 'ArrowDown' ? 1 : -1))
	else if (e.key === 'f') animateTo(fitCamera())
	else return
	e.preventDefault()
})

// ---------- loop ----------

const gl = new DemoGL(canvas)
const params = new Float32Array(32)
let edgeTime = 0
let lastNow = performance.now()
const intervals: number[] = []
let fpsShownAt = 0
let simulateIn = 2

let first = true
new ResizeObserver(() => {
	const r = demo.getBoundingClientRect()
	viewW = r.width
	viewH = r.height
	if (first) {
		Object.assign(camera, fitCamera())
		first = false
	}
	labelsDirty = true
}).observe(demo)

function simulate(dt: number) {
	simulateIn -= dt
	if (simulateIn > 0) return
	simulateIn = 1.4 + Math.random() * 2.6
	const i = Math.floor(Math.random() * settings.frames.length)
	const f = settings.frames[i]
	const r = Math.random()
	if (r < 0.55) f.subagents = Math.max(0, Math.min(8, f.subagents + (Math.random() < 0.5 ? -1 : 1) * (1 + Math.floor(Math.random() * 2))))
	else if (f.working) finish(i)
	else setWorking(i, true)
	renderStates()
	renderHeaders()
}

function tick(now: number) {
	requestAnimationFrame(tick)
	const dtMs = Math.min(100, now - lastNow)
	lastNow = now
	const dt = dtMs / 1000
	clock += dt
	intervals.push(dtMs)
	if (intervals.length > 90) intervals.shift()
	if (now - fpsShownAt > 500) {
		fpsShownAt = now
		const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length
		fpsEl.textContent = `${Math.round(1000 / avg)} fps`
		fpsEl.dataset.fps = String(1000 / avg)
	}
	if (settings.global.simulate) simulate(dt)

	if (cameraAnim) {
		const t = Math.min(1, (now - cameraAnim.start) / 420)
		const e = 1 - Math.pow(1 - t, 3)
		const { from, to } = cameraAnim
		// Interpolate zoom logarithmically and keep the page point under the centre moving smoothly.
		const z = from.z * Math.pow(to.z / from.z, e)
		const cx = viewW / 2
		const cy = viewH / 2
		const pf = { x: (cx - from.x) / from.z, y: (cy - from.y) / from.z }
		const pt = { x: (cx - to.x) / to.z, y: (cy - to.y) / to.z }
		const px = pf.x + (pt.x - pf.x) * e
		const py = pf.y + (pt.y - pf.y) * e
		Object.assign(camera, { z, x: cx - px * z, y: cy - py * z })
		labelsDirty = true
		if (t >= 1) cameraAnim = null
	}
	if (labelsDirty) {
		placeLabels()
		labelsDirty = false
	}

	const reduced = !!settings.global.reduced
	const values = edgeValues()
	if (!reduced) edgeTime += dt * (values.speed as number)
	const frames: FrameDraw[] = layout.sections.map((s, i) => {
		const f = settings.frames[i]
		const target = f.working ? 1 : 0
		const tau = target > work[i] ? 0.35 : 0.6
		work[i] += (target - work[i]) * (1 - Math.exp(-dt / tau))
		if (Math.abs(target - work[i]) < 0.002) work[i] = target
		return {
			box: s.box,
			color: hexToRgb(f.color),
			work: work[i],
			done: doneAt[i] < 0 ? -1 : clock - doneAt[i],
			seed: settings.global.desync ? ((i * 0.618034) % 1) : 0,
		}
	})
	pack(edge().params, values, params)
	const d = settings.done
	try {
		gl.draw({
			camera,
			width: viewW,
			height: viewH,
			dpr: Math.min(devicePixelRatio || 1, 2),
			frames,
			items: [...layout.items.values()],
			edge: edge(),
			params,
			time: edgeTime,
			pageUnits: !!settings.global.pageUnits,
			reduced,
			doneParams: [d.duration as number, d.distance as number, d.intensity as number, d.enabled ? 1 : 0],
			values,
		})
	} catch (e) {
		console.error(e)
	}
}

/** For scripted captures: frame a frame, set states, pick variations. */
;(window as unknown as { playground: unknown }).playground = {
	selectEdge,
	selectHeader,
	settings,
	refreshFrames,
	focus(index: number, z: number, dx = 0, dy = 0) {
		const b = layout.sections[index].box
		Object.assign(camera, { z, x: viewW / 2 - (b.x + b.w / 2 + dx) * z, y: viewH / 2 - (b.y + b.h / 2 + dy) * z })
		cameraAnim = null
		labelsDirty = true
	},
	frameScreenBox(index: number) {
		const b = layout.sections[index].box
		return { x: b.x * camera.z + camera.x, y: b.y * camera.z + camera.y, w: b.w * camera.z, h: b.h * camera.z }
	},
}

applyReduced()
renderLists()
renderEdgeParams()
renderHeaderParams()
renderStates()
renderHeaders()
for (const e of EDGES) gl.prepare(e)
requestAnimationFrame(tick)
