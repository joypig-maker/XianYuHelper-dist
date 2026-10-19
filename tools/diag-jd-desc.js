/**
 * 京东详情页：确认「详情描述图」的共同祖先，以及主图选择器的候选。
 *
 * 已知：
 *   主图缩略图 = .image-carousel .item img（228px，URL 里 s228x228_ 可换成 s800x800_）
 *   详情图     = 约 20+ 张 790px 宽的图，落在含 desc 的容器里
 * 待解：详情图到底是哪个容器（[class*="desc"] 命中 24 个）
 *
 * 用法：node tools/diag-jd-desc.js "<详情页URL>"
 */
'use strict';
const CDP = require('./cdp');

const URL_ = process.argv[2] || 'https://item.jd.com/10118613870035.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await CDP.connect(9222);
  const page = await b.open(URL_);
  await sleep(12000);

  // 滚到详情区把懒加载逼出来
  await page.evaluate(`
    return (async function () {
      var s = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
      for (var y = 1800; y < 20000; y += 1400) { window.scrollTo(0, y); await s(500); }
      window.scrollTo(0, 0); await s(600);
      return 1;
    })()
  `, true).catch(() => {});

  const r = await page.evaluate(`
    var out = {};

    // ① 详情图：宽 >= 600 且挂在高容器里、又不是主图轮播里的
    var descImgs = [];
    Array.prototype.slice.call(document.querySelectorAll('img')).forEach(function (i) {
      var src = String(i.getAttribute('src') || i.getAttribute('data-lazy-img') || '');
      var w = i.naturalWidth || i.width || 0;
      var h = i.naturalHeight || i.height || 0;
      if (!src || w < 600) return;
      if (i.closest('[class*="image-carousel"]')) return;      // 主图轮播，排除
      if (/avatar|headimg|logo|icon/i.test(src)) return;
      descImgs.push({ img: i, w: w, h: h, src: src });
    });
    out.详情图数 = descImgs.length;

    if (descImgs.length) {
      // ② 这些图的共同祖先：逐层往上找「包住全部」的最深那层
      var first = descImgs[0].img;
      var chain = [];
      var cur = first.parentElement;
      for (var d = 0; d < 8 && cur; d++) {
        var n = 0;
        descImgs.forEach(function (x) { if (cur.contains(x.img)) n++; });
        chain.push({
          dep: d,
          tag: cur.tagName,
          cls: String(cur.className || '').slice(0, 56),
          id: String(cur.id || '').slice(0, 24),
          含详情图: n,
          总img: cur.querySelectorAll('img').length
        });
        cur = cur.parentElement;
      }
      out.祖先链 = chain;

      // ③ 完整 URL 样例（前 5 张）
      out.详情图样例 = descImgs.slice(0, 5).map(function (x) {
        return x.w + 'x' + x.h + '  ' + x.src;
      });

      // ④ 每张详情图的父级 class（看是否同一个）
      var clsSet = {};
      descImgs.forEach(function (x) {
        var c = x.img.parentElement;
        var k = (c ? c.tagName + '.' + String(c.className || '') : '?').slice(0, 50);
        clsSet[k] = (clsSet[k] || 0) + 1;
      });
      out.详情图父级分布 = clsSet;
    }

    // ⑤ 主图选择器候选：验证哪个能精准命中 10 张缩略图
    out.主图候选 = {};
    [
      '.image-carousel [class*="item"] img',
      '[class*="image-carousel"] [class*="item"] img',
      '[class*="thumbnails"] [class*="item"] img',
      '[class*="image-carousel-track"] img',
      'img.image'
    ].forEach(function (sel) {
      try {
        var els = document.querySelectorAll(sel);
        out.主图候选[sel] = els.length;
      } catch (e) { out.主图候选[sel] = 'err'; }
    });

    // ⑥ 主图缩略图的完整 URL（前 3 张，用来验证尺寸替换）
    var thumbUrls = [];
    Array.prototype.slice.call(document.querySelectorAll('.image-carousel [class*="item"] img, img.image')).slice(0, 3).forEach(function (i) {
      thumbUrls.push(String(i.getAttribute('src') || ''));
    });
    out.主图URL样例 = thumbUrls;

    return out;
  `, true);

  console.log('详情图数: ' + r.详情图数);
  console.log('\n=== 祖先链（含详情图数） ===');
  (r.祖先链 || []).forEach((c) => console.log(
    '  层' + c.dep + ' ' + c.tag + '.' + c.cls + (c.id ? ' #' + c.id : '') +
    '   含详情图 ' + c.含详情图 + ' / 总img ' + c.总img));
  console.log('\n=== 详情图样例 ===');
  (r.详情图样例 || []).forEach((s) => console.log('  ' + s));
  console.log('\n=== 详情图父级分布 ===');
  Object.keys(r.详情图父级分布 || {}).forEach((k) => console.log('  ' + String(r.详情图父级分布[k]).padStart(3) + '  ' + k));
  console.log('\n=== 主图选择器候选 ===');
  Object.keys(r.主图候选 || {}).forEach((k) => console.log('  ' + String(r.主图候选[k]).padStart(4) + '  ' + k));
  console.log('\n=== 主图 URL 样例 ===');
  (r.主图URL样例 || []).forEach((s) => console.log('  ' + s));

  await b.close();
})().catch((e) => { console.error('ERR', e && e.message); process.exit(1); });
