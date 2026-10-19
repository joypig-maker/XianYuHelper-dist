/**
 * dump 京东搜索页一张卡片的完整结构树，找字段的精确落点。
 *
 * 已知：卡片是 [data-sku]，类名形如 _xxx_<hash>_<n>（CSS Modules），
 * 所以选择器只能用 [class*=] 前缀匹配，写全名会随版本失效。
 *
 * 用法：node tools/diag-jd-card.js [关键词]
 */
'use strict';
const CDP = require('./cdp');

const KW = process.argv[2] || '手机支架';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await CDP.connect(9222);
  const page = await b.open('https://search.jd.com/Search?keyword=' + encodeURIComponent(KW) + '&enc=utf-8');
  await sleep(9000);

  const r = await page.evaluate(`
    var out = {};
    var cards = Array.prototype.slice.call(document.querySelectorAll('[data-sku]'));
    out.卡片总数 = cards.length;
    out.全页dataSku = document.querySelectorAll('[data-sku]').length;

    var card = cards[0];
    if (!card) return { err: '没有卡片' };

    out.sku = card.getAttribute('data-sku');
    // 外层再往上找一层，京东的卡片常常外面还包着定位容器
    out.父层 = card.parentElement ? card.parentElement.tagName + '.' + String(card.parentElement.className || '').slice(0, 70) : '';

    // 结构树
    function walk(el, dep, maxDep, acc) {
      if (dep > maxDep || acc.length > 70) return;
      var cls = String(el.className || '').replace(/\\s+/g, ' ');
      var txt = '';
      if (el.children.length === 0) txt = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 34);
      acc.push('  '.repeat(dep) + el.tagName.toLowerCase() +
        (cls ? '.' + cls.slice(0, 62) : '') +
        (txt ? '  「' + txt + '」' : ''));
      Array.prototype.slice.call(el.children).slice(0, 12).forEach(function (c) { walk(c, dep + 1, maxDep, acc); });
    }
    var tree = [];
    walk(card, 0, 6, tree);
    out.结构树 = tree;

    // 试几个候选
    function one(sel) {
      try {
        var e = card.querySelector(sel);
        return e ? String(e.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 44) : null;
      } catch (e2) { return 'sel-err'; }
    }
    out.候选 = {
      '价格 _price_': one('[class*="_price_"]'),
      '价格 含¥': one('[class*="price"]'),
      '标题 title_container': one('[class*="title_container"]'),
      '标题 所有a': (function () {
        var as = card.querySelectorAll('a');
        var o = [];
        Array.prototype.forEach.call(as, function (a) {
          o.push({ href: String(a.getAttribute('href') || '').slice(0, 60), text: String(a.textContent || '').trim().slice(0, 30) });
        });
        return o.slice(0, 8);
      })(),
      '所有img': (function () {
        var o = [];
        Array.prototype.forEach.call(card.querySelectorAll('img'), function (i) {
          o.push({ cls: String(i.className || '').slice(0, 30), src: String(i.getAttribute('src') || '').slice(0, 66), lazy: String(i.getAttribute('data-lazy-img') || '').slice(0, 40) });
        });
        return o.slice(0, 6);
      })()
    };
    return out;
  `, true);

  console.log('卡片总数: ' + r.卡片总数 + '   页面 data-sku 数: ' + r.全页dataSku);
  console.log('sku: ' + r.sku + '   父层: ' + r.父层);
  console.log('\n=== 结构树 ===');
  (r.结构树 || []).forEach((l) => console.log(l));
  console.log('\n=== 候选字段 ===');
  console.log(JSON.stringify(r.候选, null, 1));

  await b.close();
})().catch((e) => { console.error('ERR', e && e.message); process.exit(1); });
