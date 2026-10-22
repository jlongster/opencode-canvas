/**
 * Person items (media people dragged or pasted onto a session's frame, see Item.origin) as
 * attachments for a prompt to that session: which ones it doesn't have yet, and each as a file
 * OpenCode takes (images scaled to fit MAX_EDGE, a contact sheet for a video; HTML goes by
 * reference only). The prompt's text has to say which attachment is which item: models see the
 * files in order, without their names.
 */
import type { Item } from '../../../shared/types'
import { url as withBase } from '../base'
import { withServer } from '../opencode/pairings'

/** attachments are scaled to fit this many px (OpenCode scales anything over 2000 px itself, slowly) */
export const MAX_EDGE = 1600
/** at most this many files go with one prompt; items past it are referenced by id only */
export const FILES_MAX = 12
/** an image this small (and of a type models take) goes as it is */
const PASSTHROUGH_BYTES = 4 * 1024 * 1024
const PASSTHROUGH_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
/** a scaled image of at most this many pixels stays PNG; bigger opaque ones become JPEG */
const PNG_MAX_PIXELS = 1_000_000
const JPEG_QUALITY = 0.88

/** A file for OpenCode's prompt, with what the prompt's text says about it. */
export interface ItemAttachment {
	uri: string
	name: string
	description: string
	/** the size it was sent at */
	width: number
	height: number
	/** a video's contact sheet: the times (s) of its frames */
	sheetTimes?: number[]
}

/** Whether the session has the item's media: true for items people didn't add (see Item.delivered). */
export function inContext(item: Item, compactedAt = 0): boolean {
	if (item.origin !== 'person') return true
	const d = item.delivered
	return !!d && d.sessionId === item.sessionId && d.src === item.src && !(compactedAt > d.at)
}

/** The session's person items it doesn't have yet, oldest first. */
export function pendingItems(items: Record<string, Item>, sessionId: string, compactedAt = 0): Item[] {
	return Object.values(items)
		.filter((i) => i.sessionId === sessionId && i.origin === 'person' && !inContext(i, compactedAt))
		.sort((a, b) => a.createdAt - b.createdAt)
}

/** Whether an item goes as a file (an image, or a video's contact sheet); HTML goes by reference. */
export const attachable = (item: Item) => item.kind === 'image' || item.kind === 'video' || (item.kind === 'page' && !!item.src)

/** When the session last compacted (ms), or 0: what it was given before then is gone from its context. */
export async function lastCompaction(serverKey: string, sessionId: string): Promise<number> {
	try {
		const res = await withServer(serverKey, (c) =>
			c.message.list({ sessionID: sessionId, type: 'compaction', order: 'desc', limit: 1 }, { signal: AbortSignal.timeout(10_000) }),
		)
		const m = (res.data as { type?: string; time?: { created?: number } }[])[0]
		return m?.type === 'compaction' ? (m.time?.created ?? 0) : 0
	} catch {
		return 0
	}
}

/** The item as a prompt attachment (null for HTML, or a page without a screenshot). */
export async function itemAttachment(item: Item): Promise<ItemAttachment | null> {
	if (item.kind === 'video') {
		const res = await fetch(withBase(`/api/items/${encodeURIComponent(item.id)}/sheet`))
		if (!res.ok) throw new Error(`couldn't make a contact sheet of ${item.name} (${res.status})`)
		const blob = await res.blob()
		const bitmap = await createImageBitmap(blob)
		const size = { width: bitmap.width, height: bitmap.height }
		bitmap.close()
		const header = (res.headers.get('x-sheet-times') ?? '').split(',').filter(Boolean).map(Number)
		// (the header doesn't cross origins: the same times, the middles of 6 equal parts)
		const sheetTimes = header.length ? header : Array.from({ length: 6 }, (_, i) => Math.round((((item.duration ?? 0) * (i + 0.5)) / 6) * 100) / 100)
		return {
			uri: await toDataUrl(blob),
			name: `canvas-${item.id}-sheet.jpg`,
			description: `Canvas item ${item.id} "${item.name}"${by(item)}: contact sheet of 6 frames of a ${item.width}×${item.height} video`,
			...size,
			sheetTimes,
		}
	}
	if (!attachable(item)) return null
	const res = await fetch(withBase(item.src))
	if (!res.ok) throw new Error(`couldn't load ${item.name} (${res.status})`)
	const blob = await res.blob()
	const fits = Math.max(item.width, item.height) <= MAX_EDGE
	if (fits && blob.size <= PASSTHROUGH_BYTES && PASSTHROUGH_TYPES.includes(blob.type)) {
		return { uri: await toDataUrl(blob), name: `canvas-${item.id}-original${extOf(blob.type)}`, description: describe(item, item.width, item.height), width: item.width, height: item.height }
	}
	const { blob: scaled, width, height } = await fitImage(blob, MAX_EDGE)
	return { uri: await toDataUrl(scaled), name: `canvas-${item.id}-original${extOf(scaled.type)}`, description: describe(item, width, height), width, height }
}

