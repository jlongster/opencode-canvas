/**
 * The browser's connections to OpenCode servers. The browser is the only OpenCode client: the
 * canvas server never talks to OpenCode or sees its credentials.
 *
 * Pairing: `opencode pair` prints a one-time link, http(s)://<host>/auth/connect/<code>, and
 * `bunx opencode-canvas` hands the browser the same thing in the URL fragment (#pair=…). Either way
 * we redeem the code (GET with Accept: application/json) for a session token, and authenticate
 * every request with HTTP Basic auth: username "opencode", the token as the password. Pairings are
 * kept in this browser's localStorage only.
 *
 * Each pairing has a key: a non-secret id derived from the server's URL, which conjured worm
 * records on the canvas server use to say which OpenCode a session lives on.
 */
import { OpenCode, type OpenCodeClient } from '@opencode/client'
import { atom } from '../state/signals'

export type { OpenCodeClient }

export interface Pairing {
	/** non-secret id: a hash of the URL */
	key: string
	/** defaults to the server's host; editable */
	name: string
	/** base URL */
	url: string
	token: string
	createdAt: number
}

/** How the latest request to each pairing went, by key (missing: not tried yet). */
export interface PairingHealth {
	ok: boolean
	error?: string
}

const STORE_KEY = 'canvas.opencode.pairings'
const OWNER_KEY = 'canvas.ownerId'
const REQUEST_MS = 10_000
const NAME_MAX = 60
const PAIR_LINK = /^(https?:\/\/[^\s]*?)\/auth\/connect\/([^\s/?#]+)\/?(?:[?#]\S*)?$/

export const pairings = atom<Pairing[]>('opencodePairings', load())
export const health = atom<Record<string, PairingHealth>>('opencodeHealth', {})

function load(): Pairing[] {
	try {
		const stored = JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]') as Pairing[]
		return Array.isArray(stored) ? stored.filter((p) => p?.key && p.url && p.token) : []
	} catch {
		return []
	}
}

function save(next: Pairing[]) {
	pairings.set(next)
	localStorage.setItem(STORE_KEY, JSON.stringify(next))
}

// Pairing (or unpairing) in another tab shows up here too.
window.addEventListener('storage', (e) => {
	if (e.key === STORE_KEY) pairings.set(load())
})

export const pairing = (key: string) => pairings.peek().find((p) => p.key === key)

// for poking at from the console, like window.editor
;(window as any).opencode = { pairings, pairing: (key: string) => pairing(key), client: (key: string) => clientFor(pairing(key)!) }

/** This browser's random id: conjured worms it creates are its own (only it can prompt and run them). */
export const ownerId: string = (() => {
	let id = localStorage.getItem(OWNER_KEY)
	if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
		const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
		id = 'own_' + [...crypto.getRandomValues(new Uint8Array(16))].map((b) => alphabet[b % alphabet.length]).join('')
		localStorage.setItem(OWNER_KEY, id)
	}
	return id
})()

/** The pairing key for a server URL: FNV-1a (64-bit) of the normalized URL. Not secret, just stable. */
export function serverKeyFor(url: string): string {
	let h = 0xcbf29ce484222325n
	for (const byte of new TextEncoder().encode(normalizeUrl(url))) {
		h ^= BigInt(byte)
		h = (h * 0x100000001b3n) & 0xffffffffffffffffn
	}
	return 'oc_' + h.toString(36)
}

/** The server's base URL without a trailing slash; "listen on all interfaces" addresses become 127.0.0.1. */
export function normalizeUrl(url: string): string {
	const u = new URL(url)
	if (u.hostname === '0.0.0.0' || u.hostname === '[::]') u.hostname = '127.0.0.1'
	return (u.origin + u.pathname).replace(/\/+$/, '')
}

export const authHeader = (p: Pairing) => `Basic ${btoa(`opencode:${p.token}`)}`

const clients = new Map<string, { token: string; url: string; client: OpenCodeClient }>()

/** The OpenCode client for a pairing (made once per token). */
export function clientFor(p: Pairing): OpenCodeClient {
	const cached = clients.get(p.key)
	if (cached && cached.token === p.token && cached.url === p.url) return cached.client
	const client = OpenCode.make({ baseUrl: p.url, headers: { authorization: authHeader(p) } })
	clients.set(p.key, { token: p.token, url: p.url, client })
	return client
}

function noteHealth(key: string, h: PairingHealth) {
	const prev = health.peek()[key]
	if (prev?.ok === h.ok && prev?.error === h.error) return
	health.set({ ...health.peek(), [key]: h })
}

/**
 * Runs a call against a paired server, noting whether it worked (shown in the server list).
 * Failures to reach it, or a revoked pairing, become an Error that says so.
 */
export async function withServer<T>(key: string, fn: (client: OpenCodeClient, p: Pairing) => Promise<T>): Promise<T> {
	const p = pairing(key)
	if (!p) throw new Error(`no paired OpenCode server ${key} in this browser`)
	try {
		const result = await fn(clientFor(p), p)
		noteHealth(key, { ok: true })
		return result
	} catch (e) {
		if (isUnauthorized(e) || isTransportError(e)) {
			const error = failureText(e, p)
			noteHealth(key, { ok: false, error })
			throw new Error(`${p.name} isn't reachable: ${error}`)
		}
		throw e
	}
}

// ---------- pairing ----------

export class PairingError extends Error {}

