'use strict';
/* ============================================================================
   lingyun · PERSONAL ATLAS — V7 页面逻辑
   ----------------------------------------------------------------------------
   原则：
     · 图面上的每一个数字都必须来自 dem.json / profile.json，不得写死在 HTML 里
     · 比例尺是量出来的（屏幕中心点与右邻一像素的地面距离），并标明它标的是哪一点
     · 指针读数来自与着色器同一份 DEM，公式与构建期一致
     · 减少动态效果时不排帧：只画一帧，交互时才重画
   ========================================================================== */
(function () {
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* 样地图层（示意）：坐标待替换为真实样地。
     生成是确定性的（固定种子），避陡坡、落在林带高度区间 —— 目的是让图面上
     有真实的图层结构，不是伪造调查结果。页面上必须写明它是示意。 */
  const PLOT_SEED = 20261025;
  let plots = null, plotsOn = false, overlayCtx = null, overlay = null;
  let dpr = 1;   /* 叠加层与投影都在模块作用域里用，所以提到这里 */

  /* 度分秒：地图坐标不用十进制度，用地图上的写法。
   ⚠️ 必须先化成整秒再拆度分 —— 直接对小数部分乘 60，浮点误差会造出
      "111°32′60″" 这种非法读法（60 秒应该是 1 分）。111.55 在双精度里略小于
      111.55，于是 0.55*60 = 32.99999999999982，取整得 32 分、四舍五入得 60 秒。 */
  function dms(v, isLat) {
    const hemi = isLat ? (v >= 0 ? 'N' : 'S') : (v >= 0 ? 'E' : 'W');
    const tot = Math.round(Math.abs(v) * 3600);
    const d = Math.floor(tot / 3600), m = Math.floor((tot % 3600) / 60), s = tot % 60;
    const pad = n => String(n).padStart(2, '0');
    return d + '°' + pad(m) + '′' + pad(s) + '″' + hemi;
  }
  function shortDms(v, isLat) {
    const hemi = isLat ? (v >= 0 ? 'N' : 'S') : (v >= 0 ? 'E' : 'W');
    const tot = Math.round(Math.abs(v) * 3600);
    const d = Math.floor(tot / 3600), m = Math.floor((tot % 3600) / 60);
    return d + '°' + String(m).padStart(2, '0') + '′' + hemi;
  }
  const nf = (v, n) => v.toLocaleString('zh-CN', { minimumFractionDigits: n, maximumFractionDigits: n });

  const LEGENDS = {
    elevation: {
      title: '高程分层设色（米）',
      items: [['#d6e0ba', '365 – 720'], ['#c4d69e', '720 – 1080'], ['#d6cd96', '1080 – 1440'],
      ['#cca674', '1440 – 1800'], ['#b07e60', '1800 – 2170']],
      extra: [['线', '等高线 100 m'], ['粗线', '计曲线 500 m'], ['细网', '经纬网 5′']]
    },
    slope: {
      title: '坡度分级（度）',
      items: [['#d6e3bc', '0 – 3 平缓'], ['#c7d88c', '3 – 8 缓坡'], ['#e4cd6e', '8 – 15 斜坡'],
      ['#d6a060', '15 – 25 陡坡'], ['#b06a54', '> 25 急坡']],
      extra: [['线', '等高线 100 m'], ['粗线', '计曲线 500 m']]
    },
    aspect: {
      title: '坡向（八方位，下坡方向）',
      items: [['#d6604d', '北 337.5–22.5°'], ['#e2964e', '东北'], ['#deca69', '东'],
      ['#a0c878', '东南'], ['#6eb29e', '南'], ['#6898be', '西南'],
      ['#8c82be', '西'], ['#ba78a0', '西北']],
      extra: [['线', '坡向按 45° 分级']]
    },
    grey: {
      title: '单色晕渲（读地形起伏）',
      items: [['#efece3', '受光面（西北）'], ['#c9c5b6', '背光面（东南）']],
      extra: [['线', '等高线 100 m'], ['粗线', '计曲线 500 m']]
    }
  };

  function renderLegend(key) {
    const L = LEGENDS[key] || LEGENDS.elevation;
    const box = $('#legend');
    if (!box) return;
    box.innerHTML = '<h4>' + L.title + '</h4><ul>' +
      L.items.map(([c, t]) => '<li><i style="background:' + c + '"></i>' + t + '</li>').join('') +
      (L.extra || []).map(([k, t]) => '<li><span class="ln"></span>' + t + '</li>').join('') +
      /* 符号上了图，就必须上图例 —— 样地是叠加层，不进 L.items */
      (typeof plotsOn !== 'undefined' && plotsOn
        ? '<li><i style="background:#a8432b;border-radius:50%;width:10px;height:10px"></i>样地（示意）' +
          (plots ? '　' + plots.length + ' 处' : '') + '</li>'
        : '') +
      '</ul>';
  }

  /* --------------------------------------------------- 静态数据填充 */
  async function fillFromData() {
    let meta;
    try {
      const r = await fetch('data/dem.json');
      meta = await r.json();
    } catch (e) { console.warn('dem.json 未加载'); return; }

    const q = meta.quality, R = meta.region, g = meta.grid;
    $('#src-line').textContent =
      '图 1　木札岭样区地形与图层｜' + q.source + '，' + q.provider +
      '｜区域 ' + dms(R.west, false) + '–' + dms(R.east, false) + '，' + dms(R.south, true) + '–' + dms(R.north, true);

    const rows = [
      ['数据源', q.source],
      ['提供方', q.provider],
      ['许可', q.license],
      ['采集时间', q.acquisition],
      ['标称分辨率', q.nominalResolution],
      ['有效分辨率', q.effectiveResolution],
      ['输出栅格', q.outputGrid],
      ['水平基准', q.horizontalDatum],
      ['垂直基准', q.verticalDatum],
      ['地表类型', q.surfaceType],
      ['空洞与填补', q.voids],
      ['精度指标', q.accuracy]
    ];
    $('#quality-table tbody').innerHTML = rows.map(
      ([k, v]) => '<tr><th scope="row" style="border:0;padding-left:0">' + k + '</th><td>' + v + '</td></tr>'
    ).join('');

    const st = [
      ['区域最低', nf(meta.elevation.min, 0) + ' m'],
      ['区域最高', nf(meta.elevation.max, 0) + ' m'],
      ['区域均值', nf(meta.elevation.mean, 0) + ' m'],
      ['像元（东西）', g.cellMetersEW.toFixed(1) + ' m'],
      ['像元（南北）', g.cellMetersNS.toFixed(1) + ' m'],
      ['栅格', g.n + ' × ' + g.n],
      ['等高距', meta.contours.intervalMeters + ' m（计曲线 ' + meta.contours.indexIntervalMeters + ' m）'],
      ['等高线层数', meta.contours.levels + ' 层'],
      ['裁区无效点', String(meta.elevation.voidsInCrop)]
    ];
    $('#stats-table tbody').innerHTML = st.map(
      ([k, v]) => '<tr><th scope="row" style="border:0;padding-left:0">' + k + '</th><td class="num">' + v + '</td></tr>'
    ).join('');

    /* A–A′ 剖面：真数据画出来的，不是示意图 */
    try {
      const pr = await (await fetch('data/profile.json')).json();
      const s = pr.samples;
      const hMin = Math.min(...s.map(p => p.h)), hMax = Math.max(...s.map(p => p.h));
      const W = 1000, H = 190, pad = 34;
      const x = i => pad + (i / (s.length - 1)) * (W - pad - 12);
      const y = h => H - 26 - ((h - hMin) / Math.max(1, hMax - hMin)) * (H - 58);
      let d = 'M' + x(0).toFixed(1) + ',' + y(s[0].h).toFixed(1);
      for (let i = 1; i < s.length; i++) d += 'L' + x(i).toFixed(1) + ',' + y(s[i].h).toFixed(1);
      const area = d + 'L' + x(s.length - 1).toFixed(1) + ',' + (H - 26) + 'L' + x(0).toFixed(1) + ',' + (H - 26) + 'Z';
      const ticks = [hMin, Math.round((hMin + hMax) / 2), hMax];
      $('#profile-svg').innerHTML =
        '<path d="' + area + '" fill="#e7e3d8"/>' +
        '<path d="' + d + '" fill="none" stroke="#3a3b32" stroke-width="1.4"/>' +
        ticks.map(h => '<line x1="' + pad + '" x2="' + (W - 12) + '" y1="' + y(h).toFixed(1) +
          '" y2="' + y(h).toFixed(1) + '" stroke="#c9c5b6" stroke-width="1" stroke-dasharray="3 4"/>' +
          '<text x="' + (pad - 6) + '" y="' + (y(h) + 4).toFixed(1) +
          '" text-anchor="end" font-size="11" fill="#6d7062" font-family="ui-monospace,monospace">' + h + ' m</text>').join('') +
        '<text x="' + (W / 2) + '" y="' + (H - 6) + '" text-anchor="middle" font-size="11" fill="#6d7062" ' +
        'font-family="ui-monospace,monospace">沿 ' + dms(pr.lat, true) + ' 自西向东　共 ' + s.length + ' 个采样点</text>';
      $('#profile-cap').innerHTML = '<b>图 2</b>　A–A′ 地形剖面（' + dms(pr.lat, true) +
        '）：最低 ' + hMin + ' m，最高 ' + hMax + ' m。数据取自同一份 SRTM 栅格。';
    } catch (e) { console.warn('profile.json 未加载'); }
  }

  /* --------------------------------------------------- 图廓四角坐标 */
  function fillCorners() {
    const R = { south: 33.50, north: 34.00, west: 111.55, east: 112.05 };
    const set = (sel, txt) => { const el = $(sel); if (el) el.textContent = txt; };
    set('.corner.nw', dms(R.west, false) + '  ' + dms(R.north, true));
    set('.corner.ne', dms(R.east, false) + '  ' + dms(R.north, true));
    set('.corner.sw', dms(R.west, false) + '  ' + dms(R.south, true));
    set('.corner.se', dms(R.east, false) + '  ' + dms(R.south, true));
  }

  /* --------------------------------------------------- 启动 */
  async function boot() {
    fillCorners();
    await fillFromData();
    renderLegend('elevation');

    /* ⚠️ 这个 id 不能和上面那节的 id 重名：重名时 querySelector 拿到的是 section，
       引擎会在 canvas.getContext 上抛错，而且状态停在 idle，很难查 */
    const canvas = $('#map-canvas');
    if (!canvas || typeof canvas.getContext !== 'function') {
      window.__atlas7 = { error: 'canvas not found', status: () => ({ state: 'error' }) };
      return;
    }
    const engine = new window.Atlas7();
    window.__atlas7 = {
      engine, status: () => engine.status(), readout: null, scale: null,
      frames: () => engine.frames
    };

    dpr = Math.min(devicePixelRatio || 1, 2);
    const st = await engine.init(canvas, { demUrl: 'data/dem-rgb.webp', gridN: 220, reduced: REDUCED });
    if (st.state !== 'ready') {
      window.__atlas7.status = () => engine.status();
      updateBanner(engine.degradeReason || st.state);
      return;
    }
    engine.setSize(dpr);
    engine.attachInput(dpr);

    /* 图层切换 */
    $$('#layers button[data-layer]').forEach(btn => {
      btn.addEventListener('click', () => {
        const k = btn.dataset.layer;
        engine.layer = window.__atlas7Config.layers.indexOf(k);
        $$('#layers button[data-layer]').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
        renderLegend(k);
        engine.drawOnce();
      });
    });
    /* 垂直夸张：0.6–2.5，让"起伏看得清"是可调的，而不是骗人的固定值 */
    const vex = $('#vexag');
    if (vex) vex.addEventListener('input', () => {
      engine.vexag = Number(vex.value);
      const out = $('#vexag-out');
      if (out) out.textContent = '×' + Number(vex.value).toFixed(1);
      engine.drawOnce();
      updateReadoutDerived();
    });

    /* 指针读数（节流到 ~20Hz，拾取要射线步进，不该每个 mousemove 都跑） */
    let lastPick = 0;
    engine.onHover = (px, py) => {
      const now = performance.now();
      if (now - lastPick < 50) return;
      lastPick = now;
      const r = engine.pick(px * dpr, py * dpr);
      window.__atlas7.readout = r;
      updateReadout(r);
    };

    /* ---- 样地图层（示意）----
       确定性生成：固定种子 + 抖动网格 + 避陡坡 + 只落在林带高度区间。
       它提供的是一套**看得见的图层结构**，不是调查结果。 */
    overlay = $('#overlay');
    if (overlay && overlay.getContext) {
      overlayCtx = overlay.getContext('2d');
      plots = makePlots(engine, 56, PLOT_SEED);
      const btn = document.querySelector('[data-toggle="plots"]');
      btn && btn.addEventListener('click', () => {
        plotsOn = !plotsOn;
        btn.setAttribute('aria-pressed', String(plotsOn));
        renderLegend(window.__atlas7Config.layers[engine.layer]);
        sizeOverlay();
        drawOverlay();
        toast(plotsOn
          ? '样地 ' + plots.length + ' 处为示意坐标，待替换为真实样地'
          : '样地图层已关闭');
      });
      sizeOverlay();
    }

    let lastScaleAt = 0;
    engine.onFrame = s => {
      const el = $('#frames');
      if (el) el.textContent = String(s.frames);
      /* 指北针必须每帧跟着相机更新，不能只挂在比例尺那次计算上 ——
         否则拖动时它不动，就等于一个装饰性的假指北针。 */
      updateCompass();
      drawOverlay();
      /* 比例尺：相机停下来之后重算。不这么做的话，首帧之前算的那一次
         会因为 _invVP 还没建立而退化成解析估计，而且相机一动它就过期。 */
      const now = performance.now();
      if (now - lastScaleAt > 400) { lastScaleAt = now; updateScale(dpr); }
    };

    if (REDUCED) {
      engine.drawOnce();
    } else {
      engine.start();
      const io = new IntersectionObserver(es => {
        es.forEach(e => { e.isIntersecting ? engine.start() : engine.stop(); });
      }, { rootMargin: '160px' });
      io.observe(canvas.parentElement);
      document.addEventListener('visibilitychange', () => {
        document.hidden ? engine.stop() : engine.start();
      });
    }

    updateScale(dpr);
    addEventListener('resize', () => { engine.setSize(dpr); engine.drawOnce(); updateScale(dpr); });
    $('#reset-view') && $('#reset-view').addEventListener('click', () => {
      engine.camWant.yaw = 0.34; engine.camWant.pitch = 0.54;
      engine.camWant.dist = Math.max(engine.world.w, engine.world.h) * 0.86;
      engine.drawOnce(); updateScale(dpr);
    });
    $('#top-view') && $('#top-view').addEventListener('click', () => {
      engine.camWant.yaw = 0; engine.camWant.pitch = 1.44;
      engine.drawOnce(); updateScale(dpr);
    });

    /* 相机变化后比例尺会变，所以要在拖动/缩放后重算 */
    canvas.addEventListener('pointerup', () => setTimeout(() => updateScale(dpr), 260));
    canvas.addEventListener('wheel', () => setTimeout(() => updateScale(dpr), 60), { passive: true });

    function updateReadout(r) {
      const box = $('#readout');
      if (!box) return;
      if (!r) { box.classList.add('is-empty'); box.querySelector('.vals').textContent = '指向图面以读取坐标'; return; }
      box.classList.remove('is-empty');
      box.querySelector('.vals').innerHTML =
        '<dl>' +
        '<dt>经度</dt><dd>' + dms(r.lon, false) + '</dd>' +
        '<dt>纬度</dt><dd>' + dms(r.lat, true) + '</dd>' +
        '<dt>高程</dt><dd>' + nf(r.h, 1) + ' m</dd>' +
        '<dt>坡度</dt><dd>' + nf(r.slope, 1) + '°</dd>' +
        '<dt>坡向</dt><dd>' + nf(r.aspect, 0) + '°（' + dirName(r.aspect) + '）</dd>' +
        '</dl>';
    }
    function updateReadoutDerived() {
      if (window.__atlas7.readout) /* 高程不变，只是显示用的夸张系数变了 */ null;
    }
    updateReadout(null);
  }

  function dirName(a) {
    const n = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
    return n[Math.floor(((a + 22.5) % 360) / 45)];
  }

  /* 样地（示意）：确定性抖动网格，避陡坡、落在林带高度区间。
     目的只是让图面上出现一套真实的图层结构 —— 坐标是占位的，页面上写明了。 */
  function makePlots(engine, n, seed) {
    let s = seed >>> 0;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    const out = [];
    const cols = Math.ceil(Math.sqrt(n * 1.7));
    const rows = Math.ceil(n / cols);
    for (let j = 0; j < rows && out.length < n; j++) {
      for (let i = 0; i < cols && out.length < n; i++) {
        const u = (i + 0.22 + rnd() * 0.56) / cols;
        const v = (j + 0.22 + rnd() * 0.56) / rows;
        const d = engine.describe(u, v);
        if (d.slope > 26) continue;              /* 陡坡不放样地 */
        if (d.h < 520 || d.h > 1850) continue;   /* 只落在可能成林的带内 */
        out.push({ u, v, h: d.h, slope: d.slope });
      }
    }
    return out;
  }

  function sizeOverlay() {
    if (!overlay) return;
    const r = overlay.parentElement.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (overlay.width !== w || overlay.height !== h) { overlay.width = w; overlay.height = h; }
  }

  function drawOverlay() {
    if (!overlayCtx) return;
    const c = overlayCtx, W = overlay.width, H = overlay.height;
    c.clearRect(0, 0, W, H);
    if (!plotsOn || !plots) return;
    const A = window.__atlas7;
    const eng = A && A.engine;
    if (!eng || eng.state !== 'ready') return;
    for (let i = 0; i < plots.length; i++) {
      const pt = eng.projectUV(plots[i].u, plots[i].v);
      if (!pt) continue;
      const x = pt[0], y = pt[1];
      if (x < -24 || y < -24 || x > W + 24 || y > H + 24) continue;
      /* 双层符号：浅底 + 深环，在深浅两种地形上都能辨认 */
      c.beginPath(); c.arc(x, y, 5 * dpr, 0, 6.2832);
      c.fillStyle = 'rgba(246,244,238,.94)'; c.fill();
      c.lineWidth = 1.5 * dpr; c.strokeStyle = '#14150f'; c.stroke();
      c.beginPath(); c.arc(x, y, 2.1 * dpr, 0, 6.2832);
      c.fillStyle = '#a8432b'; c.fill();
    }
  }

  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('on'), 4200);
  }

  /* 指北针：把世界北方向投影到相机的屏幕基上，得到它相对屏幕"上"的角度。
     +z 是南，所以世界北 = (0,0,−1)。 */
  function updateCompass() {
    const A = window.__atlas7;
    if (!A || !A.engine || A.engine.state !== 'ready') return;
    const c = A.engine.cam, e = A.engine.eye();
    let fx = c.tx - e[0], fy = c.ty - e[1], fz = c.tz - e[2];
    const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
    let rx = -fz, ry = 0, rz = fx;                       // forward × up(0,1,0)
    const rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; ry /= rl; rz /= rl;
    const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;
    const nx = 0, ny = 0, nz = -1;
    const sx = nx * rx + ny * ry + nz * rz;
    const sy = nx * ux + ny * uy + nz * uz;
    const deg = Math.atan2(sx, sy) * 180 / Math.PI;
    const rose = $('#compass .rose');
    if (rose) rose.style.transform = 'rotate(' + deg.toFixed(1) + 'deg)';
    A.northScreenDeg = deg;
  }

  function updateBanner(reason) {
    const b = $('#degrade-note');
    if (b) b.textContent = '三维地图未启用（' + reason + '），下方仍为同一份数据渲染的等高线图幅。';
  }

  /* 比例尺与指北针：都在页面这一层算，因为它们是"读数"，不是三维内容 */
  function updateScale(dpr) {
    const A = window.__atlas7;
    if (!A || !A.engine || A.engine.state !== 'ready') return;
    const stage = $('#map-canvas').parentElement;
    const w = stage.clientWidth, h = stage.clientHeight;
    let mpp = A.engine.metersPerPixel(w / 2, h / 2, dpr);
    let src = '图面中心';
    if (!mpp) {                       /* 射线没打到地形（指向了天空/边界）时的退路 */
      mpp = A.engine.metersPerPixelEstimated(h);
      src = '解析估计（视线未落到地形）';
    }
    /* 取 1/2/5×10ⁿ 里不超过目标宽度且最大的一档 */
    const target = Math.min(180, w * 0.28) * mpp;
    const pow = Math.pow(10, Math.floor(Math.log10(target)));
    const cands = [1, 2, 5, 10].map(k => k * pow).filter(v => v <= target);
    const meters = cands.length ? cands[cands.length - 1] : pow;
    const px = meters / mpp;
    const bar = $('#scalebar .bar');
    if (bar) {
      bar.style.width = px.toFixed(1) + 'px';
      bar.innerHTML = '<i style="width:50%"></i><i style="width:50%"></i>';
    }
    const lbl = $('#scalebar .lbl');
    if (lbl) lbl.innerHTML = '<span>0</span><span>' +
      (meters >= 1000 ? (meters / 1000) + ' km' : meters + ' m') + '</span>';
    const note = $('#scale-note');
    if (note) note.textContent = '1 px ≈ ' + mpp.toFixed(1) + ' m（' + src + '）';
    /* 地图上写"图上 1 cm ≈ ?"才是制图惯例；屏幕 96dpi 下 1 cm = 37.8 px。
       这不是"1:N 比例尺" —— 屏幕没有固定物理尺寸，写 1:N 是假的。 */
    const perCm = mpp * 37.8;
    const num = $('#scale-num');
    if (num) num.textContent = '图上 1 cm ≈ ' +
      (perCm >= 1000 ? (perCm / 1000).toFixed(2) + ' km' : perCm.toFixed(0) + ' m');
    A.scale = { metersPerPixel: mpp, barMeters: meters, at: '图面中心', source: src, metersPerCm: perCm };

    updateCompass();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else { boot(); }
})();