import './stacks.css'
import { button, el, numberField, switchControl } from '../shared/controls'
import { chromeParams, chromeVariations, createChrome, restoreParams, shareParams } from '../shared/chrome'
import { defaults, range, resolve, toggle, type ParamValues } from '../shared/params'
import { conceptOf, CONCEPTS, type ConceptId } from './concepts'
import { applyCount, buildWorld, defaultCounts, MAX_CHILDREN, seedStatuses } from './data'
import { Engine } from './stacks'

const OPTIONS = [
	toggle('reduced', 'Reduced motion', matchMedia('(prefers-reduced-motion: reduce)').matches),
	toggle('simulate', 'Simulate activity', false),
	toggle('ghosts', 'Running before first post (ghosts)', false),
	toggle('nested', 'Nested subagents', true),
]

interface Settings {
	concept: ConceptId
	params: Record<string, ParamValues>
	options: ParamValues
	counts: number[]
	busy: boolean[]
}

const world = buildWorld()

const chrome = createChrome<Settings>({
	site: 'subagents',
	title: 'Subagents',
	storageKey: 'canvas-playground-subagent-stacks-v1',
	defaults: () => ({
		concept: CONCEPTS[0].id,
		params: Object.fromEntries(CONCEPTS.map((c) => [c.id, defaults(c.params)])),
		options: defaults(OPTIONS),
		counts: defaultCounts(),
		busy: world.sessions.map((s) => s.status === 'busy'),
	}),
	restore(saved, s) {
		if (typeof saved.v === 'string' && CONCEPTS.some((c) => c.id === saved.v)) s.concept = saved.v as ConceptId
		restoreParams(CONCEPTS, saved.p, s.params)
		if (saved.o) s.options = resolve(OPTIONS, { ...s.options, ...(saved.o as ParamValues) })
		if (Array.isArray(saved.n)) s.counts = s.counts.map((d, i) => (typeof (saved.n as unknown[])[i] === 'number' ? Math.max(0, Math.min(MAX_CHILDREN, Math.round((saved.n as number[])[i]))) : d))
		if (Array.isArray(saved.b)) s.busy = s.busy.map((d, i) => (typeof (saved.b as unknown[])[i] === 'number' ? !!(saved.b as number[])[i] : d))
	},
	share: (s) => ({
		v: s.concept,
		p: shareParams(CONCEPTS, s.params),
		o: Object.fromEntries(Object.entries(s.options).filter(([k, v]) => OPTIONS.find((d) => d.key === k)!.value !== v)),
		n: s.counts,
		b: s.busy.map((b) => (b ? 1 : 0)),
	}),
	exportJson: (s) => {
		const c = conceptOf(s.concept)
		return { site: 'subagents', concept: { id: c.id, name: c.name, params: s.params[c.id] }, focus: s.params.focus }
	},
})

const { settings, demo } = chrome
demo.setAttribute('aria-label', 'Demo canvas: drag to pan, scroll or pinch to zoom; click a deck to fan it, double-click a session to focus it')

// ---------- world ----------

world.sessions.forEach((s, si) => {
	s.status = settings.busy[si] ? 'busy' : 'idle'
	applyCount(world, si, settings.counts[si], 0)
})
seedStatuses(world)

const engine = new Engine(world)
engine.params = settings.params
engine.concept = settings.concept
engine.reduced = !!settings.options.reduced
engine.ghosts = !!settings.options.ghosts
engine.nested = !!settings.options.nested
engine.setConcept(settings.concept)
demo.prepend(engine.worldEl)

const crumbs = el('nav', 'sa-crumbs')
crumbs.setAttribute('aria-label', 'Focus')
demo.append(crumbs)

