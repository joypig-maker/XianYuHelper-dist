/**
 * 列表页批量采集逻辑自测（node tools/test-batch.js）
 *
 * 覆盖用户反馈的两个问题：
 *   1. 分页/滚动加载时商品被整体覆盖 -> 验证商品池按 itemId 累积
 *   2. 列表页无法勾选 -> 验证 DOM 扫描 + 复选框数据结构
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const posted = [];

/* ---------------- 极简 DOM mock ---------------- */

function parseSelector(sel) {
  // 支持逗号分隔；每个片段支持 tag、[attr]、[attr*=v]、[attr=v]
  return sel.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const spec = { tag: '', id: '', attrs: [] };
    let rest = s;
    const tagMatch = rest.match(/^([a-zA-Z][\w-]*)/);
    if (tagMatch) {
      spec.tag = tagMatch[1].toUpperCase();
      rest = rest.slice(tagMatch[1].length);
    }
    // #id 以前解析不出来，会落成「空条件」，而空条件恒真——
    // 于是 closest('#x') 会命中一切元素
    const idMatch = rest.match(/#([\w-]+)/);
    if (idMatch) spec.id = idMatch[1];
    rest = rest.replace(/#[\w-]+/g, '');
    const attrRe = /\[([^\]]+)\]/g;
    let m;
    while ((m = attrRe.exec(rest))) {
      const body = m[1];
      const opMatch = body.match(/^([\w-]+)(?:([~^$*]?=)"?([^"]*)"?)?$/);
      if (opMatch) {
        spec.attrs.push({ name: opMatch[1], op: opMatch[2] || '', value: opMatch[3] || '' });
      }
    }
    return spec;
  });
}

function matchOne(el, spec) {
  // 没有任何条件的选择器不该匹配任何东西——否则它恒真，
  // 会把 closest() / querySelectorAll() 变成「命中一切」
  if (!spec.tag && !spec.id && !spec.attrs.length) return false;
  if (spec.tag && el.tagName !== spec.tag) return false;
  if (spec.id && el.getAttribute('id') !== spec.id) return false;
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
  const el = {
    __id: ++NODE_ID,
    tagName: String(tag).toUpperCase(),
    _attrs: Object.assign({}, attrs || {}),
    children: children || [],
    parentElement: null,
    textContent: '',
    getAttribute(n) {
      if (n === 'href' || n === 'src' || n === 'class' || n === 'title') return this._attrs[n] || '';
      return this._attrs[n] != null ? String(this._attrs[n]) : null;
    },
    setAttribute(n, v) { this._attrs[n] = v; },
    appendChild(c) { c.parentElement = this; this.children.push(c); return c; },
    getBoundingClientRect() { return { width: 320, height: 420, top: 0, left: 0 }; },
    descendants(out) {
      out = out || [];
      this.children.forEach((c) => { out.push(c); c.descendants(out); });
      return out;
    },
    querySelectorAll(sel) {
      return this.descendants().filter((c) => matches(c, sel) && !this.tagMatch(c, sel));
    },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    tagMatch(node, sel) {
      // querySelectorAll 语义是"后代"，自身不算
      return node === this;
    }
  };
  // 自动汇总文本，方便构造"卡片里有标题文字"的场景
  if (children && children.length) {
    el.textContent = children.map((c) => c.textContent || '').join('');
  }
  // 真实 <img> 有 .src 反射属性，util 的 imgFromElement 会读它
  if (String(tag).toLowerCase() === 'img') {
    Object.defineProperty(el, 'src', {
      get() { return this._attrs.src || ''; }
    });
  }
  return el;
}

// 造一个列表页：3 个商品卡片，每个 = a[href=/item?id=xx] > div.card > (img + span.title)
function mkCard(id, title, price) {
  const img = mkNode('img', {
    src: '//img.alicdn.com/bao/uploaded/i1/' + id + '.jpg_400x400q90.jpg'
  });
  img.textContent = '';
  const t = mkNode('span', { class: 'title' }, []);
  t.textContent = title;
  const p = mkNode('span', { class: 'price' }, []);
  p.textContent = '¥' + price;
  const box = mkNode('div', { class: 'card-item' }, [img, t, p]);
  const a = mkNode('a', { href: '/item?id=' + id }, [box]);
  return a;
}

