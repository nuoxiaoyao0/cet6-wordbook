/* ============================================================================
   六级词汇 · 书页模式  v1.1
   - 单词在上、中文在下，一页由脚本按真实行高排满一屏（永不遮挡）
   - 新增：学习计划（几天背完 / 每天几次）、复习模式（1/2/4/7/15/30 天）、
           高频词星标（COCA 词频）、顺序版/乱序版、细节动效
   ==========================================================================*/
(function () {
  'use strict';

  var VERSION = '1.1.0';
  var LS_SET = 'cet6.book.settings.v2';
  var LS_MARK = 'cet6.book.marks.v1';
  var LS_REV = 'cet6.book.rev.v1';
  var LS_PLAN = 'cet6.book.plan.v1';
  var LS_POS = 'cet6.book.pos.v2';
  var LS_HINT = 'cet6.book.hint.v2';
  var LIST_SIZE = 50;
  var DAY = 86400000;
  var IV = [1, 2, 4, 7, 15, 30];              /* 复习间隔（天） */

  /* ========================= 纯逻辑（node 可测） ======================== */
  var Core = {
    transText: function (trans) {
      if (!trans || !trans.length) return '';
      return trans.map(function (t) { return (t[0] ? t[0] + '. ' : '') + t[1]; }).join('；');
    },

    /* 高频等级：2 = 核心（COCA ≤2000），1 = 高频（≤4000），0 = 普通 */
    starLevel: function (row) {
      var f = row && row[8] || 0;
      if (!f) return 0;
      if (f <= 2000) return 2;
      if (f <= 4000) return 1;
      return 0;
    },

    /* 第二天复习间隔（天）：rep 从 1 开始 */
    interval: function (rep) {
      var i = Math.min(Math.max(rep, 1), IV.length) - 1;
      return IV[i];
    },

    /* 计划：第 d 天（1 起）的词区间 [start,end) */
    planBounds: function (total, day, days) {
      var per = Math.ceil(total / Math.max(1, days));
      var start = (Math.max(1, day) - 1) * per;
      return [start, Math.min(start + per, total), per];
    },

    /* 复习是否到期；legacy=true 表示旧数据（标记过但没有审核时间） */
    isDue: function (mark, rev, now) {
      if (!mark) return false;
      if (!rev || !rev[1]) return (mark === 2 || mark === 3);
      return rev[1] <= now;
    },

    /* 下一次复习时间：next 为新标记；返回 [rep, nextTs] */
    schedule: function (prevRev, nextMark, now) {
      if (!nextMark) return null;
      var rep = (prevRev && prevRev[0]) || 0;
      if (nextMark === 1) rep = Math.min(rep + 1, IV.length);
      else rep = 1;
      return [rep, now + Core.interval(rep) * 86400000];
    },

    paginate: function (heights, pageH, perPage) {
      var n = heights.length;
      if (!n) return [];
      var pages = [], i;
      if (perPage > 0) {
        for (i = 0; i < n; i += perPage) pages.push([i, Math.min(n, i + perPage)]);
        return pages;
      }
      var H = Math.max(1, pageH), start = 0, acc = 0;
      for (i = 0; i < n; i++) {
        var h = heights[i];
        if (i > start && acc + h > H) { pages.push([start, i]); start = i; acc = 0; }
        acc += h;
      }
      pages.push([start, n]);
      return pages;
    },

    pageOf: function (pages, idx) {
      var lo = 0, hi = pages.length - 1;
      if (hi < 0) return 0;
      while (lo <= hi) {
        var mid = (lo + hi) >> 1;
        if (idx < pages[mid][0]) hi = mid - 1;
        else if (idx >= pages[mid][1]) lo = mid + 1;
        else return mid;
      }
      return Math.min(Math.max(lo, 0), pages.length - 1);
    },

    seededShuffle: function (n, seed) {
      var a = new Array(n), i;
      for (i = 0; i < n; i++) a[i] = i;
      var s = (seed >>> 0) || 1;
      function rnd() { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }
      for (i = n - 1; i > 0; i--) { var j = Math.floor(rnd() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
      return a;
    },

    /* 搜索命中：前缀优先、再词长短、再字母序 */
    matchScore: function (row, q) {
      var w = row[0].toLowerCase();
      if (w.indexOf(q) === 0) return 0;
      if (w.indexOf(q) > 0) return 1;
      if (Core.transText(row[3]).toLowerCase().indexOf(q) >= 0) return 2;
      return -1;
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
  if (typeof document === 'undefined') return;

  /* ================================ 状态 ================================ */
  var S = {
    rows: [],
    wordIndex: Object.create(null),
    marks: {},
    rev: {},
    plan: null,
    view: 'all',
    query: '',
    page: 0,
    settings: {
      size: 16, sentences: true, phonetic: true, theme: 'paper',
      perPage: 0, order: 'alpha', seed: 1, accent: 'us', hideKnown: false, showStar: true
    }
  };

  var lay = { list: [], pages: [], heights: [] };
  var hCache = new Map();
  var hSig = '';
  var orderCache = null, orderSig = '';
  var longFired = false, longTimer = 0, pdX = 0, pdY = 0;

  /* ================================ DOM ================================= */
  var $ = function (id) { return document.getElementById(id); };
  var app = $('app'), flow = $('flow'), paper = $('paper');
  var runLeft = $('runLeft'), runRight = $('runRight'), pagenum = $('pagenum');
  var pageInfo = $('pageInfo'), wordRange = $('wordRange');
  var btnPrev = $('btnPrev'), btnNext = $('btnNext');
  var progressRail = $('progressRail').firstElementChild;
  var loadingEl = $('loading'), ldBar = $('ldBar'), ldHint = $('ldHint');
  var toastEl = $('toast');

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function todayStr(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function dateAdd(str, days) {
    var d = new Date(str + 'T00:00:00');
    d.setDate(d.getDate() + days);
    return todayStr(d);
  }

  /* ============================== 持久化 ================================ */
  function readJSON(key, fallback) {
    try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
    catch (e) { return fallback; }
  }
  function writeJSON(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }
  function loadState() {
    var st = readJSON(LS_SET, null);
    if (st) for (var k in S.settings) if (st[k] !== undefined) S.settings[k] = st[k];
    var mk = readJSON(LS_MARK, null);
    if (mk && typeof mk === 'object') S.marks = mk;
    var rv = readJSON(LS_REV, null);
    if (rv && typeof rv === 'object') S.rev = rv;
    var pl = readJSON(LS_PLAN, null);
    if (pl && pl.start && pl.days) S.plan = pl;
    var pos = readJSON(LS_POS, null);
    if (pos && pos.word) S.posWord = pos.word;
    if (pos && pos.view) S.posView = pos.view;
  }
  var markSaveTimer = 0;
  function saveMarks() {
    clearTimeout(markSaveTimer);
    markSaveTimer = setTimeout(function () {
      writeJSON(LS_MARK, S.marks);
      writeJSON(LS_REV, S.rev);
    }, 220);
  }
  function saveSettings() { writeJSON(LS_SET, S.settings); }
  function savePlan() { writeJSON(LS_PLAN, S.plan); }
  function savePos() {
    if (!lay.list.length) return;
    var p = lay.pages[S.page] || [0, 0];
    var idx = lay.list[p[0]];
    if (idx != null && S.rows[idx]) writeJSON(LS_POS, { word: S.rows[idx][0], view: S.view });
  }

  /* ============================ 词条渲染 ================================ */
  function markGlyph(m) { return m === 1 ? '✓' : m === 2 ? '✕' : m === 3 ? '△' : '○'; }

  function transHTML(trans) {
    if (!trans || !trans.length) return '';
    return trans.map(function (t) {
      var pos = t[0] ? '<span class="e-pos">' + esc(t[0]) + '.</span>' : '';
      return pos + esc(t[1]);
    }).join('<span class="e-sep">；</span>');
  }

  function starHTML(row) {
    if (!S.settings.showStar) return '';
    var lv = Core.starLevel(row);
    return lv ? '<span class="e-star l' + lv + '">★</span>' : '';
  }

  function entryHTML(i) {
    var r = S.rows[i];
    if (!r) return '';
    var word = r[0], ph = r[1], trans = r[3], sents = r[4];
    var m = S.marks[word] || 0, s = S.settings;
    var phHTML = (s.phonetic && ph) ? '<span class="e-ph">/' + esc(ph) + '/</span>' : '<span class="e-ph"></span>';
    var sHTML = '';
    if (s.sentences && sents && sents.length) {
      var x = sents[0];
      sHTML = '<div class="e-s"><span class="s-en">' + esc(x[0]) + '</span>'
        + '<span class="s-cn">' + esc(x[1]) + '</span></div>';
    }
    return '<div class="entry marked-' + m + '" data-i="' + i + '">'
      + '<span class="rail"></span>'
      + '<div class="e-head">'
      + '<span class="e-w">' + esc(word) + '</span>' + starHTML(r) + phHTML
      + '<button class="e-mark m' + m + '" data-act="mark" aria-label="标记">' + markGlyph(m) + '</button>'
      + '</div>'
      + '<div class="e-t">' + transHTML(trans) + '</div>'
      + sHTML
      + '</div>';
  }

  /* ============================ 顺序 / 计划 ============================= */
  function baseOrder() {
    var sig = S.settings.order + '|' + S.settings.seed + '|' + S.rows.length;
    if (orderCache && orderSig === sig) return orderCache;
    var n = S.rows.length, i;
    if (S.settings.order === 'shuffle') {
      orderCache = Core.seededShuffle(n, S.settings.seed);
    } else {
      orderCache = new Array(n);
      for (i = 0; i < n; i++) orderCache[i] = i;
    }
    orderSig = sig;
    return orderCache;
  }

  function planDay() {
    if (!S.plan) return 0;
    var start = new Date(S.plan.start + 'T00:00:00');
    var now = new Date(); now.setHours(0, 0, 0, 0);
    var d = Math.floor((now.getTime() - start.getTime()) / DAY) + 1;
    return clamp(d, 1, Math.max(1, S.plan.days));
  }
  function planRange() {
    if (!S.plan) return null;
    var b = Core.planBounds(S.rows.length, planDay(), S.plan.days);
    return { start: b[0], end: b[1], perDay: b[2], day: planDay() };
  }
  function planDone() {
    var r = planRange();
    if (!r) return { done: 0, total: 0, allDone: markedCount(), all: S.rows.length };
    var ord = baseOrder(), done = 0;
    for (var k = r.start; k < r.end; k++) if (S.marks[S.rows[ord[k]][0]]) done++;
    return { done: done, total: r.end - r.start, allDone: markedCount(), all: S.rows.length };
  }
  function markedCount() {
    var c = 0;
    for (var k in S.marks) if (S.marks[k]) c++;
    return c;
  }

  function isDue(i, now) {
    var word = S.rows[i][0];
    return Core.isDue(S.marks[word] || 0, S.rev[word], now);
  }
  function dueCount() {
    var now = Date.now(), c = 0, ord = baseOrder();
    for (var k = 0; k < ord.length; k++) if (isDue(ord[k], now)) c++;
    return c;
  }

  /* ============================ 列表构建 =============================== */
  function computeList() {
    var rows = S.rows, ord = baseOrder(), v = S.view, arr, k;
    if (v === 'today') {
      var pr = planRange();
      if (pr) arr = ord.slice(pr.start, pr.end); else arr = ord.slice();
    } else if (v === 'review') {
      var now = Date.now();
      arr = [];
      for (k = 0; k < ord.length; k++) if (isDue(ord[k], now)) arr.push(ord[k]);
    } else if (v === 'hi') {
      arr = [];
      for (k = 0; k < ord.length; k++) if (Core.starLevel(rows[ord[k]]) >= 1) arr.push(ord[k]);
    } else if (v === 'new') {
      arr = [];
      for (k = 0; k < ord.length; k++) {
        var m0 = S.marks[rows[ord[k]][0]] || 0;
        if (m0 === 2 || m0 === 3) arr.push(ord[k]);
      }
    } else if (v === 'known') {
      arr = [];
      for (k = 0; k < ord.length; k++) if ((S.marks[rows[ord[k]][0]] || 0) === 1) arr.push(ord[k]);
    } else if (v === 'unmarked') {
      arr = [];
      for (k = 0; k < ord.length; k++) if (!(S.marks[rows[ord[k]][0]] || 0)) arr.push(ord[k]);
    } else {
      arr = ord.slice();
      if (S.settings.hideKnown) {
        arr = arr.filter(function (i) { return (S.marks[rows[i][0]] || 0) !== 1; });
      }
    }
    var q = S.query.trim().toLowerCase();
    if (q) {
      var scored = [];
      for (k = 0; k < arr.length; k++) {
        var sc = Core.matchScore(rows[arr[k]], q);
        if (sc >= 0) scored.push([sc, arr[k]]);
      }
      scored.sort(function (a, b) {
        if (a[0] !== b[0]) return a[0] - b[0];
        var wa = rows[a[1]][0].toLowerCase(), wb = rows[b[1]][0].toLowerCase();
        if (wa.length !== wb.length) return wa.length - wb.length;
        return wa < wb ? -1 : wa > wb ? 1 : 0;
      });
      arr = scored.map(function (x) { return x[1]; });
    }
    return arr;
  }

  /* ============================ 布局 / 分页 ============================= */
  function heightSig() {
    return [S.settings.size, S.settings.sentences ? 1 : 0, S.settings.phonetic ? 1 : 0,
      S.settings.showStar ? 1 : 0, S.settings.theme, flow.clientWidth].join('|');
  }

  function measure(indices) {
    var missing = [], k;
    for (k = 0; k < indices.length; k++) if (!hCache.has(indices[k])) missing.push(indices[k]);
    if (!missing.length) return;
    var probe = document.createElement('div');
    probe.className = 'flow probe';
    probe.style.width = flow.clientWidth + 'px';
    var html = [];
    for (k = 0; k < missing.length; k++) html.push(entryHTML(missing[k]));
    probe.innerHTML = html.join('');
    app.appendChild(probe);
    var kids = probe.children;
    for (k = 0; k < missing.length; k++) {
      var h = kids[k] ? kids[k].getBoundingClientRect().height : 0;
      hCache.set(missing[k], h > 4 ? h : 64);
    }
    probe.remove();
  }

  function buildLayout(anchorWord) {
    var sig = heightSig();
    if (sig !== hSig) { hCache.clear(); hSig = sig; }
    lay.list = computeList();
    measure(lay.list);
    lay.heights = lay.list.map(function (i) { return hCache.get(i) || 64; });
    var pageH = flow.clientHeight || (window.innerHeight - 130);
    lay.pages = Core.paginate(lay.heights, pageH, S.settings.perPage);
    if (anchorWord) {
      var rowIdx = S.wordIndex[anchorWord];
      if (rowIdx != null) {
        var within = lay.list.indexOf(rowIdx);
        if (within >= 0) S.page = Core.pageOf(lay.pages, within);
      }
    }
    S.page = clamp(S.page, 0, Math.max(0, lay.pages.length - 1));
  }

  var VIEW_LABEL = {
    all: '全部', today: '今日', review: '复习', hi: '高频',
    'new': '生词', known: '已掌握', unmarked: '未标记'
  };

  function turn(dir) {
    if (!dir) return;
    flow.classList.remove('turn-next', 'turn-prev');
    void flow.offsetWidth;
    flow.classList.add(dir > 0 ? 'turn-next' : 'turn-prev');
  }

  function render() {
    var total = lay.pages.length;
    if (!total) {
      flow.innerHTML = '<div class="empty"><p>这里还没有单词</p>'
        + '<p class="sub">换个视图，或清除搜索条件</p></div>';
      pageInfo.textContent = '0 / 0';
      wordRange.textContent = '';
      pagenum.textContent = '—';
      runRight.textContent = '';
      btnPrev.disabled = btnNext.disabled = true;
      updateChrome();
      return;
    }
    S.page = clamp(S.page, 0, total - 1);
    var p = lay.pages[S.page];
    var slice = lay.list.slice(p[0], p[1]);
    flow.innerHTML = slice.map(entryHTML).join('');
    flow.classList.toggle('scrollable', flow.scrollHeight - flow.clientHeight > 2);

    var firstIdx = slice[0], lastIdx = slice[slice.length - 1];
    var head = S.query.trim() ? '搜索 “' + S.query.trim() + '”' : (VIEW_LABEL[S.view] || '全部');
    runLeft.textContent = '六级词汇 · ' + head;
    var firstWord = S.rows[firstIdx][0], lastWord = S.rows[lastIdx][0];
    var listTag;
    if (S.settings.order === 'shuffle') {
      listTag = '乱序 · ' + pad(Math.floor(p[0] / LIST_SIZE) + 1);
    } else {
      var l1 = Math.floor(firstIdx / LIST_SIZE) + 1, l2 = Math.floor(lastIdx / LIST_SIZE) + 1;
      listTag = 'List ' + pad(l1) + (l2 !== l1 ? '–' + pad(l2) : '');
    }
    runRight.textContent = listTag + ' · ' + firstWord + ' – ' + lastWord;

    pagenum.textContent = '— ' + (S.page + 1) + ' —';
    pageInfo.textContent = (S.page + 1) + ' / ' + total;
    wordRange.textContent = '第 ' + (p[0] + 1) + '–' + p[1] + ' 词 · 共 ' + lay.list.length;
    btnPrev.disabled = S.page === 0;
    btnNext.disabled = S.page >= total - 1;
    updateChrome();
    savePos();
  }

  /* 顶栏副标题 + 进度条 */
  function updateChrome() {
    var sub = $('subTitle');
    var pct = S.rows.length ? markedCount() / S.rows.length * 100 : 0;
    progressRail.style.width = pct.toFixed(2) + '%';
    var txt;
    if (S.query.trim()) txt = '搜索中';
    else if (S.plan) {
      var d = planDone();
      txt = '第 ' + planDay() + '/' + S.plan.days + ' 天 · 今日 ' + d.done + '/' + d.total;
    } else txt = VIEW_LABEL[S.view] || '书页模式';
    if (sub.textContent !== txt) sub.textContent = txt;
    var st = $('statNote');
    if (st) st.textContent = '共 ' + S.rows.length + ' 词 · 已标记 ' + markedCount()
      + ' 词（' + pct.toFixed(1) + '%）· 今日到期复习 ' + dueCount() + ' 词';
  }

  /* ============================== 标记 / 复习 ============================ */
  function applyMark(word, next) {
    var prev = S.marks[word] || 0;
    if (next === prev) return prev;
    if (!next) {
      delete S.marks[word];
      delete S.rev[word];
    } else {
      S.marks[word] = next;
      var sch = Core.schedule(S.rev[word], next, Date.now());
      if (sch) S.rev[word] = sch; else delete S.rev[word];
    }
    saveMarks();
    return next;
  }
  function cycleMark(word) {
    var m = S.marks[word] || 0;
    return applyMark(word, m === 0 ? 1 : m === 1 ? 3 : m === 3 ? 2 : 0);
  }

  function refreshEntry(el, word) {
    var m = S.marks[word] || 0;
    el.className = 'entry marked-' + m;
    var btn = el.querySelector('.e-mark');
    if (btn) {
      btn.className = 'e-mark m' + m;
      btn.textContent = markGlyph(m);
      btn.classList.remove('pop');
      void btn.offsetWidth;
      btn.classList.add('pop');
    }
  }

  var MARK_NAME = { 0: '已清除标记', 1: '已掌握', 2: '不熟', 3: '待再看' };

  function onMark(word, el) {
    var next = cycleMark(word);
    if (el && S.view === 'all' && !S.settings.hideKnown) {
      refreshEntry(el, word);                       /* 原地更新，不打断阅读 */
    } else {
      if (el) buildLayout(S.rows[+el.dataset.i][0]);
      render();
    }
    updateChrome();
    var extra = '';
    var rv = S.rev[word];
    if (rv && rv[1]) {
      var days = Math.max(1, Math.round((rv[1] - Date.now()) / DAY));
      extra = ' · ' + days + ' 天后复习';
    }
    toast(MARK_NAME[next] + ' · ' + word + extra);
  }

  /* ============================== 语音 ================================= */
  var voices = [];
  function loadVoices() { try { voices = window.speechSynthesis.getVoices() || []; } catch (e) { voices = []; } }
  function speak(text) {
    if (!('speechSynthesis' in window)) { toast('这个浏览器不支持朗读'); return; }
    var lang = S.settings.accent === 'uk' ? 'en-GB' : 'en-US';
    if (!voices.length) loadVoices();
    var pick = null;
    for (var i = 0; i < voices.length; i++) {
      if (voices[i].lang && voices[i].lang.replace('_', '-').toLowerCase().indexOf(lang.toLowerCase()) === 0) { pick = voices[i]; break; }
    }
    try {
      var u = new SpeechSynthesisUtterance(text);
      u.lang = lang; u.rate = 0.92; u.pitch = 1;
      if (pick) u.voice = pick;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch (e) { toast('朗读失败'); }
  }

  /* ============================== 抽屉控制 ============================= */
  var openSheetId = null;
  function showSheet(id) {
    var el = $(id);
    if (!el) return;
    el.hidden = false;
    openSheetId = id;
    document.body.style.overflow = 'hidden';
  }
  function hideSheet(id) {
    var el = id ? $(id) : (openSheetId ? $(openSheetId) : null);
    if (!el) return;
    el.hidden = true;
    if (openSheetId === (id || openSheetId)) openSheetId = null;
    if (!document.querySelector('.sheet:not([hidden])')) {
      document.body.style.overflow = '';
      openSheetId = null;
    }
  }
  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-close]')) hideSheet();
  });

  /* ============================== toast =============================== */
  var toastTimer = 0;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    requestAnimationFrame(function () { toastEl.classList.add('show'); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove('show');
      setTimeout(function () { toastEl.hidden = true; }, 220);
    }, 1700);
  }

  /* ============================== 翻页 ================================ */
  function goto(page) {
    var p = clamp(page, 0, Math.max(0, lay.pages.length - 1));
    if (p === S.page) return;
    var dir = p > S.page ? 1 : -1;
    S.page = p;
    render();
    turn(dir);
    if (flow.scrollTop) flow.scrollTop = 0;
  }
  function nextPage() { goto(S.page + 1); }
  function prevPage() { goto(S.page - 1); }

  /* ============================== 目录 / 计划卡 ======================== */
  function renderPlanCard() {
    var el = $('planCard');
    if (!el) return;
    if (!S.plan) {
      el.className = 'plan-card empty';
      el.innerHTML = '<div><div class="pc-title">制定学习计划</div>'
        + '<div class="pc-meta" style="margin-top:4px">选天数与每天次数，'
        + '自动生成「今日」任务</div></div>'
        + '<button class="btn primary" data-act="plan-new" style="flex:0 0 auto">去设定</button>';
      return;
    }
    var d = planDone(), day = planDay();
    var pctDay = d.total ? (d.done / d.total * 100) : 0;
    var pctAll = d.all ? (d.allDone / d.all * 100) : 0;
    el.className = 'plan-card';
    el.innerHTML = '<div class="pc-top">'
      + '<span class="pc-title">第 ' + day + ' / ' + S.plan.days + ' 天</span>'
      + '<span class="pc-day">今日 ' + d.done + ' / ' + d.total + '</span></div>'
      + '<div class="pc-bar"><i style="width:' + pctDay.toFixed(1) + '%"></i></div>'
      + '<div class="pc-meta"><span>每天 ' + planRange().perDay + ' 词'
      + ' · 每次 ' + Math.ceil(planRange().perDay / S.plan.sessions) + ' 词</span>'
      + '<span>全书 ' + pctAll.toFixed(1) + '%</span></div>'
      + '<div class="pc-actions">'
      + '<button class="btn primary" data-act="plan-today">背今天的词</button>'
      + '<button class="btn" data-act="plan-today-next">下一个未标记</button>'
      + '<button class="btn" data-act="plan-new">调整</button></div>';
  }

  function buildToc() {
    var rows = S.rows, n = rows.length, k;
    var known = 0;
    for (k in S.marks) if (S.marks[k] === 1) known++;
    var marked = markedCount();
    var cntNew = 0, cntDue = dueCount(), now = Date.now();
    for (k in S.marks) if (S.marks[k] === 2 || S.marks[k] === 3) cntNew++;
    var pr = planRange();

    var defs = [
      ['all', '全部', n],
      ['today', '今日', pr ? pr.end - pr.start : 0],
      ['review', '复习', cntDue],
      ['hi', '高频', hiCount()],
      ['new', '生词', cntNew],
      ['known', '已掌握', known],
      ['unmarked', '未标记', n - marked]
    ];
    $('viewChips').innerHTML = defs.map(function (d) {
      return '<button class="chip' + (S.view === d[0] ? ' on' : '') + '" data-view="' + d[0] + '">'
        + d[1] + ' <b>' + d[2] + '</b></button>';
    }).join('');

    renderPlanCard();
    segOn('segOrderToc', S.settings.order);

    /* 字母索引（仅顺序版可用） */
    var alpha = $('alphaIndex');
    if (S.settings.order === 'shuffle') {
      alpha.innerHTML = '<p class="set-note" style="grid-column:1/-1;margin:0 0 4px">'
        + '乱序版没有字母顺序，A–Z 跳转请切回顺序版（下级目录仍可按 List 跳转）。</p>';
    } else {
      var used = {};
      for (k = 0; k < n; k++) used[rows[k][0][0].toUpperCase() === undefined ? '#' : rows[k][0][0].toUpperCase()] = 1;
      var out = [];
      'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').forEach(function (L) {
        out.push('<button data-pos="' + (used[L] ? alphaPos(L) : -1) + '"'
          + (used[L] ? '' : ' disabled') + '>' + L + '</button>');
      });
      alpha.innerHTML = out.join('');
    }

    /* List 目录（按当前顺序每 50 词一 List） */
    var ord = baseOrder(), parts = [];
    for (var s0 = 0; s0 < n; s0 += LIST_SIZE) {
      var e0 = Math.min(n, s0 + LIST_SIZE), mk = 0;
      for (var j = s0; j < e0; j++) if (S.marks[rows[ord[j]][0]]) mk++;
      var w1 = rows[ord[s0]][0], w2 = rows[ord[e0 - 1]][0];
      parts.push('<button class="toc-item" data-pos="' + s0 + '">'
        + '<span class="toc-no">List ' + pad(Math.floor(s0 / LIST_SIZE) + 1) + '</span>'
        + '<span class="toc-words">' + esc(w1) + ' – ' + esc(w2) + '</span>'
        + '<span class="toc-meta">' + mk + '/' + (e0 - s0) + '</span>'
        + '<span class="toc-bar"><i style="width:' + (mk / (e0 - s0) * 100).toFixed(0) + '%"></i></span>'
        + '</button>');
    }
    $('tocList').innerHTML = parts.join('');
  }

  function hiCount() {
    var c = 0;
    for (var i = 0; i < S.rows.length; i++) if (Core.starLevel(S.rows[i]) >= 1) c++;
    return c;
  }
  function alphaPos(L) {
    for (var i = 0; i < S.rows.length; i++) if (S.rows[i][0][0].toUpperCase() === L) return i;
    return 0;
  }

  function gotoOrderPos(pos) {
    if (pos == null || pos < 0) return;
    if (S.view !== 'all' || S.query.trim()) {
      S.view = 'all'; S.query = ''; syncSearchUI();
      buildLayout();
    }
    var within = Math.min(pos, lay.list.length - 1);
    S.page = Core.pageOf(lay.pages, within);
    render();
    hideSheet('sheetToc');
  }

  function gotoWord(word) {
    var i = S.wordIndex[word];
    if (i == null) return false;
    var within = lay.list.indexOf(i);
    if (within < 0) return false;
    S.page = Core.pageOf(lay.pages, within);
    render();
    return true;
  }

  /* ============================== 详情 =============================== */
  var detailIdx = -1;
  function openDetail(i) {
    var r = S.rows[i];
    if (!r) return;
    detailIdx = i;
    var word = r[0], ph = r[1], pus = r[2], trans = r[3], sents = r[4], syn = r[5], rel = r[6];
    var books = r[7] || 1, frq = r[8] || 0;
    var m = S.marks[word] || 0, rv = S.rev[word];
    var lv = Core.starLevel(r);

    var h = ['<div class="d-head">',
      '<span class="d-w">', esc(word), '</span>'];
    if (lv) h.push('<span class="e-star l' + lv + '" style="font-size:15px">★</span>');
    h.push('<span class="d-ph">',
      ph ? '<span>UK /' + esc(ph) + '/</span>' : '',
      pus ? '<span>US /' + esc(pus) + '/</span>' : '',
      '</span></div>');

    var tags = [];
    if (lv === 2) tags.push('<span class="d-tag hi2">核心高频 ★</span>');
    else if (lv === 1) tags.push('<span class="d-tag hi1">高频 ★</span>');
    if (frq) tags.push('<span class="d-tag">COCA 词频 #' + frq.toLocaleString() + '</span>');
    if (books >= 2) tags.push('<span class="d-tag">收录于 ' + books + ' 份六级词表</span>');
    if (m && rv && rv[1]) {
      var days = Math.max(0, Math.ceil((rv[1] - Date.now()) / DAY));
      tags.push('<span class="d-tag' + (days <= 0 ? ' due' : '') + '">'
        + (days <= 0 ? '今天该复习' : days + ' 天后复习') + ' · 第 ' + rv[0] + ' 次</span>');
    }
    if (tags.length) h.push('<div class="d-meta">' + tags.join('') + '</div>');

    h.push('<div class="d-actions">');
    h.push('<button class="btn" data-act="speak">🔊 发音</button>');
    h.push('<button class="btn' + (m === 1 ? ' on' : '') + '" data-mark="1" data-word="' + esc(word) + '">✓ 已掌握</button>');
    h.push('<button class="btn' + (m === 3 ? ' on' : '') + '" data-mark="3" data-word="' + esc(word) + '">△ 待再看</button>');
    h.push('<button class="btn' + (m === 2 ? ' on' : '') + '" data-mark="2" data-word="' + esc(word) + '">✕ 不熟</button>');
    h.push('</div>');

    h.push('<div class="d-sec"><h3>释义</h3><p class="d-trans">' + transHTML(trans) + '</p></div>');
    if (sents && sents.length) {
      h.push('<div class="d-sec"><h3>例句</h3>');
      sents.forEach(function (x) {
        h.push('<p class="d-sent">' + esc(x[0]) + '</p><p class="d-sent-cn">' + esc(x[1]) + '</p>');
      });
      h.push('</div>');
    }
    if (syn) {
      h.push('<div class="d-sec"><h3>同近义词</h3><div class="d-list">');
      String(syn).split(' / ').forEach(function (line) {
        if (line) h.push('<div>' + esc(line) + '</div>');
      });
      h.push('</div></div>');
    }
    if (rel) {
      h.push('<div class="d-sec"><h3>同根词</h3><div class="d-list">');
      String(rel).split('; ').forEach(function (line) {
        if (!line) return;
        var mm = line.match(/^(\S+)\s+(.*?)(?:\s=\s(.*))?$/);
        if (mm) {
          h.push('<div><span class="pos">' + esc(mm[1]) + '</span>'
            + '<span class="hwd">' + esc(mm[2]) + '</span>'
            + '<span class="cn">' + esc(mm[3] || '') + '</span></div>');
        } else h.push('<div>' + esc(line) + '</div>');
      });
      h.push('</div></div>');
    }
    h.push('<div class="d-sep"></div>');
    $('detailBody').innerHTML = h.join('');
    showSheet('sheetDetail');
  }

  /* ============================== 搜索 =============================== */
  function syncSearchUI() {
    var bar = $('searchbar');
    if (S.query.trim()) { bar.hidden = false; $('searchInput').value = S.query; $('btnSearchClear').hidden = false; }
    updateChrome();
  }

  /* ============================== 设置 =============================== */
  function syncSettingsUI() {
    var s = S.settings;
    app.dataset.theme = s.theme;
    document.documentElement.dataset.theme = s.theme;
    app.style.setProperty('--fs', s.size + 'px');
    var mt = document.querySelector('meta[name="theme-color"]');
    if (mt) mt.setAttribute('content', s.theme === 'night' ? '#14171c' : s.theme === 'clean' ? '#ffffff' : '#f4ebdc');
    $('lblSize').textContent = s.size;
    $('rngSize').value = s.size;
    segOn('segTheme', s.theme);
    segOn('segOrder', s.order);
    segOn('segOrderToc', s.order);
    segOn('segAccent', s.accent);
    segOn('segPerPage', String(s.perPage));
    $('tgSent').setAttribute('aria-checked', s.sentences ? 'true' : 'false');
    $('tgPhon').setAttribute('aria-checked', s.phonetic ? 'true' : 'false');
    $('tgStar').setAttribute('aria-checked', s.showStar ? 'true' : 'false');
    $('tgHide').setAttribute('aria-checked', s.hideKnown ? 'true' : 'false');
  }
  function segOn(id, v) {
    var el = $(id); if (!el) return;
    [].forEach.call(el.querySelectorAll('button'), function (b) {
      b.classList.toggle('on', b.dataset.v === String(v));
    });
  }
  function relayout(anchorWord) { buildLayout(anchorWord); render(); }

  /* 词序切换（两处入口共用） */
  function setOrder(order, reshuffle) {
    if (reshuffle) S.settings.seed = (Math.random() * 4294967295) >>> 0;
    S.settings.order = order;
    saveSettings(); syncSettingsUI();
    S.page = 0;
    relayout();
    toast(order === 'shuffle' ? '已切换到乱序版（顺序版随时可切回）' : '已切换到顺序版');
  }

  /* ============================== 计划 =============================== */
  var planDraft = { days: 30, sessions: 2 };
  function openPlanSheet() {
    if (S.plan) { planDraft.days = S.plan.days; planDraft.sessions = S.plan.sessions; }
    syncPlanSheet();
    showSheet('sheetPlan');
  }
  function syncPlanSheet() {
    segOn('segDays', String(planDraft.days));
    segOn('segSessions', String(planDraft.sessions));
    var nd = $('numDays');
    if (nd && document.activeElement !== nd) nd.value = planDraft.days;
    var per = Math.ceil(S.rows.length / planDraft.days);
    var perS = Math.ceil(per / planDraft.sessions);
    var end = dateAdd(todayStr(), planDraft.days - 1);
    $('planPreview').innerHTML = '每天 <b>' + per + '</b> 词 · 每次 <b>' + perS + '</b> 词'
      + '（每天 ' + planDraft.sessions + ' 次）<br>'
      + '全书 <b>' + S.rows.length + '</b> 词，预计 <b>' + end + '</b> 背完';
  }

  /* ============================== 事件绑定 =========================== */
  function bindEvents() {
    /* 词条：点击 / 长按 */
    flow.addEventListener('pointerdown', function (e) {
      var entry = e.target.closest('.entry');
      if (!entry) return;
      pdX = e.clientX; pdY = e.clientY;
      longFired = false;
      clearTimeout(longTimer);
      longTimer = setTimeout(function () {
        longFired = true;
        openDetail(+entry.dataset.i);
        if (navigator.vibrate) { try { navigator.vibrate(12); } catch (err) {} }
      }, 520);
    });
    flow.addEventListener('pointermove', function (e) {
      if (!longTimer) return;
      if (Math.abs(e.clientX - pdX) > 8 || Math.abs(e.clientY - pdY) > 8) {
        clearTimeout(longTimer); longTimer = 0; longFired = false;
      }
    }, { passive: true });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (t) {
      flow.addEventListener(t, function () { clearTimeout(longTimer); longTimer = 0; });
    });

    flow.addEventListener('click', function (e) {
      var markBtn = e.target.closest('.e-mark');
      var entry = e.target.closest('.entry');
      if (!entry) return;
      if (markBtn) { onMark(S.rows[+entry.dataset.i][0], entry); return; }
      if (longFired) { longFired = false; return; }
      var i = +entry.dataset.i;
      if (e.target.closest('.e-w') || e.target.closest('.e-ph')) speak(S.rows[i][0]);
      else openDetail(i);
    });

    /* 详情抽屉 */
    $('sheetDetail').addEventListener('click', function (e) {
      if (e.target.closest('[data-act="speak"]') && detailIdx >= 0) { speak(S.rows[detailIdx][0]); return; }
      var mk = e.target.closest('[data-mark]');
      if (!mk) return;
      var word = mk.dataset.word, want = +mk.dataset.mark;
      var target = (S.marks[word] || 0) === want ? 0 : want;
      applyMark(word, target);
      openDetail(detailIdx);
      buildLayout(S.rows[detailIdx][0]);
      render();
      var rv = S.rev[word];
      var extra = rv && rv[1] ? ' · ' + Math.max(1, Math.round((rv[1] - Date.now()) / DAY)) + ' 天后复习' : '';
      toast(MARK_NAME[target] + ' · ' + word + extra);
    });

    /* 目录 */
    $('btnToc').onclick = function () { buildToc(); showSheet('sheetToc'); };
    $('btnTitle').onclick = function () { buildToc(); showSheet('sheetToc'); };

    $('sheetToc').addEventListener('click', function (e) {
      var v = e.target.closest('[data-view]');
      if (v) {
        var view = v.dataset.view;
        if (view === 'today' && !S.plan) { openPlanSheet(); return; }
        S.view = view;
        S.page = 0;
        buildToc();
        relayout();
        hideSheet('sheetToc');
        if (!lay.pages.length) toast(view === 'review' ? '今天没有到期的复习' : '这个视图暂时是空的');
        return;
      }
      var pos = e.target.closest('[data-pos]');
      if (pos) { gotoOrderPos(+pos.dataset.pos); return; }
      var act = e.target.closest('[data-act]');
      if (!act) return;
      var a = act.dataset.act;
      if (a === 'plan-new') { hideSheet('sheetToc'); openPlanSheet(); }
      else if (a === 'plan-today') {
        S.view = 'today'; S.page = 0;
        relayout();
        hideSheet('sheetToc');
        toast('今日任务：' + lay.list.length + ' 词');
      } else if (a === 'plan-today-next') {
        gotoNextUnmarkedToday();
      }
    });

    $('btnReshuffle').onclick = function () { setOrder('shuffle', true); buildToc(); };

    /* 设置里的词序 */
    function onOrderBtn(e) {
      var b = e.target.closest('button[data-v]');
      if (!b) return;
      if (b.dataset.v === S.settings.order) return;
      setOrder(b.dataset.v);
      if (!$('sheetToc').hidden) buildToc();
    }
    $('segOrder').addEventListener('click', onOrderBtn);
    $('segOrderToc').addEventListener('click', onOrderBtn);

    /* 计划抽屉 */
    $('segDays').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      planDraft.days = +b.dataset.v; syncPlanSheet();
    });
    $('segSessions').addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      planDraft.sessions = +b.dataset.v; syncPlanSheet();
    });
    $('numDays').addEventListener('input', function () {
      var v = parseInt(this.value, 10);
      if (!isNaN(v) && v >= 3) { planDraft.days = Math.min(v, 365); syncPlanSheet(); }
    });
    $('btnPlanStart').onclick = function () {
      var isNew = !S.plan;
      S.plan = {
        start: isNew ? todayStr() : (S.plan.start || todayStr()),
        days: planDraft.days,
        sessions: planDraft.sessions
      };
      savePlan();
      S.view = 'today'; S.page = 0;
      relayout();
      hideSheet('sheetPlan'); hideSheet('sheetToc');
      updateChrome();
      toast('计划已保存：' + S.plan.days + ' 天 · 每天 '
        + Math.ceil(S.rows.length / S.plan.days) + ' 词');
    };
    $('btnPlanEnd').onclick = function () {
      if (!S.plan) { toast('当前没有计划'); return; }
      S.plan = null;
      savePlan();
      S.view = 'all'; S.page = 0;
      relayout();
      hideSheet('sheetPlan');
      updateChrome();
      toast('已结束计划（标记与复习记录都保留）');
    };

    /* 搜索 */
    var sInput = $('searchInput'), sTimer = 0;
    $('btnSearch').onclick = function () {
      $('searchbar').hidden = false;
      setTimeout(function () { sInput.focus(); }, 30);
    };
    $('btnSearchClose').onclick = function () {
      $('searchbar').hidden = true;
      sInput.value = '';
      if (S.query) { S.query = ''; S.page = 0; syncSearchUI(); relayout(); }
      $('btnSearchClear').hidden = true;
      updateChrome();
    };
    $('btnSearchClear').onclick = function () {
      sInput.value = ''; S.query = ''; S.page = 0;
      $('btnSearchClear').hidden = true;
      syncSearchUI(); relayout();
    };
    sInput.addEventListener('input', function () {
      var v = sInput.value;
      $('btnSearchClear').hidden = !v;
      clearTimeout(sTimer);
      sTimer = setTimeout(function () {
        S.query = v; S.page = 0;
        syncSearchUI();
        buildLayout();
        render();
        if (v.trim() && !lay.pages.length) toast('没有匹配的单词');
      }, 150);
    });
    sInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') sInput.blur(); });

    /* 设置 */
    $('btnSettings').onclick = function () {
      syncSettingsUI();
      $('countText').textContent = S.rows.length + ' 词';
      updateChrome();
      showSheet('sheetSet');
    };
    segOn_bind('segTheme', function (v) { S.settings.theme = v; saveSettings(); syncSettingsUI(); relayout(curWord()); });
    segOn_bind('segAccent', function (v) { S.settings.accent = v; saveSettings(); syncSettingsUI(); });
    segOn_bind('segPerPage', function (v) { S.settings.perPage = +v; saveSettings(); syncSettingsUI(); relayout(curWord()); });
    $('rngSize').addEventListener('input', function () {
      S.settings.size = +this.value;
      $('lblSize').textContent = this.value;
      app.style.setProperty('--fs', this.value + 'px');
    });
    $('rngSize').addEventListener('change', function () { saveSettings(); relayout(curWord()); });
    $('tgSent').onclick = function () {
      S.settings.sentences = !S.settings.sentences; saveSettings(); syncSettingsUI(); relayout(curWord());
    };
    $('tgPhon').onclick = function () {
      S.settings.phonetic = !S.settings.phonetic; saveSettings(); syncSettingsUI(); relayout(curWord());
    };
    $('tgStar').onclick = function () {
      S.settings.showStar = !S.settings.showStar; saveSettings(); syncSettingsUI(); relayout(curWord());
    };
    $('tgHide').onclick = function () {
      S.settings.hideKnown = !S.settings.hideKnown; saveSettings(); syncSettingsUI();
      S.page = 0; relayout();
    };
    $('btnReset').onclick = function () {
      if (!confirm('清空全部标记与复习记录？此操作不可恢复。')) return;
      S.marks = {}; S.rev = {};
      writeJSON(LS_MARK, {}); writeJSON(LS_REV, {});
      relayout(); updateChrome(); toast('已清空全部记录');
    };
    $('btnExportMark').onclick = function () {
      var lines = ['word,phonetic,meaning,mark,review_rep,next_review'];
      Object.keys(S.marks).sort().forEach(function (w) {
        var i = S.wordIndex[w]; if (i == null) return;
        var r = S.rows[i], rv = S.rev[w] || [0, 0];
        lines.push(csv([r[0], r[1] || '', Core.transText(r[3]), MARK_NAME[S.marks[w]] || '',
          rv[0] || '', rv[1] ? todayStr(new Date(rv[1])) : '']));
      });
      if (lines.length === 1) { toast('还没有标记任何单词'); return; }
      download('六级生词-' + dateStr() + '.csv', lines.join('\r\n'));
      toast('已导出 ' + (lines.length - 1) + ' 个单词');
    };
    $('btnExportAll').onclick = function () {
      var lines = ['word,phonetic,phonetic_us,meaning,frq,example,example_cn'];
      S.rows.forEach(function (r) {
        var s0 = (r[4] && r[4][0]) || ['', ''];
        lines.push(csv([r[0], r[1] || '', r[2] || '', Core.transText(r[3]), r[8] || '', s0[0], s0[1]]));
      });
      download('六级词汇-' + dateStr() + '.csv', lines.join('\r\n'));
      toast('已导出全部 ' + S.rows.length + ' 词');
    };
    $('btnPrint').onclick = function () {
      var keep = flow.innerHTML, keepPage = S.page;
      flow.innerHTML = lay.list.map(entryHTML).join('');
      setTimeout(function () {
        window.print();
        setTimeout(function () { S.page = keepPage; flow.innerHTML = keep; }, 600);
      }, 60);
    };

    /* 翻页 / 键盘 / 手势 */
    btnPrev.onclick = prevPage;
    btnNext.onclick = nextPage;
    document.addEventListener('keydown', function (e) {
      if (e.target && /input|textarea/i.test(e.target.tagName)) return;
      if (e.key === 'ArrowLeft' || e.key === 'PageUp' || e.key === 'k') { prevPage(); e.preventDefault(); }
      else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ' || e.key === 'j') { nextPage(); e.preventDefault(); }
      else if (e.key === 'Escape') hideSheet();
    });

    var tx = 0, ty = 0, tt = 0;
    paper.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) return;
      tx = e.touches[0].clientX; ty = e.touches[0].clientY; tt = Date.now();
    }, { passive: true });
    paper.addEventListener('touchend', function (e) {
      if (e.touches.length || !e.changedTouches.length) return;
      var dx = e.changedTouches[0].clientX - tx;
      var dy = e.changedTouches[0].clientY - ty;
      if (Date.now() - tt > 900) return;
      if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.6) {
        if (dx < 0) nextPage(); else prevPage();
      }
    }, { passive: true });

    var rz = 0;
    function onResize() {
      clearTimeout(rz);
      rz = setTimeout(function () { relayout(curWord()); }, 180);
    }
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);

    if ('speechSynthesis' in window) {
      loadVoices();
      window.speechSynthesis.onvoiceschanged = loadVoices;
    }
  }

  function gotoNextUnmarkedToday() {
    if (!S.plan) { openPlanSheet(); return; }
    if (S.view !== 'today') { S.view = 'today'; S.page = 0; relayout(); }
    var ord = baseOrder(), pr = planRange();
    for (var k = pr.start; k < pr.end; k++) {
      var i = ord[k];
      if (!(S.marks[S.rows[i][0]] || 0)) {
        var within = lay.list.indexOf(i);
        if (within >= 0) { S.page = Core.pageOf(lay.pages, within); render(); }
        toast('今天的下一个：' + S.rows[i][0]);
        return;
      }
    }
    toast('今天的词都标记完了 🎉');
  }

  function segOn_bind(id, fn) {
    var el = $(id); if (!el) return;
    el.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      fn(b.dataset.v);
    });
  }

  function curWord() {
    var p = lay.pages[S.page];
    if (!p) return null;
    var i = lay.list[p[0]];
    return i != null && S.rows[i] ? S.rows[i][0] : null;
  }
  function csv(cells) {
    return cells.map(function (c) {
      var s = String(c == null ? '' : c);
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',');
  }
  function dateStr() {
    var d = new Date();
    return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
  }
  function download(name, text) {
    var blob = new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  }

  /* ============================== 载入数据 ============================= */
  function setProgress(p) { if (ldBar) ldBar.style.width = (clamp(p, 0, 1) * 100).toFixed(1) + '%'; }

  async function fetchWords() {
    if (window.__WORDS_INLINE__) { setProgress(1); ldHint.textContent = '内置词库'; return window.__WORDS_INLINE__; }
    var res = await fetch('./data/words.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var total = +(res.headers.get('content-length') || 0);
    if (!res.body || !res.body.getReader || !total) return res.json();
    var reader = res.body.getReader(), chunks = [], got = 0;
    for (;;) {
      var step = await reader.read();
      if (step.done) break;
      chunks.push(step.value); got += step.value.length;
      setProgress(got / total);
      ldHint.textContent = (got / 1024 / 1024).toFixed(1) + ' MB';
    }
    var buf = new Uint8Array(got), off = 0;
    chunks.forEach(function (c) { buf.set(c, off); off += c.length; });
    return JSON.parse(new TextDecoder('utf-8').decode(buf));
  }

  /* ============================== 诊断 ================================ */
  function emitDiag(ms) {
    if (!/[?&]diag\b/.test(location.search + location.hash)) return;
    var kids = [].slice.call(flow.children).filter(function (n) { return n.classList.contains('entry'); });
    var fr = flow.getBoundingClientRect();
    var rects = kids.map(function (k) { return k.getBoundingClientRect(); });
    var overlap = rects.some(function (r, i) { return i > 0 && r.top < rects[i - 1].bottom - 0.6; });
    var hiddenTrans = kids.filter(function (k) {
      var t = k.querySelector('.e-t');
      if (!t) return true;
      var cs = getComputedStyle(t);
      return cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.5 || !t.textContent.trim();
    }).length;
    var chinese = kids.filter(function (k) {
      var t = k.querySelector('.e-t');
      return t && /[\u4e00-\u9fff]/.test(t.textContent);
    }).length;
    var last = rects[rects.length - 1];
    var widest = null, widestRight = 0;
    [].forEach.call(app.querySelectorAll('*'), function (n) {
      var r = n.getBoundingClientRect();
      if (r.width > 0 && r.right > widestRight) {
        widestRight = r.right;
        widest = (n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') +
          (typeof n.className === 'string' && n.className ? '.' + n.className.trim().split(/\s+/).join('.') : ''));
      }
    });
    var d = {
      version: VERSION,
      vw: window.innerWidth,
      docScrollW: document.documentElement.scrollWidth,
      appW: Math.round(app.getBoundingClientRect().width),
      flowW: Math.round(flow.getBoundingClientRect().width),
      widest: widest,
      widestRight: Math.round(widestRight),
      words: S.rows.length,
      view: S.view,
      order: S.settings.order,
      theme: S.settings.theme,
      fontSize: S.settings.size,
      plan: S.plan ? (S.plan.days + 'd/' + S.plan.sessions + 'x') : null,
      planDay: S.plan ? planDay() : null,
      page: S.page + 1,
      pages: lay.pages.length,
      listLen: lay.list.length,
      entriesOnPage: kids.length,
      starsOnPage: kids.filter(function (k) { return !!k.querySelector('.e-star'); }).length,
      flowH: Math.round(flow.clientHeight),
      usedH: Math.round(rects.reduce(function (a, r) { return a + r.height; }, 0)),
      bottomGap: last ? Math.round(fr.bottom - last.bottom) : null,
      overflowPx: Math.round(flow.scrollHeight - flow.clientHeight),
      overlap: overlap,
      entriesWithoutChinese: kids.length - chinese,
      hiddenTrans: hiddenTrans,
      sheet: openSheetId,
      buildMs: Math.round(ms || 0),
      title: runRight.textContent
    };
    document.documentElement.setAttribute('data-diag', JSON.stringify(d));
  }

  /* ============================== 启动 ================================ */
  async function boot() {
    loadState();
    syncSettingsUI();
    bindEvents();
    var t0 = performance.now();
    var rows;
    try {
      rows = await fetchWords();
    } catch (err) {
      ldHint.textContent = '加载失败：' + err.message;
      ldHint.style.color = '#a33327';
      return;
    }
    S.rows = rows;
    for (var i = 0; i < rows.length; i++) S.wordIndex[rows[i][0]] = i;

    setProgress(1);
    var q = new URLSearchParams(location.search);
    var forceView = q.get('view');
    if (forceView && VIEW_LABEL[forceView]) S.view = forceView;
    else if (S.posView && VIEW_LABEL[S.posView]) S.view = S.posView;
    if (S.view === 'today' && !S.plan) S.view = 'all';
    var forceOrder = q.get('order');
    if (forceOrder === 'shuffle' || forceOrder === 'alpha') S.settings.order = forceOrder;

    var anchor = S.posWord || null;
    buildLayout(anchor);
    render();
    syncSearchUI();
    updateChrome();

    var bootMs = performance.now() - t0;
    loadingEl.classList.add('out');
    setTimeout(function () { loadingEl.hidden = true; }, 320);

    /* 首帧后视口/字体稳定的再次排版 */
    requestAnimationFrame(function () {
      if (heightSig() !== hSig) { buildLayout(curWord()); render(); }
      var open = q.get('sheet');
      if (open === 'detail') openDetail(lay.list[0]);
      else if (open === 'plan') { S.view = 'all'; buildToc(); openPlanSheet(); }
      else if (open === 'toc') { buildToc(); showSheet('sheetToc'); }
      else if (open === 'set') { syncSettingsUI(); showSheet('sheetSet'); }
      emitDiag(performance.now() - t0);
    });

    if (!readJSON(LS_HINT, 0)) {
      setTimeout(function () {
        toast('轻点释义看例句 · 长按词条看详情 · 右侧圆点做标记');
        writeJSON(LS_HINT, 1);
      }, 800);
    }

    if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
      navigator.serviceWorker.register('./sw.js').catch(function () {});
    }
  }

  if (typeof window !== 'undefined') {
    window.__CET6__ = {
      S: S, lay: lay, Core: Core, render: render, buildLayout: buildLayout,
      emitDiag: emitDiag, openDetail: openDetail, openPlanSheet: openPlanSheet,
      setOrder: setOrder, planRange: planRange, planDone: planDone, dueCount: dueCount
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
