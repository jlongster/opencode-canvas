import { mipShader } from './shaders'
import { url as withBase } from '../base'

export interface TextureEntry {
	url: string
	state: 'queued' | 'loading' | 'ready' | 'error'
	texture?: GPUTexture
	bindGroup?: GPUBindGroup
	bytes: number
	lastUsedFrame: number
	readyAt: number
}

const MAX_CONCURRENT_LOADS = 6
const MAX_UPLOADS_PER_FRAME = 4
const UPLOAD_BUDGET_MS = 6
/** Phones and tablets get far less GPU memory before the browser kills the page. */
const IS_MOBILE = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
const MEMORY_BUDGET = (IS_MOBILE ? 256 : 768) * 1024 * 1024
const MAX_DIMENSION = IS_MOBILE ? 4096 : 8192
const FORMAT: GPUTextureFormat = 'rgba8unorm'

/**
 * Loads images into mipmapped GPU textures, on demand.
 *
 * Callers `request` what they want to draw each frame; decoding happens off the main thread
 * (createImageBitmap), uploads are spread over frames, and textures that haven't been used
 * recently are evicted once the memory budget is exceeded.
 */
export class TextureCache {
	private entries = new Map<string, TextureEntry>()
	private decoded: { entry: TextureEntry; bitmap: ImageBitmap }[] = []
	private loading = 0
	private bytes = 0
	private frame = 0
	private mipPipeline: GPURenderPipeline
	private mipSampler: GPUSampler
	private maxDim: number

	constructor(
		private device: GPUDevice,
		private layout: GPUBindGroupLayout,
	) {
		this.maxDim = Math.min(device.limits.maxTextureDimension2D, MAX_DIMENSION)
		const module = device.createShaderModule({ code: mipShader })
		this.mipPipeline = device.createRenderPipeline({
			layout: 'auto',
			vertex: { module, entryPoint: 'vs' },
			fragment: { module, entryPoint: 'fs', targets: [{ format: FORMAT }] },
			primitive: { topology: 'triangle-list' },
		})
		this.mipSampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' })
	}

	/** Returns the entry if it exists, and asks for it to be loaded if it doesn't. */
	request(url: string): TextureEntry {
		let entry = this.entries.get(url)
		if (!entry) {
			entry = { url, state: 'queued', bytes: 0, lastUsedFrame: this.frame, readyAt: 0 }
			this.entries.set(url, entry)
		}
		entry.lastUsedFrame = this.frame
		return entry
	}

	/** Returns the entry only if it's ready, without requesting it. */
	peek(url: string): TextureEntry | undefined {
		const entry = this.entries.get(url)
		if (entry?.state === 'ready') {
			entry.lastUsedFrame = this.frame
			return entry
		}
	}

	/** Starts loads, uploads decoded images, and evicts. Returns true if anything new became drawable. */
	update(): boolean {
		this.frame++
		this.startLoads()
		const uploaded = this.upload()
		this.evict()
		return uploaded
	}

	get pending() {
		return this.loading > 0 || this.decoded.length > 0
	}

	private startLoads() {
		if (this.loading >= MAX_CONCURRENT_LOADS) return
		// Most recently requested first: that's what's on screen right now.
		const queued = [...this.entries.values()]
			.filter((e) => e.state === 'queued')
			.sort((a, b) => b.lastUsedFrame - a.lastUsedFrame)
		for (const entry of queued) {
			if (this.frame - entry.lastUsedFrame > 2) {
				this.entries.delete(entry.url) // scrolled away before we got to it
				continue
			}
			if (this.loading >= MAX_CONCURRENT_LOADS) break
			this.load(entry)
		}
	}

	private async load(entry: TextureEntry) {
		entry.state = 'loading'
		this.loading++
		try {
			const res = await fetch(withBase(entry.url))
			if (!res.ok) throw new Error(`${res.status}`)
			const blob = await res.blob()
			let bitmap = await decode(blob, { premultiplyAlpha: 'premultiply', colorSpaceConversion: 'default' })
			if (bitmap.width > this.maxDim || bitmap.height > this.maxDim) {
				const s = this.maxDim / Math.max(bitmap.width, bitmap.height)
				const resized = await decode(bitmap, {
					resizeWidth: Math.floor(bitmap.width * s),
					resizeHeight: Math.floor(bitmap.height * s),
					resizeQuality: 'high',
					premultiplyAlpha: 'premultiply',
				})
				bitmap.close()
				bitmap = resized
			}
			if (this.entries.get(entry.url) !== entry) return bitmap.close()
			this.decoded.push({ entry, bitmap })
		} catch (e) {
			console.warn('texture load failed', entry.url, e)
			entry.state = 'error'
		} finally {
			this.loading--
		}
	}

