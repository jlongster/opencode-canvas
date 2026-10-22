import { range, select, toggle, type ParamDef } from '../shared/params'

const prefersReduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** The title row and the frames (the same for every technique). */
export const ROW_PARAMS: ParamDef[] = [
	range('title', 'Title size', 14, 12, 20, 1, 'px'),
	range('max', 'Before +N', 8, 2, 20, 1),
	toggle('reduced', 'Reduced motion', prefersReduced),
	toggle('busy', 'Busy band', true),
]

export const EXPAND_PARAMS: ParamDef[] = [
	range('scale', 'Scale', 0.75, 0.4, 1, 0.01, '×'),
	range('dur', 'Duration', 440, 0, 1000, 10, 'ms'),
	select('ease', 'Easing', ['standard', 'decelerate', 'in-out'], 'standard'),
	range('stagger', 'Stagger', 40, 0, 120, 5, 'ms'),
]

/** The coordinator's subagent counts the panel offers. */
export const COUNTS = ['0', '1', '3', '8', '15', '20']
