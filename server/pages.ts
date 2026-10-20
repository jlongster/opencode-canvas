/**
 * Page items: snapshots of real web pages, taken on the canvas server.
 *
 * A page is rendered in a headless Chromium driven by playwright-core (which never downloads a
 * browser itself): the one in $CANVAS_CHROME, else a browser Playwright installed (in its cache,
 * any revision), else Chrome/Chromium/Edge/Brave where they're usually installed. With none of
 * those (or when it won't start), the page's HTML is fetched instead and its preview becomes the
 * snapshot: its og:image, or a card drawn with ffmpeg (title, domain, description, favicon).
 *
 * Private addresses (loopback, RFC 1918, link-local, CGNAT, unique-local IPv6, …) are refused
 * unless `allowPrivate` (see CANVAS_PAGES_PRIVATE in index.ts): checked for the URL posted, every
 * redirect, and every request the page makes in the browser.
 */
import { existsSync, readdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { lookup } from 'node:dns/promises'
import { connect, createServer, isIP, type AddressInfo, type Socket } from 'node:net'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import type { Browser } from 'playwright-core'

export class PageError extends Error {
	constructor(public status: number, message: string) {
		super(message)
	}
}

export interface PageShot {
	/** file names in the media folder */
	file: string
	thumb: string
	width: number
	height: number
	/** the page's <title> (or og:title), if it has one */
	title?: string
	/** the URL after redirects */
	finalUrl: string
	via: 'browser' | 'card'
}

export interface PageOptions {
	width: number
	height: number
	fullPage?: boolean
}

interface PagesDeps {
	mediaDir: string
	hasFfmpeg: boolean
	run(cmd: string[]): Promise<string>
	probe(file: string): Promise<{ width: number; height: number }>
	makeThumb(input: string, output: string): Promise<void>
	/** a font file for a fontconfig pattern ("sans:bold"), or null */
	font(pattern: string): Promise<string | null>
	allowPrivate: boolean
	log?: (message: string) => void
}

/** Full-page snapshots stop this far down (CSS px). */
export const PAGE_MAX_HEIGHT = 6000
const LOAD_TIMEOUT_MS = 15_000
const SETTLE_MS = 500
const JOB_TIMEOUT_MS = 60_000
const MAX_JOBS = 2
const BROWSER_IDLE_MS = 60_000
/** after a browser fails to start, use the fallback card this long before trying again */
const BROWSER_RETRY_MS = 10 * 60_000
const FETCH_TIMEOUT_MS = 10_000
const HTML_READ_MAX = 1024 * 1024
const IMAGE_READ_MAX = 10 * 1024 * 1024
const CARD = { width: 1200, height: 630 }

export function createPages(deps: PagesDeps) {
	const log = deps.log ?? ((m: string) => console.warn(m))

	// ---------- addresses ----------

	/** Throws a PageError unless `raw` is an http(s) URL whose host is allowed. Returns it normalized. */
	async function checkUrl(raw: string): Promise<URL> {
		let url: URL
		try {
			url = new URL(raw)
		} catch {
			throw new PageError(400, `"page" is not a URL: ${JSON.stringify(raw)}`)
		}
		if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new PageError(400, `"page" must be an http(s) URL, got ${url.protocol}`)
		if (!deps.allowPrivate) await checkHost(url.hostname)
		return url
	}

	async function checkHost(hostname: string) {
		const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
		const refuse = (what: string) =>
			new PageError(403, `${hostname} is ${what}; this canvas server only snapshots public pages`)
		if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw refuse('a local name')
		if (isIP(host)) {
			if (privateAddress(host)) throw refuse('a private address')
			return
		}
		let addresses: { address: string }[]
		try {
			addresses = await lookup(host, { all: true, verbatim: true })
		} catch {
			throw new PageError(400, `can't resolve ${hostname}`)
		}
		if (!addresses.length) throw new PageError(400, `can't resolve ${hostname}`)
		if (addresses.some((a) => privateAddress(a.address))) throw refuse('on a private address')
	}

	// ---------- browser ----------

	let browser: Promise<Browser> | null = null
	let browserIdle: ReturnType<typeof setTimeout> | undefined
	let browserFailedAt = 0
	let active = 0
	const waiting: (() => void)[] = []
	let found: { path: string; source: string } | null | undefined

	/** The browser to drive, found once: see findBrowser. */
	function browserPath() {
		if (found === undefined) {
			found = findBrowser()
			log(found ? `page snapshots: ${found.source} at ${found.path}` : 'page snapshots: no Chrome/Chromium found, pages get a preview card instead (set CANVAS_CHROME to a browser to fix)')
		}
		return found
	}

	async function getBrowser(): Promise<Browser> {
		clearTimeout(browserIdle)
		if (!browser) {
			const path = browserPath()!.path
			const guard = deps.allowPrivate ? Promise.resolve(null) : guardProxy()
			browser = Promise.all([import('playwright-core'), guard])
				.then(([{ chromium }, proxy]) =>
					chromium.launch({
						executablePath: path,
						headless: true,
						// Playwright's own signal handlers would keep the server from stopping; the browser exits with its pipe anyway.
						handleSIGINT: false,
						handleSIGTERM: false,
						handleSIGHUP: false,
						args: [
							'--hide-scrollbars',
							'--mute-audio',
							// Every request (redirects, subresources, websockets; loopback too) goes through the guard.
							...(proxy ? [`--proxy-server=http://127.0.0.1:${proxy}`, '--proxy-bypass-list=<-loopback>', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] : []),
						],
					}),
				)
				.then((b) => {
					b.on('disconnected', () => {
						browser = null
					})
					return b
				})
			browser.catch(() => {
				browser = null
			})
		}
		return browser
	}

	function releaseBrowser() {
		clearTimeout(browserIdle)
		if (active > 0) return
		browserIdle = setTimeout(() => {
			const b = browser
			browser = null
			b?.then((x) => x.close()).catch(() => {})
		}, BROWSER_IDLE_MS)
	}

	async function slot() {
		if (active >= MAX_JOBS) await new Promise<void>((resolve) => waiting.push(resolve))
		active++
	}

	function freeSlot() {
		active--
		waiting.shift()?.()
	}

	/** Snapshots `url` into "<base>.png" (plus "<base>.thumb.webp") in the media folder. */
	async function snapshot(url: string, opts: PageOptions, base: string): Promise<PageShot> {
		await slot()
		try {
			return await withTimeout(snapshotNow(url, opts, base), JOB_TIMEOUT_MS, 'taking the snapshot timed out')
		} finally {
			freeSlot()
			releaseBrowser()
		}
	}

	async function snapshotNow(url: string, opts: PageOptions, base: string): Promise<PageShot> {
		await checkUrl(url)
		const useBrowser = browserPath() && Date.now() - browserFailedAt > BROWSER_RETRY_MS
		if (useBrowser) {
			let b: Browser
			try {
				b = await getBrowser()
			} catch (e) {
				browserFailedAt = Date.now()
				log(`page snapshots: the browser at ${browserPath()!.path} didn't start (${firstLine(e)}); using preview cards for now`)
				return card(url, base)
			}
			return shoot(b, url, opts, base)
		}
		return card(url, base)
	}

	async function shoot(b: Browser, url: string, opts: PageOptions, base: string): Promise<PageShot> {
		const ua = b.version().match(/[\d.]+/)?.[0] ?? '140.0.0.0'
		const context = await b.newContext({
			viewport: { width: opts.width, height: opts.height },
			deviceScaleFactor: 1,
			serviceWorkers: 'block',
			acceptDownloads: false,
			userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ua} Safari/537.36`,
		})
		try {
			const page = await context.newPage()
			const started = Date.now()
			try {
				await page.goto(url, { waitUntil: 'load', timeout: LOAD_TIMEOUT_MS })
			} catch (e) {
				// A page that never finishes loading still gets snapshotted as it is; one that never arrived doesn't.
				if (page.url() === 'about:blank' || !/timeout/i.test(String(e))) throw new PageError(502, `couldn't load ${url}: ${firstLine(e)}`)
			}
			// (the guard refused to fetch it, but the browser would show its error page as the snapshot)
			if (!deps.allowPrivate) await checkUrl(page.url()).catch(() => Promise.reject(new PageError(403, `${url} redirects to a private address (${page.url()}), which this server doesn't snapshot`)))
			await page.waitForLoadState('networkidle', { timeout: Math.max(1000, LOAD_TIMEOUT_MS - (Date.now() - started)) }).catch(() => {})
			let height = opts.height
			if (opts.fullPage) {
				// Scroll through it so lazy images load, then measure.
				const full = await page
					.evaluate(async (max: number) => {
						const total = () => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0)
						for (let y = 0; y < Math.min(total(), max); y += innerHeight) {
							scrollTo(0, y)
							await new Promise((r) => setTimeout(r, 120))
						}
						scrollTo(0, 0)
						return total()
					}, PAGE_MAX_HEIGHT)
					.catch(() => opts.height)
				height = Math.min(PAGE_MAX_HEIGHT, Math.max(opts.height, Math.round(full)))
				await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {})
			}
			await page.waitForTimeout(SETTLE_MS)
			const png = await page.screenshot({
				type: 'png',
				timeout: 15_000,
				animations: 'disabled',
				...(opts.fullPage ? { fullPage: true, clip: { x: 0, y: 0, width: opts.width, height } } : {}),
			})
			const title = cleanTitle(await page.title().catch(() => ''))
			const finalUrl = page.url()
			const file = `${base}.png`
			await Bun.write(join(deps.mediaDir, file), png)
			return { file, thumb: await thumbOf(file, base), width: opts.width, height, ...(title ? { title } : {}), finalUrl, via: 'browser' }
		} finally {
			await context.close().catch(() => {})
		}
	}

	async function thumbOf(file: string, base: string) {
		if (!deps.hasFfmpeg) return file
		const thumb = `${base}.thumb.webp`
		try {
			await deps.makeThumb(join(deps.mediaDir, file), join(deps.mediaDir, thumb))
			return thumb
		} catch {
			return file
		}
	}

	// ---------- the guard: a local proxy that only connects to public addresses ----------

	let guardPort: Promise<number> | null = null

	/**
	 * An HTTP proxy on 127.0.0.1 that the browser (and the card's fetches) send everything through.
	 * It resolves each host itself, refuses any that resolve to a private address, and connects to
	 * the address it checked, so neither redirects nor DNS rebinding get past it.
	 */
	function guardProxy(): Promise<number> {
		guardPort ??= new Promise<number>((resolve, reject) => {
			const server = createServer((client) => {
				let head = Buffer.alloc(0)
				const onData = (chunk: Buffer) => {
					head = Buffer.concat([head, chunk])
					const end = head.indexOf('\r\n\r\n')
					if (end < 0) {
						if (head.length > 64 * 1024) client.destroy()
						return
					}
					client.off('data', onData)
					client.pause()
					void forward(client, head.subarray(0, end).toString('latin1'), head.subarray(end + 4))
				}
				client.on('data', onData)
				client.on('error', () => client.destroy())
			})
			server.on('error', reject)
			server.listen(0, '127.0.0.1', () => {
				server.unref()
				resolve((server.address() as AddressInfo).port)
			})
		})
		return guardPort
	}

	async function forward(client: Socket, head: string, rest: Buffer) {
		const [requestLine, ...headers] = head.split('\r\n')
		const [method, target, version] = requestLine.split(' ')
		const refuse = (status: string) => {
			client.end(`HTTP/1.1 ${status}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`)
		}
		let host: string
		let port: number
		let path = ''
		try {
			if (method === 'CONNECT') {
				const u = new URL(`http://${target}`)
				host = u.hostname
				port = Number(u.port || 443)
			} else {
				const u = new URL(target)
				if (u.protocol !== 'http:') return refuse('400 Bad Request')
				host = u.hostname
				port = Number(u.port || 80)
				path = u.pathname + u.search
			}
		} catch {
			return refuse('400 Bad Request')
		}
		const address = await publicAddress(host)
		if (!address) return refuse('403 Forbidden')
		let connected = false
		const upstream = connect({ host: address, port }, () => {
			connected = true
			if (method === 'CONNECT') client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
			else {
				const kept = headers.filter((h) => !/^(proxy-connection|connection|keep-alive|proxy-authorization):/i.test(h))
				upstream.write(`${method} ${path} ${version}\r\n${[...kept, 'Connection: close'].join('\r\n')}\r\n\r\n`)
			}
			if (rest.length) upstream.write(rest)
			client.pipe(upstream)
			upstream.pipe(client)
			client.resume()
		})
		upstream.setTimeout(LOAD_TIMEOUT_MS * 2, () => upstream.destroy())
		upstream.on('error', () => (connected ? client.destroy() : refuse('502 Bad Gateway')))
		client.on('close', () => upstream.destroy())
		upstream.on('close', () => client.end())
	}

	/** The address to connect to for `hostname`: the first it resolves to, if none is private. */
	async function publicAddress(hostname: string): Promise<string | null> {
		const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
		if (host === 'localhost' || host.endsWith('.localhost')) return null
		if (isIP(host)) return privateAddress(host) ? null : host
		try {
			const addresses = await lookup(host, { all: true, verbatim: true })
			if (!addresses.length || addresses.some((a) => privateAddress(a.address))) return null
			return addresses[0].address
		} catch {
			return null
		}
	}

	// ---------- fallback: a preview card ----------

	/** Fetches with every redirect checked, reading at most `max` bytes. */
	async function fetchChecked(url: string, max: number, accept: string) {
		let current = url
		for (let hop = 0; hop < 6; hop++) {
			await checkUrl(current)
			const proxy = deps.allowPrivate ? null : await guardProxy()
			const res = await fetch(current, {
				redirect: 'manual',
				...(proxy ? { proxy: `http://127.0.0.1:${proxy}` } : {}),
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
				headers: { accept, 'user-agent': 'Mozilla/5.0 (compatible; opencode-canvas page preview)' },
			})
			const location = res.headers.get('location')
			if (res.status >= 300 && res.status < 400 && location) {
				current = new URL(location, current).href
				await res.body?.cancel()
				continue
			}
			if (!res.ok) throw new PageError(502, `fetching ${current} failed: ${res.status}`)
			return { res, body: await readAtMost(res, max), url: current }
		}
		throw new PageError(502, `too many redirects from ${url}`)
	}

	async function card(url: string, base: string): Promise<PageShot> {
		const { res, body, url: finalUrl } = await fetchChecked(url, HTML_READ_MAX, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5')
		const type = res.headers.get('content-type') ?? ''
		const html = type.includes('html') || !type ? new TextDecoder().decode(body) : ''
		const meta = readMeta(html, finalUrl)
		const title = meta.title
		const file = `${base}.png`
		const out = join(deps.mediaDir, file)

		// Its own preview image, when it has one.
		if (meta.image) {
			try {
				const image = await fetchChecked(meta.image, IMAGE_READ_MAX, 'image/*')
				const tmp = join(deps.mediaDir, `${base}.og`)
				await Bun.write(tmp, image.body)
				try {
					if (!deps.hasFfmpeg) throw new Error('no ffmpeg')
					await deps.run(['ffmpeg', '-y', '-v', 'error', '-i', tmp, '-frames:v', '1', '-vf', "scale='min(1600,iw)':-2", out])
				} finally {
					await rm(tmp, { force: true })
				}
				const size = await deps.probe(out)
				return { file, thumb: await thumbOf(file, base), ...size, ...(title ? { title } : {}), finalUrl, via: 'card' }
			} catch {
				await rm(out, { force: true })
			}
		}

		const host = new URL(finalUrl).hostname.replace(/^www\./, '')
		let drawn = false
		if (deps.hasFfmpeg) {
			drawn = await drawCard(out, base, { host, title: title ?? host, description: meta.description, icon: meta.icon }).then(
				() => true,
				(e) => (log(`page snapshots: drawing a preview card failed (${firstLine(e)})`), false),
			)
		}
		if (!drawn) await Bun.write(out, plainCard(CARD.width, CARD.height))
		return { file, thumb: await thumbOf(file, base), ...CARD, ...(title ? { title } : {}), finalUrl, via: 'card' }
	}

	/** title, domain and description on a dark card, with the favicon if it can be read. */
	async function drawCard(out: string, base: string, c: { host: string; title: string; description?: string; icon?: string }) {
		const [bold, regular] = await Promise.all([deps.font('sans:bold'), deps.font('sans')])
		const files: string[] = []
		const text = async (name: string, value: string) => {
			const path = join(deps.mediaDir, `${base}.${name}.txt`)
			await Bun.write(path, value)
			files.push(path)
			return path.replace(/\\/g, '/').replace(/'/g, '').replace(/:/g, '\\:')
		}
		let icon: string | null = null
		try {
			if (c.icon) {
				const fetched = await fetchChecked(c.icon, 1024 * 1024, 'image/*')
				icon = join(deps.mediaDir, `${base}.icon`)
				await Bun.write(icon, fetched.body)
				files.push(icon)
			}
		} catch {
			icon = null
		}
		const filters: string[] = []
		const font = (f: string | null) => (f ? `fontfile='${f.replace(/'/g, '').replace(/:/g, '\\:')}':` : '')
		const x = 80
		const titleLines = wrap(c.title, 30, 3)
		filters.push(`drawbox=x=0:y=0:w=iw:h=6:color=0x5790ff:t=fill`)
		filters.push(`drawtext=${font(regular)}textfile='${await text('host', c.host)}':expansion=none:fontsize=30:fontcolor=0xa1a1aa:x=${icon ? x + 60 : x}:y=88`)
		filters.push(`drawtext=${font(bold)}textfile='${await text('title', titleLines.join('\n'))}':expansion=none:fontsize=58:line_spacing=14:fontcolor=0xfafafa:x=${x}:y=170`)
		if (c.description) {
			const y = 170 + titleLines.length * 72 + 34
			const lines = wrap(c.description, 62, Math.max(1, Math.min(4, Math.floor((CARD.height - 40 - y) / 42))))
			filters.push(`drawtext=${font(regular)}textfile='${await text('desc', lines.join('\n'))}':expansion=none:fontsize=30:line_spacing=10:fontcolor=0xa1a1aa:x=${x}:y=${y}`)
		}
		const background = ['-f', 'lavfi', '-i', `color=c=0x18181b:s=${CARD.width}x${CARD.height}`]
		const render = (withIcon: boolean) =>
			deps.run([
				'ffmpeg', '-y', '-v', 'error', ...background,
				...(withIcon && icon ? ['-i', icon] : []),
				'-filter_complex',
				withIcon && icon
					? `[1:v]scale=44:44[icon];[0:v][icon]overlay=${x}:84,${filters.join(',')}`
					: `[0:v]${filters.join(',')}`,
				'-frames:v', '1', out,
			])
		try {
			try {
				await render(true)
			} catch (e) {
				if (!icon) throw e
				await render(false)
			}
		} finally {
			for (const f of files) await rm(f, { force: true })
		}
	}

	return {
		checkUrl,
		snapshot,
		/** where snapshots come from, for logs */
		browser: () => browserPath(),
	}
}

// ---------- browser discovery ----------

/**
 * $CANVAS_CHROME ("none" turns the browser off), then a Chromium Playwright installed (its
 * headless shell first; any revision, newest first), then the usual system installs.
 */
export function findBrowser(): { path: string; source: string } | null {
	const env = process.env.CANVAS_CHROME?.trim()
	if (env && /^(none|off|0|false)$/i.test(env)) return null
	if (env) {
		if (existsSync(env)) return { path: env, source: 'CANVAS_CHROME' }
		console.warn(`CANVAS_CHROME=${env} doesn't exist; looking for another browser`)
	}
	for (const path of playwrightBrowsers()) if (existsSync(path)) return { path, source: 'Playwright\'s Chromium' }
	for (const path of systemBrowsers()) if (path && existsSync(path)) return { path, source: 'the system browser' }
	return null
}

function playwrightBrowsers(): string[] {
	const os = platform()
	const root =
		process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== '0'
			? process.env.PLAYWRIGHT_BROWSERS_PATH
			: os === 'darwin'
				? join(homedir(), 'Library/Caches/ms-playwright')
				: os === 'win32'
					? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData/Local'), 'ms-playwright')
					: join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'ms-playwright')
	let dirs: string[]
	try {
		dirs = readdirSync(root)
	} catch {
		return []
	}
	const revision = (d: string) => Number(/-(\d+)$/.exec(d)?.[1] ?? 0)
	const shells = dirs.filter((d) => d.startsWith('chromium_headless_shell-')).sort((a, b) => revision(b) - revision(a))
	const full = dirs.filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => revision(b) - revision(a))
	const inShell = ['chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-linux/headless_shell', 'chrome-headless-shell-mac-arm64/chrome-headless-shell', 'chrome-headless-shell-mac-x64/chrome-headless-shell', 'chrome-mac/headless_shell', 'chrome-headless-shell-win64/chrome-headless-shell.exe', 'chrome-win/headless_shell.exe']
	const inFull = ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-win64/chrome.exe', 'chrome-win/chrome.exe']
	return [...shells.flatMap((d) => inShell.map((p) => join(root, d, p))), ...full.flatMap((d) => inFull.map((p) => join(root, d, p)))]
}

