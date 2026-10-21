import"./layout-D5wn9ku6.js";import{l as te,c as Te,b as j,p as Me,f as qe,d as Se,e as Be,s as ze}from"./shell-DIo1ov9H.js";import{S as pe,r as l,s as H,g as Ie,t as ae,v as Ue,p as De,o as Le,a as Ce,b as Oe,c as Ne,d as K,f as Ve,e as $e,h as le}from"./panels-B9gWL9Or.js";const Xe=`#version 300 es
layout(location = 0) in vec2 a_c;
layout(location = 1) in vec4 a_rect;
layout(location = 2) in vec4 a_col;
uniform vec2 u_size;
out vec4 v_col;
void main() {
  vec2 p = a_rect.xy + a_c * a_rect.zw;
  vec2 n = p / u_size * 2.0 - 1.0;
  gl_Position = vec4(n.x, -n.y, 0.0, 1.0);
  v_col = a_col;
}`,Ge=`#version 300 es
precision mediump float;
in vec4 v_col;
out vec4 o;
void main() { o = v_col; }`,O=8;class We{data=new Float32Array(O*4096);n=0;begin(){this.n=0}add(e,o,r,s,f,n,c,v){if(!(v<=.002||r<=0||s<=0)){if((this.n+1)*O>this.data.length){const a=new Float32Array(this.data.length*2);a.set(this.data),this.data=a}this.data.set([e,o,r,s,f*v,n*v,c*v,v],this.n*O),this.n++}}}class Ye{constructor(e){this.gl=e,this.program=te(e,Xe,Ge),this.uSize=e.getUniformLocation(this.program,"u_size");const o=e.createBuffer();e.bindBuffer(e.ARRAY_BUFFER,o),e.bufferData(e.ARRAY_BUFFER,new Float32Array([0,0,1,0,0,1,0,1,1,0,1,1]),e.STATIC_DRAW),this.vao=e.createVertexArray(),e.bindVertexArray(this.vao),e.enableVertexAttribArray(0),e.vertexAttribPointer(0,2,e.FLOAT,!1,0,0),this.buf=e.createBuffer(),e.bindBuffer(e.ARRAY_BUFFER,this.buf),e.enableVertexAttribArray(1),e.vertexAttribPointer(1,4,e.FLOAT,!1,O*4,0),e.vertexAttribDivisor(1,1),e.enableVertexAttribArray(2),e.vertexAttribPointer(2,4,e.FLOAT,!1,O*4,16),e.vertexAttribDivisor(2,1),e.bindVertexArray(null)}gl;program;uSize;vao;buf;draw(e){const{gl:o}=this;e.n&&(o.bindFramebuffer(o.FRAMEBUFFER,null),o.viewport(0,0,o.drawingBufferWidth,o.drawingBufferHeight),o.enable(o.BLEND),o.blendFunc(o.ONE,o.ONE_MINUS_SRC_ALPHA),o.useProgram(this.program),o.uniform2f(this.uSize,o.drawingBufferWidth,o.drawingBufferHeight),o.bindVertexArray(this.vao),o.bindBuffer(o.ARRAY_BUFFER,this.buf),o.bufferData(o.ARRAY_BUFFER,e.data.subarray(0,e.n*O),o.DYNAMIC_DRAW),o.drawArraysInstanced(o.TRIANGLES,0,6,e.n),o.bindVertexArray(null))}}function L(t,e=[]){return[pe,l("pitch","Grid pitch",t.pitch??4,2,12,1,"px"),l("dot","Dot size",t.dot??3,1,10,.5,"px"),H("shape","Dot shape",["round","square"],t.shape??"square"),H("mode","Mask",["brightness","halftone","dither"],t.mode??"brightness"),l("levels","Brightness steps",t.levels??0,0,8,1),l("base","Unlit dots",t.base??0,0,.3,.005),l("rim","Edge row",t.rim??.18,0,1,.01),l("modulate","Mask modulation",0,0,1,.01),l("scale","Noise size",t.scale??18,3,120,.5,"px"),l("warp","Warp",t.warp??1,0,3,.01),l("drift","Outward drift",t.drift??8,0,80,.5,"px/s"),l("depth","Band depth",t.depth??34,8,120,1,"px"),l("falloff","Falloff",t.falloff??.8,.2,4,.05),l("intensity","Intensity",t.intensity??1,0,3,.01),l("peak","Peak opacity",t.peak??.9,0,1,.01),H("color","Colour",["session","mesh"],t.color??"session"),...e]}const W=`
vec3 meshTint(Fx f, vec3 col) {
  if (P_color < 0.5) return col;
  float h = vnoise(around(f, 140.0, -6.0, f.t * 0.05)) - 0.5;
  return hueRotate(col, h * 1.4);
}`,je=[{id:"embers",name:"Ember clumps",note:"Tuned to look like Brian’s Brain, but continuous: two layers of fine noise crawl in opposite directions round the frame while drifting outward, and only their peaks light up, giving sparse bright clumps that thin out away from the edge and glide instead of stepping.",params:L({scale:9,drift:5,depth:34,falloff:1,mode:"brightness",levels:0,rim:.18},[l("crawl","Crawl",7,0,40,.5,"px/s"),l("sparse","Sparseness",.71,.4,.9,.005),l("dim","Dim clumps",.3,0,1,.01)]),still:4,glsl:`${W}
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
vec3 tint(Fx f, vec3 col, float v) { return meshTint(f, col); }`},{id:"smoke",name:"Smoke",note:"Slow domain-warped fbm (Inigo Quilez’s warping) sampled further inward as time passes, so soft tongues of smoke lift off every side and corner and dissolve as the falloff takes them; seen through 3px square dots as dithered speckle.",params:L({scale:16,warp:1.1,drift:7,depth:36,falloff:.9,mode:"dither",rim:.2}),still:3,glsl:`${W}
float field(Fx f) {
  vec3 q = outward(f, P_scale, P_drift, 0.12);
  vec3 w = vec3(fbm(q + vec3(0.0, 0.0, f.t * 0.07)), fbm(q + vec3(5.2, 1.3, 2.8)), 0.0);
  float n = fbm(q + P_warp * (w - 0.5) * 2.0);
  return smoothstep(0.42, 0.8, n) * f.fall;
}
vec3 tint(Fx f, vec3 col, float v) { return meshTint(f, col); }`},{id:"fire",name:"Fire",note:"Quicker licking tongues: noise stretched away from the edge rises fast and is cut by height (the classic noise-minus-height flame), so it is hot and dense at the base and frays into sparks; the base shifts warm.",params:L({scale:9,warp:.6,drift:26,depth:30,falloff:1,mode:"brightness",levels:0,rim:.3},[l("stretch","Tongue length",2.4,1,6,.05),l("warm","Warm shift",.45,0,1,.01)]),still:2,glsl:`
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
}`},{id:"mesh",name:"Mesh gradient",note:"Four large soft blobs of colour near the session hue orbit the frame at different speeds while the band breathes outward and back; brightness-masked dots turn the smooth mesh gradient into an LED glow.",params:L({depth:32,falloff:1.2,mode:"brightness",levels:0,rim:.15,color:"mesh",scale:30,intensity:1.1},[l("orbit","Orbit speed",.04,0,.3,.005),l("breathe","Breathing",.25,0,.8,.01)]),still:5,glsl:`
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
}`},{id:"ink",name:"Ink wisps",note:"Thin wisps rather than blobs: doubly warped noise folded into ridges (1 − |2n − 1|, sharpened), flowing along and away from the edge like ink in water; halftone dots grow along each filament.",params:L({scale:22,warp:1.6,drift:6,depth:40,falloff:.9,mode:"halftone",dot:3.5,shape:"round",rim:.15},[l("thin","Thinness",9,1,20,.1),l("flow","Flow along",5,-30,30,.5,"px/s")]),still:6,glsl:`${W}
float field(Fx f) {
  vec3 q = around(f, P_scale, P_flow, (f.d - f.t * P_drift) / P_scale);
  vec3 w1 = vec3(fbm(q + vec3(0.0, 0.0, f.t * 0.05)), fbm(q + vec3(5.2, 1.3, 2.8)), 0.0);
  vec3 w2 = vec3(fbm(q + P_warp * w1 + vec3(1.7, 9.2, f.t * 0.08)), fbm(q + P_warp * w1 + vec3(8.3, 2.8, 0.0)), 0.0);
  float n = fbm(q + P_warp * (w2 - 0.5) * 2.0);
  float ridge = pow(1.0 - abs(2.0 * n - 1.0), P_thin);
  return smoothstep(0.3, 0.9, ridge) * f.fall;
}
vec3 tint(Fx f, vec3 col, float v) { return meshTint(f, col); }`},{id:"aurora",name:"Aurora",note:"Curtains of light running round the perimeter: noise that is long away from the edge and short along it makes vertical streaks that slide round the frame, and a finer noise eats them from the outside, so they fray into specks.",params:L({scale:10,drift:3,depth:40,falloff:.7,mode:"brightness",levels:0,rim:.2},[l("slide","Slide speed",10,-40,40,.5,"px/s"),l("fray","Fray",.7,0,1.5,.01)]),still:2.5,glsl:`${W}
float field(Fx f) {
  float curtain = fbm(around(f, P_scale, P_slide, f.d / (P_scale * 6.0) + f.t * 0.06));
  float rays = smoothstep(0.48, 0.8, curtain);
  float fine = vnoise(outward(f, P_scale * 0.5, P_drift * 3.0, 0.4));
  float keep = smoothstep(-0.15, 0.25, fine - P_fray * f.d / f.depth);
  return rays * pow(f.fall, 0.6) * keep * 1.2;
}
vec3 tint(Fx f, vec3 col, float v) { return meshTint(f, col); }`}],M=8,He=`
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
`,fe=`#version 300 es
layout(location = 0) in vec2 a_c;
void main() { gl_Position = vec4(a_c * 2.0 - 1.0, 0.0, 1.0); }`;function Ke(t,e){const o=/vec3\s+tint\s*\(/.test(e)?"":"vec3 tint(Fx f, vec3 col, float v) { return col; }";return`#version 300 es
precision highp float;
uniform vec4 u_cam;   // x, y (CSS px), zoom, dpr
uniform vec2 u_cell0; // grid cell of texel (0, 0)
uniform float u_t;
uniform int u_n;
uniform vec4 u_rect[${M}];
uniform vec4 u_fr[${M}]; // time offset, presence, fill, seed
uniform vec3 u_col[${M}];
uniform float u_p[32];
out vec4 o;
${He}
${Ie(t)}
${e}
${o}

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
  for (int i = 0; i < ${M}; i++) {
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
}`}const Qe=`#version 300 es
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
}`;class Je{constructor(e,o){this.gl=e,this.quadVao=o;const r=te(e,fe,Qe);this.mask={program:r,u:Object.fromEntries(["u_field","u_cam","u_view","u_cell0","u_t","u_m0","u_m1"].map(s=>[s,e.getUniformLocation(r,s)]))},this.fbo=e.createFramebuffer(),this.tex=e.createTexture()}gl;quadVao;programs=new Map;mask;fbo;tex;tw=0;th=0;rects=new Float32Array(M*4);fr=new Float32Array(M*4);cols=new Float32Array(M*3);program(e,o,r){let s=this.programs.get(e);if(!s){const f=te(this.gl,fe,Ke(o,r));s={program:f,u:Object.fromEntries(["u_cam","u_cell0","u_t","u_n","u_rect","u_fr","u_col","u_p"].map(c=>[c,this.gl.getUniformLocation(f,c)]))},this.programs.set(e,s)}return s}draw(e,o,r,s,f,n,c,v){const{gl:a}=this,x=e.dpr,d=Math.max(2,Math.round(n[0]*x)),h=Math.round(e.camera.x*x),p=Math.round(e.camera.y*x),i=[Math.floor(-h/d),Math.floor(-p/d)],m=Math.ceil(e.width*x/d)+2,g=Math.ceil(e.height*x/d)+2;(m!==this.tw||g!==this.th)&&(this.tw=m,this.th=g,a.bindTexture(a.TEXTURE_2D,this.tex),a.texImage2D(a.TEXTURE_2D,0,a.RGBA8,m,g,0,a.RGBA,a.UNSIGNED_BYTE,null),a.texParameteri(a.TEXTURE_2D,a.TEXTURE_MIN_FILTER,a.NEAREST),a.texParameteri(a.TEXTURE_2D,a.TEXTURE_MAG_FILTER,a.NEAREST),a.bindFramebuffer(a.FRAMEBUFFER,this.fbo),a.framebufferTexture2D(a.FRAMEBUFFER,a.COLOR_ATTACHMENT0,a.TEXTURE_2D,this.tex,0),a.bindFramebuffer(a.FRAMEBUFFER,null),a.bindTexture(a.TEXTURE_2D,null));const{program:E,u:y}=this.program(o,r,s),B=v.slice(0,M);B.forEach((w,R)=>{this.rects.set([w.box.x,w.box.y,w.box.w,w.box.h],R*4),this.fr.set([w.offset,w.presence,w.fill,R+1],R*4),this.cols.set(w.color,R*3)});const F=a.getParameter(a.VIEWPORT),P=a.getParameter(a.FRAMEBUFFER_BINDING);a.activeTexture(a.TEXTURE0),a.bindTexture(a.TEXTURE_2D,null),a.bindFramebuffer(a.FRAMEBUFFER,this.fbo),a.viewport(0,0,m,g),a.disable(a.BLEND),a.useProgram(E),a.uniform4f(y.u_cam,e.camera.x,e.camera.y,e.camera.z,x),a.uniform2f(y.u_cell0,i[0],i[1]),a.uniform1f(y.u_t,c),a.uniform1i(y.u_n,B.length),a.uniform4fv(y.u_rect,this.rects),a.uniform4fv(y.u_fr,this.fr),a.uniform3fv(y.u_col,this.cols),a.uniform1fv(y.u_p,f),a.bindVertexArray(this.quadVao),a.drawArrays(a.TRIANGLES,0,6),a.bindFramebuffer(a.FRAMEBUFFER,P),a.viewport(F[0],F[1],F[2],F[3]),a.enable(a.BLEND),a.blendFunc(a.ONE,a.ONE_MINUS_SRC_ALPHA);const _=this.mask;a.useProgram(_.program),a.activeTexture(a.TEXTURE0),a.bindTexture(a.TEXTURE_2D,this.tex),a.uniform1i(_.u.u_field,0),a.uniform4f(_.u.u_cam,e.camera.x,e.camera.y,e.camera.z,x),a.uniform2f(_.u.u_view,e.width,e.height),a.uniform2f(_.u.u_cell0,i[0],i[1]),a.uniform1f(_.u.u_t,c),a.uniform4f(_.u.u_m0,n[0],n[1],n[2],n[3]),a.uniform4f(_.u.u_m1,n[4],n[5],n[6],n[7]),a.drawArrays(a.TRIANGLES,0,6),a.bindTexture(a.TEXTURE_2D,null),a.bindVertexArray(null)}}function Ze(t,e,o){let r=Math.imul(t|0,374761393)+Math.imul(e|0,668265263)+Math.imul(o|0,1274126177);return r=Math.imul(r^r>>>13,1274126177),((r^r>>>16)>>>0)/4294967296}function et(t,e,o,r){const s=3*t,f=3*(o-t)-s,n=1-s-f,c=3*e,v=3*(r-e)-c,a=1-c-v,x=d=>((n*d+f)*d+s)*d;return d=>{if(d<=0)return 0;if(d>=1)return 1;let h=0,p=1,i=d;for(let m=0;m<24;m++)x(i)<d?h=i:p=i,i=(h+p)/2;return((a*i+v)*i+c)*i}}const Y=et(.23,1,.32,1),tt=t=>Math.min(1,Math.max(0,t)),at=(t,e)=>(t%e+e)%e,ce=new Map;function ot(t,e,o,r,s=1){const f=t.px(e),n=f+Math.round(o*t.dpr),c=[t.frame.x,t.frame.y,t.frame.w,t.frame.h,f,n,r,s,t.z].map(I=>I.toFixed(2)).join(),v=ce.get(t.key);if(v&&v.sig===c)return v.band;const a=t.dpr,x=t.frame.x/a,d=t.frame.y/a,h=t.frame.w/a,p=t.frame.h/a,i=Math.min(20*t.z,h/2,p/2),m=h/2-i,g=p/2-i,E=Math.PI/2*i,y=4*(m+g)+2*Math.PI*i,B=x+h/2,F=d+p/2,P=n/a,_=s+r*P,w=Math.round(t.frame.x),R=Math.round(t.frame.y),z=Math.floor(-_*a/n)-1,q=Math.ceil((h+_)*a/n)+1,we=Math.floor(-_*a/n)-1,Fe=Math.ceil((p+_)*a/n)+1,re=[];for(let I=we;I<=Fe;I++){const ne=R+I*n,T=(ne+f/2)/a-F,Ee=Math.abs(T)<g-1?[[z,Math.ceil(2*P*a/n)+1],[Math.floor((h-2*P)*a/n)-1,q]]:[[z,q]];for(const[Pe,Ae]of Ee)for(let $=Pe;$<=Ae;$++){const ie=w+$*n,A=(ie+f/2)/a-B,ke=Math.max(-m,Math.min(m,A)),Re=Math.max(-g,Math.min(g,T));let U=A-ke,D=T-Re;const X=Math.hypot(U,D);if(X<1e-6)continue;const ee=X-i;if(ee<s||ee>_)continue;U/=X,D/=X;let k;if(Math.abs(A)<=m&&T<0)k=A>=0?A:y+A;else if(Math.abs(A)<=m)k=m+2*E+2*g+(m-A);else if(Math.abs(T)<=g&&A>0)k=m+E+(T+g);else if(Math.abs(T)<=g)k=3*m+2*g+3*E+(g-T);else{const G=Math.atan2(D,U);U>0&&D<0?k=m+i*(G+Math.PI/2):U>0?k=m+E+2*g+i*G:D>0?k=3*m+2*g+2*E+i*(G-Math.PI/2):k=3*m+4*g+3*E+i*(G+Math.PI)}re.push({x:ie,y:ne,gx:$,gy:I,d:ee-s,s:at(k,y),nx:U,ny:D})}}const se={cells:re,L:y,pitch:P,size:f};return ce.set(t.key,{sig:c,band:se}),se}const rt=H("color","Colour",["session","white"],"session"),st=t=>l("peak","Intensity",t,0,1,.01),nt=t=>l("cell","Cell",t,1,10,1,"px"),it=t=>l("gap","Gap",t,0,4,1,"px"),lt=(t,e=16)=>l("depth","Band depth",t,1,e,1,"cells"),ft=t=>l("falloff","Falloff",t,.2,4,.05),ct=(t,e,o,r)=>Math.pow(tt(1-e/(o*t.pitch)),r),de=new Map;function dt(t,e,o,r,s,f){const n=Math.floor(t.t/o);let c=de.get(t.key);for((!c||c.sig!==e||n<c.gen||n-c.gen>240)&&(c={sig:e,gen:n-f,data:r()},de.set(t.key,c));c.gen<n;)c.gen++,s(c);return c}const mt=[{id:"brain",name:"Brian’s Brain",note:"A band round the frame runs Brian’s Brain, a three-state automaton (firing, dying, off): the edge row sparks at random and the rule turns the sparks into tiny gliders that crawl along and out of the band, firing bright and dying dim.",params:[pe,nt(3),it(1),lt(8),l("step","Step",.07,.03,.3,.01,"s"),l("spark","Edge sparks",.15,0,.3,.005),l("dying","Dying cells",.35,0,1,.01),l("base","Edge glow",.18,0,1,.01),ft(.6),st(.9),rt],still:3,draw(t){const{p:e}=t,o=e.depth,r=ot(t,e.cell,e.gap,o),s=r.cells,f=ut(t.key,r),n=e.spark,v=dt(t,`${s.length}:${r.size}`,e.step,()=>[new Uint8Array(s.length)],d=>{const h=d.data[0],p=new Uint8Array(s.length);for(let i=0;i<s.length;i++)if(h[i]===1)p[i]=2;else if(h[i]===2)p[i]=0;else{let m=0;for(const g of f[i])h[g]===1&&m++;(m===2||s[i].d<r.pitch&&Ze(i,d.gen,17)<n)&&(p[i]=1)}d.data[0]=p},40).data[0],a=e.dying,x=e.base;for(let d=0;d<s.length;d++){const h=s[d],p=ct(r,h.d,o,e.falloff),i=v[d]===1?1:v[d]===2?a:h.d<r.pitch?x:0;t.cell(h.x,h.y,r.size,r.size,i*(.35+.65*p),p)}}}],me=new Map;function ut(t,e){const o=me.get(t);if(o&&o.band===e)return o.nb;const r=new Map;e.cells.forEach((f,n)=>r.set(f.gx*100003+f.gy,n));const s=e.cells.map(f=>{const n=[];for(let c=-1;c<=1;c++)for(let v=-1;v<=1;v++){if(!v&&!c)continue;const a=r.get((f.gx+v)*100003+f.gy+c);a!==void 0&&n.push(a)}return n});return me.set(t,{band:e,nb:s}),s}const S=[...je,...mt],Q=[ae("enabled","Resolve when done",!0),l("fill","Fill",.2,.05,.6,.01,"s"),l("hold","Hold",.15,0,1,.01,"s"),l("fade","Fade",.7,.1,1.5,.05,"s")],J=[ae("reduced","Reduced motion",matchMedia("(prefers-reduced-motion: reduce)").matches),ae("desync","Offset frames in time",!0)],ht=.3,b=Te({site:"busy",title:"Busy",storageKey:"canvas-playground-busy-v6",defaults:()=>({variant:S[0].id,params:Object.fromEntries(S.map(t=>[t.id,K(t.params)])),options:K(J),done:K(Q),frames:Se()}),restore(t,e){Oe(t,e,S,J),t.d&&(e.done=Ne(Q,{...e.done,...t.d})),Array.isArray(t.f)&&(e.frames=e.frames.map((o,r)=>{const[s,f]=t.f[r]??[];return qe(o,{working:s===void 0?void 0:!!s,color:f})}))},share:t=>({...Ce(t,S,J),d:Object.fromEntries(Object.entries(t.done).filter(([e,o])=>Q.find(r=>r.key===e).value!==o)),f:t.frames.map(e=>[e.working?1:0,e.color])}),exportJson:t=>{const e=S.find(o=>o.id===t.variant);return{site:"busy",variant:{id:e.id,name:e.name,params:t.params[e.id]},done:t.done}}}),{settings:u}=b,V=()=>S.find(t=>t.id===u.variant),ve=()=>b.setCaption(V().name,V().note);Ue(b,S,()=>u.variant,t=>{u.variant=t,pt.render(),ve(),b.save()});const pt=De(b,"Parameters",()=>V().params,()=>u.params[u.variant],b.save,()=>u.params[u.variant]=K(V().params));b.section("Done",j("Finish all",()=>u.frames.forEach((t,e)=>C(e,!1)),"ghost",!0)).append(...Q.map(t=>Me(t,u.done,b.save)));let oe=0;const xe=u.frames.map(()=>-1/0),be=u.frames.map(()=>!1);function C(t,e){const o=u.frames[t];o.working!==e&&(be[t]=o.working&&!e,o.working=e,xe[t]=oe,ge(),b.save())}const vt=b.section("Frames");function ge(){vt.replaceChildren(...Ve(u.frames,(t,e)=>{const o=ze(t.working,r=>C(e,r));return o.setAttribute("aria-label",`${t.title} is working`),o.dataset.frame=String(e),[o]},()=>b.save()),Be("div","pg-buttons",j("Randomise",()=>u.frames.forEach((t,e)=>C(e,Math.random()<.6)),"",!0),j("All working",()=>u.frames.forEach((t,e)=>C(e,!0)),"",!0),j("All done",()=>u.frames.forEach((t,e)=>C(e,!1)),"",!0)))}ge();Le(b,"Preview",J,u.options,b.save);ve();function ue(t){const e=oe-xe[t];if(u.frames[t].working)return[Y(Math.min(1,e/ht)),0];if(!be[t])return[0,0];const o=u.done;if(u.options.reduced||!o.enabled)return[1-Y(Math.min(1,e/.2)),0];const r=o.fill,s=o.hold,f=o.fade;return[1-Y(Math.min(1,Math.max(0,(e-r-s)/f))),Y(Math.min(1,e/r))]}const xt=new Ye(b.gl.gl),N=new We;let Z=0,_e=!1;const ye=t=>{oe+=t,u.options.reduced||(Z+=t*u.params[u.variant].speed)};b.onTick(t=>{_e||ye(t)});const bt=new Je(b.gl.gl,b.gl.quadVao),he=new Float32Array(32);b.onDraw(t=>{const e=V(),o=u.params[e.id],{dpr:r,camera:s}=t,f=s.z,n=!!u.options.reduced,c=x=>u.options.desync?x*1.618:0,v=n?e.still:Z,a=e.glsl?()=>{$e(e.params,o,he);const x=b.layout.sections.map((h,p)=>{const[i,m]=ue(p);return{box:h.box,color:le(u.frames[p].color),offset:n?0:c(p)+p*37,presence:i,fill:m}}),d=[o.pitch,o.dot,o.shape==="square"?1:0,["brightness","halftone","dither"].indexOf(o.mode),o.levels,o.base,o.peak,o.modulate];bt.draw(t,e.id,e.params,e.glsl,he,d,v,x)}:void 0;b.gl.draw(t,b.layout.sections.map(x=>({box:x.box})),[...b.layout.items.values()],a),e.draw&&(N.begin(),b.layout.sections.forEach((x,d)=>{const[h,p]=ue(d);if(h<=.001)return;const i=u.frames[d],m=o.color==="white"?[1,1,1]:le(i.color),g=o.floor??0,E=o.peak??1,y=o.levels||0,B={frame:{x:(x.box.x*f+s.x)*r,y:(x.box.y*f+s.y)*r,w:x.box.w*f*r,h:x.box.h*f*r},t:n?e.still:Z+c(d),reduced:n,dpr:r,z:f,p:o,key:`${e.id}:${d}`,px:F=>Math.max(1,Math.round(F*r)),cell:(F,P,_,w,R,z=1)=>{let q=Math.max(Math.min(1,Math.max(0,R))*(1-p),p*z*z*z);y>0&&(q=Math.round(q*y)/y),g>0&&N.add(F,P,_,w,1,1,1,g*h),q>0&&N.add(F,P,_,w,m[0],m[1],m[2],E*q*h)}};e.draw(B)}),xt.draw(N))});Object.assign(b.playground,{time:()=>Z,blocks:()=>N.n,select:t=>document.querySelector(`[role="option"][data-id="${t}"]`)?.click(),setWorking:t=>t.forEach((e,o)=>C(o,e)),pause:t=>_e=t,advance:ye});
