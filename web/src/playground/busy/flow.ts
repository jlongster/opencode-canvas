import { link, type View } from '../shared/gl'
import { glslDefines, type ParamDef } from '../shared/params'

export const MAX_FRAMES = 8

/** One frame's band: where it is (page units), its colour, time offset, presence and done fill. */
export interface FlowFrame {
	box: { x: number; y: number; w: number; h: number }
	/** sRGB 0..1 */
	color: [number, number, number]
	/** seconds added to its clock, so frames run out of phase */
	offset: number
	presence: number
	fill: number
}

/**
 * A smooth field flowing off every frame's edge, seen through a grid of dots.
 *
 * The field is a fragment-shader function of where a point sits relative to the nearest frame's
 * rounded outline (`Fx`: distance outside it, outward normal, arc length round it, all in CSS px).
 * The mask is a grid of cells in device pixels, anchored to the canvas (it moves with panning in
 * whole pixels and never swims), a constant CSS size at any zoom. Each dot samples the field once,
 * at its cell's centre, so every dot is one uniform, crisp shape: lit by brightness, sized
 * (halftone), or switched on against a Bayer threshold.
 */
export const FLOW_PRELUDE = /* glsl */ `
#define PI 3.14159265
#define TAU 6.28318531

struct Fx {
  vec2 P;      // CSS px from the frame's centre (y down)
  vec2 n;      // outward normal
  float d;     // CSS px outside the edge (0 at the edge)
  float s;     // CSS px round the outline from the top centre, clockwise
  float L;     // perimeter, CSS px
  float t;     // seconds (speed-scaled, offset per frame)
  float seed;  // per frame
  float fall;  // 1 at the edge, 0 at the band's outer side (falloff curve applied)
  float depth; // band depth, CSS px
};

float h31(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.x + p.y) * p.z);
}
float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(h31(i), h31(i + vec3(1, 0, 0)), f.x), mix(h31(i + vec3(0, 1, 0)), h31(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(h31(i + vec3(0, 0, 1)), h31(i + vec3(1, 0, 1)), f.x), mix(h31(i + vec3(0, 1, 1)), h31(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
float fbm(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + vec3(7.1, 3.7, 1.3); a *= 0.5; }
  return s / 0.9375;
}
// The plane round the frame, flowing outward: points are sampled further in as time passes, so
// features drift away from the edge on every side and round every corner, seamlessly.
vec3 outward(Fx f, float scale, float drift, float churn) {
  return vec3((f.P - f.n * f.t * drift) / scale, f.t * churn) + f.seed * vec3(17.13, 31.7, 5.31);
}
// Round the loop: arc length mapped onto a circle (so it wraps), plus a coordinate away from the edge.
vec3 around(Fx f, float scale, float along, float away) {
  float R = f.L / (TAU * scale);
  float a = (f.s - f.t * along) / f.L * TAU;
  return vec3(cos(a) * R, sin(a) * R, away) + f.seed * vec3(11.7, 5.3, 2.9);
}
vec3 hueRotate(vec3 c, float a) {
  const mat3 toYIQ = mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312);
  const mat3 toRGB = mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703);
  vec3 y = toYIQ * c;
  float h = atan(y.z, y.y) + a;
  float ch = length(y.yz);
  return clamp(toRGB * vec3(y.x, ch * cos(h), ch * sin(h)), 0.0, 1.0);
}
`

const VS = /* glsl */ `#version 300 es
layout(location = 0) in vec2 a_c;
void main() { gl_Position = vec4(a_c * 2.0 - 1.0, 0.0, 1.0); }`

/**
 * Pass 1 (per variation): one texel per grid cell. Each texel evaluates the field at its cell's
 * centre: rgb = colour, a = 0.02 + 0.98·value inside a band (0 outside every band).
 */