function systemBrowsers(): (string | null)[] {
	const os = platform()
	if (os === 'darwin') {
		return ['Google Chrome', 'Chromium', 'Google Chrome Canary', 'Microsoft Edge', 'Brave Browser'].flatMap((app) => [
			`/Applications/${app}.app/Contents/MacOS/${app}`,
			join(homedir(), `Applications/${app}.app/Contents/MacOS/${app}`),
		])
	}
	if (os === 'win32') {
		const roots = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean) as string[]
		return roots.flatMap((r) => [join(r, 'Google/Chrome/Application/chrome.exe'), join(r, 'Microsoft/Edge/Application/msedge.exe'), join(r, 'Chromium/Application/chrome.exe')])
	}
	return ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser'].map((name) => Bun.which(name))
}

// ---------- helpers ----------

/** Loopback, private, link-local, CGNAT, multicast and reserved IPv4; loopback, unspecified, unique-local, link-local and multicast IPv6 (and IPv4 inside IPv6). */
export function privateAddress(ip: string): boolean {
	if (isIP(ip) === 4) {
		const [a, b] = ip.split('.').map(Number)
		return (
			a === 0 || a === 10 || a === 127 || a >= 224 ||
			(a === 100 && b >= 64 && b < 128) ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b < 32) ||
			(a === 192 && b === 168) ||
			(a === 192 && b === 0) ||
			(a === 198 && (b === 18 || b === 19))
		)
	}
	const v6 = ip.toLowerCase().split('%')[0]
	const mapped = /^(?:::ffff:(?:0:)?|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(v6)?.[1]
	if (mapped) return privateAddress(mapped)
	const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6)
	if (hex) {
		const hi = parseInt(hex[1], 16)
		const lo = parseInt(hex[2], 16)
		return privateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
	}
	if (v6 === '::' || v6 === '::1') return true
	const first = parseInt(v6.split(':')[0] || '0', 16)
	return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00
}

