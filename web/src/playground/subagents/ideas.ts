import { range, select, toggle, type ParamDef } from '../shared/params'

/** How the frames, headers, lists and expanded subagents are arranged (the same for every representation). */
export const LAYOUT_PARAMS: ParamDef[] = [
	select('head', 'Header', ['line', 'meta', 'dot'], 'line'),
	range('title', 'Title size', 14, 12, 20, 1, 'px'),
	select('list', 'Subagents', ['gap', 'inside'], 'gap'),
	select('color', 'Dot colour', ['parent', 'own'], 'parent'),
	range('summaryAt', 'Summary below', 320, 120, 640, 10, 'px'),
	toggle('busy', 'Busy band', true),
]

export const EXPAND_PARAMS: ParamDef[] = [
	select('expand', 'Place', ['below', 'right', 'inline'], 'below'),
	select('motion', 'Motion', ['fade', 'grow'], 'fade'),
	range('scale', 'Scale', 0.75, 0.4, 1, 0.01, '×'),
	range('dur', 'Duration', 440, 0, 1000, 10, 'ms'),
	select('ease', 'Easing', ['standard', 'decelerate', 'in-out'], 'standard'),
	range('stagger', 'Stagger', 40, 0, 120, 5, 'ms'),
]

export const HEAD_NOTES: Record<string, string> = {
	line: 'Title, then its state, controls at the right of the same line.',
	meta: 'Title and controls, with a muted line under it: state, agent, subagents, last activity.',
	dot: 'Neutral title after a small dot square, the only colour; controls show on hover.',
}

/** The coordinator's subagent counts the panel offers. */
export const COUNTS = ['0', '1', '3', '8', '14', '20']