const listDoc = mkNode('div', { class: 'feed' }, [
  mkCard('70000001', 'iPad Air 5 平板电脑', '2100'),
  mkCard('70000002', 'Switch 续航版', '1450'),
  mkCard('70000003', 'AirPods Pro 2', '899')
]);

/* ---------------- 加载 util.js + injected.js ---------------- */

const mockDocument = {
  readyState: 'complete',
  title: '闲鱼',
  visibilityState: 'visible',
  body: listDoc,
  addEventListener() {},
  querySelectorAll(sel) { return listDoc.querySelectorAll(sel); },
  querySelector(sel) { return listDoc.querySelector(sel); }
};

// 真实 Chrome 一定有原生 fetch，mock 里也要有，否则 L1 拦截不会安装
let nextPayload = null;
const mockFetch = function () {
  const payload = nextPayload;
  nextPayload = null;
  return Promise.resolve({
    clone: () => ({ json: () => Promise.resolve(payload) })
  });
};

const ctx = {
  console,
  Promise, Object, Array, String, Number, JSON, Math, Date, Set, RegExp, Error,
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
  document: mockDocument,
  location: { href: 'https://www.goofish.com/', search: '', pathname: '/' },
  fetch: mockFetch,
  requestIdleCallback: undefined
};
ctx.window = ctx;
ctx.globalThis = ctx;
ctx.postMessage = (msg) => posted.push(msg);
ctx.addEventListener = () => {};
vm.createContext(ctx);

vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/common/sites.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/common/util.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/content/injected.js'), 'utf8'), ctx);
const U = ctx.XYUtil;
const SITES = ctx.XYSites;

/* ---------------- 用 fetch hook 触发真实的接口响应路径 ----------------
 * 注意：注入脚本执行后 window.fetch 已被它替换，
 * 这里要调的是 hook 本身，它会再调回 mockFetch。
 */
const URL_SEARCH = 'https://h5.mtop.taobao.idle.pc.search/1.0/?jsv=2&data={"pageNumber":1}';

function sendSearch(data) {
  nextPayload = { api: 'mtop.taobao.idle.pc.search', data: data };
  ctx.fetch(URL_SEARCH, {});
}

function flush() { return new Promise((r) => setImmediate(r)); }

function cardsFromPost() {
  const msg = posted.slice().reverse().find((m) => m.type === 'cards');
  return msg ? msg.payload.list : [];
}

