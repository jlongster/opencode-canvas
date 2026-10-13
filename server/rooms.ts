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

export const ROOM_NAME = /^[A-Za-z0-9_-]{1,64}$/

export interface RoomSocketData {
	room: string
}

type Socket = ServerWebSocket<RoomSocketData>

interface Room {
	doc: Y.Doc
	awareness: awarenessProtocol.Awareness
	/** each socket and the awareness client ids it controls */
	conns: Map<Socket, Set<number>>
}

const rooms = new Map<string, Room>()

function getRoom(name: string): Room {
	let room = rooms.get(name)
	if (room) return room

	const doc = new Y.Doc()
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
		const room = getRoom(ws.data.room)
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
	},

	message(ws: Socket, data: string | Buffer) {
		if (typeof data === 'string') return
		const room = rooms.get(ws.data.room)
		if (!room) return
		try {
			const decoder = decoding.createDecoder(new Uint8Array(data))
			const type = decoding.readVarUint(decoder)
			if (type === MESSAGE_SYNC) {
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
	},

	close(ws: Socket) {
		const room = rooms.get(ws.data.room)
		if (!room) return
		const ids = room.conns.get(ws)
		room.conns.delete(ws)
		if (ids?.size) awarenessProtocol.removeAwarenessStates(room.awareness, [...ids], null)
		if (room.conns.size === 0) {
			room.awareness.destroy()
			room.doc.destroy()
			rooms.delete(ws.data.room)
		}
	},
}
