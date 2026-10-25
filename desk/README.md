# 文人书桌静物 · 原始 WebGL2 手写几何配方

零依赖：没有 three.js、没有模型文件、没有 CDN。全部几何由 JS 生成，全部材质由手写 GLSL ES 3.00 完成。
单位用毫米（棋盘 460mm、棋子直径 22mm），相机距离约 1.1m，1 单位 = 1mm，尺度感直接可对。

## 文件

| 文件 | 内容 |
| --- | --- |
| `src/geom/util.js` | 整数 hash 噪声 / fBm、MeshBuilder、法线三策略、绕序自检、合并烘焙 |
| `src/geom/revolve.js` | `lathe()` 车削 + `sweep()` 扫掠（旋转最小化标架）——棋子、笔、笔头都走这里 |
| `src/geom/board.js` | 围棋盘（倒角 + 硬边顶点复制）、几何版棋盘线（A/B 对比用）、交叉点坐标 |
| `src/geom/stones.js` | 围棋子双凸透镜剖面 |
| `src/geom/brush.js` | 笔杆 / 笔斗 / 笔头（收细 + 回锋）/ 挂绳 |
| `src/geom/inkslab.js` | 砚台（圆角矩形射线求交 + 高度场墨池 + 磨损） |
| `src/geom/paper.js` | 宣纸薄片（高度场）+ 宣纸卷（阿基米德螺线） |
| `src/geom/rock.js` | 太湖石（icosphere 位移 + 掏洞删面 + 去碎块） |
| `src/material.js` | 材质表 + uber 着色器（VS/FS 全文）+ std140 UBO 打包 |
| `src/scene.js` | 两档分段参数 `TIERS`、摆场、合并成 3 次 draw call |
| `src/orbit-camera.js` | 球面轨道相机 + 阻尼 + 极小 mat4 |
| `src/main.js` | 组装与渲染循环 |
| `tools/budget.mjs` | 面数预算 + 绕序/体积自检（Node 直跑，不需要 GL） |

跑起来：

```bash
cd _webgl2-wenren-desk
python -m http.server 8000     # 或任意静态服务；直接双击 index.html 会被 CORS 挡住 ES module
# 浏览器打开 http://localhost:8000/  ，按 1 / 2 切换桌面级 / 移动端档
node tools/budget.mjs          # 面数与绕序自检
```

---

## 一、逐物体配方

### 1. 围棋盘 `makeGoBoard`

- 结构：顶面（同心矩形环带，`topRings` 圈，可为 0 就是纯平）→ 45° 倒角（`bevelSegs` 段）→ 竖直侧壁 → 底面。
- **顶面只放 2 圈**：木纹和 19 路网格都在片元里算，平面不需要细分。只有想要"盘面极轻微凹陷"（`sag`）这种顶点级形变才需要加圈数。
- **法线：解析**。顶面 `(0,1,0)`；倒角法线 = `normalize(outward·bevelH + up·bevelRun)`（`bevelH=bevelRun` 即 45°）；侧壁取水平外法线。
- **硬边靠复制顶点**：顶面边界和倒角第一行同位置、不同法线；倒角最后一行和侧壁顶端同理。这是"解析法线 + 硬边"的正确姿势，不是"平均法线再想办法找回棱角"。
- `groups` 把索引切成 `woodTop` / `woodEdge` 两段 → 喂给顶点材质表时顶面走"带网格线"的材质、侧面走"纯木纹"，一次 draw call 里就分开了。

### 2. 围棋子 `makeStone`

- 剖面两种：
  - `rimHeight = 0`：椭球剖面 `r=R·sinφ, y=(h/2)·cosφ`，C∞ 连续，边缘绝无折角，法线有严格解析式
    `n = normalize(x/R², y/(h/2)², z/R²)`。
  - `rimHeight > 0`：球冠 + 微圆柱腰（更像真碁石的腰线）。腰线折角 ≈90°，靠 `creaseAngleDeg` 判定：小于阈值 → 复制顶点保持硬边；调到 90 以上 → 自动平均成圆滑过渡。
- 实测校验：`R=11, h=6.6` 椭球解析体积 1672.6，网格实测 1639.4（差 1.0%，来自 6 段球冠的多边形内接）→ 轮廓和绕序都对。

### 3. 毛笔 `makeBrush`

