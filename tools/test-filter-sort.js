/**
 * 按想要人数/价格筛选 + 排序（v1.9.0）
 *
 * 起因：客户要「想要人数 > 2 且价格 20-100 的自动勾选」+「列表区按价格/想要人数排序」。
 *
 * **动手前先查了字段，发现接口字段名一直是错的**（这是功能能不能做的前提）：
 *   闲鱼详情接口的真实字段是 **wantCnt / browseCnt**（带 Cnt 后缀），
 *   不是 wantNum / browseNum。写错的后果极其隐蔽：
 *   接口**确实有**这个数据（wantCnt=1、wantCntUnit='人想要'），
 *   但按错的名字去找 → 永远取不到 → 筛选功能永远筛不出东西，
 *   而且**没有任何报错**。
 *
 * 第二个坑：**列表接口不一定给 wantCnt**，但卡片 DOM 上写着「N 人想要」
 * （2026-10-28 实测详情页 .want--ecByv3Sr → "29人想要 1268浏览"），
 * 所以 DOM 这条路能立刻出结果，不用等补详情（30 秒/件）。
 *
 * 跑：node tools/test-filter-sort.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const UT = fs.readFileSync(path.join(ROOT, 'src/common/util.js'), 'utf8');
const BR = fs.readFileSync(path.join(ROOT, 'src/content/bridge.js'), 'utf8');
const IJ = fs.readFileSync(path.join(ROOT, 'src/content/injected.js'), 'utf8');

let pass = 0, fail = 0;
function is(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra != null ? '  → ' + extra : '')); }
}
function section(t) { console.log('\n' + t); }

const w = {}; vm.createContext(w);
vm.runInContext(UT, w, { timeout: 5000 });
const U = w.XYUtil;

/* ============================================================ */
section('1) ★★★ 接口字段名：wantCnt / browseCnt');
{
  const raw = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'tools/fixtures/xy-detail-real.json'), 'utf8'));
  const it = raw.data.itemDO;
  is('★ 样本里有 wantCnt（不是 wantNum）',
    it.wantCnt != null && it.wantNum == null, 'wantCnt=' + it.wantCnt);
  is('★ 样本里有 browseCnt（不是 browseNum）',
    it.browseCnt != null && it.browseNum == null, 'browseCnt=' + it.browseCnt);
  is('★ wantCntUnit 写着「人想要」', it.wantCntUnit === '人想要', it.wantCntUnit);

  const d = U.extractDetail(raw.data, null);
  is('★★★ 提取出的 wantNum = 1', d.wantNum === '1', String(d.wantNum));
  is('★★★ 提取出的 browseNum = 42', d.browseNum === '42', String(d.browseNum));
  is('★ 提取出的 price = 9.90（元）', d.price === '9.90', String(d.price));
}

/* ============================================================ */
section('2) ★★ 价格单位：skuList 的 price 是「分」');
{
  const raw = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'tools/fixtures/xy-detail-real2.json'), 'utf8'));
  is('★ 样本里只有 skuList 的分值',
    raw.data.itemDO.soldPrice == null &&
    raw.data.itemDO.skuList[0].price === 4990);
  const d = U.extractDetail(raw.data, null);
  is('★★ 换算成元（49.90，不是 4990）', d.price === '49.90', String(d.price));
}

/* ============================================================ */
section('3) ★★ 卡片 DOM 抓「N 人想要」');
{
  // 模拟一张卡片：内含 "¥9.90" "29人想要" "1268浏览"
  const fake = {
    innerText: '李宁 童鞋 2026新款\n¥9.90\n29人想要\n1268浏览'
  };
  is('★ 抓到想要人数 29', U.cardWantNum(fake) === '29', U.cardWantNum(fake));
  is('★ 抓到浏览量 1268', U.cardBrowseNum(fake) === '1268', U.cardBrowseNum(fake));

  const sp = { innerText: '商品A\n¥20.00\n5 人想要' };
  is('★ 「5 人想要」（带空格）也认', U.cardWantNum(sp) === '5', U.cardWantNum(sp));

  const none = { innerText: '商品B\n¥30.00' };
  is('★ 没有该文本时返回空（不是 0）',
    U.cardWantNum(none) === '' && U.cardBrowseNum(none) === '',
    U.cardWantNum(none) + '/' + U.cardBrowseNum(none));

  const zero = { innerText: '商品C\n0人想要' };
  is('★ 「0人想要」是有效值（不等于缺数据）', U.cardWantNum(zero) === '0', U.cardWantNum(zero));
}

