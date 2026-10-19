/**
 * SKU 规格图对接契约回归测试（sku_image_contract.md v1.0）
 *
 * 与 test-sku-e2e.js 的分工：
 *   test-sku-e2e.js —— 盯 1688 规格表解析（parseSkus → 文案 → 落盘路径）
 *   本文件          —— 盯**对接契约**：落盘命名 + info.json 的 sku_specs + 三条不变量
 *
 * 全部用真实实测样本，全程不发包、不联网：
 *   1688：dist/laputa-sku-sample.json      （mtop.1688.wosc.queryofferskuselectormodel）
 *   淘宝：tools/fixtures/tb-detail.json     （mtop.taobao.pcdetail.data.get）
 *
 * 规范文档里的多维组合键示例（颜色|尺码）目前**没有真实样本**，
 * 本文件用合成数据覆盖，真实多维响应一旦抓到就替换掉。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const S1688 = path.join(ROOT, 'dist', 'laputa-sku-sample.json');
const STB = path.join(__dirname, 'fixtures', 'tb-detail.json');

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log('  ✓ ' + msg); }
function bad(msg, detail) {
  fail++; console.log('  ✗ ' + msg + (detail ? '\n      实际: ' + detail : ''));
}
function is(cond, msg, detail) { cond ? ok(msg) : bad(msg, detail); }

/* ---------- 起一个最小上下文，把 util.js 装进去 ---------- */
const ctx = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  Promise, Math, Date, JSON, Object, Array, String, Number, RegExp, Error
};
ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
ctx.location = { href: 'https://detail.1688.com/offer/1.html', host: 'detail.1688.com', pathname: '/offer/1.html', search: '' };
ctx.document = {
  readyState: 'complete', querySelectorAll: () => [], querySelector: () => null,
  addEventListener() {}, createElement: () => ({ style: {}, appendChild() {}, addEventListener() {} }),
  documentElement: { setAttribute() {} },
  get body() { return { appendChild() {}, addEventListener() {} }; },
  visibilityState: 'visible'
};
ctx.navigator = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/common/util.js'), 'utf8'), ctx);
const U = ctx.XYUtil;

/** 把 sku_specs 摊平成「相对路径 → 值名」，顺便验证路径唯一 */
function filesOf(skus) {
  const out = {};
  (skus.specDefs || []).forEach((d, g) => (d.values || []).forEach((v, i) => {
    const li = U.skuSpecLocalImage(g, i, d);
    if (li) out[li] = v.value;
  }));
  return out;
}

/* ============================================================ */
console.log('\n[1] 1688 真实样本：规格图按维度值落盘');
const raw1688 = JSON.parse(fs.readFileSync(S1688, 'utf8'));
const s1688 = U.parseSkus(raw1688.data);
assert.ok(s1688, '1688 样本应能解析出规格表');

is(s1688.specDefs.length === 1 && s1688.specDefs[0].name === '颜色',
  '维度名原样输出', JSON.stringify(s1688.specDefs.map((d) => d.name)));
is(s1688.specDefs[0].values.length === 2,
  '两个规格值都在（无图的也要占位）', String(s1688.specDefs[0].values.length));
is(s1688.specDefs[0].values.every((v) => v.image),
  '1688 规格图全部拿到', JSON.stringify(s1688.specDefs[0].values.map((v) => v.image)));

const files1688 = filesOf(s1688);
const expected1688 = [
  'images/sku/1_1_【6格】CD支架.jpg',
  'images/sku/1_2_【8格】CD支架.jpg'
];
is(JSON.stringify(Object.keys(files1688).sort()) === JSON.stringify(expected1688.slice().sort()),
  '落盘文件名符合规范 §2「维度_值_安全值名.ext」', JSON.stringify(Object.keys(files1688)));

const info1688 = U.buildInfo({ title: 'CD支架', description: '', price: '3.00-4.00' }, ['https://cbu01.alicdn.com/m.jpg'], s1688);
is(info1688.sku_specs[0].values.every((v) => v.image_url && /alicdn\.com/.test(v.image_url)),
  'sku_specs 带 image_url（本地丢了软件可兜底重下）',
  JSON.stringify(info1688.sku_specs[0].values));
is(info1688.sku_info.every((s) => s.local_image === undefined),
  'sku_info 组合行不再带 local_image（多维时无唯一图可指）');
/* ============================================================ */

console.log('\n[2] 淘宝真实样本：propPath join 取图（规范 §5 写的是组合级 skuImage，实测不存在）');
const tb = JSON.parse(fs.readFileSync(STB, 'utf8'));
const sTb = U.parseSkus(tb);
assert.ok(sTb, '淘宝样本应能解析出规格表');
is(sTb.specDefs.length === 1 && sTb.specDefs[0].name === '颜色分类',
  '维度名取 props[].name', JSON.stringify(sTb.specDefs.map((d) => d.name)));
is(sTb.specDefs[0].values[0].image &&
  /gw\.alicdn\.com/.test(sTb.specDefs[0].values[0].image),
  '规格图从 props[].values[].image 取到',
  sTb.specDefs[0].values[0].image);
is(sTb.specDefs[0].values[0].value === '1.2m/三合一【液态硅胶】快速充电【1条装】',
  '规格值**原样**输出，不缩短（12 字上限是软件侧的事）',
  sTb.specDefs[0].values[0].value);

const filesTb = filesOf(sTb);
const keyTb = Object.keys(filesTb)[0] || '';
is(/^images\/sku\/1_1_.+\.png$/.test(keyTb),
  '淘宝落盘文件名同规则，且扩展名保留 png', keyTb);

