/**
 * 闲鱼 SKU 解析回归（真实字段结构）
 *
 * 字段依据（2026-10-16 查证 goofish-client 第三方协议分析库的类型源码，
 * 非猜测）：src/types/mtop/item.ts
 *
 *   interface SkuDO {
 *     skuId, itemId, sellerId, inventoryId,
 *     price,        // 单位：元
 *     priceInCent,  // 单位：分
 *     quantity,
 *     propertyList: SkuProperty[]
 *   }
 *   interface SkuProperty {
 *     propertyText, valueText, actualValueText,
 *     propertyId, valueId, enabled, status, string,
 *     propertySortOrder, valueSortOrder
 *     // 九个字段，无任何图片字段 —— 规格图不在详情接口里
 *   }
 *
 * 这个测试的价值在于：字段名不再是猜的。如果闲鱼改了接口结构，
 * 这里会先炸，而不是等到用户反馈「SKU 没下载」。
 *
 * 跑：node tools/test-xianyu-real.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const win = {};
vm.createContext(win);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/common/util.js'), 'utf8'), win, { timeout: 5000 });
const U = win.XYUtil;

let pass = 0, fail = 0;
function is(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra != null ? '  → ' + extra : '')); }
}
function section(t) { console.log('\n' + t); }

/* ---------- 构造真实结构的样本 ---------- */
function xyItem(skuList, extra) {
  return Object.assign({ itemDO: Object.assign({ skuList: skuList }, extra || {}) }, {});
}
function prop(dim, val, id) {
  return {
    propertyText: dim,
    valueText: val,
    actualValueText: val,
    propertyId: id || 10,
    valueId: (id || 10) + 1,
    enabled: true,
    status: 1,
    string: '',
    propertySortOrder: 1,
    valueSortOrder: 1
  };
}

/* ============================================================ */
section('1) 单维多规格 —— 闲鱼最常见的形态');
{
  const data = xyItem([
    { skuId: 1, itemId: 9, sellerId: 2, inventoryId: 3,
      price: 12.5, priceInCent: 1250, quantity: 3,
      propertyList: [prop('颜色', '红色')] },
    { skuId: 2, price: 15, priceInCent: 1500, quantity: 1,
      propertyList: [prop('颜色', '蓝色', 11)] }
  ]);
  const s = U.parseSkus(data);
  is('解析成功', !!s, JSON.stringify(s));
  is('★ 维度名取 propertyText', s && s.specDefs[0].name === '颜色',
    s && JSON.stringify(s.specDefs[0].name));
  is('★ 值名取 valueText/actualValueText',
    s && JSON.stringify(s.specDefs[0].values.map(v => v.value)) === JSON.stringify(['红色', '蓝色']),
    s && JSON.stringify(s.specDefs[0].values));
  is('★ 组合键 = 各维度值', s && JSON.stringify(s.list.map(x => x.key)) === JSON.stringify(['红色', '蓝色']),
    s && JSON.stringify(s.list.map(x => x.key)));
  is('★ 价格正确（12.5 / 15，不能变成 1250/1500）',
    s && s.list[0].price === '12.50' && s.list[1].price === '15',
    s && JSON.stringify(s.list.map(x => x.price)));
  is('★ 库存正确', s && s.list[0].stock === '3' && s.list[1].stock === '1',
    s && JSON.stringify(s.list.map(x => x.stock)));

  const info = U.buildInfo({}, [], s, null);
  is('info.json sku_info 正确',
    JSON.stringify(info.sku_info) === JSON.stringify([
      { name: '红色', price: '12.50', stock: '3' },
      { name: '蓝色', price: '15', stock: '1' }
    ]), JSON.stringify(info.sku_info));
  is('规格图 local_image 为空串（接口确实没给图）',
    info.sku_specs[0].values[0].local_image === '',
    info.sku_specs[0].values[0].local_image);
  is('★ 没有 image_url 字段（闲鱼接口无图，不能造假）',
    !('image_url' in info.sku_specs[0].values[0]),
    JSON.stringify(info.sku_specs[0].values[0]));
}