- 笔杆：二次贝塞尔脊线（弓形 `bow`）+ 半径线性收细（`waist` 收腰）。
- 笔头：半径 `r(s) = rBase·(1-s)^0.72 · (1 + 0.10·sin(π·1.25s))`，脊线再侧向勾 `hook·s^1.7` 做出"回锋"。
- **法线：解析**——扫掠管在半径变化处的法线是 `normalize(e - r'(s)·t)`（`e` 为环向径向、`t` 为脊线切向）。收细段的法线自动向外倾，不需要顶点平均，也不会出现"管壁一圈硬折"。
- 端盖**单独复制一圈顶点**、法线取盖面自身（平面盖 = `±t`，锥尖盖 = `normalize(0.85·e + sign·t)`）。侧壁收细处的法线带轴向分量，如果端盖复用它，盖子法线会被带偏、硬边也糊掉。
- 挂绳：一小段圆环螺线扫掠，两端各多绕 4% 遮住平行移动标架的 holonomy 接缝。

### 4. 砚台 `makeInkSlab`

- 轮廓：**按角度射线解析求交**得到圆角矩形极坐标网格——比"矩形网格往圆角上硬夹"干净，角上不会拉伸。
- 高度场 `slabHeight(x,z)`：墨池凹陷（第二层圆角矩形做 `rho`）+ 池沿微隆 + 边缘噪声磨损 + 极外圈微倒角。
- **法线：解析（差一个 ε）**——中心差分 `n = normalize(-∂y/∂x, 1, -∂y/∂z)`。高度场是解析函数，差分只是数值化，结果处处连续、没有接缝。
- 侧壁竖直、取水平外法线（SDF 梯度：直边精确、角上取径向），与顶面是硬边。

### 5. 宣纸 `makePaper` / `makePaperRoll`

- 薄片：单层曲面，高度场 = 低频 fBm 起伏 + 四边卷曲 + 整体塌陷；法线同样是高度场中心差分。半透明 → 关背面剔除 + 片元里 `gl_FrontFacing` 翻法线。
- 纸卷：阿基米德螺线 `r(φ) = innerR + gap·φ/2π`，法线在 `(t,u)` 参数域取数值切向再叉乘。曲率连续，无折角。
- 纸要薄、要少顶点：桌面级 64×48 = 6144 三角已经远超视觉需要，移动端 16×12 = 384 就够——观感来自"边缘卷曲 + 透光"，不是表面细节。

### 6. 太湖石 `makeScholarRock`

- `icosphere(subdiv)`（焊接顶点）→ 归一化 → 半径乘 `1 + amp·((1-ridgedAmt)·fBm + ridgedAmt·ridged)`（ridged 给"皱"，比纯 fBm 更像风化岩）→ 底部拍平。
- **掏洞**：另取一个频率的噪声当"掏空场"对每个面的重心求值，取分位数当阈值删面，`holes=0.32` 就表示删掉约 32% 的面（参数含义明确，不是拍脑袋的常数）。
- **删完必须去碎块**：`keepLargestComponent()` 按共享边 BFS 只留最大连通分量，否则会出现漂浮碎片（孔洞附近很容易出）。
- **法线：面积加权顶点平均**（位移 + 删面后没有解析法线可用）；想要低多边形块面感就 `flat: true` → 非索引 + 面法线。
- 删面后是有洞的开放曲面 → **必须双面**，单列一趟 draw call（关剔除），不能塞进关闭剔除就全浪费的不透明合并批里。

---

## 二、参数与三角面数预算（实测，`node tools/budget.mjs`）

### 桌面级（`TIERS.desktop`）

| 物体 | 关键分段 | verts | tris | 数量 | 小计 |
| --- | --- | --- | --- | --- | --- |
| 桌面 | 12×10 | 143 | 240 | ×1 | 240 |
| 围棋盘 | 每边 24 段环、倒角 3 段、顶面 2 圈 | 674 | 1,152 | ×1 | 1,152 |
| 单颗棋子 | 径向 64、单侧球冠 6、腰 0.9mm | 1,692 | 1,664 | ×16 | 26,624 |
| 笔杆 | 28 段 × 20 径向 | 653 | 1,160 | ×1 | 1,160 |
| 笔斗 | 4 × 20 | 149 | 200 | ×1 | 200 |
| 笔头 | 24 × 20 | 569 | 1,000 | ×1 | 1,000 |
| 挂绳 | 56 × 8 | 513 | 896 | ×1 | 896 |
| 砚台 | 24 圈 × 72 径向 | 1,874 | 3,600 | ×1 | 3,600 |
| 宣纸 | 64×48 | 3,185 | 6,144 | ×1 | 6,144 |
| 宣纸卷 | 220×12 | 2,873 | 5,280 | ×1 | 5,280 |
| 太湖石 | subdiv 4 → 掏洞 30% → flat | 10,644 | 3,548 | ×1 | 3,548 |
| **合计** | | | | | **49,844** |

