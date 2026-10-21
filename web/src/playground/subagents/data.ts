/*
 * The demo canvas: eight sessions, each with a pool of up to twelve subagents (OpenCode child
 * sessions: an agent id, the subagent tool's description as the title, running or finished) and the
 * items they posted, as placeholder tiles.
 */

export type Status = 'busy' | 'done' | 'failed' | 'idle'

export interface Tile {
	/** width / height */
	a: number
	/** CSS background standing in for the image */
	bg: string
}

export interface Frame {
	id: string
	title: string
	/** the subagent's agent id (children only) */
	agent?: string
	color: string
	tiles: Tile[]
	status: Status
	/** last activity, on the demo clock (s) */
	at: number
	/** a running child that hasn't posted yet: shown as a ghost, if at all */
	ghost?: boolean
	parent: Frame | null
	/** in deck order: running first, then newest first */
	children: Frame[]
}

export const PALETTE = ['#f472b6', '#a78bfa', '#fb923c', '#4ade80', '#facc15', '#f87171', '#60a5fa', '#2dd4bf', '#e879f9', '#a3e635']

const AGENTS: Record<string, string> = { explore: 'Explore', general: 'General', review: 'Review', plan: 'Plan' }
export const agentName = (id: string | undefined) => (id ? (AGENTS[id] ?? id) : '')

interface ChildDef {
	agent: string
	title: string
	tiles: number
}

interface SessionDef {
	title: string
	color: string
	busy: boolean
	tiles: number[]
	count: number
	pool: ChildDef[]
}

const c = (agent: string, title: string, tiles = 2): ChildDef => ({ agent, title, tiles })

const SESSIONS: SessionDef[] = [
	{
		title: 'Canvas build: coordinator',
		color: PALETTE[6],
		busy: true,
		tiles: [1.6, 1.33, 1.78, 1, 1.5],
		count: 12,
		pool: [
			c('general', 'Subagent stacks: research + demos', 3),
			c('explore', 'Map the render loop', 1),
			c('general', 'Fix flaky upload test', 2),
			c('review', 'Review page items', 2),
			c('general', 'Busy v6: flow fields', 4),
			c('explore', 'Auth flow', 1),
			c('general', 'Precise highlight points', 3),
			c('general', 'Refactor uploads', 2),
			c('explore', 'Where do titles come from', 1),
			c('general', 'HTML side drawer', 2),
			c('review', 'Annotations consumed on read', 1),
			c('general', 'Pointer returns to its frame', 2),
		],
	},
	{
		title: 'Landing hero explorations',
		color: PALETTE[0],
		busy: true,
		tiles: [1.78, 1.78, 1.5, 1.33],
		count: 8,
		pool: [
			c('general', 'Hero variants: round 3', 4),
			c('general', 'Hero variants: round 2', 3),
			c('explore', 'Competitor heroes', 3),
			c('general', 'Type scale study', 2),
			c('review', 'Contrast + a11y pass', 1),
			c('general', 'Illustration directions', 3),
			c('explore', 'Brand assets in repo', 1),
			c('general', 'Motion for the hero', 2),
			c('general', 'Dark mode hero', 2),
			c('general', 'Mobile crops', 3),
			c('review', 'Copy review', 1),
			c('general', 'Hero video loop', 2),
		],
	},
	{
		title: 'Shader study: rounded SDF',
		color: PALETTE[1],
		busy: false,
		tiles: [1.33, 1, 1.5, 0.8],
		count: 3,
		pool: [
			c('explore', 'SDF references', 2),
			c('general', 'Corner smoothing', 3),
			c('general', 'AA at small sizes', 2),
			c('general', 'Squircle vs circle', 2),
			c('review', 'Perf on SwiftShader', 1),
			c('general', 'Stroke alignment', 2),
			c('general', 'Shadow falloff', 2),
			c('explore', 'Prior art in Skia', 1),
			c('general', 'Variable radius', 2),
			c('general', 'Inner shadows', 2),
			c('review', 'Shader review', 1),
			c('general', 'WebGPU port', 2),
		],
	},
	{
		title: 'Onboarding copy pass',
		color: PALETTE[3],
		busy: false,
		tiles: [0.62, 0.62, 0.62],
		count: 0,
		pool: [
			c('general', 'Welcome screen copy', 2),
			c('review', 'Tone check', 1),
			c('general', 'Empty states', 2),
			c('explore', 'Existing strings', 1),
			c('general', 'Error messages', 2),
			c('general', 'Tooltips', 1),
			c('general', 'Emails', 2),
			c('review', 'Legal review', 1),
			c('general', 'Localization notes', 1),
			c('general', 'Release notes', 2),
			c('general', 'FAQ', 1),
			c('general', 'Docs intro', 2),
		],
	},
	{
		title: 'Fix flaky upload test',
		color: PALETTE[2],
		busy: false,
		tiles: [2.2, 1.6],
		count: 2,
		pool: [
			c('explore', 'Find the race', 1),
			c('general', 'Fix test', 2),
			c('review', 'Review the fix', 1),
			c('general', 'Retry with backoff', 2),
			c('general', 'Add a regression test', 1),
			c('explore', 'Other flaky tests', 1),
			c('general', 'CI timing traces', 2),
			c('general', 'Mock clock', 1),
			c('general', 'Chunked uploads', 2),
			c('review', 'Second review', 1),
			c('general', 'Cleanup', 1),
			c('general', 'Docs', 1),
		],
	},
	{
		title: 'Perf: video pool',
		color: PALETTE[7],
		busy: true,
		tiles: [2.4, 1.78, 1.2],
		count: 5,
		pool: [
			c('general', 'Decoder reuse', 3),
			c('explore', 'Map video pool', 1),
			c('general', 'Frame pacing traces', 2),
			c('review', 'Memory review', 1),
			c('general', 'Poster frames', 3),
			c('general', 'Seek latency', 2),
			c('explore', 'Browser limits', 1),
			c('general', 'Offscreen pause', 2),
			c('general', 'Thumbnail atlas', 2),
			c('general', 'Hardware decode', 2),
			c('review', 'Perf review', 1),
			c('general', 'Pool size heuristics', 2),
		],
	},
	{
		title: 'Docs site redesign',
		color: PALETTE[4],
		busy: false,
		tiles: [1.5, 1.5, 1.33, 1.6, 1.2],
		count: 6,
		pool: [
			c('general', 'Navigation IA', 2),
			c('general', 'Code block styles', 3),
			c('explore', 'Current docs tree', 1),
			c('general', 'Search UI', 2),
			c('review', 'Readability pass', 1),
			c('general', 'Landing page', 3),
			c('general', 'API reference layout', 2),
			c('general', 'Dark theme', 2),
			c('explore', 'Analytics on docs', 1),
			c('general', 'Versioning switcher', 2),
			c('review', 'Link check', 1),
			c('general', 'Changelog page', 2),
		],
	},
	{
		title: 'Auth migration',
		color: PALETTE[5],
		busy: true,
		tiles: [1.78, 1.33],
		count: 4,
		pool: [
			c('explore', 'Auth flow', 1),
			c('general', 'Session tokens', 2),
			c('plan', 'Migration plan', 1),
			c('general', 'OAuth callback', 2),
			c('review', 'Security review', 1),
			c('general', 'Rotate keys', 1),
			c('general', 'Rate limits', 2),
			c('explore', 'Call sites', 1),
			c('general', 'Logout everywhere', 1),
			c('general', 'Passkeys', 2),
			c('review', 'Pen test notes', 1),
			c('general', 'Docs', 1),
		],
	},
]