engine.onFocusChange = renderCrumbs
function renderCrumbs() {
	const levels = engine.focused()
	crumbs.classList.toggle('on', levels.length > 0)
	if (!levels.length) return
	const all = el('button', '', 'All sessions')
	all.type = 'button'
	all.addEventListener('click', () => {
		while (engine.back());
		demo.focus()
	})
	const parts: (HTMLElement | string)[] = [all]
	levels.forEach((l, i) => {
		const b = el('button', '', el('span', 'dot'), l.root.f.title)
		b.type = 'button'
		b.style.setProperty('--c', l.root.f.color)
		if (i === levels.length - 1) b.setAttribute('aria-current', 'page')
		else
			b.addEventListener('click', () => {
				while (engine.focusDepth() > i + 1) engine.back()
				demo.focus()
			})
		parts.push(el('span', 'slash', '/'), b)
	})
	const top = levels[levels.length - 1]
	const n = top.kids.length
	const running = top.kids.filter((k) => k.f.status === 'busy').length
	parts.push(el('span', 'count', `${n} subagent${n === 1 ? '' : 's'}${running ? ` · ${running} running` : ''}`), el('kbd', '', 'Esc'))
	crumbs.replaceChildren(...parts)
}

// ---------- panel ----------

const concept = () => conceptOf(settings.concept)
const refreshCaption = () => chrome.setCaption(concept().name, concept().note)

chromeVariations(chrome, CONCEPTS, settings.concept, (id) => {
	settings.concept = id as ConceptId
	engine.setConcept(settings.concept)
	params.render()
	refreshCaption()
	chrome.save()
})
const params = chromeParams(
	chrome,
	'Parameters',
	() => concept().params,
	() => settings.params[settings.concept],
	() => chrome.save(),
	() => (settings.params[settings.concept] = defaults(concept().params)),
)

const COUNT = range('n', 'Subagents', 0, 0, MAX_CHILDREN, 1)
const framesBody = chrome.section(
	'Sessions',
	button('Add subagent', () => addChild(), 'ghost', true),
)
const countFields: { update: () => void }[] = []
const busySwitches: HTMLButtonElement[] = []
function renderFrames() {
	countFields.length = 0
	busySwitches.length = 0
	framesBody.replaceChildren(
		...world.sessions.map((s, si) => {
			const field = numberField(
				COUNT,
				() => settings.counts[si],
				(v) => setCount(si, v),
			)
			field.el.title = 'Subagents: drag to scrub, click to type'
			field.el.querySelector('input')!.setAttribute('aria-label', `${s.title}: subagents`)
			countFields.push(field)
			const sw = switchControl(settings.busy[si], (on) => setBusy(si, on))
			sw.setAttribute('aria-label', `${s.title} is working`)
			sw.title = 'Working'
			busySwitches.push(sw)
			const row = el('div', 'sa-frame-row', el('span', 'dot'), el('span', 't', s.title), field.el, sw)
			row.style.setProperty('--c', s.color)
			return row
		}),
		el(
			'div',
			'pg-buttons',
			button('Finish all', () => finishAll(), '', true),
			button('Randomise', () => randomise(), '', true),
			button('Defaults', () => {
				defaultCounts().forEach((n, si) => setCount(si, n, false))
				seedStatuses(world)
				world.sessions.forEach((_, si) => engine.dataChanged(si))
			}, '', true),
		),
	)
}

function setCount(si: number, v: number, sync = true) {
	const n = Math.round(Math.min(MAX_CHILDREN, Math.max(0, v)))
	if (n === settings.counts[si]) return
	settings.counts[si] = n
	applyCount(world, si, n, engine.clock)
	if (n === 0 && engine.isFanned(si)) engine.setFan(si, false)
	engine.dataChanged(si)
	if (sync) countFields[si]?.update()
	chrome.save()
}

function setBusy(si: number, on: boolean) {
	settings.busy[si] = on
	world.sessions[si].status = on ? 'busy' : 'idle'
	busySwitches[si]?.setAttribute('aria-checked', String(on))
	chrome.save()
}

function addChild(si?: number) {
	const target = si ?? (engine.selected ? engine.sessionOf(engine.selected) : world.sessions.findIndex((s, i) => s.status === 'busy' && settings.counts[i] < MAX_CHILDREN))
	if (target < 0) return
	setCount(target, settings.counts[target] + 1)
}

function finishAll() {
	world.sessions.forEach((s, si) => {
		for (const f of s.children) if (f.status === 'busy') {
			f.status = 'done'
			f.at = engine.clock
		}
		engine.dataChanged(si)
	})
}