不透明合并后 **34,872 三角 / 31,647 顶点**（含桌面与 16 颗棋子）；半透明（纸 + 卷）11,424 三角。
**draw call = 3**（1 不透明剔除 + 1 双面太湖石 + 1 半透明纸）。

### 移动端（`TIERS.mobile`）

| 物体 | 关键分段 | verts | tris | 数量 | 小计 |
| --- | --- | --- | --- | --- | --- |
| 桌面 | 12×10 | 143 | 240 | ×1 | 240 |
| 围棋盘 | 每边 8 段、倒角 2 段、顶面 1 圈 | 162 | 256 | ×1 | 256 |
| 单颗棋子 | 径向 24、球冠 4 | 452 | 432 | ×10 | 4,320 |
| 笔（杆/斗/头/绳） | 12×10 / 2×10 / 10×10 / 24×5 | 519 | 780 | ×1 | 780 |
| 砚台 | 8 圈 × 24 径向 | 242 | 432 | ×1 | 432 |
| 宣纸 | 16×12 | 221 | 384 | ×1 | 384 |
| 宣纸卷 | 48×4 | 245 | 384 | ×1 | 384 |
| 太湖石 | subdiv 2 → 掏洞 28% → flat | 684 | 228 | ×1 | 228 |
| **合计** | | | | | **7,024** |

不透明 6,028 三角 / 5,586 顶点，半透明 768 三角，同样 **3 次 draw call**。

> 结论：两档都在极低预算内（桌面 5 万三角对任何独显都是噪声，移动 7 千三角在中端机上纯粹是填充率受限）。
> **真正的瓶颈不是三角数，是"棋盘网格线的片元 ALU"和"半透明纸的填充率"**——降级要优先砍这两项（见第六节）。

---

## 三、绕序与背面剔除

WebGL 默认 `frontFace = CCW`、`cullFace(BACK)`。本工程的生成器全部按"外法线朝外 = CCW"写，并用两道自检兜底（`src/geom/util.js`）：

1. **逐面绕序对齐** `alignWindingToNormals()`：比较几何面法线与三个顶点法线之和，点积 < 0 就翻转该三角。对开放曲面也成立，能精确定位是哪几个面写反了。所有生成器都以 `windingFlips` 报出修正数量——**现在全部为 0**（开发过程中它抓出了 4 处真 bug：车削极点扇形、扫掠侧壁、扫掠端盖法线、砚台顶环/侧壁/底面）。
2. **有向体积** `signedVolume()`：闭合网格若为负说明整体方向反了，`orientOutward()` 会整体反转。

| 物体 | 双面？ | 说明 |
| --- | --- | --- |
| 围棋盘 | ❌ 可剔除 | 闭合体，剔除省 30~50% 片元 |
| 围棋子 | ❌ 可剔除 | 闭合车削体 |
| 毛笔杆/斗/头 | ❌ 可剔除 | 闭合扫掠体（端盖已封） |
| 毛笔挂绳 | ⚠️ 可剔除 | 两端开口，但开口闷在笔杆里看不见 |
| 砚台 | ❌ 可剔除 | 闭合体 |
| 宣纸 / 纸卷 | ✅ 双面 | 单层薄面，无厚度 |
| 太湖石 | ✅ 双面 | 掏洞后是有洞的开放曲面（或用"偏移内壳 + 缝合洞沿"做成闭合体换剔除） |

**"哪些双面"直接决定 draw call 结构**：把双面物体单独分趟，其余合批并开剔除，才能既有 1 次合批又不多花片元。本工程就是 3 趟。

---

## 四、工程问题

### 问题 1：一个场景画多种材质，原始 WebGL2 怎么组织？

