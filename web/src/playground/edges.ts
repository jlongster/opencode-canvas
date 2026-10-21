import { color, range, select, SPEED, toggle, type ParamDef } from './params'

/**
 * A "working" treatment for a session frame's edge: a GLSL `vec4 effect(Fx f)` (premultiplied
 * RGBA, composited over the frame) with its own parameters, named P_<key> in the body.
 *
 * Fx (see PRELUDE): p is the fragment in page units from the frame's centre, b its half size, r
 * the corner radius; d the rounded-rect SDF (page units, negative inside) and dpx the same in CSS
 * px; s the arc length around the outline from the top centre, clockwise (constant speed around
 * corners), L the perimeter and u = s / L. z is the zoom, k the width scale (1 for screen px,
 * z for page units: multiply px widths by it), t the speed-scaled time in seconds, aa one device
 * pixel in CSS px, col the session colour.
 */
export interface EdgeVariant {
	id: string
	name: string
	blurb: string
	params: ParamDef[]
	glsl: string
	/** how far inside the edge the effect can reach, in px (default 80): beyond it the shader skips the effect */
	reach?: number
}

const EASINGS = ['sine', 'smooth', 'inhale', 'expo']

export const EDGE_PRELUDE = /* glsl */ `
#define PI 3.14159265
#define TAU 6.28318531

struct Fx {
  vec2 p; vec2 b; float r;
  float d; float dpx;
  float s; float L; float u;
  float z; float k; float t; float aa;
  float work; vec3 col; float seed;
};

float sdRR(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

float perimeter(vec2 b, float r) { vec2 q = b - r; return 4.0 * (q.x + q.y) + TAU * r; }

// Arc length of the outline point nearest p, from the top centre, clockwise (y down).
float arcS(vec2 p, vec2 b, float r) {
  vec2 q = b - r;
  float hp = 0.5 * PI * r;
  float L = 4.0 * (q.x + q.y) + TAU * r;
  vec2 dv = p - clamp(p, -q, q);
  if (dv.x == 0.0 && dv.y == 0.0) {
    if (q.x - abs(p.x) < q.y - abs(p.y)) dv = vec2(p.x < 0.0 ? -1.0 : 1.0, 0.0);
    else dv = vec2(0.0, p.y < 0.0 ? -1.0 : 1.0);
  }
  if (dv.x == 0.0) {
    if (p.y < 0.0) return p.x >= 0.0 ? p.x : L + p.x;
    return q.x + 2.0 * hp + 2.0 * q.y + (q.x - p.x);
  }
  if (dv.y == 0.0) {
    if (p.x > 0.0) return q.x + hp + (p.y + q.y);
    return 3.0 * q.x + 2.0 * q.y + 3.0 * hp + (q.y - p.y);
  }
  float a = atan(dv.y, dv.x);
  if (dv.x > 0.0 && dv.y < 0.0) return q.x + r * (a + 0.5 * PI);
  if (dv.x > 0.0) return q.x + hp + 2.0 * q.y + r * a;
  if (dv.y > 0.0) return 3.0 * q.x + 2.0 * q.y + 2.0 * hp + r * (a - 0.5 * PI);
  return 3.0 * q.x + 4.0 * q.y + 3.0 * hp + r * (a + PI);
}

// Signed distance from b to a along a loop of length L, in (-L/2, L/2].
float cyc(float a, float b, float L) { return mod(a - b + 0.5 * L, L) - 0.5 * L; }

float gauss(float x, float s) { return exp(-x * x / (s * s + 1e-4)); }

// A line of width w centred on x = 0, antialiased over aa; lines thinner than a pixel fade instead.
float lineAA(float x, float w, float aa) {
  float ww = max(w, aa);
  return clamp((0.5 * ww - abs(x)) / aa + 0.5, 0.0, 1.0) * min(w / aa, 1.0);
}

// A ring of width w just outside the frame's edge, where the real frame's stroke sits.
float ring(Fx f, float w) { return lineAA(f.dpx - 0.5 * w, w, f.aa); }

// Light falling off outward from the edge (gaussian, radius r px).
float glowOut(Fx f, float x, float r) { return gauss(max(x, 0.0), r) * smoothstep(-1.5, 0.0, f.dpx); }

vec3 hi(vec3 c, float m) { return mix(c, vec3(1.0), m); }

vec2 circ(float u) { return vec2(cos(TAU * u), sin(TAU * u)); }

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
  for (int i = 0; i < 3; i++) { s += a * vnoise(p); p = p * 2.03 + 7.1; a *= 0.5; }
  return s / 0.875;
}

vec3 hueRot(vec3 c, float a) {
  mat3 toYiq = mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312);
  mat3 toRgb = mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703);
  vec3 y = toYiq * c;
  float h = atan(y.z, y.y) + a;
  y.yz = vec2(cos(h), sin(h)) * length(y.yz);
  return clamp(toRgb * y, 0.0, 1.0);
}

// 0 → 1 → 0 over ph in [0, 1): sine, smooth triangle, inhale (quick rise, long release), expo (mostly rest).
float breath(float ph, float mode) {
  if (mode < 0.5) return 0.5 - 0.5 * cos(TAU * ph);
  if (mode < 1.5) { float x = 1.0 - abs(2.0 * ph - 1.0); return x * x * (3.0 - 2.0 * x); }
  if (mode < 2.5) {
    if (ph < 0.3) { float s = sin(ph / 0.3 * 0.5 * PI); return s * s; }
    return 1.0 - smoothstep(0.0, 1.0, (ph - 0.3) / 0.7);
  }
  return pow(0.5 - 0.5 * cos(TAU * ph), 3.0);
}

vec4 lit(vec3 c, float a) { a = clamp(a, 0.0, 1.0); return vec4(c * a, a); }
`

