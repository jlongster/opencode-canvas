import type { Item } from '../../../shared/types'
import { GROUP_OUTLINE_PADDING, opensInDrawer, type Editor, type HtmlLink } from '../editor/Editor'
import { Box, clamp } from '../editor/geometry'
import { LAYOUT } from '../editor/layout'
import { frameKey } from '../editor/selection'
import { imageShader, rectShader, videoShader } from './shaders'
import { TextureCache } from './TextureCache'
import { VideoPool } from './VideoPool'
import { EXTRACT_ICON, VideoControls } from './VideoControls'
import { LinkHover, loadHtml, makeNonce, parseLinkMessage, withLinkReporter, type FrameTransform } from './HtmlLinks'
import { PageBadges, pageDomain } from './PageBadges'
import { ItemBadges } from './ItemBadges'
import { linkCardUrl } from './linkCard'
import { url as withBase } from '../base'
import { THEME } from '../theme'
import { SheetHeads } from './SheetHeads'

const THUMB_SIZE = 512
/** Sheets and items are square-cornered (the Reference Manual). */
const ITEM_RADIUS = 0
const SECTION_RADIUS = 0
const EASE_MS = 90 // time constant for layout motion
const FADE_MS = 220
/** A focused group's outline shows this long, fading out over the last GROUP_FLASH_FADE_MS. */
const GROUP_FLASH_MS = 1200
const GROUP_FLASH_FADE_MS = 800
/** Most HTML items mounted as iframes at once; the rest show their placeholder. */
const MAX_HTML_FRAMES = 40
/** Mount HTML items this far (screen px) outside the viewport, so they're ready when panned in. */
const HTML_MARGIN_PX = 400
/** HTML items smaller than this on screen aren't worth an iframe. */
const MIN_HTML_PX = 24

const RECT_FLOATS = 16
const IMAGE_FLOATS = 8
/** rect patterns (see rectShader) */
const DITHER = 1
const PINSTRIPE = 2
const PLUS_MARKS = 3

type RGBA = [number, number, number, number]
const [BG_R, BG_G, BG_B] = hexToRgba(THEME.canvas)
const BG: GPUColor = { r: BG_R, g: BG_G, b: BG_B, a: 1 }
/** Rules that matter: ink. */
const INK: RGBA = hexToRgba(THEME.ink)
/** Selection, hover and the brush */
const ACCENT: RGBA = [0.34, 0.56, 1, 1]
/** Frames: a sheet of paper on the ground, edged with a hairline */
const SECTION_FILL: RGBA = hexToRgba(THEME.frame)
const SECTION_STROKE: RGBA = hexToRgba(THEME.rule2)
/** a subagent's drawer, unfolded in its parent's sheet */
const DRAWER_FILL: RGBA = hexToRgba(THEME.raised)
/** the running sheet's spine */
const BLUE: RGBA = hexToRgba(THEME.blue)
/** the canvas's plus-marks */
const PLUS: RGBA = hexToRgba(THEME.plus)
/** an item's edge */
const ITEM_EDGE: RGBA = [0, 0, 0, 0.12]
/** under an item until its picture's ready: the sheet, dithered (loading) or pinstriped (queued) */
const PLACEHOLDER: RGBA = hexToRgba(THEME.frame)
const DITHER_INK: RGBA = withAlpha(INK, 0.28)
const PINSTRIPE_INK: RGBA = hexToRgba(THEME.pinstripe)
const NONE: RGBA = [0, 0, 0, 0]
/** A frame picked up by its title: opaque (so nothing shows through it), over a hard offset shadow */
const LIFTED_FILL: RGBA = hexToRgba(THEME.frame)
const LIFTED_STROKE: RGBA = hexToRgba(THEME.ink)
const SHADOW: RGBA = withAlpha(INK, 0.14)

