import type { Item, Session } from '../../../../shared/types'
import { sessionColor } from '../../../../shared/sessionColor'
import type { KidState } from '../../render/subagents/field'

/*
 * The demo canvas, in memory: five sessions with 14, 3, 0, 8 and 1 subagents (child sessions,
 * titled "<Agent>: <what it was asked>" as OpenCode names them) and the items every one of them
 * posted. The coordinator has 20 defined so its count can go from 0 to 20. Colours are the app's own
 * (sessionColor), so the busy band, the badges and the subagent dots agree. Images are drawn in the browser.
 */

export interface DemoKid {
	id: string
	title: string
	agent: string
	task: string
	state: KidState
	/** s before boot it started, and (finished ones) how long it ran */
	startedAgo: number
	ran: number
}

export interface DemoFamily {
	parentId: string
	title: string
	color: string
	busy: boolean
	agent: string
	unread: number
	asking: boolean
	/** in the order the session started them */
	kids: DemoKid[]
	/** how many of them it has (the coordinator's can be changed) */
	count: number
}

export interface Demo {
	sessions: Session[]
	items: Item[]
	families: DemoFamily[]
}

type Shot = number | { a: number; w?: number }
type KidDef = [title: string, state: KidState, shots: Shot[]]

interface ParentDef {
	key: string
	title: string
	/** the session colour it should get (its id is picked to hash to it) */
	color: string
	busy: boolean
	agent: string
	unread: number
	asking: boolean
	shots: Shot[]
	kids: KidDef[]
	count?: number
}

const DEFS: ParentDef[] = [
	{
		key: 'coordinator',
		title: 'Canvas build: coordinator',
		color: '#60a5fa',
		busy: true,
		agent: 'build',
		unread: 2,
		asking: false,
		shots: [1.6, 1.33, 1.78, 1, 1.5, 1.2, 1.6, 0.8],
		count: 14,
		kids: [
			['Explore: render loop', 'running', [1.5]],
			['General: subagent frames demo', 'running', [1.78, 1.33]],
			['Explore: competitor heroes', 'done', [{ a: 4.2, w: 4200 }, 1.78]],
			['General: fix flaky upload test', 'done', [1.6, 1.2]],
			['General: mobile onboarding', 'done', [{ a: 0.5, w: 900 }, 1.33]],
			['Review: page items', 'failed', [1.33]],
			['Explore: auth flow', 'waiting', [1.5, 1]],
			['General: HTML side drawer', 'done', [1.78, 1.5]],
			['General: precise highlights', 'done', [1.6]],
			['Explore: ember band timing', 'running', [1.78]],
			['Review: frame chrome copy', 'done', [1.5]],
			['General: link cards', 'done', [1.33, 1.6]],
			['Explore: WebGPU fallbacks', 'done', [1.6]],
			['General: unread badge', 'done', [1.2]],
			['Explore: video seek latency', 'running', [1.78]],
			['General: share dialog', 'done', [1.5]],
			['Review: keyboard shortcuts', 'done', [1.33]],
			['General: canvas list previews', 'done', [1.6]],
			['Explore: Safari texture upload', 'done', [1.5]],
			['General: presence bar', 'done', [1.78]],
		],
	},
	{
		key: 'hero',
		title: 'Landing hero explorations',
		color: '#f472b6',
		busy: false,
		agent: 'build',
		unread: 0,
		asking: true,
		shots: [1.78, 1.78, 1.5, 1.33],
		kids: [
			['General: hero variants, round 3', 'running', [1.78, 1.78]],
			['Explore: brand assets', 'done', [1.33, 1, 1.5]],
			['Review: contrast pass', 'done', [1.5]],
		],
	},
	{
		key: 'shader',
		title: 'Shader study: rounded SDF',
		color: '#a78bfa',
		busy: false,
		agent: 'plan',
		unread: 0,
		asking: false,
		shots: [1.33, 1, 1.5, 0.8],
		kids: [],
	},
	{
		key: 'video',
		title: 'Perf: video pool',
		color: '#2dd4bf',
		busy: true,
		agent: 'build',
		unread: 1,
		asking: false,
		shots: [2.4, 1.78, 1.2],
		kids: [
			['Explore: map video pool', 'done', [1.5]],
			['General: decoder reuse', 'running', [1.78, 1.6]],
			['General: frame pacing traces', 'running', [2.2]],
			['Review: memory', 'done', [1.33]],
			['Explore: importExternalTexture', 'done', [1.6]],
			['General: poster frames', 'done', [1.5, 1.2]],
			['Explore: seek latency', 'done', [1.78]],
			['Review: leak check', 'failed', [1.33]],
		],
	},
	{
		key: 'flaky',
		title: 'Fix flaky upload test',
		color: '#fb923c',
		busy: false,
		agent: 'build',
		unread: 0,
		asking: false,
		shots: [2.2, 1.6],
		kids: [['Explore: find the race', 'done', [1.6]]],
	},
]

/** An OpenCode-shaped session id ("ses_" + 26) that hashes to `color` (the app colours sessions by id). */
function sessionIdFor(key: string, color: string) {
	const base = `ses_demo${key}`
	for (let i = 0; i < 1000; i++) {
		const id = `${base}${i.toString(36)}`.padEnd(30, '0').slice(0, 30)
		if (sessionColor(id) === color) return id
	}
	return base.padEnd(30, '0').slice(0, 30)
}

