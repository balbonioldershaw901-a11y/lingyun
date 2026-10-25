/* ============================================================================
   scroll-scene.js — 主页的「滑动式丝滑」：滚动量推动镜头走一遍书桌
   ----------------------------------------------------------------------------
   只读引用 desk/src/*（那边另有智能体在修材质，本文件一个字都不改它们）：
     material.js  → uber 着色器 + std140 材质表
     scene.js     → 摆场、合并、三角预算
     orbit-camera.js → 只借它的 mat4（相机不用它：这里要的是关键帧，不是自由轨道）

   丝滑的三条规矩：
   1) 帧率无关阻尼：k = 1 - exp(-λ·dt)。绝不写 x += (t-x)*0.1
   2) 滚动量只做「目标值」：滚轮/触控板/触屏滑动都归一成 0..1 的进度，
      相机参数（距离/方位角/俯仰/焦点/横向偏移）按关键帧插值，再阻尼追上去
   3) 不用 scroll-snap：一条连续曲线，滚到哪儿镜头到哪儿
   ========================================================================== */

import { VERT_SRC, FRAG_SRC, buildMaterialTextureData, MATERIALS } from './desk/src/material.js';
import { buildScene } from './desk/src/scene.js';
import { mat4 } from './desk/src/orbit-camera.js';

const FOV = (38 * Math.PI) / 180;
const NEAR = 20, FAR = 8000;
/* 远景雾色：和 material.js 里 floor 的 bit6、main.js 的 HAZE_COLOR 是同一个数。
   地面一直铺到雾里，所以 clearColor 必须取"雾色过完色调映射 + gamma"之后的值，
   否则地面边缘会有一道能看见的接缝。 */
const HAZE_COLOR = [0.36, 0.33, 0.29];

/* 两级阻尼（都是「每秒收敛比例」，与帧率无关）
   进度慢一点 → 手指停了镜头还往前飘一段，这是"丝滑"的主要来源
   参数快一点 → 关键帧本身的曲率不被二次拖影，保证过弯干净 */
const LAMBDA_PROGRESS = 7.0;
const LAMBDA_CAMERA = 16.0;
const STATIC_PROGRESS = 0.16;          // prefers-reduced-motion：直接给一张静构图

/* 关键帧：p = 全局进度 0..1
   d 距离(mm) / th 方位角(rad) / ph 极角(rad，越小越俯视) / t 焦点(mm)
   off 横向偏移：以屏幕半宽为单位，正数=焦点右移（被摄物因此偏左），
   用来给左侧/右侧的文字卡片让出位置，免得卡片压住主角 */
const KEYS = [
  { p: 0.00, d: 1580, th: 0.62, ph: 0.96, t: [  10, 68,  46], off: -0.12 }, // 远景：整张桌子
  { p: 0.15, d: 1150, th: 0.42, ph: 0.86, t: [   0, 56,  20], off: -0.20 }, // 推近
  { p: 0.31, d:  820, th: 0.10, ph: 0.64, t: [ -30, 40, -10], off: -0.40 }, // 贴棋盘：看棋路
  { p: 0.46, d:  820, th: 0.80, ph: 0.72, t: [ 150, 44, 120], off: -0.10 }, // 转向砚台一侧
  { p: 0.62, d:  700, th: 1.35, ph: 0.86, t: [ 345, 42, 260], off:  0.50 }, // 砚台与毛笔
  { p: 0.78, d:  860, th: 2.05, ph: 1.00, t: [ 210, 46, -40], off:  0.35 }, // 绕到右后：太湖石前景
  { p: 0.90, d: 1060, th: 2.55, ph: 1.06, t: [-120, 50, 140], off: -0.30 }, // 宣纸与宣纸卷
  { p: 1.00, d: 2050, th: 2.95, ph: 0.99, t: [  60, 84, -40], off: -0.40 }, // 收尾拉远
];

/* ---------------------------------------------------------------- 关键帧求值 */
/** Catmull-Rom：过每个关键帧且一阶连续，所以镜头不会在关键帧上"停一下" */
function cr(v0, v1, v2, v3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2 * v1) + (-v0 + v2) * t
    + (2 * v0 - 5 * v1 + 4 * v2 - v3) * t2
    + (-v0 + 3 * v1 - 3 * v2 + v3) * t3);
}
function track(keys, get, p) {
  let i = 0;
  while (i < keys.length - 2 && p >= keys[i + 1].p) i++;
  const k1 = keys[i], k2 = keys[i + 1];
  const span = k2.p - k1.p;
  const t = span > 1e-6 ? Math.min(1, Math.max(0, (p - k1.p) / span)) : 0;
  const k0 = keys[Math.max(0, i - 1)], k3 = keys[Math.min(keys.length - 1, i + 2)];
  return cr(get(k0), get(k1), get(k2), get(k3), t);
}

