import type { Item } from '../../../shared/types'

const MAX_PLAYING = 6
/** Videos whose length is being read (metadata only) at once, for badges of items without a stored duration. */
const MAX_PROBES = 2
/** Give up on reading a length after this long. */
const PROBE_TIMEOUT_MS = 15_000

/**
 * What the viewer chose for a video with the controls: kept per item, in this tab only, so a
 * paused video stays on its frame (and a played one keeps playing) while it's on screen, and comes
 * back where it was after its element was let go.
 */
interface Playback {
	paused: boolean
	time: number
	muted: boolean
}

export interface VideoState {
	/** an element exists for it (it may still be loading) */
	loaded: boolean
	playing: boolean
	time: number
	/** seconds, once known */
	duration: number | undefined
	muted: boolean
	/** true once the element is known to have sound */
	hasAudio: boolean
	/** the viewer has played, paused or seeked it (it stays mounted while visible) */
	touched: boolean
}

/**
 * Keeps <video> elements only for the videos that should be playing (or showing a paused frame)
 * right now. Everything else is drawn from its poster thumbnail, so idle videos cost nothing.
 * Without a choice from the viewer, a video plays muted on a loop while hovered or selected, unless
 * the system asks for reduced motion.
 */
export class VideoPool {
	private videos = new Map<string, HTMLVideoElement>()
	private playback = new Map<string, Playback>()
	/** Lengths read in the browser, by src; null when it couldn't be read. */
	private durations = new Map<string, number | null>()
	private probes = new Map<string, HTMLVideoElement>()
	private probeQueue: string[] = []
	private reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')
	private host: HTMLDivElement
	/** Something visible changed without the video playing (seeked, paused, loaded…): draw a frame. */
	private dirty = false

	constructor(parent: HTMLElement) {
		// Videos must live in the document for some browsers to keep decoding frames.
		this.host = document.createElement('div')
		this.host.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none'
		parent.appendChild(this.host)
	}

	get autoplay() {
		return !this.reducedMotion?.matches
	}

	/** Items the viewer has played or paused: they stay mounted while visible. */
	touchedIds() {
		return this.playback.keys()
	}

	sync(wanted: { id: string; src: string }[]) {
		const keep = new Set(wanted.slice(0, MAX_PLAYING).map((w) => w.id))
		for (const [id, video] of this.videos) {
			if (keep.has(id)) continue
			const state = this.playback.get(id)
			if (state) state.time = video.currentTime
			video.pause()
			video.removeAttribute('src')
			video.load()
			video.remove()
			this.videos.delete(id)
		}
		for (const { id, src } of wanted.slice(0, MAX_PLAYING)) {
			if (this.videos.has(id)) continue
			const state = this.playback.get(id)
			const video = document.createElement('video')
			video.muted = state?.muted ?? true
			video.loop = true
			video.playsInline = true
			video.preload = 'auto'
			// media may come from another origin (the app served on localhost): frames must stay readable for the GPU
			// (and for extracting frames into a canvas)
			video.crossOrigin = 'anonymous'
			video.src = src
			const changed = () => (this.dirty = true)
			for (const type of ['loadeddata', 'seeked', 'pause', 'play', 'volumechange', 'durationchange']) video.addEventListener(type, changed)
			video.addEventListener('loadedmetadata', () => {
				if (validDuration(video.duration)) this.durations.set(src, video.duration)
				if (state?.time) video.currentTime = state.time
			})
			this.host.appendChild(video)
			if (state ? !state.paused : this.autoplay) video.play().catch(() => {})
			this.videos.set(id, video)
		}
	}

	/** A video that has a frame ready to draw. */
	getReady(id: string): HTMLVideoElement | undefined {
		const video = this.videos.get(id)
		return video && video.readyState >= 2 && video.videoWidth > 0 ? video : undefined
	}

	/**
	 * The video's length in seconds: the server's (from ffprobe), else the playing element's, else one
	 * read in the browser, which starts reading it if needed. Undefined while unknown, never NaN/Infinity.
	 */
	duration(item: Item): number | undefined {
		if (validDuration(item.duration)) return item.duration
		const video = this.videos.get(item.id)
		if (video && validDuration(video.duration)) return video.duration
		const src = item.src
		const known = this.durations.get(src)
		if (known !== undefined) return known ?? undefined
		if (!this.probes.has(src) && !this.probeQueue.includes(src)) {
			this.probeQueue.push(src)
			this.runProbes()
		}
		return undefined
	}

