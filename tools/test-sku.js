/**
 * SKU 解析自测
 *
 * 用的是实测抓下来的 1688 真实结构（detail.1688.com/offer/1001672530707），
 * 不是编的样例——1688 的 skuModel 是"对象不是数组"，
 * 规格图还按规格名挂在 skuProps 上，形状很特别。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
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

/* ---------- 真实样本：1688 skuModel ---------- */
const real1688 = {
  skuProps: [{
    fid: 3216,
    prop: '颜色',
    value: [
      { imageUrl: 'https://cbu01.alicdn.com/img/ibank/O1CN01CTBKZQ2CT9N7Gxn0o_!!2220383608474-0-cib.jpg', name: '【6格】CD支架' },
      { imageUrl: 'https://cbu01.alicdn.com/img/ibank/O1CN01k1gkw32CT9N7lcp2v_!!2220383608474-0-cib.jpg', name: '【8格】CD支架' }
    ]
  }],
  // 以下数值与 dist/laputa-sku-sample.json 一致，改动前先重新抓一次真实响应
  skuInfoMap: {
    '【8格】CD支架': {
      specId: 'c36eacc1f421522a1c20d884eb2c6811', saleCount: 0, discountPrice: '4.00',
      canBookCount: 29882, specAttrs: '【8格】CD支架', price: '4.00', priceAmount: 2,
      retailPrice: '', skuId: 6157035487299, isPromotionSku: true
    },
    '【6格】CD支架': {
      specId: '81322de18456c14a4683af5f1e27d3fc', saleCount: 0, discountPrice: '3.00',
      canBookCount: 29861, specAttrs: '【6格】CD支架', price: '3.00', priceAmount: 2,
      retailPrice: '', skuId: 6157035487298, isPromotionSku: true
    }
  },
  skuPriceScale: '3.00-4.00'
};

const r = U.parseSkus(real1688);
assert.ok(r, '1688 skuModel 应能解析出规格');
// vm 里的数组原型和外层不同，跨 realm 不能直接 deepStrictEqual 同原型数组
assert.deepStrictEqual(Array.from(r.specs), ['颜色'], '规格维度应取到「颜色」');
assert.strictEqual(r.list.length, 2, '应有 2 个规格');

const six = r.list.find((s) => s.key.indexOf('6格') > -1);
const eight = r.list.find((s) => s.key.indexOf('8格') > -1);
assert.ok(six && eight, '两个规格都应被解析出来');
// 样本抓下来时恰好没促销（discountPrice 与 price 相同），
// 所以促销价优先单独用下面的合成用例验证
assert.strictEqual(six.price, '3', '价格应取 discountPrice');
assert.strictEqual(eight.price, '4', '价格应取 discountPrice');
assert.strictEqual(six.stock, '29861', '库存应取 canBookCount');
assert.strictEqual(eight.stock, '29882', '8格库存应取 canBookCount');

/* ---------- 促销价优先（合成用例：真实样本里没有价格差） ---------- */
const promo = {
  skuProps: [{ prop: '颜色', value: [{ name: '红', imageUrl: 'https://x/r.jpg' }] }],
  skuInfoMap: { '红': { discountPrice: '2.47', price: '3.00', canBookCount: 10, skuId: 1 } }
};
const rp = U.parseSkus(promo);
assert.strictEqual(rp.list[0].price, '2.47', '有促销价时必须取促销价，否则铺出去贵一大截');
console.log('✓ 促销价优先于原价通过');
assert.ok(six.image && /alicdn/.test(six.image), '规格图应来自 skuProps（挂在规格名上，不在 SKU 明细里）');
assert.ok(eight.image && eight.image !== six.image, '两个规格的图应各自对应');
assert.ok(six.image.indexOf('O1CN01CTBKZQ2CT9N7Gxn0o') > -1, '6格的图应对上 6 格的 imageUrl');
assert.ok(eight.image.indexOf('O1CN01k1gkw32CT9N7lcp2v') > -1, '8格的图应对上 8 格的 imageUrl');
console.log('✓ 1688 skuModel（对象形态）解析通过');

/* ---------- 数组形态（多数站的写法） ---------- */
const arrStyle = {
  skuList: [
    { skuName: '红色', skuPrice: '18.90', quantity: 120, imageUrls: ['https://cbu01.alicdn.com/i/a.jpg'] },
    { skuName: '蓝色', skuPrice: '21.00', quantity: 80, imageUrls: ['https://cbu01.alicdn.com/i/b.jpg'] }
  ]
};
const r2 = U.parseSkus(arrStyle);
assert.ok(r2, '数组形态也应能解析');
assert.strictEqual(r2.list.length, 2, '应有 2 个规格');
assert.strictEqual(r2.list[0].price, '18.90', '数组形态价格');
assert.strictEqual(r2.list[0].stock, '120', '数组形态库存');
assert.ok(r2.list[0].image === 'https://cbu01.alicdn.com/i/a.jpg', '数组形态规格图');
console.log('✓ 数组形态（skuList）解析通过');

/* ---------- 深层嵌套：真实接口会把数据裹很多层 ---------- */
const nested = {
  result: { data: { Root: { fields: { dataJson: { skuModel: real1688 } } } } }
};
const r3 = U.parseSkus(nested);
assert.ok(r3 && r3.list.length === 2, '深层嵌套也应递归找到 skuModel');
assert.ok(r3.list[0].image, '嵌套后规格图不能丢');
console.log('✓ 深层嵌套定位通过（result.data.Root...skuModel）');

/* ---------- 无规格的商品不能凭空造 ---------- */
assert.strictEqual(U.parseSkus({ title: '单规格商品' }), null, '没有规格数据时必须返回 null');
assert.strictEqual(U.parseSkus(null), null, 'null 输入应返回 null');
assert.strictEqual(U.parseSkus({ skuInfoMap: {} }), null, '空的 skuInfoMap 不算规格');
console.log('✓ 无规格数据不臆造字段通过');

/* ---------- 区间价识别：第二遍多规格补录的筛子 ---------- */
assert.strictEqual(U.isRangePrice('3.00-4.00'), true, '1688 的 skuPriceScale 区间应识别为多规格');
assert.strictEqual(U.isRangePrice('¥18 ~ ¥21'), true, '带货币符和波浪号的区间也应识别');
assert.strictEqual(U.isRangePrice('¥18.90'), false, '单规格价格不该被当成区间');
assert.strictEqual(U.isRangePrice('3.00'), false, '单价格不该被当成区间');
assert.strictEqual(U.isRangePrice(''), false, '空价格不该被当成区间');
assert.strictEqual(U.isRangePrice(null), false, 'null 不该被当成区间');
// 反序（4.00-3.00）在真实数据里不会出现，它只是反向，不算区间
assert.strictEqual(U.isRangePrice('4.00-3.00'), false, '反序区间不算');
console.log('✓ 区间价识别通过（多规格补录的筛子）');

/* ---------- 文案里的规格表 ---------- */
const txt = U.formatSkus(r);
console.log('----- 规格表文案 -----\n' + txt + '\n----------------------');
assert.ok(/【规格与价格】/.test(txt), '文案应带规格表标题');
assert.ok(/颜色/.test(txt), '文案应带规格维度');
assert.ok(/29861/.test(txt), '文案应带库存');
assert.ok(/29861/.test(txt), '文案应带库存');
assert.strictEqual(U.formatSkus(null), '', '无规格时不该产出空标题');
console.log('✓ 规格表文案生成通过');

console.log('\n全部测试通过 ✅');