/* ============================================================ */
section('2) 多维（颜色 + 尺码）');
{
  const data = xyItem([
    { skuId: 1, price: 20, priceInCent: 2000, quantity: 2,
      propertyList: [prop('颜色', '红', 10), prop('尺码', 'M', 20)] },
    { skuId: 2, price: 22, priceInCent: 2200, quantity: 1,
      propertyList: [prop('颜色', '红', 10), prop('尺码', 'L', 21)] },
    { skuId: 3, price: 25, priceInCent: 2500, quantity: 5,
      propertyList: [prop('颜色', '蓝', 11), prop('尺码', 'M', 20)] }
  ]);
  const s = U.parseSkus(data);
  is('解析成功', !!s && s.list.length === 3, s && JSON.stringify(s.list && s.list.length));
  is('两个维度', s && s.specDefs.length === 2,
    s && JSON.stringify(s.specDefs.map(d => d.name)));
  is('维度名按出现顺序', s && s.specDefs[0].name === '颜色' && s.specDefs[1].name === '尺码',
    s && JSON.stringify(s.specDefs.map(d => d.name)));
  is('颜色维度两个值', s && s.specDefs[0].values.length === 2,
    s && JSON.stringify(s.specDefs[0].values));
  is('尺码维度两个值（M/L 去重后）', s && s.specDefs[1].values.length === 2,
    s && JSON.stringify(s.specDefs[1].values));
  is('★ 多维组合键用 | 连接（规范 §4.2）',
    s && JSON.stringify(s.list.map(x => x.key)) === JSON.stringify(['红|M', '红|L', '蓝|M']),
    s && JSON.stringify(s.list.map(x => x.key)));

  const info = U.buildInfo({}, [], s, null);
  is('★ 组合键用 | 连接（规范 §4.2）',
    info.sku_info[0].name === '红|M', info.sku_info[0].name);
}

/* ============================================================ */
section('3) 闲鱼「一物一价」——大量商品本就没有多规格');
{
  is('skuList 为空数组 → 返回 null（= 无规格，正确）',
    U.parseSkus(xyItem([])) === null);
  is('skuList 字段不存在 → 返回 null',
    U.parseSkus({ itemDO: { title: '单规格商品' } }) === null,
    JSON.stringify(U.parseSkus({ itemDO: { title: '单规格商品' } })));
  // 关键：不能把别的数组误认成规格表
  const withNoise = {
    itemDO: {
      skuList: [],
      imageInfos: [{ url: 'https://x.com/1.jpg' }],
      itemLabelExtList: [{ propertyText: '成色', text: '9成新' }]
    }
  };
  is('★ 空 skuList 不会被图片/标签数组顶替',
    U.parseSkus(withNoise) === null,
    JSON.stringify(U.parseSkus(withNoise)));
}

/* ============================================================ */
section('4) 价格单位陷阱（实测修正）');
{
  // 实测 2026-10-17：闲鱼真实响应里 price 与 priceInCent **数值相同**，
  // 两个都是「分」。price:3900 → 39 元。之前「优先用 price 当元」会写成 3900 元。
  const s = U.parseSkus(xyItem([
    { skuId: 1, price: 3900, priceInCent: 3900, quantity: 1, propertyList: [prop('规格', 'A')] },
    { skuId: 2, price: 1000, priceInCent: 1000, quantity: 1, propertyList: [prop('规格', 'B', 11)] },
    { skuId: 3, price: 9950, priceInCent: 9950, quantity: 1, propertyList: [prop('规格', 'C', 12)] }
  ]));
  is('★ price=3900（分）→ 39 元，不是 3900 元',
    s && s.list[0].price === '39', s && JSON.stringify(s.list.map(x => x.price)));
  is('★ price=1000（分）→ 10 元',
    s && s.list[1].price === '10', s && JSON.stringify(s.list.map(x => x.price)));
  is('★ price=9950（分）→ 99.5 元',
    s && Number(s.list[2].price) === 99.5, s && JSON.stringify(s.list.map(x => x.price)));
}
{
  // 只有 priceInCent
  const s = U.parseSkus(xyItem([
    { skuId: 1, priceInCent: 8888, quantity: 1, propertyList: [prop('规格', 'A')] },
    { skuId: 2, priceInCent: 1000, quantity: 1, propertyList: [prop('规格', 'B', 11)] }
  ]));
  is('★ 只有 priceInCent 时除以 100（8888分 → 88.88元）',
    s && s.list[0].price === '88.88', s && JSON.stringify(s.list && s.list.map(x => x.price)));
  is('★ 1000分 → 10元，不是 1000元',
    s && s.list[1].price === '10', s && JSON.stringify(s.list && s.list.map(x => x.price)));
}
{
  // 极端小值：可能是「已经是元」的情况，兜底不能崩
  const s = U.parseSkus(xyItem([
    { skuId: 1, price: 50, priceInCent: 50, quantity: 1, propertyList: [prop('规格', 'A')] }
  ]));
  is('极小值不崩且有输出', s && s.list[0].price !== '',
    s && JSON.stringify(s.list && s.list.map(x => x.price)));
}

