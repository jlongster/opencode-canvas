import { button, el, listbox, paramControl, swatch } from './controls'
import { changed, resolve, type ParamDef, type ParamValues } from './params'
import { SESSION_COLORS, type FrameState } from './scene'
import type { createShell } from './shell'

type Shell = ReturnType<typeof createShell>

export interface Variation {
	id: string
	name: string
	note: string
	params: ParamDef[]
}

/** The state both sites keep: which variation, every variation's params, options and frames. */
export interface VariationSettings {
	variant: string
	params: Record<string, ParamValues>
	options: ParamValues
	frames: FrameState[]
}

export function restoreVariations(saved: Record<string, unknown>, into: VariationSettings, variants: Variation[], options: ParamDef[]) {
	if (typeof saved.v === 'string' && variants.some((v) => v.id === saved.v)) into.variant = saved.v
	const p = (saved.p ?? {}) as Record<string, ParamValues>
	for (const v of variants) if (p[v.id]) into.params[v.id] = resolve(v.params, { ...into.params[v.id], ...p[v.id] })
	if (saved.o) into.options = resolve(options, { ...into.options, ...(saved.o as ParamValues) })
}

export function shareVariations(s: VariationSettings, variants: Variation[], options: ParamDef[]) {
	const p: Record<string, ParamValues> = {}
	for (const v of variants) {
		const c = changed(v.params, s.params[v.id])
		if (Object.keys(c).length) p[v.id] = c
	}
	return { v: s.variant, p, o: changed(options, s.options) }
}

/** The variation list; number keys pick one too (when focus isn't in a field). */
export function variationSection(shell: Shell, variants: Variation[], current: () => string, onSelect: (id: string) => void) {
	const list = listbox(
		variants.map((v, i) => ({ id: v.id, name: v.name, key: String(i + 1), title: v.note })),
		current(),
		onSelect,
		'Variation',
	)
	shell.section('Variation').append(list.el)
	window.addEventListener('keydown', (e) => {
		if ((e.target as HTMLElement).closest('input, textarea, [role="slider"]') || e.metaKey || e.ctrlKey || e.altKey) return
		const i = Number(e.key) - 1
		if (Number.isInteger(i) && i >= 0 && i < variants.length) list.select(variants[i].id)
	})
	return list
}

/** A section of param controls with a Reset action; call render() after the variation changes. */
export function paramsSection(shell: Shell, title: string, defs: () => ParamDef[], values: () => ParamValues, onChange: () => void, reset: () => void) {
	const resetButton = button('Reset', () => {
		reset()
		render()
		onChange()
	}, 'ghost', true)
	const body = shell.section(title, resetButton)
	const render = () => body.replaceChildren(...defs().map((d) => paramControl(d, values(), onChange, SESSION_COLORS)))
	render()
	return { render }
}

export function optionsSection(shell: Shell, title: string, defs: ParamDef[], values: ParamValues, onChange: () => void) {
	shell.section(title).append(...defs.map((d) => paramControl(d, values, onChange, SESSION_COLORS)))
}

/** One row per example frame: colour, title, then the site's own controls. */
export function frameRows(frames: FrameState[], controls: (f: FrameState, i: number) => HTMLElement[], onColor: (i: number) => void) {
	return frames.map((f, i) =>
		el(
			'div',
			'pg-frame',
			swatch(f.color, SESSION_COLORS, (c) => {
				f.color = c
				onColor(i)
			}, `Colour of ${f.title}`),
			el('span', 't', f.title),
			el('span', 'controls', ...controls(f, i)),
		),
	)
}
