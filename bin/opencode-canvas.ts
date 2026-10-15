#!/usr/bin/env bun
/**
 * `bunx github:jlongster/opencode-canvas [canvas-url-or-id]`: runs a canvas server on this machine
 * (API, media, live rooms, MCP and the web app; canvases are stored in ~/.opencode-canvas), finds
 * the local OpenCode, mints a one-time pairing code and opens the browser with it in the URL
 * fragment. The page offers it (one click on Connect redeems it) and then talks to OpenCode
 * directly. Binds 127.0.0.1 unless --host says otherwise.
 *
 * With --canvas-server <url> it instead serves just the web app locally, using that canvas server
 * for canvases (OpenCode only answers pages on localhost, so the app has to be served from here).
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, normalize, resolve, sep } from 'node:path'
import { Service } from '@opencode/client/service'

const ROOT = join(import.meta.dir, '..')
const WEB_DIST = join(ROOT, 'web/dist')
const VERSION: string = (await Bun.file(join(ROOT, 'package.json')).json()).version ?? 'dev'
const DEFAULT_PORT = 4545
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_DATA = join(homedir(), '.opencode-canvas')
const DISCOVER_MS = 5000
const REQUEST_MS = 10_000

const HELP = `opencode-canvas ${VERSION}

Review canvases on your machine, connected to your local OpenCode.

Usage
  bunx github:jlongster/opencode-canvas [canvas-url-or-id] [options]

Arguments
  canvas-url-or-id     a canvas id (e.g. Ab3dEf7hJk) or link (…/c/<id> or …/v/<viewKey>) to open;
                       without one, opens the canvas list

Options
  --port <n>           port to serve on (default ${DEFAULT_PORT}; keep it the same so your pairings,
                       kept in the browser per origin, persist)
  --host <address>     address to listen on (default ${DEFAULT_HOST}, this machine only)
  --data <dir>         where canvases and media are stored (default ~/.opencode-canvas)
  --canvas-server <url>
                       use a remote canvas server instead of a local one (only the web app is
                       served locally); also implied by a canvas link to another server
  --no-open            don't open a browser; just print the link
  -h, --help           show this help
  -v, --version        show the version
`

interface Options {
	port: number
	host: string
	data: string
	canvasServer: string | null
	target: { kind: 'c' | 'v'; id: string } | null
	open: boolean
}

function fail(message: string): never {
	console.error(`opencode-canvas: ${message}`)
	process.exit(1)
}

function parseArgs(argv: string[]): Options {
	const opts: Options = { port: DEFAULT_PORT, host: DEFAULT_HOST, data: DEFAULT_DATA, canvasServer: null, target: null, open: true }
	let linkServer: string | null = null
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined]
		const value = () => inline ?? argv[++i] ?? fail(`${flag} needs a value`)
		if (flag === '-h' || flag === '--help') {
			process.stdout.write(HELP)
			process.exit(0)
		} else if (flag === '-v' || flag === '--version') {
			console.log(VERSION)
			process.exit(0)
		} else if (flag === '--port') {
			const port = Number(value())
			if (!Number.isInteger(port) || port < 1 || port > 65535) fail('--port must be a port number (1-65535)')
			opts.port = port
		} else if (flag === '--host') {
			opts.host = value()
		} else if (flag === '--data') {
			opts.data = resolve(value().replace(/^~(?=$|\/)/, homedir()))
		} else if (flag === '--canvas-server') {
			opts.canvasServer = canvasServerUrl(value())
		} else if (flag === '--no-open') {
			opts.open = false
		} else if (flag.startsWith('-')) {
			fail(`unknown option ${flag} (see --help)`)
		} else if (opts.target) {
			fail(`unexpected argument ${arg} (see --help)`)
		} else {
			const parsed = parseCanvasArg(arg)
			opts.target = parsed.target
			linkServer = parsed.server
		}
	}
	// A link to a canvas on another server opens it there; links to localhost are this server's.
	if (linkServer && !opts.canvasServer && !isLoopback(new URL(linkServer).hostname)) opts.canvasServer = linkServer
	return opts
}

function canvasServerUrl(value: string): string {
	try {
		const u = new URL(value)
		if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error()
		return (u.origin + u.pathname).replace(/\/+$/, '')
	} catch {
		fail(`--canvas-server must be an http(s) URL, got ${value}`)
	}
}

/** A canvas id, or a link to one (and the server it's on). */
function parseCanvasArg(arg: string): { target: Options['target']; server: string | null } {
	if (/^[A-Za-z0-9]{10}$/.test(arg)) return { target: { kind: 'c', id: arg }, server: null }
	let u: URL
	try {
		u = new URL(arg)
	} catch {
		fail(`${arg} isn't a canvas id (10 letters and digits) or a canvas link`)
	}
	const m = /^(.*?)\/(c|v)\/([A-Za-z0-9]+)\/?$/.exec(u.pathname)
	if (!m) fail(`${arg} doesn't look like a canvas link (…/c/<id> or …/v/<viewKey>)`)
	return { target: { kind: m[2] as 'c' | 'v', id: m[3] }, server: (u.origin + m[1]).replace(/\/+$/, '') }
}

