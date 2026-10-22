import type { Item, Session } from '../../../../shared/types'

/*
 * The demo canvas, in memory: five sessions, four of them with subagents (child sessions, titled
 * "<Agent>: <what it was asked>" as OpenCode names them), and the items they posted. The coordinator
 * has nine, among them a very wide frame and a tall one. Images are drawn in the browser.
 */

export interface DemoChild {
	id: string
	title: string
	color: string
	busy: boolean
}

export interface DemoFamily {
	parentId: string
	color: string
	busy: boolean
	/** newest first */
	children: DemoChild[]
}

export interface Demo {
	sessions: Session[]
	items: Item[]
	families: DemoFamily[]
}

const PALETTE = ['#f472b6', '#a78bfa', '#fb923c', '#4ade80', '#facc15', '#f87171', '#60a5fa', '#2dd4bf', '#e879f9', '#a3e635']

type Shot = number | { a: number; w?: number }

interface ParentDef {
	id: string
	title: string
	color: string
	busy: boolean
	shots: Shot[]
	children: { title: string; busy?: boolean; shots: Shot[] }[]
}

const DEFS: ParentDef[] = [
	{
		id: 'ses_demo_coordinator',
		title: 'Canvas build: coordinator',
		color: PALETTE[6],
		busy: true,
		shots: [1.6, 1.33, 1.78, 1, 1.5, 1.2, 1.6, 0.8],
		children: [
			{ title: 'Explore: render loop', busy: true, shots: [1.5] },
			{ title: 'General: subagent frames demo', busy: true, shots: [1.78, 1.33, 1.6] },
			{ title: 'Explore: competitor heroes', shots: [{ a: 4.2, w: 4200 }, 1.78, 1.6] },
			{ title: 'General: fix flaky upload test', shots: [1.6, 1.2] },
			{ title: 'General: mobile onboarding', shots: [{ a: 0.5, w: 900 }, 1.33] },
			{ title: 'Review: page items', shots: [1.33] },
			{ title: 'Explore: auth flow', shots: [1.5, 1] },
			{ title: 'General: HTML side drawer', shots: [1.78, 1.5] },
			{ title: 'General: precise highlights', shots: [1.6] },
		],
	},
	{
		id: 'ses_demo_hero',
		title: 'Landing hero explorations',
		color: PALETTE[0],
		busy: false,
		shots: [1.78, 1.78, 1.5, 1.33],
		children: [
			{ title: 'General: hero variants, round 3', busy: true, shots: [1.78, 1.78] },
			{ title: 'Explore: brand assets', shots: [1.33, 1, 1.5] },
			{ title: 'Review: contrast pass', shots: [1.5] },
		],
	},
	{
		id: 'ses_demo_shader',
		title: 'Shader study: rounded SDF',
		color: PALETTE[1],
		busy: false,
		shots: [1.33, 1, 1.5, 0.8],
		children: [],
	},
	{
		id: 'ses_demo_video',
		title: 'Perf: video pool',
		color: PALETTE[7],
		busy: true,
		shots: [2.4, 1.78, 1.2],
		children: [
			{ title: 'Explore: map video pool', shots: [1.5] },
			{ title: 'General: decoder reuse', busy: true, shots: [1.78, 1.6] },
			{ title: 'General: frame pacing traces', shots: [2.2] },
			{ title: 'Review: memory', shots: [1.33] },
		],
	},
	{
		id: 'ses_demo_flaky',
		title: 'Fix flaky upload test',
		color: PALETTE[2],
		busy: false,
		shots: [2.2, 1.6],
		children: [{ title: 'Explore: find the race', shots: [1.6] }],
	},
]

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
	const long = 720
	const w = Math.round(aspect >= 1 ? Math.min(1400, long * Math.min(aspect, 2)) : long * aspect)
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
		// a soft subject
		const x = w * (0.25 + r() * 0.5)
		const y = hgt * (0.3 + r() * 0.4)
		const rad = Math.min(w, hgt) * (0.25 + r() * 0.2)
		const sub = g.createRadialGradient(x, y, 0, x, y, rad)
		sub.addColorStop(0, `hsl(${h2 + 30} ${s + 14}% ${50 + r() * 14}% / 0.75)`)
		sub.addColorStop(1, `hsl(${h2 + 30} ${s}% 40% / 0)`)
		g.fillStyle = sub
		g.fillRect(0, 0, w, hgt)
	} else {
		// a screenshot: a top bar and some text lines
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
			const bw = w * 0.16
			g.beginPath()
			g.roundRect(x0, Math.min(hgt - u * 3, y + u), bw, u * 1.6, u * 0.4)
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
			const height = Math.round(width / a)
			const item: Item = {
				id: `${sessionId}-i${k}`,
				canvasId,
				sessionId,
				kind: 'image',
				name: `shot-${k + 1}.png`,
				src: '',
				thumb: '',
				width,
				height,
				createdAt: t--,
			}
			items.push(item)
			jobs.push(
				placeholder(r, h, a).then((url) => {
					item.src = url
					item.thumb = url
				}),
			)
		})
	}
	DEFS.forEach((d, pi) => {
		sessions.push({ id: d.id, canvasId, title: d.title, createdAt: 1000 + pi })
		addItems(d.id, d.color, d.shots, 100 + pi)
		const children: DemoChild[] = d.children.map((c, ci) => {
			const id = `${d.id}_sub${ci}`
			const color = PALETTE[(pi * 3 + ci * 7 + 2) % PALETTE.length]
			sessions.push({ id, canvasId, title: c.title, createdAt: 2000 + pi * 20 + ci })
			addItems(id, color, c.shots, 1000 + pi * 50 + ci)
			return { id, title: c.title, color, busy: !!c.busy }
		})
		families.push({ parentId: d.id, color: d.color, busy: d.busy, children })
	})
	await Promise.all(jobs)
	return { sessions, items, families }
}
