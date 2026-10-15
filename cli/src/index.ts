/**
 * `bunx opencode-canvas [canvas-url-or-id]`: serves the canvas web app on http://localhost:<port>
 * (an origin OpenCode allows by default), finds the local OpenCode, mints a one-time pairing code
 * and opens the browser with it in the URL fragment. The browser redeems the code and talks to
 * OpenCode directly; canvases themselves live on the shared canvas server.
 *
 * This server is static only: no secrets, no OpenCode proxying. It binds 127.0.0.1.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync, createReadStream } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { dirname, extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Service } from '@opencode/client/service'

declare const CLI_VERSION: string

const DEFAULT_PORT = 4545
const DEFAULT_CANVAS_SERVER = 'https://jamesbox.exe.xyz/canvas'
const HOST = '127.0.0.1'
const DISCOVER_MS = 5000
const REQUEST_MS = 10_000

const HELP = `opencode-canvas ${typeof CLI_VERSION === 'string' ? CLI_VERSION : 'dev'}

Open review canvases in your browser, connected to your local OpenCode.

Usage
  bunx opencode-canvas [canvas-url-or-id] [options]

Arguments
  canvas-url-or-id     a canvas id (e.g. Ab3dEf7hJk) or link (…/c/<id> or …/v/<viewKey>) to open;
                       without one, opens the canvas list

Options
  --port <n>           local port to serve the app on (default ${DEFAULT_PORT}; keep it the same so
                       your pairings, kept in the browser, persist)
  --canvas-server <url>
                       the canvas server to use (default ${DEFAULT_CANVAS_SERVER}, or the
                       server of the canvas link you pass)
  --no-open            don't open a browser; just print the link
  -h, --help           show this help
  -v, --version        show the version
`

interface Options {
	port: number
	canvasServer: string | null
	target: { kind: 'c' | 'v'; id: string } | null
	open: boolean
}

function fail(message: string): never {
	console.error(`opencode-canvas: ${message}`)
	process.exit(1)
}

function parseArgs(argv: string[]): Options {
	const opts: Options = { port: DEFAULT_PORT, canvasServer: null, target: null, open: true }
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined]
		const value = () => inline ?? argv[++i] ?? fail(`${flag} needs a value`)
		if (flag === '-h' || flag === '--help') {
			process.stdout.write(HELP)
			process.exit(0)
		} else if (flag === '-v' || flag === '--version') {
			console.log(typeof CLI_VERSION === 'string' ? CLI_VERSION : 'dev')
			process.exit(0)
		} else if (flag === '--port') {
			const port = Number(value())
			if (!Number.isInteger(port) || port < 1 || port > 65535) fail('--port must be a port number (1-65535)')
			opts.port = port
		} else if (flag === '--canvas-server') {
			opts.canvasServer = canvasServerUrl(value())
		} else if (flag === '--no-open') {
			opts.open = false
		} else if (flag.startsWith('-')) {
			fail(`unknown option ${flag} (see --help)`)
		} else if (opts.target) {
			fail(`unexpected argument ${arg} (see --help)`)
		} else {
			const { target, server } = parseCanvasArg(arg)
			opts.target = target
			if (server && !opts.canvasServer) opts.canvasServer = server
		}
	}
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

/** A canvas id, or a link to one (whose server becomes the default canvas server). */
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

/** The URL fragment the app redeems: #pair=<base64url of {url, code}>. */
function pairFragment(url: string, code: string) {
	return `#pair=${Buffer.from(JSON.stringify({ url, code })).toString('base64url')}`
}

// ---------- the static app ----------

const MIME: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.ico': 'image/x-icon',
	'.webp': 'image/webp',
	'.woff2': 'font/woff2',
	'.txt': 'text/plain; charset=utf-8',
	'.map': 'application/json',
}

function appDir(): string {
	const here = dirname(fileURLToPath(import.meta.url))
	// dist/cli.js → ../app; when run from source (src/index.ts) the same
	const dir = join(here, '..', 'app')
	if (!existsSync(join(dir, 'index.html'))) fail(`the web app isn't built (no ${join(dir, 'index.html')}); run \`bun run build\` in cli/`)
	return dir
}

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

