import type { Item } from '../../../shared/types'
import type { Editor, HtmlLink } from '../editor/Editor'
import { Box } from '../editor/geometry'
import { LAYOUT, type SectionLayout } from '../editor/layout'
import { frameKey } from '../editor/selection'
import { imageShader, rectShader, videoShader } from './shaders'
import { TextureCache } from './TextureCache'
import { VideoPool } from './VideoPool'
import { LinkHover, loadHtml, makeNonce, parseLinkMessage, withLinkReporter, type FrameTransform } from './HtmlLinks'
import { url as withBase } from '../base'

const THUMB_SIZE = 512
const ITEM_RADIUS = 6
const SECTION_RADIUS = 20
const EASE_MS = 90 // time constant for layout motion
const FADE_MS = 220
/** Most HTML items mounted as iframes at once; the rest show their placeholder. */
const MAX_HTML_FRAMES = 40
/** Mount HTML items this far (screen px) outside the viewport, so they're ready when panned in. */
const HTML_MARGIN_PX = 400
/** HTML items smaller than this on screen aren't worth an iframe. */
const MIN_HTML_PX = 24

const RECT_FLOATS = 16
const IMAGE_FLOATS = 8

type RGBA = [number, number, number, number]
const BG: GPUColor = { r: 0.067, g: 0.067, b: 0.075, a: 1 }
const ACCENT: RGBA = [0.34, 0.56, 1, 1]
const SECTION_FILL: RGBA = [1, 1, 1, 0.035]
const SECTION_STROKE: RGBA = [1, 1, 1, 0.06]
const PLACEHOLDER: RGBA = [1, 1, 1, 0.06]
const NONE: RGBA = [0, 0, 0, 0]

export interface RendererOptions {
	/** Hide editing controls (view-only links) */
	readOnly?: boolean
	/** Other people's selections (selection keys, see selection.ts), outlined in their colour (multiplayer). */
	getRemoteSelections?: () => { ids: string[]; color: string }[]
	/** Called when the user removes a section with its close button. */
	onCloseSection?: (sectionId: string) => void
	/** Called when the GPU device is lost other than by destroy() (iOS drops it in background tabs, GPU resets). */
	onDeviceLost?: (message: string) => void
}

interface Displayed {
	x: number
	y: number
	w: number
	h: number
	opacity: number
}

/**
 * Draws the editor's state with WebGPU. It only reads from the editor, and only
 * renders a frame when something it depends on has changed or is still animating.
 */
export class Renderer {
	private context: GPUCanvasContext
	private format: GPUTextureFormat
	private globals: GPUBuffer
	private globalsData = new Float32Array(8)
	private globalsBindGroup: GPUBindGroup
	private sampler: GPUSampler
	private rectPipeline: GPURenderPipeline
	private imagePipeline: GPURenderPipeline
	private videoPipeline: GPURenderPipeline
	private videoLayout: GPUBindGroupLayout
	private imageLayout: GPUBindGroupLayout
	/** Zero-copy video via importExternalTexture; false once it's missing or has failed, then frames are copied. */
	private externalVideo: boolean
	private videoCopies = new Map<string, { texture: GPUTexture; bindGroup: GPUBindGroup; w: number; h: number }>()
	private maxCanvasPx: number
	private rectBuffer: GPUBuffer | null = null
	private rectData = new Float32Array(RECT_FLOATS * 256) as Float32Array<ArrayBuffer>
	private imageBuffer: GPUBuffer | null = null
	private imageData = new Float32Array(IMAGE_FLOATS * 256) as Float32Array<ArrayBuffer>
	private textures: TextureCache
	private videos: VideoPool
	private labels: SectionLabels
	private actions: ItemActions
	private titles: ItemTitles
	private html: HtmlItems
	private linkHover: LinkHover

	private displayedItems = new Map<string, Displayed>()
	private displayedSections = new Map<string, Displayed>()
	private lastEpoch = -1
	private animating = true
	private pixelSize = { w: 0, h: 0 }
	private dpr = window.devicePixelRatio || 1
	private disposers: (() => void)[] = []
	private destroyed = false
	frameTimes: number[] = []

	/**
	 * Every step names itself in the error it throws, and WebGPU validation errors (which are
	 * reported asynchronously, not thrown) are collected with an error scope, so a failure on some
	 * browser says what failed and why instead of a bare "TypeError".
	 */
	static async create(canvas: HTMLCanvasElement, overlay: HTMLElement, editor: Editor, options: RendererOptions = {}) {
		if (!navigator.gpu) throw new Error('WebGPU is not available in this browser.')
		const adapter = await step('requesting a WebGPU adapter', async () => {
			// Some implementations reject options they don't know rather than ignoring them.
			try {
				return await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
			} catch {
				return await navigator.gpu.requestAdapter()
			}
		})
		if (!adapter) throw new Error('No WebGPU adapter found.')
		const device = await step('requesting a WebGPU device', () => adapter.requestDevice())
		device.addEventListener?.('uncapturederror', (e) => console.error('WebGPU error:', (e as GPUUncapturedErrorEvent).error?.message))

		try {
			const sampler = await createSampler(device)
			const context = step('getting the canvas WebGPU context', () => {
				const ctx = canvas.getContext('webgpu')
				if (!ctx) throw new Error('canvas.getContext("webgpu") returned null')
				return ctx
			})
			const format = step('configuring the canvas', () => configureContext(context, device))
			device.pushErrorScope('validation')
			const renderer = step('creating pipelines', () => new Renderer(device, context, format, sampler, canvas, overlay, editor, options))
			// Chrome rejects popErrorScope once the device is lost; onDeviceLost deals with that.
			const error = await device.popErrorScope().catch(() => null)
			if (error) {
				renderer.destroy()
				throw new Error(`WebGPU validation failed while creating pipelines: ${error.message}`)
			}
			return renderer
		} catch (e) {
			device.destroy()
			throw e
		}
	}

