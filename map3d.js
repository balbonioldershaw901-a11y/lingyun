'use strict';
/* ============================================================================
   lingyun · PERSONAL ATLAS — V7 地图引擎（P1）
   ----------------------------------------------------------------------------
   和 V6 的 atlas3d.js 的根本区别：
     V6：程序噪声地形 → 只驱动相机，不驱动任何信息 → 是背景
     V7：真实 SRTM DEM → 每一节都落在图上真实坐标 → 是坐标系
   所以这里的每一件事都必须可核对：
     · 高程来自 terrain-RGB 纹理，着色器里解码
     · 坡度/坡向用与构建期完全相同的公式（atan2(−p,−q)），方向不能写反
     · 光标读数靠射线步进打到地形上，反查同一份 DEM
     · 比例尺是**量出来的**：屏幕中心那一点与它右边一像素的地面距离
   零依赖手写 WebGL2。降级时换成构建期渲染的真实等高线版图，不是占位图。

   数据来源：SRTM 1 弧秒（NASA/USGS，公有领域），垂直基准 EGM96，DSM 含冠层。
   ========================================================================== */

const CONFIG = {
  /* 与 site-v7/data/dem.json 必须一致，不一致就是错的 */
  region: { south: 33.50, north: 34.00, west: 111.55, east: 112.05 },
  grid: 1024,
  cell: { ew: 45.2, ns: 54.4 },      // 像元实际尺寸（米）
  world: { w: 0, h: 0 },             // 区域实长（米），init 时算
  height: { min: 365, max: 2170, mean: 1006 },
  contour: { interval: 100, indexEvery: 5 },
  graticule: { deg: 5 / 60 },        // 经纬网间隔 5′
  light: { azimuth: 315, altitude: 45, zFactor: 1 },
  layers: ['elevation', 'slope', 'aspect', 'grey']
};

