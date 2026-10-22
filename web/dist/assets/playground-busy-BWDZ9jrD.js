import"./layout-D5wn9ku6.js";import{D as be,E as Le,a as N,b as Ue,c as j,e as Ce}from"./ember-CuhyAbSy.js";import{l as Oe,b as $,p as ce,S as de,e as H,s as Ne,a as ee,c as Ve,f as $e,d as Ye,g as We}from"./shell-CigVNP_v.js";import{c as xe,r as ne,a as l,S as ie,s as K,g as Xe,t as le,d as Q,h as oe,p as Ge}from"./params-Bh0xY2p6.js";function je(t,e,a,r){typeof t.v=="string"&&a.some(n=>n.id===t.v)&&(e.variant=t.v);const s=t.p??{};for(const n of a)s[n.id]&&(e.params[n.id]=ne(n.params,{...e.params[n.id],...s[n.id]}));t.o&&(e.options=ne(r,{...e.options,...t.o}))}function He(t,e,a){const r={};for(const s of e){const n=xe(s.params,t.params[s.id]);Object.keys(n).length&&(r[s.id]=n)}return{v:t.variant,p:r,o:xe(a,t.options)}}function Ke(t,e,a,r){const s=Oe(e.map((n,i)=>({id:n.id,name:n.name,key:String(i+1),title:n.note})),a(),r,"Variation");return t.section("Variation").append(s.el),window.addEventListener("keydown",n=>{if(n.target.closest('input, textarea, [role="slider"]')||n.metaKey||n.ctrlKey||n.altKey)return;const i=Number(n.key)-1;Number.isInteger(i)&&i>=0&&i<e.length&&s.select(e[i].id)}),s}function Qe(t,e,a,r,s,n){const i=$("Reset",()=>{n(),h(),s()},"ghost",!0),f=t.section(e,i),h=()=>f.replaceChildren(...a().map(o=>ce(o,r(),s,de)));return h(),{render:h}}function Je(t,e,a,r,s){t.section(e).append(...a.map(n=>ce(n,r,s,de)))}function Ze(t,e,a){return t.map((r,s)=>H("div","pg-frame",Ne(r.color,de,n=>{r.color=n,a(s)},`Colour of ${r.title}`),H("span","t",r.title),H("span","controls",...e(r,s))))}const et=`#version 300 es
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
}`,tt=`#version 300 es
precision mediump float;
in vec4 v_col;
out vec4 o;
void main() { o = v_col; }`,O=8;class at{data=new Float32Array(O*4096);n=0;begin(){this.n=0}add(e,a,r,s,n,i,f,h){if(!(h<=.002||r<=0||s<=0)){if((this.n+1)*O>this.data.length){const o=new Float32Array(this.data.length*2);o.set(this.data),this.data=o}this.data.set([e,a,r,s,n*h,i*h,f*h,h],this.n*O),this.n++}}}class ot{constructor(e){this.gl=e,this.program=ee(e,et,tt),this.uSize=e.getUniformLocation(this.program,"u_size");const a=e.createBuffer();e.bindBuffer(e.ARRAY_BUFFER,a),e.bufferData(e.ARRAY_BUFFER,new Float32Array([0,0,1,0,0,1,0,1,1,0,1,1]),e.STATIC_DRAW),this.vao=e.createVertexArray(),e.bindVertexArray(this.vao),e.enableVertexAttribArray(0),e.vertexAttribPointer(0,2,e.FLOAT,!1,0,0),this.buf=e.createBuffer(),e.bindBuffer(e.ARRAY_BUFFER,this.buf),e.enableVertexAttribArray(1),e.vertexAttribPointer(1,4,e.FLOAT,!1,O*4,0),e.vertexAttribDivisor(1,1),e.enableVertexAttribArray(2),e.vertexAttribPointer(2,4,e.FLOAT,!1,O*4,16),e.vertexAttribDivisor(2,1),e.bindVertexArray(null)}gl;program;uSize;vao;buf;draw(e){const{gl:a}=this;e.n&&(a.bindFramebuffer(a.FRAMEBUFFER,null),a.viewport(0,0,a.drawingBufferWidth,a.drawingBufferHeight),a.enable(a.BLEND),a.blendFunc(a.ONE,a.ONE_MINUS_SRC_ALPHA),a.useProgram(this.program),a.uniform2f(this.uSize,a.drawingBufferWidth,a.drawingBufferHeight),a.bindVertexArray(this.vao),a.bindBuffer(a.ARRAY_BUFFER,this.buf),a.bufferData(a.ARRAY_BUFFER,e.data.subarray(0,e.n*O),a.DYNAMIC_DRAW),a.drawArraysInstanced(a.TRIANGLES,0,6,e.n),a.bindVertexArray(null))}}const rt=`#version 300 es
layout(location = 0) in vec2 a_c;
layout(location = 1) in vec4 a_cell;
layout(location = 2) in vec4 a_size;
layout(location = 3) in vec4 a_col;
uniform vec2 u_size;
flat out vec4 v_cell;
flat out vec4 v_size;
flat out vec4 v_col;
void main() {
  vec2 p = a_cell.xy + a_c * a_cell.z;
  vec2 n = p / u_size * 2.0 - 1.0;
  gl_Position = vec4(n.x, -n.y, 0.0, 1.0);
  v_cell = a_cell;
  v_size = a_size;
  v_col = a_col;
}`,st=`#version 300 es
precision highp float;
uniform vec2 u_size;
flat in vec4 v_cell;
flat in vec4 v_size;
flat in vec4 v_col;
out vec4 o;
void main() {
  vec2 pix = floor(vec2(gl_FragCoord.x, u_size.y - gl_FragCoord.y)) - v_cell.xy;
  float pd = v_cell.z;
  float cover;
  float baseCover;
  if (v_cell.w > 0.5) {
    float dist = length(pix + 0.5 - 0.5 * pd);
    cover = clamp(0.5 * v_size.x - dist + 0.5, 0.0, 1.0);
    baseCover = clamp(0.5 * v_size.y - dist + 0.5, 0.0, 1.0);
  } else {
    float side = floor(v_size.x + 0.5);
    float start = floor(0.5 * (pd - side));
    cover = side >= 1.0 && all(greaterThanEqual(pix, vec2(start))) && all(lessThan(pix, vec2(start + side))) ? 1.0 : 0.0;
    float bside = floor(v_size.y + 0.5);
    float bstart = floor(0.5 * (pd - bside));
    baseCover = all(greaterThanEqual(pix, vec2(bstart))) && all(lessThan(pix, vec2(bstart + bside))) ? 1.0 : 0.0;
  }
  float a = max(v_size.z * cover, v_size.w * baseCover);
  if (a <= 0.002) discard;
  o = vec4(v_col.rgb * a, a);
}`;class nt{constructor(e){this.gl=e,this.program=ee(e,rt,st),this.uSize=e.getUniformLocation(this.program,"u_size");const a=e.createBuffer();e.bindBuffer(e.ARRAY_BUFFER,a),e.bufferData(e.ARRAY_BUFFER,new Float32Array([0,0,1,0,0,1,0,1,1,0,1,1]),e.STATIC_DRAW),this.vao=e.createVertexArray(),e.bindVertexArray(this.vao),e.enableVertexAttribArray(0),e.vertexAttribPointer(0,2,e.FLOAT,!1,0,0),this.buf=e.createBuffer(),e.bindBuffer(e.ARRAY_BUFFER,this.buf);for(let r=0;r<3;r++)e.enableVertexAttribArray(1+r),e.vertexAttribPointer(1+r,4,e.FLOAT,!1,be*4,r*16),e.vertexAttribDivisor(1+r,1);e.bindVertexArray(null)}gl;program;uSize;vao;buf;draw(e){const{gl:a}=this;e.n&&(a.enable(a.BLEND),a.blendFunc(a.ONE,a.ONE_MINUS_SRC_ALPHA),a.useProgram(this.program),a.uniform2f(this.uSize,a.drawingBufferWidth,a.drawingBufferHeight),a.bindVertexArray(this.vao),a.bindBuffer(a.ARRAY_BUFFER,this.buf),a.bufferData(a.ARRAY_BUFFER,e.data.subarray(0,e.n*be),a.DYNAMIC_DRAW),a.drawArraysInstanced(a.TRIANGLES,0,6,e.n),a.bindVertexArray(null))}}function U(t,e=[]){return[t.speed===void 0?ie:{...ie,value:t.speed},l("pitch","Grid pitch",t.pitch??4,2,12,1,"px"),l("dot","Dot size",t.dot??3,1,10,.5,"px"),K("shape","Dot shape",["round","square"],t.shape??"square"),K("mode","Mask",["brightness","halftone","dither"],t.mode??"brightness"),l("levels","Brightness steps",t.levels??0,0,8,1),l("base","Unlit dots",t.base??0,0,.3,.005),l("rim","Edge row",t.rim??.18,0,1,.01),l("modulate","Mask modulation",t.modulate??0,0,1,.01),l("scale","Noise size",t.scale??18,3,120,.5,"px"),l("warp","Warp",t.warp??1,0,3,.01),l("drift","Outward drift",t.drift??8,0,80,.5,"px/s"),l("depth","Band depth",t.depth??34,8,120,1,"px"),l("falloff","Falloff",t.falloff??.8,.2,4,.05),l("intensity","Intensity",t.intensity??1,0,3,.01),l("peak","Peak opacity",t.peak??.9,0,1,.01),K("color","Colour",["session","mesh"],t.color??"session"),...e]}const re=`
vec3 meshTint(Fx f, vec3 col) {
  if (P_color < 0.5) return col;
  float h = vnoise(around(f, 140.0, -6.0, f.t * 0.05)) - 0.5;
  return hueRotate(col, h * 1.4);
}`,it=[{id:"embers",name:"Ember clumps",note:"What busy frames show in the app (render/busy/ember.ts, with these defaults). Tuned to look like Brian’s Brain, but continuous: two layers of fine noise crawl in opposite directions round the frame while drifting outward, and only their peaks light up, giving sparse bright clumps that thin out away from the edge and glide instead of stepping. Evaluated once per cell on the CPU.",params:U(N,[l("crawl","Crawl",N.crawl,0,40,.5,"px/s"),l("sparse","Sparseness",N.sparse,.4,.9,.005),l("dim","Dim clumps",N.dim,0,1,.01)]),still:Le,dots:(t,e,a,r,s)=>t.fill(e,a,{...N,...r},s)},{id:"smoke",name:"Smoke",note:"Slow domain-warped fbm (Inigo Quilez’s warping) sampled further inward as time passes, so soft tongues of smoke lift off every side and corner and dissolve as the falloff takes them; seen through 3px square dots as dithered speckle.",params:U({scale:16,warp:1.1,drift:7,depth:36,falloff:.9,mode:"dither",rim:.2}),still:3,glsl:`${re}
float field(Fx f) {
  vec3 q = outward(f, P_scale, P_drift, 0.12);
  vec3 w = vec3(fbm(q + vec3(0.0, 0.0, f.t * 0.07)), fbm(q + vec3(5.2, 1.3, 2.8)), 0.0);
  float n = fbm(q + P_warp * (w - 0.5) * 2.0);
  return smoothstep(0.42, 0.8, n) * f.fall;
}
vec3 tint(Fx f, vec3 col, float v) { return meshTint(f, col); }`},{id:"fire",name:"Fire",note:"Quicker licking tongues: noise stretched away from the edge rises fast and is cut by height (the classic noise-minus-height flame), so it is hot and dense at the base and frays into sparks; the base shifts warm.",params:U({scale:9,warp:.6,drift:26,depth:30,falloff:1,mode:"brightness",levels:0,rim:.3},[l("stretch","Tongue length",2.4,1,6,.05),l("warm","Warm shift",.45,0,1,.01)]),still:2,glsl:`
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
}`},{id:"mesh",name:"Mesh gradient",note:"Four large soft blobs of colour near the session hue orbit the frame at different speeds while the band breathes outward and back; brightness-masked dots turn the smooth mesh gradient into an LED glow.",params:U({depth:32,falloff:1.2,mode:"brightness",levels:0,rim:.15,color:"mesh",scale:30,intensity:1.1},[l("orbit","Orbit speed",.04,0,.3,.005),l("breathe","Breathing",.25,0,.8,.01)]),still:5,glsl:`
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
}`},{id:"ink",name:"Ink wisps",note:"Thin wisps rather than blobs: doubly warped noise folded into ridges (1 − |2n − 1|, sharpened), flowing along and away from the edge like ink in water; halftone dots grow along each filament.",params:U({scale:22,warp:1.6,drift:6,depth:40,falloff:.9,mode:"halftone",dot:3.5,shape:"round",rim:.15},[l("thin","Thinness",9,1,20,.1),l("flow","Flow along",5,-30,30,.5,"px/s")]),still:6,glsl:`${re}
float field(Fx f) {
  vec3 q = around(f, P_scale, P_flow, (f.d - f.t * P_drift) / P_scale);
  vec3 w1 = vec3(fbm(q + vec3(0.0, 0.0, f.t * 0.05)), fbm(q + vec3(5.2, 1.3, 2.8)), 0.0);
  vec3 w2 = vec3(fbm(q + P_warp * w1 + vec3(1.7, 9.2, f.t * 0.08)), fbm(q + P_warp * w1 + vec3(8.3, 2.8, 0.0)), 0.0);
  float n = fbm(q + P_warp * (w2 - 0.5) * 2.0);
  float ridge = pow(1.0 - abs(2.0 * n - 1.0), P_thin);
  return smoothstep(0.3, 0.9, ridge) * f.fall;
}
vec3 tint(Fx f, vec3 col, float v) { return meshTint(f, col); }`},{id:"aurora",name:"Aurora",note:"Curtains of light running round the perimeter: noise that is long away from the edge and short along it makes vertical streaks that slide round the frame, and a finer noise eats them from the outside, so they fray into specks.",params:U({scale:10,drift:3,depth:40,falloff:.7,mode:"brightness",levels:0,rim:.2},[l("slide","Slide speed",10,-40,40,.5,"px/s"),l("fray","Fray",.7,0,1.5,.01)]),still:2.5,glsl:`${re}
float field(Fx f) {
  float curtain = fbm(around(f, P_scale, P_slide, f.d / (P_scale * 6.0) + f.t * 0.06));
  float rays = smoothstep(0.48, 0.8, curtain);
  float fine = vnoise(outward(f, P_scale * 0.5, P_drift * 3.0, 0.4));
  float keep = smoothstep(-0.15, 0.25, fine - P_fray * f.d / f.depth);
  return rays * pow(f.fall, 0.6) * keep * 1.2;
}
vec3 tint(Fx f, vec3 col, float v) { return meshTint(f, col); }`}],M=8,lt=`
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
`,_e=`#version 300 es
layout(location = 0) in vec2 a_c;
void main() { gl_Position = vec4(a_c * 2.0 - 1.0, 0.0, 1.0); }`;function ft(t,e){const a=/vec3\s+tint\s*\(/.test(e)?"":"vec3 tint(Fx f, vec3 col, float v) { return col; }";return`#version 300 es
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
${lt}
${Xe(t)}
${e}
${a}

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
}`}const ct=`#version 300 es
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
}`;class dt{constructor(e,a){this.gl=e,this.quadVao=a;const r=ee(e,_e,ct);this.mask={program:r,u:Object.fromEntries(["u_field","u_cam","u_view","u_cell0","u_t","u_m0","u_m1"].map(s=>[s,e.getUniformLocation(r,s)]))},this.fbo=e.createFramebuffer(),this.tex=e.createTexture()}gl;quadVao;programs=new Map;mask;fbo;tex;tw=0;th=0;rects=new Float32Array(M*4);fr=new Float32Array(M*4);cols=new Float32Array(M*3);program(e,a,r){let s=this.programs.get(e);if(!s){const n=ee(this.gl,_e,ft(a,r));s={program:n,u:Object.fromEntries(["u_cam","u_cell0","u_t","u_n","u_rect","u_fr","u_col","u_p"].map(f=>[f,this.gl.getUniformLocation(n,f)]))},this.programs.set(e,s)}return s}draw(e,a,r,s,n,i,f,h){const{gl:o}=this,b=e.dpr,v=Math.max(2,Math.round(i[0]*b)),u=Math.round(e.camera.x*b),x=Math.round(e.camera.y*b),c=[Math.floor(-u/v),Math.floor(-x/v)],m=Math.ceil(e.width*b/v)+2,_=Math.ceil(e.height*b/v)+2;(m!==this.tw||_!==this.th)&&(this.tw=m,this.th=_,o.bindTexture(o.TEXTURE_2D,this.tex),o.texImage2D(o.TEXTURE_2D,0,o.RGBA8,m,_,0,o.RGBA,o.UNSIGNED_BYTE,null),o.texParameteri(o.TEXTURE_2D,o.TEXTURE_MIN_FILTER,o.NEAREST),o.texParameteri(o.TEXTURE_2D,o.TEXTURE_MAG_FILTER,o.NEAREST),o.bindFramebuffer(o.FRAMEBUFFER,this.fbo),o.framebufferTexture2D(o.FRAMEBUFFER,o.COLOR_ATTACHMENT0,o.TEXTURE_2D,this.tex,0),o.bindFramebuffer(o.FRAMEBUFFER,null),o.bindTexture(o.TEXTURE_2D,null));const{program:E,u:y}=this.program(a,r,s),B=h.slice(0,M);B.forEach((w,T)=>{this.rects.set([w.box.x,w.box.y,w.box.w,w.box.h],T*4),this.fr.set([w.offset,w.presence,w.fill,T+1],T*4),this.cols.set(w.color,T*3)});const A=o.getParameter(o.VIEWPORT),F=o.getParameter(o.FRAMEBUFFER_BINDING);o.activeTexture(o.TEXTURE0),o.bindTexture(o.TEXTURE_2D,null),o.bindFramebuffer(o.FRAMEBUFFER,this.fbo),o.viewport(0,0,m,_),o.disable(o.BLEND),o.useProgram(E),o.uniform4f(y.u_cam,e.camera.x,e.camera.y,e.camera.z,b),o.uniform2f(y.u_cell0,c[0],c[1]),o.uniform1f(y.u_t,f),o.uniform1i(y.u_n,B.length),o.uniform4fv(y.u_rect,this.rects),o.uniform4fv(y.u_fr,this.fr),o.uniform3fv(y.u_col,this.cols),o.uniform1fv(y.u_p,n),o.bindVertexArray(this.quadVao),o.drawArrays(o.TRIANGLES,0,6),o.bindFramebuffer(o.FRAMEBUFFER,F),o.viewport(A[0],A[1],A[2],A[3]),o.enable(o.BLEND),o.blendFunc(o.ONE,o.ONE_MINUS_SRC_ALPHA);const g=this.mask;o.useProgram(g.program),o.activeTexture(o.TEXTURE0),o.bindTexture(o.TEXTURE_2D,this.tex),o.uniform1i(g.u.u_field,0),o.uniform4f(g.u.u_cam,e.camera.x,e.camera.y,e.camera.z,b),o.uniform2f(g.u.u_view,e.width,e.height),o.uniform2f(g.u.u_cell0,c[0],c[1]),o.uniform1f(g.u.u_t,f),o.uniform4f(g.u.u_m0,i[0],i[1],i[2],i[3]),o.uniform4f(g.u.u_m1,i[4],i[5],i[6],i[7]),o.drawArrays(o.TRIANGLES,0,6),o.bindTexture(o.TEXTURE_2D,null),o.bindVertexArray(null)}}function ut(t,e,a){let r=Math.imul(t|0,374761393)+Math.imul(e|0,668265263)+Math.imul(a|0,1274126177);return r=Math.imul(r^r>>>13,1274126177),((r^r>>>16)>>>0)/4294967296}const mt=t=>Math.min(1,Math.max(0,t)),ht=(t,e)=>(t%e+e)%e,ge=new Map;function pt(t,e,a,r,s=1){const n=t.px(e),i=n+Math.round(a*t.dpr),f=[t.frame.x,t.frame.y,t.frame.w,t.frame.h,n,i,r,s,t.z].map(D=>D.toFixed(2)).join(),h=ge.get(t.key);if(h&&h.sig===f)return h.band;const o=t.dpr,b=t.frame.x/o,v=t.frame.y/o,u=t.frame.w/o,x=t.frame.h/o,c=Math.min(20*t.z,u/2,x/2),m=u/2-c,_=x/2-c,E=Math.PI/2*c,y=4*(m+_)+2*Math.PI*c,B=b+u/2,A=v+x/2,F=i/o,g=s+r*F,w=Math.round(t.frame.x),T=Math.round(t.frame.y),q=Math.floor(-g*o/i)-1,S=Math.ceil((u+g)*o/i)+1,Me=Math.floor(-g*o/i)-1,Se=Math.ceil((x+g)*o/i)+1,me=[];for(let D=Me;D<=Se;D++){const pe=T+D*i,P=(pe+n/2)/o-A,ze=Math.abs(P)<_-1?[[q,Math.ceil(2*F*o/i)+1],[Math.floor((u-2*F)*o/i)-1,S]]:[[q,S]];for(const[Be,qe]of ze)for(let W=Be;W<=qe;W++){const ve=w+W*i,R=(ve+n/2)/o-B,De=Math.max(-m,Math.min(m,R)),Ie=Math.max(-_,Math.min(_,P));let I=R-De,L=P-Ie;const X=Math.hypot(I,L);if(X<1e-6)continue;const ae=X-c;if(ae<s||ae>g)continue;I/=X,L/=X;let k;if(Math.abs(R)<=m&&P<0)k=R>=0?R:y+R;else if(Math.abs(R)<=m)k=m+2*E+2*_+(m-R);else if(Math.abs(P)<=_&&R>0)k=m+E+(P+_);else if(Math.abs(P)<=_)k=3*m+2*_+3*E+(_-P);else{const G=Math.atan2(L,I);I>0&&L<0?k=m+c*(G+Math.PI/2):I>0?k=m+E+2*_+c*G:L>0?k=3*m+2*_+2*E+c*(G-Math.PI/2):k=3*m+4*_+3*E+c*(G+Math.PI)}me.push({x:ve,y:pe,gx:W,gy:D,d:ae-s,s:ht(k,y),nx:I,ny:L})}}const he={cells:me,L:y,pitch:F,size:n};return ge.set(t.key,{sig:f,band:he}),he}const vt=K("color","Colour",["session","white"],"session"),bt=t=>l("peak","Intensity",t,0,1,.01),xt=t=>l("cell","Cell",t,1,10,1,"px"),_t=t=>l("gap","Gap",t,0,4,1,"px"),gt=(t,e=16)=>l("depth","Band depth",t,1,e,1,"cells"),yt=t=>l("falloff","Falloff",t,.2,4,.05),wt=(t,e,a,r)=>Math.pow(mt(1-e/(a*t.pitch)),r),ye=new Map;function At(t,e,a,r,s,n){const i=Math.floor(t.t/a);let f=ye.get(t.key);for((!f||f.sig!==e||i<f.gen||i-f.gen>240)&&(f={sig:e,gen:i-n,data:r()},ye.set(t.key,f));f.gen<i;)f.gen++,s(f);return f}const Et=[{id:"brain",name:"Brian’s Brain",note:"A band round the frame runs Brian’s Brain, a three-state automaton (firing, dying, off): the edge row sparks at random and the rule turns the sparks into tiny gliders that crawl along and out of the band, firing bright and dying dim.",params:[ie,xt(3),_t(1),gt(8),l("step","Step",.07,.03,.3,.01,"s"),l("spark","Edge sparks",.15,0,.3,.005),l("dying","Dying cells",.35,0,1,.01),l("base","Edge glow",.18,0,1,.01),yt(.6),bt(.9),vt],still:3,draw(t){const{p:e}=t,a=e.depth,r=pt(t,e.cell,e.gap,a),s=r.cells,n=Ft(t.key,r),i=e.spark,h=At(t,`${s.length}:${r.size}`,e.step,()=>[new Uint8Array(s.length)],v=>{const u=v.data[0],x=new Uint8Array(s.length);for(let c=0;c<s.length;c++)if(u[c]===1)x[c]=2;else if(u[c]===2)x[c]=0;else{let m=0;for(const _ of n[c])u[_]===1&&m++;(m===2||s[c].d<r.pitch&&ut(c,v.gen,17)<i)&&(x[c]=1)}v.data[0]=x},40).data[0],o=e.dying,b=e.base;for(let v=0;v<s.length;v++){const u=s[v],x=wt(r,u.d,a,e.falloff),c=h[v]===1?1:h[v]===2?o:u.d<r.pitch?b:0;t.cell(u.x,u.y,r.size,r.size,c*(.35+.65*x),x)}}}],we=new Map;function Ft(t,e){const a=we.get(t);if(a&&a.band===e)return a.nb;const r=new Map;e.cells.forEach((n,i)=>r.set(n.gx*100003+n.gy,i));const s=e.cells.map(n=>{const i=[];for(let f=-1;f<=1;f++)for(let h=-1;h<=1;h++){if(!h&&!f)continue;const o=r.get((n.gx+h)*100003+n.gy+f);o!==void 0&&i.push(o)}return i});return we.set(t,{band:e,nb:s}),s}const z=[...it,...Et],J=[le("enabled","Resolve when done",j.enabled),l("fill","Fill",j.fill,.05,.6,.01,"s"),l("hold","Hold",j.hold,0,1,.01,"s"),l("fade","Fade",j.fade,.1,1.5,.05,"s")],Z=[le("reduced","Reduced motion",matchMedia("(prefers-reduced-motion: reduce)").matches),le("desync","Offset frames in time",!0)],p=Ve({site:"busy",title:"Busy",storageKey:"canvas-playground-busy-v6",defaults:()=>({variant:z[0].id,params:Object.fromEntries(z.map(t=>[t.id,Q(t.params)])),options:Q(Z),done:Q(J),frames:Ye()}),restore(t,e){je(t,e,z,Z),t.d&&(e.done=ne(J,{...e.done,...t.d})),Array.isArray(t.f)&&(e.frames=e.frames.map((a,r)=>{const[s,n]=t.f[r]??[];return $e(a,{working:s===void 0?void 0:!!s,color:n})}))},share:t=>({...He(t,z,Z),d:Object.fromEntries(Object.entries(t.done).filter(([e,a])=>J.find(r=>r.key===e).value!==a)),f:t.frames.map(e=>[e.working?1:0,e.color])}),exportJson:t=>{const e=z.find(a=>a.id===t.variant);return{site:"busy",variant:{id:e.id,name:e.name,params:t.params[e.id]},done:t.done}}}),{settings:d}=p,Y=()=>z.find(t=>t.id===d.variant),Ee=()=>p.setCaption(Y().name,Y().note);Ke(p,z,()=>d.variant,t=>{d.variant=t,Rt.render(),Ee(),p.save()});const Rt=Qe(p,"Parameters",()=>Y().params,()=>d.params[d.variant],p.save,()=>d.params[d.variant]=Q(Y().params));p.section("Done",$("Finish all",()=>d.frames.forEach((t,e)=>C(e,!1)),"ghost",!0)).append(...J.map(t=>ce(t,d.done,p.save)));let ue=0;const Fe=d.frames.map(()=>-1/0),Re=d.frames.map(()=>!1);function C(t,e){const a=d.frames[t];a.working!==e&&(Re[t]=a.working&&!e,a.working=e,Fe[t]=ue,ke(),p.save())}const kt=p.section("Frames");function ke(){kt.replaceChildren(...Ze(d.frames,(t,e)=>{const a=We(t.working,r=>C(e,r));return a.setAttribute("aria-label",`${t.title} is working`),a.dataset.frame=String(e),[a]},()=>p.save()),H("div","pg-buttons",$("Randomise",()=>d.frames.forEach((t,e)=>C(e,Math.random()<.6)),"",!0),$("All working",()=>d.frames.forEach((t,e)=>C(e,!0)),"",!0),$("All done",()=>d.frames.forEach((t,e)=>C(e,!1)),"",!0)))}ke();Je(p,"Preview",Z,d.options,p.save);Ee();function se(t){const e={working:!!d.frames[t].working,since:Fe[t],finished:Re[t]};return Ce(e,ue,d.done,!!d.options.reduced)}const Tt=new ot(p.gl.gl),V=new at;let te=0,Te=!1;const Pe=t=>{ue+=t,d.options.reduced||(te+=t*d.params[d.variant].speed)};p.onTick(t=>{Te||Pe(t)});const Pt=new dt(p.gl.gl,p.gl.quadVao),Ae=new Float32Array(32),Mt=new nt(p.gl.gl),fe=new Ue;p.onDraw(t=>{const e=Y(),a=d.params[e.id],{dpr:r,camera:s}=t,n=s.z,i=!!d.options.reduced,f=b=>d.options.desync?b*1.618:0,h=i?e.still:te,o=e.dots?()=>{const b=p.layout.sections.map((v,u)=>{const[x,c]=se(u);return{box:v.box,color:oe(d.frames[u].color),offset:i?0:f(u)+u*37,seed:u+1,presence:x,fill:c}});e.dots(fe,{x:s.x,y:s.y,z:n,width:t.width,height:t.height,dpr:r},b,a,h),Mt.draw(fe)}:e.glsl?()=>{Ge(e.params,a,Ae);const b=p.layout.sections.map((u,x)=>{const[c,m]=se(x);return{box:u.box,color:oe(d.frames[x].color),offset:i?0:f(x)+x*37,presence:c,fill:m}}),v=[a.pitch,a.dot,a.shape==="square"?1:0,["brightness","halftone","dither"].indexOf(a.mode),a.levels,a.base,a.peak,a.modulate];Pt.draw(t,e.id,e.params,e.glsl,Ae,v,h,b)}:void 0;p.gl.draw(t,p.layout.sections.map(b=>({box:b.box})),[...p.layout.items.values()],o),e.draw&&(V.begin(),p.layout.sections.forEach((b,v)=>{const[u,x]=se(v);if(u<=.001)return;const c=d.frames[v],m=a.color==="white"?[1,1,1]:oe(c.color),_=a.floor??0,E=a.peak??1,y=a.levels||0,B={frame:{x:(b.box.x*n+s.x)*r,y:(b.box.y*n+s.y)*r,w:b.box.w*n*r,h:b.box.h*n*r},t:i?e.still:te+f(v),reduced:i,dpr:r,z:n,p:a,key:`${e.id}:${v}`,px:A=>Math.max(1,Math.round(A*r)),cell:(A,F,g,w,T,q=1)=>{let S=Math.max(Math.min(1,Math.max(0,T))*(1-x),x*q*q*q);y>0&&(S=Math.round(S*y)/y),_>0&&V.add(A,F,g,w,1,1,1,_*u),S>0&&V.add(A,F,g,w,m[0],m[1],m[2],E*S*u)}};e.draw(B)}),Tt.draw(V))});Object.assign(p.playground,{time:()=>te,blocks:()=>V.n,dots:()=>fe.n,select:t=>document.querySelector(`[role="option"][data-id="${t}"]`)?.click(),setWorking:t=>t.forEach((e,a)=>C(a,e)),pause:t=>Te=t,advance:Pe});
