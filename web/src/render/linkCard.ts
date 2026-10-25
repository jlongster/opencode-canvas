import type { Item } from '../../../shared/types'

/**
 * The link card a page item without a screenshot shows: drawn here, in the browser (nothing fetches
 * the page), as a PNG data URL the texture cache loads like any image. Cards are drawn at SCALE×
 * the item's size so they stay crisp zoomed in.
 */
const SCALE = 2
const FONT = 'Archivo, system-ui, -apple-system, "Segoe UI", sans-serif'
const MONO = '"Courier Prime", ui-monospace, Menlo, Consolas, monospace'

/** Where the "Open" pill sits on the card, as fractions of its width and height (PageBadges puts a button there). */
export function linkCardOpenBox(width: number, height: number) {
	const u = Math.min(width / 800, height / 500)
	const w = 132 * u
	const h = 40 * u
	return { x: (width - w) / 2 / width, y: (height / 2 + 112 * u - h / 2) / height, w: w / width, h: h / height }
}

const cards = new Map<string, string>()

export function linkCardUrl(item: Pick<Item, 'width' | 'height' | 'title' | 'pageUrl' | 'page'>): string {
	const url = item.pageUrl ?? item.page?.url ?? ''
	// drawn again once the app's font has loaded
	const fontReady = typeof document.fonts?.check === 'function' && document.fonts.check('16px Archivo')
	const key = `${fontReady ? 1 : 0}|${item.width}x${item.height}|${item.title ?? ''}|${url}`
	let card = cards.get(key)
	if (!card) {
		card = drawCard(item.width, item.height, item.title?.trim() || hostOf(url), url)
		if (cards.size > 200) cards.delete(cards.keys().next().value!)
		cards.set(key, card)
	}
	return card
}

function hostOf(url: string) {
	try {
		return new URL(url).host.replace(/^www\./, '') || url
	} catch {
		return url || 'Link'
	}
}

function drawCard(width: number, height: number, title: string, url: string): string {
	const canvas = document.createElement('canvas')
	canvas.width = Math.round(width * SCALE)
	canvas.height = Math.round(height * SCALE)
	const c = canvas.getContext('2d')!
	c.scale(SCALE, SCALE)
	// 1 unit = 1 CSS px of an 800×500 card
	const u = Math.min(width / 800, height / 500)
	const cx = width / 2
	const cy = height / 2

	// a sheet of paper, its address ruled off along the top
	c.fillStyle = '#fbfaf6'
	c.fillRect(0, 0, width, height)
	c.fillStyle = '#e9e6de'
	c.fillRect(0, 0, width, 34 * u)
	c.fillStyle = '#151515'
	c.fillRect(0, 34 * u, width, Math.max(1, u))

	// globe, in ink
	const gy = cy - 78 * u
	const r = 22 * u
	c.strokeStyle = '#151515'
	c.lineWidth = 1.6 * u
	c.beginPath()
	c.arc(cx, gy, r, 0, Math.PI * 2)
	c.moveTo(cx - r, gy)
	c.lineTo(cx + r, gy)
	c.stroke()
	c.beginPath()
	c.ellipse(cx, gy, r * 0.45, r, 0, 0, Math.PI * 2)
	c.stroke()

	c.textAlign = 'center'
	c.textBaseline = 'middle'
	const maxW = width - 96 * u
	c.fillStyle = '#151515'
	c.font = `600 ${30 * u}px ${FONT}`
	c.fillText(fit(c, title, maxW), cx, cy + 4 * u)
	c.fillStyle = '#8a877f'
	c.font = `${15 * u}px ${MONO}`
	c.fillText(fit(c, url, maxW), cx, cy + 46 * u)
	c.textAlign = 'left'
	c.fillStyle = '#4f4d48'
	c.font = `${14 * u}px ${MONO}`
	c.fillText(fit(c, hostOf(url).toUpperCase(), width - 32 * u), 16 * u, 17 * u)
	c.textAlign = 'center'

	// "Open" (a real button sits on it, see PageBadges)
	const box = linkCardOpenBox(width, height)
	const px = box.x * width
	const py = box.y * height
	const pw = box.w * width
	const ph = box.h * height
	c.fillStyle = '#fbfaf6'
	c.fillRect(px, py, pw, ph)
	c.strokeStyle = '#151515'
	c.lineWidth = 1.5 * u
	c.strokeRect(px, py, pw, ph)
	c.fillStyle = '#151515'
	c.font = `600 ${16 * u}px ${FONT}`
	c.fillText('Open ↗', cx, py + ph / 2 + 0.5 * u)

	return canvas.toDataURL('image/png')
}

/** `text` cut to `max` px wide with an ellipsis. */
function fit(c: CanvasRenderingContext2D, text: string, max: number) {
	if (c.measureText(text).width <= max) return text
	let lo = 0
	let hi = text.length
	while (lo < hi) {
		const mid = Math.ceil((lo + hi) / 2)
		if (c.measureText(text.slice(0, mid) + '…').width <= max) lo = mid
		else hi = mid - 1
	}
	return text.slice(0, lo) + '…'
}
