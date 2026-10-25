// util.js — 无依赖基础库：确定性噪声 / 网格构建 / 法线 / 绕序 / 极小 mat4
// 说明用中文，代码注释可用英文。纯 JS，可在 Node 里 import 做面数预算（不碰 DOM）。

export const TAU = Math.PI * 2;

/* =====================================================================
 * 1. 确定性噪声
 * 用整数 hash（Math.imul），不用 Math.sin 技巧：位级确定，跨平台一致，
 * 便于"同一 seed 出同一块太湖石"这种可复现需求。
 * ===================================================================== */
export function hash3i(ix, iy, iz) {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ Math.imul(iz | 0, 1440662683);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296; // [0,1)
}

// 5 次 fade（quintic）→ 一阶/二阶导连续，法线不会出现格点条纹
const fade5 = (t) => t * t * t * (t * (t * 6 - 15) + 10);

export function valueNoise3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = fade5(xf), v = fade5(yf), w = fade5(zf);
  const c000 = hash3i(xi, yi, zi), c100 = hash3i(xi + 1, yi, zi);
  const c010 = hash3i(xi, yi + 1, zi), c110 = hash3i(xi + 1, yi + 1, zi);
  const c001 = hash3i(xi, yi, zi + 1), c101 = hash3i(xi + 1, yi, zi + 1);
  const c011 = hash3i(xi, yi + 1, zi + 1), c111 = hash3i(xi + 1, yi + 1, zi + 1);
  const x00 = c000 + (c100 - c000) * u, x10 = c010 + (c110 - c010) * u;
  const x01 = c001 + (c101 - c001) * u, x11 = c011 + (c111 - c011) * u;
  const y0 = x00 + (x10 - x00) * v, y1 = x01 + (x11 - x01) * v;
  return y0 + (y1 - y0) * w;
}

export const noise3 = (x, y, z) => valueNoise3(x, y, z) * 2 - 1; // [-1,1]
export const noise2 = (x, y) => noise3(x, y, 0.371);

/** fBm，返回约 [-1,1]（按振幅和归一化，不随 octaves 改变振幅） */
export function fbm3(x, y, z, { octaves = 4, freq = 1, lacunarity = 2.0, gain = 0.5 } = {}) {
  let amp = 1, sum = 0, norm = 0, f = freq;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise3(x * f, y * f, z * f);
    norm += amp; amp *= gain; f *= lacunarity;
  }
  return sum / norm;
}

/** ridged fBm：太湖石的"皱"，脊线比 fBm 更像风化岩 */
export function ridged3(x, y, z, opts = {}) {
  const n = fbm3(x, y, z, opts);
  return 1 - Math.abs(n) * 2; // [-1,1]，0 处形成脊
}

/** 平滑 min（smin），用于把两个形体"糊"成一个，避免硬接缝 */
export function smin(a, b, k) {
  const h = Math.max(0, Math.min(1, 0.5 + 0.5 * (b - a) / k));
  return b + (a - b) * h - k * h * (1 - h);
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0 || 1e-9), 0, 1);
  return t * t * (3 - 2 * t);
};
export const lerp = (a, b, t) => a + (b - a) * t;

/* =====================================================================
 * 2. 三角网格容器
 * 生成器统一返回 { positions, normals, uvs, indices, groups? }
 *   positions/normals: Float32Array(3N)  uvs: Float32Array(2N)
 *   indices: Uint16Array 或 Uint32Array（>65535 顶点自动用 32 位）
 *   groups : [{ first, count, material }]  索引区间 + 材质名（供"一次 draw"烘焙用）
 * ===================================================================== */
