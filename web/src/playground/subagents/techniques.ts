import type { OrbShader } from '../../render/subagents/orbs'
import { glslDefines, range, select, SPEED, type ParamDef, type ParamValues } from '../shared/params'

/*
 * Subagent indicators: one small orb per subagent, in a row after its session's title, each drawn by
 * a fragment shader (see render/subagents/orbs.ts). Every technique reads the same per-orb record:
 * where it is, its colour, its state weights (running, done, failed, waiting, crossfading after a
 * change), a brief flash as a run finishes, hover, open (its frame expanded), a slow breath while it
 * waits, and its own clock, which only runs while it works (so done and failed orbs are still).
 * Nothing here moves on wall time: reduced motion freezes every clock at a pose.
 */

export type TechId = 'glass' | 'wisps' | 'metaballs' | 'fireflies' | 'plasma' | 'dots' | 'ink' | 'moons'

export interface Technique {
	id: TechId
	name: string
	note: string
	params: ParamDef[]
	/** quads per row (the shader sees every orb of a row at once), else per orb */
	row: boolean
	/** an orb's quad round its centre (device px): left, top, right, bottom */
	reach: (p: ParamValues, r: number, dpr: number) => [number, number, number, number]
	/** where orbs sit on the title line */
	anchor: 'centre' | 'baseline'
	/** reduced motion: the clock every orb is frozen at (plus its own phase) */
	still: number
	glsl: string
}

const size = (v: number, min = 6, max = 28) => range('size', 'Size', v, min, max, 1, 'px')
const spacing = (v: number) => range('spacing', 'Spacing', v, 8, 44, 1, 'px')
const colour = (v: 'parent' | 'own' = 'parent') => select('color', 'Colour', ['parent', 'own'], v)
const common = (s: number, sp: number, c: 'parent' | 'own' = 'parent', sizeMin = 6, sizeMax = 28) => [size(s, sizeMin, sizeMax), spacing(sp), SPEED, colour(c)]

/** A square quad: k radii round the centre, plus room for the open ring. */
const around = (k: number) => (_p: ParamValues, r: number, dpr: number): [number, number, number, number] => {
	const e = Math.max(k * r, r * 1.06 + 4 * dpr) + 2
	return [e, e, e, e]
}

const GLASS = /* glsl */ `
vec4 shadeOrb(Orb o, vec2 px) {
  float R = o.r * (1.0 + 0.06 * o.hover);
  vec2 q = (px - o.c) / R;
  float d = length(q);
  vec3 col = tint(o);
  float cov = cover((d - 1.0) * R);
  vec4 c = openRing(o, px, R + 3.0 * u_dpr);
  // a faint halo while it works, breathing while it waits
  float hd = max(d - 1.0, 0.0);
  float halo = exp(-hd * hd * 10.0) * (1.0 - cov) * smoothstep(1.75, 1.15, d);
  float glow = (0.22 * o.run + 0.24 * o.wait * o.breath + 0.03 * o.done + 0.3 * o.flash + 0.1 * o.hover) * P_glow;
  c = over(c, pm(lift(col, 0.25), halo * glow * o.alpha));
  if (cov <= 0.0) return c;
  // the inside: domain-warped noise swirling slowly in the sphere
  vec3 n = vec3(q, sqrt(max(0.0, 1.0 - d * d)));
  float t = o.t * 0.45 + o.phase * 40.0;
  vec3 s = n;
  s.xz *= rot(t * 0.4);
  vec3 sp = s * P_scale + vec3(o.seed * 0.37, o.seed * 0.11, 0.0);
  vec3 w = vec3(fbm(sp + vec3(0.0, 0.0, t * 0.35), 2), fbm(sp + vec3(5.2, 1.3, 7.0 - t * 0.3), 2), 0.0);
  float v = 0.5 + 0.5 * fbm(sp + 1.5 * w + vec3(0.0, t * 0.15, 0.0), 3);
  float act = o.run + 0.7 * o.wait;
  // settled, the swirl stills and evens out
  v = mix(0.5 + (v - 0.5) * 0.25, v, act);
  float light = o.run * 1.25 + o.wait * (0.6 + 0.55 * o.breath) + o.done * 0.5 + o.fail * 0.7 + o.flash * 0.6 + 0.2 * o.hover;
  vec3 body = col * (0.1 + 1.3 * v * v) * (0.45 + 0.55 * n.z) * light;
  // glass: Fresnel rim light and a soft specular highlight up and to the left
  float fres = pow(1.0 - n.z, 2.4);
  vec3 rim = lift(col, 0.5) * fres * P_rim * (0.6 + 0.4 * light);
  vec3 L = normalize(vec3(-0.5, -0.65, 0.6));
  float spec = pow(max(dot(n, normalize(L + vec3(0.0, 0.0, 1.0))), 0.0), 36.0) * P_spec;
  float sheen = smoothstep(0.55, 0.0, length(q - vec2(-0.32, -0.42))) * 0.12 * P_spec;
  vec3 lit = body + rim + vec3(spec * 0.95 + sheen);
  return over(c, pm(min(lit, vec3(1.0)), cov * mix(0.8, 1.0, fres) * o.alpha));
}`

