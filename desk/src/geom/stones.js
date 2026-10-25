// stones.js — 围棋子：扁双凸透镜（车削轮廓），黑子/白子共用几何
//
// 透镜剖面两种做法：
//  A) 椭球剖面（默认，rimHeight=0）：r=R·sinφ, y=(h/2)·cosφ
//     → C∞ 连续，边缘完全无折角，法线有严格解析式
//     n = normalize( x/R²,  y/(h/2)²,  z/R² )   ← 逆伸缩（椭球梯度）
//  B) 球冠 + 微圆柱腰（rimHeight>0）：更接近真碁石的"腰线"
//     → 腰线处是硬折角，用 creaseAngleDeg 控制：小于阈值就自动圆滑过渡
//
// 少量三角形做出平滑观感的三个要点：
//  1. 剖面只放 8~12 个点（曲率变化小的地方不要浪费点）
//  2. 圆周分段是三角数主项，桌面 64、移动端 24~32 就够（棋子小、几乎看不到轮廓多边形）
//  3. 法线一律解析求（剖面切向的垂线），不要用面法线平均——平均会把腰线的折角抹平/糊掉

import { lathe } from './revolve.js';
import { orientOutward, geoStats, fbm3, alignWindingToNormals } from './util.js';

/** 闭合车削体收尾：逐面按法线对齐绕序 + 有向体积复核全局方向 */
function finishClosed(geo) {
  const flips = alignWindingToNormals(geo);
  orientOutward(geo);
  geo.meta = { ...(geo.meta || {}), windingFlips: flips };
  return geo;
}

/**
 * 双凸透镜剖面（[r,y]，从下极点排到上极点）
 * @param radius 半径 R（mm）
 * @param thickness 总厚 h（mm）
 * @param capSegs 单侧球冠分段
 * @param rimHeight 腰部竖直段高度（0 = 纯椭球）
 */
export function lensProfile({ radius = 11, thickness = 6.6, capSegs = 6, rimHeight = 0 } = {}) {
  const R = radius, H = thickness;
  const prof = [];
  if (rimHeight <= 1e-6) {
    for (let i = 0; i <= capSegs * 2; i++) {
      const phi = Math.PI * (i / (capSegs * 2));
      prof.push([R * Math.sin(phi), -(H / 2) * Math.cos(phi)]);
    }
    return prof;
  }
  const Hc = (H - rimHeight) / 2;
  for (let i = 0; i <= capSegs; i++) { // 下冠：极点 → 腰
    const phi = (Math.PI / 2) * (i / capSegs);
    prof.push([R * Math.sin(phi), -Hc * Math.cos(phi) - rimHeight / 2]);
  }
  prof.push([R, rimHeight / 2]); // 腰线上沿
  for (let i = capSegs; i >= 0; i--) { // 上冠：腰 → 极点
    const phi = (Math.PI / 2) * (i / capSegs);
    prof.push([R * Math.sin(phi), Hc * Math.cos(phi) + rimHeight / 2]);
  }
  return prof;
}

/** 单位透镜（R=1,h=1），做实例化时按 per-instance 非均匀缩放用 */
export function makeUnitLens({ capSegs = 6, rimHeight = 0 } = {}) {
  const prof = lensProfile({ radius: 1, thickness: 1, capSegs, rimHeight: rimHeight });
  const geo = finishClosed(lathe(prof, 32, { creaseAngleDeg: 25 }));
  geo.isUnitLens = true;
  return geo;
}

/**
 * 单颗棋子
 * @param creaseAngleDeg 剖面相邻段法线夹角阈值（度）。腰线折角约 90°>阈值 → 保持硬边；
 *                       若想让腰线也圆滑（老棋子手感），调到 90 以上即自动平均。
 */
export function makeStone({
  radius = 11,
  thickness = 6.6,
  radialSegs = 48,
  capSegs = 6,
  rimHeight = 0,
  creaseAngleDeg = 25,
} = {}) {
  const prof = lensProfile({ radius, thickness, capSegs, rimHeight });
  const geo = finishClosed(lathe(prof, radialSegs, { creaseAngleDeg }));
  geo.meta = { ...geo.meta, radius, thickness, radialSegs, capSegs, rimHeight };
  return geo;
}

/**
 * 棋子在盘面上的轻微随机落点抖动（手工摆的棋子不会正正在交叉点上）
 * 返回位移 [dx, dz] 与 yaw（弧度），确定性（seed 决定），不依赖 Math.random。
 */
export function stoneJitter(seed = 0, amount = 0.9) {
  const a = fbm3(seed * 3.1, 0.5, 1.7, { octaves: 2 }) * amount;
  const c = fbm3(seed * 5.7, 9.2, 2.3, { octaves: 2 }) * amount;
  const yaw = fbm3(seed * 1.3, 4.4, 7.7, { octaves: 2 }) * Math.PI;
  return [a, c, yaw];
}

export function stoneStats(geo) { return geoStats(geo); }