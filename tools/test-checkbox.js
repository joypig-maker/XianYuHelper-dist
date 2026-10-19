/**
 * 页面内复选框交互自测（node tools/test-checkbox.js）
 *
 * 覆盖用户反馈的两个 bug：
 *   1. 面板「全选/全不选/反选」能用，但页面上点单个复选框没反应
 *      -> 捕获阶段的 preventDefault() 取消了 checkbox 默认勾选，
 *         而 setSelected() 只挂在 change 上，于是永远不会被调用。
 *   2. 一键打包只下到一张卖家头像，文案描述缺失
 *      -> 卡片数据不含 desc / images，且补详情的触发条件写得太宽松，
 *         导致根本没去补，同时没图商品被整个跳过。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');

/* ---------------- 极简 DOM mock ---------------- */

function parseSelector(sel) {
  return sel.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const spec = { tag: '', id: '', class: [], attrs: [] };
    let rest = s;
    const tagMatch = rest.match(/^([a-zA-Z][\w-]*)/);
    if (tagMatch) {
      spec.tag = tagMatch[1].toUpperCase();
      rest = rest.slice(tagMatch[1].length);
    }
    // .class 片段（测试里大量使用 .xy-check / .card-item 这类写法）
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
    remove() {
      if (this.parentElement) this.parentElement.removeChild(this);
    },
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
  const lower = String(tag).toLowerCase();
  if (lower === 'img') {
    Object.defineProperty(el, 'src', { get() { return el._attrs.src || ''; } });
  }
  return el;
}

function mkCard(id, title, price, thumb) {
  const img = mkNode('img', { src: thumb || ('//img.alicdn.com/bao/uploaded/i1/' + id + '.jpg_400x400q90.jpg') });
  const t = mkNode('span', { class: 'title' }, []);
  t.textContent = title;
  const p = mkNode('span', { class: 'price' }, []);
  p.textContent = '¥' + price;
  const box = mkNode('div', { class: 'card-item' }, [img, t, p]);
  return mkNode('a', { href: '/item?id=' + id }, [box]);
}

const listDoc = mkNode('div', { class: 'feed' }, [
  mkCard('70000001', 'iPad Air 5 平板电脑', '2100'),
  mkCard('70000002', 'Switch 续航版', '1450'),
  // 第三个卡片是真实的坑：链接里挂的缩略图其实是卖家头像
  mkCard('70000003', 'AirPods Pro 2', '899', 'https://img.alicdn.com/avatar/i1/seller_70000003.jpg')
]);

/* ---------------- mock 环境 ---------------- */

const posted = [];
const captureHandlers = {};
const bubbleHandlers = {};
const bridgeListeners = [];
const searchListeners = [];

