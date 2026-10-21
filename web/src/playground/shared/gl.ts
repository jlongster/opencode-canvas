import type { Box } from '../../editor/geometry'

/** Matches the real renderer (Renderer.ts): frame radius, item radius, frame fill and its 1px stroke. */
export const FRAME_RADIUS = 20
const ITEM_RADIUS = 6
export const BG: [number, number, number] = [0.067, 0.067, 0.075]
export const FRAME_FILL = 0.035
const FRAME_STROKE = 0.06
/** Items stand in for images, which are opaque: the frame's colour plus the app's 6% placeholder. */
const ITEM = BG.map((c) => c + (1 - c) * FRAME_FILL).map((c) => c + (1 - c) * 0.06)

export interface Camera {
	/** screen = page * z + (x, y), in CSS px */
	x: number
	y: number
	z: number
}

export interface View {
	camera: Camera
	width: number
	height: number
	dpr: number
}

export interface FrameRect {
	box: Box
	/** premultiplied stroke override (e.g. a static "working" hairline), else the app's 6% white */
	stroke?: [number, number, number, number]
	strokeWidth?: number
}

const RECT_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec2 a_c;
layout(location = 1) in vec4 a_rect;
layout(location = 2) in vec4 a_fill;
layout(location = 3) in vec4 a_stroke;
layout(location = 4) in vec2 a_params; // stroke width (css px), radius (page)
uniform vec4 u_cam;
uniform vec2 u_view;
out vec2 v_p;
out vec2 v_b;
out vec4 v_fill;
out vec4 v_stroke;
out vec2 v_sr;
void main() {
  float m = (a_params.x + 2.0) / u_cam.z;
  vec2 page = a_rect.xy - m + a_c * (a_rect.zw + 2.0 * m);
  v_p = (page - a_rect.xy - 0.5 * a_rect.zw) * u_cam.z;
  v_b = 0.5 * a_rect.zw * u_cam.z;
  v_fill = a_fill;
  v_stroke = a_stroke;
  v_sr = vec2(a_params.x, min(a_params.y * u_cam.z, min(v_b.x, v_b.y)));
  vec2 n = (page * u_cam.z + u_cam.xy) / u_view * 2.0 - 1.0;
  gl_Position = vec4(n.x, -n.y, 0.0, 1.0);
}`

const RECT_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_p;
in vec2 v_b;
in vec4 v_fill;
in vec4 v_stroke;
in vec2 v_sr;
uniform vec4 u_cam;
out vec4 o;
void main() {
  vec2 q = abs(v_p) - v_b + v_sr.y;
  float d = (length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - v_sr.y) * u_cam.w;
  float inner = clamp(0.5 - d, 0.0, 1.0);
  float outer = clamp(0.5 - (d - v_sr.x * u_cam.w), 0.0, 1.0);
  o = v_fill * inner + v_stroke * (outer - inner);
}`

export class DemoGL {
	readonly gl: WebGL2RenderingContext
	private rectProgram: WebGLProgram
	private rectU: { cam: WebGLUniformLocation | null; view: WebGLUniformLocation | null }
	private rectVao: WebGLVertexArrayObject
	private rectBuf: WebGLBuffer
	readonly quadVao: WebGLVertexArrayObject
	private data = new Float32Array(0)