const WISPS = /* glsl */ `
vec4 shadeOrb(Orb o, vec2 px) {
  float R = o.r * (1.0 + 0.08 * o.hover);
  vec2 q = (px - o.c) / R;
  float t = o.t + o.phase * 40.0;
  vec3 col = tint(o);
  vec4 c = openRing(o, px, R + 3.0 * u_dpr);
  // smoke: a thread carried up a curl-noise flow, swaying, thinning and breaking into puffs
  float amt = o.run + 0.45 * o.wait * (0.4 + 0.6 * o.breath);
  float hgt = P_height * u_dpr / R;
  float up = -q.y;
  if (amt > 0.002 && up > -0.8 && up < hgt * 1.1) {
    float h = clamp(up / hgt, 0.0, 1.0);
    float rise = t * 1.5;
    vec2 w = vec2(q.x, up);
    vec2 f = curl(vec2(w.x * 0.3, (w.y - rise) * 0.2) + vec2(o.seed * 0.71, o.seed * 0.13), t * 0.12);
    w.x += f.x * P_curl * 0.32 * h * (0.5 + h);
    float sway = snoise(vec3((up - rise) * 0.16, o.seed, t * 0.08)) * 1.2 * h * P_curl;
    float width = mix(0.3, 0.8, h) * P_thick;
    float x = (w.x - sway) / width;
    float thread = exp(-x * x);
    float puffs = smoothstep(-0.35, 0.55, snoise(vec3(w.x * 0.45, (up - rise) * 0.3, t * 0.15 + o.seed)));
    float fade = smoothstep(-0.5, 0.6, up) * (1.0 - smoothstep(0.3, 1.0, h));
    float smoke = thread * mix(1.0, puffs, smoothstep(0.08, 0.45, h)) * fade / (1.0 + 1.6 * h);
    c = over(c, pm(lift(col, 0.35), min(smoke * amt * 1.1, 1.0) * o.alpha));
  }
  // the ember it rises from: a hot core with a soft glow; settled, a calm small dot
  float d = length(q);
  float flick = 0.82 + 0.18 * snoise(vec3(t * 1.6, o.seed, 3.0));
  float glow = exp(-d * d * 2.4) * smoothstep(2.4, 1.4, d) * (0.5 * o.run * flick + 0.5 * o.wait * o.breath + 0.1 * o.done + 0.06 * o.fail + 0.5 * o.flash + 0.15 * o.hover) * P_glow;
  c = over(c, pm(col, glow * o.alpha));
  float heat = o.run * flick + o.wait * (0.45 + 0.5 * o.breath) + o.done * 0.7 + o.fail * 0.75 + o.flash * 0.3 + 0.2 * o.hover;
  vec3 ember = mix(lift(col, 0.25), lift(col, 0.6), o.run + o.wait * o.breath);
  float core = cover((d - 0.42) * R);
  return over(c, pm(ember, core * min(heat, 1.0) * o.alpha));
}`

