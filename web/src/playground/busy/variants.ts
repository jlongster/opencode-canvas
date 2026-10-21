import { range, select, SPEED, toggle, type ParamDef } from '../shared/params'

/**
 * A "session is working" treatment for a frame's edge: `vec3 effect(Fx f)` returns the light it
 * adds, in linear RGB (see LIGHT_PRELUDE for Fx). The pass adds it to the frame in linear space,
 * tone-maps softly, converts back to sRGB and dithers, so faint gradients stay smooth.
 */
export interface BusyVariant {
	id: string
	name: string
	/** one line on why it works, shown as the demo's caption */
	note: string
	params: ParamDef[]
	glsl: string
}

export const LIGHT_PRELUDE = /* glsl */ `
#define PI 3.14159265
#define TAU 6.28318531

struct Fx {
  vec2 p;      // page units from the frame centre (y down)
  vec2 b;      // half size (page)
  float r;     // corner radius (page)
  vec2 n;      // outward normal of the nearest edge
  float dpx;   // signed distance to the edge, CSS px (negative inside)
  float s;     // arc length from the top centre, clockwise (page)
  float L;     // perimeter (page)
  float z;     // zoom (CSS px per page unit)
  float k;     // width scale: 1 = screen px, z = page units
  float t;     // speed-scaled time (s)
  float aa;    // one device pixel in CSS px
  vec3 col;    // session colour, linear
};

float sdRR(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

float perimeter(vec2 b, float r) { vec2 q = b - r; return 4.0 * (q.x + q.y) + TAU * r; }

// Inside the frame, points follow a concentric outline whose corner radius grows with depth, so
// arc length and normals stay smooth (no seam on the corner diagonals). R is that radius.
float insetRadius(vec2 b, float r, float d) { return min(r + max(-d, 0.0), min(b.x, b.y)); }

// Direction from the nearest outline point: the corner arc's radial direction, or the side's axis.
vec2 edgeDir(vec2 p, vec2 b, float R) {
  vec2 q = b - R;
  vec2 dv = p - clamp(p, -q, q);
  if (dv.x == 0.0 && dv.y == 0.0) {
    if (q.x - abs(p.x) < q.y - abs(p.y)) dv = vec2(p.x < 0.0 ? -1.0 : 1.0, 0.0);
    else dv = vec2(0.0, p.y < 0.0 ? -1.0 : 1.0);
  }
  return dv;
}

// Arc length of the outline point nearest p, from the top centre, clockwise (constant speed around
// corners), measured on the radius-R outline and rescaled to the frame's perimeter L.
float arcS(vec2 p, vec2 b, float R, vec2 dv, float L) {
  vec2 q = b - R;
  float hp = 0.5 * PI * R;
  float Lr = 4.0 * (q.x + q.y) + TAU * R;
  float s;
  if (dv.x == 0.0) {
    if (p.y < 0.0) s = p.x >= 0.0 ? p.x : Lr + p.x;
    else s = q.x + 2.0 * hp + 2.0 * q.y + (q.x - p.x);
  } else if (dv.y == 0.0) {
    if (p.x > 0.0) s = q.x + hp + (p.y + q.y);
    else s = 3.0 * q.x + 2.0 * q.y + 3.0 * hp + (q.y - p.y);
  } else {
    float a = atan(dv.y, dv.x);
    if (dv.x > 0.0 && dv.y < 0.0) s = q.x + R * (a + 0.5 * PI);
    else if (dv.x > 0.0) s = q.x + hp + 2.0 * q.y + R * a;
    else if (dv.y > 0.0) s = 3.0 * q.x + 2.0 * q.y + 2.0 * hp + R * (a - 0.5 * PI);
    else s = 3.0 * q.x + 4.0 * q.y + 3.0 * hp + R * (a + PI);
  }
  return s / Lr * L;
}

float cyc(float a, float b, float L) { return mod(a - b + 0.5 * L, L) - 0.5 * L; }
float gauss(float x, float s) { return exp(-x * x / (s * s + 1e-4)); }
float easeInOutCubic(float x) { return x < 0.5 ? 4.0 * x * x * x : 1.0 - pow(-2.0 * x + 2.0, 3.0) * 0.5; }
float easeInOutSine(float x) { return 0.5 - 0.5 * cos(PI * x); }
float easeOutQuart(float x) { return 1.0 - pow(1.0 - x, 4.0); }

// A line of width w centred on x = 0, antialiased; thinner than a pixel, it fades instead of aliasing.
float lineAA(float x, float w, float aa) {
  float ww = max(w, aa);
  return clamp((0.5 * ww - abs(x)) / aa + 0.5, 0.0, 1.0) * min(w / aa, 1.0);
}
// The hairline just outside the edge, where the frame's own 1px stroke sits.
float hair(Fx f, float w) { return lineAA(f.dpx - 0.5 * w, w, f.aa); }
// Light spilling outward from x (px), gaussian.
float bloomOut(Fx f, float x, float r) { return gauss(max(x, 0.0), r) * smoothstep(-1.0, 0.0, f.dpx); }
// Light scattering into the frame fill, exponential falloff inward.
float scatterIn(Fx f, float r) { return exp(-max(-f.dpx, 0.0) / max(r, 1e-3)) * clamp(0.5 - f.dpx / f.aa, 0.0, 1.0); }
`