	constructor(private canvas: HTMLCanvasElement) {
		const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: true, alpha: false })
		if (!gl) throw new Error('WebGL2 is not available')
		this.gl = gl
		const quad = gl.createBuffer()!
		gl.bindBuffer(gl.ARRAY_BUFFER, quad)
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW)

		this.quadVao = gl.createVertexArray()!
		gl.bindVertexArray(this.quadVao)
		gl.enableVertexAttribArray(0)
		gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

		this.rectProgram = link(gl, RECT_VS, RECT_FS)
		this.rectU = { cam: gl.getUniformLocation(this.rectProgram, 'u_cam'), view: gl.getUniformLocation(this.rectProgram, 'u_view') }
		this.rectVao = gl.createVertexArray()!
		this.rectBuf = gl.createBuffer()!
		gl.bindVertexArray(this.rectVao)
		gl.enableVertexAttribArray(0)
		gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
		gl.bindBuffer(gl.ARRAY_BUFFER, this.rectBuf)
		const stride = 18 * 4
		const attrs: [number, number, number][] = [
			[1, 4, 0],
			[2, 4, 4],
			[3, 4, 8],
			[4, 2, 12],
		]
		for (const [loc, size, off] of attrs) {
			gl.enableVertexAttribArray(loc)
			gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, off * 4)
			gl.vertexAttribDivisor(loc, 1)
		}
		gl.bindVertexArray(null)
	}

	/** Clears, draws the frames as the app does, runs `between` (effects under the items), then the items. */
	draw(view: View, frames: FrameRect[], items: Box[], between?: () => void) {
		const { gl, canvas } = this
		const w = Math.max(1, Math.round(view.width * view.dpr))
		const h = Math.max(1, Math.round(view.height * view.dpr))
		if (canvas.width !== w || canvas.height !== h) {
			canvas.width = w
			canvas.height = h
		}
		gl.viewport(0, 0, w, h)
		gl.clearColor(BG[0], BG[1], BG[2], 1)
		gl.clear(gl.COLOR_BUFFER_BIT)
		gl.enable(gl.BLEND)

		const white = (a: number): [number, number, number, number] => [a, a, a, a]
		this.rects(
			view,
			frames.map((f) => ({ box: f.box, fill: white(FRAME_FILL), stroke: f.stroke ?? white(FRAME_STROKE), width: f.strokeWidth ?? 1, radius: FRAME_RADIUS })),
		)
		between?.()
		this.rects(
			view,
			items.map((b) => ({ box: b, fill: [ITEM[0], ITEM[1], ITEM[2], 1], stroke: [0, 0, 0, 0], width: 0, radius: ITEM_RADIUS })),
		)
	}

	private rects(view: View, list: { box: Box; fill: number[]; stroke: number[]; width: number; radius: number }[]) {
		const { gl } = this
		if (!list.length) return
		if (this.data.length < list.length * 18) this.data = new Float32Array(list.length * 18)
		list.forEach((r, i) => {
			this.data.set([r.box.x, r.box.y, r.box.w, r.box.h, ...r.fill, ...r.stroke, r.width, r.radius, 0, 0], i * 18)
		})
		gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
		gl.useProgram(this.rectProgram)
		gl.bindVertexArray(this.rectVao)
		gl.bindBuffer(gl.ARRAY_BUFFER, this.rectBuf)
		gl.bufferData(gl.ARRAY_BUFFER, this.data.subarray(0, list.length * 18), gl.DYNAMIC_DRAW)
		gl.uniform4f(this.rectU.cam, view.camera.x, view.camera.y, view.camera.z, view.dpr)
		gl.uniform2f(this.rectU.view, view.width, view.height)
		gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, list.length)
		gl.bindVertexArray(null)
	}
}

export function link(gl: WebGL2RenderingContext, vs: string, fs: string) {
	const program = gl.createProgram()!
	for (const [type, src] of [
		[gl.VERTEX_SHADER, vs],
		[gl.FRAGMENT_SHADER, fs],
	] as const) {
		const s = gl.createShader(type)!
		gl.shaderSource(s, src)
		gl.compileShader(s)
		if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
			const numbered = src
				.split('\n')
				.map((l, i) => `${i + 1}: ${l}`)
				.join('\n')
			throw new Error(`shader compile failed: ${gl.getShaderInfoLog(s)}\n${numbered}`)
		}
		gl.attachShader(program, s)
	}
	gl.linkProgram(program)
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`link failed: ${gl.getProgramInfoLog(program)}`)
	return program
}
