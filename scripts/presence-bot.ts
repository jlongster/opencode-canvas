// A fake visitor for testing multiplayer: joins a canvas's room, circles its cursor around the
// first item, selects it, and broadcasts a view.
// Usage: bun scripts/presence-bot.ts <canvasId> [seconds] [name]
import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'

const [canvasId, seconds = '60', name = 'Test Bot'] = process.argv.slice(2)
if (!canvasId) throw new Error('usage: bun scripts/presence-bot.ts <canvasId> [seconds] [name]')
const base = process.env.CANVAS_URL ?? 'http://localhost:4410'

const data = await (await fetch(`${base}/api/canvases/${canvasId}`)).json()
const first = data.items[0]

const doc = new Y.Doc()
const provider = new WebsocketProvider(base.replace(/^http/, 'ws') + '/api/rooms', `canvas-${canvasId}`, doc, {
	disableBc: true,
	WebSocketPolyfill: WebSocket as any,
})
provider.on('status', ({ status }: { status: string }) => console.log('status:', status))

// Rough page position of the first item in the default layout (padding 32), which is enough for a demo.
const center = { x: 32 + 240, y: 32 + 40 + 160 }
const view = { x: 0, y: 0, w: 1400, h: 800 }
let t = 0
const timer = setInterval(() => {
	t += 0.05
	provider.awareness.setLocalState({
		user: { name, color: '#f472b6' },
		cursor: { x: center.x + Math.cos(t) * 180, y: center.y + Math.sin(t) * 90 },
		selection: first ? [first.id] : [],
		view: { ...view, x: view.x + Math.sin(t / 4) * 200 },
	})
}, 50)

setTimeout(() => {
	clearInterval(timer)
	provider.awareness.setLocalState(null)
	setTimeout(() => {
		provider.destroy()
		process.exit(0)
	}, 200)
}, Number(seconds) * 1000)
