import * as Y from 'yjs'
import type { AnnotationView } from '../../../shared/types'
import { sessionColor } from '../../../shared/sessionColor'
import { url as withBase } from '../base'
import type { Editor } from '../editor/Editor'
import type { Box } from '../editor/geometry'
import { LAYOUT, type SectionLayout } from '../editor/layout'
import { ownerId, pairing, pairings, withServer } from '../opencode/pairings'
import { react } from '../state/signals'
import { consumeAnnotations, peekAnnotations } from '../sync/client'
import { findSession, type Conjure } from './Conjure'
import type { Presence } from './Presence'
import '../ui/submitAnnotations.css'

/** Screen px kept clear: between the pill and the screen or frame edge, and below the top bar when pinned. */
const MARGIN = 10
/** Page px from the top of a frame's header to the middle of its title line (see .section-label: 4px padding, 48px line). */
const TITLE_MID = 28
const HEADER = `Feedback from the canvas on your posted items. By default, update the annotated items in place with update_item (keep their ids); only post new items if a note explicitly asks for something new.`

/** Where a session's prompt goes from this browser: a paired OpenCode that has it (null: none does). */
type Route = { state: 'looking' } | { state: 'found'; serverKey: string } | { state: 'none' }

interface Pill {
	el: HTMLButtonElement
	label: HTMLSpanElement
	ids: string[]
	sending: boolean
	error: string | null
	shown: string
}

/**
 * "Submit annotations (N)" on each session frame with annotations waiting (anyone's, on its items):
 * a pill at the right end of the frame's title, pinned to the top of the screen when the title is
 * scrolled away and the frame is still in view. Clicking it sends them all to the session as one
 * prompt, straight from this browser (through a paired OpenCode that has the session): what each
 * note says, where the drawing is in pixels, and the marked images attached. Once it's sent they're
 * consumed on the server, as if the agent had read them, so they fly into its creature. Edit links only.
 */
export class SubmitAnnotations {
	private host: HTMLDivElement
	private map: Y.Map<Y.Map<unknown>>
	private pills = new Map<string, Pill>()
	private routes = new Map<string, Route>()
	/** session id -> its pending annotation ids (recounted when the document or layout changes) */
	private pending = new Map<string, string[]>()
	private dirty = true
	private disposers: (() => void)[] = []

	constructor(
		parent: HTMLElement,
		private editor: Editor,
		private presence: Presence,
		private conjure: Conjure,
		private canvasId: string,
		private canvasTitle: () => string,
	) {
		this.host = document.createElement('div')
		this.host.className = 'submit-annotations'
		parent.appendChild(this.host)
		this.map = presence.doc.getMap('annotations')
		const onChange = () => (this.dirty = true)
		this.map.observeDeep(onChange)
		this.disposers.push(() => this.map.unobserveDeep(onChange))
		this.disposers.push(
			react(() => {
				editor.layout.get()
				this.dirty = true
			}),
			// Pairing or unpairing changes which sessions this browser can reach.
			react(() => {
				pairings.get()
				conjure.records.get()
				this.routes.clear()
				this.dirty = true
			}),
			editor.onFrame(() => this.frame()),
		)
	}

	destroy() {
		for (const d of this.disposers.splice(0)) d()
		this.host.remove()
	}

	private recount() {
		this.dirty = false
		const layout = this.editor.layout.get()
		const next = new Map<string, string[]>()
		const ordered = [...this.map.entries()]
			.filter(([, a]) => a instanceof Y.Map)
			.sort(([, a], [, b]) => Number(a.get('createdAt') ?? 0) - Number(b.get('createdAt') ?? 0))
		for (const [id, a] of ordered) {
			const sessionId = layout.sectionOf.get(String(a.get('itemId') ?? ''))
			if (sessionId) next.set(sessionId, [...(next.get(sessionId) ?? []), id])
		}
		this.pending = next
		for (const sessionId of next.keys()) if (!this.routes.has(sessionId)) void this.lookUp(sessionId)
	}

	/** Which paired OpenCode has the session: our own creature's, else any that lists it. */
	private async lookUp(sessionId: string) {
		this.routes.set(sessionId, { state: 'looking' })
		const r = this.conjure.record(sessionId)
		let route: Route
		if (r && r.ownerId === ownerId && pairing(r.serverKey)) route = { state: 'found', serverKey: r.serverKey }
		else {
			const found = await findSession(sessionId).catch(() => null)
			route = found ? { state: 'found', serverKey: found.serverKey } : { state: 'none' }
		}
		// (unless pairings changed meanwhile, which started over)
		if (this.routes.get(sessionId)?.state === 'looking') this.routes.set(sessionId, route)
	}

