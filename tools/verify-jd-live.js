/**
 * 真机验证京东搜索页的采集逻辑（不装扩展，直接把 util+sites 注入页面跑）。
 *
 * 校验的是「选择器能不能真命中」——这类东西靠猜必然返工，
 * 淘宝那轮就是先真机验完才写的配置。
 *
 * 用法：node tools/verify-jd-live.js [关键词]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const CDP = require('./cdp');

const ROOT = path.join(__dirname, '..');
const KW = process.argv[2] || '手机支架';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const UTIL = fs.readFileSync(path.join(ROOT, 'src/common/util.js'), 'utf8');
const SITES = fs.readFileSync(path.join(ROOT, 'src/common/sites.js'), 'utf8');

(async () => {
  const b = await CDP.connect(9222);
  const page = await b.open('https://search.jd.com/Search?keyword=' + encodeURIComponent(KW) + '&enc=utf-8');
  await sleep(10000);

  await page.evaluate(UTIL + '\n' + SITES + '\nreturn 1;');

  const r = await page.evaluate(`
    return (function () {
      var U = window.XYUtil, S = window.XYSites;
      var site = S.match(location.host);
      if (!site) return { err: '站点没命中，host=' + location.host };
      if (!U || !U.scanCards) return { err: 'XYUtil 没注入' };

      var cards = U.scanCards(document, site);
      var out = {
        host: location.host,
        site: site.key,
        cardSel命中: (function () { try { return document.querySelectorAll(site.cardSel).length; } catch (e) { return 'err'; } })(),
        采到卡片: cards.length,
        样例: []
      };
      cards.slice(0, 6).forEach(function (c) {
        out.样例.push({
          id: c.itemId,
          title: String(c.title || '').slice(0, 26),
          price: c.price,
          imgs: (c.images || []).length,
          img: String(c.image || '').slice(0, 56),
          shop: String(c.sellerNick || '').slice(0, 20),
          url: String(c.url || '').slice(0, 46)
        });
      });
      // 字段齐全度统计
      var full = { title: 0, price: 0, img: 0, shop: 0 };
      cards.forEach(function (c) {
        if (c.title) full.title++;
        if (c.price) full.price++;
        if (c.image || (c.images || []).length) full.img++;
        if (c.sellerNick) full.shop++;
      });
      out.字段齐全 = full;
      return out;
    })()
  `, true);

  console.log(JSON.stringify(r, null, 1));

  const n = r.采到卡片 || 0;
  const f = r.字段齐全 || {};
  const ok = n > 0 && f.title === n && f.price === n && f.img === n;
  console.log('\n' + (ok ? '✓ 采集正常：' + n + ' 张卡片，标题/价格/图全齐' : '✗ 有问题，逐项对照上面的字段齐全度'));

  await b.close();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('ERR', e && e.message); process.exit(1); });