	private constructor(
		private device: GPUDevice,
		context: GPUCanvasContext,
		format: GPUTextureFormat,
		sampler: GPUSampler,
		private canvas: HTMLCanvasElement,
		overlay: HTMLElement,
		private editor: Editor,
		private options: RendererOptions,
	) {
		this.context = context
		this.format = format
		this.maxCanvasPx = device.limits.maxTextureDimension2D
		this.externalVideo = typeof device.importExternalTexture === 'function'

		this.globals = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
		this.sampler = sampler

		const globalsLayout = device.createBindGroupLayout({
			entries: [
				{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
				{ binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
			],
		})
		const imageLayout = device.createBindGroupLayout({
			entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} }],
		})
		this.videoLayout = device.createBindGroupLayout({
			entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, externalTexture: {} }],
		})
		this.globalsBindGroup = device.createBindGroup({
			layout: globalsLayout,
			entries: [
				{ binding: 0, resource: { buffer: this.globals } },
				{ binding: 1, resource: this.sampler },
			],
		})

		const blend: GPUBlendState = {
			color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
			alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
		}
		const pipeline = (code: string, layouts: GPUBindGroupLayout[], attributes: GPUVertexAttribute[], stride: number) => {
			const module = device.createShaderModule({ code })
			return device.createRenderPipeline({
				layout: device.createPipelineLayout({ bindGroupLayouts: layouts }),
				vertex: {
					module,
					entryPoint: 'vs',
					buffers: [{ arrayStride: stride, stepMode: 'instance', attributes }],
				},
				fragment: { module, entryPoint: 'fs', targets: [{ format: this.format, blend }] },
				primitive: { topology: 'triangle-list' },
			})
		}
		const vec4 = (location: number): GPUVertexAttribute => ({ shaderLocation: location, offset: location * 16, format: 'float32x4' })
		this.rectPipeline = pipeline(rectShader, [globalsLayout], [0, 1, 2, 3].map(vec4), RECT_FLOATS * 4)
		this.imagePipeline = pipeline(imageShader, [globalsLayout, imageLayout], [0, 1].map(vec4), IMAGE_FLOATS * 4)
		this.videoPipeline = pipeline(videoShader, [globalsLayout, this.videoLayout], [0, 1].map(vec4), IMAGE_FLOATS * 4)

		this.imageLayout = imageLayout
		this.textures = new TextureCache(device, imageLayout)
		this.videos = new VideoPool(overlay)
		this.html = new HtmlItems(overlay)
		this.linkHover = new LinkHover(this.html.host)
		editor.linkAt = (point) => this.html.linkAt(point)
		this.labels = new SectionLabels(overlay, options.readOnly ? null : (id) => options.onCloseSection?.(id))
		this.titles = new ItemTitles(overlay)
		this.actions = new ItemActions(overlay)

		const ro = new ResizeObserver(([entry]) => {
			const size = entry.devicePixelContentBoxSize?.[0]
			this.dpr = window.devicePixelRatio || 1
			const w = size ? size.inlineSize : Math.round(entry.contentRect.width * this.dpr)
			const h = size ? size.blockSize : Math.round(entry.contentRect.height * this.dpr)
			this.pixelSize = { w: Math.min(w, this.maxCanvasPx), h: Math.min(h, this.maxCanvasPx) }
			this.lastEpoch = -1
		})
		// Safari has no device-pixel-content-box and throws a TypeError for it; the callback then
		// works from contentRect × devicePixelRatio.
		let devicePixelBox = true
		try {
			ro.observe(canvas, { box: 'device-pixel-content-box' })
		} catch {
			devicePixelBox = false
			ro.observe(canvas)
		}
		this.disposers.push(() => ro.disconnect())
		// content-box doesn't report devicePixelRatio changes (browser zoom, moving between screens).
		const onResize = () => {
			const dpr = window.devicePixelRatio || 1
			if (devicePixelBox || dpr === this.dpr) return
			this.dpr = dpr
			const rect = canvas.getBoundingClientRect()
			this.pixelSize = {
				w: Math.min(Math.round(rect.width * dpr), this.maxCanvasPx),
				h: Math.min(Math.round(rect.height * dpr), this.maxCanvasPx),
			}
			this.lastEpoch = -1
		}
		window.addEventListener('resize', onResize)
		this.disposers.push(() => window.removeEventListener('resize', onResize))
		this.disposers.push(editor.onFrame((now, elapsed) => this.frame(now, elapsed)))

		device.lost.then((info) => {
			if (info.reason === 'destroyed' || this.destroyed) return
			console.error('WebGPU device lost:', info.message)
			options.onDeviceLost?.(info.message)
		})
	}

	private frame(now: number, elapsed: number) {
		const editor = this.editor
		const layout = editor.layout.get()
		const camera = editor.camera.get()
		const items = editor.items.get()
		const hovered = editor.hoveredId.get()
		const selected = editor.selectedSet.get()

		// Which videos should be playing: hovered, then selected (only if visible).
		const viewBounds = Box.expand(editor.viewportPageBounds.get(), 0)
		const wantedVideos: { id: string; src: string }[] = []
		const consider = (id: string | null) => {
			const item = id ? items[id] : undefined
			const box = id ? layout.items.get(id) : undefined
			if (item?.kind === 'video' && box && Box.intersects(box, viewBounds) && !wantedVideos.some((v) => v.id === id)) {
				wantedVideos.push({ id: item.id, src: withBase(item.src) })
			}
		}
		consider(hovered)
		for (const id of selected) consider(id)
		this.videos.sync(wantedVideos)

		const uploaded = this.textures.update()
		const epoch = editor.getEpoch()
		const needsFrame =
			epoch !== this.lastEpoch || this.animating || uploaded || this.videos.isPlaying || editor.isCameraMoving()
		if (!needsFrame || this.pixelSize.w === 0) return
		this.lastEpoch = epoch

		const t0 = performance.now()
		this.animating = this.stepDisplay(layout, elapsed)

		if (this.canvas.width !== this.pixelSize.w || this.canvas.height !== this.pixelSize.h) {
			this.canvas.width = this.pixelSize.w
			this.canvas.height = this.pixelSize.h
		}

		const { w: vw, h: vh } = editor.viewport.get()
		this.globalsData.set([camera.x, camera.y, camera.z, this.dpr, vw, vh, now / 1000, 0])
		this.device.queue.writeBuffer(this.globals, 0, this.globalsData)

		const cull = Box.expand(viewBounds, 64 / camera.z)

		// ---- build instance data ----
		let rects = 0
		const pushRect = (b: Box, fill: RGBA, stroke: RGBA, strokeWidth: number, radius: number, screen: boolean) => {
			this.rectData = ensure(this.rectData, (rects + 1) * RECT_FLOATS)
			const o = rects++ * RECT_FLOATS
			const d = this.rectData
			d[o] = b.x; d[o + 1] = b.y; d[o + 2] = b.w; d[o + 3] = b.h
			premul(d, o + 4, fill)
			premul(d, o + 8, stroke)
			d[o + 12] = strokeWidth; d[o + 13] = radius; d[o + 14] = screen ? 1 : 0; d[o + 15] = 0
		}

		const overlays: (() => void)[] = []
		const remoteSelected = new Map<string, RGBA>()
		for (const { ids, color } of this.options.getRemoteSelections?.() ?? []) {
			const rgba = hexToRgba(color)
			for (const id of ids) if (!remoteSelected.has(id)) remoteSelected.set(id, rgba)
		}

		for (const section of layout.sections) {
			const d = this.displayedSections.get(section.id)
			if (!d || !Box.intersects(d, cull)) continue
			pushRect(d, withAlpha(SECTION_FILL, d.opacity), withAlpha(SECTION_STROKE, d.opacity), 1, SECTION_RADIUS, false)
			const key = frameKey(section.id)
			const remote = remoteSelected.get(key)
			if (remote) {
				const r = Box.expand(d, 4 / camera.z)
				overlays.push(() => pushRect(r, NONE, remote, 2.5, SECTION_RADIUS + 4 / camera.z, false))
			}
			if (selected.has(key)) overlays.push(() => pushRect(d, NONE, ACCENT, 2, SECTION_RADIUS, false))
		}

		let images = 0
		// One per image instance, in instance order.
		const imageDraws: { video: boolean; bindGroup: GPUBindGroup }[] = []
		const drawnVideos = new Set<string>()
		const pushImage = (b: Box, opacity: number) => {
			this.imageData = ensure(this.imageData, (images + 1) * IMAGE_FLOATS)
			const o = images++ * IMAGE_FLOATS
			const d = this.imageData
			d[o] = b.x; d[o + 1] = b.y; d[o + 2] = b.w; d[o + 3] = b.h
			d[o + 4] = opacity; d[o + 5] = ITEM_RADIUS; d[o + 6] = 0; d[o + 7] = 0
			return images - 1
		}

		const pxRatio = camera.z * this.dpr
		// HTML items are iframes in the overlay, above this canvas; mounted ones draw their own outlines.
		const htmlMounted = this.html.update(
			items,
			this.displayedItems,
			Box.expand(viewBounds, HTML_MARGIN_PX / camera.z),
			editor,
			{ selected, hovered, remote: remoteSelected },
		)
		const link = editor.hoveredLink.get()
		this.linkHover.update(link, link && this.html.transform(link.itemId), editor.viewport.get())

		for (const [id, d] of this.displayedItems) {
			if (!Box.intersects(d, cull)) continue
			const item = items[id]
			if (!item) continue

			const video = item.kind === 'video' ? this.videos.getReady(id) : undefined
			const videoDraw = video ? this.videoBindGroup(id, video) : null
			let texAlpha = 0
			if (item.kind === 'html') {
				// No texture: the placeholder shows under the iframe while it loads.
			} else if (videoDraw) {
				drawnVideos.add(id)
				pushImage(d, d.opacity)
				imageDraws.push(videoDraw)
				texAlpha = 1
			} else {
				const entry = this.pickTexture(item, Math.max(d.w, d.h) * pxRatio)
				if (entry) {
					texAlpha = Math.min(1, (now - entry.readyAt) / FADE_MS)
					if (texAlpha < 1) this.animating = true
					pushImage(d, d.opacity * texAlpha)
					imageDraws.push({ video: false, bindGroup: entry.bindGroup! })
				}
			}
			if (texAlpha < 1) pushRect(d, withAlpha(PLACEHOLDER, d.opacity * (1 - texAlpha)), NONE, 0, ITEM_RADIUS, false)

			if (htmlMounted.has(id)) continue
			// Someone else's selection sits outside ours, so both stay visible.
			const remote = remoteSelected.get(id)
			if (remote) overlays.push(() => pushRect(Box.expand(d, 3 / camera.z), NONE, remote, 2.5, ITEM_RADIUS + 3 / camera.z, false))
			if (selected.has(id)) overlays.push(() => pushRect(d, NONE, ACCENT, 2, ITEM_RADIUS, false))
			else if (hovered === id) overlays.push(() => pushRect(d, NONE, withAlpha(ACCENT, 0.7), 1.5, ITEM_RADIUS, false))
		}

		const backgroundRects = rects
		for (const o of overlays) o()
		const brush = editor.brush.get()
		if (brush) {
			const tl = editor.pageToScreen(brush)
			pushRect(
				{ x: tl.x, y: tl.y, w: brush.w * camera.z, h: brush.h * camera.z },
				withAlpha(ACCENT, 0.08),
				withAlpha(ACCENT, 0.6),
				1,
				0,
				true,
			)
		}

		// ---- upload & draw ----
		this.rectBuffer = this.upload(this.rectBuffer, this.rectData, rects * RECT_FLOATS)
		this.imageBuffer = this.upload(this.imageBuffer, this.imageData, images * IMAGE_FLOATS)

		const encoder = this.device.createCommandEncoder()
		const pass = encoder.beginRenderPass({
			colorAttachments: [
				{ view: this.context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: BG },
			],
		})
		pass.setBindGroup(0, this.globalsBindGroup)

		if (backgroundRects) {
			pass.setPipeline(this.rectPipeline)
			pass.setVertexBuffer(0, this.rectBuffer)
			pass.draw(6, backgroundRects, 0, 0)
		}

		if (images) {
			pass.setVertexBuffer(0, this.imageBuffer)
			let current: GPURenderPipeline | null = null
			for (let i = 0; i < images; i++) {
				const draw = imageDraws[i]
				const pipeline = draw.video ? this.videoPipeline : this.imagePipeline
				if (pipeline !== current) pass.setPipeline((current = pipeline))
				pass.setBindGroup(1, draw.bindGroup)
				pass.draw(6, 1, 0, i)
			}
		}
		for (const [id, copy] of this.videoCopies) {
			if (drawnVideos.has(id)) continue
			copy.texture.destroy()
			this.videoCopies.delete(id)
		}

		if (rects > backgroundRects) {
			pass.setPipeline(this.rectPipeline)
			pass.setVertexBuffer(0, this.rectBuffer)
			pass.draw(6, rects - backgroundRects, 0, backgroundRects)
		}

		pass.end()
		this.device.queue.submit([encoder.finish()])

		this.labels.update(layout.sections, this.displayedSections, editor)
		this.titles.update(items, this.displayedItems, cull, editor)
		const showDownload = hovered && editor.isShiftDown.get()
		this.actions.update(showDownload ? items[hovered] : undefined, showDownload ? this.displayedItems.get(hovered) : undefined, editor)

		this.frameTimes.push(performance.now() - t0)
		if (this.frameTimes.length > 120) this.frameTimes.shift()
	}

	/**
	 * The current frame of a playing video: imported zero-copy where importExternalTexture works,
	 * otherwise copied into a texture of its own each frame. Null means draw the poster instead.
	 */
	private videoBindGroup(id: string, video: HTMLVideoElement): { video: boolean; bindGroup: GPUBindGroup } | null {
		if (this.externalVideo) {
			try {
				this.device.pushErrorScope('validation')
				const bindGroup = this.device.createBindGroup({
					layout: this.videoLayout,
					entries: [{ binding: 0, resource: this.device.importExternalTexture({ source: video }) }],
				})
				this.device.popErrorScope().then((error) => {
					if (!error) return
					console.warn('importExternalTexture failed, copying video frames instead:', error.message)
					this.externalVideo = false
				})
				return { video: true, bindGroup }
			} catch (e) {
				this.device.popErrorScope().catch(() => {})
				console.warn('importExternalTexture failed, copying video frames instead:', e)
				this.externalVideo = false
			}
		}

		const w = video.videoWidth
		const h = video.videoHeight
		if (!w || !h || w > this.maxCanvasPx || h > this.maxCanvasPx) return null
		let copy = this.videoCopies.get(id)
		if (copy && (copy.w !== w || copy.h !== h)) {
			copy.texture.destroy()
			copy = undefined
		}
		if (!copy) {
			const texture = this.device.createTexture({
				size: { width: w, height: h },
				format: 'rgba8unorm',
				usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
			})
			const bindGroup = this.device.createBindGroup({ layout: this.imageLayout, entries: [{ binding: 0, resource: texture.createView() }] })
			copy = { texture, bindGroup, w, h }
			this.videoCopies.set(id, copy)
		}
		try {
			this.device.queue.copyExternalImageToTexture({ source: video }, { texture: copy.texture, premultipliedAlpha: true }, { width: w, height: h })
		} catch (e) {
			console.warn('copying a video frame failed', e)
			return null
		}
		return { video: false, bindGroup: copy.bindGroup }
	}

	/** Thumbnail first; full resolution only once the item is bigger on screen than the thumbnail. */
	private pickTexture(item: Item, screenPx: number) {
		const thumb = this.textures.request(item.thumb)
		const originalLarger = Math.max(item.width, item.height) > THUMB_SIZE
		if (item.kind === 'image' && originalLarger && screenPx > THUMB_SIZE * 1.1) {
			const full = this.textures.request(item.src)
			if (full.state === 'ready') return full
		} else if (item.kind === 'image') {
			const full = this.textures.peek(item.src)
			if (full) return full
		}
		return thumb.state === 'ready' ? thumb : undefined
	}

	/** Eases displayed boxes toward their layout targets. Returns true while anything is still moving. */
	private stepDisplay(layout: ReturnType<Editor['layout']['get']>, elapsed: number) {
		const k = 1 - Math.exp(-elapsed / EASE_MS)
		const fade = elapsed / FADE_MS
		let moving = false
		const step = (map: Map<string, Displayed>, targets: Iterable<[string, Box]>) => {
			const seen = new Set<string>()
			for (const [id, t] of targets) {
				seen.add(id)
				const d = map.get(id)
				if (!d) {
					map.set(id, { ...t, opacity: 0 })
					moving = true
					continue
				}
				d.x = approach(d.x, t.x, k)
				d.y = approach(d.y, t.y, k)
				d.w = approach(d.w, t.w, k)
				d.h = approach(d.h, t.h, k)
				d.opacity = Math.min(1, d.opacity + fade)
				if (d.x !== t.x || d.y !== t.y || d.w !== t.w || d.h !== t.h || d.opacity < 1) moving = true
			}
			for (const id of map.keys()) if (!seen.has(id)) map.delete(id)
		}
		step(this.displayedItems, layout.items)
		step(this.displayedSections, layout.sections.map((s) => [s.id, s.box] as [string, Box]))
		return moving
	}

	private upload(buffer: GPUBuffer | null, data: Float32Array<ArrayBuffer>, length: number) {
		if (!length) return buffer
		const bytes = length * 4
		if (!buffer || buffer.size < bytes) {
			buffer?.destroy()
			buffer = this.device.createBuffer({
				size: Math.max(bytes, data.byteLength),
				usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
			})
		}
		this.device.queue.writeBuffer(buffer, 0, data, 0, length)
		return buffer
	}

	destroy() {
		this.destroyed = true
		for (const d of this.disposers.splice(0)) d()
		this.textures.destroy()
		for (const copy of this.videoCopies.values()) copy.texture.destroy()
		this.videoCopies.clear()
		this.videos.destroy()
		this.labels.destroy()
		this.actions.destroy()
		this.titles.destroy()
		this.html.destroy()
		this.linkHover.destroy()
		if (this.editor.linkAt) this.editor.linkAt = null
		this.device.destroy()
	}
}

