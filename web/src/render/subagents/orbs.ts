/**
 * Subagent indicators drawn by fragment shaders on a WebGL2 canvas laid over the renderer's WebGPU
 * canvas (and under the DOM text). Everything is in device pixels of the screen, a constant size at
 * any zoom. It is drawn in the same animation frame as the renderer, after it, from the same camera,
 * so the two canvases always present together.
 *
 * Each orb is a few texels of a float texture (where it is, its colour, its state weights, its own
 * clock); each draw is a set of instanced quads, one per orb (or, for techniques that need all of a
 * row at once, one per row) looking up the orbs it covers. A technique supplies one GLSL function:
 *   vec4 shadeOrb(Orb o, vec2 px)                     one orb (quads per orb), or
 *   vec4 shadeRow(int start, int count, vec2 px)      a row of orbs (quads per row, `row: true`),
 * returning premultiplied linear colour; the prelude turns that into premultiplied sRGB, dithered.
 */

export interface OrbShader {
	/** program cache key */
	id: string
	glsl: string
	row: boolean
	/** prepended #defines (the technique's params as P_<key>) */
	defines: string
}

/** Floats per orb: 5 texels. */
export const ORB_FLOATS = 20
const INST_FLOATS = 8
const MAX_PARAMS = 16

/** One orb, device px and linear colour. */
export interface OrbData {
	x: number
	y: number
	/** radius */
	r: number
	seed: number
	rgb: readonly [number, number, number]
	alpha: number
	run: number
	done: number
	fail: number
	wait: number
	flash: number
	/** its own clock, s: runs while it works (speed-scaled), so it is still once done */
	t: number
	hover: number
	open: number
	breath: number
	/** 0..1, per orb, so orbs (and frames) run out of phase */
	phase: number
	/** technique-specific */
	aux: number
}

const VS = /* glsl */ `#version 300 es
layout(location = 0) in vec2 a_c;
layout(location = 1) in vec4 a_rect;
layout(location = 2) in vec4 a_info;
uniform vec2 u_view;
flat out ivec2 v_info;
void main() {
  vec2 p = a_rect.xy + a_c * a_rect.zw;
  vec2 n = p / u_view * 2.0 - 1.0;
  gl_Position = vec4(n.x, -n.y, 0.0, 1.0);
  v_info = ivec2(a_info.xy);
}`

/** Shared by every technique: the orb record, noise, colour and compositing helpers. */
export const PRELUDE = /* glsl */ `
precision highp float;
precision highp int;
uniform vec2 u_view;
uniform float u_dpr;
uniform float u_p[${MAX_PARAMS}];
uniform vec4 u_grid;
uniform float u_reduced;
uniform highp sampler2D u_orbs;
flat in ivec2 v_info;
out vec4 o_color;

const float PI = 3.14159265359;
const vec3 FAIL = vec3(0.863, 0.058, 0.058);

struct Orb {
  vec2 c; float r; float seed;
  vec3 col; float alpha;
  float run; float done; float fail; float wait;
  float flash; float t; float hover; float open;
  float breath; float phase; float aux;
};

Orb orb(int i) {
  vec4 a = texelFetch(u_orbs, ivec2(0, i), 0);
  vec4 b = texelFetch(u_orbs, ivec2(1, i), 0);
  vec4 c = texelFetch(u_orbs, ivec2(2, i), 0);
  vec4 d = texelFetch(u_orbs, ivec2(3, i), 0);
  vec4 e = texelFetch(u_orbs, ivec2(4, i), 0);
  return Orb(a.xy, a.z, a.w, b.rgb, b.a, c.x, c.y, c.z, c.w, d.x, d.y, d.z, d.w, e.x, e.y, e.z);
}

float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hash13(vec3 p3) { p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }

// 3D value noise in [0, 1] (the Ember band's kind of noise)
float vnoise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), f.x), mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), f.x), mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}

// 3D simplex noise in [-1, 1] (Ashima Arts / Stefan Gustavson, MIT)
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 10.0) * x); }
float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  vec3 ns = 0.142857142857 * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = 1.79284291400159 - 0.85373472095314 * vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.5 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 105.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

float fbm(vec3 p, int octaves) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) {
    if (i >= octaves) break;
    s += a * snoise(p);
    p = p * 2.03 + vec3(17.1, 3.7, 9.2);
    a *= 0.5;
  }
  return s;
}

// the curl of a scalar noise field: a divergence-free flow (smoke, ink)
vec2 curl(vec2 p, float t) {
  const float e = 0.08;
  float n1 = snoise(vec3(p.x, p.y + e, t)), n2 = snoise(vec3(p.x, p.y - e, t));
  float n3 = snoise(vec3(p.x + e, p.y, t)), n4 = snoise(vec3(p.x - e, p.y, t));
  return vec2(n1 - n2, n3 - n4) / (2.0 * e);
}

mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }

// coverage of a signed distance (device px) with a one-pixel edge
float cover(float d) { return clamp(0.5 - d, 0.0, 1.0); }

vec4 over(vec4 dst, vec4 src) { return src + dst * (1.0 - src.a); }

// premultiplied: a colour at an alpha
vec4 pm(vec3 c, float a) { return vec4(c * a, a); }

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// the orb's colour, going red as it fails
vec3 tint(Orb o) { return mix(o.col, FAIL, o.fail); }

// a soft, slightly lighter version of a colour (highlights), and a deeper one (shadows)
vec3 lift(vec3 c, float k) { return mix(c, vec3(1.0), k); }

// an expanded subagent: a thin ring round its orb, at radius r (device px)
vec4 openRing(Orb o, vec2 px, float r) {
  float d = abs(length(px - o.c) - r) - 0.5 * u_dpr;
  return pm(lift(tint(o), 0.35), cover(d) * 0.75 * o.open);
}

vec3 toSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }

vec4 finish(vec4 c) {
  float a = clamp(c.a, 0.0, 1.0);
  if (a < 0.002) discard;
  vec3 s = toSrgb(clamp(c.rgb / a, 0.0, 1.0));
  // triangular dither, fixed to the screen (it never changes from frame to frame)
  float n = (hash12(gl_FragCoord.xy) + hash12(gl_FragCoord.xy + 71.37) - 1.0) / 255.0;
  vec4 r = clamp(vec4(s * a, a) + n, 0.0, 1.0);
  return vec4(min(r.rgb, vec3(r.a)), r.a);
}
`

