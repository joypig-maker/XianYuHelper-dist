/**
 * 抓京东店铺页的网络请求，找商品列表到底从哪来。
 *
 * 背景：mall.jd.com/index-<id>.html 的 DOM 里始终只有店铺装修的图片热区，
 * 滚动还会把页面搞重载。与其继续猜渲染时机，不如直接看它请求了什么。
 *
 * 用法：node tools/diag-jd-net.js [页面 URL] [等待秒数]
 */
'use strict';
const CDP = require('./cdp');

const URL = process.argv[2] || 'https://mall.jd.com/index-1000004123.html';
const WAIT = Number(process.argv[3] || 18);

(async () => {
  const b = await CDP.connect(9222);
  const page = await b.open('about:blank');

  const seen = [];
  const seenSet = {};
  page.on('Network.responseReceived', (p) => {
    const r = p.response || {};
    const u = String(r.url || '');
    if (!u || u.indexOf('data:') === 0) return;
    const key = u.split('?')[0] + '?' + (u.split('?')[1] || '').slice(0, 60);
    if (seenSet[key]) { seenSet[key].n++; return; }
    const row = { url: u.slice(0, 150), type: p.type, mime: r.mimeType, size: r.encodedDataLength, n: 1 };
    seenSet[key] = row;
    seen.push(row);
  });

  await page.send('Network.enable');
  await page.send('Page.enable');

  console.log('打开 ' + URL + '，抓 ' + WAIT + ' 秒…');
  await page.send('Page.navigate', { url: URL });
  await new Promise((r) => setTimeout(r, WAIT * 1000));

  const interesting = seen.filter((x) => /api|xhr|json|search|list|goods|product|ware|shop/i.test(x.url + ' ' + (x.type || '')));
  console.log('\n=== 全部请求 ' + seen.length + ' 条，其中可疑 ' + interesting.length + ' 条 ===');
  interesting.slice(0, 40).forEach((x) => {
    console.log('  [' + (x.type || '?') + '] ' + String(x.size || 0).padStart(7) + 'B  ' + x.url);
  });

  console.log('\n=== 按类型统计 ===');
  const byType = {};
  seen.forEach((x) => { byType[x.type || '?'] = (byType[x.type || '?'] || 0) + 1; });
  console.log('  ' + JSON.stringify(byType));

  console.log('\n=== 所有 XHR / Fetch ===');
  seen.filter((x) => /xhr|fetch/i.test(x.type || '')).slice(0, 30)
    .forEach((x) => console.log('  ' + String(x.size || 0).padStart(7) + 'B  ' + x.url));

  console.log('\n=== 含 keyword/goods/list 的 URL（含重复次数）===');
  seen.filter((x) => /keyword=|goods|productList|wareList|\/list/i.test(x.url)).slice(0, 20).forEach((x) => {
    console.log('  ×' + x.n + '  ' + String(x.size || 0).padStart(7) + 'B  ' + x.url);
  });

  await b.close();
})().catch((e) => { console.error('ERR', e && e.message); process.exit(1); });
