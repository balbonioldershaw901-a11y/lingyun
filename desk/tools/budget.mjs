// tools/budget.mjs — 面数预算实测 + 绕序自检（Node 里跑，不需要 GL）
// 用法：node tools/budget.mjs
import { signedVolume, geoStats, computeBounds, alignWindingToNormals } from '../src/geom/util.js';
import { makeGoBoard, makeBoardGridLines, rectRing, ringOutwardNormals } from '../src/geom/board.js';
import { makeStone, makeUnitLens } from '../src/geom/stones.js';
import { makeBrush, makeBrushHandle, makeBrushHead } from '../src/geom/brush.js';
import { makeInkSlab, roundedRectRayRadius } from '../src/geom/inkslab.js';
import { makePaper, makePaperRoll } from '../src/geom/paper.js';
import { makeScholarRock, icosphere } from '../src/geom/rock.js';
import { buildScene, TIERS, perObjectStats, makeDesk } from '../src/scene.js';
import { KIFU, kifuStones } from '../src/geom/kifu.js';

const fmt = (n) => n.toLocaleString('en-US');
const STONE_TOTAL = kifuStones(KIFU).length + 2;   // 盘上棋谱局面的子 + 盘外那 2 颗

function checkClosed(name, geo) {
  const v = signedVolume(geo.positions, geo.indices);
  const ok = v > 0;
  const flips = geo.meta && geo.meta.windingFlips;
  console.log(`  ${ok ? 'OK ' : 'BAD'} ${name.padEnd(16)} volume=${v.toExponential(3)}  ${ok ? 'CCW 朝外' : '方向反了'}  生成器修正面数=${flips === undefined ? '?' : flips}`);
  return ok;
}

/** 逐面绕序自检：法线是解析给出的，面法线应与之同向（0 = 生成器完全写对） */
function audit(name, geo) {
  const before = alignWindingToNormals(geo);
  const n = geo.indices.length / 3;
  console.log(`  ${before === 0 ? 'OK ' : 'BAD'} ${name.padEnd(16)} 绕序与法线不一致的面 = ${before} / ${n}`);
  return before;
}

function avgNormalY(geo) {
  let s = 0;
  const n = geo.positions.length / 3;
  for (let i = 0; i < n; i++) s += geo.normals[i * 3 + 1];
  return s / n;
}

console.log('=== 1. 基础形状自检 ===');
const board = makeGoBoard({});
console.log('  board', geoStats(board), 'groups=', board.groups.map(g => `${g.material}:${g.count / 3}`).join(', '));
audit('board', board);
const s64 = makeStone({ radialSegs: 64, capSegs: 6, rimHeight: 0.9 });
checkClosed('stone r64', s64);
const s24 = makeStone({ radialSegs: 24, capSegs: 4, rimHeight: 0.9 });
checkClosed('stone r24', s24);
const lens = makeStone({ radius: 11, thickness: 6.6, radialSegs: 48, capSegs: 6, rimHeight: 0 });
checkClosed('lens rim0', lens);
// 椭球解析体积 vs 实测：V = (2/3)·π·R²·h
const analytic = (2 / 3) * Math.PI * 11 * 11 * 6.6;
console.log(`     椭球解析体积=${analytic.toFixed(1)}  实测=${signedVolume(lens.positions, lens.indices).toFixed(1)}  （差 1% 内说明轮廓/绕序都对）`);

const slab = makeInkSlab({});
checkClosed('inkslab', slab);
audit('inkslab', slab);
for (const p of makeBrush({})) {
  const v = signedVolume(p.geo.positions, p.geo.indices);
  console.log(`  brush.${p.name.padEnd(8)} ${JSON.stringify(geoStats(p.geo))} vol=${v.toExponential(2)} 修正面=${p.geo.meta?.windingFlips ?? '?'}`);
}
audit('brush.handle', makeBrushHandle({}));
audit('brush.head', makeBrushHead({}));

const rock = makeScholarRock({ subdiv: 3, flat: true });
console.log('  rock subdiv3 flat:', geoStats(rock), 'meta', rock.meta.stats);
const rock4 = makeScholarRock({ subdiv: 4, flat: true });
console.log('  rock subdiv4 flat:', geoStats(rock4));

