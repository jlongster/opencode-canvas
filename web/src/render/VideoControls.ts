import type { Item } from '../../../shared/types'
import type { Editor } from '../editor/Editor'
import { Box } from '../editor/geometry'
import { parseSelectionId } from '../editor/selection'
import { extractFrame, formatTime } from './extractFrame'
import { clock, segments } from './segments'
import type { VideoPool } from './VideoPool'
import './videoControls.css'

/** Screen px an item needs before it gets a badge, a centre glyph, the controls bar. */
const BADGE_MIN = { w: 64, h: 36 }
const GLYPH_MIN = 72
const CONTROLS_MIN = { w: 150, h: 64 }
/** One step of , and . while paused (most videos are 24–30 fps). */
const FRAME_STEP = 1 / 30
const EXTRACT_FEEDBACK_MS = 2500

const PLAY_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z"/></svg>'
const PAUSE_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>'
const SOUND_ICON =
	'<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5Z" fill="currentColor"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>'
const MUTED_ICON =
	'<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5Z" fill="currentColor"/><path d="m16 9 6 6M22 9l-6 6"/></svg>'
export const EXTRACT_ICON =
	'<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m21 16-5-5-8 8"/></svg>'

interface Marks {
	el: HTMLDivElement
	badge: HTMLDivElement
	duration: HTMLSpanElement
	glyph: HTMLDivElement
	style: string
	/** the timecode shown */
	text: string
}

/**
 * The DOM over video items: a badge with the video's length on each one (bottom-left), a play
 * glyph in the middle while it isn't playing, and a controls bar on the hovered one (play/pause,
 * time, a scrub bar, sound, and "Extract frame" while paused on edit links). All of it stays the
 * same size on screen at any zoom, and is left off items too small on screen to fit it.
 * K toggles the hovered (else the selected) video; while paused, , and . step a frame back and forth.
 * (Space is the editor's pan modifier.)
 */
export class VideoControls {
	private host: HTMLDivElement
	private marks = new Map<string, Marks>()
	private bar: HTMLDivElement
	private play: HTMLButtonElement
	private time: HTMLSpanElement
	private track: HTMLDivElement
	private fill: HTMLDivElement
	private mute: HTMLButtonElement
	private extractButton: HTMLButtonElement
	private extractLabel: HTMLSpanElement
	/** The item the bar is showing. */
	private barId: string | null = null
	private scrubbing: { id: string; pointerId: number } | null = null
	private overBar = false
	private extracting = new Set<string>()
	private feedbackTimer = 0
	private disposers: (() => void)[] = []

	constructor(
		parent: HTMLElement,
		private pool: VideoPool,
		private editor: Editor,
		/** View links: no extracting. */
		private readOnly: boolean,
	) {
		this.host = document.createElement('div')
		this.host.className = 'video-overlay'
		parent.appendChild(this.host)

		this.bar = document.createElement('div')
		this.bar.className = 'video-controls'
		this.play = button('vc-button vc-play', 'Play (K)', PLAY_ICON)
		this.time = document.createElement('span')
		this.time.className = 'vc-time'
		this.track = document.createElement('div')
		this.track.className = 'vc-scrub'
		this.track.innerHTML = '<div class="vc-track"><div class="vc-fill"></div></div>'
		this.fill = this.track.querySelector('.vc-fill')!
		this.mute = button('vc-button vc-mute', 'Unmute', MUTED_ICON)
		this.extractButton = button('vc-button vc-extract', 'Extract this frame as an image you can annotate', EXTRACT_ICON)
		this.extractLabel = document.createElement('span')
		this.extractLabel.textContent = 'Extract frame'
		this.extractButton.appendChild(this.extractLabel)
		this.bar.append(this.play, this.time, this.track, this.mute, this.extractButton)
		this.host.appendChild(this.bar)

		// Keep presses from reaching the canvas (which would select or start a brush).
		for (const type of ['pointerdown', 'dblclick'] as const) this.bar.addEventListener(type, (e) => e.stopPropagation())
		// Clicks shouldn't leave a button focused (Space would then press it instead of panning).
		this.bar.addEventListener('mousedown', (e) => e.preventDefault())
		this.bar.addEventListener('pointerenter', () => (this.overBar = true))
		this.bar.addEventListener('pointerleave', () => (this.overBar = false))
		this.play.addEventListener('click', () => this.barId && this.pool.toggle(this.barId))
		this.mute.addEventListener('click', () => {
			const item = this.barId ? this.editor.items.peek()[this.barId] : undefined
			if (item) this.pool.setMuted(item.id, !this.pool.state(item).muted)
		})
		this.extractButton.addEventListener('click', () => this.barId && this.extract(this.barId))
		this.track.addEventListener('pointerdown', this.onScrubDown)
		this.track.addEventListener('pointermove', this.onScrubMove)
		this.track.addEventListener('pointerup', this.onScrubUp)
		this.track.addEventListener('pointercancel', this.onScrubUp)

		window.addEventListener('keydown', this.onKeyDown)
		this.disposers.push(() => window.removeEventListener('keydown', this.onKeyDown))
	}

