// scene.js — 静物摆场：把 6 个物体按"桌面级 / 移动端"两档参数生成并烘焙成一个 VBO
// 输出：{ opaque: {positions,normals,uvs,matIds,indices}, transparent: [...], stats }
// 关键：所有静态物体都烤进世界空间 → 不透明部分只需要 1 次 drawElements。

import { MeshBuilder, bakeTransform, mergeGeometries, geoStats, computeBounds, alignWindingToNormals, TAU, fbm3 } from './geom/util.js';
import { makeGoBoard, boardIntersections } from './geom/board.js';
import { makeStone, stoneJitter } from './geom/stones.js';
import { makeBrush } from './geom/brush.js';
import { makeInkSlab } from './geom/inkslab.js';
import { makePaper, makePaperRoll } from './geom/paper.js';
import { makeScholarRock } from './geom/rock.js';
import { KIFU, kifuStones } from './geom/kifu.js';
import { MATERIAL_INDEX } from './material.js';

/* =====================================================================
 * 分段数预算：两档。改这里就能整体降级，不要散落在各处。
 * 单位：mm
 * ===================================================================== */
export const TIERS = {
  desktop: {
    label: '桌面级',
    board: { size: 460, thickness: 38, bevel: 5, bevelSegs: 3, ringSegsPerSide: 24, topRings: 2, sag: 0.35 },
    stone: { radius: 11, thickness: 6.6, radialSegs: 64, capSegs: 6, rimHeight: 0.9 },
    brush: { handleLen: 210, handleSegs: 28, handleRadial: 20, headSegs: 24, headRadial: 20, hook: 7, ferruleRadial: 20, ferruleSegs: 4, cordSegs: 56, cordRadial: 8 },
    cord: { segs: 56, radialSegs: 8 },
    slab: { rings: 24, radialSegs: 72 },
    paper: { segX: 64, segZ: 48 },
    roll: { lengthSegs: 220, widthSegs: 12 },
    rock: { subdiv: 4, flat: true, holes: 0.30 },
  },
  mobile: {
    label: '移动端',
    board: { size: 460, thickness: 38, bevel: 5, bevelSegs: 2, ringSegsPerSide: 8, topRings: 1, sag: 0.35 },
    stone: { radius: 11, thickness: 6.6, radialSegs: 24, capSegs: 4, rimHeight: 0.9 },
    brush: { handleLen: 210, handleSegs: 12, handleRadial: 10, headSegs: 10, headRadial: 10, hook: 7, ferruleRadial: 10, ferruleSegs: 2, cordSegs: 24, cordRadial: 5 },
    cord: { segs: 24, radialSegs: 5 },
    slab: { rings: 8, radialSegs: 24 },
    paper: { segX: 16, segZ: 12 },
    roll: { lengthSegs: 48, widthSegs: 4 },
    rock: { subdiv: 2, flat: true, holes: 0.28 },
  },
};

/** 桌面：一块微微起伏的大木板 + 落到地面的侧裙，避免"镜面平板"的假 */
export function makeDesk({ w = 1700, h = 1300, segX = 12, segZ = 10, thickness = 26, floorY = -2 } = {}) {
  const b = new MeshBuilder();
  b.group('desk');
  const rows = [];
  for (let i = 0; i <= segX; i++) {
    const row = [];
    for (let j = 0; j <= segZ; j++) {
      const x = -w / 2 + w * (i / segX), z = -h / 2 + h * (j / segZ);
      const y = thickness - 0.6 * (fbm3(x * 0.004, 0.3, z * 0.004, { octaves: 2 }) * 0.5 + 0.5);
      row.push(b.vert(x, y, z, 0, 1, 0, (x + w / 2) / w, (z + h / 2) / h));
    }
    rows.push(row);
  }
  for (let i = 0; i < segX; i++) for (let j = 0; j < segZ; j++) {
    b.quad(rows[i][j], rows[i + 1][j], rows[i + 1][j + 1], rows[i][j + 1]);
  }
  /* 侧裙：原来这张桌子**只有顶面**（零厚度的一张纸），而且顶面绕序反了 —— 从上方看整块桌面
     都被背面剔除掉，于是"物体全浮在黑底上"。现在沿顶面边界垂一圈裙板落到地面，
     桌面才是一块实心台面；绕序交给 alignWindingToNormals 逐面兜底（它的做法同 paper.js）。 */
  const loop = [];
  for (let i = 0; i <= segX; i++) loop.push(rows[i][0]);
  for (let j = 1; j <= segZ; j++) loop.push(rows[segX][j]);
  for (let i = segX - 1; i >= 0; i--) loop.push(rows[i][segZ]);
  for (let j = segZ - 1; j >= 1; j--) loop.push(rows[0][j]);
  const outward = (x, z) => { const l = Math.hypot(x, z) || 1; return [x / l, 0, z / l]; };
  let u = 0;
  for (let k = 0; k < loop.length; k++) {
    const a = b.posAt(loop[k]), c = b.posAt(loop[(k + 1) % loop.length]);
    const seg = Math.hypot(c[0] - a[0], c[2] - a[2]);
    const n = outward((a[0] + c[0]) / 2, (a[2] + c[2]) / 2);
    const u1 = (u + seg) / 200;
    const ta = b.vert(a[0], a[1], a[2], n[0], n[1], n[2], u, 1);
    const tc = b.vert(c[0], c[1], c[2], n[0], n[1], n[2], u1, 1);
    const bc = b.vert(c[0], floorY, c[2], n[0], n[1], n[2], u1, 0);
    const ba = b.vert(a[0], floorY, a[2], n[0], n[1], n[2], u, 0);
    b.quad(ta, tc, bc, ba);
    u += seg;
  }
  const geo = b.build();
  geo.meta = { openSurface: true, doubleSided: false, deskTop: thickness, windingFlips: alignWindingToNormals(geo) };
  return geo;
}