/**
 * Item titles as DOM text in the strip the layout reserves above each titled item.
 * The text scales with zoom like the images do, and only on-screen titles exist in the DOM.
 */
class ItemTitles {
	private els = new Map<string, HTMLDivElement>()
	private host: HTMLDivElement

	constructor(parent: HTMLElement) {
		this.host = document.createElement('div')
		this.host.className = 'item-titles'
		parent.appendChild(this.host)
	}

	update(items: Record<string, Item>, displayed: Map<string, Displayed>, view: Box, editor: Editor) {
		const z = editor.camera.peek().z
		const strip = LAYOUT.titleHeight
		// Scales with zoom, but never past MAX_ITEM_TITLE_PX on screen.
		const fontSize = Math.min(13 * z, MAX_ITEM_TITLE_PX)
		const seen = new Set<string>()
		{
			for (const [id, d] of displayed) {
				const title = items[id]?.title
				if (!title || !Box.intersects({ x: d.x, y: d.y - strip, w: d.w, h: strip }, view)) continue
				seen.add(id)
				let el = this.els.get(id)
				if (!el) {
					el = document.createElement('div')
					el.className = 'item-title'
					this.host.appendChild(el)
					this.els.set(id, el)
				}
				if (el.textContent !== title) el.textContent = title
				const p = editor.pageToScreen({ x: d.x, y: d.y - strip })
				el.style.transform = `translate(${p.x}px, ${p.y}px)`
				el.style.width = `${d.w * z}px`
				el.style.height = `${strip * z}px`
				el.style.fontSize = `${fontSize}px`
				el.style.opacity = String(d.opacity)
			}
		}
		for (const [id, el] of this.els) {
			if (seen.has(id)) continue
			el.remove()
			this.els.delete(id)
		}
	}

