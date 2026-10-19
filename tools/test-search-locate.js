/**
 * 1688 关键词搜索页定位回归测试（node tools/test-search-locate.js）
 *
 * 场景全部取自真机抓取（tools/diag-search.js / dump-search-cards.js，
 * 关键词「手机支架」，s.1688.com/selloffer/offer_search.htm）：
 *
 *   · 搜索页的卡片链接是 http://detail.m.1688.com/page/index.html?offerId=<id>
 *     不是详情页那套 /offer/<id>.html —— linkSel 只认后者时，
 *     15 件商品一个都定位不到，页面上没有一个复选框。
 *   · 同一个商品在页面上有两处链接：210x358 的卡片 <a> 和 20x20 的
 *     店铺在线聊天按钮（href 里同样带 offerId=），取错就插进小图标。
 *   · 搜索页主图的后缀是多段的：
 *       O1CN…_!!2217964505482-0-cib.jpg_460x460q100.jpg_.webp
 *     与接口裸 URI 的后缀不同，单次 replace 剥不干净，图指纹对不上。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');

/* ---------------- 极简 DOM mock（与 test-picklist.js 同一套） ---------------- */

function parseSelector(sel) {
  return sel.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const spec = { tag: '', id: '', class: [], attrs: [] };
    let rest = s;
    const tagMatch = rest.match(/^([a-zA-Z][\w-]*)/);
    if (tagMatch) {
      spec.tag = tagMatch[1].toUpperCase();
      rest = rest.slice(tagMatch[1].length);
    }
    // #id 以前解析不出来，会落成「空条件」；而空条件对任何元素都成立，
    // 于是 closest('#x') 恒返回元素自己，静默把每个元素都判成命中。
    const idMatch = rest.match(/#([\w-]+)/);
    if (idMatch) spec.id = idMatch[1];
    rest = rest.replace(/#[\w-]+/g, '');
    const clsRe = /\.([\w-]+)/g;
    let cm;
    while ((cm = clsRe.exec(rest))) spec.class.push(cm[1]);
    rest = rest.replace(clsRe, '');
    const attrRe = /\[([^\]]+)\]/g;
    let m;
    while ((m = attrRe.exec(rest))) {
      const body = m[1];
      const opMatch = body.match(/^([\w-]+)(?:([~^$*]?=)"?([^"]*)"?)?$/);
      if (opMatch) spec.attrs.push({ name: opMatch[1], op: opMatch[2] || '', value: opMatch[3] || '' });
    }
    return spec;
  });
}

function matchOne(el, spec) {
  // 没有任何条件的选择器不该匹配任何东西——否则它恒真，
  // 会把 closest() / querySelectorAll() 变成「命中一切」
  if (!spec.tag && !spec.id && !spec.class.length && !spec.attrs.length) return false;
  if (spec.tag && el.tagName !== spec.tag) return false;
  if (spec.id && el.getAttribute('id') !== spec.id) return false;
  const cls = (el.getAttribute('class') || '').split(/\s+/);
  for (const c of spec.class) if (cls.indexOf(c) === -1) return false;
  for (const a of spec.attrs) {
    const v = el.getAttribute(a.name);
    if (v == null) return false;
    if (a.op === '*=') { if (v.indexOf(a.value) === -1) return false; }
    else if (a.op === '=') { if (v !== a.value) return false; }
  }
  return true;
}

function matches(el, selector) {
  return parseSelector(selector).some((spec) => matchOne(el, spec));
}

