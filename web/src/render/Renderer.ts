import type { Item } from '../../../shared/types'
import type { Editor } from '../editor/Editor'
import { Box } from '../editor/geometry'
import { imageShader, rectShader, videoShader } from './shaders'
import { TextureCache } from './TextureCache'
import { VideoPool } from './VideoPool'

const THUMB_SIZE = 512
const ITEM_RADIUS = 6
const SECTION_RADIUS = 20
const EASE_MS = 90 // time constant for layout motion
const FADE_MS = 220

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
	/** Called when the user removes a section with its close button. */
	onCloseSection?: (sectionId: string) => void
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
	private rectBuffer: GPUBuffer | null = null
	private rectData = new Float32Array(RECT_FLOATS * 256) as Float32Array<ArrayBuffer>
	private imageBuffer: GPUBuffer | null = null
	private imageData = new Float32Array(IMAGE_FLOATS * 256) as Float32Array<ArrayBuffer>
	private textures: TextureCache
	private videos: VideoPool
	private labels: SectionLabels

	private displayedItems = new Map<string, Displayed>()
	private displayedSections = new Map<string, Displayed>()
	private lastEpoch = -1
	private animating = true
	private pixelSize = { w: 0, h: 0 }
	private dpr = window.devicePixelRatio || 1
	private disposers: (() => void)[] = []
	frameTimes: number[] = []

	static async create(canvas: HTMLCanvasElement, overlay: HTMLElement, editor: Editor, options: RendererOptions = {}) {
		if (!navigator.gpu) throw new Error('WebGPU is not available in this browser.')
		const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
		if (!adapter) throw new Error('No WebGPU adapter found.')
		const device = await adapter.requestDevice()
		return new Renderer(device, canvas, overlay, editor, options)
	}

	private constructor(
		private device: GPUDevice,
		private canvas: HTMLCanvasElement,
		overlay: HTMLElement,
		private editor: Editor,
		options: RendererOptions,
	) {
		this.context = canvas.getContext('webgpu')!
		this.format = navigator.gpu.getPreferredCanvasFormat()
		this.context.configure({ device, format: this.format, alphaMode: 'opaque' })

		this.globals = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
		this.sampler = device.createSampler({
			magFilter: 'linear',
			minFilter: 'linear',
			mipmapFilter: 'linear',
			maxAnisotropy: 8,
		})

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

		this.textures = new TextureCache(device, imageLayout)
		this.videos = new VideoPool(overlay)
		this.labels = new SectionLabels(overlay, (id) => options.onCloseSection?.(id))

		const ro = new ResizeObserver(([entry]) => {
			const size = entry.devicePixelContentBoxSize?.[0]
			this.dpr = window.devicePixelRatio || 1
			this.pixelSize = size
				? { w: size.inlineSize, h: size.blockSize }
				: { w: Math.round(entry.contentRect.width * this.dpr), h: Math.round(entry.contentRect.height * this.dpr) }
			this.lastEpoch = -1
		})
		ro.observe(canvas, { box: 'device-pixel-content-box' })
		this.disposers.push(() => ro.disconnect())
		this.disposers.push(editor.onFrame((now, elapsed) => this.frame(now, elapsed)))

		device.lost.then((info) => console.error('WebGPU device lost:', info.message))
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
				wantedVideos.push({ id: item.id, src: item.src })
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

		for (const section of layout.sections) {
			const d = this.displayedSections.get(section.id)
			if (!d || !Box.intersects(d, cull)) continue
			pushRect(d, withAlpha(SECTION_FILL, d.opacity), withAlpha(SECTION_STROKE, d.opacity), 1, SECTION_RADIUS, false)
		}

		let images = 0
		const imageDraws: { kind: 'image'; bindGroup: GPUBindGroup }[] = []
		const videoDraws: { index: number; video: HTMLVideoElement }[] = []
		const pushImage = (b: Box, opacity: number) => {
			this.imageData = ensure(this.imageData, (images + 1) * IMAGE_FLOATS)
			const o = images++ * IMAGE_FLOATS
			const d = this.imageData
			d[o] = b.x; d[o + 1] = b.y; d[o + 2] = b.w; d[o + 3] = b.h
			d[o + 4] = opacity; d[o + 5] = ITEM_RADIUS; d[o + 6] = 0; d[o + 7] = 0
			return images - 1
		}

		const overlays: (() => void)[] = []
		const pxRatio = camera.z * this.dpr

		for (const [id, d] of this.displayedItems) {
			if (!Box.intersects(d, cull)) continue
			const item = items[id]
			if (!item) continue

			const video = item.kind === 'video' ? this.videos.getReady(id) : undefined
			let texAlpha = 0
			if (video) {
				videoDraws.push({ index: pushImage(d, d.opacity), video })
				texAlpha = 1
			} else {
				const entry = this.pickTexture(item, Math.max(d.w, d.h) * pxRatio)
				if (entry) {
					texAlpha = Math.min(1, (now - entry.readyAt) / FADE_MS)
					if (texAlpha < 1) this.animating = true
					pushImage(d, d.opacity * texAlpha)
					imageDraws.push({ kind: 'image', bindGroup: entry.bindGroup! })
				}
			}
			if (texAlpha < 1) pushRect(d, withAlpha(PLACEHOLDER, d.opacity * (1 - texAlpha)), NONE, 0, ITEM_RADIUS, false)

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
			let imageIndex = 0
			pass.setPipeline(this.imagePipeline)
			pass.setVertexBuffer(0, this.imageBuffer)
			const videoIndexes = new Set(videoDraws.map((v) => v.index))
			for (let i = 0; i < images; i++) {
				if (videoIndexes.has(i)) continue
				pass.setBindGroup(1, imageDraws[imageIndex++].bindGroup)
				pass.draw(6, 1, 0, i)
			}
			if (videoDraws.length) {
				pass.setPipeline(this.videoPipeline)
				for (const { index, video } of videoDraws) {
					const bindGroup = this.device.createBindGroup({
						layout: this.videoLayout,
						entries: [{ binding: 0, resource: this.device.importExternalTexture({ source: video }) }],
					})
					pass.setBindGroup(1, bindGroup)
					pass.draw(6, 1, 0, index)
				}
			}
		}

		if (rects > backgroundRects) {
			pass.setPipeline(this.rectPipeline)
			pass.setVertexBuffer(0, this.rectBuffer)
			pass.draw(6, rects - backgroundRects, 0, backgroundRects)
		}

		pass.end()
		this.device.queue.submit([encoder.finish()])

		this.labels.update(layout.sections, this.displayedSections, editor)

		this.frameTimes.push(performance.now() - t0)
		if (this.frameTimes.length > 120) this.frameTimes.shift()
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
		for (const d of this.disposers.splice(0)) d()
		this.textures.destroy()
		this.videos.destroy()
		this.labels.destroy()
		this.device.destroy()
	}
}