	private frame() {
		if (this.dirty) this.recount()
		const layout = this.editor.layout.get()
		const seen = new Set<string>()
		const top = this.topInset()
		for (const section of layout.sections) {
			const ids = this.pending.get(section.id)
			const pill = this.pills.get(section.id)
			if (!ids?.length && !pill?.sending) continue
			seen.add(section.id)
			const p = pill ?? this.makePill(section.id)
			if (!p.sending) p.ids = ids ?? []
			this.render(section.id, p)
			this.place(section, p, top)
		}
		for (const [id, p] of this.pills) {
			if (seen.has(id)) continue
			p.el.remove()
			this.pills.delete(id)
			const title = this.titleOf(id)
			if (title) title.style.marginRight = ''
		}
	}

	private makePill(sessionId: string): Pill {
		const el = document.createElement('button')
		el.className = 'submit-annotations-pill'
		el.style.setProperty('--session', sessionColor(sessionId))
		const label = document.createElement('span')
		el.appendChild(label)
		el.addEventListener('pointerdown', (e) => e.stopPropagation())
		el.addEventListener('dblclick', (e) => e.stopPropagation())
		el.addEventListener('click', (e) => {
			e.stopPropagation()
			void this.submit(sessionId)
		})
		this.host.appendChild(el)
		const pill: Pill = { el, label, ids: [], sending: false, error: null, shown: '' }
		this.pills.set(sessionId, pill)
		return pill
	}

	private render(sessionId: string, p: Pill) {
		const route = this.routes.get(sessionId) ?? { state: 'looking' }
		const n = p.ids.length
		const text = p.sending ? 'Sending…' : p.error ? `Retry submit (${n})` : `Submit annotations (${n})`
		const disabled = p.sending || route.state !== 'found'
		const title = p.sending
			? 'Sending the annotations to this session…'
			: route.state === 'none'
				? 'Connect the OpenCode that has this session to submit'
				: route.state === 'looking'
					? 'Looking for the OpenCode that has this session…'
					: p.error
						? `Couldn't send: ${p.error}. Click to try again.`
						: `Send ${n === 1 ? 'this annotation' : `these ${n} annotations`} to the session as a prompt, with the marked images`
		const key = `${text}|${disabled}|${title}|${!!p.error}`
		if (key === p.shown) return
		p.shown = key
		p.label.textContent = text
		// (not the disabled attribute: a disabled button shows no tooltip in some browsers)
		p.el.setAttribute('aria-disabled', String(disabled))
		p.el.classList.toggle('disabled', disabled)
		p.el.title = title
		p.el.classList.toggle('error', !!p.error && !p.sending)
		p.el.classList.toggle('sending', p.sending)
	}

	/** A frame's title text (see SectionLabels in Renderer.ts). */
	private titleOf(sessionId: string) {
		return document.querySelector<HTMLElement>(`.section-label[data-session="${CSS.escape(sessionId)}"] .title`)
	}

