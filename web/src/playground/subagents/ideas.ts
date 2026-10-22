import type { ChromeVariation } from '../shared/chrome'
import { range, select, toggle, type ParamDef } from '../shared/params'

export type IdeaId = 'column' | 'deck' | 'tabs' | 'pull'

export interface Idea extends ChromeVariation {
	id: IdeaId
}

const placement = (scale: number): ParamDef[] => [
	range('scale', 'Child scale', scale, 0.5, 1, 0.01, '×'),
	range('gutter', 'Gutter', 180, 80, 480, 4, 'px'),
	range('gap', 'Gap between', 48, 16, 160, 2, 'px'),
]

const motion = (dur: number, stagger: number): ParamDef[] => [range('dur', 'Duration', dur, 0, 800, 10, 'ms'), range('stagger', 'Stagger', stagger, 0, 80, 1, 'ms')]

export const IDEAS: Idea[] = [
	{
		id: 'column',
		name: 'Flat column',
		note: 'Each session’s subagents sit in a column to its right as mini session frames at their natural size, top-aligned, joined by lines; neighbours move over to make room.',
		params: [...placement(0.75), ...motion(380, 28)],
	},
	{
		id: 'deck',
		name: 'Stacked deck',
		note: 'Subagents stacked on top of each other at full size (a wide one stays wide), offset a little; click the stack (or Expand) to deal it into a column, Stack gathers it again.',
		params: [...placement(0.75), range('offset', 'Offset', 22, 6, 80, 1, 'px'), range('shadow', 'Shadow', 0.7, 0, 1, 0.05), ...motion(400, 30)],
	},
	{
		id: 'tabs',
		name: 'Peeking titles',
		note: 'Stacked, but each card behind shows its title strip like a tab, so every subagent can be read and has its own line; click a title to bring it to the front, or expand them all.',
		params: [...placement(0.75), range('shadow', 'Shadow', 0.6, 0, 1, 0.05), ...motion(380, 30)],
	},
	{
		id: 'pull',
		name: 'Pull out',
		note: 'A stack of title tabs you pull subagents out of one at a time: click a title and that frame slides into a column above the stack; click it again (or Stack all) to put it back.',
		params: [...placement(0.75), range('shadow', 'Shadow', 0.6, 0, 1, 0.05), ...motion(380, 30)],
	},
]

export const ideaOf = (id: string) => IDEAS.find((i) => i.id === id) ?? IDEAS[0]

export const CONNECTOR_PARAMS: ParamDef[] = [
	select('kind', 'Line', ['elbow', 'bus', 'curve', 'curved bus'], 'bus'),
	range('width', 'Thickness', 1.5, 0.5, 4, 0.25, 'px'),
	select('color', 'Colour', ['session', 'child', 'neutral'], 'session'),
	range('opacity', 'Opacity', 0.75, 0.1, 1, 0.05),
	toggle('dashed', 'Dashed', false),
	select('ends', 'Ends', ['none', 'dot', 'square'], 'dot'),
	select('from', 'From parent', ['title', 'middle'], 'title'),
	select('to', 'To child', ['title', 'middle'], 'title'),
	range('radius', 'Corner radius', 6, 0, 24, 1, 'px'),
]