const isLoopback = (host: string) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host)
const isAnyAddress = (host: string) => ['0.0.0.0', '::', '[::]'].includes(host)

/** The address a browser on this machine uses: localhost, which OpenCode allows by default. */
function pageOrigin(host: string, port: number) {
	return isLoopback(host) || isAnyAddress(host) ? `http://localhost:${port}` : `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`
}

// ---------- OpenCode ----------

/** "Listen everywhere" addresses aren't reachable from a browser: use loopback. */
function browserUrl(url: string): string {
	const u = new URL(url)
	if (u.hostname === '0.0.0.0' || u.hostname === '[::]') u.hostname = '127.0.0.1'
	return (u.origin + u.pathname).replace(/\/+$/, '')
}

/** Finds the local OpenCode (never starts one) and mints a one-time pairing code on it. */
async function pairLocalOpenCode(): Promise<{ url: string; code: string; expiresIn: number } | { error: string }> {
	let endpoint: Awaited<ReturnType<typeof Service.discover>>
	try {
		endpoint = await Promise.race([
			Service.discover(),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out looking for it')), DISCOVER_MS)),
		])
	} catch (e) {
		return { error: `couldn't look for OpenCode: ${(e as Error).message}` }
	}
	if (!endpoint) return { error: 'no running OpenCode found on this machine' }
	try {
		const res = await fetch(`${endpoint.url.replace(/\/+$/, '')}/api/pair`, {
			method: 'POST',
			headers: Service.headers(endpoint) as Record<string, string>,
			signal: AbortSignal.timeout(REQUEST_MS),
		})
		const body = (await res.json().catch(() => null)) as { code?: unknown; expires_in?: unknown } | null
		if (!res.ok || typeof body?.code !== 'string') return { error: `OpenCode at ${endpoint.url} refused to make a pairing code (HTTP ${res.status})` }
		return { url: browserUrl(endpoint.url), code: body.code, expiresIn: Number(body.expires_in) || 0 }
	} catch (e) {
		return { error: `couldn't reach OpenCode at ${endpoint.url}: ${(e as Error).message}` }
	}
}

/** The URL fragment the app offers to redeem: #pair=<base64url of {url, code}>. */
function pairFragment(url: string, code: string) {
	return `#pair=${Buffer.from(JSON.stringify({ url, code })).toString('base64url')}`
}

// ---------- servers ----------

/** What's on the port already: an opencode-canvas (and for which canvas server), something else, or nothing. */
async function existingInstance(origin: string): Promise<{ web: string } | 'other' | 'none'> {
	try {
		const res = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(2000) })
		const body = (await res.json().catch(() => null)) as { app?: unknown; web?: unknown } | null
		return body?.app === 'opencode-canvas' && typeof body.web === 'string' ? { web: body.web } : 'other'
	} catch {
		return 'none'
	}
}

/** The full canvas server (server/index.ts), in this process. */
async function startLocalServer(opts: Options, origin: string) {
	Object.assign(process.env, {
		PORT: String(opts.port),
		CANVAS_HOST: opts.host,
		CANVAS_DATA: opts.data,
		CANVAS_WEB: origin,
		CANVAS_MEDIA_ORIGIN: origin,
		CANVAS_QUIET: '1',
	})
	try {
		await import('../server/index.ts')
	} catch (e) {
		const err = e as NodeJS.ErrnoException
		if (err.code === 'EADDRINUSE' || /in use|EADDRINUSE/i.test(err.message)) fail(`port ${opts.port} is in use; pass --port <n>`)
		throw e
	}
}

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

