import { EDGE_PRELUDE, type EdgeVariant } from './edges'
import { glslDefines } from './params'
import type { Box } from '../editor/geometry'

/** Matches the real renderer (Renderer.ts): frame radius, item radius, fills and the 1px frame stroke. */
export const FRAME_RADIUS = 20
const ITEM_RADIUS = 6
const FRAME_FILL = 0.035
const FRAME_STROKE = 0.06
const PLACEHOLDER = 0.06
/** Params that reach along or inside the edge rather than outward, so don't widen the quads. */
const INWARD = new Set(['spread', 'dash', 'depth', 'swell', 'length'])

export interface Camera {
	/** screen = page * z + (x, y), in CSS px */
	x: number
	y: number
	z: number
}

export interface FrameDraw {
	box: Box
	color: [number, number, number]
	/** 0..1, eased */
	work: number
	/** seconds since the done flash started, or -1 */
	done: number
	seed: number
}

export interface DrawInput {
	camera: Camera
	width: number
	height: number
	dpr: number
	frames: FrameDraw[]
	items: Box[]
	edge: EdgeVariant
	params: Float32Array
	time: number
	pageUnits: boolean
	reduced: boolean
	/** duration (s), distance (px), intensity, enabled */
	doneParams: [number, number, number, number]
	/** the variation's param values, to size the quads to how far its glows reach */
	values: Record<string, unknown>
}

/** How far outside a frame (CSS px, at screen-px widths) the effect and done flash can draw. */
function marginPx(input: DrawInput) {
	let m = 12
	for (const d of input.edge.params) {
		if (d.type !== 'range' || d.unit !== 'px' || INWARD.has(d.key)) continue
		m = Math.max(m, (input.values[d.key] as number) * (d.key === 'travel' ? 1.3 : 2.4))
	}
	if (input.edge.id === 'heartbeat') m += 3 * (input.values.ringW as number) * 3
	return 8 + Math.max(m, input.doneParams[3] ? input.doneParams[1] * 1.3 + 20 : 0)
}

const FRAME_VS = /* glsl */ `#version 300 es
in vec2 a_c;
uniform vec4 u_rect;
uniform vec4 u_cam;
uniform vec2 u_view;
uniform float u_margin;
out vec2 v_p;
void main() {
  vec2 page = u_rect.xy - u_margin + a_c * (u_rect.zw + 2.0 * u_margin);
  v_p = page - (u_rect.xy + 0.5 * u_rect.zw);
  vec2 n = (page * u_cam.z + u_cam.xy) / u_view * 2.0 - 1.0;
  gl_Position = vec4(n.x, -n.y, 0.0, 1.0);
}`

function frameFs(edge: EdgeVariant) {
	return /* glsl */ `#version 300 es
precision highp float;
in vec2 v_p;
out vec4 o;
uniform vec4 u_rect;
uniform vec4 u_cam;
uniform vec3 u_col;
uniform float u_work, u_done, u_seed, u_t, u_k, u_reduced, u_reach;
uniform vec4 u_doneP;
uniform float u_p[32];
${EDGE_PRELUDE}
${glslDefines(edge.params)}
${edge.glsl}

// Reduced motion: no movement, just a steady tinted outline.
vec4 still(Fx f) {
  float core = ring(f, 1.25 * f.k);
  float g = glowOut(f, f.dpx - 1.25 * f.k, 8.0 * f.k) * 0.12;
  return lit(f.col, core * 0.55 + g * (1.0 - core));
}

void main() {
  Fx f;
  f.b = 0.5 * u_rect.zw;
  f.r = min(${FRAME_RADIUS.toFixed(1)}, min(f.b.x, f.b.y));
  f.p = v_p;
  f.z = u_cam.z;
  f.aa = 1.0 / u_cam.w;
  f.k = u_k;
  f.d = sdRR(v_p, f.b, f.r);
  f.dpx = f.d * f.z;
  f.L = perimeter(f.b, f.r);
  f.t = u_t + u_seed * 11.0;
  f.work = u_work;
  f.col = u_col;
  f.seed = u_seed;

  // The frame as the app draws it: a faint fill and a 1px stroke outside the edge.
  float inner = clamp(0.5 - f.dpx / f.aa, 0.0, 1.0);
  float outer = clamp(0.5 - (f.dpx - 1.0) / f.aa, 0.0, 1.0);
  vec4 col = vec4(vec3(${FRAME_FILL}), ${FRAME_FILL}) * inner + vec4(vec3(${FRAME_STROKE}), ${FRAME_STROKE}) * (outer - inner);

  // Deep inside the frame no effect reaches, so skip the work there.
  bool near = f.dpx > -u_reach * f.k;
  if (near) {
    f.s = arcS(v_p, f.b, f.r);
    f.u = f.s / f.L;
  }
  if (u_work > 0.001 && near) {
    vec4 fx = (u_reduced > 0.5 ? still(f) : effect(f)) * u_work;
    col = fx + col * (1.0 - fx.a);
  }

  // Done: one gentle flash shared by every variation, a brightening outline and a ring easing outward.
  if (u_doneP.w > 0.5 && u_done >= 0.0 && u_done < u_doneP.x) {
    float pr = u_done / u_doneP.x;
    float r = u_doneP.y * f.k * (1.0 - pow(1.0 - pr, 3.0));
    float wave = !near || u_reduced > 0.5 ? 0.0 : gauss(f.dpx - r, (2.0 + 7.0 * pr) * f.k) * smoothstep(-1.0, 1.0, f.dpx) * pow(1.0 - pr, 2.0);
    float edge = !near ? 0.0 : ring(f, 1.5 * f.k) * pow(1.0 - pr, 1.6);
    float fill = inner * 0.045 * pow(1.0 - pr, 2.5);
    float rise = smoothstep(0.0, 0.06, pr);
    vec4 fl = lit(hi(f.col, 0.4), (wave * 0.8 + edge + fill) * u_doneP.z * rise);
    col = fl + col * (1.0 - fl.a);
  }
  o = col;
}`
}

