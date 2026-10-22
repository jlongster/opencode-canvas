import { clientFor, errorText, isUnauthorized, pairing } from './pairings'

export interface OpenCodeEvent {
	type: string
	/** when it happened (ms) */
	created?: number
	data?: Record<string, unknown>
}

export interface OpenCodeEventListener {
	onEvent(ev: OpenCodeEvent): void
	/** the stream (re)connected: events may have been missed while it was down */
	onConnect?(): void
}

/** a dropped or unreachable stream is retried this often */
const RETRY_MS = 5000

interface Stream {
	abort: AbortController
	listeners: Set<OpenCodeEventListener>
}

const streams = new Map<string, Stream>()

/**
 * Listens to a paired server's global event stream. One stream per server is shared by every
 * listener in this tab and stays open (reconnecting as needed) while any is registered. Returns the
 * unsubscribe function.
 */
export function onOpenCodeEvents(key: string, listener: OpenCodeEventListener): () => void {
	let stream = streams.get(key)
	if (!stream) {
		stream = { abort: new AbortController(), listeners: new Set() }
		streams.set(key, stream)
		run(key, stream)
	}
	const s = stream
	s.listeners.add(listener)
	return () => {
		s.listeners.delete(listener)
		if (s.listeners.size === 0) {
			s.abort.abort()
			if (streams.get(key) === s) streams.delete(key)
		}
	}
}

async function run(key: string, stream: Stream) {
	const signal = stream.abort.signal
	let failing = false
	while (!signal.aborted) {
		const p = pairing(key)
		if (!p) return
		try {
			let connected = false
			for await (const ev of clientFor(p).event.subscribe({ signal })) {
				if (!connected) {
					connected = true
					if (failing) console.info(`OpenCode event stream for ${p.name} reconnected`)
					failing = false
					for (const l of [...stream.listeners]) l.onConnect?.()
				}
				for (const l of [...stream.listeners]) {
					try {
						l.onEvent(ev as OpenCodeEvent)
					} catch (e) {
						console.error('OpenCode event listener failed:', e)
					}
				}
			}
		} catch (e) {
			if (signal.aborted) return
			if (!failing) console.warn(`OpenCode event stream for ${p.name} failed:`, isUnauthorized(e) ? 'unauthorized' : errorText(e))
			failing = true
		}
		if (!signal.aborted) await new Promise((r) => setTimeout(r, RETRY_MS))
	}
}