const MAIN_ORB = /* glsl */ `
void main() {
  vec2 px = vec2(gl_FragCoord.x, u_view.y - gl_FragCoord.y);
  vec4 c = vec4(0.0);
  for (int i = 0; i < v_info.y; i++) c = over(c, shadeOrb(orb(v_info.x + i), px));
  o_color = finish(c);
}`

const MAIN_ROW = /* glsl */ `
void main() {
  vec2 px = vec2(gl_FragCoord.x, u_view.y - gl_FragCoord.y);
  o_color = finish(shadeRow(v_info.x, v_info.y, px));
}`

interface Program {
	program: WebGLProgram
	u: Record<'view' | 'dpr' | 'p' | 'grid' | 'reduced' | 'orbs', WebGLUniformLocation | null>
}

export class OrbLayer {
	readonly canvas: HTMLCanvasElement
	private gl: WebGL2RenderingContext
	private programs = new Map<string, Program>()
	private vao: WebGLVertexArrayObject
	private instBuf: WebGLBuffer
	private tex: WebGLTexture
	private texRows = 0
	private orbData = new Float32Array(ORB_FLOATS * 64)
	private instData = new Float32Array(INST_FLOATS * 64)
	private params = new Float32Array(MAX_PARAMS)
	/** orbs and quads pushed since begin() */
	nOrbs = 0
	nInst = 0
	private blank = true
	/** the last compile error, if the current technique's shader failed */
	error: string | null = null

