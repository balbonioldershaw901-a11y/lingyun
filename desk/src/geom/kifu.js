// kifu.js — 棋谱数据 + 坐标换算 + 规则重放（零依赖，纯 JS）
//
// ============================================================================
// 这局棋是什么
// ============================================================================
//   名称：当湖十局·第一局（Ten Games of DangHu, game 1 / The First Game of DangHu）
//   年代：1739 年（清乾隆四年），浙江平湖
//   黑：范西屏（Fan Xiping）　白：施襄夏（Shi Xiangxia，又名施定庵 Shi Ding'an）
//   规则：中国古制 —— 四颗座子（黑 D4、Q16；白 D16、Q4）摆好后由白方先行，无贴目
//   全长：260 手，网络著录为黑胜（结果未做纸本核对，见下）
//   本文件收录：全部 260 手着法；棋盘上摆到第 60 手终了（PLACED_UP_TO = 60）
//
// ============================================================================
// 版权状态（结论：走 B —— 用年代上已无争议的公有领域棋局）
// ============================================================================
//   1) 着法本身：1739 年的对局，作者（对局者）已去世两百余年；棋谱着法是事实性内容，
//      年代上早已进入公有领域。
//   2) 一份明确的、可引用的许可声明 —— Sensei's Library「Ten Games of DangHu」页原文：
//         "The game records are not under copyright, however the aforementioned
//          commentaries and articles are."
//      （棋谱记录不受版权保护；但前述的解说与文章受版权保护。）
//      来源 URL: https://senseis.xmp.net/?TenGamesOfDangHu
//      该站内容按其版权页声明以 Open Content License 发布：
//         https://senseis.xmp.net/?SLCopyright
//      → 本文件只取「着法坐标」这一事实数据，不取任何解说文字。
//        陈祖德《当湖十局细解》一类带解说的版本有独立版权，本工程一个字都没用。
//   3) 一个必须避开的坑：目录 _gokifu/weiqiok_player.html 来自 WeiqiOK.com（围棋学研网）。
//      该站用户协议页页脚写「版权所有，未经许可，不得转录，违者必究」，
//      协议正文只讲注册用户行为规范，没有给出任何可再分发的内容许可。
//      URL: http://www.weiqiok.com/asp/UserAgreement.asp
//      → 用户协议不明/保留全部权利 = 不能用。本文件没有采用该站的任何数据。
//
// ============================================================================
// 核对到什么程度（诚实交代，不把待核的写成确定的）
// ============================================================================
//   * 第 1–60 手：两个彼此独立的来源逐手一致，0 处不符 —— 可视为已交叉核对。
//       (a) 101 围棋网《当湖十局》第 1 局页内嵌数据
//           https://www.101weiqi.com/book/chess/77/16873/
//       (b) Sensei's Library「The First Game of DangHu」页的 6 张分谱 SGF（1-10 … 51-60）
//           https://senseis.xmp.net/?TheFirstGameOfDangHu
//      两源分别来自中国棋谱数据库与英文围棋维基（后者转录自陈祖德的解说系列），
//      互不派生，逐手比对完全一致。
//   * 第 61–260 手：只有 (a) 一个来源，未找到第二来源逐手比对 —— 状态：待核。
//      内部自洽性核过：全部 260 手按围棋规则逐手重放（提子 / 自杀 / 全局同形禁着）
//      0 处非法，13 次提子，终局黑 125 子对白 120 子。
//      自洽不等于与纸本一致，所以棋盘只摆到第 60 手这个已交叉核对的位置。
//   * 未核对：对局结果「黑胜」等元数据只有网络著录；分先/贴目细节没有纸本核对。
//
// ============================================================================
// 坐标约定（最容易错的一步）
// ============================================================================
//   19 路标准盘，坐标指交叉点。列 A B C D E F G H J K L M N O P Q R S T（跳过 I）左→右；
//   行 1..19 从下到上。天元 J10；星位 D4 D10 D16 J4 J10 J16 Q4 Q10 Q16。
//   本工程棋盘的世界坐标：boardIntersections() 给出 points[iz * 19 + ix]，
//   其中 ix = 列序号（A=0 … T=18），iz = 19 - 行号（第 1 行 → iz=18，落在观者这一侧）。
//   所以 A1 在左前角、T19 在右后角，和棋盘线一起看就是正常的一盘棋。
//   （检查：四个座子 D4/Q16/D16/Q4 正好落在左下、右上、左上、右下四个角星上。）
//
// ============================================================================

