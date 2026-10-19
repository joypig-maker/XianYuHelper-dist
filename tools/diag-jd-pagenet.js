/**
 * 全量抓「点下一页」瞬间的网络请求 —— 找出商品列表到底从哪来。
 *
 * 上一轮已知：
 *   · 点 .fp-next 后页码 1→2、首件确实换了
 *   · 但 XHR/fetch 里没有列表请求，只有比色/埋点
 * 所以要放开过滤，看全部请求（含 <script> JSONP、表单提交、整页导航）。
 *
 * 用法：node tools/diag-jd-pagenet.js <view_search url>
 */
'use strict';
const CDP = require('./cdp');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const url = process.argv[2];
  if (!url) { console.error('用法: node tools/diag-jd-pagenet.js <url>'); process.exit(1); }

  const b = await CDP.connect(9222);
  const page = await b.open('about:blank');

  let phase = 'load';
  const all = [];
  page.on('Network.requestWillBeSent', (p) => {
    const u = (p && p.request && p.request.url) || '';
    all.push({
      phase: phase,
      method: (p.request && p.request.method) || 'GET',
      type: (p && p.type) || '',
      url: u
    });
  });
  page.on('Page.frameNavigated', (p) => {
    all.push({ phase: 'NAV-' + phase, method: '-', type: 'nav', url: (p.frame && p.frame.url) || '' });
  });
  await page.send('Network.enable');
  await page.send('Page.enable');

  await page.goto(url, 40000);
  await sleep(7000);

  const before = await page.evaluate(`
    return {
      页码: (function () { var b = document.querySelector('.g-pager .fp-text b'); return b ? b.innerText : '?'; })(),
      首件: (function () {
        var a = document.querySelector('.gl-item a[href*="item.jd.com"]');
        return a ? a.getAttribute('href').slice(0, 64) : '(无)';
      })(),
      HTML长度: document.documentElement.innerHTML.length,
      item链接数: document.querySelectorAll('a[href*="item.jd.com"]').length
    };
  `, true);
  console.log('点击前: 页=' + before.页码 + ' 首件=' + before.首件 +
    ' HTML=' + before.HTML长度 + '字 item链接=' + before.item链接数);

  phase = 'click';
  await page.evaluate(`
    var a = document.querySelector('.g-pager .fp-next');
    if (a) a.click();
    return 1;
  `, true);
  await sleep(8000);

  const after = await page.evaluate(`
    return {
      页码: (function () { var b = document.querySelector('.g-pager .fp-text b'); return b ? b.innerText : '?'; })(),
      首件: (function () {
        var a = document.querySelector('.gl-item a[href*="item.jd.com"]');
        return a ? a.getAttribute('href').slice(0, 64) : '(无)';
      })(),
      HTML长度: document.documentElement.innerHTML.length,
      item链接数: document.querySelectorAll('a[href*="item.jd.com"]').length,
      href: location.href.slice(0, 140),
      首件标题: (function () {
        var d = document.querySelector('.gl-item .jDesc a');
        return d ? (d.innerText || '').trim().slice(0, 40) : '(无)';
      })()
    };
  `, true);
  console.log('点击后: 页=' + after.页码 + ' 首件=' + after.首件 +
    ' HTML=' + after.HTML长度 + '字 item链接=' + after.item链接数);
  console.log('        URL=' + after.href);
  console.log('        标题=' + after.首件标题);

  const clk = all.filter((x) => x.phase === 'click' || x.phase === 'NAV-click');
  const uniq = [];
  const seen = new Set();
  clk.forEach((x) => {
    const k = x.method + ' ' + x.url;
    if (seen.has(k)) return;
    seen.add(k);
    uniq.push(x);
  });
  console.log('\n点击阶段的请求 (' + uniq.length + ' 条去重):');
  uniq.slice(0, 40).forEach((x) => {
    const u = x.url.length > 165 ? x.url.slice(0, 165) + '…' : x.url;
    console.log('   [' + x.type + '] ' + x.method + ' ' + u);
  });

  console.log('\n首屏请求里含 page/list/goods 的:');
  all.filter((x) => x.phase === 'load' && /page|list|goods|search/i.test(x.url) &&
    !/\.(js|css|png|jpe?g|webp|gif|svg|woff2?|ico)(\?|$)/i.test(x.url))
    .slice(0, 15).forEach((x) => console.log('   ' + x.url.slice(0, 160)));

  try { await page.close(); } catch (e) {}
  await b.close();
})().catch((e) => { console.error('ERR', e && e.message); process.exit(1); });
