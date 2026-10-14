/**
 * The path prefix the app is served under: "" when opened directly (:4410), or "/canvas" when
 * reached through the website's proxy at https://jamesbox.exe.xyz/canvas.
 */
export const BASE = /^\/canvas(\/|$)/.test(location.pathname) ? '/canvas' : ''

/** Prefix a server path like "/api/state" or "/media/x.png" with the base. */
export function url(path: string) {
	return path.startsWith('/') ? BASE + path : path
}

/** The path within the app, without the base (e.g. "/c/abc123"). */
export const APP_PATH = location.pathname.slice(BASE.length) || '/'
