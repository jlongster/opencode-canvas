import"./layout-D5L6uoqV.js";import{F as rt,c as Ye,r as ye,B as ve,S as ge,a as f,s as le,g as st,b as nt,d as F,t as we,e as it,f as fe,D as ie,h as be,p as lt,i as ft}from"./params-scS7024I.js";import{l as ct,b as Z,p as Re,S as Me,e as ce,s as dt,a as me,c as ht,f as ut,d as mt,g as pt}from"./shell-7tC7-Ydv.js";const J={speed:.75,pitch:5,dot:2,shape:"square",mode:"brightness",levels:0,base:0,rim:.18,modulate:0,scale:9,drift:5,depth:11,falloff:.7,intensity:1,peak:.9,color:"session",crawl:5.5,sparse:.525,dim:.3},vt=4,ee=12;class bt{data=new Float32Array(ee*1024);n=0;framesInView=0;push(e,a,o,n,s,i,l,d,r,p,v){if((this.n+1)*ee>this.data.length){const x=new Float32Array(this.data.length*2);x.set(this.data),this.data=x}const c=this.n++*ee,u=this.data;u[c]=e,u[c+1]=a,u[c+2]=o,u[c+3]=n,u[c+4]=s,u[c+5]=i,u[c+6]=l,u[c+7]=d,u[c+8]=r,u[c+9]=p,u[c+10]=v,u[c+11]=0}stamp=new Uint32Array(0);best=new Float32Array(0);band=new Float32Array(0);rgb=new Float32Array(0);touched=new Int32Array(0);gen=0;grid(e){if(this.stamp.length>=e)return;const a=Math.max(e,this.stamp.length*2);this.stamp=new Uint32Array(a),this.best=new Float32Array(a),this.band=new Float32Array(a),this.rgb=new Float32Array(a*3),this.touched=new Int32Array(a),this.gen=0}fill(e,a,o,n){this.n=0,this.framesInView=0;const{dpr:s,z:i}=e,l=Math.max(2,Math.round(o.pitch*s)),d=Math.round(e.x*s),r=Math.round(e.y*s),p=Math.floor(-d/l),v=Math.floor(-r/l),c=Math.floor((e.width*s-d)/l)-p+1,u=Math.floor((e.height*s-r)/l)-v+1;if(c<=0||u<=0)return;this.grid(c*u),++this.gen===4294967295&&(this.stamp.fill(0),this.gen=1);const x=this.gen;let E=0;const R=o.depth,L=R+1+o.pitch,M=o.color==="mesh";for(const h of a){if(h.presence<=.001)continue;const _=h.box.w/2,y=h.box.h/2,G=h.box.x+_,H=h.box.y+y,j=(h.box.x*i+e.x-L)*s,N=(h.box.y*i+e.y-L)*s,oe=((h.box.x+h.box.w)*i+e.x+L)*s,tt=((h.box.y+h.box.h)*i+e.y+L)*s,Pe=Math.max(p,Math.floor((j-d)/l)),pe=Math.min(p+c-1,Math.floor((oe-d)/l)),Be=Math.max(v,Math.floor((N-r)/l)),Se=Math.min(v+u-1,Math.floor((tt-r)/l));if(Pe>pe||Be>Se)continue;this.framesInView++;const k=Math.min(rt,_,y),g=_-k,w=y-k,O=.5*Math.PI*k,ze=4*(g+w)+2*Math.PI*k,qe=ze*i,Ie=n+h.offset,De=h.seed,at=Math.floor(((h.box.x*i+e.x+o.pitch)*s-d)/l),Ue=Math.ceil((((h.box.x+h.box.w)*i+e.x-o.pitch)*s-d)/l),[Le,Ce,Ne]=h.color;for(let re=Be;re<=Se;re++){const I=((r+re*l+.5*l)/s-e.y)/i-H,ot=Math.abs(I)<w;for(let T=Pe;T<=pe&&!(ot&&T>at&&T<Ue&&(T=Ue,T>pe));T++){const P=((d+T*l+.5*l)/s-e.x)/i-G,Oe=Math.abs(P)-g,Ve=Math.abs(I)-w,K=(Math.hypot(Math.max(Oe,0),Math.max(Ve,0))+Math.min(Math.max(Oe,Ve),0)-k)*i-1;if(K<0||K>R)continue;const se=P-Math.max(-g,Math.min(g,P)),ne=I-Math.max(-w,Math.min(w,I));let B;if(se===0)B=I<0?P>=0?P:ze+P:g+2*O+2*w+(g-P);else if(ne===0)B=P>0?g+O+(I+w):3*g+2*w+3*O+(w-I);else{const D=Math.atan2(ne,se);se>0&&ne<0?B=g+k*(D+.5*Math.PI):se>0?B=g+O+2*w+k*D:ne>0?B=3*g+2*w+2*O+k*(D-.5*Math.PI):B=3*g+4*w+3*O+k*(D+Math.PI)}const Q=Math.pow(Y(1-K/R),o.falloff);let V=Y(xt(B*i,qe,K,Ie,De,Q,o)*o.intensity);K<=o.pitch&&(V=Math.max(V,o.rim*Q)),V=Math.max(V*(1-h.fill),h.fill*Q*Q*Q)*h.presence;const A=(re-v)*c+(T-p);if(this.stamp[A]!==x&&(this.stamp[A]=x,this.best[A]=-1,this.band[A]=0,this.touched[E++]=A),this.band[A]=Math.max(this.band[A],h.presence),V>this.best[A]){this.best[A]=V;let D=Le,$e=Ce,We=Ne;M&&([D,$e,We]=_t(B*i,qe,Ie,De,Le,Ce,Ne)),this.rgb[A*3]=D,this.rgb[A*3+1]=$e,this.rgb[A*3+2]=We}}}}const X=o.dot*s,C=o.shape==="round"?1:0,ae=o.mode;for(let h=0;h<E;h++){const _=this.touched[h],y=Math.max(0,this.best[_]),G=p+_%c,H=v+Math.floor(_/c);let j=1;o.modulate>0&&(j=z(1,de(.25,.75,He(G*.09,H*.09,n*.15)),o.modulate));let N;ae==="brightness"?N=o.levels>.5?Math.floor(y*o.levels+.5)/o.levels:y:ae==="halftone"?(N=y>.004?1:0,j*=Math.sqrt(y)):N=y>wt(G,H)?1:0;const oe=N*o.peak;oe<=.002&&o.base<=.002||this.push(d+G*l,r+H*l,l,C,X*j,X,oe,o.base,this.rgb[_*3],this.rgb[_*3+1],this.rgb[_*3+2])}}}function xt(t,e,a,o,n,s,i){const l=(a-o*i.drift)/i.scale,d=Ae(t,e,o,n,i.scale,i.crawl,l,o*.11),r=Ae(t,e,o,n,i.scale*1.15,-i.crawl,l*1.1+9,o*.13),p=Math.max(d,r),v=de(i.sparse+.06,i.sparse+.12,p),c=de(i.sparse-.02,i.sparse+.03,p)*i.dim,u=de(0,.25,s);return Math.max(v,c)*(.35+.65*s)*u}function Ae(t,e,a,o,n,s,i,l){const d=e/(2*Math.PI*n),r=(t-a*s)/e*2*Math.PI;return He(Math.cos(r)*d+o*11.7,Math.sin(r)*d+o*5.3,i+l+o*2.9)}function _t(t,e,a,o,n,s,i){const l=Ae(t,e,a,o,140,-6,a*.05,0)-.5;return yt(n,s,i,l*1.4)}function yt(t,e,a,o){const n=.299*t+.587*e+.114*a,s=.596*t-.274*e-.322*a,i=.211*t-.523*e+.312*a,l=Math.atan2(i,s)+o,d=Math.hypot(s,i),r=d*Math.cos(l),p=d*Math.sin(l);return[Y(n+.956*r+.621*p),Y(n-.272*r-.647*p),Y(n-1.106*r+1.703*p)]}const gt=[0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5];function wt(t,e){return(gt[(t%4+4)%4+(e%4+4)%4*4]+.5)/16}function S(t,e,a){let o=Math.imul(t|0,374761393)+Math.imul(e|0,668265263)+Math.imul(a|0,1274126177);return o=Math.imul(o^o>>>13,1274126177),((o^o>>>16)>>>0)/4294967296}function He(t,e,a){const o=Math.floor(t),n=Math.floor(e),s=Math.floor(a);let i=t-o,l=e-n,d=a-s;i=i*i*(3-2*i),l=l*l*(3-2*l),d=d*d*(3-2*d);const r=z(S(o,n,s),S(o+1,n,s),i),p=z(S(o,n+1,s),S(o+1,n+1,s),i),v=z(S(o,n,s+1),S(o+1,n,s+1),i),c=z(S(o,n+1,s+1),S(o+1,n+1,s+1),i);return z(z(r,p,l),z(v,c,l),d)}function z(t,e,a){return t+(e-t)*a}function de(t,e,a){const o=Y((a-t)/(e-t));return o*o*(3-2*o)}function Y(t){return t<0?0:t>1?1:t}function At(t,e,a,o){typeof t.v=="string"&&a.some(s=>s.id===t.v)&&(e.variant=t.v);const n=t.p??{};for(const s of a)n[s.id]&&(e.params[s.id]=ye(s.params,{...e.params[s.id],...n[s.id]}));t.o&&(e.options=ye(o,{...e.options,...t.o}))}function Ft(t,e,a){const o={};for(const n of e){const s=Ye(n.params,t.params[n.id]);Object.keys(s).length&&(o[n.id]=s)}return{v:t.variant,p:o,o:Ye(a,t.options)}}function Et(t,e,a,o){const n=ct(e.map((s,i)=>({id:s.id,name:s.name,key:String(i+1),title:s.note})),a(),o,"Variation");return t.section("Variation").append(n.el),window.addEventListener("keydown",s=>{if(s.target.closest('input, textarea, [role="slider"]')||s.metaKey||s.ctrlKey||s.altKey)return;const i=Number(s.key)-1;Number.isInteger(i)&&i>=0&&i<e.length&&n.select(e[i].id)}),n}function Rt(t,e,a,o,n,s){const i=Z("Reset",()=>{s(),d(),n()},"ghost",!0),l=t.section(e,i),d=()=>l.replaceChildren(...a().map(r=>Re(r,o(),n,Me)));return d(),{render:d}}function Mt(t,e,a,o,n){t.section(e).append(...a.map(s=>Re(s,o,n,Me)))}function kt(t,e,a){return t.map((o,n)=>ce("div","pg-frame",dt(o.color,Me,s=>{o.color=s,a(n)},`Colour of ${o.title}`),ce("span","t",o.title),ce("span","controls",...e(o,n))))}const Tt=`#version 300 es
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
}`,Pt=`#version 300 es
precision mediump float;
in vec4 v_col;
out vec4 o;
void main() { o = v_col; }`;class Bt{constructor(e){this.gl=e,this.program=me(e,Tt,Pt),this.uSize=e.getUniformLocation(this.program,"u_size");const a=e.createBuffer();e.bindBuffer(e.ARRAY_BUFFER,a),e.bufferData(e.ARRAY_BUFFER,new Float32Array([0,0,1,0,0,1,0,1,1,0,1,1]),e.STATIC_DRAW),this.vao=e.createVertexArray(),e.bindVertexArray(this.vao),e.enableVertexAttribArray(0),e.vertexAttribPointer(0,2,e.FLOAT,!1,0,0),this.buf=e.createBuffer(),e.bindBuffer(e.ARRAY_BUFFER,this.buf),e.enableVertexAttribArray(1),e.vertexAttribPointer(1,4,e.FLOAT,!1,ve*4,0),e.vertexAttribDivisor(1,1),e.enableVertexAttribArray(2),e.vertexAttribPointer(2,4,e.FLOAT,!1,ve*4,16),e.vertexAttribDivisor(2,1),e.bindVertexArray(null)}gl;program;uSize;vao;buf;draw(e){const{gl:a}=this;e.n&&(a.bindFramebuffer(a.FRAMEBUFFER,null),a.viewport(0,0,a.drawingBufferWidth,a.drawingBufferHeight),a.enable(a.BLEND),a.blendFunc(a.ONE,a.ONE_MINUS_SRC_ALPHA),a.useProgram(this.program),a.uniform2f(this.uSize,a.drawingBufferWidth,a.drawingBufferHeight),a.bindVertexArray(this.vao),a.bindBuffer(a.ARRAY_BUFFER,this.buf),a.bufferData(a.ARRAY_BUFFER,e.data.subarray(0,e.n*ve),a.DYNAMIC_DRAW),a.drawArraysInstanced(a.TRIANGLES,0,6,e.n),a.bindVertexArray(null))}}const St=`#version 300 es
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
}`,zt=`#version 300 es
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
}`;class qt{constructor(e){this.gl=e,this.program=me(e,St,zt),this.uSize=e.getUniformLocation(this.program,"u_size");const a=e.createBuffer();e.bindBuffer(e.ARRAY_BUFFER,a),e.bufferData(e.ARRAY_BUFFER,new Float32Array([0,0,1,0,0,1,0,1,1,0,1,1]),e.STATIC_DRAW),this.vao=e.createVertexArray(),e.bindVertexArray(this.vao),e.enableVertexAttribArray(0),e.vertexAttribPointer(0,2,e.FLOAT,!1,0,0),this.buf=e.createBuffer(),e.bindBuffer(e.ARRAY_BUFFER,this.buf);for(let o=0;o<3;o++)e.enableVertexAttribArray(1+o),e.vertexAttribPointer(1+o,4,e.FLOAT,!1,ee*4,o*16),e.vertexAttribDivisor(1+o,1);e.bindVertexArray(null)}gl;program;uSize;vao;buf;draw(e){const{gl:a}=this;e.n&&(a.enable(a.BLEND),a.blendFunc(a.ONE,a.ONE_MINUS_SRC_ALPHA),a.useProgram(this.program),a.uniform2f(this.uSize,a.drawingBufferWidth,a.drawingBufferHeight),a.bindVertexArray(this.vao),a.bindBuffer(a.ARRAY_BUFFER,this.buf),a.bufferData(a.ARRAY_BUFFER,e.data.subarray(0,e.n*ee),a.DYNAMIC_DRAW),a.drawArraysInstanced(a.TRIANGLES,0,6,e.n),a.bindVertexArray(null))}}function $(t,e=[]){return[t.speed===void 0?ge:{...ge,value:t.speed},f("pitch","Grid pitch",t.pitch??4,2,12,1,"px"),f("dot","Dot size",t.dot??3,1,10,.5,"px"),le("shape","Dot shape",["round","square"],t.shape??"square"),le("mode","Mask",["brightness","halftone","dither"],t.mode??"brightness"),f("levels","Brightness steps",t.levels??0,0,8,1),f("base","Unlit dots",t.base??0,0,.3,.005),f("rim","Edge row",t.rim??.18,0,1,.01),f("modulate","Mask modulation",t.modulate??0,0,1,.01),f("scale","Noise size",t.scale??18,3,120,.5,"px"),f("warp","Warp",t.warp??1,0,3,.01),f("drift","Outward drift",t.drift??8,0,80,.5,"px/s"),f("depth","Band depth",t.depth??34,8,120,1,"px"),f("falloff","Falloff",t.falloff??.8,.2,4,.05),f("intensity","Intensity",t.intensity??1,0,3,.01),f("peak","Peak opacity",t.peak??.9,0,1,.01),le("color","Colour",["session","mesh"],t.color??"session"),...e]}const xe=`
vec3 meshTint(Fx f, vec3 col) {
  if (P_color < 0.5) return col;
  float h = vnoise(around(f, 140.0, -6.0, f.t * 0.05)) - 0.5;
  return hueRotate(col, h * 1.4);
}`,It=[{id:"embers",name:"Ember clumps",note:"What busy frames showed in the app before Brian’s Brain (ember.ts, with these defaults). Tuned to look like Brian’s Brain, but continuous: two layers of fine noise crawl in opposite directions round the frame while drifting outward, and only their peaks light up, giving sparse bright clumps that thin out away from the edge and glide instead of stepping. Evaluated once per cell on the CPU.",params:$(J,[f("crawl","Crawl",J.crawl,0,40,.5,"px/s"),f("sparse","Sparseness",J.sparse,.4,.9,.005),f("dim","Dim clumps",J.dim,0,1,.01)]),still:vt,dots:(t,e,a,o,n)=>t.fill(e,a,{...J,...o},n)},{id:"smoke",name:"Smoke",note:"Slow domain-warped fbm (Inigo Quilez’s warping) sampled further inward as time passes, so soft tongues of smoke lift off every side and corner and dissolve as the falloff takes them; seen through 3px square dots as dithered speckle.",params:$({scale:16,warp:1.1,drift:7,depth:36,falloff:.9,mode:"dither",rim:.2}),still:3,glsl:`${xe}
float field(Fx f) {
  vec3 q = outward(f, P_scale, P_drift, 0.12);
  vec3 w = vec3(fbm(q + vec3(0.0, 0.0, f.t * 0.07)), fbm(q + vec3(5.2, 1.3, 2.8)), 0.0);
  float n = fbm(q + P_warp * (w - 0.5) * 2.0);
  return smoothstep(0.42, 0.8, n) * f.fall;
}
vec3 tint(Fx f, vec3 col, float v) { return meshTint(f, col); }`},{id:"fire",name:"Fire",note:"Quicker licking tongues: noise stretched away from the edge rises fast and is cut by height (the classic noise-minus-height flame), so it is hot and dense at the base and frays into sparks; the base shifts warm.",params:$({scale:9,warp:.6,drift:26,depth:30,falloff:1,mode:"brightness",levels:0,rim:.3},[f("stretch","Tongue length",2.4,1,6,.05),f("warm","Warm shift",.45,0,1,.01)]),still:2,glsl:`
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
}`},{id:"mesh",name:"Mesh gradient",note:"Four large soft blobs of colour near the session hue orbit the frame at different speeds while the band breathes outward and back; brightness-masked dots turn the smooth mesh gradient into an LED glow.",params:$({depth:32,falloff:1.2,mode:"brightness",levels:0,rim:.15,color:"mesh",scale:30,intensity:1.1},[f("orbit","Orbit speed",.04,0,.3,.005),f("breathe","Breathing",.25,0,.8,.01)]),still:5,glsl:`
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
}`},{id:"ink",name:"Ink wisps",note:"Thin wisps rather than blobs: doubly warped noise folded into ridges (1 − |2n − 1|, sharpened), flowing along and away from the edge like ink in water; halftone dots grow along each filament.",params:$({scale:22,warp:1.6,drift:6,depth:40,falloff:.9,mode:"halftone",dot:3.5,shape:"round",rim:.15},[f("thin","Thinness",9,1,20,.1),f("flow","Flow along",5,-30,30,.5,"px/s")]),still:6,glsl:`${xe}
float field(Fx f) {
  vec3 q = around(f, P_scale, P_flow, (f.d - f.t * P_drift) / P_scale);
  vec3 w1 = vec3(fbm(q + vec3(0.0, 0.0, f.t * 0.05)), fbm(q + vec3(5.2, 1.3, 2.8)), 0.0);
  vec3 w2 = vec3(fbm(q + P_warp * w1 + vec3(1.7, 9.2, f.t * 0.08)), fbm(q + P_warp * w1 + vec3(8.3, 2.8, 0.0)), 0.0);
  float n = fbm(q + P_warp * (w2 - 0.5) * 2.0);
  float ridge = pow(1.0 - abs(2.0 * n - 1.0), P_thin);
  return smoothstep(0.3, 0.9, ridge) * f.fall;
}
vec3 tint(Fx f, vec3 col, float v) { return meshTint(f, col); }`},{id:"aurora",name:"Aurora",note:"Curtains of light running round the perimeter: noise that is long away from the edge and short along it makes vertical streaks that slide round the frame, and a finer noise eats them from the outside, so they fray into specks.",params:$({scale:10,drift:3,depth:40,falloff:.7,mode:"brightness",levels:0,rim:.2},[f("slide","Slide speed",10,-40,40,.5,"px/s"),f("fray","Fray",.7,0,1.5,.01)]),still:2.5,glsl:`${xe}
float field(Fx f) {
  float curtain = fbm(around(f, P_scale, P_slide, f.d / (P_scale * 6.0) + f.t * 0.06));
  float rays = smoothstep(0.48, 0.8, curtain);
  float fine = vnoise(outward(f, P_scale * 0.5, P_drift * 3.0, 0.4));
  float keep = smoothstep(-0.15, 0.25, fine - P_fray * f.d / f.depth);
  return rays * pow(f.fall, 0.6) * keep * 1.2;
}
vec3 tint(Fx f, vec3 col, float v) { return meshTint(f, col); }`}],q=8,Dt=`
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
`,Xe=`#version 300 es
layout(location = 0) in vec2 a_c;
void main() { gl_Position = vec4(a_c * 2.0 - 1.0, 0.0, 1.0); }`;function Ut(t,e){const a=/vec3\s+tint\s*\(/.test(e)?"":"vec3 tint(Fx f, vec3 col, float v) { return col; }";return`#version 300 es
precision highp float;
uniform vec4 u_cam;   // x, y (CSS px), zoom, dpr
uniform vec2 u_cell0; // grid cell of texel (0, 0)
uniform float u_t;
uniform int u_n;
uniform vec4 u_rect[${q}];
uniform vec4 u_fr[${q}]; // time offset, presence, fill, seed
uniform vec3 u_col[${q}];
uniform float u_p[32];
out vec4 o;
${Dt}
${st(t)}
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
  for (int i = 0; i < ${q}; i++) {
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
}`}const Lt=`#version 300 es
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
}`;class Ct{constructor(e,a){this.gl=e,this.quadVao=a;const o=me(e,Xe,Lt);this.mask={program:o,u:Object.fromEntries(["u_field","u_cam","u_view","u_cell0","u_t","u_m0","u_m1"].map(n=>[n,e.getUniformLocation(o,n)]))},this.fbo=e.createFramebuffer(),this.tex=e.createTexture()}gl;quadVao;programs=new Map;mask;fbo;tex;tw=0;th=0;rects=new Float32Array(q*4);fr=new Float32Array(q*4);cols=new Float32Array(q*3);program(e,a,o){let n=this.programs.get(e);if(!n){const s=me(this.gl,Xe,Ut(a,o));n={program:s,u:Object.fromEntries(["u_cam","u_cell0","u_t","u_n","u_rect","u_fr","u_col","u_p"].map(l=>[l,this.gl.getUniformLocation(s,l)]))},this.programs.set(e,n)}return n}draw(e,a,o,n,s,i,l,d){const{gl:r}=this,p=e.dpr,v=Math.max(2,Math.round(i[0]*p)),c=Math.round(e.camera.x*p),u=Math.round(e.camera.y*p),x=[Math.floor(-c/v),Math.floor(-u/v)],E=Math.ceil(e.width*p/v)+2,R=Math.ceil(e.height*p/v)+2;(E!==this.tw||R!==this.th)&&(this.tw=E,this.th=R,r.bindTexture(r.TEXTURE_2D,this.tex),r.texImage2D(r.TEXTURE_2D,0,r.RGBA8,E,R,0,r.RGBA,r.UNSIGNED_BYTE,null),r.texParameteri(r.TEXTURE_2D,r.TEXTURE_MIN_FILTER,r.NEAREST),r.texParameteri(r.TEXTURE_2D,r.TEXTURE_MAG_FILTER,r.NEAREST),r.bindFramebuffer(r.FRAMEBUFFER,this.fbo),r.framebufferTexture2D(r.FRAMEBUFFER,r.COLOR_ATTACHMENT0,r.TEXTURE_2D,this.tex,0),r.bindFramebuffer(r.FRAMEBUFFER,null),r.bindTexture(r.TEXTURE_2D,null));const{program:L,u:M}=this.program(a,o,n),X=d.slice(0,q);X.forEach((_,y)=>{this.rects.set([_.box.x,_.box.y,_.box.w,_.box.h],y*4),this.fr.set([_.offset,_.presence,_.fill,y+1],y*4),this.cols.set(_.color,y*3)});const C=r.getParameter(r.VIEWPORT),ae=r.getParameter(r.FRAMEBUFFER_BINDING);r.activeTexture(r.TEXTURE0),r.bindTexture(r.TEXTURE_2D,null),r.bindFramebuffer(r.FRAMEBUFFER,this.fbo),r.viewport(0,0,E,R),r.disable(r.BLEND),r.useProgram(L),r.uniform4f(M.u_cam,e.camera.x,e.camera.y,e.camera.z,p),r.uniform2f(M.u_cell0,x[0],x[1]),r.uniform1f(M.u_t,l),r.uniform1i(M.u_n,X.length),r.uniform4fv(M.u_rect,this.rects),r.uniform4fv(M.u_fr,this.fr),r.uniform3fv(M.u_col,this.cols),r.uniform1fv(M.u_p,s),r.bindVertexArray(this.quadVao),r.drawArrays(r.TRIANGLES,0,6),r.bindFramebuffer(r.FRAMEBUFFER,ae),r.viewport(C[0],C[1],C[2],C[3]),r.enable(r.BLEND),r.blendFunc(r.ONE,r.ONE_MINUS_SRC_ALPHA);const h=this.mask;r.useProgram(h.program),r.activeTexture(r.TEXTURE0),r.bindTexture(r.TEXTURE_2D,this.tex),r.uniform1i(h.u.u_field,0),r.uniform4f(h.u.u_cam,e.camera.x,e.camera.y,e.camera.z,p),r.uniform2f(h.u.u_view,e.width,e.height),r.uniform2f(h.u.u_cell0,x[0],x[1]),r.uniform1f(h.u.u_t,l),r.uniform4f(h.u.u_m0,i[0],i[1],i[2],i[3]),r.uniform4f(h.u.u_m1,i[4],i[5],i[6],i[7]),r.drawArrays(r.TRIANGLES,0,6),r.bindTexture(r.TEXTURE_2D,null),r.bindVertexArray(null)}}const Nt=[{id:"brain",name:"Brian’s Brain",note:"What busy frames show in the app (render/busy/brain.ts, with these defaults). A band round the frame runs Brian’s Brain, a three-state automaton (firing, dying, off): the edge row sparks at random and the rule turns the sparks into tiny gliders that crawl along and out of the band, firing bright and dying dim.",params:[{...ge,value:F.speed},f("cell","Cell",F.cell,1,10,1,"px"),f("gap","Gap",F.gap,0,4,1,"px"),f("depth","Band depth",F.depth,1,16,1,"cells"),f("step","Step",F.step,.03,.3,.01,"s"),f("spark","Edge sparks",F.spark,0,.3,.005),f("dying","Dying cells",F.dying,0,1,.01),f("base","Edge glow",F.base,0,1,.01),f("falloff","Falloff",F.falloff,.2,4,.05),f("peak","Intensity",F.peak,0,1,.01),le("color","Colour",["session","white"],F.color)],still:nt,blocks:(t,e,a,o,n)=>t.fill(e,a,{...F,...o},n)}],U=[...It,...Nt],he=[we("enabled","Resolve when done",ie.enabled),f("fill","Fill",ie.fill,.05,.6,.01,"s"),f("hold","Hold",ie.hold,0,1,.01,"s"),f("fade","Fade",ie.fade,.1,1.5,.05,"s")],ue=[we("reduced","Reduced motion",matchMedia("(prefers-reduced-motion: reduce)").matches),we("desync","Offset frames in time",!0)],b=ht({site:"busy",title:"Busy",storageKey:"canvas-playground-busy-v7",defaults:()=>({variant:U[0].id,params:Object.fromEntries(U.map(t=>[t.id,fe(t.params)])),options:fe(ue),done:fe(he),frames:mt()}),restore(t,e){At(t,e,U,ue),t.d&&(e.done=ye(he,{...e.done,...t.d})),Array.isArray(t.f)&&(e.frames=e.frames.map((a,o)=>{const[n,s]=t.f[o]??[];return ut(a,{working:n===void 0?void 0:!!n,color:s})}))},share:t=>({...Ft(t,U,ue),d:Object.fromEntries(Object.entries(t.done).filter(([e,a])=>he.find(o=>o.key===e).value!==a)),f:t.frames.map(e=>[e.working?1:0,e.color])}),exportJson:t=>{const e=U.find(a=>a.id===t.variant);return{site:"busy",variant:{id:e.id,name:e.name,params:t.params[e.id]},done:t.done}}}),{settings:m}=b,te=()=>U.find(t=>t.id===m.variant),je=()=>b.setCaption(te().name,te().note);Et(b,U,()=>m.variant,t=>{m.variant=t,Ot.render(),je(),b.save()});const Ot=Rt(b,"Parameters",()=>te().params,()=>m.params[m.variant],b.save,()=>m.params[m.variant]=fe(te().params));b.section("Done",Z("Finish all",()=>m.frames.forEach((t,e)=>W(e,!1)),"ghost",!0)).append(...he.map(t=>Re(t,m.done,b.save)));let ke=0;const Ke=m.frames.map(()=>-1/0),Qe=m.frames.map(()=>!1);function W(t,e){const a=m.frames[t];a.working!==e&&(Qe[t]=a.working&&!e,a.working=e,Ke[t]=ke,Je(),b.save())}const Vt=b.section("Frames");function Je(){Vt.replaceChildren(...kt(m.frames,(t,e)=>{const a=pt(t.working,o=>W(e,o));return a.setAttribute("aria-label",`${t.title} is working`),a.dataset.frame=String(e),[a]},()=>b.save()),ce("div","pg-buttons",Z("Randomise",()=>m.frames.forEach((t,e)=>W(e,Math.random()<.6)),"",!0),Z("All working",()=>m.frames.forEach((t,e)=>W(e,!0)),"",!0),Z("All done",()=>m.frames.forEach((t,e)=>W(e,!1)),"",!0)))}Je();Mt(b,"Preview",ue,m.options,b.save);je();function _e(t){const e={working:!!m.frames[t].working,since:Ke[t],finished:Qe[t]};return ft(e,ke,m.done,!!m.options.reduced)}const $t=new Bt(b.gl.gl),Fe=new it;let Te=0,Ze=!1;const et=t=>{ke+=t,m.options.reduced||(Te+=t*m.params[m.variant].speed)};b.onTick(t=>{Ze||et(t)});const Wt=new Ct(b.gl.gl,b.gl.quadVao),Ge=new Float32Array(32),Yt=new qt(b.gl.gl),Ee=new bt;b.onDraw(t=>{const e=te(),a=m.params[e.id],{dpr:o,camera:n}=t,s=n.z,i=!!m.options.reduced,l=v=>m.options.desync?v*1.618:0,d=i?e.still:Te,r=e.dots?()=>{const v=b.layout.sections.map((c,u)=>{const[x,E]=_e(u);return{box:c.box,color:be(m.frames[u].color),offset:i?0:l(u)+u*37,seed:u+1,presence:x,fill:E}});e.dots(Ee,{x:n.x,y:n.y,z:s,width:t.width,height:t.height,dpr:o},v,a,d),Yt.draw(Ee)}:e.glsl?()=>{lt(e.params,a,Ge);const v=b.layout.sections.map((u,x)=>{const[E,R]=_e(x);return{box:u.box,color:be(m.frames[x].color),offset:i?0:l(x)+x*37,presence:E,fill:R}}),c=[a.pitch,a.dot,a.shape==="square"?1:0,["brightness","halftone","dither"].indexOf(a.mode),a.levels,a.base,a.peak,a.modulate];Wt.draw(t,e.id,e.params,e.glsl,Ge,c,d,v)}:void 0;if(b.gl.draw(t,b.layout.sections.map(v=>({box:v.box})),[...b.layout.items.values()],r),!e.blocks)return;const p=b.layout.sections.map((v,c)=>{const[u,x]=_e(c);return{key:`${e.id}:${c}`,box:v.box,color:be(m.frames[c].color),offset:i?0:l(c),seed:c+1,presence:u,fill:x}});e.blocks(Fe,{x:n.x,y:n.y,z:s,width:t.width,height:t.height,dpr:o},p,a,d),$t.draw(Fe)});Object.assign(b.playground,{time:()=>Te,blocks:()=>Fe.n,dots:()=>Ee.n,select:t=>document.querySelector(`[role="option"][data-id="${t}"]`)?.click(),setWorking:t=>t.forEach((e,a)=>W(a,e)),pause:t=>Ze=t,advance:et});