let NODE_ID = 0;
function mkNode(tag, attrs, children, rect) {
  let classes = new Set(String((attrs && attrs.class) || '').split(/\s+/).filter(Boolean));
  const el = {
    __id: ++NODE_ID,
    tagName: String(tag).toUpperCase(),
    _attrs: Object.assign({}, attrs || {}),
    children: children || [],
    parentElement: null,
    checked: false,
    type: (attrs && attrs.type) || '',
    style: {},
    dataset: {},
    listeners: {},
    _rect: rect || { width: 320, height: 420, top: 0, left: 0 },
    getBoundingClientRect() { return this._rect; },
    getAttribute(n) {
      if (n === 'class') return [...classes].join(' ');
      if (this._attrs[n] != null) return String(this._attrs[n]);
      // 产品代码里常写 input.type = 'checkbox' 这种直接赋值，不经过 setAttribute，
      // mock 只翻 _attrs 会读不到，选择器就永远匹配不上
      if (this[n] != null) return String(this[n]);
      return null;
    },
    setAttribute(n, v) { this._attrs[n] = v; },
    appendChild(c) { c.parentElement = this; this.children.push(c); return c; },
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i > -1) this.children.splice(i, 1);
      return c;
    },
    remove() { if (this.parentElement) this.parentElement.removeChild(this); },
    descendants(out) {
      out = out || [];
      this.children.forEach((c) => { out.push(c); c.descendants(out); });
      return out;
    },
    querySelectorAll(sel) { return this.descendants().filter((c) => matches(c, sel)); },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    closest(sel) {
      let cur = this;
      while (cur) {
        if (matches(cur, sel)) return cur;
        cur = cur.parentElement;
      }
      return null;
    },
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    contains(n) {
      let cur = n;
      while (cur) { if (cur === this) return true; cur = cur.parentElement; }
      return false;
    }
  };
  el.classList = {
    add: (c) => classes.add(c),
    remove: (c) => classes.delete(c),
    contains: (c) => classes.has(c),
    toggle: (c, force) => {
      const on = force === undefined ? !classes.has(c) : !!force;
      if (on) classes.add(c); else classes.delete(c);
      return on;
    }
  };
  Object.defineProperty(el, 'className', {
    get() { return [...classes].join(' '); },
    set(v) { classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  });
  Object.defineProperty(el, 'textContent', {
    get() { return el._text || ''; },
    set(v) { el._text = String(v); el.children = []; }
  });
  return el;
}

/* ---------------- 复刻搜索页真实结构 ---------------- */

// 真机抓到的主图形态：后缀是多段的
const IMG_1 = 'https://cbu01.alicdn.com/img/ibank/O1CN01dQGSox1qMoL2q3xzW_!!2217964505482-0-cib.jpg_460x460q100.jpg_.webp';
const IMG_2 = 'https://cbu01.alicdn.com/img/ibank/O1CN01l8PjV71Nde5UQ9BaO_!!2217980874035-0-cib.jpg_460x460q100.jpg_.webp';
const IMG_3 = 'https://cbu01.alicdn.com/img/ibank/O1CN01KPUXzK1Nde2YZRCRs_!!2217980874035-0-cib.jpg_460x460q100.jpg_.webp';

const OFFERS = [
  { id: '803347112456', title: '镓铟锡 镓铟合金 高校科研用液态金属合金', price: '635.00', img: IMG_1 },
  { id: '1057696557508', title: '镓铟锡合金/镓铟合金99.99% 液态常温合金', price: '629.00', img: IMG_1 },
  { id: '1069781976358', title: '高纯液态镓铟锡合金 热界面材料 半导体散热', price: '6.50', img: IMG_2 }
];

// 卡片本体：<a class="search-offer-wrapper … search-offer-item" href="…?offerId=<id>">
function mkCard(offer) {
  const img = mkNode('img', { src: offer.img }, [], { width: 460, height: 460, top: 0, left: 0 });
  const inner = mkNode('div', { class: 'offer-shop-row' }, [img], { width: 200, height: 40, top: 0, left: 0 });
  const a = mkNode('a', {
    class: 'search-offer-wrapper cardui-normal search-offer-item major-offer',
    href: 'http://detail.m.1688.com/page/index.html?offerId=' + offer.id + '&sortType=&pageId=',
    title: offer.title
  }, [inner], { width: 210, height: 358, top: 0, left: 0 });
  return a;
}

// 店铺那行的在线聊天按钮：20x20，href 里同样带 offerId=，真机上确实存在
function mkWangWang(offer) {
  return mkNode('a', {
    class: 'ww-link ww-inline ww-online',
    href: 'https://air.1688.com/app/ocms-fusion-components-1688/def_cbu_web_im/index.html?uid=%E9%95%BF%E6%B2%99&offerId=' + offer.id
  }, [], { width: 20, height: 20, top: 300, left: 180 });
}

const CARD_A = OFFERS.map(mkCard);
const listDoc = mkNode('div', { class: 'page-offerlist' }, CARD_A);
// 聊天按钮挂在卡片右侧，真机上比卡片晚渲染，但顺序不该影响定位
OFFERS.forEach((o, i) => {
  const ww = mkWangWang(o);
  ww.parentElement = listDoc;
  listDoc.children.push(ww);
});

/* ---------------- mock 环境：搜索页 ---------------- */

const posted = [];
const captureHandlers = {};
const bridgeListeners = [];
const searchListeners = [];