/** Section titles as DOM text, positioned in screen space so they stay crisp and readable at any zoom. */
class SectionLabels {
	private els = new Map<string, HTMLDivElement>()
	private host: HTMLDivElement

	constructor(
		parent: HTMLElement,
		private onClose: (sectionId: string) => void,
	) {
		this.host = document.createElement('div')
		this.host.className = 'section-labels'
		parent.appendChild(this.host)
	}

	private createLabel(id: string) {
		const el = document.createElement('div')
		el.className = 'section-label'
		el.innerHTML = '<span class="title"></span><span class="count"></span><button class="close" title="Remove this session">×</button>'
		const button = el.querySelector('button')!
		let armTimer = 0
		const disarm = () => {
			clearTimeout(armTimer)
			button.classList.remove('armed')
			button.textContent = '×'
		}
		// Removal is permanent, so it takes two clicks: the first arms the button, the second removes.
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
			this.onClose(id)
		})
		button.addEventListener('pointerleave', disarm)
		return el
	}

	update(sections: { id: string; title: string; itemIds: string[] }[], displayed: Map<string, Displayed>, editor: Editor) {
		const seen = new Set<string>()
		const z = editor.camera.peek().z
		for (const s of sections) {
			const d = displayed.get(s.id)
			if (!d) continue
			seen.add(s.id)
			let el = this.els.get(s.id)
			if (!el) {
				el = this.createLabel(s.id)
				this.host.appendChild(el)
				this.els.set(s.id, el)
			}
			const title = el.children[0] as HTMLElement
			const count = el.children[1] as HTMLElement
			if (title.textContent !== s.title) title.textContent = s.title
			const countText = `${s.itemIds.length}`
			if (count.textContent !== countText) count.textContent = countText
			const p = editor.pageToScreen(d)
			const width = d.w * z
			el.style.transform = `translate(${p.x}px, ${p.y - 26}px)`
			el.style.width = `${width}px`
			el.style.opacity = width < 80 ? '0' : String(d.opacity)
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

function withAlpha([r, g, b, a]: RGBA, k: number): RGBA {
	return [r, g, b, a * k]
}