function randomise() {
	world.sessions.forEach((_, si) => {
		const r = Math.random()
		setCount(si, r < 0.2 ? 0 : r < 0.4 ? 1 + Math.floor(Math.random() * 3) : 3 + Math.floor(Math.random() * 10))
	})
}

renderFrames()

const previewBody = chrome.section('Preview')
for (const d of OPTIONS) {
	const row = el('div', 'c-row c-row-2', el('label', 'c-label', d.label))
	const sw = switchControl(!!settings.options[d.key], (on) => {
		settings.options[d.key] = on
		applyOptions()
		chrome.save()
	})
	sw.setAttribute('aria-label', d.label)
	sw.dataset.key = d.key
	row.append(sw)
	previewBody.append(row)
}

function applyOptions() {
	engine.reduced = !!settings.options.reduced
	demo.classList.toggle('sa-reduced', engine.reduced)
	if (engine.ghosts !== !!settings.options.ghosts || engine.nested !== !!settings.options.nested) {
		engine.ghosts = !!settings.options.ghosts
		engine.nested = !!settings.options.nested
		world.sessions.forEach((_, si) => engine.dataChanged(si))
	}
}
applyOptions()

const keys: [string, string][] = [
	['Click', 'a deck: fan it out'],
	['Dbl-click', 'a session: focus it'],
	['F', 'fan / gather the selected deck (all if none)'],
	['Enter', 'focus the selected session'],
	['Esc', 'back out, gather, deselect'],
	['← →  ↑ ↓', 'select another session'],
	['0', 'fit everything'],
	['1–4', 'switch concept'],
]
chrome.section('Keys').append(el('div', 'sa-keys', ...keys.flatMap(([k, v]) => [el('kbd', '', k), el('span', '', v)])))

refreshCaption()

// ---------- input ----------

let untouched = true
const local = (e: { clientX: number; clientY: number }) => {
	const r = demo.getBoundingClientRect()
	return { x: e.clientX - r.left, y: e.clientY - r.top }
}
const cardAt = (clientX: number, clientY: number) => {
	const t = document.elementFromPoint(clientX, clientY) as HTMLElement | null
	if (!t || !demo.contains(t)) return { card: null, chip: null }
	return { card: (t.closest('[data-card]') as HTMLElement | null)?.dataset.card ?? null, chip: (t.closest('[data-chip]') as HTMLElement | null)?.dataset.chip ?? null }
}

let press: { id: number; x: number; y: number; lx: number; ly: number; moved: boolean } | null = null
let lastClick: { si: number; t: number; fanned: boolean } | null = null

demo.addEventListener('pointerdown', (e) => {
	if ((e.target as HTMLElement).closest('.sa-crumbs')) return
	if (e.button !== 0) return
	demo.focus({ preventScroll: true })
	demo.setPointerCapture(e.pointerId)
	const p = local(e)
	press = { id: e.pointerId, x: p.x, y: p.y, lx: p.x, ly: p.y, moved: false }
	engine.stopCamera()
})
demo.addEventListener('pointermove', (e) => {
	if (press && e.pointerId === press.id) {
		const p = local(e)
		if (!press.moved && Math.hypot(p.x - press.x, p.y - press.y) > 4) {
			press.moved = true
			demo.classList.add('dragging')
			untouched = false
		}
		if (press.moved) engine.pan(p.x - press.lx, p.y - press.ly)
		press.lx = p.x
		press.ly = p.y
		return
	}
	if (e.pointerType === 'mouse') engine.hover(cardAt(e.clientX, e.clientY).card)
})
demo.addEventListener('pointerleave', () => engine.hover(null))
const release = (e: PointerEvent) => {
	if (!press || e.pointerId !== press.id) return
	const wasClick = !press.moved
	press = null
	demo.classList.remove('dragging')
	if (wasClick) click(e.clientX, e.clientY)
}
demo.addEventListener('pointerup', release)
demo.addEventListener('pointercancel', release)

