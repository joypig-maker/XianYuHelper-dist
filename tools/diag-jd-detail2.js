/**
 * 京东详情页：主图大图 URL 的来源 + 详情描述图。
 *
 * 上一轮已知：
 *   img.image（171x228，父级 .item）  = 主图缩略图，共 10 张
 *   img.zoom-img（1080x1440，.image-zoom-container） = 当前那张的大图
 *   img.specification-item-sku-image（36x48）        = 规格图
 * 待解：主图「大图」的完整列表从哪来（缩略图只有 228px，铺货不能用），
 *       以及详情描述图在哪（可能在懒加载区，要滚动才出来）。
 *
 * 用法：node tools/diag-jd-detail2.js "<详情页URL>"
 */
'use strict';
const CDP = require('./cdp');

const URL_ = process.argv[2] || 'https://item.jd.com/10118613870035.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await CDP.connect(9222);
  const page = await b.open(URL_);
  await sleep(12000);

  // 分段滚动触发懒加载（慢一点，别把页面冲重载）
  const scroll = await page.evaluate(`
    return (async function () {
      var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
      var log = [];
      var H = document.documentElement.scrollHeight;
      for (var y = 0; y <= H; y += 900) {
        window.scrollTo(0, y);
        await sleep(700);
        H = document.documentElement.scrollHeight;
        log.push('y=' + y + ' H=' + H + ' img=' + document.querySelectorAll('img').length);
        if (log.length > 20) break;
      }
      window.scrollTo(0, 0);
      await sleep(800);
      return { log: log, 最终高度: document.documentElement.scrollHeight, 图片数: document.querySelectorAll('img').length };
    })()
  `, true).catch((e) => ({ err: e.message }));
  console.log('滚动: ' + JSON.stringify(scroll));

  const r = await page.evaluate(`
    var out = {};

    // ① 主图区：把 .image-zoom-container / .item 的 HTML 和属性摊开
    var zoomBox = document.querySelector('[class*="image-zoom-container"]');
    out.大图容器 = zoomBox ? zoomBox.tagName + '.' + String(zoomBox.className || '').slice(0, 50) : '(无)';
    var zoomImg = zoomBox ? zoomBox.querySelector('img') : null;
    if (zoomImg) {
      out.大图属性 = {};
      Array.prototype.forEach.call(zoomImg.attributes, function (a) { out.大图属性[a.name] = String(a.value).slice(0, 110); });
    }

    // 主图缩略图那组：找 .item 的共同父级
    var items = Array.prototype.slice.call(document.querySelectorAll('[class*="image-thumb"], [class*="thumb"] [class*="item"], [class*="item"][class*="current"]'));
    out.缩略图item数_粗 = items.length;
    var firstItem = document.querySelector('[class*="current"]') || document.querySelector('[class*="item"]');
    out.首个item标签 = firstItem ? firstItem.tagName + '.' + String(firstItem.className || '').slice(0, 46) : '(无)';
    if (firstItem) out.首个itemHTML = String(firstItem.outerHTML).slice(0, 700);

    // 把所有「171x228 那个尺寸」的图连同祖先 class 列出来，找它们的公共父级
    var thumbs = [];
    Array.prototype.slice.call(document.querySelectorAll('img')).forEach(function (i) {
      var w = i.naturalWidth || i.width || 0;
      if (w === 171 || w === 228) {
        var chain = [];
        var c = i.parentElement;
        for (var k = 0; k < 4 && c; k++) {
          chain.push(c.tagName.toLowerCase() + '.' + String(c.className || '').replace(/\\s+/g, '.').slice(0, 40));
          c = c.parentElement;
        }
        thumbs.push({ src: String(i.getAttribute('src') || '').slice(0, 96), 祖先: chain });
      }
    });
    out.缩略图 = thumbs.slice(0, 12);

    // ② 详情描述图：找长图 / 大尺寸图，且不是主图/评论图
    var desc = [];
    Array.prototype.slice.call(document.querySelectorAll('img')).forEach(function (i) {
      var src = String(i.getAttribute('src') || i.getAttribute('data-lazy-img') || i.getAttribute('data-src') || '');
      var w = i.naturalWidth || i.width || 0;
      var h = i.naturalHeight || i.height || 0;
      var cls = String(i.className || '');
      // 详情图特征：宽 ≥ 600 且很高，或者挂在 detail/desc 容器里
      var inDetail = !!(i.closest('[class*="detail"],[class*="desc"],[id*="detail"],[id*="desc"]'));
      if (src && (inDetail || (w >= 600 && h >= 400))) {
        desc.push({ w: w, h: h, cls: cls.slice(0, 30), inDetail: inDetail, src: src.slice(0, 88) });
      }
    });
    out.详情图候选 = desc.slice(0, 25);

    // ③ 所有 1440 尺寸的图（大图）
    var big = [];
    Array.prototype.slice.call(document.querySelectorAll('img')).forEach(function (i) {
      var src = String(i.getAttribute('src') || '');
      if (src.indexOf('1440') > -1) big.push(src.slice(0, 96));
    });
    out.含1440的图 = big.slice(0, 8);

    // ④ 详情区容器
    out.详情容器候选 = {};
    ['[class*="detail"]','[class*="desc"]','[class*="introduce"]','[class*="param"]','#detail','#J-detail-content','[class*="product-detail"]'].forEach(function (sel) {
      try {
        var els = document.querySelectorAll(sel);
        out.详情容器候选[sel] = els.length;
        if (els.length && els.length < 6) {
          var e = els[0];
          out['样本_' + sel] = { cls: String(e.className || '').slice(0, 50), img: e.querySelectorAll('img').length, text: String(e.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60) };
        }
      } catch (e2) { out.详情容器候选[sel] = 'err'; }
    });

    // ⑤ 店铺入口
    var seen = {}, shops = [];
    Array.prototype.slice.call(document.querySelectorAll('a[href]')).forEach(function (a) {
      var h = String(a.getAttribute('href') || '');
      if (/mall\\.jd\\.com|shop\\.jd\\.com|view_search|\\/\\/[a-z0-9-]+\\.jd\\.com\\//i.test(h) && !seen[h]) {
        seen[h] = 1; shops.push({ href: h.slice(0, 100), text: String(a.textContent || '').trim().slice(0, 22) });
      }
    });
    out.店铺链接 = shops.slice(0, 12);
    out.店铺名候选 = (function () {
      var e = document.querySelector('[class*="shop-name"],[class*="shopName"],[class*="vender"],[class*="store-name"]');
      return e ? String(e.textContent || '').trim().slice(0, 30) : '(无)';
    })();

    return out;
  `, true);

  console.log('\n大图容器: ' + r.大图容器);
  console.log('大图属性: ' + JSON.stringify(r.大图属性));
  console.log('\n缩略图项数(粗): ' + r.缩略图item数_粗);
  console.log('首个 item: ' + r.首个item标签);
  console.log('item HTML: ' + String(r.首个itemHTML || '').slice(0, 500));
  console.log('\n=== 缩略图（171/228 尺寸）===');
  (r.缩略图 || []).forEach((x) => console.log('  ' + x.src.slice(-60) + '\n      祖先: ' + x.祖先.join(' ← ')));
  console.log('\n=== 含 1440 的图 ===');
  (r.含1440的图 || []).forEach((s) => console.log('  ' + s));
  console.log('\n=== 详情容器候选 ===');
  Object.keys(r.详情容器候选 || {}).forEach((k) => console.log('  ' + k.padEnd(26) + r.详情容器候选[k]));
  Object.keys(r).filter((k) => k.indexOf('样本_') === 0).forEach((k) => console.log('  ' + k + ' = ' + JSON.stringify(r[k])));
  console.log('\n=== 详情图候选（前 25） ===');
  (r.详情图候选 || []).forEach((x) => console.log('  ' + (x.w + 'x' + x.h).padEnd(11) + (x.inDetail ? '[详情区]' : '        ') + ' ' + x.src.slice(-52)));
  console.log('\n=== 店铺 ===');
  console.log('  店铺名: ' + r.店铺名候选);
  (r.店铺链接 || []).forEach((s) => console.log('  [' + (s.text || '?') + '] ' + s.href));

  await b.close();
})().catch((e) => { console.error('ERR', e && e.message); process.exit(1); });