/* ---------------------------------------------------------------- 状态 */
const qs = new URLSearchParams(location.search);
const FORCE_TIER = qs.get('tier') === 'mobile' ? 'mobile' : qs.get('tier') === 'desktop' ? 'desktop' : null;
const LOCK_T = qs.has('t') && Number.isFinite(Number(qs.get('t')))
  ? Math.min(1, Math.max(0, Number(qs.get('t')))) : null;

const canvas = document.getElementById('gl');
const note = document.getElementById('gl-note');
const topbar = document.getElementById('topbar');
const railBar = document.querySelector('#rail-progress i');
const root = document.documentElement;
const mqReduce = window.matchMedia('(prefers-reduced-motion: reduce)');

const api = {
  ready: false, error: null, tier: '', buildMs: 0, reduced: mqReduce.matches,
  raw: 0, progress: 0, settled: false, draws: 0, frames: 0,
  distance: 0, theta: 0, phi: 0, target: [0, 0, 0], eye: [0, 0, 0], fov: FOV,
  capture: null,
};
window.__scrollScene = api;

const state = {
  gl: null, program: null, matTex: null, loc: {},
  opaque: null, doubleSided: null, transparent: null,
  cur: null, want: null,
};

/* 相机参数：当前值 / 目标值。都是普通数组，方便一起阻尼 */
function makeCam(k) {
  return { d: k.d, th: k.th, ph: k.ph, t: k.t.slice(), off: k.off };
}
function evalKeys(p) {
  return makeCam({
    d: track(KEYS, k => k.d, p),
    th: track(KEYS, k => k.th, p),
    ph: track(KEYS, k => k.ph, p),
    off: track(KEYS, k => k.off, p),
    t: [0, 1, 2].map(i => track(KEYS, k => k.t[i], p)),
  });
}

/* ---------------------------------------------------------------- GL 小工具 */
function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) || 'shader');
  return sh;
}
function createProgram(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link');
  return p;
}
function uploadMesh(gl, mesh) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const bufs = {};
  const mk = (name, data, target) => {
    const b = gl.createBuffer();
    gl.bindBuffer(target || gl.ARRAY_BUFFER, b);
    gl.bufferData(target || gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    bufs[name] = b;
  };
  mk('pos', mesh.positions);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  mk('nrm', mesh.normals);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
  mk('uv', mesh.uvs);
  gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0);
  mk('mat', mesh.matIds);
  gl.enableVertexAttribArray(3); gl.vertexAttribIPointer(3, 1, gl.UNSIGNED_BYTE, 0, 0);
  mk('idx', mesh.indices, gl.ELEMENT_ARRAY_BUFFER);
  gl.bindVertexArray(null);
  return { vao, count: mesh.indices.length, bufs };
}
function killMesh(gl, m) {
  if (!m) return;
  gl.deleteVertexArray(m.vao);
  for (const k in m.bufs) gl.deleteBuffer(m.bufs[k]);
}

/* ---------------------------------------------------------------- 启动 */
const view = mat4.identity(), proj = mat4.identity(), vp = mat4.identity();

