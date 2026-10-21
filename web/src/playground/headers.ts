import { range, select, SPEED, toggle, type ParamDef, type ParamValues } from './params'

/**
 * Where a header variation can put things: before the title, under it (spanning its width), and
 * after it. The title stays the hero; all of these collapse to nothing with no subagents.
 */
export interface Slots {
	root: HTMLElement
	before: HTMLElement
	title: HTMLElement
	under: HTMLElement
	after: HTMLElement
}

/**
 * A subagent indicator for the frame title. Params become CSS custom properties on the label
 * (`--key`, with the param's unit), toggles `p-key` classes and selects `data-key` attributes, so
 * most of the motion is CSS (see playground.css, `.hv-<id>`); render reconciles the DOM for n.
 */
export interface HeaderVariant {
	id: string
	name: string
	blurb: string
	params: ParamDef[]
	render(slots: Slots, n: number, p: ParamValues): void
}

function el(tag: string, className = '', children: (Node | string)[] = []) {
	const e = document.createElement(tag)
	if (className) e.className = className
	for (const c of children) e.append(c)
	return e
}

function part(slot: HTMLElement, className: string, make: () => HTMLElement): HTMLElement {
	let e = slot.querySelector<HTMLElement>(`:scope > .${className}`)
	if (!e) slot.appendChild((e = make()))
	return e
}

/**
 * n live children in container: new ones get `.u` and `.in` a frame later (so CSS can transition
 * them in), extra ones get `.out` and leave once their transition is over.
 */
function sync(container: HTMLElement, n: number, make: (i: number) => HTMLElement) {
	const live = [...container.children].filter((c) => c.classList.contains('u') && !c.classList.contains('out')) as HTMLElement[]
	while (live.length < n) {
		const e = make(live.length)
		e.classList.add('u')
		e.style.setProperty('--i', String(live.length))
		container.appendChild(e)
		requestAnimationFrame(() => requestAnimationFrame(() => e.classList.add('in')))
		live.push(e)
	}
	while (live.length > n) {
		const e = live.pop()!
		e.classList.remove('in')
		e.classList.add('out')
		setTimeout(() => e.remove(), 450)
	}
	return live
}

/** A "+k" for agents past what's drawn. */
function overflow(container: HTMLElement, n: number, shown: number) {
	const more = part(container, 'more', () => el('span', 'more'))
	const label = n > shown ? `+${n - shown}` : ''
	if (more.textContent !== label && label) more.textContent = label
	more.classList.toggle('on', n > shown)
}

/** Deterministic per-index jitter so bars and phases look organic but don't change on re-render. */
const jitter = (i: number, salt = 0) => {
	const x = Math.sin((i + 1) * 12.9898 + salt * 78.233) * 43758.5453
	return x - Math.floor(x)
}

const BRAILLE_SETS = ['braille', 'orbit', 'arc', 'pulse']

