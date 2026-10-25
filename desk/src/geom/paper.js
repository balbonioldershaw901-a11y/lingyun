// paper.js — 宣纸：微微起伏的薄纸片 + 卷起的宣纸卷
//
// 薄纸片：单层曲面（不给厚度）。半透明 → 关背面剔除 + 片元里按 gl_FrontFacing 翻法线。
// 法线：高度场 y=f(x,z) 的中心差分梯度（解析到 ε），比面法线平均干净得多。
// 纸张起伏很浅（1~3mm），顶点数不需要多：桌面 64×48 已经远超视觉需要，
// 移动端 16×12 也够——因为主要观感来自"边缘卷曲 + 透光"，不是表面细节。

import { MeshBuilder, fbm3, smoothstep, clamp, alignWindingToNormals } from './util.js';
import { TAU } from './util.js';

/**
 * 纸张高度场：低频起伏（纸张本身的波浪）+ 边缘卷曲（curl）
 */
export function paperHeight(x, z, o) {
  const { w, h, amp, freq, curl, seed, sag } = o;
  const u = (x + w / 2) / w, v = (z + h / 2) / h;
  let y = amp * fbm3(x * freq, seed, z * freq, { octaves: 3, gain: 0.55 });
  // 边缘卷曲：四边略翘/略垂（u01 沿边 0/1）
  const ex = Math.pow(Math.abs(u - 0.5) * 2, 3), ez = Math.pow(Math.abs(v - 0.5) * 2, 3);
  y += curl * (ex + ez) * 0.5;
  // 整体沿对角微微塌一点（压在桌面上）
  y -= sag * (1 - (u + v) * 0.5);
  return y;
}

export function makePaper({
  w = 420, h = 300, segX = 64, segZ = 48,
  amp = 1.8, freq = 0.018, curl = 3.2, sag = 0.6, seed = 2.7,
  lift = 0.4,          // 桌面 y 抬高，避免与桌面 z-fighting
} = {}) {
  const b = new MeshBuilder();
  const o = { w, h, amp, freq, curl, seed, sag };
  const eps = Math.min(w, h) / Math.max(segX, segZ) * 0.25;
  const heightN = (x, z) => {
    const hx = (paperHeight(x + eps, z, o) - paperHeight(x - eps, z, o)) / (2 * eps);
    const hz = (paperHeight(x, z + eps, o) - paperHeight(x, z - eps, o)) / (2 * eps);
    const nx = -hx, ny = 1, nz = -hz;
    const l = Math.hypot(nx, ny, nz) || 1;
    return [nx / l, ny / l, nz / l];
  };
  b.group('paper');
  const grid = [];
  for (let i = 0; i <= segX; i++) {
    const row = [];
    const x = -w / 2 + w * (i / segX);
    for (let j = 0; j <= segZ; j++) {
      const z = -h / 2 + h * (j / segZ);
      const y = paperHeight(x, z, o) + lift;
      const [nx, ny, nz] = heightN(x, z);
      row.push(b.vert(x, y, z, nx, ny, nz, i / segX, j / segZ));
    }
    grid.push(row);
  }
  for (let i = 0; i < segX; i++) for (let j = 0; j < segZ; j++) {
    // 顶面朝 +Y：quad(rowA[j], rowB[j], rowB[j+1], rowA[j+1])
    b.quad(grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]);
  }
  const geo = b.build();
  geo.meta = { doubleSided: true, openSurface: true, w, h, windingFlips: alignWindingToNormals(geo) };
  return geo;
}

/**
 * 宣纸卷：把一条纸带贴到阿基米德螺线上（r 随角度线性增长）
 * 螺线：r(φ) = innerR + gap·φ/2π ；纸带宽度方向沿卷轴 z。
 * 法线：在 (φ, u) 参数域对位置做数值切向、叉乘求法线（曲率连续，无折角）。
 */
export function makePaperRoll({
  width = 300,        // 纸带宽度（卷轴方向）
  turns = 2.6,
  innerR = 16,
  gap = 0.9,          // 每层之间径向间隙（≈ 纸厚 + 空气）
  lengthSegs = 240,   // 沿螺线
  widthSegs = 12,     // 沿纸带宽度
  wave = 0.5,         // 径向小起伏，避免规整得像弹簧
  lift = 0,           // 整体 y 偏移（卷轴轴线默认沿 z，水平放置时用 rotateX 转）
} = {}) {
  const b = new MeshBuilder();
  const phiMax = TAU * turns;
  const pos = (t, u) => {
    const phi = phiMax * t;
    const r = innerR + gap * (phi / TAU) + wave * fbm3(t * 9.3, u * 4.1, 0.7, { octaves: 2 });
    return [Math.cos(phi) * r, Math.sin(phi) * r + lift, (u - 0.5) * width];
  };
  b.group('paperRoll');
  const rows = [];
  for (let i = 0; i <= lengthSegs; i++) {
    const t = i / lengthSegs, row = [];
    for (let j = 0; j <= widthSegs; j++) {
      const u = j / widthSegs;
      const p = pos(t, u);
      const e = 1e-4;
      const pt = pos(Math.min(1, t + e), u), pu = pos(t, Math.min(1, u + e));
      const pt2 = pos(Math.max(0, t - e), u), pu2 = pos(t, Math.max(0, u - e));
      const dt = [(pt[0] - pt2[0]), (pt[1] - pt2[1]), (pt[2] - pt2[2])];
      const du = [(pu[0] - pu2[0]), (pu[1] - pu2[1]), (pu[2] - pu2[2])];
      let nx = dt[1] * du[2] - dt[2] * du[1];
      let ny = dt[2] * du[0] - dt[0] * du[2];
      let nz = dt[0] * du[1] - dt[1] * du[0];
      const l = Math.hypot(nx, ny, nz) || 1;
      row.push(b.vert(p[0], p[1], p[2], nx / l, ny / l, nz / l, t, u));
    }
    rows.push(row);
  }
  for (let i = 0; i < lengthSegs; i++) for (let j = 0; j < widthSegs; j++) {
    b.quad(rows[i][j], rows[i + 1][j], rows[i + 1][j + 1], rows[i][j + 1]);
  }
  const geo = b.build();
  geo.meta = { doubleSided: true, openSurface: true, roll: true, windingFlips: alignWindingToNormals(geo) };
  return geo;
}