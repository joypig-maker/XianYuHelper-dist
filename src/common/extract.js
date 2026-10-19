/**
 * 三级取值兜底（借鉴 1688 官方插件的分层取值思路）
 *
 *   L1  window 全局数据        —— 服务端渲染时把整包数据挂在 window 上
 *   L2  React fiber            —— 组件树上还留着没渲染成 DOM 的原始 props
 *   L3  DOM                    —— 在 bridge.js 里，本模块不碰
 *
 * 为什么需要这两级：
 *   1688 整店页（/page/offerlist.htm）的商品卡片是纯 inline-style div，
 *   无 class、无 id、无 data-*、无 href，linkSel 和属性选择器都命中不到，
 *   页面上的复选框就一个都挂不上。但这类页面的 SSR 数据包往往挂在
 *   window 上，React 组件的 memoizedProps 里也还留着干净的 offerId，
 *   是「DOM 全裸」时唯一还能用的两条路。
 *
 * 为什么必须跑在 MAIN world：
 *   window 上的全局变量和 __reactFiber$xxx 都是 MAIN world 的 JS 对象属性，
 *   ISOLATED world 看不到（DOM 树共享，JS 对象不共享）。所以本文件和
 *   injected.js 一组，都走 world: 'MAIN'。
 *
 * 抽出来的卡片按现有的 'cards' 协议推给 bridge，复用它那条链路，
 * 不另起一套。
 *
 * 依赖：util.js（字段映射）、postbus.js（通道）。缺任意一个就整体退出，
 * 这是个纯增强模块，宁可什么都不做，也别把主流程搞坏。
 */