	destroy() {
		this.host.remove()
	}
}

interface HtmlFrame {
	wrap: HTMLDivElement
	frame: HTMLIFrameElement
	loaded: boolean
	src: string
	style: string
	/** In the document's injected link reporter; its messages must carry it. */
	nonce: string
	/** Its links in document px, as last reported. */
	links: { href: string; rects: Box[] }[]
	/** Where the document is on screen, as of the last update(). */
	transform: FrameTransform & { w: number; h: number }
}

/**
 * HTML items as sandboxed iframes in the overlay, laid out at the item's design size (item.width ×
 * item.height CSS px) and scaled onto its displayed box, so the browser renders them crisply at any
 * zoom. They never take input (the editor hit-tests from layout boxes), so they behave like images;
 * their links are reported by a script injected into each document (see HtmlLinks.ts) and opened
 * by the editor.
 * Only items in or near the viewport get an iframe, at most MAX_HTML_FRAMES, biggest on screen first.
 * Since they cover the WebGPU canvas, their selection/hover outlines are drawn here too.
 */
class HtmlItems {
	private frames = new Map<string, HtmlFrame>()
	readonly host: HTMLDivElement

	constructor(parent: HTMLElement) {
		this.host = document.createElement('div')
		this.host.className = 'html-items'
		// First in the overlay, so titles, buttons, notes and cursors all sit above.
		parent.prepend(this.host)
		window.addEventListener('message', this.onMessage)
	}