export const BOARD_SIZE = 19;
export const GTP_COLUMNS = 'ABCDEFGHJKLMNOPQRST';   // 19 个字母，跳过 I

const EMPTY = 0, BLACK = 1, WHITE = 2;

/** 显示坐标（如 'Q16'）→ { ix, iz }；非法返回 null */
export function parsePoint(pt) {
  if (typeof pt !== 'string' || pt.length < 2) return null;
  const ix = GTP_COLUMNS.indexOf(pt[0].toUpperCase());
  const row = parseInt(pt.slice(1), 10);
  if (ix < 0 || !(row >= 1 && row <= 19)) return null;
  return { ix, iz: 19 - row };
}

/** { ix, iz } → 显示坐标 */
export function pointName(ix, iz) {
  return GTP_COLUMNS[ix] + (19 - iz);
}

/**
 * 逐手重放：座子 → 着法，含提子 / 自杀判定 / 全局同形禁着（超级劫）。
 * @param kifu 棋谱对象
 * @param upTo 只重放前 upTo 手（不含座子；座子永远先摆）
 * @returns { board, errors, captures, black, white }
 *          board 是长度 361 的 Int8Array，下标 = iz * 19 + ix（与棋盘几何一致）
 */
export function replayKifu(kifu, upTo = kifu.moves.length) {
  const N = BOARD_SIZE;
  const board = new Int8Array(N * N);
  const errors = [];
  const captures = [];
  const seen = new Set();
  const hash = () => board.join('');

  const neighbours = (ix, iz) => {
    const out = [];
    if (ix > 0) out.push(ix - 1, iz);
    if (ix < N - 1) out.push(ix + 1, iz);
    if (iz > 0) out.push(ix, iz - 1);
    if (iz < N - 1) out.push(ix, iz + 1);
    return out;   // 扁平：[x, z, x, z, ...]
  };
  const groupAt = (ix, iz) => {
    const color = board[iz * N + ix];
    const stack = [ix, iz];
    const stones = new Set([iz * N + ix]);
    const libs = new Set();
    while (stack.length) {
      const z = stack.pop(), x = stack.pop();
      const nb = neighbours(x, z);
      for (let i = 0; i < nb.length; i += 2) {
        const nx = nb[i], nz = nb[i + 1], k = nz * N + nx;
        const v = board[k];
        if (v === EMPTY) libs.add(k);
        else if (v === color && !stones.has(k)) { stones.add(k); stack.push(nx, nz); }
      }
    }
    return { stones, libs };
  };

  /* 座子先摆：中国古制的四颗对角星。座子之间互不相邻，不需要做吃子判定。 */
  for (const setup of kifu.setup || []) {
    const side = setup[0] === 'B' ? BLACK : WHITE;
    const p = parsePoint(setup.slice(1));
    if (!p) { errors.push('座子坐标非法: ' + setup); continue; }
    board[p.iz * N + p.ix] = side;
  }

  const total = Math.min(upTo, kifu.moves.length);
  for (let i = 0; i < total; i++) {
    const mv = kifu.moves[i];
    const side = mv[0] === 'B' ? BLACK : WHITE;
    const p = parsePoint(mv.slice(1));
    const label = '第' + (i + 1) + '手 ' + mv;
    if (!p) { errors.push(label + ' 坐标非法'); continue; }
    const k = p.iz * N + p.ix;
    if (board[k] !== EMPTY) { errors.push(label + ' 落在已有子上'); continue; }
    board[k] = side;

    let taken = 0;
    const nb = neighbours(p.ix, p.iz);
    for (let j = 0; j < nb.length; j += 2) {
      const nx = nb[j], nz = nb[j + 1], nk = nz * N + nx;
      if (board[nk] === EMPTY || board[nk] === side) continue;
      const g = groupAt(nx, nz);
      if (g.libs.size === 0) { for (const s of g.stones) board[s] = EMPTY; taken += g.stones.size; }
    }
    if (taken) captures.push({ move: i + 1, stones: taken });

    if (groupAt(p.ix, p.iz).libs.size === 0) errors.push(label + ' 自杀');
    const h = hash();
    if (seen.has(h)) errors.push(label + ' 全局同形重复（禁着）');
    seen.add(h);
  }

  let black = 0, white = 0;
  for (let i = 0; i < board.length; i++) {
    if (board[i] === BLACK) black++;
    else if (board[i] === WHITE) white++;
  }
  return { board, errors, captures, black, white };
}