(function (root) {
  'use strict';

  var U = root.XYUtil;
  var bus = root.XYPostBus ? root.XYPostBus.channel('injected') : null;

  /** L2 标注完给节点打的属性名，bridge.js 的定位链会读它 */
  var CARD_ATTR = 'data-xy-card';

  /** 商品 ID 的形态：1688 offerId 通常 12 位，闲鱼 itemId 6 位起 */
  function isGoodId(v) {
    return v != null && !Array.isArray(v) && /^\d{6,20}$/.test(String(v).trim());
  }

  /* ---------------- L1：window 全局数据 ---------------- */

  // 常见 SSR 挂载名。这些都是「见过的一次性清单」，
  // 站点改版换名字时靠下面的宽松扫描兜底。
  var WINDOW_KEYS = [
    '__INITIAL_STATE__', '__INITIAL_SSR_STATE__', '__PRELOADED_STATE__',
    '__NUXT__', '__NEXT_DATA__', '__NEXT_DATA__FROM_SSR', '__APOLLO_STATE__',
    '__INIT_DATA__', '__INIT_DATASET__', '__INITIAL_DATA__',
    '__SSR_DATA__', '__SERVER_DATA__', '__PAGE_DATA__', '__APP_DATA__',
    '__DATA__', '__DATASET__', '__HYBRID_DATA__', '__hybridData',
    '_DATA_', '_INITIAL_STATE_'
  ];

  // 固定名没命中才扫这一类。名字里要同时出现「数据/页面/状态」味道的词，
  // 避免把 window.location、window.navigator 之类的数据结构也算进来。
  var LOOSE_RE = /(data|state|page|initial|store|ssr|hydrat|render)/i;

  /**
   * 松解析：SSR 填空的常见形态有
   *   "window.__DATA__={...}" / "<!-- {...} -->" / 直接 "{...}"
   * 先把首尾的壳剥掉再交 JSON.parse。
   */
  function parseLoose(text) {
    if (typeof text !== 'string') return null;
    var t = text.trim();
    if (!t) return null;
    if (t.charAt(0) !== '{' && t.charAt(0) !== '[') {
      var a = t.indexOf('{');
      var b = t.lastIndexOf('}');
      if (a < 0 || b <= a) return null;
      t = t.slice(a, b + 1);
    }
    try { return JSON.parse(t); } catch (e) { return null; }
  }

  /** 把一个值取成数据根：对象直接用，字符串试着解析 */
  function asRoot(v) {
    if (v && typeof v === 'object') return v;
    return parseLoose(v);
  }

  /**
   * 收集 window 上可疑的数据根。不涉及任何字段解析——
   * 字段映射（itemId / price / consignPrice 各家叫法）交给 U.collectCards。
   * @returns {object[]}
   */
  function windowRoots(opts) {
    opts = opts || {};
    var win = opts.window || root;
    if (!win) return [];
    var out = [];
    var seen = [];
    var i, v;

    function push(v2) {
      var r = asRoot(v2);
      if (!r || typeof r !== 'object') return;
      for (var k = 0; k < seen.length; k++) if (seen[k] === r) return;
      seen.push(r);
      out.push(r);
    }

    for (i = 0; i < WINDOW_KEYS.length; i++) {
      try { push(win[WINDOW_KEYS[i]]); } catch (e) {}
    }
    if (out.length) return out;
    if (opts.skipLoose) return out;

    // 宽松扫描：一次性扫，命中即收工
    var budget = opts.looseBudget || 300;
    try {
      for (var key in win) {
        if (budget-- <= 0) break;
        if (LOOSE_RE.test(key)) {
          try { push(win[key]); } catch (e) {}
        }
      }
    } catch (e) {}

    // SSR 数据也可能塞在 <script type="application/json"> 里
    if (opts.doc !== false && root.document) {
      try {
        var tags = root.document.querySelectorAll(
          'script[type="application/json"],script[type="text/json"]');
        for (i = 0; i < tags.length; i++) {
          var r2 = asRoot(tags[i].textContent);
          if (r2 && typeof r2 === 'object') out.push(r2);
        }
      } catch (e) {}
    }
    return out;
  }

  /** 把数据根交给 util 的字段映射抽卡片，抽不到返回空数组 */
  function collectFromRoots(roots, opts) {
    if (!U || !U.collectCards || !roots || !roots.length) return [];
    var out = [];
    for (var i = 0; i < roots.length && out.length < (opts && opts.limit || 200); i++) {
      var got = U.collectCards(roots[i], opts && opts.site ? { site: opts.site } : null);
      if (got && got.length) out = out.concat(got);
    }
    return out;
  }

  /* ---------------- L2：React fiber ---------------- */

  /** 元素上挂的 fiber 键名形如 __reactFiber$1a2b3c，每次渲染都带随机后缀 */
  function fiberKeyOf(el) {
    var names;
    try { names = Object.getOwnPropertyNames(el); } catch (e) { return null; }
    for (var i = 0; i < names.length; i++) {
      if (names[i].indexOf('__reactFiber$') === 0) return names[i];
    }
    return null;
  }

  /** 从 props / state 对象里挑商品 ID，字段顺序按「越具体越先」排 */
  function pickId(node) {
    if (!node || typeof node !== 'object') return '';
    var cands = [node.itemId, node.item_id, node.offerId, node.goodsId,
                 node.productId, node.id];
    for (var i = 0; i < cands.length; i++) {
      if (isGoodId(cands[i])) return String(cands[i]).trim();
    }
    return '';
  }

  /** 沿 fiber 的 return 链往上找，同一层里 props 比 state 更可能带 ID */
  function idFromFiber(fiber, maxDepth) {
    var f = fiber, hop = 0;
    while (f && typeof f === 'object' && hop++ < (maxDepth || 12)) {
      var v = pickId(f.memoizedProps) || pickId(f.pendingProps) ||
        pickId(f.memoizedState) || pickId(f.stateNode);
      if (v) return v;
      f = f.return;
    }
    return '';
  }

  /**
   * 扫页面上的 React 节点，把认出来的商品 ID 标到元素上。
   * 标记本身才是目的——bridge.js 的定位链多一条 [data-xy-card] 就能命中
   * 那些无 class 无 id 的裸 div 卡片，复选框也就挂得上。
   * @returns {{marked:number, ids:string[]}}
   */
  function fiberScan(opts) {
    opts = opts || {};
    var doc = opts.doc || root.document;
    if (!doc || !doc.querySelectorAll) return { marked: 0, ids: [] };
    var budget = opts.budget || 3000;
    var els;
    try { els = doc.querySelectorAll(opts.sel || '*'); }
    catch (e) { return { marked: 0, ids: [] }; }

    var marked = 0;
    var ids = [];
    for (var i = 0; i < els.length && budget > 0; i++) {
      var el = els[i];
      if (!el || el.nodeType !== 1) continue;
      if (el.getAttribute && el.getAttribute(CARD_ATTR)) continue;  // 已标过
      var k = fiberKeyOf(el);
      if (!k) continue;
      budget--;
      var id = '';
      try { id = idFromFiber(el[k]); } catch (e) {}
      if (!id) continue;
      try { el.setAttribute(CARD_ATTR, id); } catch (e) {}
      marked++;
      if (ids.indexOf(id) < 0) ids.push(id);
    }
    return { marked: marked, ids: ids };
  }

  /* ---------------- 接线 ---------------- */

  function emit(cards) {
    if (!bus || !cards.length) return 0;
    bus.push('bridge', 'cards', { list: cards });
    return cards.length;
  }

  var lastHref = '';

  /**
   * 跑一遍 L1 + L2。
   *
   * 可以重复调用：SPA 换路由后 injected.js 的 boot 会再调一次，
   * 新页面是新节点、需要重新扫。同一 href 下不重做 L1（数据包不会再变），
   * fiber 扫描则每次都跑——它会跳过已经打过标记的节点，不会重复标注。
   */
  function start(opts) {
    opts = opts || {};
    var href = (opts.href || (root.location && root.location.href) || '').split('#')[0];
    var fresh = href !== lastHref;
    lastHref = href;

    var cards = [];
    if (fresh) cards = collectFromRoots(windowRoots(opts), opts);
    emit(cards);

    // React 挂载比 DOMContentLoaded 晚，晚一拍再扫 fiber
    var scan = function () {
      var r = fiberScan(opts);
      // 标注只影响定位，不重推数据；让 bridge 按 ids 补挂一次复选框
      if (r.marked && bus) bus.push('bridge', 'cards-relocate', { ids: r.ids });
      return r;
    };
    if (opts.now) return { cards: cards, marked: 0, ids: [] };
    setTimeout(scan, opts.delay || 1200);
    return { cards: cards, marked: 0, ids: [] };
  }

  root.XYExtract = {
    CARD_ATTR: CARD_ATTR,
    isGoodId: isGoodId,
    windowRoots: windowRoots,
    collectFromRoots: collectFromRoots,
    fiberKeyOf: fiberKeyOf,
    pickId: pickId,
    fiberScan: fiberScan,
    start: start
  };
})(typeof window !== 'undefined' ? window : this);