	/**
	 * At the right end of the title line, left of the frame's buttons, with room kept for it at the
	 * end of the title (which shortens with an ellipsis rather than run under it); when that's above the top of the screen (under the top
	 * bar) but the frame is still in view, pinned there instead, at the frame's visible right edge.
	 */
	private place(section: SectionLayout, p: Pill, top: number) {
		const { w: vw, h: vh } = this.editor.viewport.peek()
		const frame = this.screen(section.box)
		const header = this.screen(section.header)
		const w = p.el.offsetWidth
		const h = p.el.offsetHeight
		const right = Math.min(frame.x + frame.w, vw) - MARGIN
		const left = Math.max(frame.x, 0) + MARGIN
		const z = this.editor.getZoom()
		const scale = Math.max(z, LAYOUT.minFrameTitlePx / LAYOUT.frameTitlePx)
		const mid = header.y + header.h - section.header.h * scale + TITLE_MID * scale
		const title = this.titleOf(section.id)
		const reserve = `${Math.ceil((w + 2 * MARGIN) / scale)}px`
		if (title && title.style.marginRight !== reserve) title.style.marginRight = reserve
		const buttons = title?.parentElement?.querySelector('.frame-buttons')
		const shownButtons = buttons && title!.parentElement!.classList.contains('roomy') ? buttons.getBoundingClientRect() : null
		const headerRight = shownButtons ? shownButtons.left - this.host.getBoundingClientRect().left - MARGIN : header.x + header.w - MARGIN
		let x = Math.min(headerRight, vw - MARGIN) - w
		let y = mid - h / 2
		let pinned = false
		if (y < top) {
			pinned = true
			y = top
			x = right - w
		}
		const visible = frame.x + frame.w > 0 && frame.x < vw && frame.y < vh && y + h + MARGIN <= Math.min(frame.y + frame.h, vh) && x >= left
		const key = visible ? `${Math.round(x)},${Math.round(y)},${pinned}` : 'hidden'
		if (p.el.dataset.at === key) return
		p.el.dataset.at = key
		p.el.style.visibility = visible ? '' : 'hidden'
		p.el.classList.toggle('pinned', pinned)
		if (visible) p.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`
	}

	private screen(b: Box): Box {
		const z = this.editor.getZoom()
		const o = this.editor.pageToScreen(b)
		return { x: o.x, y: o.y, w: b.w * z, h: b.h * z }
	}

	/** Screen y (in the canvas) below the top bar, the tool picker and the attention tray. */
	private topInset() {
		const container = this.host.getBoundingClientRect()
		let bottom = 0
		for (const el of document.querySelectorAll('.top-bar > *, .toolbar.tools, .top-stack > *')) {
			const r = el.getBoundingClientRect()
			if (r.height) bottom = Math.max(bottom, r.bottom)
		}
		return Math.max(0, bottom - container.top) + MARGIN
	}

	/** Sends the frame's annotations to its session as one prompt, then marks them delivered. */
	private async submit(sessionId: string) {
		const p = this.pills.get(sessionId)
		const route = this.routes.get(sessionId)
		if (!p || p.sending || route?.state !== 'found' || !p.ids.length) return
		const ids = [...p.ids]
		p.sending = true
		p.error = null
		try {
			const all = await peekAnnotations(this.canvasId, sessionId)
			const views = all.filter((a) => ids.includes(a.id))
			if (!views.length) throw new Error('those annotations are gone')
			const { text, files } = await this.compose(views)
			await withServer(route.serverKey, async (c) => {
				const active = await c.session.active({ signal: AbortSignal.timeout(10_000) }).catch(() => ({}))
				const busy = sessionId in active
				await c.session.prompt({
					sessionID: sessionId,
					text,
					files,
					metadata: { source: 'canvas', kind: 'annotations', canvasId: this.canvasId, annotationIds: views.map((v) => v.id) },
					...(busy ? { delivery: 'steer' as const } : {}),
				})
			})
			await consumeAnnotations(this.canvasId, views.map((v) => v.id), sessionId).catch((e: Error) => {
				this.editor.deletions.notify(`Sent, but couldn't clear them from the canvas: ${e.message}`)
				throw null
			})
			const title = this.editor.sessions.peek()[sessionId]?.title?.trim()
			this.editor.deletions.notify(`Sent ✓ ${views.length === 1 ? '1 annotation' : `${views.length} annotations`}${title ? ` to ${title}` : ''}`)
		} catch (e) {
			if (e !== null) {
				const message = e instanceof Error ? e.message : String(e)
				p.error = message
				this.editor.deletions.notify(`Couldn't submit the annotations: ${message}`)
			}
		} finally {
			p.sending = false
			p.shown = ''
		}
	}

	/** The prompt: the header, then each item's annotations (note, where, marked image attached in order). */
	private async compose(views: AnnotationView[]) {
		const from = this.presence.me.peek().name.trim()
		const lines = [HEADER, '', `From ${from || 'someone'} on the canvas "${this.canvasTitle()}" (${withBase(`/c/${this.canvasId}`)}).`]
		const files: { uri: string; name: string }[] = []
		const byItem = new Map<string, AnnotationView[]>()
		for (const v of views) byItem.set(v.item.id, [...(byItem.get(v.item.id) ?? []), v])
		for (const list of byItem.values()) {
			const item = list[0].item
			const html = item.kind === 'html'
			lines.push('', `## ${item.title || item.name} (item ${item.id}, ${item.kind}, ${item.width}×${item.height}${html ? ' CSS px' : ' px'})`)
			if (html) lines.push(`Canvas link: ${item.link}`)
			if (item.kind === 'page' && item.pageUrl) lines.push(`A snapshot of the web page ${item.pageUrl}`)
			for (const [i, v] of list.entries()) {
				const note = v.text.trim() ? `"${v.text.trim()}"` : '(drawing, no text)'
				const where = v.bbox
					? `drawing's bounding box x=${v.bbox.x}, y=${v.bbox.y}, ${v.bbox.width}×${v.bbox.height}${html ? ' in page pixels' : ' px in the original image'}`
					: `a note on the spot x=${v.anchor.px}, y=${v.anchor.py}${html ? ' in page pixels' : ' px in the original image'}`
				let image = ''
				if (!html) {
					const uri = await dataUrl(withBase(`/api/canvases/${encodeURIComponent(this.canvasId)}/annotations/${encodeURIComponent(v.id)}/image`)).catch(() => null)
					if (uri) {
						files.push({ uri, name: `annotation-${files.length + 1}.png` })
						image = ` — marked image ${files.length} attached`
					}
				}
				lines.push(`${i + 1}. ${note} — ${where}${image}`)
			}
		}
		return { text: lines.join('\n'), files }
	}
}

async function dataUrl(src: string): Promise<string> {
	const res = await fetch(src)
	if (!res.ok) throw new Error(`HTTP ${res.status}`)
	const blob = await res.blob()
	return new Promise((resolve, reject) => {
		const reader = new FileReader()
		reader.onload = () => resolve(String(reader.result))
		reader.onerror = () => reject(reader.error)
		reader.readAsDataURL(blob)
	})
}
