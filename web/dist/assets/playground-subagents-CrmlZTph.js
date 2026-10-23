import{a as ze,L as At,B as Vt}from"./layout-D5L6uoqV.js";import{ak as qe,al as Te,s as qt,a1 as Fe,b as Ne,c as ie,am as B,an as ye,ao as Ge,ap as Be,aq as Xe,ar as ct,as as wt,r as je,a8 as He,a9 as re,at as Ke,au as De,av as Ue,aw as We}from"./styles-Bzz4IwfQ.js";import{c as Ot,r as It,a as L,t as vt,s as jt,f as it,j as Ht}from"./params-scS7024I.js";import{e as M,h as Ye,B as Je,b as tt,l as Ve,p as Gt,S as Qe,i as Ze,j as to,k as eo}from"./shell-7tC7-Ydv.js";function oo(t){const e=t.defaults();try{t.restore(JSON.parse(localStorage.getItem(t.storageKey)??"{}"),e)}catch{}try{const g=/[#&]s=([^&]+)/.exec(location.hash);g&&t.restore(JSON.parse(decodeURIComponent(g[1])),e)}catch(g){console.warn("ignoring an unreadable settings hash",g)}let o=0;const a=()=>{clearTimeout(o),o=window.setTimeout(()=>{const g=JSON.stringify(t.share(e));localStorage.setItem(t.storageKey,g),history.replaceState(null,"",`#s=${encodeURIComponent(g)}`)},150)};document.title=`${t.title} · Frame status playground`;const n=M("div","pg-app"),i=M("nav","c-tabs");i.setAttribute("aria-label","Playgrounds");for(const g of Ye){const P=M("a","",g.name);P.href=g.href,g.id===t.site&&P.setAttribute("aria-current","page"),i.append(P)}const r=M("a","pg-brand","Frame status");r.href=`${Je}/playground`;const s=M("span","pg-readout pg-fps");s.title="Frames per second";const l=M("span","pg-readout pg-zoom");l.title="Zoom";const f=M("div","pg-toolbar",r,i,M("span","pg-spacer"),s,l),x=M("div","pg-demo");x.tabIndex=0;const w=M("div","pg-caption");x.append(w);const d=M("main","pg-main",f,x),m=M("div","pg-panel-body"),p=tt("Copy settings",()=>{v()},"primary",!0),k=M("aside","pg-panel",M("header","pg-panel-head",M("h1","",t.title),p),m);n.append(d,k),document.body.append(n);async function v(){const g=JSON.stringify(t.exportJson(e),null,2);try{await navigator.clipboard.writeText(g)}catch{const P=M("textarea");P.value=g,document.body.append(P),P.select(),document.execCommand("copy"),P.remove()}console.log(g),p.textContent="Copied",setTimeout(()=>p.textContent="Copy settings",1200)}window.playgroundSettings=()=>t.exportJson(e);function I(g,P){const _=M("div","pg-stack"),H=M("div","pg-section-head",M("h2","",g));return P&&H.append(P),m.append(M("section","pg-section",H,_)),_}function T(g,P){w.replaceChildren(M("b","",g),M("span","",P)),w.title=P}const C=[];let h=performance.now();const y=[];let $=0;const F=g=>{requestAnimationFrame(F);const P=Math.max(0,Math.min(100,g-h));if(h=g,y.push(P),y.length>60&&y.shift(),g-$>500&&y.length>5){$=g;const _=1e3/(y.reduce((H,G)=>H+G,0)/y.length);s.textContent=`${Math.round(_)} fps`,s.dataset.fps=String(_)}for(const _ of C)try{_(P,g)}catch(H){console.error(H)}};return requestAnimationFrame(F),{settings:e,save:a,section:I,setCaption:T,demo:x,toolbar:f,panelBody:m,setZoom:g=>l.textContent=`${Math.round(g*100)}%`,onTick:g=>C.push(g)}}function no(t,e,o,a){const n=Ve(e.map((i,r)=>({id:i.id,name:i.name,key:String(r+1),title:i.note})),o,a,"Variation");return t.section("Variation").append(n.el),window.addEventListener("keydown",i=>{if(i.target.closest('input, textarea, [role="slider"]')||i.metaKey||i.ctrlKey||i.altKey)return;const r=Number(i.key)-1;Number.isInteger(r)&&r>=0&&r<e.length&&n.select(e[r].id)}),n}function ao(t,e,o,a,n,i){const r=tt("Reset",()=>{i(),l(),n()},"ghost",!0),s=t.section(e,r),l=()=>s.replaceChildren(...o().map(f=>Gt(f,a(),n,Qe)));return l(),{render:l}}function so(t,e,o){const a=e??{};for(const n of t)a[n.id]&&(o[n.id]=It(n.params,{...o[n.id],...a[n.id]}))}function io(t,e){const o={};for(const a of t){const n=Ot(a.params,e[a.id]);Object.keys(n).length&&(o[a.id]=n)}return o}const dt=24;class ro{constructor(e,o,a,n){this.editor=o,this.orbs=a,this.actions=n,this.host=document.createElement("div"),this.host.className="sa-chrome",e.appendChild(this.host),this.rows=new qe(this.host,a,n),this.wires=document.createElementNS("http://www.w3.org/2000/svg","svg"),this.wires.classList.add("sa-wires"),this.host.insertBefore(this.wires,this.host.firstChild)}editor;orbs;actions;host;heads=new Map;links=new Map;wires;styleCache=new WeakMap;rows;get text(){return this.rows.text}get animating(){return this.rows.animating}get alive(){return this.rows.alive}get drawn(){return this.rows.drawn}anchor(e,o,a){return this.rows.anchor(e,o,a)}hover(e,o){return this.rows.hover(e,o)}css(e,o){this.styleCache.get(e)!==o&&(this.styleCache.set(e,o),e.style.cssText=o)}draw(e,o,a,n,i,r){const s=this.editor.camera.peek(),{w:l,h:f}=this.editor.viewport.peek(),x=h=>Math.round(h*r)/r,w=n.tech,d=n.p,m=Number(d.size),p=x(w.anchor==="baseline"?dt/2+.363*n.titlePx:dt/2);this.rows.begin(i);const k=new Set,v=h=>({x:(h.x+s.x)*s.z,y:(h.y+s.y)*s.z,w:h.w*s.z,h:h.h*s.z}),I=e.cards.filter(h=>h.fit==="overlay"&&h.opacity>.01).map(h=>({c:h,b:v(h.box)})),T=new Map;for(const h of e.heads){const y=o.get(h.id);if(!y)continue;const $=x((h.box.x+s.x)*s.z),F=x((h.box.y+s.y)*s.z),g=h.inCard?h.box.w*s.z:h.parentId?Math.max(h.box.w*s.z,Math.min(300,h.box.w*s.z*2.5)):h.box.w*s.z;let P=0;for(const{c:b,b:E}of I)b.parentId===h.id||b.parentId===h.parentId||b.id===h.id||$<E.x+E.w&&$+g>E.x&&F<E.y+E.h&&F+dt>E.y&&(P=Math.max(P,b.opacity));const _=h.opacity*(1-P),H=w.anchor==="baseline"?Number(d.height??0):0,G=_>.01&&$<l&&$+g>0&&F-H<f&&F+dt+40>0&&g>24;let A=this.heads.get(h.id);if(!G){A&&this.css(A.el,"display:none");continue}k.add(h.id),A||(A=this.createHead(h.id),this.heads.set(h.id,A));const c=a.get(h.id),u=y.child?this.text.width(y.agent??"",500,n.titlePx)+5+this.text.width(y.task??"",600,n.titlePx):this.text.width(y.title,600,n.titlePx);let z=Math.min(u,g);if(c&&c.kids.length){this.rows.element(h.id,A.el),A.row=!0,z=this.rows.layout(h.id,c,n,u,g,i);const b=F+p;T.set(h.id,{px:$,y:b}),this.rows.draw(h.id,c,n,{px:$,y:b,w:g,opacity:_,anchorY:p,dpr:r,vw:l},i)}else A.row&&(this.rows.remove(h.id),A.row=!1);let K=y.status??"";if(h.inCard){const b=g-30;K&&u+this.text.width(K,500,12)+10>b&&(K=""),z=Math.max(0,Math.min(u,b))}this.fillHead(A,{...y,status:K},z,h.inCard),this.css(A.el,`transform:translate(${$}px,${F}px);width:${Math.max(0,Math.floor(g))}px;opacity:${_.toFixed(3)};--title:${n.titlePx}px;--status-x:${Math.ceil(z)+8}px`)}for(const[h,y]of this.heads)k.has(h)||this.css(y.el,"display:none");this.drawLinks(e.cards,T,p,m,i,x);const C=[Math.round(s.x*s.z*r),Math.round(s.y*s.z*r),Math.max(2,Math.round(5*r)),Math.max(1,Math.floor(2*r+.5))];this.rows.end(n,r,C,i)}createHead(e){const o=document.createElement("div");return o.className="sa-head",o.dataset.session=e,o.innerHTML='<span class="title"></span>',this.host.insertBefore(o,this.host.firstChild),{el:o,title:o.firstChild,key:"",row:!1,status:null,close:null}}fillHead(e,o,a,n){if(this.css(e.title,`max-width:${Math.max(0,Math.ceil(a))}px`),n&&!e.close?(e.status=document.createElement("span"),e.status.className="status",e.close=document.createElement("button"),e.close.type="button",e.close.className="sa-close",e.close.textContent="×",e.close.setAttribute("aria-label",`Collapse ${o.title}`),e.close.addEventListener("pointerdown",r=>r.stopPropagation()),e.close.addEventListener("click",r=>(r.stopPropagation(),this.actions.toggleKid(o.id,!0))),e.el.append(e.status,e.close)):!n&&e.close&&(e.status?.remove(),e.close.remove(),e.status=e.close=null),e.el.classList.toggle("in-card",n),e.status){const r=o.status??"";e.status.textContent!==r&&(e.status.textContent=r);const s=`status ${o.statusKind??""}`;e.status.className!==s&&(e.status.className=s)}const i=`${o.title}|${o.child}`;e.key!==i&&(e.key=i,e.el.classList.toggle("child",o.child),o.child?e.title.innerHTML='<span class="agent"></span><span class="task"></span>':e.title.innerHTML='<span class="task"></span>',o.child&&(e.title.firstChild.textContent=o.agent??""),e.title.lastChild.textContent=o.child?o.task??"":o.title)}drawLinks(e,o,a,n,i,r){const s=this.editor.camera.peek(),l=new Set,f=new Map,x=new Map;for(const d of e)d.fit!=="drawer"&&x.set(d.parentId,[...x.get(d.parentId)??[],d]);for(const d of x.values())d.sort((m,p)=>m.orbX-p.orbX).forEach((m,p)=>f.set(m.id,{i:p,n:d.length}));const w=new Map;for(const d of e)d.fit==="drawer"&&d.caret>.01&&(!w.has(d.parentId)||d.box.y<w.get(d.parentId).box.y)&&w.set(d.parentId,d);for(const d of e){const m=o.get(d.parentId);if(!m||d.caret<.01||d.fit==="drawer"&&w.get(d.parentId)!==d)continue;const p=this.anchor(d.parentId,d.id,i),k=m.px+(p??40),v=(d.orbX+s.x)*s.z,I=r((d.box.y+s.y)*s.z),T=(d.box.x+s.x)*s.z,C=d.box.w*s.z,h=d.caret,y=r(Math.max(T+12,Math.min(T+C-12,v)));let $=this.links.get(d.id);if(!$){const A=document.createElement("div");A.className="sa-caret",A.style.setProperty("--fill",Te.frame),this.host.insertBefore(A,this.wires.nextSibling);const c=document.createElementNS("http://www.w3.org/2000/svg","path");this.wires.appendChild(c),$={caret:A,wire:c},this.links.set(d.id,$)}l.add(d.id);const F=h;this.css($.caret,`transform:translate(${y-6}px,${I-6}px) scale(${(.4+.6*h).toFixed(3)}) rotate(45deg);opacity:${F.toFixed(3)}`);const g=r(m.y+n/2+3),P=I-8,_=r(k);let H="";if(P-g>2)if(Math.abs(y-_)<1)H=`M${_} ${g}V${P}`;else{const A=f.get(d.id),c=A&&A.n>1?Math.round(Math.max(g+3,P-4-(A.n-1-A.i)*Math.min(4,(P-g-7)/Math.max(1,A.n-1)))):Math.round((g+P)/2),u=Math.min(4,Math.abs(y-_)/2,(P-g)/4),z=Math.sign(y-_);H=`M${_} ${g}V${c-u}Q${_} ${c} ${_+z*u} ${c}H${y-z*u}Q${y} ${c} ${y} ${c+u}V${P}`}$.wire.getAttribute("d")!==H&&$.wire.setAttribute("d",H);const G=F.toFixed(3);$.wire.getAttribute("opacity")!==G&&$.wire.setAttribute("opacity",G)}for(const[d,m]of this.links)l.has(d)||(m.caret.remove(),m.wire.remove(),this.links.delete(d))}orbCentre(e){return this.rows.orbCentre(e,this.host)}destroy(){this.host.remove()}}const co=[{key:"coordinator",title:"Canvas build: coordinator",color:"#60a5fa",busy:!0,agent:"build",unread:2,asking:!1,shots:[1.6,1.33,1.78,1,1.5,1.2,1.6,.8],count:14,kids:[["Explore: render loop","running",[1.5]],["General: subagent frames demo","running",[1.78,1.33]],["Explore: competitor heroes","done",[{a:4.2,w:4200},1.78]],["General: fix flaky upload test","done",[1.6,1.2]],["General: mobile onboarding","done",[{a:.5,w:900},1.33]],["Review: page items","failed",[1.33]],["Explore: auth flow","waiting",[1.5,1]],["General: HTML side drawer","done",[1.78,1.5]],["General: precise highlights","done",[1.6]],["Explore: ember band timing","running",[1.78]],["Review: frame chrome copy","done",[1.5]],["General: link cards","done",[1.33,1.6]],["Explore: WebGPU fallbacks","done",[1.6]],["General: unread badge","done",[1.2]],["Explore: video seek latency","running",[1.78]],["General: share dialog","done",[1.5]],["Review: keyboard shortcuts","done",[1.33]],["General: canvas list previews","done",[1.6]],["Explore: Safari texture upload","done",[1.5]],["General: presence bar","done",[1.78]]]},{key:"hero",title:"Landing hero explorations",color:"#f472b6",busy:!1,agent:"build",unread:0,asking:!0,shots:[1.78,1.78,1.5,1.33],kids:[["General: hero variants, round 3","running",[1.78,1.78]],["Explore: brand assets","done",[1.33,1,1.5]],["Review: contrast pass","done",[1.5]]]},{key:"shader",title:"Shader study: rounded SDF",color:"#a78bfa",busy:!1,agent:"plan",unread:0,asking:!1,shots:[1.33,1,1.5,.8],kids:[]},{key:"video",title:"Perf: video pool",color:"#2dd4bf",busy:!0,agent:"build",unread:1,asking:!1,shots:[2.4,1.78,1.2],kids:[["Explore: map video pool","done",[1.5]],["General: decoder reuse","running",[1.78,1.6]],["General: frame pacing traces","running",[2.2]],["Review: memory","done",[1.33]],["Explore: importExternalTexture","done",[1.6]],["General: poster frames","done",[1.5,1.2]],["Explore: seek latency","done",[1.78]],["Review: leak check","failed",[1.33]]]},{key:"flaky",title:"Fix flaky upload test",color:"#fb923c",busy:!1,agent:"build",unread:0,asking:!1,shots:[2.2,1.6],kids:[["Explore: find the race","done",[1.6]]]}];function lo(t,e){const o=`ses_demo${t}`;for(let a=0;a<1e3;a++){const n=`${o}${a.toString(36)}`.padEnd(30,"0").slice(0,30);if(qt(n)===e)return n}return o.padEnd(30,"0").slice(0,30)}function Ut(t){return()=>{t|=0,t=t+1831565813|0;let e=Math.imul(t^t>>>15,1|t);return e=e+Math.imul(e^e>>>7,61|e)^e,((e^e>>>14)>>>0)/4294967296}}function fo(t){const e=parseInt(t.slice(1),16),o=(e>>16&255)/255,a=(e>>8&255)/255,n=(e&255)/255,i=Math.max(o,a,n),r=Math.min(o,a,n);if(i===r)return 0;const s=i-r;return(i===o?(a-n)/s+(a<n?6:0):i===a?(n-o)/s+2:(o-a)/s+4)*60}async function ho(t,e,o){const n=Math.round(o>=1?Math.min(1280,640*Math.min(o,2)):640*o),i=Math.round(n/o),r=new OffscreenCanvas(n,i),s=r.getContext("2d"),l=e+(t()-.5)*70,f=l+20+t()*50,x=18+t()*22,w=s.createLinearGradient(0,0,n*t(),i);if(w.addColorStop(0,`hsl(${l} ${x}% ${16+t()*10}%)`),w.addColorStop(1,`hsl(${f} ${x+6}% ${26+t()*14}%)`),s.fillStyle=w,s.fillRect(0,0,n,i),t()<.45){const m=n*(.25+t()*.5),p=i*(.3+t()*.4),k=Math.min(n,i)*(.25+t()*.2),v=s.createRadialGradient(m,p,0,m,p,k);v.addColorStop(0,`hsl(${f+30} ${x+14}% ${50+t()*14}% / 0.75)`),v.addColorStop(1,`hsl(${f+30} ${x}% 40% / 0)`),s.fillStyle=v,s.fillRect(0,0,n,i)}else{const m=Math.min(n,i)/20;s.fillStyle="rgba(255,255,255,0.07)",s.fillRect(0,0,n,m*2),s.fillStyle="rgba(255,255,255,0.14)";const p=n*.08;let k=i*(.22+t()*.1);for(let v=0;v<4&&k<i*.85;v++)s.fillRect(p,k,n*(.25+t()*.5)*(v?.8:1),m*(v?.7:1.3)),k+=m*(v?1.6:2.6),s.fillStyle="rgba(255,255,255,0.08)";t()<.6&&(s.fillStyle=`hsl(${f+40} ${x+20}% 58% / 0.55)`,s.beginPath(),s.roundRect(p,Math.min(i-m*3,k+m),n*.16,m*1.6,m*.4),s.fill())}const d=await r.convertToBlob({type:"image/png"});return URL.createObjectURL(d)}async function po(t="playground"){const e=[],o=[],a=[],n=[];let i=1e6;const r=(l,f,x,w)=>{const d=Ut(w),m=fo(f);x.forEach((p,k)=>{const v=typeof p=="number"?p:p.a,I=typeof p=="number"?Math.round(1e3*v):p.w??Math.round(1e3*v),T={id:`${l}-i${k}`,canvasId:t,sessionId:l,kind:"image",name:`shot-${k+1}.png`,src:"",thumb:"",width:I,height:Math.round(I/v),createdAt:i--};o.push(T),n.push(ho(d,m,v).then(C=>{T.src=C,T.thumb=C}))})},s=Ut(7);return co.forEach((l,f)=>{const x=lo(l.key,l.color);e.push({id:x,canvasId:t,title:l.title,createdAt:1e3+f}),r(x,l.color,l.shots,100+f);const w=l.kids.map(([d,m,p],k)=>{const v=`${x.slice(0,22)}k${String(k).padStart(2,"0")}`.padEnd(30,"0");e.push({id:v,canvasId:t,title:d,createdAt:2e3+f*40+k}),r(v,qt(v),p,1e3+f*50+k);const[I,...T]=d.split(": "),C=m==="running"||m==="waiting"?20+s()*150:200+s()*900,h=m==="running"||m==="waiting"?C:40+s()*160;return{id:v,title:d,agent:I,task:T.join(": ")||d,state:m,startedAgo:C,ran:h}});a.push({parentId:x,title:l.title,color:qt(x),busy:l.busy,agent:l.agent,unread:l.unread,asking:l.asking,kids:w,count:l.count??w.length})}),await Promise.all(n),{sessions:e,items:o,families:a}}class uo extends Fe{plan=Ne("plan",null);naturalLayout=ie("naturalLayout",()=>ze(this.sessions.get(),this.items.get(),this.sessionOrder.get(),this.itemLimits.get()));layout=ie("layout",()=>this.plan.get()?.layout??this.naturalLayout.get())}const mo=typeof matchMedia=="function"&&matchMedia("(prefers-reduced-motion: reduce)").matches,yt=[L("title","Title size",14,12,20,1,"px"),L("max","Before +N",8,2,20,1),vt("reduced","Reduced motion",mo),vt("busy","Busy band",!0)],kt=[jt("fit","Fit",["overlay","push","drawer","below"],"push"),jt("switch","Switching",["morph","swap"],"morph"),L("scale","Scale",1,.4,1,.01,"×"),L("dur","Duration",360,0,1400,10,"ms"),jt("ease","Easing",["standard","decelerate","in-out"],"standard"),L("stagger","Stagger",40,0,120,5,"ms")],Mt=[vt("preview","Preview on hover",!0),vt("unread","New-item badges",!0),vt("group","Group by state",!1)],ke=["0","1","3","8","15","20"],ce=72,le=12,de=30,go=14,wo=8,bo=40,Lt={overlay:1,push:.55,drawer:.35,below:0};function xo(t){const{natural:e,zoom:o,m:a}=t,n=At,i=n.frameHeaderHeight,r={sections:[],groups:[],items:new Map,sectionOf:e.sectionOf,groupOf:e.groupOf,bounds:null},s=[],l=[],f=new Map(e.sections.map(d=>[d.id,d])),x=(a.head+a.headGap)/o;let w=0;for(const d of e.sections){if(t.childIds.has(d.id))continue;const m=(t.families.get(d.id)??[]).filter(C=>C.open>5e-4&&f.has(C.id)),p={x:w,y:0,w:d.box.w,h:d.box.h-i},k={x:p.x,y:p.y-x,w:p.w,h:a.head/o};if(s.push({id:d.id,parentId:null,box:k,frame:p,opacity:1,inCard:!1}),t.fit==="below"){const C=vo(t,d,p,m,r.items,s),h=nt(e,d,p.x,0,1,r.items);h.box=p,h.header=k,r.sections.push(...C.sections,h),w=C.right+n.frameGap;continue}const v=yo(t,d,p,m,r.items,s,l),I=nt(e,d,p.x,p.y+v.room,1,r.items);I.box={...p,w:Math.max(p.w,v.width),h:p.h+v.room},I.header=k;const T=s.find(C=>C.id===d.id);T.frame=I.box,T.box={...k,w:I.box.w},r.sections.push(...v.sections,I),w=p.x+Math.max(p.w,v.reach)+n.frameGap}return r.groups=r.sections.flatMap(d=>d.groups),r.bounds=Vt.union(r.sections.flatMap(d=>[d.box,d.header])),{layout:r,heads:s,cards:l,zoom:o}}function vo(t,e,o,a,n,i){const{natural:r,zoom:s,m:l}=t,f=At.frameHeaderHeight,x=new Map(r.sections.map(v=>[v.id,v])),w=(l.head+l.headGap)/s,d=v=>B(v.open/.5),m=[];let p=o.x+o.w,k=o.y+o.h;for(const v of a){const I=x.get(v.id),T=I.box.h-f,C=t.childScale,h=k+ce+w;k+=(ce+w+T*C)*d(v),p=Math.max(p,o.x+o.w+(Math.max(o.w,I.box.w*C)-o.w)*d(v));const y=B((v.open-.5)/.5),$=nt(r,I,o.x,h+(1-y)*(12/s),C*(.98+.02*y),n);$.opacity=y,$.header={x:$.box.x,y:$.box.y-w,w:$.box.w,h:l.head/s},i.push({id:I.id,parentId:e.id,box:$.header,frame:$.box,opacity:y,inCard:!1}),m.push($)}return{sections:m,right:p}}function yo(t,e,o,a,n,i,r){const{natural:s,zoom:l,fit:f}=t,x=At,w=x.frameHeaderHeight,d=new Map(s.sections.map(c=>[c.id,c])),m=t.childScale,p=Math.min(x.framePadding,le/l),k=o.y+le/l,v=go/l,I=Math.max(0,bo/l-x.framePadding*m),T=c=>{const u=t.anchor(e.id,c);return o.x+(u??40)/l},C=a.map(c=>{const u=d.get(c.id),z=u.box.w*m;return{kid:c,c:u,w:z,h:I+(u.box.h-w)*m,dy:I,left:0,top:k,orbX:T(c.id)}}),h=[],y=o.x+p,$=f==="drawer";let F=0,g=o.w;if($){const c=Math.max(o.w-p*2,...C.map(b=>b.w)),u=C.length===2&&t.morph?fe(C):null;if(u){const b=u.to.kid.open,E={x:y,y:k,w:c,h:u.from.h+(u.to.h-u.from.h)*b},W=B((b-.1)/.5),lt=1-B((b-.6)/.25),Y=Math.min(1,E.h/u.from.h),J=Math.min(1,E.h/u.to.h),V=nt(s,u.from.c,y,k+u.from.dy*Y,m*Y,n),ot=nt(s,u.to.c,y,k+u.to.dy*J,m*J,n);for(const[$t,Oe,Ie]of[[V,lt,1-B(b/.4)],[ot,W,B((b-.5)/.5)]])$t.box=E,$t.header={x:E.x,y:E.y,w:E.w,h:0},$t.opacity=Oe,i.push(_t($t.id,e.id,E,m,l,Ie));const rt=u.from.orbX+(u.to.orbX-u.from.orbX)*b;return h.push({card:{id:u.from.c.id,parentId:e.id,box:E,orbX:rt,opacity:1,shadow:0,caret:0,open:1,fit:f},section:V,to:0}),h.push({card:{id:u.to.c.id,parentId:e.id,box:E,orbX:rt,opacity:1,shadow:Lt.drawer,caret:1,open:1,fit:f},section:ot,to:1}),{sections:Kt(h,r),room:E.y+E.h-o.y,width:Math.max(o.w,c+p*2),reach:Math.max(o.w,c+p*2)}}let z=k,K=0;for(const b of C){const E=b.kid.open,W=1-(1-B(E/.75))**2,lt=B((E-.55)/.45),Y=b.h*W,J={x:y,y:z,w:c,h:Y},V=nt(s,b.c,y,z+b.dy,m,n);V.box=J,V.header={x:J.x,y:J.y,w:J.w,h:0},V.opacity=lt,i.push(_t(b.c.id,e.id,J,m,l,lt));const ot=B(E/.25);h.push({card:{id:b.c.id,parentId:e.id,box:J,orbX:b.orbX,opacity:ot,shadow:Lt.drawer*ot,caret:ot*B((E-.1)/.4),open:E,fit:f},section:V,to:b.kid.to}),z+=(Y+v)*W,K=Math.max(K,W)}return F=Math.max(0,z-k+(k-o.y-v)*K),g=Math.max(o.w,c+p*2),{sections:Kt(h,r),room:F,width:g,reach:g}}const P=o.x+o.w-p,_=C.filter(c=>c.kid.to>.5);let H=y;for(const c of _)c.left=Math.max(c.orbX-de/l,H),H=c.left+c.w+v;if(_.length){const c=_[_.length-1],u=c.left+c.w-P,z=u>0?Math.min(u,_[0].left-y):0;for(const K of _)K.left-=z}for(const c of _)t.memo.set(c.kid.id,{dx:c.left-o.x,dy:c.top-o.y,w:c.w,h:c.h});for(const c of C){if(c.kid.to>.5)continue;const u=t.memo.get(c.kid.id);u?(c.left=o.x+u.dx,c.top=o.y+u.dy):c.left=Math.max(y,Math.min(c.orbX-de/l,P-c.w))}const G=t.morph&&_.length===1?fe(C):null,A=G&&t.memo.get(G.from.kid.id);if(G&&A){const c=G.to.kid.open,u=G.to,z=o.x+A.dx,K=o.y+A.dy,b={x:z+(u.left-z)*c,y:K+(u.top-K)*c,w:A.w+(u.w-A.w)*c,h:A.h+(u.h-A.h)*c},E=B((c-.1)/.5),W=1-B((c-.6)/.25),lt=G.from.orbX+(u.orbX-G.from.orbX)*c;for(const[Y,J,V]of[[G.from,W,0],[u,E,1]]){const ot=Math.min(1,b.w/Y.w,b.h/Y.h),rt=nt(s,Y.c,b.x,b.y+Y.dy*ot,m*ot,n);rt.box=b,rt.header={x:b.x,y:b.y,w:b.w,h:0},rt.opacity=J,i.push(_t(Y.c.id,e.id,b,m*ot,l,V?B((c-.5)/.5):1-B(c/.4))),h.push({card:{id:Y.c.id,parentId:e.id,box:b,orbX:lt,opacity:J,shadow:V?Lt[f]*Math.max(E,W):0,caret:V,open:1,fit:f},section:rt,to:V})}f==="push"&&(F=b.y-o.y+b.h,g=Math.max(o.w,b.x+b.w+p-o.x))}for(const c of C){if(G&&A&&(c===G.from||c===G.to))continue;const u=c.kid.open,z=Math.max(c.left,Math.min(c.left+c.w,c.orbX)),K=z+(c.left-z)*u,b={x:K,y:c.top,w:c.w*u,h:c.h*u},E=B(u/.35),W=nt(s,c.c,K,c.top+c.dy*u,m*u,n);W.box=b,W.header={x:b.x,y:b.y,w:b.w,h:0},W.opacity=E,i.push(_t(c.c.id,e.id,b,m*u,l,B((u-.6)/.4))),h.push({card:{id:c.c.id,parentId:e.id,box:b,orbX:c.orbX,opacity:E,shadow:Lt[f]*E,caret:E*B((u-.1)/.4),open:u,fit:f},section:W,to:c.kid.to}),f==="push"&&(F=Math.max(F,(c.top-o.y+c.h)*u),g=Math.max(g,o.w+(c.left+c.w+p-o.x-o.w)*u))}return{sections:Kt(h,r),room:F,width:g,reach:g}}function fe(t){const e=t.find(a=>a.kid.to>.5&&a.kid.from),o=e&&t.find(a=>a.kid.id===e.kid.from&&a.kid.to<.5);return e&&o?{from:o,to:e}:null}function _t(t,e,o,a,n,i){const r=At.framePadding*a;return{id:t,parentId:e,box:{x:o.x+r,y:o.y+wo/n,w:Math.max(0,o.w-r*2),h:24/n},frame:o,opacity:i,inCard:!0}}function Kt(t,e){const o=t.map((a,n)=>({...a,i:n})).sort((a,n)=>a.to-n.to||a.i-n.i);return e.push(...o.map(a=>a.card)),o.map(a=>a.section).reverse()}function nt(t,e,o,a,n,i){const r=At.frameHeaderHeight,s=f=>({x:o+(f.x-e.box.x)*n,y:a+(f.y-e.box.y-r)*n,w:f.w*n,h:f.h*n});for(const f of e.itemIds){const x=t.items.get(f);x&&i.set(f,s(x))}const l=e.groups.map(f=>({...f,box:s(f.box),heading:f.heading&&s(f.heading)}));return{...e,box:{x:o,y:a,w:e.box.w*n,h:(e.box.h-r)*n},header:{x:o,y:a,w:e.box.w*n,h:0},groups:l,more:e.more&&{...e.more,box:s(e.more.box)}}}class ko{constructor(e,o){this.families=e;for(const a of e)a.kids.forEach((n,i)=>{const r=n.state==="running"||n.state==="waiting",s=o-n.startedAgo,l=1+(i*7919+a.parentId.length*104729+n.id.charCodeAt(23)*31)%997;this.kids.set(n.id,{demo:n,parentId:a.parentId,index:i+1,seed:l,own:ye(qt(n.id)),state:n.state,prev:n.state,since:o-60,started:s,finished:r?null:s+n.ran})});this.next=o+2.5}families;kids=new Map;live=!1;next=0;r=Ut(42);familyKids(e){return e.kids.slice(0,e.count).map(o=>this.kids.get(o.id))}set(e,o,a){const n=this.kids.get(e);if(!n||n.state===o)return;const i=r=>r==="running"||r==="waiting";i(o)&&!i(n.state)?(n.started=a,n.finished=null):!i(o)&&i(n.state)&&(n.finished=a),n.prev=n.state,n.state=o,n.since=a}tick(e){if(!this.live||e<this.next)return;this.next=e+2.2+this.r()*1.6;const o=this.families.flatMap(l=>this.familyKids(l)),a=l=>{const f=o.filter(x=>x.state===l&&e-x.since>2);return f.length?f[Math.floor(this.r()*f.length)]:void 0},n=this.r(),i=a("running"),r=a("waiting");if(r&&n<.2)return this.set(r.demo.id,"running",e);if(i&&n<.62)return this.set(i.demo.id,this.r()<.18?"failed":this.r()<.12?"waiting":"done",e);const s=a("done")??a("failed");s&&this.set(s.demo.id,"running",e)}look(e,o,a,n,i,r){return Ge(e,o,a,n,i,r)}view(e,o,a){return{id:e.demo.id,title:e.demo.title,agent:e.demo.agent,task:e.demo.task,index:e.index,own:e.own,seed:e.seed,state:e.state,look:a,elapsed:Be((e.finished??o)-e.started)}}}const Mo=`
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
}`,Co=`
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
}`,So=`
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
}`,Ro=`
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
}`,Po=`
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
}`,Eo=`
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
}`,Ao=`
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
}`,at=[Xe,{id:"wisps",name:"Wisps",note:"Incense threads standing on the title’s baseline: curl-noise smoke rises from a small ember while it works; done leaves the ember alone.",params:[...ct(9,17,"parent",4,20),L("height","Height",24,8,44,1,"px"),L("curl","Curl",.9,0,2,.05),L("thick","Thickness",1,.4,2,.05),L("glow","Glow",1,0,2,.05)],row:!1,reach:(t,e,o)=>{const a=Math.max(2.6*e,e*1.08+4*o)+2,n=Math.max(Number(t.height)*o*1.1+e,a);return[a,n,a,a]},anchor:"baseline",still:2.4,glsl:Mo},{id:"metaballs",name:"Metaballs",note:"Liquid drops on the title line: running ones wander, and now and then two neighbours draw together, merge and part; done drops shrink and settle.",params:[...ct(11,18),L("goo","Goo",.45,0,1,.05),L("wander","Wander",.8,0,1.5,.05),L("shine","Highlight",.6,0,1.5,.05)],row:!0,reach:wt(1.8),anchor:"centre",still:6.3,glsl:Co},{id:"fireflies",name:"Fireflies",note:"A crisp point with a soft halo drifting in a tiny Lissajous orbit, trailing light and flickering while it works; done ones hold a steady glow.",params:[...ct(14,18),L("orbit","Orbit",3,0,8,.25,"px"),L("flicker","Flicker",.6,0,1,.05),L("trail","Trail",.6,0,1.5,.05),L("core","Core",2.6,1,5,.1,"px")],row:!1,reach:(t,e,o)=>{const a=Math.max(e*1.7,e*.9+4*o)+Number(t.orbit)*o+2;return[a,a,a,a]},anchor:"centre",still:1.7,glsl:So},{id:"plasma",name:"Plasma beads",note:"A lit bead whose surface is sphere-mapped fbm folded into plasma bands, turning on a tilted axis while it works; done beads stop and soften.",params:[...ct(12,19),L("scale","Noise scale",1.3,.4,4,.05),L("bands","Bands",1.4,0,4,.05),L("spin","Spin",1,0,3,.05),L("light","Lighting",.7,0,1,.05)],row:!1,reach:wt(1),anchor:"centre",still:2.2,glsl:Ro},{id:"dots",name:"Dot-grid orbs",note:"Orbs seen through the Ember band’s own dot grid: its clumps crawl round a little ring while running; done is a small calm cluster.",params:[...ct(22,30,"parent",14,36),L("crawl","Crawl",5.5,0,14,.5,"px/s"),L("scale","Noise scale",7,3,12,.5,"px"),L("sparse","Sparse",.5,.35,.7,.005),L("peak","Peak",.9,.3,1,.05)],row:!0,reach:wt(1.8),anchor:"centre",still:4,glsl:Po},{id:"ink",name:"Ink drops",note:"A drop of ink blooming in water, looping, ink pooling at its lobed front; done leaves a still stain.",params:[...ct(14,20),L("period","Period",3.2,1.5,6,.1,"s"),L("spread","Spread",1,.6,1.3,.02),L("tendrils","Tendrils",1,0,2,.05)],row:!1,reach:wt(1.5),anchor:"centre",still:1.15,glsl:Eo},{id:"moons",name:"Moons",note:"A small moon whose phases cycle while it works: full and calm when done, half lit with a breathing terminator while waiting.",params:[...ct(12,18),L("soft","Terminator",.3,0,1,.05),L("shine","Earthshine",.22,0,.6,.02),L("surface","Maria",.5,0,1,.05)],row:!1,reach:wt(1),anchor:"centre",still:2.1,glsl:Ao}];function Me(t){return at.find(e=>e.id===t)??at[0]}const q=oo({site:"subagents",title:"Subagents",storageKey:"canvas-playground-subagents-v5",defaults:()=>({tech:at[0].id,params:Object.fromEntries(at.map(t=>[t.id,it(t.params)])),row:it(yt),expand:it(kt),ideas:it(Mt),live:!0,count:8}),restore(t,e){typeof t.v=="string"&&at.some(o=>o.id===t.v)&&(e.tech=t.v),so(at,t.p,e.params),t.r&&(e.row=It(yt,{...e.row,...t.r})),t.x&&(e.expand=It(kt,{...e.expand,...t.x})),t.i&&(e.ideas=It(Mt,{...e.ideas,...t.i})),typeof t.live=="boolean"&&(e.live=t.live),typeof t.n=="number"&&ke.includes(String(t.n))&&(e.count=t.n)},share:t=>({v:t.tech,p:io(at,t.params),r:Ot(yt,t.row),x:Ot(kt,t.expand),i:Ot(Mt,t.ideas),live:t.live,n:t.count}),exportJson:t=>({site:"subagents",technique:{id:t.tech,name:Me(t.tech).name,params:t.params[t.tech]},row:t.row,expand:t.expand,ideas:t.ideas})}),{settings:R,demo:Ce}=q;Ce.setAttribute("aria-label","The canvas: scroll to pan, pinch or ctrl-scroll to zoom; click a subagent’s orb to open its frame under it");const Z=M("div","canvas-container sa-canvas"),ft=M("canvas","canvas"),ht=M("div","overlay"),xt=M("div","sa-loading","Drawing the demo canvas…"),zt=M("div","sa-toast");Z.append(ft,ht,xt,zt);Ce.prepend(Z);const S=new uo;S.mount(Z);S.setCurrentTool("select");window.editor=S;let N=null,O=null,Ct=null,D=null,U=null;const Rt=()=>Me(R.tech),Tt=()=>R.params[R.tech],Ft=()=>R.row,pt=()=>R.expand,Pt=()=>R.ideas,Qt=()=>String(pt().fit),Se=()=>!!Ft().reduced,Q=new Map,he={standard:Ht(.4,0,.2,1),decelerate:Ht(0,0,.2,1),"in-out":Ht(.65,0,.35,1)};function Zt(t,e){const o=Q.get(t);if(!o)return 0;const a=Number(pt().dur),n=a<=0?1:B((e-o.start)/a);return n>=1&&o.to===0&&Q.delete(t),o.from+(o.to-o.from)*(he[String(pt().ease)]??he.standard)(n)}const et=t=>(Q.get(t)?.to??0)>.5;function Nt(t,e,o,a=0){et(t)===e&&Q.has(t)===e||(Q.set(t,{from:Zt(t,o),to:e?1:0,start:o+a}),X=!0)}function St(t){return N?.families.find(e=>e.parentId===t||e.kids.some(o=>o.id===t))}function gt(t){return t.kids.slice(0,t.count)}function te(t,e=!1){const o=performance.now(),a=!et(t),n=[];if(a&&!e){const r=St(t);for(const s of r?gt(r):[])s.id!==t&&et(s.id)&&n.push(s.id);for(const s of n)Nt(s,!1,o)}Nt(t,a,o);const i=Q.get(t);i&&a&&(i.replaced=n.length===1?n[0]:st&&n.includes(st)?st:void 0),a&&mt.delete(t),st=a?t:st}let st=null;function Re(){for(const t of Q.keys())if(et(t))return!0;return!1}function $o(t){const e=st&&et(st)?st:[...Q.keys()].find(et),o=e&&St(e);if(!e||!o)return!1;const a=ee(o).map(i=>i.id),n=a[(a.indexOf(e)+t+a.length)%a.length];return n&&n!==e&&te(n),!0}function Pe(t,e){const o=performance.now(),a=gt(t),n=e?a:[...a].reverse(),i=n.length>1?Math.min(Number(pt().stagger),260/(n.length-1)):0;let r=0;for(const s of n)et(s.id)!==e&&Nt(s.id,e,o,i*r++)}function ut(t){for(const e of N?.families??[])Pe(e,t)}let X=!0,pe="";function Lo(){return{head:dt,headGap:8}}function Et(t){if(!N||!O)return;O.live=R.live,O.tick(t/1e3);const e=S.camera.peek().z,o=new Map,a=Qt();let n="";const i=new Set(N.families.flatMap(l=>l.kids.map(f=>f.id)));let r=!1;for(const l of N.families)o.set(l.parentId,ee(l).map(f=>{const x=Zt(f.id,t),w=Q.get(f.id)?.to??0;return Q.has(f.id)&&x!==w&&(r=!0),x>0&&a!=="below"&&(n+=`${f.id}:${(ue(l.parentId,f.id,t)??-1).toFixed(2)},`),{id:f.id,open:x,to:w,from:Q.get(f.id)?.replaced}}));const s=`${e}|${a}|${n}|${[...o.values()].map(l=>l.map(f=>f.open>0?`${f.open.toFixed(4)}${f.to}`:"").join(",")).join(";")}`;!X&&!r&&s===pe&&U||(X=!1,pe=s,U=xo({natural:S.naturalLayout.get(),families:o,childIds:i,zoom:e,childScale:Number(pt().scale),m:Lo(),fit:a,anchor:(l,f)=>ue(l,f,t),memo:_o,morph:pt().switch==="morph"}),S.plan.set(U))}const _o=new Map,ue=(t,e,o)=>D?.anchor(t,e,o)??null;function ee(t){const e=gt(t);if(!Pt().group||!O)return e;const o={waiting:0,failed:1,running:2,done:3};return e.map((a,n)=>({k:a,i:n,r:o[O.kids.get(a.id)?.state??"done"]})).sort((a,n)=>a.r-n.r||a.i-n.i).map(a=>a.k)}S.onFrame(t=>Et(t));const me=new Map,ge=new Map,we=new Map;function Ee(t){let e=me.get(t);return e||me.set(t,e={run:0,done:0,fail:0,wait:0,flash:0,open:0,hover:0,breath:0}),e}function Oo(t,e){const o=new Map;if(!N||!O||!D)return o;const a=t/1e3,n=Number(Tt().speed??1),i=Tt().color==="own",r=Se();for(const s of N.families){const l=ee(s).map(w=>O.kids.get(w.id));if(!l.length)continue;const f=ye(s.color),x=l.map(w=>{const d=O.look(w,a,Zt(w.demo.id,t),D.hover(w.demo.id,t),Ee(w.demo.id),r),m=(ge.get(w.demo.id)??w.seed*.37)+e/1e3*n*(d.run+.35*d.wait);ge.set(w.demo.id,m);const p=Ae.get(w.demo.id);return p!==void 0&&Pt().unread&&!r&&(d.flash=Math.max(d.flash,Xo(t-p))),{view:O.view(w,a,d),rgb:i?w.own:f,time:m,unread:Pt().unread?mt.get(w.demo.id)??0:0,thumb:Yt.get(w.demo.id)??null}});o.set(s.parentId,{parentId:s.parentId,kids:x,rgb:f,...Io(s.parentId,x.map(w=>w.view),t,e,n,r)})}return o}function Io(t,e,o,a,n,i){let r=we.get(t);return r||we.set(t,r=new We(t)),r.update(e,o,a,n,i,D?.hover(`agg:${t}`,o)??0)}function zo(){const t=new Map;if(!N||!O)return t;for(const e of N.families){t.set(e.parentId,{id:e.parentId,title:e.title,child:!1});for(const o of e.kids){const a=O.kids.get(o.id),n=a?O.view(a,performance.now()/1e3,Ee(o.id)):null;t.set(o.id,{id:o.id,title:o.title,agent:o.agent,task:o.task,child:!0,status:n?Ue(n):"",statusKind:n?.state})}}return t}let be="",Dt=0,Wt=null,j=!0;function qo(t){if(!D||!U)return;const e=Dt?Math.min(100,Math.max(0,t-Dt)):16;Dt=t;const o=S.camera.peek(),{w:a,h:n}=S.viewport.peek(),i=ft.width/Math.max(1,a);D.orbs.resize(ft.width,ft.height,a,n);const r=Oo(t,e),s=`${o.x},${o.y},${o.z},${a},${n},${ft.width}`;!j&&s===be&&Wt===U&&!D.animating&&!D.alive&&!To(r)||(j=!1,be=s,Wt=U,D.draw(U,zo(),r,{tech:Rt(),p:Tt(),max:Number(Ft().max),titlePx:Number(Ft().title),reduced:Se(),preview:!!Pt().preview},t,i),q.setZoom(o.z))}function To(t){return De([...t.values()].flatMap(e=>[...e.kids.map(o=>o.view.look),e.agg]))}async function Fo(){const t=await po();N=t,t.families[0].count=R.count,O=new ko(t.families,performance.now()/1e3);for(const a of t.items)Yt.has(a.sessionId)||Yt.set(a.sessionId,a.thumb);const e=t.families[0].kids;mt.set(e[1].id,2),mt.set(e[6].id,1),S.loadSnapshot(t.sessions,t.items),X=!0,S.whenViewportReady(()=>requestAnimationFrame(()=>Bt(!1)));try{Ct=await He.create(ft,ht,S,{readOnly:!0,easeLayout:!1,busySessions:()=>No(),getRaisedSections:()=>Go()}),window.renderer=Ct}catch(a){console.error(a),xt.textContent=`Can't start the renderer: ${re(a)}`;return}xt.remove();let o;try{o=new Ke(ht)}catch(a){xt.textContent=`Can't start WebGL2 for the orbs: ${re(a)}`,Z.append(xt);return}D=new ro(ht,S,o,{toggleKid:te,showAll:()=>j=!0,zoomTo:a=>ne(()=>{const n=S.layout.get().sections.find(i=>i.id===a);return n?Vt.union([n.box,n.header]):null},64,!0)}),eo.then(()=>{D?.text.reset(),j=!0}),S.onFrame(a=>qo(a))}const bt=new Set;function No(){if(bt.clear(),!N||!O||!Ft().busy)return bt;const t=Qt()!=="below";for(const e of N.families)if(e.busy&&bt.add(e.parentId),!t)for(const o of O.familyKids(e))o.state==="running"&&bt.add(o.demo.id);return bt}function Go(){return(U?.cards??[]).map(t=>({id:t.id,shadow:t.shadow}))}const mt=new Map,Ae=new Map,Yt=new Map,Bo=900,Xo=t=>t<0?0:t<150?t/150:Math.max(0,1-(t-150)/(Bo-150));let xe=0;function jo(t){if(!N||!O||!R.live||!Pt().unread||t<xe)return;xe=t+2600+t*7%1900;const e=N.families.flatMap(o=>O.familyKids(o)).filter(o=>o.state==="running"&&!et(o.demo.id));e.length&&oe(e[Math.floor(t/997%e.length)].demo.id,t)}function oe(t,e=performance.now()){et(t)||(mt.set(t,(mt.get(t)??0)+1),Ae.set(t,e),j=!0)}S.onFrame(t=>jo(t));let Jt=null;Z.addEventListener("pointerdown",t=>{Jt=t.button===0?{x:t.clientX,y:t.clientY}:null});Z.addEventListener("pointerup",t=>{const e=Jt;if(Jt=null,!e||Math.hypot(t.clientX-e.x,t.clientY-e.y)>4||!Re()||Qt()==="below"||t.target.closest(".sa-orb, .sa-agg, .sa-more, .sa-close"))return;const o=Z.getBoundingClientRect(),a=S.screenToPage({x:t.clientX-o.left,y:t.clientY-o.top});(U?.cards??[]).some(i=>i.open>.5&&a.x>=i.box.x&&a.x<=i.box.x+i.box.w&&a.y>=i.box.y&&a.y<=i.box.y+i.box.h)||ut(!1)});let ve=0;function Ho(t){zt.textContent=t,zt.classList.add("on"),clearTimeout(ve),ve=window.setTimeout(()=>zt.classList.remove("on"),2400)}function Bt(t=!0){ne(()=>S.layout.get().bounds,48,t)}function ne(t,e,o){const a=S.camera.peek();let n=a;for(let i=0;i<5;i++){const r=t();if(!r)return;n=S.getCameraForBounds(r,{padding:e}),S.setCamera(n),X=!0,Et(performance.now())}o&&(S.setCamera(a),X=!0,Et(performance.now()),S.setCamera(n,{animate:!0,duration:480}))}je(()=>{Z.style.cursor=S.cursor.get()});const $e=()=>q.setCaption(Rt().name,Rt().note),Ko=no(q,at,R.tech,t=>{R.tech=t,Le.render(),$e(),j=!0,q.save()}),Le=ao(q,"Technique",()=>Rt().params,()=>Tt(),()=>{j=!0,q.save()},()=>R.params[R.tech]=it(Rt().params)),Do=q.section("Title row",tt("Reset",()=>{R.row=it(yt),Xt(),X=j=!0,q.save()},"ghost",!0));function Xt(){Do.replaceChildren(...yt.map(t=>Gt(t,R.row,()=>{X=j=!0,q.save()})),M("p","pg-note","Every technique: failed is red and still, waiting breathes. Hover an orb for its subagent; click it to open its frame right under it (Fit, below). Zoomed out, the orbs fold into +N, then flow into one."))}Xt();const Uo=q.section("Expanding",tt("Reset",()=>{R.expand=it(kt),ae(),X=!0,q.save()},"ghost",!0));function ae(){Uo.replaceChildren(...kt.map(t=>Gt(t,R.expand,()=>{X=!0,q.save()})),M("div","pg-buttons",tt("Expand all",()=>ut(!0),"",!0),tt("Collapse all",()=>ut(!1),"",!0)))}ae();const Wo=q.section("Ideas",tt("Reset",()=>{R.ideas=it(Mt),se(),X=j=!0,q.save()},"ghost",!0));function se(){Wo.replaceChildren(...Mt.map(t=>Gt(t,R.ideas,()=>{X=j=!0,q.save()})),M("p","pg-note","Prototypes: the hover label shows what the subagent last made; a working subagent that isn’t open gets a count of what it posted since (its orb brightens as it posts); the row orders waiting, failed, running, done."),M("div","pg-buttons",tt("Post from one",()=>Yo(),"",!0)))}se();function Yo(){const t=N?.families[0],e=t&&gt(t).find(o=>!et(o.id));e&&oe(e.id)}q.section("Demo").append(Ze("Coordinator’s",ke,String(R.count),t=>_e(Number(t))),to("Live states",R.live,t=>{R.live=t,q.save()}),M("div","pg-buttons",tt("Fit",()=>Bt(),"",!0),tt("Next state",()=>Jo(),"",!0)));function _e(t){R.count=t;const e=N?.families[0];if(e){e.count=t;for(const o of e.kids.slice(t))Q.delete(o.id)}X=j=!0,q.save()}function Jo(){if(!O)return;const t=O.live;O.live=!0,O.next=0,O.tick(performance.now()/1e3),O.live=t}const Vo=[["Hover","an orb: its subagent and state"],["Click","an orb: open its frame under it, or switch to it"],["⇧Click","open another alongside"],["←→","with one open: the subagent before or after; on a focused orb: move along the row"],["1–8","technique"],["E","expand or collapse every subagent"],["Esc","or click outside: collapse"],["M","reduced motion"],["⇧1","zoom to fit"]];q.section("Keys").append(M("div","sa-keys",...Vo.flatMap(([t,e])=>[M("kbd","",t),M("span","",e)])));window.addEventListener("keydown",t=>{t.target.closest('input, textarea, [role="slider"]')||t.metaKey||t.ctrlKey||t.altKey||(t.key==="e"||t.key==="E"?ut(!(N?.families??[]).every(e=>gt(e).every(o=>et(o.id)))):t.key==="Escape"?ut(!1):(t.key==="ArrowLeft"||t.key==="ArrowRight")&&!t.target.closest("button")&&Re()?$o(t.key==="ArrowLeft"?-1:1)&&t.preventDefault():(t.key==="m"||t.key==="M")&&(R.row.reduced=!R.row.reduced,Xt(),j=!0,Ho(R.row.reduced?"Reduced motion: every orb holds its pose":"Motion on"),q.save()))});q.toolbar.append(tt("Fit",()=>Bt(),"",!0));$e();Fo();Object.assign(window,{playground:{editor:S,settings:R,get sim(){return O},get demo(){return N},ready:()=>!!Ct&&!!D&&!!U,select:t=>Ko.select(t),param(t,e){R.params[R.tech][t]=e,Le.render(),j=!0},row(t,e){R.row[t]=e,Xt(),X=j=!0},expandParam(t,e){R.expand[t]=e,ae(),X=j=!0},idea(t,e){R.ideas[t]=e,se(),X=j=!0},toggle:(t,e=!1)=>te(t,e),post:t=>oe(t),cards:()=>U?.cards,live(t){R.live=t},state(t,e){O?.set(t,e,performance.now()/1e3)},open:(t,e=!0)=>Nt(t,e,performance.now()),expandAll:(t,e=!0)=>{const o=St(t);o&&Pe(o,e)},expandEverything:ut,setCount:_e,kids:t=>St(t)?.kids.slice(0,St(t).count).map(e=>({id:e.id,title:e.title,state:O?.kids.get(e.id)?.state})),families:()=>N?.families.map(t=>({id:t.parentId,title:t.title,kids:gt(t).length})),orbPoint(t){const e=D?.orbCentre(t);if(!e)return null;const o=Z.getBoundingClientRect();return{x:o.left+e.x,y:o.top+e.y}},look(t,e=48,o=0,a=0,n=0){ne(()=>{const i=S.layout.get().sections.find(s=>s.id===t),r=i&&Vt.union([i.box,i.header]);return r?{x:r.x,y:r.y-n,w:r.w+o,h:r.h+a+n}:null},e,!1)},trace(){const t=S.camera.peek(),e=s=>(s+t.x)*t.z,o=s=>(s+t.y)*t.z,a=s=>[e(s.x),o(s.y),s.w*t.z,s.h*t.z].map(l=>Math.round(l*100)/100),n=Wt,i=Z.getBoundingClientRect(),r=s=>Math.round(s*100)/100;return{cam:t,frames:Object.fromEntries((n?.layout.sections??[]).map(s=>[s.id,a(s.box)])),drawn:Object.fromEntries((n?.layout.sections??[]).map(s=>[s.id,Ct?.sectionBox(s.id)?a(Ct.sectionBox(s.id)):null])),heads:Object.fromEntries((n?.heads??[]).map(s=>[s.id,a(s.box).slice(0,2)])),dom:Object.fromEntries([...ht.querySelectorAll(".sa-head")].filter(s=>s.style.display!=="none").map(s=>{const l=s.getBoundingClientRect();return[s.dataset.session,[r(l.left-i.left),r(l.top-i.top)]]})),orbs:Object.fromEntries((D?.drawn??[]).filter(s=>s.alpha>.5).map(s=>[s.id,[r(s.x),r(s.y)]])),orbDom:Object.fromEntries([...ht.querySelectorAll(".sa-orb")].filter(s=>s.style.display!=="none"&&s.style.cssText).map(s=>{const l=s.getBoundingClientRect();return[s.dataset.id,[r(l.left-i.left+l.width/2),r(l.top-i.top+l.height/2)]]}))}},region(t,e=0,o=16,a=0){const n=S.camera.peek(),i=U?.heads.find(l=>l.id===t);if(!i)return null;const r=Z.getBoundingClientRect(),s=(i.box.y+n.y)*n.z;return{x:Math.round(r.left+(i.frame.x+n.x)*n.z-o),y:Math.round(r.top+s-o),width:Math.round((a||i.frame.w*n.z)+o*2),height:Math.round(dt+8+Math.min(i.frame.h*n.z,e)+o*2)}},place(t,e,o=40,a=70){S.setCamera({...S.camera.peek(),z:e}),X=!0,Et(performance.now());const n=U?.heads.find(i=>i.id===t);n&&(S.setCamera({x:o/e-n.box.x,y:a/e-n.box.y,z:e}),X=!0,Et(performance.now()))},camera:()=>S.camera.peek(),setCamera:(t,e,o)=>S.setCamera({x:t,y:e,z:o}),fit:()=>Bt(!1),plan:()=>U,error:()=>D?.orbs.error??null}});