const mockDocument = {
  readyState: 'complete',
  title: '闲鱼',
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

let nextPayload = null;
const ctx = {
  console,
  Promise, Object, Array, String, Number, JSON, Math, Date, Set, RegExp, Error,
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
  document: mockDocument,
  location: { href: 'https://www.goofish.com/', search: '', pathname: '/' },
  fetch: () => Promise.resolve({
    clone: () => ({ json: () => Promise.resolve(nextPayload) })
  }),
  requestIdleCallback: undefined,
  navigator: { clipboard: null }
};
ctx.window = ctx;
ctx.globalThis = ctx;
ctx.postMessage = (msg) => posted.push(msg);
/* bridge 的点击委托挂在 window 的捕获阶段（站点会在 window 捕获阶段
 * stopPropagation，挂在 document 上收不到事件），所以这里也要把
 * window 上注册的 click 监听器记下来。 */
ctx.addEventListener = (type, fn, cap) => {
  if (type === 'message') {
    searchListeners.push(fn);
  } else if (type === 'click') {
    if (cap) captureHandlers[type] = fn;
    else (bubbleHandlers[type] = bubbleHandlers[type] || []).push(fn);
  }
};
vm.createContext(ctx);

/* ---------------- bridge.js 需要的 chrome API ---------------- */

let bgResponse = { ok: true, items: 2, images: 3, imgTotal: 4, textOk: 2 };

ctx.chrome = {
  storage: {
    sync: { get(defaults, cb) { cb(defaults); }, set() {} },
    local: { get(keys, cb) { cb({}); }, set() {} },
    onChanged: { addListener() {} }
  },
  runtime: {
    onInstalled: { addListener() {} },
    onMessage: { addListener(fn) { bridgeListeners.push(fn); } },
    sendMessage(msg, cb) { if (cb) cb(bgResponse); },
    lastError: undefined
  }
};

vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/common/sites.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/common/util.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/content/injected.js'), 'utf8'), ctx);
const U = ctx.XYUtil;

/* ---------------- 加载内容脚本（放在注入脚本之后，模拟真实注入顺序） ---------------- */
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/content/bridge.js'), 'utf8'), ctx);

/* vm 里的 window 与 context 对象是不同的实例（createContext 的已知行为），
 * 消息必须带上「vm 内的那个 window」才能通过 e.source !== window 的校验。 */
const vmWindow = vm.runInContext('window', ctx);

/* 把消息喂给内容脚本（它们监听的是 window 的 message 事件） */
function feedBridge(msg) {
  searchListeners.forEach((fn) => fn({ source: vmWindow, data: msg }));
}

/* 模拟真实点击：捕获阶段先于 target 阶段。
 * 站点也会在 window 捕获阶段抢先处理并翻转 checked，
 * 所以这里额外支持「站点先动过手」的场景（见 testSiteFlipsChecked）。 */
function clickOn(target, siteHandled) {
  const ev = {
    target,
    defaultPrevented: !!(siteHandled && siteHandled.preventDefault),
    stopped: false,
    immediate: false,
    siteFlip: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.stopped = true; },
    stopImmediatePropagation() { this.stopped = true; this.immediate = true; }
  };
  if (siteHandled) {
    // 站点抢先一步：preventDefault 之外还会把 checked 翻一下
    if (target.tag === 'INPUT') target.checked = !target.checked;
    ev.siteFlip = true;
  }
  if (captureHandlers.click) captureHandlers.click(ev);
  (bubbleHandlers.click || []).forEach((fn) => fn(ev));
  return ev;
}

function askBridge(type) {
  let out = null;
  bridgeListeners.forEach((fn) => fn({ type }, {}, (r) => { out = r; }));
  return out;
}

const flush = () => new Promise((r) => setImmediate(r));

/* 待断言的上下文：勾选的商品 + 它们的打包条目 */
function selection() {
  const r = askBridge('xy:get-selected');
  return { ids: r.ids, items: r.items };
}
function checkBoxOf(id) {
  return listDoc.querySelector('.xy-check[data-xy-id="' + id + '"]') || null;
}