export interface RendererOptions {
	/** Hide editing controls (view-only links) */
	readOnly?: boolean
	/** Other people's selections (selection keys, see selection.ts), outlined in their colour (multiplayer). */
	getRemoteSelections?: () => { ids: string[]; color: string }[]
	/** Called when the GPU device is lost other than by destroy() (iOS drops it in background tabs, GPU resets). */
	onDeviceLost?: (message: string) => void
	/** Frames drawn last, back to front, each opaque over a soft shadow (0–1), so they can overlap like a stack (a dragged frame goes on top). */
	getRaisedSections?: () => readonly { id: string; shadow: number }[]
	/** The sessions working right now (see SessionControl.busy): their sheets get a blue spine. */
	busySessions?: () => ReadonlySet<string>
	/**
	 * false: frames and items are drawn exactly where the layout puts them, at its opacity
	 * (SectionLayout.opacity), with no easing or fade-in: the caller animates the layout itself.
	 */
	easeLayout?: boolean
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
	private busyKey = ''
	private textures: TextureCache
	private videos: VideoPool
	private labels: SheetHeads
	private actions: ItemActions
	private videoControls: VideoControls
	private titles: ItemTitles
	private html: HtmlItems
	private linkHover: LinkHover
	private hoverBar: HoverBar
	/** what each item in view shows while its picture isn't ready: loading or queued */
	private itemStates = new Map<string, 'loading' | 'queued'>()
	private pageBadges: PageBadges
	private itemBadges: ItemBadges

