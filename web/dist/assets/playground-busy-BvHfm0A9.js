import"./layout-CVB4XQ9q.js";import{F as Kt,D as pt,e as ie}from"./envelope-hq1lSZqC.js";import{l as le,b as ct,p as Bt,S as It,e as xt,s as ce,a as wt,c as fe,f as he,d as de,g as ue}from"./shell-CNwjNvs9.js";import{c as Xt,r as Et,S as Rt,a as v,s as vt,g as me,t as kt,d as bt,h as At,p as pe}from"./params-Bh0xY2p6.js";const V={speed:.1,cell:2,gap:1,depth:3,step:.03,spark:.15,dying:.69,base:.18,falloff:.6,peak:.9,color:"white"},xe=3,Gt=40,ve=4e5,st=8;class be{data=new Float32Array(st*4096);n=0;framesInView=0;nextT=1/0;bands=new Map;seen=new Set;fill(t,o,a,n){this.n=0,this.framesInView=0,this.nextT=1/0,this.seen.clear();const{dpr:i,z:r}=t,l=Math.max(1,Math.round(a.cell*i)),c=l+Math.round(a.gap*i),s=c/i,m=1+a.depth*s,p=t.width*i,h=t.height*i,x=a.color==="white";for(const f of o){if(f.presence<=.001)continue;const R=(f.box.x*r+t.x)*i,k=(f.box.y*r+t.y)*i,B=f.box.w*r*i,S=f.box.h*r*i,C=m*i;if(R+B+C<0||k+S+C<0||R-C>p||k-C>h)continue;const A=f.box.w*r,D=f.box.h*r;if((2*(A+D)+8*m)*m>ve*s*s)continue;this.framesInView++,this.seen.add(f.key);const u=[B,S,r,l,c,a.depth,a.falloff].map(_=>_.toFixed(3)).join();let d=this.bands.get(f.key);if(!d||d.sig!==u){const _=_e(u,A,D,r,i,l,c,a.depth,a.falloff);d&&we(d,_),this.bands.set(f.key,d=_)}const M=n+f.offset,I=Math.floor(M/a.step);for((I<d.gen||I-d.gen>Gt)&&(d.state.fill(0),d.gen=I-Gt);d.gen<I;)ge(d,a.spark,f.seed);this.nextT=Math.min(this.nextT,(I+1)*a.step-f.offset);const q=Math.round(R),z=Math.round(k),[b,U,T]=x?ye:f.color,P=a.peak*f.presence,L=1-f.fill,N=d.state;for(let _=0;_<d.n;_++){const w=q+d.gx[_]*c,F=z+d.gy[_]*c;if(w+l<=0||F+l<=0||w>=p||F>=h)continue;const E=d.fall[_],$=N[_]===1?1:N[_]===2?a.dying:d.edge[_]?a.base:0,W=Math.max(Math.min(1,$*(.35+.65*E))*L,f.fill*E*E*E),Y=P*W;Y>.002&&this.push(w,F,l,Y*b,Y*U,Y*T,Y)}}for(const f of this.bands.keys())this.seen.has(f)||this.bands.delete(f)}push(t,o,a,n,i,r,l){if((this.n+1)*st>this.data.length){const m=new Float32Array(this.data.length*2);m.set(this.data),this.data=m}const c=this.n++*st,s=this.data;s[c]=t,s[c+1]=o,s[c+2]=a,s[c+3]=a,s[c+4]=n,s[c+5]=i,s[c+6]=r,s[c+7]=l}}const ye=[1,1,1];function ge(e,t,o){e.gen++;const a=e.state,n=e.next,i=e.nb;for(let r=0;r<e.n;r++){const l=a[r];if(l===1)n[r]=2;else if(l===2)n[r]=0;else{let c=0;for(let s=r*8,m=s+8;s<m;s++){const p=i[s];p>=0&&a[p]===1&&c++}n[r]=c===2||e.edge[r]&&Ae(e.gx[r]*7919+e.gy[r],e.gen,o)<t?1:0}}e.state=n,e.next=a}function _e(e,t,o,a,n,i,r,l,c){const m=r/n,p=1+l*m,h=Math.min(Kt*a,t/2,o/2),x=t/2-h,f=o/2-h,R=Math.floor(-p*n/r)-1,k=Math.ceil((t+p)*n/r)+1,B=R,S=Math.ceil((o+p)*n/r)+1,C=S-B+1,A=new Int32Array(C*6);let D=0;for(let b=B;b<=S;b++){const U=(b*r+i/2)/n-o/2,T=(b-B)*6,P=R;let L=k,N=1,_=0;if(Math.abs(U)-o/2<1){const w=Math.abs(U)<=f?0:t/2-x;L=Math.min(k,Math.ceil(w*n/r)+1),N=Math.max(L+1,Math.floor((t-w)*n/r)-1),_=k}A[T]=P,A[T+1]=L,A[T+2]=D,D+=L-P+1,A[T+3]=N,A[T+4]=_,A[T+5]=D,_>=N&&(D+=_-N+1)}const u=new Int32Array(D).fill(-1),d=[],M=[],I=[];for(let b=B;b<=S;b++){const U=(b-B)*6,T=(b*r+i/2)/n-o/2;for(let P=0;P<2;P++){const L=A[U+P*3],N=A[U+P*3+1],_=A[U+P*3+2];for(let w=L;w<=N;w++){const F=(w*r+i/2)/n-t/2,E=F-Math.max(-x,Math.min(x,F)),$=T-Math.max(-f,Math.min(f,T)),W=Math.hypot(E,$)-h;W<1||W>p||(u[_+w-L]=d.length,d.push(w),M.push(b),I.push(W-1))}}}const q=d.length,z={sig:e,n:q,gx:Int32Array.from(d),gy:Int32Array.from(M),edge:new Uint8Array(q),fall:new Float32Array(q),nb:new Int32Array(q*8),row0:B,runs:A,slots:u,state:new Uint8Array(q),next:new Uint8Array(q),gen:-1/0};for(let b=0;b<q;b++){z.edge[b]=I[b]<m?1:0,z.fall[b]=Math.pow(Math.min(1,Math.max(0,1-I[b]/(l*m))),c);let U=b*8;for(let T=-1;T<=1;T++)for(let P=-1;P<=1;P++)(P||T)&&(z.nb[U++]=Qt(z,z.gx[b]+P,z.gy[b]+T))}return z}function Qt(e,t,o){const a=o-e.row0;if(a<0||a*6>=e.runs.length)return-1;const n=a*6;return t>=e.runs[n]&&t<=e.runs[n+1]?e.slots[e.runs[n+2]+t-e.runs[n]]:t>=e.runs[n+3]&&t<=e.runs[n+4]?e.slots[e.runs[n+5]+t-e.runs[n+3]]:-1}function we(e,t){t.gen=e.gen;for(let o=0;o<t.n;o++){const a=Qt(e,t.gx[o],t.gy[o]);t.state[o]=a>=0?e.state[a]:0}}function Ae(e,t,o){let a=Math.imul(e|0,374761393)+Math.imul(t|0,668265263)+Math.imul(o|0,1274126177);return a=Math.imul(a^a>>>13,1274126177),((a^a>>>16)>>>0)/4294967296}const lt={speed:.75,pitch:5,dot:2,shape:"square",mode:"brightness",levels:0,base:0,rim:.18,modulate:0,scale:9,drift:5,depth:11,falloff:.7,intensity:1,peak:.9,color:"session",crawl:5.5,sparse:.525,dim:.3},Me=4,ft=12;class Fe{data=new Float32Array(ft*1024);n=0;framesInView=0;push(t,o,a,n,i,r,l,c,s,m,p){if((this.n+1)*ft>this.data.length){const f=new Float32Array(this.data.length*2);f.set(this.data),this.data=f}const h=this.n++*ft,x=this.data;x[h]=t,x[h+1]=o,x[h+2]=a,x[h+3]=n,x[h+4]=i,x[h+5]=r,x[h+6]=l,x[h+7]=c,x[h+8]=s,x[h+9]=m,x[h+10]=p,x[h+11]=0}stamp=new Uint32Array(0);best=new Float32Array(0);band=new Float32Array(0);rgb=new Float32Array(0);touched=new Int32Array(0);gen=0;grid(t){if(this.stamp.length>=t)return;const o=Math.max(t,this.stamp.length*2);this.stamp=new Uint32Array(o),this.best=new Float32Array(o),this.band=new Float32Array(o),this.rgb=new Float32Array(o*3),this.touched=new Int32Array(o),this.gen=0}fill(t,o,a,n){this.n=0,this.framesInView=0;const{dpr:i,z:r}=t,l=Math.max(2,Math.round(a.pitch*i)),c=Math.round(t.x*i),s=Math.round(t.y*i),m=Math.floor(-c/l),p=Math.floor(-s/l),h=Math.floor((t.width*i-c)/l)-m+1,x=Math.floor((t.height*i-s)/l)-p+1;if(h<=0||x<=0)return;this.grid(h*x),++this.gen===4294967295&&(this.stamp.fill(0),this.gen=1);const f=this.gen;let R=0;const k=a.depth,B=k+1+a.pitch,S=a.color==="mesh";for(const u of o){if(u.presence<=.001)continue;const d=u.box.w/2,M=u.box.h/2,I=u.box.x+d,q=u.box.y+M,z=(u.box.x*r+t.x-B)*i,b=(u.box.y*r+t.y-B)*i,U=((u.box.x+u.box.w)*r+t.x+B)*i,T=((u.box.y+u.box.h)*r+t.y+B)*i,P=Math.max(m,Math.floor((z-c)/l)),L=Math.min(m+h-1,Math.floor((U-c)/l)),N=Math.max(p,Math.floor((b-s)/l)),_=Math.min(p+x-1,Math.floor((T-s)/l));if(P>L||N>_)continue;this.framesInView++;const w=Math.min(Kt,d,M),F=d-w,E=M-w,$=.5*Math.PI*w,W=4*(F+E)+2*Math.PI*w,Y=W*r,Ut=n+u.offset,Dt=u.seed,re=Math.floor(((u.box.x*r+t.x+a.pitch)*i-c)/l),Lt=Math.ceil((((u.box.x+u.box.w)*r+t.x-a.pitch)*i-c)/l),[Ct,Nt,Ot]=u.color;for(let dt=N;dt<=_;dt++){const J=((s+dt*l+.5*l)/i-t.y)/r-q,ne=Math.abs(J)<E;for(let X=P;X<=L&&!(ne&&X>re&&X<Lt&&(X=Lt,X>L));X++){const G=((c+X*l+.5*l)/i-t.x)/r-I,Vt=Math.abs(G)-F,$t=Math.abs(J)-E,nt=(Math.hypot(Math.max(Vt,0),Math.max($t,0))+Math.min(Math.max(Vt,$t),0)-w)*r-1;if(nt<0||nt>k)continue;const ut=G-Math.max(-F,Math.min(F,G)),mt=J-Math.max(-E,Math.min(E,J));let H;if(ut===0)H=J<0?G>=0?G:W+G:F+2*$+2*E+(F-G);else if(mt===0)H=G>0?F+$+(J+E):3*F+2*E+3*$+(E-J);else{const Z=Math.atan2(mt,ut);ut>0&&mt<0?H=F+w*(Z+.5*Math.PI):ut>0?H=F+$+2*E+w*Z:mt>0?H=3*F+2*E+2*$+w*(Z-.5*Math.PI):H=3*F+4*E+3*$+w*(Z+Math.PI)}const it=Math.pow(rt(1-nt/k),a.falloff);let et=rt(Ee(H*r,Y,nt,Ut,Dt,it,a)*a.intensity);nt<=a.pitch&&(et=Math.max(et,a.rim*it)),et=Math.max(et*(1-u.fill),u.fill*it*it*it)*u.presence;const O=(dt-p)*h+(X-m);if(this.stamp[O]!==f&&(this.stamp[O]=f,this.best[O]=-1,this.band[O]=0,this.touched[R++]=O),this.band[O]=Math.max(this.band[O],u.presence),et>this.best[O]){this.best[O]=et;let Z=Ct,Wt=Nt,Yt=Ot;S&&([Z,Wt,Yt]=Re(H*r,Y,Ut,Dt,Ct,Nt,Ot)),this.rgb[O*3]=Z,this.rgb[O*3+1]=Wt,this.rgb[O*3+2]=Yt}}}}const C=a.dot*i,A=a.shape==="round"?1:0,D=a.mode;for(let u=0;u<R;u++){const d=this.touched[u],M=Math.max(0,this.best[d]),I=m+d%h,q=p+Math.floor(d/h);let z=1;a.modulate>0&&(z=K(1,yt(.25,.75,Jt(I*.09,q*.09,n*.15)),a.modulate));let b;D==="brightness"?b=a.levels>.5?Math.floor(M*a.levels+.5)/a.levels:M:D==="halftone"?(b=M>.004?1:0,z*=Math.sqrt(M)):b=M>Pe(I,q)?1:0;const U=b*a.peak;U<=.002&&a.base<=.002||this.push(c+I*l,s+q*l,l,A,C*z,C,U,a.base,this.rgb[d*3],this.rgb[d*3+1],this.rgb[d*3+2])}}}function Ee(e,t,o,a,n,i,r){const l=(o-a*r.drift)/r.scale,c=Tt(e,t,a,n,r.scale,r.crawl,l,a*.11),s=Tt(e,t,a,n,r.scale*1.15,-r.crawl,l*1.1+9,a*.13),m=Math.max(c,s),p=yt(r.sparse+.06,r.sparse+.12,m),h=yt(r.sparse-.02,r.sparse+.03,m)*r.dim,x=yt(0,.25,i);return Math.max(p,h)*(.35+.65*i)*x}function Tt(e,t,o,a,n,i,r,l){const c=t/(2*Math.PI*n),s=(e-o*i)/t*2*Math.PI;return Jt(Math.cos(s)*c+a*11.7,Math.sin(s)*c+a*5.3,r+l+a*2.9)}function Re(e,t,o,a,n,i,r){const l=Tt(e,t,o,a,140,-6,o*.05,0)-.5;return ke(n,i,r,l*1.4)}function ke(e,t,o,a){const n=.299*e+.587*t+.114*o,i=.596*e-.274*t-.322*o,r=.211*e-.523*t+.312*o,l=Math.atan2(r,i)+a,c=Math.hypot(i,r),s=c*Math.cos(l),m=c*Math.sin(l);return[rt(n+.956*s+.621*m),rt(n-.272*s-.647*m),rt(n-1.106*s+1.703*m)]}const Te=[0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5];function Pe(e,t){return(Te[(e%4+4)%4+(t%4+4)%4*4]+.5)/16}function j(e,t,o){let a=Math.imul(e|0,374761393)+Math.imul(t|0,668265263)+Math.imul(o|0,1274126177);return a=Math.imul(a^a>>>13,1274126177),((a^a>>>16)>>>0)/4294967296}function Jt(e,t,o){const a=Math.floor(e),n=Math.floor(t),i=Math.floor(o);let r=e-a,l=t-n,c=o-i;r=r*r*(3-2*r),l=l*l*(3-2*l),c=c*c*(3-2*c);const s=K(j(a,n,i),j(a+1,n,i),r),m=K(j(a,n+1,i),j(a+1,n+1,i),r),p=K(j(a,n,i+1),j(a+1,n,i+1),r),h=K(j(a,n+1,i+1),j(a+1,n+1,i+1),r);return K(K(s,m,l),K(p,h,l),c)}function K(e,t,o){return e+(t-e)*o}function yt(e,t,o){const a=rt((o-e)/(t-e));return a*a*(3-2*a)}function rt(e){return e<0?0:e>1?1:e}function Se(e,t,o,a){typeof e.v=="string"&&o.some(i=>i.id===e.v)&&(t.variant=e.v);const n=e.p??{};for(const i of o)n[i.id]&&(t.params[i.id]=Et(i.params,{...t.params[i.id],...n[i.id]}));e.o&&(t.options=Et(a,{...t.options,...e.o}))}function Be(e,t,o){const a={};for(const n of t){const i=Xt(n.params,e.params[n.id]);Object.keys(i).length&&(a[n.id]=i)}return{v:e.variant,p:a,o:Xt(o,e.options)}}function Ie(e,t,o,a){const n=le(t.map((i,r)=>({id:i.id,name:i.name,key:String(r+1),title:i.note})),o(),a,"Variation");return e.section("Variation").append(n.el),window.addEventListener("keydown",i=>{if(i.target.closest('input, textarea, [role="slider"]')||i.metaKey||i.ctrlKey||i.altKey)return;const r=Number(i.key)-1;Number.isInteger(r)&&r>=0&&r<t.length&&n.select(t[r].id)}),n}function qe(e,t,o,a,n,i){const r=ct("Reset",()=>{i(),c(),n()},"ghost",!0),l=e.section(t,r),c=()=>l.replaceChildren(...o().map(s=>Bt(s,a(),n,It)));return c(),{render:c}}function ze(e,t,o,a,n){e.section(t).append(...o.map(i=>Bt(i,a,n,It)))}function Ue(e,t,o){return e.map((a,n)=>xt("div","pg-frame",ce(a.color,It,i=>{a.color=i,o(n)},`Colour of ${a.title}`),xt("span","t",a.title),xt("span","controls",...t(a,n))))}const De=`#version 300 es
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
}`,Le=`#version 300 es
precision mediump float;
in vec4 v_col;
out vec4 o;
void main() { o = v_col; }`;class Ce{constructor(t){this.gl=t,this.program=wt(t,De,Le),this.uSize=t.getUniformLocation(this.program,"u_size");const o=t.createBuffer();t.bindBuffer(t.ARRAY_BUFFER,o),t.bufferData(t.ARRAY_BUFFER,new Float32Array([0,0,1,0,0,1,0,1,1,0,1,1]),t.STATIC_DRAW),this.vao=t.createVertexArray(),t.bindVertexArray(this.vao),t.enableVertexAttribArray(0),t.vertexAttribPointer(0,2,t.FLOAT,!1,0,0),this.buf=t.createBuffer(),t.bindBuffer(t.ARRAY_BUFFER,this.buf),t.enableVertexAttribArray(1),t.vertexAttribPointer(1,4,t.FLOAT,!1,st*4,0),t.vertexAttribDivisor(1,1),t.enableVertexAttribArray(2),t.vertexAttribPointer(2,4,t.FLOAT,!1,st*4,16),t.vertexAttribDivisor(2,1),t.bindVertexArray(null)}gl;program;uSize;vao;buf;draw(t){const{gl:o}=this;t.n&&(o.bindFramebuffer(o.FRAMEBUFFER,null),o.viewport(0,0,o.drawingBufferWidth,o.drawingBufferHeight),o.enable(o.BLEND),o.blendFunc(o.ONE,o.ONE_MINUS_SRC_ALPHA),o.useProgram(this.program),o.uniform2f(this.uSize,o.drawingBufferWidth,o.drawingBufferHeight),o.bindVertexArray(this.vao),o.bindBuffer(o.ARRAY_BUFFER,this.buf),o.bufferData(o.ARRAY_BUFFER,t.data.subarray(0,t.n*st),o.DYNAMIC_DRAW),o.drawArraysInstanced(o.TRIANGLES,0,6,t.n),o.bindVertexArray(null))}}const Ne=`#version 300 es
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
}`,Oe=`#version 300 es
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
}`;class Ve{constructor(t){this.gl=t,this.program=wt(t,Ne,Oe),this.uSize=t.getUniformLocation(this.program,"u_size");const o=t.createBuffer();t.bindBuffer(t.ARRAY_BUFFER,o),t.bufferData(t.ARRAY_BUFFER,new Float32Array([0,0,1,0,0,1,0,1,1,0,1,1]),t.STATIC_DRAW),this.vao=t.createVertexArray(),t.bindVertexArray(this.vao),t.enableVertexAttribArray(0),t.vertexAttribPointer(0,2,t.FLOAT,!1,0,0),this.buf=t.createBuffer(),t.bindBuffer(t.ARRAY_BUFFER,this.buf);for(let a=0;a<3;a++)t.enableVertexAttribArray(1+a),t.vertexAttribPointer(1+a,4,t.FLOAT,!1,ft*4,a*16),t.vertexAttribDivisor(1+a,1);t.bindVertexArray(null)}gl;program;uSize;vao;buf;draw(t){const{gl:o}=this;t.n&&(o.enable(o.BLEND),o.blendFunc(o.ONE,o.ONE_MINUS_SRC_ALPHA),o.useProgram(this.program),o.uniform2f(this.uSize,o.drawingBufferWidth,o.drawingBufferHeight),o.bindVertexArray(this.vao),o.bindBuffer(o.ARRAY_BUFFER,this.buf),o.bufferData(o.ARRAY_BUFFER,t.data.subarray(0,t.n*ft),o.DYNAMIC_DRAW),o.drawArraysInstanced(o.TRIANGLES,0,6,t.n),o.bindVertexArray(null))}}function ot(e,t=[]){return[e.speed===void 0?Rt:{...Rt,value:e.speed},v("pitch","Grid pitch",e.pitch??4,2,12,1,"px"),v("dot","Dot size",e.dot??3,1,10,.5,"px"),vt("shape","Dot shape",["round","square"],e.shape??"square"),vt("mode","Mask",["brightness","halftone","dither"],e.mode??"brightness"),v("levels","Brightness steps",e.levels??0,0,8,1),v("base","Unlit dots",e.base??0,0,.3,.005),v("rim","Edge row",e.rim??.18,0,1,.01),v("modulate","Mask modulation",e.modulate??0,0,1,.01),v("scale","Noise size",e.scale??18,3,120,.5,"px"),v("warp","Warp",e.warp??1,0,3,.01),v("drift","Outward drift",e.drift??8,0,80,.5,"px/s"),v("depth","Band depth",e.depth??34,8,120,1,"px"),v("falloff","Falloff",e.falloff??.8,.2,4,.05),v("intensity","Intensity",e.intensity??1,0,3,.01),v("peak","Peak opacity",e.peak??.9,0,1,.01),vt("color","Colour",["session","mesh"],e.color??"session"),...t]}const Mt=`
vec3 meshTint(Fx f, vec3 col) {
  if (P_color < 0.5) return col;
  float h = vnoise(around(f, 140.0, -6.0, f.t * 0.05)) - 0.5;
  return hueRotate(col, h * 1.4);
}`,$e=[{id:"embers",name:"Ember clumps",note:"What busy frames showed in the app before Brian’s Brain (ember.ts, with these defaults). Tuned to look like Brian’s Brain, but continuous: two layers of fine noise crawl in opposite directions round the frame while drifting outward, and only their peaks light up, giving sparse bright clumps that thin out away from the edge and glide instead of stepping. Evaluated once per cell on the CPU.",params:ot(lt,[v("crawl","Crawl",lt.crawl,0,40,.5,"px/s"),v("sparse","Sparseness",lt.sparse,.4,.9,.005),v("dim","Dim clumps",lt.dim,0,1,.01)]),still:Me,dots:(e,t,o,a,n)=>e.fill(t,o,{...lt,...a},n)},{id:"smoke",name:"Smoke",note:"Slow domain-warped fbm (Inigo Quilez’s warping) sampled further inward as time passes, so soft tongues of smoke lift off every side and corner and dissolve as the falloff takes them; seen through 3px square dots as dithered speckle.",params:ot({scale:16,warp:1.1,drift:7,depth:36,falloff:.9,mode:"dither",rim:.2}),still:3,glsl:`${Mt}
float field(Fx f) {
  vec3 q = outward(f, P_scale, P_drift, 0.12);
  vec3 w = vec3(fbm(q + vec3(0.0, 0.0, f.t * 0.07)), fbm(q + vec3(5.2, 1.3, 2.8)), 0.0);
  float n = fbm(q + P_warp * (w - 0.5) * 2.0);
  return smoothstep(0.42, 0.8, n) * f.fall;
}
vec3 tint(Fx f, vec3 col, float v) { return meshTint(f, col); }`},{id:"fire",name:"Fire",note:"Quicker licking tongues: noise stretched away from the edge rises fast and is cut by height (the classic noise-minus-height flame), so it is hot and dense at the base and frays into sparks; the base shifts warm.",params:ot({scale:9,warp:.6,drift:26,depth:30,falloff:1,mode:"brightness",levels:0,rim:.3},[v("stretch","Tongue length",2.4,1,6,.05),v("warm","Warm shift",.45,0,1,.01)]),still:2,glsl:`
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
}`},{id:"mesh",name:"Mesh gradient",note:"Four large soft blobs of colour near the session hue orbit the frame at different speeds while the band breathes outward and back; brightness-masked dots turn the smooth mesh gradient into an LED glow.",params:ot({depth:32,falloff:1.2,mode:"brightness",levels:0,rim:.15,color:"mesh",scale:30,intensity:1.1},[v("orbit","Orbit speed",.04,0,.3,.005),v("breathe","Breathing",.25,0,.8,.01)]),still:5,glsl:`
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
}`},{id:"ink",name:"Ink wisps",note:"Thin wisps rather than blobs: doubly warped noise folded into ridges (1 − |2n − 1|, sharpened), flowing along and away from the edge like ink in water; halftone dots grow along each filament.",params:ot({scale:22,warp:1.6,drift:6,depth:40,falloff:.9,mode:"halftone",dot:3.5,shape:"round",rim:.15},[v("thin","Thinness",9,1,20,.1),v("flow","Flow along",5,-30,30,.5,"px/s")]),still:6,glsl:`${Mt}
float field(Fx f) {
  vec3 q = around(f, P_scale, P_flow, (f.d - f.t * P_drift) / P_scale);
  vec3 w1 = vec3(fbm(q + vec3(0.0, 0.0, f.t * 0.05)), fbm(q + vec3(5.2, 1.3, 2.8)), 0.0);
  vec3 w2 = vec3(fbm(q + P_warp * w1 + vec3(1.7, 9.2, f.t * 0.08)), fbm(q + P_warp * w1 + vec3(8.3, 2.8, 0.0)), 0.0);
  float n = fbm(q + P_warp * (w2 - 0.5) * 2.0);
  float ridge = pow(1.0 - abs(2.0 * n - 1.0), P_thin);
  return smoothstep(0.3, 0.9, ridge) * f.fall;
}
vec3 tint(Fx f, vec3 col, float v) { return meshTint(f, col); }`},{id:"aurora",name:"Aurora",note:"Curtains of light running round the perimeter: noise that is long away from the edge and short along it makes vertical streaks that slide round the frame, and a finer noise eats them from the outside, so they fray into specks.",params:ot({scale:10,drift:3,depth:40,falloff:.7,mode:"brightness",levels:0,rim:.2},[v("slide","Slide speed",10,-40,40,.5,"px/s"),v("fray","Fray",.7,0,1.5,.01)]),still:2.5,glsl:`${Mt}
float field(Fx f) {
  float curtain = fbm(around(f, P_scale, P_slide, f.d / (P_scale * 6.0) + f.t * 0.06));
  float rays = smoothstep(0.48, 0.8, curtain);
  float fine = vnoise(outward(f, P_scale * 0.5, P_drift * 3.0, 0.4));
  float keep = smoothstep(-0.15, 0.25, fine - P_fray * f.d / f.depth);
  return rays * pow(f.fall, 0.6) * keep * 1.2;
}
vec3 tint(Fx f, vec3 col, float v) { return meshTint(f, col); }`}],Q=8,We=`
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
`,Ht=`#version 300 es
layout(location = 0) in vec2 a_c;
void main() { gl_Position = vec4(a_c * 2.0 - 1.0, 0.0, 1.0); }`;function Ye(e,t){const o=/vec3\s+tint\s*\(/.test(t)?"":"vec3 tint(Fx f, vec3 col, float v) { return col; }";return`#version 300 es
precision highp float;
uniform vec4 u_cam;   // x, y (CSS px), zoom, dpr
uniform vec2 u_cell0; // grid cell of texel (0, 0)
uniform float u_t;
uniform int u_n;
uniform vec4 u_rect[${Q}];
uniform vec4 u_fr[${Q}]; // time offset, presence, fill, seed
uniform vec3 u_col[${Q}];
uniform float u_p[32];
out vec4 o;
${We}
${me(e)}
${t}
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
  for (int i = 0; i < ${Q}; i++) {
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
}`}const Xe=`#version 300 es
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
}`;class Ge{constructor(t,o){this.gl=t,this.quadVao=o;const a=wt(t,Ht,Xe);this.mask={program:a,u:Object.fromEntries(["u_field","u_cam","u_view","u_cell0","u_t","u_m0","u_m1"].map(n=>[n,t.getUniformLocation(a,n)]))},this.fbo=t.createFramebuffer(),this.tex=t.createTexture()}gl;quadVao;programs=new Map;mask;fbo;tex;tw=0;th=0;rects=new Float32Array(Q*4);fr=new Float32Array(Q*4);cols=new Float32Array(Q*3);program(t,o,a){let n=this.programs.get(t);if(!n){const i=wt(this.gl,Ht,Ye(o,a));n={program:i,u:Object.fromEntries(["u_cam","u_cell0","u_t","u_n","u_rect","u_fr","u_col","u_p"].map(l=>[l,this.gl.getUniformLocation(i,l)]))},this.programs.set(t,n)}return n}draw(t,o,a,n,i,r,l,c){const{gl:s}=this,m=t.dpr,p=Math.max(2,Math.round(r[0]*m)),h=Math.round(t.camera.x*m),x=Math.round(t.camera.y*m),f=[Math.floor(-h/p),Math.floor(-x/p)],R=Math.ceil(t.width*m/p)+2,k=Math.ceil(t.height*m/p)+2;(R!==this.tw||k!==this.th)&&(this.tw=R,this.th=k,s.bindTexture(s.TEXTURE_2D,this.tex),s.texImage2D(s.TEXTURE_2D,0,s.RGBA8,R,k,0,s.RGBA,s.UNSIGNED_BYTE,null),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_MIN_FILTER,s.NEAREST),s.texParameteri(s.TEXTURE_2D,s.TEXTURE_MAG_FILTER,s.NEAREST),s.bindFramebuffer(s.FRAMEBUFFER,this.fbo),s.framebufferTexture2D(s.FRAMEBUFFER,s.COLOR_ATTACHMENT0,s.TEXTURE_2D,this.tex,0),s.bindFramebuffer(s.FRAMEBUFFER,null),s.bindTexture(s.TEXTURE_2D,null));const{program:B,u:S}=this.program(o,a,n),C=c.slice(0,Q);C.forEach((d,M)=>{this.rects.set([d.box.x,d.box.y,d.box.w,d.box.h],M*4),this.fr.set([d.offset,d.presence,d.fill,M+1],M*4),this.cols.set(d.color,M*3)});const A=s.getParameter(s.VIEWPORT),D=s.getParameter(s.FRAMEBUFFER_BINDING);s.activeTexture(s.TEXTURE0),s.bindTexture(s.TEXTURE_2D,null),s.bindFramebuffer(s.FRAMEBUFFER,this.fbo),s.viewport(0,0,R,k),s.disable(s.BLEND),s.useProgram(B),s.uniform4f(S.u_cam,t.camera.x,t.camera.y,t.camera.z,m),s.uniform2f(S.u_cell0,f[0],f[1]),s.uniform1f(S.u_t,l),s.uniform1i(S.u_n,C.length),s.uniform4fv(S.u_rect,this.rects),s.uniform4fv(S.u_fr,this.fr),s.uniform3fv(S.u_col,this.cols),s.uniform1fv(S.u_p,i),s.bindVertexArray(this.quadVao),s.drawArrays(s.TRIANGLES,0,6),s.bindFramebuffer(s.FRAMEBUFFER,D),s.viewport(A[0],A[1],A[2],A[3]),s.enable(s.BLEND),s.blendFunc(s.ONE,s.ONE_MINUS_SRC_ALPHA);const u=this.mask;s.useProgram(u.program),s.activeTexture(s.TEXTURE0),s.bindTexture(s.TEXTURE_2D,this.tex),s.uniform1i(u.u.u_field,0),s.uniform4f(u.u.u_cam,t.camera.x,t.camera.y,t.camera.z,m),s.uniform2f(u.u.u_view,t.width,t.height),s.uniform2f(u.u.u_cell0,f[0],f[1]),s.uniform1f(u.u.u_t,l),s.uniform4f(u.u.u_m0,r[0],r[1],r[2],r[3]),s.uniform4f(u.u.u_m1,r[4],r[5],r[6],r[7]),s.drawArrays(s.TRIANGLES,0,6),s.bindTexture(s.TEXTURE_2D,null),s.bindVertexArray(null)}}const He=[{id:"brain",name:"Brian’s Brain",note:"What busy frames show in the app (render/busy/brain.ts, with these defaults). A band round the frame runs Brian’s Brain, a three-state automaton (firing, dying, off): the edge row sparks at random and the rule turns the sparks into tiny gliders that crawl along and out of the band, firing bright and dying dim.",params:[{...Rt,value:V.speed},v("cell","Cell",V.cell,1,10,1,"px"),v("gap","Gap",V.gap,0,4,1,"px"),v("depth","Band depth",V.depth,1,16,1,"cells"),v("step","Step",V.step,.03,.3,.01,"s"),v("spark","Edge sparks",V.spark,0,.3,.005),v("dying","Dying cells",V.dying,0,1,.01),v("base","Edge glow",V.base,0,1,.01),v("falloff","Falloff",V.falloff,.2,4,.05),v("peak","Intensity",V.peak,0,1,.01),vt("color","Colour",["session","white"],V.color)],still:xe,blocks:(e,t,o,a,n)=>e.fill(t,o,{...V,...a},n)}],tt=[...$e,...He],gt=[kt("enabled","Resolve when done",pt.enabled),v("fill","Fill",pt.fill,.05,.6,.01,"s"),v("hold","Hold",pt.hold,0,1,.01,"s"),v("fade","Fade",pt.fade,.1,1.5,.05,"s")],_t=[kt("reduced","Reduced motion",matchMedia("(prefers-reduced-motion: reduce)").matches),kt("desync","Offset frames in time",!0)],g=fe({site:"busy",title:"Busy",storageKey:"canvas-playground-busy-v7",defaults:()=>({variant:tt[0].id,params:Object.fromEntries(tt.map(e=>[e.id,bt(e.params)])),options:bt(_t),done:bt(gt),frames:de()}),restore(e,t){Se(e,t,tt,_t),e.d&&(t.done=Et(gt,{...t.done,...e.d})),Array.isArray(e.f)&&(t.frames=t.frames.map((o,a)=>{const[n,i]=e.f[a]??[];return he(o,{working:n===void 0?void 0:!!n,color:i})}))},share:e=>({...Be(e,tt,_t),d:Object.fromEntries(Object.entries(e.done).filter(([t,o])=>gt.find(a=>a.key===t).value!==o)),f:e.frames.map(t=>[t.working?1:0,t.color])}),exportJson:e=>{const t=tt.find(o=>o.id===e.variant);return{site:"busy",variant:{id:t.id,name:t.name,params:e.params[t.id]},done:e.done}}}),{settings:y}=g,ht=()=>tt.find(e=>e.id===y.variant),Zt=()=>g.setCaption(ht().name,ht().note);Ie(g,tt,()=>y.variant,e=>{y.variant=e,je.render(),Zt(),g.save()});const je=qe(g,"Parameters",()=>ht().params,()=>y.params[y.variant],g.save,()=>y.params[y.variant]=bt(ht().params));g.section("Done",ct("Finish all",()=>y.frames.forEach((e,t)=>at(t,!1)),"ghost",!0)).append(...gt.map(e=>Bt(e,y.done,g.save)));let qt=0;const te=y.frames.map(()=>-1/0),ee=y.frames.map(()=>!1);function at(e,t){const o=y.frames[e];o.working!==t&&(ee[e]=o.working&&!t,o.working=t,te[e]=qt,oe(),g.save())}const Ke=g.section("Frames");function oe(){Ke.replaceChildren(...Ue(y.frames,(e,t)=>{const o=ue(e.working,a=>at(t,a));return o.setAttribute("aria-label",`${e.title} is working`),o.dataset.frame=String(t),[o]},()=>g.save()),xt("div","pg-buttons",ct("Randomise",()=>y.frames.forEach((e,t)=>at(t,Math.random()<.6)),"",!0),ct("All working",()=>y.frames.forEach((e,t)=>at(t,!0)),"",!0),ct("All done",()=>y.frames.forEach((e,t)=>at(t,!1)),"",!0)))}oe();ze(g,"Preview",_t,y.options,g.save);Zt();function Ft(e){const t={working:!!y.frames[e].working,since:te[e],finished:ee[e]};return ie(t,qt,y.done,!!y.options.reduced)}const Qe=new Ce(g.gl.gl),Pt=new be;let zt=0,ae=!1;const se=e=>{qt+=e,y.options.reduced||(zt+=e*y.params[y.variant].speed)};g.onTick(e=>{ae||se(e)});const Je=new Ge(g.gl.gl,g.gl.quadVao),jt=new Float32Array(32),Ze=new Ve(g.gl.gl),St=new Fe;g.onDraw(e=>{const t=ht(),o=y.params[t.id],{dpr:a,camera:n}=e,i=n.z,r=!!y.options.reduced,l=p=>y.options.desync?p*1.618:0,c=r?t.still:zt,s=t.dots?()=>{const p=g.layout.sections.map((h,x)=>{const[f,R]=Ft(x);return{box:h.box,color:At(y.frames[x].color),offset:r?0:l(x)+x*37,seed:x+1,presence:f,fill:R}});t.dots(St,{x:n.x,y:n.y,z:i,width:e.width,height:e.height,dpr:a},p,o,c),Ze.draw(St)}:t.glsl?()=>{pe(t.params,o,jt);const p=g.layout.sections.map((x,f)=>{const[R,k]=Ft(f);return{box:x.box,color:At(y.frames[f].color),offset:r?0:l(f)+f*37,presence:R,fill:k}}),h=[o.pitch,o.dot,o.shape==="square"?1:0,["brightness","halftone","dither"].indexOf(o.mode),o.levels,o.base,o.peak,o.modulate];Je.draw(e,t.id,t.params,t.glsl,jt,h,c,p)}:void 0;if(g.gl.draw(e,g.layout.sections.map(p=>({box:p.box})),[...g.layout.items.values()],s),!t.blocks)return;const m=g.layout.sections.map((p,h)=>{const[x,f]=Ft(h);return{key:`${t.id}:${h}`,box:p.box,color:At(y.frames[h].color),offset:r?0:l(h),seed:h+1,presence:x,fill:f}});t.blocks(Pt,{x:n.x,y:n.y,z:i,width:e.width,height:e.height,dpr:a},m,o,c),Qe.draw(Pt)});Object.assign(g.playground,{time:()=>zt,blocks:()=>Pt.n,dots:()=>St.n,select:e=>document.querySelector(`[role="option"][data-id="${e}"]`)?.click(),setWorking:e=>e.forEach((t,o)=>at(o,t)),pause:e=>ae=e,advance:se});