function makeHandler(dir: string, canvasServer: string) {
	const index = readFileSync(join(dir, 'index.html'), 'utf8').replace(
		'</head>',
		`<meta name="canvas-api" content="${escapeAttr(canvasServer)}">\n</head>`,
	)
	const config = JSON.stringify({ app: 'opencode-canvas', version: typeof CLI_VERSION === 'string' ? CLI_VERSION : 'dev', apiBase: canvasServer })
	const common = { 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' }

	return (req: IncomingMessage, res: ServerResponse) => {
		if (req.method !== 'GET' && req.method !== 'HEAD') {
			res.writeHead(405, { ...common, allow: 'GET, HEAD' }).end()
			return
		}
		let path: string
		try {
			path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
		} catch {
			res.writeHead(400, common).end()
			return
		}
		// The build references /canvas/assets/*, like the canvas server (which strips the prefix too).
		if (path === '/canvas' || path.startsWith('/canvas/')) path = path.slice('/canvas'.length) || '/'
		if (path === '/config.json') {
			res.writeHead(200, { ...common, 'content-type': 'application/json', 'cache-control': 'no-store' }).end(req.method === 'HEAD' ? undefined : config)
			return
		}
		const file = normalize(join(dir, path))
		const isFile = file.startsWith(dir + sep) && path !== '/index.html' && existsSync(file) && statSync(file).isFile()
		if (!isFile) {
			// the app's own routes (/, /c/:id, /v/:key): index.html, naming the canvas server
			res.writeHead(200, { ...common, 'content-type': MIME['.html'], 'cache-control': 'no-store' }).end(req.method === 'HEAD' ? undefined : index)
			return
		}
		res.writeHead(200, {
			...common,
			'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
			'content-length': statSync(file).size,
			'cache-control': path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store',
		})
		if (req.method === 'HEAD') res.end()
		else createReadStream(file).pipe(res)
	}
}

/** Another opencode-canvas already serving this port (for the same canvas server)? Then we can just reuse it. */
async function existingInstance(port: number, canvasServer: string): Promise<'same' | 'other' | 'none'> {
	try {
		const res = await fetch(`http://${HOST}:${port}/config.json`, { signal: AbortSignal.timeout(2000) })
		const body = (await res.json().catch(() => null)) as { app?: unknown; apiBase?: unknown } | null
		if (body?.app !== 'opencode-canvas') return 'other'
		return body.apiBase === canvasServer ? 'same' : 'other'
	} catch {
		return 'none'
	}
}

function listen(handler: ReturnType<typeof makeHandler>, port: number): Promise<boolean> {
	return new Promise((resolve, reject) => {
		const server = createServer(handler)
		server.once('error', (e: NodeJS.ErrnoException) => (e.code === 'EADDRINUSE' ? resolve(false) : reject(e)))
		server.listen(port, HOST, () => resolve(true))
	})
}

function openBrowser(url: string) {
	const [cmd, args] =
		process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]]
	try {
		const child = spawn(cmd, args as string[], { stdio: 'ignore', detached: true })
		child.on('error', () => console.log('  (couldn\'t open a browser: open the link above yourself)'))
		child.unref()
	} catch {
		console.log('  (couldn\'t open a browser: open the link above yourself)')
	}
}

// ---------- main ----------

async function main() {
	const opts = parseArgs(process.argv.slice(2))
	const canvasServer = opts.canvasServer ?? DEFAULT_CANVAS_SERVER
	const dir = appDir()

	const [listening, pair] = await Promise.all([
		(async () => {
			if (await listen(makeHandler(dir, canvasServer), opts.port)) return 'started' as const
			const existing = await existingInstance(opts.port, canvasServer)
			if (existing === 'same') return 'reused' as const
			fail(
				existing === 'other'
					? `port ${opts.port} is serving opencode-canvas for another canvas server; stop it or pass --port`
					: `port ${opts.port} is in use; pass --port <n> (pairings are kept per port, so pick one and stick with it)`,
			)
		})(),
		pairLocalOpenCode(),
	])

	const page = opts.target ? `/${opts.target.kind}/${opts.target.id}` : '/'
	const base = `http://localhost:${opts.port}`
	const link = base + page + ('code' in pair ? pairFragment(pair.url, pair.code) : '')

	console.log(`\n  opencode-canvas ${typeof CLI_VERSION === 'string' ? CLI_VERSION : 'dev'}`)
	console.log(`  canvas server  ${canvasServer}`)
	console.log(`  app            ${base}${listening === 'reused' ? ' (already running)' : ''}`)
	if ('code' in pair) {
		console.log(`  OpenCode       ${pair.url}`)
		console.log(`\n  Open: ${link}`)
		console.log(`  (one-time pairing link${pair.expiresIn ? `, valid for ${Math.round(pair.expiresIn)}s` : ''}; once paired, ${base} remembers it)`)
	} else {
		console.log(`  OpenCode       not connected: ${pair.error}`)
		console.log(`\n  Open: ${link}`)
		console.log('  To connect OpenCode, start it and run this again, or run `opencode pair` and paste the link into the canvas (Conjure → Connect).')
	}
	if (opts.open) openBrowser(link)
	if (listening === 'reused') process.exit(0)
	console.log('\n  Ctrl-C to stop.')
}

main().catch((e) => fail((e as Error).stack ?? String(e)))