export class MeshBuilder {
  constructor() {
    this.p = []; this.pn = []; this.puv = []; this.idx = [];
    this._groups = []; this._groupStart = 0; this._groupMat = null;
  }
  /** 开启一个材质分组（索引区间）。material 是字符串名，见 scene.js 的材质表 */
  group(material) {
    if (this._groupMat !== null) this._groups.push({ first: this._groupStart, count: this.idx.length - this._groupStart, material: this._groupMat });
    this._groupStart = this.idx.length; this._groupMat = material;
    return this;
  }
  vert(x, y, z, nx = 0, ny = 1, nz = 0, u = 0, v = 0) {
    const i = this.p.length / 3;
    this.p.push(x, y, z); this.pn.push(nx, ny, nz); this.puv.push(u, v);
    return i;
  }
  /** 取某顶点已有位置（用于复制顶点做硬边/材质缝） */
  posAt(i) { return [this.p[i * 3], this.p[i * 3 + 1], this.p[i * 3 + 2]]; }
  normalAt(i) { return [this.pn[i * 3], this.pn[i * 3 + 1], this.pn[i * 3 + 2]]; }
  uvAt(i) { return [this.puv[i * 2], this.puv[i * 2 + 1]]; }
  tri(a, b, c) { this.idx.push(a, b, c); return this; }
  /** 四边形按 (a,b,c,d) 逆时针给；内部拆成 (a,b,c)+(a,c,d) */
  quad(a, b, c, d) { this.idx.push(a, b, c, a, c, d); return this; }
  /** 统一的"环带"助手：上/内行 upper 与下/外行 lower，用 outward 绕序 quad(A,D,C,B) */
  quadBand(upper, lower, i, j, n) {
    const a = upper[i % n], b = upper[(i + 1) % n];
    const c = lower[(i + 1) % n], d = lower[i % n];
    this.quad(a, d, c, b);
    return this;
  }
  get triCount() { return this.idx.length / 3; }
  get vertCount() { return this.p.length / 3; }
  build({ forceUint32 = false } = {}) {
    if (this._groupMat !== null) this._groups.push({ first: this._groupStart, count: this.idx.length - this._groupStart, material: this._groupMat });
    const n = this.p.length / 3;
    const IndexArray = (forceUint32 || n > 65535) ? Uint32Array : Uint16Array;
    return {
      positions: new Float32Array(this.p),
      normals: new Float32Array(this.pn),
      uvs: new Float32Array(this.puv),
      indices: new IndexArray(this.idx),
      groups: this._groups.slice(),
    };
  }
}

export function geoStats(geo) {
  return { verts: geo.positions.length / 3, tris: geo.indices.length / 3 };
}

/* =====================================================================
 * 3. 法线
 * 策略（本工程采用）：
 *   - 解析法线：外形可用公式描述的（球/椭球/车削剖面/扫掠管/高度场）→ 精确、无接缝、无平均钝化
 *   - 面积加权顶点平均：位移 + 删面后的太湖石 → 只能重算，且面积加权（叉积模长=2*面积，累加即加权）
 *   - 面法线（flat，非索引）：低多边形太湖石想要"石头块面感"时反而更好看
 * ===================================================================== */
export function computeVertexNormals(positions, indices, { mode = 'area' } = {}) {
  const n = new Float32Array(positions.length);
  const angle = mode === 'angle';
  for (let t = 0; t < indices.length; t += 3) {
    const ia = indices[t] * 3, ib = indices[t + 1] * 3, ic = indices[t + 2] * 3;
    const ax = positions[ia], ay = positions[ia + 1], az = positions[ia + 2];
    const e1x = positions[ib] - ax, e1y = positions[ib + 1] - ay, e1z = positions[ib + 2] - az;
    const e2x = positions[ic] - ax, e2y = positions[ic + 1] - ay, e2z = positions[ic + 2] - az;
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    if (angle) { // 角度加权：抑制细长三角形的过度影响
      const l1 = Math.hypot(e1x, e1y, e1z), l2 = Math.hypot(e2x, e2y, e2z);
      const l3 = Math.hypot(positions[ic] - positions[ib], positions[ic + 1] - positions[ib + 1], positions[ic + 2] - positions[ib + 2]);
      const p = (l1 + l2 + l3) / 2;
      const area = nx * nx + ny * ny + nz * nz;
      const r = area > 0 ? (l1 * l2 * l3) / (4 * Math.sqrt(area)) : 0; // 外接圆半径
      const w = r > 1e-12 ? 1 / (r * r) : 1; // ∝ 顶角
      nx *= w; ny *= w; nz *= w;
    }
    n[ia] += nx; n[ia + 1] += ny; n[ia + 2] += nz;
    n[ib] += nx; n[ib + 1] += ny; n[ib + 2] += nz;
    n[ic] += nx; n[ic + 1] += ny; n[ic + 2] += nz;
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
    n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
  }
  return n;
}

