import{a as dt,s as pt,L as Pe}from"./layout-D5wn9ku6.js";const s=(e,a,t,n,o,r,i)=>({key:e,label:a,type:"range",value:t,min:n,max:o,step:r,unit:i}),w=(e,a,t)=>({key:e,label:a,type:"toggle",value:t}),ut=(e,a,t)=>({key:e,label:a,type:"color",value:t}),D=(e,a,t,n)=>({key:e,label:a,type:"select",options:t,value:n}),y=s("speed","Speed",1,0,3,.05,"×");function A(e,a){const t={};for(const n of e){const o=a?.[n.key];n.type==="range"?t[n.key]=typeof o=="number"&&isFinite(o)?Math.min(n.max,Math.max(n.min,o)):n.value:n.type==="toggle"?t[n.key]=typeof o=="boolean"?o:n.value:n.type==="color"?t[n.key]=typeof o=="string"&&/^#[0-9a-f]{6}$/i.test(o)?o:n.value:t[n.key]=typeof o=="string"&&n.options.includes(o)?o:n.value}return t}function Y(e,a){const t={};for(const n of e)a[n.key]!==n.value&&(t[n.key]=a[n.key]);return t}function fe(e){const a=parseInt(e.slice(1),16);return[(a>>16&255)/255,(a>>8&255)/255,(a&255)/255]}function Be(e){return e.type==="color"?3:1}function ht(e){let a=0;const t=[];for(const n of e)n.type==="color"?t.push(`#define P_${n.key} vec3(u_p[${a}], u_p[${a+1}], u_p[${a+2}])`):t.push(`#define P_${n.key} u_p[${a}]`),a+=Be(n);return t.join(`
`)}function mt(e,a,t){let n=0;for(const o of e){const r=a[o.key];o.type==="color"?t.set(fe(r),n):o.type==="toggle"?t[n]=r?1:0:o.type==="select"?t[n]=Math.max(0,o.options.indexOf(r)):t[n]=r,n+=Be(o)}}const Ae=["sine","smooth","inhale","expo"],gt=`
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
`,E=[{id:"breathe",name:"Breath",blurb:"The outline takes the session colour and slowly breathes: opacity and width swell, with a faint halo at the peak.",params:[y,s("period","Period",3.6,1,10,.1,"s"),D("easing","Easing",Ae,"inhale"),s("width","Width",1.25,.5,4,.05,"px"),s("swell","Swell",.75,0,4,.05,"px"),s("minA","Low",.16,0,1,.01),s("maxA","High",.7,0,1,.01),s("halo","Halo radius",12,0,48,.5,"px"),s("haloA","Halo",.2,0,1,.01),s("whiten","Whiten at peak",.2,0,1,.01)],glsl:`
vec4 effect(Fx f) {
  float e = breath(fract(f.t / P_period), P_easing);
  float w = (P_width + P_swell * e) * f.k;
  float line = ring(f, w) * mix(P_minA, P_maxA, e);
  float halo = glowOut(f, f.dpx - w, P_halo * f.k * (0.6 + 0.4 * e)) * P_haloA * e;
  return lit(hi(f.col, P_whiten * e), line + halo * (1.0 - line));
}`},{id:"orbit",name:"Travelling light",blurb:"One soft highlight orbits the outline at constant speed (arc-length parameterised, so it never rushes the corners).",params:[y,s("period","Lap time",4.5,1,16,.1,"s"),s("length","Tail length",.22,.03,.7,.01,"× perimeter"),s("falloff","Tail falloff",1.6,.4,5,.05),s("width","Width",1.5,.5,4,.05,"px"),s("glow","Glow radius",10,0,40,.5,"px"),s("glowA","Glow",.35,0,1,.01),s("intensity","Intensity",.9,0,1,.01),s("base","Resting ring",.1,0,.6,.01),s("whiten","Hot head",.35,0,1,.01),w("clockwise","Clockwise",!0)],glsl:`
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
}`},{id:"comets",name:"Twin comets",blurb:"Two short comets run in opposite directions and meet at the top and bottom centre, where they bloom briefly.",params:[y,s("period","Lap time",6,1,16,.1,"s"),s("length","Tail length",.12,.02,.4,.01,"× perimeter"),s("width","Width",1.25,.5,4,.05,"px"),s("glow","Glow radius",8,0,40,.5,"px"),s("glowA","Glow",.3,0,1,.01),s("intensity","Intensity",.85,0,1,.01),s("bloom","Meeting bloom",.55,0,1,.01),s("whiten","Hot heads",.3,0,1,.01)],glsl:`
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
}`},{id:"tide",name:"Inner tide",reach:400,blurb:"A soft light rises inward from the edges and recedes, uneven like water, with the outline tinted in time.",params:[y,s("period","Period",4.2,1,10,.1,"s"),D("easing","Easing",Ae,"sine"),s("depth","Depth",24,4,90,1,"px"),s("swell","Swell",16,0,60,1,"px"),s("intensity","Intensity",.24,0,.6,.005),s("edge","Outline",.32,0,1,.01),s("uneven","Unevenness",.4,0,1,.01),s("scale","Noise scale",2.2,.3,8,.1)],glsl:`
vec4 effect(Fx f) {
  float e = breath(fract(f.t / P_period), P_easing);
  float n = vnoise(vec3(circ(f.u) * P_scale, f.t * 0.15 + f.seed * 9.0));
  float depth = (P_depth + P_swell * e) * f.k * (1.0 + P_uneven * (n - 0.5) * 2.0);
  float x = max(-f.dpx, 0.0);
  float g = exp(-2.2 * x / max(depth, 1e-3)) * smoothstep(f.aa, -f.aa, f.dpx);
  float a = g * P_intensity * (0.5 + 0.5 * e) + ring(f, f.k) * P_edge * (0.45 + 0.55 * e);
  return lit(f.col, a);
}`},{id:"silk",name:"Silk shimmer",blurb:"A thin sheen of noise flows along the border, catching light here and there like silk thread.",params:[y,s("flow","Flow",1,0,4,.05),s("scale","Noise scale",7,1,24,.1),s("contrast","Contrast",2.6,.5,8,.1),s("width","Width",1.25,.5,4,.05,"px"),s("glow","Glow radius",5,0,30,.5,"px"),s("glowA","Glow",.3,0,1,.01),s("intensity","Intensity",.9,0,1,.01),s("base","Resting ring",.12,0,.6,.01),s("whiten","Sheen whiteness",.5,0,1,.01)],glsl:`
vec4 effect(Fx f) {
  float n = fbm(vec3(circ(f.u - f.t * P_flow * 0.035) * P_scale, f.t * 0.3));
  float sheen = pow(smoothstep(0.35, 0.85, n), P_contrast);
  float w = P_width * f.k;
  float core = ring(f, w);
  float glow = gauss(f.dpx - 0.5 * w, P_glow * f.k) * P_glowA;
  float a = (core + glow * (1.0 - core)) * sheen * P_intensity + core * P_base * (1.0 - sheen);
  return lit(mix(f.col, hi(f.col, P_whiten), sheen), a);
}`},{id:"march",name:"Marching dashes",blurb:"Quiet marching ants in the session colour: round-capped dashes, a whole number of them around the frame so the loop is seamless.",params:[y,s("dash","Dash spacing",12,3,48,.5,"px"),s("duty","Dash length",.5,.1,.95,.01,"× spacing"),s("rate","March",14,0,120,1,"px/s"),s("width","Width",1.5,.5,4,.05,"px"),s("opacity","Opacity",.55,0,1,.01),s("glow","Glow radius",4,0,24,.5,"px"),s("glowA","Glow",.12,0,1,.01),w("caps","Round caps",!0)],glsl:`
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
}`},{id:"aurora",name:"Aurora",blurb:"Low-frequency noise drifts the hue within the session colour along the edge, brightening and dimming like an aurora.",params:[y,s("flow","Flow",.6,0,3,.05),s("hueRange","Hue range",40,0,180,1,"°"),s("scale","Noise scale",1.6,.3,6,.05),s("width","Width",2,.5,6,.05,"px"),s("glow","Glow radius",16,0,50,.5,"px"),s("glowA","Glow",.4,0,1,.01),s("intensity","Intensity",.6,0,1,.01),w("useSecond","Blend a second colour",!1),ut("second","Second colour","#7dd3fc")],glsl:`
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
}`},{id:"heartbeat",name:"Heartbeat",blurb:"A double pulse (lub-dub) ripples outward from the border, then rests; the outline thumps with each beat.",params:[y,s("period","Period",2.6,1,6,.05,"s"),s("gap","Beat gap",.26,.1,.6,.01,"s"),s("second","Second beat",.65,0,1,.01),s("travel","Travel",22,4,80,1,"px"),s("ringW","Ripple width",2,.5,8,.1,"px"),s("decay","Decay",2.2,.5,5,.05),s("intensity","Ripple",.5,0,1,.01),s("edge","Outline thump",.4,0,1,.01)],glsl:`
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
}`},{id:"sweep",name:"Conic sweep",blurb:"A conic gradient turns around the frame centre, masked to the border: a lighthouse beam brushing the edge.",params:[y,s("period","Turn time",7,1,20,.1,"s"),s("arms","Arms",1,1,4,1),s("softness","Tail softness",2.2,.5,8,.05),s("width","Width",1.5,.5,4,.05,"px"),s("glow","Glow radius",8,0,40,.5,"px"),s("glowA","Glow",.3,0,1,.01),s("intensity","Intensity",.8,0,1,.01),s("base","Resting ring",.1,0,.6,.01),w("even","Even around the frame",!0)],glsl:`
vec4 effect(Fx f) {
  vec2 q = P_even > 0.5 ? f.p / f.b : f.p;
  float v = fract((atan(q.y, q.x) / TAU + 0.25) * P_arms - f.t / P_period);
  float g = pow(v, P_softness) * smoothstep(1.0, 0.985, v);
  float w = P_width * f.k;
  float core = ring(f, w);
  float glow = gauss(f.dpx - 0.5 * w, P_glow * f.k) * P_glowA;
  float a = (core + glow * (1.0 - core)) * g * P_intensity + core * P_base * (1.0 - g);
  return lit(mix(f.col, hi(f.col, 0.3), g * g), a);
}`},{id:"corners",reach:120,name:"Corner gather",blurb:"Light gathers at each corner in turn, converging from a wide dim spread to a bright point, then hands off to the next.",params:[y,s("period","Cycle",4.8,1,16,.1,"s"),s("spread","Spread",70,10,300,1,"px"),s("overlap","Hold",.45,.1,1,.01,"× cycle"),s("width","Width",1.5,.5,4,.05,"px"),s("glow","Glow radius",12,0,40,.5,"px"),s("glowA","Glow",.35,0,1,.01),s("intensity","Intensity",.9,0,1,.01),w("clockwise","Clockwise",!0)],glsl:`
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
}`}],wt=20,xt=6,Le=.035,Ee=.06,bt=.06,yt=new Set(["spread","dash","depth","swell","length"]);function vt(e){let a=12;for(const t of e.edge.params)t.type!=="range"||t.unit!=="px"||yt.has(t.key)||(a=Math.max(a,e.values[t.key]*(t.key==="travel"?1.3:2.4)));return e.edge.id==="heartbeat"&&(a+=3*e.values.ringW*3),8+Math.max(a,e.doneParams[3]?e.doneParams[1]*1.3+20:0)}const _t=`#version 300 es
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
}`;function kt(e){return`#version 300 es
precision highp float;
in vec2 v_p;
out vec4 o;
uniform vec4 u_rect;
uniform vec4 u_cam;
uniform vec3 u_col;
uniform float u_work, u_done, u_seed, u_t, u_k, u_reduced, u_reach;
uniform vec4 u_doneP;
uniform float u_p[32];
${gt}
${ht(e.params)}
${e.glsl}

