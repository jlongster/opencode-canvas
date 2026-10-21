import './font'
import './ui.css'
import { button, el } from './controls'
import { DemoGL, type Camera, type View } from './gl'
import { buildLayout, defaultFrames, type FrameState } from './scene'
import { LAYOUT, type Layout } from '../../editor/layout'
import type { Box } from '../../editor/geometry'

/** "/canvas" when reached through the website's proxy, else "". */
export const BASE = /^\/canvas(\/|$)/.test(location.pathname) ? '/canvas' : ''

export const SITES = [
	{ id: 'busy', name: 'Busy', href: `${BASE}/playground/busy` },
	{ id: 'subagents', name: 'Subagents', href: `${BASE}/playground/subagents` },
] as const

export interface TitleSlots {
	root: HTMLElement
	text: HTMLElement
	after: HTMLElement
}

/** A frame title as the playground draws it: the text, then a slot for indicators beside it. */
export function createTitle(title: string): TitleSlots {
	const text = el('span', 'text', title)
	const after = el('span', 'after')
	const root = el('div', 'pg-title', text, after)
	return { root, text, after }
}

export interface BaseSettings {
	frames: FrameState[]
}

export interface ShellOptions<S extends BaseSettings> {
	site: (typeof SITES)[number]['id']
	title: string
	storageKey: string
	defaults: () => S
	/** fills `into` (the defaults) from whatever was saved or shared */
	restore: (saved: Record<string, unknown>, into: S) => void
	/** the compact state the URL hash carries */
	share: (s: S) => unknown
	/** what "Copy settings" copies */
	exportJson: (s: S) => unknown
	/** shown under the demo (e.g. specimens) */
	below?: HTMLElement
}

export function frameFromSaved(base: FrameState, o: Partial<FrameState> | undefined): FrameState {
	if (!o) return base
	return {
		...base,
		working: typeof o.working === 'boolean' ? o.working : base.working,
		subagents: typeof o.subagents === 'number' ? Math.max(0, Math.min(8, Math.round(o.subagents))) : base.subagents,
		color: typeof o.color === 'string' && /^#[0-9a-f]{6}$/i.test(o.color) ? o.color : base.color,
	}
}