/** 转成非索引 + 面法线（硬块面感，顶点数 = 3×三角形数，移动端慎用） */
export function toFlatShaded(geo) {
  const tri = geo.indices.length / 3;
  const positions = new Float32Array(tri * 9), normals = new Float32Array(tri * 9);
  const uvs = geo.uvs && geo.uvs.length ? new Float32Array(tri * 6) : null;
  for (let t = 0; t < tri; t++) {
    const ia = geo.indices[t * 3], ib = geo.indices[t * 3 + 1], ic = geo.indices[t * 3 + 2];
    const ax = geo.positions[ia * 3], ay = geo.positions[ia * 3 + 1], az = geo.positions[ia * 3 + 2];
    const bx = geo.positions[ib * 3], by = geo.positions[ib * 3 + 1], bz = geo.positions[ib * 3 + 2];
    const cx = geo.positions[ic * 3], cy = geo.positions[ic * 3 + 1], cz = geo.positions[ic * 3 + 2];
    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    const o = t * 9;
    positions.set([ax, ay, az, bx, by, bz, cx, cy, cz], o);
    normals.set([nx, ny, nz, nx, ny, nz, nx, ny, nz], o);
    if (uvs) {
      const ou = t * 6;
      uvs.set([geo.uvs[ia * 2], geo.uvs[ia * 2 + 1], geo.uvs[ib * 2], geo.uvs[ib * 2 + 1], geo.uvs[ic * 2], geo.uvs[ic * 2 + 1]], ou);
    }
  }
  const indices = new Uint32Array(tri * 3);
  for (let i = 0; i < indices.length; i++) indices[i] = i;
  return { positions, normals, uvs, indices, groups: geo.groups ? geo.groups.slice() : [] };
}

/* =====================================================================
 * 4. 绕序与朝向
 * WebGL 默认 frontFace = CCW，cullFace(BACK)。闭合网格用有向体积自检：
 *   V = Σ dot(v0, cross(v1,v2)) / 6    V>0 → 外法线朝外（CCW 朝外）
 * 生成器里我按推导好的绕序写，但用这个函数兜底，绝不靠"看起来对不对"。
 * ===================================================================== */
export function signedVolume(positions, indices) {
  let vol = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
    const bx = positions[b], by = positions[b + 1], bz = positions[b + 2];
    const cx = positions[c], cy = positions[c + 1], cz = positions[c + 2];
    vol += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return vol / 6;
}

/** 闭合网格朝向修正：体积为负则整体反转索引绕序（法线数组不动，它们本来就是朝外的） */
export function orientOutward(geo) {
  const v = signedVolume(geo.positions, geo.indices);
  if (v >= 0) return { geo, flipped: false, volume: v };
  const idx = geo.indices;
  for (let t = 0; t < idx.length; t += 3) { const tmp = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = tmp; }
  return { geo, flipped: true, volume: -v };
}

/**
 * 绕序对齐自检（本工程最省心的一招）：
 * 逐三角形比较"几何面法线"与"三个顶点法线的和"，
 * 若点积 < 0 说明这个三角的绕序与作者给的法线相反 → 就地翻转。
 * 优点：对开放曲面也成立（不需要闭合体积），能定位到具体哪个面写反了；
 *       和"有向体积"配合使用：体积判全局方向，本函数判逐面一致性。
 * 返回翻转的三角形个数（生成器写对了就是 0，非 0 说明推导有错，要修生成器）。
 */
export function alignWindingToNormals(geo) {
  const idx = geo.indices, P = geo.positions, N = geo.normals;
  let flipped = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
    const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
    const fx = e1y * e2z - e1z * e2y, fy = e1z * e2x - e1x * e2z, fz = e1x * e2y - e1y * e2x;
    const nx = N[a] + N[b] + N[c], ny = N[a + 1] + N[b + 1] + N[c + 1], nz = N[a + 2] + N[b + 2] + N[c + 2];
    if (fx * nx + fy * ny + fz * nz < 0) {
      const tmp = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = tmp;
      flipped++;
    }
  }
  return flipped;
}