const mockDocument = {
  readyState: 'complete',
  title: '手机支架_阿里巴巴',
  visibilityState: 'visible',
  body: listDoc,
  documentElement: mkNode('html'),
  addEventListener(type, fn, cap) {
    if (type === 'click' && cap) captureHandlers[type] = fn;
  },
  createElement(tag) { return mkNode(tag); },
  getElementById() { return null; },
  querySelectorAll(sel) { return listDoc.querySelectorAll(sel); },
  querySelector(sel) { return listDoc.querySelector(sel); }
};

const ctx = {
  console,
  Promise, Object, Array, String, Number, JSON, Math, Date, Set, RegExp, Error,
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
  document: mockDocument,
  location: {
    href: 'https://s.1688.com/selloffer/offer_search.htm?keywords=%E6%89%8B%E6%9C%BA%E6%94%AF%E6%9E%B6&n=8',
    host: 's.1688.com',
    search: '?keywords=%E6%89%8B%E6%9C%BA%E6%94%AF%E6%9E%B6&n=8',
    pathname: '/selloffer/offer_search.htm'
  },
  fetch: () => Promise.resolve({ clone: () => ({ json: () => Promise.resolve({}) }) }),
  requestIdleCallback: undefined,
  navigator: { clipboard: null }
};
ctx.window = ctx;
ctx.globalThis = ctx;
ctx.postMessage = (msg) => posted.push(msg);
/* bridge 的点击委托挂在 window 的捕获阶段：站点会在自己的 window 捕获监听里
 * stopPropagation + 翻转 checked，挂在 document 上根本收不到事件。
 * 所以这里要把 window（也就是 ctx）上注册的 click 捕获处理器记下来。 */
ctx.addEventListener = (type, fn, cap) => {
  if (type === 'message') searchListeners.push(fn);
  else if (type === 'click' && cap) captureHandlers[type] = fn;
};
vm.createContext(ctx);

ctx.chrome = {
  storage: {
    sync: { get(defaults, cb) { cb(defaults); }, set() {} },
    local: { get(keys, cb) { cb({}); }, set() {} },
    onChanged: { addListener() {} }
  },
  runtime: {
    onInstalled: { addListener() {} },
    onMessage: { addListener(fn) { bridgeListeners.push(fn); } },
    sendMessage(msg, cb) { if (cb) cb({ ok: true }); },
    lastError: undefined
  }
};

vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/common/sites.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/common/util.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/content/bridge.js'), 'utf8'), ctx);
const vmWindow = vm.runInContext('window', ctx);

function feedBridge(msg) {
  searchListeners.forEach((fn) => fn({ source: vmWindow, data: msg }));
}
function askBridge(type) {
  let out = null;
  bridgeListeners.forEach((fn) => fn({ type }, {}, (r) => { out = r; }));
  return out;
}
function clickOn(target) {
  const ev = {
    target,
    defaultPrevented: false,
    stopped: false,
    immediate: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.stopped = true; },
    stopImmediatePropagation() { this.stopped = true; this.immediate = true; }
  };
  if (captureHandlers.click) captureHandlers.click(ev);
  return ev;
}
const flush = () => new Promise((r) => setImmediate(r));
const selection = () => askBridge('xy:get-selected');

/* ================= 1. linkSel 覆盖两种链接形态 ================= */
console.log('1) linkSel 必须同时认 /offer/<id> 与 offerId=<id>');
const site = ctx.XYSites.get('p1688');
const sel803 = site.linkSel('803347112456');
assert.ok(/\/\offer\/803347112456/.test(sel803), '应保留详情页形态：' + sel803);
assert.ok(/offerId=803347112456/.test(sel803), '应覆盖搜索页形态：' + sel803);
// 详情页链接不能因为多了 offerId 分支就被误伤
assert.strictEqual(
  listDoc.querySelectorAll(site.linkSel('803347112456')).length >= 2, true,
  '同一个商品在搜索页上应命中卡片本体与聊天按钮两处'
);
console.log('   ✓ ' + sel803);