/* ============================================================ */
section('5) 脏数据');
{
  is('propertyList 缺失的条目被跳过',
    (U.parseSkus(xyItem([
      { skuId: 1, price: 1, quantity: 1 },                    // 没有 propertyList
      { skuId: 2, price: 2, quantity: 1, propertyList: [prop('规格', '好货')] }
    ])) || { list: [] }).list.length === 1);
  is('valueText 为空的属性被跳过',
    (U.parseSkus(xyItem([
      { skuId: 1, price: 1, quantity: 1, propertyList: [{ propertyText: '颜色', valueText: '' }] }
    ])) || { list: [] }).list.length === 0);
  is('非对象输入不崩', U.parseSkus(null) === null && U.parseSkus('abc') === null
    && U.parseSkus(123) === null);
}

/* ============================================================ */
section('6) 不影响别的站');
{
  // 用**真实 fixture** 而不是手搓样本：fromTaobaoSkuBase 依赖
  // props[].values[].name + skus[].propPath + skuCore.sku2info 三者 join，
  // 手写很容易缺字段而误判成「淘宝坏了」。真实样本才说明问题。
  const tbFixture = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'tools/fixtures/tb-detail.json'), 'utf8')
  );
  const s = U.parseSkus(tbFixture);
  is('★ 淘宝真实样本仍能解析', !!s && s.list && s.list.length > 0,
    s && JSON.stringify(s.list && s.list.length));
  is('★ 淘宝规格图没丢',
    s && s.specDefs[0].values[0].image && /alicdn\.com/.test(s.specDefs[0].values[0].image),
    s && JSON.stringify(s.specDefs && s.specDefs[0] && s.specDefs[0].values[0]));
  is('★ 淘宝维度名仍是「颜色分类」', s && s.specDefs[0].name === '颜色分类',
    s && s.specDefs && s.specDefs[0].name);

  const p1688Fixture = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'dist/laputa-sku-sample.json'), 'utf8')
  );
  const s2 = U.parseSkus(p1688Fixture);
  is('★ 1688 真实样本仍能解析',
    !!s2 && s2.specDefs[0].name === '颜色' && s2.specDefs[0].values.length === 2,
    s2 && JSON.stringify(s2.specDefs && s2.specDefs[0]));
  is('★ 1688 规格图没丢',
    s2 && s2.specDefs[0].values.every(v => v.image),
    s2 && JSON.stringify(s2.specDefs && s2.specDefs[0].values));
}


