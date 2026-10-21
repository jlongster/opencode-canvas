import { BG, FRAME_FILL, FRAME_RADIUS, link, type View } from '../shared/gl'
import { glslDefines } from '../shared/params'
import type { Box } from '../../editor/geometry'
import { INWARD, LIGHT_PRELUDE, type BusyVariant } from './variants'

export interface LitFrame {
	box: Box
	/** session colour, sRGB 0..1 */
	color: [number, number, number]
	/** 0..1, eased */
	work: number
	/** seconds since the done flash started, or -1 */
	done: number
	/** time offset (s) so frames don't pulse in lockstep */
	offset: number
}

export interface LightInput {
	variant: BusyVariant
	values: Record<string, unknown>
	packed: Float32Array
	time: number
	pageUnits: boolean
	reduced: boolean
	/** duration (s), travel (px), intensity, enabled */
	done: [number, number, number, number]
}

const VS = /* glsl */ `#version 300 es
layout(location = 0) in vec2 a_c;
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

const f3 = (v: number[]) => `vec3(${v.map((c) => c.toFixed(5)).join(', ')})`
const FILL = BG.map((c) => c + (1 - c) * FRAME_FILL)

function fragment(v: BusyVariant) {
	return /* glsl */ `#version 300 es
precision highp float;
in vec2 v_p;
out vec4 o;
uniform vec4 u_rect;
uniform vec4 u_cam;
uniform vec3 u_col;
uniform float u_work, u_done, u_t, u_k, u_reduced;
uniform vec4 u_doneP;
uniform float u_p[32];
${LIGHT_PRELUDE}
${glslDefines(v.params)}
${v.glsl}