/** 影棚地面：一张远大于桌面的大平面（background 环境色靠材质表的 bit6 远处化进雾里） */
export function makeFloor({ size = 12000, y = 0 } = {}) {
  const b = new MeshBuilder();
  b.group('floor');
  const r = size / 2;
  const v0 = b.vert(-r, y, -r, 0, 1, 0, 0, 0);
  const v1 = b.vert(r, y, -r, 0, 1, 0, 1, 0);
  const v2 = b.vert(r, y, r, 0, 1, 0, 1, 1);
  const v3 = b.vert(-r, y, r, 0, 1, 0, 0, 1);
  b.quad(v0, v1, v2, v3);
  const geo = b.build();
  geo.meta = { openSurface: true, doubleSided: false, windingFlips: alignWindingToNormals(geo) };
  return geo;
}

/**
 * 接触阴影贴片：朝上的一片四角贴片，UV 铺满 [0,1]，片元里按超椭圆距离算软边 alpha（bit7）。
 * 贴在"物体压在支撑面上"的位置，补没有 shadow map 时最缺的那一口气：接触感。
 * 尺寸比物体footprint 略大一圈就是半影；旋转跟物体一致即可。
 */
export function makeContactPatch({ w = 300, h = 300, y = 0, rotateY = 0 } = {}) {
  const b = new MeshBuilder();
  b.group('contact');
  const cy = Math.cos(rotateY), sy = Math.sin(rotateY);
  const hw = w / 2, hh = h / 2;
  const v = (x, z, u, vv) => {
    const px = x * cy + z * sy, pz = -x * sy + z * cy;
    return b.vert(px, y, pz, 0, 1, 0, u, vv);
  };
  const a = v(-hw, -hh, 0, 0), c = v(hw, -hh, 1, 0), d = v(hw, hh, 1, 1), e = v(-hw, hh, 0, 1);
  b.quad(a, c, d, e);
  const geo = b.build();
  geo.meta = { openSurface: true, decal: true };
  return geo;
}

/* 棋谱局面见 src/geom/kifu.js：当湖十局·第一局（1739，范西屏对施襄夏），摆到第 60 手。
   这里原来是一个写死的 MOVES 数组（14 手随手摆的，不属于任何真实棋谱），已删除。 */

/** 多个几何体的世界包围盒并集（机位取景用） */
export function unionBounds(geos) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const g of geos) {
    const b = computeBounds(g.positions);
    for (let k = 0; k < 3; k++) {
      if (b.min[k] < min[k]) min[k] = b.min[k];
      if (b.max[k] > max[k]) max[k] = b.max[k];
    }
  }
  return { min, max, center: min.map((v, k) => (v + max[k]) / 2), size: min.map((v, k) => max[k] - v) };
}