const ITEM_VS = /* glsl */ `#version 300 es
in vec2 a_c;
in vec4 a_r;
uniform vec4 u_cam;
uniform vec2 u_view;
out vec2 v_p;
out vec2 v_b;
void main() {
  vec2 m = vec2(1.0 / u_cam.z);
  vec2 page = a_r.xy - m + a_c * (a_r.zw + 2.0 * m);
  v_p = (page - a_r.xy - 0.5 * a_r.zw) * u_cam.z;
  v_b = 0.5 * a_r.zw * u_cam.z;
  vec2 n = (page * u_cam.z + u_cam.xy) / u_view * 2.0 - 1.0;
  gl_Position = vec4(n.x, -n.y, 0.0, 1.0);
}`

const ITEM_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_p;
in vec2 v_b;
uniform vec4 u_cam;
out vec4 o;
void main() {
  float r = min(${ITEM_RADIUS.toFixed(1)} * u_cam.z, min(v_b.x, v_b.y));
  vec2 q = abs(v_p) - v_b + r;
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  float a = clamp(0.5 - d * u_cam.w, 0.0, 1.0) * ${PLACEHOLDER};
  o = vec4(vec3(a), a);
}`

interface FrameProgram {
	program: WebGLProgram
	u: Record<string, WebGLUniformLocation | null>
}

export class DemoGL {
	private gl: WebGL2RenderingContext
	private programs = new Map<string, FrameProgram>()
	private item: { program: WebGLProgram; cam: WebGLUniformLocation | null; view: WebGLUniformLocation | null }
	private quad: WebGLBuffer
	private instances: WebGLBuffer
	private frameVao: WebGLVertexArrayObject
	private itemVao: WebGLVertexArrayObject
	private instanceData = new Float32Array(0)

	constructor(private canvas: HTMLCanvasElement) {
		const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: true, alpha: false })
		if (!gl) throw new Error('WebGL2 is not available')
		this.gl = gl
		this.quad = gl.createBuffer()!
		gl.bindBuffer(gl.ARRAY_BUFFER, this.quad)
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW)
		this.instances = gl.createBuffer()!

		const itemProgram = link(gl, ITEM_VS, ITEM_FS)
		this.item = { program: itemProgram, cam: gl.getUniformLocation(itemProgram, 'u_cam'), view: gl.getUniformLocation(itemProgram, 'u_view') }

		this.frameVao = gl.createVertexArray()!
		gl.bindVertexArray(this.frameVao)
		gl.bindBuffer(gl.ARRAY_BUFFER, this.quad)
		gl.enableVertexAttribArray(0)
		gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

		this.itemVao = gl.createVertexArray()!
		gl.bindVertexArray(this.itemVao)
		const ac = gl.getAttribLocation(itemProgram, 'a_c')
		const ar = gl.getAttribLocation(itemProgram, 'a_r')
		gl.bindBuffer(gl.ARRAY_BUFFER, this.quad)
		gl.enableVertexAttribArray(ac)
		gl.vertexAttribPointer(ac, 2, gl.FLOAT, false, 0, 0)
		gl.bindBuffer(gl.ARRAY_BUFFER, this.instances)
		gl.enableVertexAttribArray(ar)
		gl.vertexAttribPointer(ar, 4, gl.FLOAT, false, 0, 0)
		gl.vertexAttribDivisor(ar, 1)
		gl.bindVertexArray(null)
	}

	/** Compiles a variation's program (once); throws with the compiler log if it doesn't. */
	prepare(edge: EdgeVariant): FrameProgram {
		let p = this.programs.get(edge.id)
		if (p) return p
		const gl = this.gl
		const program = link(gl, FRAME_VS, frameFs(edge), (prog) => gl.bindAttribLocation(prog, 0, 'a_c'))
		const names = ['u_rect', 'u_cam', 'u_view', 'u_margin', 'u_col', 'u_work', 'u_done', 'u_seed', 'u_t', 'u_k', 'u_reduced', 'u_reach', 'u_doneP', 'u_p']
		p = { program, u: Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(program, n)])) }
		this.programs.set(edge.id, p)
		return p
	}

	draw(input: DrawInput) {
		const { gl, canvas } = this
		const { camera, dpr } = input
		const w = Math.max(1, Math.round(input.width * dpr))
		const h = Math.max(1, Math.round(input.height * dpr))
		if (canvas.width !== w || canvas.height !== h) {
			canvas.width = w
			canvas.height = h
		}
		gl.viewport(0, 0, w, h)
		gl.clearColor(0.067, 0.067, 0.075, 1)
		gl.clear(gl.COLOR_BUFFER_BIT)
		gl.enable(gl.BLEND)
		gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)

		const cam = [camera.x, camera.y, camera.z, dpr] as const
		const k = input.pageUnits ? camera.z : 1
		const p = this.prepare(input.edge)
		gl.useProgram(p.program)
		gl.bindVertexArray(this.frameVao)
		gl.uniform4f(p.u.u_cam, ...cam)
		gl.uniform2f(p.u.u_view, input.width, input.height)
		const m = (marginPx(input) * k) / camera.z
		gl.uniform1f(p.u.u_margin, m)
		gl.uniform1f(p.u.u_t, input.time)
		gl.uniform1f(p.u.u_k, k)
		gl.uniform1f(p.u.u_reduced, input.reduced ? 1 : 0)
		gl.uniform1f(p.u.u_reach, input.edge.reach ?? 80)
		gl.uniform4f(p.u.u_doneP, ...input.doneParams)
		gl.uniform1fv(p.u.u_p, input.params)
		const view = { x: -camera.x / camera.z, y: -camera.y / camera.z, w: input.width / camera.z, h: input.height / camera.z }
		for (const f of input.frames) {
			const b = f.box
			if (b.x - m > view.x + view.w || b.x + b.w + m < view.x || b.y - m > view.y + view.h || b.y + b.h + m < view.y) continue
			gl.uniform4f(p.u.u_rect, b.x, b.y, b.w, b.h)
			gl.uniform3f(p.u.u_col, ...f.color)
			gl.uniform1f(p.u.u_work, f.work)
			gl.uniform1f(p.u.u_done, f.done)
			gl.uniform1f(p.u.u_seed, f.seed)
			gl.drawArrays(gl.TRIANGLES, 0, 6)
		}

		if (this.instanceData.length < input.items.length * 4) this.instanceData = new Float32Array(input.items.length * 4)
		input.items.forEach((b, i) => this.instanceData.set([b.x, b.y, b.w, b.h], i * 4))
		gl.useProgram(this.item.program)
		gl.bindVertexArray(this.itemVao)
		gl.bindBuffer(gl.ARRAY_BUFFER, this.instances)
		gl.bufferData(gl.ARRAY_BUFFER, this.instanceData.subarray(0, input.items.length * 4), gl.DYNAMIC_DRAW)
		gl.uniform4f(this.item.cam, ...cam)
		gl.uniform2f(this.item.view, input.width, input.height)
		gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, input.items.length)
		gl.bindVertexArray(null)
	}
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string, beforeLink?: (p: WebGLProgram) => void) {
	const program = gl.createProgram()!
	for (const [type, src] of [
		[gl.VERTEX_SHADER, vs],
		[gl.FRAGMENT_SHADER, fs],
	] as const) {
		const s = gl.createShader(type)!
		gl.shaderSource(s, src)
		gl.compileShader(s)
		if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
			const log = gl.getShaderInfoLog(s)
			const numbered = src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n')
			throw new Error(`shader compile failed: ${log}\n${numbered}`)
		}
		gl.attachShader(program, s)
	}
	beforeLink?.(program)
	gl.linkProgram(program)
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`link failed: ${gl.getProgramInfoLog(program)}`)
	return program
}
