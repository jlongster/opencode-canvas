import type { ServerWebSocket } from 'bun'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as syncProtocol from 'y-protocols/sync'
import * as Y from 'yjs'

/**
 * Real-time rooms speaking the y-websocket protocol, so the client can use the stock
 * `WebsocketProvider`. Each room holds a Y.Doc (for shared state) and an Awareness
 * instance (for presence: who's here, cursors, selections, viewports). Rooms live in
 * memory and disappear when the last person leaves.
 */

const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1
const MESSAGE_QUERY_AWARENESS = 3
// Sub-type of a sync message (see y-protocols/sync): a request for the document, not a write.
const SYNC_STEP_1 = 0

export interface RoomSocketData {
	room: string
	/** read-only sockets can sync and share presence, but their document writes are ignored */
	readOnly: boolean
	/** resolves once the room (and its saved document) is loaded; messages queue behind it */
	ready?: Promise<Room>
}

type Socket = ServerWebSocket<RoomSocketData>

interface Room {
	doc: Y.Doc
	awareness: awarenessProtocol.Awareness
	/** each socket and the awareness client ids it controls */
	conns: Map<Socket, Set<number>>
}

const rooms = new Map<string, Room>()

/** Where a room's document is saved, or null to keep it in memory only. */
let persistPath: (room: string) => string | null = () => null
const SAVE_DEBOUNCE_MS = 500
const saveTimers = new Map<string, Timer>()

export function setRoomPersistence(fn: (room: string) => string | null) {
	persistPath = fn
}

async function saveRoom(name: string, doc: Y.Doc) {
	const path = persistPath(name)
	if (!path) return
	await Bun.write(path, Y.encodeStateAsUpdate(doc))
}

function scheduleSave(name: string, doc: Y.Doc) {
	clearTimeout(saveTimers.get(name))
	saveTimers.set(
		name,
		setTimeout(() => {
			saveTimers.delete(name)
			saveRoom(name, doc).catch((e) => console.error(`failed to save room ${name}:`, e))
		}, SAVE_DEBOUNCE_MS),
	)
}

const loading = new Map<string, Promise<Room>>()
/** final saves of rooms that just emptied; a reload of the same room waits for these */
const flushing = new Map<string, Promise<void>>()

function getRoom(name: string): Promise<Room> {
	const existing = rooms.get(name)
	if (existing) return Promise.resolve(existing)
	let pending = loading.get(name)
	if (!pending) {
		pending = loadRoom(name).finally(() => loading.delete(name))
		loading.set(name, pending)
	}
	return pending
}

async function loadRoom(name: string): Promise<Room> {
	let room: Room | undefined
	await flushing.get(name)

	const doc = new Y.Doc()
	const path = persistPath(name)
	if (path) {
		const file = Bun.file(path)
		if (await file.exists()) Y.applyUpdate(doc, new Uint8Array(await file.arrayBuffer()))
	}
	const awareness = new awarenessProtocol.Awareness(doc)
	// The server itself has no presence.
	awareness.setLocalState(null)
	const conns = new Map<Socket, Set<number>>()
	room = { doc, awareness, conns }
	rooms.set(name, room)

	doc.on('update', (update: Uint8Array) => {
		const encoder = encoding.createEncoder()
		encoding.writeVarUint(encoder, MESSAGE_SYNC)
		syncProtocol.writeUpdate(encoder, update)
		broadcast(room!, encoding.toUint8Array(encoder))
		scheduleSave(name, doc)
	})

	awareness.on(
		'update',
		({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
			const changed = [...added, ...updated, ...removed]
			const ids = conns.get(origin as Socket)
			if (ids) {
				for (const id of added) ids.add(id)
				for (const id of removed) ids.delete(id)
			}
			const encoder = encoding.createEncoder()
			encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
			encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, changed))
			broadcast(room!, encoding.toUint8Array(encoder))
		},
	)

	return room
}

function broadcast(room: Room, message: Uint8Array) {
	for (const ws of room.conns.keys()) send(ws, message)
}

function send(ws: Socket, message: Uint8Array) {
	if (ws.readyState === WebSocket.OPEN) ws.send(message)
}

export const roomSockets = {
	open(ws: Socket) {
		ws.data.ready = getRoom(ws.data.room).then((room) => {
			room.conns.set(ws, new Set())

			// Start the document sync, and send everyone who's already here.
			const sync = encoding.createEncoder()
			encoding.writeVarUint(sync, MESSAGE_SYNC)
			syncProtocol.writeSyncStep1(sync, room.doc)
			send(ws, encoding.toUint8Array(sync))

			const states = room.awareness.getStates()
			if (states.size) {
				const encoder = encoding.createEncoder()
				encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
				encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...states.keys()]))
				send(ws, encoding.toUint8Array(encoder))
			}
			return room
		})
		ws.data.ready.catch((e) => {
			console.error(`failed to open room ${ws.data.room}:`, e)
			ws.close(1011, 'room failed to load')
		})
	},

	message(ws: Socket, data: string | Buffer) {
		if (typeof data === 'string') return
		const bytes = new Uint8Array(data)
		ws.data.ready?.then((room) => handleMessage(room, ws, bytes))
	},

	close(ws: Socket) {
		ws.data.ready?.then((room) => {
			const ids = room.conns.get(ws)
			room.conns.delete(ws)
			if (ids?.size) awarenessProtocol.removeAwarenessStates(room.awareness, [...ids], null)
			if (room.conns.size > 0 || rooms.get(ws.data.room) !== room) return
			rooms.delete(ws.data.room)
			// Save right away rather than waiting for the debounce, then free the room.
			clearTimeout(saveTimers.get(ws.data.room))
			saveTimers.delete(ws.data.room)
			const name = ws.data.room
			const flush = saveRoom(name, room.doc)
				.catch((e) => console.error(`failed to save room ${name}:`, e))
				.finally(() => {
					room.awareness.destroy()
					room.doc.destroy()
					if (flushing.get(name) === flush) flushing.delete(name)
				})
			flushing.set(name, flush)
		})
	},
}

function handleMessage(room: Room, ws: Socket, bytes: Uint8Array) {
	try {
		const decoder = decoding.createDecoder(bytes)
		const type = decoding.readVarUint(decoder)
		if (type === MESSAGE_SYNC && ws.data.readOnly) {
			// Read-only sockets get the document, but anything they try to write is ignored. (Writes
			// can't be accepted selectively: Yjs needs every update from a client, in order.)
			if (decoding.readVarUint(decoder) !== SYNC_STEP_1) return
			const encoder = encoding.createEncoder()
			encoding.writeVarUint(encoder, MESSAGE_SYNC)
			syncProtocol.writeSyncStep2(encoder, room.doc, decoding.readVarUint8Array(decoder))
			send(ws, encoding.toUint8Array(encoder))
		} else if (type === MESSAGE_SYNC) {
			const encoder = encoding.createEncoder()
			encoding.writeVarUint(encoder, MESSAGE_SYNC)
			syncProtocol.readSyncMessage(decoder, encoder, room.doc, ws)
			if (encoding.length(encoder) > 1) send(ws, encoding.toUint8Array(encoder))
		} else if (type === MESSAGE_AWARENESS) {
			awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), ws)
		} else if (type === MESSAGE_QUERY_AWARENESS) {
			const encoder = encoding.createEncoder()
			encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
			encoding.writeVarUint8Array(
				encoder,
				awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...room.awareness.getStates().keys()]),
			)
			send(ws, encoding.toUint8Array(encoder))
		}
	} catch (e) {
		console.error('room message failed:', e)
	}
}