export const MAX_CHILDREN = 12

/** mulberry32 */
function rng(seed: number) {
	return () => {
		seed |= 0
		seed = (seed + 0x6d2b79f5) | 0
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

function hexHue(hex: string) {
	const n = parseInt(hex.slice(1), 16)
	const r = ((n >> 16) & 255) / 255
	const g = ((n >> 8) & 255) / 255
	const b = (n & 255) / 255
	const max = Math.max(r, g, b)
	const min = Math.min(r, g, b)
	if (max === min) return 0
	const d = max - min
	const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
	return h * 60
}

/** A placeholder image: a muted two-tone gradient near the frame's hue, sometimes with a UI-ish block. */
function tile(r: () => number, hue: number, a: number): Tile {
	const h1 = hue + (r() - 0.5) * 70
	const h2 = h1 + 20 + r() * 50
	const s = 14 + r() * 22
	const l1 = 16 + r() * 10
	const l2 = 24 + r() * 14
	const angle = Math.round(r() * 360)
	const layers = [`linear-gradient(${angle}deg, hsl(${h1} ${s}% ${l1}%), hsl(${h2} ${s + 6}% ${l2}%))`]
	const kind = r()
	if (kind < 0.35) {
		// a soft disc, like a subject
		const x = Math.round(25 + r() * 50)
		const y = Math.round(30 + r() * 40)
		layers.unshift(`radial-gradient(circle at ${x}% ${y}%, hsl(${h2 + 30} ${s + 10}% ${l2 + 14}% / 0.55), transparent 32%)`)
	} else if (kind < 0.7) {
		// a few UI bars, like a screenshot
		const y = Math.round(18 + r() * 20)
		layers.unshift(
			`linear-gradient(hsl(0 0% 100% / 0.12), hsl(0 0% 100% / 0.12)) 10% ${y}% / 46% 7% no-repeat`,
			`linear-gradient(hsl(0 0% 100% / 0.07), hsl(0 0% 100% / 0.07)) 10% ${y + 14}% / 70% 5% no-repeat`,
			`linear-gradient(hsl(0 0% 100% / 0.07), hsl(0 0% 100% / 0.07)) 10% ${y + 24}% / 58% 5% no-repeat`,
		)
	}
	return { a, bg: layers.join(', ') }
}

const ASPECTS = [1.78, 1.6, 1.5, 1.33, 1.2, 1, 0.8, 2.2]

export interface World {
	sessions: Frame[]
	/** every child each session could have, in arrival order (pool[0] is the oldest) */
	pools: Frame[][]
}

export function buildWorld(): World {
	const sessions: Frame[] = []
	const pools: Frame[][] = []
	SESSIONS.forEach((d, si) => {
		const r = rng(1000 + si * 97)
		const hue = hexHue(d.color)
		const s: Frame = {
			id: `s${si}`,
			title: d.title,
			color: d.color,
			tiles: d.tiles.map((a) => tile(r, hue, a)),
			status: d.busy ? 'busy' : 'idle',
			at: 0,
			parent: null,
			children: [],
		}
		const pool = d.pool.map((cd, ci): Frame => {
			const color = PALETTE[(si * 3 + ci * 7 + 2) % PALETTE.length]
			const ch = hexHue(color)
			return {
				id: `s${si}c${ci}`,
				title: cd.title,
				agent: cd.agent,
				color,
				tiles: Array.from({ length: cd.tiles }, () => tile(r, ch, ASPECTS[Math.floor(r() * ASPECTS.length)])),
				status: 'done',
				at: 0,
				parent: s,
				children: [],
			}
		})
		// The pool is listed newest first; arrival order is the reverse.
		pool.reverse()
		sessions.push(s)
		pools.push(pool)
	})
	// One nested level, to show grandchildren: the coordinator's "Refactor uploads" ran three of its own.
	const refactor = pools[0].find((f) => f.title === 'Refactor uploads')!
	const r = rng(77)
	refactor.children = [
		['explore', 'Upload call sites', 1],
		['explore', 'Multipart edge cases', 2],
		['review', 'Review refactor', 1],
	].map(([agent, title, n], i) => ({
		id: `${refactor.id}g${i}`,
		title: title as string,
		agent: agent as string,
		color: PALETTE[(i * 4 + 5) % PALETTE.length],
		tiles: Array.from({ length: n as number }, () => tile(r, 200 + i * 60, ASPECTS[Math.floor(r() * ASPECTS.length)])),
		status: 'done' as Status,
		at: -600 - i * 30,
		parent: refactor,
		children: [],
	}))
	return { sessions, pools }
}

/** The starting state: each session shows its default number of subagents with a believable mix of running and done. */
export function defaultCounts() {
	return SESSIONS.map((d) => d.count)
}

/** Sets which children a session shows (the newest `n` of its pool) and when they last did something. */
export function applyCount(world: World, si: number, n: number, now: number) {
	const s = world.sessions[si]
	const pool = world.pools[si]
	n = Math.max(0, Math.min(pool.length, Math.round(n)))
	const keep = pool.slice(pool.length - n)
	for (const f of keep) {
		if (!s.children.includes(f)) {
			// New arrivals start running, on top.
			f.status = 'busy'
			f.at = now
			f.ghost = false
		}
	}
	s.children = keep
}

/** Seeds the default statuses: the first one or two children of a busy session are running, older ones done (one failed). */
export function seedStatuses(world: World) {
	world.sessions.forEach((s, si) => {
		const busy = s.status === 'busy'
		s.children.forEach((f, i) => {
			const fromTop = s.children.length - 1 - i
			f.at = -60 * (fromTop * 3 + 1 + (si % 3))
			f.status = busy && fromTop < (si === 0 ? 2 : 1) ? 'busy' : fromTop === 4 && si === 0 ? 'failed' : 'done'
			if (f.status === 'busy') f.at = 0
		})
	})
	// A running child that hasn't posted anything yet (shown only with ghosts on).
	const landing = world.sessions[1]
	const pool = world.pools[1]
	const unposted = pool.find((f) => !landing.children.includes(f))
	if (unposted) {
		unposted.ghost = true
		unposted.status = 'busy'
		unposted.at = 0
	}
}

/** Deck order: running first, then by last activity, newest first. */
export function deckOrder(children: Frame[]) {
	const rank = (f: Frame) => (f.status === 'busy' ? 0 : 1)
	return [...children].sort((a, b) => rank(a) - rank(b) || b.at - a.at)
}

export function relTime(at: number, now: number) {
	const s = Math.max(0, now - at)
	if (s < 45) return 'just now'
	const m = Math.round(s / 60)
	if (m < 60) return `${m}m`
	return `${Math.round(m / 60)}h`
}
