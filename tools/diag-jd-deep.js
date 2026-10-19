/**
 * 京东深度探测：把店铺首页和详情页都等久一点，并检查 iframe。
 *
 * 背景：之前各等 7~10 秒，店铺首页正文只有 1165 字、详情页 2563 字，
 * 都像是 SPA 还没渲染完。这一步确认到底是「加载慢」还是「真没内容」。
 *
 * 用法：node tools/diag-jd-deep.js
 */
'use strict';
const CDP = require('./cdp');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROBE = `
  var out = {};
  out.href = location.href.slice(0, 100);
  out.title = (document.title || '').slice(0, 50);
  out.len = (document.body.innerText || '').length;
  out.dataSku = document.querySelectorAll('[data-sku]').length;
  out.iframe = Array.prototype.slice.call(document.querySelectorAll('iframe')).map(function (f) {
    return String(f.getAttribute('src') || '').slice(0, 80);
  });
  out.scriptSrc = Array.prototype.slice.call(document.querySelectorAll('script[src]'))
    .map(function (s) { return String(s.getAttribute('src') || ''); })
    .filter(function (s) { return /jd\\.com/.test(s); }).slice(0, 10);
  // 所有带 data-* 的元素类型，找商品锚点
  var attrs = {};
  Array.prototype.slice.call(document.querySelectorAll('[data-sku],[data-itemid],[data-id],[data-pid]')).slice(0, 5).forEach(function (e) {
    var o = {}; Array.prototype.forEach.call(e.attributes, function (a) { o[a.name] = String(a.value).slice(0, 24); });
    attrs[e.tagName + '.' + String(e.className || '').slice(0, 40)] = o;
  });
  out.dataAttrs = attrs;
  out.imgCount = document.querySelectorAll('img').length;
  out.sampleImgs = Array.prototype.slice.call(document.querySelectorAll('img')).slice(0, 8)
    .map(function (i) { return String(i.getAttribute('src') || i.getAttribute('data-lazy-img') || '').slice(0, 62); });
  // 所有指向店铺/商品的链接
  var seen = {}, links = [];
  Array.prototype.slice.call(document.querySelectorAll('a[href]')).forEach(function (a) {
    var h = String(a.getAttribute('href') || '');
    if (/mall\\.jd\\.com|view_search|item\\.jd\\.com|shop\\.jd\\.com/.test(h) && !seen[h]) {
      seen[h] = 1; links.push(h.slice(0, 90));
    }
  });
  out.店铺或商品链接 = links.slice(0, 10);
  out.head = (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 150);
  return out;
`;

(async () => {
  const b = await CDP.connect(9222);

  const targets = [
    ['店铺首页 index-1000004123', 'https://mall.jd.com/index-1000004123.html'],
    ['详情页 100275558589', 'https://item.jd.com/100275558589.html']
  ];

  for (const [name, u] of targets) {
    console.log('\n▸ ' + name);
    let p = null;
    try {
      p = await b.open(u);
      await sleep(12000);
      // SPA 往往要滚动才继续加载
      await p.evaluate('window.scrollTo(0, 1500); return 1;', true).catch(() => {});
      await sleep(9000);
      await p.evaluate('window.scrollTo(0, 0); return 1;', true).catch(() => {});
      await sleep(3000);
      const r = await p.evaluate(PROBE, true);
      console.log(JSON.stringify(r, null, 1));
    } catch (e) {
      console.log('  ERR ' + e.message);
    }
    try { if (p) await p.close(); } catch (e) {}
  }

  await b.close();
})().catch((e) => { console.error('ERR', e && e.message); process.exit(1); });