	private onMessage = (e: MessageEvent) => {
		if (!e.source) return
		for (const f of this.frames.values()) {
			if (f.frame.contentWindow !== e.source) continue
			const links = parseLinkMessage(e.data, f.nonce)
			if (links) f.links = links
			return
		}
	}

	/** Where the item's document is on screen, if it's mounted. */
	transform(id: string): FrameTransform | null {
		return this.frames.get(id)?.transform ?? null
	}

	/** The link under a screen point (relative to the canvas container), in a mounted, loaded item. */
	linkAt(point: { x: number; y: number }): HtmlLink | null {
		for (const [itemId, f] of this.frames) {
			const t = f.transform
			if (!f.loaded || !f.links.length || t.sx <= 0 || t.sy <= 0) continue
			const x = (point.x - t.x) / t.sx
			const y = (point.y - t.y) / t.sy
			if (x < 0 || y < 0 || x > t.w || y > t.h) continue
			// Later links are usually drawn on top of earlier ones.
			for (let i = f.links.length - 1; i >= 0; i--) {
				const link = f.links[i]
				if (link.rects.some((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h)) return { itemId, ...link }
			}
			return null
		}
		return null
	}

	/** Returns the ids of the items that are mounted. */
	update(
		items: Record<string, Item>,
		displayed: Map<string, Displayed>,
		view: Box,
		editor: Editor,
		marks: { selected: Set<string>; hovered: string | null; remote: Map<string, RGBA> },
	): Set<string> {
		const z = editor.camera.peek().z
		const wanted: { item: Item; d: Displayed; area: number }[] = []
		for (const [id, d] of displayed) {
			const item = items[id]
			if (item?.kind !== 'html' || !Box.intersects(d, view)) continue
			if (Math.min(d.w, d.h) * z < MIN_HTML_PX) continue
			wanted.push({ item, d, area: d.w * d.h })
		}
		if (wanted.length > MAX_HTML_FRAMES) wanted.sort((a, b) => b.area - a.area).splice(MAX_HTML_FRAMES)

		const seen = new Set<string>()
		for (const { item, d } of wanted) {
			seen.add(item.id)
			const f = this.frames.get(item.id) ?? this.mount(item)
			const src = withBase(item.src)
			if (f.src !== src) this.load(f, src)
			const p = editor.pageToScreen(d)
			const remote = marks.remote.get(item.id)
			const shadow = marks.selected.has(item.id)
				? `0 0 0 2px ${css(ACCENT)}`
				: marks.hovered === item.id
					? `0 0 0 1.5px ${css(withAlpha(ACCENT, 0.7))}`
					: 'none'
			const style =
				`transform:translate(${p.x}px,${p.y}px);width:${d.w * z}px;height:${d.h * z}px;` +
				`border-radius:${ITEM_RADIUS * z}px;box-shadow:${shadow};` +
				(remote ? `outline:2.5px solid ${css(remote)};outline-offset:3px;` : '')
			if (f.style !== style) {
				f.style = style
				f.wrap.style.cssText = style
			}
			f.frame.style.width = `${item.width}px`
			f.frame.style.height = `${item.height}px`
			f.transform = { x: p.x, y: p.y, sx: (d.w * z) / item.width, sy: (d.h * z) / item.height, w: item.width, h: item.height }
			f.frame.style.transform = `scale(${f.transform.sx}, ${f.transform.sy})`
			f.frame.style.opacity = f.loaded ? String(d.opacity) : '0'
		}
		for (const [id, f] of this.frames) {
			if (seen.has(id)) continue
			f.wrap.remove()
			this.frames.delete(id)
		}
		return seen
	}

	private mount(item: Item): HtmlFrame {
		const wrap = document.createElement('div')
		wrap.className = 'html-item'
		const frame = document.createElement('iframe')
		// Scripts may run, but with an opaque origin: no access to this page, its cookies or the API.
		frame.setAttribute('sandbox', 'allow-scripts')
		frame.setAttribute('scrolling', 'no')
		frame.loading = 'lazy'
		frame.tabIndex = -1
		frame.title = item.title ?? 'HTML item'
		const f: HtmlFrame = {
			wrap,
			frame,
			loaded: false,
			src: '',
			style: '',
			nonce: '',
			links: [],
			transform: { x: 0, y: 0, sx: 0, sy: 0, w: 0, h: 0 },
		}
		frame.addEventListener('load', () => {
			// The initial about:blank, before load() has given it a document.
			if (!frame.hasAttribute('srcdoc') && !frame.hasAttribute('src')) return
			f.loaded = true
			frame.style.opacity = '1'
		})
		wrap.appendChild(frame)
		this.host.appendChild(wrap)
		this.frames.set(item.id, f)
		return f
	}

	/**
	 * Loads the item's HTML as srcdoc with the link reporter added. It keeps the sandbox's opaque
	 * origin, and a <base> keeps relative URLs pointing where they did. If the HTML can't be fetched,
	 * the iframe loads the URL itself (no links).
	 */
	private load(f: HtmlFrame, src: string) {
		f.src = src
		f.loaded = false
		f.links = []
		f.nonce = makeNonce()
		const nonce = f.nonce
		loadHtml(src).then((html) => {
			if (f.src !== src || f.nonce !== nonce || !f.frame.isConnected) return
			if (html === null) {
				f.frame.removeAttribute('srcdoc')
				f.frame.src = src
			} else {
				f.frame.srcdoc = withLinkReporter(html, src, nonce)
			}
		})
	}

	destroy() {
		window.removeEventListener('message', this.onMessage)
		this.host.remove()
	}
}

const LINK_ICON =
	'<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5"/></svg>'
const CHECK_ICON =
	'<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>'
const COPIED_MS = 1400

/**
 * Buttons over the top-right corner of the hovered item, shown while shift is held: copy a link to
 * its original file (the canvas server's public URL, even when this page is served elsewhere) and
 * download it.
 */
class ItemActions {
	private el: HTMLDivElement
	private link: HTMLButtonElement
	private download: HTMLAnchorElement
	private itemId: string | null = null
	private copiedTimer = 0