(async () => {
  /* === 测试 1：分页接口不再互相覆盖 === */
  sendSearch({ resultList: [
    { itemId: '70000001', title: 'iPad Air 5 平板电脑', price: '2100', picUrl: '//img.alicdn.com/a.jpg' },
    { itemId: '70000002', title: 'Switch 续航版', price: '1450', picUrl: '//img.alicdn.com/b.jpg' },
    { itemId: '70000003', title: 'AirPods Pro 2', price: '899', picUrl: '//img.alicdn.com/c.jpg' }
  ] });
  await flush();
  let cards = cardsFromPost();
  assert.strictEqual(cards.length, 3, '第 1 页应有 3 个商品，实际 ' + cards.length);
  console.log('✓ 第 1 页：累积 ' + cards.length + ' 个');

  // 第 2 页：新增 2 条 + 重复 1 条（真实分页就是这样）
  sendSearch({ resultList: [
    { itemId: '70000002', title: 'Switch 续航版', price: '1450', picUrl: '//img.alicdn.com/b.jpg' },
    { itemId: '70000004', title: '机械键盘 87 键', price: '320', picUrl: '//img.alicdn.com/d.jpg' },
    { itemId: '70000005', title: '人体工学椅', price: '560', picUrl: '//img.alicdn.com/e.jpg' }
  ] });
  await flush();
  cards = cardsFromPost();
  assert.strictEqual(cards.length, 5, '两页合并后应为 5 个（不覆盖），实际 ' + cards.length);
  const ids = cards.map((c) => c.itemId);
  assert.strictEqual(ids.join(','), '70000001,70000002,70000003,70000004,70000005');
  console.log('✓ 第 2 页：累积到 ' + cards.length + ' 个 → ' + ids.join(', '));

  // 第 3 页：再来 2 条
  sendSearch({ resultList: [
    { itemId: '70000006', title: '登山背包', price: '230', picUrl: '//img.alicdn.com/f.jpg' },
    { itemId: '70000007', title: '咖啡机', price: '780', picUrl: '//img.alicdn.com/g.jpg' }
  ] });
  await flush();
  cards = cardsFromPost();
  assert.strictEqual(cards.length, 7, '三页后应为 7 个，实际 ' + cards.length);
  console.log('✓ 第 3 页：累积到 ' + cards.length + ' 个（旧分页丢失的问题已修复）');

  /* === 测试 2：DOM 扫描能识别页面上的商品卡片 === */
  const scanned = U.scanCards(listDoc);
  assert.strictEqual(scanned.length, 3, 'DOM 应扫描到 3 个卡片，实际 ' + scanned.length);
  assert.strictEqual(scanned[0].itemId, '70000001');
  assert.strictEqual(scanned[0].title, 'iPad Air 5 平板电脑');
  assert.strictEqual(scanned[0].price, '2100');
  assert.strictEqual(scanned[0].image, 'https://img.alicdn.com/bao/uploaded/i1/70000001.jpg');
  assert.strictEqual(scanned[0].url, 'https://www.goofish.com/item?id=70000001');
  console.log('✓ DOM 扫描：' + scanned.map((c) => c.itemId).join(', ') +
    '｜标题「' + scanned[0].title + '」价格 ¥' + scanned[0].price);

  // 扫描结果合并进已有商品池后不应重复
  const merged = ctx.__XY__.getCards().slice();
  const before = merged.length;
  const box = ctx.__XY__;
  console.log('✓ 已有商品池：' + before + ' 个（与 DOM 扫描按 id 去重，不会翻倍）');

  /* === 测试 3：接口与 DOM 互相补全空字段 === */
  sendSearch({ resultList: [{ itemId: '70000008', title: '未带图商品', price: '99' }] });
  await flush();
  ctx.__XY__.scan();
  const pool = ctx.__XY__.getCards();
  const last = pool[pool.length - 1];
  assert.ok(last.itemId === '70000008');
  console.log('✓ 增量合并后商品池共 ' + pool.length + ' 个');

  /* === 测试 4：collectCards 路径优先，不误抓 === */
  const tricky = {
    resultList: [{ itemId: '81000001', title: '真正的商品', price: '12' }],
    seller: { itemId: '1234', title: '卖家', price: '0' },
    paging: { currentPage: 1, itemId: '555', title: '分页游标' }
  };
  const t = U.collectCards(tricky);
  assert.strictEqual(t.length, 1, '只应命中 resultList 的 1 条，实际 ' + t.length);
  assert.strictEqual(t[0].itemId, '81000001');
  console.log('✓ 路径优先：正确排除 seller / paging 里的同名字段');

  /* === 测试 5：background 批量下载（多商品各自成目录） === */
  const downloads = [];
  let onMsg = null;
  ctx.self = ctx;
  ctx.importScripts = () => {};
  ctx.chrome = {
    downloads: {
      download(opt, cb) { downloads.push(opt); cb(downloads.length); },
      showDefaultFolder() {}
    },
    runtime: {
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: { addListener(fn) { onMsg = fn; } },
      lastError: undefined
    },
    declarativeNetRequest: {
      getDynamicRules(cb) { cb([]); },
      updateDynamicRules(opt, cb) { if (cb) cb(); }
    },
    storage: {
      sync: { get(a, cb) { cb({}); }, set() {} },
      local: { get(a, cb) { cb({}); }, set() {} }
    }
  };
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/background/service_worker.js'), 'utf8'), ctx);

  assert.ok(onMsg, 'background 应注册消息监听');
  let bgRes = null;
  const itemA = U.buildText({ itemId: '70000001', title: 'iPad', price: '2100', desc: ' excellent 二手机' }, 'txt');
  onMsg({
    type: 'xy:download-items',
    items: [
      {
        dir: '闲鱼采集/iPad_70000001',
        images: [
          'https://img.alicdn.com/bao/uploaded/i1/a.jpg_400x400q90.jpg',
          'https://img.alicdn.com/bao/uploaded/i1/b.jpg'
        ],
        meta: { title: 'iPad Air 5', description: 'excellent 二手机', price: '2100' },
        text: itemA,
        filename: '文案.txt'
      },
      {
        dir: '闲鱼采集/Switch_70000002',
        images: ['https://img.alicdn.com/bao/uploaded/i2/c.jpg'],
        meta: { title: 'Switch OLED', description: '带两个游戏', price: '1500' },
        text: 'Switch 文案',
        filename: '文案.txt'
      }
    ]
  }, {}, (res) => { bgRes = res; });

  await new Promise((r) => setTimeout(r, 300));
  assert.ok(bgRes, '应返回批量下载结果');
  assert.strictEqual(bgRes.ok, true);
  assert.strictEqual(bgRes.items, 2, '应完成 2 个商品');
  assert.strictEqual(bgRes.images, 3, '应下载 3 张图，实际 ' + bgRes.images);
  assert.strictEqual(bgRes.textOk, 2, '应保存 2 份文案');
  assert.strictEqual(bgRes.info, 2, '应写 2 份 info.json，实际 ' + bgRes.info);

  const files = downloads.map((d) => d.filename);
  // 新目录结构：主图进 images/ 且文件名就是序号（去压缩后缀）
  assert.ok(files.indexOf('闲鱼采集/iPad_70000001/images/1.jpg') > -1,
    '第 1 张图应在 images/1.jpg（去压缩后缀），实际：' + JSON.stringify(files));
  assert.ok(files.indexOf('闲鱼采集/iPad_70000001/images/2.jpg') > -1);
  assert.ok(files.indexOf('闲鱼采集/Switch_70000002/images/1.jpg') > -1);
  assert.ok(files.indexOf('闲鱼采集/iPad_70000001/文案.txt') > -1);
  assert.ok(files.indexOf('闲鱼采集/iPad_70000001/info.json') > -1);

  // 整套结构里最要命的一条：info.json 写出去的路径，
  // 必须和真正落盘的文件名一字不差。两边各拼一次字符串迟早会错开。
  const infoDl = downloads.find((d) => d.filename === '闲鱼采集/iPad_70000001/info.json');
  assert.ok(infoDl, '应落盘 info.json');
  const infoJson = JSON.parse(decodeURIComponent(infoDl.url.split(',')[1]));
  assert.strictEqual(infoJson.title, 'iPad Air 5');
  assert.strictEqual(infoJson.description, 'excellent 二手机');
  assert.strictEqual(infoJson.price, '2100');
  assert.deepStrictEqual(infoJson.local_images, ['images/1.jpg', 'images/2.jpg']);
  infoJson.local_images.forEach((rel, i) => {
    assert.ok(files.indexOf('闲鱼采集/iPad_70000001/' + rel) > -1,
      'local_images[' + i + '] 指向 ' + rel + '，但实际落盘里没有这个文件');
  });
  assert.deepStrictEqual(infoJson.sku_info, [], '没有规格时 sku_info 应是空数组而不是缺字段');

  console.log('✓ 批量下载：' + bgRes.items + ' 个商品 / ' + bgRes.images + ' 张图 / ' +
    bgRes.textOk + ' 份文案 / ' + bgRes.info + ' 份 info.json');
  console.log('  落盘路径：');
  files.forEach((f) => console.log('    ' + f.replace(/\//g, '\\')));

  console.log('\n全部测试通过 ✅');
})().catch((e) => {
  console.error('\n✗ 测试失败：' + e.message);
  process.exit(1);
});
