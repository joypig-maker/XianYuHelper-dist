/**
 * 站点适配层自测（node tools/test-sites.js）
 *
 * 验证三件事：
 *   1. 域名 -> 站点 的匹配是否正确
 *   2. 各站点的 ID 正则 / 链接模板是否自洽
 *   3. scanCards 能不能在模拟的 1688 / 闲鱼页面结构上真的抓到卡片
 *      （这一条最关键——选择器只有跑在结构样本上才算数）
 */
require('../src/common/sites.js');
require('../src/common/util.js');

var S = globalThis.XYSites;
var U = globalThis.XYUtil;
var assert = require('assert');

/* ---------------- 极简 DOM mock ---------------- */
// 只实现被测代码用到的那几个方法，够验证选择器链路就行。

function parseSelector(sel) {
  var out = { tag: '', id: '', classes: [], attrs: [] };
  var s = String(sel).trim();
  var m = s.match(/^([a-zA-Z][\w-]*)?/);
  if (m && m[1]) out.tag = m[1].toLowerCase();
  var rest = s.slice(m ? m[0].length : 0);
  // #id 以前解析不出来会落成「空条件」，而空条件恒真——closest('#x') 会命中一切
  var im = rest.match(/#([\w-]+)/);
  if (im) out.id = im[1].toLowerCase();
  rest = rest.replace(/#[\w-]+/g, '');
  var cm = rest.match(/(?:\.([\w-]+))+/g) || [];
  cm.forEach(function (c) {
    c.split('.').forEach(function (p) { if (p) out.classes.push(p.toLowerCase()); });
  });
  var am = rest.match(/\[[^\]]*\]/g) || [];
  am.forEach(function (a) {
    var inner = a.slice(1, -1);
    var mm = inner.match(/^([\w-]+)(?:([\*=\~\|]?=)"?([^"\]]*)"?)?$/);
    if (mm) out.attrs.push({ name: mm[1], op: mm[2] || '', value: mm[3] || '' });
  });
  return out;
}

function matches(el, sel) {
  return String(sel).split(',').some(function (part) {
    var p = parseSelector(part);
    // 没有任何条件的选择器不该匹配任何东西——否则它恒真
    if (!p.tag && !p.id && !p.classes.length && !p.attrs.length) return false;
    if (p.tag && String(el.tagName).toLowerCase() !== p.tag) return false;
    if (p.id && String(el.getAttribute('id') || '').toLowerCase() !== p.id) return false;
    if (p.classes.length) {
      var has = String(el.getAttribute('class') || '').toLowerCase().split(/\s+/);
      for (var i = 0; i < p.classes.length; i++) {
        if (has.indexOf(p.classes[i]) === -1) return false;
      }
    }
    for (var j = 0; j < p.attrs.length; j++) {
      var a = p.attrs[j];
      var v = el.getAttribute(a.name);
      if (v == null || v === '') return false;
      if (a.op === '*=' && v.indexOf(a.value) === -1) return false;
      if (a.op === '=' && v !== a.value) return false;
    }
    return true;
  });
}

function El(tag, attrs, text) {
  this.tagName = tag;
  this.attrs = attrs || {};
  this._text = text || '';
  this.children = [];
  this.parentElement = null;
}

El.prototype.getAttribute = function (k) {
  return this.attrs[k] != null ? String(this.attrs[k]) : null;
};
El.prototype.matches = function (sel) { return matches(this, sel); };
El.prototype.querySelectorAll = function (sel) {
  var out = [];
  var walk = function (n) {
    n.children.forEach(function (c) {
      if (matches(c, sel)) out.push(c);
      walk(c);
    });
  };
  walk(this);
  return out;
};
El.prototype.querySelector = function (sel) {
  return this.querySelectorAll(sel)[0] || null;
};
El.prototype.appendChild = function (c) {
  c.parentElement = this;
  this.children.push(c);
  return c;
};
El.prototype.getBoundingClientRect = function () {
  return { width: 240, height: 320, top: 0, left: 0 };
};
// 真实 DOM 里 <img>.src / <a>.href 这类属性会从 attribute 自动反射，
// mock 必须照做，否则 imgFromElement 之类读不到值
['src', 'href', 'id', 'title', 'type', 'value', 'checked'].forEach(function (prop) {
  Object.defineProperty(El.prototype, prop, {
    get: function () {
      return this.attrs[prop] != null ? String(this.attrs[prop]) : '';
    }
  });
});
Object.defineProperty(El.prototype, 'className', {
  get: function () { return this.getAttribute('class') || ''; }
});
Object.defineProperty(El.prototype, 'textContent', {
  get: function () {
    if (this._text) return this._text;
    return this.children.map(function (c) { return c.textContent; }).join('');
  }
});

// El.prototype.querySelectorAll 已能递归查找，这里不能再覆盖掉
function page() {
  return new El('body', {});
}