	constructor(parent: HTMLElement, before: Node | null = null) {
		this.canvas = document.createElement('canvas')
		this.canvas.className = 'sa-orb-layer'
		parent.insertBefore(this.canvas, before)
		const gl = this.canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false })
		if (!gl) throw new Error('WebGL2 is not available')
		this.gl = gl
		const quad = gl.createBuffer()!
		gl.bindBuffer(gl.ARRAY_BUFFER, quad)
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW)
		this.vao = gl.createVertexArray()!
		gl.bindVertexArray(this.vao)
		gl.enableVertexAttribArray(0)
		gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
		this.instBuf = gl.createBuffer()!
		gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf)
		for (const [loc, off] of [
			[1, 0],
			[2, 4],
		]) {
			gl.enableVertexAttribArray(loc)
			gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, INST_FLOATS * 4, off * 4)
			gl.vertexAttribDivisor(loc, 1)
		}
		gl.bindVertexArray(null)
		this.tex = gl.createTexture()!
		gl.bindTexture(gl.TEXTURE_2D, this.tex)
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
	}

	/** Matches the canvas to the renderer's: `w`×`h` device px shown at `cssW`×`cssH`. */
	resize(w: number, h: number, cssW: number, cssH: number) {
		if (this.canvas.width !== w || this.canvas.height !== h) {
			this.canvas.width = w
			this.canvas.height = h
			this.blank = false
		}
		const sw = `${cssW}px`
		const sh = `${cssH}px`
		if (this.canvas.style.width !== sw) this.canvas.style.width = sw
		if (this.canvas.style.height !== sh) this.canvas.style.height = sh
	}

	begin() {
		this.nOrbs = 0
		this.nInst = 0
	}

	/** Adds an orb; returns its index (for quads that cover several). */
	orb(o: OrbData) {
		if ((this.nOrbs + 1) * ORB_FLOATS > this.orbData.length) this.orbData = grow(this.orbData)
		const d = this.orbData
		const k = this.nOrbs * ORB_FLOATS
		d[k] = o.x
		d[k + 1] = o.y
		d[k + 2] = o.r
		d[k + 3] = o.seed
		d[k + 4] = o.rgb[0]
		d[k + 5] = o.rgb[1]
		d[k + 6] = o.rgb[2]
		d[k + 7] = o.alpha
		d[k + 8] = o.run
		d[k + 9] = o.done
		d[k + 10] = o.fail
		d[k + 11] = o.wait
		d[k + 12] = o.flash
		d[k + 13] = o.t
		d[k + 14] = o.hover
		d[k + 15] = o.open
		d[k + 16] = o.breath
		d[k + 17] = o.phase
		d[k + 18] = o.aux
		d[k + 19] = 0
		return this.nOrbs++
	}

	/** A quad (device px) covering orbs start … start + count − 1. */
	quad(x: number, y: number, w: number, h: number, start: number, count: number) {
		if (w <= 0 || h <= 0 || count <= 0) return
		if (x + w < 0 || y + h < 0 || x > this.canvas.width || y > this.canvas.height) return
		if ((this.nInst + 1) * INST_FLOATS > this.instData.length) this.instData = grow(this.instData)
		const d = this.instData
		const k = this.nInst++ * INST_FLOATS
		d[k] = x
		d[k + 1] = y
		d[k + 2] = w
		d[k + 3] = h
		d[k + 4] = start
		d[k + 5] = count
		d[k + 6] = 0
		d[k + 7] = 0
	}

	/** Draws what was pushed with `shader` (clearing first). Grid: the dot grid's origin, pitch and dot side, device px. */
	draw(shader: OrbShader, params: ArrayLike<number>, dpr: number, grid: readonly [number, number, number, number], reduced: boolean) {
		const gl = this.gl
		if (this.nInst === 0) {
			if (this.blank) return
			gl.viewport(0, 0, this.canvas.width, this.canvas.height)
			gl.clearColor(0, 0, 0, 0)
			gl.clear(gl.COLOR_BUFFER_BIT)
			this.blank = true
			return
		}
		const prog = this.program(shader)
		gl.viewport(0, 0, this.canvas.width, this.canvas.height)
		gl.clearColor(0, 0, 0, 0)
		gl.clear(gl.COLOR_BUFFER_BIT)
		this.blank = !prog
		if (!prog) return
		// orbs: a texture ORB_FLOATS / 4 texels wide, a row per orb
		gl.activeTexture(gl.TEXTURE0)
		gl.bindTexture(gl.TEXTURE_2D, this.tex)
		const rows = Math.max(1, this.nOrbs)
		if (rows > this.texRows) {
			this.texRows = Math.max(64, 1 << Math.ceil(Math.log2(rows)))
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, ORB_FLOATS / 4, this.texRows, 0, gl.RGBA, gl.FLOAT, null)
		}
		gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, ORB_FLOATS / 4, rows, gl.RGBA, gl.FLOAT, this.orbData.subarray(0, rows * ORB_FLOATS))
		gl.useProgram(prog.program)
		gl.uniform2f(prog.u.view, this.canvas.width, this.canvas.height)
		gl.uniform1f(prog.u.dpr, dpr)
		this.params.fill(0)
		for (let i = 0; i < Math.min(MAX_PARAMS, params.length); i++) this.params[i] = params[i]
		gl.uniform1fv(prog.u.p, this.params)
		gl.uniform4f(prog.u.grid, grid[0], grid[1], grid[2], grid[3])
		gl.uniform1f(prog.u.reduced, reduced ? 1 : 0)
		gl.uniform1i(prog.u.orbs, 0)
		gl.enable(gl.BLEND)
		gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
		gl.bindVertexArray(this.vao)
		gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf)
		gl.bufferData(gl.ARRAY_BUFFER, this.instData.subarray(0, this.nInst * INST_FLOATS), gl.DYNAMIC_DRAW)
		gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.nInst)
		gl.bindVertexArray(null)
	}

	private program(shader: OrbShader): Program | null {
		const cached = this.programs.get(shader.id)
		if (cached) return cached
		const gl = this.gl
		try {
			const fs = `#version 300 es\n${shader.defines}\n${PRELUDE}\n${shader.glsl}\n${shader.row ? MAIN_ROW : MAIN_ORB}`
			const program = link(gl, VS, fs)
			const u = (n: string) => gl.getUniformLocation(program, n)
			const p: Program = { program, u: { view: u('u_view'), dpr: u('u_dpr'), p: u('u_p'), grid: u('u_grid'), reduced: u('u_reduced'), orbs: u('u_orbs') } }
			this.programs.set(shader.id, p)
			this.error = null
			return p
		} catch (e) {
			this.error = String(e)
			console.error(e)
			return null
		}
	}

	destroy() {
		this.canvas.remove()
	}
}

function grow(a: Float32Array) {
	const b = new Float32Array(a.length * 2)
	b.set(a)
	return b
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string) {
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
