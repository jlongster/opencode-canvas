import type { RGB } from './field'

/**
 * Dots for subagent visuals on a 2D canvas laid over the renderer's WebGPU canvas (and under the
 * DOM text): square dots of whole device pixels on a grid `pitch` CSS px apart, a constant size on
 * screen at any zoom, like the Ember busy band (same pitch, dot size and rasterization rule as the
 * dot shader: `side = floor(size + 0.5)` device px at `floor((pitch − side) / 2)` in its cell).
 *
 * A Region is a grid fitted into a CSS px rect: its origin snapped to device pixels, as many whole
 * cells as fit, centred. Painting addresses cells by (column, row).
 */
export class DotLayer {
	readonly canvas: HTMLCanvasElement
	private ctx: CanvasRenderingContext2D
	private dpr = 1
	private cssW = 0
	private cssH = 0
	/** device px */
	pd = 5
	private side = 2
	private off = 1
	private fill = ''
	private styles = new Map<string, string>()
	/** dots drawn since the last clear */
	count = 0

	constructor(parent: HTMLElement) {
		this.canvas = document.createElement('canvas')
		this.canvas.className = 'sa-dots'
		parent.appendChild(this.canvas)
		this.ctx = this.canvas.getContext('2d')!
	}

	/** CSS px per cell, as drawn (the pitch rounded to whole device pixels). */
	get pitch() {
		return this.pd / this.dpr
	}

	/** Sizes the canvas to the viewport and sets the grid; returns whether anything changed. */
	setup(cssW: number, cssH: number, dpr: number, pitch: number, dot: number) {
		const pd = Math.max(2, Math.round(pitch * dpr))
		const side = Math.max(1, Math.floor(dot * dpr + 0.5))
		const changed = cssW !== this.cssW || cssH !== this.cssH || dpr !== this.dpr || pd !== this.pd || side !== this.side
		if (!changed) return false
		this.cssW = cssW
		this.cssH = cssH
		this.dpr = dpr
		this.pd = pd
		this.side = side
		this.off = Math.floor((pd - side) / 2)
		const w = Math.max(1, Math.round(cssW * dpr))
		const h = Math.max(1, Math.round(cssH * dpr))
		if (this.canvas.width !== w || this.canvas.height !== h) {
			this.canvas.width = w
			this.canvas.height = h
		}
		this.canvas.style.width = `${cssW}px`
		this.canvas.style.height = `${cssH}px`
		return true
	}

	clear() {
		this.ctx.setTransform(1, 0, 0, 1, 0, 0)
		this.ctx.globalAlpha = 1
		this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
		this.count = 0
		this.fill = ''
	}

	/** A grid fitted into the CSS px rect (screen space): whole cells, centred, origin on a device pixel. */
	region(x: number, y: number, w: number, h: number, centre = true): Region {
		const pd = this.pd
		const dw = w * this.dpr
		const dh = h * this.dpr
		const cols = Math.max(0, Math.floor(dw / pd + 1e-6))
		const rows = Math.max(0, Math.floor(dh / pd + 1e-6))
		const ox = Math.round(x * this.dpr + (centre ? (dw - cols * pd) / 2 : 0))
		const oy = Math.round(y * this.dpr + (centre ? (dh - rows * pd) / 2 : 0))
		return new Region(this, ox, oy, cols, rows)
	}

	/** Whole cells in a CSS px length. */
	cells(len: number) {
		return Math.max(0, Math.floor((len * this.dpr) / this.pd + 1e-6))
	}

	/** @internal */
	dot(dx: number, dy: number, alpha: number, rgb: RGB) {
		if (alpha <= 0.004) return
		const a = alpha > 1 ? 1 : alpha
		const key = `${rgb[0] | 0},${rgb[1] | 0},${rgb[2] | 0}`
		if (key !== this.fill) {
			let style = this.styles.get(key)
			if (!style) this.styles.set(key, (style = `rgb(${key})`))
			this.ctx.fillStyle = style
			this.fill = key
		}
		this.ctx.globalAlpha = a
		this.ctx.fillRect(dx + this.off, dy + this.off, this.side, this.side)
		this.count++
	}

	/** Visible device-px bounds, for culling. */
	inView(ox: number, oy: number, w: number, h: number) {
		return ox + w >= 0 && oy + h >= 0 && ox <= this.canvas.width && oy <= this.canvas.height
	}
}

export class Region {
	constructor(
		private layer: DotLayer,
		/** device px */
		readonly ox: number,
		readonly oy: number,
		readonly cols: number,
		readonly rows: number,
	) {}

	get visible() {
		return this.cols > 0 && this.rows > 0 && this.layer.inView(this.ox, this.oy, this.cols * this.layer.pd, this.rows * this.layer.pd)
	}

	/** CSS px from the region's left (top) to the centre of a column (row). */
	cx(col: number) {
		return (col + 0.5) * this.layer.pitch
	}
	cy(row: number) {
		return (row + 0.5) * this.layer.pitch
	}

	set(col: number, row: number, alpha: number, rgb: RGB) {
		if (col < 0 || row < 0 || col >= this.cols || row >= this.rows) return
		const pd = this.layer.pd
		this.layer.dot(this.ox + col * pd, this.oy + row * pd, alpha, rgb)
	}
}
