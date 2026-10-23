import { BRAIN, BRAIN_STILL, type BrainBlocks, type BrainFrame, type BrainSettings, type BrainView } from '../../render/busy/brain'
import type { EmberDots, EmberFrame, EmberView } from './ember'
import { range, select, SPEED, type ParamDef, type ParamValues } from '../shared/params'

export interface BusyVariant {
	id: string
	name: string
	/** one line on what it is and where it comes from, shown as the demo's caption */
	note: string
	params: ParamDef[]
	/** reduced motion: the time to freeze at, a pose that still reads as "busy" */
	still: number
	/** block variations (Brian's Brain, shared with the app): fill in the blocks for these frames at `t` */
	blocks?: (out: BrainBlocks, view: BrainView, frames: BrainFrame[], values: ParamValues, t: number) => void
	/** flow variations: `float field(Fx f)` (see flow.ts), seen through the dot grid */
	glsl?: string
	/** CPU flow variations (Ember clumps): fill in the dot grid for these frames at `t` */
	dots?: (out: EmberDots, view: EmberView, frames: EmberFrame[], values: ParamValues, t: number) => void
}

export const BLOCK_VARIANTS: BusyVariant[] = [
	{
		id: 'brain',
		name: 'Brian’s Brain',
		note: 'What busy frames show in the app (render/busy/brain.ts, with these defaults). A band round the frame runs Brian’s Brain, a three-state automaton (firing, dying, off): the edge row sparks at random and the rule turns the sparks into tiny gliders that crawl along and out of the band, firing bright and dying dim.',
		params: [
			{ ...SPEED, value: BRAIN.speed },
			range('cell', 'Cell', BRAIN.cell, 1, 10, 1, 'px'),
			range('gap', 'Gap', BRAIN.gap, 0, 4, 1, 'px'),
			range('depth', 'Band depth', BRAIN.depth, 1, 16, 1, 'cells'),
			range('step', 'Step', BRAIN.step, 0.03, 0.3, 0.01, 's'),
			range('spark', 'Edge sparks', BRAIN.spark, 0, 0.3, 0.005),
			range('dying', 'Dying cells', BRAIN.dying, 0, 1, 0.01),
			range('base', 'Edge glow', BRAIN.base, 0, 1, 0.01),
			range('falloff', 'Falloff', BRAIN.falloff, 0.2, 4, 0.05),
			range('peak', 'Intensity', BRAIN.peak, 0, 1, 0.01),
			select('color', 'Colour', ['session', 'white'], BRAIN.color),
		],
		still: BRAIN_STILL,
		blocks: (out, view, frames, values, t) => out.fill(view, frames, { ...BRAIN, ...values } as BrainSettings, t),
	},
]
