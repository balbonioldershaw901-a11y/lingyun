// material.js — 材质表 + 单 program 的"uber 着色器"（GLSL ES 3.00）
// 组织方式的结论：1 个 program + 1 张材质表 + 每顶点 materialId
//   → 静态静物整场 1 次 draw call（不透明）+ 1 次（双面石）+ 1 次（半透明纸与阴影贴片）
//
// 材质表的读取方式：sampler2D + texelFetch（每材质 2 个 texel：第 0 行 matA、第 1 行 matB）。
// 曾经的写法是 layout(std140) uniform MatTable { vec4 matA[16]; vec4 matB[16]; }，
// 但 JS 那边把 8 个 float 按材质**交错**打包，而 std140 里两个数组是**前后两块** ——
// 布局不一致，matA[i] 只在偶数 i 上凑巧读对，奇数 i 读到上一个材质的 features/spec/f0，
// 于是砚台（id7）读成 (0,0.55,0.03)、太湖石（id11）读成 (0,0.35,0.045) —— 刺眼的纯绿。
// 详见 README.md「工程问题 1 / 5」。

export const MATERIALS = [
  // name            baseColor                roughness  features bitmask
  // features: 1 棋盘网格线 | 2 木纹 | 4 假环境反射 | 8 纸透光 | 16 多孔石 | 32 丝绳
  //           64 远景雾（远处化进环境色）| 128 接触阴影贴片（软边 alpha）
  { name: 'woodTop', color: [0.72, 0.53, 0.30], roughness: 0.42, features: 1 | 2, spec: 0.35, f0: 0.035, extra: 1.0 },
  { name: 'woodEdge', color: [0.66, 0.47, 0.26], roughness: 0.50, features: 2, spec: 0.25, f0: 0.030, extra: 1.0 },
  { name: 'stoneBlack', color: [0.020, 0.022, 0.027], roughness: 0.16, features: 4, spec: 1.0, f0: 0.045, extra: 1.0 },
  { name: 'stoneWhite', color: [0.855, 0.842, 0.805], roughness: 0.34, features: 0, spec: 0.55, f0: 0.030, extra: 0.35 },
  { name: 'bamboo', color: [0.66, 0.50, 0.24], roughness: 0.34, features: 2, spec: 0.45, f0: 0.040, extra: 4.0 },
  { name: 'bristle', color: [0.10, 0.075, 0.055], roughness: 0.46, features: 0, spec: 0.35, f0: 0.045, extra: 0.0 },
  { name: 'ferrule', color: [0.32, 0.20, 0.10], roughness: 0.30, features: 0, spec: 0.5, f0: 0.050, extra: 0.0 },
  { name: 'inkstone', color: [0.155, 0.150, 0.145], roughness: 0.62, features: 16, spec: 0.20, f0: 0.020, extra: 1.0 },
  { name: 'inkstoneSide', color: [0.135, 0.130, 0.126], roughness: 0.72, features: 16, spec: 0.15, f0: 0.018, extra: 1.0 },
  { name: 'paper', color: [0.92, 0.90, 0.845], roughness: 0.85, features: 8, spec: 0.06, f0: 0.020, extra: 1.0 },
  { name: 'paperRoll', color: [0.90, 0.88, 0.825], roughness: 0.85, features: 8, spec: 0.06, f0: 0.020, extra: 1.0 },
  // 太湖石：原来是 [0.255,0.245,0.230]（几乎中性的冷灰）+ extra 1.7，渲染出来是一块**没有颜色的惨白石头**。
  // 两个原因叠在一起：
  //   ① extra 在这套着色器里同时是「wrap 光照的推开量」。1.7 属于外推
  //      （mix(NoL, wrap, 1.7) = 1.7·wrap − 0.7·NoL），背光面被抬到 0.6 以上，
  //      整块石头的明暗被压平、只往亮里走 —— 形状读不出来，就只剩一坨白。
  //   ② 基色 R/G/B 相差不到 0.03，中间调上根本看不出暖调，石头像是没上材质。
  // 现在：基色取太湖石的暖灰石色（R−B ≈ 0.1，即石灰岩那种带土黄的灰），
  // extra 降到 0.45（正常 wrap，保留块面明暗），粗糙度提到 0.82、高光压低 ——
  // 石头该是哑的，不该有砚台那种抛光感。extra 同时是假 AO 的噪声尺度
  // （0.02×extra），变小之后空腔暗化从"细颗粒"变成"大块斑"，更像风化的孔洞。
  { name: 'rock', color: [0.352, 0.312, 0.252], roughness: 0.82, features: 16, spec: 0.10, f0: 0.018, extra: 0.45 },
  { name: 'cord', color: [0.42, 0.10, 0.09], roughness: 0.58, features: 32, spec: 0.25, f0: 0.030, extra: 1.0 },
  { name: 'gridLine', color: [0.045, 0.035, 0.028], roughness: 0.55, features: 0, spec: 0.10, f0: 0.020, extra: 0.0 },
  { name: 'desk', color: [0.235, 0.175, 0.115], roughness: 0.55, features: 2, spec: 0.28, f0: 0.030, extra: 0.25 },
  // 地面（影棚地台）：桌面之外要有"环境色"，远处靠 bit6 化进雾里 → 背景不再全黑
  { name: 'floor', color: [0.105, 0.092, 0.078], roughness: 0.88, features: 16 | 64, spec: 0.06, f0: 0.020, extra: 1.0 },
  // 接触阴影贴片（bit7）：不参与光照，只用 alpha 画软边。
  // 这三个字段在这里换了含义：roughness=软边宽度、spec=超椭圆指数（越大越接近矩形）、extra=峰值不透明度
  { name: 'contact', color: [0.030, 0.024, 0.020], roughness: 0.55, features: 128, spec: 3.0, f0: 0.0, extra: 0.58 },
];

