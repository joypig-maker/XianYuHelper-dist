/**
 * 京东店铺页结构探测（mall.jd.com）。
 *
 * 京东 PC 搜索页和详情页都强制登录，店铺页不用——所以先把它摸透。
 * 顺便从店铺首页里捞出「全部商品」的真实入口格式。
 *
 * 用法：node tools/diag-jd-shop.js [店铺首页 URL]
 */
'use strict';
const CDP = require('./cdp');

const HOME = process.argv[2] || 'https://mall.jd.com/index-1000004123.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await CDP.connect(9222);

  // ① 店铺首页：找「全部商品」入口
  console.log('▸ 店铺首页 ' + HOME);
  const p1 = await b.open(HOME);
  await sleep(7000);
  const home = await p1.evaluate(`
    var links = Array.prototype.slice.call(document.querySelectorAll('a[href]'))
      .map(function (a) { return String(a.getAttribute('href')); })
      .filter(function (h) { return /view_search|shop\\.jd\\.com|list\\.jd\\.com|\\.jd\\.com\\/\\?/i.test(h); });
    var uniq = [];
    links.forEach(function (h) { if (uniq.indexOf(h) === -1) uniq.push(h); });
    return {
      title: document.title.slice(0, 50),
      href: location.href.slice(0, 90),
      len: (document.body.innerText || '').length,
      含商品的链接: uniq.slice(0, 12),
      全部链接数: links.length,
      head: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 140)
    };
  `, true);
  console.log(JSON.stringify(home, null, 1));
  await p1.close();

  // ② 直接试通用商品列表页格式
  const venderId = (HOME.match(/index-(\d+)/) || [])[1] || '1000004123';
  const tries = [
    'https://mall.jd.com/view_search-' + venderId + '-0-0-1-0-0-0-1.html',
    'https://mall.jd.com/view_search-' + venderId + '.html'
  ];
  for (const u of tries) {
    console.log('\n▸ 试商品列表 ' + u);
    let p2 = null;
    try {
      p2 = await b.open(u);
      await sleep(7000);
      const r = await p2.evaluate(`
        var n = function (s) { try { return document.querySelectorAll(s).length; } catch (e) { return -1; } };
        var out = {
          href: location.href.slice(0, 100),
          title: (document.title || '').slice(0, 46),
          len: (document.body.innerText || '').length,
          login: /passport\\.jd\\.com|欢迎登录/.test(location.href + document.title),
          候选: {
            'li.gl-item': n('li.gl-item'),
            '[data-sku]': n('[data-sku]'),
            '.j-item': n('.j-item'),
            '[class*="goods-item"]': n('[class*="goods-item"]'),
            '[class*="product"]': n('[class*="product"]'),
            'img': n('img')
          }
        };
        var c = document.querySelector('[data-sku]') || document.querySelector('li.gl-item');
        if (c) {
          out.卡片样例 = {
            tag: c.tagName + '.' + String(c.className || '').slice(0, 50),
            attrs: (function () {
              var o = {}; Array.prototype.forEach.call(c.attributes, function (a) { o[a.name] = String(a.value).slice(0, 30); }); return o;
            })(),
            text: (c.innerText || '').replace(/\\s+/g, ' ').slice(0, 120)
          };
        }
        return out;
      `, true);
      console.log(JSON.stringify(r, null, 1));
    } catch (e) {
      console.log('  ERR ' + e.message);
    }
    try { if (p2) await p2.close(); } catch (e) {}
  }

  await b.close();
})().catch((e) => { console.error('ERR', e && e.message); process.exit(1); });
