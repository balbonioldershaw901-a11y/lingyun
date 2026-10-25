// main.js — 组装：1 个 program + 1 张材质表贴图 + 3 次 draw call
// 不引用任何库；只用到 WebGL2 标准 API。

import { VERT_SRC, FRAG_SRC, buildMaterialUBOData, buildMaterialTextureData, MATERIALS } from './material.js';
import { buildScene, TIERS } from './scene.js';
import { KIFU_CAPTION } from './geom/kifu.js';
import { OrbitCamera, mat4 } from './orbit-camera.js';

const FOV_Y = (38 * Math.PI) / 180;
const CAM_THETA = 0.58;   // 方位角：从右前方看，棋盘在中间、太湖石在右后
const CAM_PHI = 1.02;     // 极角：约 32 度俯角
const HAZE_COLOR = [0.36, 0.33, 0.29];   // 远景雾色，和材质表的 floor(bit6) 一致

const state = {
  tier: new URLSearchParams(location.search).get('tier') === 'mobile' ? 'mobile' : 'desktop',
  stats: null,
  focus: null,
  gl: null, program: null, ubo: null,
  opaque: null, doubleSided: null, transparent: null,
  loc: {},
  camera: null,
};

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    console.error('[shader]', log, src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n'));
    throw new Error(`Shader compile failed: ${log}`);
  }
  return sh;
}