export const MATERIAL_INDEX = Object.fromEntries(MATERIALS.map((m, i) => [m.name, i]));

/**
 * 材质表的唯一打包处：每材质 8 个 float，**交错**存（rgb, roughness, features, spec, f0, extra）。
 * 这只是"源数据"，不是任何一种 GPU 布局。
 */
export function buildMaterialRows() {
  const N = MATERIALS.length;
  const data = new Float32Array(N * 8);
  MATERIALS.forEach((m, i) => {
    const o = i * 8;
    data[o] = m.color[0]; data[o + 1] = m.color[1]; data[o + 2] = m.color[2]; data[o + 3] = m.roughness;
    data[o + 4] = m.features; data[o + 5] = m.spec; data[o + 6] = m.f0; data[o + 7] = m.extra;
  });
  return data;
}

/**
 * **平面**布局：前 N 个 vec4 是 A（rgb + roughness），后 N 个是 B（features/spec/f0/extra）。
 * 两种读法都吃这一份数据：
 *   - 贴图（着色器走这条路）：宽 N、高 2 的 RGBA32F，第 0 行 = matA[i]，第 1 行 = matB[i]，
 *     texelFetch(ivec2(i, 0..1), 0) 直接取，不经过任何 std140 规则 → 不可能再对不上。
 *   - 真要退回 UBO 数组：layout(std140) uniform MatTable { vec4 matA[N]; vec4 matB[N]; }
 *     的内存顺序正好就是它，bufferData 上去即可，不必再算偏移。
 *
 * 原来的坑：JS 按材质交错打包，着色器却声明成两个数组（std140 里是前后两块），
 * matA[i] 于是只在偶数 i 上凑巧读对；奇数 i 读到上一个材质的 features/spec/f0。
 * 砚台 id7 读到 m3 的 (features 0, spec 0.55, f0 0.03) → albedo 变成 (0, 0.55, 0.03) 纯绿，
 * 太湖石 id11 读到 m5 的 (0, 0.35, 0.045) 也是纯绿 —— 这就是当初那两块绿。
 */
export function buildMaterialTextureData() {
  const N = MATERIALS.length;
  const rows = buildMaterialRows();
  const planar = new Float32Array(N * 8);
  for (let i = 0; i < N; i++) {
    for (let k = 0; k < 4; k++) {
      planar[i * 4 + k] = rows[i * 8 + k];
      planar[N * 4 + i * 4 + k] = rows[i * 8 + 4 + k];
    }
  }
  return planar;
}