(async () => {
  /* === 准备：让页面上有 3 个已识别的商品 ===
   * 注入脚本已经把 window.fetch 换成钩子了，
   * 所以这里要填的是钩子内部真正调用的 mock fetch。 */
  nextPayload = {
    api: 'mtop.taobao.idle.pc.search',
    data: {
      resultList: [
        { itemId: '70000001', title: 'iPad Air 5 平板电脑', price: '2100', picUrl: '//img.alicdn.com/bao/uploaded/i1/70000001.jpg' },
        { itemId: '70000002', title: 'Switch 续航版', price: '1450', picUrl: '//img.alicdn.com/bao/uploaded/i1/70000002.jpg' },
        // 接口把卖家头像当成缩略图返回（真实存在的情况）
        { itemId: '70000003', title: 'AirPods Pro 2', price: '899', picUrl: '//img.alicdn.com/avatar/i1/seller_70000003.jpg' }
      ]
    }
  };
  ctx.fetch('https://h5.mtop.taobao.idle.pc.search/1.0/?x=1', {});
  await flush();

  // 把注入脚本给出的卡片同步给 bridge（这正是页面里发生的事）
  const cardsMsg = posted.slice().reverse().find((m) => m.type === 'cards');
  assert.ok(cardsMsg, '注入脚本应产出 cards 消息');
  feedBridge(cardsMsg);
  await flush();

  // bridge 首屏 800ms 的渲染定时器
  await new Promise((r) => setTimeout(r, 900));
  feedBridge(cardsMsg);
  await flush();

  /* === 测试 1：复选框已挂到卡片上 === */
  const box1 = checkBoxOf('70000001');
  assert.ok(box1, '70000001 的卡片上应出现复选框');
  assert.ok(captureHandlers.click, 'bridge 应在 document 捕获阶段注册 click 处理器');
  console.log('✓ 复选框已挂到页面卡片上');

  /* === 测试 2：点单个复选框能选中（原 bug） === */
  const inp1 = box1.querySelector('input');
  assert.ok(inp1, '复选框里应有 input');
  assert.strictEqual(inp1.checked, false, '初始不应勾选');

  clickOn(inp1);
  assert.strictEqual(inp1.checked, true, '点击后 input 应被勾选');
  assert.strictEqual(selection().ids.join(','), '70000001', '数据层应记录该商品，实际 ' + selection().ids.join(','));
  console.log('✓ 点击单个复选框 → 已勾选 ' + selection().ids.join(',') + '（原「点了没反应」已修复）');

  /* === 测试 3：再点一次取消 === */
  clickOn(inp1);
  assert.strictEqual(inp1.checked, false, '再次点击应取消勾选');
  assert.strictEqual(selection().ids.length, 0, '数据层应清空该商品');
  console.log('✓ 再点一次 → 取消勾选');

  /* === 测试 4：点在圆的外圈（label）也要生效 === */
  clickOn(box1);
  assert.strictEqual(box1.querySelector('input').checked, true, '点 label 区域也应勾选');
  assert.strictEqual(selection().ids.join(','), '70000001');
  clickOn(box1);
  assert.strictEqual(selection().ids.length, 0);
  console.log('✓ 点复选框外圈（label）同样生效');

  /* === 测试 5：卖家头像不能当成主图 === */
  // 场景：卡片上唯一的图是卖家头像，有效主图一张都没有
  const box3 = checkBoxOf('70000003');
  assert.ok(box3, '70000003 的卡片上应出现复选框');
  clickOn(box3.querySelector('input'));
  assert.strictEqual(selection().ids.join(','), '70000003');

  // 打包条目里必须剔掉头像，保留真实主图
  const items = selection().items;
  const it3 = items.find((i) => String(i.dir).indexOf('70000003') > -1);
  assert.ok(it3, '被勾选的商品应出现在打包条目里');
  assert.deepStrictEqual(
    it3.images.join(','),
    '',
    '卖家头像应被剔除（打包时只下到一张头像的 bug）'
  );
  assert.ok(it3.text && it3.text.length > 0, '即使没有主图，文案也要保留（不能整个跳过）');
  console.log('✓ 头像被剔除、无图商品仍保留文案（原「只下到一张头像」已修复）');

  /* === 测试 6：缺描述的卡片会触发补详情 === */
  const beforeCount = posted.filter((m) => m.type === 'ensure-cards').length;
  // 在面板上放一个真实的「勾选一键打包」按钮并点它
  const panel = listDoc.querySelector('.xy-panel');
  const panelBody = panel.querySelector('.xy-body');
  const packBtn = mkNode('button', { class: 'xy-btn' }, []);
  packBtn.dataset.act = 'b-pack';
  panelBody.appendChild(packBtn);
  clickOn(packBtn);
  await flush();
  const afterCount = posted.filter((m) => m.type === 'ensure-cards').length;
  assert.ok(afterCount > beforeCount, '缺描述的卡片应触发 ensure-cards 补详情，实际没有');
  const reqIds = (posted.slice().reverse().find((m) => m.type === 'ensure-cards') || {}).payload;
  assert.ok(reqIds && reqIds.ids.indexOf('70000003') > -1,
    '70000003 应被列入补详情清单，实际 ' + JSON.stringify(reqIds && reqIds.ids));
  console.log('✓ 缺描述的商品触发补详情：' + (reqIds ? reqIds.ids.join(', ') : ''));

  /* === 测试 7：补详情回来的数据会合并而非覆盖 === */
  feedBridge({
    source: 'xy-injected',
    type: 'card-detail',
    payload: {
      itemId: '70000003',
      title: 'AirPods Pro 2',
      desc: '全新未拆，带原包装',
      images: [
        'https://img.alicdn.com/bao/uploaded/i1/p1.jpg',
        'https://img.alicdn.com/bao/uploaded/i1/p2.jpg',
        'https://img.alicdn.com/avatar/i1/seller.jpg'
      ]
    }
  });
  await flush();
  const it3b = selection().items.find((i) => String(i.dir).indexOf('70000003') > -1);
  assert.ok(it3b, '补详情后条目应仍在');
  assert.ok(it3b.text.indexOf('全新未拆') > -1, '文案里应含补回来的描述');
  assert.strictEqual(
    it3b.images.join(','),
    'https://img.alicdn.com/bao/uploaded/i1/p1.jpg,https://img.alicdn.com/bao/uploaded/i1/p2.jpg',
    '补详情里的头像也应剔除，实际 ' + it3b.images.join(',')
  );
  console.log('✓ 补详情数据合并进条目：文案含描述，主图 2 张（头像已剔除）');

  /* === 测试 8：detailMap 里是空壳时，不能把卡片里的好数据挡掉 ===
   * 用户报的「没有可以处理的商品」就是这个：
   * 站点在列表页也发一条 detail 消息，内容只有 itemId。
   * 旧代码 `detailMap[id] || cardIndex[id]` 里 || 看的是对象是否 truthy，
   * 空壳对象照样命中，于是 title/image 全空 → 整件商品被过滤掉。 */
  clickOn(checkBoxOf('70000001'));
  await flush();

  // 先给 70000001 一份完整数据
  feedBridge({
    source: 'xy-injected',
    type: 'card-detail',
    payload: {
      itemId: '70000001',
      title: 'iPad Air 5 平板电脑',
      desc: '国行正品，配件齐全',
      images: [
        'https://img.alicdn.com/bao/uploaded/i1/p1.jpg',
        'https://img.alicdn.com/bao/uploaded/i1/p2.jpg'
      ]
    }
  });
  await flush();
  const fully = selection().items.find((i) => String(i.dir).indexOf('70000001') > -1);
  assert.ok(fully && fully.images.length === 2, '完整数据下应有 2 张主图');

  // 站点随后发来一个只有 itemId 的空壳（真机上就是这么来的）
  feedBridge({
    source: 'xy-injected',
    type: 'detail',
    payload: { itemId: '70000001', title: '', desc: '', image: '', images: [] }
  });
  await flush();

  const survived = selection().items.find((i) => String(i.dir).indexOf('70000001') > -1);
  assert.ok(survived, '详情是空壳时商品不能被丢掉（原「没有可以处理的商品」）');
  assert.ok(survived.text.indexOf('iPad Air 5 平板电脑') > -1,
    '标题应来自卡片数据，实际文案：' + JSON.stringify(survived.text));
  assert.strictEqual(survived.images.join(','),
    'https://img.alicdn.com/bao/uploaded/i1/p1.jpg,https://img.alicdn.com/bao/uploaded/i1/p2.jpg',
    '主图应来自卡片数据，实际 ' + survived.images.join(',')
  );
  console.log('✓ 详情空壳不掩盖卡片数据：标题与主图都保住了');

  /* === 测试 9：站点抢先翻转 checked 时，点一次要真的切换 ===
   * 站点的 window 捕获监听器比我们更早执行，会 preventDefault()
   * 并把 checked 翻一下。旧代码读 checked 再取反，等于点第二次，
   * 净变化为零 —— 表现就是「点了没反应 → 打包说没有可处理的商品」。 */
  const box2 = checkBoxOf('70000002');
  const inp2 = box2.querySelector('input');
  const idsBefore = selection().ids.slice();

  clickOn(inp2, { preventDefault: true });
  assert.ok(selection().ids.indexOf('70000002') > -1,
    '站点翻转 checked 后第一次点击仍应勾上，实际 ' + selection().ids.join(','));
  assert.strictEqual(inp2.__xyOn, true, '扩展应自己记下勾选状态');

  clickOn(inp2, { preventDefault: true });
  assert.strictEqual(selection().ids.indexOf('70000002'), -1,
    '第二次点击应取消勾选，实际 ' + selection().ids.join(','));
  console.log('✓ 站点抢先翻转 checked 也能正确切换：' + idsBefore.join(',') + ' → ' + selection().ids.join(','));

  console.log('\n全部测试通过 ✅');
  process.exit(0);
})().catch((e) => {
  console.error('\n✗ 测试失败：' + e.message);
  console.error(e.stack);
  process.exit(1);
});
