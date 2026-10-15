/**
 * The path prefix the app is served under: "" when opened directly (:4410, or `bunx opencode-canvas`
 * on localhost), or "/canvas" when reached through the website's proxy at https://jamesbox.exe.xyz/canvas.
 */
export const BASE = /^\/canvas(\/|$)/.test(location.pathname) ? '/canvas' : ''

/**
 * Where the canvas server is: its origin plus path prefix, e.g. "https://jamesbox.exe.xyz/canvas".
 * Usually the page's own server; `bunx opencode-canvas` serves the app from localhost and names the
 * shared canvas server in <meta name="canvas-api">.
 */
export const API_BASE = (() => {
	const configured = document.querySelector<HTMLMetaElement>('meta[name="canvas-api"]')?.content.trim()
	if (configured) {
		try {
			return new URL(configured).href.replace(/\/+$/, '')
		} catch {
			console.error(`ignoring the invalid canvas-api ${configured}`)
		}
	}
	return location.origin + BASE
})()

/** The canvas server is somewhere other than this page (the app is served by `bunx opencode-canvas`). */
export const API_ELSEWHERE = API_BASE !== location.origin + BASE

/** A canvas server path like "/api/state" or "/media/x.png" as a full URL; anything else as it is. */
export function url(path: string) {
	return path.startsWith('/') ? API_BASE + path : path
}

/** A canvas server path as a WebSocket URL. */
export function wsUrl(path: string) {
	return url(path).replace(/^http/, 'ws')
}

/** The path within the app, without the base (e.g. "/c/abc123"). */
export const APP_PATH = location.pathname.slice(BASE.length) || '/'

/**
 * Whether OpenCode answers this page out of the box: it allows browser requests (CORS) from
 * http://localhost:*, http://127.0.0.1:* (what `bunx opencode-canvas` serves) and *.opencode.ai.
 * Other sites must be added once with CORS_COMMAND.
 */
export const OPENCODE_ALLOWS_PAGE =
	/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(location.origin) || /^https:\/\/([a-z0-9-]+\.)*opencode\.ai$/.test(location.origin)

/** Adds this page to the sites OpenCode allows (run where OpenCode runs). */
export const CORS_COMMAND = `opencode service set cors ${location.origin}`
