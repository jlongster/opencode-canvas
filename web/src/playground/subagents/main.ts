import './indicators.css'
import { button, el, numberField } from '../shared/controls'
import { defaults, hexToRgb, range, toggle } from '../shared/params'
import { frameRows, optionsSection, paramsSection, restoreVariations, shareVariations, variationSection, type VariationSettings } from '../shared/panels'
import { createShell, createTitle, defaultFrames, frameFromSaved, type TitleSlots } from '../shared/shell'
import { applyParams, INDICATORS, type Instance } from './indicators'

const OPTIONS = [
	toggle('reduced', 'Reduced motion', matchMedia('(prefers-reduced-motion: reduce)').matches),
	toggle('hairline', 'Working frames: static hairline', true),
	toggle('simulate', 'Simulate activity', false),
]

const SPECIMENS = [0, 1, 3, 8]
const below = el('div', 'pg-specimens')
const specimenSlots: { n: number; slots: TitleSlots }[] = SPECIMENS.map((n) => {
	const slots = createTitle('Coordinator')
	below.append(el('div', 'pg-spec', slots.root, el('span', 'pg-spec-n', n === 1 ? '1 agent' : `${n} agents`)))
	return { n, slots }
})

const shell = createShell<VariationSettings>({
	site: 'subagents',
	title: 'Subagents',
	storageKey: 'canvas-playground-subagents-v2',
	below,
	defaults: () => ({
		variant: INDICATORS[0].id,
		params: Object.fromEntries(INDICATORS.map((v) => [v.id, defaults(v.params)])),
		options: defaults(OPTIONS),
		frames: defaultFrames(),
	}),
	restore(saved, s) {
		restoreVariations(saved, s, INDICATORS, OPTIONS)
		if (Array.isArray(saved.f))
			s.frames = s.frames.map((f, i) => {
				const [n, c] = (saved.f as [number, string][])[i] ?? []
				return frameFromSaved(f, { subagents: n, color: c })
			})
	},
	share: (s) => ({ ...shareVariations(s, INDICATORS, OPTIONS), f: s.frames.map((f) => [f.subagents, f.color]) }),
	exportJson: (s) => {
		const v = INDICATORS.find((x) => x.id === s.variant)!
		return { site: 'subagents', variant: { id: v.id, name: v.name, params: s.params[v.id] } }
	},
})

const { settings } = shell
const indicator = () => INDICATORS.find((v) => v.id === settings.variant)!
const values = () => settings.params[settings.variant]

// ---------- titles ----------

interface Mounted {
	slots: TitleSlots
	n: () => number
	color: () => string
	instance: Instance | null
	variant: string
}

const mounted: Mounted[] = [
	...shell.frameLabels.map(({ slots }, i) => ({ slots, n: () => settings.frames[i].subagents, color: () => settings.frames[i].color, instance: null, variant: '' })),
	...specimenSlots.map(({ slots, n }) => ({ slots, n: () => n, color: () => settings.frames[0].color, instance: null, variant: '' })),
]

function mixWhite(hex: string, m: number) {
	const [r, g, b] = hexToRgb(hex).map((c) => Math.round((c + (1 - c) * m) * 255))
	return `rgb(${r} ${g} ${b})`
}

function paint() {
	const v = indicator()
	const p = values()
	for (const m of mounted) {
		if (m.variant !== v.id) {
			m.instance?.destroy()
			m.instance = v.mount(m.slots.after)
			m.variant = v.id
		}
		const r = m.slots.after.lastElementChild as HTMLElement
		r.style.setProperty('--c', m.color())
		r.style.setProperty('--c-hi', mixWhite(m.color(), 0.38))
		applyParams(r, v.params, p)
		m.instance!.update(m.n(), p)
	}
}

const applyReduced = () => {
	shell.demo.classList.toggle('pg-reduced', !!settings.options.reduced)
	below.classList.toggle('pg-reduced', !!settings.options.reduced)
}

// ---------- panel ----------

const refreshCaption = () => shell.setCaption(indicator().name, indicator().note)

variationSection(shell, INDICATORS, () => settings.variant, (id) => {
	settings.variant = id
	params.render()
	refreshCaption()
	paint()
	shell.save()
})
const onParam = () => {
	paint()
	shell.save()
}
const params = paramsSection(shell, 'Parameters', () => indicator().params, values, onParam, () => (settings.params[settings.variant] = defaults(indicator().params)))

const COUNT = range('n', 'Subagents', 0, 0, 8, 1)
const framesBody = shell.section('Frames')
const countFields: { update: () => void }[] = []
function renderFrames() {
	countFields.length = 0
	framesBody.replaceChildren(
		...frameRows(
			settings.frames,
			(f) => {
				const field = numberField(
					COUNT,
					() => f.subagents,
					(v) => {
						const n = Math.round(Math.min(8, Math.max(0, v)))
						if (n === f.subagents) return
						f.subagents = n
						field.update()
						paint()
						shell.save()
					},
				)
				field.el.title = 'Subagents: drag to scrub, click to type'
				field.el.querySelector('input')!.setAttribute('aria-label', `${f.title}: subagents`)
				field.el.dataset.frame = f.id
				countFields.push(field)
				return [field.el]
			},
			() => {
				paint()
				shell.save()
			},
		),
		el(
			'div',
			'pg-buttons',
			button('Randomise', () => {
				for (const f of settings.frames) f.subagents = randomCount()
				refresh()
			}, '', true),
			button('All 3', () => {
				for (const f of settings.frames) f.subagents = 3
				refresh()
			}, '', true),
			button('None', () => {
				for (const f of settings.frames) f.subagents = 0
				refresh()
			}, '', true),
		),
	)
}
const refresh = () => {
	for (const c of countFields) c.update()
	paint()
	shell.save()
}
const randomCount = () => {
	const r = Math.random()
	return r < 0.25 ? 0 : r < 0.5 ? 1 : 1 + Math.ceil(Math.random() * 7)
}
renderFrames()

optionsSection(shell, 'Preview', OPTIONS, settings.options, () => {
	applyReduced()
	shell.save()
})

refreshCaption()
applyReduced()
paint()

// ---------- loop ----------

let simulateIn = 1.5
shell.onTick((dt) => {
	const p = values()
	if (!settings.options.reduced) for (const m of mounted) m.instance?.tick?.(dt, p)
	if (settings.options.simulate) {
		simulateIn -= dt
		if (simulateIn <= 0) {
			simulateIn = 1.2 + Math.random() * 2.4
			const f = settings.frames[Math.floor(Math.random() * settings.frames.length)]
			f.subagents = Math.max(0, Math.min(8, f.subagents + (Math.random() < 0.5 ? -1 : 1)))
			for (const c of countFields) c.update()
			paint()
		}
	}
})

shell.onDraw((view) => {
	const frames = shell.layout.sections.map((s, i) => {
		const f = settings.frames[i]
		if (!settings.options.hairline || !f.working) return { box: s.box }
		// A quiet, static "working" state: the frame's 1px stroke in the session colour at 35%.
		const [r, g, b] = hexToRgb(f.color).map((c) => c * 0.35)
		return { box: s.box, stroke: [r, g, b, 0.35] as [number, number, number, number] }
	})
	shell.gl.draw(view, frames, [...shell.layout.items.values()])
})

Object.assign(shell.playground, {
	select: (id: string) => document.querySelector<HTMLElement>(`[role="option"][data-id="${id}"]`)?.click(),
	setCounts: (ns: number[]) => {
		ns.forEach((n, i) => (settings.frames[i].subagents = n))
		refresh()
	},
})

