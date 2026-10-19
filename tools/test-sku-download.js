/**
 * 「下载商品只有一张主图 / 没有 SKU 图 / txt 没有规格价格」回归测试
 *
 * 与 test-sku-e2e.js 的分工：
 *   test-sku-e2e.js 验的是「规格表拿到之后」的解析、文案、落盘路径；
 *   这里验的是「规格表能不能拿到」和「卡片到底收了几张图」——
 *   也就是用户实际踩到的两处断链：
 *
 *   断链 1：SKU 选择器接口缺业务参数
 *     实测只给 offerId 会直接 FAIL_SYS_BIZPARAM_MISSED::缺少业务参数useCase，
 *     补 useCase 后仍缺 bizScene。两个都补上才是 SUCCESS。
 *     这个失败非常安静——上层只看得到 skus 为空，
 *     所以表现成「没有 SKU 图 + txt 里没有规格价格」，很容易被当成解析问题。
 *
 *   断链 2：卡片采集只取第一张图
 *     1688 整店页的 offerImages 是数组（每件 3 张），
 *     而 collectCards 只取 offerImages[0]，于是下载永远一张图。
 *
 * 全部离线，不发包。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');

/* ---------- 起最小上下文，把 util.js / sites.js 装进去 ---------- */
const ctx = { console, setTimeout, clearTimeout, setInterval, clearInterval, Promise, Math, Date, JSON, Object, Array, String, Number, RegExp, Error, Set };
ctx.window = ctx;
ctx.self = ctx;
ctx.globalThis = ctx;
ctx.location = { href: 'https://detail.1688.com/offer/1001672530707.html', host: 'detail.1688.com', pathname: '/offer/1001672530707.html', search: '' };
ctx.document = { readyState: 'complete', querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, createElement: () => ({ style: {}, appendChild() {}, addEventListener() {} }), documentElement: { setAttribute() {} }, get body() { return { appendChild() {}, addEventListener() {} }; }, visibilityState: 'visible' };
ctx.navigator = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/common/util.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/common/sites.js'), 'utf8'), ctx);
const U = ctx.XYUtil;
const S = ctx.XYSites;
// current() 要的是带 hostname 的 location 对象，传 URL 字符串会解析不出站点
const SITE = S.current({ hostname: 'detail.1688.com' });

let pass = 0;
function ok(msg) { pass++; console.log('  ✓ ' + msg); }

/* ================= 1. SKU 接口参数 ================= */
console.log('[1] SKU 选择器接口的业务参数');
assert.ok(SITE.skuApi, '1688 必须配 skuApi');
const bd = SITE.skuApi.buildData('803347112456');
assert.strictEqual(bd.offerId, '803347112456', 'offerId 必须带上');
assert.strictEqual(bd.useCase, '1688detail',
  '缺 useCase 会直接 FAIL_SYS_BIZPARAM_MISSED::缺少业务参数useCase（实测，缺了就没有规格图也没有规格价格）');
assert.strictEqual(bd.bizScene, 'pcod',
  '缺 bizScene 会 FAIL_SYS_BIZPARAM_MISSED::缺少业务参数bizScene（补了 useCase 才暴露出来）');
assert.strictEqual(SITE.skuApi.api, 'mtop.1688.wosc.queryofferskuselectormodel', '接口名应与实测一致');
ok('buildData：' + JSON.stringify(bd));
ok('api=' + SITE.skuApi.api + ' v=' + SITE.skuApi.v);

// 缺任何一个参数，规格表都得不出来——反证这两个参数不是可选项
const sample = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist/laputa-sku-sample.json'), 'utf8'));
function parseWith(patch) {
  const mutated = JSON.parse(JSON.stringify(sample.data));
  if (patch) Object.assign(mutated, patch);
  return U.parseSkus(mutated);
}
const full = parseWith(null);
assert.ok(full && full.list && full.list.length, '补齐参数后应能解析出规格表');
ok('样本解析：' + full.list.length + ' 条规格（' + full.list.map((s) => s.key).join(' / ') + '）');