/* ------------------------------------------------------------------ 矩阵 */
const M4 = {
  ident: () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  mul(a, b, o) {
    o = o || new Float32Array(16);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + j] * b[i * 4 + k];
      o[i * 4 + j] = s;
    }
    return o;
  },
  perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return new Float32Array([
      f / aspect, 0, 0, 0, 0, f, 0, 0,
      0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
  },
  lookAt(eye, center, up) {
    let zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
    let l = Math.hypot(zx, zy, zz) || 1; zx /= l; zy /= l; zz /= l;
    let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
    l = Math.hypot(xx, xy, xz) || 1; xx /= l; xy /= l; xz /= l;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    return new Float32Array([
      xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
      -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
      -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
      -(zx * eye[0] + zy * eye[1] + zz * eye[2]), 1]);
  },
  /* 逆矩阵（用于从屏幕射线反投影） */
  invert(m) {
    const inv = new Float32Array(16);
    const a = m;
    inv[0] = a[5]*a[10]*a[15]-a[5]*a[11]*a[14]-a[9]*a[6]*a[15]+a[9]*a[7]*a[14]+a[13]*a[6]*a[11]-a[13]*a[7]*a[10];
    inv[4] = -a[4]*a[10]*a[15]+a[4]*a[11]*a[14]+a[8]*a[6]*a[15]-a[8]*a[7]*a[14]-a[12]*a[6]*a[11]+a[12]*a[7]*a[10];
    inv[8] = a[4]*a[9]*a[15]-a[4]*a[11]*a[13]-a[8]*a[5]*a[15]+a[8]*a[7]*a[13]+a[12]*a[5]*a[11]-a[12]*a[7]*a[9];
    inv[12] = -a[4]*a[9]*a[14]+a[4]*a[10]*a[13]+a[8]*a[5]*a[14]-a[8]*a[6]*a[13]-a[12]*a[5]*a[10]+a[12]*a[6]*a[9];
    inv[1] = -a[1]*a[10]*a[15]+a[1]*a[11]*a[14]+a[9]*a[2]*a[15]-a[9]*a[3]*a[14]-a[13]*a[2]*a[11]+a[13]*a[3]*a[10];
    inv[5] = a[0]*a[10]*a[15]-a[0]*a[11]*a[14]-a[8]*a[2]*a[15]+a[8]*a[3]*a[14]+a[12]*a[2]*a[11]-a[12]*a[3]*a[10];
    inv[9] = -a[0]*a[9]*a[15]+a[0]*a[11]*a[13]+a[8]*a[1]*a[15]-a[8]*a[3]*a[13]-a[12]*a[1]*a[11]+a[12]*a[3]*a[9];
    inv[13] = a[0]*a[9]*a[14]-a[0]*a[10]*a[13]-a[8]*a[1]*a[14]+a[8]*a[2]*a[13]+a[12]*a[1]*a[10]-a[12]*a[2]*a[9];
    inv[2] = a[1]*a[6]*a[15]-a[1]*a[7]*a[14]-a[5]*a[2]*a[15]+a[5]*a[3]*a[14]+a[13]*a[2]*a[7]-a[13]*a[3]*a[6];
    inv[6] = -a[0]*a[6]*a[15]+a[0]*a[7]*a[14]+a[4]*a[2]*a[15]-a[4]*a[3]*a[14]-a[12]*a[2]*a[7]+a[12]*a[3]*a[6];
    inv[10] = a[0]*a[5]*a[15]-a[0]*a[7]*a[13]-a[4]*a[1]*a[15]+a[4]*a[3]*a[13]+a[12]*a[1]*a[7]-a[12]*a[3]*a[5];
    inv[14] = -a[0]*a[5]*a[14]+a[0]*a[6]*a[13]+a[4]*a[1]*a[14]-a[4]*a[2]*a[13]-a[12]*a[1]*a[6]+a[12]*a[2]*a[5];
    inv[3] = -a[1]*a[6]*a[11]+a[1]*a[7]*a[10]+a[5]*a[2]*a[11]-a[5]*a[3]*a[10]-a[9]*a[2]*a[7]+a[9]*a[3]*a[6];
    inv[7] = a[0]*a[6]*a[11]-a[0]*a[7]*a[10]-a[4]*a[2]*a[11]+a[4]*a[3]*a[10]+a[8]*a[2]*a[7]-a[8]*a[3]*a[6];
    inv[11] = -a[0]*a[5]*a[11]+a[0]*a[7]*a[9]+a[4]*a[1]*a[11]-a[4]*a[3]*a[9]-a[8]*a[1]*a[7]+a[8]*a[3]*a[5];
    inv[15] = a[0]*a[5]*a[10]-a[0]*a[6]*a[9]-a[4]*a[1]*a[10]+a[4]*a[2]*a[9]+a[8]*a[1]*a[6]-a[8]*a[2]*a[5];
    let det = a[0]*inv[0]+a[1]*inv[4]+a[2]*inv[8]+a[3]*inv[12];
    if (!det) return null;
    det = 1 / det;
    for (let i = 0; i < 16; i++) inv[i] *= det;
    return inv;
  },
  xform(m, v) {   // 变换 vec4
    return [
      m[0]*v[0]+m[4]*v[1]+m[8]*v[2]+m[12]*v[3],
      m[1]*v[0]+m[5]*v[1]+m[9]*v[2]+m[13]*v[3],
      m[2]*v[0]+m[6]*v[1]+m[10]*v[2]+m[14]*v[3],
      m[3]*v[0]+m[7]*v[1]+m[11]*v[2]+m[15]*v[3]];
  }
};