export const EDGES: EdgeVariant[] = [
	{
		id: 'breathe',
		name: 'Breath',
		blurb: 'The outline takes the session colour and slowly breathes: opacity and width swell, with a faint halo at the peak.',
		params: [
			SPEED,
			range('period', 'Period', 3.6, 1, 10, 0.1, 's'),
			select('easing', 'Easing', EASINGS, 'inhale'),
			range('width', 'Width', 1.25, 0.5, 4, 0.05, 'px'),
			range('swell', 'Swell', 0.75, 0, 4, 0.05, 'px'),
			range('minA', 'Low', 0.16, 0, 1, 0.01),
			range('maxA', 'High', 0.7, 0, 1, 0.01),
			range('halo', 'Halo radius', 12, 0, 48, 0.5, 'px'),
			range('haloA', 'Halo', 0.2, 0, 1, 0.01),
			range('whiten', 'Whiten at peak', 0.2, 0, 1, 0.01),
		],
		glsl: /* glsl */ `
vec4 effect(Fx f) {
  float e = breath(fract(f.t / P_period), P_easing);
  float w = (P_width + P_swell * e) * f.k;
  float line = ring(f, w) * mix(P_minA, P_maxA, e);
  float halo = glowOut(f, f.dpx - w, P_halo * f.k * (0.6 + 0.4 * e)) * P_haloA * e;
  return lit(hi(f.col, P_whiten * e), line + halo * (1.0 - line));
}`,
	},
	{
		id: 'orbit',
		name: 'Travelling light',
		blurb: 'One soft highlight orbits the outline at constant speed (arc-length parameterised, so it never rushes the corners).',
		params: [
			SPEED,
			range('period', 'Lap time', 4.5, 1, 16, 0.1, 's'),
			range('length', 'Tail length', 0.22, 0.03, 0.7, 0.01, '× perimeter'),
			range('falloff', 'Tail falloff', 1.6, 0.4, 5, 0.05),
			range('width', 'Width', 1.5, 0.5, 4, 0.05, 'px'),
			range('glow', 'Glow radius', 10, 0, 40, 0.5, 'px'),
			range('glowA', 'Glow', 0.35, 0, 1, 0.01),
			range('intensity', 'Intensity', 0.9, 0, 1, 0.01),
			range('base', 'Resting ring', 0.1, 0, 0.6, 0.01),
			range('whiten', 'Hot head', 0.35, 0, 1, 0.01),
			toggle('clockwise', 'Clockwise', true),
		],
		glsl: /* glsl */ `
vec4 effect(Fx f) {
  float dir = P_clockwise > 0.5 ? 1.0 : -1.0;
  float head = fract(f.t / P_period) * f.L;
  float ds = cyc(f.s, head, f.L) * dir;
  float behind = clamp(-ds / (P_length * f.L), 0.0, 1.0);
  float tail = ds <= 0.0 ? pow(1.0 - behind, P_falloff) : gauss(ds * f.z, 5.0 * f.k);
  float w = P_width * f.k;
  float core = ring(f, w);
  float glow = gauss(f.dpx - 0.5 * w, P_glow * f.k) * P_glowA;
  float a = tail * (core + glow * (1.0 - core)) * P_intensity + core * P_base * (1.0 - tail);
  return lit(mix(f.col, hi(f.col, P_whiten), tail * tail), a);
}`,
	},
	{
		id: 'comets',
		name: 'Twin comets',
		blurb: 'Two short comets run in opposite directions and meet at the top and bottom centre, where they bloom briefly.',
		params: [
			SPEED,
			range('period', 'Lap time', 6, 1, 16, 0.1, 's'),
			range('length', 'Tail length', 0.12, 0.02, 0.4, 0.01, '× perimeter'),
			range('width', 'Width', 1.25, 0.5, 4, 0.05, 'px'),
			range('glow', 'Glow radius', 8, 0, 40, 0.5, 'px'),
			range('glowA', 'Glow', 0.3, 0, 1, 0.01),
			range('intensity', 'Intensity', 0.85, 0, 1, 0.01),
			range('bloom', 'Meeting bloom', 0.55, 0, 1, 0.01),
			range('whiten', 'Hot heads', 0.3, 0, 1, 0.01),
		],
		glsl: /* glsl */ `
float comet(Fx f, float head, float dir, float len) {
  float ds = cyc(f.s, head, f.L) * dir;
  float behind = clamp(-ds / len, 0.0, 1.0);
  return ds <= 0.0 ? pow(1.0 - behind, 1.8) : gauss(ds * f.z, 4.0 * f.k);
}
vec4 effect(Fx f) {
  float u = fract(f.t / P_period);
  float h1 = u * f.L;
  float h2 = f.L - h1;
  float len = P_length * f.L;
  float tail = max(comet(f, h1, 1.0, len), comet(f, h2, -1.0, len));
  float w = P_width * f.k;
  float core = ring(f, w);
  float glow = gauss(f.dpx - 0.5 * w, P_glow * f.k) * P_glowA;
  float meetAt = abs(cyc(h1, 0.0, f.L)) < f.L * 0.25 ? 0.0 : 0.5 * f.L;
  float meet = gauss(abs(cyc(h1, h2, f.L)) * f.z, 90.0 * f.k);
  float bloom = meet * gauss(cyc(f.s, meetAt, f.L) * f.z, 46.0 * f.k) * gauss(f.dpx, 16.0 * f.k) * P_bloom;
  float a = tail * (core + glow * (1.0 - core)) * P_intensity + bloom * 0.6;
  return lit(mix(f.col, hi(f.col, P_whiten), max(tail * tail, meet)), a);
}`,
	},
	{
		id: 'tide',
		name: 'Inner tide',
		reach: 400,
		blurb: 'A soft light rises inward from the edges and recedes, uneven like water, with the outline tinted in time.',
		params: [
			SPEED,
			range('period', 'Period', 4.2, 1, 10, 0.1, 's'),
			select('easing', 'Easing', EASINGS, 'sine'),
			range('depth', 'Depth', 24, 4, 90, 1, 'px'),
			range('swell', 'Swell', 16, 0, 60, 1, 'px'),
			range('intensity', 'Intensity', 0.24, 0, 0.6, 0.005),
			range('edge', 'Outline', 0.32, 0, 1, 0.01),
			range('uneven', 'Unevenness', 0.4, 0, 1, 0.01),
			range('scale', 'Noise scale', 2.2, 0.3, 8, 0.1),
		],
		glsl: /* glsl */ `
vec4 effect(Fx f) {
  float e = breath(fract(f.t / P_period), P_easing);
  float n = vnoise(vec3(circ(f.u) * P_scale, f.t * 0.15 + f.seed * 9.0));
  float depth = (P_depth + P_swell * e) * f.k * (1.0 + P_uneven * (n - 0.5) * 2.0);
  float x = max(-f.dpx, 0.0);
  float g = exp(-2.2 * x / max(depth, 1e-3)) * smoothstep(f.aa, -f.aa, f.dpx);
  float a = g * P_intensity * (0.5 + 0.5 * e) + ring(f, f.k) * P_edge * (0.45 + 0.55 * e);
  return lit(f.col, a);
}`,
	},
	{
		id: 'silk',
		name: 'Silk shimmer',
		blurb: 'A thin sheen of noise flows along the border, catching light here and there like silk thread.',
		params: [
			SPEED,
			range('flow', 'Flow', 1, 0, 4, 0.05),
			range('scale', 'Noise scale', 7, 1, 24, 0.1),
			range('contrast', 'Contrast', 2.6, 0.5, 8, 0.1),
			range('width', 'Width', 1.25, 0.5, 4, 0.05, 'px'),
			range('glow', 'Glow radius', 5, 0, 30, 0.5, 'px'),
			range('glowA', 'Glow', 0.3, 0, 1, 0.01),
			range('intensity', 'Intensity', 0.9, 0, 1, 0.01),
			range('base', 'Resting ring', 0.12, 0, 0.6, 0.01),
			range('whiten', 'Sheen whiteness', 0.5, 0, 1, 0.01),
		],
		glsl: /* glsl */ `
vec4 effect(Fx f) {
  float n = fbm(vec3(circ(f.u - f.t * P_flow * 0.035) * P_scale, f.t * 0.3));
  float sheen = pow(smoothstep(0.35, 0.85, n), P_contrast);
  float w = P_width * f.k;
  float core = ring(f, w);
  float glow = gauss(f.dpx - 0.5 * w, P_glow * f.k) * P_glowA;
  float a = (core + glow * (1.0 - core)) * sheen * P_intensity + core * P_base * (1.0 - sheen);
  return lit(mix(f.col, hi(f.col, P_whiten), sheen), a);
}`,
	},
	{
		id: 'march',
		name: 'Marching dashes',
		blurb: 'Quiet marching ants in the session colour: round-capped dashes, a whole number of them around the frame so the loop is seamless.',
		params: [
			SPEED,
			range('dash', 'Dash spacing', 12, 3, 48, 0.5, 'px'),
			range('duty', 'Dash length', 0.5, 0.1, 0.95, 0.01, '× spacing'),
			range('rate', 'March', 14, 0, 120, 1, 'px/s'),
			range('width', 'Width', 1.5, 0.5, 4, 0.05, 'px'),
			range('opacity', 'Opacity', 0.55, 0, 1, 0.01),
			range('glow', 'Glow radius', 4, 0, 24, 0.5, 'px'),
			range('glowA', 'Glow', 0.12, 0, 1, 0.01),
			toggle('caps', 'Round caps', true),
		],
		glsl: /* glsl */ `
vec4 effect(Fx f) {
  float Lpx = f.L * f.z;
  float n = max(3.0, floor(Lpx / (P_dash * f.k) + 0.5));
  float pp = Lpx / n;
  float x = fract(f.u * n - f.t * P_rate * f.k / pp) * pp;
  float w = P_width * f.k;
  float y = f.dpx - 0.5 * w;
  float on = P_duty * pp;
  float c = abs(x - 0.5 * pp);
  float dist = P_caps > 0.5
    ? length(vec2(max(c - max(0.5 * on - 0.5 * w, 0.0), 0.0), y)) - 0.5 * w
    : max(c - 0.5 * on, abs(y) - 0.5 * w);
  float cov = clamp(0.5 - dist / f.aa, 0.0, 1.0) * min(w / f.aa, 1.0);
  float glow = gauss(y, P_glow * f.k) * P_glowA;
  return lit(f.col, cov * P_opacity + glow * (1.0 - cov));
}`,
	},
	{
		id: 'aurora',
		name: 'Aurora',
		blurb: 'Low-frequency noise drifts the hue within the session colour along the edge, brightening and dimming like an aurora.',
		params: [
			SPEED,
			range('flow', 'Flow', 0.6, 0, 3, 0.05),
			range('hueRange', 'Hue range', 40, 0, 180, 1, '°'),
			range('scale', 'Noise scale', 1.6, 0.3, 6, 0.05),
			range('width', 'Width', 2, 0.5, 6, 0.05, 'px'),
			range('glow', 'Glow radius', 16, 0, 50, 0.5, 'px'),
			range('glowA', 'Glow', 0.4, 0, 1, 0.01),
			range('intensity', 'Intensity', 0.6, 0, 1, 0.01),
			toggle('useSecond', 'Blend a second colour', false),
			color('second', 'Second colour', '#7dd3fc'),
		],
		glsl: /* glsl */ `
vec4 effect(Fx f) {
  vec2 c = circ(f.u) * P_scale;
  float n1 = fbm(vec3(c, f.t * 0.12 * P_flow + f.seed * 5.0));
  float n2 = vnoise(vec3(c * 1.7 + 11.0, f.t * 0.2 * P_flow));
  vec3 col = hueRot(f.col, (n1 - 0.5) * 2.0 * radians(P_hueRange));
  if (P_useSecond > 0.5) col = mix(col, P_second, smoothstep(0.45, 0.75, n2));
  float bright = 0.3 + 0.7 * smoothstep(0.2, 0.8, n1 * 0.6 + n2 * 0.4);
  float w = P_width * f.k;
  float core = ring(f, w);
  float glow = glowOut(f, f.dpx - 0.5 * w, P_glow * f.k * (0.6 + 0.8 * n2)) * P_glowA;
  return lit(col, (core * 0.8 + glow * (1.0 - core)) * bright * P_intensity);
}`,
	},
	{
		id: 'heartbeat',
		name: 'Heartbeat',
		blurb: 'A double pulse (lub-dub) ripples outward from the border, then rests; the outline thumps with each beat.',
		params: [
			SPEED,
			range('period', 'Period', 2.6, 1, 6, 0.05, 's'),
			range('gap', 'Beat gap', 0.26, 0.1, 0.6, 0.01, 's'),
			range('second', 'Second beat', 0.65, 0, 1, 0.01),
			range('travel', 'Travel', 22, 4, 80, 1, 'px'),
			range('ringW', 'Ripple width', 2, 0.5, 8, 0.1, 'px'),
			range('decay', 'Decay', 2.2, 0.5, 5, 0.05),
			range('intensity', 'Ripple', 0.5, 0, 1, 0.01),
			range('edge', 'Outline thump', 0.4, 0, 1, 0.01),
		],
		glsl: /* glsl */ `
float beat(Fx f, float tb, float dur) {
  if (tb < 0.0 || tb > dur) return 0.0;
  float pr = tb / dur;
  float r = P_travel * f.k * (1.0 - pow(1.0 - pr, 3.0));
  float w = P_ringW * f.k * (1.0 + 2.0 * pr);
  return gauss(f.dpx - r, w) * pow(1.0 - pr, P_decay) * smoothstep(-1.0, 1.0, f.dpx);
}
vec4 effect(Fx f) {
  float ph = mod(f.t, P_period);
  float dur = min(1.1, P_period - P_gap);
  float b = beat(f, ph, dur) + beat(f, ph - P_gap, dur) * P_second;
  float th = exp(-ph * 9.0) + (ph > P_gap ? exp(-(ph - P_gap) * 9.0) * P_second : 0.0);
  float core = ring(f, 1.25 * f.k);
  return lit(hi(f.col, 0.15), b * P_intensity + core * (0.16 + P_edge * min(th, 1.0)));
}`,
	},
	{
		id: 'sweep',
		name: 'Conic sweep',
		blurb: 'A conic gradient turns around the frame centre, masked to the border: a lighthouse beam brushing the edge.',
		params: [
			SPEED,
			range('period', 'Turn time', 7, 1, 20, 0.1, 's'),
			range('arms', 'Arms', 1, 1, 4, 1),
			range('softness', 'Tail softness', 2.2, 0.5, 8, 0.05),
			range('width', 'Width', 1.5, 0.5, 4, 0.05, 'px'),
			range('glow', 'Glow radius', 8, 0, 40, 0.5, 'px'),
			range('glowA', 'Glow', 0.3, 0, 1, 0.01),
			range('intensity', 'Intensity', 0.8, 0, 1, 0.01),
			range('base', 'Resting ring', 0.1, 0, 0.6, 0.01),
			toggle('even', 'Even around the frame', true),
		],
		glsl: /* glsl */ `
vec4 effect(Fx f) {
  vec2 q = P_even > 0.5 ? f.p / f.b : f.p;
  float v = fract((atan(q.y, q.x) / TAU + 0.25) * P_arms - f.t / P_period);
  float g = pow(v, P_softness) * smoothstep(1.0, 0.985, v);
  float w = P_width * f.k;
  float core = ring(f, w);
  float glow = gauss(f.dpx - 0.5 * w, P_glow * f.k) * P_glowA;
  float a = (core + glow * (1.0 - core)) * g * P_intensity + core * P_base * (1.0 - g);
  return lit(mix(f.col, hi(f.col, 0.3), g * g), a);
}`,
	},
	{
		id: 'corners',
		reach: 120,
		name: 'Corner gather',
		blurb: 'Light gathers at each corner in turn, converging from a wide dim spread to a bright point, then hands off to the next.',
		params: [
			SPEED,
			range('period', 'Cycle', 4.8, 1, 16, 0.1, 's'),
			range('spread', 'Spread', 70, 10, 300, 1, 'px'),
			range('overlap', 'Hold', 0.45, 0.1, 1, 0.01, '× cycle'),
			range('width', 'Width', 1.5, 0.5, 4, 0.05, 'px'),
			range('glow', 'Glow radius', 12, 0, 40, 0.5, 'px'),
			range('glowA', 'Glow', 0.35, 0, 1, 0.01),
			range('intensity', 'Intensity', 0.9, 0, 1, 0.01),
			toggle('clockwise', 'Clockwise', true),
		],
		glsl: /* glsl */ `
vec4 effect(Fx f) {
  vec2 q = f.b - f.r;
  float hp = 0.5 * PI * f.r;
  float ph = fract(f.t / P_period);
  float light = 0.0;
  for (int i = 0; i < 4; i++) {
    float cs = i == 0 ? q.x + 0.5 * hp
      : i == 1 ? q.x + 1.5 * hp + 2.0 * q.y
      : i == 2 ? 3.0 * q.x + 2.5 * hp + 2.0 * q.y
      : 3.0 * q.x + 3.5 * hp + 4.0 * q.y;
    float order = P_clockwise > 0.5 ? float(i) : float(3 - i);
    float x = fract(ph - order * 0.25) / P_overlap;
    float env = x < 1.0 ? pow(sin(PI * x), 2.0) : 0.0;
    light += env * gauss(cyc(f.s, cs, f.L) * f.z, P_spread * f.k * mix(1.8, 0.7, env));
  }
  float w = P_width * f.k;
  float core = ring(f, w);
  float glow = gauss(f.dpx - 0.5 * w, P_glow * f.k) * P_glowA;
  light = min(light, 1.0);
  return lit(mix(f.col, hi(f.col, 0.3), light), light * (core + glow * (1.0 - core)) * P_intensity + core * 0.08);
}`,
	},
]
