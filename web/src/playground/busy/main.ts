import { button, el, paramControl, switchControl } from '../shared/controls'
import { defaults, hexToRgb, pack, range, resolve, toggle, type ParamValues } from '../shared/params'
import { frameRows, optionsSection, paramsSection, restoreVariations, shareVariations, variationSection, type VariationSettings } from '../shared/panels'
import { createShell, defaultFrames, frameFromSaved } from '../shared/shell'
import { LightPass, type LitFrame } from './light'
import { VARIANTS } from './variants'

const DONE = [
	toggle('enabled', 'Flash when done', true),
	range('duration', 'Duration', 1.3, 0.4, 3, 0.05, 's'),
	range('travel', 'Travel', 20, 0, 60, 1, 'px'),
	range('intensity', 'Intensity', 0.6, 0, 1.5, 0.01),
]

const OPTIONS = [
	toggle('reduced', 'Reduced motion', matchMedia('(prefers-reduced-motion: reduce)').matches),
	toggle('pageUnits', 'Widths in page units', false),
	toggle('desync', 'Offset frames in time', true),
]

interface BusySettings extends VariationSettings {
	done: ParamValues
}

const shell = createShell<BusySettings>({
	site: 'busy',
	title: 'Busy',
	storageKey: 'canvas-playground-busy-v2',
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
		return { site: 'busy', variant: { id: v.id, name: v.name, params: s.params[v.id] }, done: s.done, pageUnits: s.options.pageUnits }
	},
})

const { settings } = shell
const variant = () => VARIANTS.find((v) => v.id === settings.variant)!
const light = new LightPass(shell.gl.gl, shell.gl.quadVao)
for (const v of VARIANTS) light.prepare(v)

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
	.section('Done flash', button('Flash all', () => settings.frames.forEach((_, i) => flash(i)), 'ghost', true))
	.append(...DONE.map((d) => paramControl(d, settings.done, shell.save)))

// ---------- frames ----------

const work = settings.frames.map((f) => (f.working ? 1 : 0))
const doneAt = settings.frames.map(() => -1)
let clock = 0

function flash(i: number) {
	doneAt[i] = clock
}

function setWorking(i: number, on: boolean) {
	const f = settings.frames[i]
	if (f.working && !on) flash(i)
	f.working = on
}

const framesBody = shell.section('Frames')
function renderFrames() {
	framesBody.replaceChildren(
		...frameRows(
			settings.frames,
			(f, i) => {
				const sw = switchControl(f.working, (on) => {
					setWorking(i, on)
					shell.save()
				})
				sw.setAttribute('aria-label', `${f.title} is working`)
				sw.dataset.frame = String(i)
				return [sw]
			},
			() => shell.save(),
		),
		el(
			'div',
			'pg-buttons',
			button('Randomise', () => {
				settings.frames.forEach((_, i) => setWorking(i, Math.random() < 0.6))
				renderFrames()
				shell.save()
			}, '', true),
			button('All working', () => {
				settings.frames.forEach((_, i) => setWorking(i, true))
				renderFrames()
				shell.save()
			}, '', true),
			button('All done', () => {
				settings.frames.forEach((_, i) => setWorking(i, false))
				renderFrames()
				shell.save()
			}, '', true),
		),
	)
}
renderFrames()

optionsSection(shell, 'Preview', OPTIONS, settings.options, shell.save)
refreshCaption()

// ---------- loop ----------

const packed = new Float32Array(32)
let time = 0
shell.onTick((dt) => {
	clock += dt
	const values = settings.params[settings.variant]
	if (!settings.options.reduced) time += dt * (values.speed as number)
	settings.frames.forEach((f, i) => {
		const target = f.working ? 1 : 0
		// Ease in over ~0.5s and out over ~0.8s (exponential approach: no overshoot, no snap).
		work[i] += (target - work[i]) * (1 - Math.exp(-dt / (target > work[i] ? 0.18 : 0.3)))
		if (Math.abs(target - work[i]) < 0.002) work[i] = target
	})
})

shell.onDraw((view) => {
	const v = variant()
	const values = settings.params[v.id]
	pack(v.params, values, packed)
	const d = settings.done
	const frames: LitFrame[] = shell.layout.sections.map((s, i) => ({
		box: s.box,
		color: hexToRgb(settings.frames[i].color),
		work: work[i],
		done: doneAt[i] < 0 || clock - doneAt[i] > (d.duration as number) ? -1 : clock - doneAt[i],
		offset: settings.options.desync ? i * 1.618 : 0,
	}))
	shell.gl.draw(view, shell.layout.sections.map((s) => ({ box: s.box })), [...shell.layout.items.values()], () =>
		light.draw(view, frames, {
			variant: v,
			values,
			packed,
			time,
			pageUnits: !!settings.options.pageUnits,
			reduced: !!settings.options.reduced,
			done: [d.duration as number, d.travel as number, d.intensity as number, d.enabled ? 1 : 0],
		}),
	)
})

Object.assign(shell.playground, {
	time: () => time,
	select: (id: string) => document.querySelector<HTMLElement>(`[role="option"][data-id="${id}"]`)?.click(),
	setWorking: (on: boolean[]) => {
		on.forEach((w, i) => setWorking(i, w))
		renderFrames()
	},
})