/** 只保留最大连通分量：太湖石掏洞后删面会产生漂浮碎块，必须清掉 */
export function keepLargestComponent(geo) {
  const tri = geo.indices.length / 3;
  const edgeMap = new Map(); // "a_b" -> tri 列表
  const key = (a, b) => (a < b ? a * 4294967296 + b : b * 4294967296 + a);
  for (let t = 0; t < tri; t++) {
    const a = geo.indices[t * 3], b = geo.indices[t * 3 + 1], c = geo.indices[t * 3 + 2];
    for (const [x, y] of [[a, b], [b, c], [c, a]]) {
      const k = key(x, y);
      let arr = edgeMap.get(k); if (!arr) edgeMap.set(k, arr = []); arr.push(t);
    }
  }
  const seen = new Uint8Array(tri);
  let best = [], bestSize = -1;
  for (let s = 0; s < tri; s++) {
    if (seen[s]) continue;
    const stack = [s]; seen[s] = 1; const comp = [];
    while (stack.length) {
      const t = stack.pop(); comp.push(t);
      const a = geo.indices[t * 3], b = geo.indices[t * 3 + 1], c = geo.indices[t * 3 + 2];
      for (const [x, y] of [[a, b], [b, c], [c, a]]) {
        for (const o of edgeMap.get(key(x, y))) if (!seen[o]) { seen[o] = 1; stack.push(o); }
      }
    }
    if (comp.length > bestSize) { bestSize = comp.length; best = comp; }
  }
  const indices = new Uint32Array(best.length * 3);
  best.forEach((t, i) => { indices[i * 3] = geo.indices[t * 3]; indices[i * 3 + 1] = geo.indices[t * 3 + 1]; indices[i * 3 + 2] = geo.indices[t * 3 + 2]; });
  return { ...geo, indices, removedTriangles: tri - best.length };
}

export function computeBounds(positions) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max, center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2], size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

/* =====================================================================
 * 5. 烘焙变换 + 合并（"一次 draw" 的基础设施）
 * 非均匀缩放时法线必须用逆转置：n' = normalize(n / s)，否则光照会歪。
 * ===================================================================== */
export function bakeTransform(geo, { translate = [0, 0, 0], rotateY = 0, rotateX = 0, scale = 1 } = {}) {
  const s = Array.isArray(scale) ? scale : [scale, scale, scale];
  const cy = Math.cos(rotateY), sy = Math.sin(rotateY);
  const cx = Math.cos(rotateX), sx = Math.sin(rotateX);
  const p = new Float32Array(geo.positions.length), n = new Float32Array(geo.normals.length);
  for (let i = 0; i < geo.positions.length; i += 3) {
    let x = geo.positions[i] * s[0], y = geo.positions[i + 1] * s[1], z = geo.positions[i + 2] * s[2];
    // X 轴旋转
    let y1 = y * cx - z * sx, z1 = y * sx + z * cx;
    // Y 轴旋转
    let x2 = x * cy + z1 * sy, z2 = -x * sy + z1 * cy;
    p[i] = x2 + translate[0]; p[i + 1] = y1 + translate[1]; p[i + 2] = z2 + translate[2];
    // 法线：逆缩放（逆转置）
    let nx = geo.normals[i] / s[0], ny = geo.normals[i + 1] / s[1], nz = geo.normals[i + 2] / s[2];
    let ny1 = ny * cx - nz * sx, nz1 = ny * sx + nz * cx;
    let nx2 = nx * cy + nz1 * sy, nz2 = -nx * sy + nz1 * cy;
    const l = Math.hypot(nx2, ny1, nz2) || 1;
    n[i] = nx2 / l; n[i + 1] = ny1 / l; n[i + 2] = nz2 / l;
  }
  return { ...geo, positions: p, normals: n };
}

/**
 * 把多个 geo 合并成"一个 VBO + 一个 IBO + 每顶点材质号"。
 * 材质号按顶点写：分组边界处顶点会被复制（同一个顶点属于两种材质时无法共享），
 * 这是静态场景换取"1 次 draw call"的正常代价（顶点数增加 5~15%）。
 */
export function mergeGeometries(items, materialIndexOf) {
  const positions = [], normals = [], uvs = [], indices = [], matIds = [];
  let vBase = 0;
  for (const it of items) {
    const geo = it.geo;
    const groups = (geo.groups && geo.groups.length) ? geo.groups : [{ first: 0, count: geo.indices.length, material: it.material }];
    for (const g of groups) {
      const mat = materialIndexOf(it.material || g.material);
      const remap = new Map();
      for (let k = g.first; k < g.first + g.count; k++) {
        const old = geo.indices[k];
        let ni = remap.get(old);
        if (ni === undefined) {
          ni = vBase + positions.length / 3;
          positions.push(geo.positions[old * 3], geo.positions[old * 3 + 1], geo.positions[old * 3 + 2]);
          normals.push(geo.normals[old * 3], geo.normals[old * 3 + 1], geo.normals[old * 3 + 2]);
          uvs.push(geo.uvs ? geo.uvs[old * 2] : 0, geo.uvs ? geo.uvs[old * 2 + 1] : 0);
          matIds.push(mat);
          remap.set(old, ni);
        }
        indices.push(ni);
      }
    }
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    matIds: new Uint8Array(matIds),
    indices: new Uint32Array(indices),
    drawCalls: 1,
  };
}