async function readAtMost(res: Response, max: number): Promise<Uint8Array> {
	if (!res.body) return new Uint8Array()
	const reader = res.body.getReader()
	const chunks: Uint8Array[] = []
	let size = 0
	while (size < max) {
		const { done, value } = await reader.read()
		if (done) break
		chunks.push(value)
		size += value.length
	}
	await reader.cancel().catch(() => {})
	const out = new Uint8Array(Math.min(size, max))
	let at = 0
	for (const c of chunks) {
		out.set(c.subarray(0, out.length - at), at)
		at += c.length
		if (at >= out.length) break
	}
	return out
}

const decodeEntities = (s: string) =>
	s
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
		.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
		.replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[e as 'amp']!)

const cleanTitle = (s: string | undefined) => (s ? decodeEntities(s).replace(/\s+/g, ' ').trim().slice(0, 200) || undefined : undefined)

/** A page's title, description, preview image and favicon, from its HTML. */
export function readMeta(html: string, base: string) {
	const head = html.slice(0, 300_000)
	const metas = [...head.matchAll(/<meta\b[^>]*>/gi)].map((m) => attrs(m[0]))
	const meta = (...names: string[]) => metas.find((a) => names.includes((a.property ?? a.name ?? '').toLowerCase()) && a.content)?.content
	const resolve = (href: string | undefined) => {
		if (!href) return undefined
		try {
			const u = new URL(decodeEntities(href.trim()), base)
			return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined
		} catch {
			return undefined
		}
	}
	const links = [...head.matchAll(/<link\b[^>]*>/gi)].map((m) => attrs(m[0]))
	const icon = links.find((l) => /(^|\s)(icon|apple-touch-icon)(\s|$)/i.test(l.rel ?? '') && l.href && !/svg/i.test(l.type ?? '') && !/\.svg(\?|$)/i.test(l.href))?.href
	const title = cleanTitle(meta('og:title', 'twitter:title') ?? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1])
	const description = cleanTitle(meta('og:description', 'description', 'twitter:description'))
	return {
		title,
		description: description ? decodeEntities(description).slice(0, 400) : undefined,
		image: resolve(meta('og:image', 'og:image:url', 'twitter:image')),
		icon: resolve(icon ?? '/favicon.ico'),
	}
}