function fieldFragment(params: ParamDef[], body: string) {
	const tint = /vec3\s+tint\s*\(/.test(body) ? '' : 'vec3 tint(Fx f, vec3 col, float v) { return col; }'
	return /* glsl */ `#version 300 es
precision highp float;
uniform vec4 u_cam;   // x, y (CSS px), zoom, dpr
uniform vec2 u_cell0; // grid cell of texel (0, 0)
uniform float u_t;
uniform int u_n;
uniform vec4 u_rect[${MAX_FRAMES}];
uniform vec4 u_fr[${MAX_FRAMES}]; // time offset, presence, fill, seed
uniform vec3 u_col[${MAX_FRAMES}];
uniform float u_p[32];
out vec4 o;
${FLOW_PRELUDE}
${glslDefines(params)}
${body}
${tint}

float sdRR(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

void main() {
  float dpr = u_cam.w;
  float z = u_cam.z;
  float pd = max(2.0, floor(P_pitch * dpr + 0.5));
  vec2 org = floor(u_cam.xy * dpr + 0.5);
  vec2 cell = u_cell0 + floor(gl_FragCoord.xy);
  vec2 centre = (org + cell * pd + 0.5 * pd) / dpr;
  vec2 page = (centre - u_cam.xy) / z;

  float best = 0.0;
  float inBand = 0.0;
  vec3 col = vec3(0.0);
  for (int i = 0; i < ${MAX_FRAMES}; i++) {
    if (i >= u_n) break;
    vec4 fr = u_fr[i];
    if (fr.y <= 0.001) continue;
    vec2 b = 0.5 * u_rect[i].zw;
    vec2 p = page - u_rect[i].xy - b;
    float r = min(20.0, min(b.x, b.y));
    float d = sdRR(p, b, r) * z - 1.0;
    if (d < 0.0 || d > P_depth) continue;
    Fx f;
    f.P = p * z;
    vec2 q = b - r;
    vec2 dv = p - clamp(p, -q, q);
    f.n = normalize(dv);
    float hp = 0.5 * PI * r;
    float Lp = 4.0 * (q.x + q.y) + TAU * r;
    float s;
    if (dv.x == 0.0) s = p.y < 0.0 ? (p.x >= 0.0 ? p.x : Lp + p.x) : q.x + 2.0 * hp + 2.0 * q.y + (q.x - p.x);
    else if (dv.y == 0.0) s = p.x > 0.0 ? q.x + hp + (p.y + q.y) : 3.0 * q.x + 2.0 * q.y + 3.0 * hp + (q.y - p.y);
    else {
      float a = atan(dv.y, dv.x);
      if (dv.x > 0.0 && dv.y < 0.0) s = q.x + r * (a + 0.5 * PI);
      else if (dv.x > 0.0) s = q.x + hp + 2.0 * q.y + r * a;
      else if (dv.y > 0.0) s = 3.0 * q.x + 2.0 * q.y + 2.0 * hp + r * (a - 0.5 * PI);
      else s = 3.0 * q.x + 4.0 * q.y + 3.0 * hp + r * (a + PI);
    }
    f.s = s * z;
    f.L = Lp * z;
    f.d = d;
    f.t = u_t + fr.x;
    f.seed = fr.w;
    f.depth = P_depth;
    f.fall = pow(clamp(1.0 - d / P_depth, 0.0, 1.0), P_falloff);
    float v = clamp(field(f) * P_intensity, 0.0, 1.0);
    // The row of dots on the edge always glows a little.
    v = max(v, P_rim * step(d, P_pitch) * f.fall);
    // Done: the flow gives way to a bright rim that falls off outward, then fades.
    v = max(v * (1.0 - fr.z), fr.z * f.fall * f.fall * f.fall) * fr.y;
    if (inBand == 0.0) col = u_col[i];
    inBand = max(inBand, fr.y);
    if (v > best) { best = v; col = tint(f, u_col[i], v); }
  }
  o = inBand > 0.0 ? vec4(col, 0.02 + 0.98 * best) : vec4(0.0);
}`
}

/** Pass 2 (shared): the dot grid, each dot lit by its cell's texel. */
const MASK_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_field;
uniform vec4 u_cam;
uniform vec2 u_view;
uniform vec2 u_cell0;
uniform float u_t;
// pitch, dot, shape (0 round, 1 square), mode (0 brightness, 1 halftone, 2 dither)
uniform vec4 u_m0;
// levels, unlit dots, peak, modulation
uniform vec4 u_m1;
out vec4 o;

float h31(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.x + p.y) * p.z);
}
float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(h31(i), h31(i + vec3(1, 0, 0)), f.x), mix(h31(i + vec3(0, 1, 0)), h31(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(h31(i + vec3(0, 0, 1)), h31(i + vec3(1, 0, 1)), f.x), mix(h31(i + vec3(0, 1, 1)), h31(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
float bayer4(vec2 c) {
  vec2 m = mod(c, 4.0);
  int i = int(m.x) + int(m.y) * 4;
  int b[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  return (float(b[i]) + 0.5) / 16.0;
}

void main() {
  float dpr = u_cam.w;
  vec2 dev = vec2(gl_FragCoord.x, u_view.y * dpr - gl_FragCoord.y);
  float pd = max(2.0, floor(u_m0.x * dpr + 0.5));
  vec2 org = floor(u_cam.xy * dpr + 0.5);
  vec2 rel = floor(dev) - org;
  vec2 cell = floor(rel / pd);
  vec2 pix = rel - cell * pd;
  vec4 texel = texelFetch(u_field, ivec2(cell - u_cell0), 0);
  if (texel.a < 0.01) discard;
  float best = (texel.a - 0.02) / 0.98;

  float size = 1.0;
  if (u_m1.w > 0.0) size = mix(1.0, smoothstep(0.25, 0.75, vnoise(vec3(cell * 0.09, u_t * 0.15))), u_m1.w);
  float alpha;
  float grow = size;
  int mode = int(u_m0.w + 0.5);
  if (mode == 0) alpha = u_m1.x > 0.5 ? floor(best * u_m1.x + 0.5) / u_m1.x : best;
  else if (mode == 1) { alpha = best > 0.004 ? 1.0 : 0.0; grow *= sqrt(best); }
  else alpha = best > bayer4(cell) ? 1.0 : 0.0;

  // Square dots cover whole device pixels; round ones are antialiased over one pixel.
  float dotPx = u_m0.y * dpr;
  float cover;
  float baseCover;
  if (u_m0.z < 0.5) {
    float dist = length(pix + 0.5 - 0.5 * pd);
    cover = clamp(0.5 * dotPx * grow - dist + 0.5, 0.0, 1.0);
    baseCover = clamp(0.5 * dotPx - dist + 0.5, 0.0, 1.0);
  } else {
    float side = floor(dotPx * grow + 0.5);
    float start = floor(0.5 * (pd - side));
    cover = side >= 1.0 && all(greaterThanEqual(pix, vec2(start))) && all(lessThan(pix, vec2(start + side))) ? 1.0 : 0.0;
    float bside = floor(dotPx + 0.5);
    float bstart = floor(0.5 * (pd - bside));
    baseCover = all(greaterThanEqual(pix, vec2(bstart))) && all(lessThan(pix, vec2(bstart + bside))) ? 1.0 : 0.0;
  }
  float a = max(alpha * u_m1.z * cover, u_m1.y * baseCover);
  if (a <= 0.002) discard;
  o = vec4(texel.rgb * a, a);
}`

export class FlowPass {
	private programs = new Map<string, { program: WebGLProgram; u: Record<string, WebGLUniformLocation | null> }>()
	private mask: { program: WebGLProgram; u: Record<string, WebGLUniformLocation | null> }
	private fbo: WebGLFramebuffer
	private tex: WebGLTexture
	private tw = 0
	private th = 0
	private rects = new Float32Array(MAX_FRAMES * 4)
	private fr = new Float32Array(MAX_FRAMES * 4)
	private cols = new Float32Array(MAX_FRAMES * 3)

	constructor(
		private gl: WebGL2RenderingContext,
		private quadVao: WebGLVertexArrayObject,
	) {
		const program = link(gl, VS, MASK_FS)
		this.mask = { program, u: Object.fromEntries(['u_field', 'u_cam', 'u_view', 'u_cell0', 'u_t', 'u_m0', 'u_m1'].map((n) => [n, gl.getUniformLocation(program, n)])) }
		this.fbo = gl.createFramebuffer()!
		this.tex = gl.createTexture()!
	}

	private program(id: string, params: ParamDef[], body: string) {
		let p = this.programs.get(id)
		if (!p) {
			const program = link(this.gl, VS, fieldFragment(params, body))
			const names = ['u_cam', 'u_cell0', 'u_t', 'u_n', 'u_rect', 'u_fr', 'u_col', 'u_p']
			p = { program, u: Object.fromEntries(names.map((n) => [n, this.gl.getUniformLocation(program, n)])) }
			this.programs.set(id, p)
		}
		return p
	}

	/** `mask`: pitch, dot, shape index, mode index, levels, unlit dots, peak, modulation. */
	draw(view: View, id: string, params: ParamDef[], body: string, packed: Float32Array, mask: number[], time: number, frames: FlowFrame[]) {
		const { gl } = this
		const dpr = view.dpr
		const pd = Math.max(2, Math.round(mask[0] * dpr))
		const ox = Math.round(view.camera.x * dpr)
		const oy = Math.round(view.camera.y * dpr)
		const cell0 = [Math.floor(-ox / pd), Math.floor(-oy / pd)]
		const tw = Math.ceil((view.width * dpr) / pd) + 2
		const th = Math.ceil((view.height * dpr) / pd) + 2
		if (tw !== this.tw || th !== this.th) {
			this.tw = tw
			this.th = th
			gl.bindTexture(gl.TEXTURE_2D, this.tex)
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, tw, th, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
			gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo)
			gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0)
			gl.bindFramebuffer(gl.FRAMEBUFFER, null)
			gl.bindTexture(gl.TEXTURE_2D, null)
		}

		// Pass 1: the field, one texel per cell.
		const { program, u } = this.program(id, params, body)
		const list = frames.slice(0, MAX_FRAMES)
		list.forEach((f, i) => {
			this.rects.set([f.box.x, f.box.y, f.box.w, f.box.h], i * 4)
			this.fr.set([f.offset, f.presence, f.fill, i + 1], i * 4)
			this.cols.set(f.color, i * 3)
		})
		const prevViewport = gl.getParameter(gl.VIEWPORT) as Int32Array
		const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null
		gl.activeTexture(gl.TEXTURE0)
		gl.bindTexture(gl.TEXTURE_2D, null)
		gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo)
		gl.viewport(0, 0, tw, th)
		gl.disable(gl.BLEND)
		gl.useProgram(program)
		gl.uniform4f(u.u_cam, view.camera.x, view.camera.y, view.camera.z, dpr)
		gl.uniform2f(u.u_cell0, cell0[0], cell0[1])
		gl.uniform1f(u.u_t, time)
		gl.uniform1i(u.u_n, list.length)
		gl.uniform4fv(u.u_rect, this.rects)
		gl.uniform4fv(u.u_fr, this.fr)
		gl.uniform3fv(u.u_col, this.cols)
		gl.uniform1fv(u.u_p, packed)
		gl.bindVertexArray(this.quadVao)
		gl.drawArrays(gl.TRIANGLES, 0, 6)

		// Pass 2: the dots.
		gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo)
		gl.viewport(prevViewport[0], prevViewport[1], prevViewport[2], prevViewport[3])
		gl.enable(gl.BLEND)
		gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
		const m = this.mask
		gl.useProgram(m.program)
		gl.activeTexture(gl.TEXTURE0)
		gl.bindTexture(gl.TEXTURE_2D, this.tex)
		gl.uniform1i(m.u.u_field, 0)
		gl.uniform4f(m.u.u_cam, view.camera.x, view.camera.y, view.camera.z, dpr)
		gl.uniform2f(m.u.u_view, view.width, view.height)
		gl.uniform2f(m.u.u_cell0, cell0[0], cell0[1])
		gl.uniform1f(m.u.u_t, time)
		gl.uniform4f(m.u.u_m0, mask[0], mask[1], mask[2], mask[3])
		gl.uniform4f(m.u.u_m1, mask[4], mask[5], mask[6], mask[7])
		gl.drawArrays(gl.TRIANGLES, 0, 6)
		gl.bindTexture(gl.TEXTURE_2D, null)
		gl.bindVertexArray(null)
	}
}