function click(clientX: number, clientY: number) {
	const { card, chip } = cardAt(clientX, clientY)
	const now = performance.now()
	if (chip !== null) {
		const si = Number(chip)
		engine.selected = world.sessions[si].id
		engine.toggleFan(si)
		lastClick = null
		return
	}
	if (!card) {
		if (!engine.focusDepth()) engine.selected = null
		lastClick = null
		return
	}
	const si = engine.sessionOf(card)
	const c = engine.card(card)!
	if (lastClick && lastClick.si === si && now - lastClick.t < 340) {
		// Double-click: focus (undoing a fan its first click started).
		if (lastClick.fanned) engine.cancelFan(si)
		engine.enter(card)
		lastClick = null
		return
	}
	let fanned = false
	if (engine.focusDepth()) engine.selected = card
	else {
		engine.selected = world.sessions[si].id
		if (c.f.parent && !engine.isFanned(si) && settings.concept !== 'focus') {
			engine.setFan(si, true)
			fanned = true
		}
	}
	lastClick = { si, t: now, fanned }
}

demo.addEventListener(
	'wheel',
	(e) => {
		e.preventDefault()
		untouched = false
		const p = local(e)
		const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? engine.viewH : 1
		const dx = e.deltaX * scale
		const dy = e.deltaY * scale
		const z = engine.cam.z
		if (e.ctrlKey || e.metaKey) engine.zoomAt(p.x, p.y, z * Math.exp(-Math.max(-50, Math.min(50, dy || dx)) * 0.01))
		else if (Math.abs(dx) > Math.abs(dy) * 1.5) engine.pan(-dx, 0)
		else engine.zoomAt(p.x, p.y, z * Math.exp(-Math.max(-120, Math.min(120, dy)) * 0.002))
	},
	{ passive: false },
)

function nearestSession() {
	let best = 0
	let bestD = Infinity
	world.sessions.forEach((s, si) => {
		const b = engine.screenBox(s.id)
		if (!b) return
		const d = Math.hypot(b.x + b.w / 2 - engine.viewW / 2, b.y + b.h / 2 - engine.viewH / 2)
		if (d < bestD) {
			bestD = d
			best = si
		}
	})
	return best
}

function moveSelection(dx: number, dy: number) {
	const cur = engine.selected ? engine.sessionOf(engine.selected) : -1
	if (cur < 0) {
		engine.selected = world.sessions[nearestSession()].id
		return
	}
	const from = engine.screenBox(world.sessions[cur].id)!
	let best = -1
	let bestD = Infinity
	world.sessions.forEach((s, si) => {
		if (si === cur) return
		const b = engine.screenBox(s.id)!
		const vx = b.x - from.x
		const vy = b.y - from.y
		const along = vx * dx + vy * dy
		if (along <= 1) return
		const d = along + Math.abs(vx * dy + vy * dx) * 3
		if (d < bestD) {
			bestD = d
			best = si
		}
	})
	if (best >= 0) engine.selected = world.sessions[best].id
}

demo.addEventListener('keydown', (e) => {
	if (e.metaKey || e.ctrlKey || e.altKey) return
	const k = e.key
	const sel = engine.selected ? engine.sessionOf(engine.selected) : -1
	if (k === 'f' || k === 'F') {
		if (engine.focusDepth()) return
		if (sel >= 0 && engine.card(engine.selected!)?.f.parent === null) engine.toggleFan(sel)
		else if (sel >= 0) engine.toggleFan(sel)
		else if (engine.anyFanned()) engine.collapseAll()
		else world.sessions.forEach((_, si) => engine.setFan(si, true))
	} else if (k === 'Enter') {
		engine.enter(engine.selected ?? world.sessions[nearestSession()].id)
	} else if (k === 'Escape') {
		if (engine.back()) return void e.preventDefault()
		if (engine.closePeek()) return void e.preventDefault()
		if (sel >= 0 && engine.isFanned(sel)) engine.setFan(sel, false)
		else if (engine.anyFanned()) engine.collapseAll()
		else engine.selected = null
	} else if (k.startsWith('Arrow')) {
		const dx = k === 'ArrowLeft' ? -1 : k === 'ArrowRight' ? 1 : 0
		const dy = k === 'ArrowUp' ? -1 : k === 'ArrowDown' ? 1 : 0
		if (e.shiftKey) engine.pan(-dx * 120, -dy * 120)
		else if (!engine.focusDepth()) moveSelection(dx, dy)
	} else if (k === '0') {
		engine.animateCamera(engine.fitAll(), 480, 'in-out')
	} else if (k === '=' || k === '+') engine.zoomAt(engine.viewW / 2, engine.viewH / 2, engine.cam.z * 1.25)
	else if (k === '-') engine.zoomAt(engine.viewW / 2, engine.viewH / 2, engine.cam.z / 1.25)
	else return
	untouched = false
	e.preventDefault()
})

