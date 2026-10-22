import { sessionColor } from '../../../shared/sessionColor'
import type { Editor } from '../editor/Editor'
import type { Vec } from '../editor/geometry'
import { PASTED_SESSION_ID, showWhenLaidOut } from '../ui/pastePage'
import { uploadItem } from '../sync/client'
import type { Presence } from './Presence'
import type { SessionControl } from './SessionControl'
import '../ui/frameDrop.css'

const VIDEO_MAX_BYTES = 200 * 1024 * 1024
const OTHER_MAX_BYTES = 50 * 1024 * 1024
const HTML_FILE = /\.html?$/i

/**
 * Edit links: media files (images, videos, HTML files) dropped or pasted onto a session's frame
 * become items in it, marked as added by you (Item.origin 'person'): references for the session,
 * which go to it with the next Submit annotations or prompt from the frame (see itemAttachments.ts).
 * While dragging, the frame under the pointer is outlined in its colour. Files dropped anywhere
 * else are swallowed, so the tab doesn't navigate away to them. (The open prompt bubble takes its
 * own drops: images attached to that one prompt.)
 */
export class FrameDrop {
	private outline: HTMLDivElement
	private label: HTMLDivElement
	private target: string | null = null
	private depth = 0
	private disposers: (() => void)[] = []

