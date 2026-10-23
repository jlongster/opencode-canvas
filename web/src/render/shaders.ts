// Shared uniforms: camera in page space, viewport in CSS pixels.
const common = /* wgsl */ `
struct Globals {
  camera: vec4f,   // x, y, zoom, drawing buffer px per CSS px
  viewport: vec4f, // width, height (css px), time, unused
};
@group(0) @binding(0) var<uniform> g: Globals;
@group(0) @binding(1) var samp: sampler;

// A function-scope var rather than a module-scope const array: dynamically indexing a const
// array is not handled by every WGSL compiler (WebKit's in particular).
fn quadCorner(vi: u32) -> vec2f {
  var quad = array<vec2f, 6>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0)
  );
  return quad[vi];
}

fn pageToScreen(p: vec2f) -> vec2f {
  return (p + g.camera.xy) * g.camera.z;
}

fn screenToClip(s: vec2f) -> vec4f {
  let n = s / g.viewport.xy * 2.0 - 1.0;
  return vec4f(n.x, -n.y, 0.0, 1.0);
}

fn roundedBoxSdf(p: vec2f, halfSize: vec2f, r: f32) -> f32 {
  let q = abs(p) - halfSize + vec2f(r);
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}
`

/** Rounded rectangles with fill and an outside stroke, in page or screen space. */
export const rectShader = /* wgsl */ `
${common}

struct RectIn {
  @location(0) rect: vec4f,    // x, y, w, h
  @location(1) fill: vec4f,    // premultiplied rgba
  @location(2) stroke: vec4f,  // premultiplied rgba
  @location(3) params: vec4f,  // strokeWidth (screen px), radius, space (0 page, 1 screen), unused
};

struct RectOut {
  @builtin(position) pos: vec4f,
  @location(0) local: vec2f,
  @location(1) halfSize: vec2f,
  @location(2) fill: vec4f,
  @location(3) stroke: vec4f,
  @location(4) sr: vec2f,
};

@vertex fn vs(@builtin(vertex_index) vi: u32, r: RectIn) -> RectOut {
  var origin = r.rect.xy;
  var size = r.rect.zw;
  var radius = r.params.y;
  if (r.params.z < 0.5) {
    origin = pageToScreen(origin);
    size = size * g.camera.z;
    radius = radius * g.camera.z;
  }
  let halfSize = size * 0.5;
  radius = min(radius, min(halfSize.x, halfSize.y));
  let margin = r.params.x + 1.0;
  let corner = quadCorner(vi);
  let local = (corner * 2.0 - 1.0) * (halfSize + vec2f(margin));
  var out: RectOut;
  out.pos = screenToClip(origin + halfSize + local);
  out.local = local;
  out.halfSize = halfSize;
  out.fill = r.fill;
  out.stroke = r.stroke;
  out.sr = vec2f(r.params.x, radius);
  return out;
}

@fragment fn fs(i: RectOut) -> @location(0) vec4f {
  let d = roundedBoxSdf(i.local, i.halfSize, i.sr.y);
  let inner = clamp(0.5 - d, 0.0, 1.0);
  let outer = clamp(0.5 - (d - i.sr.x), 0.0, 1.0);
  return i.fill * inner + i.stroke * (outer - inner);
}
`

/**
 * The busy band's blocks (see render/busy/brain.ts): solid rectangles in whole device pixels, in
 * premultiplied rgba, so every block covers exact pixels.
 */
export const blockShader = /* wgsl */ `
${common}

struct BlockIn {
  @location(0) rect: vec4f,  // x, y, w, h (device px)
  @location(1) color: vec4f, // premultiplied rgba
};

struct BlockOut {
  @builtin(position) pos: vec4f,
  @location(0) @interpolate(flat) color: vec4f,
};

@vertex fn vs(@builtin(vertex_index) vi: u32, b: BlockIn) -> BlockOut {
  let px = b.rect.xy + quadCorner(vi) * b.rect.zw;
  let n = px / (g.viewport.xy * g.camera.w) * 2.0 - 1.0;
  var out: BlockOut;
  out.pos = vec4f(n.x, -n.y, 0.0, 1.0);
  out.color = b.color;
  return out;
}

@fragment fn fs(i: BlockOut) -> @location(0) vec4f {
  return i.color;
}
`

const imageVertex = /* wgsl */ `
struct ImageIn {
  @location(0) rect: vec4f,   // page x, y, w, h
  @location(1) params: vec4f, // opacity, radius (page), unused, unused
};

struct ImageOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) local: vec2f,
  @location(2) halfSize: vec2f,
  @location(3) params: vec2f,
};

@vertex fn vs(@builtin(vertex_index) vi: u32, r: ImageIn) -> ImageOut {
  let origin = pageToScreen(r.rect.xy);
  let size = r.rect.zw * g.camera.z;
  let halfSize = size * 0.5;
  let corner = quadCorner(vi);
  var out: ImageOut;
  out.pos = screenToClip(origin + corner * size);
  out.uv = corner;
  out.local = (corner * 2.0 - 1.0) * halfSize;
  out.halfSize = halfSize;
  out.params = vec2f(r.params.x, min(r.params.y * g.camera.z, min(halfSize.x, halfSize.y)));
  return out;
}

fn mask(i: ImageOut) -> f32 {
  return clamp(0.5 - roundedBoxSdf(i.local, i.halfSize, i.params.y), 0.0, 1.0) * i.params.x;
}
`

/** Mipmapped image textures (premultiplied alpha). */
export const imageShader = /* wgsl */ `
${common}
${imageVertex}
@group(1) @binding(0) var tex: texture_2d<f32>;

@fragment fn fs(i: ImageOut) -> @location(0) vec4f {
  return textureSample(tex, samp, i.uv) * mask(i);
}
`

/** Live video frames, imported zero-copy each frame. */
export const videoShader = /* wgsl */ `
${common}
${imageVertex}
@group(1) @binding(0) var tex: texture_external;

@fragment fn fs(i: ImageOut) -> @location(0) vec4f {
  let c = textureSampleBaseClampToEdge(tex, samp, i.uv);
  return vec4f(c.rgb, 1.0) * mask(i);
}
`

/** Downsamples one mip level into the next. */
export const mipShader = /* wgsl */ `
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var src: texture_2d<f32>;

struct Out { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex fn vs(@builtin(vertex_index) vi: u32) -> Out {
  var tri = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let p = tri[vi];
  var o: Out;
  o.pos = vec4f(p, 0.0, 1.0);
  o.uv = vec2f(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  return o;
}

@fragment fn fs(i: Out) -> @location(0) vec4f {
  return textureSample(src, samp, i.uv);
}
`