	/** the texture each item was last drawn with, by item id (see pickTexture) */
	private drawnTextures = new Map<string, string>()
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
		this.labels = new SheetHeads(
			overlay,
			editor,
			options.readOnly ? null : (id) => editor.setFrameHidden(id, true),
			(id, count) => editor.showMoreItems(id, count),
			(id) => editor.drawers.set(id, false),
		)
		this.titles = new ItemTitles(overlay)
		this.videoControls = new VideoControls(overlay, this.videos, editor, !!options.readOnly)
		this.pageBadges = new PageBadges(overlay, (item) => editor.openHtmlDrawer(item.id))
		this.itemBadges = new ItemBadges(overlay)
		// HTML items and pages both open in the side drawer (a page: its live web page).
		const open = (id: string) => editor.openHtmlDrawer(id)
		this.actions = new ItemActions(overlay, options.readOnly ? null : this.videoControls, open)
		this.hoverBar = new HoverBar(overlay, open)

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
		this.draw(now, elapsed)
	}

	private draw(now: number, elapsed: number) {
		const editor = this.editor
		const layout = editor.layout.get()
		const camera = editor.camera.get()
		const items = editor.items.get()
		const hovered = editor.hoveredId.get()
		const selected = editor.selectedSet.get()

		// Which videos get an element (only if visible): hovered, selected, then ones the viewer played or paused.
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
		for (const id of this.videos.touchedIds()) consider(id)
		this.videos.sync(wantedVideos)

		const uploaded = this.textures.update()
		const epoch = editor.getEpoch()
		const busy = this.options.busySessions?.() ?? editor.busy.peek()
		const busyKey = [...busy].sort().join()
		const busyChanged = busyKey !== this.busyKey
		this.busyKey = busyKey
		const needsFrame =
			epoch !== this.lastEpoch ||
			this.animating ||
			uploaded ||
			busyChanged ||
			this.videos.takeDirty() ||
			this.videos.isPlaying ||
			editor.isCameraMoving()
		if (!needsFrame || this.pixelSize.w === 0) return
		this.lastEpoch = epoch

		const t0 = performance.now()
		this.animating = this.stepDisplay(layout, elapsed)

		if (this.canvas.width !== this.pixelSize.w || this.canvas.height !== this.pixelSize.h) {
			this.canvas.width = this.pixelSize.w
			this.canvas.height = this.pixelSize.h
		}

		const { w: vw, h: vh } = editor.viewport.get()
		// (the drawing buffer's pixels per CSS px: what the canvas really has, which can differ from devicePixelRatio)
		this.globalsData.set([camera.x, camera.y, camera.z, this.canvas.width / vw, vw, vh, now / 1000, 0])
		this.device.queue.writeBuffer(this.globals, 0, this.globalsData)

		const cull = Box.expand(viewBounds, 64 / camera.z)
		const unit = 1 / camera.z

		// ---- build instance data ----
		let rects = 0
		const pushRect = (b: Box, fill: RGBA, stroke: RGBA, strokeWidth: number, radius: number, screen: boolean, pattern = 0) => {
			this.rectData = ensure(this.rectData, (rects + 1) * RECT_FLOATS)
			const o = rects++ * RECT_FLOATS
			const d = this.rectData
			d[o] = b.x; d[o + 1] = b.y; d[o + 2] = b.w; d[o + 3] = b.h
			premul(d, o + 4, fill)
			premul(d, o + 8, stroke)
			d[o + 12] = pattern ? 0 : strokeWidth; d[o + 13] = radius; d[o + 14] = screen ? 1 : 0; d[o + 15] = pattern
		}
		// The ground: plus-marks, anchored to the page.
		pushRect({ x: 0, y: 0, w: vw, h: vh }, NONE, PLUS, 0, 0, true, PLUS_MARKS)
		/** Where a sheet is drawn: its frame, and its head where that grows up out of it (zoomed out, see frameTitleBox). */
		const minScale = LAYOUT.minFrameTitlePx / LAYOUT.frameTitlePx
		const sheetOf = (section: (typeof layout.sections)[number], d: Displayed): Box => {
			if (section.drawer) return d
			const grow = Math.max(1, minScale / camera.z)
			const bottom = d.y + section.header.y - section.box.y + section.header.h
			const top = Math.min(d.y, bottom - section.header.h * grow)
			return { x: d.x, y: top, w: d.w, h: d.y + d.h - top }
		}
		const pushSheet = (section: (typeof layout.sections)[number], d: Displayed, fill: RGBA, stroke: RGBA) => {
			if (section.drawer) {
				// a band across its parent's sheet, ruled off in ink below
				pushRect(d, DRAWER_FILL, NONE, 0, 0, false)
				pushRect({ x: d.x, y: d.y + d.h - unit, w: d.w, h: unit }, INK, NONE, 0, 0, false)
				return
			}
			const b = sheetOf(section, d)
			pushRect(b, withAlpha(fill, d.opacity), withAlpha(stroke, d.opacity), 1, SECTION_RADIUS, false)
			// running: a 4 px blue spine down its left edge
			if (busy.has(section.id)) pushRect({ x: b.x - 5 * unit, y: b.y - unit, w: 4 * unit, h: b.h + 2 * unit }, withAlpha(BLUE, d.opacity), NONE, 0, 0, false)
		}

		const overlays: (() => void)[] = []
		const remoteSelected = new Map<string, RGBA>()
		for (const { ids, color } of this.options.getRemoteSelections?.() ?? []) {
			const rgba = hexToRgba(color)
			for (const id of ids) if (!remoteSelected.has(id)) remoteSelected.set(id, rgba)
		}

		// A dragged frame and its items are drawn last, over everything else (see the draw calls below).
		const liftedId = editor.frameDrag.get()?.sessionId ?? null
		const raised = [...(this.options.getRaisedSections?.() ?? []).filter((r) => r.id !== liftedId), ...(liftedId ? [{ id: liftedId, shadow: 1 }] : [])]
		const raisedIds = new Set(raised.map((r) => r.id))
		// (parents before their drawers: a band lies across its parent's sheet)
		const drawn = [...layout.sections].sort((a, b) => Number(!!a.drawer) - Number(!!b.drawer))
		for (const section of drawn) {
			const d = this.displayedSections.get(section.id)
			if (!d || raisedIds.has(section.id)) continue
			const sheet = sheetOf(section, d)
			if (!Box.intersects(sheet, cull)) continue
			pushSheet(section, d, SECTION_FILL, SECTION_STROKE)
			const key = frameKey(section.id)
			const remote = remoteSelected.get(key)
			if (remote) overlays.push(() => pushRect(Box.expand(sheet, 4 * unit), NONE, remote, 2.5, SECTION_RADIUS, false))
			if (selected.has(key)) overlays.push(() => pushRect(sheet, NONE, ACCENT, 2, SECTION_RADIUS, false))
		}

		// A hovered heading gets a faint outline around its group; a just-focused group a fading one.
		const hoveredGroupId = editor.hoveredGroupId.get()
		const flash = editor.groupFlash
		const flashAlpha = flash ? clamp((GROUP_FLASH_MS - (now - flash.at)) / GROUP_FLASH_FADE_MS, 0, 1) : 0
		if (flash && flashAlpha > 0) this.animating = true
		for (const group of layout.groups) {
			const flashing = flashAlpha > 0 && group.id === flash!.id
			if (!flashing && group.id !== hoveredGroupId) continue
			const section = layout.sections.find((s) => s.id === group.sessionId)
			const d = section && this.displayedSections.get(section.id)
			if (!section || !d) continue
			const pad = GROUP_OUTLINE_PADDING
			const b = { x: group.box.x + d.x - section.box.x - pad, y: group.box.y + d.y - section.box.y - pad, w: group.box.w + pad * 2, h: group.box.h + pad * 2 }
			const stroke = flashing ? withAlpha(ACCENT, Math.max(flashAlpha, 0.35)) : withAlpha(ACCENT, 0.35)
			overlays.push(() => pushRect(b, NONE, stroke, flashing ? 2 : 1, ITEM_RADIUS, false))
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
		)
		const link = editor.hoveredLink.get()
		this.linkHover.update(link, link && this.html.transform(link.itemId), editor.viewport.get())

		const pushItem = (id: string, d: Displayed) => {
			if (!Box.intersects(d, cull)) return
			const item = items[id]
			if (!item) return

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
			// Not ready yet: a 50% dither while it loads, pinstripes while it's queued (no picture made yet). Never a shimmer.
			const loading = item.kind === 'html' ? !this.html.isLoaded(id) : texAlpha < 1
			if (loading) {
				const queued = !item.thumb && item.kind !== 'page' && item.kind !== 'html'
				this.itemStates.set(id, queued ? 'queued' : 'loading')
				const a = d.opacity * (item.kind === 'html' ? 1 : 1 - texAlpha)
				pushRect(d, withAlpha(PLACEHOLDER, a), withAlpha(queued ? PINSTRIPE_INK : DITHER_INK, a), 0, ITEM_RADIUS, false, queued ? PINSTRIPE : DITHER)
			}

			// (easeLayout false: an item fading with its frame takes its outlines with it)
			const fade = this.options.easeLayout === false ? d.opacity : 1
			// Someone else's selection sits outside ours, so both stay visible.
			const remote = remoteSelected.get(id)
			if (remote) overlays.push(() => pushRect(Box.expand(d, 3 * unit), NONE, withAlpha(remote, fade), 2.5, ITEM_RADIUS, false))
			if (selected.has(id)) overlays.push(() => pushRect(d, NONE, withAlpha(ACCENT, fade), 2, ITEM_RADIUS, false))
			else if (hovered === id) overlays.push(() => pushRect(d, NONE, withAlpha(ACCENT, 0.7 * fade), 1.5, ITEM_RADIUS, false))
			// at rest, a faint edge
			else overlays.push(() => pushRect(d, NONE, withAlpha(ITEM_EDGE, fade * d.opacity), 1, 0, false))
		}
		this.itemStates.clear()
		for (const [id, d] of this.displayedItems) if (!raisedIds.has(layout.sectionOf.get(id)!)) pushItem(id, d)

		// Raised frames, in order: each a soft shadow (stacked translucent rects), the opaque frame, then its items.
		const layers: number[][] = []
		for (const r of raised) {
			const lifted = this.displayedSections.get(r.id)
			if (!lifted) continue
			const from = [rects, images]
			const section = layout.sections.find((s) => s.id === r.id)!
			const sheet = sheetOf(section, lifted)
			// a hard offset shadow, like paper lifted off the desk
			if (r.shadow > 0) pushRect({ x: sheet.x + 5 * unit, y: sheet.y + 5 * unit, w: sheet.w, h: sheet.h }, withAlpha(SHADOW, r.shadow * lifted.opacity), NONE, 0, 0, false)
			pushSheet(section, lifted, LIFTED_FILL, r.id === liftedId ? LIFTED_STROKE : SECTION_STROKE)
			if (selected.has(frameKey(r.id))) overlays.push(() => pushRect(sheet, NONE, ACCENT, 2, SECTION_RADIUS, false))
			for (const [id, d] of this.displayedItems) if (layout.sectionOf.get(id) === r.id) pushItem(id, d)
			layers.push([from[0], rects, from[1], images])
		}
		const liftedRects = layers[0]?.[0] ?? rects
		const liftedImages = layers[0]?.[2] ?? images

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

		const drawRects = (from: number, to: number) => {
			if (to <= from) return
			pass.setPipeline(this.rectPipeline)
			pass.setVertexBuffer(0, this.rectBuffer)
			pass.draw(6, to - from, 0, from)
		}
		const drawImages = (from: number, to: number) => {
			if (to <= from) return
			pass.setVertexBuffer(0, this.imageBuffer)
			let current: GPURenderPipeline | null = null
			for (let i = from; i < to; i++) {
				const draw = imageDraws[i]
				const pipeline = draw.video ? this.videoPipeline : this.imagePipeline
				if (pipeline !== current) pass.setPipeline((current = pipeline))
				pass.setBindGroup(1, draw.bindGroup)
				pass.draw(6, 1, 0, i)
			}
		}
		drawRects(0, liftedRects)
		drawImages(0, liftedImages)
		for (const [r0, r1, i0, i1] of layers) {
			drawRects(r0, r1)
			drawImages(i0, i1)
		}
		for (const [id, copy] of this.videoCopies) {
			if (drawnVideos.has(id)) continue
			copy.texture.destroy()
			this.videoCopies.delete(id)
		}

		drawRects(backgroundRects, rects)

		pass.end()
		this.device.queue.submit([encoder.finish()])

		this.labels.update(layout.sections, this.displayedSections, liftedId)
		this.titles.update(items, this.displayedItems, cull, editor, this.itemStates)
		this.videoControls.update(items, this.displayedItems, viewBounds)
		this.pageBadges.update(items, this.displayedItems, viewBounds, editor)
		this.itemBadges.update(items, this.displayedItems, viewBounds, editor)
		// Shift (or ⋯ on its hover bar) shows a hovered item's file actions; else its hover bar: Open ↗ and ⋯.
		const showDownload = hovered && (editor.isShiftDown.get() || this.hoverBar.moreFor === hovered)
		this.actions.update(showDownload ? items[hovered] : undefined, showDownload ? this.displayedItems.get(hovered) : undefined, editor)
		const hoveredItem = hovered ? items[hovered] : undefined
		const showBar = hovered && !showDownload && !editor.inputs.isPointing
		this.hoverBar.update(showBar ? (hoveredItem ?? null) : null, showBar ? this.displayedItems.get(hovered) : undefined, editor, hovered)

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

	/**
	 * Thumbnail first; full resolution only once the item is bigger on screen than the thumbnail. An
	 * item whose file was replaced keeps showing the last texture drawn for it until the new one is ready.
	 */
	private pickTexture(item: Item, screenPx: number) {
		const entry = this.pickNewTexture(item, screenPx)
		if (entry) {
			this.drawnTextures.set(item.id, entry.url)
			return entry
		}
		const last = this.drawnTextures.get(item.id)
		return last ? this.textures.peek(last) : undefined
	}

	private pickNewTexture(item: Item, screenPx: number) {
		// a page without a screenshot: its link card
		if (item.kind === 'page' && !item.thumb) {
			const card = this.textures.request(linkCardUrl(item))
			return card.state === 'ready' ? card : undefined
		}
		if (!item.thumb) return undefined
		const thumb = this.textures.request(item.thumb)
		const originalLarger = Math.max(item.width, item.height) > THUMB_SIZE
		const still = item.kind === 'image' || item.kind === 'page'
		if (still && originalLarger && screenPx > THUMB_SIZE * 1.1) {
			const full = this.textures.request(item.src)
			if (full.state === 'ready') return full
		} else if (still) {
			const full = this.textures.peek(item.src)
			if (full) return full
		}
		return thumb.state === 'ready' ? thumb : undefined
	}

	/** Eases displayed boxes toward their layout targets. Returns true while anything is still moving. */
	private stepDisplay(layout: ReturnType<Editor['layout']['get']>, elapsed: number) {
		if (this.options.easeLayout === false) return this.snapDisplay(layout)
		const k = 1 - Math.exp(-elapsed / EASE_MS)
		const fade = elapsed / FADE_MS
		let moving = false
		// frames the layout animates itself (subagents' drawers, see drawers.ts), with their items: exactly where it says
		const snapped = new Map<string, number>()
		for (const s of layout.sections) if (s.snap) snapped.set(s.id, s.opacity ?? 1)
		const step = (map: Map<string, Displayed>, targets: Iterable<[string, Box]>, sectionOf: (id: string) => string | undefined) => {
			const seen = new Set<string>()
			for (const [id, t] of targets) {
				seen.add(id)
				const d = map.get(id)
				const snap = snapped.get(sectionOf(id) ?? '')
				if (snap !== undefined) {
					map.set(id, { x: t.x, y: t.y, w: t.w, h: t.h, opacity: Math.min(snap, d && d.opacity < 1 ? d.opacity + fade : 1) })
					continue
				}
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
		step(this.displayedItems, layout.items, (id) => layout.sectionOf.get(id))
		step(this.displayedSections, layout.sections.map((s) => [s.id, s.box] as [string, Box]), (id) => id)
		return moving
	}

	/** easeLayout false: everything where the layout says, as opaque as its frame. Nothing animates on its own. */
	private snapDisplay(layout: ReturnType<Editor['layout']['get']>) {
		const opacity = new Map(layout.sections.map((s) => [s.id, s.opacity ?? 1]))
		const put = (map: Map<string, Displayed>, targets: Iterable<[string, Box]>, alpha: (id: string) => number) => {
			const seen = new Set<string>()
			for (const [id, t] of targets) {
				seen.add(id)
				map.set(id, { x: t.x, y: t.y, w: t.w, h: t.h, opacity: alpha(id) })
			}
			for (const id of map.keys()) if (!seen.has(id)) map.delete(id)
		}
		put(this.displayedItems, layout.items, (id) => opacity.get(layout.sectionOf.get(id)!) ?? 1)
		put(this.displayedSections, layout.sections.map((s) => [s.id, s.box] as [string, Box]), (id) => opacity.get(id) ?? 1)
		return false
	}

	/** Where a frame is drawn right now (it eases toward its layout box) and its opacity. */
	sectionBox(id: string): Readonly<Displayed> | undefined {
		return this.displayedSections.get(id)
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
		this.hoverBar.destroy()
		this.pageBadges.destroy()
		this.itemBadges.destroy()
		this.videoControls.destroy()
		this.titles.destroy()
		this.html.destroy()
		this.linkHover.destroy()
		if (this.editor.linkAt) this.editor.linkAt = null
		this.device.destroy()
	}
}

/**
 * Item labels as DOM text in the strip the layout reserves above each titled item: its name, and
 * its type on the right (png, html, Link, mp4; Loading or Queued until its picture's ready). The
 * text scales with zoom like the images do, and only on-screen labels exist in the DOM.
 */
class ItemTitles {
	private els = new Map<string, { el: HTMLDivElement; name: HTMLElement; kind: HTMLElement }>()
	private host: HTMLDivElement

	constructor(parent: HTMLElement) {
		this.host = document.createElement('div')
		this.host.className = 'item-titles'
		parent.appendChild(this.host)
	}

	update(items: Record<string, Item>, displayed: Map<string, Displayed>, view: Box, editor: Editor, states: ReadonlyMap<string, 'loading' | 'queued'>) {
		const z = editor.camera.peek().z
		const strip = LAYOUT.titleHeight
		// Scales with zoom, but never past MAX_ITEM_TITLE_PX on screen.
		const fontSize = Math.min(26 * z, MAX_ITEM_TITLE_PX)
		const seen = new Set<string>()
		for (const [id, d] of displayed) {
			const item = items[id]
			const title = item?.title
			if (!title || !Box.intersects({ x: d.x, y: d.y - strip, w: d.w, h: strip }, view)) continue
			seen.add(id)
			let entry = this.els.get(id)
			if (!entry) {
				const el = document.createElement('div')
				el.className = 'item-title'
				el.innerHTML = '<span class="nm"></span><span class="kd"></span>'
				this.host.appendChild(el)
				entry = { el, name: el.children[0] as HTMLElement, kind: el.children[1] as HTMLElement }
				this.els.set(id, entry)
			}
			if (entry.name.textContent !== title) entry.name.textContent = title
			const state = states.get(id)
			const kind = state ? state[0].toUpperCase() + state.slice(1) : kindTag(item)
			if (entry.kind.textContent !== kind) entry.kind.textContent = kind
			const el = entry.el
			const p = editor.pageToScreen({ x: d.x, y: d.y - strip })
			el.style.transform = `translate(${p.x}px, ${p.y}px)`
			el.style.width = `${d.w * z}px`
			el.style.height = `${strip * z}px`
			el.style.fontSize = `${fontSize}px`
			el.style.opacity = String(d.opacity)
		}
		for (const [id, entry] of this.els) {
			if (seen.has(id)) continue
			entry.el.remove()
			this.els.delete(id)
		}
	}

	destroy() {
		this.host.remove()
	}
}

/** An item's type, as its label shows it: its file's extension (lower case), Link for a page, html. */
function kindTag(item: Item) {
	if (item.kind === 'page') return 'Link'
	if (item.kind === 'html') return 'html'
	const ext = /\.([a-z0-9]{2,4})(?:[?#]|$)/i.exec(item.name || '')?.[1] ?? /\.([a-z0-9]{2,4})(?:[?#]|$)/i.exec(item.src)?.[1]
	if (!ext) return item.kind === 'video' ? 'Video' : 'Image'
	const low = ext.toLowerCase()
	return low === 'jpeg' ? 'jpg' : low
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
 * Their edges, selection rings and handles are drawn on the WebGPU canvas, just outside them.
 */
class HtmlItems {
	private frames = new Map<string, HtmlFrame>()
	readonly host: HTMLDivElement
	/**
	 * Covers the iframes so touches land on the canvas, not in their documents. iOS Safari hit-tests
	 * gestures into an iframe despite pointer-events: none, where touch-action is auto again, so it
	 * would scroll the iframe's document (or the page) instead of letting the canvas pan.
	 */
	private shield: HTMLDivElement

	constructor(parent: HTMLElement) {
		this.host = document.createElement('div')
		this.host.className = 'html-items'
		this.shield = document.createElement('div')
		this.shield.className = 'html-items-shield'
		this.shield.dataset.surface = ''
		this.shield.hidden = true
		// First in the overlay, so titles, buttons, notes and cursors all sit above.
		parent.prepend(this.host, this.shield)
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

	/** Whether the item is mounted and its document has loaded. */
	isLoaded(id: string) {
		return !!this.frames.get(id)?.loaded
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
			// (their edges, selection rings and handles are drawn on the canvas, outside them)
			const style = `transform:translate(${p.x}px,${p.y}px);width:${d.w * z}px;height:${d.h * z}px;`
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
		this.shield.hidden = this.frames.size === 0
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
		// A page replaced by a new version stays on screen until the new one has loaded.
		f.src = src
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
		this.shield.remove()
	}
}

const LINK_ICON =
	'<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5"/></svg>'
const CHECK_ICON =
	'<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>'
export const OPEN_DRAWER_ICON =
	'<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M14 4v16"/><path d="m9 10-2 2 2 2"/></svg>'
const COPIED_MS = 1400

/**
 * Over the hovered item's top-right corner, at a constant size on screen: plain-text commands on a
 * ruled strip. "Open ↗" on an HTML item or page opens it in the side drawer, where it takes input
 * (a page: the live web page); "⋯" shows its file actions (ItemActions, as shift does).
 */
class HoverBar {
	private el: HTMLDivElement
	private open: HTMLButtonElement
	private itemId: string | null = null
	/** the item whose file actions ⋯ showed (until the pointer leaves it) */
	moreFor: string | null = null

	constructor(parent: HTMLElement, onOpen: (id: string) => void) {
		this.el = document.createElement('div')
		this.el.className = 'hover-bar'
		this.open = document.createElement('button')
		this.open.textContent = 'Open ↗'
		const more = document.createElement('button')
		more.textContent = '⋯'
		more.title = 'Copy its link, download it (or hold shift)'
		this.el.append(this.open, more)
		this.el.addEventListener('pointerdown', (e) => e.stopPropagation())
		this.el.addEventListener('dblclick', (e) => e.stopPropagation())
		this.open.addEventListener('click', (e) => {
			e.stopPropagation()
			if (this.itemId) onOpen(this.itemId)
		})
		more.addEventListener('click', (e) => {
			e.stopPropagation()
			this.moreFor = this.itemId
		})
		parent.appendChild(this.el)
	}

	update(item: Item | null, box: Displayed | undefined, editor: Editor, hovered: string | null) {
		if (this.moreFor && this.moreFor !== hovered) this.moreFor = null
		const z = editor.camera.peek().z
		if (!item || !box || box.w * z < 120 || box.h * z < 64) {
			if (this.itemId !== null) this.el.style.display = 'none'
			this.itemId = null
			return
		}
		this.itemId = item.id
		const openable = opensInDrawer(item)
		this.open.hidden = !openable
		if (openable) this.open.title = drawerTitle(item)
		const p = editor.pageToScreen({ x: box.x + box.w, y: box.y })
		this.el.style.display = 'flex'
		this.el.style.transform = `translate(calc(${Math.round(p.x - 4)}px - 100%), ${Math.round(p.y + 4)}px)`
	}

	destroy() {
		this.el.remove()
	}
}

/**
 * Buttons over the top-right corner of the hovered item, shown while shift is held: copy a link to
 * its original file (the canvas server's public URL, even when this page is served elsewhere) and
 * download it; on a paused video (edit links only), extract its current frame.
 */
class ItemActions {
	private el: HTMLDivElement
	private link: HTMLButtonElement
	private download: HTMLAnchorElement
	private extract: HTMLButtonElement
	private open: HTMLButtonElement
	private itemId: string | null = null
	private kind: Item['kind'] | null = null
	private src = ''
	private linkTarget = ''
	private copiedTimer = 0

	constructor(
		parent: HTMLElement,
		/** null on view links */
		private frames: Pick<VideoControls, 'canExtract' | 'extract'> | null,
		onOpen: (id: string) => void,
	) {
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
		this.extract = document.createElement('button')
		this.extract.className = 'item-action item-extract'
		this.extract.title = 'Extract this frame as an image you can annotate'
		this.extract.innerHTML = EXTRACT_ICON
		this.extract.addEventListener('click', () => this.itemId && this.frames?.extract(this.itemId))
		this.open = document.createElement('button')
		this.open.className = 'item-action item-open'
		this.open.innerHTML = OPEN_DRAWER_ICON
		this.open.addEventListener('click', () => this.itemId && onOpen(this.itemId))
		this.el.append(this.extract, this.open, this.link, this.download)
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
		const page = item.kind === 'page'
		if (this.itemId !== item.id || this.src !== item.src) {
			this.itemId = item.id
			this.src = item.src
			this.download.href = withBase(item.src)
			this.download.download = downloadName(item)
			this.showCopied(false)
		}
		// A page's link is the page itself; everything else's, its file.
		this.linkTarget = page ? (item.pageUrl ?? '') : new URL(withBase(item.src), location.href).href
		if (this.kind !== item.kind) {
			this.kind = item.kind
			this.download.title = page ? 'Download the screenshot' : 'Download'
			this.showCopied(false)
		}
		this.extract.style.display = this.frames?.canExtract(item) ? '' : 'none'
		this.open.title = drawerTitle(item)
		this.open.style.display = opensInDrawer(item) ? '' : 'none'
		this.download.style.display = item.src ? '' : 'none'
		const p = editor.pageToScreen({ x: box.x + box.w, y: box.y })
		this.el.style.display = 'flex'
		this.el.style.transform = `translate(calc(${p.x - 8}px - 100%), ${p.y + 8}px)`
	}

	private async copyLink() {
		const href = this.linkTarget
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
		this.link.title = copied ? 'Copied' : this.kind === 'page' ? 'Copy link to the page' : 'Copy link to the file'
	}

	destroy() {
		clearTimeout(this.copiedTimer)
		this.el.remove()
	}
}

/** The tooltip of the buttons that open an item in the side drawer. */
export function drawerTitle(item: Item) {
	return item.kind === 'page' ? `Open ${pageDomain(item)} in a side panel` : 'Open in a side panel, to use the page'
}

/** Puts text on the clipboard, falling back to execCommand where the Clipboard API isn't available. */
export async function copyText(text: string) {
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

const MAX_ITEM_TITLE_PX = 14

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

function withAlpha([r, g, b, a]: RGBA, k: number): RGBA {
	return [r, g, b, a * k]
}
