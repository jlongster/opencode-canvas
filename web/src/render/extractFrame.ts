import type { Item } from '../../../shared/types'
import { uploadItem } from '../sync/client'

/** "1:05", or with tenths ("1:05.3") for frame times; hours when needed. */
export function formatTime(seconds: number, tenths = false): string {
	const t = Math.max(0, seconds)
	const whole = tenths ? Math.floor(t * 10) / 10 : Math.floor(t)
	const h = Math.floor(whole / 3600)
	const m = Math.floor((whole % 3600) / 60)
	const s = whole % 60
	const ss = tenths ? s.toFixed(1).padStart(4, '0') : String(Math.floor(s)).padStart(2, '0')
	return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** What a video is called: its title, else its file name without the extension. */
export function videoLabel(item: Item) {
	return item.title?.trim() || item.name.replace(/\.[a-z0-9]{2,4}$/i, '') || item.id
}

/**
 * The video's current frame, at its full resolution, posted as a new image item in the video's
 * session and group, right after the video (and any frames already taken from it). The video's
 * element must be CORS-readable (VideoPool loads it with crossOrigin), or the canvas is tainted.
 */
export async function extractFrame(video: HTMLVideoElement, item: Item, items: Record<string, Item>): Promise<Item> {
	const time = video.currentTime
	const w = video.videoWidth
	const h = video.videoHeight
	if (!w || !h) throw new Error('the video has no frame to extract yet')
	const canvas = document.createElement('canvas')
	canvas.width = w
	canvas.height = h
	const ctx = canvas.getContext('2d')
	if (!ctx) throw new Error('no 2D canvas available')
	ctx.drawImage(video, 0, 0, w, h)
	const blob = await new Promise<Blob>((resolve, reject) =>
		canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('could not encode the frame'))), 'image/png'),
	)

	const label = videoLabel(item)
	const at = formatTime(time, true)
	const safe = label.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || item.id
	return uploadItem(item.canvasId, item.sessionId, blob, {
		filename: `${safe}-${time.toFixed(1)}s.png`,
		group: item.group,
		title: `${label} @ ${at}`,
		caption: `Frame at ${at} (${time.toFixed(3)} s) of the video "${label}" (item ${item.id})`,
		createdAt: createdAtAfter(item, items),
		sourceItemId: item.id,
		sourceTime: Math.round(time * 1000) / 1000,
	})
}

/**
 * A createdAt that orders a new item right after the video in its group, after frames already
 * extracted from it (1 ms after the last one, so a whole series fits before whatever came next).
 */
function createdAtAfter(video: Item, items: Record<string, Item>): number {
	const siblings = Object.values(items)
		.filter((i) => i.canvasId === video.canvasId && i.sessionId === video.sessionId && (i.group ?? '') === (video.group ?? ''))
		.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
	let index = siblings.findIndex((i) => i.id === video.id)
	while (siblings[index + 1]?.sourceItemId === video.id) index++
	return (siblings[index]?.createdAt ?? video.createdAt) + 1
}