/* ---------------- 1. 域名匹配 ---------------- */

assert.strictEqual(S.match('www.1688.com').key, 'p1688', '1688 应命中 p1688');
assert.strictEqual(S.match('detail.1688.com').key, 'p1688', 'detail 子域也应命中');
assert.strictEqual(S.match('s.1688.com').key, 'p1688', '搜索域也应命中');
assert.strictEqual(S.match('www.goofish.com').key, 'xianyu', '闲鱼不应被 1688 抢走');
assert.strictEqual(S.match('xxx.taobao.com').key, 'taobao',
  '淘宝域名应命中 taobao');
// 淘宝自 2026-09-28 起正式接入（搜索页 / 整店页），不再是占位配置
assert.strictEqual(S.active('xxx.taobao.com').key, 'taobao', '淘宝已启用，active 应返回站点');
assert.ok(!S.inactive({ host: 'xxx.taobao.com' }), '淘宝已启用，inactive 应为 false');
assert.strictEqual(S.match('detail.tmall.com').key, 'taobao', '天猫域名同样命中 taobao');
assert.strictEqual(S.match('minwai.tmall.com').key, 'taobao', '品牌店铺域名命中 taobao');
assert.strictEqual(S.match('example.com'), null, '无关域名不命中');
assert.strictEqual(S.active('example.com'), null);
console.log('✓ 域名匹配通过（1688 / 闲鱼 / 淘宝已启用 / 无关域）');

/* ---------------- 2. ID 提取与链接模板 ---------------- */

var p1688 = S.get('p1688');

function idOf(url) {
  var m = String(url).match(p1688.idRe);
  return m ? String(m[1] || m[2] || '') : '';
}

assert.strictEqual(idOf('https://detail.1688.com/offer/671812345678.html'), '671812345678');
assert.strictEqual(idOf('https://s.1688.com/selloffer/offer_view.htm?offerId=671812345678'), '671812345678');
assert.strictEqual(idOf('https://detail.1688.com/page/offer.html?offerId=671812345678'),
  '671812345678', '短链/店铺内商品链接形态');
assert.strictEqual(idOf('https://detail.1688.com/offer/123'), '',
  '过短的 ID 不应命中，避免把页面噪声当成商品');
assert.strictEqual(idOf('https://www.1688.com/'), '', '非商品页不应误命中');
console.log('✓ 1688 offerId 提取通过（两种 URL 形态 + 不误命中）');

assert.strictEqual(p1688.itemUrl('671812345678'),
  'https://detail.1688.com/offer/671812345678.html', '商品链接模板');
assert.ok(p1688.linkSel('671812345678').indexOf('671812345678') > -1,
  '卡片定位选择器要带上 id');
console.log('✓ 1688 链接模板与定位选择器自洽');

/* ---------------- 3. 区间价 ---------------- */

assert.strictEqual(U.firstPrice('18.90-25.00'), '18.90', '批发区间价取下限');
assert.strictEqual(U.firstPrice('¥18.90起'), '18.90', '带前缀的价格');
assert.strictEqual(U.firstPrice(''), '', '空串');
console.log('✓ 区间价解析通过');

/* ---------------- 4. 1688 列表页 DOM 扫描 ---------------- */

var doc1688 = page();
var card1 = new El('div', { class: 'sm-offer-item' });
card1.appendChild(new El('a', {
  class: 'title',
  href: '//detail.1688.com/offer/671812345678.html',
  title: '2025新款TWS蓝牙耳机'
}, '2025新款TWS蓝牙耳机'));
card1.appendChild(new El('div', { class: 'price' }, '¥18.90-25.00'));
var imgWrap = new El('a', { class: 'offer-img', href: 'https://detail.1688.com/offer/671812345678.html' });
imgWrap.appendChild(new El('img', { src: '//cbu01.alicdn.com/img/bank/abcdef.jpg_400x400q90.jpg' }));
card1.appendChild(imgWrap);
card1.appendChild(new El('div', { class: 'company' }, '深圳市某某电子商行'));
doc1688.appendChild(card1);

var got = U.scanCards(doc1688, p1688);
assert.strictEqual(got.length, 1, '应抓到 1 个 1688 商品');
assert.strictEqual(got[0].itemId, '671812345678', 'itemId');
assert.strictEqual(got[0].title, '2025新款TWS蓝牙耳机', '标题');
assert.strictEqual(got[0].price, '18.90', '区间价要取下限，不能输出 18.9025.00');
assert.strictEqual(got[0].image, 'https://cbu01.alicdn.com/img/bank/abcdef.jpg', '主图去压缩后缀');
assert.strictEqual(got[0].sellerNick, '深圳市某某电子商行', '店铺名');
assert.strictEqual(got[0].url, 'https://detail.1688.com/offer/671812345678.html', '商品链接');
console.log('✓ 1688 列表页扫描通过：' +
  JSON.stringify({ t: got[0].title, p: got[0].price, s: got[0].sellerNick }));