function boot() {
  const gl = canvas.getContext('webgl2', {
    antialias: true, alpha: false, depth: true, stencil: false,
    powerPreference: 'high-performance', preserveDrawingBuffer: false,
  });
  if (!gl) return fail('这台设备没有可用的 WebGL2');
  state.gl = gl;

  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); api.error = 'context-lost'; });
  canvas.addEventListener('webglcontextrestored', () => { api.error = null; });

  try {
    state.program = createProgram(gl, VERT_SRC, FRAG_SRC);
  } catch (e) {
    return fail('着色器没有编译通过');
  }
  gl.useProgram(state.program);

  /* 材质表：RGBA32F 贴图（宽 = 材质数、高 2；第 0 行 matA、第 1 行 matB），
     着色器用 texelFetch 按材质号直取 —— material.js 已经是这个接口了，
     UBO 那条路只留给 probe-desk.cjs 做诊断镜像，本页不需要。
     RGBA32F 不可过滤且没有 mipmap：MIN_FILTER 必须显式设 NEAREST，
     否则贴图不完整，texelFetch 会全读成黑（整场变黑，就是这个原因）。 */
  const matTex = gl.createTexture();
  state.matTex = matTex;
  gl.bindTexture(gl.TEXTURE_2D, matTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, MATERIALS.length, 2, 0, gl.RGBA, gl.FLOAT, buildMaterialTextureData());
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.activeTexture(gl.TEXTURE0);
  const locTable = gl.getUniformLocation(state.program, 'uMatTable');
  if (locTable) gl.uniform1i(locTable, 0);

  // uniform：名字变了也不会静默变绿的兜底 —— 查到才设，查不到就跳过这一项
  for (const n of ['uViewProj', 'uEye', 'uLightDir', 'uLightDir[0]', 'uLightColor', 'uLightColor[0]',
    'uSkyZenith', 'uSkyHorizon', 'uGroundColor', 'uGridPx', 'uBorderPx', 'uStarPx',
    'uBoardFadeNear', 'uBoardFadeFar', 'uGrainOctaves', 'uEnvStrength', 'uTime',
    'uHazeColor', 'uHazeNear', 'uHazeFar']) {
    state.loc[n] = gl.getUniformLocation(state.program, n);
  }

  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.enable(gl.CULL_FACE);
  gl.cullFace(gl.BACK);
  gl.frontFace(gl.CCW);

  /* 先上移动端档（7k 三角，快），第一帧尽快出现；
     空闲时再换成桌面级（50k 三角）。不是"先糊后清"，是直接换档重传几何。 */
  const small = FORCE_TIER ? FORCE_TIER === 'mobile' : window.innerWidth < 900;
  state.cur = makeCam(KEYS[0]);
  state.want = makeCam(KEYS[0]);
  /* 先上移动端档（7k 三角）把第一帧尽快画出来，大屏再补桌面级。
     小屏就停在移动端档 —— 不要在手机上偷偷换成 50k 三角的桌面档。 */
  buildTier('mobile');
  api.ready = true;

  if (!small) {
    if ('requestIdleCallback' in window) window.requestIdleCallback(() => buildTier('desktop', true), { timeout: 3000 });
    else setTimeout(() => buildTier('desktop', true), 400);
  }

  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);
  window.addEventListener('scroll', onScroll, { passive: true });
  if (mqReduce.addEventListener) mqReduce.addEventListener('change', onReduceChange);

  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries, obs) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add('in');
        obs.unobserve(e.target);          // 只播一次，播完即撤
      }
    }, { rootMargin: '0px 0px -10% 0px', threshold: 0.1 });
    document.querySelectorAll('[data-rise]').forEach(el => io.observe(el));
  } else {
    document.querySelectorAll('[data-rise]').forEach(el => el.classList.add('in'));
  }

  onResize();
  requestAnimationFrame(frame);
}

let errorNoteShown = false;
function fail(msg) {
  api.error = msg;
  root.classList.add('gl-failed');
  if (!errorNoteShown && note) { note.hidden = false; note.textContent = msg + '，三维静物没有画出来；下面的文字照常可读。'; errorNoteShown = true; }
}

function buildTier(tier, upgrade) {
  const gl = state.gl;
  if (!gl) return;
  const t0 = performance.now();
  let built;
  try { built = buildScene(tier); } catch (e) { return; }
  const next = {
    opaque: uploadMesh(gl, built.opaque),
    doubleSided: uploadMesh(gl, built.doubleSided),
    transparent: uploadMesh(gl, built.transparent),
  };
  // 换档：先建后拆，中间不会出现空帧
  const old = { o: state.opaque, d: state.doubleSided, t: state.transparent };
  state.opaque = next.opaque; state.doubleSided = next.doubleSided; state.transparent = next.transparent;
  killMesh(gl, old.o); killMesh(gl, old.d); killMesh(gl, old.t);
  api.tier = tier;
  api.buildMs = Math.round(performance.now() - t0);
  if (upgrade) { api.upgradeMs = api.buildMs; api.upgraded = true; }
}

function onResize() {
  const gl = state.gl; if (!gl) return;
  root.style.setProperty('--vh', (window.innerHeight * 0.01) + 'px');
  const cap = api.tier === 'mobile' ? 1.5 : 2;
  const dpr = Math.min(window.devicePixelRatio || 1, cap);
  const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
}

function onScroll() {
  const y = window.scrollY || document.documentElement.scrollTop || 0;
  root.classList.toggle('scrolled', y > 36);
  if (topbar) topbar.classList.toggle('solid', y > window.innerHeight * 0.62);
}

function onReduceChange(e) {
  api.reduced = e.matches;
}