/* ============================================================ */
section('3b) ★★★ 卡片价格：实测踩到的三种形态');
{
  // 真实页面上抓到的原始文本（2026-10-28 实测）：
  //   "¥\n69\n.90"    → CSS 把 69.90 拆成三行
  //   "¥\n45\n¥120"   → 两个价格（划线价 / 现价）
  //   "¥1855人想要"   → 价格 18 与「55人想要」粘在一起
  function fakeScope(texts) {
    return {
      querySelectorAll: function () {
        return texts.map(function (t) {
          return { textContent: t, innerText: t };
        });
      }
    };
  }
  const sel = ['[class*=price]'];

  is('★★ 拆行的一个价 → 69.90',
    U.cardPrice(fakeScope(['¥\n69\n.90']), sel, false) === '69.90',
    U.cardPrice(fakeScope(['¥\n69\n.90']), sel, false));
  is('★★ 两个价 → 取第一个 45（不是 45120）',
    U.cardPrice(fakeScope(['¥\n45\n¥120']), sel, false) === '45',
    U.cardPrice(fakeScope(['¥\n45\n¥120']), sel, false));
  is('★★ 价格与「N人想要」粘一起 → 18（不是 1855）',
    U.cardPrice(fakeScope(['¥1855人想要', '¥18', '55人想要']), sel, false) === '18',
    U.cardPrice(fakeScope(['¥1855人想要', '¥18', '55人想要']), sel, false));
  is('★ 区间价也先去空白',
    U.firstPrice('¥\n18\n.90-\n25\n.00') === '18.90',
    U.firstPrice('¥\n18\n.90-\n25\n.00'));
}

/* ============================================================ */
section('4) ★★★ 合并时不能把 wantNum/browseNum 丢掉');
{
  is('★ mergeCards 的补空列表含 wantNum/browseNum',
    /'title', 'price', 'image', 'sellerNick', 'wantNum', 'browseNum'/.test(IJ),
    (IJ.match(/'title', 'price'[^]]*\]/) || [''])[0]);
  is('★ bridge 的详情合并保护空值',
    /\['wantNum', 'browseNum'\]\.forEach/.test(BR));
}

/* ============================================================ */
section('5) ★★ 筛选逻辑');
{
  const fn = BR.slice(BR.indexOf('function matchFilter'),
                      BR.indexOf('function matchFilter') + 1400);
  is('★ 想要人数用 ≥ 语义（wantMin）', /w < wMin/.test(fn));
  is('★ 价格区间上下限都判断',
    /p < pMin/.test(fn) && /p > pMax/.test(fn));
  is('★★ 缺数据不算「不符合」，而是标记 missing',
    /return \{ ok: true, missing: 'want' \}/.test(fn) &&
    /return \{ ok: true, missing: 'price' \}/.test(fn));
  is('★ 缺数据与 0 区分（wantOf 返回 null 而不是 0）',
    /function wantOf\(d\)/.test(BR));
  is('★ 空值 = 不限（numOf 空串返回 null）',
    /function numOf\(v\)/.test(BR) &&
    /if \(v == null \|\| v === ''\) return null;/.test(BR));
}

/* ============================================================ */
section('6) ★★ 排序逻辑');
{
  is('★ 有 sortedCards 函数', /function sortedCards\(\)/.test(BR));
  is('★ 支持价格升序/降序', /'price-'/.test(BR) && /'price'/.test(BR));
  is('★ 支持想要人数排序', /else if \(key === 'want'\)/.test(BR));
  is('★ 支持浏览量排序', /else if \(key === 'browse'\)/.test(BR));
  is('★★ 缺数据的沉到末尾（不混在中间）',
    /if \(va == null\) return 1;/.test(BR) && /if \(vb == null\) return -1;/.test(BR));
  is('★ 渲染列表用排序后的结果', /var list = sortedCards\(\)/.test(BR));
  is('★ 排序选项齐全',
    /'default'/.test(BR) && /'want'/.test(BR) && /'browse'/.test(BR));
}

/* ============================================================ */
section('7) ★★ 界面');
{
  is('★ 有筛选条渲染函数', /function renderFilterBar\(body\)/.test(BR));
  is('★ 有「想要≥」输入框', /'想要≥'/.test(BR));
  is('★ 有价格区间两个输入框',
    /'低'/.test(BR) && /'高'/.test(BR));
  is('★ 有排序下拉', /document\.createElement\('select'\)/.test(BR));
  is('★ 有「筛选并勾选」按钮', /'筛选并勾选'/.test(BR));
  is('★ 有「追加勾选」按钮', /'追加勾选'/.test(BR));
  is('★ 有「清空条件」按钮', /'清空条件'/.test(BR));
  is('★ 筛选条在列表工具区里', /renderFilterBar\(body\);/.test(BR));
  is('★ 每行显示想要人数', /'人想要'/.test(BR));
  is('★ CSS 有筛选条样式', /\.xy-filter\s*\{/.test(
    fs.readFileSync(path.join(ROOT, 'src/content/panel.css'), 'utf8')));
}

console.log('\n' + '─'.repeat(50));
if (fail) {
  console.log('✗ 有失败：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(1);
} else {
  console.log('✓ 全部通过：' + pass + ' 项断言');
}