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
	select('fit', 'Fit', ['overlay', 'push', 'drawer', 'below'], 'push'),
	select('switch', 'Switching', ['morph', 'swap'], 'morph'),
	range('scale', 'Scale', 1, 0.4, 1, 0.01, '×'),
	range('dur', 'Duration', 360, 0, 1400, 10, 'ms'),
	select('ease', 'Easing', ['standard', 'decelerate', 'in-out'], 'standard'),
	range('stagger', 'Stagger', 40, 0, 120, 5, 'ms'),
]

/** Prototypes of the ideas in ideas.md. */
export const IDEA_PARAMS: ParamDef[] = [
	toggle('preview', 'Preview on hover', true),
	toggle('unread', 'New-item badges', true),
	toggle('group', 'Group by state', false),
]

/** The coordinator's subagent counts the panel offers. */
export const COUNTS = ['0', '1', '3', '8', '15', '20']