| 方案 | program 数 | draw call | 优点 | 缺点 |
| --- | --- | --- | --- | --- |
| A 多 program（一材质一 program） | N | N | 无分支、寄存器压力最小、易单独优化 | N 个 program 要编译/切换；uniform 管道重复代码多；N 个着色器源码变体要维护 |
| B 单 uber program + uniform 分支 | 1 | N | 一个 program、一处逻辑 | 所有材质特征挤在一个 FS 里，寄存器分配按最坏情况给；分支是 uniform 的所以不慢，但代码会膨胀 |
| C 单 program + 材质表（UBO/TexelBuffer）+ 每顶点 materialId | 1 | **1~3** | 静态物体可整场合批；材质是数据不是代码，加材质不改着色器 | 顶点要带材质号；分组边界处顶点会复制（顶点数 +5~15%）；动态增删物体要重烘焙 |
| D C + 实例化（同网格多实例） | 1 | 2（黑白子各一趟） | 361 颗子也只 2 趟 | 需要 per-instance 变换与逆转置法线 |

**推荐 C（本工程实现），棋子多时叠加 D。** 实际结构：

- 顶点属性：`aPos(vec3) / aNormal(vec3) / aUV(vec2) / aMatId(uint8)`；
  整数属性必须用 `gl.vertexAttribIPointer(3, 1, gl.UNSIGNED_BYTE, 0, 0)`，用 `vertexAttribPointer` 会被当成 float 读（[MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebGL2RenderingContext/vertexAttribIPointer)）。
- 材质表：**宽 = 材质数、高 2 的 RGBA32F 贴图**（第 0 行 rgb=baseColor/a=roughness，第 1 行 features/spec/F0/extra），片元里 `texelFetch(uMatTable, ivec2(int(vMatId), 0..1), 0)` 取。贴图不可过滤，`TEXTURE_MIN_FILTER` 必须显式设 `NEAREST`（默认是 `NEAREST_MIPMAP_LINEAR`，没有 mipmap 就整张不完整、`texelFetch` 全读成黑）。
- `flat out uint vMatId` → `texelFetch(...)`，整数 varying 必须 `flat`。
- 合批函数 `mergeGeometries()` 按材质分组重映射索引：同一顶点属于两种材质时复制成两份，这是换 1 次 draw call 的正常代价。

**代价与实测**：10 万三角级、几十个物体时，合批的 CPU 开销只在启动时付一次；每帧 3 次 `drawElements` vs 26 次，省的是 JS→GL 的调用与状态校验（对移动端尤其明显）。

### 问题 2：棋盘 19 路网格线怎么画最划算？

| 方案 | 每帧成本 | 抗锯齿 | 缩放/距离 | 备注 |
| --- | --- | --- | --- | --- |
| 几何细线（thin quad） | 94 三角 + 1 趟 draw（或合批） | 只能靠 MSAA | 固定宽度，远了闪光 | WebGL 的 `lineWidth > 1` 基本不被实现，只能用薄四边形；见 `makeBoardGridLines()`，实测 47 个 quad / 94 三角 |
| 程序化贴图 | 1 次采样 | mipmap + 各向异性最好 | 受纹理分辨率限制（2K 贴图下一格约 100px） | 需要额外显存；缩放到很近会糊 |
| **片元里 `fract` + `fwidth`** | 每个像素几十条 ALU，零显存 | 解析抗锯齿，免 MSAA | 线宽按像素恒定，远处 `fwidth` 变大 → 自然变淡，不会摩尔纹炸裂 | **推荐** |

推荐做法（`src/material.js` 完整实现）：

```glsl
// uv 在 [0,1] 上正好覆盖 19×19 交叉点区域 → 格坐标 g = uv*18，整数处就是棋线
float gridMask(vec2 g, vec2 px, float widthPx) {
  vec2 d = abs(fract(g - 0.5) - 0.5) / px;          // 到最近整数线的距离（像素）
  return 1.0 - smoothstep(widthPx - 0.5, widthPx + 0.5, min(d.x, d.y));
}
// 边线在 g=0 与 g=18 上，会被 UV 边界裁掉一半 → 单独按到 uv 边界的距离画，只画内侧
float borderMask(vec2 uv, vec2 px, float widthPx) {
  float d = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)) * 18.0;
  return 1.0 - smoothstep(widthPx - 0.5, widthPx + 0.5, d / max(px.x, 1e-5));
}
// 9 个星位在 (3,3)(3,9)(3,15)...(15,15)
float starMask(vec2 g, vec2 px, float radiusPx) {
  float m = 1e9;
  for (int i = 0; i < 3; i++)
    for (int j = 0; j < 3; j++) {
      vec2 s = vec2(3.0 + float(i) * 6.0, 3.0 + float(j) * 6.0);
      m = min(m, length((g - s) / px));
    }
  return 1.0 - smoothstep(radiusPx - 0.5, radiusPx + 0.5, m);
}
```

