import type { ChromeVariation } from '../shared/chrome'
import { range, select, type ParamDef } from '../shared/params'

export type ConceptId = 'deck' | 'zoom' | 'focus' | 'peek'

export interface Concept extends ChromeVariation {
	id: ConceptId
}

const timing = (dur: number, stagger: number, ease: string): ParamDef[] => [
	range('dur', 'Duration', dur, 0, 1000, 10, 'ms'),
	range('stagger', 'Stagger', stagger, 0, 80, 1, 'ms'),
	select('ease', 'Easing', ['in-out', 'out', 'quart'], ease),
]

const deck = (o: { depth?: number; offset?: number; tilt?: number; persp?: number; falloff?: number; dim?: number; shadow?: number } = {}): ParamDef[] => [
	range('depth', 'Depth shown', o.depth ?? 3, 1, 6, 1),
	range('offset', 'Offset', o.offset ?? 40, 12, 96, 1, 'px'),
	range('minOff', 'Min offset', 7, 0, 20, 0.5, 'px'),
	range('tilt', 'Tilt', o.tilt ?? 10, -30, 30, 0.5, '°'),
	range('persp', 'Perspective', o.persp ?? 2400, 600, 6000, 50, 'px'),
	range('falloff', 'Scale falloff', o.falloff ?? 0.94, 0.8, 1, 0.005),
	range('dim', 'Dim per level', o.dim ?? 0.14, 0, 0.4, 0.01),
	range('shadow', 'Shadow', o.shadow ?? 0.7, 0, 1, 0.05),
]

export const CONCEPTS: Concept[] = [
	{
		id: 'zoom',
		name: 'Semantic zoom',
		note: 'Zoom drives it: far out, each flat frame keeps its subagents gathered around its bottom edge; zooming in deals them out into rows under it, held under the cursor.',
		params: [
			select('outLayout', 'Zoomed-out layout', ['tucked', 'dock', 'fan', 'tabs'], 'tucked'),
			range('zOut', 'Gathered below', 20, 5, 60, 1, '%'),
			range('zIn', 'Dealt above', 42, 10, 100, 1, '%'),
			range('cols', 'Grid columns', 3, 1, 4, 1),
			range('fanScale', 'Child scale', 0.5, 0.3, 1, 0.01, '×'),
			range('peel', 'Deal stagger', 0.06, 0, 0.15, 0.005),
			select('ease', 'Easing', ['in-out', 'out', 'quart'], 'in-out'),
			range('dur', 'Pin duration', 440, 0, 1000, 10, 'ms'),
			// Tucked
			range('depth', 'Depth shown', 4, 1, 8, 1),
			range('offset', 'Offset', 40, 8, 96, 1, 'px'),
			range('minOff', 'Min offset', 13, 0, 24, 0.5, 'px'),
			range('falloff', 'Scale falloff', 0.975, 0.85, 1, 0.005),
			range('jitter', 'Paper jitter', 0.5, 0, 2, 0.05),
			range('dim', 'Dim per level', 0.1, 0, 0.4, 0.01),
			// Dock
			range('perRow', 'Per row', 6, 2, 10, 1),
			select('overflow', 'Overflow', ['wrap', '+N'], 'wrap'),
			range('dockGap', 'Gap', 28, 0, 120, 1, 'px'),
			// Fan
			range('handSize', 'Card size', 0.21, 0.12, 0.5, 0.01, '×'),
			range('handStep', 'Step', 3.5, 1, 12, 0.25, '°'),
			range('arc', 'Arc radius', 10, 2, 20, 0.5, '×'),
			range('tuck', 'Tuck', 0.14, 0, 0.8, 0.01),
			range('maxHand', 'Max cards', 9, 3, 12, 1),
			// Tabs
			range('maxTabs', 'Tabs', 6, 2, 10, 1),
			range('tabStep', 'Step', 12, 0, 60, 1, 'px'),
			range('tabH', 'Tab height', 40, 16, 120, 1, 'px'),
			range('shadow', 'Shadow', 0.6, 0, 1, 0.05),
		],
	},
	{
		id: 'deck',
		name: '3D deck',
		note: 'Children sit behind the parent like a Wallet stack, one strip each; click the deck (or F) to deal them out beside it, a row for a few, rows for more; Esc gathers them.',
		params: [
			...deck(),
			select('fan', 'Fan layout', ['auto', 'row', 'grid', 'below'], 'auto'),
			range('fanScale', 'Fan scale', 0.6, 0.3, 1, 0.01, '×'),
			...timing(440, 36, 'in-out'),
		],
	},
	{
		id: 'focus',
		name: 'Focus mode',
		note: 'Double-click a session (or Enter) to step inside: the rest recedes under a scrim and its subagents lay out as their own canvas, running first; Esc steps back out.',
		params: [
			...deck({ depth: 3, tilt: 10 }),
			range('recede', 'Recede', 0.94, 0.8, 1, 0.005, '×'),
			range('scrim', 'Scrim', 0.88, 0, 1, 0.01),
			range('focusScale', 'Child scale', 1, 0.4, 1.2, 0.01, '×'),
			range('cols', 'Columns', 4, 1, 6, 1),
			...timing(480, 28, 'in-out'),
		],
	},
	{
		id: 'peek',
		name: 'Side peek',
		note: 'Hover a deck and its newest few slide out to the side as a fanned hand, floating over the canvas without reflowing it; point at one to lift it, click to deal them all.',
		params: [
			...deck({ depth: 3 }),
			range('peekCount', 'Peek count', 4, 1, 6, 1),
			range('peekScale', 'Peek scale', 0.6, 0.25, 0.9, 0.01, '×'),
			range('spread', 'Spread', 0.62, 0.2, 1.2, 0.01, '×'),
			range('drop', 'Drop', 28, 0, 200, 1, 'px'),
			range('angle', 'Turn', 12, 0, 45, 0.5, '°'),
			range('hoverDelay', 'Hover intent', 90, 0, 400, 10, 'ms'),
			select('fan', 'Click deals', ['auto', 'row', 'grid', 'below'], 'auto'),
			range('fanScale', 'Fan scale', 0.6, 0.3, 1, 0.01, '×'),
			...timing(300, 30, 'out'),
		],
	},
]

export const conceptOf = (id: string) => CONCEPTS.find((c) => c.id === id) ?? CONCEPTS[0]

/** Semantic zoom's params that apply whatever the zoomed-out layout (the rest belong to one layout each). */
export const ZOOM_COMMON = ['zOut', 'zIn', 'cols', 'fanScale', 'peel', 'ease', 'dur']

export type Ease = (t: number) => number

export const EASES: Record<string, Ease> = {
	'in-out': (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
	out: (t) => 1 - Math.pow(1 - t, 3),
	quart: (t) => 1 - Math.pow(1 - t, 4),
}
