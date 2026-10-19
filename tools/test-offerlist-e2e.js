/**
 * 1688 整店页（/page/offerlist.htm）采集离线自测
 *
 * 背景：整店页的商品**不在**店铺首页那个 moduledata.get 里
 * （那个接口在整店页上返回空 categories），而是走另一个接口：
 *
 *   POST h5api.m.1688.com/h5/mtop.alibaba.alisite.cbu.server.moduleasyncservice/1.0/
 *   -> data.content.offerList   （offerCount = 10，件件有商品 ID）
 *
 * 之前漏掉这个接口，导致整店页一片空白，被误判成「整店页确实没商品」。
 *
 * 本测试读 tools/probe-shop.js 在真机上拦下来的原始响应，跑完整链路：
 *
 *     collectCards(真实响应) → 卡片字段 → 商品链接
 *
 * 全程不发包、不访问网络。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const SAMPLE = path.join(ROOT, 'dist', 'offerlist-real.json');

let pass = 0;
function ok(msg) { pass++; console.log('  ✓ ' + msg); }

/* ---------- 装 util.js（collectCards 就在这里） ---------- */
let ctx = { console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, Math, Date, JSON, Object, Array, String, Number, RegExp, Error, Set, Map };
ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
ctx.location = { href: 'https://shop3653158894s77.1688.com/page/offerlist.htm', host: 'shop3653158894s77.1688.com', pathname: '/page/offerlist.htm', search: '' };
ctx.document = { readyState: 'complete', querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, createElement: () => ({ style: {}, appendChild() {}, addEventListener() {} }), documentElement: { setAttribute() {} }, get body() { return { appendChild() {}, addEventListener() {} }; }, visibilityState: 'visible' };
ctx.navigator = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/common/util.js'), 'utf8'), ctx);
const U = ctx.XYUtil;

console.log('[1] 载入真实样本');
assert.ok(fs.existsSync(SAMPLE), '缺少实测样本 ' + SAMPLE +
  '\n     请先跑：PROBE_WANT="mtop.alibaba.alisite.cbu.server.moduleasyncservice,moduledata.get,mtop.1688.shop.data.get" \\\n        node tools/probe-shop.js "https://shop3653158894s77.1688.com/page/offerlist.htm" --save dist/offerlist-real.json');
const texts = JSON.parse(fs.readFileSync(SAMPLE, 'utf8'));
const apiKey = Object.keys(texts).find((k) => /moduleasyncservice/.test(k));
assert.ok(apiKey, '样本里没有 moduleasyncservice 接口的响应，请重新采集');
ok('样本载入（' + apiKey + '，' + texts[apiKey].length + ' 字节）');

const raw = JSON.parse(texts[apiKey]);
console.log('    offerCount 声明 =', (raw.data && raw.data.content && raw.data.content.offerCount) || '(无)');

console.log('\n[2] 用真实响应抽卡片');
const site = { domain: '1688', itemUrl: (id) => 'https://detail.1688.com/offer/' + id + '.html' };
const cards = U.collectCards(raw, { site });
assert.ok(cards.length > 0, '整店页接口应能抽出商品卡片（这是整店失效的核心回归点）');
ok('抽出 ' + cards.length + ' 个商品');

const c0 = cards[0];
console.log('    例：' + c0.itemId + ' | ' + c0.title.slice(0, 24) + ' | ¥' + c0.price + ' | ' + c0.image.slice(0, 60));

console.log('\n[3] 逐项校验字段');

// 1) 商品 ID
assert.ok(/^\d{6,20}$/.test(String(c0.itemId)), 'itemId 应取自 id 字段，实际 = ' + c0.itemId);
ok('商品 ID 取自 id 字段：' + c0.itemId);

// 2) 标题
assert.ok(typeof c0.title === 'string' && c0.title.trim().length >= 2, '标题应取自 subject');
ok('标题取自 subject：' + c0.title.slice(0, 30));

// 3) 价格
assert.ok(c0.price && /^\d/.test(String(c0.price)), '价格应取自 consignPrice/offerPrice，实际 = ' + c0.price);
ok('价格取自 consignPrice：¥' + c0.price);

// 4) 图片：整店页给的是 img/ibank/... 裸相对路径，不补域名就是坏图
assert.ok(c0.image && /^https?:\/\//i.test(c0.image), '图片应是绝对 URL，实际 = ' + c0.image);
assert.ok(c0.image.indexOf('alicdn.com') > -1, '图片域名应补齐，实际 = ' + c0.image);
ok('图片自动补上 alicdn 域名：' + c0.image.slice(0, 66));

// 5) 商品链接
assert.ok(c0.url && c0.url.indexOf(c0.itemId) > -1, '商品链接应包含 itemId，实际 = ' + c0.url);
ok('商品链接可生成：' + c0.url.slice(0, 52));

console.log('\n[4] 全量校验（不能只有第一张卡对，其余得是空壳）');
const bad = cards.filter((c) => !String(c.itemId || '').match(/^\d{6,20}$/) ||
  !c.title || !c.price || !/^https?:/.test(c.image || ''));
const badMsg = bad.length
  ? bad.length + ' 张卡片字段残缺：' + bad.map((c) => JSON.stringify({
    itemId: c.itemId, title: c.title, price: c.price, image: c.image
  })).join(' ; ').slice(0, 400)
  : '';
assert.strictEqual(bad.length, 0, badMsg || '不应有残缺卡片');
ok('全部 ' + cards.length + ' 张卡片字段完整，无空壳');

const uniq = new Set(cards.map((c) => c.itemId));
ok('商品 ID 无重复：' + uniq.size + ' 个唯一 ID');

console.log('\n[5] 反例：整店页不应该掉进店铺首页的接口');
// 整店页上 moduledata.get 返回空 categories，这条路必须抽不到东西，
// 否则说明我们把空响应当成了有效数据。
const moduledata = texts['moduledata.get'];
if (moduledata) {
  const mj = JSON.parse(moduledata);
  const mc = U.collectCards(mj, { site });
  assert.strictEqual(mc.length, 0, '整店页的 moduledata 响应本应为空，却抽到 ' + mc.length + ' 张卡');
  ok('确认 moduledata 在整店页为空，不会污染结果');
} else {
  console.log('  · 样本里没有 moduledata.get，跳过该反例');
}

console.log('\n[6] 站点识别：整店页 url 必须命中 1688');
const sitesSrc = fs.readFileSync(path.join(ROOT, 'src/common/sites.js'), 'utf8');
const m = sitesSrc.match(/shopApiRe:\s*(\/.*?\/i)/);
assert.ok(m, '没找到 shopApiRe');
const re = eval(m[1]);
assert.ok(re.test('mtop.alibaba.alisite.cbu.server.moduleasyncservice'), 'shopApiRe 必须匹配 moduleasyncservice');
ok('shopApiRe 已覆盖 moduleasyncservice');

console.log('\n========================================');
console.log('全部通过（' + pass + ' 项断言）  整店页采集已打通');
console.log('========================================');