/**
 * 喂给"诊断镜像 UBO"的那份逐材质交错数据（着色器不读它）。
 * 存在的唯一理由：probe-desk.cjs 会按交错顺序把这 512 字节读回来核对材质表，表错了立刻看得见。
 * 别把它换成平面顺序 —— 那支探针读不懂，会打出一堆看着像出错的数。
 */
export const buildMaterialUBOData = buildMaterialRows;

/* ============================ 顶点着色器 ============================ */
export const VERT_SRC = `#version 300 es
precision highp float;

layout(location = 0) in vec3 aPos;      // 已烘焙到世界空间
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUV;
layout(location = 3) in uint aMatId;    // gl.vertexAttribIPointer，整数属性必须用 I 版本

uniform mat4 uViewProj;
uniform vec3 uEye;

out vec3 vWorld;
out vec3 vNormal;
out vec2 vUV;
out float vViewDist;
flat out uint vMatId;   // 整数 varying 必须 flat

void main() {
  vWorld = aPos;
  vNormal = aNormal;
  vUV = aUV;
  vMatId = aMatId;
  vViewDist = length(uEye - aPos);
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

/* ============================ 片元着色器 ============================ */
export const FRAG_SRC = `#version 300 es
precision highp float;

in vec3 vWorld;
in vec3 vNormal;
in vec2 vUV;
in float vViewDist;
flat in uint vMatId;

uniform vec3 uEye;
uniform vec3 uLightDir[2];      // 已归一化，指向光源
uniform vec3 uLightColor[2];
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uGroundColor;
uniform float uGridPx;          // 棋盘网格线宽度（像素，屏幕空间稳定）
uniform float uBorderPx;        // 边线宽度（像素）
uniform float uStarPx;          // 星位半径（像素）
uniform float uBoardFadeNear;   // 网格线开始淡出的距离
uniform float uBoardFadeFar;
uniform float uGrainOctaves;    // 移动端降级：木纹 fBm 层数
uniform float uEnvStrength;     // 假环境反射总强度（移动端可降）
uniform float uTime;            // 未用，留接口（灰尘/水汽动画）
uniform vec3 uHazeColor;        // 远景雾色（地面远处化进它；main.js 的 clearColor 与之对齐）
uniform float uHazeNear;        // 开始起雾的距离
uniform float uHazeFar;         // 完全化成雾色的距离

/* 材质表：宽 = 材质数、高 2 的 RGBA32F 贴图。
   第 0 行 matA（rgb=baseColor, a=roughness），第 1 行 matB（x=features, y=spec, z=F0, w=extra）。
   为什么不用 UBO 数组：std140 的布局与 JS 打包顺序一旦不一致，就会静默读出隔壁材质的字段
   （本工程就是这么绿起来的）。texelFetch 的坐标就是"第几个材质、第几行"，没有对齐规则可踩。 */
uniform highp sampler2D uMatTable;

out vec4 fragColor;

const float PI = 3.14159265359;

/* ---------------- 程序化噪声（片元用，2D 足够） ---------------- */
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i), b = hash12(i + vec2(1, 0));
  float c = hash12(i + vec2(0, 1)), d = hash12(i + vec2(1, 1));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm2(vec2 p, float octaves) {
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 6; i++) {
    if (float(i) >= octaves) break;   // 上界是常量，uniform 控制层数 → 合法
    s += a * vnoise2(p); n += a;
    p = p * 2.03 + 17.1; a *= 0.5;
  }
  return s / max(n, 1e-4);
}

/* ================= 工程问题 2：片元里直接算 19 路网格 =================
 * uv 在 [0,1] 上正好覆盖 19×19 交叉点的区域：
 *   格坐标 g = uv * 18，整数处就是棋线；0 与 18 是两条边线。
 * 抗锯齿用 fwidth：把"到线的距离"换算成像素数，再 smoothstep。
 * 好处：分辨率无关、零显存、距离/掠射角自动"自限"（线宽按像素恒定，
 *       远处 fwidth 变大 → 线自然变淡，不会摩尔纹炸裂）。
 * 代价：每个像素多几十条 ALU；近景极近距离想要"墨渗进木头"的质感，
 *       仍然建议叠一层几何线或小贴图（见 makeBoardGridLines）。
 */