	constructor(parent: HTMLElement) {
		this.el = document.createElement('div')
		this.el.className = 'item-actions'
		this.link = document.createElement('button')
		this.link.className = 'item-action item-link'
		this.link.title = 'Copy link to the file'
		this.link.innerHTML = LINK_ICON
		this.link.addEventListener('click', () => this.copyLink())
		this.download = document.createElement('a')
		this.download.className = 'item-action item-download'
		this.download.title = 'Download'
		this.download.innerHTML =
			'<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>'
		this.el.append(this.link, this.download)
		// Keep the click from reaching the canvas (which would select or start a brush).
		this.el.addEventListener('pointerdown', (e) => e.stopPropagation())
		this.el.addEventListener('dblclick', (e) => e.stopPropagation())
		parent.appendChild(this.el)
	}

	update(item: Item | undefined, box: Displayed | undefined, editor: Editor) {
		const z = editor.camera.peek().z
		if (!item || !box || box.w * z < 96 || box.h * z < 48) {
			this.el.style.display = 'none'
			this.itemId = null
			return
		}
		if (this.itemId !== item.id) {
			this.itemId = item.id
			this.download.href = withBase(item.src)
			this.download.download = downloadName(item)
			this.showCopied(false)
		}
		const p = editor.pageToScreen({ x: box.x + box.w, y: box.y })
		this.el.style.display = 'flex'
		this.el.style.transform = `translate(calc(${p.x - 8}px - 100%), ${p.y + 8}px)`
	}