function createProgram(gl, vsSrc, fsSrc) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Link failed: ${gl.getProgramInfoLog(p)}`);
  return p;
}

/** 把合并后的几何上传成 VAO：pos(vec3) / normal(vec3) / uv(vec2) / matId(uint8) */
function uploadMesh(gl, mesh) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const bufs = {};
  const mk = (name, data, target = gl.ARRAY_BUFFER) => {
    const b = gl.createBuffer();
    gl.bindBuffer(target, b);
    gl.bufferData(target, data, gl.STATIC_DRAW);
    bufs[name] = b;
    return b;
  };
  const stride = 3 * 4 + 3 * 4 + 2 * 4 + 1; // 27 字节（交错也完全可以，这里分开存更清楚）
  mk('pos', mesh.positions);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
  mk('nrm', mesh.normals);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
  mk('uv', mesh.uvs);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0);
  mk('mat', mesh.matIds);
  gl.enableVertexAttribArray(3);
  gl.vertexAttribIPointer(3, 1, gl.UNSIGNED_BYTE, 0, 0); // 整数属性必须用 I 版本
  mk('idx', mesh.indices, gl.ELEMENT_ARRAY_BUFFER);
  gl.bindVertexArray(null);
  return { vao, count: mesh.indices.length, bufs, stride };
}

/**
 * 机位：由"焦点组包围盒"算出来，而不是手糊一个距离。
 *   - 横向要容纳的宽度：包围盒在相机右向量上的投影 = 斜视角下 x 与 z 都要算进去；
 *   - 距离 = 该宽度 / 水平半视场的 tan；窄屏（竖屏/移动端）按宽高比自动后退；
 *   - 目标点抬到包围盒中心以下（整体在 y 上很"薄"，对准几何中心会把画面往上顶，
 *     底部的前景笔和纸就没余量了）。
 * 单位：1 = 1mm；桌面级这一档算出来约 1.4m，和"相机距离约 1.1m"同一量级。
 */
function cameraFor(focus, canvas) {
  const aspect = Math.max(0.35, (canvas.clientWidth || 1280) / Math.max(1, canvas.clientHeight || 800));
  const projW = Math.abs(focus.size[0] * Math.cos(CAM_THETA)) + Math.abs(focus.size[2] * Math.sin(CAM_THETA));
  const distance = (projW * 0.5 * 1.12) / (Math.tan(FOV_Y / 2) * aspect);
  return {
    target: [focus.center[0], focus.center[1] * 0.75, focus.center[2]],
    theta: CAM_THETA,
    phi: CAM_PHI,
    distance,
    minDistance: distance * 0.35,
    maxDistance: distance * 2.4,
  };
}

function init() {
  const canvas = document.getElementById('gl');
  const gl = canvas.getContext('webgl2', {
    antialias: true, alpha: false, depth: true, stencil: false,
    powerPreference: 'high-performance', preserveDrawingBuffer: false,
  });
  if (!gl) { document.getElementById('hud').textContent = '此浏览器不支持 WebGL2'; return; }
  state.gl = gl;

  state.program = createProgram(gl, VERT_SRC, FRAG_SRC);
  gl.useProgram(state.program);

  // ---- 材质表：贴图（着色器读它）+ UBO（诊断镜像）----
  // 贴图：宽 = 材质数、高 2 的 RGBA32F，第 0 行 matA、第 1 行 matB，texelFetch 直接按材质号取。
  // 注意 RGBA32F 不可过滤，TEXTURE_MIN_FILTER 必须显式设成 NEAREST：
  // 默认是 NEAREST_MIPMAP_LINEAR，而这张贴图没有 mipmap → 贴图不完整，texelFetch 全读成黑。
  const tableData = buildMaterialTextureData();
  const matTex = gl.createTexture();
  state.matTex = matTex;
  gl.bindTexture(gl.TEXTURE_2D, matTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, MATERIALS.length, 2, 0, gl.RGBA, gl.FLOAT, tableData);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.activeTexture(gl.TEXTURE0);
  gl.uniform1i(gl.getUniformLocation(state.program, 'uMatTable'), 0);

  // UBO：着色器已经不读它了（读的是上面那张贴图），留它是给 probe-desk.cjs 当探针用 ——
  // 那支探针按"逐材质交错"读回这 512 字节并核对，所以这里喂 buildMaterialUBOData()。
  // 结尾故意不 unbind：探针读的是 UNIFORM_BUFFER_BINDING，解绑它就什么都读不到了。
  const ubo = gl.createBuffer();
  state.ubo = ubo;
  gl.bindBuffer(gl.UNIFORM_BUFFER, ubo);
  gl.bufferData(gl.UNIFORM_BUFFER, buildMaterialUBOData(), gl.STATIC_DRAW);
  gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, ubo);

  // ---- uniform 位置缓存 ----
  for (const n of ['uViewProj', 'uEye', 'uLightDir[0]', 'uLightColor[0]', 'uLightDir[1]', 'uLightColor[1]', 'uSkyZenith', 'uSkyHorizon',
    'uGroundColor', 'uGridPx', 'uBorderPx', 'uStarPx', 'uBoardFadeNear', 'uBoardFadeFar',
    'uGrainOctaves', 'uEnvStrength', 'uTime', 'uHazeColor', 'uHazeNear', 'uHazeFar']) state.loc[n] = gl.getUniformLocation(state.program, n);

  rebuildScene();

  const resize = () => {
    // 移动端把 DPR 夹到 1.5，避免 3x 屏上填充率爆炸
    const dpr = Math.min(window.devicePixelRatio || 1, state.tier === 'mobile' ? 1.5 : 2);
    const w = Math.floor(canvas.clientWidth * dpr), h = Math.floor(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  };
  window.addEventListener('resize', resize);
  resize();   // 先定下画布尺寸：机位要按真实宽高比算

  state.camera = new OrbitCamera(cameraFor(state.focus, canvas));
  state.camera.attach(canvas);

  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.enable(gl.CULL_FACE);
  gl.cullFace(gl.BACK);
  gl.frontFace(gl.CCW);          // 生成器保证 CCW 朝外

  const view = mat4.identity(), proj = mat4.identity(), vp = mat4.identity();
  let last = performance.now();
  const frame = (now) => {
    const dt = Math.max(0.0001, (now - last) / 1000); last = now;
    resize();
    state.camera.update(dt);
    const cam = state.camera;
    mat4.perspective(proj, FOV_Y, canvas.width / Math.max(1, canvas.height), 20, 8000);
    mat4.lookAt(view, cam.eye, cam.target, [0, 1, 0]);
    mat4.multiply(vp, proj, view);

    gl.viewport(0, 0, canvas.width, canvas.height);
    // 地面一直铺到雾里，所以背景色取"雾色过完色调映射 + gamma"之后的值：
    // 与远处地面的最终颜色一致 → 画到地面边缘/远裁剪面时接缝看不见。
    gl.clearColor(HAZE_COLOR[0] / (HAZE_COLOR[0] + 0.85), HAZE_COLOR[1] / (HAZE_COLOR[1] + 0.85), HAZE_COLOR[2] / (HAZE_COLOR[2] + 0.85), 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.useProgram(state.program);
    gl.uniformMatrix4fv(state.loc.uViewProj, false, vp);
    gl.uniform3fv(state.loc.uEye, cam.eye);
    gl.uniform3fv(state.loc['uLightDir[0]'], new Float32Array([0.42, 0.72, 0.35]));  // 主光（右上偏前）
    gl.uniform3fv(state.loc['uLightColor[0]'], new Float32Array([0.95, 0.90, 0.80]));
  /* 补光（左后、偏冷、弱）。**必须显式设**：不设就是零向量，
     而 normalize(零向量) 会产出 NaN，把颜色染成刺眼的纯色（常见纯绿）。
     着色器那边也加了"退化光源直接跳过"，两处都留着 —— 少一处都可能复发。 */
  gl.uniform3fv(state.loc['uLightDir[1]'], new Float32Array([-0.62, 0.30, 0.72]));
  gl.uniform3fv(state.loc['uLightColor[1]'], new Float32Array([0.26, 0.29, 0.35]));
    gl.uniform3fv(state.loc['uSkyZenith'], new Float32Array([0.42, 0.52, 0.68]));
    gl.uniform3fv(state.loc['uSkyHorizon'], new Float32Array([0.72, 0.66, 0.56]));
    gl.uniform3fv(state.loc['uGroundColor'], new Float32Array([0.28, 0.21, 0.14]));
    gl.uniform1f(state.loc.uGridPx, 1.05);
    gl.uniform1f(state.loc.uBorderPx, 1.85);
    gl.uniform1f(state.loc.uStarPx, 2.6);
    gl.uniform1f(state.loc.uBoardFadeNear, 900);
    gl.uniform1f(state.loc.uBoardFadeFar, 2600);
    gl.uniform1f(state.loc.uGrainOctaves, state.tier === 'mobile' ? 3 : 5);
    gl.uniform1f(state.loc.uEnvStrength, state.tier === 'mobile' ? 0.8 : 1.0);
    gl.uniform1f(state.loc.uTime, now * 0.001);
    gl.uniform3fv(state.loc.uHazeColor, new Float32Array(HAZE_COLOR));
    gl.uniform1f(state.loc.uHazeNear, 700);
    gl.uniform1f(state.loc.uHazeFar, 3800);

    // ---- pass 1：不透明（闭合体），开背面剔除，1 次 draw call ----
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.enable(gl.CULL_FACE);
    gl.bindVertexArray(state.opaque.vao);
    gl.drawElements(gl.TRIANGLES, state.opaque.count, gl.UNSIGNED_INT, 0);

    // ---- pass 2：双面不透明（掏洞太湖石）。关剔除，法线靠 gl_FrontFacing 翻 ----
    if (state.doubleSided) {
      gl.disable(gl.CULL_FACE);
      gl.bindVertexArray(state.doubleSided.vao);
      gl.drawElements(gl.TRIANGLES, state.doubleSided.count, gl.UNSIGNED_INT, 0);
    }

    // ---- pass 3：纸与接触阴影贴片（半透明）。关剔除 + 关深度写入 ----
    if (state.transparent) {
      gl.disable(gl.CULL_FACE);   // 显式关：别依赖 pass 2 的状态
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.bindVertexArray(state.transparent.vao);
      gl.drawElements(gl.TRIANGLES, state.transparent.count, gl.UNSIGNED_INT, 0);
      gl.depthMask(true);
    }
    gl.bindVertexArray(null);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function disposeScene() {
  const gl = state.gl;
  const kill = (m) => {
    if (!m) return;
    gl.deleteVertexArray(m.vao);
    for (const k in m.bufs) gl.deleteBuffer(m.bufs[k]);
  };
  kill(state.opaque); kill(state.doubleSided); kill(state.transparent);
  state.opaque = null; state.doubleSided = null; state.transparent = null;
}

function rebuildScene() {
  const gl = state.gl;
  disposeScene();
  const built = buildScene(state.tier);
  state.opaque = uploadMesh(gl, built.opaque);
  state.doubleSided = uploadMesh(gl, built.doubleSided);
  state.transparent = uploadMesh(gl, built.transparent);
  state.stats = built.stats;
  state.focus = built.focus;
  const hud = document.getElementById('hud');
  if (hud) {
    const k = built.stats.kifu;
    hud.textContent = `${TIERS[state.tier].label} · 三角 ${built.stats.totalTris.toLocaleString()} · `
      + `顶点 ${built.stats.opaqueVerts.toLocaleString()} · draw call ${built.stats.drawCalls} · 材质 ${MATERIALS.length}`
      + ` · 棋谱「${k.nameZh}」第 ${k.placedUpTo} 手（${k.stones} 子）`;
  }
  /* 盘上是什么棋：一句话，白话，放在页面上（文案只有 kifu.js 一处） */
  const cap = document.getElementById('kifu');
  if (cap) cap.textContent = KIFU_CAPTION;
}

window.addEventListener('keydown', (e) => {
  if (e.key === '1') { state.tier = 'desktop'; rebuildScene(); }
  if (e.key === '2') { state.tier = 'mobile'; rebuildScene(); }
});

init();