	private runProbes() {
		while (this.probes.size < MAX_PROBES && this.probeQueue.length) {
			const src = this.probeQueue.shift()!
			const probe = document.createElement('video')
			probe.preload = 'metadata'
			probe.muted = true
			probe.crossOrigin = 'anonymous'
			let finished = false
			const finish = (duration: number | null) => {
				// Clearing the src below fires an error event of its own: only the first outcome counts.
				if (finished) return
				finished = true
				clearTimeout(timer)
				this.durations.set(src, duration)
				probe.removeAttribute('src')
				probe.load()
				this.probes.delete(src)
				this.dirty = true
				this.runProbes()
			}
			const timer = window.setTimeout(() => finish(null), PROBE_TIMEOUT_MS)
			// Files without a length in their header (MediaRecorder WebM) report Infinity until read to
			// the end: seeking far past the end makes the browser find it.
			const check = () => {
				if (validDuration(probe.duration)) finish(probe.duration)
				else if (probe.duration === Infinity && probe.currentTime < 1e9) probe.currentTime = 1e10
			}
			probe.addEventListener('loadedmetadata', check)
			probe.addEventListener('durationchange', check)
			probe.addEventListener('seeked', check)
			probe.addEventListener('error', () => finish(null), { once: true })
			probe.src = src
			this.probes.set(src, probe)
		}
	}

	state(item: Item): VideoState {
		const video = this.videos.get(item.id)
		const playback = this.playback.get(item.id)
		return {
			loaded: !!video,
			playing: video ? !video.paused : !!playback && !playback.paused,
			time: video ? video.currentTime : (playback?.time ?? 0),
			duration: this.duration(item),
			muted: video ? video.muted : (playback?.muted ?? true),
			hasAudio: video ? hasAudio(video) : false,
			touched: !!playback,
		}
	}

	private remember(id: string): Playback {
		let state = this.playback.get(id)
		if (!state) {
			const video = this.videos.get(id)
			state = { paused: video ? video.paused : true, time: video?.currentTime ?? 0, muted: video?.muted ?? true }
			this.playback.set(id, state)
		}
		return state
	}

	/** Play or pause. Without an element yet, the choice applies once it's mounted. */
	setPlaying(id: string, playing: boolean) {
		const state = this.remember(id)
		state.paused = !playing
		const video = this.videos.get(id)
		if (video) {
			if (playing) video.play().catch(() => {})
			else video.pause()
			state.time = video.currentTime
		}
		this.dirty = true
	}

	toggle(id: string) {
		const video = this.videos.get(id)
		const playing = video ? !video.paused : !(this.playback.get(id)?.paused ?? !this.autoplay)
		this.setPlaying(id, !playing)
	}

	seek(id: string, time: number) {
		const state = this.remember(id)
		const video = this.videos.get(id)
		const duration = video && Number.isFinite(video.duration) ? video.duration : Infinity
		const t = Math.max(0, Math.min(time, duration))
		state.time = t
		if (video) video.currentTime = t
		this.dirty = true
	}

	setMuted(id: string, muted: boolean) {
		this.remember(id).muted = muted
		const video = this.videos.get(id)
		if (video) video.muted = muted
		this.dirty = true
	}

	/** Whether something changed that needs a frame drawn (and clears it). */
	takeDirty() {
		const dirty = this.dirty
		this.dirty = false
		return dirty
	}

	get isPlaying() {
		for (const v of this.videos.values()) if (!v.paused && v.readyState >= 2) return true
		return false
	}

	destroy() {
		this.sync([])
		for (const probe of this.probes.values()) probe.removeAttribute('src')
		this.probes.clear()
		this.probeQueue = []
		this.host.remove()
	}
}

function validDuration(d: number | undefined): d is number {
	return typeof d === 'number' && Number.isFinite(d) && d > 0
}

/** Whether the browser says the video has sound (each exposes it differently; unknown counts as none). */
function hasAudio(video: HTMLVideoElement) {
	const v = video as HTMLVideoElement & {
		mozHasAudio?: boolean
		webkitAudioDecodedByteCount?: number
		audioTracks?: { length: number }
	}
	if (v.mozHasAudio !== undefined) return v.mozHasAudio
	if (v.audioTracks) return v.audioTracks.length > 0
	return (v.webkitAudioDecodedByteCount ?? 0) > 0
}
