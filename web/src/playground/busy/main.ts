import { DONE as DONE_DEFAULTS, EmberDots, envelope as busyEnvelope, type DoneSettings, type EmberFrame } from '../../render/busy/ember'
import { button, el, paramControl, switchControl } from '../shared/controls'
import { defaults, hexToRgb, pack, range, resolve, toggle, type ParamValues } from '../shared/params'
import { frameRows, optionsSection, paramsSection, restoreVariations, shareVariations, variationSection, type VariationSettings } from '../shared/panels'
import { createShell, defaultFrames, frameFromSaved } from '../shared/shell'
import { BlockBatch, BlockPass } from './blocks'
import { DotPass } from './dots'
import { FLOW_VARIANTS } from './fields'
import { FlowPass, type FlowFrame } from './flow'
import { BLOCK_VARIANTS, type BusyCtx } from './variants'

const VARIANTS = [...FLOW_VARIANTS, ...BLOCK_VARIANTS]

const DONE = [
	toggle('enabled', 'Resolve when done', DONE_DEFAULTS.enabled),
	range('fill', 'Fill', DONE_DEFAULTS.fill, 0.05, 0.6, 0.01, 's'),
	range('hold', 'Hold', DONE_DEFAULTS.hold, 0, 1, 0.01, 's'),
	range('fade', 'Fade', DONE_DEFAULTS.fade, 0.1, 1.5, 0.05, 's'),
]

const OPTIONS = [
	toggle('reduced', 'Reduced motion', matchMedia('(prefers-reduced-motion: reduce)').matches),
	toggle('desync', 'Offset frames in time', true),
]

interface BusySettings extends VariationSettings {
	done: ParamValues
}

const shell = createShell<BusySettings>({
	site: 'busy',
	title: 'Busy',
	storageKey: 'canvas-playground-busy-v6',
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
function envelope(i: number): [number, number] {
	const state = { working: !!settings.frames[i].working, since: since[i], finished: finished[i] }
	return busyEnvelope(state, clock, settings.done as unknown as DoneSettings, !!settings.options.reduced)
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

const flow = new FlowPass(shell.gl.gl, shell.gl.quadVao)
const packed = new Float32Array(32)
const dotPass = new DotPass(shell.gl.gl)
const dots = new EmberDots()

shell.onDraw((view) => {
	const v = variant()
	const values = settings.params[v.id]
	const { dpr, camera } = view
	const z = camera.z
	const reduced = !!settings.options.reduced
	const offset = (i: number) => (settings.options.desync ? i * 1.618 : 0)
	const t = reduced ? v.still : time

	// Flow variations: the field behind the dot grid, under the items (frames are translucent, items opaque).
	const between = v.dots
		? () => {
				const frames: EmberFrame[] = shell.layout.sections.map((s, i) => {
					const [presence, fill] = envelope(i)
					return { box: s.box, color: hexToRgb(settings.frames[i].color), offset: reduced ? 0 : offset(i) + i * 37, seed: i + 1, presence, fill }
				})
				v.dots!(dots, { x: camera.x, y: camera.y, z, width: view.width, height: view.height, dpr }, frames, values, t)
				dotPass.draw(dots)
			}
		: v.glsl
		? () => {
				pack(v.params, values, packed)
				const frames: FlowFrame[] = shell.layout.sections.map((s, i) => {
					const [presence, fill] = envelope(i)
					return { box: s.box, color: hexToRgb(settings.frames[i].color), offset: reduced ? 0 : offset(i) + i * 37, presence, fill }
				})
				const mask = [
					values.pitch as number,
					values.dot as number,
					values.shape === 'square' ? 1 : 0,
					['brightness', 'halftone', 'dither'].indexOf(values.mode as string),
					values.levels as number,
					values.base as number,
					values.peak as number,
					values.modulate as number,
				]
				flow.draw(view, v.id, v.params, v.glsl!, packed, mask, t, frames)
			}
		: undefined
	shell.gl.draw(view, shell.layout.sections.map((s) => ({ box: s.box })), [...shell.layout.items.values()], between)
	if (!v.draw) return

	batch.begin()
	shell.layout.sections.forEach((s, i) => {
		const [pres, fill] = envelope(i)
		if (pres <= 0.001) return
		const f = settings.frames[i]
		const col = values.color === 'white' ? [1, 1, 1] : hexToRgb(f.color)
		const floor = (values.floor as number) ?? 0
		const peak = (values.peak as number) ?? 1
		const levels = (values.levels as number) || 0
		const ctx: BusyCtx = {
			frame: { x: (s.box.x * z + camera.x) * dpr, y: (s.box.y * z + camera.y) * dpr, w: s.box.w * z * dpr, h: s.box.h * z * dpr },
			t: reduced ? v.still : time + offset(i),
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
		v.draw!(ctx)
	})
	pass.draw(batch)
})

Object.assign(shell.playground, {
	time: () => time,
	blocks: () => batch.n,
	dots: () => dots.n,
	select: (id: string) => document.querySelector<HTMLElement>(`[role="option"][data-id="${id}"]`)?.click(),
	setWorking: (on: boolean[]) => on.forEach((w, i) => setWorking(i, w)),
	/** Scripted captures: stop the clock, then step it by exact amounts. */
	pause: (on: boolean) => (paused = on),
	advance,
})
