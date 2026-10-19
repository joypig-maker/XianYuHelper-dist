/**
 * dump 京东店铺首页的商品卡片结构 + 找「全部商品」的真实入口。
 *
 * 已知：mall.jd.com/index-<id>.html 里能捞到 //item.jd.com/<sku>.html 链接，
 * 但卡片不用 data-sku 属性；而 view_search-<id>.html 会乱跳到搜索页，
 * 所以「整店」的入口 URL 必须从真实页面上找，不能猜。
 *
 * 用法：node tools/diag-jd-shopcard.js [店铺首页 URL]
 */
'use strict';
const CDP = require('./cdp');

const HOME = process.argv[2] || 'https://mall.jd.com/index-1000004123.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await CDP.connect(9222);
  const page = await b.open(HOME);
  await sleep(14000);

  const r = await page.evaluate(`
    var out = {};
    out.href = location.href.slice(0, 90);
    out.title = (document.title || '').slice(0, 40);
    out.len = (document.body.innerText || '').length;

    // ① 找「全部商品」这类入口：所有含 view_search / 全部商品 / 商品列表 的链接与按钮
    var cands = [];
    Array.prototype.slice.call(document.querySelectorAll('a[href],button')).forEach(function (a) {
      var h = String(a.getAttribute('href') || '');
      var t = String(a.textContent || '').trim().replace(/\\s+/g, '').slice(0, 18);
      if (/view_search|全部商品|所有商品|商品列表|逛逛|\\u5168\\u90e8/.test(h + t)) {
        cands.push({ tag: a.tagName, href: h.slice(0, 90), text: t });
      }
    });
    out.全部商品候选 = cands.slice(0, 10);

    // ② 商品卡片：拿一个 item 链接往上找卡片容器
    var a = document.querySelector('a[href*="item.jd.com"]');
    out.找到商品链接 = a ? String(a.getAttribute('href')).slice(0, 70) : '(无)';
    if (a) {
      var card = a;
      for (var i = 0; i < 6 && card.parentElement; i++) {
        card = card.parentElement;
        if (card.querySelectorAll('a[href*="item.jd.com"]').length > 1) { card = card.parentElement; break; }
      }
      out.卡片容器 = card.tagName + '.' + String(card.className || '').slice(0, 60);
      var tree = [];
      (function walk(el, dep) {
        if (dep > 5 || tree.length > 45) return;
        var cls = String(el.className || '').replace(/\\s+/g, ' ').slice(0, 56);
        var t = el.children.length === 0 ? (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 28) : '';
        tree.push('  '.repeat(dep) + el.tagName.toLowerCase() + (cls ? '.' + cls : '') + (t ? ' 「' + t + '」' : ''));
        Array.prototype.slice.call(el.children).slice(0, 8).forEach(function (c) { walk(c, dep + 1); });
      })(card, 0);
      out.卡片结构 = tree;

      // 同层再找一个卡片，看结构是否一致
      var sib = card.parentElement ? card.parentElement.querySelectorAll(':scope > *') : [];
      out.同层卡片数 = sib.length;
    }

    // ③ 商品链接去重后有多少个（判断一屏能采几件）
    var seen = {}, n = 0;
    Array.prototype.slice.call(document.querySelectorAll('a[href*="item.jd.com"]')).forEach(function (x) {
      var m = String(x.getAttribute('href')).match(/item\\.jd\\.com\\/(\\d+)/);
      if (m && !seen[m[1]]) { seen[m[1]] = 1; n++; }
    });
    out.页面商品数 = n;
    out.商品ID样例 = Object.keys(seen).slice(0, 8);

    out.head = (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 150);
    return out;
  `, true);

  console.log('页面: ' + r.title + '  (' + r.href + ')');
  console.log('正文长度: ' + r.len + '   页面商品数: ' + r.页面商品数);
  console.log('商品 ID 样例: ' + JSON.stringify(r.商品ID样例));
  console.log('\n「全部商品」候选入口:');
  (r.全部商品候选 || []).forEach((c) => console.log('  [' + c.tag + '] ' + (c.text || '(无文本)') + '  →  ' + c.href));
  console.log('\n找到的商品链接: ' + r.找到商品链接);
  console.log('卡片容器: ' + r.卡片容器 + '   同层卡片数: ' + r.同层卡片数);
  console.log('\n=== 卡片结构树 ===');
  (r.卡片结构 || []).forEach((l) => console.log(l));
  console.log('\nhead: ' + r.head);

  await b.close();
})().catch((e) => { console.error('ERR', e && e.message); process.exit(1); });