三个必须注意的点：

1. **求导不能放在不一致的控制流里**。`fwidth` 是 2×2 像素块的差分；`matId` 是 `flat varying`，同一像素块可能横跨两种材质，若把 `fwidth` 写在 `if (材质有网格线)` 里面结果就是未定义的。所以先无条件算：
   ```glsl
   vec2 gUV = vUV * 18.0;
   vec2 gPx = max(fwidth(gUV), vec2(1e-5));   // 每格对应多少像素
   ```
   再进分支。每像素多两条指令，换"一定正确"。
2. **掠射角/远处要主动淡出**：`fade = (1 - smoothstep(near, far, vViewDist)) * mix(0.55, 1.0, pow(NoV, 0.35))`。
3. 想要"墨渗进木头"的近距离质感，可以在这个 shader 之上叠一层几何线做 A/B（本工程留了 `makeBoardGridLines()` 就是干这个的）。

### 问题 3：双凸透镜棋子怎么用少量三角形做平滑

**用车削（lathe）**，不要让球体非均匀缩放后硬修法线。剖面：

```js
// 椭球双凸（默认 rimHeight=0）：C∞ 连续，边缘零折角
for (let i = 0; i <= capSegs * 2; i++) {
  const phi = Math.PI * (i / (capSegs * 2));
  prof.push([R * Math.sin(phi), -(H / 2) * Math.cos(phi)]);   // [r, y]，下极点 → 上极点
}
```

要点：

1. **剖面点少而精**：单侧球冠 4~6 段就够（曲率变化小的地方不给点）。三角数的主项是圆周分段：桌面 64、移动 24~32，棋子立起来只有 22mm 直径，轮廓多边形根本看不出来。
2. **法线必须解析**：剖面每段的 2D 切向 `(dr, dy)` → 外法线 `(dy, -dr)` 归一化（竖直外壁 `t=(0,1)` → `n=(1,0)` 朝外 ✓；下球冠 `t=(R,H)` → `n=(H,-R)` 朝外下 ✓）。再绕 Y 轴旋到 3D。**不要用面法线平均**——平均会把腰线折角抹成一个模糊的环。
3. **腰线不能有硬折角**的做法：`creaseAngleDeg` 判定相邻剖面段法线夹角，小于阈值就按段长加权平均成一根法线（视觉上完全光滑）；想保留真碁石的腰线就把腰段做成"球冠 + 短圆柱 + 球冠"，夹角约 90° > 阈值 → 自动复制顶点保持锐利。两条路同一个函数，只改一个参数。
4. **极点法线**：`r=0` 的端点必须取轴向 `(0,±1,0)`（光滑球冠在极点处切线水平，法线必然与轴平行）。取分段弦法线会让极点出现一圈奇怪的暗环——这是车削最常见的 bug。
5. **非均匀缩放的正确姿势**：如果坚持用"单位透镜 + per-instance 缩放（R, h/2, R）"，法线要按逆转置 `n' = normalize(n / s)` 变换，否则光照会歪。本工程的 `bakeTransform()` 就是这么做的，但默认路径还是直接生成正确尺寸的车削体，最省事。

### 问题 4：没有 HDRI / cubemap，黑子怎么"黑而不死"？

三层叠加（`fakeEnv()` + FS 里的反射段）：

```glsl
vec3 fakeEnv(vec3 R) {
  float t = clamp(R.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 env = mix(uGroundColor, uSkyHorizon, smoothstep(0.0, 0.52, t));   // 天空梯度
  env = mix(env, uSkyZenith, smoothstep(0.46, 1.0, t));
  // 一条"窗光"窄亮带：镜面里必须有可读的结构，否则黑子只是一坨渐变
  float win = pow(clamp(dot(normalize(R), normalize(vec3(0.32, 0.62, -0.72))), 0.0, 1.0), 26.0);
  env += vec3(1.0, 0.965, 0.90) * win * 0.75;
  env += uGroundColor * 0.35 * smoothstep(0.15, -0.5, R.y);             // 桌面暖色二次反弹
  return env;
}
// ... 在 main() 里：
vec3 R = reflect(-V, N);
float F = fresnelSchlick(NoV, F0);
color += albedo * uSkyHorizon * 0.9;                 // 极小环境漫反射垫底（≈0.012，别让它是 0）
color += fakeEnv(R) * uEnvStrength * mix(F, F * 1.9, 0.5) * 2.2;        // 菲涅尔主导
color += uSkyHorizon * pow(1.0 - NoV, 4.0) * 0.10;   // 掠射角那圈亮边
```