	private async copyLink() {
		const href = new URL(withBase(this.download.getAttribute('href') ?? ''), location.href).href
		try {
			await copyText(href)
			this.showCopied(true)
			clearTimeout(this.copiedTimer)
			this.copiedTimer = window.setTimeout(() => this.showCopied(false), COPIED_MS)
		} catch (e) {
			console.error('copying the link failed', e)
			this.link.title = `Couldn't copy: ${href}`
		}
	}

	private showCopied(copied: boolean) {
		this.link.classList.toggle('copied', copied)
		this.link.innerHTML = copied ? CHECK_ICON : LINK_ICON
		this.link.title = copied ? 'Copied' : 'Copy link to the file'
	}

	destroy() {
		clearTimeout(this.copiedTimer)
		this.el.remove()
	}
}

/** Puts text on the clipboard, falling back to execCommand where the Clipboard API isn't available. */
async function copyText(text: string) {
	if (navigator.clipboard?.writeText) {
		try {
			return await navigator.clipboard.writeText(text)
		} catch {}
	}
	const area = document.createElement('textarea')
	area.value = text
	area.style.cssText = 'position:fixed;opacity:0;pointer-events:none'
	document.body.appendChild(area)
	area.select()
	const ok = document.execCommand('copy')
	area.remove()
	if (!ok) throw new Error('the clipboard is not available')
}

function downloadName(item: Item) {
	const ext = item.src.slice(item.src.lastIndexOf('.'))
	const base = (item.title ?? item.caption ?? item.id).replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[^\w.-]+/g, '-').slice(0, 80) || item.id
	return base + ext
}

const MAX_ITEM_TITLE_PX = 15

/** Section titles as DOM text, positioned in screen space so they stay crisp and readable at any zoom. */
class SectionLabels {
	private els = new Map<string, HTMLDivElement>()
	private host: HTMLDivElement

	constructor(
		parent: HTMLElement,
		/** null hides the close buttons (read-only views) */
		private onClose: ((sectionId: string) => void) | null,
	) {
		this.host = document.createElement('div')
		this.host.className = 'section-labels'
		parent.appendChild(this.host)
	}

	private createLabel(id: string) {
		const el = document.createElement('div')
		el.className = 'section-label'
		el.innerHTML = '<span class="title"></span>'
		const onClose = this.onClose
		if (!onClose) return el
		const button = document.createElement('button')
		button.className = 'close'
		button.title = 'Remove this session'
		button.textContent = '×'
		el.appendChild(button)
		let armTimer = 0
		const disarm = () => {
			clearTimeout(armTimer)
			button.classList.remove('armed')
			button.textContent = '×'
		}
		// Removal takes two clicks: the first arms the button, the second removes (undo brings it back).
		button.addEventListener('pointerdown', (e) => e.stopPropagation())
		button.addEventListener('dblclick', (e) => e.stopPropagation())
		button.addEventListener('click', (e) => {
			e.stopPropagation()
			if (!button.classList.contains('armed')) {
				button.classList.add('armed')
				button.textContent = 'Remove'
				armTimer = window.setTimeout(disarm, 3000)
				return
			}
			disarm()
			onClose(id)
		})
		button.addEventListener('pointerleave', disarm)
		return el
	}