const METABALLS = /* glsl */ `
const int MAX_BALLS = 24;
vec4 shadeRow(int start, int count, vec2 px) {
  // where each drop is: running ones wander a little along the line, and now and then two running
  // neighbours draw together, merge, and part again
  vec2 P[MAX_BALLS];
  float n = float(count);
  for (int i = 0; i < MAX_BALLS; i++) {
    if (i >= count) break;
    Orb o = orb(start + i);
    float t = o.t * 0.8 + o.phase * 30.0;
    P[i] = o.c + vec2(snoise(vec3(t * 0.3, o.seed, 1.0)) * 0.14 * o.aux, snoise(vec3(t * 0.4, o.seed, 6.0)) * 0.12 * o.r) * o.run * P_wander;
  }
  for (int i = 0; i < MAX_BALLS - 1; i++) {
    if (i >= count - 1) break;
    Orb a = orb(start + i);
    Orb b = orb(start + i + 1);
    float tp = (a.t + b.t) * 0.5 + (a.phase + b.phase) * 20.0;
    float w = a.run * b.run * smoothstep(0.05, 0.5, snoise(vec3(tp * 0.2, a.seed * 1.3 + b.seed, 7.0))) * min(a.alpha, b.alpha);
    vec2 pull = (b.c - a.c) * 0.46 * w * min(P_wander, 1.0);
    P[i] += pull;
    P[i + 1] -= pull;
  }
  float F = 0.0;
  vec2 G = vec2(0.0);
  vec3 acc = vec3(0.0);
  float ring = 0.0;
  vec3 ringC = vec3(0.0);
  float k = mix(6.0, 2.6, P_goo);
  for (int i = 0; i < MAX_BALLS; i++) {
    if (i >= count) break;
    Orb o = orb(start + i);
    if (o.alpha < 0.002) continue;
    float t = o.t * 0.8 + o.phase * 30.0;
    float r = o.r * (o.run * (1.0 + 0.05 * sin(t * 1.7 + o.seed)) + o.done * 0.74 + o.fail * 0.82 + o.wait * (0.78 + 0.16 * o.breath) + 0.08 * o.hover) * sqrt(o.alpha);
    vec2 dv = px - P[i];
    float d2 = max(dot(dv, dv), 1e-3);
    float f = pow(r * r / d2, 0.5 * k);
    F += f;
    G -= k * f * dv / d2;
    float b = o.run + o.wait * (0.6 + 0.4 * o.breath) + o.done * 0.6 + o.fail * 0.7 + o.flash * 0.5 + 0.2 * o.hover;
    acc += f * tint(o) * b;
    float rd = abs(length(px - o.c) - (o.r * 1.06 + 3.0 * u_dpr)) - 0.5 * u_dpr;
    float ra = cover(rd) * 0.75 * o.open * o.alpha;
    if (ra > ring) { ring = ra; ringC = lift(tint(o), 0.35); }
  }
  vec4 res = pm(ringC, ring);
  if (F < 0.02) return res;
  vec3 col = acc / F;
  float g = max(length(G), 1e-4);
  // the field's level set, antialiased with its gradient (≈ distance to the surface, device px)
  float sd = (1.0 - F) / g;
  float cov = cover(sd);
  if (cov <= 0.0) return res;
  // liquid: a sphere-like normal, outward along the field's gradient, tilted by how deep in the
  // field is (F^(-1/k) is a lone drop's normalised radius: 1 at its rim, 0 at its centre)
  float s = clamp(pow(F, -1.0 / k), 0.0, 1.0);
  vec3 nn = vec3(-G / g * s, sqrt(max(0.0, 1.0 - s * s)));
  vec3 L = normalize(vec3(-0.45, -0.65, 0.62));
  float diff = 0.5 + 0.5 * dot(nn, L);
  float spec = pow(max(dot(nn, normalize(L + vec3(0.0, 0.0, 1.0))), 0.0), 30.0) * P_shine;
  float rim = pow(1.0 - nn.z, 3.0) * 0.25;
  vec3 c = col * (0.35 + 0.8 * diff) + lift(col, 0.6) * rim + vec3(spec);
  return over(res, pm(min(c, vec3(1.0)), cov));
}`

