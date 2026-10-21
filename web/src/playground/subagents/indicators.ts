import { el } from '../shared/controls'
import { range, select, SPEED, toggle, type ParamDef, type ParamValues } from '../shared/params'

/**
 * A subagent indicator that sits right after a frame title, sized in em of the title (so it scales
 * with it). Params arrive as CSS custom properties on the indicator (`--key`), toggles as `p-key`
 * classes and selects as `data-key`; most motion is CSS (indicators.css), the rest is `tick`.
 */
export interface Indicator {
	id: string
	name: string
	note: string
	params: ParamDef[]
	mount(slot: HTMLElement): Instance
}

export interface Instance {
	update(n: number, p: ParamValues): void
	tick?(dt: number, p: ParamValues): void
	destroy(): void
}

/** Applies params as CSS variables, classes and data attributes on the indicator's root. */
export function applyParams(root: HTMLElement, defs: ParamDef[], p: ParamValues) {
	for (const d of defs) {
		const v = p[d.key]
		if (d.type === 'range') root.style.setProperty(`--${d.key}`, `${v}${d.unit === 'em' || d.unit === 's' || d.unit === '%' || d.unit === '°' ? (d.unit === '°' ? 'deg' : d.unit) : ''}`)
		else if (d.type === 'toggle') root.classList.toggle(`p-${d.key}`, !!v)
		else if (d.type === 'select') root.dataset[d.key] = v as string
		else root.style.setProperty(`--${d.key}`, v as string)
	}
}

/**
 * A number that changes by sliding: the old value leaves and the new one arrives in the direction
 * of the change (up when it grows), 260ms on an ease-out, after Emil Kowalski's number transitions.
 */
function rollingNumber(className = '') {
	const wrap = el('span', `sa-roll ${className}`)
	let value: string | null = null
	return {
		el: wrap,
		set(text: string, up: boolean) {
			if (text === value) return
			const first = value === null
			value = text
			const next = el('span', 'v', text)
			if (!first) {
				for (const old of wrap.querySelectorAll<HTMLElement>('.v:not(.leave)')) {
					old.classList.add('leave', up ? 'up' : 'down')
					setTimeout(() => old.remove(), 300)
				}
				next.classList.add('enter', up ? 'up' : 'down')
				requestAnimationFrame(() => requestAnimationFrame(() => next.classList.remove('enter')))
			}
			wrap.append(next)
		},
	}
}

/** n live children; extras fade out (`.out`) before they go, new ones fade in (`.in` a frame later). */
function sync(container: HTMLElement, n: number, make: (i: number) => HTMLElement) {
	const live = [...container.children].filter((c) => c.classList.contains('u') && !c.classList.contains('out')) as HTMLElement[]
	while (live.length < n) {
		const e = make(live.length)
		e.classList.add('u')
		e.style.setProperty('--i', String(live.length))
		container.append(e)
		requestAnimationFrame(() => requestAnimationFrame(() => e.classList.add('in')))
		live.push(e)
	}
	while (live.length > n) {
		const e = live.pop()!
		e.classList.remove('in')
		e.classList.add('out')
		setTimeout(() => e.remove(), 320)
	}
	return live
}

function root(slot: HTMLElement, id: string, ...children: Node[]) {
	const r = el('span', `sa sa-${id}`, ...children)
	slot.append(r)
	return r
}

const SVG = 'http://www.w3.org/2000/svg'
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}) {
	const e = document.createElementNS(SVG, tag)
	for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v))
	return e
}

let gradientId = 0

