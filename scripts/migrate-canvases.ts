// One-off migration to multiple canvases: puts every existing session and item on one canvas
// called "Main", and removes the old share snapshots.
// Usage: bun scripts/migrate-canvases.ts   (stop the server first; honours $CANVAS_DATA)
import { existsSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Canvas, Item, Session } from '../shared/types'

const DATA_DIR = resolve(process.env.CANVAS_DATA ?? join(import.meta.dir, '../data'))
const INDEX_FILE = join(DATA_DIR, 'index.json')
const SHARES_DIR = join(DATA_DIR, 'shares')

type OldIndex = { sessions: Omit<Session, 'canvasId'>[]; items: Omit<Item, 'canvasId'>[]; canvases?: unknown }

function randomId(length: number) {
	const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
	const bytes = crypto.getRandomValues(new Uint8Array(length))
	return [...bytes].map((b) => alphabet[b % alphabet.length]).join('')
}

const old: OldIndex = existsSync(INDEX_FILE)
	? await Bun.file(INDEX_FILE).json()
	: { sessions: [], items: [] }
if (old.canvases) throw new Error(`${INDEX_FILE} already has canvases; nothing to migrate`)

const canvas: Canvas = { id: randomId(10), title: 'Main', createdAt: Date.now(), viewKey: randomId(16) }
const next = {
	canvases: [canvas],
	sessions: old.sessions.map((s): Session => ({ ...s, canvasId: canvas.id })),
	items: old.items.map((i): Item => ({ ...i, canvasId: canvas.id })),
}

const tmp = INDEX_FILE + '.tmp'
await Bun.write(tmp, JSON.stringify(next))
await rename(tmp, INDEX_FILE)
await rm(SHARES_DIR, { recursive: true, force: true })

console.log(
	`migrated ${next.sessions.length} sessions and ${next.items.length} items to canvas "Main" ` +
		`(id ${canvas.id}, viewKey ${canvas.viewKey}); removed ${SHARES_DIR}`,
)