	private upload(): boolean {
		const start = performance.now()
		let count = 0
		while (this.decoded.length && count < MAX_UPLOADS_PER_FRAME && performance.now() - start < UPLOAD_BUDGET_MS) {
			const { entry, bitmap } = this.decoded.shift()!
			if (this.entries.get(entry.url) !== entry) {
				bitmap.close()
				continue
			}
			const { width, height } = bitmap
			const mipLevelCount = Math.floor(Math.log2(Math.max(width, height))) + 1
			const texture = this.device.createTexture({
				size: { width, height },
				format: FORMAT,
				mipLevelCount,
				usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
			})
			try {
				this.device.queue.copyExternalImageToTexture({ source: bitmap }, { texture, premultipliedAlpha: true }, { width, height })
			} catch (e) {
				console.warn('texture upload failed', entry.url, e)
				texture.destroy()
				bitmap.close()
				entry.state = 'error'
				continue
			}
			bitmap.close()
			this.generateMips(texture, mipLevelCount)
			entry.texture = texture
			entry.bindGroup = this.device.createBindGroup({
				layout: this.layout,
				entries: [{ binding: 0, resource: texture.createView() }],
			})
			entry.bytes = Math.round(width * height * 4 * 1.34)
			entry.state = 'ready'
			entry.readyAt = performance.now()
			this.bytes += entry.bytes
			count++
		}
		return count > 0
	}

	private generateMips(texture: GPUTexture, levels: number) {
		if (levels < 2) return
		const encoder = this.device.createCommandEncoder()
		for (let level = 1; level < levels; level++) {
			const bindGroup = this.device.createBindGroup({
				layout: this.mipPipeline.getBindGroupLayout(0),
				entries: [
					{ binding: 0, resource: this.mipSampler },
					{ binding: 1, resource: texture.createView({ baseMipLevel: level - 1, mipLevelCount: 1 }) },
				],
			})
			const pass = encoder.beginRenderPass({
				colorAttachments: [
					{
						view: texture.createView({ baseMipLevel: level, mipLevelCount: 1 }),
						loadOp: 'clear',
						storeOp: 'store',
						clearValue: [0, 0, 0, 0],
					},
				],
			})
			pass.setPipeline(this.mipPipeline)
			pass.setBindGroup(0, bindGroup)
			pass.draw(3)
			pass.end()
		}
		this.device.queue.submit([encoder.finish()])
	}

	private evict() {
		if (this.bytes <= MEMORY_BUDGET) return
		const candidates = [...this.entries.values()]
			.filter((e) => e.state === 'ready' && e.lastUsedFrame < this.frame - 1)
			.sort((a, b) => a.lastUsedFrame - b.lastUsedFrame)
		for (const entry of candidates) {
			if (this.bytes <= MEMORY_BUDGET * 0.85) break
			entry.texture!.destroy()
			this.bytes -= entry.bytes
			this.entries.delete(entry.url)
		}
	}

	destroy() {
		for (const e of this.entries.values()) e.texture?.destroy()
		for (const d of this.decoded) d.bitmap.close()
		this.entries.clear()
		this.decoded = []
	}
}

/**
 * createImageBitmap with options, retrying with fewer of them: older engines reject options (or
 * option values) they don't support with a TypeError instead of ignoring them.
 */
async function decode(source: ImageBitmapSource, options: ImageBitmapOptions): Promise<ImageBitmap> {
	try {
		return await createImageBitmap(source, options)
	} catch (e) {
		if (!(e instanceof TypeError)) throw e
	}
	const { resizeWidth, resizeHeight } = options
	if (resizeWidth && resizeHeight) {
		try {
			return await createImageBitmap(source, { resizeWidth, resizeHeight })
		} catch (e) {
			if (!(e instanceof TypeError)) throw e
		}
		return downscale(source as ImageBitmap, resizeWidth, resizeHeight)
	}
	return createImageBitmap(source)
}

/** Resizing through a 2D canvas, for engines whose createImageBitmap can't resize. */
async function downscale(bitmap: ImageBitmap, w: number, h: number) {
	const canvas = document.createElement('canvas')
	canvas.width = w
	canvas.height = h
	const ctx = canvas.getContext('2d')!
	ctx.imageSmoothingQuality = 'high'
	ctx.drawImage(bitmap, 0, 0, w, h)
	return createImageBitmap(canvas)
}