/* --------------------------------------------------------------- 着色器 */
const VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aGrid;
uniform mat4 uViewProj;
uniform sampler2D uDem;
uniform vec2 uWorldSize;
uniform float uVExag;
out vec3 vWorld;
out vec2 vUV;
/* terrain-RGB：h = -10000 + (R*65536 + G*256 + B) * 0.1 （Mapbox 官方编码） */
float decodeH(vec3 c){
  return -10000.0 + (c.r*255.0*65536.0 + c.g*255.0*256.0 + c.b*255.0) * 0.1;
}
void main(){
  vUV = aGrid;
  float h = decodeH(texture(uDem, aGrid).rgb);
  /* 世界坐标：x=东(米)，y=高程(米)，z=南(米)。v=0 是北，所以 z 向南递增 */
  vWorld = vec3(aGrid.x*uWorldSize.x, h*uVExag, aGrid.y*uWorldSize.y);
  gl_Position = uViewProj * vec4(vWorld, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec3 vWorld;
in vec2 vUV;
uniform sampler2D uDem;
uniform vec2 uTexel;
uniform vec2 uCell;
uniform float uVExag;
uniform float uContourInterval;
uniform float uIndexEvery;
uniform vec2 uHeightRange;
uniform int uLayer;
uniform float uHillshade;
uniform vec2 uLonLatNW;
uniform vec2 uLonLatSpan;
uniform float uGridDeg;
uniform int uShowContour;
uniform int uShowGrid;
out vec4 outColor;

float decodeH(vec3 c){
  return -10000.0 + (c.r*255.0*65536.0 + c.g*255.0*256.0 + c.b*255.0) * 0.1;
}
/* 返回 (∂h/∂x 东, ∂h/∂北)。注意 v 小 = 北，所以北向差分取 uv.y - texel */
vec2 grad(vec2 uv){
  float hL = decodeH(texture(uDem, uv - vec2(uTexel.x, 0.0)).rgb);
  float hR = decodeH(texture(uDem, uv + vec2(uTexel.x, 0.0)).rgb);
  float hN = decodeH(texture(uDem, uv - vec2(0.0, uTexel.y)).rgb);
  float hS = decodeH(texture(uDem, uv + vec2(0.0, uTexel.y)).rgb);
  return vec2((hR-hL)/(2.0*uCell.x), (hN-hS)/(2.0*uCell.y));
}
vec3 rampElevation(float t){
  /* 分层设色：**明度随海拔单调递减**，色相 黄绿→黄→橙→褐。
     绝不按彩虹配 —— 彩虹色会造出虚假的"分级边界"。
     这组色值是按"相邻带明度单调、差异可见"的规则推出来的，不是抄某个标准色带。 */
  vec3 c[6];
  c[0]=vec3(214.0,224.0,186.0)/255.0;
  c[1]=vec3(196.0,214.0,158.0)/255.0;
  c[2]=vec3(214.0,205.0,150.0)/255.0;
  c[3]=vec3(204.0,166.0,116.0)/255.0;
  c[4]=vec3(176.0,126.0, 96.0)/255.0;
  c[5]=vec3(146.0,100.0, 84.0)/255.0;
  float x = clamp(t,0.0,1.0)*5.0;
  int i = int(floor(x));
  i = i > 4 ? 4 : i;
  return mix(c[i], c[i+1], x - float(i));
}
vec3 rampSlope(float deg){
  /* 坡度分级：0–3 绿 / 3–8 黄 / 8–15 橙 / 15–25 赭 / >25 红褐 */
  if (deg <  3.0) return vec3(214.0,227.0,188.0)/255.0;
  if (deg <  8.0) return vec3(199.0,216.0,140.0)/255.0;
  if (deg < 15.0) return vec3(228.0,205.0,110.0)/255.0;
  if (deg < 25.0) return vec3(214.0,160.0, 96.0)/255.0;
  return vec3(176.0,106.0, 84.0)/255.0;
}
vec3 rampAspect(float deg){
  /* 坡向 8 方位：定性配色，色盲友好取向（蓝/橙为主轴，避免红绿对） */
  int k = int(mod(floor((deg + 22.5)/45.0), 8.0));
  vec3 c[8];
  c[0]=vec3(214.0, 96.0, 77.0)/255.0;  // 北
  c[1]=vec3(226.0,150.0, 78.0)/255.0;  // 东北
  c[2]=vec3(222.0,203.0,105.0)/255.0;  // 东
  c[3]=vec3(160.0,200.0,120.0)/255.0;  // 东南
  c[4]=vec3(110.0,178.0,158.0)/255.0;  // 南
  c[5]=vec3(104.0,152.0,190.0)/255.0;  // 西南
  c[6]=vec3(140.0,130.0,190.0)/255.0;  // 西
  c[7]=vec3(186.0,120.0,160.0)/255.0;  // 西北
  return c[k];
}
void main(){
  float h = decodeH(texture(uDem, vUV).rgb);
  vec2 g = grad(vUV);
  float slopeDeg = degrees(atan(length(g)));
  /* 坡向 = 下坡方向的罗盘方位 = atan2(−p, −q)。写成 atan2(p,q) 会差 90°，山读成坑。
     这条公式与构建期 prepare-dem.cjs 完全一致，并由 test-dem-math.cjs 断言守住。 */
  float aspectDeg = degrees(atan(-g.x, -g.y));
  aspectDeg = mod(aspectDeg + 360.0, 360.0);

  float t = (h - uHeightRange.x) / max(1.0, uHeightRange.y - uHeightRange.x);
  vec3 base;
  if (uLayer == 0) base = rampElevation(t);
  else if (uLayer == 1) base = rampSlope(slopeDeg);
  else if (uLayer == 2) base = rampAspect(aspectDeg);
  else base = vec3(0.94, 0.92, 0.87);

  /* 晕渲：光源方位角/高度角固定 315°/45°，光从西北来 —— 这条不能改，
     改了之后山脊与谷地的明暗关系就和读者的直觉相反。 */
  float az = radians(360.0 - 315.0 + 90.0);
  float zen = radians(90.0 - 45.0);
  float hs = cos(zen)*cos(radians(slopeDeg))
           + sin(zen)*sin(radians(slopeDeg))*cos(az - radians(aspectDeg));
  hs = clamp(hs, 0.0, 1.0);
  vec3 col = base * mix(1.0, 0.42 + 0.82*hs, uHillshade);

  /* 等高线：等宽抗锯齿。淡出阈值必须写成 smoothstep(大, 小, d) —— 写反就把线全抹掉 */
  if (uShowContour == 1) {
    float hn = h / uContourInterval;
    float w = max(fwidth(hn), 1e-5);
    float f = abs(fract(hn - 0.5) - 0.5);
    float fade = smoothstep(0.42, 0.18, w);
    float thin = (1.0 - clamp(f/(w*0.62), 0.0, 1.0)) * fade;
    float hi = h / (uContourInterval*uIndexEvery);
    float wi = max(fwidth(hi), 1e-5);
    float fi = abs(fract(hi - 0.5) - 0.5);
    float hiFade = smoothstep(0.42, 0.18, wi);
    float thick = (1.0 - clamp(fi/(wi*0.85), 0.0, 1.0)) * hiFade;
    col = mix(col, col*0.42, thin*0.55);
    col = mix(col, col*0.26, thick*0.85);
  }

  /* 经纬网：真实坐标，不是装饰刻度 */
  if (uShowGrid == 1) {
    float lon = uLonLatNW.x + vUV.x * uLonLatSpan.x;
    float lat = uLonLatNW.y - vUV.y * uLonLatSpan.y;
    float gl = abs(fract(lon/uGridDeg - 0.5) - 0.5) / max(fwidth(lon/uGridDeg), 1e-5);
    float gt = abs(fract(lat/uGridDeg - 0.5) - 0.5) / max(fwidth(lat/uGridDeg), 1e-5);
    float line = 1.0 - clamp(min(gl, gt), 0.0, 1.0);
    col = mix(col, vec3(0.35,0.30,0.22), line*0.42);
  }

  outColor = vec4(col, 1.0);
}`;

/* --------------------------------------------------------------- 工具 */
function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error('着色器编译失败：' + log);
  }
  return s;
}
function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('链接失败：' + gl.getProgramInfoLog(p));
  return p;
}
/* terrain-RGB 解码成高程（JS 侧，供光标读数与拾取使用 —— 与着色器同一公式） */
function decodeDem(rgba, n) {
  const h = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) {
    h[i] = -10000 + (rgba[i * 4] * 65536 + rgba[i * 4 + 1] * 256 + rgba[i * 4 + 2]) * 0.1;
  }
  return h;
}
/* 等高距网格三角化 */
function gridMesh(n) {
  const verts = new Float32Array((n + 1) * (n + 1) * 2);
  let k = 0;
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
    verts[k++] = i / n; verts[k++] = j / n;
  }
  const idx = new Uint32Array(n * n * 6);
  k = 0;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
    idx[k++] = a; idx[k++] = c; idx[k++] = b;
    idx[k++] = b; idx[k++] = c; idx[k++] = d;
  }
  return { verts, idx, tris: n * n * 2 };
}

/* ================================================================ 引擎 */
class Atlas7 {
  constructor() {
    this.state = 'idle';
    this.layer = 0;
    this.vexag = 1;
    this.hillshadeMix = 1;
    this.showContour = 1;
    this.showGrid = 1;
    this.frames = 0;
    this.running = false;
    this._drag = null;
    this.cam = { yaw: 0.34, pitch: 0.54, dist: 0, tx: 0, ty: 0, tz: 0 };
    this.camWant = { yaw: 0.34, pitch: 0.54, dist: 0 };
  }

  async init(canvas, opt) {
    this.canvas = canvas;
    this.opt = Object.assign({ demUrl: 'data/dem-rgb.webp', gridN: 220, reduced: false }, opt || {});
    const gl = canvas.getContext('webgl2', {
      antialias: !this.opt.reduced, alpha: false, depth: true,
      powerPreference: 'high-performance'
    });
    if (!gl) { this.degrade('webgl2-unavailable'); return this.status(); }
    this.gl = gl;

    const R = CONFIG.region;
    const midLat = (R.south + R.north) / 2 * Math.PI / 180;
    CONFIG.world.w = (R.east - R.west) * 111320 * Math.cos(midLat);
    CONFIG.world.h = (R.north - R.south) * 111320;
    this.world = CONFIG.world;

    /* 载入真实高程：既做 GPU 纹理，也留一份 JS 数组供读数与拾取 */
    let img;
    try {
      const res = await fetch(this.opt.demUrl);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      img = await createImageBitmap(await res.blob());
    } catch (e) { this.degrade('dem-load-failed'); return this.status(); }

    const N = CONFIG.grid;
    const oc = new OffscreenCanvas(N, N);
    const og = oc.getContext('2d', { willReadFrequently: true });
    og.drawImage(img, 0, 0, N, N);
    const px = og.getImageData(0, 0, N, N).data;
    this.dem = decodeDem(px, N);
    this.demN = N;

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);   // 第 0 行 = 北 = v0
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.tex = tex;

    this.prog = program(gl, VS, FS);
    this.u = {};
    for (const n of ['uViewProj', 'uDem', 'uWorldSize', 'uVExag', 'uTexel', 'uCell',
      'uContourInterval', 'uIndexEvery', 'uHeightRange', 'uLayer', 'uHillshade',
      'uLonLatNW', 'uLonLatSpan', 'uGridDeg', 'uShowContour', 'uShowGrid']) {
      this.u[n] = gl.getUniformLocation(this.prog, n);
    }

    const m = gridMesh(this.opt.gridN);
    this.tris = m.tris;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, m.verts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.vao = vao; this.indexCount = m.idx.length;
    this.indexType = gl.UNSIGNED_INT;

    /* 相机初始：看向区域中心，距离按区域实长定 */
    this.cam.tx = this.world.w / 2;
    this.cam.ty = CONFIG.height.mean;
    this.cam.tz = this.world.h / 2;
    this.cam.dist = this.camWant.dist = Math.max(this.world.w, this.world.h) * 0.86;

    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0.93, 0.92, 0.89, 1);

    this.canvas.addEventListener('webglcontextlost', e => {
      e.preventDefault(); this.degrade('context-lost');
    });
    this.state = 'ready';
    return this.status();
  }

  degrade(reason) {
    this.state = 'degraded';
    this.degradeReason = reason;
    this.running = false;
    this.onFrame = null;
    document.documentElement.classList.add('no-webgl');
    const c = this.canvas;
    if (c) { c.hidden = true; c.setAttribute('aria-hidden', 'true'); }
    window.dispatchEvent(new CustomEvent('atlas7:degraded', { detail: this.status() }));
  }

  status() {
    return {
      state: this.state,
      reason: this.degradeReason || null,
      tris: this.tris || 0,
      gridN: this.opt ? this.opt.gridN : 0,
      demGrid: this.demN || 0,
      layer: CONFIG.layers[this.layer],
      vexag: this.vexag,
      frames: this.frames,
      region: CONFIG.region,
      contour: CONFIG.contour,
      world: this.world || null
    };
  }

  /* ---------------------------------------------------- 相机与每帧 */
  eye() {
    const c = this.cam;
    const cp = Math.cos(c.pitch), sp = Math.sin(c.pitch);
    return [
      c.tx + c.dist * cp * Math.sin(c.yaw),
      c.ty + c.dist * sp,
      c.tz + c.dist * cp * Math.cos(c.yaw)
    ];
  }
  viewProj() {
    const w = this.canvas.width, h = this.canvas.height;
    const proj = M4.perspective(48 * Math.PI / 180, w / h, 50, 400000);
    const view = M4.lookAt(this.eye(), [this.cam.tx, this.cam.ty, this.cam.tz], [0, 1, 0]);
    this._vp = M4.mul(proj, view);
    this._invVP = M4.invert(this._vp);
    return this._vp;
  }

  setSize(dpr) {
    const r = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
  }

  draw(dt) {
    const gl = this.gl;
    if (!gl || this.state !== 'ready') return;
    /* 帧率无关阻尼：固定 lerp 在 120Hz 和 30Hz 手感完全不同 */
    const k = 1 - Math.exp(-dt * 5.0);
    this.cam.yaw += (this.camWant.yaw - this.cam.yaw) * k;
    this.cam.pitch += (this.camWant.pitch - this.cam.pitch) * k;
    this.cam.dist += (this.camWant.dist - this.cam.dist) * k;
    this.viewProj();

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(this.u.uDem, 0);
    gl.uniformMatrix4fv(this.u.uViewProj, false, this._vp);
    gl.uniform2f(this.u.uWorldSize, this.world.w, this.world.h);
    gl.uniform1f(this.u.uVExag, this.vexag);
    gl.uniform2f(this.u.uTexel, 1 / this.demN, 1 / this.demN);
    gl.uniform2f(this.u.uCell, CONFIG.cell.ew, CONFIG.cell.ns);
    gl.uniform1f(this.u.uContourInterval, CONFIG.contour.interval);
    gl.uniform1f(this.u.uIndexEvery, CONFIG.contour.indexEvery);
    gl.uniform2f(this.u.uHeightRange, CONFIG.height.min, CONFIG.height.max);
    gl.uniform1i(this.u.uLayer, this.layer);
    gl.uniform1f(this.u.uHillshade, this.hillshadeMix);
    gl.uniform2f(this.u.uLonLatNW, CONFIG.region.west, CONFIG.region.north);
    gl.uniform2f(this.u.uLonLatSpan, CONFIG.region.east - CONFIG.region.west,
      CONFIG.region.north - CONFIG.region.south);
    gl.uniform1f(this.u.uGridDeg, CONFIG.graticule.deg);
    gl.uniform1i(this.u.uShowContour, this.showContour);
    gl.uniform1i(this.u.uShowGrid, this.showGrid);
    gl.drawElements(gl.TRIANGLES, this.indexCount, this.indexType, 0);
    gl.bindVertexArray(null);
    this.frames++;
  }

  start() {
    if (this.running || this.state !== 'ready') return;
    this.running = true;
    let last = performance.now();
    const loop = now => {
      if (!this.running) return;
      const dt = Math.min(0.1, (now - last) / 1000); last = now;
      this.draw(dt);
      if (this.onFrame) this.onFrame(this.status());
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }
  stop() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }
  /* 减少动态效果时：只画一帧，之后靠外部调用 drawOnce() */
  drawOnce() {
    if (this.state !== 'ready') return;
    this.draw(0.016);
    if (this.onFrame) this.onFrame(this.status());
  }

  /* 画面探针：**必须在同一帧内 draw 后立刻 readPixels**。
     默认 preserveDrawingBuffer:false 时，合成之后再读只会拿到全零 ——
     这不是"画面是黑的"，而是读得太晚。所以探针自己画一帧再读。 */
  probe(w, h) {
    if (this.state !== 'ready') return null;
    this.draw(0.016);
    const gl = this.gl;
    const W = Math.min(w || 240, this.canvas.width);
    const H = Math.min(h || 160, this.canvas.height);
    const px = new Uint8Array(W * H * 4);
    gl.readPixels(Math.floor((this.canvas.width - W) / 2), Math.floor((this.canvas.height - H) / 2),
      W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let min = 255, max = 0, sum = 0;
    const buckets = new Set();
    for (let i = 0; i < W * H; i++) {
      const v = Math.round((px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2]) / 3);
      if (v < min) min = v; if (v > max) max = v; sum += v;
      buckets.add(v >> 3);
    }
    return { w: W, h: H, min, max, mean: sum / (W * H), buckets: buckets.size };
  }

  /* ---------------------------------------------------- 交互 */
  attachInput(dpr) {
    const c = this.canvas;
    c.style.touchAction = 'none';
    const pos = e => {
      const r = c.getBoundingClientRect();
      return [(e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr];
    };
    c.addEventListener('pointerdown', e => {
      if (e.pointerType === 'touch' && e.isPrimary === false) return;
      this._drag = { x: e.clientX, y: e.clientY };
      c.setPointerCapture(e.pointerId);
    });
    const up = e => {
      this._drag = null;
      if (c.hasPointerCapture && c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId);
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('lostpointercapture', () => { this._drag = null; });
    c.addEventListener('pointermove', e => {
      const p = pos(e);
      if (this.onHover) this.onHover(p[0] / dpr, p[1] / dpr);
      if (!this._drag) return;
      const dx = e.clientX - this._drag.x, dy = e.clientY - this._drag.y;
      if (e.pointerType === 'touch' && Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
      this.camWant.yaw -= dx * 0.006;
      this.camWant.pitch = Math.max(0.08, Math.min(1.45, this.camWant.pitch + dy * 0.005));
      this._drag = { x: e.clientX, y: e.clientY };
      if (!this.running) this.drawOnce();
    });
    /* 滚轮必须 passive:false 才能 preventDefault，否则默认 passive 会让缩放同时滚页 */
    c.addEventListener('wheel', e => {
      e.preventDefault();
      this.camWant.dist = Math.max(this.world.w * 0.10,
        Math.min(this.world.w * 2.4, this.camWant.dist * Math.exp(e.deltaY * 0.0012)));
      if (!this.running) this.drawOnce();
    }, { passive: false });
  }

  /* --------------------------------- 拾取：屏幕像素 → 地面点（射线步进） */
  pick(px, py) {
    if (!this._invVP || !this.dem) return null;
    const w = this.canvas.width, h = this.canvas.height;
    const ndcX = (px / w) * 2 - 1, ndcY = 1 - (py / h) * 2;
    const p0 = M4.xform(this._invVP, [ndcX, ndcY, -1, 1]);
    const p1 = M4.xform(this._invVP, [ndcX, ndcY, 1, 1]);
    const a = [p0[0] / p0[3], p0[1] / p0[3], p0[2] / p0[3]];
    const b = [p1[0] / p1[3], p1[1] / p1[3], p1[2] / p1[3]];
    let dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const len = Math.hypot(dx, dy, dz) || 1; dx /= len; dy /= len; dz /= len;
    const maxT = this.cam.dist * 4;
    const step = Math.max(8, maxT / 420);
    let t = 0, prevDiff = null, prevT = 0;
    for (let i = 0; i < 460 && t < maxT; i++, t += step) {
      const x = a[0] + dx * t, y = a[1] + dy * t, z = a[2] + dz * t;
      const u = x / this.world.w, v = z / this.world.h;
      if (u < 0 || u > 1 || v < 0 || v > 1) { prevDiff = null; prevT = t; continue; }
      const gh = this.sampleDem(u, v) * this.vexag;
      const diff = y - gh;
      if (prevDiff !== null && prevDiff > 0 && diff <= 0) {
        /* 二分细化，落到米级 */
        let lo = prevT, hi = t;
        for (let k = 0; k < 26; k++) {
          const mid = (lo + hi) / 2;
          const mx = a[0] + dx * mid, my = a[1] + dy * mid, mz = a[2] + dz * mid;
          const mu = mx / this.world.w, mv = mz / this.world.h;
          const mh = (mu >= 0 && mu <= 1 && mv >= 0 && mv <= 1)
            ? this.sampleDem(mu, mv) * this.vexag : -1e9;
          if (my - mh > 0) lo = mid; else hi = mid;
        }
        const ft = (lo + hi) / 2;
        const fx = a[0] + dx * ft, fz = a[2] + dz * ft;
        return this.describe(fx / this.world.w, fz / this.world.h);
      }
      prevDiff = diff; prevT = t;
    }
    return null;
  }

  sampleDem(u, v) {
    const n = this.demN;
    const x = Math.min(n - 1.001, Math.max(0, u * (n - 1)));
    const y = Math.min(n - 1.001, Math.max(0, v * (n - 1)));
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const at = (r, c) => this.dem[r * n + c];
    const a = at(y0, x0) * (1 - fx) + at(y0, x0 + 1) * fx;
    const b = at(y0 + 1, x0) * (1 - fx) + at(y0 + 1, x0 + 1) * fx;
    return a * (1 - fy) + b * fy;
  }

  /* 由网格坐标得到经纬度、高程、坡度、坡向 —— 读数与图面必须用同一份数 */
  describe(u, v) {
    const n = this.demN;
    const R = CONFIG.region;
    const lon = R.west + u * (R.east - R.west);
    const lat = R.north - v * (R.north - R.south);
    const h = this.sampleDem(u, v);
    const du = 1 / (n - 1), dv = 1 / (n - 1);
    const hL = this.sampleDem(u - du, v), hR = this.sampleDem(u + du, v);
    const hN = this.sampleDem(u, v - dv), hS = this.sampleDem(u, v + dv);
    const p = (hR - hL) / (2 * CONFIG.cell.ew);
    const q = (hN - hS) / (2 * CONFIG.cell.ns);
    const slope = Math.atan(Math.hypot(p, q)) * 180 / Math.PI;
    const aspect = (Math.atan2(-p, -q) * 180 / Math.PI + 360) % 360;
    return { u, v, lon, lat, h, slope, aspect };
  }

  /* 屏幕某点的比例尺：量"该点"与"它右边 base 个 CSS 像素"落在地面上的距离，再除以 base。
     基线取 10 而不是 1 —— 相邻一像素常常落进同一个纹素，相减会得到 0，
     比例尺就永远是空的。返回 null 时由调用方退化到解析估计。 */
  metersPerPixel(px, py, dpr) {
    const base = 10;
    const a = this.pick(px * dpr, py * dpr);
    const b = this.pick((px + base) * dpr, py * dpr);
    if (!a || !b) return null;
    const mLon = 111320 * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
    const dE = (b.lon - a.lon) * mLon;
    const dN = (b.lat - a.lat) * 111320;
    const m = Math.hypot(dE, dN) / base;
    return m > 0 ? m : null;
  }

  /* 网格坐标 → 屏幕设备像素。叠加层（样地点、注记）靠它定位。
     返回 null 表示在相机后方。 */
  projectUV(u, v) {
    if (!this._vp) this.viewProj();
    const h = this.sampleDem(u, v) * this.vexag;
    const p = M4.xform(this._vp, [u * this.world.w, h, v * this.world.h, 1]);
    if (p[3] <= 0) return null;
    return [
      (p[0] / p[3] * 0.5 + 0.5) * this.canvas.width,
      (1 - (p[1] / p[3] * 0.5 + 0.5)) * this.canvas.height
    ];
  }

  /* 解析估计：在目标深度上，一个像素对应的世界距离。地层不是平面，
     所以它只能当退路，页面上必须标明比例尺的来源。 */
  metersPerPixelEstimated(cssHeight) {
    const fov = 48 * Math.PI / 180;
    return 2 * Math.tan(fov / 2) * this.cam.dist / Math.max(1, cssHeight);
  }
}

window.Atlas7 = Atlas7;
window.__atlas7Config = CONFIG;