export function buildScene(tierName = 'desktop') {
  const T = TIERS[tierName] || TIERS.desktop;
  const items = [];       // 不透明部分
  const transparent = []; // 半透明部分（纸、纸卷、接触阴影贴片）

  const deskTop = 26;
  const floorY = 0;
  const onDesk = deskTop + 0.45;   // 贴片贴在桌面上方一点（桌面本身还有 0.6mm 起伏）

  // ---------- 桌面（含落到地面的侧裙）----------
  items.push({ geo: makeDesk({ thickness: deskTop, floorY: floorY - 2 }), material: 'desk' });

  // ---------- 地面 ----------
  items.push({ geo: makeFloor({ size: 12000, y: floorY }), material: 'floor' });

  // ---------- 围棋盘 ----------
  const board = makeGoBoard(T.board);
  const boardTopY = deskTop + T.board.thickness;
  items.push({ geo: bakeTransform(board, { translate: [0, deskTop, 0] }), material: 'woodTop' });

  // ---------- 围棋子（棋谱局面）----------
  // 位置由 src/geom/kifu.js 重放棋谱得出：四颗座子 + 第 1..60 手终了的局面，共 64 子。
  const inter = boardIntersections(T.board);
  const stoneGeo = makeStone({ ...T.stone });
  const placed = [];
  const onBoard = kifuStones(KIFU);      // 默认摆到 KIFU.placedUpTo（=60）手
  for (const st of onBoard) {
    const [p, q] = inter.points[st.iz * 19 + st.ix];
    // 抖动按交叉点取种（不是按数组序号）：换手数、换档位都不会让同一颗子跳位置
    const [jx, jz, yaw] = stoneJitter((st.iz * 19 + st.ix) * 1.37 + (st.color === 'black' ? 0 : 50), 1.1);
    const y = boardTopY + T.stone.thickness / 2 - 0.12; // 微微压进盘面，别浮着
    placed.push({
      geo: bakeTransform(stoneGeo, { translate: [p + jx, y, q + jz], rotateY: yaw }),
      material: st.color === 'black' ? 'stoneBlack' : 'stoneWhite',
    });
  }
  // 盘外两颗（一颗在纸上、一颗在砚台边）
  // 纸上的那颗要跟着纸一起抬（纸的抬升见下面"宣纸"一节），否则会被纸埋掉半颗
  placed.push({ geo: bakeTransform(stoneGeo, { translate: [-330, deskTop + 5.6, 300], rotateY: 0.7 }), material: 'stoneWhite' });
  placed.push({ geo: bakeTransform(stoneGeo, { translate: [250, deskTop + 3.2, 380], rotateY: 2.1 }), material: 'stoneBlack' });
  items.push(...placed);

  // ---------- 砚台 ----------
  items.push({ geo: bakeTransform(makeInkSlab(T.slab), { translate: [345, deskTop, 205], rotateY: -0.18 }), material: 'inkstone' });

  // ---------- 毛笔（横躺在砚台边，笔头搭在墨池上方）----------
  for (const part of makeBrush(T.brush)) {
    const mat = part.name === 'handle' ? 'bamboo' : part.name === 'head' ? 'bristle' : part.name === 'ferrule' ? 'ferrule' : 'cord';
    const lay = Math.PI / 2 * 0.94;   // 放倒（≈84°）
    items.push({
      geo: bakeTransform(part.geo, {
        translate: [318, deskTop + 9.5, 372],
        rotateX: -lay,
        rotateY: -0.22,
      }),
      material: mat,
    });
  }

  /* ---------- 接触阴影贴片（进半透明那一趟，先画贴片：纸再叠在它上面）----------
     每块都贴在"物体压在支撑面上"的位置，比 footprint 略大一圈就是半影。
     桌面压在地面那条（最后一块）是让桌子"坐进"影棚地台里，不是浮在地面上。 */
  const patch = (w, h, x, z, rot, y = onDesk) => ({
    geo: bakeTransform(makeContactPatch({ w, h, y, rotateY: rot }), { translate: [x, 0, z] }),
    material: 'contact',
  });
  transparent.push(
    // 棋盘：贴片往右挪 170 —— 纸的右上角压在棋盘底下，而纸只有 80% 不透明，
    // 贴片只要是盖在纸下的部分就会"透"上来显成一块脏斑；右移后纸那片区域的 alpha 已经衰减到看不见。
    patch(700, 700, 170, 0, 0),
    patch(330, 290, 345, 205, -0.18),          // 砚台
    patch(360, 340, 430, -330, 0.4),           // 太湖石
    patch(150, 240, 336, 250, -0.22),          // 毛笔（横躺的那一段）
    patch(380, 130, -360, -340, 0),            // 宣纸卷
    patch(2100, 1700, 0, 0, 0, floorY + 0.35), // 桌面 → 地面
  );

  // ---------- 宣纸（半透明，单独一趟）----------
  // 抬高 1.6 而不是 0.3：纸有起伏（局部最低到 -1.3mm），而桌面顶面本身有 0..-0.6 的起伏，
  // 抬 0.3 时纸的凹陷处会掉到桌面**底下**，深度测试一拒就透出桌面 → 纸上一块块深褐色斑。
  transparent.push({
    geo: bakeTransform(makePaper(T.paper), { translate: [-345, deskTop + 1.6, 300], rotateY: 0.12 }),
    material: 'paper',
  });

  // ---------- 宣纸卷（后左）----------
  // 原来 translate 写在原点：纸卷整根埋在棋盘里（卷顶 62.7 < 盘面 64），等于不存在。
  const roll = makePaperRoll(T.roll);
  const rollMeta = { outerR: 16 + 0.9 * 2.6 };
  const rollPlaced = bakeTransform(roll, { translate: [-360, deskTop + rollMeta.outerR, -340], rotateY: Math.PI / 2 });
  transparent.push({ geo: rollPlaced, material: 'paperRoll' });

  // ---------- 太湖石（后右）----------
  // 注意：掏洞后的曲面是"薄壳、有洞"，必须双面渲染 → 单独一趟（关剔除），
  // 不能塞进"关闭剔除就浪费"的不透明合并批里。见 README 的绕序/剔除小节。
  // 底部拍平之后最低点在局部坐标 -79 附近，translate.y 必须按它反推 —— 原来是写死 +6，
  // 石头有 67mm 埋在桌面底下，看着像"穿模"而不是"坐住"。
  const rockGeo = makeScholarRock(T.rock);
  const rockScale = 0.92;
  const rockY = deskTop - computeBounds(rockGeo.positions).min[1] * rockScale;
  const rockPlaced = bakeTransform(rockGeo, { translate: [430, rockY, -330], rotateY: 0.8, scale: rockScale });
  const doubleSided = mergeGeometries([{ geo: rockPlaced, material: 'rock' }], (name) => MATERIAL_INDEX[name] ?? 0);

  // ---------- 合并 ----------
  const opaque = mergeGeometries(items, (name) => MATERIAL_INDEX[name] ?? 0);
  const transparentGeo = mergeGeometries(transparent, (name) => MATERIAL_INDEX[name] ?? 0);

  const stats = {
    tier: tierName,
    opaqueTris: opaque.indices.length / 3,
    opaqueVerts: opaque.positions.length / 3,
    doubleSidedTris: doubleSided.indices.length / 3,
    transparentTris: transparentGeo.indices.length / 3,
    totalTris: opaque.indices.length / 3 + doubleSided.indices.length / 3 + transparentGeo.indices.length / 3,
    drawCalls: 3,   // 1 不透明(剔除) + 1 双面不透明(太湖石) + 1 半透明(纸/贴片)
    parts: items.length + transparent.length,
    /* 盘上摆的是哪一局棋：探针/页面都读这里，不要在别处另写一份 */
    kifu: {
      id: KIFU.id,
      nameZh: KIFU.nameZh,
      year: KIFU.year,
      black: KIFU.black,
      white: KIFU.white,
      placedUpTo: KIFU.placedUpTo,
      crossCheckedThrough: KIFU.crossCheckedThrough,
      stones: onBoard.length,
      license: KIFU.license,
    },
  };

  /* 焦点组包围盒（除桌面与地面、除贴片）：机位按它来算。若按整块桌面算，
     相机会为了塞下 1700mm 的桌子一路后退，静物缩成画面中间一小撮。 */
  const focus = unionBounds([
    ...items.filter((it) => it.material !== 'desk' && it.material !== 'floor').map((it) => it.geo),
    rockPlaced,
    ...transparent.filter((it) => it.material === 'paper' || it.material === 'paperRoll').map((it) => it.geo),
  ]);

  return { opaque, doubleSided, transparent: transparentGeo, stats, focus, bounds: computeBounds(opaque.positions) };
}

/** 逐物体面数（做预算表用，不做合并） */
export function perObjectStats(tierName = 'desktop') {
  const T = TIERS[tierName] || TIERS.desktop;
  const out = {};
  const count = (g) => { const s = geoStats(g); return { verts: s.verts, tris: s.tris }; };
  out.desk = count(makeDesk({ thickness: 26 }));
  out.board = count(makeGoBoard(T.board));
  out.stone = count(makeStone(T.stone));
  for (const p of makeBrush(T.brush)) out[`brush_${p.name}`] = count(p.geo);
  out.inkslab = count(makeInkSlab(T.slab));
  out.paper = count(makePaper(T.paper));
  out.paperRoll = count(makePaperRoll(T.roll));
  out.rock = count(makeScholarRock(T.rock));
  return out;
}