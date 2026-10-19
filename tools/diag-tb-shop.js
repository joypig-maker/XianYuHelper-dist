/**
 * 淘宝店铺（整店）页探路
 *
 * 从搜索结果里动态取一个真实店铺链接再进去——比手写 URL 可靠，
 * 淘宝的店铺域名/参数形态换过好几轮（旧版 search.htm、新版 store.taobao.com）。
 * 目标是回答两件事：商品列表走 DOM 还是接口；卡片的字段锚点在哪。
 */
'use strict';

const CDP = require('./cdp');

(async () => {
  const b = await CDP.connect(9222);
  const { targetId } = await b.createTarget('about:blank');
  const page = await b.attachTarget({ id: targetId });

  // 1) 先从搜索页拿一个真实店铺链接
  await page.goto('https://s.taobao.com/search?q=' + encodeURIComponent('手机支架'), 40000);
  await new Promise((r) => setTimeout(r, 4000));
  const shopLinks = await page.evaluate(`return (function(){
    var out = [];
    document.querySelectorAll('[class*="doubleCardWrapper"]').forEach(function(el){
      if (out.length >= 6) return;
      var a = el.querySelector('a[href*="category.htm"],a[href*="search.htm"],a[href*="view_shop"]');
      if (!a) return;
      var name = el.querySelector('[class*="shopNameText"]');
      out.push({ href: a.getAttribute('href'), name: name ? name.innerText.trim() : '' });
    });
    return out;
  })()`);
  console.log('=== 搜索页里拿到的店铺链接 ===');
  shopLinks.forEach((s, i) => console.log('  [' + i + '] ' + s.name + '  ' + String(s.href).slice(0, 110)));

  let target = shopLinks.find((s) => /category\.htm|search\.htm/.test(s.href || ''));
  if (!target) { console.log('没拿到店铺链接，退出'); await b.close(); return; }
  let url = target.href;
  if (url.indexOf('//') === 0) url = 'https:' + url;

  console.log('\n=== 进入店铺页: ' + url.slice(0, 120) + ' ===');
  const reqs = [];
  await page.send('Network.enable');
  page.on('Network.requestWillBeSent', (p) => {
    const u = p.request && p.request.url;
    if (!u || !/^https?:/.test(u)) return;
    if (/\.(png|jpg|jpeg|gif|webp|css|woff2?|ttf|svg)(\?|$)/i.test(u)) return;
    reqs.push({ url: u, type: p.type });
  });

  await page.goto(url, 40000);
  await new Promise((r) => setTimeout(r, 6000));
  console.log('title:', await page.evaluate('return document.title'));
  console.log('落地 url:', await page.evaluate('return location.href').then((u) => String(u).slice(0, 150)));

  const shape = await page.evaluate(`return (function(){
    var sels = ['[class*="doubleCard"]','[class*="item"]','[class*="Item"]','[class*="card"]',
                '[class*="offer"]','[class*="product"]','a[href*="item.taobao.com"]',
                'a[href*="detail.tmall.com"]','[class*="pagination"]','[class*="Pagination"]'];
    var out = {};
    sels.forEach(function(s){ try { out[s] = document.querySelectorAll(s).length; } catch(e){ out[s]='err'; } });
    out.__bodyLen = (document.body ? document.body.innerText.length : 0);
    out.__head = (document.body ? document.body.innerText.slice(0, 220).replace(/\\s+/g,' ') : '');
    return out;
  })()`);
  console.log('\n=== 选择器命中 ===');
  console.log(JSON.stringify(shape, null, 1));

  console.log('\n=== 与商品列表相关的请求 ===');
  const hit = reqs.filter((r) => /list|item|goods|offer|search|mtop|page|product/i.test(r.url));
  const uniq = [...new Set(hit.map((r) => r.url.split('?')[0]))];
  uniq.slice(0, 25).forEach((u) => console.log('  ' + u.slice(0, 150)));
  console.log('  … 共 ' + uniq.length + ' 个去重后的地址');

  await page.close();
  await b.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