	/** Whether "Extract frame" applies to the item now: an edit link, a video paused on a loaded frame. */
	canExtract(item: Item | undefined): boolean {
		if (this.readOnly || item?.kind !== 'video' || this.extracting.has(item.id)) return false
		const state = this.pool.state(item)
		return !state.playing && !!this.pool.getReady(item.id)
	}

	/** Posts the video's current frame as an image item, then selects and focuses it (ready for A to annotate). */
	async extract(id: string) {
		const item = this.editor.items.peek()[id]
		const video = this.pool.getReady(id)
		if (!item || !video || !this.canExtract(item)) return
		this.extracting.add(id)
		this.showFeedback('Extracting…', false)
		try {
			const frame = await extractFrame(video, item, this.editor.items.peek())
			this.editor.putItem(frame)
			this.editor.focusSelectionKey(frame.id)
			this.showFeedback('Extracted', false)
		} catch (e) {
			console.error('extracting the frame failed', e)
			this.showFeedback('Failed', true, e instanceof Error ? e.message : String(e))
		} finally {
			this.extracting.delete(id)
		}
	}

	private showFeedback(text: string, error: boolean, detail?: string) {
		clearTimeout(this.feedbackTimer)
		this.extractLabel.textContent = text
		this.extractButton.classList.toggle('failed', error)
		if (detail) this.extractButton.title = `Couldn't extract the frame: ${detail}`
		if (text === 'Extracting…') return
		this.feedbackTimer = window.setTimeout(() => {
			this.extractLabel.textContent = 'Extract frame'
			this.extractButton.classList.remove('failed')
			this.extractButton.title = 'Extract this frame as an image you can annotate'
		}, EXTRACT_FEEDBACK_MS)
	}

	update(items: Record<string, Item>, displayed: Map<string, { x: number; y: number; w: number; h: number; opacity: number }>, view: Box) {
		const editor = this.editor
		const z = editor.camera.peek().z
		const hovered = editor.hoveredId.peek()
		const selectTool = editor.toolPath.peek().startsWith('select')
		const busy = editor.inputs.isPointing && !this.scrubbing

		// The bar: on the hovered video (kept while scrubbing it or with the pointer on the bar).
		let barId: string | null = this.scrubbing?.id ?? null
		if (!barId && selectTool && !busy) {
			if (hovered && items[hovered]?.kind === 'video') barId = hovered
			else if (this.overBar && this.barId && items[this.barId]) barId = this.barId
		}
		const barBox = barId ? displayed.get(barId) : undefined
		if (barId && (!barBox || barBox.w * z < CONTROLS_MIN.w || barBox.h * z < CONTROLS_MIN.h)) barId = null
		this.barId = barId

		const seen = new Set<string>()
		for (const [id, d] of displayed) {
			const item = items[id]
			if (item?.kind !== 'video' || !Box.intersects(d, view)) continue
			const sw = d.w * z
			const sh = d.h * z
			if (sw < BADGE_MIN.w || sh < BADGE_MIN.h) continue
			seen.add(id)
			const m = this.marks.get(id) ?? this.mountMarks(id)
			const state = this.pool.state(item)
			const duration = state.duration
			// its timecode in seven segments: where it is once played, else how long it is
			const at = state.time > 0 ? state.time : duration
			const text = at !== undefined ? clock(at * 1000) : ''
			if (m.text !== text) {
				m.text = text
				m.duration.innerHTML = text ? segments(text, 9) : ''
				m.badge.hidden = !text
			}
			const p = editor.pageToScreen(d)
			const style = `transform:translate(${p.x}px,${p.y}px);width:${sw}px;height:${sh}px;opacity:${d.opacity}`
			if (m.style !== style) m.el.style.cssText = m.style = style
			m.badge.hidden = id === barId || !text
			m.glyph.hidden = state.playing || Math.min(sw, sh) < GLYPH_MIN
		}
		for (const [id, m] of this.marks) {
			if (seen.has(id)) continue
			m.el.remove()
			this.marks.delete(id)
		}

		if (!barId || !barBox) {
			this.bar.style.display = 'none'
			return
		}
		const item = items[barId]
		const state = this.pool.state(item)
		const sw = barBox.w * z
		const p = editor.pageToScreen({ x: barBox.x, y: barBox.y + barBox.h })
		this.bar.style.display = 'flex'
		this.bar.style.transform = `translate(${p.x + 6}px, calc(${p.y - 6}px - 100%))`
		this.bar.style.width = `${sw - 12}px`
		this.bar.style.opacity = String(barBox.opacity)
		this.bar.classList.toggle('narrow', sw < 280)
		this.bar.classList.toggle('compact', sw < 320)

		const playing = state.playing
		setIcon(this.play, playing ? PAUSE_ICON : PLAY_ICON)
		this.play.title = playing ? 'Pause (K)' : 'Play (K)'
		this.play.setAttribute('aria-label', playing ? 'Pause' : 'Play')
		const duration = state.duration
		const timeText = duration !== undefined ? `${formatTime(state.time)} / ${formatTime(duration)}` : formatTime(state.time)
		if (this.time.textContent !== timeText) this.time.textContent = timeText
		const fraction = duration ? Math.min(1, state.time / duration) : 0
		this.fill.style.width = `${fraction * 100}%`
		this.mute.hidden = !state.hasAudio
		this.mute.classList.toggle('muted', state.muted)
		setIcon(this.mute, state.muted ? MUTED_ICON : SOUND_ICON)
		this.mute.title = state.muted ? 'Unmute' : 'Mute'
		this.extractButton.hidden = this.readOnly || state.playing || !state.loaded
		this.extractButton.disabled = this.extracting.has(barId) || !this.pool.getReady(barId)
	}