vec3 toLin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 toSrgb(vec3 c) { c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
float h12(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }

// Reduced motion: the same message without movement, a steady ring just off the edge.
vec3 still(Fx f) {
  float w = 1.5 * f.k;
  return f.col * 0.24 * lineAA(f.dpx - 3.0 * f.k - 0.5 * w, w, f.aa);
}

void main() {
  Fx f;
  f.b = 0.5 * u_rect.zw;
  f.r = min(${FRAME_RADIUS.toFixed(1)}, min(f.b.x, f.b.y));
  f.p = v_p;
  f.z = u_cam.z;
  f.aa = 1.0 / u_cam.w;
  f.k = u_k;
  f.t = u_t;
  f.col = toLin(u_col);
  f.dpx = sdRR(v_p, f.b, f.r) * f.z;
  // Most of a frame is far from its edge: nothing to light there.
  if (f.dpx < -360.0 * f.k) discard;
  float R = insetRadius(f.b, f.r, f.dpx / f.z);
  vec2 dv = edgeDir(v_p, f.b, R);
  f.n = dv;
  f.L = perimeter(f.b, f.r);
  f.s = arcS(v_p, f.b, R, dv, f.L);

  vec3 light = vec3(0.0);
  if (u_work > 0.001) light += (u_reduced > 0.5 ? still(f) : effect(f)) * u_work;

  // Done: one gentle flash shared by every variation.
  if (u_doneP.w > 0.5 && u_done >= 0.0 && u_done < u_doneP.x) {
    float pr = u_done / u_doneP.x;
    float e = 1.0 - pow(1.0 - pr, 3.0);
    float ring = u_reduced > 0.5 ? 0.0 : gauss(f.dpx - u_doneP.y * f.k * e, (2.0 + 6.0 * pr) * f.k) * smoothstep(-1.0, 1.0, f.dpx) * pow(1.0 - pr, 2.0);
    float edge = hair(f, 1.5 * f.k) * pow(1.0 - pr, 2.0);
    float fill = scatterIn(f, 60.0 * f.k) * 0.05 * pow(1.0 - pr, 3.0);
    light += mix(f.col, vec3(1.0), 0.35) * (edge + 0.55 * ring + fill) * u_doneP.z * smoothstep(0.0, 0.04, pr);
  }
  if (dot(light, vec3(1.0)) < 1e-6) discard;

  // Add the light to what the base pass drew here, in linear space, with a soft shoulder.
  float inside = clamp(0.5 - f.dpx / f.aa, 0.0, 1.0);
  vec3 base = mix(${f3(BG)}, ${f3(FILL)}, inside);
  vec3 lb = toLin(base);
  vec3 delta = toSrgb(1.0 - exp(-(lb + light))) - toSrgb(1.0 - exp(-lb));
  // Triangular dither of ±1 LSB, so faint gradients don't band.
  float n = h12(gl_FragCoord.xy) + h12(gl_FragCoord.xy + 17.31) - 1.0;
  o = vec4(max(delta + n / 255.0, 0.0), 0.0);
}`
}

interface Program {
	program: WebGLProgram
	u: Record<string, WebGLUniformLocation | null>
}

const UNIFORMS = ['u_rect', 'u_cam', 'u_view', 'u_margin', 'u_col', 'u_work', 'u_done', 'u_t', 'u_k', 'u_reduced', 'u_doneP', 'u_p']

export class LightPass {
	private programs = new Map<string, Program>()

	constructor(
		private gl: WebGL2RenderingContext,
		private quadVao: WebGLVertexArrayObject,
	) {}

	prepare(v: BusyVariant): Program {
		let p = this.programs.get(v.id)
		if (p) return p
		const program = link(this.gl, VS, fragment(v))
		p = { program, u: Object.fromEntries(UNIFORMS.map((n) => [n, this.gl.getUniformLocation(program, n)])) }
		this.programs.set(v.id, p)
		return p
	}

	/** How far outside a frame (CSS px at screen-px widths) light can reach. */
	private margin(input: LightInput) {
		let m = 16
		for (const d of input.variant.params) {
			if (d.type !== 'range' || d.unit !== 'px' || INWARD.has(d.key)) continue
			const v = input.values[d.key] as number
			m = Math.max(m, d.key === 'travel' ? v + 24 : d.key === 'offset' ? v + 24 : v * 3)
		}
		if (input.done[3]) m = Math.max(m, input.done[1] + 30)
		return m + 24
	}

	draw(view: View, frames: LitFrame[], input: LightInput) {
		const { gl } = this
		const p = this.prepare(input.variant)
		const { camera } = view
		const k = input.pageUnits ? camera.z : 1
		const m = (this.margin(input) * k) / camera.z
		gl.blendFunc(gl.ONE, gl.ONE)
		gl.useProgram(p.program)
		gl.bindVertexArray(this.quadVao)
		gl.uniform4f(p.u.u_cam, camera.x, camera.y, camera.z, view.dpr)
		gl.uniform2f(p.u.u_view, view.width, view.height)
		gl.uniform1f(p.u.u_margin, m)
		gl.uniform1f(p.u.u_k, k)
		gl.uniform1f(p.u.u_reduced, input.reduced ? 1 : 0)
		gl.uniform4f(p.u.u_doneP, ...input.done)
		gl.uniform1fv(p.u.u_p, input.packed)
		const vx = -camera.x / camera.z
		const vy = -camera.y / camera.z
		const vw = view.width / camera.z
		const vh = view.height / camera.z
		for (const f of frames) {
			if (f.work < 0.001 && f.done < 0) continue
			const b = f.box
			if (b.x - m > vx + vw || b.x + b.w + m < vx || b.y - m > vy + vh || b.y + b.h + m < vy) continue
			gl.uniform4f(p.u.u_rect, b.x, b.y, b.w, b.h)
			gl.uniform3f(p.u.u_col, ...f.color)
			gl.uniform1f(p.u.u_work, f.work)
			gl.uniform1f(p.u.u_done, f.done)
			gl.uniform1f(p.u.u_t, input.time + f.offset)
			gl.drawArrays(gl.TRIANGLES, 0, 6)
		}
		gl.bindVertexArray(null)
		gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
	}
}