/** Just the web app, pointed at a remote canvas server by <meta name="canvas-api"> (see web/src/base.ts). */
async function startStaticServer(opts: Options, canvasServer: string) {
	const index = (await Bun.file(join(WEB_DIST, 'index.html')).text()).replace(
		'</head>',
		`<meta name="canvas-api" content="${escapeAttr(canvasServer)}">\n</head>`,
	)
	const health = JSON.stringify({ app: 'opencode-canvas', web: canvasServer })
	const common = { 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' }
	try {
		Bun.serve({
			port: opts.port,
			hostname: opts.host,
			fetch(req) {
				if (req.method !== 'GET' && req.method !== 'HEAD') return new Response(null, { status: 405, headers: { ...common, allow: 'GET, HEAD' } })
				let path = decodeURIComponent(new URL(req.url).pathname)
				// The build references /canvas/assets/*, like the canvas server (which strips the prefix too).
				if (path === '/canvas' || path.startsWith('/canvas/')) path = path.slice('/canvas'.length) || '/'
				if (path === '/api/health') return new Response(health, { headers: { ...common, 'content-type': 'application/json' } })
				const file = normalize(join(WEB_DIST, path))
				if (file.startsWith(WEB_DIST + sep) && path !== '/index.html' && existsSync(file) && Bun.file(file).size > 0) {
					return new Response(Bun.file(file), {
						headers: { ...common, 'cache-control': path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store' },
					})
				}
				// the app's own routes (/, /c/:id, /v/:key)
				return new Response(index, { headers: { ...common, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
			},
		})
	} catch (e) {
		const err = e as NodeJS.ErrnoException
		if (err.code === 'EADDRINUSE' || /in use|EADDRINUSE/i.test(err.message)) fail(`port ${opts.port} is in use; pass --port <n>`)
		throw e
	}
}

function openBrowser(url: string) {
	const [cmd, args] =
		process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]]
	const failed = () => console.log("  (couldn't open a browser: open the link above yourself)")
	try {
		const child = spawn(cmd, args as string[], { stdio: 'ignore', detached: true })
		child.on('error', failed)
		child.unref()
	} catch {
		failed()
	}
}

// ---------- main ----------

async function main() {
	const opts = parseArgs(process.argv.slice(2))
	if (!existsSync(join(WEB_DIST, 'index.html'))) fail(`the web app isn't built (no ${join(WEB_DIST, 'index.html')}); run \`bun run build\``)
	const origin = pageOrigin(opts.host, opts.port)
	// Talk to whatever is on the port over loopback when listening on every interface.
	const probeOrigin = isAnyAddress(opts.host) ? `http://127.0.0.1:${opts.port}` : origin
	const wanted = opts.canvasServer ?? origin

	const existing = await existingInstance(probeOrigin)
	if (existing === 'other') fail(`port ${opts.port} is in use by something else; pass --port <n>`)
	if (existing !== 'none' && existing.web !== wanted) {
		fail(`port ${opts.port} is already serving opencode-canvas for ${existing.web}; stop it or pass --port <n>`)
	}
	const reused = existing !== 'none'

	const [, pair] = await Promise.all([
		reused ? null : opts.canvasServer ? startStaticServer(opts, opts.canvasServer) : startLocalServer(opts, origin),
		pairLocalOpenCode(),
	])

	const page = opts.target ? `/${opts.target.kind}/${opts.target.id}` : '/'
	const link = origin + page + ('code' in pair ? pairFragment(pair.url, pair.code) : '')

	console.log(`\n  opencode-canvas ${VERSION}${reused ? ' (already running on this port)' : ''}`)
	if (opts.canvasServer) {
		console.log(`  canvas server  ${opts.canvasServer} (remote; the app is served at ${origin})`)
	} else {
		console.log(`  canvases       ${origin}${reused ? '' : `  (data: ${opts.data})`}`)
		console.log(`  MCP            ${origin}/mcp`)
	}
	if ('code' in pair) {
		console.log(`  OpenCode       ${pair.url}`)
		console.log(`\n  Open: ${link}`)
		console.log(
			`  Click Connect on the page to connect this OpenCode (one-time code${pair.expiresIn ? `, valid for ${Math.round(pair.expiresIn)}s` : ''}; once connected, ${origin} remembers it).`,
		)
	} else {
		console.log(`  OpenCode       not found: ${pair.error}`)
		console.log(`\n  Open: ${link}`)
		console.log('  To connect OpenCode, start it and run this again, or run `opencode pair` and paste the link it prints into the page.')
	}
	if (opts.open) openBrowser(link)
	if (reused) process.exit(0)
	console.log('\n  Ctrl-C to stop.')
}

main().catch((e) => fail((e as Error).stack ?? String(e)))
