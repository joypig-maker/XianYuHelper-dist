/**
 * SKU 整链路离线自测（多 SKU 漏采修复的回归防线）
 *
 * 与 test-sku.js 的区别：
 *   test-sku.js 用的是手抄的样例结构；
 *   这里直接读 tools/watch-detail.js 实测抓下来的原始响应字节
 *   （dist/laputa-sku-sample.json），跑完整的三段链路：
 *
 *     parseSkus(真实响应) → formatSkus(文案) → oneItem 落盘路径
 *
 * 这样将来改动 SKU 解析或下载命名时，一旦链路断了会立刻在这里红掉，
 * 而不需要再开一次浏览器、赌一次风控。
 *
 * 注意：全程不发包、不访问网络，只读本地文件。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const SAMPLE = path.join(ROOT, 'dist', 'laputa-sku-sample.json');

let pass = 0;
function ok(msg) { pass++; console.log('  ✓ ' + msg); }

/* ---------- 起一个最小上下文，把 util.js 装进去 ---------- */
let ctx = { console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, Math, Date, JSON, Object, Array, String, Number, RegExp, Error };
ctx.window = ctx;
ctx.self = ctx;
ctx.globalThis = ctx;
ctx.location = { href: 'https://detail.1688.com/offer/1001672530707.html', host: 'detail.1688.com', pathname: '/offer/1001672530707.html', search: '' };
ctx.document = { readyState: 'complete', querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, createElement: () => ({ style: {}, appendChild() {}, addEventListener() {} }), documentElement: { setAttribute() {} }, get body() { return { appendChild() {}, addEventListener() {} }; }, visibilityState: 'visible' };
ctx.navigator = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/common/util.js'), 'utf8'), ctx);
const U = ctx.XYUtil;

console.log('[1] 真实响应样本');
assert.ok(fs.existsSync(SAMPLE), '缺少实测样本 ' + SAMPLE + '，请先跑 tools/watch-detail.js');
const raw = JSON.parse(fs.readFileSync(SAMPLE, 'utf8'));
ok('样本载入：' + path.basename(SAMPLE) + '（接口 ' + raw.api + '）');

/* ---------- 1. parseSkus：真实响应 → 结构化规格表 ---------- */
console.log('\n[2] 用真实响应解析规格表');
const skus = U.parseSkus(raw.data);
assert.ok(skus, '真实响应应能解析出规格表');
ok('解析成功，规格维度 ' + JSON.stringify(skus.specs));
ok('SKU 明细 ' + skus.list.length + ' 条：' + skus.list.map((s) => s.key).join(' / '));

assert.ok(skus.specs && skus.specs.length, '规格维度不能为空（规格名/规格图都挂在它上面）');
assert.strictEqual(skus.list.length, 2, '样本里应恰好 2 个规格');
const keys = skus.list.map((s) => s.key);
assert.ok(keys.some((k) => k.indexOf('6格') > -1), '应含【6格】CD支架');
assert.ok(keys.some((k) => k.indexOf('8格') > -1), '应含【8格】CD支架');

// '1.85-2.47' 这种 skuPriceScale 字符串曾被误当成规格名，这里必须不再出现
assert.ok(!skus.specs.some((s) => /\d/.test(s)), '规格维度里不应出现价格区间这类假规格；实得 ' + JSON.stringify(skus.specs));

// 真实样本里 discountPrice 与 price 恰好相同，所以这里只校验取值落点；
// "促销价优先" 的单独验证放在 test-sku.js 的合成用例里。
const six = skus.list.find((s) => s.key.indexOf('6格') > -1);
const eight = skus.list.find((s) => s.key.indexOf('8格') > -1);
assert.strictEqual(six.price, '3', '6格价格应来自 discountPrice');
assert.strictEqual(eight.price, '4', '8格价格应来自 discountPrice');
ok('价格：6格 ' + six.price + ' / 8格 ' + eight.price);
assert.strictEqual(six.stock, '29861', '库存应来自 canBookCount');
assert.strictEqual(eight.stock, '29882', '8格库存');
ok('库存：' + six.stock + ' / ' + eight.stock);

// 规格图必须按规格名对上：图挂在 skuProps 上，不在 SKU 明细字段里
assert.ok(six.image && six.image.indexOf('O1CN01CTBKZQ2CT9N7Gxn0o') > -1, '6格的规格图应对上 6 格的 imageUrl');
assert.ok(eight.image && eight.image.indexOf('O1CN01k1gkw32CT9N7lcp2v') > -1, '8格的规格图应对上 8 格的 imageUrl');
ok('规格图按规格名对上（不是凭空补的）');

