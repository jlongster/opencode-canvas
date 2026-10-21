import './font'
import './ui.css'
import { button, el, listbox, paramControl } from './controls'
import { changed, resolve, type ParamDef, type ParamValues } from './params'
import { SESSION_COLORS } from './scene'
import { BASE, SITES } from './shell'

/*
 * The playground's shell without a scene: toolbar, site tabs, the demo box, the panel, settings kept
 * in localStorage and the URL hash, and a frame loop with an fps readout. createShell draws the
 * example frames itself; a site that renders its own scene (and owns its camera) uses this instead.
 */

export interface ChromeOptions<S> {
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
}

export function createChrome<S>(opts: ChromeOptions<S>) {
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
			const shared = JSON.stringify(opts.share(settings))
			localStorage.setItem(opts.storageKey, shared)
			history.replaceState(null, '', `#s=${encodeURIComponent(shared)}`)
		}, 150)
	}

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
	const caption = el('div', 'pg-caption')
	demo.append(caption)
	const main = el('main', 'pg-main', toolbar, demo)
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

	const tickFns: ((dtMs: number, now: number) => void)[] = []
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
		for (const fn of tickFns) {
			try {
				fn(dtMs, now)
			} catch (e) {
				console.error(e)
			}
		}
	}
	requestAnimationFrame(loop)

	return {
		settings,
		save,
		section,
		setCaption,
		demo,
		toolbar,
		panelBody,
		setZoom: (z: number) => (zoom.textContent = `${Math.round(z * 100)}%`),
		/** runs every animation frame with the elapsed ms (clamped to 100) */
		onTick: (fn: (dtMs: number, now: number) => void) => tickFns.push(fn),
	}
}

export type Chrome = ReturnType<typeof createChrome>

/** A variation as a site without createShell lists it. */
export interface ChromeVariation {
	id: string
	name: string
	note: string
	params: ParamDef[]
}

/** The variation listbox; number keys pick one too (when focus isn't in a field). */
export function chromeVariations(chrome: Pick<Chrome, 'section'>, variants: ChromeVariation[], current: string, onSelect: (id: string) => void) {
	const list = listbox(
		variants.map((v, i) => ({ id: v.id, name: v.name, key: String(i + 1), title: v.note })),
		current,
		onSelect,
		'Variation',
	)
	chrome.section('Variation').append(list.el)
	window.addEventListener('keydown', (e) => {
		if ((e.target as HTMLElement).closest('input, textarea, [role="slider"]') || e.metaKey || e.ctrlKey || e.altKey) return
		const i = Number(e.key) - 1
		if (Number.isInteger(i) && i >= 0 && i < variants.length) list.select(variants[i].id)
	})
	return list
}

/** Param controls under a heading with a Reset action; render() rebuilds them (e.g. after the variation changes). */
export function chromeParams(chrome: Pick<Chrome, 'section'>, title: string, defs: () => ParamDef[], values: () => ParamValues, onChange: () => void, reset: () => void) {
	const resetButton = button('Reset', () => {
		reset()
		render()
		onChange()
	}, 'ghost', true)
	const body = chrome.section(title, resetButton)
	const render = () => body.replaceChildren(...defs().map((d) => paramControl(d, values(), onChange, SESSION_COLORS)))
	render()
	return { render }
}

/** Saved values for each variation's params, taking what's valid and defaults for the rest. */
export function restoreParams(variants: ChromeVariation[], saved: unknown, into: Record<string, ParamValues>) {
	const p = (saved ?? {}) as Record<string, ParamValues>
	for (const v of variants) if (p[v.id]) into[v.id] = resolve(v.params, { ...into[v.id], ...p[v.id] })
}

/** Only the params that differ from their defaults, per variation (what the URL hash carries). */
export function shareParams(variants: ChromeVariation[], values: Record<string, ParamValues>) {
	const p: Record<string, ParamValues> = {}
	for (const v of variants) {
		const c = changed(v.params, values[v.id])
		if (Object.keys(c).length) p[v.id] = c
	}
	return p
}
