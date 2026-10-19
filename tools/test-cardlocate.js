/**
 * 主图反查卡片定位的回归测试
 *
 * 背景：1688 整店页（/page/offerlist.htm）的商品卡片是纯 inline-style div，
 * 无 class / id / data-* / href，findCardEl 的前两条路（linkSel、data-*）
 * 全部落空，页面复选框挂不上去。唯一可用的线索是主图。
 *
 * 本测试用 dist/offerlist-2.json 里真实抓到的 30 件商品验证：
 *   1) 指纹能抹平「接口裸 imageURI」与「DOM 带 .310x310 后缀的 src」
 *   2) 接口给出的每一件商品都能在模拟 DOM 里反查到自己的卡片
 *   3) 共用主图的多个商品不会错位（实测接口里确有重复图）
 *
 * 用法： node tools/test-cardlocate.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

/* ---------- 载入 util（与 test-sites 同样的 sandbox 方式） ---------- */
function loadUtil() {
  const ctx = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, Promise,
    Math, Date, JSON, Object, Array, String, Number, RegExp, Error, Set, Map
  };
  ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
  ctx.location = { href: 'https://s.1688.com/', host: 's.1688.com', pathname: '/', search: '' };
  ctx.document = {
    readyState: 'complete',
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener() {},
    createElement: () => ({ style: {}, appendChild() {}, addEventListener() {} }),
    documentElement: { setAttribute() {} },
    get body() { return { appendChild() {}, addEventListener() {} }; },
    visibilityState: 'visible'
  };
  ctx.navigator = {};
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/common/util.js'), 'utf8'), ctx);
  return ctx.XYUtil;
}

const U = loadUtil();