const FIREFLIES = /* glsl */ `
vec2 fly(Orb o, float t, float amp) {
  // a frequency ratio per orb: 1:2, 2:3, 3:2 or 3:4
  float h = fract(o.seed * 0.618);
  vec2 ab = h < 0.25 ? vec2(1.0, 2.0) : h < 0.5 ? vec2(2.0, 3.0) : h < 0.75 ? vec2(3.0, 2.0) : vec2(3.0, 4.0);
  return o.c + amp * vec2(sin(ab.x * t * 0.6 + o.phase * 6.2832), 0.7 * sin(ab.y * t * 0.6 + o.seed));
}
vec4 shadeOrb(Orb o, vec2 px) {
  float t = o.t + o.phase * 40.0;
  vec3 col = tint(o);
  float amp = P_orbit * u_dpr * (o.run + 0.25 * o.wait);
  vec2 p = fly(o, t, amp);
  float d = length(px - p);
  float sig = o.r * (0.5 + 0.08 * o.hover);
  // a slow, soft flicker while it works
  float fl = mix(1.0, 0.45 + 0.55 * smoothstep(-0.45, 0.65, snoise(vec3(t * 1.3, o.seed, 2.0))), P_flicker * o.run);
  float halo = o.run * 0.75 * fl + o.wait * (0.25 + 0.5 * o.breath) + o.done * 0.28 + o.fail * 0.2 + o.flash * 0.6 + 0.25 * o.hover;
  vec4 c = openRing(o, px, o.r * 0.9 + 3.0 * u_dpr);
  // a faint trail along its orbit
  float trail = 0.0;
  for (int j = 1; j <= 5; j++) {
    float fj = float(j);
    float dj = length(px - fly(o, t - fj * 0.09, amp));
    trail += exp(-dj * dj / (0.5 * u_dpr * u_dpr * (1.0 + fj * 0.5))) * (1.0 - fj / 6.0);
  }
  c = over(c, pm(col, min(trail * 0.32 * P_trail * o.run * fl, 0.8) * o.alpha));
  c = over(c, pm(lift(col, 0.1), exp(-d * d / (2.0 * sig * sig)) * smoothstep(3.2 * sig, 2.2 * sig, d) * min(halo, 1.0) * o.alpha));
  float core = cover(d - P_core * 0.5 * u_dpr * (1.0 + 0.15 * o.hover));
  float heat = o.run * (0.55 + 0.45 * fl) + o.wait * (0.5 + 0.4 * o.breath) + o.done * 0.75 + o.fail * 0.8 + o.flash * 0.3;
  return over(c, pm(lift(col, 0.35 + 0.5 * (o.run * fl + o.wait * o.breath + o.flash)), core * min(heat, 1.0) * o.alpha));
}`

const PLASMA = /* glsl */ `
vec4 shadeOrb(Orb o, vec2 px) {
  float R = o.r * (1.0 + 0.06 * o.hover);
  vec2 q = (px - o.c) / R;
  float d = length(q);
  vec3 col = tint(o);
  vec4 c = openRing(o, px, R + 3.0 * u_dpr);
  float cov = cover((d - 1.0) * R);
  if (cov <= 0.0) return c;
  vec3 n = vec3(q, sqrt(max(0.0, 1.0 - d * d)));
  float t = o.t + o.phase * 60.0;
  // the bead turns about a tilted axis; its surface is flowing noise folded into soft plasma bands
  vec3 s = n;
  s.yz *= rot(0.4);
  s.xz *= rot(t * 0.45 * P_spin + o.seed);
  float v = fbm(s * P_scale + vec3(o.seed, t * 0.08, 0.0), 2);
  float w = snoise(s * P_scale * 0.5 + vec3(t * 0.05, o.seed * 1.3, 2.0));
  float act = o.run + 0.6 * o.wait;
  float ph = (v * 0.9 + w * 0.7) * P_bands + t * 0.45;
  float pat = 0.5 + 0.5 * cos(ph * 3.1416);
  pat = mix(0.5 + (pat - 0.5) * 0.35, pat, act);
  vec3 surf = mix(col * 0.2, lift(col, 0.3), pat);
  vec3 L = normalize(vec3(-0.5, -0.6, 0.62));
  float lam = max(dot(n, L), 0.0);
  float lit = mix(1.0, 0.22 + 0.95 * lam, P_light);
  float b = o.run + o.wait * (0.6 + 0.4 * o.breath) + o.done * 0.62 + o.fail * 0.72 + o.flash * 0.45 + 0.2 * o.hover;
  float rim = pow(1.0 - n.z, 3.0) * 0.35;
  vec3 cc = surf * lit * b + lift(col, 0.5) * rim * b;
  return over(c, pm(min(cc, vec3(1.0)), cov * o.alpha));
}`

