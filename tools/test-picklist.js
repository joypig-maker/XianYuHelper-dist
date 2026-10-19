/**
 * 浮层选品清单自测（node tools/test-picklist.js）
 *
 * 场景取自 1688 整店页的真实特征：
 *   商品卡片是纯 inline-style div——无 class、无 id、无 data-*、无 href，
 *   页面上插复选框那套定位逻辑（findCardEl / cardSel）在整店页上全部落空。
 *   可接口 mtop.alibaba.alisite.cbu.server.moduleasyncservice
 *   返回的 offerList 里明明白白有 10 件商品。
 *
 * 于是「在页面上勾」这条路断了，选品必须落到浮层里：
 *   用户能在浮层清单里自由勾选，勾选结果跟页面复选框共用一份数据，
 *   下游的批量下载 / 保存文案 / 一键打包一个字都不用改。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');

/* ---------------- 极简 DOM mock（与 test-checkbox.js 同一套） ---------------- */

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
function mkNode(tag, attrs, children) {
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
    getBoundingClientRect() { return { width: 320, height: 420, top: 0, left: 0 }; },
    getAttribute(n) {
      if (n === 'class') return [...classes].join(' ');
      return this._attrs[n] != null ? String(this._attrs[n]) : null;
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

/**
 * 复刻 1688 整店页的真实 DOM：商品卡片是纯 inline-style div，
 * 没有 class / id / data-* 中的任何一个，也没有商品链接。
 */
function mkBareCard(id, title) {
  const box = mkNode('div', { style: 'display:flex' }, []);
  box.textContent = title;
  return mkNode('div', { style: 'position:relative' }, [box]);
}

const SHOP_CARDS = [
  mkBareCard('1002275214224', '亚克力收纳盒透明壁挂盲盒手办展示柜'),
  mkBareCard('1004082356855', '超大盲盒收纳盒磁吸全透明手办展示架柜'),
  mkBareCard('1001672530707', 'CD展示架桌面分格亚克力黑胶唱片光盘收纳盒'),
  mkBareCard('1005600000001', '鞋盒收纳盒透明可折叠透气防潮')
];

const listDoc = mkNode('div', { class: 'shop-page' }, SHOP_CARDS);

/* ---------------- mock 环境 ---------------- */

const posted = [];
const captureHandlers = {};
const bridgeListeners = [];
const searchListeners = [];

const mockDocument = {
  readyState: 'complete',
  title: '全部商品页',
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
  // 1688 整店页：店铺域名 + /page/ 子页，正是之前面板不出现的地方
  location: {
    href: 'https://shop3653158894s77.1688.com/page/offerlist.htm',
    host: 'shop3653158894s77.1688.com',
    search: '',
    pathname: '/page/offerlist.htm'
  },
  fetch: () => Promise.resolve({ clone: () => ({ json: () => Promise.resolve({}) }) }),
  requestIdleCallback: undefined,
  navigator: { clipboard: null }
};
ctx.window = ctx;
ctx.globalThis = ctx;
ctx.postMessage = (msg) => posted.push(msg);
/* 同 test-search-locate：委托在 window 捕获阶段，mock 要接得住 */
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

function askBridge(type) {
  let out = null;
  bridgeListeners.forEach((fn) => fn({ type }, {}, (r) => { out = r; }));
  return out;
}

const flush = () => new Promise((r) => setImmediate(r));
const selection = () => askBridge('xy:get-selected');

function pickRow(id) {
  return listDoc.querySelector('.xy-pick-row[data-xy-id="' + id + '"]') || null;
}
function pickCountNode() {
  return listDoc.querySelector('.xy-pick-count');
}
function panelOf() {
  return listDoc.querySelector('.xy-panel');
}

/* 真实的整店页接口响应（dist/offerlist-real.json），走 collectCards 归一 */
function realOfferCards() {
  let raw = null;
  const samplePath = path.join(ROOT, 'dist/offerlist-real.json');
  if (fs.existsSync(samplePath)) {
    const bag = JSON.parse(fs.readFileSync(samplePath, 'utf8'));
    const key = Object.keys(bag).find((k) => /moduleasyncservice/.test(k));
    if (key) raw = JSON.parse(bag[key]);
  }
  const site = ctx.XYSites.get('p1688');
  if (raw) return ctx.XYUtil.collectCards(raw, { site: site });
  // 样本缺失时退回手工构造，保证测试不因文件缺失而无声跳过
  const fallback = {
    data: { content: { offerList: [
      { id: '1002275214224', subject: '亚克力收纳盒透明壁挂盲盒手办展示柜', consignPrice: '12.00', offerImages: [{ imageURI: 'img/ibank/x1.jpg' }] },
      { id: '1004082356855', subject: '超大盲盒收纳盒磁吸全透明手办展示架柜', consignPrice: '12.00', offerImages: [{ imageURI: 'img/ibank/x2.jpg' }] },
      { id: '1001672530707', subject: 'CD展示架桌面分格亚克力黑胶唱片光盘收纳盒', consignPrice: '10.00', offerImages: [{ imageURI: 'img/ibank/x3.jpg' }] }
    ] } }
  };
  return ctx.XYUtil.collectCards(fallback, { site: site });
}

(async () => {
  /* === 准备：模拟接口抓到整店商品并同步给 bridge === */
  const cards = realOfferCards();
  assert.ok(cards.length >= 3, '样本应至少 3 件商品，实际 ' + cards.length);
  feedBridge({
    source: 'xy-injected',
    type: 'cards',
    payload: { list: cards, added: cards.length }
  });
  await flush();

  /* === 1：站点识别与面板挂载（原整店页面板不出现的问题） === */
  const site = ctx.XYSites.current(ctx.location);
  assert.ok(site && site.key === 'p1688', '整店页应识别为 1688，实际 ' + (site && site.key));
  const panel = panelOf();
  assert.ok(panel, '整店页上浮层面板应已挂载');
  console.log('✓ 站点识别 1688 + 浮层面板已挂载（' + ctx.location.host + '/page/offerlist.htm）');

  /* === 2：整店页的裸 div 卡片上插不上复选框，这是事实前提 === */
  const wired = listDoc.querySelectorAll('.xy-check').length;
  console.log('   （整店页裸卡片上已挂复选框 ' + wired + ' 个——真机上为 0，故选品需落到浮层）');

  /* === 3：清单把商品列出来了 === */
  const rows = listDoc.querySelectorAll('.xy-pick-row');
  assert.strictEqual(rows.length, cards.length,
    '清单应列出全部 ' + cards.length + ' 件商品，实际 ' + rows.length);
  const first = rows[0];
  assert.strictEqual(first.getAttribute('data-xy-id'), cards[0].itemId,
    '清单首行应是第一个商品，实际 ' + first.getAttribute('data-xy-id'));
  assert.ok(first.querySelector('.xy-pick-box'), '清单每行应自带复选框');
  console.log('✓ 浮层清单列出 ' + rows.length + ' 件商品（首行 ' + cards[0].itemId + '）');

  /* === 4：清单里点一下就能勾选 === */
  const targetId = cards[1].itemId;
  const row = pickRow(targetId);
  assert.ok(row, '清单里应能按商品 ID 找到对应行');
  const box = row.querySelector('.xy-pick-box');
  assert.ok(box, '清单行里应自带 .xy-pick-box 复选框');
  clickOn(box);
  assert.strictEqual(box.checked, true, '点清单行应勾选');
  assert.ok(selection().ids.indexOf(targetId) > -1,
    '勾选应写进数据层，实际 ' + selection().ids.join(','));
  console.log('✓ 点清单行 → 已勾选 ' + targetId);

  /* === 5：整行都能点，不必精确点中小方块 === */
  const row2 = pickRow(cards[2].itemId);
  const title2 = row2.querySelector('.xy-pick-title');
  assert.ok(title2, '清单行里应有商品标题，供点击整行');
  clickOn(title2);
  assert.strictEqual(
    selection().ids.indexOf(cards[2].itemId) > -1, true,
    '点行内文字也应能勾选'
  );
  console.log('✓ 点行内文字同样生效（不必精确点中小方块）');

  /* === 6：再点一次取消 === */
  clickOn(box);
  assert.strictEqual(box.checked, false, '再次点击应取消');
  assert.strictEqual(selection().ids.indexOf(targetId), -1, '数据层应移除该商品');
  console.log('✓ 再点一次 → 取消勾选');

  /* === 7：全选 / 全不选 会同步清单行外观 === */
  const allBtn = mkNode('button', { class: 'xy-btn' }, []);
  allBtn.dataset.act = 'sel-all';
  panel.querySelector('.xy-body').appendChild(allBtn);
  clickOn(allBtn);
  assert.strictEqual(selection().ids.length, cards.length, '全选应覆盖所有商品');
  rows.forEach((r) => {
    assert.ok(r.classList.contains('xy-check-on'),
      '全选后每行都应是勾选态');
  });
  assert.ok(pickCountNode() && /已勾选 \d+ 个/.test(pickCountNode().textContent),
    '头部应显示已勾选数量，实际 ' + (pickCountNode() ? pickCountNode().textContent : '(无)'));
  console.log('✓ 全选 → ' + selection().ids.length + ' 个，清单行与计数同步');

  const noneBtn = mkNode('button', { class: 'xy-btn' }, []);
  noneBtn.dataset.act = 'sel-none';
  panel.querySelector('.xy-body').appendChild(noneBtn);
  clickOn(noneBtn);
  assert.strictEqual(selection().ids.length, 0, '全不选应清空');
  rows.forEach((r) => {
    assert.ok(!r.classList.contains('xy-check-on'), '全不选后不应有勾选态');
  });
  console.log('✓ 全不选 → 清空，清单行同步');

  /* === 8：清单勾选与页面复选框共用一份数据（反向同步也算数） === */
  const stayId = cards[0].itemId;
  const stayRow = pickRow(stayId);
  assert.ok(stayRow && stayRow.querySelector('.xy-pick-box'), '清单里应能找到 ' + stayId + ' 的行');
  clickOn(stayRow.querySelector('.xy-pick-box'));
  assert.ok(selection().ids.indexOf(stayId) > -1, '清单勾选应写进数据层');

  // 页面上真要给这个商品插上复选框（比如别的页面形态有卡片），
  // 勾一下就得同步到清单，不能出现两边各勾各的
  const pageBox = mkNode('label', { class: 'xy-check', 'data-xy-id': stayId }, []);
  const pageInput = mkNode('input', { type: 'checkbox' });
  pageBox.appendChild(pageInput);
  listDoc.appendChild(pageBox);
  pageInput.checked = false;
  clickOn(pageInput);
  assert.ok(selection().ids.indexOf(stayId) > -1, '页面复选框勾选后数据层应一致');
  const row3 = pickRow(stayId);
  assert.ok(row3.classList.contains('xy-check-on'),
    '页面勾选后清单行也应变成勾选态（两种形态须共用一份数据）');
  console.log('✓ 清单与页面复选框共用一份数据，勾选态双向同步');

  /* === 9：勾选能驱动下游批量动作 === */
  const packBtn = mkNode('button', { class: 'xy-btn' }, []);
  packBtn.dataset.act = 'b-pack';
  panel.querySelector('.xy-body').appendChild(packBtn);
  clickOn(packBtn);
  await flush();
  const ensure = posted.filter((m) => m.type === 'ensure-cards');
  assert.ok(ensure.length > 0, '勾选的商品应能触发补齐详情并进入打包流程');
  console.log('✓ 清单勾选直通下游批量动作（补齐详情 ' + ensure.length + ' 次）');

  console.log('\n全部测试通过 ✅');
  process.exit(0);
})().catch((e) => {
  console.error('\n✗ 测试失败：' + e.message);
  console.error(e.stack);
  process.exit(1);
});