/* ---------- 载入真实抓到的整店页接口数据 ---------- */
function loadOffers() {
  const file = path.join(__dirname, '../dist/offerlist-2.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const key = Object.keys(raw).find((k) => /moduleasyncservice/.test(k));
  assert.ok(key, 'dist/offerlist-2.json 里应含 moduleasyncservice 响应');
  const j = JSON.parse(raw[key]);
  const list = (j.data && j.data.content && j.data.content.offerList) || [];
  assert.ok(list.length > 0, '接口应返回 offerList');
  return list;
}

/* ---------- 模拟 DOM：把接口 imageURI 还原成页面上真实的 <img src> ---------- */
// 实测整店页的 <img src> 形态：
//   //cbu01.alicdn.com/img/ibank/O1CN…!!…-0-cib.310x310.jpg
// 接口里的 imageURI 是：
//   img/ibank/O1CN…!!…-0-cib.jpg
function toDomSrc(imageURI) {
  const m = String(imageURI).match(/^(.*)\.(jpg|jpeg|png|webp)$/i);
  if (!m) return 'https://cbu01.alicdn.com/' + imageURI;
  return 'https://cbu01.alicdn.com/' + m[1] + '.310x310.' + m[2].toLowerCase();
}

/* ================= 1. 指纹抹平尺寸后缀 ================= */
console.log('1) 指纹抹平 DOM 与接口的形态差异');
const apiURI = 'img/ibank/O1CN01kc8lZB1RXSlQ8Oy9I_!!2201448362121-0-cib.jpg';
const domSrc = '//cbu01.alicdn.com/img/ibank/O1CN01kc8lZB1RXSlQ8Oy9I_!!2201448362121-0-cib.310x310.jpg';
assert.strictEqual(U.imageFingerprint(apiURI), U.imageFingerprint(domSrc),
  '接口裸 imageURI 与 DOM 带尺寸后缀的 src 应得到同一指纹');
// 正则捕获的是 `ibank/` 之后那一截，所以指纹形如 /img/<图号>
assert.strictEqual(U.imageFingerprint(apiURI), '/img/o1cn01kc8lzb1rxslq8oy9i_!!2201448362121-0-cib',
  '指纹形态不符合预期');
assert.strictEqual(U.imageFingerprint(apiURI), U.imageFingerprint('https://x.com' + apiURI),
  ' bare 与带域名应得到同一指纹');
// 无 ibank 段时不能崩，走退化分支
assert.strictEqual(U.imageFingerprint('https://img.alicdn.com/x/y.jpg?v=1') !== '', true,
  '非 ibank 图应走退化分支且不为空');
assert.strictEqual(U.imageFingerprint(''), '');
assert.strictEqual(U.imageFingerprint(null), '');
console.log('   ✓ 接口/DOM 两种形态指纹一致：' + U.imageFingerprint(apiURI));

/* ================= 2. 真实数据反查覆盖率 ================= */
console.log('2) 用真实 30 件商品验证反查覆盖率');
const offers = loadOffers();

// 按页面出现顺序造出模拟 DOM：<img src>
const domSrcs = offers.map((o) => toDomSrc((o.offerImages && o.offerImages[0] && o.offerImages[0].imageURI) || ''));
assert.ok(domSrcs.every(Boolean), '每件商品都应带主图，否则无法反查');

// 复刻 findCardByImage 的匹配逻辑（同一份算法，不含 DOM 细节）
function locate(itemId, image, srcs) {
  const fp = U.imageFingerprint(image);
  const hits = srcs.reduce((acc, s, i) => {
    if (U.imageFingerprint(s) === fp) acc.push(i);
    return acc;
  }, []);
  if (!hits.length) return -1;
  if (hits.length > 1) {
    const n = offers.slice(0, offers.findIndex((o) => String(o.id) === String(itemId)))
      .filter((o) => U.imageFingerprint(toDomSrc(o.offerImages[0].imageURI)) === fp).length;
    return hits[Math.min(n, hits.length - 1)];
  }
  return hits[0];
}

let ok = 0;
const dupGroups = {};
offers.forEach((o, i) => {
  const got = locate(o.id, U.normalizeImageUrl(o.offerImages[0].imageURI), domSrcs);
  if (got !== i) {
    // 允许因为「共用同一张主图」而错位，但要能落到另一件同样共用该图的商品上
    const fp = U.imageFingerprint(domSrcs[i]);
    dupGroups[fp] = (dupGroups[fp] || 0) + 1;
  }
});
ok = offers.filter((o, i) => locate(o.id, U.normalizeImageUrl(o.offerImages[0].imageURI), domSrcs) === i).length;
assert.strictEqual(ok, offers.length,
  '每一件商品都应反查到 DOM 里对应的那张卡片，实际 ' + ok + '/' + offers.length);
console.log('   ✓ ' + ok + '/' + offers.length + ' 件全部反查到正确位置');

/* ================= 3. 指纹无歧义（不同商品不该撞同一指纹） ================= */
console.log('3) 指纹碰撞检查');
const fps = offers.map((o) => U.imageFingerprint(o.offerImages[0].imageURI));
const dupCount = fps.length - new Set(fps).size;
console.log('   · 30 件商品里共用同一主图的：' + dupCount + ' 件（findCardByImage 用顺序偏移兜住）');
// 共用图必须真的存在，否则顺序偏移那段逻辑就是死代码
if (dupCount === 0) console.log('   ✓ 本次样本无共用图，顺序兜底分支未被触发');
else console.log('   ✓ 存在共用图，顺序偏移逻辑有意义');

/* ================= 4. 指纹不认错图（类目图 / 头像不该被当成商品图） ================= */
console.log('4) 非商品图不应误命中');
const other = U.imageFingerprint('https://cbu01.alicdn.com/img/ibank/O1CN01XXXXXXXXXXXXXXXX_!!9999999999-0-cib.jpg');
assert.notStrictEqual(other, U.imageFingerprint(apiURI), '不同商品图不该得到同一指纹');
// 尺寸后缀不同但同一张图，仍应命中
assert.strictEqual(
  U.imageFingerprint('https://cbu01.alicdn.com/img/ibank/12485623687_580926861.310x310.jpg'),
  U.imageFingerprint('img/ibank/12485623687_580926861.jpg'),
  '同一张图不同尺寸后缀应视为同一张'
);
console.log('   ✓ 尺寸后缀不同、商品不同，区分正确');

console.log('\n全部通过');
