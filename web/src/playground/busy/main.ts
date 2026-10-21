import { button, el, paramControl, switchControl } from '../shared/controls'
import { defaults, hexToRgb, range, resolve, toggle, type ParamValues } from '../shared/params'
import { frameRows, optionsSection, paramsSection, restoreVariations, shareVariations, variationSection, type VariationSettings } from '../shared/panels'
import { createShell, defaultFrames, frameFromSaved } from '../shared/shell'
import { BlockBatch, BlockPass } from './blocks'
import { easeOut, VARIANTS, type BusyCtx } from './variants'

const DONE = [
	toggle('enabled', 'Resolve when done', true),
	range('fill', 'Fill', 0.2, 0.05, 0.6, 0.01, 's'),
	range('hold', 'Hold', 0.15, 0, 1, 0.01, 's'),
	range('fade', 'Fade', 0.7, 0.1, 1.5, 0.05, 's'),
]

const OPTIONS = [
	toggle('reduced', 'Reduced motion', matchMedia('(prefers-reduced-motion: reduce)').matches),
	toggle('desync', 'Offset frames in time', true),
]

/** Enter: the indicator rises from its unlit floor over this long (ease-out). */
const ENTER = 0.3

interface BusySettings extends VariationSettings {
	done: ParamValues
}

const shell = createShell<BusySettings>({
	site: 'busy',
	title: 'Busy',
	storageKey: 'canvas-playground-busy-v4',
	defaults: () => ({
		variant: VARIANTS[0].id,
		params: Object.fromEntries(VARIANTS.map((v) => [v.id, defaults(v.params)])),
		options: defaults(OPTIONS),
		done: defaults(DONE),
		frames: defaultFrames(),
	}),
	restore(saved, s) {
		restoreVariations(saved, s, VARIANTS, OPTIONS)
		if (saved.d) s.done = resolve(DONE, { ...s.done, ...(saved.d as ParamValues) })
		if (Array.isArray(saved.f))
			s.frames = s.frames.map((f, i) => {
				const [w, c] = (saved.f as [number, string][])[i] ?? []
				return frameFromSaved(f, { working: w === undefined ? undefined : !!w, color: c })
			})
	},
	share: (s) => ({
		...shareVariations(s, VARIANTS, OPTIONS),
		d: Object.fromEntries(Object.entries(s.done).filter(([k, v]) => DONE.find((d) => d.key === k)!.value !== v)),
		f: s.frames.map((f) => [f.working ? 1 : 0, f.color]),
	}),
	exportJson: (s) => {
		const v = VARIANTS.find((x) => x.id === s.variant)!
		return { site: 'busy', variant: { id: v.id, name: v.name, params: s.params[v.id] }, done: s.done }
	},
})

const { settings } = shell
const variant = () => VARIANTS.find((v) => v.id === settings.variant)!

const refreshCaption = () => shell.setCaption(variant().name, variant().note)

variationSection(shell, VARIANTS, () => settings.variant, (id) => {
	settings.variant = id
	params.render()
	refreshCaption()
	shell.save()
})
const params = paramsSection(
	shell,
	'Parameters',
	() => variant().params,
	() => settings.params[settings.variant],
	shell.save,
	() => (settings.params[settings.variant] = defaults(variant().params)),
)

shell
	.section('Done', button('Finish all', () => settings.frames.forEach((_, i) => setWorking(i, false)), 'ghost', true))
	.append(...DONE.map((d) => paramControl(d, settings.done, shell.save)))

// ---------- frames ----------

let clock = 0
/** when each frame last started or stopped working (clock s); -Infinity = always so */
const since = settings.frames.map(() => -Infinity)
/** whether stopping should play the done resolve (it was working, not just loaded idle) */
const finished = settings.frames.map(() => false)

function setWorking(i: number, on: boolean) {
	const f = settings.frames[i]
	if (f.working === on) return
	finished[i] = f.working && !on
	f.working = on
	since[i] = clock
	renderFrames()
	shell.save()
}