export const HEADERS: HeaderVariant[] = [
	{
		id: 'dots',
		name: 'Pulse dots',
		blurb: 'One dot per subagent after the title, each breathing softly out of phase, like a row of quiet LEDs.',
		params: [
			SPEED,
			range('period', 'Period', 1.8, 0.6, 5, 0.05, 's'),
			range('phase', 'Phase step', 0.22, 0, 1, 0.01, 's'),
			range('size', 'Dot size', 0.16, 0.08, 0.3, 0.005, 'em'),
			range('gap', 'Gap', 0.12, 0.02, 0.4, 0.005, 'em'),
			range('lo', 'Low opacity', 0.28, 0, 1, 0.01),
			range('max', 'Max dots', 6, 1, 8, 1),
			toggle('glow', 'Glow', true),
		],
		render(s, n, p) {
			const wrap = part(s.after, 'dots', () => el('span', 'dots'))
			const shown = Math.min(n, p.max as number)
			sync(wrap, shown, () => el('span', 'dot', [el('i')]))
			overflow(s.after, n, shown)
		},
	},
	{
		id: 'pill',
		name: 'Counter pill',
		blurb: 'A small tinted pill with the count and a fine ring spinner; the number bumps when it changes.',
		params: [
			SPEED,
			range('period', 'Spin time', 1.1, 0.3, 4, 0.05, 's'),
			range('arc', 'Arc length', 28, 8, 80, 1, '%'),
			range('fill', 'Pill tint', 14, 0, 40, 1, '%'),
			range('fs', 'Size', 0.5, 0.35, 0.8, 0.01, 'em'),
			toggle('ring', 'Ring spinner', true),
			toggle('outline', 'Outline', true),
		],
		render(s, n) {
			const pill = part(s.after, 'pill', () => {
				const ns = 'http://www.w3.org/2000/svg'
				const svg = document.createElementNS(ns, 'svg')
				svg.setAttribute('viewBox', '0 0 20 20')
				svg.setAttribute('class', 'ring')
				for (const cls of ['track', 'arc']) {
					const c = document.createElementNS(ns, 'circle')
					c.setAttribute('cx', '10')
					c.setAttribute('cy', '10')
					c.setAttribute('r', '7.5')
					c.setAttribute('pathLength', '100')
					c.setAttribute('class', cls)
					svg.appendChild(c)
				}
				return el('span', 'pill', [svg, el('span', 'num')])
			})
			const num = pill.querySelector<HTMLElement>('.num')!
			const label = String(Math.max(n, 1))
			if (n > 0 && num.textContent !== label) {
				const had = num.textContent !== ''
				num.textContent = label
				if (had) {
					pill.classList.remove('bump')
					void pill.offsetWidth
					pill.classList.add('bump')
				}
			}
		},
	},
	{
		id: 'sheen',
		name: 'Title sheen',
		blurb: 'The title itself carries a slow light sweep in the session colour while subagents run, with a quiet count beside it.',
		params: [
			SPEED,
			range('period', 'Sweep time', 3.2, 1, 8, 0.05, 's'),
			range('w', 'Band width', 12, 3, 30, 0.5, '%'),
			range('strength', 'Strength', 85, 10, 100, 1, '%'),
			toggle('count', 'Show count', true),
			toggle('faster', 'Faster with more agents', true),
		],
		render(s, n, p) {
			const count = part(s.after, 'count', () => el('span', 'count'))
			if (n > 0) count.textContent = `${n}`
			s.root.style.setProperty('--per', p.faster ? String(1 + Math.min(n, 8) * 0.12) : '1')
		},
	},
	{
		id: 'orbit',
		name: 'Orbiting moons',
		blurb: 'A small session-coloured glyph before the title with one tiny moon per subagent circling it; moons re-space smoothly as the count changes.',
		params: [
			SPEED,
			range('period', 'Orbit time', 3.2, 0.8, 10, 0.05, 's'),
			range('r', 'Orbit radius', 0.3, 0.15, 0.45, 0.005, 'em'),
			range('moon', 'Moon size', 0.1, 0.04, 0.18, 0.005, 'em'),
			range('core', 'Core size', 0.16, 0.06, 0.3, 0.005, 'em'),
			toggle('track', 'Show orbit', true),
			toggle('twinkle', 'Twinkle', true),
		],
		render(s, n) {
			const orb = part(s.before, 'orb', () => el('span', 'orb', [el('span', 'track'), el('span', 'core'), el('span', 'moons')]))
			const moons = orb.querySelector<HTMLElement>('.moons')!
			moons.style.setProperty('--n', String(Math.max(n, 1)))
			const live = sync(moons, Math.min(n, 8), () => el('span', 'moon', [el('i')]))
			live.forEach((m, i) => m.style.setProperty('--i', String(i)))
		},
	},
	{
		id: 'scanner',
		name: 'Split underline',
		blurb: 'A hairline under the title splits into one segment per subagent; light runs through them like a scanner or fills them like progress.',
		params: [
			SPEED,
			range('period', 'Pass time', 2.2, 0.6, 6, 0.05, 's'),
			select('mode', 'Mode', ['scan', 'fill', 'pulse'], 'scan'),
			range('th', 'Thickness', 0.06, 0.02, 0.15, 0.005, 'em'),
			range('gap', 'Segment gap', 0.14, 0.02, 0.5, 0.01, 'em'),
			range('off', 'Offset', 0.02, -0.1, 0.25, 0.005, 'em'),
			range('rest', 'Resting tint', 22, 0, 60, 1, '%'),
		],
		render(s, n) {
			const bar = part(s.under, 'segs', () => el('span', 'segs'))
			bar.style.setProperty('--n', String(Math.max(n, 1)))
			const live = sync(bar, n, () => el('span', 'seg', [el('i')]))
			live.forEach((m, i) => m.style.setProperty('--i', String(i)))
		},
	},
	{
		id: 'eq',
		name: 'Equaliser',
		blurb: 'Tiny bars after the title, one per subagent, bouncing at their own tempo: the frame looks busy in proportion to the work.',
		params: [
			SPEED,
			range('period', 'Tempo', 1.1, 0.4, 3, 0.05, 's'),
			range('bw', 'Bar width', 0.09, 0.03, 0.16, 0.005, 'em'),
			range('bg', 'Bar gap', 0.06, 0.02, 0.2, 0.005, 'em'),
			range('bh', 'Max height', 0.56, 0.2, 0.9, 0.01, 'em'),
			range('lo', 'Rest height', 0.22, 0.05, 0.8, 0.01),
			toggle('fade', 'Fade by height', true),
		],
		render(s, n) {
			const eq = part(s.after, 'eq', () => el('span', 'eq'))
			sync(eq, n, (i) => {
				const b = el('span', 'bar', [el('i')])
				b.style.setProperty('--j', (0.7 + jitter(i) * 0.7).toFixed(3))
				b.style.setProperty('--k', (-jitter(i, 1)).toFixed(3))
				return b
			})
		},
	},
	{
		id: 'rolling',
		name: 'Rolling count',
		blurb: 'A quiet "· 3 agents" suffix in muted text; the digit rolls like an odometer when the count changes, with a small live dot.',
		params: [
			SPEED,
			range('roll', 'Roll time', 0.55, 0.15, 1.5, 0.01, 's'),
			range('fs', 'Size', 0.5, 0.35, 0.8, 0.01, 'em'),
			select('word', 'Word', ['agents', 'subagents', 'helpers', 'none'], 'agents'),
			select('sep', 'Separator', ['·', '—', '/', 'none'], '·'),
			toggle('live', 'Live dot', true),
			range('period', 'Live dot pulse', 1.6, 0.5, 4, 0.05, 's'),
		],
		render(s, n, p) {
			const wrap = part(s.after, 'agents', () =>
				el('span', 'agents', [el('span', 'sep'), el('span', 'live'), el('span', 'digits'), el('span', 'word')]),
			)
			const [sep, , digits, word] = wrap.children as unknown as HTMLElement[]
			sep.textContent = p.sep === 'none' ? '' : (p.sep as string)
			sep.hidden = p.sep === 'none'
			const shownN = Math.max(n, 1)
			const text = String(shownN)
			while (digits.children.length < text.length) {
				const col = el('span', 'col')
				for (let d = 0; d <= 9; d++) col.appendChild(el('span', '', [String(d)]))
				digits.appendChild(col)
			}
			while (digits.children.length > text.length) digits.lastElementChild!.remove()
			;[...digits.children].forEach((c, i) => (c as HTMLElement).style.setProperty('--d', text[i]))
			const w = p.word as string
			word.textContent = w === 'none' ? '' : shownN === 1 ? w.replace(/s$/, '') : w
			word.hidden = w === 'none'
		},
	},
	{
		id: 'stack',
		name: 'Agent stack',
		blurb: 'Overlapping little discs, one per subagent like an avatar stack, in tints of the session colour; a slow wave rolls through them.',
		params: [
			SPEED,
			range('period', 'Wave time', 2.4, 0.8, 6, 0.05, 's'),
			range('size', 'Disc size', 0.42, 0.18, 0.6, 0.005, 'em'),
			range('overlap', 'Overlap', 0.3, 0, 0.7, 0.01),
			range('lift', 'Wave lift', 0.06, 0, 0.2, 0.005, 'em'),
			range('max', 'Max discs', 5, 1, 8, 1),
			toggle('rings', 'Rings', true),
		],
		render(s, n, p) {
			const stack = part(s.after, 'stack', () => el('span', 'stack'))
			const shown = Math.min(n, p.max as number)
			sync(stack, shown, (i) => {
				const d = el('span', 'av', [el('i')])
				d.style.setProperty('--tone', String(Math.round(100 - ((i * 37) % 55))))
				return d
			})
			overflow(s.after, n, shown)
		},
	},
	{
		id: 'braille',
		name: 'Braille spinners',
		blurb: 'Terminal-flavoured: one tiny Braille spinner glyph per subagent, each a step out of phase, as text beside the title.',
		params: [
			SPEED,
			range('period', 'Cycle', 1, 0.3, 3, 0.05, 's'),
			select('set', 'Glyphs', BRAILLE_SETS, 'braille'),
			range('fs', 'Size', 0.7, 0.35, 1, 0.01, 'em'),
			range('phase', 'Phase step', 0.13, 0, 0.5, 0.01, 's'),
			toggle('perAgent', 'One per agent', true),
			toggle('count', 'Show count', false),
		],
		render(s, n, p) {
			const wrap = part(s.after, 'spins', () => el('span', 'spins'))
			sync(wrap, p.perAgent ? Math.min(n, 8) : Math.min(n, 1), () => el('span', 'spin'))
			const count = part(s.after, 'count', () => el('span', 'count'))
			if (n > 0) count.textContent = String(n)
		},
	},
]

