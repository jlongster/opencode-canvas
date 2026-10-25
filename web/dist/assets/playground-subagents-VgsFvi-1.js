import{a as Ke,L as Tt,B as ae}from"./layout-BoOi8fel.js";import{aj as G,ak as Ve,al as We,s as Ht,a0 as Ye,b as Je,c as pe,am as Te,an as Qe,ao as Ze,r as to,a7 as eo,a8 as ue}from"./styles-ZUugZsyS.js";import{b as It}from"./envelope-hq1lSZqC.js";import{a as z,S as oo,s as Dt,g as so,p as ao,c as Nt,r as Bt,t as _t,d as ct}from"./params-Bh0xY2p6.js";import{e as O,h as no,B as io,b as et,l as ro,p as Vt,S as co,i as lo,j as ho,k as fo}from"./shell-Cr2QVklX.js";const dt=20,xt=8,Zt=16,po=`#version 300 es
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
}`,uo=`
precision highp float;
precision highp int;
uniform vec2 u_view;
uniform float u_dpr;
uniform float u_p[${Zt}];
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
`,mo=`
void main() {
  vec2 px = vec2(gl_FragCoord.x, u_view.y - gl_FragCoord.y);
  vec4 c = vec4(0.0);
  for (int i = 0; i < v_info.y; i++) c = over(c, shadeOrb(orb(v_info.x + i), px));
  o_color = finish(c);
}`,go=`
void main() {
  vec2 px = vec2(gl_FragCoord.x, u_view.y - gl_FragCoord.y);
  o_color = finish(shadeRow(v_info.x, v_info.y, px));
}`;class vo{canvas;gl;programs=new Map;failed=new Set;vao;instBuf;tex;texRows=0;orbData=new Float32Array(dt*64);instData=new Float32Array(xt*64);params=new Float32Array(Zt);nOrbs=0;nInst=0;blank=!0;error=null;constructor(t,e=null){this.canvas=document.createElement("canvas"),this.canvas.className="sa-orb-layer",t.insertBefore(this.canvas,e);const s=this.canvas.getContext("webgl2",{alpha:!0,premultipliedAlpha:!0,antialias:!1,depth:!1,stencil:!1,preserveDrawingBuffer:!1});if(!s)throw new Error("WebGL2 is not available");this.gl=s,this.init(),this.canvas.addEventListener("webglcontextlost",a=>a.preventDefault()),this.canvas.addEventListener("webglcontextrestored",()=>{this.programs.clear(),this.failed.clear(),this.texRows=0,this.blank=!1,this.init()})}init(){const t=this.gl,e=t.createBuffer();t.bindBuffer(t.ARRAY_BUFFER,e),t.bufferData(t.ARRAY_BUFFER,new Float32Array([0,0,1,0,0,1,0,1,1,0,1,1]),t.STATIC_DRAW),this.vao=t.createVertexArray(),t.bindVertexArray(this.vao),t.enableVertexAttribArray(0),t.vertexAttribPointer(0,2,t.FLOAT,!1,0,0),this.instBuf=t.createBuffer(),t.bindBuffer(t.ARRAY_BUFFER,this.instBuf);for(const[s,a]of[[1,0],[2,4]])t.enableVertexAttribArray(s),t.vertexAttribPointer(s,4,t.FLOAT,!1,xt*4,a*4),t.vertexAttribDivisor(s,1);t.bindVertexArray(null),this.tex=t.createTexture(),t.bindTexture(t.TEXTURE_2D,this.tex),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MIN_FILTER,t.NEAREST),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MAG_FILTER,t.NEAREST),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_S,t.CLAMP_TO_EDGE),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_T,t.CLAMP_TO_EDGE)}resize(t,e,s,a){(this.canvas.width!==t||this.canvas.height!==e)&&(this.canvas.width=t,this.canvas.height=e,this.blank=!1);const r=`${s}px`,i=`${a}px`;this.canvas.style.width!==r&&(this.canvas.style.width=r),this.canvas.style.height!==i&&(this.canvas.style.height=i)}begin(){this.nOrbs=0,this.nInst=0}orb(t){(this.nOrbs+1)*dt>this.orbData.length&&(this.orbData=me(this.orbData));const e=this.orbData,s=this.nOrbs*dt;return e[s]=t.x,e[s+1]=t.y,e[s+2]=t.r,e[s+3]=t.seed,e[s+4]=t.rgb[0],e[s+5]=t.rgb[1],e[s+6]=t.rgb[2],e[s+7]=t.alpha,e[s+8]=t.run,e[s+9]=t.done,e[s+10]=t.fail,e[s+11]=t.wait,e[s+12]=t.flash,e[s+13]=t.t,e[s+14]=t.hover,e[s+15]=t.open,e[s+16]=t.breath,e[s+17]=t.phase,e[s+18]=t.aux,e[s+19]=0,this.nOrbs++}quad(t,e,s,a,r,i){if(s<=0||a<=0||i<=0||t+s<0||e+a<0||t>this.canvas.width||e>this.canvas.height)return;(this.nInst+1)*xt>this.instData.length&&(this.instData=me(this.instData));const n=this.instData,c=this.nInst++*xt;n[c]=t,n[c+1]=e,n[c+2]=s,n[c+3]=a,n[c+4]=r,n[c+5]=i,n[c+6]=0,n[c+7]=0}draw(t,e,s,a,r){const i=this.gl;if(i.isContextLost())return;if(this.nInst===0){if(this.blank)return;i.viewport(0,0,this.canvas.width,this.canvas.height),i.clearColor(0,0,0,0),i.clear(i.COLOR_BUFFER_BIT),this.blank=!0;return}const n=this.program(t);if(i.viewport(0,0,this.canvas.width,this.canvas.height),i.clearColor(0,0,0,0),i.clear(i.COLOR_BUFFER_BIT),this.blank=!n,!n)return;i.activeTexture(i.TEXTURE0),i.bindTexture(i.TEXTURE_2D,this.tex);const c=Math.max(1,this.nOrbs);c>this.texRows&&(this.texRows=Math.max(64,1<<Math.ceil(Math.log2(c))),i.texImage2D(i.TEXTURE_2D,0,i.RGBA32F,dt/4,this.texRows,0,i.RGBA,i.FLOAT,null)),i.texSubImage2D(i.TEXTURE_2D,0,0,0,dt/4,c,i.RGBA,i.FLOAT,this.orbData.subarray(0,c*dt)),i.useProgram(n.program),i.uniform2f(n.u.view,this.canvas.width,this.canvas.height),i.uniform1f(n.u.dpr,s),this.params.fill(0);for(let l=0;l<Math.min(Zt,e.length);l++)this.params[l]=e[l];i.uniform1fv(n.u.p,this.params),i.uniform4f(n.u.grid,a[0],a[1],a[2],a[3]),i.uniform1f(n.u.reduced,r?1:0),i.uniform1i(n.u.orbs,0),i.enable(i.BLEND),i.blendFunc(i.ONE,i.ONE_MINUS_SRC_ALPHA),i.bindVertexArray(this.vao),i.bindBuffer(i.ARRAY_BUFFER,this.instBuf),i.bufferData(i.ARRAY_BUFFER,this.instData.subarray(0,this.nInst*xt),i.DYNAMIC_DRAW),i.drawArraysInstanced(i.TRIANGLES,0,6,this.nInst),i.bindVertexArray(null)}program(t){const e=this.programs.get(t.id);if(e)return e;if(this.failed.has(t.id))return null;const s=this.gl;try{const a=`#version 300 es
${t.defines}
${uo}
${t.glsl}
${t.row?go:mo}`,r=wo(s,po,a),i=c=>s.getUniformLocation(r,c),n={program:r,u:{view:i("u_view"),dpr:i("u_dpr"),p:i("u_p"),grid:i("u_grid"),reduced:i("u_reduced"),orbs:i("u_orbs")}};return this.programs.set(t.id,n),this.error=null,n}catch(a){return this.error=String(a),console.error(a),s.isContextLost()||this.failed.add(t.id),null}}destroy(){this.canvas.remove()}}function me(o){const t=new Float32Array(o.length*2);return t.set(o),t}function wo(o,t,e){const s=o.createProgram();for(const[a,r]of[[o.VERTEX_SHADER,t],[o.FRAGMENT_SHADER,e]]){const i=o.createShader(a);if(o.shaderSource(i,r),o.compileShader(i),!o.getShaderParameter(i,o.COMPILE_STATUS)){const n=r.split(`
`).map((c,l)=>`${l+1}: ${c}`).join(`
`);throw new Error(`shader compile failed: ${o.getShaderInfoLog(i)}
${n}`)}o.attachShader(s,i)}if(o.linkProgram(s),!o.getProgramParameter(s,o.LINK_STATUS))throw new Error(`link failed: ${o.getProgramInfoLog(s)}`);return s}const xo=(o,t=6,e=28)=>z("size","Size",o,t,e,1,"px"),bo=o=>z("spacing","Spacing",o,8,44,1,"px"),yo=(o="parent")=>Dt("color","Colour",["parent","own"],o),at=(o,t,e="parent",s=6,a=28)=>[xo(o,s,a),bo(t),oo,yo(e)],ht=o=>(t,e,s)=>{const a=Math.max(o*e,e*1.06+4*s)+2;return[a,a,a,a]},ko=`
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
}`,Mo={id:"glass",name:"Glass orbs",note:"A tiny glass sphere with Fresnel rim light and a soft highlight; domain-warped noise swirls inside while it works and stills once it’s done.",params:[...at(12,19),z("rim","Rim light",.7,0,1.5,.05),z("spec","Highlight",.75,0,1.5,.05),z("scale","Noise scale",1.1,.4,4,.05),z("glow","Glow",1,0,2,.05)],row:!1,reach:ht(1.8),anchor:"centre",still:3.1,glsl:ko},ge=new Map;function _o(o){let t=ge.get(o.id);return t||ge.set(o.id,t={id:o.id,glsl:o.glsl,row:o.row,defines:so(o.params)}),t}const Ao=10,ve=140,Eo=70,So=220,Ro=120,Co=450,we=160,$o="-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter Variable', ui-sans-serif, system-ui, sans-serif",qt=It(.4,0,.2,1);class Lo{ctx=new OffscreenCanvas(1,1).getContext("2d");cache=new Map;width=(t,e,s=12)=>{const a=`${e}|${s}|${t}`;let r=this.cache.get(a);return r===void 0&&(this.ctx.font=`${e} ${s}px ${$o}`,r=this.ctx.measureText(t).width,this.cache.set(a,r)),r};reset(){this.cache.clear()}}class bt{constructor(t,e){this.dur=e,this.from=this.to=t}dur;from;to;start=-1e9;at(t){const e=qt(G((t-this.start)/this.dur));return this.from+(this.to-this.from)*e}set(t,e){Math.abs(t-this.to)<1e-6||(this.from=this.at(e),this.to=t,this.start=e)}moving(t){return t-this.start<this.dur}get target(){return this.to}}class Po{constructor(t,e,s){this.layer=e,this.actions=s,this.tip=document.createElement("div"),this.tip.className="sa-tip",this.tip.hidden=!0,t.appendChild(this.tip)}layer;actions;text=new Lo;animating=!1;alive=!1;drawn=[];rows=new Map;tip;tipShown=!1;tipAlpha=0;hovered=null;hoveredAt=0;clicked=null;labelFor=null;labelShownAt=0;labelHiddenAt=-1e9;hoverValue=new Map;styleCache=new WeakMap;tipSize=new Map;params=new Float32Array(16);seen=new Set;hover(t,e){const s=this.hoverValue.get(t);if(!s)return 0;const a=qt(G((e-s.at)/ve)),r=s.v+(s.to-s.v)*a;return a>=1&&s.to===0&&this.hoverValue.delete(t),r}anchor(t,e,s){const a=this.rows.get(t);if(!a)return null;if(a.mode==="merged")return a.x0;if(a.mode==="hidden")return null;const r=a.slots.get(e);return r&&r.alpha.target>.5?a.x0+r.u.at(s)*a.S:a.x0+a.more.u.at(s)*a.S+Math.max(a.D,a.S)/2+2+(this.text.width(a.more.text,600,12)+8)/2}begin(t){this.animating=!1,this.alive=!1,this.drawn=[],this.seen.clear(),this.tipShown=!1,this.layer.begin(),this.updateLabel(t),this.tipAlpha=qt(G((t-this.labelShownAt)/Ro)),(this.hovered!==this.labelFor||this.tipAlpha<1)&&(this.animating=!0)}element(t,e){const s=this.rows.get(t)??this.createRow(t,e);return s.el.parentElement!==e&&e.appendChild(s.el),s.el}layout(t,e,s,a,r,i){const n=this.rows.get(t);if(!n)return Math.min(a,r);const c=e.kids.length,l=Number(s.p.size),p=Number(s.p.spacing),f=n.more.el.dataset.all==="1",d=f?c:Math.min(c,Math.max(1,s.max)),v=S=>S<c?this.text.width(`+${c-S}`,600,12)+12:0,u=s.gap??Ao,R=S=>u+l+(S-1)*p+(S<c?Math.max(l,p)/2-l/2+2+v(S):0),b=r-a,P=S=>n.mode===S?-4:4;let A=d;for(;A>0&&R(A)>b-(A>n.shown?3:0);)A--;const y=Math.min(c,2),m=c>1?this.text.width(String(c),600,11)+6:0,k=u+l+8+m;let M,$=a;A>=y&&R(y)<=b-P("row")?M="row":k<=b-P("merged")?M="merged":r-k>=56+P("merged")?(M="merged",$=r-k):(M="hidden",$=Math.min(a,r)),M==="row"&&(A=Math.max(A,y)),n.mode=M,n.shown=M==="row"?A:0;let w=0;for(const S of e.kids){const _=n.slots.get(S.view.id)??this.createSlot(n,S.view.id),h=M==="row"&&w<A;_.u.set(M==="row"?Math.min(w,A):0,i),_.alpha.set(h?1:0,i);const g=`${S.view.title}: ${Gt(S.view)}${S.view.look.open>.5?", expanded":""}`;_.label!==g&&(_.label=g,_.el.setAttribute("aria-label",g)),w++}for(const[S,_]of n.slots)e.kids.some(h=>h.view.id===S)||(_.el.remove(),n.slots.delete(S));n.agg.alpha.set(M==="merged"?1:0,i);const E=M==="row"&&A<c?`+${c-A}`:f&&M==="row"&&c>Math.max(1,s.max)?"−":"";if(n.more.u.set(Math.max(0,A-1),i),n.more.alpha.set(E?1:0,i),E&&E!==n.more.text){n.more.text=E,n.more.el.textContent=E;const S=e.kids.slice(A).map(h=>h.view),_=E==="−"?"Show fewer":`${c-A} more: ${xe(S)}`;n.more.el.dataset.label=_,n.more.el.setAttribute("aria-label",_)}const T=c>1?String(c):"";T!==n.agg.text&&(n.agg.text=T,n.agg.el.textContent=T);const q=c===1?`${e.kids[0].view.title}: ${Gt(e.kids[0].view)}`:`${c} subagents: ${xe(e.kids.map(S=>S.view))} · click to zoom in`;return q!==n.agg.label&&(n.agg.label=q,n.agg.el.setAttribute("aria-label",q)),n.x0=Math.max(0,Math.min($,r))+u+l/2,n.S=p,n.D=l,Math.max(0,Math.min($,r))}draw(t,e,s,a,r){const i=this.rows.get(t);if(!i)return;this.seen.add(t);const n=this.layer,{tech:c,p:l}=s,{px:p,y:f,w:d,opacity:v,dpr:u,anchorY:R}=a,b=L=>Math.round(L*u)/u,{x0:P,S:A,D:y}=i,m=n.nOrbs;let k=1/0,M=-1/0;const $=c.reach(l,y/2*u,u),w=(L,D,x,C)=>{const B=p+P+x*A;C*=G((p+d-(B+y/2))/6+1);const H=D?D.view.look:e.agg,U=D?D.view.seed:500+t.length;n.orb({x:B*u,y:f*u,r:y/2*u,seed:U%97,rgb:Ve(D?D.rgb:e.rgb),alpha:C*v,run:H.run,done:H.done,fail:H.fail,wait:H.wait,flash:H.flash,t:s.reduced?c.still:D?D.time:e.aggTime,hover:H.hover,open:H.open,breath:H.breath,phase:D?Oo(U*.6180339):e.aggPhase,aux:A*u}),c.row||n.quad(B*u-$[0],f*u-$[1],$[0]+$[2],$[1]+$[3],n.nOrbs-1,1),k=Math.min(k,B),M=Math.max(M,B),this.drawn.push({id:L,x:B,y:f,alpha:C}),!s.reduced&&(H.run+H.wait>.001||H.flash>.001)&&(this.alive=!0)},E=v>.5;for(const L of e.kids){const D=i.slots.get(L.view.id);if(!D)continue;const x=D.alpha.at(r),C=D.u.at(r);x>.002&&w(L.view.id,L,C,x);const B=Math.max(Math.min(A,y+8),12),H=x>.5;if(this.css(D.el,H?`transform:translate(${b(P+C*A-B/2)}px,0);width:${B}px;--badge-x:${Math.round(B/2+y/2-3)}px;--badge-y:${Math.max(0,Math.round(R-y/2-7))}px`:"display:none"),this.setBadge(D,L.unread),H&&E&&this.labelFor===L.view.id){const U=r-this.hoveredAt-Co,Y=s.preview&&L.view.look.open<.5&&U>0&&this.clicked!==L.view.id?L.thumb:null;s.preview&&L.thumb&&U<we&&(this.animating=!0),this.showTip(L.view,p+P+C*A,f-y/2-7,Y,a.vw,f+y/2+7,qt(G(U/we)))}}const T=i.agg.alpha.at(r);T>.002&&w(`agg:${t}`,e.kids.length===1?e.kids[0]:null,0,T);const q=T>.5,S=e.kids.length>1?this.text.width(String(e.kids.length),600,11)+6:0;this.css(i.agg.el,q?`transform:translate(${b(P-y/2-3)}px,0);width:${Math.ceil(y+10+S)}px;--count-x:${y+9}px`:"display:none"),q&&E&&this.labelFor===`agg:${t}`&&this.showText(i.agg.label,p+P,f-y/2-7,a.vw);const _=i.more.alpha.at(r),h=P+i.more.u.at(r)*A+Math.max(y,A)/2+2;this.css(i.more.el,_>.01?`transform:translate(${b(h-4)}px,0);opacity:${_.toFixed(3)};pointer-events:${_>.5?"auto":"none"}`:"display:none"),_>.5&&E&&this.labelFor===`more:${t}`&&this.showText(i.more.el.dataset.label??"",p+h+10,f-y/2-7,a.vw),this.animating||=this.rowMoving(i,r);const g=n.nOrbs-m;c.row&&g>0&&n.quad(k*u-$[0]-A*u,f*u-$[1],(M-k)*u+$[0]+$[2]+2*A*u,$[1]+$[3],m,g)}hide(t){const e=this.rows.get(t);e&&this.css(e.el,"display:none")}show(t){const e=this.rows.get(t);e&&this.css(e.el,"")}remove(t){const e=this.rows.get(t);e&&(e.el.remove(),this.rows.delete(t))}ids(){return this.rows.keys()}end(t,e,s,a){this.tipShown||(this.tip.hidden=!0),ao(t.tech.params,t.p,this.params),this.layer.draw(_o(t.tech),this.params,e,s,t.reduced);for(const r of this.hoverValue.values())(r.to!==1||a-r.at<ve)&&(this.animating=!0)}orbCentre(t,e){let s;if(t.startsWith("agg:"))s=this.rows.get(t.slice(4))?.agg.el;else for(const i of this.rows.values())s??=i.slots.get(t)?.el;if(!s||!s.offsetParent)return null;const a=s.getBoundingClientRect();if(!a.width)return null;const r=e.getBoundingClientRect();return{x:a.left-r.left+a.width/2,y:a.top-r.top+a.height/2}}destroy(){for(const t of this.rows.values())t.el.remove();this.rows.clear(),this.tip.remove()}setHover(t,e){if(t!==this.hovered){for(const s of[this.hovered,t]){if(!s)continue;const a=this.hover(s,e);this.hoverValue.set(s,{v:a,at:e,to:s===t?1:0})}this.hovered=t,this.hoveredAt=e,this.clicked=null}}updateLabel(t){if(this.hovered===this.labelFor)return;if(!this.hovered){this.labelFor&&(this.labelHiddenAt=t),this.labelFor=null;return}const e=!!this.labelFor||t-this.labelHiddenAt<400;t-this.hoveredAt<(e?Eo:So)||(e||(this.labelShownAt=t),this.labelFor=this.hovered)}css(t,e){this.styleCache.get(t)!==e&&(this.styleCache.set(t,e),t.style.cssText=e)}rowMoving(t,e){if(t.agg.alpha.moving(e)||t.more.alpha.moving(e)||t.more.u.moving(e))return!0;for(const s of t.slots.values())if(s.u.moving(e)||s.alpha.moving(e))return!0;return!1}createRow(t,e){const s=document.createElement("div");s.className="sa-orbs",s.dataset.session=t,e.appendChild(s);const a=(c,l,p)=>{const f=document.createElement("button");return f.type="button",f.className=c,f.addEventListener("pointerdown",d=>d.stopPropagation()),f.addEventListener("dblclick",d=>d.stopPropagation()),f.addEventListener("click",d=>(d.stopPropagation(),l())),this.hoverable(f,p),s.appendChild(f),f},r=a("sa-more",()=>{r.dataset.all=r.dataset.all==="1"?"":"1",this.actions.showAll(t)},`more:${t}`),i=a("sa-agg",()=>this.actions.zoomTo(t),`agg:${t}`),n={el:s,x0:0,S:16,D:10,mode:"row",shown:0,slots:new Map,more:{el:r,u:new bt(0,240),alpha:new bt(0,200),text:""},agg:{el:i,alpha:new bt(0,320),text:"",label:""}};return this.rows.set(t,n),n}createSlot(t,e){const s=document.createElement("button");s.type="button",s.className="sa-orb",s.dataset.id=e,s.addEventListener("pointerdown",i=>i.stopPropagation()),s.addEventListener("dblclick",i=>i.stopPropagation()),s.addEventListener("click",i=>{i.stopPropagation(),this.clicked=e,this.actions.toggleKid(e,i.shiftKey)}),s.addEventListener("keydown",i=>{if(i.key!=="ArrowLeft"&&i.key!=="ArrowRight")return;const n=[...t.slots.values()].filter(p=>p.alpha.target>.5).sort((p,f)=>p.u.target-f.u.target),c=n.findIndex(p=>p.el===s),l=n[c+(i.key==="ArrowLeft"?-1:1)];l&&(i.preventDefault(),i.stopPropagation(),l.el.focus())}),this.hoverable(s,e),t.el.insertBefore(s,t.el.firstChild);const a=document.createElement("span");a.className="sa-badge",a.hidden=!0,s.appendChild(a);const r={el:s,badge:a,unread:0,u:new bt(t.slots.size,300),alpha:new bt(0,260),label:""};return t.slots.set(e,r),r}hoverable(t,e){const s=()=>this.setHover(e,performance.now()),a=()=>{this.hovered===e&&this.setHover(null,performance.now())};t.addEventListener("pointerenter",s),t.addEventListener("pointerleave",a),t.addEventListener("focus",()=>t.matches(":focus-visible")&&s()),t.addEventListener("blur",a)}showTip(t,e,s,a,r,i,n){const c=`<span class="line"><span class="nm">${t.agent?`<span class="agent">${yt(t.agent)}:</span> `:""}${yt(t.task)}</span><span class="st ${t.state}">${yt(Gt(t))}</span></span>`;this.showHtml(a?`<img class="thumb" src="${yt(a)}" alt="">${c}`:c,e,s,r,!!a,i,n)}showText(t,e,s,a){this.showHtml(`<span class="line"><span class="nm">${yt(t)}</span></span>`,e,s,a,!1)}showHtml(t,e,s,a,r,i=s,n=1){this.tipShown=!0,this.tip.innerHTML!==t&&(this.tip.innerHTML=t),this.tip.hidden=!1,this.tip.classList.toggle("with-thumb",r),this.tipSize.size>200&&this.tipSize.clear();let c=this.tipSize.get(t);c||this.tipSize.set(t,c={w:this.tip.offsetWidth,h:r?170:this.tip.offsetHeight});const l=Math.max(c.w/2+6,Math.min(a-c.w/2-6,e)),p=s-c.h<4;this.css(this.tip,`transform:translate(${Math.round(l)}px,${Math.round(p?i:s)}px) translate(-50%,${p?0:-100}%);opacity:${this.tipAlpha.toFixed(3)};--thumb:${n.toFixed(3)}`)}setBadge(t,e){if(t.unread===e)return;const s=e>t.unread;t.unread=e,t.badge.hidden=e===0,t.badge.textContent=e>9?"9+":String(e),s&&(t.badge.classList.remove("pop"),t.badge.offsetWidth,t.badge.classList.add("pop"))}}class To{look={run:0,done:1,fail:0,wait:0,flash:0,open:0,hover:0,breath:0};time;phase;constructor(t){this.time=t.length,this.phase=t.charCodeAt(9)%17/17}update(t,e,s,a,r,i){const n=f=>t.some(d=>d.state===f),c=n("running")?"run":n("waiting")?"wait":n("failed")?"fail":"done",l=1-Math.exp(-s/150),p=this.look;for(const f of["run","done","fail","wait"]){const d=f===c?1:0;p[f]+=(d-p[f])*l,Math.abs(d-p[f])<.002&&(p[f]=d)}return p.flash=Math.max(0,...t.map(f=>f.look.flash)),p.hover=i,p.breath=r?.6:.5-.5*Math.cos(e/1e3/2.4*2*Math.PI),this.time+=s/1e3*a*(p.run+.35*p.wait),{agg:p,aggTime:this.time,aggPhase:this.phase}}}function zo(o){const t=e=>e<.001||e>.999;for(const e of o)if(!t(e.run)||!t(e.done)||!t(e.fail)||!t(e.wait)||e.flash>0||!t(e.open)||!t(e.hover))return!0;return!1}function Gt(o){const t=o.elapsed;return o.state==="running"?t?`running · ${t}`:"running":o.state==="done"?t?`done in ${t}`:"done":o.state==="failed"?t?`failed after ${t}`:"failed":"waiting for an answer"}function xe(o){const t={running:0,waiting:0,failed:0,done:0};for(const s of o)t[s.state]++;const e=[];return t.running&&e.push(`${t.running} running`),t.waiting&&e.push(`${t.waiting} waiting`),t.failed&&e.push(`${t.failed} failed`),t.done&&e.push(`${t.done} done`),e.join(" · ")}const Oo=o=>o-Math.floor(o);function yt(o){return o.replace(/[&<>"]/g,t=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"})[t])}function Fo(o){const t=o.defaults();try{o.restore(JSON.parse(localStorage.getItem(o.storageKey)??"{}"),t)}catch{}try{const w=/[#&]s=([^&]+)/.exec(location.hash);w&&o.restore(JSON.parse(decodeURIComponent(w[1])),t)}catch(w){console.warn("ignoring an unreadable settings hash",w)}let e=0;const s=()=>{clearTimeout(e),e=window.setTimeout(()=>{const w=JSON.stringify(o.share(t));localStorage.setItem(o.storageKey,w),history.replaceState(null,"",`#s=${encodeURIComponent(w)}`)},150)};document.title=`${o.title} · Frame status playground`;const a=O("div","pg-app"),r=O("nav","c-tabs");r.setAttribute("aria-label","Playgrounds");for(const w of no){const E=O("a","",w.name);E.href=w.href,w.id===o.site&&E.setAttribute("aria-current","page"),r.append(E)}const i=O("a","pg-brand","Frame status");i.href=`${io}/playground`;const n=O("span","pg-readout pg-fps");n.title="Frames per second";const c=O("span","pg-readout pg-zoom");c.title="Zoom";const l=O("div","pg-toolbar",i,r,O("span","pg-spacer"),n,c),p=O("div","pg-demo");p.tabIndex=0;const f=O("div","pg-caption");p.append(f);const d=O("main","pg-main",l,p),v=O("div","pg-panel-body"),u=et("Copy settings",()=>{b()},"primary",!0),R=O("aside","pg-panel",O("header","pg-panel-head",O("h1","",o.title),u),v);a.append(d,R),document.body.append(a);async function b(){const w=JSON.stringify(o.exportJson(t),null,2);try{await navigator.clipboard.writeText(w)}catch{const E=O("textarea");E.value=w,document.body.append(E),E.select(),document.execCommand("copy"),E.remove()}console.log(w),u.textContent="Copied",setTimeout(()=>u.textContent="Copy settings",1200)}window.playgroundSettings=()=>o.exportJson(t);function P(w,E){const T=O("div","pg-stack"),q=O("div","pg-section-head",O("h2","",w));return E&&q.append(E),v.append(O("section","pg-section",q,T)),T}function A(w,E){f.replaceChildren(O("b","",w),O("span","",E)),f.title=E}const y=[];let m=performance.now();const k=[];let M=0;const $=w=>{requestAnimationFrame($);const E=Math.max(0,Math.min(100,w-m));if(m=w,k.push(E),k.length>60&&k.shift(),w-M>500&&k.length>5){M=w;const T=1e3/(k.reduce((q,S)=>q+S,0)/k.length);n.textContent=`${Math.round(T)} fps`,n.dataset.fps=String(T)}for(const T of y)try{T(E,w)}catch(q){console.error(q)}};return requestAnimationFrame($),{settings:t,save:s,section:P,setCaption:A,demo:p,toolbar:l,panelBody:v,setZoom:w=>c.textContent=`${Math.round(w*100)}%`,onTick:w=>y.push(w)}}function Io(o,t,e,s){const a=ro(t.map((r,i)=>({id:r.id,name:r.name,key:String(i+1),title:r.note})),e,s,"Variation");return o.section("Variation").append(a.el),window.addEventListener("keydown",r=>{if(r.target.closest('input, textarea, [role="slider"]')||r.metaKey||r.ctrlKey||r.altKey)return;const i=Number(r.key)-1;Number.isInteger(i)&&i>=0&&i<t.length&&a.select(t[i].id)}),a}function Do(o,t,e,s,a,r){const i=et("Reset",()=>{r(),c(),a()},"ghost",!0),n=o.section(t,i),c=()=>n.replaceChildren(...e().map(l=>Vt(l,s(),a,co)));return c(),{render:c}}function No(o,t,e){const s=t??{};for(const a of o)s[a.id]&&(e[a.id]=Bt(a.params,{...e[a.id],...s[a.id]}))}function Bo(o,t){const e={};for(const s of o){const a=Nt(s.params,t[s.id]);Object.keys(a).length&&(e[s.id]=a)}return e}const ft=24;class qo{constructor(t,e,s,a){this.editor=e,this.orbs=s,this.actions=a,this.host=document.createElement("div"),this.host.className="sa-chrome",t.appendChild(this.host),this.rows=new Po(this.host,s,a),this.wires=document.createElementNS("http://www.w3.org/2000/svg","svg"),this.wires.classList.add("sa-wires"),this.host.insertBefore(this.wires,this.host.firstChild)}editor;orbs;actions;host;heads=new Map;links=new Map;wires;styleCache=new WeakMap;rows;get text(){return this.rows.text}get animating(){return this.rows.animating}get alive(){return this.rows.alive}get drawn(){return this.rows.drawn}anchor(t,e,s){return this.rows.anchor(t,e,s)}hover(t,e){return this.rows.hover(t,e)}css(t,e){this.styleCache.get(t)!==e&&(this.styleCache.set(t,e),t.style.cssText=e)}draw(t,e,s,a,r,i){const n=this.editor.camera.peek(),{w:c,h:l}=this.editor.viewport.peek(),p=m=>Math.round(m*i)/i,f=a.tech,d=a.p,v=Number(d.size),u=p(f.anchor==="baseline"?ft/2+.363*a.titlePx:ft/2);this.rows.begin(r);const R=new Set,b=m=>({x:(m.x+n.x)*n.z,y:(m.y+n.y)*n.z,w:m.w*n.z,h:m.h*n.z}),P=t.cards.filter(m=>m.fit==="overlay"&&m.opacity>.01).map(m=>({c:m,b:b(m.box)})),A=new Map;for(const m of t.heads){const k=e.get(m.id);if(!k)continue;const M=p((m.box.x+n.x)*n.z),$=p((m.box.y+n.y)*n.z),w=m.inCard?m.box.w*n.z:m.parentId?Math.max(m.box.w*n.z,Math.min(300,m.box.w*n.z*2.5)):m.box.w*n.z;let E=0;for(const{c:x,b:C}of P)x.parentId===m.id||x.parentId===m.parentId||x.id===m.id||M<C.x+C.w&&M+w>C.x&&$<C.y+C.h&&$+ft>C.y&&(E=Math.max(E,x.opacity));const T=m.opacity*(1-E),q=f.anchor==="baseline"?Number(d.height??0):0,S=T>.01&&M<c&&M+w>0&&$-q<l&&$+ft+40>0&&w>24;let _=this.heads.get(m.id);if(!S){_&&this.css(_.el,"display:none");continue}R.add(m.id),_||(_=this.createHead(m.id),this.heads.set(m.id,_));const h=s.get(m.id),g=k.child?this.text.width(k.agent??"",500,a.titlePx)+5+this.text.width(k.task??"",600,a.titlePx):this.text.width(k.title,600,a.titlePx);let L=Math.min(g,w);if(h&&h.kids.length){this.rows.element(m.id,_.el),_.row=!0,L=this.rows.layout(m.id,h,a,g,w,r);const x=$+u;A.set(m.id,{px:M,y:x}),this.rows.draw(m.id,h,a,{px:M,y:x,w,opacity:T,anchorY:u,dpr:i,vw:c},r)}else _.row&&(this.rows.remove(m.id),_.row=!1);let D=k.status??"";if(m.inCard){const x=w-30;D&&g+this.text.width(D,500,12)+10>x&&(D=""),L=Math.max(0,Math.min(g,x))}this.fillHead(_,{...k,status:D},L,m.inCard),this.css(_.el,`transform:translate(${M}px,${$}px);width:${Math.max(0,Math.floor(w))}px;opacity:${T.toFixed(3)};--title:${a.titlePx}px;--status-x:${Math.ceil(L)+8}px`)}for(const[m,k]of this.heads)R.has(m)||this.css(k.el,"display:none");this.drawLinks(t.cards,A,u,v,r,p);const y=[Math.round(n.x*n.z*i),Math.round(n.y*n.z*i),Math.max(2,Math.round(5*i)),Math.max(1,Math.floor(2*i+.5))];this.rows.end(a,i,y,r)}createHead(t){const e=document.createElement("div");return e.className="sa-head",e.dataset.session=t,e.innerHTML='<span class="title"></span>',this.host.insertBefore(e,this.host.firstChild),{el:e,title:e.firstChild,key:"",row:!1,status:null,close:null}}fillHead(t,e,s,a){if(this.css(t.title,`max-width:${Math.max(0,Math.ceil(s))}px`),a&&!t.close?(t.status=document.createElement("span"),t.status.className="status",t.close=document.createElement("button"),t.close.type="button",t.close.className="sa-close",t.close.textContent="×",t.close.setAttribute("aria-label",`Collapse ${e.title}`),t.close.addEventListener("pointerdown",i=>i.stopPropagation()),t.close.addEventListener("click",i=>(i.stopPropagation(),this.actions.toggleKid(e.id,!0))),t.el.append(t.status,t.close)):!a&&t.close&&(t.status?.remove(),t.close.remove(),t.status=t.close=null),t.el.classList.toggle("in-card",a),t.status){const i=e.status??"";t.status.textContent!==i&&(t.status.textContent=i);const n=`status ${e.statusKind??""}`;t.status.className!==n&&(t.status.className=n)}const r=`${e.title}|${e.child}`;t.key!==r&&(t.key=r,t.el.classList.toggle("child",e.child),e.child?t.title.innerHTML='<span class="agent"></span><span class="task"></span>':t.title.innerHTML='<span class="task"></span>',e.child&&(t.title.firstChild.textContent=e.agent??""),t.title.lastChild.textContent=e.child?e.task??"":e.title)}drawLinks(t,e,s,a,r,i){const n=this.editor.camera.peek(),c=new Set,l=new Map,p=new Map;for(const d of t)d.fit!=="drawer"&&p.set(d.parentId,[...p.get(d.parentId)??[],d]);for(const d of p.values())d.sort((v,u)=>v.orbX-u.orbX).forEach((v,u)=>l.set(v.id,{i:u,n:d.length}));const f=new Map;for(const d of t)d.fit==="drawer"&&d.caret>.01&&(!f.has(d.parentId)||d.box.y<f.get(d.parentId).box.y)&&f.set(d.parentId,d);for(const d of t){const v=e.get(d.parentId);if(!v||d.caret<.01||d.fit==="drawer"&&f.get(d.parentId)!==d)continue;const u=this.anchor(d.parentId,d.id,r),R=v.px+(u??40),b=(d.orbX+n.x)*n.z,P=i((d.box.y+n.y)*n.z),A=(d.box.x+n.x)*n.z,y=d.box.w*n.z,m=d.caret,k=i(Math.max(A+12,Math.min(A+y-12,b)));let M=this.links.get(d.id);if(!M){const _=document.createElement("div");_.className="sa-caret",_.style.setProperty("--fill",We.frame),this.host.insertBefore(_,this.wires.nextSibling);const h=document.createElementNS("http://www.w3.org/2000/svg","path");this.wires.appendChild(h),M={caret:_,wire:h},this.links.set(d.id,M)}c.add(d.id);const $=m;this.css(M.caret,`transform:translate(${k-6}px,${P-6}px) scale(${(.4+.6*m).toFixed(3)}) rotate(45deg);opacity:${$.toFixed(3)}`);const w=i(v.y+a/2+3),E=P-8,T=i(R);let q="";if(E-w>2)if(Math.abs(k-T)<1)q=`M${T} ${w}V${E}`;else{const _=l.get(d.id),h=_&&_.n>1?Math.round(Math.max(w+3,E-4-(_.n-1-_.i)*Math.min(4,(E-w-7)/Math.max(1,_.n-1)))):Math.round((w+E)/2),g=Math.min(4,Math.abs(k-T)/2,(E-w)/4),L=Math.sign(k-T);q=`M${T} ${w}V${h-g}Q${T} ${h} ${T+L*g} ${h}H${k-L*g}Q${k} ${h} ${k} ${h+g}V${E}`}M.wire.getAttribute("d")!==q&&M.wire.setAttribute("d",q);const S=$.toFixed(3);M.wire.getAttribute("opacity")!==S&&M.wire.setAttribute("opacity",S)}for(const[d,v]of this.links)c.has(d)||(v.caret.remove(),v.wire.remove(),this.links.delete(d))}orbCentre(t){return this.rows.orbCentre(t,this.host)}destroy(){this.host.remove()}}const Go=[{key:"coordinator",title:"Canvas build: coordinator",color:"#60a5fa",busy:!0,agent:"build",unread:2,asking:!1,shots:[1.6,1.33,1.78,1,1.5,1.2,1.6,.8],count:14,kids:[["Explore: render loop","running",[1.5]],["General: subagent frames demo","running",[1.78,1.33]],["Explore: competitor heroes","done",[{a:4.2,w:4200},1.78]],["General: fix flaky upload test","done",[1.6,1.2]],["General: mobile onboarding","done",[{a:.5,w:900},1.33]],["Review: page items","failed",[1.33]],["Explore: auth flow","waiting",[1.5,1]],["General: HTML side drawer","done",[1.78,1.5]],["General: precise highlights","done",[1.6]],["Explore: ember band timing","running",[1.78]],["Review: frame chrome copy","done",[1.5]],["General: link cards","done",[1.33,1.6]],["Explore: WebGPU fallbacks","done",[1.6]],["General: unread badge","done",[1.2]],["Explore: video seek latency","running",[1.78]],["General: share dialog","done",[1.5]],["Review: keyboard shortcuts","done",[1.33]],["General: canvas list previews","done",[1.6]],["Explore: Safari texture upload","done",[1.5]],["General: presence bar","done",[1.78]]]},{key:"hero",title:"Landing hero explorations",color:"#f472b6",busy:!1,agent:"build",unread:0,asking:!0,shots:[1.78,1.78,1.5,1.33],kids:[["General: hero variants, round 3","running",[1.78,1.78]],["Explore: brand assets","done",[1.33,1,1.5]],["Review: contrast pass","done",[1.5]]]},{key:"shader",title:"Shader study: rounded SDF",color:"#a78bfa",busy:!1,agent:"plan",unread:0,asking:!1,shots:[1.33,1,1.5,.8],kids:[]},{key:"video",title:"Perf: video pool",color:"#2dd4bf",busy:!0,agent:"build",unread:1,asking:!1,shots:[2.4,1.78,1.2],kids:[["Explore: map video pool","done",[1.5]],["General: decoder reuse","running",[1.78,1.6]],["General: frame pacing traces","running",[2.2]],["Review: memory","done",[1.33]],["Explore: importExternalTexture","done",[1.6]],["General: poster frames","done",[1.5,1.2]],["Explore: seek latency","done",[1.78]],["Review: leak check","failed",[1.33]]]},{key:"flaky",title:"Fix flaky upload test",color:"#fb923c",busy:!1,agent:"build",unread:0,asking:!1,shots:[2.2,1.6],kids:[["Explore: find the race","done",[1.6]]]}];function Xo(o,t){const e=`ses_demo${o}`;for(let s=0;s<1e3;s++){const a=`${e}${s.toString(36)}`.padEnd(30,"0").slice(0,30);if(Ht(a)===t)return a}return e.padEnd(30,"0").slice(0,30)}function te(o){return()=>{o|=0,o=o+1831565813|0;let t=Math.imul(o^o>>>15,1|o);return t=t+Math.imul(t^t>>>7,61|t)^t,((t^t>>>14)>>>0)/4294967296}}function Ho(o){const t=parseInt(o.slice(1),16),e=(t>>16&255)/255,s=(t>>8&255)/255,a=(t&255)/255,r=Math.max(e,s,a),i=Math.min(e,s,a);if(r===i)return 0;const n=r-i;return(r===e?(s-a)/n+(s<a?6:0):r===s?(a-e)/n+2:(e-s)/n+4)*60}async function Uo(o,t,e){const a=Math.round(e>=1?Math.min(1280,640*Math.min(e,2)):640*e),r=Math.round(a/e),i=new OffscreenCanvas(a,r),n=i.getContext("2d"),c=t+(o()-.5)*70,l=c+20+o()*50,p=18+o()*22,f=n.createLinearGradient(0,0,a*o(),r);if(f.addColorStop(0,`hsl(${c} ${p}% ${16+o()*10}%)`),f.addColorStop(1,`hsl(${l} ${p+6}% ${26+o()*14}%)`),n.fillStyle=f,n.fillRect(0,0,a,r),o()<.45){const v=a*(.25+o()*.5),u=r*(.3+o()*.4),R=Math.min(a,r)*(.25+o()*.2),b=n.createRadialGradient(v,u,0,v,u,R);b.addColorStop(0,`hsl(${l+30} ${p+14}% ${50+o()*14}% / 0.75)`),b.addColorStop(1,`hsl(${l+30} ${p}% 40% / 0)`),n.fillStyle=b,n.fillRect(0,0,a,r)}else{const v=Math.min(a,r)/20;n.fillStyle="rgba(255,255,255,0.07)",n.fillRect(0,0,a,v*2),n.fillStyle="rgba(255,255,255,0.14)";const u=a*.08;let R=r*(.22+o()*.1);for(let b=0;b<4&&R<r*.85;b++)n.fillRect(u,R,a*(.25+o()*.5)*(b?.8:1),v*(b?.7:1.3)),R+=v*(b?1.6:2.6),n.fillStyle="rgba(255,255,255,0.08)";o()<.6&&(n.fillStyle=`hsl(${l+40} ${p+20}% 58% / 0.55)`,n.beginPath(),n.roundRect(u,Math.min(r-v*3,R+v),a*.16,v*1.6,v*.4),n.fill())}const d=await i.convertToBlob({type:"image/png"});return URL.createObjectURL(d)}async function jo(o="playground"){const t=[],e=[],s=[],a=[];let r=1e6;const i=(c,l,p,f)=>{const d=te(f),v=Ho(l);p.forEach((u,R)=>{const b=typeof u=="number"?u:u.a,P=typeof u=="number"?Math.round(1e3*b):u.w??Math.round(1e3*b),A={id:`${c}-i${R}`,canvasId:o,sessionId:c,kind:"image",name:`shot-${R+1}.png`,src:"",thumb:"",width:P,height:Math.round(P/b),createdAt:r--};e.push(A),a.push(Uo(d,v,b).then(y=>{A.src=y,A.thumb=y}))})},n=te(7);return Go.forEach((c,l)=>{const p=Xo(c.key,c.color);t.push({id:p,canvasId:o,title:c.title,createdAt:1e3+l}),i(p,c.color,c.shots,100+l);const f=c.kids.map(([d,v,u],R)=>{const b=`${p.slice(0,22)}k${String(R).padStart(2,"0")}`.padEnd(30,"0");t.push({id:b,canvasId:o,title:d,createdAt:2e3+l*40+R}),i(b,Ht(b),u,1e3+l*50+R);const[P,...A]=d.split(": "),y=v==="running"||v==="waiting"?20+n()*150:200+n()*900,m=v==="running"||v==="waiting"?y:40+n()*160;return{id:b,title:d,agent:P,task:A.join(": ")||d,state:v,startedAgo:y,ran:m}});s.push({parentId:p,title:c.title,color:Ht(p),busy:c.busy,agent:c.agent,unread:c.unread,asking:c.asking,kids:f,count:c.count??f.length})}),await Promise.all(a),{sessions:t,items:e,families:s}}class Ko extends Ye{plan=Je("plan",null);naturalLayout=pe("naturalLayout",()=>Ke(this.sessions.get(),this.items.get(),this.sessionOrder.get(),this.itemLimits.get()));layout=pe("layout",()=>this.plan.get()?.layout??this.naturalLayout.get())}const Vo=typeof matchMedia=="function"&&matchMedia("(prefers-reduced-motion: reduce)").matches,At=[z("title","Title size",14,12,20,1,"px"),z("max","Before +N",8,2,20,1),_t("reduced","Reduced motion",Vo),_t("busy","Busy band",!0)],Et=[Dt("fit","Fit",["overlay","push","drawer","below"],"push"),Dt("switch","Switching",["morph","swap"],"morph"),z("scale","Scale",1,.4,1,.01,"×"),z("dur","Duration",360,0,1400,10,"ms"),Dt("ease","Easing",["standard","decelerate","in-out"],"standard"),z("stagger","Stagger",40,0,120,5,"ms")],St=[_t("preview","Preview on hover",!0),_t("unread","New-item badges",!0),_t("group","Group by state",!1)],ze=["0","1","3","8","15","20"],be=72,ye=12,ke=30,Wo=14,Yo=8,Jo=40,Ot={overlay:1,push:.55,drawer:.35,below:0};function Qo(o){const{natural:t,zoom:e,m:s}=o,a=Tt,r=a.frameHeaderHeight,i={sections:[],groups:[],items:new Map,sectionOf:t.sectionOf,groupOf:t.groupOf,bounds:null},n=[],c=[],l=new Map(t.sections.map(d=>[d.id,d])),p=(s.head+s.headGap)/e;let f=0;for(const d of t.sections){if(o.childIds.has(d.id))continue;const v=(o.families.get(d.id)??[]).filter(y=>y.open>5e-4&&l.has(y.id)),u={x:f,y:0,w:d.box.w,h:d.box.h-r},R={x:u.x,y:u.y-p,w:u.w,h:s.head/e};if(n.push({id:d.id,parentId:null,box:R,frame:u,opacity:1,inCard:!1}),o.fit==="below"){const y=Zo(o,d,u,v,i.items,n),m=nt(t,d,u.x,0,1,i.items);m.box=u,m.header=R,i.sections.push(...y.sections,m),f=y.right+a.frameGap;continue}const b=ts(o,d,u,v,i.items,n,c),P=nt(t,d,u.x,u.y+b.room,1,i.items);P.box={...u,w:Math.max(u.w,b.width),h:u.h+b.room},P.header=R;const A=n.find(y=>y.id===d.id);A.frame=P.box,A.box={...R,w:P.box.w},i.sections.push(...b.sections,P),f=u.x+Math.max(u.w,b.reach)+a.frameGap}return i.groups=i.sections.flatMap(d=>d.groups),i.bounds=ae.union(i.sections.flatMap(d=>[d.box,d.header])),{layout:i,heads:n,cards:c,zoom:e}}function Zo(o,t,e,s,a,r){const{natural:i,zoom:n,m:c}=o,l=Tt.frameHeaderHeight,p=new Map(i.sections.map(b=>[b.id,b])),f=(c.head+c.headGap)/n,d=b=>G(b.open/.5),v=[];let u=e.x+e.w,R=e.y+e.h;for(const b of s){const P=p.get(b.id),A=P.box.h-l,y=o.childScale,m=R+be+f;R+=(be+f+A*y)*d(b),u=Math.max(u,e.x+e.w+(Math.max(e.w,P.box.w*y)-e.w)*d(b));const k=G((b.open-.5)/.5),M=nt(i,P,e.x,m+(1-k)*(12/n),y*(.98+.02*k),a);M.opacity=k,M.header={x:M.box.x,y:M.box.y-f,w:M.box.w,h:c.head/n},r.push({id:P.id,parentId:t.id,box:M.header,frame:M.box,opacity:k,inCard:!1}),v.push(M)}return{sections:v,right:u}}function ts(o,t,e,s,a,r,i){const{natural:n,zoom:c,fit:l}=o,p=Tt,f=p.frameHeaderHeight,d=new Map(n.sections.map(h=>[h.id,h])),v=o.childScale,u=Math.min(p.framePadding,ye/c),R=e.y+ye/c,b=Wo/c,P=Math.max(0,Jo/c-p.framePadding*v),A=h=>{const g=o.anchor(t.id,h);return e.x+(g??40)/c},y=s.map(h=>{const g=d.get(h.id),L=g.box.w*v;return{kid:h,c:g,w:L,h:P+(g.box.h-f)*v,dy:P,left:0,top:R,orbX:A(h.id)}}),m=[],k=e.x+u,M=l==="drawer";let $=0,w=e.w;if(M){const h=Math.max(e.w-u*2,...y.map(x=>x.w)),g=y.length===2&&o.morph?Me(y):null;if(g){const x=g.to.kid.open,C={x:k,y:R,w:h,h:g.from.h+(g.to.h-g.from.h)*x},B=G((x-.1)/.5),H=1-G((x-.6)/.25),U=Math.min(1,C.h/g.from.h),Y=Math.min(1,C.h/g.to.h),Q=nt(n,g.from.c,k,R+g.from.dy*U,v*U,a),st=nt(n,g.to.c,k,R+g.to.dy*Y,v*Y,a);for(const[zt,Ue,je]of[[Q,H,1-G(x/.4)],[st,B,G((x-.5)/.5)]])zt.box=C,zt.header={x:C.x,y:C.y,w:C.w,h:0},zt.opacity=Ue,r.push(Ft(zt.id,t.id,C,v,c,je));const lt=g.from.orbX+(g.to.orbX-g.from.orbX)*x;return m.push({card:{id:g.from.c.id,parentId:t.id,box:C,orbX:lt,opacity:1,shadow:0,caret:0,open:1,fit:l},section:Q,to:0}),m.push({card:{id:g.to.c.id,parentId:t.id,box:C,orbX:lt,opacity:1,shadow:Ot.drawer,caret:1,open:1,fit:l},section:st,to:1}),{sections:Jt(m,i),room:C.y+C.h-e.y,width:Math.max(e.w,h+u*2),reach:Math.max(e.w,h+u*2)}}let L=R,D=0;for(const x of y){const C=x.kid.open,B=1-(1-G(C/.75))**2,H=G((C-.55)/.45),U=x.h*B,Y={x:k,y:L,w:h,h:U},Q=nt(n,x.c,k,L+x.dy,v,a);Q.box=Y,Q.header={x:Y.x,y:Y.y,w:Y.w,h:0},Q.opacity=H,r.push(Ft(x.c.id,t.id,Y,v,c,H));const st=G(C/.25);m.push({card:{id:x.c.id,parentId:t.id,box:Y,orbX:x.orbX,opacity:st,shadow:Ot.drawer*st,caret:st*G((C-.1)/.4),open:C,fit:l},section:Q,to:x.kid.to}),L+=(U+b)*B,D=Math.max(D,B)}return $=Math.max(0,L-R+(R-e.y-b)*D),w=Math.max(e.w,h+u*2),{sections:Jt(m,i),room:$,width:w,reach:w}}const E=e.x+e.w-u,T=y.filter(h=>h.kid.to>.5);let q=k;for(const h of T)h.left=Math.max(h.orbX-ke/c,q),q=h.left+h.w+b;if(T.length){const h=T[T.length-1],g=h.left+h.w-E,L=g>0?Math.min(g,T[0].left-k):0;for(const D of T)D.left-=L}for(const h of T)o.memo.set(h.kid.id,{dx:h.left-e.x,dy:h.top-e.y,w:h.w,h:h.h});for(const h of y){if(h.kid.to>.5)continue;const g=o.memo.get(h.kid.id);g?(h.left=e.x+g.dx,h.top=e.y+g.dy):h.left=Math.max(k,Math.min(h.orbX-ke/c,E-h.w))}const S=o.morph&&T.length===1?Me(y):null,_=S&&o.memo.get(S.from.kid.id);if(S&&_){const h=S.to.kid.open,g=S.to,L=e.x+_.dx,D=e.y+_.dy,x={x:L+(g.left-L)*h,y:D+(g.top-D)*h,w:_.w+(g.w-_.w)*h,h:_.h+(g.h-_.h)*h},C=G((h-.1)/.5),B=1-G((h-.6)/.25),H=S.from.orbX+(g.orbX-S.from.orbX)*h;for(const[U,Y,Q]of[[S.from,B,0],[g,C,1]]){const st=Math.min(1,x.w/U.w,x.h/U.h),lt=nt(n,U.c,x.x,x.y+U.dy*st,v*st,a);lt.box=x,lt.header={x:x.x,y:x.y,w:x.w,h:0},lt.opacity=Y,r.push(Ft(U.c.id,t.id,x,v*st,c,Q?G((h-.5)/.5):1-G(h/.4))),m.push({card:{id:U.c.id,parentId:t.id,box:x,orbX:H,opacity:Y,shadow:Q?Ot[l]*Math.max(C,B):0,caret:Q,open:1,fit:l},section:lt,to:Q})}l==="push"&&($=x.y-e.y+x.h,w=Math.max(e.w,x.x+x.w+u-e.x))}for(const h of y){if(S&&_&&(h===S.from||h===S.to))continue;const g=h.kid.open,L=Math.max(h.left,Math.min(h.left+h.w,h.orbX)),D=L+(h.left-L)*g,x={x:D,y:h.top,w:h.w*g,h:h.h*g},C=G(g/.35),B=nt(n,h.c,D,h.top+h.dy*g,v*g,a);B.box=x,B.header={x:x.x,y:x.y,w:x.w,h:0},B.opacity=C,r.push(Ft(h.c.id,t.id,x,v*g,c,G((g-.6)/.4))),m.push({card:{id:h.c.id,parentId:t.id,box:x,orbX:h.orbX,opacity:C,shadow:Ot[l]*C,caret:C*G((g-.1)/.4),open:g,fit:l},section:B,to:h.kid.to}),l==="push"&&($=Math.max($,(h.top-e.y+h.h)*g),w=Math.max(w,e.w+(h.left+h.w+u-e.x-e.w)*g))}return{sections:Jt(m,i),room:$,width:w,reach:w}}function Me(o){const t=o.find(s=>s.kid.to>.5&&s.kid.from),e=t&&o.find(s=>s.kid.id===t.kid.from&&s.kid.to<.5);return t&&e?{from:e,to:t}:null}function Ft(o,t,e,s,a,r){const i=Tt.framePadding*s;return{id:o,parentId:t,box:{x:e.x+i,y:e.y+Yo/a,w:Math.max(0,e.w-i*2),h:24/a},frame:e,opacity:r,inCard:!0}}function Jt(o,t){const e=o.map((s,a)=>({...s,i:a})).sort((s,a)=>s.to-a.to||s.i-a.i);return t.push(...e.map(s=>s.card)),e.map(s=>s.section).reverse()}function nt(o,t,e,s,a,r){const i=Tt.frameHeaderHeight,n=l=>({x:e+(l.x-t.box.x)*a,y:s+(l.y-t.box.y-i)*a,w:l.w*a,h:l.h*a});for(const l of t.itemIds){const p=o.items.get(l);p&&r.set(l,n(p))}const c=t.groups.map(l=>({...l,box:n(l.box),heading:l.heading&&n(l.heading)}));return{...t,box:{x:e,y:s,w:t.box.w*a,h:(t.box.h-i)*a},header:{x:e,y:s,w:t.box.w*a,h:0},groups:c,more:t.more&&{...t.more,box:n(t.more.box)}}}class es{constructor(t,e){this.families=t;for(const s of t)s.kids.forEach((a,r)=>{const i=a.state==="running"||a.state==="waiting",n=e-a.startedAgo,c=1+(r*7919+s.parentId.length*104729+a.id.charCodeAt(23)*31)%997;this.kids.set(a.id,{demo:a,parentId:s.parentId,index:r+1,seed:c,own:Te(Ht(a.id)),state:a.state,prev:a.state,since:e-60,started:n,finished:i?null:n+a.ran})});this.next=e+2.5}families;kids=new Map;live=!1;next=0;r=te(42);familyKids(t){return t.kids.slice(0,t.count).map(e=>this.kids.get(e.id))}set(t,e,s){const a=this.kids.get(t);if(!a||a.state===e)return;const r=i=>i==="running"||i==="waiting";r(e)&&!r(a.state)?(a.started=s,a.finished=null):!r(e)&&r(a.state)&&(a.finished=s),a.prev=a.state,a.state=e,a.since=s}tick(t){if(!this.live||t<this.next)return;this.next=t+2.2+this.r()*1.6;const e=this.families.flatMap(c=>this.familyKids(c)),s=c=>{const l=e.filter(p=>p.state===c&&t-p.since>2);return l.length?l[Math.floor(this.r()*l.length)]:void 0},a=this.r(),r=s("running"),i=s("waiting");if(i&&a<.2)return this.set(i.demo.id,"running",t);if(r&&a<.62)return this.set(r.demo.id,this.r()<.18?"failed":this.r()<.12?"waiting":"done",t);const n=s("done")??s("failed");n&&this.set(n.demo.id,"running",t)}look(t,e,s,a,r,i){return Qe(t,e,s,a,r,i)}view(t,e,s){return{id:t.demo.id,title:t.demo.title,agent:t.demo.agent,task:t.demo.task,index:t.index,own:t.own,seed:t.seed,state:t.state,look:s,elapsed:Ze((t.finished??e)-t.started)}}}const os=`
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
}`,ss=`
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
}`,as=`
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
}`,ns=`
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
}`,is=`
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
}`,rs=`
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
}`,cs=`
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
}`,it=[Mo,{id:"wisps",name:"Wisps",note:"Incense threads standing on the title’s baseline: curl-noise smoke rises from a small ember while it works; done leaves the ember alone.",params:[...at(9,17,"parent",4,20),z("height","Height",24,8,44,1,"px"),z("curl","Curl",.9,0,2,.05),z("thick","Thickness",1,.4,2,.05),z("glow","Glow",1,0,2,.05)],row:!1,reach:(o,t,e)=>{const s=Math.max(2.6*t,t*1.08+4*e)+2,a=Math.max(Number(o.height)*e*1.1+t,s);return[s,a,s,s]},anchor:"baseline",still:2.4,glsl:os},{id:"metaballs",name:"Metaballs",note:"Liquid drops on the title line: running ones wander, and now and then two neighbours draw together, merge and part; done drops shrink and settle.",params:[...at(11,18),z("goo","Goo",.45,0,1,.05),z("wander","Wander",.8,0,1.5,.05),z("shine","Highlight",.6,0,1.5,.05)],row:!0,reach:ht(1.8),anchor:"centre",still:6.3,glsl:ss},{id:"fireflies",name:"Fireflies",note:"A crisp point with a soft halo drifting in a tiny Lissajous orbit, trailing light and flickering while it works; done ones hold a steady glow.",params:[...at(14,18),z("orbit","Orbit",3,0,8,.25,"px"),z("flicker","Flicker",.6,0,1,.05),z("trail","Trail",.6,0,1.5,.05),z("core","Core",2.6,1,5,.1,"px")],row:!1,reach:(o,t,e)=>{const s=Math.max(t*1.7,t*.9+4*e)+Number(o.orbit)*e+2;return[s,s,s,s]},anchor:"centre",still:1.7,glsl:as},{id:"plasma",name:"Plasma beads",note:"A lit bead whose surface is sphere-mapped fbm folded into plasma bands, turning on a tilted axis while it works; done beads stop and soften.",params:[...at(12,19),z("scale","Noise scale",1.3,.4,4,.05),z("bands","Bands",1.4,0,4,.05),z("spin","Spin",1,0,3,.05),z("light","Lighting",.7,0,1,.05)],row:!1,reach:ht(1),anchor:"centre",still:2.2,glsl:ns},{id:"dots",name:"Dot-grid orbs",note:"Orbs seen through the Ember band’s own dot grid: its clumps crawl round a little ring while running; done is a small calm cluster.",params:[...at(22,30,"parent",14,36),z("crawl","Crawl",5.5,0,14,.5,"px/s"),z("scale","Noise scale",7,3,12,.5,"px"),z("sparse","Sparse",.5,.35,.7,.005),z("peak","Peak",.9,.3,1,.05)],row:!0,reach:ht(1.8),anchor:"centre",still:4,glsl:is},{id:"ink",name:"Ink drops",note:"A drop of ink blooming in water, looping, ink pooling at its lobed front; done leaves a still stain.",params:[...at(14,20),z("period","Period",3.2,1.5,6,.1,"s"),z("spread","Spread",1,.6,1.3,.02),z("tendrils","Tendrils",1,0,2,.05)],row:!1,reach:ht(1.5),anchor:"centre",still:1.15,glsl:rs},{id:"moons",name:"Moons",note:"A small moon whose phases cycle while it works: full and calm when done, half lit with a breathing terminator while waiting.",params:[...at(12,18),z("soft","Terminator",.3,0,1,.05),z("shine","Earthshine",.22,0,.6,.02),z("surface","Maria",.5,0,1,.05)],row:!1,reach:ht(1),anchor:"centre",still:2.1,glsl:cs}];function Oe(o){return it.find(t=>t.id===o)??it[0]}const X=Fo({site:"subagents",title:"Subagents",storageKey:"canvas-playground-subagents-v5",defaults:()=>({tech:it[0].id,params:Object.fromEntries(it.map(o=>[o.id,ct(o.params)])),row:ct(At),expand:ct(Et),ideas:ct(St),live:!0,count:8}),restore(o,t){typeof o.v=="string"&&it.some(e=>e.id===o.v)&&(t.tech=o.v),No(it,o.p,t.params),o.r&&(t.row=Bt(At,{...t.row,...o.r})),o.x&&(t.expand=Bt(Et,{...t.expand,...o.x})),o.i&&(t.ideas=Bt(St,{...t.ideas,...o.i})),typeof o.live=="boolean"&&(t.live=o.live),typeof o.n=="number"&&ze.includes(String(o.n))&&(t.count=o.n)},share:o=>({v:o.tech,p:Bo(it,o.params),r:Nt(At,o.row),x:Nt(Et,o.expand),i:Nt(St,o.ideas),live:o.live,n:o.count}),exportJson:o=>({site:"subagents",technique:{id:o.tech,name:Oe(o.tech).name,params:o.params[o.tech]},row:o.row,expand:o.expand,ideas:o.ideas})}),{settings:I,demo:Fe}=X;Fe.setAttribute("aria-label","The canvas: scroll to pan, pinch or ctrl-scroll to zoom; click a subagent’s orb to open its frame under it");const tt=O("div","canvas-container sa-canvas"),pt=O("canvas","canvas"),ut=O("div","overlay"),Mt=O("div","sa-loading","Drawing the demo canvas…"),Xt=O("div","sa-toast");tt.append(pt,ut,Mt,Xt);Fe.prepend(tt);const F=new Ko;F.mount(tt);F.setCurrentTool("select");window.editor=F;let j=null,N=null,Rt=null,W=null,J=null;const $t=()=>Oe(I.tech),Ut=()=>I.params[I.tech],jt=()=>I.row,mt=()=>I.expand,Lt=()=>I.ideas,ne=()=>String(mt().fit),Ie=()=>!!jt().reduced,Z=new Map,_e={standard:It(.4,0,.2,1),decelerate:It(0,0,.2,1),"in-out":It(.65,0,.35,1)};function ie(o,t){const e=Z.get(o);if(!e)return 0;const s=Number(mt().dur),a=s<=0?1:G((t-e.start)/s);return a>=1&&e.to===0&&Z.delete(o),e.from+(e.to-e.from)*(_e[String(mt().ease)]??_e.standard)(a)}const ot=o=>(Z.get(o)?.to??0)>.5;function Kt(o,t,e,s=0){ot(o)===t&&Z.has(o)===t||(Z.set(o,{from:ie(o,e),to:t?1:0,start:e+s}),K=!0)}function Ct(o){return j?.families.find(t=>t.parentId===o||t.kids.some(e=>e.id===o))}function wt(o){return o.kids.slice(0,o.count)}function re(o,t=!1){const e=performance.now(),s=!ot(o),a=[];if(s&&!t){const i=Ct(o);for(const n of i?wt(i):[])n.id!==o&&ot(n.id)&&a.push(n.id);for(const n of a)Kt(n,!1,e)}Kt(o,s,e);const r=Z.get(o);r&&s&&(r.replaced=a.length===1?a[0]:rt&&a.includes(rt)?rt:void 0),s&&vt.delete(o),rt=s?o:rt}let rt=null;function De(){for(const o of Z.keys())if(ot(o))return!0;return!1}function ls(o){const t=rt&&ot(rt)?rt:[...Z.keys()].find(ot),e=t&&Ct(t);if(!t||!e)return!1;const s=ce(e).map(r=>r.id),a=s[(s.indexOf(t)+o+s.length)%s.length];return a&&a!==t&&re(a),!0}function Ne(o,t){const e=performance.now(),s=wt(o),a=t?s:[...s].reverse(),r=a.length>1?Math.min(Number(mt().stagger),260/(a.length-1)):0;let i=0;for(const n of a)ot(n.id)!==t&&Kt(n.id,t,e,r*i++)}function gt(o){for(const t of j?.families??[])Ne(t,o)}let K=!0,Ae="";function ds(){return{head:ft,headGap:8}}function Pt(o){if(!j||!N)return;N.live=I.live,N.tick(o/1e3);const t=F.camera.peek().z,e=new Map,s=ne();let a="";const r=new Set(j.families.flatMap(c=>c.kids.map(l=>l.id)));let i=!1;for(const c of j.families)e.set(c.parentId,ce(c).map(l=>{const p=ie(l.id,o),f=Z.get(l.id)?.to??0;return Z.has(l.id)&&p!==f&&(i=!0),p>0&&s!=="below"&&(a+=`${l.id}:${(Ee(c.parentId,l.id,o)??-1).toFixed(2)},`),{id:l.id,open:p,to:f,from:Z.get(l.id)?.replaced}}));const n=`${t}|${s}|${a}|${[...e.values()].map(c=>c.map(l=>l.open>0?`${l.open.toFixed(4)}${l.to}`:"").join(",")).join(";")}`;!K&&!i&&n===Ae&&J||(K=!1,Ae=n,J=Qo({natural:F.naturalLayout.get(),families:e,childIds:r,zoom:t,childScale:Number(mt().scale),m:ds(),fit:s,anchor:(c,l)=>Ee(c,l,o),memo:hs,morph:mt().switch==="morph"}),F.plan.set(J))}const hs=new Map,Ee=(o,t,e)=>W?.anchor(o,t,e)??null;function ce(o){const t=wt(o);if(!Lt().group||!N)return t;const e={waiting:0,failed:1,running:2,done:3};return t.map((s,a)=>({k:s,i:a,r:e[N.kids.get(s.id)?.state??"done"]})).sort((s,a)=>s.r-a.r||s.i-a.i).map(s=>s.k)}F.onFrame(o=>Pt(o));const Se=new Map,Re=new Map,Ce=new Map;function Be(o){let t=Se.get(o);return t||Se.set(o,t={run:0,done:0,fail:0,wait:0,flash:0,open:0,hover:0,breath:0}),t}function fs(o,t){const e=new Map;if(!j||!N||!W)return e;const s=o/1e3,a=Number(Ut().speed??1),r=Ut().color==="own",i=Ie();for(const n of j.families){const c=ce(n).map(f=>N.kids.get(f.id));if(!c.length)continue;const l=Te(n.color),p=c.map(f=>{const d=N.look(f,s,ie(f.demo.id,o),W.hover(f.demo.id,o),Be(f.demo.id),i),v=(Re.get(f.demo.id)??f.seed*.37)+t/1e3*a*(d.run+.35*d.wait);Re.set(f.demo.id,v);const u=qe.get(f.demo.id);return u!==void 0&&Lt().unread&&!i&&(d.flash=Math.max(d.flash,ys(o-u))),{view:N.view(f,s,d),rgb:r?f.own:l,time:v,unread:Lt().unread?vt.get(f.demo.id)??0:0,thumb:oe.get(f.demo.id)??null}});e.set(n.parentId,{parentId:n.parentId,kids:p,rgb:l,...ps(n.parentId,p.map(f=>f.view),o,t,a,i)})}return e}function ps(o,t,e,s,a,r){let i=Ce.get(o);return i||Ce.set(o,i=new To(o)),i.update(t,e,s,a,r,W?.hover(`agg:${o}`,e)??0)}function us(){const o=new Map;if(!j||!N)return o;for(const t of j.families){o.set(t.parentId,{id:t.parentId,title:t.title,child:!1});for(const e of t.kids){const s=N.kids.get(e.id),a=s?N.view(s,performance.now()/1e3,Be(e.id)):null;o.set(e.id,{id:e.id,title:e.title,agent:e.agent,task:e.task,child:!0,status:a?Gt(a):"",statusKind:a?.state})}}return o}let $e="",Qt=0,ee=null,V=!0;function ms(o){if(!W||!J)return;const t=Qt?Math.min(100,Math.max(0,o-Qt)):16;Qt=o;const e=F.camera.peek(),{w:s,h:a}=F.viewport.peek(),r=pt.width/Math.max(1,s);W.orbs.resize(pt.width,pt.height,s,a);const i=fs(o,t),n=`${e.x},${e.y},${e.z},${s},${a},${pt.width}`;!V&&n===$e&&ee===J&&!W.animating&&!W.alive&&!gs(i)||(V=!1,$e=n,ee=J,W.draw(J,us(),i,{tech:$t(),p:Ut(),max:Number(jt().max),titlePx:Number(jt().title),reduced:Ie(),preview:!!Lt().preview},o,r),X.setZoom(e.z))}function gs(o){return zo([...o.values()].flatMap(t=>[...t.kids.map(e=>e.view.look),t.agg]))}async function vs(){const o=await jo();j=o,o.families[0].count=I.count,N=new es(o.families,performance.now()/1e3);for(const s of o.items)oe.has(s.sessionId)||oe.set(s.sessionId,s.thumb);const t=o.families[0].kids;vt.set(t[1].id,2),vt.set(t[6].id,1),F.loadSnapshot(o.sessions,o.items),K=!0,F.whenViewportReady(()=>requestAnimationFrame(()=>Wt(!1)));try{Rt=await eo.create(pt,ut,F,{readOnly:!0,easeLayout:!1,busySessions:()=>ws(),getRaisedSections:()=>xs()}),window.renderer=Rt}catch(s){console.error(s),Mt.textContent=`Can't start the renderer: ${ue(s)}`;return}Mt.remove();let e;try{e=new vo(ut)}catch(s){Mt.textContent=`Can't start WebGL2 for the orbs: ${ue(s)}`,tt.append(Mt);return}W=new qo(ut,F,e,{toggleKid:re,showAll:()=>V=!0,zoomTo:s=>de(()=>{const a=F.layout.get().sections.find(r=>r.id===s);return a?ae.union([a.box,a.header]):null},64,!0)}),fo.then(()=>{W?.text.reset(),V=!0}),F.onFrame(s=>ms(s))}const kt=new Set;function ws(){if(kt.clear(),!j||!N||!jt().busy)return kt;const o=ne()!=="below";for(const t of j.families)if(t.busy&&kt.add(t.parentId),!o)for(const e of N.familyKids(t))e.state==="running"&&kt.add(e.demo.id);return kt}function xs(){return(J?.cards??[]).map(o=>({id:o.id,shadow:o.shadow}))}const vt=new Map,qe=new Map,oe=new Map,bs=900,ys=o=>o<0?0:o<150?o/150:Math.max(0,1-(o-150)/(bs-150));let Le=0;function ks(o){if(!j||!N||!I.live||!Lt().unread||o<Le)return;Le=o+2600+o*7%1900;const t=j.families.flatMap(e=>N.familyKids(e)).filter(e=>e.state==="running"&&!ot(e.demo.id));t.length&&le(t[Math.floor(o/997%t.length)].demo.id,o)}function le(o,t=performance.now()){ot(o)||(vt.set(o,(vt.get(o)??0)+1),qe.set(o,t),V=!0)}F.onFrame(o=>ks(o));let se=null;tt.addEventListener("pointerdown",o=>{se=o.button===0?{x:o.clientX,y:o.clientY}:null});tt.addEventListener("pointerup",o=>{const t=se;if(se=null,!t||Math.hypot(o.clientX-t.x,o.clientY-t.y)>4||!De()||ne()==="below"||o.target.closest(".sa-orb, .sa-agg, .sa-more, .sa-close"))return;const e=tt.getBoundingClientRect(),s=F.screenToPage({x:o.clientX-e.left,y:o.clientY-e.top});(J?.cards??[]).some(r=>r.open>.5&&s.x>=r.box.x&&s.x<=r.box.x+r.box.w&&s.y>=r.box.y&&s.y<=r.box.y+r.box.h)||gt(!1)});let Pe=0;function Ms(o){Xt.textContent=o,Xt.classList.add("on"),clearTimeout(Pe),Pe=window.setTimeout(()=>Xt.classList.remove("on"),2400)}function Wt(o=!0){de(()=>F.layout.get().bounds,48,o)}function de(o,t,e){const s=F.camera.peek();let a=s;for(let r=0;r<5;r++){const i=o();if(!i)return;a=F.getCameraForBounds(i,{padding:t}),F.setCamera(a),K=!0,Pt(performance.now())}e&&(F.setCamera(s),K=!0,Pt(performance.now()),F.setCamera(a,{animate:!0,duration:480}))}to(()=>{tt.style.cursor=F.cursor.get()});const Ge=()=>X.setCaption($t().name,$t().note),_s=Io(X,it,I.tech,o=>{I.tech=o,Xe.render(),Ge(),V=!0,X.save()}),Xe=Do(X,"Technique",()=>$t().params,()=>Ut(),()=>{V=!0,X.save()},()=>I.params[I.tech]=ct($t().params)),As=X.section("Title row",et("Reset",()=>{I.row=ct(At),Yt(),K=V=!0,X.save()},"ghost",!0));function Yt(){As.replaceChildren(...At.map(o=>Vt(o,I.row,()=>{K=V=!0,X.save()})),O("p","pg-note","Every technique: failed is red and still, waiting breathes. Hover an orb for its subagent; click it to open its frame right under it (Fit, below). Zoomed out, the orbs fold into +N, then flow into one."))}Yt();const Es=X.section("Expanding",et("Reset",()=>{I.expand=ct(Et),he(),K=!0,X.save()},"ghost",!0));function he(){Es.replaceChildren(...Et.map(o=>Vt(o,I.expand,()=>{K=!0,X.save()})),O("div","pg-buttons",et("Expand all",()=>gt(!0),"",!0),et("Collapse all",()=>gt(!1),"",!0)))}he();const Ss=X.section("Ideas",et("Reset",()=>{I.ideas=ct(St),fe(),K=V=!0,X.save()},"ghost",!0));function fe(){Ss.replaceChildren(...St.map(o=>Vt(o,I.ideas,()=>{K=V=!0,X.save()})),O("p","pg-note","Prototypes: the hover label shows what the subagent last made; a working subagent that isn’t open gets a count of what it posted since (its orb brightens as it posts); the row orders waiting, failed, running, done."),O("div","pg-buttons",et("Post from one",()=>Rs(),"",!0)))}fe();function Rs(){const o=j?.families[0],t=o&&wt(o).find(e=>!ot(e.id));t&&le(t.id)}X.section("Demo").append(lo("Coordinator’s",ze,String(I.count),o=>He(Number(o))),ho("Live states",I.live,o=>{I.live=o,X.save()}),O("div","pg-buttons",et("Fit",()=>Wt(),"",!0),et("Next state",()=>Cs(),"",!0)));function He(o){I.count=o;const t=j?.families[0];if(t){t.count=o;for(const e of t.kids.slice(o))Z.delete(e.id)}K=V=!0,X.save()}function Cs(){if(!N)return;const o=N.live;N.live=!0,N.next=0,N.tick(performance.now()/1e3),N.live=o}const $s=[["Hover","an orb: its subagent and state"],["Click","an orb: open its frame under it, or switch to it"],["⇧Click","open another alongside"],["←→","with one open: the subagent before or after; on a focused orb: move along the row"],["1–8","technique"],["E","expand or collapse every subagent"],["Esc","or click outside: collapse"],["M","reduced motion"],["⇧1","zoom to fit"]];X.section("Keys").append(O("div","sa-keys",...$s.flatMap(([o,t])=>[O("kbd","",o),O("span","",t)])));window.addEventListener("keydown",o=>{o.target.closest('input, textarea, [role="slider"]')||o.metaKey||o.ctrlKey||o.altKey||(o.key==="e"||o.key==="E"?gt(!(j?.families??[]).every(t=>wt(t).every(e=>ot(e.id)))):o.key==="Escape"?gt(!1):(o.key==="ArrowLeft"||o.key==="ArrowRight")&&!o.target.closest("button")&&De()?ls(o.key==="ArrowLeft"?-1:1)&&o.preventDefault():(o.key==="m"||o.key==="M")&&(I.row.reduced=!I.row.reduced,Yt(),V=!0,Ms(I.row.reduced?"Reduced motion: every orb holds its pose":"Motion on"),X.save()))});X.toolbar.append(et("Fit",()=>Wt(),"",!0));Ge();vs();Object.assign(window,{playground:{editor:F,settings:I,get sim(){return N},get demo(){return j},ready:()=>!!Rt&&!!W&&!!J,select:o=>_s.select(o),param(o,t){I.params[I.tech][o]=t,Xe.render(),V=!0},row(o,t){I.row[o]=t,Yt(),K=V=!0},expandParam(o,t){I.expand[o]=t,he(),K=V=!0},idea(o,t){I.ideas[o]=t,fe(),K=V=!0},toggle:(o,t=!1)=>re(o,t),post:o=>le(o),cards:()=>J?.cards,live(o){I.live=o},state(o,t){N?.set(o,t,performance.now()/1e3)},open:(o,t=!0)=>Kt(o,t,performance.now()),expandAll:(o,t=!0)=>{const e=Ct(o);e&&Ne(e,t)},expandEverything:gt,setCount:He,kids:o=>Ct(o)?.kids.slice(0,Ct(o).count).map(t=>({id:t.id,title:t.title,state:N?.kids.get(t.id)?.state})),families:()=>j?.families.map(o=>({id:o.parentId,title:o.title,kids:wt(o).length})),orbPoint(o){const t=W?.orbCentre(o);if(!t)return null;const e=tt.getBoundingClientRect();return{x:e.left+t.x,y:e.top+t.y}},look(o,t=48,e=0,s=0,a=0){de(()=>{const r=F.layout.get().sections.find(n=>n.id===o),i=r&&ae.union([r.box,r.header]);return i?{x:i.x,y:i.y-a,w:i.w+e,h:i.h+s+a}:null},t,!1)},trace(){const o=F.camera.peek(),t=n=>(n+o.x)*o.z,e=n=>(n+o.y)*o.z,s=n=>[t(n.x),e(n.y),n.w*o.z,n.h*o.z].map(c=>Math.round(c*100)/100),a=ee,r=tt.getBoundingClientRect(),i=n=>Math.round(n*100)/100;return{cam:o,frames:Object.fromEntries((a?.layout.sections??[]).map(n=>[n.id,s(n.box)])),drawn:Object.fromEntries((a?.layout.sections??[]).map(n=>[n.id,Rt?.sectionBox(n.id)?s(Rt.sectionBox(n.id)):null])),heads:Object.fromEntries((a?.heads??[]).map(n=>[n.id,s(n.box).slice(0,2)])),dom:Object.fromEntries([...ut.querySelectorAll(".sa-head")].filter(n=>n.style.display!=="none").map(n=>{const c=n.getBoundingClientRect();return[n.dataset.session,[i(c.left-r.left),i(c.top-r.top)]]})),orbs:Object.fromEntries((W?.drawn??[]).filter(n=>n.alpha>.5).map(n=>[n.id,[i(n.x),i(n.y)]])),orbDom:Object.fromEntries([...ut.querySelectorAll(".sa-orb")].filter(n=>n.style.display!=="none"&&n.style.cssText).map(n=>{const c=n.getBoundingClientRect();return[n.dataset.id,[i(c.left-r.left+c.width/2),i(c.top-r.top+c.height/2)]]}))}},region(o,t=0,e=16,s=0){const a=F.camera.peek(),r=J?.heads.find(c=>c.id===o);if(!r)return null;const i=tt.getBoundingClientRect(),n=(r.box.y+a.y)*a.z;return{x:Math.round(i.left+(r.frame.x+a.x)*a.z-e),y:Math.round(i.top+n-e),width:Math.round((s||r.frame.w*a.z)+e*2),height:Math.round(ft+8+Math.min(r.frame.h*a.z,t)+e*2)}},place(o,t,e=40,s=70){F.setCamera({...F.camera.peek(),z:t}),K=!0,Pt(performance.now());const a=J?.heads.find(r=>r.id===o);a&&(F.setCamera({x:e/t-a.box.x,y:s/t-a.box.y,z:t}),K=!0,Pt(performance.now()))},camera:()=>F.camera.peek(),setCamera:(o,t,e)=>F.setCamera({x:o,y:t,z:e}),fit:()=>Wt(!1),plan:()=>J,error:()=>W?.orbs.error??null}});
