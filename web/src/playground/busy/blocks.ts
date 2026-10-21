import { link } from '../shared/gl'

/**
 * Solid axis-aligned rectangles in whole device pixels, drawn with one instanced call. Nothing is
 * antialiased or blurred: every block covers exact pixels, so it stays crisp at any zoom or DPR.
 */
const VS = /* glsl */ `#version 300 es
layout(location = 0) in vec2 a_c;
layout(location = 1) in vec4 a_rect;
layout(location = 2) in vec4 a_col;
uniform vec2 u_size;
out vec4 v_col;
void main() {
  vec2 p = a_rect.xy + a_c * a_rect.zw;
  vec2 n = p / u_size * 2.0 - 1.0;
  gl_Position = vec4(n.x, -n.y, 0.0, 1.0);
  v_col = a_col;
}`

const FS = /* glsl */ `#version 300 es
precision mediump float;
in vec4 v_col;
out vec4 o;
void main() { o = v_col; }`

const STRIDE = 8

export class BlockBatch {
	data = new Float32Array(STRIDE * 4096)
	n = 0

	begin() {
		this.n = 0
	}

	/** A block at whole device pixels, in premultiplied rgba. */
	add(x: number, y: number, w: number, h: number, r: number, g: number, b: number, a: number) {
		if (a <= 0.002 || w <= 0 || h <= 0) return
		if ((this.n + 1) * STRIDE > this.data.length) {
			const next = new Float32Array(this.data.length * 2)
			next.set(this.data)
			this.data = next
		}
		this.data.set([x, y, w, h, r * a, g * a, b * a, a], this.n * STRIDE)
		this.n++
	}
}

export class BlockPass {
	private program: WebGLProgram
	private uSize: WebGLUniformLocation | null
	private vao: WebGLVertexArrayObject
	private buf: WebGLBuffer

	constructor(private gl: WebGL2RenderingContext) {
		this.program = link(gl, VS, FS)
		this.uSize = gl.getUniformLocation(this.program, 'u_size')
		const quad = gl.createBuffer()!
		gl.bindBuffer(gl.ARRAY_BUFFER, quad)
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW)
		this.vao = gl.createVertexArray()!
		gl.bindVertexArray(this.vao)
		gl.enableVertexAttribArray(0)
		gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
		this.buf = gl.createBuffer()!
		gl.bindBuffer(gl.ARRAY_BUFFER, this.buf)
		gl.enableVertexAttribArray(1)
		gl.vertexAttribPointer(1, 4, gl.FLOAT, false, STRIDE * 4, 0)
		gl.vertexAttribDivisor(1, 1)
		gl.enableVertexAttribArray(2)
		gl.vertexAttribPointer(2, 4, gl.FLOAT, false, STRIDE * 4, 16)
		gl.vertexAttribDivisor(2, 1)
		gl.bindVertexArray(null)
	}

	draw(batch: BlockBatch) {
		const { gl } = this
		if (!batch.n) return
		gl.bindFramebuffer(gl.FRAMEBUFFER, null)
		gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)
		gl.enable(gl.BLEND)
		gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
		gl.useProgram(this.program)
		gl.uniform2f(this.uSize, gl.drawingBufferWidth, gl.drawingBufferHeight)
		gl.bindVertexArray(this.vao)
		gl.bindBuffer(gl.ARRAY_BUFFER, this.buf)
		gl.bufferData(gl.ARRAY_BUFFER, batch.data.subarray(0, batch.n * STRIDE), gl.DYNAMIC_DRAW)
		gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, batch.n)
		gl.bindVertexArray(null)
	}
}
