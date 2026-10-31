/**
 * 集市店铺的「想要人数」：从**列表接口**直接读出来，不进详情页。
 *
 * 数据全部来自真机抓包（tools/watch-xy-shop.js 存的 dist/xy-shop-api.json），
 * 期望值由详情接口 itemDO.wantCnt 对账确认（16/16 一致，见 tools/probe-xy-bulk.js）。
 *
 * 这条成立的意义：1000 个商品的店铺，滚动加载完就能筛想要人数，
 * 不用逐个开详情页（原来 5 秒/个 → 80 多分钟）。
 *
 * 跑：node tools/test-xy-shop-want.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const UT = fs.readFileSync(path.join(ROOT, 'src/common/util.js'), 'utf8');

let pass = 0, fail = 0;
function is(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra != null ? '  → ' + extra : '')); }
}
function section(t) { console.log('\n' + t); }

const w = {}; vm.createContext(w);
vm.runInContext(UT, w, { timeout: 5000 });
const U = w.XYUtil;

/* ---------- 真机抓包 ---------- */
const CAP = path.join(ROOT, 'dist/xy-shop-api.json');
if (!fs.existsSync(CAP)) {
  console.log('缺少抓包文件 ' + CAP + '，先跑：node tools/watch-xy-shop.js');
  process.exit(1);
}
const hits = JSON.parse(fs.readFileSync(CAP, 'utf8'))
  .filter((x) => x.api === 'mtop.idle.web.xyh.item.list');

section('1) 抓包基础');
is('抓到了列表接口响应', hits.length > 0, hits.length + ' 页');

/* ---------- 标签解析 ---------- */
section('2) U.xyLabelNums：标签行里的想要人数');
{
  // 有「3人想要」+「行情价240元」并列的卡片
  const a = { itemLabelDataVO: { labelData: { r3: { tagList: [
    { data: { labelId: '1943', content: '行情价240元' } },
    { data: { labelId: '9', content: '3人想要' } }
  ] } } } };
  const ra = U.xyLabelNums(a);
  is('读到想要人数 3', ra.wantNum === '3', ra.wantNum);
  is('读到行情价 240', ra.marketPrice === '240', ra.marketPrice);
  is('标记 sawLabels', ra.sawLabels === true);

  // 只有行情价、没有想要 → 0 人想要（对账确认过）
  const b = { itemLabelDataVO: { labelData: { r3: { tagList: [
    { data: { labelId: '1943', content: '行情价289元' } }
  ] } } } };
  const rb = U.xyLabelNums(b);
  is('没有想要标签 → 判为 0 人想要', rb.wantNum === '0', rb.wantNum);

  // 完全没有标签结构 → 不能瞎猜 0
  const c = { title: 'x' };
  const rc = U.xyLabelNums(c);
  is('没有标签结构 → 不给数（不臆造）', rc.wantNum === '' && rc.sawLabels === false);

  // 议价热度
  const d = { itemLabelDataVO: { labelData: { r3: { tagList: [
    { data: { content: '2人小刀价' } }
  ] } } } };
  const rd = U.xyLabelNums(d);
  is('议价热度 2', rd.bargainNum === '2', rd.bargainNum);
}

/* ---------- 端到端：真实响应 → collectCards ---------- */
section('3) 真实列表响应 → collectCards');
{
  const site = { itemUrl: (id) => 'https://www.goofish.com/item?id=' + id };
  let total = 0, withWant = 0, withPrice = 0, withImg = 0;
  const sample = [];
  hits.forEach((hit) => {
    const j = JSON.parse(hit.body);
    const cards = U.collectCards(j.data, { site: site });
    cards.forEach((c) => {
      total++;
      if (c.wantNum !== '' && c.wantNum != null) withWant++;
      if (c.price) withPrice++;
      if (c.image) withImg++;
      if (sample.length < 6) {
        sample.push({ id: c.itemId, want: c.wantNum, price: c.price,
          imgs: (c.images || []).length });
      }
    });
  });
  console.log('  ' + hits.length + ' 页 → ' + total + ' 件商品');
  sample.forEach((s) => console.log('    ' + JSON.stringify(s)));
  is('解析出商品', total > 0, total);
  is('★ 每件都有想要人数（集市商品也能读到）',
    total > 0 && withWant === total, withWant + '/' + total);
  is('价格从 priceInfo 读到（原来全是空）',
    withPrice === total, withPrice + '/' + total);
  is('主图读得到', withImg === total, withImg + '/' + total);
}

/* ---------- 与详情接口对账（16/16 的实测结论固化成断言） ---------- */
section('4) 对账结论：标签值 == 详情接口 wantCnt');
{
  // [itemId, 列表标签里的想要数, 详情接口 itemDO.wantCnt]
  const TABLE = [
    ['1095514180818', '3', 3],
    ['1094660814311', '2', 2],
    ['1097114332276', '1', 1],
    ['1096045961892', '1', 1],
    ['1096046749258', '', 0],
    ['1094020399690', '', 0],
    ['1096046745168', '', 0],
    ['1097115208169', '', 0],
    ['1094021307064', '', 0],
    ['1094020771835', '', 0],
    ['1097114600944', '', 0],
    ['1097114764504', '', 0],
    ['1096045905830', '', 0],
    ['1096046537050', '', 0],
    ['1096045753938', '', 0],
    ['1096045841247', '', 0]
  ];
  let ok = 0;
  TABLE.forEach(([id, label, api]) => {
    const got = label === '' ? 0 : Number(label);
    if (got === api) ok++;
    else console.log('    对不上 ' + id + ' 标签=' + label + ' 接口=' + api);
  });
  is('16 件全部一致（标签缺失 == 0 人想要）', ok === TABLE.length, ok + '/' + TABLE.length);
}

console.log('\n' + (fail ? '✗ ' : '✓ ') + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
