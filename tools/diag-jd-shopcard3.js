/**
 * 定位京东店铺页真正的商品卡片区。
 *
 * 上一轮的坑：第一个 a[href*=item.jd.com] 恰好落在 #hotwords（底部热词）里，
 * 于是把「祖先链」和「列表容器」全带偏了。这次先把热词区排除掉再找。
 *
 * 用法：node tools/diag-jd-shopcard3.js [店铺首页 URL]
 */
'use strict';
const CDP = require('./cdp');

const HOME = process.argv[2] || 'https://mall.jd.com/index-1000004123.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await CDP.connect(9222);
  const page = await b.open(HOME);
  await sleep(15000);

  const r = await page.evaluate(`
    var out = {};
    var all = Array.prototype.slice.call(document.querySelectorAll('a[href*="item.jd.com"]'));
    var links = all.filter(function (a) { return !a.closest('#hotwords'); });
    out.总链接 = all.length;
    out.排除热词后 = links.length;
    if (!links.length) return out;

    var a = links[0];
    out.首个链接 = String(a.getAttribute('href')).slice(0, 70);
    out.首个链接文本 = String(a.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 50);

    // 祖先链（这次是干净的）
    out.祖先链 = [];
    var cur = a;
    for (var i = 0; i < 9 && cur; i++) {
      out.祖先链.push({
        层: i, tag: cur.tagName,
        cls: String(cur.className || '').slice(0, 60),
        子: cur.children ? cur.children.length : 0,
        item链接: cur.querySelectorAll ? cur.querySelectorAll('a[href*="item.jd.com"]').length : 0,
        img: cur.querySelectorAll ? cur.querySelectorAll('img').length : 0,
        文本: String(cur.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40)
      });
      cur = cur.parentElement;
    }

    // 卡片：a 往上找到第一个「有图片或有价格文本」的块
    var card = a;
    for (var j = 0; j < 6 && card.parentElement; j++) {
      card = card.parentElement;
      if (card.querySelector('img') && card.querySelectorAll('a[href*="item.jd.com"]').length <= 3) break;
    }
    out.卡片 = card.tagName + '.' + String(card.className || '').slice(0, 56);
    out.卡片HTML = String(card.outerHTML).slice(0, 900);
    out.卡片文本 = String(card.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 110);
    out.卡片图 = Array.prototype.slice.call(card.querySelectorAll('img')).slice(0, 3)
      .map(function (i) {
        return String(i.getAttribute('src') || i.getAttribute('data-lazy-img') || i.getAttribute('data-src') || '').slice(0, 66);
      });
    out.卡片里的a = Array.prototype.slice.call(card.querySelectorAll('a[href]')).slice(0, 4)
      .map(function (x) { return { href: String(x.getAttribute('href')).slice(0, 56), text: String(x.textContent || '').trim().slice(0, 22) }; });

    // 列表容器：含 item 链接最多、且最靠内的那层
    var best = null, bestN = 0;
    Array.prototype.slice.call(document.querySelectorAll('div,ul,section')).forEach(function (el) {
      if (el.closest('#hotwords')) return;
      var n = el.querySelectorAll('a[href*="item.jd.com"]').length;
      if (n > bestN && n > 5) { bestN = n; best = el; }
    });
    out.列表容器 = best ? best.tagName + '.' + String(best.className || '').slice(0, 56) : '(没找到)';
    out.列表容器商品数 = bestN;
    out.列表容器子元素数 = best ? best.children.length : 0;

    out.滚动高度 = document.documentElement.scrollHeight;
    return out;
  `, true);

  console.log('总 item 链接: ' + r.总链接 + '   排除热词后: ' + r.排除热词后);
  console.log('首个: ' + r.首个链接 + '  「' + r.首个链接文本 + '」');
  console.log('\n=== 祖先链 ===');
  (r.祖先链 || []).forEach((x) => console.log(
    '  层' + x.层 + ' ' + x.tag + '.' + x.cls + '  子' + x.子 + ' item' + x.item链接 + ' img' + x.img +
    (x.文本 ? '  「' + x.文本 + '」' : '')));
  console.log('\n列表容器: ' + r.列表容器 + '  商品数 ' + r.列表容器商品数 + '  子元素 ' + r.列表容器子元素数);
  console.log('卡片: ' + r.卡片);
  console.log('卡片文本: ' + r.卡片文本);
  console.log('卡片图: ' + JSON.stringify(r.卡片图));
  console.log('卡片里的 a: ' + JSON.stringify(r.卡片里的a));
  console.log('\n卡片 HTML:');
  console.log('  ' + String(r.卡片HTML || '').slice(0, 700));
  console.log('\n滚动高度: ' + r.滚动高度);

  await b.close();
})().catch((e) => { console.error('ERR', e && e.message); process.exit(1); });