/** The {url, code} in a pairing link `opencode pair` prints (…/auth/connect/<code>), or null. */
export function parsePairLink(text: string): { url: string; code: string } | null {
	const link = /https?:\/\/\S+/.exec(text.trim())?.[0] ?? ''
	const m = PAIR_LINK.exec(link)
	if (!m) return null
	try {
		return { url: normalizeUrl(m[1]), code: decodeURIComponent(m[2]) }
	} catch {
		return null
	}
}

/** "#pair=<base64url of {url, code}>", as `bunx opencode-canvas` opens the page with. */
export function parsePairFragment(hash: string): { url: string; code: string } | null {
	const m = /(?:^#|&)pair=([A-Za-z0-9_-]+)/.exec(hash)
	if (!m) return null
	try {
		const json = atob(m[1].replace(/-/g, '+').replace(/_/g, '/'))
		const { url, code } = JSON.parse(json) as { url?: unknown; code?: unknown }
		if (typeof url !== 'string' || typeof code !== 'string' || !code) return null
		return { url: normalizeUrl(url), code }
	} catch {
		return null
	}
}

/** The hash without its pair= part. */
export function stripPairFragment(hash: string): string {
	const rest = hash.replace(/^#/, '').split('&').filter((part) => !part.startsWith('pair='))
	return rest.length ? `#${rest.join('&')}` : ''
}

/**
 * Redeems a one-time pairing code and saves the server. Pairing the same server again (say its
 * old token stopped working) refreshes its token and keeps its name.
 */
export async function redeem(target: { url: string; code: string }, nameValue?: string): Promise<Pairing> {
	const url = normalizeUrl(target.url)
	const host = new URL(url).host
	let res: Response
	try {
		res = await fetch(`${url}/auth/connect/${encodeURIComponent(target.code)}`, {
			headers: { accept: 'application/json' },
			redirect: 'manual',
			signal: AbortSignal.timeout(REQUEST_MS),
		})
	} catch (e) {
		const reason = errorText(e).replace(/[.\s]+$/, '')
		throw new PairingError(
			`couldn't reach ${host} (${reason}). Is OpenCode running there, and does it allow this page (${location.origin})? ` +
				'Running `bunx opencode-canvas` opens the canvas on localhost, which it allows',
		)
	}
	const body = (await res.json().catch(() => null)) as { token?: unknown; message?: unknown } | null
	if (!res.ok || typeof body?.token !== 'string' || !body.token) {
		if (res.status >= 500) throw new PairingError(`${host} failed to pair (HTTP ${res.status})`)
		const reason = typeof body?.message === 'string' && body.message ? body.message : `HTTP ${res.status}`
		throw new PairingError(`the pairing link didn't work: ${reason}. Run \`opencode pair\` (or \`bunx opencode-canvas\`) again for a new one`)
	}
	const token = body.token
	const key = serverKeyFor(url)
	const name = cleanName(nameValue)
	const existing = pairing(key)
	const p: Pairing = existing
		? { ...existing, url, token, ...(name ? { name } : {}) }
		: { key, name: name || host, url, token, createdAt: Date.now() }
	try {
		await clientFor(p).server.info({ signal: AbortSignal.timeout(REQUEST_MS) })
	} catch (e) {
		throw new PairingError(`paired, but ${host} didn't answer: ${failureText(e, p)}`)
	}
	save([...pairings.peek().filter((x) => x.key !== key), p].sort((a, b) => a.createdAt - b.createdAt))
	noteHealth(key, { ok: true })
	return p
}

/** Pairs from the text of a pasted `opencode pair` link. */
export async function pairFromLink(text: string, name?: string): Promise<Pairing> {
	const target = parsePairLink(text)
	if (!target) {
		throw new PairingError('that isn\'t an OpenCode pairing link: run `opencode pair` and paste the link it prints (…/auth/connect/<code>)')
	}
	return redeem(target, name)
}

export function renamePairing(key: string, nameValue: string) {
	const name = cleanName(nameValue)
	if (!name) return
	save(pairings.peek().map((p) => (p.key === key ? { ...p, name } : p)))
}

export function unpair(key: string) {
	clients.delete(key)
	save(pairings.peek().filter((p) => p.key !== key))
	const { [key]: _, ...rest } = health.peek()
	health.set(rest)
}

function cleanName(value: unknown): string {
	return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, NAME_MAX) : ''
}

// ---------- errors ----------

export function errorText(e: unknown): string {
	if (e && typeof e === 'object') {
		const err = e as { message?: unknown; _tag?: unknown }
		if (typeof err.message === 'string' && err.message) return err.message
		if (typeof err._tag === 'string') return err._tag
	}
	return String(e)
}

function failureText(e: unknown, p: Pairing): string {
	if (isUnauthorized(e)) return 'it no longer accepts this pairing (401); pair it again with `opencode pair` or `bunx opencode-canvas`'
	if (isTransportError(e)) return `couldn't connect to ${new URL(p.url).host} (is OpenCode running?)`
	return errorText(e)
}

export function isTransportError(e: unknown): boolean {
	if (e instanceof TypeError) return true
	return !!e && typeof e === 'object' && (e as { reason?: unknown }).reason === 'Transport'
}

export function isUnauthorized(e: unknown): boolean {
	if (!e || typeof e !== 'object') return false
	const err = e as { status?: unknown; _tag?: unknown; response?: { status?: unknown }; cause?: unknown }
	if (err.status === 401 || err.response?.status === 401 || err._tag === 'UnauthorizedError') return true
	return !!err.cause && err.cause !== e && isUnauthorized(err.cause)
}