/* ---------------- 5. 闲鱼回归（不能退化） ---------------- */

var xy = S.get('xianyu');
var docXY = page();
var xyCard = new El('a', { href: 'https://www.goofish.com/item?id=1054899470781' });
xyCard.appendChild(new El('img', { src: '//img.alicdn.com/bao/uploaded/i4/aaa.jpg' }));
xyCard.appendChild(new El('div', { class: 'title' }, '出一台 iPhone 15 128G'));
xyCard.appendChild(new El('div', { class: 'price' }, '¥3980'));
xyCard.appendChild(new El('div', { class: 'userNick' }, '小王数码严选'));
docXY.appendChild(xyCard);

var gotXY = U.scanCards(docXY, xy);
assert.strictEqual(gotXY.length, 1, '闲鱼仍应抓到 1 个商品');
assert.strictEqual(gotXY[0].itemId, '1054899470781');
assert.strictEqual(gotXY[0].title, '出一台 iPhone 15 128G');
assert.strictEqual(gotXY[0].price, '3980');
assert.strictEqual(gotXY[0].sellerNick, '小王数码严选');
console.log('✓ 闲鱼扫描回归通过（未被站点化改造破坏）');

/* ---------------- 6. 店铺页配置 ---------------- */

assert.ok(p1688.shopPage, '1688 要配店铺页识别');
assert.ok(p1688.shopPage.hostRe.test('shop123456789.1688.com'), '店铺域名应命中');
// 实测真实形态：字母数字混排，早期 /^shop\d*/ 一律漏掉，整店模式因此失效
assert.ok(p1688.shopPage.hostRe.test('shop3g5365975f5y2.1688.com'), '混排店铺域名（真实形态）应命中');
assert.ok(p1688.shopPage.hostRe.test('shop289586509g3k1.1688.com'), '混排店铺域名2应命中');
assert.ok(p1688.shopPage.urlRe.test('/'), '店铺首页根路径应算店铺页');
assert.ok(p1688.shopPage.urlRe.test('/page/offerlist.htm'), '店铺页路径应命中');
assert.ok(!p1688.shopPage.hostRe.test('detail.1688.com'), '详情域名不应误判为店铺页');
assert.ok(!p1688.shopPage.hostRe.test('s.1688.com'), '搜索域名不应误判为店铺页');

// 店铺页商品不走搜索接口，走店铺模块接口。
// 实测（2026-09-27，店铺 shop3653158894s77.1688.com）：
//   h5api.m.1688.com/h5/mtop.alisite.cbu.winport.sync.moduledata.get/1.0/
//   之前配的 wp.m.1688.com/pc/render/unifiedRenderData 在店铺页上压根没被调用过。
assert.ok(p1688.shopApiRe &&
  p1688.shopApiRe.test('https://h5api.m.1688.com/h5/mtop.alisite.cbu.winport.sync.moduledata.get/1.0/')
  , '店铺页商品接口（moduledata.get）应命中');
assert.ok(p1688.shopApiRe.test('offerModuleList'), '店铺商品数组 offerModuleList 也应命中');
assert.ok(!p1688.shopApiRe.test('https://detail.1688.com/offer/1001672530707.html'), '普通详情页不应误判成店铺接口');
assert.ok(!p1688.shopApiRe.test('https://s.1688.com/selloffer/offer_search.html'), '搜索接口不应误判成店铺接口');

// 内嵌数据通道：规格表就在 window.context 里
assert.ok(p1688.embedded, '1688 应配页面内嵌数据通道');
assert.deepStrictEqual(Array.from(p1688.embedded.paths), ['result', 'data', 'Root', 'fields', 'dataJson'], '内嵌数据路径应指向 dataJson');
assert.ok(p1688.embedded.idPaths && p1688.embedded.idPaths.length > 0, '内嵌数据必须校验商品 ID，防止张冠李戴');
assert.ok(p1688.embedded.idPaths.some(function (p) { return /1001672530707/.test(p); }) ||
  p1688.embedded.idPaths.indexOf('result.global.globalData.model.offerDetail.offerId') > -1,
  '应能校验 offerId');
console.log('✓ 店铺页接口通道与内嵌数据通道配置通过');
console.log('✓ 店铺页识别通过（正例 + 防误判）');

/* ---------------- 7. 诊断快照（函数要换成占位符） ---------------- */

var snap = {};
Object.keys(p1688).forEach(function (k) {
  snap[k] = typeof p1688[k] === 'function' ? '(function)' : p1688[k];
});
assert.strictEqual(snap.itemUrl, '(function)', '函数要占位，避免 JSON 序列化时丢字段');
assert.strictEqual(typeof snap.cardSel, 'string');
console.log('✓ 诊断快照可安全序列化');

console.log('\n全部测试通过 ✅');
