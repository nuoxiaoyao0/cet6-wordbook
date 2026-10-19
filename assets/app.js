/* ============================================================================
   六级词汇 · 书页模式
   一份「不遮中文」的电子单词书：单词在上，音标、词性、释义紧接着在下，
   每页由 JS 按真实行高精确排满一屏 —— 不需要翻卡，也不会有滚动条。
   ==========================================================================*/
(function () {
  'use strict';

  var VERSION = '1.0.0';
  var LS_SET = 'cet6.book.settings.v1';
  var LS_MARK = 'cet6.book.marks.v1';
  var LS_POS = 'cet6.book.pos.v1';
  var LS_HINT = 'cet6.book.hint.v1';
  var LIST_SIZE = 50;

  /* ========================= 纯逻辑（可在 node 中测试） ===================== */
  var Core = {
    transText: function (trans) {
      if (!trans || !trans.length) return '';
      return trans.map(function (t) { return (t[0] ? t[0] + '. ' : '') + t[1]; }).join('；');
    },

    filterIndices: function (rows, marks, view, query, hideKnown) {
      var q = (query || '').trim().toLowerCase();
      var out = [];
      for (var i = 0; i < rows.length; i++) {
        var w = rows[i];
        var m = marks[w[0]] || 0;
        if (view === 'new' && !(m === 2 || m === 3)) continue;
        if (view === 'known' && m !== 1) continue;
        if (view === 'unmarked' && m !== 0) continue;
        if (view === 'all' && hideKnown && m === 1) continue;
        if (q) {
          var word = w[0].toLowerCase();
          var cn = Core.transText(w[3]);
          if (word.indexOf(q) < 0 && cn.indexOf(q) < 0) continue;
        }
        out.push(i);
      }
      if (q) {
        out.sort(function (a, b) {
          var wa = rows[a][0].toLowerCase(), wb = rows[b][0].toLowerCase();
          var sa = wa.indexOf(q) === 0 ? 0 : 1, sb = wb.indexOf(q) === 0 ? 0 : 1;
          if (sa !== sb) return sa - sb;
          if (wa.length !== wb.length) return wa.length - wb.length;
          return wa < wb ? -1 : wa > wb ? 1 : 0;
        });
      }
      return out;
    },

    /* 贪心按高度切页；perPage>0 时按固定词数切 */
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

    lowerBoundAsc: function (arr, target) {
      var lo = 0, hi = arr.length;
      while (lo < hi) { var mid = (lo + hi) >> 1; if (arr[mid] < target) lo = mid + 1; else hi = mid; }
      return lo;
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
  if (typeof document === 'undefined') return;   /* node：只导出纯逻辑 */

  /* ================================ 状态 ================================= */
  var S = {
    rows: [],
    marks: {},
    view: 'all',
    query: '',
    page: 0,
    settings: {
      size: 16, sentences: true, phonetic: true, theme: 'paper',
      perPage: 0, order: 'alpha', seed: 1, accent: 'us', hideKnown: false
    }
  };

  var lay = { list: [], pages: [], heights: [] };
  var hCache = new Map();
  var hSig = '';
  var longFired = false;
  var longTimer = 0;

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

  /* ============================== 持久化 ================================ */
  function readJSON(key, fallback) {
    try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
    catch (e) { return fallback; }
  }
  function writeJSON(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* 隐私模式等 */ }
  }
  function loadState() {
    var st = readJSON(LS_SET, null);
    if (st) for (var k in S.settings) if (st[k] !== undefined) S.settings[k] = st[k];
    var mk = readJSON(LS_MARK, null);
    if (mk && typeof mk === 'object') S.marks = mk;
    var pos = readJSON(LS_POS, null);
    if (pos && pos.word) S.posWord = pos.word;
  }
  var markSaveTimer = 0;
  function saveMarks() {
    clearTimeout(markSaveTimer);
    markSaveTimer = setTimeout(function () { writeJSON(LS_MARK, S.marks); }, 250);
  }
  function saveSettings() { writeJSON(LS_SET, S.settings); }
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

  function entryHTML(i) {
    var r = S.rows[i];
    if (!r) return '';
    var word = r[0], ph = r[1], trans = r[3], sents = r[4];
    var m = S.marks[word] || 0, s = S.settings;
    var phHTML = (s.phonetic && ph) ? '<span class="e-ph">/' + esc(ph) + '/</span>' : '<span class="e-ph"></span>';
    var sHTML = '';
    if (s.sentences && sents && sents.length) {
      /* 只放第一条例句，一行到底；更多例句留在详情里 */
      var x = sents[0];
      sHTML = '<div class="e-s"><span class="s-en">' + esc(x[0]) + '</span>'
        + '<span class="s-cn">' + esc(x[1]) + '</span></div>';
    }
    return '<div class="entry marked-' + m + '" data-i="' + i + '">'
      + '<span class="rail"></span>'
      + '<div class="e-head">'
      + '<span class="e-w">' + esc(word) + '</span>' + phHTML
      + '<button class="e-mark m' + m + '" data-act="mark" aria-label="标记">' + markGlyph(m) + '</button>'
      + '</div>'
      + '<div class="e-t">' + transHTML(trans) + '</div>'
      + sHTML
      + '</div>';
  }

  /* ============================ 布局 / 分页 ============================= */
  function heightSig() {
    return [S.settings.size, S.settings.sentences ? 1 : 0, S.settings.phonetic ? 1 : 0,
      S.settings.theme, flow.clientWidth].join('|');
  }

  function computeList() {
    var base = Core.filterIndices(S.rows, S.marks, S.view, S.query,
      S.settings.hideKnown && S.view === 'all');
    if (S.query.trim() || S.settings.order === 'alpha' || S.view !== 'all') return base;
    var sh = Core.seededShuffle(S.rows.length, S.settings.seed);
    var rank = new Map();
    for (var k = 0; k < sh.length; k++) rank.set(sh[k], k);
    base.sort(function (a, b) { return rank.get(a) - rank.get(b); });
    return base;
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

  var VIEW_LABEL = { all: '全部', 'new': '生词', known: '已掌握', unmarked: '未标记' };

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
      updateProgress();
      return;
    }
    S.page = clamp(S.page, 0, total - 1);
    var p = lay.pages[S.page];
    var slice = lay.list.slice(p[0], p[1]);
    flow.innerHTML = slice.map(entryHTML).join('');
    /* 固定词数模式可能超出页面高度：此时允许滚动，避免任何内容被裁掉 */
    flow.classList.toggle('scrollable', flow.scrollHeight - flow.clientHeight > 2);

    /* 书页页眉 */
    var firstIdx = slice[0], lastIdx = slice[slice.length - 1];
    var head = S.query.trim() ? '搜索 “' + S.query.trim() + '”' : (VIEW_LABEL[S.view] || '全部');
    runLeft.textContent = '六级词汇 · ' + head;
    var firstWord = S.rows[firstIdx][0], lastWord = S.rows[lastIdx][0];
    var listTag = '';
    if (S.settings.order === 'alpha' || S.view !== 'all') {
      var l1 = Math.floor(firstIdx / LIST_SIZE) + 1, l2 = Math.floor(lastIdx / LIST_SIZE) + 1;
      listTag = 'List ' + pad(l1) + (l2 !== l1 ? '–' + pad(l2) : '');
    } else {
      listTag = '乱序';
    }
    runRight.textContent = listTag + ' · ' + firstWord + ' – ' + lastWord;

    pagenum.textContent = '— ' + (S.page + 1) + ' —';
    pageInfo.textContent = (S.page + 1) + ' / ' + total;
    wordRange.textContent = '第 ' + (p[0] + 1) + '–' + p[1] + ' 词 · 共 ' + lay.list.length;
    btnPrev.disabled = S.page === 0;
    btnNext.disabled = S.page >= total - 1;
    updateProgress();
    savePos();
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function updateProgress() {
    var marked = 0, n = S.rows.length;
    for (var k in S.marks) if (S.marks[k]) marked++;
    var pct = n ? (marked / n) * 100 : 0;
    progressRail.style.width = pct.toFixed(2) + '%';
    var st = $('statNote');
    if (st) st.textContent = '共 ' + n + ' 词 · 已标记 ' + marked + ' 词（' + pct.toFixed(1) + '%）';
  }

  /* ============================== 交互：标记 ============================= */
  function cycleMark(word) {
    var m = S.marks[word] || 0;
    var next = m === 0 ? 1 : m === 1 ? 3 : m === 3 ? 2 : 0;
    if (next === 0) delete S.marks[word]; else S.marks[word] = next;
    saveMarks();
    return next;
  }

  function refreshEntry(el, word) {
    var m = S.marks[word] || 0;
    el.className = 'entry marked-' + m;
    var btn = el.querySelector('.e-mark');
    if (btn) { btn.className = 'e-mark m' + m; btn.textContent = markGlyph(m); }
  }

  var MARK_NAME = { 0: '已清除标记', 1: '已掌握', 2: '不熟', 3: '待再看' };

  function onMark(word, el) {
    var next = cycleMark(word);
    if (el && S.view === 'all' && !S.settings.hideKnown) {
      refreshEntry(el, word);          /* 不用重排，翻页时不跳动 */
    } else {
      buildLayout(S.rows[el ? +el.dataset.i : 0][0]);
      render();
    }
    updateProgress();
    toast(MARK_NAME[next] + ' · ' + word);
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
  var openSheet = null;
  function showSheet(id) {
    var el = $(id);
    if (!el) return;
    el.hidden = false;
    openSheet = el;
    document.body.style.overflow = 'hidden';
  }
  function hideSheet(id) {
    var el = id ? $(id) : openSheet;
    if (!el) return;
    el.hidden = true;
    if (openSheet === el) openSheet = null;
    if (!document.querySelector('.sheet:not([hidden])')) document.body.style.overflow = '';
  }
  document.addEventListener('click', function (e) {
    var closer = e.target.closest('[data-close]');
    if (closer) { hideSheet(); }
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
    }, 1500);
  }

  /* ============================== 翻页 ================================ */
  function goto(page) {
    var p = clamp(page, 0, Math.max(0, lay.pages.length - 1));
    if (p === S.page) return;
    S.page = p;
    render();
    flow.scrollTop = 0;
  }
  function nextPage() { goto(S.page + 1); }
  function prevPage() { goto(S.page - 1); }

  /* ============================== 目录 ================================ */
  function buildToc() {
    var toc = $('tocList');
    var rows = S.rows, n = rows.length;
    var known = 0, marked = 0;
    for (var k in S.marks) if (S.marks[k]) { marked++; if (S.marks[k] === 1) known++; }

    var chips = $('viewChips');
    var defs = [['all', '全部', n], ['new', '生词', markedKnown(2) + markedKnown(3)],
      ['known', '已掌握', known], ['unmarked', '未标记', n - marked]];
    chips.innerHTML = defs.map(function (d) {
      return '<button class="chip' + (S.view === d[0] ? ' on' : '') + '" data-view="' + d[0] + '">'
        + d[1] + ' <b>' + d[2] + '</b></button>';
    }).join('');

    var letters = {}, used = {};
    for (var i = 0; i < n; i++) {
      var c0 = rows[i][0][0].toUpperCase();
      if (!(c0 >= 'A' && c0 <= 'Z')) c0 = '#';
      if (!letters[c0]) { letters[c0] = i; used[c0] = 0; }
      used[c0]++;
    }
    var alpha = $('alphaIndex');
    var out = [];
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').forEach(function (L) {
      out.push('<button data-letter="' + L + '"' + (used[L] ? '' : ' disabled') + '>' + L + '</button>');
    });
    if (used['#']) out.push('<button data-letter="#">#</button>');
    alpha.innerHTML = out.join('');

    var parts = [];
    for (var s0 = 0; s0 < n; s0 += LIST_SIZE) {
      var e0 = Math.min(n, s0 + LIST_SIZE);
      var mk = 0;
      for (var j = s0; j < e0; j++) if (S.marks[rows[j][0]]) mk++;
      parts.push('<button class="toc-item" data-pos="' + s0 + '">'
        + '<span class="toc-no">List ' + pad(Math.floor(s0 / LIST_SIZE) + 1) + '</span>'
        + '<span class="toc-words">' + esc(rows[s0][0]) + ' – ' + esc(rows[e0 - 1][0]) + '</span>'
        + '<span class="toc-meta">' + (e0 - s0) + ' 词</span>'
        + '<span class="toc-bar"><i style="width:' + (mk / (e0 - s0) * 100).toFixed(0) + '%"></i></span>'
        + '</button>');
    }
    toc.innerHTML = parts.join('');

    function markedKnown(v) { var c = 0; for (var kk in S.marks) if (S.marks[kk] === v) c++; return c; }
  }

  function gotoAlphaPos(pos) {
    if (S.view !== 'all' || S.query.trim()) {
      S.view = 'all'; S.query = ''; syncSearchUI();
      toast('已回到「全部」视图');
    }
    if (S.settings.order !== 'alpha') { S.settings.order = 'alpha'; saveSettings(); syncSettingsUI(); }
    buildLayout();
    var within = Core.lowerBoundAsc(lay.list, pos);
    S.page = Core.pageOf(lay.pages, Math.min(within, lay.list.length - 1));
    render();
    hideSheet('sheetToc');
  }

  function jumpToRowIndex(rowIdx) {
    var within = lay.list.indexOf(rowIdx);
    if (within < 0) return false;
    S.page = Core.pageOf(lay.pages, within);
    return true;
  }

  /* ============================== 详情 =============================== */
  var detailIdx = -1;
  function openDetail(i) {
    var r = S.rows[i];
    if (!r) return;
    detailIdx = i;
    var word = r[0], ph = r[1], pus = r[2], trans = r[3], sents = r[4], syn = r[5], rel = r[6];
    var m = S.marks[word] || 0;
    var h = ['<div class="d-head">',
      '<span class="d-w">', esc(word), '</span>',
      '<span class="d-ph">',
      ph ? '<span>UK /' + esc(ph) + '/</span>' : '',
      pus ? '<span>US /' + esc(pus) + '/</span>' : '',
      '</span></div>'];
    h.push('<div class="d-actions">');
    h.push('<button class="btn" data-act="speak">🔊 发音</button>');
    h.push('<button class="btn' + (m === 1 ? ' on' : '') + '" data-mark="1" data-word="' + esc(word) + '">✓ 已掌握</button>');
    h.push('<button class="btn' + (m === 3 ? ' on' : '') + '" data-mark="3" data-word="' + esc(word) + '">△ 待再看</button>');
    h.push('<button class="btn' + (m === 2 ? ' on' : '') + '" data-mark="2" data-word="' + esc(word) + '">✕ 不熟</button>');
    h.push('</div>');

    h.push('<div class="d-sec"><h3>释义</h3><p class="d-trans">' + transHTML(trans) + '</p></div>');
    if ((r[7] || 1) >= 2) {
      h.push('<div class="d-sec"><h3>词表</h3><p class="d-sent-cn">收录于 ' + r[7]
        + ' 份六级词表 · 核心词</p></div>');
    }
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
        if (!line) return;
        h.push('<div>' + esc(line) + '</div>');
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
    $('subTitle').textContent = S.query.trim() ? '搜索中' : (VIEW_LABEL[S.view] || '书页模式');
  }

  /* ============================== 设置 =============================== */
  function syncSettingsUI() {
    var s = S.settings;
    app.dataset.theme = s.theme;
    app.style.setProperty('--fs', s.size + 'px');
    var mt = document.querySelector('meta[name="theme-color"]');
    if (mt) mt.setAttribute('content', s.theme === 'night' ? '#14171c' : s.theme === 'clean' ? '#ffffff' : '#f4ebdc');
    $('lblSize').textContent = s.size;
    $('rngSize').value = s.size;
    segOn('segTheme', s.theme);
    segOn('segOrder', s.order);
    segOn('segAccent', s.accent);
    segOn('segPerPage', String(s.perPage));
    $('tgSent').setAttribute('aria-checked', s.sentences ? 'true' : 'false');
    $('tgPhon').setAttribute('aria-checked', s.phonetic ? 'true' : 'false');
    $('tgHide').setAttribute('aria-checked', s.hideKnown ? 'true' : 'false');
  }
  function segOn(id, v) {
    var el = $(id); if (!el) return;
    [].forEach.call(el.querySelectorAll('button'), function (b) {
      b.classList.toggle('on', b.dataset.v === String(v));
    });
  }

  function relayout(anchorWord) {
    buildLayout(anchorWord);
    render();
  }

  /* ============================== 事件绑定 ============================= */
  function bindEvents() {
    /* 词条点击 / 长按 */
    var pdX = 0, pdY = 0;
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
      var sp = e.target.closest('[data-act="speak"]');
      if (sp && detailIdx >= 0) { speak(S.rows[detailIdx][0]); return; }
      var mk = e.target.closest('[data-mark]');
      if (mk) {
        var word = mk.dataset.word, want = +mk.dataset.mark;
        if ((S.marks[word] || 0) === want) delete S.marks[word]; else S.marks[word] = want;
        saveMarks();
        openDetail(detailIdx);
        buildLayout(S.rows[detailIdx][0]);
        render();
        updateProgress();
        toast(MARK_NAME[S.marks[word] || 0] + ' · ' + word);
      }
    });

    /* 目录 */
    $('btnToc').onclick = function () { buildToc(); showSheet('sheetToc'); };
    $('btnTitle').onclick = function () { buildToc(); showSheet('sheetToc'); };
    $('viewChips').addEventListener('click', function (e) {
      var b = e.target.closest('[data-view]');
      if (!b) return;
      S.view = b.dataset.view;
      S.query = ''; syncSearchUI();
      S.page = 0;
      buildToc();
      relayout();
      $('subTitle').textContent = VIEW_LABEL[S.view];
      if (!lay.pages.length) toast('这个视图暂时是空的');
      hideSheet('sheetToc');
    });
    $('alphaIndex').addEventListener('click', function (e) {
      var b = e.target.closest('[data-letter]');
      if (!b || b.disabled) return;
      var L = b.dataset.letter, rows = S.rows, pos = -1;
      for (var i = 0; i < rows.length; i++) {
        var c0 = rows[i][0][0].toUpperCase();
        if (!(c0 >= 'A' && c0 <= 'Z')) c0 = '#';
        if (c0 === L) { pos = i; break; }
      }
      if (pos < 0) return;
      gotoAlphaPos(pos);
      toast('跳到 ' + L);
    });
    $('tocList').addEventListener('click', function (e) {
      var b = e.target.closest('[data-pos]');
      if (!b) return;
      gotoAlphaPos(+b.dataset.pos);
    });

    /* 搜索 */
    var sInput = $('searchInput'), sTimer = 0;
    $('btnSearch').onclick = function () {
      $('searchbar').hidden = false;
      setTimeout(function () { sInput.focus(); }, 30);
    };
    $('btnSearchClose').onclick = function () {
      $('searchbar').hidden = true;
      sInput.value = '';
      if (S.query) { S.query = ''; S.view = 'all'; S.page = 0; syncSearchUI(); relayout(); }
      $('btnSearchClear').hidden = true;
      $('subTitle').textContent = VIEW_LABEL[S.view] || '书页模式';
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
      }, 160);
    });
    sInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') sInput.blur(); });

    /* 设置 */
    $('btnSettings').onclick = function () {
      syncSettingsUI();
      $('countText').textContent = S.rows.length + ' 词';
      showSheet('sheetSet');
    };
    segOn_bind('segTheme', function (v) { S.settings.theme = v; saveSettings(); syncSettingsUI(); relayout(curWord()); });
    segOn_bind('segOrder', function (v) {
      if (v === 'reshuffle') {
        S.settings.seed = (Math.random() * 4294967295) >>> 0;
        S.settings.order = 'shuffle';
      } else S.settings.order = v;
      saveSettings(); syncSettingsUI();
      S.page = 0; relayout();
    });
    segOn_bind('segAccent', function (v) { S.settings.accent = v; saveSettings(); syncSettingsUI(); });
    segOn_bind('segPerPage', function (v) {
      S.settings.perPage = +v; saveSettings(); syncSettingsUI(); relayout(curWord());
    });
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
    $('tgHide').onclick = function () {
      S.settings.hideKnown = !S.settings.hideKnown; saveSettings(); syncSettingsUI();
      S.page = 0; relayout();
    };
    $('btnReset').onclick = function () {
      if (!confirm('清空全部标记？此操作不可恢复。')) return;
      S.marks = {}; writeJSON(LS_MARK, {});
      relayout(); updateProgress(); toast('已清空全部标记');
    };
    $('btnExportMark').onclick = function () {
      var lines = ['word,phonetic,meaning,mark'];
      var order = ['1', '3', '2'];
      Object.keys(S.marks).sort().forEach(function (w) {
        var i = S.wordIndex[w]; if (i == null) return;
        var r = S.rows[i];
        lines.push(csv([r[0], r[1] || '', Core.transText(r[3]), MARK_NAME[S.marks[w]] || '']));
      });
      if (lines.length === 1) { toast('还没有标记任何单词'); return; }
      download('六级生词-' + dateStr() + '.csv', lines.join('\r\n'));
      toast('已导出 ' + (lines.length - 1) + ' 个单词');
    };
    $('btnExportAll').onclick = function () {
      var lines = ['word,phonetic,phonetic_us,meaning,example,example_cn'];
      S.rows.forEach(function (r) {
        var s0 = (r[4] && r[4][0]) || ['', ''];
        lines.push(csv([r[0], r[1] || '', r[2] || '', Core.transText(r[3]), s0[0], s0[1]]));
      });
      download('六级词汇-' + dateStr() + '.csv', lines.join('\r\n'));
      toast('已导出全部 ' + S.rows.length + ' 词');
    };
    $('btnPrint').onclick = function () {
      var keep = flow.innerHTML, keepPage = S.page;
      var all = lay.list.map(entryHTML).join('');
      flow.innerHTML = all;
      document.body.classList.add('printing');
      setTimeout(function () {
        window.print();
        setTimeout(function () {
          document.body.classList.remove('printing');
          S.page = keepPage;
          flow.innerHTML = keep;
        }, 600);
      }, 60);
    };

    /* 翻页按钮 / 键盘 / 手势 */
    btnPrev.onclick = prevPage;
    btnNext.onclick = nextPage;
    document.addEventListener('keydown', function (e) {
      if (e.target && /input|textarea/i.test(e.target.tagName)) return;
      if (e.key === 'ArrowLeft' || e.key === 'PageUp' || e.key === 'k') { prevPage(); e.preventDefault(); }
      else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ' || e.key === 'j') { nextPage(); e.preventDefault(); }
      else if (e.key === 'Escape') { hideSheet(); }
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

    /* 尺寸变化：重排但守住当前单词 */
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
    return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
  }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
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
    /* 单文件版：词库已经内联在页面里，不走网络 */
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

  /* ============================== 诊断（自动化验证用） ==================== */
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
    /* 找出真正顶到边缘的元素：用于排查横向溢出 */
    var widest = null, widestRight = 0;
    [].forEach.call(app.querySelectorAll('*'), function (n) {
      var r = n.getBoundingClientRect();
      if (r.width > 0 && r.right > widestRight) {
        widestRight = r.right;
        widest = (n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') +
          (n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\s+/).join('.') : ''));
      }
    });
    var d = {
      vw: window.innerWidth,
      docScrollW: document.documentElement.scrollWidth,
      appW: Math.round(app.getBoundingClientRect().width),
      flowW: Math.round(flow.getBoundingClientRect().width),
      widest: widest,
      widestRight: Math.round(widestRight),
      words: S.rows.length,
      theme: S.settings.theme,
      fontSize: S.settings.size,
      sentences: S.settings.sentences,
      page: S.page + 1,
      pages: lay.pages.length,
      entriesOnPage: kids.length,
      flowH: Math.round(flow.clientHeight),
      usedH: Math.round(rects.reduce(function (a, r) { return a + r.height; }, 0)),
      bottomGap: last ? Math.round(fr.bottom - last.bottom) : null,
      overflowPx: Math.round(flow.scrollHeight - flow.clientHeight),
      overlap: overlap,
      entriesWithoutChinese: kids.length - chinese,
      hiddenTrans: hiddenTrans,
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
    S.wordIndex = Object.create(null);
    for (var i = 0; i < rows.length; i++) S.wordIndex[rows[i][0]] = i;

    setProgress(1);
    /* 恢复上次读到的位置 */
    var anchor = S.posWord || null;
    if (anchor && S.wordIndex[anchor] != null) {
      var pos = readJSON(LS_POS, null);
      if (pos && pos.view && VIEW_LABEL[pos.view]) S.view = pos.view;
    }
    buildLayout(anchor);
    render();
    syncSearchUI();
    updateProgress();

    var bootMs = performance.now() - t0;
    if (anchor && S.wordIndex[anchor] != null && S.page === 0) {
      var wi = lay.list.indexOf(S.wordIndex[anchor]);
      if (wi >= 0) { S.page = Core.pageOf(lay.pages, wi); render(); }
    }

    loadingEl.classList.add('out');
    setTimeout(function () { loadingEl.hidden = true; }, 320);

    if (!readJSON(LS_HINT, 0)) {
      setTimeout(function () {
        toast('轻点释义看例句 · 长按词条看词根 · 右侧圆点做标记');
        writeJSON(LS_HINT, 1);
      }, 700);
    }
    emitDiag(bootMs);

    /* 字体/视口在首帧之后才稳定时，再排一次版，避免页高被低估 */
    requestAnimationFrame(function () {
      if (heightSig() !== hSig) {
        buildLayout(curWord()); render(); emitDiag(performance.now() - t0);
      }
    });

    if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
      navigator.serviceWorker.register('./sw.js').catch(function () {});
    }
  }

  /* 供无 DOM 环境的测试脚本调用 */
  if (typeof window !== 'undefined') window.__CET6__ = { S: S, lay: lay, Core: Core, render: render, buildLayout: buildLayout, emitDiag: emitDiag };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