export const INDICATORS: Indicator[] = [
	{
		id: 'badge',
		name: 'Ring badge',
		note: 'You read the count at a glance in a tinted capsule. A 1.5px indeterminate ring in the iOS/Material rhythm carries the motion, and digits slide the way the count changed.',
		params: [
			SPEED,
			range('size', 'Size', 0.42, 0.3, 0.6, 0.01, 'em'),
			range('tint', 'Tint', 12, 0, 30, 1, '%'),
			range('weight', 'Ring weight', 2, 1, 3.5, 0.1),
			toggle('ring', 'Ring', true),
			toggle('outline', 'Outline', true),
		],
		mount(slot) {
			const ring = svg('svg', { viewBox: '0 0 24 24', class: 'ring', 'aria-hidden': 'true' })
			ring.append(svg('circle', { cx: 12, cy: 12, r: 9, class: 'track', pathLength: 100 }), svg('circle', { cx: 12, cy: 12, r: 9, class: 'arc', pathLength: 100 }))
			const num = rollingNumber('num')
			const r = root(slot, 'badge', el('span', 'cap', ring, num.el))
			let last = 0
			return {
				update(n) {
					r.classList.toggle('on', n > 0)
					if (n > 0) num.set(String(n), n >= last)
					if (n > 0) last = n
				},
				destroy: () => r.remove(),
			}
		},
	},
	{
		id: 'dots',
		name: 'Wave dots',
		note: 'One dot per agent, with a wave of opacity passing through them on a 1.6s ease-in-out. You can count them up to six, and the motion stays a whisper.',
		params: [
			SPEED,
			range('period', 'Period', 1.6, 0.8, 4, 0.05, 's'),
			range('dot', 'Dot', 0.13, 0.06, 0.22, 0.005, 'em'),
			range('gap', 'Gap', 0.11, 0.04, 0.24, 0.005, 'em'),
			range('stagger', 'Stagger', 0.14, 0, 0.4, 0.01, 's'),
			range('low', 'Rest opacity', 0.25, 0, 1, 0.01),
			range('max', 'Max dots', 6, 2, 8, 1),
		],
		mount(slot) {
			const dots = el('span', 'dots')
			const more = el('span', 'more')
			const r = root(slot, 'dots', dots, more)
			return {
				update(n, p) {
					r.classList.toggle('on', n > 0)
					const shown = Math.min(n, p.max as number)
					sync(dots, shown, () => el('span', 'dot', el('i')))
					if (n > shown) more.textContent = `+${n - shown}`
					more.classList.toggle('on', n > shown)
				},
				destroy: () => r.remove(),
			}
		},
	},
	{
		id: 'ticker',
		name: 'Ticker',
		note: 'Tabular, slashed-zero digits that roll like an odometer, next to one tick mark that lights fast and fades slowly each second. It reads like a clock, not a spinner.',
		params: [
			SPEED,
			range('period', 'Tick', 1, 0.4, 3, 0.05, 's'),
			range('size', 'Size', 0.46, 0.3, 0.6, 0.01, 'em'),
			select('shape', 'Tick', ['bar', 'dot'], 'bar'),
			select('word', 'Word', ['agents', 'subagents', 'none'], 'agents'),
			toggle('pad', 'Two digits', true),
		],
		mount(slot) {
			const tick = el('span', 'tick')
			const digits = el('span', 'digits')
			const word = el('span', 'word')
			const r = root(slot, 'ticker', tick, digits, word)
			return {
				update(n, p) {
					r.classList.toggle('on', n > 0)
					if (n === 0) return
					const text = p.pad ? String(n).padStart(2, '0') : String(n)
					while (digits.children.length < text.length) {
						const col = el('span', 'col')
						for (let d = 0; d <= 9; d++) col.append(el('span', '', String(d)))
						digits.append(col)
					}
					while (digits.children.length > text.length) digits.lastElementChild!.remove()
					;[...digits.children].forEach((c, i) => (c as HTMLElement).style.setProperty('--d', text[i]))
					const w = p.word as string
					word.textContent = w === 'none' ? '' : n === 1 ? w.replace(/s$/, '') : w
					word.hidden = w === 'none'
				},
				destroy: () => r.remove(),
			}
		},
	},
	{
		id: 'spark',
		name: 'Sparkline',
		note: 'A trace of agent activity scrolls right to left. It shows that work is happening and how bursty it is, with no number to parse, and grows busier with more agents.',
		params: [
			SPEED,
			range('w', 'Width', 1.9, 1, 3.5, 0.05, 'em'),
			range('h', 'Height', 0.5, 0.3, 0.8, 0.01, 'em'),
			range('history', 'History', 28, 12, 60, 1),
			range('stroke', 'Stroke', 1.25, 0.75, 2.5, 0.05),
			toggle('fill', 'Area fill', true),
			toggle('count', 'Count', true),
		],
		mount(slot) {
			const gid = `sa-grad-${++gradientId}`
			const chart = svg('svg', { class: 'chart', viewBox: '0 0 100 30', preserveAspectRatio: 'none', 'aria-hidden': 'true' })
			const defs = svg('defs')
			const fade = svg('linearGradient', { id: gid, x1: 0, x2: 1, y1: 0, y2: 0 })
			fade.append(svg('stop', { offset: '0', 'stop-color': 'white', 'stop-opacity': 0 }), svg('stop', { offset: '0.35', 'stop-color': 'white', 'stop-opacity': 1 }))
			const mask = svg('mask', { id: `${gid}-m`, maskContentUnits: 'objectBoundingBox' })
			mask.append(svg('rect', { x: 0, y: 0, width: 1, height: 1, fill: `url(#${gid})` }))
			defs.append(fade, mask)
			const g = svg('g', { mask: `url(#${gid}-m)` })
			const scroll = svg('g')
			const area = svg('path', { class: 'area' })
			const line = svg('path', { class: 'line' })
			scroll.append(area, line)
			g.append(scroll)
			chart.append(defs, g)
			const head = el('span', 'head')
			const count = el('span', 'count')
			const r = root(slot, 'spark', el('span', 'plot', chart, head), count)
			let n = 0
			let samples: number[] = []
			let acc = 0
			let t = Math.random() * 100
			const seeds = Array.from({ length: 8 }, () => [Math.random() * 6.28, 0.7 + Math.random() * 1.6, 1.3 + Math.random() * 2.2])
			const sample = () => {
				// Each agent contributes a slow wobble times a faster flutter, with occasional quiet spells.
				let s = 0
				for (let i = 0; i < Math.max(n, 1); i++) {
					const [ph, f1, f2] = seeds[i]
					const a = 0.5 + 0.5 * Math.sin(t * f1 + ph)
					const b = 0.6 + 0.4 * Math.sin(t * f2 * 1.7 + ph * 2.1)
					s += a * b
				}
				s /= Math.max(n, 1)
				return Math.min(1, 0.12 + 0.78 * s * (0.75 + 0.25 * Math.min(n, 8) / 8) + (Math.random() - 0.5) * 0.08)
			}
			const draw = (p: ParamValues) => {
				const N = p.history as number
				const step = 100 / (N - 2)
				const pts = samples.map((v, i) => [i * step, 28 - v * 26] as const)
				if (pts.length < 2) return
				let d = `M${pts[0][0].toFixed(2)},${pts[0][1].toFixed(2)}`
				for (let i = 0; i < pts.length - 1; i++) {
					const p0 = pts[Math.max(0, i - 1)]
					const p1 = pts[i]
					const p2 = pts[i + 1]
					const p3 = pts[Math.min(pts.length - 1, i + 2)]
					// Catmull-Rom as cubic Béziers: smooth through every sample, no overshooting spikes.
					const c1x = p1[0] + (p2[0] - p0[0]) / 6
					const c1y = p1[1] + (p2[1] - p0[1]) / 6
					const c2x = p2[0] - (p3[0] - p1[0]) / 6
					const c2y = p2[1] - (p3[1] - p1[1]) / 6
					d += ` C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`
				}
				line.setAttribute('d', d)
				area.setAttribute('d', `${d} L${pts[pts.length - 1][0].toFixed(2)},30 L0,30 Z`)
			}
			const seed = (p: ParamValues) => {
				samples = []
				for (let i = 0; i < (p.history as number); i++) {
					t += 0.14
					samples.push(sample())
				}
				draw(p)
			}
			return {
				update(next, p) {
					n = next
					r.classList.toggle('on', n > 0)
					if (n > 0) count.textContent = String(n)
					if (samples.length !== (p.history as number)) seed(p)
				},
				tick(dt, p) {
					if (n === 0) return
					const interval = 0.14
					acc += dt * (p.speed as number)
					while (acc >= interval) {
						acc -= interval
						t += interval
						samples.push(sample())
						if (samples.length > (p.history as number)) samples.shift()
						draw(p)
					}
					const step = 100 / ((p.history as number) - 2)
					scroll.setAttribute('transform', `translate(${(-(acc / interval) * step).toFixed(3)} 0)`)
					// The head dot sits where the line leaves the plot.
					const N = samples.length
					const frac = acc / interval
					const yv = samples[N - 2] + (samples[N - 1] - samples[N - 2]) * frac
					head.style.top = `${((28 - yv * 26) / 30) * 100}%`
				},
				destroy: () => r.remove(),
			}
		},
	},
	{
		id: 'dial',
		name: 'Dial',
		note: 'A small ring with one arc per agent, lit in turn with a fading trail. It reads as several things in turn and stays legible down to 13px titles.',
		params: [
			SPEED,
			range('step', 'Step', 0.42, 0.15, 1.2, 0.01, 's'),
			range('size', 'Size', 0.62, 0.3, 0.9, 0.01, 'em'),
			range('weight', 'Weight', 2.6, 1.2, 4, 0.1),
			range('gap', 'Gap', 30, 0, 80, 1, '°'),
			range('rest', 'Rest opacity', 0.26, 0, 0.6, 0.01),
			select('mode', 'Mode', ['sweep', 'fill', 'breathe'], 'sweep'),
		],
		mount(slot) {
			const dial = svg('svg', { viewBox: '0 0 24 24', class: 'dialsvg', 'aria-hidden': 'true' })
			const r = root(slot, 'dial', dial)
			let n = 0
			let segs: SVGPathElement[] = []
			let t = 0
			let builtFor = ''
			const build = (p: ParamValues) => {
				const key = `${n}:${p.gap}`
				if (key === builtFor) return
				builtFor = key
				dial.replaceChildren()
				segs = []
				const count = Math.max(n, 1)
				const span = 360 / count
				// Gaps never eat more than 40% of an arc, so eight agents still read as a ring.
				const gap = count === 1 ? Math.max(p.gap as number, 24) : Math.min(p.gap as number, span * 0.4)
				const rad = 9
				for (let i = 0; i < count; i++) {
					const a0 = ((-90 + i * span + gap / 2) * Math.PI) / 180
					const a1 = ((-90 + (i + 1) * span - gap / 2) * Math.PI) / 180
					const large = a1 - a0 > Math.PI ? 1 : 0
					const d = `M${12 + rad * Math.cos(a0)},${12 + rad * Math.sin(a0)} A${rad},${rad} 0 ${large} 1 ${12 + rad * Math.cos(a1)},${12 + rad * Math.sin(a1)}`
					const seg = svg('path', { d, class: 'seg' })
					dial.append(seg)
					segs.push(seg)
				}
			}
			const paint = (p: ParamValues) => {
				const count = segs.length
				const rest = p.rest as number
				const phase = t / (p.step as number)
				segs.forEach((s, i) => {
					let a: number
					if (p.mode === 'fill') {
						// Light one more each step, hold the full ring a beat, then clear.
						const cyc = phase % (count + 1.5)
						a = cyc >= count + 0.6 ? Math.max(0, 1 - (cyc - count - 0.6) * 1.6) : Math.min(1, Math.max(0, cyc - i))
					} else if (p.mode === 'breathe' || count === 1) {
						a = 0.5 - 0.5 * Math.cos(((phase / 3 + i * 0.12) % 1) * Math.PI * 2)
					} else {
						const d = (((phase - i) % count) + count) % count
						a = d < 1 ? 1 - d * 0.35 : Math.exp(-(d - 1) * 1.4) * 0.65
					}
					s.style.opacity = String(rest + (1 - rest) * a)
				})
			}
			return {
				update(next, p) {
					n = next
					r.classList.toggle('on', n > 0)
					if (n > 0) build(p)
					paint(p)
				},
				tick(dt, p) {
					if (n === 0) return
					t += dt * (p.speed as number)
					paint(p)
				},
				destroy: () => r.remove(),
			}
		},
	},
	{
		id: 'label',
		name: 'Shimmer label',
		note: 'Plain words in the title’s own typography, like “3 agents”, with a slow light passing across them: quiet text in the Linear/Raycast way that only shimmers while something runs.',
		params: [
			SPEED,
			range('period', 'Period', 2.8, 1.2, 6, 0.05, 's'),
			range('size', 'Size', 0.46, 0.3, 0.6, 0.01, 'em'),
			range('strength', 'Highlight', 80, 20, 100, 1, '%'),
			select('wording', 'Wording', ['agents', 'running', 'working'], 'agents'),
			toggle('sep', 'Separator', true),
		],
		mount(slot) {
			const sep = el('span', 'sep', '·')
			const num = rollingNumber('num')
			const word = el('span', 'word')
			const r = root(slot, 'label', sep, num.el, word)
			let last = 0
			return {
				update(n, p) {
					r.classList.toggle('on', n > 0)
					if (n === 0) return
					num.set(String(n), n >= last)
					last = n
					const w = p.wording === 'running' ? 'running' : p.wording === 'working' ? (n === 1 ? 'agent working' : 'agents working') : n === 1 ? 'agent' : 'agents'
					word.textContent = w
				},
				destroy: () => r.remove(),
			}
		},
	},
]