export const VARIANTS: BusyVariant[] = [
	{
		id: 'specular',
		name: 'Specular',
		note: 'A specular glint runs along a 1px bevel lit from above; it keeps a constant speed around corners and spills just a little light into the fill, so it reads as material, not as a glow.',
		params: [
			SPEED,
			range('lap', 'Lap', 5.5, 2, 14, 0.1, 's'),
			range('tail', 'Tail', 0.14, 0.03, 0.4, 0.01),
			range('intensity', 'Intensity', 0.55, 0, 1.5, 0.01),
			range('width', 'Width', 1.25, 0.5, 3, 0.05, 'px'),
			range('white', 'Specular', 0.55, 0, 1, 0.01),
			range('bevel', 'Bevel', 0.45, 0, 1, 0.01),
			range('bloom', 'Bloom', 0.05, 0, 0.3, 0.005),
			range('scatter', 'Scatter', 0.035, 0, 0.2, 0.005),
		],
		glsl: /* glsl */ `
vec3 effect(Fx f) {
  float head = fract(f.t / P_lap) * f.L;
  float ds = cyc(f.s, head, f.L) * f.z;
  float tailPx = max(P_tail * f.L * f.z, 1.0);
  float a = ds > 0.0 ? gauss(ds, 9.0 * f.k) : exp(-2.4 * pow(-ds / tailPx, 1.35));
  // Bloom and scattered light are softer than the glint itself, so they lead it a little too.
  float soft = ds > 0.0 ? gauss(ds, 40.0 * f.k) : exp(-2.0 * pow(-ds / (tailPx * 1.3), 1.25));
  // A chamfer lit from the upper left catches more light where its normal faces the light.
  float facing = clamp(dot(normalize(f.n), normalize(vec2(-0.4, -1.0))) * 0.5 + 0.5, 0.0, 1.0);
  float lit = mix(1.0, 0.45 + 1.1 * facing, P_bevel);
  vec3 spec = mix(f.col, vec3(1.0), P_white * a * a);
  float w = P_width * f.k;
  return spec * a * hair(f, w) * P_intensity * lit
    + f.col * soft * (bloomOut(f, f.dpx - w, 12.0 * f.k) * P_bloom + scatterIn(f, 28.0 * f.k) * P_scatter);
}`,
	},
	{
		id: 'halo',
		name: 'Focus halo',
		note: 'A macOS-style focus ring set 3px off the frame breathes between 8% and 20% on a 3.4s sine: no movement at all, so it is calm enough to leave on for minutes.',
		params: [
			SPEED,
			range('period', 'Period', 3.4, 1.5, 8, 0.1, 's'),
			range('low', 'Low', 0.08, 0, 0.6, 0.01),
			range('high', 'High', 0.2, 0, 1, 0.01),
			range('offset', 'Offset', 3, 0, 8, 0.5, 'px'),
			range('width', 'Width', 1.5, 0.5, 4, 0.05, 'px'),
			range('haze', 'Haze', 5, 0, 16, 0.5, 'px'),
			select('easing', 'Easing', ['sine', 'quad', 'expo'], 'sine'),
		],
		glsl: /* glsl */ `
vec3 effect(Fx f) {
  float ph = fract(f.t / P_period);
  float e = 0.5 - 0.5 * cos(TAU * ph);
  if (P_easing > 1.5) e = pow(e, 2.6);
  else if (P_easing > 0.5) e = e * e * (3.0 - 2.0 * e);
  float a = mix(P_low, P_high, e);
  float w = P_width * f.k;
  float x = f.dpx - P_offset * f.k - 0.5 * w;
  float ring = lineAA(x, w, f.aa);
  float haze = gauss(x, P_haze * f.k + 1e-3) * (1.0 - ring) * 0.18;
  return f.col * a * (ring + haze);
}`,
	},
	{
		id: 'ambient',
		name: 'Ambient',
		note: 'Two broad, slow pools of light drift around the frame in opposite directions and scatter into the fill: activity felt in the periphery, never a moving line to track.',
		params: [
			SPEED,
			range('drift', 'Drift', 12, 4, 30, 0.5, 's'),
			range('lobes', 'Pools', 2, 1, 3, 1),
			range('size', 'Size', 0.2, 0.06, 0.45, 0.01),
			range('depth', 'Depth', 40, 8, 120, 1, 'px'),
			range('fill', 'Fill light', 0.08, 0, 0.3, 0.005),
			range('edge', 'Edge', 0.22, 0, 0.8, 0.01),
			range('breathe', 'Breathe', 0.3, 0, 1, 0.01),
		],
		glsl: /* glsl */ `
vec3 effect(Fx f) {
  float u = f.t / P_drift;
  float m = 0.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    if (fi >= P_lobes) break;
    float dir = mod(fi, 2.0) < 0.5 ? 1.0 : -1.0;
    float c = fract(u * dir + fi / P_lobes + 0.06 * sin(TAU * (u * 0.7 + fi * 0.37))) * f.L;
    float ds = cyc(f.s, c, f.L) / (P_size * f.L);
    m += exp(-ds * ds * 2.5);
  }
  m = min(m, 1.0);
  float br = 1.0 - P_breathe * (0.5 + 0.5 * cos(TAU * f.t / 4.4));
  return f.col * m * br * (scatterIn(f, P_depth * f.k) * P_fill + hair(f, f.k) * P_edge);
}`,
	},
	{
		id: 'gloss',
		name: 'Gloss',
		note: 'A glassy band sweeps diagonally across the frame on a long ease-in-out, then rests: like the sheen on a Wallet card, it says alive without asking to be watched.',
		params: [
			SPEED,
			range('period', 'Every', 4.2, 2, 10, 0.1, 's'),
			range('sweep', 'Sweep', 1.6, 0.6, 4, 0.05, 's'),
			range('angle', 'Angle', 22, -60, 60, 1, '°'),
			range('band', 'Band', 70, 20, 240, 1, 'px'),
			range('edge', 'Edge', 0.55, 0, 1.5, 0.01),
			range('sheen', 'Sheen', 0.025, 0, 0.12, 0.001),
			range('white', 'Whiteness', 0.45, 0, 1, 0.01),
		],
		glsl: /* glsl */ `
vec3 effect(Fx f) {
  float ph = mod(f.t, P_period);
  float sweep = min(P_sweep, P_period);
  if (ph > sweep) return vec3(0.0);
  float x = ph / sweep;
  float a = radians(P_angle);
  vec2 dir = vec2(cos(a), sin(a));
  float extent = dot(abs(dir), f.b) + P_band * f.k / f.z;
  float c = mix(-extent, extent, easeInOutCubic(x));
  float g = gauss((dot(f.p, dir) - c) * f.z, P_band * f.k);
  float fade = sqrt(sin(PI * x));
  float inside = clamp(0.5 - f.dpx / f.aa, 0.0, 1.0);
  vec3 c0 = mix(f.col, vec3(1.0), P_white * g);
  return c0 * g * fade * (hair(f, 1.25 * f.k) * P_edge + inside * P_sheen + bloomOut(f, f.dpx - f.k, 8.0 * f.k) * 0.05);
}`,
	},
	{
		id: 'trace',
		name: 'Trace',
		note: 'An indeterminate progress stroke, drawn down both sides from the top and erased after it, in the iOS and Material spinner rhythm: head and tail ease on offset curves so the length breathes.',
		params: [
			SPEED,
			range('cycle', 'Cycle', 2.8, 1.2, 6, 0.05, 's'),
			range('lag', 'Tail lag', 0.32, 0.1, 0.6, 0.01),
			range('intensity', 'Intensity', 0.42, 0, 1.5, 0.01),
			range('width', 'Width', 1.25, 0.5, 3, 0.05, 'px'),
			range('tips', 'Bright tips', 0.5, 0, 1, 0.01),
			range('bloom', 'Bloom', 0.02, 0, 0.3, 0.005),
			toggle('mirror', 'Both sides', true),
		],
		glsl: /* glsl */ `
vec3 effect(Fx f) {
  float ph = fract(f.t / P_cycle);
  float k = floor(f.t / P_cycle);
  float head = easeInOutCubic(clamp(ph / (1.0 - P_lag), 0.0, 1.0));
  float tail = easeInOutCubic(clamp((ph - P_lag) / (1.0 - P_lag), 0.0, 1.0));
  float a;
  float lenPx;
  if (P_mirror > 0.5) {
    a = abs(cyc(f.s, 0.0, f.L)) / (0.5 * f.L);
    if (mod(k, 2.0) > 0.5) a = 1.0 - a; // the next stroke grows back from where this one ended
    lenPx = 0.5 * f.L * f.z;
  } else {
    a = fract(f.s / f.L - 0.5 * k);
    lenPx = f.L * f.z;
  }
  float x = a * lenPx;
  float soft = 9.0 * f.k;
  float seg = smoothstep(tail * lenPx - soft, tail * lenPx + soft, x) * (1.0 - smoothstep(head * lenPx - soft, head * lenPx + soft, x));
  float tip = gauss(x - head * lenPx, 7.0 * f.k) + 0.4 * gauss(x - tail * lenPx, 7.0 * f.k);
  tip *= step(0.001, head - tail);
  float w = P_width * f.k;
  vec3 c = mix(f.col, vec3(1.0), P_tips * min(tip, 1.0) * 0.6);
  float shape = seg + tip * P_tips * 0.5;
  return c * shape * (hair(f, w) * P_intensity + bloomOut(f, f.dpx - w, 10.0 * f.k) * P_bloom);
}`,
	},
	{
		id: 'ripple',
		name: 'Ripple',
		note: 'One soft ring leaves the frame every 3.2s and eases out over 24px, like Find My’s ping: rhythmic, legible at a glance across the room, and at rest most of the time.',
		params: [
			SPEED,
			range('period', 'Every', 3.2, 1.5, 8, 0.1, 's'),
			range('travel', 'Travel', 24, 6, 64, 1, 'px'),
			range('width', 'Width', 2, 0.5, 8, 0.1, 'px'),
			range('intensity', 'Intensity', 0.12, 0, 1, 0.01),
			range('rest', 'Resting edge', 0.08, 0, 0.4, 0.005),
			range('thump', 'Edge flash', 0.25, 0, 1, 0.01),
			toggle('double', 'Echo', false),
		],
		glsl: /* glsl */ `
float wave(Fx f, float tb, float dur) {
  if (tb < 0.0 || tb > dur) return 0.0;
  float pr = tb / dur;
  float r = P_travel * f.k * easeOutQuart(pr);
  float w = P_width * f.k * (1.0 + 1.6 * pr);
  return gauss(f.dpx - r, w) * pow(1.0 - pr, 1.8) * smoothstep(-1.0, 1.0, f.dpx);
}
vec3 effect(Fx f) {
  float ph = mod(f.t, P_period);
  float dur = min(1.9, P_period);
  float v = wave(f, ph, dur) + (P_double > 0.5 ? 0.55 * wave(f, ph - 0.32, dur) : 0.0);
  float flash = exp(-ph * 5.0) * smoothstep(0.0, 0.06, ph);
  return f.col * (v * P_intensity + hair(f, 1.25 * f.k) * (P_rest + P_thump * flash));
}`,
	},
]

/** Params that extend along or inside the edge, not outward, so they don't widen the quads. */
export const INWARD = new Set(['band', 'depth', 'tail'])