const infoTb = U.buildInfo({ title: 'T', description: '', price: '4.01' }, ['https://gw.alicdn.com/m.jpg'], sTb);
is(infoTb.sku_info[0].price === '4.01',
  '价格取 skuCore.sku2info[skuId].subPrice.priceText', infoTb.sku_info[0].price);
is(infoTb.sku_info[0].stock === '200',
  '库存取 skuCore.sku2info[skuId].quantity', infoTb.sku_info[0].stock);
is(infoTb.sku_info[0].name === sTb.specDefs[0].values[0].value,
  '单维组合键 = 维度值（原样）', infoTb.sku_info[0].name);
/* ============================================================ */

console.log('\n[3] 不变量 1：索引对齐（无图的值占位，值序号不跳）');
{
  const skus = {
    specs: ['颜色'],
    specDefs: [{ name: '颜色', values: [
      { value: '红', image: 'https://a/1.jpg' },
      { value: '蓝', image: '' },          // 无图，必须占位
      { value: '绿', image: 'https://a/3.jpg' }
    ] }],
    list: [{ key: '红', price: '1', stock: '1' }]
  };
  const info = U.buildInfo({}, [], skus);
  const vals = info.sku_specs[0].values;
  is(vals.length === 3, '值列表长度 = 3（无图的也在）', String(vals.length));
  is(vals[1].local_image === '', '无图值 local_image 是空串，不是 null/undefined',
    JSON.stringify(vals[1].local_image));
  is(vals[2].local_image === 'images/sku/1_3_绿.jpg',
    '第 3 个值仍是值序号 3，没有被空值挤到 2',
    vals[2].local_image);
}

console.log('\n[4] 不变量 2：组合键用 | 连接，顺序与 sku_specs 一致');
{
  // 合成多维：真实样本暂时只有单维（见文件头说明）
  const raw = { data: { skuSelectorBizModel: {
    skuProps: [
      { prop: '颜色', value: [{ name: '红', imageUrl: 'https://a/red.jpg' }, { name: '蓝', imageUrl: 'https://a/blue.jpg' }] },
      { prop: '尺码', value: [{ name: 'S', imageUrl: '' }, { name: 'M', imageUrl: '' }] }
    ],
    skuInfoMap: {
      '颜色:蓝;尺码:M': { discountPrice: '9.9', canBookCount: 10, specAttrs: '颜色:蓝;尺码:M', skuId: 2 },
      '颜色:红;尺码:M': { discountPrice: '8.8', canBookCount: 20, specAttrs: '颜色:红;尺码:M', skuId: 1 }
    }
  } } };
  const skus = U.parseSkus(raw.data);
  assert.ok(skus, '多维样本应能解析');
  const keys = skus.list.map((s) => s.key).sort();
  // 规范 §4.2：name 是各维度**值**按 sku_specs 顺序用 | 连接，不带维度名前缀
  is(JSON.stringify(keys) === JSON.stringify(['蓝|M', '红|M'].sort()),
    'specAttrs「维度:值;维度:值」还原成 | 组合键',
    JSON.stringify(keys));
  const files = filesOf(skus);
  is(!!files['images/sku/1_1_红.jpg'] && !!files['images/sku/1_2_蓝.jpg'] &&
     files['images/sku/2_1_S.jpg'] === undefined && files['images/sku/2_2_M.jpg'] === undefined,
    '只有颜色维度产图，尺码维度无图 → 不产文件但值序号仍占位',
    JSON.stringify(Object.keys(files)));
}

console.log('\n[5] 不变量 3：同维度值名唯一 / 跨维度重名靠维度序号兜');
{
  const raw = { data: { skuSelectorBizModel: {
    skuProps: [
      { prop: '颜色', value: [{ name: '经典', imageUrl: 'https://a/1.jpg' }] },
      { prop: '款式', value: [{ name: '经典', imageUrl: 'https://a/2.jpg' }] }
    ],
    skuInfoMap: { '颜色:经典;款式:经典': { discountPrice: '1', canBookCount: 1, specAttrs: '颜色:经典;款式:经典', skuId: 1 } }
  } } };
  const skus = U.parseSkus(raw.data);
  const files = filesOf(skus);
  is(files['images/sku/1_1_经典.jpg'] === '经典' && files['images/sku/2_1_经典.jpg'] === '经典',
    '跨维度同名不撞车', JSON.stringify(Object.keys(files)));
}

console.log('\n[6] 规范 §2：文件名清洗');
{
  is(U.sanitizeSpecName('红/蓝') === '红_蓝', '非法字符替换成 _', U.sanitizeSpecName('红/蓝'));
  is(U.sanitizeSpecName('a:b*c?d"e<f>g|h') === 'a_b_c_d_e_f_g_h',
    '8 个非法字符全部替换', U.sanitizeSpecName('a:b*c?d"e<f>g|h'));
  is(U.sanitizeSpecName('') === '规格', '空值兜底「规格」');
  is(U.sanitizeSpecName(null) === '规格', 'null 兜底「规格」');
  is(U.sanitizeSpecName('x'.repeat(60), 40).length === 40, '截断到 40 字');
  is(U.skuSpecImageName(0, 0, '红', 'https://a/x.webp') === '1_1_红.webp',
    'webp 保留原扩展名，不转 jpg');
}

/* ============================================================ */
console.log('\n' + '—'.repeat(60));
if (fail) {
  console.log('✗ 有失败：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(1);
}
console.log('✓ 全部通过：' + pass + ' 项断言');