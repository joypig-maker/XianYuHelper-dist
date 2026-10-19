/**
 * 京东各入口的可访问性 + 结构探测。
 * 先搞清楚「哪些页面要求登录」，再决定怎么接。
 *
 * 用法：node tools/diag-jd-entry.js
 */
'use strict';
const CDP = require('./cdp');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const URLS = [
  ['详情页 item.jd.com', 'https://item.jd.com/100012043978.html'],
  ['店铺页 mall.jd.com', 'https://mall.jd.com/index-1000004123.html'],
  ['PC 搜索 search.jd.com', 'https://search.jd.com/Search?keyword=' + encodeURIComponent('手机支架') + '&enc=utf-8'],
  ['移动搜索 so.m.jd.com', 'https://so.m.jd.com/ware/search.action?keyword=' + encodeURIComponent('手机支架')],
  ['首页 www.jd.com', 'https://www.jd.com/']
];

(async () => {
  const b = await CDP.connect(9222);
  for (const [name, u] of URLS) {
    let page = null;
    try {
      page = await b.open(u);
      await sleep(7000);
      const r = await page.evaluate(`
        var n = function (s) { try { return document.querySelectorAll(s).length; } catch (e) { return -1; } };
        return {
          href: location.href.slice(0, 96),
          title: (document.title || '').slice(0, 40),
          len: (document.body.innerText || '').length,
          login: /passport\\.jd\\.com|欢迎登录/.test(location.href + document.title),
          glItem: n('li.gl-item'),
          dataSku: n('[data-sku]'),
          jItem: n('.j-item'),
          anyCard: n('[class*="goods"],[class*="item"],[class*="sku"]')
        };
      `, true);
      console.log('\n▸ ' + name);
      console.log('  ' + JSON.stringify(r));
    } catch (e) {
      console.log('\n▸ ' + name + ' —— ERR ' + e.message);
    }
    try { if (page) await page.close(); } catch (e) {}
  }
  await b.close();
})().catch((e) => { console.error('ERR', e && e.message); process.exit(1); });
