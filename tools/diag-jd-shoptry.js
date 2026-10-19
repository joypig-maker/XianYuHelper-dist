/**
 * 快速试京东店铺「全部商品」的几种 URL 格式，看哪个真能出商品。
 * 猜格式不如一次批量试——但结论仍然以实测为准，试完不留猜测。
 *
 * 用法：node tools/diag-jd-shoptry.js [venderId]
 */
'use strict';
const CDP = require('./cdp');

const V = process.argv[2] || '1000004123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const URLS = [
  ['view_search 8段', 'https://mall.jd.com/view_search-' + V + '-0-0-1-0-0-0-1.html'],
  ['view_search 6段', 'https://mall.jd.com/view_search-' + V + '-1-0-0-0-0.html'],
  ['view_search 4段', 'https://mall.jd.com/view_search-' + V + '-0-0-1.html'],
  ['shop 路径式', 'https://mall.jd.com/shop/' + V + '/index.html'],
  ['品牌域名', 'https://m.' + V + '.jd.com/'],
  ['index + tab', 'https://mall.jd.com/index-' + V + '.html?tab=all']
];

(async () => {
  const b = await CDP.connect(9222);
  for (const [name, u] of URLS) {
    let p = null;
    try {
      p = await b.open(u);
      await sleep(8000);
      const r = await p.evaluate(`
        var skus = document.querySelectorAll('[data-sku]').length;
        // 只在「商品卡片区」里数，避开底部热词导航
        var hot = document.getElementById('hotwords');
        var hotN = hot ? hot.querySelectorAll('a[href*="item.jd.com"]').length : 0;
        var all = document.querySelectorAll('a[href*="item.jd.com"]').length;
        return {
          href: location.href.slice(0, 96),
          title: (document.title || '').slice(0, 34),
          len: (document.body.innerText || '').length,
          dataSku: skus,
          itemLinks: all,
          热词区链接: hotN,
          扣掉热词: all - hotN,
          是404: /不存在|error\\.aspx/.test(location.href + document.title)
        };
      `, true);
      console.log('▸ ' + name.padEnd(16) + ' ' + JSON.stringify(r));
    } catch (e) {
      console.log('▸ ' + name.padEnd(16) + ' ERR ' + e.message);
    }
    try { if (p) await p.close(); } catch (e) {}
  }
  await b.close();
})().catch((e) => { console.error('ERR', e && e.message); process.exit(1); });