const DOTS = /* glsl */ `
float clumps(Orb o, vec2 dv, float t) {
  // the Ember band's clumps on a little ring round the orb: two noise layers crawling round it in
  // opposite directions while drifting outward; only their peaks light up
  float rc = o.r / u_dpr;
  float dist = length(dv) * rc;
  float Lc = 2.0 * PI * rc * 0.75;
  float arc = (atan(dv.y, dv.x) / (2.0 * PI)) * Lc;
  float sc = P_scale;
  float Rn = Lc / (2.0 * PI * sc);
  float a1 = (arc - t * P_crawl) / Lc * 2.0 * PI;
  float a2 = (arc + t * P_crawl) / Lc * 2.0 * PI;
  float away = (dist - t * 5.0) / sc;
  float n1 = vnoise(vec3(cos(a1) * Rn + o.seed * 11.7, sin(a1) * Rn + o.seed * 5.3, away + t * 0.11 + o.seed * 2.9));
  float n2 = vnoise(vec3(cos(a2) * Rn * 0.87 + o.seed * 3.1 + 9.0, sin(a2) * Rn * 0.87 + o.seed * 7.9, away * 1.1 + 9.0 + t * 0.13));
  float m = max(n1, n2);
  return max(smoothstep(P_sparse + 0.06, P_sparse + 0.12, m), smoothstep(P_sparse - 0.02, P_sparse + 0.03, m) * 0.3);
}
// one orb's value (0..1) at a point
float dotField(Orb o, vec2 p, float pd) {
  float R = o.r * (1.0 + 0.08 * o.hover);
  vec2 dv = (p - o.c) / R;
  float d = length(dv);
  if (d > 1.75) return 0.0;
  float t = o.t + o.phase * 40.0;
  float pitchR = pd / R;
  float soft = 0.18;
  // running: a lit core, a faint rim, and the band's clumps crawling round outside it
  float core = 1.0 - smoothstep(0.42, 0.42 + soft, d);
  float band = clamp(1.0 - (d - 0.45) / 0.75, 0.0, 1.0);
  float run = max(core * 0.55, clumps(o, dv, t) * pow(band, 0.7) * smoothstep(0.3, 0.55, d));
  run = max(run, 0.16 * (1.0 - smoothstep(0.0, pitchR * 0.8, abs(d - 0.78))));
  // settled: a small round cluster, brightest in the middle
  float small = 1.0 - smoothstep(0.58, 0.58 + soft, d);
  float settled = small * mix(0.66, 0.42, smoothstep(0.0, 0.6, d));
  float waitRing = (1.0 - smoothstep(0.0, pitchR * 0.7, abs(d - 0.86))) * (0.15 + 0.6 * o.breath);
  float waiting = max(small * 0.3, waitRing);
  float v = o.run * run + o.done * settled + o.fail * small * 0.66 + o.wait * waiting;
  v = max(v, o.flash * (1.0 - smoothstep(0.8, 0.8 + soft, d)) * 0.95);
  v = min(1.0, v * (1.0 + 0.3 * o.hover) + 0.1 * o.hover * small);
  float ring = (1.0 - smoothstep(0.0, pitchR * 0.6, abs(d - 1.32))) * 0.5 * o.open;
  return max(v, ring) * o.alpha;
}
vec4 shadeRow(int start, int count, vec2 px) {
  // the Ember band's grid: anchored to the canvas, whole device pixels, a constant size on screen
  vec2 g0 = u_grid.xy;
  float pd = u_grid.z;
  float side = u_grid.w;
  vec2 cell = floor((px - g0) / pd);
  vec2 local = px - g0 - cell * pd;
  float off = floor((pd - side) * 0.5);
  if (local.x < off || local.y < off || local.x >= off + side || local.y >= off + side) return vec4(0.0);
  vec2 cc = g0 + (cell + 0.5) * pd;
  // each cell takes the field's average over it (2×2 samples), not its value at the centre, so an orb
  // sliding across the grid (zooming, gliding) brightens and dims dots smoothly instead of popping them
  float best = 0.0;
  vec3 bc = vec3(0.0);
  float q = pd * 0.25;
  for (int i = 0; i < count; i++) {
    Orb o = orb(start + i);
    if (o.alpha < 0.002 || length(cc - o.c) > o.r * 1.9 + pd) continue;
    float v = 0.25 * (dotField(o, cc + vec2(-q, -q), pd) + dotField(o, cc + vec2(q, -q), pd) + dotField(o, cc + vec2(-q, q), pd) + dotField(o, cc + vec2(q, q), pd));
    if (v > best) { best = v; bc = tint(o); }
  }
  return pm(bc, best * P_peak);
}`

