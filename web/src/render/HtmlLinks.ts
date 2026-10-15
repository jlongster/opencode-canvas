import type { HtmlLink } from '../editor/Editor'
import type { Box } from '../editor/geometry'

/**
 * Links in HTML items. The iframes never take input, so each document gets a small script that
 * reports where its links are, and the editor hit-tests those rects to show and open them.
 *
 * Protocol (iframe → parent, postMessage to the parent's origin):
 *   { type: 'canvas:links', nonce, width, height, links: [{ href, rects: [[x, y, w, h], …] }] }
 * Rects are in the document's viewport CSS px (the item's design size; scroll is already applied),
 * clipped to the viewport, and only for visible, unobscured http(s)/mailto links: <a href>s, and
 * URLs written as plain text (autolinked, bare hosts get https://). The parent only
 * accepts it from that iframe's contentWindow with the nonce it put in that document.
 */

export const MAX_LINKS = 500
const MAX_RECTS = 16
const MAX_HREF = 4096
const LINK_MESSAGE = 'canvas:links'
/** Fetched HTML item sources, by URL (they're immutable). */
const MAX_CACHED_DOCS = 48

/** Runs inside the item's document; must not reference anything outside itself. */
function linkReporter(nonce: string, parentOrigin: string, maxLinks: number, maxRects: number) {
	document.currentScript?.remove()
	const MAX_TEXT_NODES = 5000
	const MAX_TEXT_CHARS = 500_000
	// Plain-text URLs: http(s)://…, www.…, a bare host followed by a path (github.com/a/b), emails.
	const urlPattern =
		/(?<![\w@.\/-])(?:(https?:\/\/[^\s<>"'`]+)|(www\.[a-z0-9-]+(?:\.[a-z0-9-]+)+[^\s<>"'`]*)|((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+([a-z]{2,})(?::\d{1,5})?\/[^\s<>"'`]*)|([\w.+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b))/gi
	// "TLDs" that are really file extensions (package.json/x, foo.ts/bar): not bare hosts.
	const fileExts = new Set(
		'c h cc cpp hpp cs go rs rb py js jsx mjs cjs ts tsx mts cts json jsonc md mdx txt log sh bash zsh css scss less html htm xml yml yaml toml ini lock java kt swift php sql vue svelte png jpg jpeg gif svg webp zip tar gz tgz'.split(' '),
	)
	const skip = 'a,script,style,noscript,template,textarea,input,select,option,[contenteditable]:not([contenteditable="false"])'
	const textCache = new WeakMap<Text, { data: string; found: [number, number, string][] }>()
	const findUrls = (text: string) => {
		const found: [number, number, string][] = []
		if (!/[./@]/.test(text)) return found
		for (const m of text.matchAll(urlPattern)) {
			if (m[4] && fileExts.has(m[4].toLowerCase())) continue
			let url = m[0]
			// Trailing punctuation isn't part of it, nor are closing brackets it didn't open.
			for (;;) {
				const last = url[url.length - 1]
				if ('.,;:!?\'"'.includes(last)) url = url.slice(0, -1)
				else if (last && ')]}'.includes(last) && url.split(last).length > url.split('([{'[')]}'.indexOf(last)]).length)
					url = url.slice(0, -1)
				else break
			}
			if (!/[\w/=#)\]}-]$/.test(url)) continue
			if (m[5]) {
				if (!/\.[a-z]{2,}$/i.test(url)) continue
				found.push([m.index!, url.length, 'mailto:' + url])
			} else {
				found.push([m.index!, url.length, m[1] ? url : 'https://' + url])
			}
		}
		return found
	}
	let timer = 0
	let lastAt = 0
	let last = ''
	const measure = () => {
		timer = 0
		lastAt = performance.now()
		const vw = innerWidth
		const vh = innerHeight
		const links: { href: string; rects: number[][] }[] = []
		// The visible, unobscured parts of rects (clipped to the viewport), in document px.
		const visibleRects = (list: DOMRectList, owner: Element) => {
			const rects: number[][] = []
			for (const r of Array.from(list)) {
				if (rects.length >= maxRects) break
				const x = Math.max(0, r.left)
				const y = Math.max(0, r.top)
				const w = Math.min(vw, r.right) - x
				const h = Math.min(vh, r.bottom) - y
				if (w < 1 || h < 1) continue
				// Hidden, clipped away (e.g. scrolled out of its box) or covered by something else.
				const hit = document.elementFromPoint(x + w / 2, y + h / 2)
				if (!hit || !owner.contains(hit)) continue
				rects.push([x, y, w, h].map((n) => Math.round(n * 10) / 10))
			}
			return rects
		}
		for (const a of Array.from(document.querySelectorAll('a'))) {
			if (links.length >= maxLinks) break
			const raw = (a.getAttribute('href') ?? a.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ?? '').trim()
			if (!raw || raw.startsWith('#')) continue
			let url: URL
			try {
				url = new URL(raw, document.baseURI)
			} catch {
				continue
			}
			if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'mailto:') continue
			const rects = visibleRects(a.getClientRects(), a)
			if (rects.length) links.push({ href: url.href, rects })
		}
		if (document.body && links.length < maxLinks) {
			const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
				acceptNode: (node) =>
					node.nodeType === 1 && (node as Element).matches(skip) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
			})
			const range = document.createRange()
			let nodes = 0
			let chars = 0
			for (let node = walker.nextNode(); node && links.length < maxLinks; node = walker.nextNode()) {
				if (node.nodeType !== 3) continue
				const text = node as Text
				const data = text.data
				if (++nodes > MAX_TEXT_NODES || (chars += data.length) > MAX_TEXT_CHARS) break
				let cached = textCache.get(text)
				if (!cached || cached.data !== data) textCache.set(text, (cached = { data, found: findUrls(data) }))
				const owner = text.parentElement
				if (!owner) continue
				for (const [start, length, href] of cached.found) {
					if (links.length >= maxLinks) break
					range.setStart(text, start)
					range.setEnd(text, start + length)
					const rects = visibleRects(range.getClientRects(), owner)
					if (rects.length) links.push({ href, rects })
				}
			}
			range.detach()
		}
		const json = JSON.stringify([vw, vh, links])
		if (json === last) return
		last = json
		parent.postMessage({ type: 'canvas:links', nonce, width: vw, height: vh, links }, parentOrigin)
	}
	const schedule = () => {
		if (!timer) timer = setTimeout(measure, Math.max(16, 100 - (performance.now() - lastAt))) as unknown as number
	}
	new MutationObserver(schedule).observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
	new ResizeObserver(schedule).observe(document.documentElement)
	for (const type of ['DOMContentLoaded', 'load', 'scroll', 'resize', 'transitionend', 'animationend']) {
		addEventListener(type, schedule, { capture: true, passive: true })
	}
	document.fonts?.ready.then(schedule)
	for (const ms of [300, 1000, 2500]) setTimeout(schedule, ms)
	// CSS animations move links without any event; keep measuring while some are running.
	setInterval(() => {
		if (document.getAnimations?.().some((a) => a.playState === 'running')) schedule()
	}, 250)
	schedule()
}

/** The item's HTML with the link reporter (and a <base> so relative URLs resolve as before) at the top of <head>. */
export function withLinkReporter(html: string, baseHref: string, nonce: string): string {
	const args = [nonce, location.origin, MAX_LINKS, MAX_RECTS].map((a) => JSON.stringify(a).replace(/</g, '\\u003c')).join(',')
	const base = /<base\b/i.test(html) ? '' : `<base href="${baseHref.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">`
	const inject = `${base}<script>(${linkReporter.toString()})(${args})</script>`
	// After the doctype (anything before it would put the document in quirks mode).
	const doctype = /^\s*(?:<!--[\s\S]*?-->\s*)*<!doctype[^>]*>/i.exec(html)
	return doctype ? doctype[0] + inject + html.slice(doctype[0].length) : inject + html
}

const docs = new Map<string, Promise<string | null>>()

/** The HTML source at the URL, or null if it can't be fetched (then the iframe loads it directly, without links). */
export function loadHtml(src: string): Promise<string | null> {
	let doc = docs.get(src)
	if (doc) {
		docs.delete(src)
	} else {
		doc = fetch(src)
			.then((res) => (res.ok ? res.text() : null))
			.catch(() => null)
		doc.then((text) => text === null && docs.delete(src))
	}
	docs.set(src, doc)
	if (docs.size > MAX_CACHED_DOCS) docs.delete(docs.keys().next().value!)
	return doc
}

export function makeNonce() {
	return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
}

export function isOpenableUrl(href: string) {
	try {
		return ['http:', 'https:', 'mailto:'].includes(new URL(href).protocol)
	} catch {
		return false
	}
}

/** The links in a message from an item's document, validated; null if it isn't a links message for this nonce. */
export function parseLinkMessage(data: unknown, nonce: string): { href: string; rects: Box[] }[] | null {
	const msg = data as { type?: unknown; nonce?: unknown; links?: unknown } | null
	if (!msg || typeof msg !== 'object' || msg.type !== LINK_MESSAGE || msg.nonce !== nonce || !Array.isArray(msg.links)) return null
	const links: { href: string; rects: Box[] }[] = []
	for (const link of msg.links.slice(0, MAX_LINKS) as { href?: unknown; rects?: unknown }[]) {
		if (!link || typeof link.href !== 'string' || link.href.length > MAX_HREF || !isOpenableUrl(link.href)) continue
		if (!Array.isArray(link.rects)) continue
		const rects: Box[] = []
		for (const r of link.rects.slice(0, MAX_RECTS) as unknown[]) {
			if (!Array.isArray(r) || r.length !== 4 || !r.every((n) => typeof n === 'number' && Number.isFinite(n))) continue
			const [x, y, w, h] = r as number[]
			if (w > 0 && h > 0) rects.push({ x, y, w, h })
		}
		if (rects.length) links.push({ href: link.href, rects })
	}
	return links
}

/** Where an HTML item's document sits on screen: its top-left and the scale from document px. */
export interface FrameTransform {
	x: number
	y: number
	sx: number
	sy: number
}

/**
 * The hovered link's highlight (over each of its rects) and its URL in a small tip, like a
 * browser's status bar. Sits just above the HTML items and below everything else in the overlay.
 */
export class LinkHover {
	private el: HTMLDivElement
	private marks: HTMLDivElement[] = []
	private tip: HTMLDivElement
	private shown = ''

	constructor(after: HTMLElement) {
		this.el = document.createElement('div')
		this.el.className = 'html-link-hover'
		this.tip = document.createElement('div')
		this.tip.className = 'html-link-tip'
		this.el.appendChild(this.tip)
		after.after(this.el)
	}

	update(link: HtmlLink | null, t: FrameTransform | null, viewport: { w: number; h: number }) {
		if (!link || !t) {
			if (this.shown) {
				this.shown = ''
				this.el.style.display = 'none'
			}
			return
		}
		this.el.style.display = ''
		if (this.shown !== link.href) {
			this.shown = link.href
			this.tip.textContent = link.href
		}
		while (this.marks.length < link.rects.length) {
			const mark = document.createElement('div')
			mark.className = 'html-link-mark'
			this.el.insertBefore(mark, this.tip)
			this.marks.push(mark)
		}
		let top = Infinity
		let bottom = -Infinity
		let left = Infinity
		this.marks.forEach((mark, i) => {
			const r = link.rects[i]
			if (!r) return void (mark.style.display = 'none')
			const x = t.x + r.x * t.sx
			const y = t.y + r.y * t.sy
			const w = r.w * t.sx
			const h = r.h * t.sy
			mark.style.display = ''
			mark.style.transform = `translate(${x}px, ${y}px)`
			mark.style.width = `${w}px`
			mark.style.height = `${h}px`
			top = Math.min(top, y)
			bottom = Math.max(bottom, y + h)
			left = Math.min(left, x)
		})
		// Under the link, flipped above it near the bottom of the screen, kept on screen.
		const tipW = this.tip.offsetWidth
		const tipH = this.tip.offsetHeight
		let ty = bottom + 6
		if (ty + tipH > viewport.h - 8) ty = top - tipH - 6
		const tx = Math.min(Math.max(8, left), viewport.w - tipW - 8)
		this.tip.style.transform = `translate(${Math.round(tx)}px, ${Math.round(Math.max(8, ty))}px)`
	}

	destroy() {
		this.el.remove()
	}
}