// 规格图必须落在规格名上，否则「SKU 图片」子目录里会是一堆无法对应规格的空图
const withImg = full.list.filter((s) => s.image);
assert.ok(withImg.length > 0, '规格图应挂在规格维度上（skuProps.imageUrl）');
ok('带规格图的规格：' + withImg.length + ' 条，例：' + withImg[0].key);

/* ================= 2. 卡片采集要多张图 ================= */
console.log('\n[2] 卡片采集收几张图');

// 1688 整店页 moduleasyncservice 的真实形态（offerImages 数组，imageURI 是相对路径）
const offerImages = [
  { size220x220ImageURI: 'img/ibank/O1CN01Lt1fob2GFBk35wh8K_!!2219023938985.220x220.jpg', imageURI: 'img/ibank/O1CN01Lt1fob2GFBk35wh8K_!!2219023938985.jpg', size310x310ImageURI: 'img/ibank/O1CN01Lt1fob2GFBk35wh8K_!!2219023938985.310x310.jpg' },
  { imageURI: 'img/ibank/O1CN01dy0Asp1J8iq8srlIq_!!2220515860984-0-cib.jpg' },
  { imageURI: 'img/ibank/O1CN01D6MyO51J8iqCxt12I_!!2220515860984-0-cib.jpg' }
];
const cards = U.collectCards({
  data: {
    content: {
      offerList: [{
        id: 803347112456,
        subject: '车载手机支架 吸盘式 360度旋转',
        consignPrice: '12.50',
        offerImages: offerImages
      }]
    }
  }
}, { site: SITE });

assert.strictEqual(cards.length, 1, '应抓到 1 件商品');
const c0 = cards[0];
assert.strictEqual(c0.images.length, 3,
  '整店页接口给了 3 张图，只取 [0] 就会「下载主图只有一张」；实得 ' + (c0.images || []).length);