const INK = /* glsl */ `
// one bloom, f (0..1) of the way through: a soft drop spreading, its front gently lobed, the ink
// pooling at its edge and drawn into fine filaments by a curl flow inside
float bloom(Orb o, vec2 q, float f, float gs, out float front) {
  float grow = 1.0 - pow(1.0 - f, 2.4);
  float rad = mix(0.18, 1.0, grow) * P_spread;
  float a = atan(q.y, q.x);
  float lobes = snoise(vec3(cos(a) * 0.7, sin(a) * 0.7, gs)) * 0.75 + snoise(vec3(cos(a) * 1.5, sin(a) * 1.5, gs + 4.0)) * 0.2;
  float edge = rad * (1.0 + P_tendrils * 0.1 * grow * lobes);
  // (the curl flow only stirs the ink inside: its kinks would show on the edge)
  vec2 w = q + P_tendrils * 0.03 * grow * curl(q * 1.1 + vec2(gs, gs * 0.3), gs);
  float x = length(q) / edge;
  float fw = 1.2 / max(o.r * edge, 1.0);
  float body = 1.0 - smoothstep(1.0 - fw, 1.0 + fw, x);
  front = smoothstep(0.4, 1.0, x);
  float veil = 0.3 + 0.25 * (0.5 + 0.5 * snoise(vec3(w * 1.8, gs + 1.7)));
  return body * mix(veil, 1.0, front * front);
}
vec4 shadeOrb(Orb o, vec2 px) {
  float R = o.r * (1.0 + 0.06 * o.hover);
  vec2 q = (px - o.c) / R;
  vec3 col = tint(o);
  vec4 c = openRing(o, px, R * 1.08 + 3.0 * u_dpr);
  if (length(q) > 1.45) return c;
  float t = o.t / max(P_period, 0.5) + o.phase * 7.0;
  float a = 0.0, fr = 0.0, fk;
  if (o.run > 0.001) {
    // running: blooms one after another, two overlapping so none pops in or out
    float keep = 1.0;
    for (int k = 0; k < 2; k++) {
      float ph = t + float(k) * 0.5;
      float f = fract(ph);
      float life = smoothstep(0.0, 0.07, f) * pow(1.0 - f, 1.4);
      float v = bloom(o, q, f, o.seed + floor(ph) * 7.31 + float(k) * 3.1, fk) * life;
      keep *= 1.0 - v;
      fr = max(fr, fk * life);
    }
    a += o.run * (1.0 - keep);
  }
  if (o.wait > 0.001) a += o.wait * bloom(o, q, 0.22 + 0.4 * o.breath, o.seed + 0.5, fk) * 0.75;
  float settled = o.done + o.fail;
  if (settled > 0.001) {
    a += settled * bloom(o, q, 0.6, o.seed, fk) * 0.72;
    fr = max(fr, fk * settled * 0.6);
  }
  float b = 0.8 + 0.25 * o.run + 0.1 * o.wait + 0.4 * o.flash + 0.2 * o.hover;
  vec3 ink = mix(col, lift(col, 0.35), fr) * b;
  return over(c, pm(min(ink, vec3(1.0)), min(a * (1.0 + 0.4 * o.flash), 1.0) * o.alpha));
}`

