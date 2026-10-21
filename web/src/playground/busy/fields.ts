import { range, select, SPEED, type ParamDef } from '../shared/params'
import type { BusyVariant } from './variants'

interface FieldDefaults {
	pitch?: number
	dot?: number
	shape?: 'round' | 'square'
	mode?: 'brightness' | 'halftone' | 'dither'
	levels?: number
	base?: number
	rim?: number
	scale?: number
	warp?: number
	drift?: number
	depth?: number
	falloff?: number
	intensity?: number
	peak?: number
	color?: 'session' | 'mesh'
}

/** Every flow variation's controls: the dot grid, then the field, then colour. */
function params(d: FieldDefaults, extra: ParamDef[] = []): ParamDef[] {
	return [
		SPEED,
		range('pitch', 'Grid pitch', d.pitch ?? 4, 2, 12, 1, 'px'),
		range('dot', 'Dot size', d.dot ?? 3, 1, 10, 0.5, 'px'),
		select('shape', 'Dot shape', ['round', 'square'], d.shape ?? 'square'),
		select('mode', 'Mask', ['brightness', 'halftone', 'dither'], d.mode ?? 'brightness'),
		range('levels', 'Brightness steps', d.levels ?? 0, 0, 8, 1),
		range('base', 'Unlit dots', d.base ?? 0, 0, 0.3, 0.005),
		range('rim', 'Edge row', d.rim ?? 0.18, 0, 1, 0.01),
		range('modulate', 'Mask modulation', 0, 0, 1, 0.01),
		range('scale', 'Noise size', d.scale ?? 18, 3, 120, 0.5, 'px'),
		range('warp', 'Warp', d.warp ?? 1, 0, 3, 0.01),
		range('drift', 'Outward drift', d.drift ?? 8, 0, 80, 0.5, 'px/s'),
		range('depth', 'Band depth', d.depth ?? 34, 8, 120, 1, 'px'),
		range('falloff', 'Falloff', d.falloff ?? 0.8, 0.2, 4, 0.05),
		range('intensity', 'Intensity', d.intensity ?? 1, 0, 3, 0.01),
		range('peak', 'Peak opacity', d.peak ?? 0.9, 0, 1, 0.01),
		select('color', 'Colour', ['session', 'mesh'], d.color ?? 'session'),
		...extra,
	]
}

/** Shared tint: the session colour, or (mesh) slow hue drifts round the frame near the session hue. */
const MESH_TINT = /* glsl */ `
vec3 meshTint(Fx f, vec3 col) {
  if (P_color < 0.5) return col;
  float h = vnoise(around(f, 140.0, -6.0, f.t * 0.05)) - 0.5;
  return hueRotate(col, h * 1.4);
}`

