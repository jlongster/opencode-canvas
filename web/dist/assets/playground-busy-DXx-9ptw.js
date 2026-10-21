import"./layout-D5wn9ku6.js";import{l as D,F as M,B as I,a as B,c as N,b as w,p as V,f as W,d as j,e as $,s as G}from"./shell-CX1N1pJT.js";import{S as u,r as a,s as H,t as h,g as Q,v as J,p as K,o as X,a as Y,b as Z,c as ee,d as b,f as te,e as ae,h as oe}from"./panels-BngdA6ZN.js";const re=`
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
`,d=[{id:"specular",name:"Specular",note:"A specular glint runs along a 1px bevel lit from above; it keeps a constant speed around corners and spills just a little light into the fill, so it reads as material, not as a glow.",params:[u,a("lap","Lap",5.5,2,14,.1,"s"),a("tail","Tail",.14,.03,.4,.01),a("intensity","Intensity",.55,0,1.5,.01),a("width","Width",1.25,.5,3,.05,"px"),a("white","Specular",.55,0,1,.01),a("bevel","Bevel",.45,0,1,.01),a("bloom","Bloom",.05,0,.3,.005),a("scatter","Scatter",.035,0,.2,.005)],glsl:`
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
}`},{id:"halo",name:"Focus halo",note:"A macOS-style focus ring set 3px off the frame breathes between 8% and 20% on a 3.4s sine: no movement at all, so it is calm enough to leave on for minutes.",params:[u,a("period","Period",3.4,1.5,8,.1,"s"),a("low","Low",.08,0,.6,.01),a("high","High",.2,0,1,.01),a("offset","Offset",3,0,8,.5,"px"),a("width","Width",1.5,.5,4,.05,"px"),a("haze","Haze",5,0,16,.5,"px"),H("easing","Easing",["sine","quad","expo"],"sine")],glsl:`
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
}`},{id:"ambient",name:"Ambient",note:"Two broad, slow pools of light drift around the frame in opposite directions and scatter into the fill: activity felt in the periphery, never a moving line to track.",params:[u,a("drift","Drift",12,4,30,.5,"s"),a("lobes","Pools",2,1,3,1),a("size","Size",.2,.06,.45,.01),a("depth","Depth",40,8,120,1,"px"),a("fill","Fill light",.08,0,.3,.005),a("edge","Edge",.22,0,.8,.01),a("breathe","Breathe",.3,0,1,.01)],glsl:`
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
}`},{id:"gloss",name:"Gloss",note:"A glassy band sweeps diagonally across the frame on a long ease-in-out, then rests: like the sheen on a Wallet card, it says alive without asking to be watched.",params:[u,a("period","Every",4.2,2,10,.1,"s"),a("sweep","Sweep",1.6,.6,4,.05,"s"),a("angle","Angle",22,-60,60,1,"°"),a("band","Band",70,20,240,1,"px"),a("edge","Edge",.55,0,1.5,.01),a("sheen","Sheen",.025,0,.12,.001),a("white","Whiteness",.45,0,1,.01)],glsl:`
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
}`},{id:"trace",name:"Trace",note:"An indeterminate progress stroke, drawn down both sides from the top and erased after it, in the iOS and Material spinner rhythm: head and tail ease on offset curves so the length breathes.",params:[u,a("cycle","Cycle",2.8,1.2,6,.05,"s"),a("lag","Tail lag",.32,.1,.6,.01),a("intensity","Intensity",.42,0,1.5,.01),a("width","Width",1.25,.5,3,.05,"px"),a("tips","Bright tips",.5,0,1,.01),a("bloom","Bloom",.02,0,.3,.005),h("mirror","Both sides",!0)],glsl:`
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
}`},{id:"ripple",name:"Ripple",note:"One soft ring leaves the frame every 3.2s and eases out over 24px, like Find My’s ping: rhythmic, legible at a glance across the room, and at rest most of the time.",params:[u,a("period","Every",3.2,1.5,8,.1,"s"),a("travel","Travel",24,6,64,1,"px"),a("width","Width",2,.5,8,.1,"px"),a("intensity","Intensity",.12,0,1,.01),a("rest","Resting edge",.08,0,.4,.005),a("thump","Edge flash",.25,0,1,.01),h("double","Echo",!1)],glsl:`
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
}`}],se=new Set(["band","depth","tail"]),ne=`#version 300 es
layout(location = 0) in vec2 a_c;
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
}`,R=e=>`vec3(${e.map(t=>t.toFixed(5)).join(", ")})`,ie=I.map(e=>e+(1-e)*B);function fe(e){return`#version 300 es
precision highp float;
in vec2 v_p;
out vec4 o;
uniform vec4 u_rect;
uniform vec4 u_cam;
uniform vec3 u_col;
uniform float u_work, u_done, u_t, u_k, u_reduced;
uniform vec4 u_doneP;
uniform float u_p[32];
${re}
${Q(e.params)}
${e.glsl}

vec3 toLin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 toSrgb(vec3 c) { c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
float h12(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }

// Reduced motion: the same message without movement, a steady ring just off the edge.
vec3 still(Fx f) {
  float w = 1.5 * f.k;
  return f.col * 0.24 * lineAA(f.dpx - 3.0 * f.k - 0.5 * w, w, f.aa);
}

void main() {
  Fx f;
  f.b = 0.5 * u_rect.zw;
  f.r = min(${M.toFixed(1)}, min(f.b.x, f.b.y));
  f.p = v_p;
  f.z = u_cam.z;
  f.aa = 1.0 / u_cam.w;
  f.k = u_k;
  f.t = u_t;
  f.col = toLin(u_col);
  f.dpx = sdRR(v_p, f.b, f.r) * f.z;
  // Most of a frame is far from its edge: nothing to light there.
  if (f.dpx < -360.0 * f.k) discard;
  float R = insetRadius(f.b, f.r, f.dpx / f.z);
  vec2 dv = edgeDir(v_p, f.b, R);
  f.n = dv;
  f.L = perimeter(f.b, f.r);
  f.s = arcS(v_p, f.b, R, dv, f.L);

  vec3 light = vec3(0.0);
  if (u_work > 0.001) light += (u_reduced > 0.5 ? still(f) : effect(f)) * u_work;

  // Done: one gentle flash shared by every variation.
  if (u_doneP.w > 0.5 && u_done >= 0.0 && u_done < u_doneP.x) {
    float pr = u_done / u_doneP.x;
    float e = 1.0 - pow(1.0 - pr, 3.0);
    float ring = u_reduced > 0.5 ? 0.0 : gauss(f.dpx - u_doneP.y * f.k * e, (2.0 + 6.0 * pr) * f.k) * smoothstep(-1.0, 1.0, f.dpx) * pow(1.0 - pr, 2.0);
    float edge = hair(f, 1.5 * f.k) * pow(1.0 - pr, 2.0);
    float fill = scatterIn(f, 60.0 * f.k) * 0.05 * pow(1.0 - pr, 3.0);
    light += mix(f.col, vec3(1.0), 0.35) * (edge + 0.55 * ring + fill) * u_doneP.z * smoothstep(0.0, 0.04, pr);
  }
  if (dot(light, vec3(1.0)) < 1e-6) discard;

  // Add the light to what the base pass drew here, in linear space, with a soft shoulder.
  float inside = clamp(0.5 - f.dpx / f.aa, 0.0, 1.0);
  vec3 base = mix(${R(I)}, ${R(ie)}, inside);
  vec3 lb = toLin(base);
  vec3 delta = toSrgb(1.0 - exp(-(lb + light))) - toSrgb(1.0 - exp(-lb));
  // Triangular dither of ±1 LSB, so faint gradients don't band.
  float n = h12(gl_FragCoord.xy) + h12(gl_FragCoord.xy + 17.31) - 1.0;
  o = vec4(max(delta + n / 255.0, 0.0), 0.0);
}`}const le=["u_rect","u_cam","u_view","u_margin","u_col","u_work","u_done","u_t","u_k","u_reduced","u_doneP","u_p"];class ce{constructor(t,r){this.gl=t,this.quadVao=r}gl;quadVao;programs=new Map;prepare(t){let r=this.programs.get(t.id);if(r)return r;const s=D(this.gl,ne,fe(t));return r={program:s,u:Object.fromEntries(le.map(o=>[o,this.gl.getUniformLocation(s,o)]))},this.programs.set(t.id,r),r}margin(t){let r=16;for(const s of t.variant.params){if(s.type!=="range"||s.unit!=="px"||se.has(s.key))continue;const o=t.values[s.key];r=Math.max(r,s.key==="travel"||s.key==="offset"?o+24:o*3)}return t.done[3]&&(r=Math.max(r,t.done[1]+30)),r+24}draw(t,r,s){const{gl:o}=this,f=this.prepare(s.variant),{camera:l}=t,L=s.pageUnits?l.z:1,g=this.margin(s)*L/l.z;o.blendFunc(o.ONE,o.ONE),o.useProgram(f.program),o.bindVertexArray(this.quadVao),o.uniform4f(f.u.u_cam,l.x,l.y,l.z,t.dpr),o.uniform2f(f.u.u_view,t.width,t.height),o.uniform1f(f.u.u_margin,g),o.uniform1f(f.u.u_k,L),o.uniform1f(f.u.u_reduced,s.reduced?1:0),o.uniform4f(f.u.u_doneP,...s.done),o.uniform1fv(f.u.u_p,s.packed);const S=-l.x/l.z,z=-l.y/l.z,U=t.width/l.z,C=t.height/l.z;for(const p of r){if(p.work<.001&&p.done<0)continue;const c=p.box;c.x-g>S+U||c.x+c.w+g<S||c.y-g>z+C||c.y+c.h+g<z||(o.uniform4f(f.u.u_rect,c.x,c.y,c.w,c.h),o.uniform3f(f.u.u_col,...p.color),o.uniform1f(f.u.u_work,p.work),o.uniform1f(f.u.u_done,p.done),o.uniform1f(f.u.u_t,s.time+p.offset),o.drawArrays(o.TRIANGLES,0,6))}o.bindVertexArray(null),o.blendFunc(o.ONE,o.ONE_MINUS_SRC_ALPHA)}}const y=[h("enabled","Flash when done",!0),a("duration","Duration",1.3,.4,3,.05,"s"),a("travel","Travel",20,0,60,1,"px"),a("intensity","Intensity",.6,0,1.5,.01)],P=[h("reduced","Reduced motion",matchMedia("(prefers-reduced-motion: reduce)").matches),h("pageUnits","Widths in page units",!1),h("desync","Offset frames in time",!0)],i=N({site:"busy",title:"Busy",storageKey:"canvas-playground-busy-v2",defaults:()=>({variant:d[0].id,params:Object.fromEntries(d.map(e=>[e.id,b(e.params)])),options:b(P),done:b(y),frames:j()}),restore(e,t){Z(e,t,d,P),e.d&&(t.done=ee(y,{...t.done,...e.d})),Array.isArray(e.f)&&(t.frames=t.frames.map((r,s)=>{const[o,f]=e.f[s]??[];return W(r,{working:o===void 0?void 0:!!o,color:f})}))},share:e=>({...Y(e,d,P),d:Object.fromEntries(Object.entries(e.done).filter(([t,r])=>y.find(s=>s.key===t).value!==r)),f:e.frames.map(t=>[t.working?1:0,t.color])}),exportJson:e=>{const t=d.find(r=>r.id===e.variant);return{site:"busy",variant:{id:t.id,name:t.name,params:e.params[t.id]},done:e.done,pageUnits:e.options.pageUnits}}}),{settings:n}=i,_=()=>d.find(e=>e.id===n.variant),O=new ce(i.gl.gl,i.gl.quadVao);for(const e of d)O.prepare(e);const E=()=>i.setCaption(_().name,_().note);J(i,d,()=>n.variant,e=>{n.variant=e,de.render(),E(),i.save()});const de=K(i,"Parameters",()=>_().params,()=>n.params[n.variant],i.save,()=>n.params[n.variant]=b(_().params));i.section("Done flash",w("Flash all",()=>n.frames.forEach((e,t)=>T(t)),"ghost",!0)).append(...y.map(e=>V(e,n.done,i.save)));const m=n.frames.map(e=>e.working?1:0),k=n.frames.map(()=>-1);let q=0;function T(e){k[e]=q}function x(e,t){const r=n.frames[e];r.working&&!t&&T(e),r.working=t}const pe=i.section("Frames");function v(){pe.replaceChildren(...te(n.frames,(e,t)=>{const r=G(e.working,s=>{x(t,s),i.save()});return r.setAttribute("aria-label",`${e.title} is working`),r.dataset.frame=String(t),[r]},()=>i.save()),$("div","pg-buttons",w("Randomise",()=>{n.frames.forEach((e,t)=>x(t,Math.random()<.6)),v(),i.save()},"",!0),w("All working",()=>{n.frames.forEach((e,t)=>x(t,!0)),v(),i.save()},"",!0),w("All done",()=>{n.frames.forEach((e,t)=>x(t,!1)),v(),i.save()},"",!0)))}v();X(i,"Preview",P,n.options,i.save);E();const F=new Float32Array(32);let A=0;i.onTick(e=>{q+=e;const t=n.params[n.variant];n.options.reduced||(A+=e*t.speed),n.frames.forEach((r,s)=>{const o=r.working?1:0;m[s]+=(o-m[s])*(1-Math.exp(-e/(o>m[s]?.18:.3))),Math.abs(o-m[s])<.002&&(m[s]=o)})});i.onDraw(e=>{const t=_(),r=n.params[t.id];ae(t.params,r,F);const s=n.done,o=i.layout.sections.map((f,l)=>({box:f.box,color:oe(n.frames[l].color),work:m[l],done:k[l]<0||q-k[l]>s.duration?-1:q-k[l],offset:n.options.desync?l*1.618:0}));i.gl.draw(e,i.layout.sections.map(f=>({box:f.box})),[...i.layout.items.values()],()=>O.draw(e,o,{variant:t,values:r,packed:F,time:A,pageUnits:!!n.options.pageUnits,reduced:!!n.options.reduced,done:[s.duration,s.travel,s.intensity,s.enabled?1:0]}))});Object.assign(i.playground,{time:()=>A,select:e=>document.querySelector(`[role="option"][data-id="${e}"]`)?.click(),setWorking:e=>{e.forEach((t,r)=>x(r,t)),v()}});
