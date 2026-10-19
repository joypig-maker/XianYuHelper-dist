/**
 * 深挖京东详情页结构（用用户实际在用的那个 URL）。
 *
 * 目标：
 *   ① 主图在哪（几张、怎么挂的）
 *   ② 详情描述图在哪
 *   ③ 店铺入口（为后面的「整店」铺路）
 *   ④ SKU 规格
 *
 * 之前用另一个 SKU 探过，.sku-name / .p-price / #spec-list 这些经典选择器
 * 全部失效（新版 SPA），所以这次直接摊开结构看。
 *
 * 用法：node tools/diag-jd-userdetail.js "<详情页URL>"
 */
'use strict';
const CDP = require('./cdp');

const URL_ = process.argv[2] || 'https://item.jd.com/10118613870035.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await CDP.connect(9222);
  console.log('打开: ' + URL_.slice(0, 90));
  const page = await b.open(URL_);
  await sleep(14000);

  const r = await page.evaluate(`
    var out = {};
    out.href = location.href.slice(0, 90);
    out.title = (document.title || '').slice(0, 70);
    out.len = (document.body.innerText || '').length;
    out.scrollH = document.documentElement.scrollHeight;

    // ① 所有图片，带尺寸和父级 class —— 主图通常是一组同尺寸的小图
    var imgs = Array.prototype.slice.call(document.querySelectorAll('img'));
    out.图片总数 = imgs.length;
    out.图片清单 = imgs.slice(0, 40).map(function (i, idx) {
      var p = i.parentElement;
      return {
        i: idx,
        w: i.naturalWidth || i.width || 0,
        h: i.naturalHeight || i.height || 0,
        cls: String(i.className || '').slice(0, 34),
        parentCls: p ? String(p.className || '').slice(0, 40) : '',
        src: String(i.getAttribute('src') || i.getAttribute('data-lazy-img') || i.getAttribute('data-src') || '').slice(0, 78)
      };
    });

    // ② 结构树（挑前几个有 class 的容器）
    var tree = [];
    (function walk(el, dep) {
      if (dep > 4 || tree.length > 55) return;
      var cls = String(el.className || '').replace(/\\s+/g, ' ').slice(0, 52);
      if (cls || el.tagName === 'IMG') {
        var t = el.children.length === 0 ? String(el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 22) : '';
        tree.push('  '.repeat(dep) + el.tagName.toLowerCase() + (cls ? '.' + cls : '') + (t ? ' 「' + t + '」' : ''));
      }
      Array.prototype.slice.call(el.children).slice(0, 10).forEach(function (c) { walk(c, dep + 1); });
    })(document.body, 0);
    out.结构树 = tree;

    // ③ 店铺入口
    var seen = {}, shops = [];
    Array.prototype.slice.call(document.querySelectorAll('a[href]')).forEach(function (a) {
      var h = String(a.getAttribute('href') || '');
      if (/mall\\.jd\\.com|shop\\.jd\\.com|view_search|\\/\\/[a-z0-9-]+\\.jd\\.com\\//i.test(h) && !seen[h]) {
        seen[h] = 1;
        shops.push({ href: h.slice(0, 90), text: String(a.textContent || '').trim().slice(0, 20) });
      }
    });
    out.店铺链接 = shops.slice(0, 10);

    // ④ SKU / 规格 / 参数区
    out.候选 = {};
    ['[class*="spec"]', '[class*="sku"]', '[class*="thumb"]', '[class*="gallery"]',
     '[class*="preview"]', '[class*="detail"]', '[class*="desc"]', '[class*="param"]',
     '[class*="shop"]', '[class*="name"]', '[class*="price"]', '[class*="title"]'].forEach(function (sel) {
      try { out.候选[sel] = document.querySelectorAll(sel).length; } catch (e) { out.候选[sel] = 'err'; }
    });

    // ⑤ data-* 属性里有没有 sku
    var attrs = {};
    Array.prototype.slice.call(document.querySelectorAll('[data-sku],[data-skuid],[data-item],[data-pid]')).slice(0, 4).forEach(function (e) {
      var o = {}; Array.prototype.forEach.call(e.attributes, function (a) { o[a.name] = String(a.value).slice(0, 26); });
      attrs[e.tagName + '.' + String(e.className || '').slice(0, 36)] = o;
    });
    out.dataAttrs = attrs;

    return out;
  `, true);

  console.log('标题: ' + r.title);
  console.log('正文长度: ' + r.len + '   滚动高度: ' + r.scrollH + '   图片数: ' + r.图片总数);
  console.log('\n=== 结构树 ===');
  (r.结构树 || []).forEach((l) => console.log(l));
  console.log('\n=== 图片清单（前 40） ===');
  (r.图片清单 || []).forEach((x) => console.log(
    '  [' + x.i + '] ' + (x.w + 'x' + x.h).padEnd(11) + (x.cls || '(无class)').padEnd(24) +
    (x.parentCls ? '↑' + x.parentCls.padEnd(22) : ' '.repeat(24)) + ' ' + x.src.slice(-46)));
  console.log('\n=== 候选选择器命中数 ===');
  Object.keys(r.候选 || {}).forEach((k) => console.log('  ' + k.padEnd(22) + r.候选[k]));
  console.log('\n=== 店铺链接 ===');
  (r.店铺链接 || []).forEach((s) => console.log('  [' + (s.text || '?') + '] ' + s.href));
  console.log('\n=== data 属性 ===');
  Object.keys(r.dataAttrs || {}).forEach((k) => console.log('  ' + k + '  ' + JSON.stringify(r.dataAttrs[k])));

  await b.close();
})().catch((e) => { console.error('ERR', e && e.message); process.exit(1); });
