/**
 * Numerals in seven segments (the Reference Manual's clock and timecodes): an inline SVG string, h
 * px tall, lit segments in `on` and the unlit ones faintly in `off`. Digits, ":" and "." (anything
 * else is blank).
 */
const LIT: Record<string, string> = {
	'0': 'abcdef',
	'1': 'bc',
	'2': 'abged',
	'3': 'abgcd',
	'4': 'fgbc',
	'5': 'afgcd',
	'6': 'afgedc',
	'7': 'abc',
	'8': 'abcdefg',
	'9': 'abcdfg',
	'-': 'g',
}

const cache = new Map<string, string>()

export function segments(str: string, h = 11, on = '#fff', off = 'rgba(255,255,255,.14)'): string {
	const key = `${str}|${h}|${on}|${off}`
	const hit = cache.get(key)
	if (hit) return hit
	const w = h * 0.54
	const t = Math.max(1.6, h * 0.13)
	const g = t * 0.18
	let x = 0
	let out = ''
	const H = (x0: number, x1: number, y: number) =>
		`${x0},${y} ${x0 + t / 2},${y - t / 2} ${x1 - t / 2},${y - t / 2} ${x1},${y} ${x1 - t / 2},${y + t / 2} ${x0 + t / 2},${y + t / 2}`
	const V = (xc: number, y0: number, y1: number) =>
		`${xc},${y0} ${xc + t / 2},${y0 + t / 2} ${xc + t / 2},${y1 - t / 2} ${xc},${y1} ${xc - t / 2},${y1 - t / 2} ${xc - t / 2},${y0 + t / 2}`
	const f = (n: number) => +n.toFixed(2)
	for (const ch of str) {
		if (ch === ':') {
			out += `<rect x="${f(x)}" y="${f(h * 0.26)}" width="${f(t)}" height="${f(t)}" fill="${on}"/><rect x="${f(x)}" y="${f(h * 0.64)}" width="${f(t)}" height="${f(t)}" fill="${on}"/>`
			x += t * 2
			continue
		}
		if (ch === '.') {
			out += `<rect x="${f(x)}" y="${f(h - t)}" width="${f(t)}" height="${f(t)}" fill="${on}"/>`
			x += t * 2
			continue
		}
		const L = x + t / 2
		const R = x + w - t / 2
		const T = t / 2
		const M = h / 2
		const B = h - t / 2
		const lit = LIT[ch] ?? ''
		const P: Record<string, string> = {
			a: H(L + g, R - g, T),
			g: H(L + g, R - g, M),
			d: H(L + g, R - g, B),
			f: V(L, T + g, M - g),
			b: V(R, T + g, M - g),
			e: V(L, M + g, B - g),
			c: V(R, M + g, B - g),
		}
		for (const k in P) out += `<polygon points="${P[k].replace(/\d+\.\d+/g, (n) => String(f(+n)))}" fill="${lit.includes(k) ? on : off}"/>`
		x += w + h * 0.16
	}
	const svg = `<svg class="seg" width="${f(x)}" height="${h}" viewBox="0 0 ${f(x)} ${h}" aria-hidden="true">${out}</svg>`
	if (cache.size > 400) cache.delete(cache.keys().next().value!)
	cache.set(key, svg)
	return svg
}

/** Elapsed time as "mm:ss" (or "h:mm:ss" past an hour). */
export function clock(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000))
	const hh = Math.floor(s / 3600)
	const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
	const ss = String(s % 60).padStart(2, '0')
	return hh ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`
}

/** A wall-clock time as "15:42". */
export function hhmm(at: number): string {
	const d = new Date(at)
	return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