const by = (item: Item) => (item.addedBy ? `, added by ${item.addedBy}` : '')

function describe(item: Item, width: number, height: number) {
	const sent = width === item.width && height === item.height ? '' : `, sent at ${width}×${height}`
	return `Canvas item ${item.id} "${item.name}"${by(item)}; original ${item.width}×${item.height}${sent}`
}

/**
 * An image scaled to fit max×max px (never enlarged): PNG when it's small or has transparency,
 * else JPEG.
 */
export async function fitImage(blob: Blob, max: number): Promise<{ blob: Blob; width: number; height: number }> {
	const bitmap = await createImageBitmap(blob)
	const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height))
	const width = Math.max(1, Math.round(bitmap.width * scale))
	const height = Math.max(1, Math.round(bitmap.height * scale))
	const canvas = new OffscreenCanvas(width, height)
	const ctx = canvas.getContext('2d')!
	ctx.drawImage(bitmap, 0, 0, width, height)
	bitmap.close()
	const png = width * height <= PNG_MAX_PIXELS || (blob.type !== 'image/jpeg' && hasAlpha(ctx, width, height))
	const out = await canvas.convertToBlob(png ? { type: 'image/png' } : { type: 'image/jpeg', quality: JPEG_QUALITY })
	return { blob: out, width, height }
}

/** Whether any pixel (of a sampled grid) is see-through. */
function hasAlpha(ctx: OffscreenCanvasRenderingContext2D, width: number, height: number) {
	const step = Math.max(1, Math.floor(Math.min(width, height) / 64))
	const data = ctx.getImageData(0, 0, width, height).data
	for (let y = 0; y < height; y += step) for (let x = 0; x < width; x += step) if (data[(y * width + x) * 4 + 3] < 250) return true
	return false
}

const extOf = (mime: string) => ({ 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' })[mime] ?? ''

export function toDataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader()
		reader.onload = () => resolve(String(reader.result))
		reader.onerror = () => reject(reader.error)
		reader.readAsDataURL(blob)
	})
}

/** The line a prompt's text says about a person item: which attachment (if any) is it, and what it is. */
export function itemReference(item: Item, attachment: ItemAttachment | null, index: number | null): string {
	const what = `canvas item ${item.id} "${item.name}" (${item.kind}, ${item.width}×${item.height}${item.kind === 'html' ? ' CSS px' : ''}${item.kind === 'video' && item.duration ? `, ${Math.round(item.duration * 10) / 10} s` : ''})`
	const who = `added by ${item.addedBy || 'someone'}`
	if (item.kind === 'html') return `${what}, ${who}: call get_item ${item.id} to read its HTML`
	if (!attachment || index === null) return `${what}, ${who}: not attached (too many files); get_item {itemId: "${item.id}", includeImage: true, fullSize: true} to see it`
	if (attachment.sheetTimes) {
		return `Attachment ${index}: ${what}, ${who}: a contact sheet of 6 frames at t=${attachment.sheetTimes.join(', ')} s; the video is ${withBase(item.src)} (curl or ffmpeg it for more)`
	}
	const scaled = attachment.width !== item.width ? `, sent at ${attachment.width}×${attachment.height} (×${round2(attachment.width / item.width)})` : ''
	return `Attachment ${index}: ${what}${scaled}, ${who}`
}

const round2 = (n: number) => Math.round(n * 100) / 100
