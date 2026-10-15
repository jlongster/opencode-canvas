/**
 * The connection to OpenCode, for conjured worms (see conjured.ts). It's made lazily, on first use:
 * OPENCODE_URL (with OPENCODE_TOKEN as a bearer token) if set, else the local background service
 * found by Service.discover(), which never starts one. When OpenCode isn't reachable, callers get
 * an OpenCodeUnavailable error and nothing else breaks; the next call tries again.
 */
import { OpenCode } from '@opencode/client'
import { Service } from '@opencode/client/service'
import type { OpenCodeSessionSummary, OpenCodeStatus } from '../shared/types'

export type OpenCodeClient = ReturnType<typeof OpenCode.make>

export class OpenCodeUnavailable extends Error {}

const SESSIONS_LIMIT = 50
const REQUEST_MS = 10_000
/** a failed connection is retried at most this often */
const RETRY_MS = 3000

let connection: { client: OpenCodeClient; url: string } | null = null
let connecting: Promise<{ client: OpenCodeClient; url: string }> | null = null
let lastFailure: { at: number; error: string } | null = null

async function connect(): Promise<{ client: OpenCodeClient; url: string }> {
	const override = process.env.OPENCODE_URL?.trim()
	if (override) {
		const token = process.env.OPENCODE_TOKEN?.trim()
		const client = OpenCode.make({ baseUrl: override, headers: token ? { authorization: `Bearer ${token}` } : undefined })
		await client.server.info({ signal: AbortSignal.timeout(REQUEST_MS) })
		return { client, url: override }
	}
	const endpoint = await Service.discover()
	if (!endpoint) throw new Error('no running OpenCode service found')
	const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
	await client.server.info({ signal: AbortSignal.timeout(REQUEST_MS) })
	return { client, url: endpoint.url }
}

/** The client, connecting first if needed. Throws OpenCodeUnavailable. */
export async function opencode(): Promise<OpenCodeClient> {
	if (connection) return connection.client
	if (lastFailure && Date.now() - lastFailure.at < RETRY_MS) {
		throw new OpenCodeUnavailable(`OpenCode isn't reachable: ${lastFailure.error}`)
	}
	connecting ??= connect()
		.then((c) => {
			connection = c
			lastFailure = null
			return c
		})
		.catch((e) => {
			lastFailure = { at: Date.now(), error: errorText(e) }
			throw new OpenCodeUnavailable(`OpenCode isn't reachable: ${lastFailure.error}`)
		})
		.finally(() => (connecting = null))
	return (await connecting).client
}

/** Forgets the connection after a transport failure, so the next call rediscovers the service. */
export function resetOpenCode() {
	connection = null
}

/** Runs a call against OpenCode, reconnecting once if the connection went stale. */
export async function withOpenCode<T>(fn: (client: OpenCodeClient) => Promise<T>): Promise<T> {
	const client = await opencode()
	try {
		return await fn(client)
	} catch (e) {
		if (!isTransportError(e)) throw e
		resetOpenCode()
		try {
			return await fn(await opencode())
		} catch (again) {
			if (isTransportError(again)) throw new OpenCodeUnavailable(`OpenCode isn't reachable: ${errorText(again)}`)
			throw again
		}
	}
}

// ---------- the shared event stream ----------

export interface OpenCodeEvent {
	type: string
	data?: Record<string, unknown>
}

export interface OpenCodeEventListener {
	onEvent(ev: OpenCodeEvent): void
	/** the stream (re)connected: events may have been missed while it was down */
	onConnect?(): void
}

/** a dropped or unreachable stream is retried this often */
const STREAM_RETRY_MS = 5000
const listeners = new Set<OpenCodeEventListener>()
let stream: AbortController | null = null

/**
 * Listens to OpenCode's global event stream. One stream is shared by every listener and stays open
 * (reconnecting as needed) while any is registered. Returns the unsubscribe function.
 */
export function onOpenCodeEvents(listener: OpenCodeEventListener): () => void {
	listeners.add(listener)
	if (!stream) {
		stream = new AbortController()
		runStream(stream.signal)
	}
	return () => {
		listeners.delete(listener)
		if (listeners.size === 0) {
			stream?.abort()
			stream = null
		}
	}
}

async function runStream(signal: AbortSignal) {
	let failing = false
	while (!signal.aborted) {
		try {
			const client = await opencode()
			let connected = false
			for await (const ev of client.event.subscribe({ signal })) {
				if (!connected) {
					connected = true
					if (failing) console.log('opencode event stream reconnected')
					failing = false
					for (const l of [...listeners]) l.onConnect?.()
				}
				for (const l of [...listeners]) {
					try {
						l.onEvent(ev as OpenCodeEvent)
					} catch (e) {
						console.error('opencode event listener failed:', e)
					}
				}
			}
		} catch (e) {
			if (signal.aborted) return
			if (isTransportError(e)) resetOpenCode()
			if (!failing && !(e instanceof OpenCodeUnavailable)) console.error('opencode event stream failed:', errorText(e))
			failing = true
		}
		if (!signal.aborted) await Bun.sleep(STREAM_RETRY_MS)
	}
}

export async function openCodeStatus(): Promise<OpenCodeStatus> {
	try {
		await withOpenCode((c) => c.server.info({ signal: AbortSignal.timeout(REQUEST_MS) }))
		return { connected: true, url: connection?.url }
	} catch (e) {
		return { connected: false, error: errorText(e) }
	}
}

/** Recent sessions across all projects, newest first. */
export async function listOpenCodeSessions(): Promise<OpenCodeSessionSummary[]> {
	return withOpenCode(async (c) => {
		const signal = AbortSignal.timeout(REQUEST_MS)
		const [list, active] = await Promise.all([
			c.session.list({ limit: SESSIONS_LIMIT, order: 'desc' }, { signal }),
			c.session.active({ signal }).catch(() => ({}) as Record<string, unknown>),
		])
		return list.data
			.filter((s) => !s.time.archived)
			.map((s) => ({
				id: s.id,
				title: s.title?.trim() || '',
				directory: s.location.directory,
				updatedAt: s.time.updated,
				busy: s.id in active,
				...(s.parentID ? { parentId: s.parentID } : {}),
			}))
			.sort((a, b) => b.updatedAt - a.updatedAt)
	})
}

export function errorText(e: unknown): string {
	if (e instanceof OpenCodeUnavailable) return e.message.replace(/^OpenCode isn't reachable: /, '')
	if (e && typeof e === 'object') {
		const err = e as { message?: unknown; _tag?: unknown; cause?: unknown }
		if (typeof err.message === 'string' && err.message) return err.message
		if (typeof err._tag === 'string') return err._tag
	}
	return String(e)
}

function isTransportError(e: unknown): boolean {
	if (e instanceof TypeError) return true
	return !!e && typeof e === 'object' && (e as { reason?: unknown }).reason === 'Transport'
}