const MOONS = /* glsl */ `
vec4 shadeOrb(Orb o, vec2 px) {
  float R = o.r * (1.0 + 0.06 * o.hover);
  vec2 q = (px - o.c) / R;
  float d = length(q);
  vec3 col = tint(o);
  vec4 c = openRing(o, px, R + 3.0 * u_dpr);
  float cov = cover((d - 1.0) * R);
  if (cov <= 0.0) return c;
  vec3 n = vec3(q.x, -q.y, sqrt(max(0.0, 1.0 - d * d)));
  float t = o.t + o.phase * 40.0;
  // running, its phases go round; waiting, half lit, the terminator breathing; done, full; failed, red
  float th = t * 0.6;
  vec3 Lr = normalize(vec3(sin(th), 0.12, cos(th)));
  float tw = 1.5708 - 0.5 + 0.5 * o.breath;
  vec3 Lw = normalize(vec3(sin(tw), 0.12, cos(tw)));
  float soft = mix(0.03, 0.45, P_soft);
  float lit = o.run * smoothstep(-soft, soft, dot(n, Lr)) + o.wait * smoothstep(-soft, soft, dot(n, Lw)) + o.done + o.fail;
  // faint maria, fixed to the moon, and limb darkening
  float maria = fbm(vec3(n.xy * 1.5 + o.seed * 0.31, o.seed), 3);
  float surf = 1.0 - P_surface * 0.4 * smoothstep(-0.15, 0.45, maria);
  float limb = mix(0.6, 1.0, sqrt(n.z));
  float b = o.run + o.wait * 0.9 + o.done * 0.62 + o.fail * 0.72 + o.flash * 0.45 + 0.2 * o.hover;
  vec3 day = lift(col, 0.28) * surf * limb * b;
  vec3 night = col * 0.5 * limb;
  vec3 cc = mix(night, day, lit);
  float alpha = mix(P_shine, 1.0, lit);
  return over(c, pm(min(cc, vec3(1.0)), cov * alpha * o.alpha));
}`

