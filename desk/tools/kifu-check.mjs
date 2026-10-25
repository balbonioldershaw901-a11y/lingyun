// tools/kifu-check.mjs — 棋谱自检：来源/许可、规则重放、文本局面图、双来源交叉核对
// 用法：node tools/kifu-check.mjs
// 不依赖浏览器，也不依赖任何包。
import fs from 'node:fs';
import path from 'node:path';
import { KIFU, kifuText, kifuStones, replayKifu, parsePoint, pointName, GTP_COLUMNS } from '../src/geom/kifu.js';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const line = (s) => console.log('  ' + s);

console.log('=== 1. 这是哪一局棋 ===');
line(`${KIFU.nameZh} / ${KIFU.name}`);
line(`${KIFU.year} 年（${KIFU.era || '清乾隆四年'}），${KIFU.place}；黑 ${KIFU.black}，白 ${KIFU.white}`);
line(`规则：${KIFU.rules}；全长 ${KIFU.totalMoves} 手，棋盘上摆到第 ${KIFU.placedUpTo} 手`);

console.log('\n=== 2. 来源与许可状态 ===');
for (const s of KIFU.sources) {
  line(`${s.covers.padEnd(6)} ${s.crossChecked ? '已交叉核对' : '待核      '}  ${s.label}  ${s.url}`);
}
line(`许可依据：${KIFU.license}`);
line(`依据原文页面：${KIFU.licenseUrl}`);
line(`保留意见：${KIFU.disclaimer}`);

console.log('\n=== 3. 坐标换算自检 ===');
const known = { Q16: [15, 3], D4: [3, 15], D16: [3, 3], Q4: [15, 15], A1: [0, 18], T19: [18, 0], J10: [8, 9] };
let bad = 0;
for (const [name, [ix, iz]] of Object.entries(known)) {
  const p = parsePoint(name);
  const ok = p && p.ix === ix && p.iz === iz && pointName(ix, iz) === name;
  if (!ok) bad++;
  line(`${ok ? 'OK ' : 'BAD'} ${name.padEnd(4)} -> ix=${p && p.ix} iz=${p && p.iz}（回读 ${p && pointName(p.ix, p.iz)}）`);
}
line(`字母表 ${GTP_COLUMNS}（${GTP_COLUMNS.length} 个，跳过 I）；星位/天元/四角全部对上${bad === 0 ? '' : '，有 ' + bad + ' 处不符'}`);

console.log('\n=== 4. 规则重放（提子 / 自杀 / 全局同形禁着）===');
const full = replayKifu(KIFU, KIFU.totalMoves);
line(`全部 ${KIFU.totalMoves} 手：非法手 ${full.errors.length} 处${full.errors.length ? ' -> ' + full.errors.slice(0, 3).join('; ') : ''}`);
line(`提子共 ${full.captures.length} 次：${full.captures.map((c) => '第' + c.move + '手提' + c.stones).join('、')}`);
line(`终局：黑 ${full.black} 子 / 白 ${full.white} 子`);
const shown = replayKifu(KIFU, KIFU.placedUpTo);
line(`摆到第 ${KIFU.placedUpTo} 手：黑 ${shown.black} 子 / 白 ${shown.white} 子，共 ${kifuStones(KIFU).length} 子（含四座子）`);

console.log('\n=== 5. 摆上棋盘的文本局面图（X 黑 / O 白 / . 空）===');
console.log(kifuText(KIFU).split('\n').map((l) => '  ' + l).join('\n'));

console.log('\n=== 6. 双来源交叉核对（本地有 SL 分谱副本时才做）===');
const L = 'ABCDEFGHJKLMNOPQRST';
const s2gtp = (p) => L[p.charCodeAt(0) - 97] + (19 - (p.charCodeAt(1) - 97));
const slDirs = [
  path.join(HERE, '..', '..', '..', '..', '_gokifu', 'sl_danghu'),
  path.join(HERE, '..', '..', '..', '..', '..', '_gokifu', 'sl_danghu'),
];
const slDir = slDirs.find((d) => fs.existsSync(d));
if (!slDir) {
  line('本地没有 Sensei\'s Library 分谱副本，跳过。分谱 URL 见第 2 节 sources。');
} else {
  const sl = [];
  for (const f of fs.readdirSync(slDir).sort()) {
    if (!/^0[2-7]/.test(f)) continue;
    const sgf = fs.readFileSync(path.join(slDir, f), 'utf8');
    const re = /;\s*([BW])\[([a-s]{2})\]/g;
    let m;
    while ((m = re.exec(sgf))) sl.push(m[1] + s2gtp(m[2]));
  }
  const upto = Math.min(sl.length, KIFU.moves.length);
  const diff = [];
  for (let i = 0; i < upto; i++) if (sl[i] !== KIFU.moves[i]) diff.push(`第${i + 1}手 101=${KIFU.moves[i]} SL=${sl[i]}`);
  line(`本地分谱：${slDir}`);
  line(`逐手比对前 ${upto} 手：不符 ${diff.length} 处${diff.length ? ' -> ' + diff.slice(0, 5).join('; ') : ''}`);
  line(diff.length === 0 && upto >= KIFU.crossCheckedThrough
    ? `结论：第 1–${upto} 手与 101 围棋网数据逐手一致（KIFU.crossCheckedThrough=${KIFU.crossCheckedThrough}）`
    : '结论：未达交叉核对要求');

  /* 再核一层：SL 每张分谱都自带 AB/AW 前置局面，把它 + 那 10 手重放出来，
     应与本工程在同样手数上的局面逐点相同（这一步同时校验坐标换算与提子逻辑）。 */
  line('');
  line('分谱自带局面（AB/AW + 该图 10 手）逐点比对：');
  const files = fs.readdirSync(slDir).sort().filter((f) => /^0[2-7]/.test(f));
  /* SGF 的 AB/AW 是一串方括号（AB[pd][dp]），必须整串读完，只读第一个会少子 */
  const parseSetup = (sgf) => {
    const out = [];
    for (const key of ['AB', 'AW']) {
      const re = new RegExp(key + '((?:\\[[a-s]{2}\\])+)', 'g');
      let m;
      while ((m = re.exec(sgf))) {
        for (const p of m[1].matchAll(/\[([a-s]{2})\]/g)) out.push((key === 'AB' ? 'B' : 'W') + s2gtp(p[1]));
      }
    }
    return out;
  };
  for (const f of files) {
    const sgf = fs.readFileSync(path.join(slDir, f), 'utf8');
    const setup = parseSetup(sgf);
    const mv = [];
    const re = /;\s*([BW])\[([a-s]{2})\]/g;
    let m;
    while ((m = re.exec(sgf))) mv.push(m[1] + s2gtp(m[2]));
    const endMatch = /_m\d+_(\d+)\.sgf$/.exec(f);
    const n = endMatch ? Number(endMatch[1]) : mv.length;
    const mine = replayKifu(KIFU, n).board;
    const theirs = replayKifu({ setup, moves: mv, placedUpTo: mv.length, totalMoves: mv.length }, mv.length).board;
    let mismatch = 0;
    for (let i = 0; i < mine.length; i++) if (mine[i] !== theirs[i]) mismatch++;
    const count = theirs.reduce((a, v) => a + (v ? 1 : 0), 0);
    line(`  ${f}  第 ${n} 手局面：不符 ${mismatch} / 361 点（该图前置 ${setup.length} 子 + 本图 ${mv.length} 手 = ${count} 子）`);
  }
}