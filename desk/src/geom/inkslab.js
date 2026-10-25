// inkslab.js — 砚台：圆角矩形石砚 + 墨池凹陷 + 边缘磨损
//
// 做法：从中心向外"按角度射线"走到圆角矩形边界（解析求交），
//   → 天然的极坐标网格，不需要把矩形网格往圆角上硬夹（那样角上会拉伸）。
// 高度场 y = f(x,z) 完全解析：墨池凹陷 + 砚堂斜面 + 噪声磨损。
// 法线 = 中心差分梯度 normalize(-∂y/∂x, 1, -∂y/∂z)：解析（差一个 ε），无接缝、无平均钝化。

import { MeshBuilder, fbm3, smoothstep, clamp, computeVertexNormals, alignWindingToNormals } from './util.js';
import { orientOutward } from './util.js';

/** 圆角矩形：从中心沿 theta 方向走到边界的距离（解析） */
export function roundedRectRayRadius(theta, a, b, rc) {
  const dx = Math.cos(theta), dz = Math.sin(theta);
  const ax = Math.abs(dx), az = Math.abs(dz);
  let tBest = Infinity;
  // 直边 x=±a（有效区间 |z| <= b-rc）
  if (ax > 1e-9) { const t = a / ax; if (Math.abs(t * dz) <= b - rc + 1e-9) tBest = Math.min(tBest, t); }
  if (az > 1e-9) { const t = b / az; if (Math.abs(t * dx) <= a - rc + 1e-9) tBest = Math.min(tBest, t); }
  // 圆角：圆心 c=(sx(a-rc), sz(b-rc))，解 |t·d - c| = rc，取大根
  const sx = dx >= 0 ? 1 : -1, sz = dz >= 0 ? 1 : -1;
  const cx = sx * (a - rc), cz = sz * (b - rc);
  const dc = dx * cx + dz * cz;
  const disc = dc * dc - (cx * cx + cz * cz) + rc * rc;
  if (disc >= 0) {
    const t = dc + Math.sqrt(disc);
    const hx = t * dx, hz = t * dz;
    // 命中点必须落在该圆角象限内
    if (t > 0 && Math.abs(hx) >= a - rc - 1e-9 && Math.abs(hz) >= b - rc - 1e-9) tBest = Math.min(tBest, t);
  }
  return tBest === Infinity ? Math.max(a, b) : tBest;
}

/** 圆角矩形边界外法线（SDF 梯度，直边精确，角上取径向） */
export function roundedRectOutwardNormal(x, z, a, b, rc) {
  const qx = Math.abs(x) - (a - rc), qz = Math.abs(z) - (b - rc);
  const sgx = x >= 0 ? 1 : -1, sgz = z >= 0 ? 1 : -1;
  let nx, nz;
  if (qx > 0 && qz > 0) { nx = sgx * qx; nz = sgz * qz; }
  else if (qx > qz) { nx = sgx; nz = 0; }
  else { nx = 0; nz = sgz; }
  const l = Math.hypot(nx, nz) || 1;
  return [nx / l, 0, nz / l];
}

/**
 * 砚台高度场。参数都在 o 里，方便法线做中心差分。
 */
export function slabHeight(x, z, o) {
  const th = Math.atan2(z, x);
  const R = roundedRectRayRadius(th, o.a, o.b, o.rc);
  const t = clamp(Math.hypot(x, z) / R, 0, 1); // 0 中心 → 1 外缘
  // 墨池：以 poolCenter 为中心的圆角矩形，rho 0 中心 → 1 池边
  const px = x - o.poolCenter[0], pz = z - o.poolCenter[1];
  const pth = Math.atan2(pz, px);
  const Rp = roundedRectRayRadius(pth, o.pa, o.pb, o.prc);
  const rho = clamp(Math.hypot(px, pz) / Rp, 0, 1.6);
  let y = o.topY;
  y -= o.poolDepth * (1 - smoothstep(0.0, 1.0, rho));       // 墨池凹陷（池沿平滑收回）
  y += o.poolLip * (smoothstep(0.9, 1.02, rho) - smoothstep(1.02, 1.25, rho)); // 池沿一圈微微隆起
  y -= o.slope * smoothstep(0.55, 1.0, rho) * (o.poolDepth > 0 ? 0 : 1); // 无墨池时的整面浅斜（砚堂）
  // 边缘磨损：外缘带被磨低 + 噪声起伏（"用过很久"的痕迹）
  const w = fbm3(x * 0.045, 3.71, z * 0.045, { octaves: 3, gain: 0.55 }) * 0.5 + 0.5;
  y -= o.wear * w * smoothstep(0.84, 1.0, t);
  y -= o.rimDrop * smoothstep(0.955, 1.0, t);               // 极外圈微倒角，避免刀口
  return y;
}