float gridMask(vec2 g, vec2 px, float widthPx) {
  vec2 d = abs(fract(g - 0.5) - 0.5) / px;   // 到最近整数线的距离（像素）
  return 1.0 - smoothstep(widthPx - 0.5, widthPx + 0.5, min(d.x, d.y));
}

float borderMask(vec2 uv, vec2 px, float widthPx) {
  // 边界线在 g=0 与 g=18 上：统计到 uv 边界的距离，只画内侧（否则会被裁掉一半）
  float d = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)) * 18.0;
  float dPx = d / max(px.x, 1e-5);
  return 1.0 - smoothstep(widthPx - 0.5, widthPx + 0.5, dPx);
}

float starMask(vec2 g, vec2 px, float radiusPx) {
  float m = 1e9;
  // 9 个星位：(3,3) (3,9) (3,15) (9,3) ... (15,15)
  for (int i = 0; i < 3; i++) {
    for (int j = 0; j < 3; j++) {
      vec2 s = vec2(3.0 + float(i) * 6.0, 3.0 + float(j) * 6.0);
      m = min(m, length((g - s) / px));
    }
  }
  return 1.0 - smoothstep(radiusPx - 0.5, radiusPx + 0.5, m);
}

/* ---------------- 木纹：沿 x 拉伸的年轮 + 域扭曲 + 细纹 ---------------- */
float woodGrain(vec2 uv, float stretch, float scale, float octaves) {
  vec2 p = vec2(uv.x * stretch, uv.y) * scale;
  float w = fbm2(p * 0.55 + 3.7, octaves);
  float g = fbm2(p + vec2(w * 1.6, w * 0.5), octaves);
  float rings = abs(sin((p.x * 0.22 + g * 0.9) * PI * 2.0));
  float fiber = fbm2(vec2(p.x * 6.0, p.y * 0.35), max(2.0, octaves - 2.0));
  return mix(0.86, 1.08, pow(rings, 0.65)) * (0.93 + 0.12 * fiber);
}

/* ============ 工程问题 4：无 HDRI / 无 cubemap 的"假环境反射" ============
 * 三层叠加：
 *   1) 天空梯度（按反射向量 R 的 y 分两段混色）+ 桌面暖色回弹（R.y<0）
 *   2) 一条"窗光"窄亮带：让镜面里有可读的结构，否则黑子只会是一坨渐变
 *   3) 菲涅尔：黑子的黑是"边缘亮、正面几乎全黑"，这一项负责让它不死黑
 */
