/**
 * 京东详情页结构 + 店铺入口探测。
 *
 * 目的：
 *   ① 摸清详情页的主图/价格/标题/SKU/详情图字段（补图用）
 *   ② 找到「这家店的全部商品」真实入口 URL ——
 *      mall.jd.com/view_search-<x>.html 我猜的格式要么 404 要么乱跳到
 *      search.jd.com?keyword=xx，必须从真实页面上捞。
 *
 * 用法：node tools/diag-jd-detail.js [sku]
 */
'use strict';
const CDP = require('./cdp');

const SKU = process.argv[2] || '100275558589';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await CDP.connect(9222);
  const url = 'https://item.jd.com/' + SKU + '.html';
  console.log('打开: ' + url);
  const page = await b.open(url);
  await sleep(10000);

  const r = await page.evaluate(`
    var out = {};
    out.href = location.href.slice(0, 100);
    out.title = (document.title || '').slice(0, 60);
    out.len = (document.body.innerText || '').length;

    function txt(sel) {
      try {
        var e = document.querySelector(sel);
        return e ? String(e.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60) : null;
      } catch (e2) { return 'sel-err'; }
    }
    function cnt(sel) { try { return document.querySelectorAll(sel).length; } catch (e) { return -1; } }

    out.标题候选 = {
      '.sku-name': txt('.sku-name'),
      '[class*="sku-name"]': txt('[class*="sku-name"]'),
      '.itemInfo-wrap h1': txt('.itemInfo-wrap h1'),
      '.itemInfo-wrap [class*="name"]': txt('.itemInfo-wrap [class*="name"]')
    };
    out.价格候选 = {
      '.p-price .price': txt('.p-price .price'),
      '.p-price': txt('.p-price'),
      '.summary-price': txt('.summary-price'),
      '[class*="price"]': txt('[class*="price"]')
    };
    out.数量 = {
      '#spec-list li': cnt('#spec-list li'),
      '#spec-list img': cnt('#spec-list img'),
      '.spec-items li': cnt('.spec-items li'),
      '.spec-items img': cnt('.spec-items img'),
      '#J-detail-content img': cnt('#J-detail-content img'),
      '#detail img': cnt('#detail img'),
      '[class*="detail"] img': cnt('[class*="detail"] img'),
      '.sku-attr': cnt('.sku-attr'),
      '[class*="sku"] [class*="item"]': cnt('[class*="sku"] [class*="item"]')
    };

    // 缩略图/主图的实际地址形态
    function imgsOf(sel) {
      var out2 = [];
      try {
        Array.prototype.slice.call(document.querySelectorAll(sel)).slice(0, 5).forEach(function (i) {
          out2.push({
            src: String(i.getAttribute('src') || '').slice(0, 70),
            big: String(i.getAttribute('data-url') || i.getAttribute('data-src') || '').slice(0, 70)
          });
        });
      } catch (e) {}
      return out2;
    }
    out.缩略图 = imgsOf('#spec-list img, .spec-items img');
    out.详情图 = imgsOf('#J-detail-content img, #detail img');

    // 店铺入口：所有指向店铺的链接
    var seen = {}, shopLinks = [];
    Array.prototype.slice.call(document.querySelectorAll('a[href]')).forEach(function (a) {
      var h = String(a.getAttribute('href') || '');
      if (/mall\\.jd\\.com|shop\\.jd\\.com|view_search|\\/\\/\\w+\\.jd\\.com\\/index-/.test(h) && !seen[h]) {
        seen[h] = 1;
        shopLinks.push({ href: h.slice(0, 100), text: String(a.textContent || '').trim().slice(0, 24) });
      }
    });
    out.店铺链接 = shopLinks.slice(0, 12);

    out.head = (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 130);
    return out;
  `, true);

  console.log('\n' + JSON.stringify(r, null, 1));
  await b.close();
})().catch((e) => { console.error('ERR', e && e.message); process.exit(1); });
