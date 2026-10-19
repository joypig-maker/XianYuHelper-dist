/**
 * 京东店铺首页：分段滚动到底，确认商品列表到底会不会加载出来。
 *
 * 用户说整店就是 mall.jd.com/index-<id>.html 且能自己翻页，
 * 但我这边等到 15 秒也只有店铺装修的图片热区。这次一路滚到底，
 * 并在滚动后再查一遍——顺带把可能的「全部商品」入口按钮找出来。
 *
 * 用法：node tools/diag-jd-shop-load.js [店铺首页 URL]
 */
'use strict';
const CDP = require('./cdp');

const HOME = process.argv[2] || 'https://mall.jd.com/index-1000004123.html';

(async () => {
  const b = await CDP.connect(9222);
  const page = await b.open(HOME);

  const r = await page.evaluate(`
    return (async function () {
      var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
      await sleep(8000);

      var out = { 滚动过程: [] };
      var H = document.documentElement.scrollHeight;
      out.初始滚动高度 = H;
      for (var y = 0; y <= H; y += 1200) {
        window.scrollTo(0, y);
        await sleep(1300);
        var n = document.querySelectorAll('[data-sku]').length;
        out.滚动过程.push('y=' + y + ' data-sku=' + n + ' 高度=' + document.documentElement.scrollHeight);
        H = document.documentElement.scrollHeight;
        if (out.滚动过程.length > 14) break;
      }
      await sleep(2500);

      function countItem(sel) {
        var hot = document.getElementById('hotwords');
        var hotzone = document.querySelectorAll('.sh-hot-content a[href*="item.jd.com"]');
        var all = document.querySelectorAll(sel);
        return all.length;
      }
      out.dataSku = document.querySelectorAll('[data-sku]').length;
      out.商品链接总数 = document.querySelectorAll('a[href*="item.jd.com"]').length;
      out.热区链接 = document.querySelectorAll('.sh-hot-content a[href*="item.jd.com"], #hotwords a[href*="item.jd.com"]').length;
      out.扣掉热区 = out.商品链接总数 - out.热区链接;
      out.最终滚动高度 = document.documentElement.scrollHeight;
      out.正文长度 = (document.body.innerText || '').length;
      out.iframe = Array.prototype.slice.call(document.querySelectorAll('iframe'))
        .map(function (f) { return String(f.getAttribute('src') || '').slice(0, 90); });

      // 找可能的「全部商品 / 商品列表」入口
      var ent = [];
      Array.prototype.slice.call(document.querySelectorAll('a,button,li,div,span')).forEach(function (e) {
        var t = String(e.textContent || '').trim().replace(/\\s+/g, '');
        if (t.length > 0 && t.length <= 10 && /全部商品|所有商品|商品列表|全部分类|查看全部|更多商品/.test(t)) {
          var a = e.closest('a') || e;
          ent.push({
            tag: a.tagName, text: t,
            cls: String(a.className || '').slice(0, 40),
            href: String(a.getAttribute('href') || '').slice(0, 80)
          });
        }
      });
      var seen = {}, uniq = [];
      ent.forEach(function (x) { var k = x.text + x.href; if (!seen[k]) { seen[k] = 1; uniq.push(x); } });
      out.入口候选 = uniq.slice(0, 12);

      // 页面上有没有分页器（用户说要自己翻页，说明有）
      var pg = [];
      Array.prototype.slice.call(document.querySelectorAll('a,li,span,button')).forEach(function (e) {
        var t = String(e.textContent || '').trim();
        if (/^(下一页|上一页|末页|首页|\\d{1,3})$/.test(t)) {
          var p = e.closest('a') || e;
          pg.push({ text: t, cls: String(p.className || '').slice(0, 36), href: String(p.getAttribute('href') || '').slice(0, 70) });
        }
      });
      out.分页器 = pg.slice(0, 12);

      return out;
    })();
  `, true);

  console.log('初始滚动高度: ' + r.初始滚动高度 + '  最终: ' + r.最终滚动高度);
  console.log('\n滚动过程:');
  (r.滚动过程 || []).forEach((l) => console.log('  ' + l));
  console.log('\ndata-sku: ' + r.dataSku);
  console.log('商品链接总数: ' + r.商品链接总数 + '  其中热区: ' + r.热区链接 + '  扣掉热区: ' + r.扣掉热区);
  console.log('正文长度: ' + r.正文长度);
  console.log('iframe: ' + JSON.stringify(r.iframe));
  console.log('\n「全部商品」入口候选:');
  (r.入口候选 || []).forEach((x) => console.log('  [' + x.tag + '] 「' + x.text + '」 ' + x.cls + '  → ' + x.href));
  console.log('\n分页器:');
  (r.分页器 || []).forEach((x) => console.log('  「' + x.text + '」 ' + x.cls + '  → ' + x.href));

  await b.close();
})().catch((e) => { console.error('ERR', e && e.message); process.exit(1); });