- **基底不要用纯黑**：`albedo = (0.020, 0.022, 0.027)`（略偏蓝的极暗），再叠一点点环境漫反射。黑色的读感来自"正面几乎全黑、边缘一圈亮"，也就是菲涅尔，不是来自把 albedo 抬成灰。
- **反射向量用 `reflect(-V,N)` 而不是 `N`**：抛光石头是镜面反射，用 N 当查询方向会让整颗子看起来像哑光。
- **粗糙度要低**（0.16 左右）+ 微法线抖动（fBm 扰动 ±18%），完美镜面反而"数码"。
- **一束方向光高光**：`pow(NoH, specExp)` 的窄高光负责"黑曜石的通透点"，宽高光交给假环境。
- 白子走另一套：albedo 0.855、粗糙度 0.34、`wrap lighting`（`clamp((N·L+0.55)/1.55)`）把明暗交界线推开 = 贝壳/蛤贝的次表面感；黑子那套镜面照搬过来会像塑料。

### 问题 5：鼠标拖动旋转静物台

`src/orbit-camera.js` 的完整实现，要点：

1. **球面轨道**：`eye = target + d·(sinφ·sinθ, cosφ, sinφ·cosθ)`，`φ` 夹在 `[0.12, π/2 - 0.02]`——不夹住会翻到桌面下方或穿过极点（极点附近方位角会疯狂旋转）。
2. **阻尼与帧率无关**：角度/距离/焦点各存"目标值 + 当前值"，每帧
   ```js
   const k = 1 - Math.exp(-damping * Math.min(dt, 0.1));
   theta += (thetaGoal - theta) * k;
   ```
   不要写 `x += (t - x) * 0.1`——那样在 120Hz 和 30Hz 上手感完全不同。
3. **指针用 Pointer Events + `setPointerCapture`**：鼠标/触屏/触控笔一套代码；`pointerup` / `pointercancel` / `lostpointercapture` 都要收尾，否则松手后还会跟着转。双指用两个 pointer 的距离做 pinch zoom。
4. **滚轮不滚动页面**：监听必须显式声明非 passive，否则浏览器默认 `passive: true`，`preventDefault()` 无效还会在控制台报错：
   ```js
   el.addEventListener('wheel', onWheel, { passive: false });
   function onWheel(e) { e.preventDefault(); distanceGoal *= Math.exp(e.deltaY * zoomSpeed); }
   ```
5. **触屏**：canvas 上 `touch-action: none`（+ 页面 `overscroll-behavior: none`），否则拖动会同时滚动/下拉刷新。代码里 `el.style.touchAction = 'none'` 已设。
6. 右键/Shift 拖动做平移，并 `contextmenu` 里 `preventDefault`。

### 问题 6：手机上的降级策略

按"先砍片元、再砍顶点"的顺序：

1. **分辨率**：DPR 夹到 1.5（桌面 2），必要时按 0.75 缩放渲染。静物场景是**填充率受限**，这一步收益最大。
2. **网格线 shader**：降 `uGrainOctaves`（5 → 3）、`uBoardFadeFar` 提前淡出、`uEnvStrength` 降 0.8。木纹 fBm 是每像素最贵的部分。
3. **半透明纸**：移动端把纸的不透明度提到 0.92 → 可以改用 alpha test（`discard`）而不开混合，省一次排序 + 混合带宽；或干脆把纸藏起来（静物构图里它是可牺牲项，11,424 → 768 三角）。注意 alpha test 会关掉 early-Z 的部分收益，要实测。
4. **顶点**：`TIERS.mobile` 一把降到 7,024 三角（棋子径向 64→24、砚台 24 圈→8 圈、太湖石 subdiv 4→2）。棋子数量 14→8，并且**改实例化**（黑白各一趟）后 361 颗子也只是 2 次 draw call。
5. **不需要的功能直接关**：MSAA（`antialias: false`，网格线本来就有解析抗锯齿）、阴影、法线微扰。
6. **别做的事**：不要为了"看起来更流畅"把所有物体拆成多次 draw call——移动端 draw call 的状态校验开销比桌面更敏感；本工程 3 趟已经很少。