// Reduced motion: no movement, just a steady tinted outline.
vec4 still(Fx f) {
  float core = ring(f, 1.25 * f.k);
  float g = glowOut(f, f.dpx - 1.25 * f.k, 8.0 * f.k) * 0.12;
  return lit(f.col, core * 0.55 + g * (1.0 - core));
}

void main() {
  Fx f;
  f.b = 0.5 * u_rect.zw;
  f.r = min(${wt.toFixed(1)}, min(f.b.x, f.b.y));
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
  vec4 col = vec4(vec3(${Le}), ${Le}) * inner + vec4(vec3(${Ee}), ${Ee}) * (outer - inner);

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
}`}const Pt=`#version 300 es
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
}`,At=`#version 300 es
precision highp float;
in vec2 v_p;
in vec2 v_b;
uniform vec4 u_cam;
out vec4 o;
void main() {
  float r = min(${xt.toFixed(1)} * u_cam.z, min(v_b.x, v_b.y));
  vec2 q = abs(v_p) - v_b + r;
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  float a = clamp(0.5 - d * u_cam.w, 0.0, 1.0) * ${bt};
  o = vec4(vec3(a), a);
}`;class Lt{constructor(a){this.canvas=a;const t=a.getContext("webgl2",{antialias:!1,premultipliedAlpha:!0,alpha:!1});if(!t)throw new Error("WebGL2 is not available");this.gl=t,this.quad=t.createBuffer(),t.bindBuffer(t.ARRAY_BUFFER,this.quad),t.bufferData(t.ARRAY_BUFFER,new Float32Array([0,0,1,0,0,1,0,1,1,0,1,1]),t.STATIC_DRAW),this.instances=t.createBuffer();const n=Se(t,Pt,At);this.item={program:n,cam:t.getUniformLocation(n,"u_cam"),view:t.getUniformLocation(n,"u_view")},this.frameVao=t.createVertexArray(),t.bindVertexArray(this.frameVao),t.bindBuffer(t.ARRAY_BUFFER,this.quad),t.enableVertexAttribArray(0),t.vertexAttribPointer(0,2,t.FLOAT,!1,0,0),this.itemVao=t.createVertexArray(),t.bindVertexArray(this.itemVao);const o=t.getAttribLocation(n,"a_c"),r=t.getAttribLocation(n,"a_r");t.bindBuffer(t.ARRAY_BUFFER,this.quad),t.enableVertexAttribArray(o),t.vertexAttribPointer(o,2,t.FLOAT,!1,0,0),t.bindBuffer(t.ARRAY_BUFFER,this.instances),t.enableVertexAttribArray(r),t.vertexAttribPointer(r,4,t.FLOAT,!1,0,0),t.vertexAttribDivisor(r,1),t.bindVertexArray(null)}canvas;gl;programs=new Map;item;quad;instances;frameVao;itemVao;instanceData=new Float32Array(0);prepare(a){let t=this.programs.get(a.id);if(t)return t;const n=this.gl,o=Se(n,_t,kt(a),i=>n.bindAttribLocation(i,0,"a_c"));return t={program:o,u:Object.fromEntries(["u_rect","u_cam","u_view","u_margin","u_col","u_work","u_done","u_seed","u_t","u_k","u_reduced","u_reach","u_doneP","u_p"].map(i=>[i,n.getUniformLocation(o,i)]))},this.programs.set(a.id,t),t}draw(a){const{gl:t,canvas:n}=this,{camera:o,dpr:r}=a,i=Math.max(1,Math.round(a.width*r)),f=Math.max(1,Math.round(a.height*r));(n.width!==i||n.height!==f)&&(n.width=i,n.height=f),t.viewport(0,0,i,f),t.clearColor(.067,.067,.075,1),t.clear(t.COLOR_BUFFER_BIT),t.enable(t.BLEND),t.blendFunc(t.ONE,t.ONE_MINUS_SRC_ALPHA);const d=[o.x,o.y,o.z,r],m=a.pageUnits?o.z:1,p=this.prepare(a.edge);t.useProgram(p.program),t.bindVertexArray(this.frameVao),t.uniform4f(p.u.u_cam,...d),t.uniform2f(p.u.u_view,a.width,a.height);const g=vt(a)*m/o.z;t.uniform1f(p.u.u_margin,g),t.uniform1f(p.u.u_t,a.time),t.uniform1f(p.u.u_k,m),t.uniform1f(p.u.u_reduced,a.reduced?1:0),t.uniform1f(p.u.u_reach,a.edge.reach??80),t.uniform4f(p.u.u_doneP,...a.doneParams),t.uniform1fv(p.u.u_p,a.params);const v={x:-o.x/o.z,y:-o.y/o.z,w:a.width/o.z,h:a.height/o.z};for(const x of a.frames){const b=x.box;b.x-g>v.x+v.w||b.x+b.w+g<v.x||b.y-g>v.y+v.h||b.y+b.h+g<v.y||(t.uniform4f(p.u.u_rect,b.x,b.y,b.w,b.h),t.uniform3f(p.u.u_col,...x.color),t.uniform1f(p.u.u_work,x.work),t.uniform1f(p.u.u_done,x.done),t.uniform1f(p.u.u_seed,x.seed),t.drawArrays(t.TRIANGLES,0,6))}this.instanceData.length<a.items.length*4&&(this.instanceData=new Float32Array(a.items.length*4)),a.items.forEach((x,b)=>this.instanceData.set([x.x,x.y,x.w,x.h],b*4)),t.useProgram(this.item.program),t.bindVertexArray(this.itemVao),t.bindBuffer(t.ARRAY_BUFFER,this.instances),t.bufferData(t.ARRAY_BUFFER,this.instanceData.subarray(0,a.items.length*4),t.DYNAMIC_DRAW),t.uniform4f(this.item.cam,...d),t.uniform2f(this.item.view,a.width,a.height),t.drawArraysInstanced(t.TRIANGLES,0,6,a.items.length),t.bindVertexArray(null)}}function Se(e,a,t,n){const o=e.createProgram();for(const[r,i]of[[e.VERTEX_SHADER,a],[e.FRAGMENT_SHADER,t]]){const f=e.createShader(r);if(e.shaderSource(f,i),e.compileShader(f),!e.getShaderParameter(f,e.COMPILE_STATUS)){const d=e.getShaderInfoLog(f),m=i.split(`
`).map((p,g)=>`${g+1}: ${p}`).join(`
`);throw new Error(`shader compile failed: ${d}
${m}`)}e.attachShader(o,f)}if(n?.(o),e.linkProgram(o),!e.getProgramParameter(o,e.LINK_STATUS))throw new Error(`link failed: ${e.getProgramInfoLog(o)}`);return o}function u(e,a="",t=[]){const n=document.createElement(e);a&&(n.className=a);for(const o of t)n.append(o);return n}function P(e,a,t){let n=e.querySelector(`:scope > .${a}`);return n||e.appendChild(n=t()),n}function U(e,a,t){const n=[...e.children].filter(o=>o.classList.contains("u")&&!o.classList.contains("out"));for(;n.length<a;){const o=t(n.length);o.classList.add("u"),o.style.setProperty("--i",String(n.length)),e.appendChild(o),requestAnimationFrame(()=>requestAnimationFrame(()=>o.classList.add("in"))),n.push(o)}for(;n.length>a;){const o=n.pop();o.classList.remove("in"),o.classList.add("out"),setTimeout(()=>o.remove(),450)}return n}function Me(e,a,t){const n=P(e,"more",()=>u("span","more")),o=a>t?`+${a-t}`:"";n.textContent!==o&&o&&(n.textContent=o),n.classList.toggle("on",a>t)}const Ce=(e,a=0)=>{const t=Math.sin((e+1)*12.9898+a*78.233)*43758.5453;return t-Math.floor(t)},Et=["braille","orbit","arc","pulse"],R=[{id:"dots",name:"Pulse dots",blurb:"One dot per subagent after the title, each breathing softly out of phase, like a row of quiet LEDs.",params:[y,s("period","Period",1.8,.6,5,.05,"s"),s("phase","Phase step",.22,0,1,.01,"s"),s("size","Dot size",.16,.08,.3,.005,"em"),s("gap","Gap",.12,.02,.4,.005,"em"),s("lo","Low opacity",.28,0,1,.01),s("max","Max dots",6,1,8,1),w("glow","Glow",!0)],render(e,a,t){const n=P(e.after,"dots",()=>u("span","dots")),o=Math.min(a,t.max);U(n,o,()=>u("span","dot",[u("i")])),Me(e.after,a,o)}},{id:"pill",name:"Counter pill",blurb:"A small tinted pill with the count and a fine ring spinner; the number bumps when it changes.",params:[y,s("period","Spin time",1.1,.3,4,.05,"s"),s("arc","Arc length",28,8,80,1,"%"),s("fill","Pill tint",14,0,40,1,"%"),s("fs","Size",.5,.35,.8,.01,"em"),w("ring","Ring spinner",!0),w("outline","Outline",!0)],render(e,a){const t=P(e.after,"pill",()=>{const r="http://www.w3.org/2000/svg",i=document.createElementNS(r,"svg");i.setAttribute("viewBox","0 0 20 20"),i.setAttribute("class","ring");for(const f of["track","arc"]){const d=document.createElementNS(r,"circle");d.setAttribute("cx","10"),d.setAttribute("cy","10"),d.setAttribute("r","7.5"),d.setAttribute("pathLength","100"),d.setAttribute("class",f),i.appendChild(d)}return u("span","pill",[i,u("span","num")])}),n=t.querySelector(".num"),o=String(Math.max(a,1));if(a>0&&n.textContent!==o){const r=n.textContent!=="";n.textContent=o,r&&(t.classList.remove("bump"),t.offsetWidth,t.classList.add("bump"))}}},{id:"sheen",name:"Title sheen",blurb:"The title itself carries a slow light sweep in the session colour while subagents run, with a quiet count beside it.",params:[y,s("period","Sweep time",3.2,1,8,.05,"s"),s("w","Band width",12,3,30,.5,"%"),s("strength","Strength",85,10,100,1,"%"),w("count","Show count",!0),w("faster","Faster with more agents",!0)],render(e,a,t){const n=P(e.after,"count",()=>u("span","count"));a>0&&(n.textContent=`${a}`),e.root.style.setProperty("--per",t.faster?String(1+Math.min(a,8)*.12):"1")}},{id:"orbit",name:"Orbiting moons",blurb:"A small session-coloured glyph before the title with one tiny moon per subagent circling it; moons re-space smoothly as the count changes.",params:[y,s("period","Orbit time",3.2,.8,10,.05,"s"),s("r","Orbit radius",.3,.15,.45,.005,"em"),s("moon","Moon size",.1,.04,.18,.005,"em"),s("core","Core size",.16,.06,.3,.005,"em"),w("track","Show orbit",!0),w("twinkle","Twinkle",!0)],render(e,a){const n=P(e.before,"orb",()=>u("span","orb",[u("span","track"),u("span","core"),u("span","moons")])).querySelector(".moons");n.style.setProperty("--n",String(Math.max(a,1))),U(n,Math.min(a,8),()=>u("span","moon",[u("i")])).forEach((r,i)=>r.style.setProperty("--i",String(i)))}},{id:"scanner",name:"Split underline",blurb:"A hairline under the title splits into one segment per subagent; light runs through them like a scanner or fills them like progress.",params:[y,s("period","Pass time",2.2,.6,6,.05,"s"),D("mode","Mode",["scan","fill","pulse"],"scan"),s("th","Thickness",.06,.02,.15,.005,"em"),s("gap","Segment gap",.14,.02,.5,.01,"em"),s("off","Offset",.02,-.1,.25,.005,"em"),s("rest","Resting tint",22,0,60,1,"%")],render(e,a){const t=P(e.under,"segs",()=>u("span","segs"));t.style.setProperty("--n",String(Math.max(a,1))),U(t,a,()=>u("span","seg",[u("i")])).forEach((o,r)=>o.style.setProperty("--i",String(r)))}},{id:"eq",name:"Equaliser",blurb:"Tiny bars after the title, one per subagent, bouncing at their own tempo: the frame looks busy in proportion to the work.",params:[y,s("period","Tempo",1.1,.4,3,.05,"s"),s("bw","Bar width",.09,.03,.16,.005,"em"),s("bg","Bar gap",.06,.02,.2,.005,"em"),s("bh","Max height",.56,.2,.9,.01,"em"),s("lo","Rest height",.22,.05,.8,.01),w("fade","Fade by height",!0)],render(e,a){const t=P(e.after,"eq",()=>u("span","eq"));U(t,a,n=>{const o=u("span","bar",[u("i")]);return o.style.setProperty("--j",(.7+Ce(n)*.7).toFixed(3)),o.style.setProperty("--k",(-Ce(n,1)).toFixed(3)),o})}},{id:"rolling",name:"Rolling count",blurb:'A quiet "· 3 agents" suffix in muted text; the digit rolls like an odometer when the count changes, with a small live dot.',params:[y,s("roll","Roll time",.55,.15,1.5,.01,"s"),s("fs","Size",.5,.35,.8,.01,"em"),D("word","Word",["agents","subagents","helpers","none"],"agents"),D("sep","Separator",["·","—","/","none"],"·"),w("live","Live dot",!0),s("period","Live dot pulse",1.6,.5,4,.05,"s")],render(e,a,t){const n=P(e.after,"agents",()=>u("span","agents",[u("span","sep"),u("span","live"),u("span","digits"),u("span","word")])),[o,,r,i]=n.children;o.textContent=t.sep==="none"?"":t.sep,o.hidden=t.sep==="none";const f=Math.max(a,1),d=String(f);for(;r.children.length<d.length;){const p=u("span","col");for(let g=0;g<=9;g++)p.appendChild(u("span","",[String(g)]));r.appendChild(p)}for(;r.children.length>d.length;)r.lastElementChild.remove();[...r.children].forEach((p,g)=>p.style.setProperty("--d",d[g]));const m=t.word;i.textContent=m==="none"?"":f===1?m.replace(/s$/,""):m,i.hidden=m==="none"}},{id:"stack",name:"Agent stack",blurb:"Overlapping little discs, one per subagent like an avatar stack, in tints of the session colour; a slow wave rolls through them.",params:[y,s("period","Wave time",2.4,.8,6,.05,"s"),s("size","Disc size",.42,.18,.6,.005,"em"),s("overlap","Overlap",.3,0,.7,.01),s("lift","Wave lift",.06,0,.2,.005,"em"),s("max","Max discs",5,1,8,1),w("rings","Rings",!0)],render(e,a,t){const n=P(e.after,"stack",()=>u("span","stack")),o=Math.min(a,t.max);U(n,o,r=>{const i=u("span","av",[u("i")]);return i.style.setProperty("--tone",String(Math.round(100-r*37%55))),i}),Me(e.after,a,o)}},{id:"braille",name:"Braille spinners",blurb:"Terminal-flavoured: one tiny Braille spinner glyph per subagent, each a step out of phase, as text beside the title.",params:[y,s("period","Cycle",1,.3,3,.05,"s"),D("set","Glyphs",Et,"braille"),s("fs","Size",.7,.35,1,.01,"em"),s("phase","Phase step",.13,0,.5,.01,"s"),w("perAgent","One per agent",!0),w("count","Show count",!1)],render(e,a,t){const n=P(e.after,"spins",()=>u("span","spins"));U(n,t.perAgent?Math.min(a,8):Math.min(a,1),()=>u("span","spin"));const o=P(e.after,"count",()=>u("span","count"));a>0&&(o.textContent=String(a))}}];function St(e,a,t){for(const n of a.params){const o=t[n.key];n.type==="range"?e.style.setProperty(`--${n.key}`,`${o}${n.unit==="%"||n.unit==="em"||n.unit==="s"?n.unit:""}`):n.type==="color"?e.style.setProperty(`--${n.key}`,o):n.type==="toggle"?e.classList.toggle(`p-${n.key}`,!!o):e.dataset[n.key]=o}}function Ne(e){const a=u("div","pg-hdr"),t=u("span","pg-before"),n=u("span","title",[e]),o=u("span","pg-under"),r=u("span","pg-after");return a.append(t,u("span","pg-tw",[n,o]),r),{root:a,before:t,title:n,under:o,after:r}}function Mt(e){for(const a of[e.before,e.under,e.after])a.replaceChildren();e.root.className="pg-hdr",e.root.removeAttribute("style");for(const a of Object.keys(e.root.dataset))delete e.root.dataset[a]}const O=["#f472b6","#a78bfa","#fb923c","#4ade80","#facc15","#f87171","#60a5fa","#2dd4bf","#e879f9","#a3e635"],oe=[{title:"Canvas build: coordinator",color:O[6],working:!0,subagents:3,groups:[{name:"Frame status playground",aspects:[1.6,1.33,1.78]},{name:"Earlier sketches",aspects:[1,.75,1.5,1.2]}]},{title:"Shader study: rounded SDF",color:O[1],working:!0,subagents:0,groups:[{name:null,aspects:[1.33,1,1.5,.8,1.78]}]},{title:"Onboarding copy pass",color:O[3],working:!1,subagents:0,groups:[{name:"Welcome screens",aspects:[.62,.62,.62]}]},{title:"Landing hero explorations",color:O[0],working:!0,subagents:8,groups:[{name:"Round 2",aspects:[1.78,1.78]},{name:"Round 1",aspects:[1.5,1.33,1,1.6]}]},{title:"Fix flaky upload test",color:O[2],working:!1,subagents:1,groups:[{name:null,aspects:[2.2,1.6]}]},{title:"Perf: video pool",color:O[7],working:!0,subagents:5,groups:[{name:"Traces",aspects:[2.4,1.78,1.2]}]}];function Ct(){return oe.map((e,a)=>({id:`s${a}`,title:e.title,color:e.color,working:e.working,subagents:e.subagents}))}const J=3,Rt=220;function zt(e){const a={},t={};e.forEach((r,i)=>{a[r.id]={id:r.id,canvasId:"playground",title:r.title,createdAt:i};const f=oe[i%oe.length];let d=1e3;f.groups.forEach((m,p)=>m.aspects.forEach((g,v)=>{const x=`${r.id}-${p}-${v}`;t[x]={id:x,canvasId:"playground",sessionId:r.id,kind:"image",name:x,src:"",thumb:"",width:Math.round(800*g),height:800,group:m.name??void 0,createdAt:d--}}))});let n=dt(a,t,e.map(r=>r.id)),o=0;for(let r=0;r*J<n.sections.length;r++){const i=n.sections.slice(r*J,r*J+J),f=i[0].box.x;for(const d of i)n=pt(n,d.id,-f,o);o+=Math.max(...i.map(d=>d.box.h))+Rt}return n}const X=[w("enabled","Flash when work finishes",!0),s("duration","Duration",1.5,.4,4,.05,"s"),s("distance","Ring travel",26,0,80,1,"px"),s("intensity","Intensity",.85,0,1,.01)],Z=[w("reduced","Preview reduced motion",matchMedia("(prefers-reduced-motion: reduce)").matches),w("pageUnits","Effect widths in page units (scale with zoom)",!1),w("desync","Desynchronise frames",!0),w("simulate","Simulate activity (random state changes)",!1),D("wheel","Scroll wheel",["zoom","pan"],"zoom")],We="canvas-playground-v1";function Ft(){let e={};try{e=JSON.parse(localStorage.getItem(We)??"{}")}catch{}const a={edge:E.some(t=>t.id===e.edge)?e.edge:E[1].id,header:R.some(t=>t.id===e.header)?e.header:R[0].id,edgeParams:Object.fromEntries(E.map(t=>[t.id,A(t.params,e.edgeParams?.[t.id])])),headerParams:Object.fromEntries(R.map(t=>[t.id,A(t.params,e.headerParams?.[t.id])])),done:A(X,e.done),global:A(Z,e.global),frames:Ct()};Array.isArray(e.frames)&&(a.frames=Re(a.frames,e.frames));try{const t=/[#&]s=([^&]+)/.exec(location.hash);if(t){const n=JSON.parse(decodeURIComponent(t[1]));E.some(i=>i.id===n.e)&&(a.edge=n.e),R.some(i=>i.id===n.h)&&(a.header=n.h);const o=E.find(i=>i.id===a.edge),r=R.find(i=>i.id===a.header);n.ep&&(a.edgeParams[o.id]=A(o.params,n.ep)),n.hp&&(a.headerParams[r.id]=A(r.params,n.hp)),n.d&&(a.done=A(X,n.d)),n.g&&(a.global=A(Z,{...a.global,...n.g})),Array.isArray(n.f)&&(a.frames=Re(a.frames,n.f.map(([i,f,d])=>({working:!!i,subagents:f,color:d}))))}}catch(t){console.warn("ignoring an unreadable settings hash",t)}return a}function Re(e,a){return e.map((t,n)=>{const o=a[n]??{};return{...t,working:typeof o.working=="boolean"?o.working:t.working,subagents:typeof o.subagents=="number"?Math.max(0,Math.min(8,Math.round(o.subagents))):t.subagents,color:typeof o.color=="string"&&/^#[0-9a-f]{6}$/i.test(o.color)?o.color:t.color}})}const c=Ft(),F=()=>E.find(e=>e.id===c.edge),N=()=>R.find(e=>e.id===c.header),Q=()=>c.edgeParams[c.edge],H=()=>c.headerParams[c.header];function Ge(){const e=F(),a=N();return{edge:{id:e.id,name:e.name,params:Q()},header:{id:a.id,name:a.name,params:H()},done:c.done,pageUnits:c.global.pageUnits,desync:c.global.desync}}window.playgroundSettings=Ge;let ze=0;function k(){clearTimeout(ze),ze=window.setTimeout(()=>{localStorage.setItem(We,JSON.stringify(c));const e={e:c.edge,h:c.header,ep:Y(F().params,Q()),hp:Y(N().params,H()),d:Y(X,c.done),g:Y(Z,c.global),f:c.frames.map(a=>[a.working?1:0,a.subagents,a.color])};history.replaceState(null,"",`#s=${encodeURIComponent(JSON.stringify(e))}`)},150)}function l(e,a={},...t){const n=document.createElement(e),{class:o,...r}=a;return o&&(n.className=o),Object.assign(n,r),n.append(...t),n}const qt=document.getElementById("pg"),_=l("div",{class:"pg-demo"}),Ve=l("canvas",{class:"pg-canvas"}),se=l("div",{class:"pg-overlay"}),He=l("div",{class:"pg-hud"}),re=l("span",{class:"pg-fps"}),je=l("span",{class:"pg-zoom"}),Ye=l("button",{class:"pg-btn",textContent:"Fit",title:"Zoom to fit all frames"}),Je=l("button",{class:"pg-btn",textContent:"100%",title:"Zoom to 100% around the centre"});He.append(re,je,Je,Ye);_.append(Ve,se,He,l("div",{class:"pg-hint",textContent:"Scroll or pinch to zoom · drag to pan · ←/→ edge · ↑/↓ header"}));const de=l("div",{class:"pg-specimens"}),Ke=[];for(const e of[0,1,3,8]){const a=Ne("Canvas build: coordinator"),t=l("div",{class:"pg-spec"},l("div",{class:"pg-spec-label",textContent:e===0?"no subagents":e===1?"1 subagent":`${e} subagents`}),l("div",{class:"pg-spec-frame"},a.root));de.append(t),Ke.push({n:e,slots:a})}const Tt=l("main",{class:"pg-main"},_,l("div",{class:"pg-spec-title",textContent:"Header at 0, 1, 3 and 8 subagents (first frame’s colour)"}),de),Xe=l("aside",{class:"pg-side"});qt.append(Tt,Xe);const Ze=l("div",{class:"pg-list"}),Qe=l("div",{class:"pg-params"}),et=l("div",{class:"pg-list"}),tt=l("div",{class:"pg-params"}),pe=l("div",{class:"pg-params"}),at=l("div",{class:"pg-params"}),nt=l("div",{class:"pg-states"}),K=l("button",{class:"pg-btn primary",textContent:"Copy settings"});function I(e,...a){return l("section",{class:"pg-section"},l("h2",{textContent:e}),...a)}function Fe(e){const a=l("button",{class:"pg-link",textContent:"Reset"});return a.addEventListener("click",e),a}Xe.append(l("header",{class:"pg-top"},l("h1",{textContent:"Frame status playground"}),K),I("Working · frame edge",Ze),I("Edge parameters",Qe,Fe(()=>{c.edgeParams[c.edge]=A(F().params,{}),he(),k()})),I("Subagents · title",et),I("Title parameters",tt,Fe(()=>{c.headerParams[c.header]=A(N().params,{}),me(),M(),k()})),I("Done flash (shared)",pe),I("Frames",nt),I("Preview",at));K.addEventListener("click",async()=>{const e=JSON.stringify(Ge(),null,2);try{await navigator.clipboard.writeText(e)}catch{const a=l("textarea",{value:e});document.body.append(a),a.select(),document.execCommand("copy"),a.remove()}console.log(e),K.textContent="Copied",setTimeout(()=>K.textContent="Copy settings",1200)});function ae(e,a){const t=e.step>=1?0:e.step>=.1?1:e.step>=.01?2:3;return`${a.toFixed(t)}${e.unit?(e.unit.startsWith("×")&&e.unit.length>1?" ":"")+e.unit:""}`}function ee(e,a,t){const n=l("label",{class:`pg-row pg-${e.type}`}),o=l("span",{class:"pg-name",textContent:e.label});if(e.type==="range"){const r=l("span",{class:"pg-value",textContent:ae(e,a[e.key])}),i=l("input",{type:"range",min:String(e.min),max:String(e.max),step:String(e.step),value:String(a[e.key])});i.dataset.key=e.key,i.addEventListener("input",()=>{a[e.key]=Number(i.value),r.textContent=ae(e,a[e.key]),t()}),i.addEventListener("dblclick",()=>{a[e.key]=e.value,i.value=String(e.value),r.textContent=ae(e,e.value),t()}),n.append(l("span",{class:"pg-line"},o,r),i)}else if(e.type==="color"){const r=l("input",{type:"color",value:a[e.key]});r.addEventListener("input",()=>{a[e.key]=r.value,t()}),n.append(o,r)}else if(e.type==="toggle"){const r=l("input",{type:"checkbox",checked:!!a[e.key]});r.dataset.key=e.key,r.addEventListener("change",()=>{a[e.key]=r.checked,t()}),n.append(r,l("span",{class:"pg-switch"}),o)}else{const r=l("span",{class:"pg-seg"});for(const i of e.options){const f=l("button",{type:"button",textContent:i,className:a[e.key]===i?"on":""});f.addEventListener("click",d=>{d.preventDefault(),a[e.key]=i;for(const m of r.children)m.classList.toggle("on",m===f);t()}),r.append(f)}n.append(o,r)}return n}function ue(){Ze.replaceChildren(...E.map((e,a)=>{const t=l("button",{class:`pg-item${e.id===c.edge?" on":""}`,title:e.blurb},l("span",{class:"pg-num",textContent:String(a+1)}),l("span",{class:"pg-item-name",textContent:e.name}));return t.dataset.edge=e.id,t.addEventListener("click",()=>ge(e.id)),t})),et.replaceChildren(...R.map((e,a)=>{const t=l("button",{class:`pg-item${e.id===c.header?" on":""}`,title:e.blurb},l("span",{class:"pg-num",textContent:String.fromCharCode(65+a)}),l("span",{class:"pg-item-name",textContent:e.name}));return t.dataset.header=e.id,t.addEventListener("click",()=>we(e.id)),t}))}function he(){const e=Q();Qe.replaceChildren(l("p",{class:"pg-blurb",textContent:F().blurb}),...F().params.map(a=>ee(a,e,k)))}function me(){const e=H();tt.replaceChildren(l("p",{class:"pg-blurb",textContent:N().blurb}),...N().params.map(a=>ee(a,e,()=>{M(),k()})))}function ge(e){c.edge=e;try{_e.prepare(F())}catch(a){console.error(a)}ue(),he(),k()}function we(e){c.header=e,ue(),me(),M(),k()}pe.append(...X.map(e=>ee(e,c.done,k)));const ot=l("button",{class:"pg-btn",textContent:"Flash all"});ot.addEventListener("click",()=>c.frames.forEach((e,a)=>te(a,!1)));pe.append(ot);at.append(...Z.map(e=>ee(e,c.global,()=>{st(),k()})));function st(){const e=!!c.global.reduced;_.classList.toggle("pg-reduced",e),de.classList.toggle("pg-reduced",e)}const B=c.frames.map(e=>e.working?1:0),ie=c.frames.map(()=>-1);let le=0;function te(e,a=!0){a&&(c.frames[e].working=!1,c.frames[e].subagents=0),ie[e]=le}function G(e,a){const t=c.frames[e];t.working&&!a&&te(e,!1),t.working=a}function j(){const e=c.frames.map((r,i)=>{const f=l("input",{type:"color",value:r.color,title:"Session colour"});f.addEventListener("input",()=>{r.color=f.value,M(),k()});const d=l("span",{class:"pg-seg"});for(const[v,x]of[["Idle",!1],["Working",!0]]){const b=l("button",{type:"button",textContent:v,className:r.working===x?"on":""});b.addEventListener("click",()=>{G(i,x),j(),k()}),d.append(b)}const m=l("button",{class:"pg-btn small",textContent:"Done",title:"Finish: stop working, clear subagents and flash"});m.addEventListener("click",()=>{te(i),j(),M(),k()});const p=l("span",{class:"pg-value",textContent:String(r.subagents)}),g=l("input",{type:"range",min:"0",max:"8",step:"1",value:String(r.subagents)});return g.dataset.frame=String(i),g.addEventListener("input",()=>{r.subagents=Number(g.value),p.textContent=String(r.subagents),M(),k()}),l("div",{class:"pg-state"},l("div",{class:"pg-line"},f,l("span",{class:"pg-state-title",textContent:r.title}),d,m),l("label",{class:"pg-line pg-sub"},l("span",{class:"pg-name",textContent:"Subagents"}),g,p))}),a=l("button",{class:"pg-btn",textContent:"Randomise states"});a.addEventListener("click",()=>{c.frames.forEach((r,i)=>{G(i,Math.random()<.65);const f=Math.random();r.subagents=f<.3?0:f<.55?1:Math.ceil(Math.random()*8)}),V()});const t=l("button",{class:"pg-btn",textContent:"All working"});t.addEventListener("click",()=>{c.frames.forEach((r,i)=>G(i,!0)),V()});const n=l("button",{class:"pg-btn",textContent:"All idle"});n.addEventListener("click",()=>{c.frames.forEach((r,i)=>{G(i,!1),r.subagents=0}),V()});const o=l("button",{class:"pg-btn",textContent:"Shuffle colours"});o.addEventListener("click",()=>{const r=[...O].sort(()=>Math.random()-.5);c.frames.forEach((i,f)=>i.color=r[f%r.length]),V()}),nt.replaceChildren(...e,l("div",{class:"pg-buttons"},a,t,n,o))}function V(){j(),M(),k()}const q=zt(c.frames),xe=[],rt=[];for(const e of q.sections){const a=l("div",{class:"pg-label"}),t=Ne(e.title);a.append(t.root),se.append(a),xe.push({outer:a,slots:t});for(const n of e.groups){if(!n.heading)continue;const o=l("div",{class:"pg-group"},l("span",{class:"name",textContent:n.name??""}));se.append(o),rt.push({el:o,box:n.heading})}}const qe=new WeakMap;function Te(e,a,t){const n=N();qe.get(e)!==n.id&&(Mt(e),e.root.classList.add(`hv-${n.id}`),qe.set(e,n.id)),e.root.style.setProperty("--c",t),e.root.style.setProperty("--c-hi",It(t,.45)),St(e.root,n,H()),e.root.classList.toggle("has-agents",a>0),n.render(e,a,H())}function M(){q.sections.forEach((e,a)=>Te(xe[a].slots,c.frames[a].subagents,c.frames[a].color));for(const e of Ke)Te(e.slots,e.n,c.frames[0].color)}function It(e,a){const[t,n,o]=fe(e).map(r=>Math.round((r+(1-r)*a)*255));return`rgb(${t}, ${n}, ${o})`}let z=!0;function Ot(){const{x:e,y:a,z:t}=h,n=Math.max(t,Pe.minFrameTitlePx/Pe.frameTitlePx),o=(r,i,f)=>{r.style.width=`${i.w*t/f}px`,r.style.height=`${i.h}px`,r.style.transform=`translate(${i.x*t+e}px, ${(i.y+i.h)*t+a-i.h}px) scale(${f})`};q.sections.forEach((r,i)=>o(xe[i].outer,r.header,n));for(const r of rt)o(r.el,r.box,t);je.textContent=`${Math.round(t*100)}%`}const $t=.02,Dt=8,h={x:0,y:0,z:.3};let S=null,T=1,C=1;function ce(e,a,t){t=Math.min(Dt,Math.max($t,t)),h.x=e-(e-h.x)*t/h.z,h.y=a-(a-h.y)*t/h.z,h.z=t,S=null,z=!0}function be(){const e=q.bounds,a=48,t=Math.min((T-a*2)/e.w,(C-a*2-30)/e.h,1);return{z:t,x:(T-e.w*t)/2-e.x*t,y:(C-e.h*t)/2-e.y*t+14}}function ye(e){S={from:{...h},to:e,start:performance.now()}}Ye.addEventListener("click",()=>ye(be()));Je.addEventListener("click",()=>{ye({z:1,x:T/2-(T/2-h.x)*1/h.z,y:C/2-(C/2-h.y)*1/h.z})});const L=new Map;let $=null;function ve(e){const a=_.getBoundingClientRect();return{x:e.clientX-a.left,y:e.clientY-a.top}}_.addEventListener("pointerdown",e=>{if(!e.target.closest("button")&&(_.setPointerCapture(e.pointerId),L.set(e.pointerId,ve(e)),S=null,_.classList.add("dragging"),L.size===2)){const[a,t]=[...L.values()];$={dist:Math.hypot(a.x-t.x,a.y-t.y),mx:(a.x+t.x)/2,my:(a.y+t.y)/2}}});_.addEventListener("pointermove",e=>{const a=L.get(e.pointerId);if(!a)return;const t=ve(e);if(L.set(e.pointerId,t),L.size>=2&&$){const[n,o]=[...L.values()],r=Math.hypot(n.x-o.x,n.y-o.y),i=(n.x+o.x)/2,f=(n.y+o.y)/2;h.x+=i-$.mx,h.y+=f-$.my,ce(i,f,h.z*r/$.dist),$={dist:r,mx:i,my:f}}else h.x+=t.x-a.x,h.y+=t.y-a.y,z=!0});const it=e=>{L.delete(e.pointerId),L.size<2&&($=null),L.size||_.classList.remove("dragging")};_.addEventListener("pointerup",it);_.addEventListener("pointercancel",it);_.addEventListener("wheel",e=>{e.preventDefault();const a=ve(e),t=e.deltaMode===1?16:e.deltaMode===2?C:1,n=e.deltaX*t,o=e.deltaY*t;e.ctrlKey||e.metaKey?ce(a.x,a.y,h.z*Math.exp(-Math.max(-50,Math.min(50,o||n))*.01)):c.global.wheel==="zoom"?ce(a.x,a.y,h.z*Math.exp(-Math.max(-120,Math.min(120,o))*.0022)):(h.x-=n,h.y-=o,S=null,z=!0)},{passive:!1});window.addEventListener("keydown",e=>{if(e.target.closest("input, textarea, select"))return;const a=(t,n,o)=>t[(t.findIndex(r=>r.id===n)+o+t.length)%t.length].id;if(e.key==="ArrowRight"||e.key==="ArrowLeft")ge(a(E,c.edge,e.key==="ArrowRight"?1:-1));else if(e.key==="ArrowDown"||e.key==="ArrowUp")we(a(R,c.header,e.key==="ArrowDown"?1:-1));else if(e.key==="f")ye(be());else return;e.preventDefault()});const _e=new Lt(Ve),Ie=new Float32Array(32);let Oe=0,$e=performance.now();const W=[];let De=0,ne=2,Ue=!0;new ResizeObserver(()=>{const e=_.getBoundingClientRect();T=e.width,C=e.height,Ue&&(Object.assign(h,be()),Ue=!1),z=!0}).observe(_);function Ut(e){if(ne-=e,ne>0)return;ne=1.4+Math.random()*2.6;const a=Math.floor(Math.random()*c.frames.length),t=c.frames[a];Math.random()<.55?t.subagents=Math.max(0,Math.min(8,t.subagents+(Math.random()<.5?-1:1)*(1+Math.floor(Math.random()*2)))):t.working?te(a):G(a,!0),j(),M()}function lt(e){requestAnimationFrame(lt);const a=Math.min(100,e-$e);$e=e;const t=a/1e3;if(le+=t,W.push(a),W.length>90&&W.shift(),e-De>500){De=e;const f=W.reduce((d,m)=>d+m,0)/W.length;re.textContent=`${Math.round(1e3/f)} fps`,re.dataset.fps=String(1e3/f)}if(c.global.simulate&&Ut(t),S){const f=Math.min(1,(e-S.start)/420),d=1-Math.pow(1-f,3),{from:m,to:p}=S,g=m.z*Math.pow(p.z/m.z,d),v=T/2,x=C/2,b={x:(v-m.x)/m.z,y:(x-m.y)/m.z},ke={x:(v-p.x)/p.z,y:(x-p.y)/p.z},ct=b.x+(ke.x-b.x)*d,ft=b.y+(ke.y-b.y)*d;Object.assign(h,{z:g,x:v-ct*g,y:x-ft*g}),z=!0,f>=1&&(S=null)}z&&(Ot(),z=!1);const n=!!c.global.reduced,o=Q();n||(Oe+=t*o.speed);const r=q.sections.map((f,d)=>{const m=c.frames[d],p=m.working?1:0,g=p>B[d]?.35:.6;return B[d]+=(p-B[d])*(1-Math.exp(-t/g)),Math.abs(p-B[d])<.002&&(B[d]=p),{box:f.box,color:fe(m.color),work:B[d],done:ie[d]<0?-1:le-ie[d],seed:c.global.desync?d*.618034%1:0}});mt(F().params,o,Ie);const i=c.done;try{_e.draw({camera:h,width:T,height:C,dpr:Math.min(devicePixelRatio||1,2),frames:r,items:[...q.items.values()],edge:F(),params:Ie,time:Oe,pageUnits:!!c.global.pageUnits,reduced:n,doneParams:[i.duration,i.distance,i.intensity,i.enabled?1:0],values:o})}catch(f){console.error(f)}}window.playground={selectEdge:ge,selectHeader:we,settings:c,refreshFrames:V,focus(e,a,t=0,n=0){const o=q.sections[e].box;Object.assign(h,{z:a,x:T/2-(o.x+o.w/2+t)*a,y:C/2-(o.y+o.h/2+n)*a}),S=null,z=!0},frameScreenBox(e){const a=q.sections[e].box;return{x:a.x*h.z+h.x,y:a.y*h.z+h.y,w:a.w*h.z,h:a.h*h.z}}};st();ue();he();me();j();M();for(const e of E)_e.prepare(e);requestAnimationFrame(lt);
