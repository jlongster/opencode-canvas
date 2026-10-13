const MAX_PLAYING = 6

/**
 * Keeps <video> elements only for the videos that should be playing right now.
 * Everything else is drawn from its poster thumbnail, so idle videos cost nothing.
 */
export class VideoPool {
	private videos = new Map<string, HTMLVideoElement>()
	private host: HTMLDivElement

	constructor(parent: HTMLElement) {
		// Videos must live in the document for some browsers to keep decoding frames.
		this.host = document.createElement('div')
		this.host.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none'
		parent.appendChild(this.host)
	}

	sync(wanted: { id: string; src: string }[]) {
		const keep = new Set(wanted.slice(0, MAX_PLAYING).map((w) => w.id))
		for (const [id, video] of this.videos) {
			if (keep.has(id)) continue
			video.pause()
			video.removeAttribute('src')
			video.load()
			video.remove()
			this.videos.delete(id)
		}
		for (const { id, src } of wanted.slice(0, MAX_PLAYING)) {
			if (this.videos.has(id)) continue
			const video = document.createElement('video')
			video.muted = true
			video.loop = true
			video.playsInline = true
			video.preload = 'auto'
			video.src = src
			this.host.appendChild(video)
			video.play().catch(() => {})
			this.videos.set(id, video)
		}
	}

	/** A video that has a frame ready to draw. */
	getReady(id: string): HTMLVideoElement | undefined {
		const video = this.videos.get(id)
		return video && video.readyState >= 2 && video.videoWidth > 0 ? video : undefined
	}

	get isPlaying() {
		for (const v of this.videos.values()) if (!v.paused && v.readyState >= 2) return true
		return false
	}

	destroy() {
		this.sync([])
		this.host.remove()
	}
}