const framesBody = shell.section('Frames')
function renderFrames() {
	framesBody.replaceChildren(
		...frameRows(
			settings.frames,
			(f, i) => {
				const sw = switchControl(f.working, (on) => setWorking(i, on))
				sw.setAttribute('aria-label', `${f.title} is working`)
				sw.dataset.frame = String(i)
				return [sw]
			},
			() => shell.save(),
		),
		el(
			'div',
			'pg-buttons',
			button('Randomise', () => settings.frames.forEach((_, i) => setWorking(i, Math.random() < 0.6)), '', true),
			button('All working', () => settings.frames.forEach((_, i) => setWorking(i, true)), '', true),
			button('All done', () => settings.frames.forEach((_, i) => setWorking(i, false)), '', true),
		),
	)
}
renderFrames()

optionsSection(shell, 'Preview', OPTIONS, settings.options, shell.save)
refreshCaption()

// ---------- presence ----------

/** How present the indicator is (0..1) and how far the done fill has gone (0..1). */
function presence(i: number): [number, number] {
	const dt = clock - since[i]
	if (settings.frames[i].working) return [easeOut(Math.min(1, dt / ENTER)), 0]
	if (!finished[i]) return [0, 0]
	const d = settings.done
	if (settings.options.reduced || !d.enabled) return [1 - easeOut(Math.min(1, dt / 0.2)), 0]
	const fill = d.fill as number
	const hold = d.hold as number
	const fade = d.fade as number
	return [1 - easeOut(Math.min(1, Math.max(0, (dt - fill - hold) / fade))), easeOut(Math.min(1, dt / fill))]
}

// ---------- loop ----------

const pass = new BlockPass(shell.gl.gl)
const batch = new BlockBatch()
let time = 0
let paused = false
const advance = (dt: number) => {
	clock += dt
	if (!settings.options.reduced) time += dt * (settings.params[settings.variant].speed as number)
}
shell.onTick((dt) => {
	if (!paused) advance(dt)
})

shell.onDraw((view) => {
	const v = variant()
	const values = settings.params[v.id]
	const { dpr, camera } = view
	const z = camera.z
	const reduced = !!settings.options.reduced
	shell.gl.draw(view, shell.layout.sections.map((s) => ({ box: s.box })), [...shell.layout.items.values()])

	batch.begin()
	shell.layout.sections.forEach((s, i) => {
		const [pres, fill] = presence(i)
		if (pres <= 0.001) return
		const f = settings.frames[i]
		const col = values.color === 'white' ? [1, 1, 1] : hexToRgb(f.color)
		const floor = (values.floor as number) ?? 0
		const peak = (values.peak as number) ?? 1
		const levels = (values.levels as number) || 0
		const ctx: BusyCtx = {
			frame: { x: (s.box.x * z + camera.x) * dpr, y: (s.box.y * z + camera.y) * dpr, w: s.box.w * z * dpr, h: s.box.h * z * dpr },
			t: reduced ? v.still : time + (settings.options.desync ? i * 1.618 : 0),
			reduced,
			dpr,
			z,
			p: values,
			key: `${v.id}:${i}`,
			px: (css) => Math.max(1, Math.round(css * dpr)),
			cell: (x, y, w, h, level, weight = 1) => {
				// Done: the pattern gives way to a bright rim that falls off outward (weight³), then fades.
				let l = Math.max(Math.min(1, Math.max(0, level)) * (1 - fill), fill * weight * weight * weight)
				if (levels > 0) l = Math.round(l * levels) / levels
				if (floor > 0) batch.add(x, y, w, h, 1, 1, 1, floor * pres)
				if (l > 0) batch.add(x, y, w, h, col[0], col[1], col[2], peak * l * pres)
			},
		}
		v.draw(ctx)
	})
	pass.draw(batch)
})

Object.assign(shell.playground, {
	time: () => time,
	blocks: () => batch.n,
	select: (id: string) => document.querySelector<HTMLElement>(`[role="option"][data-id="${id}"]`)?.click(),
	setWorking: (on: boolean[]) => on.forEach((w, i) => setWorking(i, w)),
	/** Scripted captures: stop the clock, then step it by exact amounts. */
	pause: (on: boolean) => (paused = on),
	advance,
})