/* ---------------------------------------------------------------- 渲染 */
function render() {
  const gl = state.gl; if (!gl || !state.opaque) return;
  const cam = state.cur;
  const w = canvas.width, h = canvas.height;
  const aspect = w / Math.max(1, h);

  // 焦点横向让位：屏幕右移 off 个半宽 → 被摄物在画面里偏左，给卡片腾地方
  const rightX = Math.cos(cam.th), rightZ = -Math.sin(cam.th);
  const halfW = cam.d * Math.tan(FOV / 2) * aspect;
  const tx = cam.t[0] + rightX * cam.off * halfW;
  const ty = cam.t[1];
  const tz = cam.t[2] + rightZ * cam.off * halfW;
  const sp = Math.sin(cam.ph), cp = Math.cos(cam.ph);
  const eye = [tx + cam.d * sp * Math.sin(cam.th), ty + cam.d * cp, tz + cam.d * sp * Math.cos(cam.th)];

  mat4.perspective(proj, FOV, aspect, NEAR, FAR);
  mat4.lookAt(view, eye, [tx, ty, tz], [0, 1, 0]);
  mat4.multiply(vp, proj, view);

  gl.viewport(0, 0, w, h);
  // 地面铺到雾里 → 背景色取雾色的色调映射结果，远处地面和背景接得上
  gl.clearColor(HAZE_COLOR[0] / (HAZE_COLOR[0] + 0.85), HAZE_COLOR[1] / (HAZE_COLOR[1] + 0.85),
    HAZE_COLOR[2] / (HAZE_COLOR[2] + 0.85), 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.useProgram(state.program);
  // 材质表贴图每帧显式绑一次：unit 0 不许被别的东西顶掉（顶掉就是整场全黑）
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, state.matTex);

  const L = state.loc;
  if (L.uViewProj) gl.uniformMatrix4fv(L.uViewProj, false, vp);
  if (L.uEye) gl.uniform3fv(L.uEye, eye);
  /* 光照常量与 desk/src/main.js 一字不差地照抄（主光右上偏前 + 左后冷补光）。
     两盏都必须显式写：未赋值的 uniform 数组元素是 0，normalize(0) 是 NaN —— 
     那才是"刺眼纯色"的病根。这里不为了回避颜色问题去调参。 */
  const dir = L.uLightDir || L['uLightDir[0]'];
  const col = L.uLightColor || L['uLightColor[0]'];
  if (dir) gl.uniform3fv(dir, new Float32Array([0.42, 0.72, 0.35, -0.62, 0.30, 0.72]));
  if (col) gl.uniform3fv(col, new Float32Array([0.95, 0.90, 0.80, 0.26, 0.29, 0.35]));
  if (L.uSkyZenith) gl.uniform3fv(L.uSkyZenith, new Float32Array([0.42, 0.52, 0.68]));
  if (L.uSkyHorizon) gl.uniform3fv(L.uSkyHorizon, new Float32Array([0.72, 0.66, 0.56]));
  if (L.uGroundColor) gl.uniform3fv(L.uGroundColor, new Float32Array([0.28, 0.21, 0.14]));
  if (L.uGridPx) gl.uniform1f(L.uGridPx, 1.05);
  if (L.uBorderPx) gl.uniform1f(L.uBorderPx, 1.85);
  if (L.uStarPx) gl.uniform1f(L.uStarPx, 2.6);
  if (L.uBoardFadeNear) gl.uniform1f(L.uBoardFadeNear, 900);
  if (L.uBoardFadeFar) gl.uniform1f(L.uBoardFadeFar, 2600);
  if (L.uGrainOctaves) gl.uniform1f(L.uGrainOctaves, api.tier === 'mobile' ? 3 : 5);
  if (L.uEnvStrength) gl.uniform1f(L.uEnvStrength, api.tier === 'mobile' ? 0.8 : 1.0);
  if (L.uTime) gl.uniform1f(L.uTime, performance.now() * 0.001);
  if (L.uHazeColor) gl.uniform3fv(L.uHazeColor, HAZE_COLOR);
  if (L.uHazeNear) gl.uniform1f(L.uHazeNear, 700);
  if (L.uHazeFar) gl.uniform1f(L.uHazeFar, 3800);

  gl.disable(gl.BLEND);
  gl.depthMask(true);
  gl.enable(gl.CULL_FACE);
  gl.bindVertexArray(state.opaque.vao);
  gl.drawElements(gl.TRIANGLES, state.opaque.count, gl.UNSIGNED_INT, 0);
  api.draws++;

  if (state.doubleSided) {
    gl.disable(gl.CULL_FACE);
    gl.bindVertexArray(state.doubleSided.vao);
    gl.drawElements(gl.TRIANGLES, state.doubleSided.count, gl.UNSIGNED_INT, 0);
    api.draws++;
  }
  if (state.transparent) {
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.bindVertexArray(state.transparent.vao);
    gl.drawElements(gl.TRIANGLES, state.transparent.count, gl.UNSIGNED_INT, 0);
    gl.depthMask(true);
    api.draws++;
  }
  gl.bindVertexArray(null);

  api.distance = cam.d; api.theta = cam.th; api.phi = cam.ph;
  api.target = [tx, ty, tz]; api.eye = eye;
}

