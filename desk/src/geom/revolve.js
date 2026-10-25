// revolve.js — 车削（lathe / surface of revolution）与扫掠（sweep）
// 围棋子的双凸透镜、笔斗、笔杆、笔头、挂绳都走这两个函数。
// 关键点：轮廓剖面（profile）决定外形，剖面每一段的法线可解析求出；
// 硬折角靠"同一位置两个顶点、两个法线"实现，软过渡靠"相邻段法线加权平均"。

import { MeshBuilder, TAU, clamp } from './util.js';

/**
 * 车削：把 [r,y] 剖面绕 Y 轴旋转。
 * @param profile  Array<[r, y]>，r>=0，按 y 递增（或任意单调方向）排列
 * @param radialSegs 圆周分段数（决定三角数的主要项）
 * @param opts.creaseAngleDeg 相邻剖面段法线夹角超过该值 → 视为硬边（复制顶点）
 * @param opts.closedProfile  剖面首尾是否相接（做环面/绳圈时用，不封口）
 * 返回闭合网格（两端 r=0 时自动收成极点，法线取轴向）
 *
 * 剖面段法线推导（2D，坐标 (o=r, y)）：
 *   切向 t=(dr,dy) → 外法线 n = (dy, -dr) 归一化
 *   例：竖直外壁 t=(0,1) → n=(1,0) 朝外 ✓
 *       下球冠 t=(R,H) → n=(H,-R) 朝外下 ✓
 */
export function lathe(profile, radialSegs, {
  creaseAngleDeg = 25,
  startAngle = 0,
  sweep = TAU,
  closedProfile = false,
  uvVScale = 1,
} = {}) {
  const b = new MeshBuilder();
  const P = profile;
  const segs = P.length - 1;

  // --- 每段的 2D 法线 ---
  const segN = new Array(segs);
  for (let s = 0; s < segs; s++) {
    const dr = P[s + 1][0] - P[s][0], dy = P[s + 1][1] - P[s][1];
    const l = Math.hypot(dr, dy) || 1;
    segN[s] = [dy / l, -dr / l]; // (nr, ny)
  }
  // --- 每个剖面顶点的法线（含硬边判定）---
  const cosCrease = Math.cos(creaseAngleDeg * Math.PI / 180);
  const vtxN = new Array(P.length); // { hard:boolean, prev:[..], next:[..], smooth:[..] }
  for (let i = 0; i < P.length; i++) {
    const prev = i - 1 >= 0 ? segN[i - 1] : null;
    const next = i < segs ? segN[i] : (closedProfile ? segN[0] : null);
    if (prev && next) {
      const d = clamp(prev[0] * next[0] + prev[1] * next[1], -1, 1);
      const hard = d < cosCrease;
      const w0 = Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]) || 1;
      const w1 = Math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]) || 1;
      const sx = prev[0] * w0 + next[0] * w1, sy = prev[1] * w0 + next[1] * w1;
      const sl = Math.hypot(sx, sy) || 1;
      vtxN[i] = { hard, prev, next, smooth: [sx / sl, sy / sl] };
    } else if (next) vtxN[i] = { hard: false, prev: next, next, smooth: next };
    else if (prev) vtxN[i] = { hard: false, prev, next: prev, smooth: prev };
    else vtxN[i] = { hard: false, prev: [0, 1], next: [0, 1], smooth: [0, 1] };
  }

  // 弧长参数化（做 v 坐标）
  const arc = [0];
  for (let s = 0; s < segs; s++) arc.push(arc[s] + Math.hypot(P[s + 1][0] - P[s][0], P[s + 1][1] - P[s][1]));
  const arcTotal = arc[segs] || 1;

  const angs = [];
  const ringSegs = closedProfile ? radialSegs : radialSegs;
  for (let j = 0; j <= ringSegs; j++) angs.push(startAngle + sweep * (j / ringSegs)); // 多一列用于 UV 缝合

  // 顶点法线 → 3D
  const n3 = (n2, theta) => {
    const c = Math.cos(theta), s = Math.sin(theta);
    return [n2[0] * c, n2[1], n2[0] * s];
  };

  // 判断某剖面顶点是否极点（r≈0）
  const isPole = (i) => P[i][0] <= 1e-7;

  // 生成"带"：s 段连接剖面 i=s 与 i=s+1
  const ringOf = (i, side) => {
    // 返回该剖面顶点在某一侧使用的 (r,y,法线2D)
    const info = vtxN[i];
    let n2;
    if (info.hard) n2 = side === 'next' ? info.next : info.prev;
    else n2 = info.smooth;
    // 极点：沿轴向法线（光滑球冠在极点处法线必须与轴平行）
    if (isPole(i)) n2 = [0, P[i][1] >= 0 ? 1 : -1];
    return n2;
  };

  for (let s = 0; s < segs; s++) {
    const i0 = s, i1 = s + 1;
    const r0 = P[i0][0], y0 = P[i0][1], r1 = P[i1][0], y1 = P[i1][1];
    const poleBottom = isPole(i0), poleTop = isPole(i1);
    const v0 = arc[s] / arcTotal * uvVScale, v1 = arc[s + 1] / arcTotal * uvVScale;

    if (poleBottom) {
      // 三角扇形收口
      const n2 = ringOf(i0, 'next');
      const cIdx = b.vert(0, y0, 0, ...n3(n2, 0), 0.5, v0);
      const row = [];
      for (const th of angs) row.push(b.vert(r1 * Math.cos(th), y1, r1 * Math.sin(th), ...n3(ringOf(i1, 'prev'), th), th / TAU, v1));
      for (let j = 0; j < row.length - 1; j++) {
        // 扇形绕序：外法线朝下（与环带公式 quad(A,B,C,D) 在 A=D 退化时的结果一致）
        b.tri(cIdx, row[j], row[j + 1]);
      }
      continue;
    }
    if (poleTop) {
      const n2 = ringOf(i1, 'prev');
      const cIdx = b.vert(0, y1, 0, ...n3(n2, 0), 0.5, v1);
      const row = [];
      for (const th of angs) row.push(b.vert(r0 * Math.cos(th), y0, r0 * Math.sin(th), ...n3(ringOf(i0, 'next'), th), th / TAU, v0));
      for (let j = 0; j < row.length - 1; j++) {
        b.tri(cIdx, row[j + 1], row[j]);
      }
      continue;
    }
    const lower = [], upper = [];
    for (const th of angs) {
      lower.push(b.vert(r0 * Math.cos(th), y0, r0 * Math.sin(th), ...n3(ringOf(i0, 'next'), th), th / TAU, v0));
      upper.push(b.vert(r1 * Math.cos(th), y1, r1 * Math.sin(th), ...n3(ringOf(i1, 'prev'), th), th / TAU, v1));
    }
    for (let j = 0; j < angs.length - 1; j++) {
      // 绕序统一为 quad(A=lower[i], D=upper[i], C=upper[i+1], B=lower[i+1])
      b.quad(lower[j], upper[j], upper[j + 1], lower[j + 1]);
    }
  }
  return b.build();
}