/**
 * 砚台几何
 * @param w,h 外形尺寸(mm)；rc 圆角半径
 * @param poolDepth 墨池深度；pool 位置相对中心 [x,z]
 * @param rings 径向分段（沿半径的圈数）；radialSegs 角向分段
 */
export function makeInkSlab({
  w = 190, h = 140, thickness = 22,
  rc = 16,
  poolDepth = 5.2,
  poolW = 62, poolH = 42, poolRC = 18,
  poolCenter = [-42, 0],
  poolLip = 0.5,
  slope = 0.0,
  wear = 1.1,
  rimDrop = 0.7,
  rings = 20,
  radialSegs = 64,
} = {}) {
  const a = w / 2, b = h / 2;
  const o = {
    a, b, rc, topY: thickness, poolDepth, pa: poolW / 2, pb: poolH / 2, prc: poolRC,
    poolCenter, poolLip, slope, wear, rimDrop,
  };
  const bld = new MeshBuilder();
  const eps = Math.min(a, b) * 0.004;
  const heightN = (x, z) => {
    const hx = (slabHeight(x + eps, z, o) - slabHeight(x - eps, z, o)) / (2 * eps);
    const hz = (slabHeight(x, z + eps, o) - slabHeight(x, z - eps, o)) / (2 * eps);
    const nx = -hx, ny = 1, nz = -hz;
    const l = Math.hypot(nx, ny, nz) || 1;
    return [nx / l, ny / l, nz / l];
  };
  const uvAt = (x, z) => [(x + a) / (2 * a), (z + b) / (2 * b)];

  bld.group('inkstone');
  // ---------- 顶面（中心极点 + rings 圈）----------
  const rows = [];
  for (let k = 1; k <= rings; k++) {
    const t = k / rings;
    const row = [];
    for (let j = 0; j < radialSegs; j++) {
      const th = (j / radialSegs) * Math.PI * 2;
      const R = roundedRectRayRadius(th, a, b, rc);
      const x = Math.cos(th) * R * t, z = Math.sin(th) * R * t;
      const y = slabHeight(x, z, o);
      const [nx, ny, nz] = heightN(x, z);
      const [u, v] = uvAt(x, z);
      row.push(bld.vert(x, y, z, nx, ny, nz, u, v));
    }
    rows.push(row);
  }
  const cIdx = bld.vert(0, slabHeight(0, 0, o), 0, 0, 1, 0, 0.5, 0.5);
  for (let j = 0; j < radialSegs; j++) bld.tri(cIdx, rows[0][(j + 1) % radialSegs], rows[0][j]);
  for (let k = 0; k < rows.length - 1; k++) {
    for (let j = 0; j < radialSegs; j++) {
      const j2 = (j + 1) % radialSegs;
      // 顶面：行方向是"径向"而不是"沿轴"，所以绕序与 lathe 环带相反（与 board 顶面同族写法）
      bld.quad(rows[k][j], rows[k][j2], rows[k + 1][j2], rows[k + 1][j]);
    }
  }
  // ---------- 侧壁（竖直，硬边：法线取水平外法线）+ 底面 ----------
  bld.group('inkstoneSide');
  const topRing = rows[rows.length - 1];
  const botRow = [];
  for (let j = 0; j < radialSegs; j++) {
    const th = (j / radialSegs) * Math.PI * 2;
    const R = roundedRectRayRadius(th, a, b, rc);
    const x = Math.cos(th) * R, z = Math.sin(th) * R;
    const n = roundedRectOutwardNormal(x, z, a, b, rc);
    const [u, v] = uvAt(x, z);
    // 注意：位置与顶面外圈相同，但这里是新顶点 + 水平法线 → 棱是硬的
    botRow.push(bld.vert(x, 0, z, n[0], n[1], n[2], u, v));
  }
  const topRingHard = [];
  for (let j = 0; j < radialSegs; j++) {
    const th = (j / radialSegs) * Math.PI * 2;
    const R = roundedRectRayRadius(th, a, b, rc);
    const x = Math.cos(th) * R, z = Math.sin(th) * R;
    const n = roundedRectOutwardNormal(x, z, a, b, rc);
    const [u, v] = uvAt(x, z);
    topRingHard.push(bld.vert(x, slabHeight(x, z, o), z, n[0], n[1], n[2], u, v));
  }
  for (let j = 0; j < radialSegs; j++) {
    const j2 = (j + 1) % radialSegs;
    // 本文件的环参数是 (cosθ, ·, sinθ)（与 lathe 同族），绕序按此推导
    bld.quad(topRingHard[j], topRingHard[j2], botRow[j2], botRow[j]);
  }
  const cb = bld.vert(0, 0, 0, 0, -1, 0, 0.5, 0.5);
  for (let j = 0; j < radialSegs; j++) bld.tri(cb, botRow[j], botRow[(j + 1) % radialSegs]);

  const geo = bld.build();
  geo.meta = { a, b, rc, topY: thickness, poolCenter, windingFlips: alignWindingToNormals(geo) };
  return geo;
}