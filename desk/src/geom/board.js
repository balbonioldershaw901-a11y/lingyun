// board.js — 围棋盘（厚木盘 + 45° 倒角 + 硬边顶点复制）
// 顶面本身只是一块平面：木纹和 19 路网格线全部在片元着色器里算，
// 所以顶面只需要"刚好够把边界补上"的分段（默认 topRings=2，纯平面时 =1）。
// 只有想要"表面微微凹陷（sag）"这种顶点级形变时，才需要加 topRings。

import { MeshBuilder, TAU, smoothstep, alignWindingToNormals } from './util.js';

/**
 * 矩形环上的点，顺序保证"从 +Y 俯视逆时针"（用它做顶面得到 +Y 法线）。
 * 起点 (hx,-hz) → (-hx,-hz) → (-hx,hz) → (hx,hz) 回环。
 */
export function rectRing(hx, hz, segsPerSide, y = 0) {
  const pts = [];
  const add = (x, z) => pts.push([x, y, z]);
  for (let i = 0; i < segsPerSide; i++) add(hx - 2 * hx * (i / segsPerSide), -hz);
  for (let i = 0; i < segsPerSide; i++) add(-hx, -hz + 2 * hz * (i / segsPerSide));
  for (let i = 0; i < segsPerSide; i++) add(-hx + 2 * hx * (i / segsPerSide), hz);
  for (let i = 0; i < segsPerSide; i++) add(hx, hz - 2 * hz * (i / segsPerSide));
  return pts;
}

/** 环上第 i 点朝外的水平法线（相邻两段外法线取平均；直角处自然变 45°，木盘圆角正合适） */
export function ringOutwardNormals(ring, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = ring[i], a = ring[(i - 1 + n) % n], b = ring[(i + 1) % n];
    const dx = b[0] - p[0], dz = b[2] - p[2];
    const ex = p[0] - a[0], ez = p[2] - a[2];
    // 段外法线 = normalize(-dz, 0, dx)
    let n1x = -dz, n1z = dx, n2x = -ez, n2z = ex;
    const l1 = Math.hypot(n1x, n1z) || 1, l2 = Math.hypot(n2x, n2z) || 1;
    n1x /= l1; n1z /= l1; n2x /= l2; n2z /= l2;
    const sx = n1x + n2x, sz = n1z + n2z, sl = Math.hypot(sx, sz) || 1;
    out.push([sx / sl, 0, sz / sl]);
  }
  return out;
}

/**
 * 围棋盘几何。单位 mm，坐标：桌面 y=0，盘顶 y=thickness。
 * @returns geo，含 groups: woodTop（顶面，走带网格线的材质）/ woodEdge（倒角+侧壁+底面）
 */
