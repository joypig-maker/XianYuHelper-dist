/**
 * 京东店铺页采集的离线验证 —— 用真实结构固件，不碰京东服务器。
 *
 * 为什么要有这个：
 *   · 京东店铺页对高频访问会降级返回（实测连续探测十几次就变成「稍后...」，
 *     商品列表整个消失），真机验证跑不了几轮就把自己搞死
 *   · 而选择器这类东西完全可以在本地用真实 DOM 验证，不该耗线上配额
 *
 * 固件 tools/fixtures/jd-shop.html 的结构是从真机 dump 出来的（不是编的），
 * 里面还刻意放了店铺页上真实存在的干扰项：
 *   · index-774716.html / view_search-991882-... ← 不能被当成商品
 *   · data-id="774716"（shopId）、data-venderid="778749" ← 曾经被误采成商品
 *
 * 注意：固件里保留 `//item.jd.com/...` 这种相对协议写法（真机就是长这样），
 * 在 file:// 下必须补成 https:// 才能正确解析，所以这里做一次替换。
 *
 * 用法：node tools/verify-jd-shop-offline.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const CDP = require('./cdp');

const ROOT = path.join(__dirname, '..');
const UTIL = fs.readFileSync(path.join(ROOT, 'src/common/util.js'), 'utf8');
const SITES = fs.readFileSync(path.join(ROOT, 'src/common/sites.js'), 'utf8');

let html = fs.readFileSync(path.join(ROOT, 'tools/fixtures/jd-shop.html'), 'utf8');
// file:// 下 `//img14.360buyimg.com/x.jpg` 会被解析成 file://img14... ，补上协议
html = html.replace(/(src|href)="\/\//g, '$1="https://');

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('✓ ' + name); }
  else { fail++; console.log('✗ ' + name + (extra !== undefined ? '  → ' + extra : '')); }
}

(async () => {
  const b = await CDP.connect(9222);
  const page = await b.open('about:blank');

  // 把固件写进文档。用 document.write 而不是导航到 file://，
  // 这样不会被浏览器的本地文件策略干扰。
  await page.evaluate(`document.open(); document.write(${JSON.stringify(html)}); document.close(); return 1;`, true);
  // 等图片加载完（cardImage 会看 naturalWidth）
  await new Promise((r) => setTimeout(r, 3500));

  const r = await page.evaluate(`
    var out = {};
    try { ${UTIL} } catch (e) { out.utilErr = e.message; }
    try { ${SITES} } catch (e) { out.sitesErr = e.message; }
    out.有Util = typeof XYUtil !== 'undefined';
    out.有Sites = typeof XYSites !== 'undefined';
    if (!out.有Util || !out.有Sites) return out;

    var site = XYSites.jd;
    out.站点识别 = XYSites.match('mall.jd.com') ? XYSites.match('mall.jd.com').key : '(未命中)';

    // DOM 侧的事实（确认固件本身没问题）
    out.glItem = document.querySelectorAll('li.gl-item').length;
    out.链接总数 = document.querySelectorAll('a[href]').length;

    var cards = XYUtil.scanCards(document, site);
    out.卡片数 = cards.length;
    out.卡片 = cards.map(function (c) {
      return {
        id: c.itemId,
        title: String(c.title || ''),
        price: String(c.price || ''),
        image: String(c.image || ''),
        url: c.url,
        source: c.source
      };
    });
    return out;
  `, true);

  if (r.utilErr) console.log('util 注入异常: ' + r.utilErr);
  if (r.sitesErr) console.log('sites 注入异常: ' + r.sitesErr);

  console.log('\n=== 固件本身 ===');
  ok('注入成功', r.有Util && r.有Sites);
  ok('固件里有 4 张 li.gl-item（3 张装修模板 + 1 张老模板）', r.glItem === 4, r.glItem);
  ok('站点识别为 jd', r.站点识别 === 'jd', r.站点识别);

  console.log('\n=== scanCards 产出 ===');
  ok('正好采到 4 张卡片（多一张少一张都是错）', r.卡片数 === 4, '实际 ' + r.卡片数);
  (r.卡片 || []).forEach((c, i) => {
    console.log('  [' + i + '] id=' + c.id);
    console.log('      标题 ' + c.title.slice(0, 40));
    console.log('      价格 ' + c.price);
    console.log('      图片 ' + c.image.slice(-52));
  });

  const ids = (r.卡片 || []).map((c) => c.id).sort();
  const want = ['100012043978', '10149735636398', '10214105977940', '10216824761563'].sort();
  ok('四个商品 ID 都对', JSON.stringify(ids) === JSON.stringify(want), JSON.stringify(ids));

  console.log('\n=== 干扰项必须被挡住 ===');
  ok('shopId 774716 没被当成商品',
    (r.卡片 || []).every((c) => c.id !== '774716'));
  ok('venderId 778749 没被当成商品',
    (r.卡片 || []).every((c) => c.id !== '778749'));
  ok('appId 991882 没被当成商品（那是 view_search 的段1）',
    (r.卡片 || []).every((c) => c.id !== '991882'));
  ok('没有「无图无价无标题」的脏卡片',
    (r.卡片 || []).every((c) => c.title && c.price && c.image),
    JSON.stringify((r.卡片 || []).map((c) => [c.title.length, c.price.length, c.image.length])));

  console.log('\n=== 字段完整性 ===');
  const c0 = (r.卡片 || []).find((c) => c.id === '10216824761563');
  ok('标题取到（.jDesc a）', c0 && c0.title.indexOf('罗蒙10A抗菌') === 0, c0 && c0.title);
  ok('价格是 64.30（￥ 与数值两个节点拼出来的）', c0 && c0.price === '64.3' || (c0 && c0.price === '64.30'),
    c0 && c0.price);
  ok('主图已升到 n0 档（800x800 原图，不是 n7 的 220x220 缩略图）',
    c0 && /\/n0\//.test(c0.image), c0 && c0.image.slice(0, 70));
  ok('商品链接是标准详情页地址',
    c0 && c0.url === 'https://item.jd.com/10216824761563.html', c0 && c0.url);

  // 每一张都要有图，且都是 n0
  ok('4 张卡片的图全部升到 n0',
    (r.卡片 || []).length === 4 && (r.卡片 || []).every((c) => /\/n0\//.test(c.image)),
    JSON.stringify((r.卡片 || []).map((c) => /\/n0\//.test(c.image))));

  /* ---- 两套模板都要认 ----------------------------------------------------
   * 装修模板（.jPic/.jDesc/.jdPrice）和老搜索模板（.p-img/.p-name/.p-price）
   * 的字段落点完全不同。只配一套的话，另一套的页面就是「图有、价没有」
   * 这种半死不活的状态 —— 真机上正是这么遇到的。
   */
  console.log('\n=== 两套模板都能认 ===');
  const old = (r.卡片 || []).find((c) => c.id === '100012043978');
  ok('老模板卡片被采到', !!old);
  ok('老模板标题（.p-name a）', old && old.title.indexOf('老模板样例商品') > -1, old && old.title);
  ok('老模板价格 28.23（<i>￥</i><em>28.23</em> 拼出来）',
    old && (old.price === '28.23' || old.price === '28.2'), old && old.price);
  ok('老模板主图（.p-img img）并升到 n0',
    old && /\/n0\//.test(old.image || ''), old && (old.image || '').slice(0, 70));

  /* ---- 降级页：主路径失效时，兜底路径不能把 shopId 当商品 ----------------
   * 这条为什么必须单独造场景：兜底分支只在「主路径一张卡都没采到」时才跑。
   * 上面那个固件里主路径是成功的（3 张），所以兜底根本不会执行 ——
   * 想验它就得把主路径打掉。真机上也正是这么遇到的：
   * 京东限流时返回的页面里 .gl-item 和商品直链全没了，
   * 只剩满地 data-id="<shopId>"，于是被采成一条空卡片。
   */
  const degraded = await page.evaluate(`
    var out = {};
    var site = XYSites.jd;
    // 打掉主路径：去掉卡片类名、去掉所有商品直链、连 data-sku 一起摘掉
    // （模拟限流降级页：这些结构性标记都没了，只剩满地的 data-id="<shopId>"）
    Array.prototype.forEach.call(document.querySelectorAll('li.gl-item, [data-sku]'), function (li) {
      li.className = 'jSubObject';
      if (li.removeAttribute) li.removeAttribute('data-sku');
    });
    Array.prototype.forEach.call(document.querySelectorAll('a[href*="item.jd.com"]'), function (a) {
      a.setAttribute('href', 'javascript:;');
    });
    out.主路径剩余 = document.querySelectorAll('li.gl-item, [data-sku]').length;
    var cards = XYUtil.scanCards(document, site);
    out.卡片数 = cards.length;
    out.采到的ID = cards.map(function (c) { return c.itemId; });
    return out;
  `, true);

  console.log('\n=== 降级页（主路径失效）的兜底行为 ===');
  ok('主路径确实被打掉了（固件准备正确）', degraded.主路径剩余 === 0, degraded.主路径剩余);
  ok('兜底路径没有把 shopId / venderId 采成商品',
    degraded.卡片数 === 0, '采到 ' + JSON.stringify(degraded.采到的ID));

  try { await page.close(); } catch (e) {}
  await b.close();

  console.log('\n———————————————————————————————');
  console.log((fail === 0 ? '✓ 全部通过' : '✗ 有失败') + '：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR', e && e.message); process.exit(1); });
