import { Marked, type Tokens } from 'marked'

/**
 * Markdown for worm speech bubbles (conjured worms' replies, agents' `say`). Safe to put in
 * innerHTML: raw HTML in the source is shown as text, links only keep http(s) and mailto URLs (and
 * open in a new tab), and images become links to them. Everything else is escaped by marked.
 */
const SAFE_URL = /^(https?:|mailto:)/i

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

function safeHref(href: string): string | null {
	try {
		const u = new URL(href.trim())
		return SAFE_URL.test(u.protocol) ? u.href : null
	} catch {
		return null
	}
}

const marked = new Marked({
	gfm: true,
	breaks: true,
	async: false,
	renderer: {
		html({ text }: Tokens.HTML | Tokens.Tag) {
			return escapeHtml(text)
		},
		link({ href, title, tokens }: Tokens.Link) {
			const text = this.parser.parseInline(tokens)
			const url = safeHref(href)
			if (!url) return text
			const t = title ? ` title="${escapeHtml(title)}"` : ''
			return `<a href="${escapeHtml(url)}"${t} target="_blank" rel="noopener noreferrer">${text}</a>`
		},
		image({ href, text }: Tokens.Image) {
			const url = safeHref(href)
			const label = escapeHtml(text || href)
			return url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label
		},
	},
})

/** The text as sanitized HTML. Partial text (still streaming) renders as far as it goes. */
export function markdownToHtml(text: string): string {
	return marked.parse(text) as string
}