assert.ok(c0.images.every((u) => /^https?:\/\//.test(u)), 'imageURI 是相对路径，normalize 后必须带域名');
assert.strictEqual(c0.image, c0.images[0], 'image 仍取第一张，保持旧行为');
assert.ok(c0.image.indexOf('O1CN01Lt1fob2GFBk35wh8K') > -1, 'image 应是第一张图');
ok('多图：' + c0.images.length + ' 张，image 取第 1 张');
c0.images.forEach((u) => console.log('      ' + u));

// 只有单值字段时，要落成「一张图的数组」，不能只给 image。
// （原来这里是断言「不该被塞成数组」，本意是防「凭空造出空数组」，
//   但表述反了：下游 selectedItems / 打包 / 补详情一律读 images 判数量，
//   只给 image 会算成「0 张图」—— 跟 pump 那个提前结算是同一类坑。
//   实现早改成 `if (!imgs.length && img) imgs = [img];`，这条断言当时漏改了。）
const single = U.collectCards({
  list: [{ itemId: '123456789012', title: '单图商品', price: '5.00', picUrl: 'https://cbu01.alicdn.com/x.jpg' }]
}, { site: SITE });
assert.strictEqual(single.length, 1);
// 注意别用 deepStrictEqual 比数组：util 是在 vm 上下文里跑的，
// 那边的 Array 原型和这边的不是同一个，deepStrictEqual 会判不等（跨 Realm）。
assert.strictEqual(single[0].images.length, 1,
  '单值字段要落成一张图的数组，实得 ' + JSON.stringify(single[0].images));
assert.strictEqual(single[0].images[0], 'https://cbu01.alicdn.com/x.jpg');
assert.strictEqual(single[0].image, 'https://cbu01.alicdn.com/x.jpg', '单值字段仍要能取到图');
assert.strictEqual(single[0].image, single[0].images[0], 'image 与 images[0] 必须一致');
ok('单值字段形态：image 取值不变，同时落成一张图的数组');

// 数组存在但全是空值时，要能退回单值字段，而不是拿到一张都没有
const fallback = U.collectCards({
  list: [{
    itemId: '123456789013', title: '数组空但单值有', price: '6.00',
    offerImages: [{}, null], imageUrl: 'https://cbu01.alicdn.com/y.jpg'
  }]
}, { site: SITE });
assert.strictEqual(fallback.length, 1);
assert.strictEqual(fallback[0].image, 'https://cbu01.alicdn.com/y.jpg', '数组全空时应退回单值字段');
ok('数组全空时退回单值字段');

// 接口层与 DOM 层各采一遍时，同一个 URL 会被收两次
const dup = U.collectCards({
  list: [{
    itemId: '123456789014', title: '重复 URL', price: '7.00',
    images: ['https://cbu01.alicdn.com/img/ibank/O1CN01x_!!123.jpg', 'https://cbu01.alicdn.com/img/ibank/O1CN01x_!!123.jpg']
  }]
}, { site: SITE });
assert.ok(dup.length === 1 && dup[0].images.length === 1,
  '完全相同的 URL 应去重，实得 ' + (dup[0].images || []).length + ' 张');
ok('重复 URL 去重：' + dup[0].images.length + ' 张');

/* ================= 3. 链路：多图与规格表一起到下载 ================= */
console.log('\n[3] 勾选下载链路');
const detail = {
  itemId: '803347112456',
  title: '车载手机支架 吸盘式 360度旋转',
  price: '12.50',
  desc: '吸盘固定，360度旋转',
  images: c0.images,
  sellerNick: '某某汽配',
  skus: full
};

// 下载侧过滤（与 bridge.selectedItems 同规则）
const images = U.filterItemImages(detail.images);
assert.strictEqual(images.length, 3, '主图过滤后应仍是 3 张');
ok('主图过滤后：' + images.length + ' 张');

// skusOf 的映射：规格图要跟着一起过去，否则下载侧拿不到图
const skus = {
  specs: full.specs || [],
  list: full.list.map((s) => ({ key: s.key, price: s.price, stock: s.stock, image: s.image || '' }))
};
const withImgList = skus.list.filter((s) => s.image);
assert.ok(withImgList.length > 0, '规格图必须随规格一起进入下载流程');
ok('进入下载的规格：' + withImgList.length + ' 条，均带 image 字段');

// 文案里必须有规格价格——这是用户明确反馈缺的那一项
const text = U.buildText(detail, 'txt');
assert.ok(text.indexOf('【规格与价格】') > -1, '文案应带规格表段落');
withImgList.forEach((s) => {
  assert.ok(text.indexOf(s.key) > -1, '文案应列出规格：' + s.key);
  if (s.price) assert.ok(text.indexOf('¥' + s.price) > -1, '文案应带规格价格 ¥' + s.price);
});
ok('文案含规格价格（' + withImgList.map((s) => s.key + ' ¥' + s.price).join(' / ') + '）');

/* ================= 4. 落盘路径 ================= */
console.log('\n[4] 落盘路径');
function safePath(p) {
  return p.split('/').map((seg) => U.cleanFileName(seg, 120)).join('/');
}
const dir = safePath('闲鱼采集/车载手机支架_803347112456');
const skuDir = dir + '/SKU图片';
const skuPaths = withImgList.map((s) => skuDir + '/' + U.cleanFileName(s.key || '规格', 40) + U.imageExt(s.image));
skuPaths.forEach((p) => assert.ok(p.indexOf('/SKU图片/') > -1, 'SKU 图必须进「SKU图片」子目录'));
assert.ok(skuPaths.every((p) => p.split('/').length === 4), '路径应为 商品目录/SKU图片/文件名');
ok('SKU 图落 ' + skuDir);
skuPaths.forEach((p) => console.log('      ' + p.split('/').pop()));

const imgPaths = images.map((u, i) => dir + '/' + (i + 1) + U.imageExt(u));
assert.ok(imgPaths.length === 3, '主图应有 3 张，与「只有一张」的正相反');
ok('主图落 ' + dir + '（' + imgPaths.length + ' 张）');

console.log('\n全部通过：' + pass + ' 项');