export function createShell<S extends BaseSettings>(opts: ShellOptions<S>) {
	// ---------- settings ----------
	const settings = opts.defaults()
	try {
		opts.restore(JSON.parse(localStorage.getItem(opts.storageKey) ?? '{}'), settings)
	} catch {}
	try {
		const m = /[#&]s=([^&]+)/.exec(location.hash)
		if (m) opts.restore(JSON.parse(decodeURIComponent(m[1])), settings)
	} catch (e) {
		console.warn('ignoring an unreadable settings hash', e)
	}
	let saveTimer = 0
	const save = () => {
		clearTimeout(saveTimer)
		saveTimer = window.setTimeout(() => {
			localStorage.setItem(opts.storageKey, JSON.stringify(opts.share(settings)))
			history.replaceState(null, '', `#s=${encodeURIComponent(JSON.stringify(opts.share(settings)))}`)
		}, 150)
	}

	// ---------- DOM ----------
	document.title = `${opts.title} · Frame status playground`
	const root = el('div', 'pg-app')
	const tabs = el('nav', 'c-tabs')
	tabs.setAttribute('aria-label', 'Playgrounds')
	for (const s of SITES) {
		const a = el('a', '', s.name)
		a.href = s.href
		if (s.id === opts.site) a.setAttribute('aria-current', 'page')
		tabs.append(a)
	}
	const brand = el('a', 'pg-brand', 'Frame status')
	brand.href = `${BASE}/playground`
	const fps = el('span', 'pg-readout pg-fps')
	fps.title = 'Frames per second'
	const zoom = el('span', 'pg-readout pg-zoom')
	zoom.title = 'Zoom'
	const toolbar = el('div', 'pg-toolbar', brand, tabs, el('span', 'pg-spacer'), fps, zoom)
	const demo = el('div', 'pg-demo')
	demo.tabIndex = 0
	demo.setAttribute('aria-label', 'Demo canvas: drag to pan, scroll or pinch to zoom, F to fit')
	const canvas = el('canvas', 'pg-canvas')
	const overlay = el('div', 'pg-overlay')
	const caption = el('div', 'pg-caption')
	demo.append(canvas, overlay, caption)
	const main = el('main', 'pg-main', toolbar, demo)
	if (opts.below) main.append(opts.below)

	const panelBody = el('div', 'pg-panel-body')
	const copy = button('Copy settings', () => void copySettings(), 'primary', true)
	const panel = el('aside', 'pg-panel', el('header', 'pg-panel-head', el('h1', '', opts.title), copy), panelBody)
	root.append(main, panel)
	document.body.append(root)

	async function copySettings() {
		const text = JSON.stringify(opts.exportJson(settings), null, 2)
		try {
			await navigator.clipboard.writeText(text)
		} catch {
			const ta = el('textarea')
			ta.value = text
			document.body.append(ta)
			ta.select()
			document.execCommand('copy')
			ta.remove()
		}
		console.log(text)
		copy.textContent = 'Copied'
		setTimeout(() => (copy.textContent = 'Copy settings'), 1200)
	}
	;(window as unknown as { playgroundSettings: () => unknown }).playgroundSettings = () => opts.exportJson(settings)

	/** A panel section; `action` sits at the right of its header (e.g. Reset). */
	function section(title: string, action?: HTMLElement) {
		const body = el('div', 'pg-stack')
		const head = el('div', 'pg-section-head', el('h2', '', title))
		if (action) head.append(action)
		panelBody.append(el('section', 'pg-section', head, body))
		return body
	}

	function setCaption(name: string, note: string) {
		caption.replaceChildren(el('b', '', name), el('span', '', note))
		caption.title = note
	}

	// ---------- layout and labels ----------
	const layout: Layout = buildLayout(settings.frames)
	const frameLabels: { outer: HTMLElement; slots: TitleSlots }[] = []
	const groupLabels: { el: HTMLElement; box: Box }[] = []
	for (const s of layout.sections) {
		const slots = createTitle(s.title)
		const outer = el('div', 'pg-label', slots.root)
		overlay.append(outer)
		frameLabels.push({ outer, slots })
		for (const g of s.groups) {
			if (!g.heading) continue
			const h = el('div', 'pg-group', el('span', 'name', g.name ?? ''))
			overlay.append(h)
			groupLabels.push({ el: h, box: g.heading })
		}
	}

	// ---------- camera ----------
	const camera: Camera = { x: 0, y: 0, z: 0.3 }
	let viewW = 1
	let viewH = 1
	let anim: { from: Camera; to: Camera; start: number } | null = null
	let labelsDirty = true
	let untouched = true
	const MIN_ZOOM = 0.02
	const MAX_ZOOM = 8

	const placeLabels = () => {
		const { x, y, z } = camera
		const scale = Math.max(z, LAYOUT.minFrameTitlePx / LAYOUT.frameTitlePx)
		const place = (e: HTMLElement, box: Box, s: number) => {
			e.style.width = `${(box.w * z) / s}px`
			e.style.height = `${box.h}px`
			e.style.transform = `translate(${box.x * z + x}px, ${(box.y + box.h) * z + y - box.h}px) scale(${s})`
		}
		layout.sections.forEach((s, i) => place(frameLabels[i].outer, s.header, scale))
		for (const g of groupLabels) place(g.el, g.box, z)
		zoom.textContent = `${Math.round(z * 100)}%`
	}

	const zoomAt = (sx: number, sy: number, z: number) => {
		untouched = false
		z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))
		camera.x = sx - ((sx - camera.x) * z) / camera.z
		camera.y = sy - ((sy - camera.y) * z) / camera.z
		camera.z = z
		anim = null
		labelsDirty = true
	}
	const fitCamera = (): Camera => {
		const b = layout.bounds!
		const pad = 56
		const z = Math.min((viewW - pad * 2) / b.w, (viewH - pad * 2 - 24) / b.h, 1)
		return { z, x: (viewW - b.w * z) / 2 - b.x * z, y: (viewH - b.h * z) / 2 - b.y * z - 8 }
	}
	const animateTo = (to: Camera) => {
		untouched = false
		anim = { from: { ...camera }, to, start: performance.now() }
	}
	const fit = () => animateTo(fitCamera())

	toolbar.append(
		button('100%', () => animateTo({ z: 1, x: viewW / 2 - (viewW / 2 - camera.x) / camera.z, y: viewH / 2 - (viewH / 2 - camera.y) / camera.z }), 'ghost', true),
		button('Fit', fit, '', true),
	)

	const pointers = new Map<number, { x: number; y: number }>()
	let pinch: { dist: number; mx: number; my: number } | null = null
	const local = (e: { clientX: number; clientY: number }) => {
		const r = demo.getBoundingClientRect()
		return { x: e.clientX - r.left, y: e.clientY - r.top }
	}
	demo.addEventListener('pointerdown', (e) => {
		demo.setPointerCapture(e.pointerId)
		pointers.set(e.pointerId, local(e))
		anim = null
		untouched = false
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
			untouched = false
			const p = local(e)
			const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? viewH : 1
			const dx = e.deltaX * scale
			const dy = e.deltaY * scale
			// Pinch arrives as ctrl+wheel; a plain wheel or two-finger scroll zooms too, gently.
			if (e.ctrlKey || e.metaKey) zoomAt(p.x, p.y, camera.z * Math.exp(-Math.max(-50, Math.min(50, dy || dx)) * 0.01))
			else if (Math.abs(dx) > Math.abs(dy) * 1.5) {
				camera.x -= dx
				anim = null
				labelsDirty = true
			} else zoomAt(p.x, p.y, camera.z * Math.exp(-Math.max(-120, Math.min(120, dy)) * 0.002))
		},
		{ passive: false },
	)
	demo.addEventListener('keydown', (e) => {
		const step = e.shiftKey ? 120 : 40
		if (e.key === 'f') fit()
		else if (e.key === '=' || e.key === '+') zoomAt(viewW / 2, viewH / 2, camera.z * 1.25)
		else if (e.key === '-') zoomAt(viewW / 2, viewH / 2, camera.z / 1.25)
		else if (e.key === 'ArrowLeft') camera.x += step
		else if (e.key === 'ArrowRight') camera.x -= step
		else if (e.key === 'ArrowUp') camera.y += step
		else if (e.key === 'ArrowDown') camera.y -= step
		else return
		e.preventDefault()
		untouched = false
		labelsDirty = true
	})

	// ---------- loop ----------
	const gl = new DemoGL(canvas)
	const tickFns: ((dt: number, now: number) => void)[] = []
	let drawFn: (view: View) => void = () => {}
		new ResizeObserver(() => {
		const r = demo.getBoundingClientRect()
		viewW = r.width
		viewH = r.height
		// Until someone moves the camera, keep everything fitted as the box settles or resizes.
		if (untouched && viewW > 10) Object.assign(camera, fitCamera())
		labelsDirty = true
	}).observe(demo)

	let last = performance.now()
	const intervals: number[] = []
	let shownAt = 0
	const loop = (now: number) => {
		requestAnimationFrame(loop)
		const dtMs = Math.max(0, Math.min(100, now - last))
		last = now
		intervals.push(dtMs)
		if (intervals.length > 60) intervals.shift()
		if (now - shownAt > 500 && intervals.length > 5) {
			shownAt = now
			const f = 1000 / (intervals.reduce((a, b) => a + b, 0) / intervals.length)
			fps.textContent = `${Math.round(f)} fps`
			fps.dataset.fps = String(f)
		}
		if (anim) {
			const t = Math.min(1, (now - anim.start) / 480)
			const e = 1 - Math.pow(1 - t, 4)
			const { from, to } = anim
			const z = from.z * Math.pow(to.z / from.z, e)
			const cx = viewW / 2
			const cy = viewH / 2
			const fx = (cx - from.x) / from.z
			const fy = (cy - from.y) / from.z
			const px = fx + ((cx - to.x) / to.z - fx) * e
			const py = fy + ((cy - to.y) / to.z - fy) * e
			Object.assign(camera, { z, x: cx - px * z, y: cy - py * z })
			labelsDirty = true
			if (t >= 1) anim = null
		}
		if (labelsDirty) {
			placeLabels()
			labelsDirty = false
		}
		for (const fn of tickFns) fn(dtMs / 1000, now)
		try {
			drawFn({ camera, width: viewW, height: viewH, dpr: Math.min(devicePixelRatio || 1, 2) })
		} catch (e) {
			console.error(e)
		}
	}
	requestAnimationFrame(loop)

	/** For scripted captures. */
	;(window as unknown as { playground: unknown }).playground = {
		settings,
		focus(index: number, z: number, dx = 0, dy = 0) {
			const b = layout.sections[index].box
			Object.assign(camera, { z, x: viewW / 2 - (b.x + b.w / 2 + dx) * z, y: viewH / 2 - (b.y + b.h / 2 + dy) * z })
			anim = null
			untouched = false
			labelsDirty = true
		},
		frameScreenBox(index: number) {
			const b = layout.sections[index].box
			const r = demo.getBoundingClientRect()
			return { x: r.left + b.x * camera.z + camera.x, y: r.top + b.y * camera.z + camera.y, w: b.w * camera.z, h: b.h * camera.z }
		},
	}

	return {
		settings,
		save,
		section,
		setCaption,
		layout,
		frameLabels,
		gl,
		demo,
		onTick: (fn: (dt: number, now: number) => void) => tickFns.push(fn),
		onDraw: (fn: (view: View) => void) => (drawFn = fn),
		playground: (window as unknown as { playground: Record<string, unknown> }).playground,
	}
}

export { defaultFrames }
export type { FrameState }
