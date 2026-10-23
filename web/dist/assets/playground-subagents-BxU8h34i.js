import{a as po,L as Ht,B as be}from"./layout-D5wn9ku6.js";import{ai as uo,s as ae,$ as mo,b as go,c as Le,r as vo,a6 as xo,a7 as Te}from"./styles-EsjeAwZi.js";import{d as Yt,f as he}from"./ember-oFoqqIy_.js";import{e as S,h as wo,B as bo,b as rt,l as yo,p as re,S as Mo,i as ko,j as _o,k as Ao}from"./shell-CBQlV3rD.js";import{c as Jt,r as Zt,a as A,S as So,s as Qt,g as Eo,p as Ro,t as Ft,d as mt}from"./params-Bh0xY2p6.js";function B(e){return e<0?0:e>1?1:e}function Ze(e){const t=parseInt(e.replace("#",""),16);return[t>>16&255,t>>8&255,t&255]}function $o(e){const t=o=>{const a=o/255;return a<=.04045?a/12.92:Math.pow((a+.055)/1.055,2.4)};return[t(e[0]),t(e[1]),t(e[2])]}const vt=20,$t=8,me=16,Co=`#version 300 es
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
}`,Po=`
precision highp float;
precision highp int;
uniform vec2 u_view;
uniform float u_dpr;
uniform float u_p[${me}];
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
`,Lo=`
void main() {
  vec2 px = vec2(gl_FragCoord.x, u_view.y - gl_FragCoord.y);
  vec4 c = vec4(0.0);
  for (int i = 0; i < v_info.y; i++) c = over(c, shadeOrb(orb(v_info.x + i), px));
  o_color = finish(c);
}`,To=`
void main() {
  vec2 px = vec2(gl_FragCoord.x, u_view.y - gl_FragCoord.y);
  o_color = finish(shadeRow(v_info.x, v_info.y, px));
}`;class zo{canvas;gl;programs=new Map;vao;instBuf;tex;texRows=0;orbData=new Float32Array(vt*64);instData=new Float32Array($t*64);params=new Float32Array(me);nOrbs=0;nInst=0;blank=!0;error=null;constructor(t,o=null){this.canvas=document.createElement("canvas"),this.canvas.className="sa-orb-layer",t.insertBefore(this.canvas,o);const a=this.canvas.getContext("webgl2",{alpha:!0,premultipliedAlpha:!0,antialias:!1,depth:!1,stencil:!1,preserveDrawingBuffer:!1});if(!a)throw new Error("WebGL2 is not available");this.gl=a;const n=a.createBuffer();a.bindBuffer(a.ARRAY_BUFFER,n),a.bufferData(a.ARRAY_BUFFER,new Float32Array([0,0,1,0,0,1,0,1,1,0,1,1]),a.STATIC_DRAW),this.vao=a.createVertexArray(),a.bindVertexArray(this.vao),a.enableVertexAttribArray(0),a.vertexAttribPointer(0,2,a.FLOAT,!1,0,0),this.instBuf=a.createBuffer(),a.bindBuffer(a.ARRAY_BUFFER,this.instBuf);for(const[r,s]of[[1,0],[2,4]])a.enableVertexAttribArray(r),a.vertexAttribPointer(r,4,a.FLOAT,!1,$t*4,s*4),a.vertexAttribDivisor(r,1);a.bindVertexArray(null),this.tex=a.createTexture(),a.bindTexture(a.TEXTURE_2D,this.tex),a.texParameteri(a.TEXTURE_2D,a.TEXTURE_MIN_FILTER,a.NEAREST),a.texParameteri(a.TEXTURE_2D,a.TEXTURE_MAG_FILTER,a.NEAREST),a.texParameteri(a.TEXTURE_2D,a.TEXTURE_WRAP_S,a.CLAMP_TO_EDGE),a.texParameteri(a.TEXTURE_2D,a.TEXTURE_WRAP_T,a.CLAMP_TO_EDGE)}resize(t,o,a,n){(this.canvas.width!==t||this.canvas.height!==o)&&(this.canvas.width=t,this.canvas.height=o,this.blank=!1);const r=`${a}px`,s=`${n}px`;this.canvas.style.width!==r&&(this.canvas.style.width=r),this.canvas.style.height!==s&&(this.canvas.style.height=s)}begin(){this.nOrbs=0,this.nInst=0}orb(t){(this.nOrbs+1)*vt>this.orbData.length&&(this.orbData=ze(this.orbData));const o=this.orbData,a=this.nOrbs*vt;return o[a]=t.x,o[a+1]=t.y,o[a+2]=t.r,o[a+3]=t.seed,o[a+4]=t.rgb[0],o[a+5]=t.rgb[1],o[a+6]=t.rgb[2],o[a+7]=t.alpha,o[a+8]=t.run,o[a+9]=t.done,o[a+10]=t.fail,o[a+11]=t.wait,o[a+12]=t.flash,o[a+13]=t.t,o[a+14]=t.hover,o[a+15]=t.open,o[a+16]=t.breath,o[a+17]=t.phase,o[a+18]=t.aux,o[a+19]=0,this.nOrbs++}quad(t,o,a,n,r,s){if(a<=0||n<=0||s<=0||t+a<0||o+n<0||t>this.canvas.width||o>this.canvas.height)return;(this.nInst+1)*$t>this.instData.length&&(this.instData=ze(this.instData));const i=this.instData,c=this.nInst++*$t;i[c]=t,i[c+1]=o,i[c+2]=a,i[c+3]=n,i[c+4]=r,i[c+5]=s,i[c+6]=0,i[c+7]=0}draw(t,o,a,n,r){const s=this.gl;if(this.nInst===0){if(this.blank)return;s.viewport(0,0,this.canvas.width,this.canvas.height),s.clearColor(0,0,0,0),s.clear(s.COLOR_BUFFER_BIT),this.blank=!0;return}const i=this.program(t);if(s.viewport(0,0,this.canvas.width,this.canvas.height),s.clearColor(0,0,0,0),s.clear(s.COLOR_BUFFER_BIT),this.blank=!i,!i)return;s.activeTexture(s.TEXTURE0),s.bindTexture(s.TEXTURE_2D,this.tex);const c=Math.max(1,this.nOrbs);c>this.texRows&&(this.texRows=Math.max(64,1<<Math.ceil(Math.log2(c))),s.texImage2D(s.TEXTURE_2D,0,s.RGBA32F,vt/4,this.texRows,0,s.RGBA,s.FLOAT,null)),s.texSubImage2D(s.TEXTURE_2D,0,0,0,vt/4,c,s.RGBA,s.FLOAT,this.orbData.subarray(0,c*vt)),s.useProgram(i.program),s.uniform2f(i.u.view,this.canvas.width,this.canvas.height),s.uniform1f(i.u.dpr,a),this.params.fill(0);for(let l=0;l<Math.min(me,o.length);l++)this.params[l]=o[l];s.uniform1fv(i.u.p,this.params),s.uniform4f(i.u.grid,n[0],n[1],n[2],n[3]),s.uniform1f(i.u.reduced,r?1:0),s.uniform1i(i.u.orbs,0),s.enable(s.BLEND),s.blendFunc(s.ONE,s.ONE_MINUS_SRC_ALPHA),s.bindVertexArray(this.vao),s.bindBuffer(s.ARRAY_BUFFER,this.instBuf),s.bufferData(s.ARRAY_BUFFER,this.instData.subarray(0,this.nInst*$t),s.DYNAMIC_DRAW),s.drawArraysInstanced(s.TRIANGLES,0,6,this.nInst),s.bindVertexArray(null)}program(t){const o=this.programs.get(t.id);if(o)return o;const a=this.gl;try{const n=`#version 300 es
${t.defines}
${Po}
${t.glsl}
${t.row?To:Lo}`,r=Fo(a,Co,n),s=c=>a.getUniformLocation(r,c),i={program:r,u:{view:s("u_view"),dpr:s("u_dpr"),p:s("u_p"),grid:s("u_grid"),reduced:s("u_reduced"),orbs:s("u_orbs")}};return this.programs.set(t.id,i),this.error=null,i}catch(n){return this.error=String(n),console.error(n),null}}destroy(){this.canvas.remove()}}function ze(e){const t=new Float32Array(e.length*2);return t.set(e),t}function Fo(e,t,o){const a=e.createProgram();for(const[n,r]of[[e.VERTEX_SHADER,t],[e.FRAGMENT_SHADER,o]]){const s=e.createShader(n);if(e.shaderSource(s,r),e.compileShader(s),!e.getShaderParameter(s,e.COMPILE_STATUS)){const i=r.split(`
`).map((c,l)=>`${l+1}: ${c}`).join(`
`);throw new Error(`shader compile failed: ${e.getShaderInfoLog(s)}
${i}`)}e.attachShader(a,s)}if(e.linkProgram(a),!e.getProgramParameter(a,e.LINK_STATUS))throw new Error(`link failed: ${e.getProgramInfoLog(a)}`);return a}function Oo(e){const t=e.defaults();try{e.restore(JSON.parse(localStorage.getItem(e.storageKey)??"{}"),t)}catch{}try{const d=/[#&]s=([^&]+)/.exec(location.hash);d&&e.restore(JSON.parse(decodeURIComponent(d[1])),t)}catch(d){console.warn("ignoring an unreadable settings hash",d)}let o=0;const a=()=>{clearTimeout(o),o=window.setTimeout(()=>{const d=JSON.stringify(e.share(t));localStorage.setItem(e.storageKey,d),history.replaceState(null,"",`#s=${encodeURIComponent(d)}`)},150)};document.title=`${e.title} · Frame status playground`;const n=S("div","pg-app"),r=S("nav","c-tabs");r.setAttribute("aria-label","Playgrounds");for(const d of wo){const M=S("a","",d.name);M.href=d.href,d.id===e.site&&M.setAttribute("aria-current","page"),r.append(M)}const s=S("a","pg-brand","Frame status");s.href=`${bo}/playground`;const i=S("span","pg-readout pg-fps");i.title="Frames per second";const c=S("span","pg-readout pg-zoom");c.title="Zoom";const l=S("div","pg-toolbar",s,r,S("span","pg-spacer"),i,c),f=S("div","pg-demo");f.tabIndex=0;const u=S("div","pg-caption");f.append(u);const h=S("main","pg-main",l,f),g=S("div","pg-panel-body"),m=rt("Copy settings",()=>{v()},"primary",!0),y=S("aside","pg-panel",S("header","pg-panel-head",S("h1","",e.title),m),g);n.append(h,y),document.body.append(n);async function v(){const d=JSON.stringify(e.exportJson(t),null,2);try{await navigator.clipboard.writeText(d)}catch{const M=S("textarea");M.value=d,document.body.append(M),M.select(),document.execCommand("copy"),M.remove()}console.log(d),m.textContent="Copied",setTimeout(()=>m.textContent="Copy settings",1200)}window.playgroundSettings=()=>e.exportJson(t);function P(d,M){const x=S("div","pg-stack"),L=S("div","pg-section-head",S("h2","",d));return M&&L.append(M),g.append(S("section","pg-section",L,x)),x}function N(d,M){u.replaceChildren(S("b","",d),S("span","",M)),u.title=M}const k=[];let _=performance.now();const E=[];let F=0;const H=d=>{requestAnimationFrame(H);const M=Math.max(0,Math.min(100,d-_));if(_=d,E.push(M),E.length>60&&E.shift(),d-F>500&&E.length>5){F=d;const x=1e3/(E.reduce((L,T)=>L+T,0)/E.length);i.textContent=`${Math.round(x)} fps`,i.dataset.fps=String(x)}for(const x of k)try{x(M,d)}catch(L){console.error(L)}};return requestAnimationFrame(H),{settings:t,save:a,section:P,setCaption:N,demo:f,toolbar:l,panelBody:g,setZoom:d=>c.textContent=`${Math.round(d*100)}%`,onTick:d=>k.push(d)}}function Io(e,t,o,a){const n=yo(t.map((r,s)=>({id:r.id,name:r.name,key:String(s+1),title:r.note})),o,a,"Variation");return e.section("Variation").append(n.el),window.addEventListener("keydown",r=>{if(r.target.closest('input, textarea, [role="slider"]')||r.metaKey||r.ctrlKey||r.altKey)return;const s=Number(r.key)-1;Number.isInteger(s)&&s>=0&&s<t.length&&n.select(t[s].id)}),n}function Do(e,t,o,a,n,r){const s=rt("Reset",()=>{r(),c(),n()},"ghost",!0),i=e.section(t,s),c=()=>i.replaceChildren(...o().map(l=>re(l,a(),n,Mo)));return c(),{render:c}}function Bo(e,t,o){const a=t??{};for(const n of e)a[n.id]&&(o[n.id]=Zt(n.params,{...o[n.id],...a[n.id]}))}function No(e,t){const o={};for(const a of e){const n=Jt(a.params,t[a.id]);Object.keys(n).length&&(o[a.id]=n)}return o}const qo=(e,t=6,o=28)=>A("size","Size",e,t,o,1,"px"),Go=e=>A("spacing","Spacing",e,8,44,1,"px"),Xo=(e="parent")=>Qt("color","Colour",["parent","own"],e),ht=(e,t,o="parent",a=6,n=28)=>[qo(e,a,n),Go(t),So,Xo(o)],xt=e=>(t,o,a)=>{const n=Math.max(e*o,o*1.06+4*a)+2;return[n,n,n,n]},Ho=`
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
}`,Uo=`
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
}`,jo=`
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
}`,Ko=`
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
}`,Vo=`
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
}`,Wo=`
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
}`,Yo=`
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
}`,Jo=`
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
}`,ft=[{id:"glass",name:"Glass orbs",note:"A tiny glass sphere with Fresnel rim light and a soft highlight; domain-warped noise swirls inside while it works and stills once it’s done.",params:[...ht(12,19),A("rim","Rim light",.7,0,1.5,.05),A("spec","Highlight",.75,0,1.5,.05),A("scale","Noise scale",1.1,.4,4,.05),A("glow","Glow",1,0,2,.05)],row:!1,reach:xt(1.8),anchor:"centre",still:3.1,glsl:Ho},{id:"wisps",name:"Wisps",note:"Incense threads standing on the title’s baseline: curl-noise smoke rises from a small ember while it works; done leaves the ember alone.",params:[...ht(9,17,"parent",4,20),A("height","Height",24,8,44,1,"px"),A("curl","Curl",.9,0,2,.05),A("thick","Thickness",1,.4,2,.05),A("glow","Glow",1,0,2,.05)],row:!1,reach:(e,t,o)=>{const a=Math.max(2.6*t,t*1.08+4*o)+2,n=Math.max(Number(e.height)*o*1.1+t,a);return[a,n,a,a]},anchor:"baseline",still:2.4,glsl:Uo},{id:"metaballs",name:"Metaballs",note:"Liquid drops on the title line: running ones wander, and now and then two neighbours draw together, merge and part; done drops shrink and settle.",params:[...ht(11,18),A("goo","Goo",.45,0,1,.05),A("wander","Wander",.8,0,1.5,.05),A("shine","Highlight",.6,0,1.5,.05)],row:!0,reach:xt(1.8),anchor:"centre",still:6.3,glsl:jo},{id:"fireflies",name:"Fireflies",note:"A crisp point with a soft halo drifting in a tiny Lissajous orbit, trailing light and flickering while it works; done ones hold a steady glow.",params:[...ht(14,18),A("orbit","Orbit",3,0,8,.25,"px"),A("flicker","Flicker",.6,0,1,.05),A("trail","Trail",.6,0,1.5,.05),A("core","Core",2.6,1,5,.1,"px")],row:!1,reach:(e,t,o)=>{const a=Math.max(t*1.7,t*.9+4*o)+Number(e.orbit)*o+2;return[a,a,a,a]},anchor:"centre",still:1.7,glsl:Ko},{id:"plasma",name:"Plasma beads",note:"A lit bead whose surface is sphere-mapped fbm folded into plasma bands, turning on a tilted axis while it works; done beads stop and soften.",params:[...ht(12,19),A("scale","Noise scale",1.3,.4,4,.05),A("bands","Bands",1.4,0,4,.05),A("spin","Spin",1,0,3,.05),A("light","Lighting",.7,0,1,.05)],row:!1,reach:xt(1),anchor:"centre",still:2.2,glsl:Vo},{id:"dots",name:"Dot-grid orbs",note:"Orbs seen through the Ember band’s own dot grid: its clumps crawl round a little ring while running; done is a small calm cluster.",params:[...ht(22,30,"parent",14,36),A("crawl","Crawl",5.5,0,14,.5,"px/s"),A("scale","Noise scale",7,3,12,.5,"px"),A("sparse","Sparse",.5,.35,.7,.005),A("peak","Peak",.9,.3,1,.05)],row:!0,reach:xt(1.8),anchor:"centre",still:4,glsl:Wo},{id:"ink",name:"Ink drops",note:"A drop of ink blooming in water, looping, ink pooling at its lobed front; done leaves a still stain.",params:[...ht(14,20),A("period","Period",3.2,1.5,6,.1,"s"),A("spread","Spread",1,.6,1.3,.02),A("tendrils","Tendrils",1,0,2,.05)],row:!1,reach:xt(1.5),anchor:"centre",still:1.15,glsl:Yo},{id:"moons",name:"Moons",note:"A small moon whose phases cycle while it works: full and calm when done, half lit with a breathing terminator while waiting.",params:[...ht(12,18),A("soft","Terminator",.3,0,1,.05),A("shine","Earthshine",.22,0,.6,.02),A("surface","Maria",.5,0,1,.05)],row:!1,reach:xt(1),anchor:"centre",still:2.1,glsl:Jo}];function Qe(e){return ft.find(t=>t.id===e)??ft[0]}const Fe=new Map;function Zo(e){let t=Fe.get(e.id);return t||Fe.set(e.id,t={id:e.id,glsl:e.glsl,row:e.row,defines:Eo(e.params)}),t}const bt=24,fe=10,Oe=140,Qo=220,ta=70,ea=120,oa=450,Ie=160,aa="-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter Variable', ui-sans-serif, system-ui, sans-serif",te=Yt(.4,0,.2,1);class na{ctx=new OffscreenCanvas(1,1).getContext("2d");cache=new Map;width=(t,o,a=12)=>{const n=`${o}|${a}|${t}`;let r=this.cache.get(n);return r===void 0&&(this.ctx.font=`${o} ${a}px ${aa}`,r=this.ctx.measureText(t).width,this.cache.set(n,r)),r};reset(){this.cache.clear()}}class Ct{constructor(t,o){this.dur=o,this.from=this.to=t}dur;from;to;start=-1e9;at(t){const o=te(B((t-this.start)/this.dur));return this.from+(this.to-this.from)*o}set(t,o){Math.abs(t-this.to)<1e-6||(this.from=this.at(o),this.to=t,this.start=o)}moving(t){return t-this.start<this.dur}get target(){return this.to}}class sa{constructor(t,o,a,n){this.editor=o,this.orbs=a,this.actions=n,this.host=document.createElement("div"),this.host.className="sa-chrome",t.appendChild(this.host),this.tip=document.createElement("div"),this.tip.className="sa-tip",this.tip.hidden=!0,this.host.appendChild(this.tip),this.wires=document.createElementNS("http://www.w3.org/2000/svg","svg"),this.wires.classList.add("sa-wires"),this.host.insertBefore(this.wires,this.host.firstChild)}editor;orbs;actions;host;tip;heads=new Map;links=new Map;wires;hovered=null;hoveredAt=0;clicked=null;labelFor=null;labelShownAt=0;labelHiddenAt=-1e9;hoverValue=new Map;styleCache=new WeakMap;text=new na;params=new Float32Array(16);animating=!1;alive=!1;drawn=[];anchor(t,o,a){const n=this.heads.get(t)?.row;if(!n)return null;if(n.mode==="merged")return n.x0;if(n.mode==="hidden")return null;const r=n.slots.get(o);return r&&r.alpha.target>.5?n.x0+r.u.at(a)*n.S:n.x0+n.more.u.at(a)*n.S+Math.max(n.D,n.S)/2+2+(this.text.width(n.more.text,600,12)+8)/2}hover(t,o){const a=this.hoverValue.get(t);if(!a)return 0;const n=te(B((o-a.at)/Oe)),r=a.v+(a.to-a.v)*n;return n>=1&&a.to===0&&this.hoverValue.delete(t),r}setHover(t,o){if(t!==this.hovered){for(const a of[this.hovered,t]){if(!a)continue;const n=this.hover(a,o);this.hoverValue.set(a,{v:n,at:o,to:a===t?1:0})}this.hovered=t,this.hoveredAt=o,this.clicked=null}}updateLabel(t){if(this.hovered===this.labelFor)return;if(!this.hovered){this.labelFor&&(this.labelHiddenAt=t),this.labelFor=null;return}const o=!!this.labelFor||t-this.labelHiddenAt<400;t-this.hoveredAt<(o?ta:Qo)||(o||(this.labelShownAt=t),this.labelFor=this.hovered)}css(t,o){this.styleCache.get(t)!==o&&(this.styleCache.set(t,o),t.style.cssText=o)}draw(t,o,a,n,r,s){const i=this.editor.camera.peek(),{w:c,h:l}=this.editor.viewport.peek(),f=d=>Math.round(d*s)/s,u=this.orbs,h=n.tech,g=n.p,m=Number(g.size),y=Number(g.spacing),v=f(h.anchor==="baseline"?bt/2+.363*n.titlePx:bt/2);this.animating=!1,this.alive=!1,this.drawn=[],u.begin(),this.updateLabel(r);const P=te(B((r-this.labelShownAt)/ea));(this.hovered!==this.labelFor||P<1)&&(this.animating=!0);let N=!1;const k=new Set,_=d=>({x:(d.x+i.x)*i.z,y:(d.y+i.y)*i.z,w:d.w*i.z,h:d.h*i.z}),E=t.cards.filter(d=>d.fit==="overlay"&&d.opacity>.01).map(d=>({c:d,b:_(d.box)})),F=new Map;for(const d of t.heads){const M=o.get(d.id);if(!M)continue;const x=f((d.box.x+i.x)*i.z),L=f((d.box.y+i.y)*i.z),T=d.inCard?d.box.w*i.z:d.parentId?Math.max(d.box.w*i.z,Math.min(300,d.box.w*i.z*2.5)):d.box.w*i.z;let O=0;for(const{c:R,b:I}of E)R.parentId===d.id||R.parentId===d.parentId||R.id===d.id||x<I.x+I.w&&x+T>I.x&&L<I.y+I.h&&L+bt>I.y&&(O=Math.max(O,R.opacity));const p=d.opacity*(1-O),w=h.anchor==="baseline"?Number(g.height??0):0,U=p>.01&&x<c&&x+T>0&&L-w<l&&L+bt+40>0&&T>24;let q=this.heads.get(d.id);if(!U){q&&this.css(q.el,"display:none");continue}k.add(d.id),q||(q=this.createHead(d.id),this.heads.set(d.id,q));const b=a.get(d.id),z=M.child?this.text.width(M.agent??"",500,n.titlePx)+5+this.text.width(M.task??"",600,n.titlePx):this.text.width(M.title,600,n.titlePx);let j=Math.min(z,T);if(b&&b.kids.length){const R=q.row??=this.createRow(q,d.id);j=this.layoutRow(R,b,n,z,T,r);const I=j+fe+m/2,G=L+v;R.x0=I,R.S=y,R.D=m,F.set(d.id,{px:x,y:G});const et=u.nOrbs;let ot=1/0,dt=-1/0;const Z=h.reach(g,m/2*s,s),Ut=(at,Y,Et,gt)=>{const lt=x+I+Et*y;gt*=B((x+T-(lt+m/2))/6+1);const Q=Y?Y.view.look:b.agg,Rt=$o(Y?Y.rgb:b.rgb),Kt=Y?Y.view.seed:500+d.id.length,fo=Y?ia(Kt*.6180339):b.aggPhase;u.orb({x:lt*s,y:G*s,r:m/2*s,seed:Kt%97,rgb:Rt,alpha:gt*p,run:Q.run,done:Q.done,fail:Q.fail,wait:Q.wait,flash:Q.flash,t:n.reduced?h.still:Y?Y.time:b.aggTime,hover:Q.hover,open:Q.open,breath:Q.breath,phase:fo,aux:y*s}),h.row||u.quad(lt*s-Z[0],G*s-Z[1],Z[0]+Z[2],Z[1]+Z[3],u.nOrbs-1,1),ot=Math.min(ot,lt),dt=Math.max(dt,lt),this.drawn.push({id:at,x:lt,y:G,alpha:gt}),!n.reduced&&(Q.run+Q.wait>.001||Q.flash>.001)&&(this.alive=!0)};for(const at of b.kids){const Y=R.slots.get(at.view.id);if(!Y)continue;const Et=Y.alpha.at(r),gt=Y.u.at(r);Et>.002&&Ut(at.view.id,at,gt,Et);const lt=Math.max(Math.min(y,m+8),12),Q=Et>.5;if(this.css(Y.el,Q?`transform:translate(${f(I+gt*y-lt/2)}px,0);width:${lt}px;--badge-x:${Math.round(lt/2+m/2-3)}px;--badge-y:${Math.max(0,Math.round(v-m/2-7))}px`:"display:none"),this.setBadge(Y,at.unread),Q&&this.labelFor===at.view.id&&p>.5){const Rt=r-this.hoveredAt-oa,Kt=n.preview&&at.view.look.open<.5&&Rt>0&&this.clicked!==at.view.id?at.thumb:null;n.preview&&at.thumb&&Rt<Ie&&(this.animating=!0),this.showTip(at.view,x+I+gt*y,G-m/2-7,P,Kt,c,G+m/2+7,te(B(Rt/Ie))),N=!0}}const de=R.agg.alpha.at(r);de>.002&&Ut(`agg:${d.id}`,b.kids.length===1?b.kids[0]:null,0,de);const $e=de>.5,ho=b.kids.length>1?this.text.width(String(b.kids.length),600,11)+6:0;this.css(R.agg.el,$e?`transform:translate(${f(I-m/2-3)}px,0);width:${Math.ceil(m+10+ho)}px;--count-x:${m+9}px`:"display:none"),$e&&this.labelFor===`agg:${d.id}`&&(this.showText(R.agg.label,x+I,G-m/2-7,P,c),N=!0);const jt=R.more.alpha.at(r),Ce=I+R.more.u.at(r)*y+Math.max(m,y)/2+2;this.css(R.more.el,jt>.01?`transform:translate(${f(Ce-4)}px,0);opacity:${jt.toFixed(3)};pointer-events:${jt>.5?"auto":"none"}`:"display:none"),jt>.5&&this.labelFor===`more:${d.id}`&&(this.showText(R.more.el.dataset.label??"",x+Ce+10,G-m/2-7,P,c),N=!0),this.animating||=this.rowMoving(R,r);const Pe=u.nOrbs-et;h.row&&Pe>0&&u.quad(ot*s-Z[0]-y*s,G*s-Z[1],(dt-ot)*s+Z[0]+Z[2]+2*y*s,Z[1]+Z[3],et,Pe)}else q.row&&(q.row.el.remove(),q.row=null);let st=M.status??"";if(d.inCard){const R=T-30;st&&z+this.text.width(st,500,12)+10>R&&(st=""),j=Math.max(0,Math.min(z,R))}this.fillHead(q,{...M,status:st},j,d.inCard),this.css(q.el,`transform:translate(${x}px,${L}px);width:${Math.max(0,Math.floor(T))}px;opacity:${p.toFixed(3)};--title:${n.titlePx}px;--status-x:${Math.ceil(j)+8}px`)}for(const[d,M]of this.heads)k.has(d)||this.css(M.el,"display:none");this.drawLinks(t.cards,F,v,m,r,f),N||(this.tip.hidden=!0),Ro(h.params,g,this.params);const H=[Math.round(i.x*i.z*s),Math.round(i.y*i.z*s),Math.max(2,Math.round(5*s)),Math.max(1,Math.floor(2*s+.5))];u.draw(Zo(h),this.params,s,H,n.reduced);for(const d of this.hoverValue.values())(d.to!==1||r-d.at<Oe)&&(this.animating=!0)}rowMoving(t,o){if(t.agg.alpha.moving(o)||t.more.alpha.moving(o)||t.more.u.moving(o))return!0;for(const a of t.slots.values())if(a.u.moving(o)||a.alpha.moving(o))return!0;return!1}layoutRow(t,o,a,n,r,s){const i=o.kids.length,c=Number(a.p.size),l=Number(a.p.spacing),f=t.more.el.dataset.all==="1",u=f?i:Math.min(i,Math.max(1,a.max)),h=x=>x<i?this.text.width(`+${i-x}`,600,12)+12:0,g=x=>fe+c+(x-1)*l+(x<i?Math.max(c,l)/2-c/2+2+h(x):0),m=r-n,y=x=>t.mode===x?-4:4;let v=u;for(;v>0&&g(v)>m-(v>t.shown?3:0);)v--;const P=Math.min(i,2),N=i>1?this.text.width(String(i),600,11)+6:0,k=fe+c+8+N;let _,E=n;v>=P&&g(P)<=m-y("row")?_="row":k<=m-y("merged")?_="merged":r-k>=56+y("merged")?(_="merged",E=r-k):(_="hidden",E=Math.min(n,r)),_==="row"&&(v=Math.max(v,P)),t.mode=_,t.shown=_==="row"?v:0;let F=0;for(const x of o.kids){const L=t.slots.get(x.view.id)??this.createSlot(t,x.view.id),T=_==="row"&&F<v;L.u.set(_==="row"?Math.min(F,v):0,s),L.alpha.set(T?1:0,s);const O=`${x.view.title}: ${ee(x.view)}${x.view.look.open>.5?", expanded":""}`;L.label!==O&&(L.label=O,L.el.setAttribute("aria-label",O)),F++}for(const[x,L]of t.slots)o.kids.some(T=>T.view.id===x)||(L.el.remove(),t.slots.delete(x));t.agg.alpha.set(_==="merged"?1:0,s);const H=_==="row"&&v<i?`+${i-v}`:f&&_==="row"&&i>Math.max(1,a.max)?"−":"";if(t.more.u.set(Math.max(0,v-1),s),t.more.alpha.set(H?1:0,s),H&&H!==t.more.text){t.more.text=H,t.more.el.textContent=H;const x=o.kids.slice(v).map(T=>T.view),L=H==="−"?"Show fewer":`${i-v} more: ${De(x)}`;t.more.el.dataset.label=L,t.more.el.setAttribute("aria-label",L)}const d=i>1?String(i):"";d!==t.agg.text&&(t.agg.text=d,t.agg.el.textContent=d);const M=i===1?`${o.kids[0].view.title}: ${ee(o.kids[0].view)}`:`${i} subagents: ${De(o.kids.map(x=>x.view))} · click to zoom in`;return M!==t.agg.label&&(t.agg.label=M,t.agg.el.setAttribute("aria-label",M)),Math.max(0,Math.min(E,r))}createHead(t){const o=document.createElement("div");return o.className="sa-head",o.dataset.session=t,o.innerHTML='<span class="title"></span>',this.host.insertBefore(o,this.host.firstChild),{el:o,title:o.firstChild,key:"",row:null,status:null,close:null}}fillHead(t,o,a,n){if(this.css(t.title,`max-width:${Math.max(0,Math.ceil(a))}px`),n&&!t.close?(t.status=document.createElement("span"),t.status.className="status",t.close=document.createElement("button"),t.close.type="button",t.close.className="sa-close",t.close.textContent="×",t.close.setAttribute("aria-label",`Collapse ${o.title}`),t.close.addEventListener("pointerdown",s=>s.stopPropagation()),t.close.addEventListener("click",s=>(s.stopPropagation(),this.actions.toggleKid(o.id,!0))),t.el.append(t.status,t.close)):!n&&t.close&&(t.status?.remove(),t.close.remove(),t.status=t.close=null),t.el.classList.toggle("in-card",n),t.status){const s=o.status??"";t.status.textContent!==s&&(t.status.textContent=s);const i=`status ${o.statusKind??""}`;t.status.className!==i&&(t.status.className=i)}const r=`${o.title}|${o.child}`;t.key!==r&&(t.key=r,t.el.classList.toggle("child",o.child),o.child?t.title.innerHTML='<span class="agent"></span><span class="task"></span>':t.title.innerHTML='<span class="task"></span>',o.child&&(t.title.firstChild.textContent=o.agent??""),t.title.lastChild.textContent=o.child?o.task??"":o.title)}createRow(t,o){const a=document.createElement("div");a.className="sa-orbs",t.el.appendChild(a);const n=(i,c,l)=>{const f=document.createElement("button");return f.type="button",f.className=i,f.addEventListener("pointerdown",u=>u.stopPropagation()),f.addEventListener("dblclick",u=>u.stopPropagation()),f.addEventListener("click",u=>(u.stopPropagation(),c())),this.hoverable(f,l),a.appendChild(f),f},r=n("sa-more",()=>{r.dataset.all=r.dataset.all==="1"?"":"1",this.actions.showAll(o)},`more:${o}`),s=n("sa-agg",()=>this.actions.zoomTo(o),`agg:${o}`);return{el:a,x0:0,S:16,D:10,mode:"row",shown:0,slots:new Map,more:{el:r,u:new Ct(0,240),alpha:new Ct(0,200),text:""},agg:{el:s,alpha:new Ct(0,320),text:"",label:""}}}createSlot(t,o){const a=document.createElement("button");a.type="button",a.className="sa-orb",a.dataset.id=o,a.addEventListener("pointerdown",s=>s.stopPropagation()),a.addEventListener("dblclick",s=>s.stopPropagation()),a.addEventListener("click",s=>{s.stopPropagation(),this.clicked=o,this.actions.toggleKid(o,s.shiftKey)}),a.addEventListener("keydown",s=>{if(s.key!=="ArrowLeft"&&s.key!=="ArrowRight")return;const i=[...t.slots.values()].filter(f=>f.alpha.target>.5).sort((f,u)=>f.u.target-u.u.target),c=i.findIndex(f=>f.el===a),l=i[c+(s.key==="ArrowLeft"?-1:1)];l&&(s.preventDefault(),s.stopPropagation(),l.el.focus())}),this.hoverable(a,o),t.el.insertBefore(a,t.el.firstChild);const n=document.createElement("span");n.className="sa-badge",n.hidden=!0,a.appendChild(n);const r={el:a,badge:n,unread:0,u:new Ct(t.slots.size,300),alpha:new Ct(0,260),label:""};return t.slots.set(o,r),r}hoverable(t,o){const a=()=>this.setHover(o,performance.now()),n=()=>{this.hovered===o&&this.setHover(null,performance.now())};t.addEventListener("pointerenter",a),t.addEventListener("pointerleave",n),t.addEventListener("focus",()=>t.matches(":focus-visible")&&a()),t.addEventListener("blur",n)}showTip(t,o,a,n,r,s,i,c){const l=`<span class="line"><span class="nm"><span class="agent">${Pt(t.agent)}:</span> ${Pt(t.task)}</span><span class="st ${t.state}">${Pt(ee(t))}</span></span>`;this.showHtml(r?`<img class="thumb" src="${Pt(r)}" alt="">${l}`:l,o,a,n,s,!!r,i,c)}showText(t,o,a,n,r){this.showHtml(`<span class="line"><span class="nm">${Pt(t)}</span></span>`,o,a,n,r,!1)}showHtml(t,o,a,n,r,s,i=a,c=1){this.tip.innerHTML!==t&&(this.tip.innerHTML=t),this.tip.hidden=!1,this.tip.classList.toggle("with-thumb",s),this.tipSize.size>200&&this.tipSize.clear();let l=this.tipSize.get(t);l||this.tipSize.set(t,l={w:this.tip.offsetWidth,h:s?170:this.tip.offsetHeight});const f=Math.max(l.w/2+6,Math.min(r-l.w/2-6,o)),u=a-l.h<4;this.css(this.tip,`transform:translate(${Math.round(f)}px,${Math.round(u?i:a)}px) translate(-50%,${u?0:-100}%);opacity:${n.toFixed(3)};--thumb:${c.toFixed(3)}`)}tipSize=new Map;setBadge(t,o){if(t.unread===o)return;const a=o>t.unread;t.unread=o,t.badge.hidden=o===0,t.badge.textContent=o>9?"9+":String(o),a&&(t.badge.classList.remove("pop"),t.badge.offsetWidth,t.badge.classList.add("pop"))}drawLinks(t,o,a,n,r,s){const i=this.editor.camera.peek(),c=new Set,l=new Map,f=new Map;for(const h of t)h.fit!=="drawer"&&f.set(h.parentId,[...f.get(h.parentId)??[],h]);for(const h of f.values())h.sort((g,m)=>g.orbX-m.orbX).forEach((g,m)=>l.set(g.id,{i:m,n:h.length}));const u=new Map;for(const h of t)h.fit==="drawer"&&h.caret>.01&&(!u.has(h.parentId)||h.box.y<u.get(h.parentId).box.y)&&u.set(h.parentId,h);for(const h of t){const g=o.get(h.parentId);if(!g||h.caret<.01||h.fit==="drawer"&&u.get(h.parentId)!==h)continue;const m=this.anchor(h.parentId,h.id,r),y=g.px+(m??40),v=(h.orbX+i.x)*i.z,P=s((h.box.y+i.y)*i.z),N=(h.box.x+i.x)*i.z,k=h.box.w*i.z,_=h.caret,E=s(Math.max(N+12,Math.min(N+k-12,v)));let F=this.links.get(h.id);if(!F){const O=document.createElement("div");O.className="sa-caret",O.style.setProperty("--fill",uo.frame),this.host.insertBefore(O,this.wires.nextSibling);const p=document.createElementNS("http://www.w3.org/2000/svg","path");this.wires.appendChild(p),F={caret:O,wire:p},this.links.set(h.id,F)}c.add(h.id);const H=_;this.css(F.caret,`transform:translate(${E-6}px,${P-6}px) scale(${(.4+.6*_).toFixed(3)}) rotate(45deg);opacity:${H.toFixed(3)}`);const d=s(g.y+n/2+3),M=P-8,x=s(y);let L="";if(M-d>2)if(Math.abs(E-x)<1)L=`M${x} ${d}V${M}`;else{const O=l.get(h.id),p=O&&O.n>1?Math.round(Math.max(d+3,M-4-(O.n-1-O.i)*Math.min(4,(M-d-7)/Math.max(1,O.n-1)))):Math.round((d+M)/2),w=Math.min(4,Math.abs(E-x)/2,(M-d)/4),U=Math.sign(E-x);L=`M${x} ${d}V${p-w}Q${x} ${p} ${x+U*w} ${p}H${E-U*w}Q${E} ${p} ${E} ${p+w}V${M}`}F.wire.getAttribute("d")!==L&&F.wire.setAttribute("d",L);const T=H.toFixed(3);F.wire.getAttribute("opacity")!==T&&F.wire.setAttribute("opacity",T)}for(const[h,g]of this.links)c.has(h)||(g.caret.remove(),g.wire.remove(),this.links.delete(h))}orbCentre(t){const o=this.host.querySelector(t.startsWith("agg:")?`.sa-head[data-session="${t.slice(4)}"] .sa-agg`:`.sa-orb[data-id="${t}"]`);if(!o||o.style.display==="none")return null;const a=o.getBoundingClientRect();if(!a.width)return null;const n=this.host.getBoundingClientRect();return{x:a.left-n.left+a.width/2,y:a.top-n.top+a.height/2}}destroy(){this.host.remove()}}function ee(e){return e.state==="running"?`running · ${e.elapsed}`:e.state==="done"?`done in ${e.elapsed}`:e.state==="failed"?`failed after ${e.elapsed}`:"waiting for an answer"}function De(e){const t={running:0,waiting:0,failed:0,done:0};for(const a of e)t[a.state]++;const o=[];return t.running&&o.push(`${t.running} running`),t.waiting&&o.push(`${t.waiting} waiting`),t.failed&&o.push(`${t.failed} failed`),t.done&&o.push(`${t.done} done`),o.join(" · ")}const ia=e=>e-Math.floor(e);function Pt(e){return e.replace(/[&<>"]/g,t=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"})[t])}const ra=[{key:"coordinator",title:"Canvas build: coordinator",color:"#60a5fa",busy:!0,agent:"build",unread:2,asking:!1,shots:[1.6,1.33,1.78,1,1.5,1.2,1.6,.8],count:14,kids:[["Explore: render loop","running",[1.5]],["General: subagent frames demo","running",[1.78,1.33]],["Explore: competitor heroes","done",[{a:4.2,w:4200},1.78]],["General: fix flaky upload test","done",[1.6,1.2]],["General: mobile onboarding","done",[{a:.5,w:900},1.33]],["Review: page items","failed",[1.33]],["Explore: auth flow","waiting",[1.5,1]],["General: HTML side drawer","done",[1.78,1.5]],["General: precise highlights","done",[1.6]],["Explore: ember band timing","running",[1.78]],["Review: frame chrome copy","done",[1.5]],["General: link cards","done",[1.33,1.6]],["Explore: WebGPU fallbacks","done",[1.6]],["General: unread badge","done",[1.2]],["Explore: video seek latency","running",[1.78]],["General: share dialog","done",[1.5]],["Review: keyboard shortcuts","done",[1.33]],["General: canvas list previews","done",[1.6]],["Explore: Safari texture upload","done",[1.5]],["General: presence bar","done",[1.78]]]},{key:"hero",title:"Landing hero explorations",color:"#f472b6",busy:!1,agent:"build",unread:0,asking:!0,shots:[1.78,1.78,1.5,1.33],kids:[["General: hero variants, round 3","running",[1.78,1.78]],["Explore: brand assets","done",[1.33,1,1.5]],["Review: contrast pass","done",[1.5]]]},{key:"shader",title:"Shader study: rounded SDF",color:"#a78bfa",busy:!1,agent:"plan",unread:0,asking:!1,shots:[1.33,1,1.5,.8],kids:[]},{key:"video",title:"Perf: video pool",color:"#2dd4bf",busy:!0,agent:"build",unread:1,asking:!1,shots:[2.4,1.78,1.2],kids:[["Explore: map video pool","done",[1.5]],["General: decoder reuse","running",[1.78,1.6]],["General: frame pacing traces","running",[2.2]],["Review: memory","done",[1.33]],["Explore: importExternalTexture","done",[1.6]],["General: poster frames","done",[1.5,1.2]],["Explore: seek latency","done",[1.78]],["Review: leak check","failed",[1.33]]]},{key:"flaky",title:"Fix flaky upload test",color:"#fb923c",busy:!1,agent:"build",unread:0,asking:!1,shots:[2.2,1.6],kids:[["Explore: find the race","done",[1.6]]]}];function ca(e,t){const o=`ses_demo${e}`;for(let a=0;a<1e3;a++){const n=`${o}${a.toString(36)}`.padEnd(30,"0").slice(0,30);if(ae(n)===t)return n}return o.padEnd(30,"0").slice(0,30)}function ge(e){return()=>{e|=0,e=e+1831565813|0;let t=Math.imul(e^e>>>15,1|e);return t=t+Math.imul(t^t>>>7,61|t)^t,((t^t>>>14)>>>0)/4294967296}}function la(e){const t=parseInt(e.slice(1),16),o=(t>>16&255)/255,a=(t>>8&255)/255,n=(t&255)/255,r=Math.max(o,a,n),s=Math.min(o,a,n);if(r===s)return 0;const i=r-s;return(r===o?(a-n)/i+(a<n?6:0):r===a?(n-o)/i+2:(o-a)/i+4)*60}async function da(e,t,o){const n=Math.round(o>=1?Math.min(1280,640*Math.min(o,2)):640*o),r=Math.round(n/o),s=new OffscreenCanvas(n,r),i=s.getContext("2d"),c=t+(e()-.5)*70,l=c+20+e()*50,f=18+e()*22,u=i.createLinearGradient(0,0,n*e(),r);if(u.addColorStop(0,`hsl(${c} ${f}% ${16+e()*10}%)`),u.addColorStop(1,`hsl(${l} ${f+6}% ${26+e()*14}%)`),i.fillStyle=u,i.fillRect(0,0,n,r),e()<.45){const g=n*(.25+e()*.5),m=r*(.3+e()*.4),y=Math.min(n,r)*(.25+e()*.2),v=i.createRadialGradient(g,m,0,g,m,y);v.addColorStop(0,`hsl(${l+30} ${f+14}% ${50+e()*14}% / 0.75)`),v.addColorStop(1,`hsl(${l+30} ${f}% 40% / 0)`),i.fillStyle=v,i.fillRect(0,0,n,r)}else{const g=Math.min(n,r)/20;i.fillStyle="rgba(255,255,255,0.07)",i.fillRect(0,0,n,g*2),i.fillStyle="rgba(255,255,255,0.14)";const m=n*.08;let y=r*(.22+e()*.1);for(let v=0;v<4&&y<r*.85;v++)i.fillRect(m,y,n*(.25+e()*.5)*(v?.8:1),g*(v?.7:1.3)),y+=g*(v?1.6:2.6),i.fillStyle="rgba(255,255,255,0.08)";e()<.6&&(i.fillStyle=`hsl(${l+40} ${f+20}% 58% / 0.55)`,i.beginPath(),i.roundRect(m,Math.min(r-g*3,y+g),n*.16,g*1.6,g*.4),i.fill())}const h=await s.convertToBlob({type:"image/png"});return URL.createObjectURL(h)}async function ha(e="playground"){const t=[],o=[],a=[],n=[];let r=1e6;const s=(c,l,f,u)=>{const h=ge(u),g=la(l);f.forEach((m,y)=>{const v=typeof m=="number"?m:m.a,P=typeof m=="number"?Math.round(1e3*v):m.w??Math.round(1e3*v),N={id:`${c}-i${y}`,canvasId:e,sessionId:c,kind:"image",name:`shot-${y+1}.png`,src:"",thumb:"",width:P,height:Math.round(P/v),createdAt:r--};o.push(N),n.push(da(h,g,v).then(k=>{N.src=k,N.thumb=k}))})},i=ge(7);return ra.forEach((c,l)=>{const f=ca(c.key,c.color);t.push({id:f,canvasId:e,title:c.title,createdAt:1e3+l}),s(f,c.color,c.shots,100+l);const u=c.kids.map(([h,g,m],y)=>{const v=`${f.slice(0,22)}k${String(y).padStart(2,"0")}`.padEnd(30,"0");t.push({id:v,canvasId:e,title:h,createdAt:2e3+l*40+y}),s(v,ae(v),m,1e3+l*50+y);const[P,...N]=h.split(": "),k=g==="running"||g==="waiting"?20+i()*150:200+i()*900,_=g==="running"||g==="waiting"?k:40+i()*160;return{id:v,title:h,agent:P,task:N.join(": ")||h,state:g,startedAgo:k,ran:_}});a.push({parentId:f,title:c.title,color:ae(f),busy:c.busy,agent:c.agent,unread:c.unread,asking:c.asking,kids:u,count:c.count??u.length})}),await Promise.all(n),{sessions:t,items:o,families:a}}class fa extends mo{plan=go("plan",null);naturalLayout=Le("naturalLayout",()=>po(this.sessions.get(),this.items.get(),this.sessionOrder.get(),this.itemLimits.get()));layout=Le("layout",()=>this.plan.get()?.layout??this.naturalLayout.get())}const pa=typeof matchMedia=="function"&&matchMedia("(prefers-reduced-motion: reduce)").matches,Ot=[A("title","Title size",14,12,20,1,"px"),A("max","Before +N",8,2,20,1),Ft("reduced","Reduced motion",pa),Ft("busy","Busy band",!0)],It=[Qt("fit","Fit",["overlay","push","drawer","below"],"push"),Qt("switch","Switching",["morph","swap"],"morph"),A("scale","Scale",1,.4,1,.01,"×"),A("dur","Duration",360,0,1400,10,"ms"),Qt("ease","Easing",["standard","decelerate","in-out"],"standard"),A("stagger","Stagger",40,0,120,5,"ms")],Dt=[Ft("preview","Preview on hover",!0),Ft("unread","New-item badges",!0),Ft("group","Group by state",!1)],to=["0","1","3","8","15","20"],Be=72,Ne=12,qe=30,ua=14,ma=8,ga=40,Vt={overlay:1,push:.55,drawer:.35,below:0};function va(e){const{natural:t,zoom:o,m:a}=e,n=Ht,r=n.frameHeaderHeight,s={sections:[],groups:[],items:new Map,sectionOf:t.sectionOf,groupOf:t.groupOf,bounds:null},i=[],c=[],l=new Map(t.sections.map(h=>[h.id,h])),f=(a.head+a.headGap)/o;let u=0;for(const h of t.sections){if(e.childIds.has(h.id))continue;const g=(e.families.get(h.id)??[]).filter(k=>k.open>5e-4&&l.has(k.id)),m={x:u,y:0,w:h.box.w,h:h.box.h-r},y={x:m.x,y:m.y-f,w:m.w,h:a.head/o};if(i.push({id:h.id,parentId:null,box:y,frame:m,opacity:1,inCard:!1}),e.fit==="below"){const k=xa(e,h,m,g,s.items,i),_=pt(t,h,m.x,0,1,s.items);_.box=m,_.header=y,s.sections.push(...k.sections,_),u=k.right+n.frameGap;continue}const v=wa(e,h,m,g,s.items,i,c),P=pt(t,h,m.x,m.y+v.room,1,s.items);P.box={...m,w:Math.max(m.w,v.width),h:m.h+v.room},P.header=y;const N=i.find(k=>k.id===h.id);N.frame=P.box,N.box={...y,w:P.box.w},s.sections.push(...v.sections,P),u=m.x+Math.max(m.w,v.reach)+n.frameGap}return s.groups=s.sections.flatMap(h=>h.groups),s.bounds=be.union(s.sections.flatMap(h=>[h.box,h.header])),{layout:s,heads:i,cards:c,zoom:o}}function xa(e,t,o,a,n,r){const{natural:s,zoom:i,m:c}=e,l=Ht.frameHeaderHeight,f=new Map(s.sections.map(v=>[v.id,v])),u=(c.head+c.headGap)/i,h=v=>B(v.open/.5),g=[];let m=o.x+o.w,y=o.y+o.h;for(const v of a){const P=f.get(v.id),N=P.box.h-l,k=e.childScale,_=y+Be+u;y+=(Be+u+N*k)*h(v),m=Math.max(m,o.x+o.w+(Math.max(o.w,P.box.w*k)-o.w)*h(v));const E=B((v.open-.5)/.5),F=pt(s,P,o.x,_+(1-E)*(12/i),k*(.98+.02*E),n);F.opacity=E,F.header={x:F.box.x,y:F.box.y-u,w:F.box.w,h:c.head/i},r.push({id:P.id,parentId:t.id,box:F.header,frame:F.box,opacity:E,inCard:!1}),g.push(F)}return{sections:g,right:m}}function wa(e,t,o,a,n,r,s){const{natural:i,zoom:c,fit:l}=e,f=Ht,u=f.frameHeaderHeight,h=new Map(i.sections.map(p=>[p.id,p])),g=e.childScale,m=Math.min(f.framePadding,Ne/c),y=o.y+Ne/c,v=ua/c,P=Math.max(0,ga/c-f.framePadding*g),N=p=>{const w=e.anchor(t.id,p);return o.x+(w??40)/c},k=a.map(p=>{const w=h.get(p.id),U=w.box.w*g;return{kid:p,c:w,w:U,h:P+(w.box.h-u)*g,dy:P,left:0,top:y,orbX:N(p.id)}}),_=[],E=o.x+m,F=l==="drawer";let H=0,d=o.w;if(F){const p=Math.max(o.w-m*2,...k.map(b=>b.w)),w=k.length===2&&e.morph?Ge(k):null;if(w){const b=w.to.kid.open,z={x:E,y,w:p,h:w.from.h+(w.to.h-w.from.h)*b},j=B((b-.1)/.5),st=1-B((b-.6)/.25),R=Math.min(1,z.h/w.from.h),I=Math.min(1,z.h/w.to.h),G=pt(i,w.from.c,E,y+w.from.dy*R,g*R,n),et=pt(i,w.to.c,E,y+w.to.dy*I,g*I,n);for(const[dt,Z,Ut]of[[G,st,1-B(b/.4)],[et,j,B((b-.5)/.5)]])dt.box=z,dt.header={x:z.x,y:z.y,w:z.w,h:0},dt.opacity=Z,r.push(Wt(dt.id,t.id,z,g,c,Ut));const ot=w.from.orbX+(w.to.orbX-w.from.orbX)*b;return _.push({card:{id:w.from.c.id,parentId:t.id,box:z,orbX:ot,opacity:1,shadow:0,caret:0,open:1,fit:l},section:G,to:0}),_.push({card:{id:w.to.c.id,parentId:t.id,box:z,orbX:ot,opacity:1,shadow:Vt.drawer,caret:1,open:1,fit:l},section:et,to:1}),{sections:pe(_,s),room:z.y+z.h-o.y,width:Math.max(o.w,p+m*2),reach:Math.max(o.w,p+m*2)}}let U=y,q=0;for(const b of k){const z=b.kid.open,j=1-(1-B(z/.75))**2,st=B((z-.55)/.45),R=b.h*j,I={x:E,y:U,w:p,h:R},G=pt(i,b.c,E,U+b.dy,g,n);G.box=I,G.header={x:I.x,y:I.y,w:I.w,h:0},G.opacity=st,r.push(Wt(b.c.id,t.id,I,g,c,st));const et=B(z/.25);_.push({card:{id:b.c.id,parentId:t.id,box:I,orbX:b.orbX,opacity:et,shadow:Vt.drawer*et,caret:et*B((z-.1)/.4),open:z,fit:l},section:G,to:b.kid.to}),U+=(R+v)*j,q=Math.max(q,j)}return H=Math.max(0,U-y+(y-o.y-v)*q),d=Math.max(o.w,p+m*2),{sections:pe(_,s),room:H,width:d,reach:d}}const M=o.x+o.w-m,x=k.filter(p=>p.kid.to>.5);let L=E;for(const p of x)p.left=Math.max(p.orbX-qe/c,L),L=p.left+p.w+v;if(x.length){const p=x[x.length-1],w=p.left+p.w-M,U=w>0?Math.min(w,x[0].left-E):0;for(const q of x)q.left-=U}for(const p of x)e.memo.set(p.kid.id,{dx:p.left-o.x,dy:p.top-o.y,w:p.w,h:p.h});for(const p of k){if(p.kid.to>.5)continue;const w=e.memo.get(p.kid.id);w?(p.left=o.x+w.dx,p.top=o.y+w.dy):p.left=Math.max(E,Math.min(p.orbX-qe/c,M-p.w))}const T=e.morph&&x.length===1?Ge(k):null,O=T&&e.memo.get(T.from.kid.id);if(T&&O){const p=T.to.kid.open,w=T.to,U=o.x+O.dx,q=o.y+O.dy,b={x:U+(w.left-U)*p,y:q+(w.top-q)*p,w:O.w+(w.w-O.w)*p,h:O.h+(w.h-O.h)*p},z=B((p-.1)/.5),j=1-B((p-.6)/.25),st=T.from.orbX+(w.orbX-T.from.orbX)*p;for(const[R,I,G]of[[T.from,j,0],[w,z,1]]){const et=Math.min(1,b.w/R.w,b.h/R.h),ot=pt(i,R.c,b.x,b.y+R.dy*et,g*et,n);ot.box=b,ot.header={x:b.x,y:b.y,w:b.w,h:0},ot.opacity=I,r.push(Wt(R.c.id,t.id,b,g*et,c,G?B((p-.5)/.5):1-B(p/.4))),_.push({card:{id:R.c.id,parentId:t.id,box:b,orbX:st,opacity:I,shadow:G?Vt[l]*Math.max(z,j):0,caret:G,open:1,fit:l},section:ot,to:G})}l==="push"&&(H=b.y-o.y+b.h,d=Math.max(o.w,b.x+b.w+m-o.x))}for(const p of k){if(T&&O&&(p===T.from||p===T.to))continue;const w=p.kid.open,U=Math.max(p.left,Math.min(p.left+p.w,p.orbX)),q=U+(p.left-U)*w,b={x:q,y:p.top,w:p.w*w,h:p.h*w},z=B(w/.35),j=pt(i,p.c,q,p.top+p.dy*w,g*w,n);j.box=b,j.header={x:b.x,y:b.y,w:b.w,h:0},j.opacity=z,r.push(Wt(p.c.id,t.id,b,g*w,c,B((w-.6)/.4))),_.push({card:{id:p.c.id,parentId:t.id,box:b,orbX:p.orbX,opacity:z,shadow:Vt[l]*z,caret:z*B((w-.1)/.4),open:w,fit:l},section:j,to:p.kid.to}),l==="push"&&(H=Math.max(H,(p.top-o.y+p.h)*w),d=Math.max(d,o.w+(p.left+p.w+m-o.x-o.w)*w))}return{sections:pe(_,s),room:H,width:d,reach:d}}function Ge(e){const t=e.find(a=>a.kid.to>.5&&a.kid.from),o=t&&e.find(a=>a.kid.id===t.kid.from&&a.kid.to<.5);return t&&o?{from:o,to:t}:null}function Wt(e,t,o,a,n,r){const s=Ht.framePadding*a;return{id:e,parentId:t,box:{x:o.x+s,y:o.y+ma/n,w:Math.max(0,o.w-s*2),h:24/n},frame:o,opacity:r,inCard:!0}}function pe(e,t){const o=e.map((a,n)=>({...a,i:n})).sort((a,n)=>a.to-n.to||a.i-n.i);return t.push(...o.map(a=>a.card)),o.map(a=>a.section).reverse()}function pt(e,t,o,a,n,r){const s=Ht.frameHeaderHeight,i=l=>({x:o+(l.x-t.box.x)*n,y:a+(l.y-t.box.y-s)*n,w:l.w*n,h:l.h*n});for(const l of t.itemIds){const f=e.items.get(l);f&&r.set(l,i(f))}const c=t.groups.map(l=>({...l,box:i(l.box),heading:l.heading&&i(l.heading)}));return{...t,box:{x:o,y:a,w:t.box.w*n,h:(t.box.h-s)*n},header:{x:o,y:a,w:t.box.w*n,h:0},groups:c,more:t.more&&{...t.more,box:i(t.more.box)}}}const ba=.45,Lt={fill:.2,hold:.15,fade:.7},ya=2.4;class Ma{constructor(t,o){this.families=t;for(const a of t)a.kids.forEach((n,r)=>{const s=n.state==="running"||n.state==="waiting",i=o-n.startedAgo,c=1+(r*7919+a.parentId.length*104729+n.id.charCodeAt(23)*31)%997;this.kids.set(n.id,{demo:n,parentId:a.parentId,index:r+1,seed:c,own:Ze(ae(n.id)),state:n.state,prev:n.state,since:o-60,started:i,finished:s?null:i+n.ran})});this.next=o+2.5}families;kids=new Map;live=!1;next=0;r=ge(42);familyKids(t){return t.kids.slice(0,t.count).map(o=>this.kids.get(o.id))}set(t,o,a){const n=this.kids.get(t);if(!n||n.state===o)return;const r=s=>s==="running"||s==="waiting";r(o)&&!r(n.state)?(n.started=a,n.finished=null):!r(o)&&r(n.state)&&(n.finished=a),n.prev=n.state,n.state=o,n.since=a}tick(t){if(!this.live||t<this.next)return;this.next=t+2.2+this.r()*1.6;const o=this.families.flatMap(c=>this.familyKids(c)),a=c=>{const l=o.filter(f=>f.state===c&&t-f.since>2);return l.length?l[Math.floor(this.r()*l.length)]:void 0},n=this.r(),r=a("running"),s=a("waiting");if(s&&n<.2)return this.set(s.demo.id,"running",t);if(r&&n<.62)return this.set(r.demo.id,this.r()<.18?"failed":this.r()<.12?"waiting":"done",t);const i=a("done")??a("failed");i&&this.set(i.demo.id,"running",t)}look(t,o,a,n,r,s){const i=he(B((o-t.since)/ba));r.run=r.done=r.fail=r.wait=0;const c=(f,u)=>{f==="running"?r.run+=u:f==="done"?r.done+=u:f==="failed"?r.fail+=u:r.wait+=u};c(t.state,i),c(t.prev,1-i);const l=o-t.since;return r.flash=!s&&t.state==="done"&&t.prev==="running"?l<Lt.fill?he(l/Lt.fill):1-he(B((l-Lt.fill-Lt.hold)/Lt.fade)):0,r.open=a,r.hover=n,r.breath=s?.6:.5-.5*Math.cos(l/ya*2*Math.PI),r}view(t,o,a){return{id:t.demo.id,title:t.demo.title,agent:t.demo.agent,task:t.demo.task,index:t.index,own:t.own,seed:t.seed,state:t.state,look:a,elapsed:ka((t.finished??o)-t.started)}}}function ka(e){const t=Math.max(0,Math.floor(e));if(t<60)return`${t}s`;const o=Math.floor(t/60);return o<60?`${o}m ${String(t%60).padStart(2,"0")}s`:`${Math.floor(o/60)}h ${String(o%60).padStart(2,"0")}m`}const X=Oo({site:"subagents",title:"Subagents",storageKey:"canvas-playground-subagents-v5",defaults:()=>({tech:ft[0].id,params:Object.fromEntries(ft.map(e=>[e.id,mt(e.params)])),row:mt(Ot),expand:mt(It),ideas:mt(Dt),live:!0,count:8}),restore(e,t){typeof e.v=="string"&&ft.some(o=>o.id===e.v)&&(t.tech=e.v),Bo(ft,e.p,t.params),e.r&&(t.row=Zt(Ot,{...t.row,...e.r})),e.x&&(t.expand=Zt(It,{...t.expand,...e.x})),e.i&&(t.ideas=Zt(Dt,{...t.ideas,...e.i})),typeof e.live=="boolean"&&(t.live=e.live),typeof e.n=="number"&&to.includes(String(e.n))&&(t.count=e.n)},share:e=>({v:e.tech,p:No(ft,e.params),r:Jt(Ot,e.row),x:Jt(It,e.expand),i:Jt(Dt,e.ideas),live:e.live,n:e.count}),exportJson:e=>({site:"subagents",technique:{id:e.tech,name:Qe(e.tech).name,params:e.params[e.tech]},row:e.row,expand:e.expand,ideas:e.ideas})}),{settings:C,demo:eo}=X;eo.setAttribute("aria-label","The canvas: scroll to pan, pinch or ctrl-scroll to zoom; click a subagent’s orb to open its frame under it");const it=S("div","canvas-container sa-canvas"),yt=S("canvas","canvas"),Mt=S("div","overlay"),zt=S("div","sa-loading","Drawing the demo canvas…"),oe=S("div","sa-toast");it.append(yt,Mt,zt,oe);eo.prepend(it);const $=new fa;$.mount(it);$.setCurrentTool("select");window.editor=$;let K=null,D=null,Bt=null,J=null,tt=null;const qt=()=>Qe(C.tech),ne=()=>C.params[C.tech],se=()=>C.row,kt=()=>C.expand,Gt=()=>C.ideas,ye=()=>String(kt().fit),oo=()=>!!se().reduced,nt=new Map,Xe={standard:Yt(.4,0,.2,1),decelerate:Yt(0,0,.2,1),"in-out":Yt(.65,0,.35,1)};function Me(e,t){const o=nt.get(e);if(!o)return 0;const a=Number(kt().dur),n=a<=0?1:B((t-o.start)/a);return n>=1&&o.to===0&&nt.delete(e),o.from+(o.to-o.from)*(Xe[String(kt().ease)]??Xe.standard)(n)}const ct=e=>(nt.get(e)?.to??0)>.5;function ie(e,t,o,a=0){ct(e)===t&&nt.has(e)===t||(nt.set(e,{from:Me(e,o),to:t?1:0,start:o+a}),V=!0)}function Nt(e){return K?.families.find(t=>t.parentId===e||t.kids.some(o=>o.id===e))}function St(e){return e.kids.slice(0,e.count)}function ke(e,t=!1){const o=performance.now(),a=!ct(e),n=[];if(a&&!t){const s=Nt(e);for(const i of s?St(s):[])i.id!==e&&ct(i.id)&&n.push(i.id);for(const i of n)ie(i,!1,o)}ie(e,a,o);const r=nt.get(e);r&&a&&(r.replaced=n.length===1?n[0]:ut&&n.includes(ut)?ut:void 0),a&&At.delete(e),ut=a?e:ut}let ut=null;function ao(){for(const e of nt.keys())if(ct(e))return!0;return!1}function _a(e){const t=ut&&ct(ut)?ut:[...nt.keys()].find(ct),o=t&&Nt(t);if(!t||!o)return!1;const a=_e(o).map(r=>r.id),n=a[(a.indexOf(t)+e+a.length)%a.length];return n&&n!==t&&ke(n),!0}function no(e,t){const o=performance.now(),a=St(e),n=t?a:[...a].reverse(),r=n.length>1?Math.min(Number(kt().stagger),260/(n.length-1)):0;let s=0;for(const i of n)ct(i.id)!==t&&ie(i.id,t,o,r*s++)}function _t(e){for(const t of K?.families??[])no(t,e)}let V=!0,He="";function Aa(){return{head:bt,headGap:8}}function Xt(e){if(!K||!D)return;D.live=C.live,D.tick(e/1e3);const t=$.camera.peek().z,o=new Map,a=ye();let n="";const r=new Set(K.families.flatMap(c=>c.kids.map(l=>l.id)));let s=!1;for(const c of K.families)o.set(c.parentId,_e(c).map(l=>{const f=Me(l.id,e),u=nt.get(l.id)?.to??0;return nt.has(l.id)&&f!==u&&(s=!0),f>0&&a!=="below"&&(n+=`${l.id}:${(Ue(c.parentId,l.id,e)??-1).toFixed(2)},`),{id:l.id,open:f,to:u,from:nt.get(l.id)?.replaced}}));const i=`${t}|${a}|${n}|${[...o.values()].map(c=>c.map(l=>l.open>0?`${l.open.toFixed(4)}${l.to}`:"").join(",")).join(";")}`;!V&&!s&&i===He&&tt||(V=!1,He=i,tt=va({natural:$.naturalLayout.get(),families:o,childIds:r,zoom:t,childScale:Number(kt().scale),m:Aa(),fit:a,anchor:(c,l)=>Ue(c,l,e),memo:Sa,morph:kt().switch==="morph"}),$.plan.set(tt))}const Sa=new Map,Ue=(e,t,o)=>J?.anchor(e,t,o)??null;function _e(e){const t=St(e);if(!Gt().group||!D)return t;const o={waiting:0,failed:1,running:2,done:3};return t.map((a,n)=>({k:a,i:n,r:o[D.kids.get(a.id)?.state??"done"]})).sort((a,n)=>a.r-n.r||a.i-n.i).map(a=>a.k)}$.onFrame(e=>Xt(e));const je=new Map,Ke=new Map,Ve=new Map;function so(e){let t=je.get(e);return t||je.set(e,t={run:0,done:0,fail:0,wait:0,flash:0,open:0,hover:0,breath:0}),t}function Ea(e,t){const o=new Map;if(!K||!D||!J)return o;const a=e/1e3,n=Number(ne().speed??1),r=ne().color==="own",s=oo();for(const i of K.families){const c=_e(i).map(u=>D.kids.get(u.id));if(!c.length)continue;const l=Ze(i.color),f=c.map(u=>{const h=D.look(u,a,Me(u.demo.id,e),J.hover(u.demo.id,e),so(u.demo.id),s),g=(Ke.get(u.demo.id)??u.seed*.37)+t/1e3*n*(h.run+.35*h.wait);Ke.set(u.demo.id,g);const m=io.get(u.demo.id);return m!==void 0&&Gt().unread&&!s&&(h.flash=Math.max(h.flash,Oa(e-m))),{view:D.view(u,a,h),rgb:r?u.own:l,time:g,unread:Gt().unread?At.get(u.demo.id)??0:0,thumb:xe.get(u.demo.id)??null}});o.set(i.parentId,{parentId:i.parentId,kids:f,rgb:l,...Ra(i.parentId,f.map(u=>u.view),e,t,n,s)})}return o}function Ra(e,t,o,a,n,r){let s=Ve.get(e);s||(s={look:{run:0,done:1,fail:0,wait:0,flash:0,open:0,hover:0,breath:0},time:e.length,phase:e.charCodeAt(9)%17/17},Ve.set(e,s));const i=u=>t.some(h=>h.state===u),c=i("running")?"run":i("waiting")?"wait":i("failed")?"fail":"done",l=1-Math.exp(-a/150),f=s.look;for(const u of["run","done","fail","wait"]){const h=u===c?1:0;f[u]+=(h-f[u])*l,Math.abs(h-f[u])<.002&&(f[u]=h)}return f.flash=Math.max(0,...t.map(u=>u.look.flash)),f.hover=J?.hover(`agg:${e}`,o)??0,f.breath=r?.6:.5-.5*Math.cos(o/1e3/2.4*2*Math.PI),s.time+=a/1e3*n*(f.run+.35*f.wait),{agg:f,aggTime:s.time,aggPhase:s.phase}}function $a(){const e=new Map;if(!K||!D)return e;for(const t of K.families){e.set(t.parentId,{id:t.parentId,title:t.title,child:!1});for(const o of t.kids){const a=D.kids.get(o.id),n=a?D.view(a,performance.now()/1e3,so(o.id)):null;e.set(o.id,{id:o.id,title:o.title,agent:o.agent,task:o.task,child:!0,status:n?ee(n):"",statusKind:n?.state})}}return e}let We="",ue=0,ve=null,W=!0;function Ca(e){if(!J||!tt)return;const t=ue?Math.min(100,Math.max(0,e-ue)):16;ue=e;const o=$.camera.peek(),{w:a,h:n}=$.viewport.peek(),r=yt.width/Math.max(1,a);J.orbs.resize(yt.width,yt.height,a,n);const s=Ea(e,t),i=`${o.x},${o.y},${o.z},${a},${n},${yt.width}`;!W&&i===We&&ve===tt&&!J.animating&&!J.alive&&!Pa(s)||(W=!1,We=i,ve=tt,J.draw(tt,$a(),s,{tech:qt(),p:ne(),max:Number(se().max),titlePx:Number(se().title),reduced:oo(),preview:!!Gt().preview},e,r),X.setZoom(o.z))}function Pa(e){for(const t of e.values())for(const o of[...t.kids.map(a=>a.view.look),t.agg])if(!wt(o.run)||!wt(o.done)||!wt(o.fail)||!wt(o.wait)||o.flash>0||!wt(o.open)||!wt(o.hover))return!0;return!1}const wt=e=>e<.001||e>.999;async function La(){const e=await ha();K=e,e.families[0].count=C.count,D=new Ma(e.families,performance.now()/1e3);for(const a of e.items)xe.has(a.sessionId)||xe.set(a.sessionId,a.thumb);const t=e.families[0].kids;At.set(t[1].id,2),At.set(t[6].id,1),$.loadSnapshot(e.sessions,e.items),V=!0,$.whenViewportReady(()=>requestAnimationFrame(()=>ce(!1)));try{Bt=await xo.create(yt,Mt,$,{readOnly:!0,easeLayout:!1,busySessions:()=>Ta(),getRaisedSections:()=>za()}),window.renderer=Bt}catch(a){console.error(a),zt.textContent=`Can't start the renderer: ${Te(a)}`;return}zt.remove();let o;try{o=new zo(Mt)}catch(a){zt.textContent=`Can't start WebGL2 for the orbs: ${Te(a)}`,it.append(zt);return}J=new sa(Mt,$,o,{toggleKid:ke,showAll:()=>W=!0,zoomTo:a=>Se(()=>{const n=$.layout.get().sections.find(r=>r.id===a);return n?be.union([n.box,n.header]):null},64,!0)}),Ao.then(()=>{J?.text.reset(),W=!0}),$.onFrame(a=>Ca(a))}const Tt=new Set;function Ta(){if(Tt.clear(),!K||!D||!se().busy)return Tt;const e=ye()!=="below";for(const t of K.families)if(t.busy&&Tt.add(t.parentId),!e)for(const o of D.familyKids(t))o.state==="running"&&Tt.add(o.demo.id);return Tt}function za(){return(tt?.cards??[]).map(e=>({id:e.id,shadow:e.shadow}))}const At=new Map,io=new Map,xe=new Map,Fa=900,Oa=e=>e<0?0:e<150?e/150:Math.max(0,1-(e-150)/(Fa-150));let Ye=0;function Ia(e){if(!K||!D||!C.live||!Gt().unread||e<Ye)return;Ye=e+2600+e*7%1900;const t=K.families.flatMap(o=>D.familyKids(o)).filter(o=>o.state==="running"&&!ct(o.demo.id));t.length&&Ae(t[Math.floor(e/997%t.length)].demo.id,e)}function Ae(e,t=performance.now()){ct(e)||(At.set(e,(At.get(e)??0)+1),io.set(e,t),W=!0)}$.onFrame(e=>Ia(e));let we=null;it.addEventListener("pointerdown",e=>{we=e.button===0?{x:e.clientX,y:e.clientY}:null});it.addEventListener("pointerup",e=>{const t=we;if(we=null,!t||Math.hypot(e.clientX-t.x,e.clientY-t.y)>4||!ao()||ye()==="below"||e.target.closest(".sa-orb, .sa-agg, .sa-more, .sa-close"))return;const o=it.getBoundingClientRect(),a=$.screenToPage({x:e.clientX-o.left,y:e.clientY-o.top});(tt?.cards??[]).some(r=>r.open>.5&&a.x>=r.box.x&&a.x<=r.box.x+r.box.w&&a.y>=r.box.y&&a.y<=r.box.y+r.box.h)||_t(!1)});let Je=0;function Da(e){oe.textContent=e,oe.classList.add("on"),clearTimeout(Je),Je=window.setTimeout(()=>oe.classList.remove("on"),2400)}function ce(e=!0){Se(()=>$.layout.get().bounds,48,e)}function Se(e,t,o){const a=$.camera.peek();let n=a;for(let r=0;r<5;r++){const s=e();if(!s)return;n=$.getCameraForBounds(s,{padding:t}),$.setCamera(n),V=!0,Xt(performance.now())}o&&($.setCamera(a),V=!0,Xt(performance.now()),$.setCamera(n,{animate:!0,duration:480}))}vo(()=>{it.style.cursor=$.cursor.get()});const ro=()=>X.setCaption(qt().name,qt().note),Ba=Io(X,ft,C.tech,e=>{C.tech=e,co.render(),ro(),W=!0,X.save()}),co=Do(X,"Technique",()=>qt().params,()=>ne(),()=>{W=!0,X.save()},()=>C.params[C.tech]=mt(qt().params)),Na=X.section("Title row",rt("Reset",()=>{C.row=mt(Ot),le(),V=W=!0,X.save()},"ghost",!0));function le(){Na.replaceChildren(...Ot.map(e=>re(e,C.row,()=>{V=W=!0,X.save()})),S("p","pg-note","Every technique: failed is red and still, waiting breathes. Hover an orb for its subagent; click it to open its frame right under it (Fit, below). Zoomed out, the orbs fold into +N, then flow into one."))}le();const qa=X.section("Expanding",rt("Reset",()=>{C.expand=mt(It),Ee(),V=!0,X.save()},"ghost",!0));function Ee(){qa.replaceChildren(...It.map(e=>re(e,C.expand,()=>{V=!0,X.save()})),S("div","pg-buttons",rt("Expand all",()=>_t(!0),"",!0),rt("Collapse all",()=>_t(!1),"",!0)))}Ee();const Ga=X.section("Ideas",rt("Reset",()=>{C.ideas=mt(Dt),Re(),V=W=!0,X.save()},"ghost",!0));function Re(){Ga.replaceChildren(...Dt.map(e=>re(e,C.ideas,()=>{V=W=!0,X.save()})),S("p","pg-note","Prototypes: the hover label shows what the subagent last made; a working subagent that isn’t open gets a count of what it posted since (its orb brightens as it posts); the row orders waiting, failed, running, done."),S("div","pg-buttons",rt("Post from one",()=>Xa(),"",!0)))}Re();function Xa(){const e=K?.families[0],t=e&&St(e).find(o=>!ct(o.id));t&&Ae(t.id)}X.section("Demo").append(ko("Coordinator’s",to,String(C.count),e=>lo(Number(e))),_o("Live states",C.live,e=>{C.live=e,X.save()}),S("div","pg-buttons",rt("Fit",()=>ce(),"",!0),rt("Next state",()=>Ha(),"",!0)));function lo(e){C.count=e;const t=K?.families[0];if(t){t.count=e;for(const o of t.kids.slice(e))nt.delete(o.id)}V=W=!0,X.save()}function Ha(){if(!D)return;const e=D.live;D.live=!0,D.next=0,D.tick(performance.now()/1e3),D.live=e}const Ua=[["Hover","an orb: its subagent and state"],["Click","an orb: open its frame under it, or switch to it"],["⇧Click","open another alongside"],["←→","with one open: the subagent before or after; on a focused orb: move along the row"],["1–8","technique"],["E","expand or collapse every subagent"],["Esc","or click outside: collapse"],["M","reduced motion"],["⇧1","zoom to fit"]];X.section("Keys").append(S("div","sa-keys",...Ua.flatMap(([e,t])=>[S("kbd","",e),S("span","",t)])));window.addEventListener("keydown",e=>{e.target.closest('input, textarea, [role="slider"]')||e.metaKey||e.ctrlKey||e.altKey||(e.key==="e"||e.key==="E"?_t(!(K?.families??[]).every(t=>St(t).every(o=>ct(o.id)))):e.key==="Escape"?_t(!1):(e.key==="ArrowLeft"||e.key==="ArrowRight")&&!e.target.closest("button")&&ao()?_a(e.key==="ArrowLeft"?-1:1)&&e.preventDefault():(e.key==="m"||e.key==="M")&&(C.row.reduced=!C.row.reduced,le(),W=!0,Da(C.row.reduced?"Reduced motion: every orb holds its pose":"Motion on"),X.save()))});X.toolbar.append(rt("Fit",()=>ce(),"",!0));ro();La();Object.assign(window,{playground:{editor:$,settings:C,get sim(){return D},get demo(){return K},ready:()=>!!Bt&&!!J&&!!tt,select:e=>Ba.select(e),param(e,t){C.params[C.tech][e]=t,co.render(),W=!0},row(e,t){C.row[e]=t,le(),V=W=!0},expandParam(e,t){C.expand[e]=t,Ee(),V=W=!0},idea(e,t){C.ideas[e]=t,Re(),V=W=!0},toggle:(e,t=!1)=>ke(e,t),post:e=>Ae(e),cards:()=>tt?.cards,live(e){C.live=e},state(e,t){D?.set(e,t,performance.now()/1e3)},open:(e,t=!0)=>ie(e,t,performance.now()),expandAll:(e,t=!0)=>{const o=Nt(e);o&&no(o,t)},expandEverything:_t,setCount:lo,kids:e=>Nt(e)?.kids.slice(0,Nt(e).count).map(t=>({id:t.id,title:t.title,state:D?.kids.get(t.id)?.state})),families:()=>K?.families.map(e=>({id:e.parentId,title:e.title,kids:St(e).length})),orbPoint(e){const t=J?.orbCentre(e);if(!t)return null;const o=it.getBoundingClientRect();return{x:o.left+t.x,y:o.top+t.y}},look(e,t=48,o=0,a=0,n=0){Se(()=>{const r=$.layout.get().sections.find(i=>i.id===e),s=r&&be.union([r.box,r.header]);return s?{x:s.x,y:s.y-n,w:s.w+o,h:s.h+a+n}:null},t,!1)},trace(){const e=$.camera.peek(),t=i=>(i+e.x)*e.z,o=i=>(i+e.y)*e.z,a=i=>[t(i.x),o(i.y),i.w*e.z,i.h*e.z].map(c=>Math.round(c*100)/100),n=ve,r=it.getBoundingClientRect(),s=i=>Math.round(i*100)/100;return{cam:e,frames:Object.fromEntries((n?.layout.sections??[]).map(i=>[i.id,a(i.box)])),drawn:Object.fromEntries((n?.layout.sections??[]).map(i=>[i.id,Bt?.sectionBox(i.id)?a(Bt.sectionBox(i.id)):null])),heads:Object.fromEntries((n?.heads??[]).map(i=>[i.id,a(i.box).slice(0,2)])),dom:Object.fromEntries([...Mt.querySelectorAll(".sa-head")].filter(i=>i.style.display!=="none").map(i=>{const c=i.getBoundingClientRect();return[i.dataset.session,[s(c.left-r.left),s(c.top-r.top)]]})),orbs:Object.fromEntries((J?.drawn??[]).filter(i=>i.alpha>.5).map(i=>[i.id,[s(i.x),s(i.y)]])),orbDom:Object.fromEntries([...Mt.querySelectorAll(".sa-orb")].filter(i=>i.style.display!=="none"&&i.style.cssText).map(i=>{const c=i.getBoundingClientRect();return[i.dataset.id,[s(c.left-r.left+c.width/2),s(c.top-r.top+c.height/2)]]}))}},region(e,t=0,o=16,a=0){const n=$.camera.peek(),r=tt?.heads.find(c=>c.id===e);if(!r)return null;const s=it.getBoundingClientRect(),i=(r.box.y+n.y)*n.z;return{x:Math.round(s.left+(r.frame.x+n.x)*n.z-o),y:Math.round(s.top+i-o),width:Math.round((a||r.frame.w*n.z)+o*2),height:Math.round(bt+8+Math.min(r.frame.h*n.z,t)+o*2)}},place(e,t,o=40,a=70){$.setCamera({...$.camera.peek(),z:t}),V=!0,Xt(performance.now());const n=tt?.heads.find(r=>r.id===e);n&&($.setCamera({x:o/t-n.box.x,y:a/t-n.box.y,z:t}),V=!0,Xt(performance.now()))},camera:()=>$.camera.peek(),setCamera:(e,t,o)=>$.setCamera({x:e,y:t,z:o}),fit:()=>ce(!1),plan:()=>tt,error:()=>J?.orbs.error??null}});