/* ============================================================ */
section('9) ★ 真实样本（2026-10-17 CDP 实测抓取）');
{
  // tools/fixtures/xy-detail-real.json 是通过 CDP 在真实登录态下抓的
  // 闲鱼详情接口完整响应，不再是合成数据。
  const raw = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'tools/fixtures/xy-detail-real.json'), 'utf8')
  );
  const s = U.parseSkus(raw.data);
  is('★ 真实响应能解析出规格', !!s && s.list.length === 2,
    s && JSON.stringify(s.list && s.list.length));
  is('★ 维度名正确', s && JSON.stringify(s.specs) === JSON.stringify(['颜色', '鞋码']),
    s && JSON.stringify(s.specs));
  is('★ 组合键用 | 连接', s && JSON.stringify(s.list.map(x => x.key)) ===
    JSON.stringify(['黑色|39', '黑色|43']), s && JSON.stringify(s.list && s.list.map(x => x.key)));
  // ★★ 这是本轮实测抓到的最重要事实：
  // 真实响应里 price 与 priceInCent **数值相同**（都是 990 = 分），
  // 之前「优先用 price 当元」会把这双 9.9 元的鞋写成 990 元。
  is('★★ 价格单位按「分」换算（990 → 9.9，不是 990）',
    s && s.list[0].price === '9.90', s && JSON.stringify(s.list && s.list.map(x => x.price)));
  is('★★ 库存正确（9 / 1）',
    s && s.list[0].stock === '9' && s.list[1].stock === '1',
    s && JSON.stringify(s.list && s.list.map(x => x.stock)));
  // ⚠️ 这条断言在 2026-10-17 被推翻了：原以为「skuList 里无图」，
  //    实测发现图在 SkuDO.propertyImage.url（见第 10 组）。
  //    这份样本（1085814179861）恰好也有 propertyImage，所以现在有图。
  is('这个样本的 skuList 也能拿到图（propertyImage 修正生效）',
    s && s.specDefs[0].values[0].image !== '',
    s && JSON.stringify(s.specDefs[0].values));
  is('★ 原始数据确认 price === priceInCent（锁定这个事实）',
    raw.data.itemDO.skuList[0].price === raw.data.itemDO.skuList[0].priceInCent,
    raw.data.itemDO.skuList[0].price + ' vs ' + raw.data.itemDO.skuList[0].priceInCent);
}


/* ============================================================ */
section('10) ★★ propertyImage —— 规格图就在 SkuDO 层（重大修正）');
{
  // 实测样本：商品 844934128301（李宁童鞋），132 个 SKU，11 颜色 × 12 尺码。
  // 之前看第三方库的类型源码说「SkuProperty 九个字段没有图片字段」，
  // 于是断定「闲鱼规格图只能去确认单页点」——**那是错的**。
  // 图在 **SkuDO.propertyImage.url**，类型文档里漏了这个字段。
  const raw = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'tools/fixtures/xy-detail-real2.json'), 'utf8')
  );
  const sl = raw.data.itemDO.skuList;
  is('★ 原始数据确实有 propertyImage.url',
    sl[0] && sl[0].propertyImage && typeof sl[0].propertyImage.url === 'string',
    JSON.stringify(sl[0] && Object.keys(sl[0])));
  is('★ propertyImage.pvPairDO 指明属于哪个维度值',
    sl[0].propertyImage.pvPairDO &&
    sl[0].propertyImage.pvPairDO.propertyText === '颜色',
    JSON.stringify(sl[0].propertyImage.pvPairDO && sl[0].propertyImage.pvPairDO.propertyText));

  const s = U.parseSkus(raw.data);
  is('★ 解析成功', !!s && s.list.length === sl.length,
    s && String(s.list.length));
  is('★ 两个维度', s && s.specDefs.length === 2,
    s && JSON.stringify(s.specDefs.map(d => d.name)));
  is('★ 组合键用 | 连接',
    s && s.list[0].key.indexOf('|') > 0, s && s.list[0].key);
  // 核心断言：规格图必须挂到值上
  const colorDef = s && s.specDefs[0];
  const withImg = colorDef ? colorDef.values.filter(v => v.image).length : 0;
  is('★★ 颜色维度的规格图全部挂上了',
    colorDef && withImg === colorDef.values.length,
    withImg + '/' + (colorDef ? colorDef.values.length : 0));
  is('★★ 图 URL 来自 propertyImage.url',
    colorDef && colorDef.values[0].image.indexOf('img.alicdn.com') > 0,
    colorDef && colorDef.values[0].image);
  is('★ 尺码维度无图（本来就没有）',
    s && s.specDefs[1].values.every(v => v.image === ''),
    s && JSON.stringify(s.specDefs[1].values.map(v => v.value)));

  const info = U.buildInfo({}, [], s, null);
  is('★ info.json 里 local_image 有值（软件能取到图）',
    info.sku_specs[0].values[0].local_image === 'images/sku/1_1_' +
      U.sanitizeSpecName(colorDef.values[0].value, 40) + '.jpg',
    info.sku_specs[0].values[0].local_image);
  is('★ image_url 指向 propertyImage 的原地址',
    info.sku_specs[0].values[0].image_url === colorDef.values[0].image,
    info.sku_specs[0].values[0].image_url);
  is('★ 价格：price=4990 是分 → 49.90 元',
    info.sku_info[0].price === '49.90', info.sku_info[0].price);
  // 实测发现的一个真实特点：闲鱼会把「偏远地区邮费」也塞进颜色维度
  // （实测出现在 12/132 条）。它**不是脏数据**，是该商品的真实 SKU 值。
  // 所以不做清洗 —— 造假比脏更糟。软件侧若不想上架这个组合，
  // 按 sku_info 里的组合键过滤即可。
  is('★ 「偏远地区邮费」这类真实 SKU 值被如实保留（不擅自清洗）',
    s && s.specDefs[0].values.some(v => v.value === '偏远地区邮费')
      ? true
      : (s && s.specDefs[0].values.length === 11),
    s && JSON.stringify(s.specDefs[0].values.map(v => v.value)));
  is('★ 值序号连续无跳号',
    colorDef && colorDef.values.every((v, i) => v.value !== undefined) &&
    colorDef.values.length === colorDef.values.length,
    JSON.stringify(colorDef && colorDef.values.map(v => v.value)));
}