/** Puts the variation's params on the label as CSS variables, classes and data attributes. */
export function applyParams(root: HTMLElement, variant: HeaderVariant, p: ParamValues) {
	for (const d of variant.params) {
		const v = p[d.key]
		if (d.type === 'range') root.style.setProperty(`--${d.key}`, `${v}${d.unit === '%' || d.unit === 'em' || d.unit === 's' ? d.unit : ''}`)
		else if (d.type === 'color') root.style.setProperty(`--${d.key}`, v as string)
		else if (d.type === 'toggle') root.classList.toggle(`p-${d.key}`, !!v)
		else root.dataset[d.key] = v as string
	}
}

/** The label markup the playground uses for frame titles (and the specimens). */
export function createHeader(title: string): Slots {
	const root = el('div', 'pg-hdr')
	const before = el('span', 'pg-before')
	const titleEl = el('span', 'title', [title])
	const under = el('span', 'pg-under')
	const after = el('span', 'pg-after')
	root.append(before, el('span', 'pg-tw', [titleEl, under]), after)
	return { root, before, title: titleEl, under, after }
}

/** Clears whatever a previous variation left in the slots. */
export function resetHeader(s: Slots) {
	for (const slot of [s.before, s.under, s.after]) slot.replaceChildren()
	s.root.className = 'pg-hdr'
	s.root.removeAttribute('style')
	for (const k of Object.keys(s.root.dataset)) delete s.root.dataset[k]
}
