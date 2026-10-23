import { glslDefines, range, select, SPEED, type ParamDef, type ParamValues } from '../params'
import type { OrbShader } from './orbs'

/*
 * How a subagent's orb is drawn: a technique supplies the fragment shader (see orbs.ts) and its
 * tweakable params. Every technique reads the same per-orb record: where it is, its colour, its
 * state weights (running, done, failed, waiting, crossfading after a change), a brief flash as a run
 * finishes, hover, open (its frame expanded), a slow breath while it waits, and its own clock, which
 * only runs while it works (so done and failed orbs are still). Nothing here moves on wall time:
 * reduced motion freezes every clock at a pose.
 *
 * The app draws Glass orbs; the playground (playground/subagents) compares it with the others.
 */

export interface Technique {
	id: string
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

/** The params every technique starts with: size, spacing, speed and colour. */
export const common = (s: number, sp: number, c: 'parent' | 'own' = 'parent', sizeMin = 6, sizeMax = 28) => [size(s, sizeMin, sizeMax), spacing(sp), SPEED, colour(c)]

/** A square quad: k radii round the centre, plus room for the open ring. */
export const around =
	(k: number) =>
	(_p: ParamValues, r: number, dpr: number): [number, number, number, number] => {
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

export const GLASS_TECHNIQUE: Technique = {
	id: 'glass',
	name: 'Glass orbs',
	note: 'A tiny glass sphere with Fresnel rim light and a soft highlight; domain-warped noise swirls inside while it works and stills once it’s done.',
	params: [...common(12, 19), range('rim', 'Rim light', 0.7, 0, 1.5, 0.05), range('spec', 'Highlight', 0.75, 0, 1.5, 0.05), range('scale', 'Noise scale', 1.1, 0.4, 4, 0.05), range('glow', 'Glow', 1, 0, 2, 0.05)],
	row: false,
	reach: around(1.8),
	anchor: 'centre',
	still: 3.1,
	glsl: GLASS,
}

const shaders = new Map<string, OrbShader>()

export function shaderOf(t: Technique): OrbShader {
	let s = shaders.get(t.id)
	if (!s) shaders.set(t.id, (s = { id: t.id, glsl: t.glsl, row: t.row, defines: glslDefines(t.params) }))
	return s
}
