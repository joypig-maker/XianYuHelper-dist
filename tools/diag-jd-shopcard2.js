/**
 * 精确定位京东店铺页的商品卡片容器 + 分页机制。
 *
 * 已知店铺首页 mall.jd.com/index-<venderId>.html 的 DOM 里有 230 个
 * item.jd.com 链接，但正文只有 1165 字——卡片疑似图片化/懒渲染。
 * 这一步把祖先链摊开看，找到真正的卡片边界。
 *
 * 用法：node tools/diag-jd-shopcard2.js [店铺首页 URL]
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
    var a = document.querySelector('a[href*="item.jd.com"]');
    if (!a) return { err: '没有 item 链接' };

    // 祖先链：看哪一层开始「包含多个商品」
    out.祖先链 = [];
    var cur = a;
    for (var i = 0; i < 8 && cur; i++) {
      out.祖先链.push({
        层: i,
        tag: cur.tagName,
        cls: String(cur.className || '').slice(0, 66),
        子元素: cur.children ? cur.children.length : 0,
        item链接: cur.querySelectorAll ? cur.querySelectorAll('a[href*="item.jd.com"]').length : 0,
        img: cur.querySelectorAll ? cur.querySelectorAll('img').length : 0,
        文本: String(cur.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 46)
      });
      cur = cur.parentElement;
    }

    out.链接外层HTML = a.parentElement ? String(a.parentElement.outerHTML).slice(0, 700) : '';

    // 商品列表容器：包含 item 链接、且「上面那层」链接数明显变多
    var best = null, node = a;
    for (var j = 0; j < 8 && node; j++) {
      var n = node.querySelectorAll ? node.querySelectorAll('a[href*="item.jd.com"]').length : 0;
      if (n >= 3) { best = node; break; }
      node = node.parentElement;
    }
    if (best) {
      out.列表容器 = best.tagName + '.' + String(best.className || '').slice(0, 60);
      out.列表容器子元素数 = best.children.length;
      var first = best.children[0];
      out.第一个子的结构 = first ? first.tagName + '.' + String(first.className || '').slice(0, 60) : '';
      // 一个子块里的字段
      if (first) {
        out.子块HTML = String(first.outerHTML).slice(0, 500);
        out.子块文本 = String(first.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 90);
        out.子块img = Array.prototype.slice.call(first.querySelectorAll('img')).slice(0, 3)
          .map(function (i) { return String(i.getAttribute('src') || i.getAttribute('data-lazy-img') || '').slice(0, 60); });
        out.子块链接 = Array.prototype.slice.call(first.querySelectorAll('a[href]')).slice(0, 4)
          .map(function (x) { return String(x.getAttribute('href')).slice(0, 60); });
      }
    }

    // 分页 / 加载更多
    var pg = [];
    Array.prototype.slice.call(document.querySelectorAll('a,button,div,span')).slice(0, 4000).forEach(function (e) {
      var t = String(e.textContent || '').trim().replace(/\\s+/g, '');
      if (t && t.length < 8 && /(下一页|加载更多|查看更多|更多商品|全部商品|\\u4e0b\\u4e00\\u9875)/.test(t)) {
        pg.push({ tag: e.tagName, cls: String(e.className || '').slice(0, 40), text: t, href: String(e.getAttribute('href') || '').slice(0, 60) });
      }
    });
    out.分页候选 = pg.slice(0, 10);
    out.滚动高度 = document.documentElement.scrollHeight;
    return out;
  `, true);

  console.log('=== 祖先链 ===');
  (r.祖先链 || []).forEach((x) => console.log(
    '  层' + x.层 + ' ' + x.tag + '.' + x.cls +
    '  子' + x.子元素 + ' item链接' + x.item链接 + ' img' + x.img +
    (x.文本 ? '  「' + x.文本 + '」' : '')));

  console.log('\n链接外层 HTML:');
  console.log('  ' + String(r.链接外层HTML || '').slice(0, 400));

  console.log('\n列表容器: ' + r.列表容器 + '  子元素数: ' + r.列表容器子元素数);
  console.log('第一个子: ' + r.第一个子的结构);
  console.log('子块文本: ' + r.子块文本);
  console.log('子块 img: ' + JSON.stringify(r.子块img));
  console.log('子块链接: ' + JSON.stringify(r.子块链接));
  console.log('\n子块 HTML:');
  console.log('  ' + String(r.子块HTML || '').slice(0, 420));

  console.log('\n分页候选:');
  (r.分页候选 || []).forEach((p) => console.log('  [' + p.tag + '] 「' + p.text + '」 ' + p.cls + '  → ' + p.href));
  console.log('滚动高度: ' + r.滚动高度);

  await b.close();
})().catch((e) => { console.error('ERR', e && e.message); process.exit(1); });
