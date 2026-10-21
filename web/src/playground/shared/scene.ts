import type { Item, Session } from '../../../../shared/types'
import { computeLayout, shiftSection, type Layout } from '../../editor/layout'

/** An example session frame and the status it's showing. */
export interface FrameState {
	id: string
	title: string
	color: string
	working: boolean
	subagents: number
}

const SESSION_COLORS = ['#f472b6', '#a78bfa', '#fb923c', '#4ade80', '#facc15', '#f87171', '#60a5fa', '#2dd4bf', '#e879f9', '#a3e635']

interface Example {
	title: string
	color: string
	working: boolean
	subagents: number
	groups: { name: string | null; aspects: number[] }[]
}

const EXAMPLES: Example[] = [
	{
		title: 'Canvas build: coordinator',
		color: SESSION_COLORS[6],
		working: true,
		subagents: 3,
		groups: [
			{ name: 'Frame status playground', aspects: [1.6, 1.33, 1.78] },
			{ name: 'Earlier sketches', aspects: [1, 0.75, 1.5, 1.2] },
		],
	},
	{
		title: 'Shader study: rounded SDF',
		color: SESSION_COLORS[1],
		working: true,
		subagents: 0,
		groups: [{ name: null, aspects: [1.33, 1, 1.5, 0.8, 1.78] }],
	},
	{
		title: 'Onboarding copy pass',
		color: SESSION_COLORS[3],
		working: false,
		subagents: 0,
		groups: [{ name: 'Welcome screens', aspects: [0.62, 0.62, 0.62] }],
	},
	{
		title: 'Landing hero explorations',
		color: SESSION_COLORS[0],
		working: true,
		subagents: 8,
		groups: [
			{ name: 'Round 2', aspects: [1.78, 1.78] },
			{ name: 'Round 1', aspects: [1.5, 1.33, 1, 1.6] },
		],
	},
	{
		title: 'Fix flaky upload test',
		color: SESSION_COLORS[2],
		working: false,
		subagents: 1,
		groups: [{ name: null, aspects: [2.2, 1.6] }],
	},
	{
		title: 'Perf: video pool',
		color: SESSION_COLORS[7],
		working: true,
		subagents: 5,
		groups: [{ name: 'Traces', aspects: [2.4, 1.78, 1.2] }],
	},
]

export function defaultFrames(): FrameState[] {
	return EXAMPLES.map((e, i) => ({ id: `s${i}`, title: e.title, color: e.color, working: e.working, subagents: e.subagents }))
}

export { SESSION_COLORS }

const COLUMNS = 3
const ROW_GAP = 220

/**
 * The example frames laid out by the app's own layout (computeLayout: frame padding, title strip,
 * group headings, justified rows), then wrapped into rows of three so they fit the demo box.
 */
export function buildLayout(frames: FrameState[]): Layout {
	const sessions: Record<string, Session> = {}
	const items: Record<string, Item> = {}
	frames.forEach((f, i) => {
		sessions[f.id] = { id: f.id, canvasId: 'playground', title: f.title, createdAt: i }
		const ex = EXAMPLES[i % EXAMPLES.length]
		let t = 1000
		ex.groups.forEach((g, gi) =>
			g.aspects.forEach((a, ai) => {
				const id = `${f.id}-${gi}-${ai}`
				items[id] = {
					id,
					canvasId: 'playground',
					sessionId: f.id,
					kind: 'image',
					name: id,
					src: '',
					thumb: '',
					width: Math.round(800 * a),
					height: 800,
					group: g.name ?? undefined,
					createdAt: t--,
				}
			}),
		)
	})
	let layout = computeLayout(sessions, items, frames.map((f) => f.id))
	let rowTop = 0
	for (let r = 0; r * COLUMNS < layout.sections.length; r++) {
		const row = layout.sections.slice(r * COLUMNS, r * COLUMNS + COLUMNS)
		const left = row[0].box.x
		for (const s of row) layout = shiftSection(layout, s.id, -left, rowTop)
		rowTop += Math.max(...row.map((s) => s.box.h)) + ROW_GAP
	}
	return layout
}