	private mountMarks(id: string): Marks {
		const el = document.createElement('div')
		el.className = 'video-marks'
		const badge = document.createElement('div')
		badge.className = 'video-badge'
		const duration = document.createElement('span')
		badge.appendChild(duration)
		const glyph = document.createElement('div')
		glyph.className = 'video-glyph'
		glyph.innerHTML = PLAY_ICON.replace(/width="14" height="14"/, 'width="22" height="22"')
		el.append(glyph, badge)
		this.host.insertBefore(el, this.bar)
		const m: Marks = { el, badge, duration, glyph, style: '', text: '' }
		this.marks.set(id, m)
		return m
	}

	// ---------- scrubbing ----------

	private seekTo(e: PointerEvent, id: string) {
		const item = this.editor.items.peek()[id]
		const duration = item && this.pool.duration(item)
		if (!duration) return
		const rect = this.track.getBoundingClientRect()
		const fraction = Math.min(1, Math.max(0, (e.clientX - rect.left) / Math.max(1, rect.width)))
		this.pool.seek(id, fraction * duration)
	}

	private onScrubDown = (e: PointerEvent) => {
		if (!this.barId || e.button !== 0) return
		e.preventDefault()
		this.track.setPointerCapture(e.pointerId)
		this.scrubbing = { id: this.barId, pointerId: e.pointerId }
		this.track.classList.add('scrubbing')
		this.seekTo(e, this.barId)
	}

	private onScrubMove = (e: PointerEvent) => {
		if (this.scrubbing?.pointerId !== e.pointerId) return
		this.seekTo(e, this.scrubbing.id)
	}

	private onScrubUp = (e: PointerEvent) => {
		if (this.scrubbing?.pointerId !== e.pointerId) return
		if (this.track.hasPointerCapture(e.pointerId)) this.track.releasePointerCapture(e.pointerId)
		this.scrubbing = null
		this.track.classList.remove('scrubbing')
	}

	// ---------- keyboard ----------

	/** The video K acts on: the hovered one, else the only selected item if it's a video. */
	private keyTarget(): Item | undefined {
		const items = this.editor.items.peek()
		const hovered = this.editor.hoveredId.peek()
		if (hovered && items[hovered]?.kind === 'video') return items[hovered]
		const selected = this.editor.selectedIds.peek()
		if (selected.length !== 1 || parseSelectionId(selected[0]).kind !== 'item') return undefined
		const item = items[selected[0]]
		return item?.kind === 'video' ? item : undefined
	}

	private onKeyDown = (e: KeyboardEvent) => {
		if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || isEditable(e.target)) return
		const key = e.key.toLowerCase()
		if (key !== 'k' && key !== ',' && key !== '.') return
		const item = this.keyTarget()
		if (!item) return
		if (key === 'k') {
			e.preventDefault()
			this.pool.toggle(item.id)
			return
		}
		const state = this.pool.state(item)
		if (state.playing || !state.loaded) return
		e.preventDefault()
		this.pool.seek(item.id, state.time + (key === '.' ? FRAME_STEP : -FRAME_STEP))
	}

	destroy() {
		clearTimeout(this.feedbackTimer)
		for (const d of this.disposers.splice(0)) d()
		this.host.remove()
	}
}

function button(className: string, title: string, icon: string) {
	const b = document.createElement('button')
	b.className = className
	b.title = title
	b.type = 'button'
	b.innerHTML = icon
	return b
}

const icons = new WeakMap<HTMLElement, string>()

/** Swaps the button's icon, keeping its label, only when it changes. */
function setIcon(el: HTMLElement, icon: string) {
	if (icons.get(el) === icon) return
	icons.set(el, icon)
	const label = el.querySelector('span')
	el.innerHTML = icon
	if (label) el.appendChild(label)
}

function isEditable(target: EventTarget | null) {
	const el = target as HTMLElement | null
	return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
}
