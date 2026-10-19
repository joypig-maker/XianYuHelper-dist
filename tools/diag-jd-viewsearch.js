/**
 * 试出京东店铺「全部商品」的 view_search URL 写法，并验证翻页参数。
 *
 * 已知（实测）：
 *   view_search-<段1>-<段2分类>-99-<页>-<每页>-1.html
 *   · 段1 是店铺的 mall 内 ID（≠ shopId，≠ venderId），能从店铺首页的
 *     「商品分类」链接里抓到
 *   · 段2 是分类 ID，如 8441300；换成什么值才是「全部」是本脚本要回答的
 *   · 第 4 段是页码，第 5 段是每页条数
 *
 * 用法：node tools/diag-jd-viewsearch.js <段1> [段1b ...]
 */
'use strict';
const CDP = require('./cdp');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROBE = `
  var out = {};
  out.href = location.href.slice(0, 130);
  out.title = (document.title || '').slice(0, 70);
  var t = (document.body ? document.body.innerText : '') || '';
  var m = t.match(/共\\s*(\\d+)\\s*件/);
  out.总数 = m ? Number(m[1]) : null;
  out.glItem = document.querySelectorAll('.gl-item').length;
  out.dataSku = document.querySelectorAll('[data-sku]').length;
  out.空页提示 = /没有找到|暂无商品|无相关商品|抱歉/.test(t);
  // 前几个商品的 ID + 标题，用来判断「第 2 页是不是真的换了货」
  out.样例 = [];
  Array.prototype.forEach.call(document.querySelectorAll('.gl-item'), function (li) {
    if (out.样例.length >= 3) return;
    var a = li.querySelector('a[href*="item.jd.com"]');
    if (!a) return;
    var idm = String(a.getAttribute('href') || '').match(/item\\.jd\\.com\\/(\\d{6,20})/);
    if (!idm) return;
    var t2 = li.querySelector('.jDesc a') || li.querySelector('.p-name a') || a;
    var p = li.querySelector('.jdNum') || li.querySelector('[class*="price"] b');
    var img = li.querySelector('img');
    out.样例.push({
      id: idm[1],
      标题: String(t2.innerText || '').replace(/\\s+/g, ' ').slice(0, 34),
      价: p ? String(p.innerText || '').trim().slice(0, 12) : '(无)',
      图: img ? String(img.getAttribute('src') || img.getAttribute('data-lazy-img') || '').slice(0, 70) : '(无)'
    });
  });
  // 分页控件
  var gp = document.querySelector('.g-pager');
  out.分页 = gp ? String(gp.innerText || '').replace(/\\s+/g, ' ').slice(0, 60) : '(无 .g-pager)';
  var cf = document.querySelector('[class*="filter"],[class*="crumb"]');
  out.面包屑 = cf ? String(cf.innerText || '').replace(/\\s+/g, ' ').slice(0, 90) : '(无)';
  return out;
`;

(async () => {
  const seg1 = process.argv.slice(2);
  if (!seg1.length) { console.error('用法: node tools/diag-jd-viewsearch.js <段1数字> [...]'); process.exit(1); }

  const b = await CDP.connect(9222);

  for (const a of seg1) {
    // 「段2」候选：0 常被用作「不筛分类」，另外试 99 占位
    const urls = [
      'https://mall.jd.com/view_search-' + a + '-0-99-1-20-1.html',
      'https://mall.jd.com/view_search-' + a + '-0-0-1-20-1.html',
      'https://mall.jd.com/view_search-' + a + '-99-99-1-20-1.html',
      'https://mall.jd.com/view_search-' + a + '-0-99-2-20-1.html'
    ];
    console.log('\n########## 段1 = ' + a + ' ##########');
    for (const u of urls) {
      let page = null;
      try {
        page = await b.open('about:blank');
        await page.goto(u, 35000);
        await sleep(5500);
        const r = await page.evaluate(PROBE, true);
        const tag = (r.总数 != null && r.glItem > 0 && !r.空页提示) ? '✓' : '×';
        console.log('\n ' + tag + ' ' + u.replace('https://mall.jd.com/', ''));
        console.log('     总数=' + r.总数 + '  gl-item=' + r.glItem + '  空页=' + r.空页提示 +
          '  分页=' + r.分页);
        console.log('     标题=' + r.title);
        if (r.面包屑 !== '(无)') console.log('     面包屑=' + r.面包屑);
        r.样例.forEach((s) => console.log('       id=' + s.id + ' [' + s.价 + '] ' + s.标题));
      } catch (e) {
        console.log('\n × ' + u.replace('https://mall.jd.com/', '') + '  ✗ ' + (e && e.message));
      } finally {
        if (page) { try { await page.close(); } catch (e) {} }
      }
      await sleep(600);
    }
  }
  await b.close();
})().catch((e) => { console.error('ERR', e && e.message); process.exit(1); });