/**
 * 棋盘上的子（给渲染用）。顺序固定（按 iz 再 ix），颜色与显示坐标一起给出。
 * @returns [{ ix, iz, color: 'black' | 'white', point }]
 */
export function kifuStones(kifu, upTo = kifu.placedUpTo) {
  const N = BOARD_SIZE;
  const { board } = replayKifu(kifu, upTo);
  const out = [];
  for (let iz = 0; iz < N; iz++) {
    for (let ix = 0; ix < N; ix++) {
      const v = board[iz * N + ix];
      if (v === EMPTY) continue;
      out.push({ ix, iz, color: v === BLACK ? 'black' : 'white', point: pointName(ix, iz) });
    }
  }
  return out;
}

/**
 * 文本局面图（自检 / 文档用）：X = 黑，O = 白，. = 空。
 * 左上角是 T19，右下角是 A1 —— 也就是正常打谱时看到的方向。
 */
export function kifuText(kifu, upTo = kifu.placedUpTo) {
  const N = BOARD_SIZE;
  const { board, black, white } = replayKifu(kifu, upTo);
  const head = '   ' + GTP_COLUMNS.split('').join(' ');
  const rows = [];
  for (let iz = 0; iz < N; iz++) {
    let line = '';
    for (let ix = 0; ix < N; ix++) {
      const v = board[iz * N + ix];
      line += (v === BLACK ? 'X ' : v === WHITE ? 'O ' : '. ');
    }
    const rank = String(19 - iz).padStart(2);
    rows.push(rank + ' ' + line + ' ' + rank);
  }
  return ['第 ' + Math.min(upTo, kifu.moves.length) + ' 手终了（黑 ' + black + ' 子 / 白 ' + white + ' 子）',
    head, ...rows, head].join('\n');
}

/* ============================================================================
 * 棋谱本体：当湖十局·第一局（1739）
 * moves 里每项是「颜色 + 显示坐标」，白先（第 1 手是 W）。setup 是四颗座子。
 * ========================================================================== */