/* ================= 2. 定位挑最大的那个，不落到 20x20 的聊天按钮 ================= */
console.log('2) 同一商品多处链接时挑卡片本体');
const cards = OFFERS.map((o) => ({
  itemId: o.id,
  title: o.title,
  price: o.price,
  image: ctx.XYUtil.normalizeImageUrl(o.img),
  sellerNick: '长沙荣创',
  url: site.itemUrl(o.id),
  source: 'dom'
}));
feedBridge({ source: 'xy-injected', type: 'cards', payload: { list: cards, added: cards.length } });
(async () => {
  await flush();

  const checks = listDoc.querySelectorAll('.xy-check');
  assert.ok(checks.length === OFFERS.length,
    '搜索页 ' + OFFERS.length + ' 件商品都应挂上复选框，实际 ' + checks.length);
  console.log('   ✓ ' + OFFERS.length + ' 件商品各挂到一个复选框');

  // 每个复选框必须落在卡片本体里，不能落在 20x20 的聊天按钮上
  OFFERS.forEach((o) => {
    const box = listDoc.querySelector('.xy-check[data-xy-id="' + o.id + '"]');
    assert.ok(box, o.id + ' 应挂上复选框');
    let cur = box;
    let onCard = false;
    while (cur) {
      if (cur === CARD_A[OFFERS.indexOf(o)]) { onCard = true; break; }
      cur = cur.parentElement;
    }
    assert.ok(onCard, o.id + ' 的复选框应挂在卡片本体 <a> 上，实际挂在 ' +
      (box.parentElement && box.parentElement.className));
  });
  console.log('   ✓ 复选框都落在 210x358 的卡片本体上，没有塞进 20x20 的聊天按钮');

  /* ================= 3. 图指纹能抹平多段后缀 ================= */
  console.log('3) 图指纹抹平搜索页的多段后缀');
  const U = ctx.XYUtil;
  const apiURI = 'img/ibank/O1CN01dQGSox1qMoL2q3xzW_!!2217964505482-0-cib.jpg';
  assert.strictEqual(
    U.imageFingerprint(apiURI),
    U.imageFingerprint(IMG_1),
    '接口裸 URI 与搜索页 DOM 主图（多段后缀）应得到同一指纹'
  );
  console.log('   ✓ ' + U.imageFingerprint(apiURI));

  /* ================= 4. 图反查那条兜底路线仍然可用 ================= */
  console.log('4) 图反查兜底（linkSel 落空时）');
  // 把卡片链接抹掉，只剩图片，退化成整店页那种「无 href」的形态
  const bare = cards.map((c) => Object.assign({}, c, { url: '' }));
  listDoc.querySelectorAll('.xy-check').forEach((n) => { n.remove(); });
  CARD_A.forEach((a) => {
    a._attrs.href = '';
    // 挂过的标记不撤掉的话 attachOne 会直接跳过这个容器
    delete a.__xyCheckAttached;
  });
  feedBridge({ source: 'xy-injected', type: 'cards', payload: { list: bare, added: 0 } });
  await flush();
  feedBridge({ source: 'xy-injected', type: 'reset', payload: null });
  feedBridge({ source: 'xy-injected', type: 'cards', payload: { list: bare, added: bare.length } });
  await flush();
  const wired2 = listDoc.querySelectorAll('.xy-check').length;
  assert.ok(wired2 > 0, '抹掉链接后仍应能通过主图反查挂上复选框，实际 ' + wired2);
  console.log('   ✓ 无链接形态下靠主图反查又挂回 ' + wired2 + ' 个复选框');

  /* ================= 5. 勾选仍然直通下游 ================= */
  console.log('5) 勾选直通下游');
  // 页面上点一下复选框，走的是真实那条路（不是直接塞数据）
  const firstCheck = listDoc.querySelector('.xy-check[data-xy-id="' + OFFERS[0].id + '"]');
  assert.ok(firstCheck, '第 4 段之后 ' + OFFERS[0].id + ' 上应重新挂有复选框');
  clickOn(firstCheck.querySelector('input[type=checkbox]'));
  assert.ok(selection().ids.indexOf(OFFERS[0].id) > -1,
    '点搜索页卡片上的复选框应写进数据层，实际 ' + selection().ids.join(','));
  console.log('   ✓ 点卡片复选框 → 已勾选 ' + OFFERS[0].id);

  const btn = mkNode('button', { class: 'xy-btn' }, []);
  btn.dataset.act = 'b-pack';
  listDoc.querySelector('.xy-panel').querySelector('.xy-body').appendChild(btn);
  clickOn(btn);
  await flush();
  const ensure = posted.filter((m) => m.type === 'ensure-cards');
  assert.ok(ensure.length > 0, '搜索页勾选也要能触发补齐详情并进入打包流程');
  console.log('   ✓ 补齐详情 ' + ensure.length + ' 次');

  console.log('\n全部测试通过 ✅');
  process.exit(0);
})().catch((e) => {
  console.error('\n✗ 测试失败：' + e.message);
  console.error(e.stack);
  process.exit(1);
});
