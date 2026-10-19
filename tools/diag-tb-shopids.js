/**
 * 店铺页：shopId / sellerId 的来源定位
 *
 * 要主动把全店 140 件拉完（而不是等用户手动翻页），就得知道 shopId 和 sellerId。
 * 页面 URL 里没有，所以得从 SSR 数据或接口响应里挖。
 * 一并确认：页面自己会不会自动请求商品列表，还是需要滚动/点击。
 */
'use strict';

const fs = require('fs');
const CDP = require('./cdp');

const SHOP = process.argv[2] ||
  'https://store.taobao.com/category.htm?appUid=RAzN8HWWdpXvAyr5aFn9AW6CRJeE2zyKNHUvQgfA3sEf2ADE1ub';

(async () => {
  const b = await CDP.connect(9222);
  const { targetId } = await b.createTarget('about:blank');
  const page = await b.attachTarget({ id: targetId });

  const itemFetches = [];
  await page.send('Network.enable');
  page.on('Network.requestWillBeSent', (p) => {
    const u = (p.request && p.request.url) || '';
    if (/shop\.simple\.item\.fetch/.test(u)) {
      const d = decodeURIComponent((u.split('data=')[1] || '').split('&')[0] || '');
      itemFetches.push({ url: u.slice(0, 120), data: d.slice(0, 320) });
    }
  });

  await page.goto(SHOP, 45000);
  await new Promise((r) => setTimeout(r, 7000));

  console.log('=== 页面主动请求商品列表的情况 ===');
  console.log('  次数:', itemFetches.length);
  itemFetches.forEach((f, i) => console.log('  [' + i + '] data=' + f.data));
  if (!itemFetches.length) console.log('  → 页面没有自动拉商品列表，需要滚动或点击才触发');

  // 找 shopId / sellerId 的全局来源
  const ids = await page.evaluate(`return (function(){
    var out = { globals: [], found: {} };
    // 常见 SSR 挂载点
    var names = ['__INITIAL_STATE__','__INITIAL_DATA__','__NUXT__','g_config','__shop__','shopData','__DATA__'];
    names.forEach(function(n){
      if (window[n]) {
        out.globals.push(n);
        try {
          var s = JSON.stringify(window[n]).slice(0, 300);
          if (/shopId|sellerId/.test(s)) out.found[n] = s;
        } catch(e) {}
      }
    });
    // 从整页 HTML 里正则抓
    var html = document.documentElement.outerHTML;
    var m1 = html.match(/"shopId"\\s*:\\s*"?([0-9A-Za-z]+)"?/);
    var m2 = html.match(/"sellerId"\\s*:\\s*"?([0-9A-Za-z]+)"?/);
    var m3 = html.match(/shopId=([0-9A-Za-z]+)/);
    return {
      globals: out.globals,
      shopIdFromHtml: m1 ? m1[1] : '',
      sellerIdFromHtml: m2 ? m2[1] : '',
      shopIdFromUrl: m3 ? m3[1] : '',
      sample: out.found,
      url: location.href.slice(0, 140)
    };
  })()`);
  console.log('\n=== shopId / sellerId 来源 ===');
  console.log(JSON.stringify(ids, null, 1));

  // 滚一下看会不会触发出商品列表
  await page.evaluate(`window.scrollTo(0, 1500); return 1;`);
  await new Promise((r) => setTimeout(r, 5000));
  await page.evaluate(`window.scrollBy(0, 2500); return 1;`);
  await new Promise((r) => setTimeout(r, 5000));
  console.log('\n=== 滚动后 ===');
  console.log('  商品列表请求累计:', itemFetches.length);
  itemFetches.slice(-3).forEach((f, i) => console.log('    ' + f.data.slice(0, 200)));
  const domAfter = await page.evaluate(`return (function(){
    return {
      商品链接数: document.querySelectorAll('a[href*="item.taobao.com"],a[href*="detail.tmall.com"]').length,
      doubleCard: document.querySelectorAll('[class*="doubleCard"]').length,
      文本长度: (document.body?document.body.innerText:'').length
    };
  })()`);
  console.log('  DOM:', JSON.stringify(domAfter));

  await page.close();
  await b.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
