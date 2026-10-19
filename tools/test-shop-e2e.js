/**
 * 1688 整店采集离线自测（整店失效修复的回归防线）
 *
 * 与 test-sites.js 的区别：
 *   test-sites.js 断的是域名匹配和字段路径；
 *   这里直接读 tools/probe-shop.js 在真实店铺页上拦下来的原始响应，
 *   跑完整的整条链路：
 *
 *     collectCards(真实响应) → 卡片字段 → 下载目录命名
 *
 * 这样将来改字段映射或接口名时，一旦链路断了会立刻在这里红掉，
 * 而不需要再开一次浏览器。全程不发包、不访问网络。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const SAMPLE = path.join(ROOT, 'dist', 'shop-moduledata-sample.json');

let pass = 0;
function ok(msg) { pass++; console.log('  ✓ ' + msg); }

/* ---------- 装 util.js（collectCards 就在这里） ---------- */
let ctx = { console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, Math, Date, JSON, Object, Array, String, Number, RegExp, Error, Set, Map };
ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
ctx.location = { href: 'https://shop3653158894s77.1688.com/', host: 'shop3653158894s77.1688.com', pathname: '/', search: '' };
ctx.document = { readyState: 'complete', querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, createElement: () => ({ style: {}, appendChild() {}, addEventListener() {} }), documentElement: { setAttribute() {} }, get body() { return { appendChild() {}, addEventListener() {} }; }, visibilityState: 'visible' };
ctx.navigator = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/common/util.js'), 'utf8'), ctx);
const U = ctx.XYUtil;

console.log('[1] 真实响应样本');
assert.ok(fs.existsSync(SAMPLE), '缺少实测样本 ' + SAMPLE + '，请先跑 tools/probe-shop.js <店铺URL> --save dist/shop-moduledata-sample.json');
const texts = JSON.parse(fs.readFileSync(SAMPLE, 'utf8'));
const key = Object.keys(texts)[0];
ok('样本载入（' + key + '，' + texts[key].length + ' 字节）');

const raw = JSON.parse(texts[key]);
console.log('\n[2] 用真实响应抽卡片');
const cards = U.collectCards(raw, { site: { itemUrl: (id) => 'https://detail.1688.com/offer/' + id + '.html' } });

assert.ok(cards.length > 0, '店铺接口应能抽出商品卡片');
ok('抽出 ' + cards.length + ' 个商品');

const c0 = cards[0];
console.log('    例：' + c0.itemId + ' | ' + c0.title.slice(0, 26) + ' | ¥' + c0.price + ' | ' + c0.image.slice(0, 62));

/* ---------- 逐项断言：这些正是之前全部缺失的字段 ---------- */
console.log('\n[3] 逐项校验字段（映射错一项，整店就是一堆空壳卡片）');

// 1) 商品 ID：接口里字段叫 id，不叫 offerId
assert.ok(/^\d{6,20}$/.test(String(c0.itemId)), 'itemId 应从 id 字段取，实际 = ' + c0.itemId);
ok('商品 ID 取自 id 字段：' + c0.itemId);

// 2) 标题：接口里叫 subject
assert.ok(typeof c0.title === 'string' && c0.title.trim().length >= 2, '标题应取自 subject');
ok('标题取自 subject：' + c0.title.slice(0, 30) + '…');

// 3) 价格：接口里叫 consignPrice（"12.00"），不是 price
assert.ok(c0.price && /^\d/.test(c0.price), '价格应取自 consignPrice，实际 = "' + c0.price + '"');
ok('价格取自 consignPrice：¥' + c0.price);

// 4) 图片：在 offerImages[0].imageURI，且是裸相对路径，必须补全域名
assert.ok(c0.image && /^https?:/i.test(c0.image), '图片应补全为绝对地址，实际 = "' + c0.image + '"');
assert.ok(c0.image.indexOf('cbu01.alicdn.com') > -1, '图片应补上 cbu01.alicdn.com，实际 = ' + c0.image);
ok('图片补全域名：' + c0.image.slice(0, 70));

// 5) 链接
assert.ok(c0.url && c0.url.indexOf(c0.itemId) > -1, 'url 应指向该商品');
ok('详情页链接：' + c0.url);

// 6) 全量一致性：10 个商品不该有缺胳膊少腿的
const badId = cards.filter((c) => !/^\d{6,20}$/.test(String(c.itemId)));
const badPrice = cards.filter((c) => !c.price);
const badImg = cards.filter((c) => !/^https?:/i.test(c.image || ''));
assert.strictEqual(badId.length, 0, '不该有空 itemId');
assert.strictEqual(badPrice.length, 0, '不该有空价格');
assert.strictEqual(badImg.length, 0, '不该有坏图');
ok('全量 ' + cards.length + ' 个商品，ID/价格/图片均完整');

const ids = new Set(cards.map((c) => c.itemId));
assert.strictEqual(ids.size, cards.length, '商品 ID 不应重复');
ok('无重复商品');

/* ---------- 4. 下载目录命名 ---------- */
console.log('\n[4] 落盘路径');
const safe = U.cleanFileName ? U.cleanFileName : function (s) { return String(s).replace(/[\\/:*?"<>|]/g, '_'); };
const p0 = '下载/闲鱼采集/' + safe(c0.title) + '/' + (0 + 1) + U.imageExt(c0.image);
assert.ok(p0.indexOf('cib') === -1 && p0.indexOf('.310x310') === -1, '路径不该带图片处理后缀');
assert.ok(path.basename(p0) === '1' + U.imageExt(c0.image), '主图应以序号命名，实际 ' + path.basename(p0));
ok('主图路径：' + p0);

console.log('\n全部通过（' + pass + ' 项断言）');
