/**
 * 淘宝/天猫接入回归
 *
 * 锁的是这一轮接进来的四条链路（全部结论来自真机实测，见 tools/diag-tb-*.js）：
 *   ① 站点配置：天猫与淘宝的域名/URL 形态差异都覆盖到
 *   ② 搜索页：卡片里的 a[href] 没有商品 ID，只能从 data-spm-act-id 取
 *   ③ 店铺页：走 mtop.taobao.shop.simple.item.fetch 分页；加密价必须挡掉
 *   ④ 详情页：pcdetail.data.get 给 5 张主图 + 到手价；getdesc v6.0 给 22 张详情图
 *
 * 断言分两层：数据层跑真实固件，契约层从源码抠接线，防止被人改回去。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const fx = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'fixtures', n), 'utf8'));

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('✓ ' + name); }
  else { fail++; console.log('✗ ' + name + (extra ? '  → ' + extra : '')); }
}

const win = {};
vm.createContext(win);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/common/util.js'), 'utf8'), win, { timeout: 5000 });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/common/sites.js'), 'utf8'), win, { timeout: 5000 });
const U = win.XYUtil;
const S = win.XYSites;
const T = S.taobao;

const INJ = fs.readFileSync(path.join(ROOT, 'src/content/injected.js'), 'utf8');

console.log('=== ① 站点配置：淘宝与天猫的网址差异 ===');
{
  ok('淘宝域名命中 taobao', S.match('s.taobao.com') && S.match('s.taobao.com').key === 'taobao');
  ok('天猫域名命中 taobao', S.match('detail.tmall.com') && S.match('detail.tmall.com').key === 'taobao');
  ok('品牌店铺域名命中 taobao', S.match('minwai.tmall.com') && S.match('minwai.tmall.com').key === 'taobao');
  ok('淘宝已启用（active 返回站点而非 null）', !!(S.active('s.taobao.com')));
  ok('详情页 ID 正则认 item.htm?id=', T.idRe.test('https://item.taobao.com/item.htm?id=669745626548'));
  ok('详情页 ID 正则认天猫 detail.tmall.com', T.idRe.test('https://detail.tmall.com/item.htm?id=669745626548'));

  // 店铺页判定：新旧入口实测都会归一，路径特征要认全
  ok('店铺页判定认 category.htm', T.shopPageRe.test('https://minwai.tmall.com/category.htm?a=1'));
  ok('店铺页判定认 search.htm', T.shopPageRe.test('https://shop375415709.taobao.com/search.htm'));
  ok('店铺页判定认 store.taobao.com', T.shopPageRe.test('https://store.taobao.com/category.htm'));
  ok('店铺页判定不误伤搜索页', !T.shopPageRe.test('https://s.taobao.com/search?q=x'));
  ok('店铺页判定不误伤详情页', !T.shopPageRe.test('https://detail.tmall.com/item.htm?id=1'));
}

console.log('\n=== ② 搜索页：商品 ID 只能从 data-spm-act-id 取 ===');
{
  // 假元素：cardSel 命中的容器挂着 data-spm-act-id，里面的 a 是广告跳转链接
  function fakeEl(attrs, parent) {
    return {
      getAttribute: (n) => (attrs && n in attrs ? attrs[n] : null),
      parentElement: parent || null,
      querySelectorAll: () => [],
      className: '',
    };
  }
  const cardWithId = fakeEl({ 'data-spm-act-id': '620596943567', 'class': 'doubleCardWrapperAdapt--x' });
  const linkEl = fakeEl({ href: 'https://click.simba.taobao.com/cc_im?p=x&s=1' }, cardWithId);
  const nested = fakeEl({}, cardWithId);

  ok('从卡片容器直接取到 ID', T.idFrom(cardWithId, '') === '620596943567');
  ok('从子元素向上找到容器的 ID', T.idFrom(nested, '') === '620596943567');
  ok('广告跳转链接里没有 ID（说明为何必须靠属性）',
    !/[?&]id=\d{6,}/.test('https://click.simba.taobao.com/cc_im?p=x&s=1'));
  ok('非数字属性值不当成 ID',
    T.idFrom(fakeEl({ 'data-spm-act-id': 'abc' }), '') === '');
  ok('没有该属性时返回空串', T.idFrom(fakeEl({}), '') === '');

  ok('cardSel 锚在 doubleCardWrapper', /doubleCardWrapper/.test(T.cardSel));
  ok('字段选择器用 [class*=] 前缀（类名带 hash 会漂）',
    T.field.title.every((s) => s.indexOf('[class*=') === 0) ||
    T.field.title.some((s) => s.indexOf('[class*=') === 0));
  ok('价格取 innerPriceWrapper（整数与小数是兄弟节点）',
    T.field.price[0] === '[class*="innerPriceWrapper"]',
    '实际 ' + T.field.price[0]);
}

console.log('\n=== ③ 店铺页：接口解析与加密价 ===');
{
  const f = fx('tb-shop-items.json');
  const cards = U.collectCards(f, { site: T });
  ok('店铺列表固件能解析出商品', cards.length === 5, '实际 ' + cards.length);
  ok('itemId 正确', cards[0].itemId === '669745626548', cards[0].itemId);
  ok('每件带 1 张主图', cards.every((c) => (c.images || []).length >= 1));
  ok('商品 URL 指向真实详情页', /item\.(taobao|tmall)\.com/.test(cards[0].url));

  // 加密价：[1_7ij1w4tp#51#<base64>#] —— 必须留空，不能当价格写进文案。
  // 断言不能只查 '[ 开头'：formatPrice 会把加密串抽成一堆数字，
  // 输出 1.7145190993087112e+22 这种科学计数法垃圾，照样是脏价格。
  // 所以按「空 或 正常十进制数字」来判断。
  ok('固件里的价格确实是加密串（前提成立）',
    /^\[/.test(f.data[0].discountPrice),
    f.data[0].discountPrice.slice(0, 24));
  ok('加密价被挡掉，price 为空或正常十进制',
    cards.every((c) => !c.price || /^\d+(\.\d{1,2})?$/.test(c.price)),
    cards.map((c) => c.price || '(空)').join(' | '));
  ok('formatPrice 对加密串不产出科学计数法',
    U.formatPrice('[1_7ij1w4tp#51#MjIyMj9gdm0UaT99M3xWbDVq0mFFYcNoLVNObzt8mGCIU71jSWZKZy1id29Ab0BS9G66YNZk+2zP=#]') === '',
    U.formatPrice('[1_7ij1w4tp#51#MjIyMj9gdm0UaT99M3xWbDVq]=#]'));

  ok('shopApi 指向 simple.item.fetch',
    T.shopApi.api === 'mtop.taobao.shop.simple.item.fetch', T.shopApi.api);
  ok('shopApi 从 HTML 里取 shopId/sellerId',
    T.shopApi.idFromHtml.length === 2 &&
    T.shopApi.idFromHtml[0].test('"shopId":"375415709"') &&
    T.shopApi.idFromHtml[1].test('"sellerId":"2200811463590"'));
  ok('分页参数含 page/catId/shopId/sellerId',
    (function () {
      const d = T.shopApi.buildData('375415709', '2200811463590', 3);
      return d.page === 3 && d.shopId === '375415709' && d.sellerId === '2200811463590' && d.catId === 0;
    })());
}

console.log('\n=== ④ 详情页：主图 / 到手价 / 详情图 ===');
{
  const detail = U.extractDetail(fx('tb-detail.json'), T);
  ok('详情解析出结果', !!detail);
  ok('主图正好 5 张（1688/淘宝后台主图上限）', detail.images.length === 5,
    '实际 ' + detail.images.length);
  ok('价格取到手价 4.01 而非原价 5.01', detail.price === '4.01', '实际 ' + detail.price);
  ok('标题正确', /液态软胶数据线/.test(detail.title), detail.title.slice(0, 20));

  const descImgs = U.parseTaobaoDesc(fx('tb-desc.json'));
  ok('详情图 22 张（pcDescContent 里的 <img>）', descImgs.length === 22, '实际 ' + descImgs.length);
  ok('详情图都是完整 https 地址', descImgs.every((u) => /^https:/.test(u)));
  ok('价格说明图未被收进来', !descImgs.some((u) => /tps-/.test(u)));

  const merged = U.capImages(U.filterItemImages(detail.images.concat(descImgs)));
  ok('主图 + 详情图合并后截断为 9 张（闲鱼图位上限）', merged.length === 9, '实际 ' + merged.length);
  ok('截断后保留的是主图（顺序即优先级）',
    merged[0] === U.normalizeImageUrl(detail.images[0]));

  ok('detailApi 指向 pcdetail.data.get（不是 adjust）',
    T.detailApi.api === 'mtop.taobao.pcdetail.data.get', T.detailApi.api);
  ok('descApi 用 v6.0（v7.0 主动调返回 null）', T.descApi.v === '6.0', String(T.descApi.v));
  ok('detailPaths 指向 item.images', T.detailPaths.images[0] === 'item.images');
  ok('detailPaths 价格优先取 subPrice（到手价）',
    /subPrice/.test(T.detailPaths.price[0]), T.detailPaths.price[0]);
}

console.log('\n=== ⑤ 源码契约：接线不许被改回去 ===');
{
  ok('handleResponse 认店铺商品列表接口',
    /String\(api\)\.indexOf\(SITE\.shopApi\.api\)/.test(INJ),
    '没找到以完整 api 名比对的判断');
  ok('handleResponse 用整名比对（店铺信息 simple.fetch 与商品列表只差 .item）',
    /SITE\.shopApi && SITE\.shopApi\.api && String\(api\)\.indexOf\(SITE\.shopApi\.api\) > -1/.test(INJ));
  ok('有主动拉整店的函数', /async function fetchShopItems/.test(INJ));
  ok('整店拉取有翻页上限（防接口异常时无限翻）',
    /var SHOP_PAGE_MAX = \d+/.test(INJ));
  ok('整店拉取只在店铺页触发',
    /SITE\.shopPageRe && SITE\.shopPageRe\.test\(location\.href\)/.test(INJ));
  ok('fetchDescImages 支持 mtop 形态（淘宝）',
    /SITE\.descApi\.api && window\.lib && window\.lib\.mtop/.test(INJ));
  ok('scanCards 走站点自定义 ID 提取',
    /if \(site\.idFrom\)/.test(fs.readFileSync(path.join(ROOT, 'src/common/util.js'), 'utf8')));
}

console.log('\n' + '='.repeat(52));
if (fail === 0) console.log('全部通过 ✅  ' + pass + ' 项');
else console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项 ❌');
process.exit(fail === 0 ? 0 : 1);