function attrs(tag: string): Record<string, string> {
	const out: Record<string, string> = {}
	for (const m of tag.matchAll(/([a-zA-Z:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g)) out[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? ''
	return out
}

/** Words into at most `lines` lines of about `width` characters, the last ending in … if cut. */
function wrap(text: string, width: number, lines: number): string[] {
	const out: string[] = []
	let line = ''
	const words = text.split(/\s+/).filter(Boolean)
	for (let i = 0; i < words.length; i++) {
		let word = words[i]
		if (word.length > width) word = word.slice(0, width - 1) + '…'
		if (!line) line = word
		else if (line.length + 1 + word.length <= width) line += ' ' + word
		else {
			out.push(line)
			line = word
			if (out.length === lines) {
				out[lines - 1] = out[lines - 1].slice(0, width - 1).replace(/\s*\S*$/, '') + '…'
				return out
			}
		}
	}
	if (line) out.push(line)
	return out
}

/** A plain dark card as a PNG, written without any tools (for servers without ffmpeg). */
function plainCard(width: number, height: number): Uint8Array {
	const row = 1 + width * 3
	const raw = new Uint8Array(row * height)
	for (let y = 0; y < height; y++) {
		const accent = y < 6
		for (let x = 0; x < width; x++) {
			const o = y * row + 1 + x * 3
			raw[o] = accent ? 0x57 : 0x18
			raw[o + 1] = accent ? 0x90 : 0x18
			raw[o + 2] = accent ? 0xff : 0x1b
		}
	}
	const chunk = (type: string, data: Uint8Array) => {
		const out = new Uint8Array(12 + data.length)
		const view = new DataView(out.buffer)
		view.setUint32(0, data.length)
		out.set(new TextEncoder().encode(type), 4)
		out.set(data, 8)
		view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
		return out
	}
	const ihdr = new Uint8Array(13)
	const v = new DataView(ihdr.buffer)
	v.setUint32(0, width)
	v.setUint32(4, height)
	ihdr.set([8, 2, 0, 0, 0], 8)
	const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())]
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
	let at = 0
	for (const p of parts) {
		out.set(p, at)
		at += p.length
	}
	return out
}

function crc32(data: Uint8Array): number {
	let c = ~0
	for (let i = 0; i < data.length; i++) {
		c ^= data[i]
		for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
	}
	return ~c >>> 0
}

const firstLine = (e: unknown) => String((e as Error)?.message ?? e).split('\n')[0].slice(0, 300)

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout>
	return Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new PageError(504, message)), ms)))]).finally(() => clearTimeout(timer))
}
