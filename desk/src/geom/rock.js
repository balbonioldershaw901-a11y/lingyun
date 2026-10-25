// rock.js — 太湖石 / 供石：低多边形 + 孔洞
//
// 流程：
//   icosphere(subdiv) → 归一化 → 半径按 fBm/ridged 位移 → 底部拍平 → 采"掏空场" → 删面 → 去碎块
// 法线：
//   - flat = true  → 面法线（非索引），低多边形石头就是要块面感（推荐移动端）
//   - flat = false → 面积加权顶点平均（位移+删面后没有解析法线可用）
// 绕序：删面后是开放曲面（有洞），关背面剔除 + gl_FrontFacing 翻法线。

import { MeshBuilder, fbm3, ridged3, smoothstep, clamp, computeVertexNormals, toFlatShaded, keepLargestComponent, geoStats } from './util.js';

/** 正二十面体细分球（顶点焊接，返回 {positions, indices}） */
export function icosphere(subdivisions = 3) {
  const t = (1 + Math.sqrt(5)) / 2;
  let verts = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map((v) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; });
  let faces = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  const cache = new Map();
  const midpoint = (a, b) => {
    const key = a < b ? `${a}_${b}` : `${b}_${a}`;
    let m = cache.get(key);
    if (m !== undefined) return m;
    const x = (verts[a][0] + verts[b][0]) / 2, y = (verts[a][1] + verts[b][1]) / 2, z = (verts[a][2] + verts[b][2]) / 2;
    const l = Math.hypot(x, y, z) || 1;
    verts.push([x / l, y / l, z / l]);
    m = verts.length - 1; cache.set(key, m);
    return m;
  };
  for (let s = 0; s < subdivisions; s++) {
    const next = [];
    for (const [a, b, c] of faces) {
      const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    faces = next;
  }
  const positions = new Float32Array(verts.length * 3);
  verts.forEach((v, i) => { positions[i * 3] = v[0]; positions[i * 3 + 1] = v[1]; positions[i * 3 + 2] = v[2]; });
  const indices = new Uint32Array(faces.length * 3);
  faces.forEach((f, i) => { indices[i * 3] = f[0]; indices[i * 3 + 1] = f[1]; indices[i * 3 + 2] = f[2]; });
  return { positions, indices };
}

/**
 * 太湖石
 * @param amp     位移幅度（相对半径）
 * @param ridgedAmt 0=fBm，1=全用 ridged（脊线更像风化皱）
 * @param holes   掏空比例：被删掉的面占总面数的目标比例（0.25 ≈ 四分之一的面镂空）
 * @param holeFreq 掏空场频率（越大孔越多越小）
 * @param squashY 竖向压扁
 * @param flatBottom 底部拍平程度（供石要坐得住）
 */
export function makeScholarRock({
  radius = 95,
  subdiv = 3,
  amp = 0.34,
  freq = 1.35,
  octaves = 4,
  ridgedAmt = 0.55,
  holes = 0.32,
  holeFreq = 2.1,
  holeBias = 0.15,
  squashY = 1.05,
  flatBottom = 0.35,
  seed = 3.17,
  seed2 = 11.3,
  flat = true,
  shellPull = 0.06,   // 孔洞边缘向内拉一点，让"洞"看起来有厚度
} = {}) {
  const ico = icosphere(subdiv);
  const n = ico.positions.length / 3;
  const positions = new Float32Array(ico.positions.length);
  const disp = new Float32Array(n); // 记录归一化位移量，供孔洞场复用
  for (let i = 0; i < n; i++) {
    const x = ico.positions[i * 3], y = ico.positions[i * 3 + 1], z = ico.positions[i * 3 + 2];
    const f = fbm3(x * freq + seed, y * freq + seed, z * freq + seed, { octaves, gain: 0.52 });
    const r = ridged3(x * freq * 0.6 + seed2, y * freq * 0.6 + seed2, z * freq * 0.6 + seed2, { octaves: Math.max(2, octaves - 1) });
    const d = (1 - ridgedAmt) * f + ridgedAmt * r;
    disp[i] = d;
    const s = radius * (1 + amp * d);
    let px = x * s, py = y * s * squashY, pz = z * s;
    // 供石要能立住：底部按 y 拍平
    if (py < 0) py *= (1 - flatBottom);
    positions[i * 3] = px; positions[i * 3 + 1] = py; positions[i * 3 + 2] = pz;
  }
  // ---- 掏空场：对每个面的重心求值，按分位数删面（holes 有明确含义）----
  const triCount = ico.indices.length / 3;
  const faceVal = new Float32Array(triCount);
  const cx = new Float32Array(triCount), cy = new Float32Array(triCount), cz = new Float32Array(triCount);
  for (let t = 0; t < triCount; t++) {
    const a = ico.indices[t * 3], b = ico.indices[t * 3 + 1], c = ico.indices[t * 3 + 2];
    const mx = (positions[a * 3] + positions[b * 3] + positions[c * 3]) / 3;
    const my = (positions[a * 3 + 1] + positions[b * 3 + 1] + positions[c * 3 + 1]) / 3;
    const mz = (positions[a * 3 + 2] + positions[b * 3 + 2] + positions[c * 3 + 2]) / 3;
    cx[t] = mx; cy[t] = my; cz[t] = mz;
    // 用另外一个频率的噪声当"掏空场"，和外形噪声解耦
    const g = fbm3(mx / radius * holeFreq + seed2, my / radius * holeFreq + seed2 * 0.7, mz / radius * holeFreq + seed2, { octaves: 3, gain: 0.6 });
    faceVal[t] = g + holeBias;
  }
  const sorted = Float32Array.from(faceVal).sort();
  const cut = sorted[Math.min(triCount - 1, Math.max(0, Math.floor((1 - holes) * triCount)))];
  const keep = [];
  for (let t = 0; t < triCount; t++) {
    if (faceVal[t] > cut) continue; // 高于阈值 → 掏掉
    keep.push(ico.indices[t * 3], ico.indices[t * 3 + 1], ico.indices[t * 3 + 2]);
  }
  // 孔洞边缘向内轻拉（视觉上"洞有厚度"）
  if (shellPull > 0) {
    const onHole = new Uint8Array(n);
    for (let t = 0; t < triCount; t++) {
      if (faceVal[t] <= cut) continue;
      for (let k = 0; k < 3; k++) onHole[ico.indices[t * 3 + k]] = 1;
    }
    for (let i = 0; i < n; i++) {
      if (!onHole[i]) continue;
      const k = 1 - shellPull;
      positions[i * 3] *= k; positions[i * 3 + 1] *= k; positions[i * 3 + 2] *= k;
    }
  }
  let geo = { positions, normals: new Float32Array(positions.length), uvs: new Float32Array(n * 2), indices: new Uint32Array(keep), groups: [] };
  // uv：球面参数化（程序化石纹用）
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    const l = Math.hypot(x, y, z) || 1;
    geo.uvs[i * 2] = (Math.atan2(z, x) / (Math.PI * 2) + 0.5);
    geo.uvs[i * 2 + 1] = Math.acos(clamp(y / l, -1, 1)) / Math.PI;
  }
  geo = keepLargestComponent(geo); // 删面会留下漂浮碎块，必须清
  geo.normals = computeVertexNormals(geo.positions, geo.indices, { mode: 'area' });
  if (flat) geo = toFlatShaded(geo);
  geo.meta = { doubleSided: true, hasHoles: true, stats: geoStats(geo) };
  return geo;
}