function readProgress() {
  const max = document.documentElement.scrollHeight - window.innerHeight;
  if (max <= 1) return 0;
  const y = window.scrollY || document.documentElement.scrollTop || 0;
  return Math.min(1, Math.max(0, y / max));
}

/* 主循环：滚动量 → 阻尼进度 → 关键帧 → 再阻尼 → 画一帧。
   镜头静止时也照画不误 —— 试过"静止就不画"的省电写法，结果是：
   preserveDrawingBuffer 为 false 时，只要页面发生一次重绘（改 DOM、切 class、
   系统来一次合成），画布这一层就会被用已被回收的缓冲重新栅格化，整块变黑。
   整场只有 3 次 draw call，不值得用"可能变黑"换那点 GPU。 */
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, Math.max(0.0001, (now - last) / 1000));
  last = now;
  api.frames++;

  const targetP = LOCK_T !== null ? LOCK_T : (api.reduced ? STATIC_PROGRESS : readProgress());
  api.raw = targetP;

  let moving = false;
  if (LOCK_T !== null || api.reduced) {
    if (Math.abs(api.progress - targetP) > 1e-6) { api.progress = targetP; moving = true; }
  } else {
    const kp = 1 - Math.exp(-LAMBDA_PROGRESS * dt);
    const next = api.progress + (targetP - api.progress) * kp;
    if (Math.abs(next - api.progress) > 1e-6) moving = true;
    api.progress = Math.abs(targetP - next) < 1e-6 ? targetP : next;
  }

  const want = evalKeys(api.progress);
  state.want = want;
  const kc = 1 - Math.exp(-LAMBDA_CAMERA * dt);
  const c = state.cur;
  const step = (a, b) => {
    const n = a + (b - a) * kc;
    if (Math.abs(b - n) > 1e-5) moving = true;
    return Math.abs(b - n) < 1e-5 ? b : n;
  };
  c.d = step(c.d, want.d);
  c.th = step(c.th, want.th);
  c.ph = step(c.ph, want.ph);
  c.off = step(c.off, want.off);
  for (let i = 0; i < 3; i++) c.t[i] = step(c.t[i], want.t[i]);

  if (railBar) railBar.parentElement.style.setProperty('--p', api.progress.toFixed(4));

  api.settled = !moving;
  render();
  requestAnimationFrame(frame);
}

/* 取像素签名：给验收脚本一个"画面真的变了"的判据（不靠 JPEG 字节差）。
   做法是先把刚画的一帧 drawImage 到一张缩略 2D 画布上再取样 —— 
   比直接对着默认帧缓冲 readPixels 稳（多重采样解析那些事交给 drawImage）。 */
let capCanvas = null, capCtx = null;
function capture() {
  const gl = state.gl;
  if (!gl || !canvas.width) return null;
  render();                        // 现画一帧再读：preserveDrawingBuffer 是 false
  const N = 24;
  if (!capCanvas) {
    capCanvas = document.createElement('canvas');
    capCanvas.width = N; capCanvas.height = N;
    capCtx = capCanvas.getContext('2d', { willReadFrequently: true });
  }
  capCtx.clearRect(0, 0, N, N);
  capCtx.drawImage(canvas, 0, 0, N, N);
  const d = capCtx.getImageData(0, 0, N, N).data;
  const grid = new Array(N * N);
  let lum = 0, lit = 0;
  for (let i = 0; i < N * N; i++) {
    const v = (d[i * 4] * 0.2126 + d[i * 4 + 1] * 0.7152 + d[i * 4 + 2] * 0.0722) / 255;
    grid[i] = +v.toFixed(4);
    lum += v;
    if (v > 0.05) lit++;
  }
  return {
    grid, w: canvas.width, h: canvas.height, sample: N, cells: N * N,
    meanLum: +(lum / (N * N)).toFixed(4), litCells: lit,
    glError: gl.getError(), tier: api.tier, progress: +api.progress.toFixed(4),
  };
}
api.capture = capture;

boot();