import { DOT_FLOATS, type EmberDots } from './ember'
import { link } from '../shared/gl'

/**
 * Draws the dots the Ember field fills in (see ember.ts): one instance per cell, its pitch × pitch
 * device pixels, each pixel lit by the larger of the lit and unlit dot's coverage.
 */
const VS = /* glsl */ `#version 300 es
layout(location = 0) in vec2 a_c;
layout(location = 1) in vec4 a_cell;
layout(location = 2) in vec4 a_size;
layout(location = 3) in vec4 a_col;
uniform vec2 u_size;
flat out vec4 v_cell;
flat out vec4 v_size;
flat out vec4 v_col;
void main() {
  vec2 p = a_cell.xy + a_c * a_cell.z;
  vec2 n = p / u_size * 2.0 - 1.0;
  gl_Position = vec4(n.x, -n.y, 0.0, 1.0);
  v_cell = a_cell;
  v_size = a_size;
  v_col = a_col;
}`

const FS = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 u_size;
flat in vec4 v_cell;
flat in vec4 v_size;
flat in vec4 v_col;
out vec4 o;
void main() {
  vec2 pix = floor(vec2(gl_FragCoord.x, u_size.y - gl_FragCoord.y)) - v_cell.xy;
  float pd = v_cell.z;
  float cover;
  float baseCover;
  if (v_cell.w > 0.5) {
    float dist = length(pix + 0.5 - 0.5 * pd);
    cover = clamp(0.5 * v_size.x - dist + 0.5, 0.0, 1.0);
    baseCover = clamp(0.5 * v_size.y - dist + 0.5, 0.0, 1.0);
  } else {
    float side = floor(v_size.x + 0.5);
    float start = floor(0.5 * (pd - side));
    cover = side >= 1.0 && all(greaterThanEqual(pix, vec2(start))) && all(lessThan(pix, vec2(start + side))) ? 1.0 : 0.0;
    float bside = floor(v_size.y + 0.5);
    float bstart = floor(0.5 * (pd - bside));
    baseCover = all(greaterThanEqual(pix, vec2(bstart))) && all(lessThan(pix, vec2(bstart + bside))) ? 1.0 : 0.0;
  }
  float a = max(v_size.z * cover, v_size.w * baseCover);
  if (a <= 0.002) discard;
  o = vec4(v_col.rgb * a, a);
}`

export class DotPass {
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
		for (let i = 0; i < 3; i++) {
			gl.enableVertexAttribArray(1 + i)
			gl.vertexAttribPointer(1 + i, 4, gl.FLOAT, false, DOT_FLOATS * 4, i * 16)
			gl.vertexAttribDivisor(1 + i, 1)
		}
		gl.bindVertexArray(null)
	}

	/** Into whatever is bound, which must be the drawing buffer's size. */
	draw(dots: EmberDots) {
		const { gl } = this
		if (!dots.n) return
		gl.enable(gl.BLEND)
		gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
		gl.useProgram(this.program)
		gl.uniform2f(this.uSize, gl.drawingBufferWidth, gl.drawingBufferHeight)
		gl.bindVertexArray(this.vao)
		gl.bindBuffer(gl.ARRAY_BUFFER, this.buf)
		gl.bufferData(gl.ARRAY_BUFFER, dots.data.subarray(0, dots.n * DOT_FLOATS), gl.DYNAMIC_DRAW)
		gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, dots.n)
		gl.bindVertexArray(null)
	}
}