export const FLOW_VARIANTS: BusyVariant[] = [
	{
		id: 'embers',
		name: 'Ember clumps',
		note: 'Tuned to look like Brian’s Brain, but continuous: two layers of fine noise crawl in opposite directions round the frame while drifting outward, and only their peaks light up, giving sparse bright clumps that thin out away from the edge and glide instead of stepping.',
		params: params({ scale: 9, drift: 5, depth: 34, falloff: 1, mode: 'brightness', levels: 0, rim: 0.18 }, [
			range('crawl', 'Crawl', 7, 0, 40, 0.5, 'px/s'),
			range('sparse', 'Sparseness', 0.71, 0.4, 0.9, 0.005),
			range('dim', 'Dim clumps', 0.3, 0, 1, 0.01),
		]),
		still: 4,
		glsl: /* glsl */ `${MESH_TINT}
float field(Fx f) {
  float away = (f.d - f.t * P_drift) / P_scale;
  float a = vnoise(around(f, P_scale, P_crawl, away) + vec3(0.0, 0.0, f.t * 0.11));
  float b = vnoise(around(f, P_scale * 1.15, -P_crawl, away * 1.1 + 9.0) + vec3(0.0, 0.0, f.t * 0.13));
  float m = max(a, b);
  // Bright peaks, and a dimmer halo round them (like dying cells), thinning outward.
  float bright = smoothstep(P_sparse + 0.06, P_sparse + 0.12, m);
  float dim = smoothstep(P_sparse - 0.02, P_sparse + 0.03, m) * P_dim;
  float edge = smoothstep(0.0, 0.25, f.fall);
  return max(bright, dim) * (0.35 + 0.65 * f.fall) * edge;
}
vec3 tint(Fx f, vec3 col, float v) { return meshTint(f, col); }`,
	},
	{
		id: 'smoke',
		name: 'Smoke',
		note: 'Slow domain-warped fbm (Inigo Quilez’s warping) sampled further inward as time passes, so soft tongues of smoke lift off every side and corner and dissolve as the falloff takes them; seen through 3px square dots as dithered speckle.',
		params: params({ scale: 16, warp: 1.1, drift: 7, depth: 36, falloff: 0.9, mode: 'dither', rim: 0.2 }),
		still: 3,
		glsl: /* glsl */ `${MESH_TINT}
float field(Fx f) {
  vec3 q = outward(f, P_scale, P_drift, 0.12);
  vec3 w = vec3(fbm(q + vec3(0.0, 0.0, f.t * 0.07)), fbm(q + vec3(5.2, 1.3, 2.8)), 0.0);
  float n = fbm(q + P_warp * (w - 0.5) * 2.0);
  return smoothstep(0.42, 0.8, n) * f.fall;
}
vec3 tint(Fx f, vec3 col, float v) { return meshTint(f, col); }`,
	},
	{
		id: 'fire',
		name: 'Fire',
		note: 'Quicker licking tongues: noise stretched away from the edge rises fast and is cut by height (the classic noise-minus-height flame), so it is hot and dense at the base and frays into sparks; the base shifts warm.',
		params: params({ scale: 9, warp: 0.6, drift: 26, depth: 30, falloff: 1, mode: 'brightness', levels: 0, rim: 0.3 }, [
			range('stretch', 'Tongue length', 2.4, 1, 6, 0.05),
			range('warm', 'Warm shift', 0.45, 0, 1, 0.01),
		]),
		still: 2,
		glsl: /* glsl */ `
float field(Fx f) {
  float h = f.d / f.depth;
  vec3 q = around(f, P_scale, 0.0, (f.d - f.t * P_drift) / (P_scale * P_stretch));
  q.xy += vec2(f.t * 0.35);
  float w = fbm(q * 0.7 + vec3(3.1, 7.7, f.t * 0.3));
  float n = fbm(q + P_warp * (w - 0.5) * 2.0);
  return smoothstep(0.05, 0.55, n * 1.25 - pow(h, 0.85));
}
vec3 tint(Fx f, vec3 col, float v) {
  vec3 hot = mix(col, vec3(1.0, 0.86, 0.6), 0.6);
  return mix(col, hot, P_warm * v * v * (1.0 - f.d / f.depth));
}`,
	},
	{
		id: 'mesh',
		name: 'Mesh gradient',
		note: 'Four large soft blobs of colour near the session hue orbit the frame at different speeds while the band breathes outward and back; brightness-masked dots turn the smooth mesh gradient into an LED glow.',
		params: params({ depth: 32, falloff: 1.2, mode: 'brightness', levels: 0, rim: 0.15, color: 'mesh', scale: 30, intensity: 1.1 }, [
			range('orbit', 'Orbit speed', 0.04, 0, 0.3, 0.005),
			range('breathe', 'Breathing', 0.25, 0, 0.8, 0.01),
		]),
		still: 5,
		glsl: /* glsl */ `
float blob(Fx f, float k) {
  float c = fract(k * 0.25 + f.t * P_orbit * (mod(k, 2.0) < 0.5 ? 1.0 : -0.7) + 0.13 * sin(f.t * 0.3 + k));
  float ds = abs(fract(f.s / f.L - c + 0.5) - 0.5);
  return exp(-ds * ds / 0.012);
}
float field(Fx f) {
  float m = 0.0;
  for (int k = 0; k < 4; k++) {
    float kk = float(k);
    float breath = 1.0 + P_breathe * sin(f.t * 0.9 + kk * 1.7);
    float reach = pow(clamp(1.0 - f.d / (f.depth * breath), 0.0, 1.0), P_falloff);
    m += blob(f, kk) * reach;
  }
  float grain = 0.85 + 0.3 * vnoise(outward(f, P_scale, P_drift, 0.1));
  return clamp(m, 0.0, 1.0) * grain + 0.18 * f.fall;
}
vec3 tint(Fx f, vec3 col, float v) {
  if (P_color < 0.5) return col;
  vec3 c = vec3(0.0);
  float wsum = 0.0;
  for (int k = 0; k < 4; k++) {
    float kk = float(k);
    float w = blob(f, kk) + 0.02;
    c += hueRotate(col, (kk - 1.5) * 0.35) * w;
    wsum += w;
  }
  return c / wsum;
}`,
	},
	{
		id: 'ink',
		name: 'Ink wisps',
		note: 'Thin wisps rather than blobs: doubly warped noise folded into ridges (1 − |2n − 1|, sharpened), flowing along and away from the edge like ink in water; halftone dots grow along each filament.',
		params: params({ scale: 22, warp: 1.6, drift: 6, depth: 40, falloff: 0.9, mode: 'halftone', dot: 3.5, shape: 'round', rim: 0.15 }, [
			range('thin', 'Thinness', 9, 1, 20, 0.1),
			range('flow', 'Flow along', 5, -30, 30, 0.5, 'px/s'),
		]),
		still: 6,
		glsl: /* glsl */ `${MESH_TINT}
float field(Fx f) {
  vec3 q = around(f, P_scale, P_flow, (f.d - f.t * P_drift) / P_scale);
  vec3 w1 = vec3(fbm(q + vec3(0.0, 0.0, f.t * 0.05)), fbm(q + vec3(5.2, 1.3, 2.8)), 0.0);
  vec3 w2 = vec3(fbm(q + P_warp * w1 + vec3(1.7, 9.2, f.t * 0.08)), fbm(q + P_warp * w1 + vec3(8.3, 2.8, 0.0)), 0.0);
  float n = fbm(q + P_warp * (w2 - 0.5) * 2.0);
  float ridge = pow(1.0 - abs(2.0 * n - 1.0), P_thin);
  return smoothstep(0.3, 0.9, ridge) * f.fall;
}
vec3 tint(Fx f, vec3 col, float v) { return meshTint(f, col); }`,
	},
	{
		id: 'aurora',
		name: 'Aurora',
		note: 'Curtains of light running round the perimeter: noise that is long away from the edge and short along it makes vertical streaks that slide round the frame, and a finer noise eats them from the outside, so they fray into specks.',
		params: params({ scale: 10, drift: 3, depth: 40, falloff: 0.7, mode: 'brightness', levels: 0, rim: 0.2 }, [
			range('slide', 'Slide speed', 10, -40, 40, 0.5, 'px/s'),
			range('fray', 'Fray', 0.7, 0, 1.5, 0.01),
		]),
		still: 2.5,
		glsl: /* glsl */ `${MESH_TINT}
float field(Fx f) {
  float curtain = fbm(around(f, P_scale, P_slide, f.d / (P_scale * 6.0) + f.t * 0.06));
  float rays = smoothstep(0.48, 0.8, curtain);
  float fine = vnoise(outward(f, P_scale * 0.5, P_drift * 3.0, 0.4));
  float keep = smoothstep(-0.15, 0.25, fine - P_fray * f.d / f.depth);
  return rays * pow(f.fall, 0.6) * keep * 1.2;
}
vec3 tint(Fx f, vec3 col, float v) { return meshTint(f, col); }`,
	},
]