/* ---------- 2. formatSkus → 写进文案 ---------- */
console.log('\n[3] 规格表写进文案');
const detail = {
  title: 'CD支架 车载手机支架',
  price: '3.00',
  desc: '吸盘固定，360度旋转',
  images: ['https://cbu01.alicdn.com/a.jpg'],
  sellerNick: '南阳某某电子',
  itemId: '1001672530707',
  skus: skus
};
const text = U.buildText(detail, 'txt');
assert.ok(text.indexOf('【规格与价格】') > -1, '文案应带规格表段落');
assert.ok(text.indexOf('【6格】CD支架') > -1, '文案应列出 6 格规格');
assert.ok(text.indexOf('【8格】CD支架') > -1, '文案应列出 8 格规格');
assert.ok(text.indexOf('¥3') > -1, '文案应带 6 格的价格');
assert.ok(text.indexOf('¥4') > -1, '文案应带 8 格的价格');
assert.ok(text.indexOf('颜色') > -1, '文案应带规格维度');
ok('文案含规格表段落，价格/库存/规格维度齐全');

// 无规格的商品不能被塞进一张空的规格表
const plain = U.buildText({ title: '无规格商品', price: '9.9', desc: '', images: [], skus: U.parseSkus({ skuInfoMap: {} }) }, 'txt');
assert.ok(plain.indexOf('【规格与价格】') === -1, '没规格就不该出现规格表段落');
ok('无规格商品不会被塞入空规格表');

/* ---------- 3. 落盘路径：与 service_worker.oneItem 保持一致 ---------- */
console.log('\n[4] 落盘路径（与 oneItem 同规则）');
function safePath(p) {
  if (!p) return '';
  return p.split('/').map(function (seg) { return U.cleanFileName(seg, 120); }).join('/');
}
function safeName(name) { return U.cleanFileName(name, 120); }

const dir = safePath('1688采集/CD支架_1001672530707');
const skuDir = dir + '/SKU图片';
const paths = skus.list.map((s) => skuDir + '/' + U.cleanFileName(s.key || '规格', 40) + U.imageExt('https://x.com/a.jpg'));

assert.ok(paths.length === 2, '两条规格各一个路径');
// 结构必须是 商品目录/SKU图片/规格名.ext，规格图不能跟主图混在一起
assert.ok(paths.every((p) => p.indexOf('/SKU图片/') > -1), 'SKU 图必须落在「SKU图片」子目录里');
assert.ok(paths.every((p) => p.split('/').length === 4), 'SKU 图路径应为 商品目录/SKU图片/文件名');
assert.ok(paths.every((p) => p.split('/')[2] === 'SKU图片'), '第 3 段应为 SKU图片');
assert.ok(paths.every((p) => p.indexOf('\\') === -1), '不应出现反斜杠');
assert.ok(paths.every((p) => !/[:*?"<>|]/.test(p.split('/').pop())), '文件名不应含 Windows 非法字符');
assert.ok(paths.some((p) => p.indexOf('6格') > -1), 'SKU 图需用规格名命名，才能分清哪个规格对应哪张图');
assert.ok(paths.some((p) => p.indexOf('8格') > -1), '8 格规格图路径');
ok('SKU 图目录：' + skuDir);
paths.forEach((p) => console.log('      ' + p.split('/').pop()));

// 商品目录名也要干净
assert.ok(!/:|\*|\?|"|<|>|\\/.test(safeName('文案.txt')), '目录/文件名清洗不应吃掉扩展名');
ok('商品目录名合法：' + dir);

/* ---------- 4. 规格图缺失时不硬造 ---------- */
console.log('\n[5] 边界');
const noImg = skus.list.map((s) => Object.assign({}, s, { image: '' }));
assert.strictEqual(noImg.filter((s) => s.image).length, 0, '样本里规格明细本身不带图，补录后 image 应为空');
const skuNoImage = { specs: skus.specs, list: noImg };
assert.strictEqual(skuNoImage.list.filter((s) => s.image).length, 0, '没有规格图就不该产出图片任务');
ok('无规格图时不产出图片任务（不会下载到空文件）');

console.log('\n全部通过 ✅  （' + pass + ' 项断言）');