export const DANGHU_1739_G1 = {
  id: 'danghu-1739-g1',
  nameZh: '当湖十局·第一局',
  name: 'The First Game of DangHu (Ten Games of DangHu)',
  year: 1739,
  era: '清乾隆四年',
  place: '浙江平湖',
  black: '范西屏',
  white: '施襄夏',
  rules: '中国古制：四座子，白先，无贴目',
  totalMoves: 260,
  /** 摆在棋盘上的手数：1–60 手是双来源交叉核对过的部分 */
  placedUpTo: 60,
  /** 着法来源 + 核对状态（逐手核对的分界点写在这里，别只写在注释里） */
  sources: [
    {
      label: '101围棋网《当湖十局》第1局',
      url: 'https://www.101weiqi.com/book/chess/77/16873/',
      covers: '1-260',
      crossChecked: false,
    },
    {
      label: "Sensei's Library, The First Game of DangHu（6 张分谱 SGF）",
      url: 'https://senseis.xmp.net/?TheFirstGameOfDangHu',
      covers: '1-60',
      crossChecked: true,
    },
  ],
  crossCheckedThrough: 60,
  license: "棋谱记录不受版权保护（Sensei's Library 原文：The game records are not under copyright）",
  licenseUrl: 'https://senseis.xmp.net/?TenGamesOfDangHu',
  disclaimer: '第 61 手以后只有一个来源，待核；棋盘只摆到第 60 手。',
  setup: ['BD4', 'BQ16', 'WD16', 'WQ4'],
  moves: [
  'WR14', 'BR9', 'WR7', 'BF17', 'WC6', 'BL3', 'WE6', 'BF5', 'WF6', 'BG6',
  'WG5', 'BF4', 'WH5', 'BG7', 'WH3', 'BG3', 'WH2', 'BK6', 'WJ6', 'BJ7',
  'WK5', 'BL5', 'WK7', 'BL6', 'WH7', 'BJ8', 'WG8', 'BF7', 'WH6', 'BD7',
  'WE7', 'BF8', 'WE8', 'BF9', 'WH8', 'BJ9', 'WG10', 'BF10', 'WD10', 'BG11',
  'WH10', 'BD11', 'WE11', 'BD9', 'WD12', 'BE9', 'WD6', 'BC9', 'WC4', 'BC3',
  'WD3', 'BE3', 'WB3', 'BD2', 'WB2', 'BF11', 'WJ10', 'BF15', 'WE14', 'BC11',
  'WE17', 'BE18', 'WD18', 'BF18', 'WF2', 'BC17', 'WC16', 'BD17', 'WB17', 'BC18',
  'WC12', 'BB11', 'WB18', 'BE16', 'WB12', 'BG2', 'WG1', 'BK10', 'WK11', 'BL10',
  'WL11', 'BM11', 'WL8', 'BL7', 'WM10', 'BK8', 'WJ12', 'BN11', 'WM8', 'BP6',
  'WN6', 'BN5', 'WQ6', 'BP7', 'WO5', 'BP5', 'WM5', 'BP4', 'WN4', 'BH4',
  'WK4', 'BL4', 'WK9', 'BL9', 'WM9', 'BK9', 'WM7', 'BN3', 'WO3', 'BO4',
  'WN2', 'BM3', 'WP3', 'BQ3', 'WQ2', 'BM4', 'WR3', 'BN5', 'WQ10', 'BO9',
  'WQ9', 'BQ11', 'WP11', 'BQ12', 'WR10', 'BQ14', 'WO10', 'BN10', 'WN9', 'BP9',
  'WP13', 'BQ13', 'WM12', 'BN12', 'WN13', 'BM13', 'WL12', 'BO13', 'WN14', 'BO12',
  'WB8', 'BC5', 'WB4', 'BB5', 'WB6', 'BD5', 'WA5', 'BC7', 'WB7', 'BA4',
  'WA6', 'BE2', 'WF1', 'BC2', 'WE5', 'BE4', 'WC1', 'BB1', 'WB9', 'BB10',
  'WA1', 'BG4', 'WK3', 'BA3', 'WD1', 'BE1', 'WG13', 'BF13', 'WF14', 'BE12',
  'WE13', 'BF12', 'WG15', 'BB1', 'WC1', 'BC14', 'WB15', 'BA12', 'WA13', 'BA10',
  'WJ4', 'BB13', 'WD13', 'BE15', 'WD15', 'BA14', 'WB19', 'BG16', 'WH1', 'BH13',
  'WH12', 'BO14', 'WN15', 'BQ8', 'WR8', 'BS11', 'WS9', 'BQ5', 'WR5', 'BN16',
  'WR17', 'BQ17', 'WM16', 'BN17', 'WR16', 'BS13', 'WS14', 'BR18', 'WS18', 'BQ18',
  'WS19', 'BD14', 'WG14', 'BA15', 'WA16', 'BC13', 'WB14', 'BA13', 'WA18', 'BK16',
  'WN4', 'BO6', 'WJ16', 'BJ15', 'WK15', 'BH16', 'WJ14', 'BH15', 'WH14', 'BA9',
  'WA8', 'BE10', 'WL16', 'BK17', 'WL17', 'BL15', 'WK14', 'BL18', 'WM15', 'BM18',
  'WL2', 'BM2', 'WM1', 'BN5', 'WK2', 'BQ7', 'WR6', 'BP10', 'WO15', 'BT16',
  'WR13', 'BS12', 'WS15', 'BP15', 'WS17', 'BC19', 'WO16', 'BO17', 'WP16', 'BQ15',
  ],
};

/** 现在摆在盘上的这一局 */
export const KIFU = DANGHU_1739_G1;

/** 一句话说明（页面/HUD 用同一句，别两处各写一份） */
export const KIFU_CAPTION = '盘上不是随手摆的：1739 年范西屏对施襄夏的「当湖十局」第一局，摆到第 60 手。';