export const TECHNIQUES: Technique[] = [
	{
		id: 'glass',
		name: 'Glass orbs',
		note: 'A tiny glass sphere with Fresnel rim light and a soft highlight; domain-warped noise swirls inside while it works and stills once it’s done.',
		params: [...common(12, 19), range('rim', 'Rim light', 0.7, 0, 1.5, 0.05), range('spec', 'Highlight', 0.75, 0, 1.5, 0.05), range('scale', 'Noise scale', 1.1, 0.4, 4, 0.05), range('glow', 'Glow', 1, 0, 2, 0.05)],
		row: false,
		reach: around(1.8),
		anchor: 'centre',
		still: 3.1,
		glsl: GLASS,
	},
	{
		id: 'wisps',
		name: 'Wisps',
		note: 'Incense threads standing on the title’s baseline: curl-noise smoke rises from a small ember while it works; done leaves the ember alone.',
		params: [...common(9, 17, 'parent', 4, 20), range('height', 'Height', 24, 8, 44, 1, 'px'), range('curl', 'Curl', 0.9, 0, 2, 0.05), range('thick', 'Thickness', 1, 0.4, 2, 0.05), range('glow', 'Glow', 1, 0, 2, 0.05)],
		row: false,
		reach: (p, r, dpr) => {
			const side = Math.max(2.6 * r, r * 1.08 + 4 * dpr) + 2
			const up = Math.max(Number(p.height) * dpr * 1.1 + r, side)
			return [side, up, side, side]
		},
		anchor: 'baseline',
		still: 2.4,
		glsl: WISPS,
	},
	{
		id: 'metaballs',
		name: 'Metaballs',
		note: 'Liquid drops on the title line: running ones wander, and now and then two neighbours draw together, merge and part; done drops shrink and settle.',
		params: [...common(11, 18), range('goo', 'Goo', 0.45, 0, 1, 0.05), range('wander', 'Wander', 0.8, 0, 1.5, 0.05), range('shine', 'Highlight', 0.6, 0, 1.5, 0.05)],
		row: true,
		reach: around(1.8),
		anchor: 'centre',
		still: 6.3,
		glsl: METABALLS,
	},
	{
		id: 'fireflies',
		name: 'Fireflies',
		note: 'A crisp point with a soft halo drifting in a tiny Lissajous orbit, trailing light and flickering while it works; done ones hold a steady glow.',
		params: [...common(14, 18), range('orbit', 'Orbit', 3, 0, 8, 0.25, 'px'), range('flicker', 'Flicker', 0.6, 0, 1, 0.05), range('trail', 'Trail', 0.6, 0, 1.5, 0.05), range('core', 'Core', 2.6, 1, 5, 0.1, 'px')],
		row: false,
		reach: (p, r, dpr) => {
			const e = Math.max(r * 1.7, r * 0.9 + 4 * dpr) + Number(p.orbit) * dpr + 2
			return [e, e, e, e]
		},
		anchor: 'centre',
		still: 1.7,
		glsl: FIREFLIES,
	},
	{
		id: 'plasma',
		name: 'Plasma beads',
		note: 'A lit bead whose surface is sphere-mapped fbm folded into plasma bands, turning on a tilted axis while it works; done beads stop and soften.',
		params: [...common(12, 19), range('scale', 'Noise scale', 1.3, 0.4, 4, 0.05), range('bands', 'Bands', 1.4, 0, 4, 0.05), range('spin', 'Spin', 1, 0, 3, 0.05), range('light', 'Lighting', 0.7, 0, 1, 0.05)],
		row: false,
		reach: around(1),
		anchor: 'centre',
		still: 2.2,
		glsl: PLASMA,
	},
	{
		id: 'dots',
		name: 'Dot-grid orbs',
		note: 'Orbs seen through the Ember band’s own dot grid: its clumps crawl round a little ring while running; done is a small calm cluster.',
		params: [...common(22, 30, 'parent', 14, 36), range('crawl', 'Crawl', 5.5, 0, 14, 0.5, 'px/s'), range('scale', 'Noise scale', 7, 3, 12, 0.5, 'px'), range('sparse', 'Sparse', 0.5, 0.35, 0.7, 0.005), range('peak', 'Peak', 0.9, 0.3, 1, 0.05)],
		row: true,
		reach: around(1.8),
		anchor: 'centre',
		still: 4,
		glsl: DOTS,
	},
	{
		id: 'ink',
		name: 'Ink drops',
		note: 'A drop of ink blooming in water, looping, ink pooling at its lobed front; done leaves a still stain.',
		params: [...common(14, 20), range('period', 'Period', 3.2, 1.5, 6, 0.1, 's'), range('spread', 'Spread', 1, 0.6, 1.3, 0.02), range('tendrils', 'Tendrils', 1, 0, 2, 0.05)],
		row: false,
		reach: around(1.5),
		anchor: 'centre',
		still: 1.15,
		glsl: INK,
	},
	{
		id: 'moons',
		name: 'Moons',
		note: 'A small moon whose phases cycle while it works: full and calm when done, half lit with a breathing terminator while waiting.',
		params: [...common(12, 18), range('soft', 'Terminator', 0.3, 0, 1, 0.05), range('shine', 'Earthshine', 0.22, 0, 0.6, 0.02), range('surface', 'Maria', 0.5, 0, 1, 0.05)],
		row: false,
		reach: around(1),
		anchor: 'centre',
		still: 2.1,
		glsl: MOONS,
	},
]

export function techOf(id: string): Technique {
	return TECHNIQUES.find((t) => t.id === id) ?? TECHNIQUES[0]
}

const shaders = new Map<TechId, OrbShader>()

export function shaderOf(t: Technique): OrbShader {
	let s = shaders.get(t.id)
	if (!s) shaders.set(t.id, (s = { id: t.id, glsl: t.glsl, row: t.row, defines: glslDefines(t.params) }))
	return s
}
