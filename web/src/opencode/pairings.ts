/**
 * The browser's connections to OpenCode servers. The browser is the only OpenCode client: the
 * canvas server never talks to OpenCode or sees its credentials.
 *
 * Pairing: `opencode pair` prints a one-time link, http(s)://<host>/auth/connect/<code>, which is
 * pasted into the canvas or handed over in the URL fragment (#pair=…, by `bunx opencode-canvas` or
 * by hand; the user accepts it first). Either way we redeem the code (GET with Accept:
 * application/json) for a session token,
 * and authenticate every request with HTTP Basic auth: username "opencode", the token as the
 * password. Pairings are kept in this browser's localStorage only.
 *
 * OpenCode only answers pages it allows by CORS: localhost, 127.0.0.1 and *.opencode.ai, plus the
 * origins added with `opencode service set cors <origin>`.
 *
 * Each pairing has a key: a non-secret id derived from the server's URL, which session links on
 * the canvas server use to say which OpenCode a session lives on.
 */
import { OpenCode, type OpenCodeClient } from '@opencode/client'
import { CORS_COMMAND } from '../base'
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
/** a pairing link anywhere in some text: base URL and code */
const PAIR_LINK = /(https?:\/\/[^\s"'<>()]+?)\/auth\/connect\/([A-Za-z0-9_%~.-]*[A-Za-z0-9_~-])/
/** the pair= part of a fragment, a whole URL or a bare one */
const PAIR_PARAM = /(?:^|[#&])pair=([^&\s]+)/
const LOOPBACK = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '[::]']

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

/** This browser's random id: sessions it links are its own (only it can prompt them, and its tabs run them). */
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

/** A pairing code from the URL: `bunx opencode-canvas`'s own, or a pairing link someone handed over. */
export interface PairOffer {
	url: string
	code: string
	from: 'cli' | 'link'
}

/** Why pairing failed; `command` is one to run that fixes it; `used`: the code expired or was used. */
export class PairingError extends Error {
	constructor(
		message: string,
		readonly command?: string,
		readonly used = false,
	) {
		super(message)
	}
}

/**
 * The {url, code} in some pasted text: the first pairing link `opencode pair` prints
 * (…/auth/connect/<code>) in it, or a canvas URL with a #pair= handoff. Null when there's neither.
 */
export function parsePairLink(text: string): { url: string; code: string } | null {
	const m = PAIR_LINK.exec(text)
	if (m) {
		try {
			return { url: normalizeUrl(m[1]), code: decodeURIComponent(m[2]) }
		} catch {
			return null
		}
	}
	const hash = /[#&]pair=\S+/.exec(text)?.[0]
	return hash ? parsePairFragment(hash) : null
}

/**
 * The {url, code} in a "#pair=…" fragment: base64url of {url, code} (as `bunx opencode-canvas`
 * opens the page with), or a pairing link itself, URL-encoded (a handoff anyone can make).
 */
export function parsePairFragment(hash: string): PairOffer | null {
	const m = PAIR_PARAM.exec(hash)
	if (!m) return null
	try {
		const value = decodeURIComponent(m[1])
		if (/^https?:/i.test(value)) {
			const target = parsePairLink(value.split(/\s/)[0])
			return target && { ...target, from: 'link' }
		}
		const json = atob(value.replace(/-/g, '+').replace(/_/g, '/'))
		const { url, code } = JSON.parse(json) as { url?: unknown; code?: unknown }
		if (typeof url !== 'string' || typeof code !== 'string' || !code) return null
		return { url: normalizeUrl(url), code, from: 'cli' }
	} catch {
		return null
	}
}

/**
 * A pairing code the page was opened with (#pair=…), waiting for the user to accept it. Kept in
 * memory only: a link never pairs this browser by itself, so nobody can pair you to their server
 * by sending you one.
 */
export const pairOffer = atom<PairOffer | null>('pairOffer', null)

/**
 * Takes a `#pair=…` fragment out of the URL (so a reload or a shared link never carries the code)
 * and offers it. Call once, before anything reads the hash. False when it was malformed.
 */
export function takePairFragment(): boolean {
	if (!/(?:^#|&)pair=/.test(location.hash)) return true
	const offer = parsePairFragment(location.hash)
	history.replaceState(history.state, '', `${location.pathname}${location.search}${stripPairFragment(location.hash)}`)
	pairOffer.set(offer)
	return !!offer
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
	const { host, hostname, protocol } = new URL(url)
	const remoteHint = LOOPBACK.includes(hostname) && !LOOPBACK.includes(location.hostname) ? ' If OpenCode is on another computer, use `opencode pair --remote`.' : ''
	if (location.protocol === 'https:' && protocol === 'http:' && !LOOPBACK.includes(hostname)) {
		throw new PairingError(`This page is HTTPS, so the browser won't connect to ${host} over plain HTTP. Use \`opencode pair --remote\` for an HTTPS link.`)
	}
	let res: Response
	try {
		res = await fetch(`${url}/auth/connect/${encodeURIComponent(target.code)}`, {
			// A custom header makes the browser ask OpenCode first (a CORS preflight), so a page it
			// doesn't allow never sends the code: a plain GET would use it up unanswered.
			headers: { accept: 'application/json', 'x-opencode-pair': '1' },
			redirect: 'manual',
			signal: AbortSignal.timeout(REQUEST_MS),
		})
	} catch (e) {
		if (e instanceof DOMException && e.name === 'TimeoutError') throw new PairingError(`OpenCode at ${host} didn't answer.${remoteHint}`)
		// Both "not running" and "doesn't allow this page" are a bare network error; a no-cors
		// request (which CORS doesn't block) tells them apart.
		if (await reachable(url)) {
			throw new PairingError(`OpenCode at ${host} blocked this site. Run this where OpenCode runs, then \`opencode pair\` again for a new link:`, CORS_COMMAND)
		}
		throw new PairingError(`Couldn't reach OpenCode at ${host}: is it running?${remoteHint}`)
	}
	const body = (await res.json().catch(() => null)) as { token?: unknown; message?: unknown } | null
	if (!res.ok || typeof body?.token !== 'string' || !body.token) {
		if (res.status >= 500) throw new PairingError(`${host} failed to pair (HTTP ${res.status})`)
		const reason = typeof body?.message === 'string' && body.message ? body.message.replace(/[.\s]+$/, '') : `HTTP ${res.status}`
		throw new PairingError(`That pairing link didn't work: ${reason}. Run \`opencode pair\` again for a new one.`, undefined, res.status === 401)
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
		throw new PairingError(`Paired, but ${host} didn't answer: ${failureText(e, p)}`)
	}
	save([...pairings.peek().filter((x) => x.key !== key), p].sort((a, b) => a.createdAt - b.createdAt))
	noteHealth(key, { ok: true })
	return p
}

/** Pairs from the text of a pasted `opencode pair` link. */
export async function pairFromLink(text: string, name?: string): Promise<Pairing> {
	const target = parsePairLink(text)
	if (!target) throw new PairingError("That isn't an OpenCode pairing link: paste the link `opencode pair` prints (…/auth/connect/<code>).")
	return redeem(target, name)
}

async function reachable(url: string): Promise<boolean> {
	try {
		await fetch(`${url}/`, { mode: 'no-cors', signal: AbortSignal.timeout(REQUEST_MS) })
		return true
	} catch {
		return false
	}
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
	if (isUnauthorized(e)) return 'it no longer accepts this pairing (401); pair it again with `opencode pair`'
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