const paper = makePaper({});
console.log('  paper avg normal.y =', avgNormalY(paper).toFixed(3), '(应 ≈ +1，说明薄片面朝上)');
audit('paper', makePaper({}));
audit('paperRoll', makePaperRoll({}));
const rollGeo = makePaperRoll({});
let rollNy = 0;
for (let i = 0; i < rollGeo.normals.length; i += 3) rollNy += Math.abs(rollGeo.normals[i + 1]);
console.log('  paperRoll avg |normal.y| =', (rollNy / (rollGeo.normals.length / 3)).toFixed(3), '(卷面法线主要在 xy 平面，应偏小)');

console.log('\n=== 2. 圆角矩形射线求交自检（砚台轮廓）===');
for (const th of [0, Math.PI / 4, Math.PI / 2, Math.PI, -Math.PI / 4]) {
  const r = roundedRectRayRadius(th, 95, 70, 16);
  console.log(`  theta=${(th * 180 / Math.PI).toFixed(0).padStart(4)}°  r=${r.toFixed(2)}  hit=(${(r * Math.cos(th)).toFixed(1)}, ${(r * Math.sin(th)).toFixed(1)})`);
}

console.log('\n=== 3. 逐物体面数（两档）===');
for (const tier of ['desktop', 'mobile']) {
  const s = perObjectStats(tier);
  const T = TIERS[tier];
  console.log(`\n-- ${T.label} (${tier}) --`);
  let sum = 0;
  for (const [k, v] of Object.entries(s)) {
    const count = k === 'stone' ? STONE_TOTAL : 1;  // 盘上棋子数来自棋谱（见 src/geom/kifu.js）+ 盘外 2 颗
    const total = v.tris * count;
    sum += total;
    console.log(`  ${k.padEnd(14)} verts=${fmt(v.verts).padStart(7)} tris=${fmt(v.tris).padStart(7)} ×${String(count).padStart(2)} = ${fmt(total).padStart(9)}`);
  }
  console.log(`  ${'【合计】'.padEnd(12)} ${fmt(sum)} 三角（含盘外 2 子与桌面）`);
}

console.log('\n=== 4. 整场合并结果 ===');
for (const tier of ['desktop', 'mobile']) {
  const built = buildScene(tier);
  const b = computeBounds(built.opaque.positions);
  console.log(`  ${TIERS[tier].label}: 不透明 tris=${fmt(built.stats.opaqueTris)} verts=${fmt(built.stats.opaqueVerts)} | 半透明 tris=${fmt(built.stats.transparentTris)} | 总 tris=${fmt(built.stats.totalTris)} | draw calls=${built.stats.drawCalls} | 部件=${built.stats.parts}`);
  console.log(`            包围盒 size=(${b.size.map(v => v.toFixed(0)).join(', ')})  minY=${b.min[0] === undefined ? '' : b.min[1].toFixed(1)}`);
}

console.log('\n=== 5. 几何版棋盘线（做 A/B 对比用）===');
const gl2 = makeBoardGridLines({});
console.log('  grid lines:', geoStats(gl2), '(理论值 47 quads = 94 tris: 19+19 条线 + 9 个星位)');

console.log('\n=== 6. 自制绕序推导自检：rectRing 的顶面扇形法线朝上 ===');
{
  const ring = rectRing(5, 5, 4, 0);
  let ok = true;
  // 扇形 (center, p_i, p_{i+1}) 的面法线应指向 +Y
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    const nx = (p[2] * q[1] - 0) + 0; // 简化：直接算 cross(p, q)
    const crossY = p[2] * q[0] - p[0] * q[2];
    if (crossY <= 0) ok = false;
  }
  console.log('  ', ok ? 'OK  全部扇形面法线为 +Y' : 'BAD 有反向面');
  const outN = ringOutwardNormals(ring, ring.length);
  console.log('   外法线示例:', outN.map(v => `(${v[0].toFixed(2)},${v[2].toFixed(2)})`).join(' '));
}

console.log('\n=== 7. icosphere 朝向自检 ===');
for (const sd of [1, 2, 3]) {
  const ico = icosphere(sd);
  const v = signedVolume(ico.positions, ico.indices);
  console.log(`  subdiv${sd}: tris=${fmt(ico.indices.length / 3)} vol=${v.toFixed(4)} ${v > 0 ? 'OK' : 'BAD'}`);
}