chrome.toolbar.append(
	button('Fit', () => {
		untouched = false
		engine.animateCamera(engine.fitAll(), 480, 'in-out')
	}, '', true),
)

new ResizeObserver(() => {
	const r = demo.getBoundingClientRect()
	engine.setView(r.width, r.height)
	if (untouched && r.width > 10) Object.assign(engine.cam, engine.fitAll())
}).observe(demo)

// ---------- loop ----------

/** Scripted captures stop the clock and step it by exact amounts. */
let virtual: number | null = null
let simulateIn = 1.6
let lastNow = performance.now()

function simulate(dt: number) {
	if (!settings.options.simulate) return
	simulateIn -= dt
	if (simulateIn > 0) return
	simulateIn = 1.4 + Math.random() * 2.2
	const r = Math.random()
	const si = Math.floor(Math.random() * world.sessions.length)
	const s = world.sessions[si]
	const busy = s.children.filter((f) => f.status === 'busy')
	if (r < 0.45 && busy.length) {
		const f = busy[Math.floor(Math.random() * busy.length)]
		f.status = Math.random() < 0.1 ? 'failed' : 'done'
		f.at = engine.clock
		engine.dataChanged(si)
	} else if (r < 0.8 && settings.counts[si] < MAX_CHILDREN) {
		setCount(si, settings.counts[si] + 1)
	} else if (s.children.length) {
		const f = s.children[Math.floor(Math.random() * s.children.length)]
		f.status = 'busy'
		f.at = engine.clock
		engine.dataChanged(si)
	}
}

function frame(now: number, dtMs: number) {
	engine.clock += dtMs / 1000
	simulate(dtMs / 1000)
	engine.update(now)
	chrome.setZoom(engine.cam.z)
}

chrome.onTick((_, now) => {
	if (virtual !== null) return
	const dt = Math.min(100, now - lastNow)
	lastNow = now
	frame(now, dt)
})

Object.assign(window, {
	playground: {
		engine,
		settings,
		world,
		select: (id: string) => document.querySelector<HTMLElement>(`[role="option"][data-id="${id}"]`)?.click(),
		pause(on: boolean) {
			virtual = on ? performance.now() : null
			lastNow = performance.now()
			demo.classList.toggle('sa-still', on)
		},
		advance(ms: number) {
			if (virtual === null) virtual = performance.now()
			virtual += ms
			frame(virtual, ms)
			demo.style.setProperty('--t', (virtual / 1000).toFixed(3))
		},
		setCounts: (ns: number[]) => ns.forEach((n, si) => setCount(si, n)),
		addChild,
		click: (id: string) => {
			const b = engine.screenBox(id)!
			const r = demo.getBoundingClientRect()
			click(r.left + b.x + b.w / 2, r.top + b.y + b.h - 6)
		},
		fan: (si: number, on: boolean) => engine.setFan(si, on),
		enter: (id: string) => engine.enter(id),
		back: () => engine.back(),
		hover: (id: string | null) => engine.hover(id),
		zoomAt: (sx: number, sy: number, z: number) => engine.zoomAt(sx, sy, z),
		fit: () => Object.assign(engine.cam, engine.fitAll()),
		camera: (to: { x: number; y: number; z: number }, ms: number) => engine.animateCamera(to, ms),
		screenBox: (id: string) => engine.screenBox(id),
		/** centres a card at zoom z (offset by dx, dy screen px) */
		look(id: string, z: number, dx = 0, dy = 0) {
			untouched = false
			const c = engine.card(id)!.shown
			const cx = c.x
			const cy = c.y + (c.bh * c.s) / 2
			Object.assign(engine.cam, { z, x: engine.viewW / 2 - cx * z + dx, y: engine.viewH / 2 - cy * z + dy })
			engine.stopCamera()
		},
		touch: () => (untouched = false),
	},
})