---

## 五、已实测 / 待实测

1. **GLSL 编译**：已实测。`probe-desk.cjs` 用 Chromium（ANGLE）跑通：着色器编译/链接无错、`glError` 0、控制台无报错、三角数 49,944 / 顶点 31,827 / draw call 3 / 材质 17，截图见 `personal-space/qa/desk-canvas.jpg`。
2. **材质表读取**：已从 `matA[vMatId]` 改成 `sampler2D` + `texelFetch`。**注意当初的绿色不是 UBO 动态索引的锅，是打包顺序与 std140 不一致**：JS 按"每材质 8 个 float 交错"打包，而 `layout(std140) uniform MatTable { vec4 matA[N]; vec4 matB[N]; }` 是两个数组前后两块。于是 `matA[i]` 只在偶数 `i` 上凑巧读对；奇数 `i` 读到**上一个材质**的 `features/spec/f0` —— 砚台 id7 读到 m3 的 `(0, 0.55, 0.03)`、太湖石 id11 读到 m5 的 `(0, 0.35, 0.045)`，渲成两块刺眼的纯绿。写材质表时**务必同时对照 CPU 打包顺序与 GLSL 声明的布局**，光把 buffer 读回来核对数据是查不出来的（buffer 里确实是对的，错在着色器按哪个偏移去读）。现在贴图那条路没有对齐规则可踩；UBO 那 512 字节仍在（`buildMaterialUBOData()`，逐材质交错），是 `probe-desk.cjs` 读回核对表的常驻探针。
3. **颜色/亮度**：假环境反射的系数（`2.2`、`0.10`、`uSkyHorizon` 取值）是按 sRGB 输出 + `color/(color+0.85)` 色调映射调的，换光照环境要重调。
4. **性能数字**：三角/顶点数是实测的（`tools/budget.mjs`），但**帧时间未实测**——需要真机 profile。移动端瓶颈大概率在棋盘的片元 ALU 和纸的混合填充率。
5. 砚台"磨损"、太湖石"孔洞"的观感参数（`wear=1.1`、`holes=0.30`）是示意值，需要按美术意图调。

## 六、查阅的 URL

- WebGL 2.0 规范：<https://registry.khronos.org/webgl/specs/latest/2.0/>
- GLSL ES 3.00 规范（`fwidth`、`flat`、整数属性语义）：<https://registry.khronos.org/OpenGL/specs/es/3.0/GLSL_ES_Specification_3.00.pdf>
- `vertexAttribIPointer`（整数顶点属性必须用 I 版本）：<https://developer.mozilla.org/en-US/docs/Web/API/WebGL2RenderingContext/vertexAttribIPointer>
- UBO / std140 内存布局（数组对齐、struct padding 陷阱）：<https://docs.cocos.com/creator/3.7/manual/zh/shader/ubo-layout>
- 用 GLSL 在平面上画平滑参考网格（`fract` + `fwidth` 抗锯齿网格的经典讨论）：<https://stackoverflow.com/questions/31301875/using-glsl-to-render-a-smooth-reference-grid-on-a-plane>
- ShaderStory · Grid 章节（网格图案的另一种写法）：<https://github.com/DeGGeD/ShaderStory/blob/main/Chapters/Patterns/Grid.md>
- Inigo Quilez · 2D SDF（圆角矩形、`opRound`，砚台轮廓与"磨损=减去常数"的推导）：<https://iquilezles.org/articles/distfunctions2d/>
- Inigo Quilez · smin（把两个形体糊在一起，本工程 `smin` 的出处）：<https://iquilezles.org/articles/smin/>
- OrbitControls 的阻尼实现讨论：<https://stackoverflow.com/questions/32060327/orbitcontrols-with-damping>
- gl-matrix（列主序 mat4 的实现参考，本工程 `perspective`/`lookAt` 与之同构）：<https://github.com/toji/gl-matrix>
- Pointer Events：<https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events>
- CSS `touch-action`：<https://developer.mozilla.org/en-US/docs/Web/CSS/touch-action>