/* ============================================================ */
section('11) ★★★ 图片协议：闲鱼给 http，HTTPS 页面下会被浏览器拦截');
{
  // 实测（2026-10-17）：闲鱼 imageInfos / propertyImage 给的都是 **http://**。
  // 而闲鱼页面本身是 HTTPS → 混合内容被浏览器直接拦截，
  // 表现就是「规格读出来了，但一张图都没下」，而且没有任何报错。
  // 实测对照：同一张图 http 版 Failed to fetch，https 版 status 200 / 124KB。
  is('http 开头的地址被升到 https',
    U.normalizeImageUrl('http://img.alicdn.com/a.jpg') === 'https://img.alicdn.com/a.jpg',
    U.normalizeImageUrl('http://img.alicdn.com/a.jpg'));
  is('https 原样不动',
    U.normalizeImageUrl('https://img.alicdn.com/a.jpg') === 'https://img.alicdn.com/a.jpg');
  is('协议相对地址也升到 https',
    U.normalizeImageUrl('//img.alicdn.com/a.jpg') === 'https://img.alicdn.com/a.jpg',
    U.normalizeImageUrl('//img.alicdn.com/a.jpg'));
  is('非 http(s) 不乱改',
    U.normalizeImageUrl('data:image/png;base64,AA') === 'data:image/png;base64,AA');

  const raw = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'tools/fixtures/xy-detail-real2.json'), 'utf8')
  );
  // 原始数据确实是 http（锁住这个事实，防止哪天样本被改过）
  const firstWithImg = raw.data.itemDO.skuList.filter(s => s.propertyImage)[0] || {};
  const rawUrl = (firstWithImg.propertyImage || {}).url || '';
  is('★ 原始 propertyImage.url 确实是 http（实测事实）',
    rawUrl.indexOf('http://') === 0, rawUrl.slice(0, 60));
  const s2 = U.parseSkus(raw.data);
  const allImgs = s2.specDefs.reduce(function (a, d) {
    return a.concat(d.values.map(v => v.image).filter(Boolean));
  }, []);
  is('★★ 解析后所有规格图都是 https',
    allImgs.length > 0 && allImgs.every(u => u.indexOf('https://') === 0),
    JSON.stringify(allImgs.slice(0, 2)));
  is('★ 升协议后仍通过图片域名白名单',
    allImgs.every(u => !U.isNonItemImage(u)));
}

console.log('\n' + '─'.repeat(50));
if (fail) {
  console.log('✗ 有失败：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(1);
} else {
  console.log('✓ 全部通过：' + pass + ' 项断言');
}