	/**
	 * Session titles sit inside the top of each frame and group headings above each group. Both are
	 * page-space text that scales with zoom like the images. Session titles never shrink below a
	 * readable size; when zoomed far out they grow upward out of the frame instead.
	 */
	update(sections: SectionLayout[], displayed: Map<string, Displayed>, editor: Editor) {
		const seen = new Set<string>()
		const z = editor.camera.peek().z
		const place = (el: HTMLElement, box: Box, scale: number) => {
			// Anchor at the bottom-left of the box, scaling up from there.
			const b = editor.pageToScreen({ x: box.x, y: box.y + box.h })
			el.style.width = `${(box.w * z) / scale}px`
			el.style.height = `${box.h}px`
			el.style.transform = `translate(${b.x}px, ${b.y - box.h}px) scale(${scale})`
		}

		for (const s of sections) {
			const d = displayed.get(s.id)
			if (!d) continue
			// Follow the frame's eased position while the layout animates.
			const dx = d.x - s.box.x
			const dy = d.y - s.box.y
			const shift = (b: Box): Box => ({ x: b.x + dx, y: b.y + dy, w: b.w, h: b.h })

			seen.add(s.id)
			let el = this.els.get(s.id)
			if (!el) {
				el = this.createLabel(s.id)
				this.host.appendChild(el)
				this.els.set(s.id, el)
			}
			const title = el.children[0] as HTMLElement
			// Sessions posted without a title (or titled with their id) get a placeholder; the id shows on hover.
			const untitled = !s.title.trim() || s.title === s.id
			const label = untitled ? 'Untitled session' : s.title
			if (title.textContent !== label) {
				title.textContent = label
				title.title = untitled ? s.id : ''
				title.style.opacity = untitled ? '0.6' : ''
			}
			place(el, shift(s.header), Math.max(z, LAYOUT.minFrameTitlePx / LAYOUT.frameTitlePx))
			el.style.opacity = String(d.opacity)

			for (const g of s.groups) {
				if (!g.heading) continue
				const key = `g:${g.id}`
				seen.add(key)
				let h = this.els.get(key)
				if (!h) {
					h = document.createElement('div')
					h.className = 'group-heading'
					h.innerHTML = '<span class="name"></span>'
					this.host.appendChild(h)
					this.els.set(key, h)
				}
				const name = h.children[0] as HTMLElement
				if (name.textContent !== g.name) name.textContent = g.name
				place(h, shift(g.heading), z)
				h.style.opacity = String(d.opacity)
			}
		}
		for (const [id, el] of this.els) {
			if (seen.has(id)) continue
			el.remove()
			this.els.delete(id)
		}
	}

	destroy() {
		this.host.remove()
	}
}

/** Runs one startup step, prefixing any error with what was being done and the error's name. */
function step<T>(what: string, fn: () => T): T {
	const fail = (e: unknown): never => {
		throw new Error(`Failed ${what}: ${describeError(e)}`, { cause: e })
	}
	try {
		const result = fn()
		return (result instanceof Promise ? result.catch(fail) : result) as T
	} catch (e) {
		return fail(e)
	}
}

export function describeError(e: unknown): string {
	if (e instanceof Error) return e.name && e.name !== 'Error' ? `${e.name}: ${e.message}` : e.message
	return String(e)
}

/** Trilinear + anisotropic, or without anisotropy where that isn't accepted. */
async function createSampler(device: GPUDevice) {
	const base: GPUSamplerDescriptor = { magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' }
	try {
		device.pushErrorScope('validation')
		const sampler = device.createSampler({ ...base, maxAnisotropy: 8 })
		if (!(await device.popErrorScope())) return sampler
	} catch {}
	return step('creating a sampler', () => device.createSampler(base))
}

/** The preferred format and opaque alpha, falling back to the formats every implementation must accept. */
function configureContext(context: GPUCanvasContext, device: GPUDevice): GPUTextureFormat {
	let preferred: GPUTextureFormat = 'bgra8unorm'
	try {
		preferred = navigator.gpu.getPreferredCanvasFormat()
	} catch {}
	const attempts: GPUCanvasConfiguration[] = [
		{ device, format: preferred, alphaMode: 'opaque' },
		{ device, format: preferred, alphaMode: 'premultiplied' },
		{ device, format: 'bgra8unorm' },
		{ device, format: 'rgba8unorm' },
	]
	let error: unknown
	for (const config of attempts) {
		try {
			context.configure(config)
			return config.format
		} catch (e) {
			error = e
		}
	}
	throw error
}

function approach(a: number, b: number, k: number) {
	const next = a + (b - a) * k
	return Math.abs(b - next) < 0.05 ? b : next
}

function ensure(arr: Float32Array<ArrayBuffer>, length: number): Float32Array<ArrayBuffer> {
	if (arr.length >= length) return arr
	const next = new Float32Array(Math.max(length, arr.length * 2))
	next.set(arr)
	return next
}

function premul(out: Float32Array, o: number, [r, g, b, a]: RGBA) {
	out[o] = r * a
	out[o + 1] = g * a
	out[o + 2] = b * a
	out[o + 3] = a
}

function hexToRgba(hex: string): RGBA {
	const n = parseInt(hex.replace('#', ''), 16)
	return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1]
}

function css([r, g, b, a]: RGBA) {
	return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`
}

function withAlpha([r, g, b, a]: RGBA, k: number): RGBA {
	return [r, g, b, a * k]
}