export function makeGoBoard({
  size = 460,
  thickness = 38,
  bevel = 5,          // 倒角水平进深 = 竖直高度 → 45°
  bevelSegs = 3,      // 倒角分几段（1 段就是一条 45° 坡面）
  ringSegsPerSide = 24,
  topRings = 2,       // 顶面同心的圈数；纯平面取 1（等价扇形，三角最少）
  sag = 0.35,         // 顶面中心极轻微凹陷（mm），0 = 完全平
  uvPad = 0.06,       // 网格线材质里用于留白的 uv 内侧留边（只影响材质，不改几何）
} = {}) {
  const b = new MeshBuilder();
  const half = size / 2;
  const ihx = half - bevel, ihz = half - bevel;
  const topY = thickness;
  const inner = rectRing(ihx, ihz, ringSegsPerSide, 0);
  const outer = rectRing(half, half, ringSegsPerSide, 0);
  const n = inner.length;
  const outN = ringOutwardNormals(outer, n);
  // 顶面 uv：0..1 正好覆盖"棋线区"（内缩矩形），0 和 1 就是最外侧两条边线
  const uvAt = (x, z) => [(x + ihx) / (2 * ihx), (z + ihz) / (2 * ihz)];

  /* ---------- 1. 台面 ---------- */
  b.group('woodTop');
  {
    const rows = []; // rows[k]: 第 k 圈（k=0 最内 → 最外=边界，和 inner 环逐点对齐）
    for (let r = topRings; r >= 1; r--) {
      const t = r / topRings;
      const row = [];
      for (let j = 0; j < n; j++) {
        const x = inner[j][0] * t, z = inner[j][2] * t;
        const y = topY - sag * (1 - t * t);
        const [u, v] = uvAt(x, z);
        row.push(b.vert(x, y, z, 0, 1, 0, u, v));
      }
      rows.push(row);
    }
    const cY = topY - sag;
    const center = b.vert(0, cY, 0, 0, 1, 0, 0.5, 0.5);
    // 中心 → 最内圈：三角扇
    for (let j = 0; j < n; j++) b.tri(center, rows[0][j], rows[0][(j + 1) % n]);
    // 圈与圈之间：统一环带绕序 quad(rowA[j], rowB[j], rowB[j+1], rowA[j+1])
    for (let k = 0; k < rows.length - 1; k++) {
      for (let j = 0; j < n; j++) {
        const j2 = (j + 1) % n;
        b.quad(rows[k][j], rows[k + 1][j], rows[k + 1][j2], rows[k][j2]);
      }
    }
  }

  /* ---------- 2. 倒角 + 侧壁 + 底面 ---------- */
  b.group('woodEdge');
  {
    // 倒角：内圈(y=topY) → 外圈(y=topY-bevel)，法线 = normalize(outward*bevelH + up*bevelRun)
    // 每行都是新顶点（与台面同位置但法线不同）→ 这就是"硬边"的正确做法
    const bevelH = bevel, bevelRun = bevel;
    const rows = [];
    for (let k = 0; k <= bevelSegs; k++) {
      const t = k / bevelSegs;
      const row = [];
      for (let j = 0; j < n; j++) {
        const x = inner[j][0] + (outer[j][0] - inner[j][0]) * t;
        const z = inner[j][2] + (outer[j][2] - inner[j][2]) * t;
        const y = topY - bevelH * t;
        const o = outN[j];
        const nx = o[0] * bevelH, ny = bevelRun, nz = o[2] * bevelH;
        const l = Math.hypot(nx, ny, nz) || 1;
        const [u, v] = uvAt(x, z);
        row.push(b.vert(x, y, z, nx / l, ny / l, nz / l, u, v));
      }
      rows.push(row);
    }
    for (let k = 0; k < rows.length - 1; k++) {
      for (let j = 0; j < n; j++) {
        const j2 = (j + 1) % n;
        b.quad(rows[k][j], rows[k + 1][j], rows[k + 1][j2], rows[k][j2]);
      }
    }
    // 侧壁：倒角外沿 → y=0。竖直面，法线取水平外法线（与倒角是硬边）
    const topRow = rows[rows.length - 1];
    const botRow = [];
    for (let j = 0; j < n; j++) {
      const o = outN[j];
      const [u, v] = uvAt(outer[j][0], outer[j][2]);
      botRow.push(b.vert(outer[j][0], 0, outer[j][2], o[0], o[1], o[2], u, v));
    }
    for (let j = 0; j < n; j++) {
      const j2 = (j + 1) % n;
      b.quad(topRow[j], botRow[j], botRow[j2], topRow[j2]);
    }
    // 底面：-Y，绕序整体反向
    const cb = b.vert(0, 0, 0, 0, -1, 0, 0.5, 0.5);
    const botRing = botRow;
    for (let j = 0; j < n; j++) b.tri(cb, botRing[(j + 1) % n], botRing[j]);
  }

  const geo = b.build();
  geo.meta = { half, ihx, ihz, topY, thickness, uvPad, windingFlips: alignWindingToNormals(geo) };
  return geo;
}

/**
 * （可选的）几何版棋盘线：thin quad 铺在盘面上方 0.12mm。
 * 用途仅是给"几何线 vs 贴图 vs 着色器"做 A/B 对比；生产建议不开。
 * 19×19 → 18+18 条线 + 9 个星位方片 = 45 个 quad = 90 三角。
 */
export function makeBoardGridLines({ size = 460, bevel = 5, lineWidth = 1.6, borderWidth = 2.6, starSize = 4.2, lift = 0.12, thickness = 38 }) {
  const b = new MeshBuilder();
  const ihx = size / 2 - bevel, ihz = ihx;
  const step = (2 * ihx) / 18;
  const y = thickness + lift;
  const uvAt = (x, z) => [(x + ihx) / (2 * ihx), (z + ihz) / (2 * ihz)];
  const quadXZ = (x0, z0, x1, z1) => {
    const [u0, v0] = uvAt(x0, z0), [u1, v1] = uvAt(x1, z1);
    const a = b.vert(x0, y, z0, 0, 1, 0, u0, v0);
    const c = b.vert(x1, y, z1, 0, 1, 0, u1, v1);
    const d = b.vert(x1, y, z0, 0, 1, 0, u1, v0);
    const e = b.vert(x0, y, z1, 0, 1, 0, u0, v1);
    b.quad(a, d, c, e);
  };
  b.group('gridLine');
  for (let i = 0; i < 19; i++) {
    const p = -ihx + step * i;
    const w = (i === 0 || i === 18) ? borderWidth : lineWidth;
    quadXZ(p - w / 2, -ihz, p + w / 2, ihz);   // 竖线
    quadXZ(-ihx, p - w / 2, ihx, p + w / 2);   // 横线
  }
  for (const ix of [3, 9, 15]) for (const iz of [3, 9, 15]) {
    const x = -ihx + step * ix, z = -ihz + step * iz;
    const s = starSize / 2;
    quadXZ(x - s, z - s, x + s, z + s);
  }
  return b.build();
}

/** 19 路交叉点世界坐标（放棋子用） */
export function boardIntersections({ size = 460, bevel = 5 }) {
  const ihx = size / 2 - bevel;
  const step = (2 * ihx) / 18;
  const pts = [];
  for (let i = 0; i < 19; i++) for (let j = 0; j < 19; j++) {
    pts.push([-ihx + step * i, -ihx + step * j]); // [x, z]
  }
  return { points: pts, step, ihx };
}