/**
 * 扫掠管：沿 3D 脊线（spine）扫一个半径变化的圆。
 * 用旋转最小化标架（parallel transport / 双反射法简化版）避免扭转。
 *
 * 解析法线公式（关键）：
 *   点 C(s,θ) = S(s) + r(s)·e(s,θ)，e = cosθ·N + sinθ·B
 *   ∂C/∂θ = r·(-sinθ·N + cosθ·B)              （环向切向）
 *   ∂C/∂s ≈ t + r'(s)·e                      （忽略标架扭转项）
 *   N_surface = normalize( ∂C/∂θ × ∂C/∂s ) = normalize( e - r'(s)·t )
 *   → 半径收细的地方法线自动向外倾，不用平均、不会硬折。
 */
export function sweep(spine, radiusFn, radialSegs, {
  capStart = 'flat',   // 'flat' | 'pole' | 'none'
  capEnd = 'flat',
  reference = [0, 1, 0],
  uvVScale = 1,
} = {}) {
  const b = new MeshBuilder();
  const n = spine.length;
  // 切向（中心差分）
  const tangents = spine.map((p, i) => {
    const a = spine[Math.max(0, i - 1)], c = spine[Math.min(n - 1, i + 1)];
    const dx = c[0] - a[0], dy = c[1] - a[1], dz = c[2] - a[2];
    const l = Math.hypot(dx, dy, dz) || 1;
    return [dx / l, dy / l, dz / l];
  });
  // 旋转最小化标架
  const frames = [];
  {
    let t = tangents[0];
    let ref = Math.abs(t[0] * reference[0] + t[1] * reference[1] + t[2] * reference[2]) > 0.95 ? [1, 0, 0] : reference;
    let N = normalize(sub(ref, scale(t, dot(ref, t))));
    let B = cross(t, N);
    frames.push({ t, N, B });
    for (let i = 1; i < n; i++) {
      const t0 = frames[i - 1].t, t1 = tangents[i];
      const axis = cross(t0, t1);
      const sinA = Math.hypot(axis[0], axis[1], axis[2]);
      const cosA = clamp(dot(t0, t1), -1, 1);
      let N1;
      if (sinA < 1e-8) N1 = frames[i - 1].N;
      else {
        const k = normalize(axis), ang = Math.atan2(sinA, cosA);
        N1 = normalize(add(scale(frames[i - 1].N, Math.cos(ang)), scale(cross(k, frames[i - 1].N), Math.sin(ang))));
      }
      // 正交化（消除数值漂移）
      N1 = normalize(sub(N1, scale(t1, dot(N1, t1))));
      frames.push({ t: t1, N: N1, B: cross(t1, N1) });
    }
  }
  const rs = spine.map((_, i) => radiusFn(i / (n - 1)));
  const angs = [];
  for (let j = 0; j <= radialSegs; j++) angs.push(TAU * j / radialSegs);

  const rings = [];
  for (let i = 0; i < n; i++) {
    const { t, N, B } = frames[i], r = rs[i];
    // r'(s)：用相邻半径差分（解析式可由 radiusFn 提供导数，这里用差分足够）
    const dr = (rs[Math.min(n - 1, i + 1)] - rs[Math.max(0, i - 1)]) / 2 * (n - 1);
    const row = [];
    for (const th of angs) {
      const ct = Math.cos(th), st = Math.sin(th);
      const ex = N[0] * ct + B[0] * st, ey = N[1] * ct + B[1] * st, ez = N[2] * ct + B[2] * st;
      const nx = ex - dr * t[0], ny = ey - dr * t[1], nz = ez - dr * t[2];
      const l = Math.hypot(nx, ny, nz) || 1;
      row.push(b.vert(
        spine[i][0] + ex * r, spine[i][1] + ey * r, spine[i][2] + ez * r,
        nx / l, ny / l, nz / l,
        th / TAU, (i / (n - 1)) * uvVScale,
      ));
    }
    rings.push(row);
  }
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < radialSegs; j++) {
      // 注意：扫掠标架是右手系（N×B=t），与车削的 (cosθ, ·, sinθ) 是镜像关系，
      // 所以这里的绕序与 lathe 里那条环带写法相反。两者都由 alignWindingToNormals 复核。
      b.quad(rings[i][j], rings[i][j + 1], rings[i + 1][j + 1], rings[i + 1][j]);
    }
  }
  // 端盖：**单独复制一圈顶点**，法线取"盖面"本身的法线。
  // 理由：侧壁在收细处的法线是 e - r'·t（带轴向分量），如果端盖复用它，
  // 平面盖子的法线会被带偏，硬边也糊掉。复制一圈 = 正确的硬边 + 正确的盖法线。
  const cap = (i, kind, isStart) => {
    const { t, N, B } = frames[i], r = rs[i], s = spine[i];
    if (kind === 'none' || r <= 1e-7) return;
    const sign = isStart ? -1 : 1;
    if (kind === 'pole') {
      // 圆锥状收尖：侧面法线 = normalize(h·e + sign·t)，h = 尖端沿 t 的伸出比
      const h = 0.85;
      const ring = [], nrm = [];
      for (const th of angs) {
        const ct = Math.cos(th), st = Math.sin(th);
        const ex = N[0] * ct + B[0] * st, ey = N[1] * ct + B[1] * st, ez = N[2] * ct + B[2] * st;
        const nx = h * ex + sign * t[0], ny = h * ey + sign * t[1], nz = h * ez + sign * t[2];
        const l = Math.hypot(nx, ny, nz) || 1;
        ring.push(b.vert(s[0] + ex * r, s[1] + ey * r, s[2] + ez * r, nx / l, ny / l, nz / l, th / TAU, isStart ? 0 : 1));
      }
      const c = b.vert(s[0] + sign * t[0] * r * h, s[1] + sign * t[1] * r * h, s[2] + sign * t[2] * r * h,
        sign * t[0], sign * t[1], sign * t[2], 0.5, isStart ? 0 : 1);
      for (let j = 0; j < radialSegs; j++) {
        if (isStart) b.tri(c, ring[j + 1], ring[j]); else b.tri(c, ring[j], ring[j + 1]);
      }
    } else {
      // 平面盖：整圈法线 = sign·t，中心法线同；绕序与推导一致
      const ring = [];
      for (const th of angs) {
        const ct = Math.cos(th), st = Math.sin(th);
        const ex = N[0] * ct + B[0] * st, ey = N[1] * ct + B[1] * st, ez = N[2] * ct + B[2] * st;
        ring.push(b.vert(s[0] + ex * r, s[1] + ey * r, s[2] + ez * r,
          sign * t[0], sign * t[1], sign * t[2], th / TAU, isStart ? 0 : 1));
      }
      const c = b.vert(s[0], s[1], s[2], sign * t[0], sign * t[1], sign * t[2], 0.5, isStart ? 0 : 1);
      for (let j = 0; j < radialSegs; j++) {
        if (isStart) b.tri(c, ring[j + 1], ring[j]); else b.tri(c, ring[j], ring[j + 1]);
      }
    }
  };
  cap(0, capStart, true);
  cap(n - 1, capEnd, false);
  return b.build();
}

/* ---- 极小向量工具（下面几个扫掠/车削公用）---- */
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const normalize = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };