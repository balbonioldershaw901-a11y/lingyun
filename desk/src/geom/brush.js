// brush.js — 毛笔：笔杆（锥形细长筒，略弯）+ 笔斗 + 笔头（从笔斗收细到笔锋，带弯）+ 挂绳
// 全部走 sweep()：半径沿脊线变化 → 法线解析式 n = normalize(e - r'(s)·t)，收细处自动外倾。
// 脊线用二次贝塞尔做"微微的弯"：真毛笔不会笔直，笔锋还会有点回勾。

import { MeshBuilder, TAU, smoothstep, clamp, orientOutward, alignWindingToNormals } from './util.js';
import { sweep, dot, cross, sub, add, scale, normalize } from './revolve.js';

/** 闭合扫掠体统一收尾：先按法线逐面对齐绕序，再用有向体积复核全局方向 */
function finishClosed(geo) {
  const flips = alignWindingToNormals(geo);
  orientOutward(geo);
  geo.meta = { ...(geo.meta || {}), windingFlips: flips };
  return geo;
}

export function quadBezier(p0, p1, p2, t) {
  const u = 1 - t;
  return [
    u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
    u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
    u * u * p0[2] + 2 * u * t * p1[2] + t * t * p2[2],
  ];
}

export function sampleSpine(fn, segs) {
  const pts = [];
  for (let i = 0; i <= segs; i++) pts.push(fn(i / segs));
  return pts;
}

/**
 * 笔杆：从尾部 y=0 到笔斗下沿 y=handleLen，轻微弓形 + 中间略有收腰
 * r(s) = mix(r0, r1, s) - waist·sin(πs)
 */
export function makeBrushHandle({
  handleLen = 210,
  radiusButt = 8.6,
  radiusNeck = 5.2,
  bow = 2.2,          // 弓形幅度 mm
  waist = 0.35,       // 收腰 mm
  lengthSegs = 24,
  radialSegs = 16,
} = {}) {
  const spine = sampleSpine((t) => {
    const x = bow * Math.sin(Math.PI * t);
    return [x, handleLen * t, 0];
  }, lengthSegs);
  const r = (s) => (radiusButt + (radiusNeck - radiusButt) * s) - waist * Math.sin(Math.PI * s);
  const geo = sweep(spine, r, radialSegs, { capStart: 'flat', capEnd: 'flat', reference: [0, 0, 1] });
  return finishClosed(geo);
}

/** 笔斗（套住笔头根部的那个小碗）：一小段车削感的锥台 */
export function makeFerrule({
  y0 = 210, len = 16, rBottom = 5.2, rTop = 6.4, radialSegs = 16, lengthSegs = 3,
} = {}) {
  const spine = sampleSpine((t) => [0, y0 + len * t, 0], lengthSegs);
  const r = (s) => rBottom + (rTop - rBottom) * smoothstep(0, 0.55, s);
  const geo = sweep(spine, r, radialSegs, { capStart: 'flat', capEnd: 'flat', reference: [0, 0, 1] });
  return finishClosed(geo);
}

/**
 * 笔头：从笔斗上沿出发，半径按 (1-s)^p 收细，脊线再往侧向勾一点 → 笔锋的"回锋"感
 * p≈0.72 是"笔肚饱满 + 锋尖细"的经验值；p 越小越肥，越大越瘦
 */
export function makeBrushHead({
  y0 = 226,
  headLen = 62,
  radiusBase = 5.0,
  taperPow = 0.72,
  belly = 0.10,       // 笔肚额外鼓一点的比例
  hook = 7.0,         // 笔锋侧向偏移 mm
  hookPow = 1.7,
  lengthSegs = 20,
  radialSegs = 16,
} = {}) {
  const spine = sampleSpine((t) => [hook * Math.pow(t, hookPow), y0 + headLen * t, -0.35 * hook * Math.pow(t, 2.4)], lengthSegs);
  const r = (s) => {
    const sEnd = Math.min(s, 0.995);
    const base = radiusBase * Math.pow(1 - sEnd, taperPow);
    return Math.max(base * (1 + belly * Math.sin(Math.PI * Math.min(1, s * 1.25))), 0.02);
  };
  const geo = sweep(spine, r, radialSegs, { capStart: 'flat', capEnd: 'pole', reference: [0, 0, 1] });
  return finishClosed(geo);
}

/** 挂绳：绕在笔杆尾部的一圈丝绳（闭合环扫掠；两端各多绕一点遮住接缝） */
export function makeCord({
  y = 16, ringR = 11.5, tubeR = 1.5, tilt = 0.35, segs = 48, radialSegs = 8,
} = {}) {
  const spine = sampleSpine((t) => {
    const a = TAU * t * 1.04; // 多绕 4% 藏接缝
    const cx = Math.cos(a) * ringR, cz = Math.sin(a) * ringR;
    // 环面稍微倾斜、并且有重力下垂
    const drop = -1.8 * Math.pow(Math.max(0, Math.cos(a)), 2);
    return [cx, y + cz * Math.sin(tilt) + drop, cz * Math.cos(tilt)];
  }, segs);
  const r = (s) => tubeR * (1 - 0.12 * Math.sin(Math.PI * s * 2));
  const geo = sweep(spine, r, radialSegs, { capStart: 'none', capEnd: 'none', reference: [0, 1, 0] });
  geo.meta = { openEnds: true, doubleSided: true };
  return geo;
}

/** 一把完整的笔，parts 便于分别给材质（竹杆 / 笔斗 / 毫 / 绳） */
export function makeBrush(opts = {}) {
  const {
    handleLen = 210, handleSegs = 24, handleRadial = 16,
    ferrule = true, cord = true, ferruleRadial = 16, ferruleSegs = 3,
    headSegs = 20, headRadial = 16, hook = 7,
    cordSegs = 48, cordRadial = 8,
  } = opts;
  const parts = [];
  parts.push({ name: 'handle', geo: makeBrushHandle({ handleLen, lengthSegs: handleSegs, radialSegs: handleRadial }) });
  const ferr = makeFerrule({ y0: handleLen, radialSegs: ferruleRadial, lengthSegs: ferruleSegs });
  if (ferrule) parts.push({ name: 'ferrule', geo: ferr });
  const head = makeBrushHead({ y0: handleLen + (ferrule ? 16 : 0), lengthSegs: headSegs, radialSegs: headRadial, hook });
  parts.push({ name: 'head', geo: head });
  if (cord) parts.push({ name: 'cord', geo: makeCord({ y: 16, segs: cordSegs, radialSegs: cordRadial }) });
  return parts;
}