/** mulberry32 */
export function rng(seed: number) {
	return () => {
		seed |= 0
		seed = (seed + 0x6d2b79f5) | 0
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

function hue(hex: string) {
	const n = parseInt(hex.slice(1), 16)
	const r = ((n >> 16) & 255) / 255
	const g = ((n >> 8) & 255) / 255
	const b = (n & 255) / 255
	const max = Math.max(r, g, b)
	const min = Math.min(r, g, b)
	if (max === min) return 0
	const d = max - min
	return (max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60
}

/** A placeholder "image": a muted gradient near the session's hue with a subject or a few UI blocks. */
async function placeholder(r: () => number, h0: number, aspect: number): Promise<string> {
	const long = 640
	const w = Math.round(aspect >= 1 ? Math.min(1280, long * Math.min(aspect, 2)) : long * aspect)
	const hgt = Math.round(w / aspect)
	const c = new OffscreenCanvas(w, hgt)
	const g = c.getContext('2d')!
	const h1 = h0 + (r() - 0.5) * 70
	const h2 = h1 + 20 + r() * 50
	const s = 18 + r() * 22
	const grad = g.createLinearGradient(0, 0, w * r(), hgt)
	grad.addColorStop(0, `hsl(${h1} ${s}% ${16 + r() * 10}%)`)
	grad.addColorStop(1, `hsl(${h2} ${s + 6}% ${26 + r() * 14}%)`)
	g.fillStyle = grad
	g.fillRect(0, 0, w, hgt)
	if (r() < 0.45) {
		const x = w * (0.25 + r() * 0.5)
		const y = hgt * (0.3 + r() * 0.4)
		const rad = Math.min(w, hgt) * (0.25 + r() * 0.2)
		const sub = g.createRadialGradient(x, y, 0, x, y, rad)
		sub.addColorStop(0, `hsl(${h2 + 30} ${s + 14}% ${50 + r() * 14}% / 0.75)`)
		sub.addColorStop(1, `hsl(${h2 + 30} ${s}% 40% / 0)`)
		g.fillStyle = sub
		g.fillRect(0, 0, w, hgt)
	} else {
		const u = Math.min(w, hgt) / 20
		g.fillStyle = 'rgba(255,255,255,0.07)'
		g.fillRect(0, 0, w, u * 2)
		g.fillStyle = 'rgba(255,255,255,0.14)'
		const x0 = w * 0.08
		let y = hgt * (0.22 + r() * 0.1)
		for (let k = 0; k < 4 && y < hgt * 0.85; k++) {
			g.fillRect(x0, y, w * (0.25 + r() * 0.5) * (k ? 0.8 : 1), u * (k ? 0.7 : 1.3))
			y += u * (k ? 1.6 : 2.6)
			g.fillStyle = 'rgba(255,255,255,0.08)'
		}
		if (r() < 0.6) {
			g.fillStyle = `hsl(${h2 + 40} ${s + 20}% 58% / 0.55)`
			g.beginPath()
			g.roundRect(x0, Math.min(hgt - u * 3, y + u), w * 0.16, u * 1.6, u * 0.4)
			g.fill()
		}
	}
	const blob = await c.convertToBlob({ type: 'image/png' })
	return URL.createObjectURL(blob)
}

export async function buildDemo(canvasId = 'playground'): Promise<Demo> {
	const sessions: Session[] = []
	const items: Item[] = []
	const families: DemoFamily[] = []
	const jobs: Promise<void>[] = []
	let t = 1_000_000
	const addItems = (sessionId: string, color: string, shots: Shot[], seed: number) => {
		const r = rng(seed)
		const h = hue(color)
		shots.forEach((shot, k) => {
			const a = typeof shot === 'number' ? shot : shot.a
			const width = typeof shot === 'number' ? Math.round(1000 * a) : (shot.w ?? Math.round(1000 * a))
			const item: Item = { id: `${sessionId}-i${k}`, canvasId, sessionId, kind: 'image', name: `shot-${k + 1}.png`, src: '', thumb: '', width, height: Math.round(width / a), createdAt: t-- }
			items.push(item)
			jobs.push(
				placeholder(r, h, a).then((url) => {
					item.src = url
					item.thumb = url
				}),
			)
		})
	}
	const r = rng(7)
	DEFS.forEach((d, pi) => {
		const parentId = sessionIdFor(d.key, d.color)
		sessions.push({ id: parentId, canvasId, title: d.title, createdAt: 1000 + pi })
		addItems(parentId, d.color, d.shots, 100 + pi)
		const kids = d.kids.map(([title, state, shots], ci): DemoKid => {
			const id = `${parentId.slice(0, 22)}k${String(ci).padStart(2, '0')}`.padEnd(30, '0')
			sessions.push({ id, canvasId, title, createdAt: 2000 + pi * 40 + ci })
			addItems(id, sessionColor(id), shots, 1000 + pi * 50 + ci)
			const [agent, ...rest] = title.split(': ')
			const startedAgo = state === 'running' || state === 'waiting' ? 20 + r() * 150 : 200 + r() * 900
			const ran = state === 'running' || state === 'waiting' ? startedAgo : 40 + r() * 160
			return { id, title, agent, task: rest.join(': ') || title, state, startedAgo, ran }
		})
		families.push({ parentId, title: d.title, color: sessionColor(parentId), busy: d.busy, agent: d.agent, unread: d.unread, asking: d.asking, kids, count: d.count ?? kids.length })
	})
	await Promise.all(jobs)
	return { sessions, items, families }
}
