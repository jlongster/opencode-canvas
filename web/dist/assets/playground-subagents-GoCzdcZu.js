import{a as It,L as _t,B as Ve}from"./layout-D5wn9ku6.js";import{s as Ee,E as Bt,a as Dt,c as rt,r as qt,R as Nt,H as lt}from"./styles-D389Ycyd.js";import{d as Me,f as Ie}from"./ember-oFoqqIy_.js";import{e as k,h as Gt,B as Ht,b as K,l as Ut,p as We,S as jt,i as Xt,j as Kt,k as Vt}from"./shell-CBQlV3rD.js";import{c as Ge,r as He,a as x,S as Wt,s as Mt,g as Yt,p as Jt,t as ct,d as ie}from"./params-Bh0xY2p6.js";function X(t){return t<0?0:t>1?1:t}function Rt(t){const e=parseInt(t.replace("#",""),16);return[e>>16&255,e>>8&255,e&255]}function Zt(t){const e=o=>{const a=o/255;return a<=.04045?a/12.92:Math.pow((a+.055)/1.055,2.4)};return[e(t[0]),e(t[1]),e(t[2])]}const oe=20,ce=8,Ue=16,Qt=`#version 300 es
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
}`,eo=`
precision highp float;
precision highp int;
uniform vec2 u_view;
uniform float u_dpr;
uniform float u_p[${Ue}];
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
`,to=`
void main() {
  vec2 px = vec2(gl_FragCoord.x, u_view.y - gl_FragCoord.y);
  vec4 c = vec4(0.0);
  for (int i = 0; i < v_info.y; i++) c = over(c, shadeOrb(orb(v_info.x + i), px));
  o_color = finish(c);
}`,oo=`
void main() {
  vec2 px = vec2(gl_FragCoord.x, u_view.y - gl_FragCoord.y);
  o_color = finish(shadeRow(v_info.x, v_info.y, px));
}`;class ao{canvas;gl;programs=new Map;vao;instBuf;tex;texRows=0;orbData=new Float32Array(oe*64);instData=new Float32Array(ce*64);params=new Float32Array(Ue);nOrbs=0;nInst=0;blank=!0;error=null;constructor(e,o=null){this.canvas=document.createElement("canvas"),this.canvas.className="sa-orb-layer",e.insertBefore(this.canvas,o);const a=this.canvas.getContext("webgl2",{alpha:!0,premultipliedAlpha:!0,antialias:!1,depth:!1,stencil:!1,preserveDrawingBuffer:!1});if(!a)throw new Error("WebGL2 is not available");this.gl=a;const n=a.createBuffer();a.bindBuffer(a.ARRAY_BUFFER,n),a.bufferData(a.ARRAY_BUFFER,new Float32Array([0,0,1,0,0,1,0,1,1,0,1,1]),a.STATIC_DRAW),this.vao=a.createVertexArray(),a.bindVertexArray(this.vao),a.enableVertexAttribArray(0),a.vertexAttribPointer(0,2,a.FLOAT,!1,0,0),this.instBuf=a.createBuffer(),a.bindBuffer(a.ARRAY_BUFFER,this.instBuf);for(const[r,s]of[[1,0],[2,4]])a.enableVertexAttribArray(r),a.vertexAttribPointer(r,4,a.FLOAT,!1,ce*4,s*4),a.vertexAttribDivisor(r,1);a.bindVertexArray(null),this.tex=a.createTexture(),a.bindTexture(a.TEXTURE_2D,this.tex),a.texParameteri(a.TEXTURE_2D,a.TEXTURE_MIN_FILTER,a.NEAREST),a.texParameteri(a.TEXTURE_2D,a.TEXTURE_MAG_FILTER,a.NEAREST),a.texParameteri(a.TEXTURE_2D,a.TEXTURE_WRAP_S,a.CLAMP_TO_EDGE),a.texParameteri(a.TEXTURE_2D,a.TEXTURE_WRAP_T,a.CLAMP_TO_EDGE)}resize(e,o,a,n){(this.canvas.width!==e||this.canvas.height!==o)&&(this.canvas.width=e,this.canvas.height=o,this.blank=!1);const r=`${a}px`,s=`${n}px`;this.canvas.style.width!==r&&(this.canvas.style.width=r),this.canvas.style.height!==s&&(this.canvas.style.height=s)}begin(){this.nOrbs=0,this.nInst=0}orb(e){(this.nOrbs+1)*oe>this.orbData.length&&(this.orbData=dt(this.orbData));const o=this.orbData,a=this.nOrbs*oe;return o[a]=e.x,o[a+1]=e.y,o[a+2]=e.r,o[a+3]=e.seed,o[a+4]=e.rgb[0],o[a+5]=e.rgb[1],o[a+6]=e.rgb[2],o[a+7]=e.alpha,o[a+8]=e.run,o[a+9]=e.done,o[a+10]=e.fail,o[a+11]=e.wait,o[a+12]=e.flash,o[a+13]=e.t,o[a+14]=e.hover,o[a+15]=e.open,o[a+16]=e.breath,o[a+17]=e.phase,o[a+18]=e.aux,o[a+19]=0,this.nOrbs++}quad(e,o,a,n,r,s){if(a<=0||n<=0||s<=0||e+a<0||o+n<0||e>this.canvas.width||o>this.canvas.height)return;(this.nInst+1)*ce>this.instData.length&&(this.instData=dt(this.instData));const i=this.instData,l=this.nInst++*ce;i[l]=e,i[l+1]=o,i[l+2]=a,i[l+3]=n,i[l+4]=r,i[l+5]=s,i[l+6]=0,i[l+7]=0}draw(e,o,a,n,r){const s=this.gl;if(this.nInst===0){if(this.blank)return;s.viewport(0,0,this.canvas.width,this.canvas.height),s.clearColor(0,0,0,0),s.clear(s.COLOR_BUFFER_BIT),this.blank=!0;return}const i=this.program(e);if(s.viewport(0,0,this.canvas.width,this.canvas.height),s.clearColor(0,0,0,0),s.clear(s.COLOR_BUFFER_BIT),this.blank=!i,!i)return;s.activeTexture(s.TEXTURE0),s.bindTexture(s.TEXTURE_2D,this.tex);const l=Math.max(1,this.nOrbs);l>this.texRows&&(this.texRows=Math.max(64,1<<Math.ceil(Math.log2(l))),s.texImage2D(s.TEXTURE_2D,0,s.RGBA32F,oe/4,this.texRows,0,s.RGBA,s.FLOAT,null)),s.texSubImage2D(s.TEXTURE_2D,0,0,0,oe/4,l,s.RGBA,s.FLOAT,this.orbData.subarray(0,l*oe)),s.useProgram(i.program),s.uniform2f(i.u.view,this.canvas.width,this.canvas.height),s.uniform1f(i.u.dpr,a),this.params.fill(0);for(let h=0;h<Math.min(Ue,o.length);h++)this.params[h]=o[h];s.uniform1fv(i.u.p,this.params),s.uniform4f(i.u.grid,n[0],n[1],n[2],n[3]),s.uniform1f(i.u.reduced,r?1:0),s.uniform1i(i.u.orbs,0),s.enable(s.BLEND),s.blendFunc(s.ONE,s.ONE_MINUS_SRC_ALPHA),s.bindVertexArray(this.vao),s.bindBuffer(s.ARRAY_BUFFER,this.instBuf),s.bufferData(s.ARRAY_BUFFER,this.instData.subarray(0,this.nInst*ce),s.DYNAMIC_DRAW),s.drawArraysInstanced(s.TRIANGLES,0,6,this.nInst),s.bindVertexArray(null)}program(e){const o=this.programs.get(e.id);if(o)return o;const a=this.gl;try{const n=`#version 300 es
${e.defines}
${eo}
${e.glsl}
${e.row?oo:to}`,r=no(a,Qt,n),s=l=>a.getUniformLocation(r,l),i={program:r,u:{view:s("u_view"),dpr:s("u_dpr"),p:s("u_p"),grid:s("u_grid"),reduced:s("u_reduced"),orbs:s("u_orbs")}};return this.programs.set(e.id,i),this.error=null,i}catch(n){return this.error=String(n),console.error(n),null}}destroy(){this.canvas.remove()}}function dt(t){const e=new Float32Array(t.length*2);return e.set(t),e}function no(t,e,o){const a=t.createProgram();for(const[n,r]of[[t.VERTEX_SHADER,e],[t.FRAGMENT_SHADER,o]]){const s=t.createShader(n);if(t.shaderSource(s,r),t.compileShader(s),!t.getShaderParameter(s,t.COMPILE_STATUS)){const i=r.split(`
`).map((l,h)=>`${h+1}: ${l}`).join(`
`);throw new Error(`shader compile failed: ${t.getShaderInfoLog(s)}
${i}`)}t.attachShader(a,s)}if(t.linkProgram(a),!t.getProgramParameter(a,t.LINK_STATUS))throw new Error(`link failed: ${t.getProgramInfoLog(a)}`);return a}function so(t){const e=t.defaults();try{t.restore(JSON.parse(localStorage.getItem(t.storageKey)??"{}"),e)}catch{}try{const m=/[#&]s=([^&]+)/.exec(location.hash);m&&t.restore(JSON.parse(decodeURIComponent(m[1])),e)}catch(m){console.warn("ignoring an unreadable settings hash",m)}let o=0;const a=()=>{clearTimeout(o),o=window.setTimeout(()=>{const m=JSON.stringify(t.share(e));localStorage.setItem(t.storageKey,m),history.replaceState(null,"",`#s=${encodeURIComponent(m)}`)},150)};document.title=`${t.title} · Frame status playground`;const n=k("div","pg-app"),r=k("nav","c-tabs");r.setAttribute("aria-label","Playgrounds");for(const m of Gt){const y=k("a","",m.name);y.href=m.href,m.id===t.site&&y.setAttribute("aria-current","page"),r.append(y)}const s=k("a","pg-brand","Frame status");s.href=`${Ht}/playground`;const i=k("span","pg-readout pg-fps");i.title="Frames per second";const l=k("span","pg-readout pg-zoom");l.title="Zoom";const h=k("div","pg-toolbar",s,r,k("span","pg-spacer"),i,l),d=k("div","pg-demo");d.tabIndex=0;const c=k("div","pg-caption");d.append(c);const b=k("main","pg-main",h,d),v=k("div","pg-panel-body"),f=K("Copy settings",()=>{u()},"primary",!0),w=k("aside","pg-panel",k("header","pg-panel-head",k("h1","",t.title),f),v);n.append(b,w),document.body.append(n);async function u(){const m=JSON.stringify(t.exportJson(e),null,2);try{await navigator.clipboard.writeText(m)}catch{const y=k("textarea");y.value=m,document.body.append(y),y.select(),document.execCommand("copy"),y.remove()}console.log(m),f.textContent="Copied",setTimeout(()=>f.textContent="Copy settings",1200)}window.playgroundSettings=()=>t.exportJson(e);function C(m,y){const g=k("div","pg-stack"),P=k("div","pg-section-head",k("h2","",m));return y&&P.append(y),v.append(k("section","pg-section",P,g)),g}function T(m,y){c.replaceChildren(k("b","",m),k("span","",y)),c.title=y}const $=[];let M=performance.now();const p=[];let F=0;const E=m=>{requestAnimationFrame(E);const y=Math.max(0,Math.min(100,m-M));if(M=m,p.push(y),p.length>60&&p.shift(),m-F>500&&p.length>5){F=m;const g=1e3/(p.reduce((P,A)=>P+A,0)/p.length);i.textContent=`${Math.round(g)} fps`,i.dataset.fps=String(g)}for(const g of $)try{g(y,m)}catch(P){console.error(P)}};return requestAnimationFrame(E),{settings:e,save:a,section:C,setCaption:T,demo:d,toolbar:h,panelBody:v,setZoom:m=>l.textContent=`${Math.round(m*100)}%`,onTick:m=>$.push(m)}}function io(t,e,o,a){const n=Ut(e.map((r,s)=>({id:r.id,name:r.name,key:String(s+1),title:r.note})),o,a,"Variation");return t.section("Variation").append(n.el),window.addEventListener("keydown",r=>{if(r.target.closest('input, textarea, [role="slider"]')||r.metaKey||r.ctrlKey||r.altKey)return;const s=Number(r.key)-1;Number.isInteger(s)&&s>=0&&s<e.length&&n.select(e[s].id)}),n}function ro(t,e,o,a,n,r){const s=K("Reset",()=>{r(),l(),n()},"ghost",!0),i=t.section(e,s),l=()=>i.replaceChildren(...o().map(h=>We(h,a(),n,jt)));return l(),{render:l}}function lo(t,e,o){const a=e??{};for(const n of t)a[n.id]&&(o[n.id]=He(n.params,{...o[n.id],...a[n.id]}))}function co(t,e){const o={};for(const a of t){const n=Ge(a.params,e[a.id]);Object.keys(n).length&&(o[a.id]=n)}return o}const ho=(t,e=6,o=28)=>x("size","Size",t,e,o,1,"px"),fo=t=>x("spacing","Spacing",t,8,44,1,"px"),po=(t="parent")=>Mt("color","Colour",["parent","own"],t),V=(t,e,o="parent",a=6,n=28)=>[ho(t,a,n),fo(e),Wt,po(o)],ae=t=>(e,o,a)=>{const n=Math.max(t*o,o*1.06+4*a)+2;return[n,n,n,n]},uo=`
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
}`,mo=`
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
}`,go=`
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
}`,vo=`
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
}`,xo=`
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
}`,bo=`
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
}`,wo=`
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
}`,yo=`
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
}`,W=[{id:"glass",name:"Glass orbs",note:"A tiny glass sphere with Fresnel rim light and a soft highlight; domain-warped noise swirls inside while it works and stills once it’s done.",params:[...V(12,19),x("rim","Rim light",.7,0,1.5,.05),x("spec","Highlight",.75,0,1.5,.05),x("scale","Noise scale",1.1,.4,4,.05),x("glow","Glow",1,0,2,.05)],row:!1,reach:ae(1.8),anchor:"centre",still:3.1,glsl:uo},{id:"wisps",name:"Wisps",note:"Incense threads standing on the title’s baseline: curl-noise smoke rises from a small ember while it works; done leaves the ember alone.",params:[...V(9,17,"parent",4,20),x("height","Height",24,8,44,1,"px"),x("curl","Curl",.9,0,2,.05),x("thick","Thickness",1,.4,2,.05),x("glow","Glow",1,0,2,.05)],row:!1,reach:(t,e,o)=>{const a=Math.max(2.6*e,e*1.08+4*o)+2,n=Math.max(Number(t.height)*o*1.1+e,a);return[a,n,a,a]},anchor:"baseline",still:2.4,glsl:mo},{id:"metaballs",name:"Metaballs",note:"Liquid drops on the title line: running ones wander, and now and then two neighbours draw together, merge and part; done drops shrink and settle.",params:[...V(11,18),x("goo","Goo",.45,0,1,.05),x("wander","Wander",.8,0,1.5,.05),x("shine","Highlight",.6,0,1.5,.05)],row:!0,reach:ae(1.8),anchor:"centre",still:6.3,glsl:go},{id:"fireflies",name:"Fireflies",note:"A crisp point with a soft halo drifting in a tiny Lissajous orbit, trailing light and flickering while it works; done ones hold a steady glow.",params:[...V(14,18),x("orbit","Orbit",3,0,8,.25,"px"),x("flicker","Flicker",.6,0,1,.05),x("trail","Trail",.6,0,1.5,.05),x("core","Core",2.6,1,5,.1,"px")],row:!1,reach:(t,e,o)=>{const a=Math.max(e*1.7,e*.9+4*o)+Number(t.orbit)*o+2;return[a,a,a,a]},anchor:"centre",still:1.7,glsl:vo},{id:"plasma",name:"Plasma beads",note:"A lit bead whose surface is sphere-mapped fbm folded into plasma bands, turning on a tilted axis while it works; done beads stop and soften.",params:[...V(12,19),x("scale","Noise scale",1.3,.4,4,.05),x("bands","Bands",1.4,0,4,.05),x("spin","Spin",1,0,3,.05),x("light","Lighting",.7,0,1,.05)],row:!1,reach:ae(1),anchor:"centre",still:2.2,glsl:xo},{id:"dots",name:"Dot-grid orbs",note:"Orbs seen through the Ember band’s own dot grid: its clumps crawl round a little ring while running; done is a small calm cluster.",params:[...V(22,30,"parent",14,36),x("crawl","Crawl",5.5,0,14,.5,"px/s"),x("scale","Noise scale",7,3,12,.5,"px"),x("sparse","Sparse",.5,.35,.7,.005),x("peak","Peak",.9,.3,1,.05)],row:!0,reach:ae(1.8),anchor:"centre",still:4,glsl:bo},{id:"ink",name:"Ink drops",note:"A drop of ink blooming in water, looping, ink pooling at its lobed front; done leaves a still stain.",params:[...V(14,20),x("period","Period",3.2,1.5,6,.1,"s"),x("spread","Spread",1,.6,1.3,.02),x("tendrils","Tendrils",1,0,2,.05)],row:!1,reach:ae(1.5),anchor:"centre",still:1.15,glsl:wo},{id:"moons",name:"Moons",note:"A small moon whose phases cycle while it works: full and calm when done, half lit with a breathing terminator while waiting.",params:[...V(12,18),x("soft","Terminator",.3,0,1,.05),x("shine","Earthshine",.22,0,.6,.02),x("surface","Maria",.5,0,1,.05)],row:!1,reach:ae(1),anchor:"centre",still:2.1,glsl:yo}];function Et(t){return W.find(e=>e.id===t)??W[0]}const ht=new Map;function ko(t){let e=ht.get(t.id);return e||ht.set(t.id,e={id:t.id,glsl:t.glsl,row:t.row,defines:Yt(t.params)}),e}const ue=24,Be=10,ft=140,_o=220,Mo=70,Ro=120,Eo="-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter Variable', ui-sans-serif, system-ui, sans-serif",je=Me(.4,0,.2,1);class Ao{ctx=new OffscreenCanvas(1,1).getContext("2d");cache=new Map;width=(e,o,a=12)=>{const n=`${o}|${a}|${e}`;let r=this.cache.get(n);return r===void 0&&(this.ctx.font=`${o} ${a}px ${Eo}`,r=this.ctx.measureText(e).width,this.cache.set(n,r)),r};reset(){this.cache.clear()}}class de{constructor(e,o){this.dur=o,this.from=this.to=e}dur;from;to;start=-1e9;at(e){const o=je(X((e-this.start)/this.dur));return this.from+(this.to-this.from)*o}set(e,o){Math.abs(e-this.to)<1e-6||(this.from=this.at(o),this.to=e,this.start=o)}moving(e){return e-this.start<this.dur}}class So{constructor(e,o,a,n){this.editor=o,this.orbs=a,this.actions=n,this.host=document.createElement("div"),this.host.className="sa-chrome",e.appendChild(this.host),this.tip=document.createElement("div"),this.tip.className="sa-tip",this.tip.hidden=!0,this.host.appendChild(this.tip)}editor;orbs;actions;host;tip;heads=new Map;hovered=null;hoveredAt=0;labelFor=null;labelShownAt=0;labelHiddenAt=-1e9;hoverValue=new Map;styleCache=new WeakMap;text=new Ao;params=new Float32Array(16);animating=!1;alive=!1;drawn=[];hover(e,o){const a=this.hoverValue.get(e);if(!a)return 0;const n=je(X((o-a.at)/ft)),r=a.v+(a.to-a.v)*n;return n>=1&&a.to===0&&this.hoverValue.delete(e),r}setHover(e,o){if(e!==this.hovered){for(const a of[this.hovered,e]){if(!a)continue;const n=this.hover(a,o);this.hoverValue.set(a,{v:n,at:o,to:a===e?1:0})}this.hovered=e,this.hoveredAt=o}}updateLabel(e){if(this.hovered===this.labelFor)return;if(!this.hovered){this.labelFor&&(this.labelHiddenAt=e),this.labelFor=null;return}const o=!!this.labelFor||e-this.labelHiddenAt<400;e-this.hoveredAt<(o?Mo:_o)||(o||(this.labelShownAt=e),this.labelFor=this.hovered)}css(e,o){this.styleCache.get(e)!==o&&(this.styleCache.set(e,o),e.style.cssText=o)}draw(e,o,a,n,r,s){const i=this.editor.camera.peek(),{w:l,h}=this.editor.viewport.peek(),d=p=>Math.round(p*s)/s,c=this.orbs,b=n.tech,v=n.p,f=Number(v.size),w=Number(v.spacing),u=d(b.anchor==="baseline"?ue/2+.363*n.titlePx:ue/2);this.animating=!1,this.alive=!1,this.drawn=[],c.begin(),this.updateLabel(r);const C=je(X((r-this.labelShownAt)/Ro));(this.hovered!==this.labelFor||C<1)&&(this.animating=!0);let T=!1;const $=new Set;for(const p of e.heads){const F=o.get(p.id);if(!F)continue;const E=d((p.box.x+i.x)*i.z),m=d((p.box.y+i.y)*i.z),y=p.parentId?Math.max(p.box.w*i.z,Math.min(300,p.box.w*i.z*2.5)):p.box.w*i.z,g=b.anchor==="baseline"?Number(v.height??0):0,P=p.opacity>.01&&E<l&&E+y>0&&m-g<h&&m+ue+40>0&&y>24;let A=this.heads.get(p.id);if(!P){A&&this.css(A.el,"display:none");continue}$.add(p.id),A||(A=this.createHead(p.id),this.heads.set(p.id,A));const O=a.get(p.id),et=F.child?this.text.width(F.agent??"",500,n.titlePx)+5+this.text.width(F.task??"",600,n.titlePx):this.text.width(F.title,600,n.titlePx);let Fe=Math.min(et,y);if(O&&O.kids.length){const U=A.row??=this.createRow(A,p.id);Fe=this.layoutRow(U,O,n,et,y,r);const te=Fe+Be+f/2,Z=m+u,tt=c.nOrbs;let ye=1/0,Oe=-1/0;const N=b.reach(v,f/2*s,s),ot=(Q,B,le,ee)=>{const j=E+te+le*w;ee*=X((E+y-(j+f/2))/6+1);const D=B?B.view.look:O.agg,Ot=Zt(B?B.rgb:O.rgb),it=B?B.view.seed:500+p.id.length,zt=B?Po(it*.6180339):O.aggPhase;c.orb({x:j*s,y:Z*s,r:f/2*s,seed:it%97,rgb:Ot,alpha:ee*p.opacity,run:D.run,done:D.done,fail:D.fail,wait:D.wait,flash:D.flash,t:n.reduced?b.still:B?B.time:O.aggTime,hover:D.hover,open:D.open,breath:D.breath,phase:zt,aux:w*s}),b.row||c.quad(j*s-N[0],Z*s-N[1],N[0]+N[2],N[1]+N[3],c.nOrbs-1,1),ye=Math.min(ye,j),Oe=Math.max(Oe,j),this.drawn.push({id:Q,x:j,y:Z,alpha:ee}),!n.reduced&&(D.run+D.wait>.001||D.flash>.001)&&(this.alive=!0)};for(const Q of O.kids){const B=U.slots.get(Q.view.id);if(!B)continue;const le=B.alpha.at(r),ee=B.u.at(r);le>.002&&ot(Q.view.id,Q,ee,le);const j=Math.max(Math.min(w,f+8),12),D=le>.5;this.css(B.el,D?`transform:translate(${d(te+ee*w-j/2)}px,0);width:${j}px`:"display:none"),D&&this.labelFor===Q.view.id&&p.opacity>.5&&(this.showTip(Q.view,E+te+ee*w,Z-f/2-7,C),T=!0)}const ze=U.agg.alpha.at(r);ze>.002&&ot(`agg:${p.id}`,O.kids.length===1?O.kids[0]:null,0,ze);const at=ze>.5,Ft=O.kids.length>1?this.text.width(String(O.kids.length),600,11)+6:0;this.css(U.agg.el,at?`transform:translate(${d(te-f/2-3)}px,0);width:${Math.ceil(f+10+Ft)}px;--count-x:${f+9}px`:"display:none"),at&&this.labelFor===`agg:${p.id}`&&(this.showText(U.agg.label,E+te,Z-f/2-7,C),T=!0);const ke=U.more.alpha.at(r),nt=te+U.more.u.at(r)*w+Math.max(f,w)/2+2;this.css(U.more.el,ke>.01?`transform:translate(${d(nt-4)}px,0);opacity:${ke.toFixed(3)};pointer-events:${ke>.5?"auto":"none"}`:"display:none"),ke>.5&&this.labelFor===`more:${p.id}`&&(this.showText(U.more.el.dataset.label??"",E+nt+10,Z-f/2-7,C),T=!0),this.animating||=this.rowMoving(U,r);const st=c.nOrbs-tt;b.row&&st>0&&c.quad(ye*s-N[0]-w*s,Z*s-N[1],(Oe-ye)*s+N[0]+N[2]+2*w*s,N[1]+N[3],tt,st)}else A.row&&(A.row.el.remove(),A.row=null);this.fillHead(A,F,Fe),this.css(A.el,`transform:translate(${E}px,${m}px);width:${Math.max(0,Math.floor(y))}px;opacity:${p.opacity.toFixed(3)};--title:${n.titlePx}px`)}for(const[p,F]of this.heads)$.has(p)||this.css(F.el,"display:none");T||(this.tip.hidden=!0),Jt(b.params,v,this.params);const M=[Math.round(i.x*i.z*s),Math.round(i.y*i.z*s),Math.max(2,Math.round(5*s)),Math.max(1,Math.floor(2*s+.5))];c.draw(ko(b),this.params,s,M,n.reduced);for(const p of this.hoverValue.values())(p.to!==1||r-p.at<ft)&&(this.animating=!0)}rowMoving(e,o){if(e.agg.alpha.moving(o)||e.more.alpha.moving(o)||e.more.u.moving(o))return!0;for(const a of e.slots.values())if(a.u.moving(o)||a.alpha.moving(o))return!0;return!1}layoutRow(e,o,a,n,r,s){const i=o.kids.length,l=Number(a.p.size),h=Number(a.p.spacing),d=e.more.el.dataset.all==="1",c=d?i:Math.min(i,Math.max(1,a.max)),b=g=>g<i?this.text.width(`+${i-g}`,600,12)+12:0,v=g=>Be+l+(g-1)*h+(g<i?Math.max(l,h)/2-l/2+2+b(g):0),f=r-n,w=g=>e.mode===g?-4:4;let u=c;for(;u>0&&v(u)>f-(u>e.shown?3:0);)u--;const C=Math.min(i,2),T=i>1?this.text.width(String(i),600,11)+6:0,$=Be+l+8+T;let M,p=n;u>=C&&v(C)<=f-w("row")?M="row":$<=f-w("merged")?M="merged":r-$>=56+w("merged")?(M="merged",p=r-$):(M="hidden",p=Math.min(n,r)),M==="row"&&(u=Math.max(u,C)),e.mode=M,e.shown=M==="row"?u:0;let F=0;for(const g of o.kids){const P=e.slots.get(g.view.id)??this.createSlot(e,g.view.id),A=M==="row"&&F<u;P.u.set(M==="row"?Math.min(F,u):0,s),P.alpha.set(A?1:0,s);const O=`${g.view.title}: ${De(g.view)}${g.view.look.open>.5?", expanded":""}`;P.label!==O&&(P.label=O,P.el.setAttribute("aria-label",O)),F++}for(const[g,P]of e.slots)o.kids.some(A=>A.view.id===g)||(P.el.remove(),e.slots.delete(g));e.agg.alpha.set(M==="merged"?1:0,s);const E=M==="row"&&u<i?`+${i-u}`:d&&M==="row"&&i>Math.max(1,a.max)?"−":"";if(e.more.u.set(Math.max(0,u-1),s),e.more.alpha.set(E?1:0,s),E&&E!==e.more.text){e.more.text=E,e.more.el.textContent=E;const g=o.kids.slice(u).map(A=>A.view),P=E==="−"?"Show fewer":`${i-u} more: ${pt(g)}`;e.more.el.dataset.label=P,e.more.el.setAttribute("aria-label",P)}const m=i>1?String(i):"";m!==e.agg.text&&(e.agg.text=m,e.agg.el.textContent=m);const y=i===1?`${o.kids[0].view.title}: ${De(o.kids[0].view)}`:`${i} subagents: ${pt(o.kids.map(g=>g.view))} · click to zoom in`;return y!==e.agg.label&&(e.agg.label=y,e.agg.el.setAttribute("aria-label",y)),Math.max(0,Math.min(p,r))}createHead(e){const o=document.createElement("div");return o.className="sa-head",o.dataset.session=e,o.innerHTML='<span class="title"></span>',this.host.insertBefore(o,this.host.firstChild),{el:o,title:o.firstChild,key:"",row:null}}fillHead(e,o,a){this.css(e.title,`max-width:${Math.ceil(a)}px`);const n=`${o.title}|${o.child}`;e.key!==n&&(e.key=n,e.el.classList.toggle("child",o.child),o.child?e.title.innerHTML='<span class="agent"></span><span class="task"></span>':e.title.innerHTML='<span class="task"></span>',o.child&&(e.title.firstChild.textContent=o.agent??""),e.title.lastChild.textContent=o.child?o.task??"":o.title)}createRow(e,o){const a=document.createElement("div");a.className="sa-orbs",e.el.appendChild(a);const n=(i,l,h)=>{const d=document.createElement("button");return d.type="button",d.className=i,d.addEventListener("pointerdown",c=>c.stopPropagation()),d.addEventListener("dblclick",c=>c.stopPropagation()),d.addEventListener("click",c=>(c.stopPropagation(),l())),this.hoverable(d,h),a.appendChild(d),d},r=n("sa-more",()=>{r.dataset.all=r.dataset.all==="1"?"":"1",this.actions.showAll(o)},`more:${o}`),s=n("sa-agg",()=>this.actions.zoomTo(o),`agg:${o}`);return{el:a,mode:"row",shown:0,slots:new Map,more:{el:r,u:new de(0,240),alpha:new de(0,200),text:""},agg:{el:s,alpha:new de(0,320),text:"",label:""}}}createSlot(e,o){const a=document.createElement("button");a.type="button",a.className="sa-orb",a.dataset.id=o,a.addEventListener("pointerdown",r=>r.stopPropagation()),a.addEventListener("dblclick",r=>r.stopPropagation()),a.addEventListener("click",r=>(r.stopPropagation(),this.actions.toggleKid(o))),this.hoverable(a,o),e.el.insertBefore(a,e.el.firstChild);const n={el:a,u:new de(e.slots.size,300),alpha:new de(0,260),label:""};return e.slots.set(o,n),n}hoverable(e,o){const a=()=>this.setHover(o,performance.now()),n=()=>{this.hovered===o&&this.setHover(null,performance.now())};e.addEventListener("pointerenter",a),e.addEventListener("pointerleave",n),e.addEventListener("focus",()=>e.matches(":focus-visible")&&a()),e.addEventListener("blur",n)}showTip(e,o,a,n){this.showHtml(`<span class="nm"><span class="agent">${_e(e.agent)}:</span> ${_e(e.task)}</span><span class="st ${e.state}">${_e(De(e))}</span>`,o,a,n)}showText(e,o,a,n){this.showHtml(`<span class="nm">${_e(e)}</span>`,o,a,n)}showHtml(e,o,a,n){this.tip.innerHTML!==e&&(this.tip.innerHTML=e),this.tip.hidden=!1,this.css(this.tip,`transform:translate(${Math.round(o)}px,${Math.round(a)}px) translate(-50%,-100%);opacity:${n.toFixed(3)}`)}orbCentre(e){const o=this.host.querySelector(e.startsWith("agg:")?`.sa-head[data-session="${e.slice(4)}"] .sa-agg`:`.sa-orb[data-id="${e}"]`);if(!o||o.style.display==="none")return null;const a=o.getBoundingClientRect();if(!a.width)return null;const n=this.host.getBoundingClientRect();return{x:a.left-n.left+a.width/2,y:a.top-n.top+a.height/2}}destroy(){this.host.remove()}}function De(t){return t.state==="running"?`running · ${t.elapsed}`:t.state==="done"?`done in ${t.elapsed}`:t.state==="failed"?`failed after ${t.elapsed}`:"waiting for an answer"}function pt(t){const e={running:0,waiting:0,failed:0,done:0};for(const a of t)e[a.state]++;const o=[];return e.running&&o.push(`${e.running} running`),e.waiting&&o.push(`${e.waiting} waiting`),e.failed&&o.push(`${e.failed} failed`),e.done&&o.push(`${e.done} done`),o.join(" · ")}const Po=t=>t-Math.floor(t);function _e(t){return t.replace(/[&<>"]/g,e=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"})[e])}const Lo=[{key:"coordinator",title:"Canvas build: coordinator",color:"#60a5fa",busy:!0,agent:"build",unread:2,asking:!1,shots:[1.6,1.33,1.78,1,1.5,1.2,1.6,.8],count:14,kids:[["Explore: render loop","running",[1.5]],["General: subagent frames demo","running",[1.78,1.33]],["Explore: competitor heroes","done",[{a:4.2,w:4200},1.78]],["General: fix flaky upload test","done",[1.6,1.2]],["General: mobile onboarding","done",[{a:.5,w:900},1.33]],["Review: page items","failed",[1.33]],["Explore: auth flow","waiting",[1.5,1]],["General: HTML side drawer","done",[1.78,1.5]],["General: precise highlights","done",[1.6]],["Explore: ember band timing","running",[1.78]],["Review: frame chrome copy","done",[1.5]],["General: link cards","done",[1.33,1.6]],["Explore: WebGPU fallbacks","done",[1.6]],["General: unread badge","done",[1.2]],["Explore: video seek latency","running",[1.78]],["General: share dialog","done",[1.5]],["Review: keyboard shortcuts","done",[1.33]],["General: canvas list previews","done",[1.6]],["Explore: Safari texture upload","done",[1.5]],["General: presence bar","done",[1.78]]]},{key:"hero",title:"Landing hero explorations",color:"#f472b6",busy:!1,agent:"build",unread:0,asking:!0,shots:[1.78,1.78,1.5,1.33],kids:[["General: hero variants, round 3","running",[1.78,1.78]],["Explore: brand assets","done",[1.33,1,1.5]],["Review: contrast pass","done",[1.5]]]},{key:"shader",title:"Shader study: rounded SDF",color:"#a78bfa",busy:!1,agent:"plan",unread:0,asking:!1,shots:[1.33,1,1.5,.8],kids:[]},{key:"video",title:"Perf: video pool",color:"#2dd4bf",busy:!0,agent:"build",unread:1,asking:!1,shots:[2.4,1.78,1.2],kids:[["Explore: map video pool","done",[1.5]],["General: decoder reuse","running",[1.78,1.6]],["General: frame pacing traces","running",[2.2]],["Review: memory","done",[1.33]],["Explore: importExternalTexture","done",[1.6]],["General: poster frames","done",[1.5,1.2]],["Explore: seek latency","done",[1.78]],["Review: leak check","failed",[1.33]]]},{key:"flaky",title:"Fix flaky upload test",color:"#fb923c",busy:!1,agent:"build",unread:0,asking:!1,shots:[2.2,1.6],kids:[["Explore: find the race","done",[1.6]]]}];function Co(t,e){const o=`ses_demo${t}`;for(let a=0;a<1e3;a++){const n=`${o}${a.toString(36)}`.padEnd(30,"0").slice(0,30);if(Ee(n)===e)return n}return o.padEnd(30,"0").slice(0,30)}function Xe(t){return()=>{t|=0,t=t+1831565813|0;let e=Math.imul(t^t>>>15,1|t);return e=e+Math.imul(e^e>>>7,61|e)^e,((e^e>>>14)>>>0)/4294967296}}function To(t){const e=parseInt(t.slice(1),16),o=(e>>16&255)/255,a=(e>>8&255)/255,n=(e&255)/255,r=Math.max(o,a,n),s=Math.min(o,a,n);if(r===s)return 0;const i=r-s;return(r===o?(a-n)/i+(a<n?6:0):r===a?(n-o)/i+2:(o-a)/i+4)*60}async function $o(t,e,o){const n=Math.round(o>=1?Math.min(1280,640*Math.min(o,2)):640*o),r=Math.round(n/o),s=new OffscreenCanvas(n,r),i=s.getContext("2d"),l=e+(t()-.5)*70,h=l+20+t()*50,d=18+t()*22,c=i.createLinearGradient(0,0,n*t(),r);if(c.addColorStop(0,`hsl(${l} ${d}% ${16+t()*10}%)`),c.addColorStop(1,`hsl(${h} ${d+6}% ${26+t()*14}%)`),i.fillStyle=c,i.fillRect(0,0,n,r),t()<.45){const v=n*(.25+t()*.5),f=r*(.3+t()*.4),w=Math.min(n,r)*(.25+t()*.2),u=i.createRadialGradient(v,f,0,v,f,w);u.addColorStop(0,`hsl(${h+30} ${d+14}% ${50+t()*14}% / 0.75)`),u.addColorStop(1,`hsl(${h+30} ${d}% 40% / 0)`),i.fillStyle=u,i.fillRect(0,0,n,r)}else{const v=Math.min(n,r)/20;i.fillStyle="rgba(255,255,255,0.07)",i.fillRect(0,0,n,v*2),i.fillStyle="rgba(255,255,255,0.14)";const f=n*.08;let w=r*(.22+t()*.1);for(let u=0;u<4&&w<r*.85;u++)i.fillRect(f,w,n*(.25+t()*.5)*(u?.8:1),v*(u?.7:1.3)),w+=v*(u?1.6:2.6),i.fillStyle="rgba(255,255,255,0.08)";t()<.6&&(i.fillStyle=`hsl(${h+40} ${d+20}% 58% / 0.55)`,i.beginPath(),i.roundRect(f,Math.min(r-v*3,w+v),n*.16,v*1.6,v*.4),i.fill())}const b=await s.convertToBlob({type:"image/png"});return URL.createObjectURL(b)}async function Fo(t="playground"){const e=[],o=[],a=[],n=[];let r=1e6;const s=(l,h,d,c)=>{const b=Xe(c),v=To(h);d.forEach((f,w)=>{const u=typeof f=="number"?f:f.a,C=typeof f=="number"?Math.round(1e3*u):f.w??Math.round(1e3*u),T={id:`${l}-i${w}`,canvasId:t,sessionId:l,kind:"image",name:`shot-${w+1}.png`,src:"",thumb:"",width:C,height:Math.round(C/u),createdAt:r--};o.push(T),n.push($o(b,v,u).then($=>{T.src=$,T.thumb=$}))})},i=Xe(7);return Lo.forEach((l,h)=>{const d=Co(l.key,l.color);e.push({id:d,canvasId:t,title:l.title,createdAt:1e3+h}),s(d,l.color,l.shots,100+h);const c=l.kids.map(([b,v,f],w)=>{const u=`${d.slice(0,22)}k${String(w).padStart(2,"0")}`.padEnd(30,"0");e.push({id:u,canvasId:t,title:b,createdAt:2e3+h*40+w}),s(u,Ee(u),f,1e3+h*50+w);const[C,...T]=b.split(": "),$=v==="running"||v==="waiting"?20+i()*150:200+i()*900,M=v==="running"||v==="waiting"?$:40+i()*160;return{id:u,title:b,agent:C,task:T.join(": ")||b,state:v,startedAgo:$,ran:M}});a.push({parentId:d,title:l.title,color:Ee(d),busy:l.busy,agent:l.agent,unread:l.unread,asking:l.asking,kids:c,count:l.count??c.length})}),await Promise.all(n),{sessions:e,items:o,families:a}}class Oo extends Bt{plan=Dt("plan",null);naturalLayout=rt("naturalLayout",()=>It(this.sessions.get(),this.items.get(),this.sessionOrder.get(),this.itemLimits.get()));layout=rt("layout",()=>this.plan.get()?.layout??this.naturalLayout.get())}const zo=typeof matchMedia=="function"&&matchMedia("(prefers-reduced-motion: reduce)").matches,me=[x("title","Title size",14,12,20,1,"px"),x("max","Before +N",8,2,20,1),ct("reduced","Reduced motion",zo),ct("busy","Busy band",!0)],ge=[x("scale","Scale",.75,.4,1,.01,"×"),x("dur","Duration",440,0,1e3,10,"ms"),Mt("ease","Easing",["standard","decelerate","in-out"],"standard"),x("stagger","Stagger",40,0,120,5,"ms")],At=["0","1","3","8","15","20"],ut=72;function Io(t){const{natural:e,zoom:o,m:a}=t,n=_t,r=n.frameHeaderHeight,s={sections:[],groups:[],items:new Map,sectionOf:e.sectionOf,groupOf:e.groupOf,bounds:null},i=[],l=new Map(e.sections.map(c=>[c.id,c])),h=(a.head+a.headGap)/o;let d=0;for(const c of e.sections){if(t.childIds.has(c.id))continue;const b=(t.families.get(c.id)??[]).filter(M=>M.open>5e-4&&l.has(M.id)),v=M=>X(M.open/.5),f={x:d,y:0,w:c.box.w,h:c.box.h-r},w=mt(e,c,f.x,0,1,s.items),u={x:f.x,y:f.y-h,w:f.w,h:a.head/o},C=[];i.push({id:c.id,parentId:null,box:u,frame:f,opacity:1});let T=f.x+f.w,$=f.y+f.h;for(const M of b){const p=l.get(M.id),F=p.box.h-r,E=t.childScale,m=$+ut+h;$+=(ut+h+F*E)*v(M),T=Math.max(T,f.x+f.w+(Math.max(f.w,p.box.w*E)-f.w)*v(M));const y=X((M.open-.5)/.5),g=mt(e,p,f.x,m+(1-y)*(12/o),E*(.98+.02*y),s.items);g.opacity=y,g.header={x:g.box.x,y:g.box.y-h,w:g.box.w,h:a.head/o},i.push({id:p.id,parentId:c.id,box:g.header,frame:g.box,opacity:y}),C.push(g)}w.box=f,w.header=u,s.sections.push(...C,w),d=T+n.frameGap}return s.groups=s.sections.flatMap(c=>c.groups),s.bounds=Ve.union(s.sections.flatMap(c=>[c.box,c.header])),{layout:s,heads:i,zoom:o}}function mt(t,e,o,a,n,r){const s=_t.frameHeaderHeight,i=h=>({x:o+(h.x-e.box.x)*n,y:a+(h.y-e.box.y-s)*n,w:h.w*n,h:h.h*n});for(const h of e.itemIds){const d=t.items.get(h);d&&r.set(h,i(d))}const l=e.groups.map(h=>({...h,box:i(h.box),heading:h.heading&&i(h.heading)}));return{...e,box:{x:o,y:a,w:e.box.w*n,h:(e.box.h-s)*n},header:{x:o,y:a,w:e.box.w*n,h:0},groups:l,more:e.more&&{...e.more,box:i(e.more.box)}}}const Bo=.45,he={fill:.2,hold:.15,fade:.7},Do=2.4;class qo{constructor(e,o){this.families=e;for(const a of e)a.kids.forEach((n,r)=>{const s=n.state==="running"||n.state==="waiting",i=o-n.startedAgo,l=1+(r*7919+a.parentId.length*104729+n.id.charCodeAt(23)*31)%997;this.kids.set(n.id,{demo:n,parentId:a.parentId,index:r+1,seed:l,own:Rt(Ee(n.id)),state:n.state,prev:n.state,since:o-60,started:i,finished:s?null:i+n.ran})});this.next=o+2.5}families;kids=new Map;live=!1;next=0;r=Xe(42);familyKids(e){return e.kids.slice(0,e.count).map(o=>this.kids.get(o.id))}set(e,o,a){const n=this.kids.get(e);if(!n||n.state===o)return;const r=s=>s==="running"||s==="waiting";r(o)&&!r(n.state)?(n.started=a,n.finished=null):!r(o)&&r(n.state)&&(n.finished=a),n.prev=n.state,n.state=o,n.since=a}tick(e){if(!this.live||e<this.next)return;this.next=e+2.2+this.r()*1.6;const o=this.families.flatMap(l=>this.familyKids(l)),a=l=>{const h=o.filter(d=>d.state===l&&e-d.since>2);return h.length?h[Math.floor(this.r()*h.length)]:void 0},n=this.r(),r=a("running"),s=a("waiting");if(s&&n<.2)return this.set(s.demo.id,"running",e);if(r&&n<.62)return this.set(r.demo.id,this.r()<.18?"failed":this.r()<.12?"waiting":"done",e);const i=a("done")??a("failed");i&&this.set(i.demo.id,"running",e)}look(e,o,a,n,r,s){const i=Ie(X((o-e.since)/Bo));r.run=r.done=r.fail=r.wait=0;const l=(d,c)=>{d==="running"?r.run+=c:d==="done"?r.done+=c:d==="failed"?r.fail+=c:r.wait+=c};l(e.state,i),l(e.prev,1-i);const h=o-e.since;return r.flash=!s&&e.state==="done"&&e.prev==="running"?h<he.fill?Ie(h/he.fill):1-Ie(X((h-he.fill-he.hold)/he.fade)):0,r.open=a,r.hover=n,r.breath=s?.6:.5-.5*Math.cos(h/Do*2*Math.PI),r}view(e,o,a){return{id:e.demo.id,title:e.demo.title,agent:e.demo.agent,task:e.demo.task,index:e.index,own:e.own,seed:e.seed,state:e.state,look:a,elapsed:No((e.finished??o)-e.started)}}}function No(t){const e=Math.max(0,Math.floor(t));if(e<60)return`${e}s`;const o=Math.floor(e/60);return o<60?`${o}m ${String(e%60).padStart(2,"0")}s`:`${Math.floor(o/60)}h ${String(o%60).padStart(2,"0")}m`}const L=so({site:"subagents",title:"Subagents",storageKey:"canvas-playground-subagents-v4",defaults:()=>({tech:W[0].id,params:Object.fromEntries(W.map(t=>[t.id,ie(t.params)])),row:ie(me),expand:ie(ge),live:!0,count:8}),restore(t,e){typeof t.v=="string"&&W.some(o=>o.id===t.v)&&(e.tech=t.v),lo(W,t.p,e.params),t.r&&(e.row=He(me,{...e.row,...t.r})),t.x&&(e.expand=He(ge,{...e.expand,...t.x})),typeof t.live=="boolean"&&(e.live=t.live),typeof t.n=="number"&&At.includes(String(t.n))&&(e.count=t.n)},share:t=>({v:t.tech,p:co(W,t.params),r:Ge(me,t.row),x:Ge(ge,t.expand),live:t.live,n:t.count}),exportJson:t=>({site:"subagents",technique:{id:t.tech,name:Et(t.tech).name,params:t.params[t.tech]},row:t.row,expand:t.expand})}),{settings:R,demo:St}=L;St.setAttribute("aria-label","The canvas: scroll to pan, pinch or ctrl-scroll to zoom; click a subagent’s orb to expand its frame");const Y=k("div","canvas-container sa-canvas"),se=k("canvas","canvas"),re=k("div","overlay"),pe=k("div","sa-loading","Drawing the demo canvas…"),Re=k("div","sa-toast");Y.append(se,re,pe,Re);St.prepend(Y);const _=new Oo;_.mount(Y);_.setCurrentTool("select");window.editor=_;let z=null,S=null,ve=null,q=null,H=null;const xe=()=>Et(R.tech),Ae=()=>R.params[R.tech],Se=()=>R.row,Pe=()=>R.expand,Pt=()=>!!Se().reduced,J=new Map,gt={standard:Me(.4,0,.2,1),decelerate:Me(0,0,.2,1),"in-out":Me(.65,0,.35,1)};function Ye(t,e){const o=J.get(t);if(!o)return 0;const a=Number(Pe().dur),n=a<=0?1:X((e-o.start)/a);return n>=1&&o.to===0&&J.delete(t),o.from+(o.to-o.from)*(gt[String(Pe().ease)]??gt.standard)(n)}const Le=t=>(J.get(t)?.to??0)>.5;function Je(t,e,o,a=0){Le(t)===e&&J.has(t)===e||(J.set(t,{from:Ye(t,o),to:e?1:0,start:o+a}),I=!0)}function qe(t){return z?.families.find(e=>e.parentId===t||e.kids.some(o=>o.id===t))}function Ce(t){return t.kids.slice(0,t.count)}function Go(t){Je(t,!Le(t),performance.now())}function Lt(t,e){const o=performance.now(),a=Ce(t),n=e?a:[...a].reverse(),r=n.length>1?Math.min(Number(Pe().stagger),260/(n.length-1)):0;let s=0;for(const i of n)Le(i.id)!==e&&Je(i.id,e,o,r*s++)}function be(t){for(const e of z?.families??[])Lt(e,t)}let I=!0,vt="";function Ho(){return{head:ue,headGap:8}}function we(t){if(!z||!S)return;S.live=R.live,S.tick(t/1e3);const e=_.camera.peek().z,o=new Map,a=new Set(z.families.flatMap(s=>s.kids.map(i=>i.id)));let n=!1;for(const s of z.families)o.set(s.parentId,Ce(s).map(i=>{const l=Ye(i.id,t);return J.has(i.id)&&l!==J.get(i.id).to&&(n=!0),{id:i.id,open:l}}));const r=`${e}|${[...o.values()].map(s=>s.map(i=>i.open>0?i.open.toFixed(4):"").join(",")).join(";")}`;!I&&!n&&r===vt&&H||(I=!1,vt=r,H=Io({natural:_.naturalLayout.get(),families:o,childIds:a,zoom:e,childScale:Number(Pe().scale),m:Ho()}),_.plan.set(H))}_.onFrame(t=>we(t));const xt=new Map,bt=new Map,wt=new Map;function Uo(t){let e=xt.get(t);return e||xt.set(t,e={run:0,done:0,fail:0,wait:0,flash:0,open:0,hover:0,breath:0}),e}function jo(t,e){const o=new Map;if(!z||!S||!q)return o;const a=t/1e3,n=Number(Ae().speed??1),r=Ae().color==="own",s=Pt();for(const i of z.families){const l=S.familyKids(i);if(!l.length)continue;const h=Rt(i.color),d=l.map(c=>{const b=S.look(c,a,Ye(c.demo.id,t),q.hover(c.demo.id,t),Uo(c.demo.id),s),v=(bt.get(c.demo.id)??c.seed*.37)+e/1e3*n*(b.run+.35*b.wait);return bt.set(c.demo.id,v),{view:S.view(c,a,b),rgb:r?c.own:h,time:v}});o.set(i.parentId,{parentId:i.parentId,kids:d,rgb:h,...Xo(i.parentId,d.map(c=>c.view),t,e,n,s)})}return o}function Xo(t,e,o,a,n,r){let s=wt.get(t);s||(s={look:{run:0,done:1,fail:0,wait:0,flash:0,open:0,hover:0,breath:0},time:t.length,phase:t.charCodeAt(9)%17/17},wt.set(t,s));const i=c=>e.some(b=>b.state===c),l=i("running")?"run":i("waiting")?"wait":i("failed")?"fail":"done",h=1-Math.exp(-a/150),d=s.look;for(const c of["run","done","fail","wait"]){const b=c===l?1:0;d[c]+=(b-d[c])*h,Math.abs(b-d[c])<.002&&(d[c]=b)}return d.flash=Math.max(0,...e.map(c=>c.look.flash)),d.hover=q?.hover(`agg:${t}`,o)??0,d.breath=r?.6:.5-.5*Math.cos(o/1e3/2.4*2*Math.PI),s.time+=a/1e3*n*(d.run+.35*d.wait),{agg:d,aggTime:s.time,aggPhase:s.phase}}function Ko(){const t=new Map;if(!z||!S)return t;for(const e of z.families){t.set(e.parentId,{id:e.parentId,title:e.title,child:!1});for(const o of e.kids)t.set(o.id,{id:o.id,title:o.title,agent:o.agent,task:o.task,child:!0})}return t}let yt="",Ne=0,Ke=null,G=!0;function Vo(t){if(!q||!H)return;const e=Ne?Math.min(100,Math.max(0,t-Ne)):16;Ne=t;const o=_.camera.peek(),{w:a,h:n}=_.viewport.peek(),r=se.width/Math.max(1,a);q.orbs.resize(se.width,se.height,a,n);const s=jo(t,e),i=`${o.x},${o.y},${o.z},${a},${n},${se.width}`;!G&&i===yt&&Ke===H&&!q.animating&&!q.alive&&!Wo(s)||(G=!1,yt=i,Ke=H,q.draw(H,Ko(),s,{tech:xe(),p:Ae(),max:Number(Se().max),titlePx:Number(Se().title),reduced:Pt()},t,r),L.setZoom(o.z))}function Wo(t){for(const e of t.values())for(const o of[...e.kids.map(a=>a.view.look),e.agg])if(!ne(o.run)||!ne(o.done)||!ne(o.fail)||!ne(o.wait)||o.flash>0||!ne(o.open)||!ne(o.hover))return!0;return!1}const ne=t=>t<.001||t>.999;async function Yo(){const t=await Fo();z=t,t.families[0].count=R.count,S=new qo(t.families,performance.now()/1e3),_.loadSnapshot(t.sessions,t.items),I=!0,_.whenViewportReady(()=>requestAnimationFrame(()=>Te(!1)));try{ve=await Nt.create(se,re,_,{readOnly:!0,easeLayout:!1,busySessions:()=>Jo()}),window.renderer=ve}catch(o){console.error(o),pe.textContent=`Can't start the renderer: ${lt(o)}`;return}pe.remove();let e;try{e=new ao(re)}catch(o){pe.textContent=`Can't start WebGL2 for the orbs: ${lt(o)}`,Y.append(pe);return}q=new So(re,_,e,{toggleKid:Go,showAll:()=>G=!0,zoomTo:o=>Ze(()=>{const a=_.layout.get().sections.find(n=>n.id===o);return a?Ve.union([a.box,a.header]):null},64,!0)}),Vt.then(()=>{q?.text.reset(),G=!0}),_.onFrame(o=>Vo(o))}const fe=new Set;function Jo(){if(fe.clear(),!z||!S||!Se().busy)return fe;for(const t of z.families){t.busy&&fe.add(t.parentId);for(const e of S.familyKids(t))e.state==="running"&&fe.add(e.demo.id)}return fe}let kt=0;function Zo(t){Re.textContent=t,Re.classList.add("on"),clearTimeout(kt),kt=window.setTimeout(()=>Re.classList.remove("on"),2400)}function Te(t=!0){Ze(()=>_.layout.get().bounds,48,t)}function Ze(t,e,o){const a=_.camera.peek();let n=a;for(let r=0;r<5;r++){const s=t();if(!s)return;n=_.getCameraForBounds(s,{padding:e}),_.setCamera(n),I=!0,we(performance.now())}o&&(_.setCamera(a),I=!0,we(performance.now()),_.setCamera(n,{animate:!0,duration:480}))}qt(()=>{Y.style.cursor=_.cursor.get()});const Ct=()=>L.setCaption(xe().name,xe().note),Qo=io(L,W,R.tech,t=>{R.tech=t,Tt.render(),Ct(),G=!0,L.save()}),Tt=ro(L,"Technique",()=>xe().params,()=>Ae(),()=>{G=!0,L.save()},()=>R.params[R.tech]=ie(xe().params)),ea=L.section("Title row",K("Reset",()=>{R.row=ie(me),$e(),I=G=!0,L.save()},"ghost",!0));function $e(){ea.replaceChildren(...me.map(t=>We(t,R.row,()=>{I=G=!0,L.save()})),k("p","pg-note","Every technique: failed is red and still, waiting breathes. Hover an orb for its subagent; click it to expand its frame. Zoomed out, the orbs fold into +N, then flow into one."))}$e();const ta=L.section("Expanding",K("Reset",()=>{R.expand=ie(ge),Qe(),I=!0,L.save()},"ghost",!0));function Qe(){ta.replaceChildren(...ge.map(t=>We(t,R.expand,()=>{I=!0,L.save()})),k("div","pg-buttons",K("Expand all",()=>be(!0),"",!0),K("Collapse all",()=>be(!1),"",!0)))}Qe();L.section("Demo").append(Xt("Coordinator’s",At,String(R.count),t=>$t(Number(t))),Kt("Live states",R.live,t=>{R.live=t,L.save()}),k("div","pg-buttons",K("Fit",()=>Te(),"",!0),K("Next state",()=>oa(),"",!0)));function $t(t){R.count=t;const e=z?.families[0];if(e){e.count=t;for(const o of e.kids.slice(t))J.delete(o.id)}I=G=!0,L.save()}function oa(){if(!S)return;const t=S.live;S.live=!0,S.next=0,S.tick(performance.now()/1e3),S.live=t}const aa=[["Hover","an orb: its subagent and state"],["Click","an orb: expand or collapse its frame"],["1–8","technique"],["E","expand or collapse every subagent"],["Esc","collapse everything"],["M","reduced motion"],["⇧1","zoom to fit"]];L.section("Keys").append(k("div","sa-keys",...aa.flatMap(([t,e])=>[k("kbd","",t),k("span","",e)])));window.addEventListener("keydown",t=>{t.target.closest('input, textarea, [role="slider"]')||t.metaKey||t.ctrlKey||t.altKey||(t.key==="e"||t.key==="E"?be(!(z?.families??[]).every(e=>Ce(e).every(o=>Le(o.id)))):t.key==="Escape"?be(!1):(t.key==="m"||t.key==="M")&&(R.row.reduced=!R.row.reduced,$e(),G=!0,Zo(R.row.reduced?"Reduced motion: every orb holds its pose":"Motion on"),L.save()))});L.toolbar.append(K("Fit",()=>Te(),"",!0));Ct();Yo();Object.assign(window,{playground:{editor:_,settings:R,get sim(){return S},get demo(){return z},ready:()=>!!ve&&!!q&&!!H,select:t=>Qo.select(t),param(t,e){R.params[R.tech][t]=e,Tt.render(),G=!0},row(t,e){R.row[t]=e,$e(),I=G=!0},expandParam(t,e){R.expand[t]=e,Qe(),I=!0},live(t){R.live=t},state(t,e){S?.set(t,e,performance.now()/1e3)},open:(t,e=!0)=>Je(t,e,performance.now()),expandAll:(t,e=!0)=>{const o=qe(t);o&&Lt(o,e)},expandEverything:be,setCount:$t,kids:t=>qe(t)?.kids.slice(0,qe(t).count).map(e=>({id:e.id,title:e.title,state:S?.kids.get(e.id)?.state})),families:()=>z?.families.map(t=>({id:t.parentId,title:t.title,kids:Ce(t).length})),orbPoint(t){const e=q?.orbCentre(t);if(!e)return null;const o=Y.getBoundingClientRect();return{x:o.left+e.x,y:o.top+e.y}},look(t,e=48,o=0,a=0,n=0){Ze(()=>{const r=_.layout.get().sections.find(i=>i.id===t),s=r&&Ve.union([r.box,r.header]);return s?{x:s.x,y:s.y-n,w:s.w+o,h:s.h+a+n}:null},e,!1)},trace(){const t=_.camera.peek(),e=i=>(i+t.x)*t.z,o=i=>(i+t.y)*t.z,a=i=>[e(i.x),o(i.y),i.w*t.z,i.h*t.z].map(l=>Math.round(l*100)/100),n=Ke,r=Y.getBoundingClientRect(),s=i=>Math.round(i*100)/100;return{cam:t,frames:Object.fromEntries((n?.layout.sections??[]).map(i=>[i.id,a(i.box)])),drawn:Object.fromEntries((n?.layout.sections??[]).map(i=>[i.id,ve?.sectionBox(i.id)?a(ve.sectionBox(i.id)):null])),heads:Object.fromEntries((n?.heads??[]).map(i=>[i.id,a(i.box).slice(0,2)])),dom:Object.fromEntries([...re.querySelectorAll(".sa-head")].filter(i=>i.style.display!=="none").map(i=>{const l=i.getBoundingClientRect();return[i.dataset.session,[s(l.left-r.left),s(l.top-r.top)]]})),orbs:Object.fromEntries((q?.drawn??[]).filter(i=>i.alpha>.5).map(i=>[i.id,[s(i.x),s(i.y)]])),orbDom:Object.fromEntries([...re.querySelectorAll(".sa-orb")].filter(i=>i.style.display!=="none"&&i.style.cssText).map(i=>{const l=i.getBoundingClientRect();return[i.dataset.id,[s(l.left-r.left+l.width/2),s(l.top-r.top+l.height/2)]]}))}},region(t,e=0,o=16,a=0){const n=_.camera.peek(),r=H?.heads.find(l=>l.id===t);if(!r)return null;const s=Y.getBoundingClientRect(),i=(r.box.y+n.y)*n.z;return{x:Math.round(s.left+(r.frame.x+n.x)*n.z-o),y:Math.round(s.top+i-o),width:Math.round((a||r.frame.w*n.z)+o*2),height:Math.round(ue+8+Math.min(r.frame.h*n.z,e)+o*2)}},place(t,e,o=40,a=70){_.setCamera({..._.camera.peek(),z:e}),I=!0,we(performance.now());const n=H?.heads.find(r=>r.id===t);n&&(_.setCamera({x:o/e-n.box.x,y:a/e-n.box.y,z:e}),I=!0,we(performance.now()))},camera:()=>_.camera.peek(),setCamera:(t,e,o)=>_.setCamera({x:t,y:e,z:o}),fit:()=>Te(!1),plan:()=>H,error:()=>q?.orbs.error??null}});