	constructor(
		/** the canvas's container: drops count on it (not on other UI) */
		private container: HTMLElement,
		overlay: HTMLElement,
		private editor: Editor,
		private presence: Presence,
		private sessions: SessionControl,
		private canvasId: string,
	) {
		this.outline = document.createElement('div')
		this.outline.className = 'frame-drop'
		this.label = document.createElement('div')
		this.label.className = 'frame-drop-label'
		overlay.append(this.outline, this.label)
		this.hide()
		const on = <K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void) => {
			window.addEventListener(type, fn)
			this.disposers.push(() => window.removeEventListener(type, fn))
		}
		on('dragenter', (e) => {
			if (!isFileDrag(e)) return
			e.preventDefault()
			this.depth++
			this.track(e)
		})
		on('dragover', (e) => {
			if (!isFileDrag(e)) return
			e.preventDefault()
			this.track(e)
		})
		on('dragleave', (e) => {
			if (!isFileDrag(e)) return
			this.depth = Math.max(0, this.depth - 1)
			if (!this.depth) this.hide()
		})
		on('drop', (e) => {
			if (!isFileDrag(e)) return
			// Never the browser's default: it would open the file in place of the canvas.
			e.preventDefault()
			this.depth = 0
			const sessionId = this.frameAt(e)
			this.hide()
			if (sessionId && e.dataTransfer) void this.add(sessionId, [...e.dataTransfer.files], this.pagePoint(e))
		})
		const onPaste = (e: ClipboardEvent) => {
			if (editable(e.target) || editable(document.activeElement)) return
			const files = [...(e.clipboardData?.files ?? [])]
			if (!files.length) return
			const pointer = this.editor.pointerPage.peek()
			const sessionId = (pointer && this.frameNear(pointer)) || this.ownFrame(this.sessions.selectedSession())
			if (!sessionId) {
				this.editor.deletions.notify('Point at a session’s frame (or select something in it) to paste files into it')
				return
			}
			e.preventDefault()
			void this.add(sessionId, files, pointer)
		}
		document.addEventListener('paste', onPaste)
		this.disposers.push(() => document.removeEventListener('paste', onPaste))
	}

	destroy() {
		for (const d of this.disposers.splice(0)) d()
		this.outline.remove()
		this.label.remove()
	}

	/** Uploads the media files as person items in the session's frame (into the group under `at`, if any), then shows the first. */
	async add(sessionId: string, files: File[], at: Vec | null) {
		const problems: string[] = []
		const media = files.filter((f) => {
			const kind = kindOf(f)
			if (!kind) problems.push(`${f.name || 'that file'} isn't an image, video or HTML file`)
			else if (f.size > (kind === 'video' ? VIDEO_MAX_BYTES : OTHER_MAX_BYTES)) problems.push(`${f.name} is over ${(kind === 'video' ? VIDEO_MAX_BYTES : OTHER_MAX_BYTES) / 1024 / 1024} MB`)
			else return true
			return false
		})
		if (!media.length) {
			if (problems.length) this.editor.deletions.notify(`Couldn't add it: ${problems.join('; ')}`)
			return
		}
		const title = this.sessions.label(sessionId)
		const addedBy = this.presence.me.peek().name.trim().slice(0, 60) || 'someone'
		const group = at ? this.groupAt(sessionId, at) : undefined
		this.editor.deletions.notify(`Adding ${media.length === 1 ? media[0].name || 'a file' : `${media.length} files`} to ${title}…`)
		const results = await Promise.allSettled(media.map((f) => uploadItem(this.canvasId, sessionId, f, { filename: f.name || fallbackName(f), addedBy, group })))
		const added = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
		for (const r of results) if (r.status === 'rejected') problems.push((r.reason as Error).message)
		if (added.length) showWhenLaidOut(this.editor, added[0].id)
		if (problems.length) this.editor.deletions.notify(`Couldn't add ${problems.length === 1 ? 'a file' : `${problems.length} files`}: ${problems.join('; ')}`)
		else this.editor.deletions.notify(`Added ${added.length === 1 ? added[0].name : `${added.length} files`} to ${title} · goes with your next prompt or Submit annotations`)
	}

	private pagePoint(e: DragEvent): Vec {
		const rect = this.container.getBoundingClientRect()
		return this.editor.screenToPage({ x: e.clientX - rect.left, y: e.clientY - rect.top })
	}

	/** The frame a drag is over (only over the canvas itself, not other UI). */
	private frameAt(e: DragEvent): string | null {
		if (!this.container.contains(e.target as Node)) return null
		return this.frameNear(this.pagePoint(e))
	}

	private frameNear(point: Vec): string | null {
		return this.ownFrame(this.sessions.sessionAt(point))
	}

	/** A session frame that takes media (not the pasted links' frame). */
	private ownFrame(sessionId: string | null) {
		return sessionId && sessionId !== PASTED_SESSION_ID ? sessionId : null
	}

	private groupAt(sessionId: string, point: Vec): string | undefined {
		for (const g of this.editor.layout.get().groups) {
			if (g.sessionId !== sessionId || !g.name) continue
			const b = g.box
			if (point.x >= b.x && point.x <= b.x + b.w && point.y >= b.y && point.y <= b.y + b.h) return g.name
		}
		return undefined
	}

	private track(e: DragEvent) {
		const sessionId = this.frameAt(e)
		if (e.dataTransfer) e.dataTransfer.dropEffect = sessionId ? 'copy' : 'none'
		const rect = this.container.getBoundingClientRect()
		const over = this.container.contains(e.target as Node)
		if (!over) return this.hide()
		this.label.style.display = ''
		if (sessionId !== this.target) {
			this.target = sessionId
			this.label.textContent = sessionId ? `Drop to add to ${this.sessions.label(sessionId)}` : 'Drop onto a session’s frame'
			this.label.classList.toggle('none', !sessionId)
			if (sessionId) this.outline.style.setProperty('--session', sessionColor(sessionId))
		}
		this.label.style.transform = `translate(${Math.round(e.clientX - rect.left + 14)}px, ${Math.round(e.clientY - rect.top + 14)}px)`
		const section = sessionId ? this.editor.layout.get().sections.find((s) => s.id === sessionId) : null
		if (!section) {
			this.outline.style.display = 'none'
			return
		}
		const z = this.editor.getZoom()
		const p = this.editor.pageToScreen(section.box)
		this.outline.style.display = ''
		this.outline.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`
		this.outline.style.width = `${Math.round(section.box.w * z)}px`
		this.outline.style.height = `${Math.round(section.box.h * z)}px`
	}

	private hide() {
		this.target = null
		this.outline.style.display = 'none'
		this.label.style.display = 'none'
	}
}

const isFileDrag = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files')

function kindOf(f: File): 'image' | 'video' | 'html' | null {
	if (f.type.startsWith('image/')) return 'image'
	if (f.type.startsWith('video/')) return 'video'
	if (f.type === 'text/html' || HTML_FILE.test(f.name)) return 'html'
	return null
}

/** Pasted images often come without a name. */
function fallbackName(f: File) {
	const ext = f.type.split('/')[1]?.split(';')[0]?.replace('jpeg', 'jpg') ?? 'bin'
	return `pasted-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.${ext}`
}

function editable(el: EventTarget | Element | null): boolean {
	return el instanceof HTMLElement && !!el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]')
}