vec3 fakeEnv(vec3 R) {
  float t = clamp(R.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 env = mix(uGroundColor, uSkyHorizon, smoothstep(0.0, 0.52, t));
  env = mix(env, uSkyZenith, smoothstep(0.46, 1.0, t));
  vec3 winDir = normalize(vec3(0.32, 0.62, -0.72));
  float win = pow(clamp(dot(normalize(R), winDir), 0.0, 1.0), 26.0);
  env += vec3(1.0, 0.965, 0.90) * win * 0.75;
  env += uGroundColor * 0.35 * smoothstep(0.15, -0.5, R.y);   // 桌面二次反弹
  return env;
}

float fresnelSchlick(float cosT, float F0) {
  return F0 + (1.0 - F0) * pow(clamp(1.0 - cosT, 0.0, 1.0), 5.0);
}

void main() {
  vec4 A = texelFetch(uMatTable, ivec2(int(vMatId), 0), 0);
  vec4 B = texelFetch(uMatTable, ivec2(int(vMatId), 1), 0);
  vec3 albedo = A.rgb;
  float roughness = clamp(A.a, 0.03, 1.0);
  float features = B.x;
  float specStrength = B.y;
  float F0 = B.z;
  float extra = B.w;

  vec3 N = normalize(vNormal);
  if (!gl_FrontFacing) N = -N;      // 双面物体（纸、有孔太湖石、挂绳）
  vec3 V = normalize(uEye - vWorld);
  float NoV = clamp(dot(N, V), 0.0, 1.0);
  vec3 R = reflect(-V, N);

  /* !! 求导必须在"一致的控制流"里取 !!
   * fwidth 是在 2x2 像素块上做的差分；如果同一像素块里的像素走了不同分支
   * （这里 matId 是 flat varying，逐三角形变化 → 同一 quad 可能跨材质），
   * 结果就是未定义的。所以先把导数无条件算出来，再进分支。
   * 每个像素多 2 次 fwidth，换来"一定正确"。
   */
  vec2 gUV = vUV * 18.0;
  vec2 gPx = max(fwidth(gUV), vec2(1e-5));   // 每 1 格对应多少像素

  /* ---------- 木纹 ---------- */
  if (features > 0.0) {
    if (mod(floor(features / 2.0), 2.0) > 0.5) {   // bit1: 木纹
      float g = woodGrain(vUV, extra, 6.0, uGrainOctaves);
      albedo *= g;
    }
  }

  /* ---------- 棋盘网格线（bit0）---------- */
  float lineMask = 0.0;
  if (mod(features, 2.0) > 0.5) {
    vec2 g = gUV;
    vec2 px = gPx;
    float fade = 1.0 - smoothstep(uBoardFadeNear, uBoardFadeFar, vViewDist);
    // 掠射角自限：视线越平，线越淡（避免远处闪烁）
    fade *= mix(0.55, 1.0, pow(NoV, 0.35));
    lineMask = max(max(gridMask(g, px, uGridPx * extra), borderMask(vUV, px, uBorderPx * extra)),
                   starMask(g, px, uStarPx));
    lineMask *= fade;
    albedo = mix(albedo, vec3(0.035, 0.026, 0.020), clamp(lineMask, 0.0, 1.0) * 0.92);
  }

  /* ---------- 多孔石 / 砚台的程序化空腔暗化（假 AO）---------- */
  if (mod(floor(features / 16.0), 2.0) > 0.5) {
    float cav = fbm2(vWorld.xz * (0.02 * extra) + vWorld.y * 0.013, 4.0);
    albedo *= mix(0.62, 1.12, smoothstep(0.28, 0.78, cav));
    roughness = clamp(roughness * mix(1.15, 0.9, cav), 0.05, 1.0);
  }

  /* ---------- 丝绳的小噪声（bit5）---------- */
  if (mod(floor(features / 32.0), 2.0) > 0.5) {
    albedo *= 0.9 + 0.2 * fbm2(vec2(atan(vWorld.z, vWorld.x) * 40.0, vWorld.y * 12.0), 3.0);
  }

  /* ---------- 直接光照：两个方向光 ---------- */
  vec3 color = vec3(0.0);
  float specExp = clamp(2.0 / max(pow(roughness, 4.0), 1e-4) - 2.0, 4.0, 4096.0);
  for (int i = 0; i < 2; i++) {
    /* !! 退化光源必须跳过 !!
     * 未赋值的 uniform 数组元素是 0，而 normalize(vec3(0)) 是 NaN。
     * 接着 color += albedo * uLightColor[i] * wrapDiff 里 0.0 * NaN 仍然是 NaN，
     * 于是颜色被污染 —— 表现是**刺眼的纯色**（常见为纯绿或纯品红），
     * 而且只有"只做加法"的材质会出问题：像纸那样 color = ... 直接覆盖的分支
     * 会把 NaN 冲掉，于是看起来是好的。这个不对称正是它的指纹。
     * 所以：长度太小的光源直接 continue，绝不让它进 normalize。
     *
     * 另注：本着色器源码是 JS 模板字符串，**注释里禁止出现反引号** ——
     * 一个反引号就会提前闭合模板字符串，报出的却是莫名的 JS 语法错误。 */
    float len2 = dot(uLightDir[i], uLightDir[i]);
    if (len2 < 1e-8) continue;
    vec3 L = uLightDir[i] * inversesqrt(len2);
    vec3 H = normalize(L + V);
    float NoL = clamp(dot(N, L), 0.0, 1.0);
    float NoH = clamp(dot(N, H), 0.0, 1.0);
    // 白子的"贝壳透光"：wrap lighting 把明暗交界线推开，别硬切
    float wrapDiff = mix(NoL, clamp((dot(N, L) + 0.55) / 1.55, 0.0, 1.0), extra);
    color += albedo * uLightColor[i] * wrapDiff;
    float spec = pow(NoH, specExp) * specStrength;
    color += uLightColor[i] * spec * (0.25 + 0.75 * fresnelSchlick(clamp(dot(H, V), 0.0, 1.0), F0));
  }

  /* ---------- 假环境反射（bit2）：黑子的灵魂 ---------- */
  if (mod(floor(features / 4.0), 2.0) > 0.5) {
    float F = fresnelSchlick(NoV, F0);
    vec3 env = fakeEnv(R) * uEnvStrength;
    // 微粗糙扰动：完美镜面太"数码"，一点点法线抖动让它像抛光石头
    float jitter = fbm2(vWorld.xz * 22.0 + vWorld.y * 6.0, 3.0) - 0.5;
    env *= 1.0 + 0.18 * jitter;
    // 关键：黑不是死黑。给一个极小的环境漫反射垫底（≈0.012），
    // 再让菲涅尔在边缘把它提亮 —— 这就是"黑曜石/那智黑石"的读感
    color += albedo * uSkyHorizon * 0.9;
    color += env * mix(F, F * 1.9, 0.5) * 2.2;
    // 掠射角的补偿：边缘掠射那圈亮边
    color += uSkyHorizon * pow(1.0 - NoV, 4.0) * 0.10;
  }

  /* ---------- 纸的半透（bit3）---------- */
  float alpha = 1.0;
  if (mod(floor(features / 8.0), 2.0) > 0.5) {
    vec3 L0 = normalize(uLightDir[0]);
    float back = clamp(dot(-N, L0), 0.0, 1.0);      // 背光透光
    float front = clamp(dot(N, L0), 0.0, 1.0);
    color = albedo * (0.45 + 0.55 * back) + albedo * front * 0.55;
    color += albedo * 0.25 * fbm2(vUV * 40.0, 3.0);  // 纸纤维
    // 单层纸都双面：背面稍微更亮（光透过来）
    alpha = gl_FrontFacing ? 0.80 : 0.62;
  }

  /* ---------- 接触阴影贴片（bit7）：贴在支撑面上的一层软阴影 ----------
   * 没有 shadow map 的时候，"物体浮在空中"最缺的就是这一口气：
   * 物体与桌面/地面之间一条渐隐的暗边。做法是一张朝上的贴片，只算 alpha：
   *   超椭圆距离（spec 当指数：2 是椭圆、越大越接近矩形）→ 软边 → 乘峰值不透明度（extra）。
   * 不参与光照，直接用 albedo 当阴影色。 */
  if (mod(floor(features / 128.0), 2.0) > 0.5) {
    vec2 q = abs(vUV * 2.0 - 1.0);
    float ex = max(specStrength, 1.5);
    float d = pow(pow(q.x, ex) + pow(q.y, ex), 1.0 / ex);
    float soft = clamp(roughness, 0.08, 1.0);       // 软边宽度（材质里 roughness 顶上用）
    color = albedo;
    alpha = (1.0 - smoothstep(1.0 - soft, 1.0, d)) * extra;
  }

  /* ---------- 远景雾（bit6）：地面远处化进环境色 ----------
   * 背景全黑是"没有环境"的一半原因；雾把地面和大到出画的地台接上，
   * 远处的最终颜色等于 uHazeColor，main.js 的 clearColor 取同一个值 → 接缝看不见。 */
  if (mod(floor(features / 64.0), 2.0) > 0.5) {
    float haze = smoothstep(uHazeNear, uHazeFar, vViewDist);
    color = mix(color, uHazeColor, haze);
  }

  /* ---------- 距离淡化（只对网格线保留；其它物体给一点点雾）---------- */
  color = max(color, vec3(0.0));
  // 简单的色调映射，避免高光过曝成方块
  color = color / (color + vec3(0.85));
  color = pow(color, vec3(1.0 / 2.2));

  fragColor = vec4(color, alpha);
}`;