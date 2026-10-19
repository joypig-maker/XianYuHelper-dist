/**
 * 抓店铺商品接口的请求参数与响应结构
 *
 * 已定位接口：mtop.taobao.shop.simple.fetch（h5api.m.tmall.com）。
 * 比解析 DOM 可靠得多——接口返回的是结构化数据，主图/价格/库存都在里面。
 * 这里要把请求的 data 参数和响应的字段形态都原样落盘，作为实现的依据。
 */
'use strict';

const fs = require('fs');
const CDP = require('./cdp');

const OUT_DIR = 'dist/_dts';
const SHOP = process.argv[2] ||
  'https://store.taobao.com/category.htm?appUid=RAzN8HWWdpXvAyr5aFn9AW6CRJeE2zyKNHUvQgfA3sEf2ADE1ub';

(async () => {
  const b = await CDP.connect(9222);
  const { targetId } = await b.createTarget('about:blank');
  const page = await b.attachTarget({ id: targetId });

  const captured = [];
  await page.send('Network.enable');
  page.on('Network.responseReceived', (p) => {
    const u = (p.response && p.response.url) || '';
    if (!/shop\.simple|shop\.|item\.fetch/.test(u)) return;
    captured.push({ requestId: p.requestId, url: u, status: p.response.status });
  });
  // 顺便抓请求体
  const posts = {};
  page.on('Network.requestWillBeSent', (p) => {
    const u = (p.request && p.request.url) || '';
    if (/shop\.simple/.test(u)) posts[p.requestId] = p.request.postData || '';
  });

  await page.goto(SHOP, 45000);
  await new Promise((r) => setTimeout(r, 8000));

  // 滚到商品区，把懒加载逼出来
  await page.evaluate(`window.scrollTo(0, 1200); return 1;`);
  await new Promise((r) => setTimeout(r, 5000));
  await page.evaluate(`window.scrollBy(0, 2000); return 1;`);
  await new Promise((r) => setTimeout(r, 5000));

  console.log('=== 命中接口 ' + captured.length + ' 个 ===');
  for (const c of captured) {
    console.log('\n--- ' + c.status + '  ' + c.url.slice(0, 190));
    console.log('    query:', c.url.split('?')[1] ? decodeURIComponent(c.url.split('?')[1]).slice(0, 400) : '(无)');
    console.log('    post :', (posts[c.requestId] || '(无)').slice(0, 400));
    try {
      const body = await page.send('Network.getResponseBody', { requestId: c.requestId });
      const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
      const name = 'shop-fetch-' + Date.now() + '.txt';
      fs.writeFileSync(OUT_DIR + '/' + name, text);
      console.log('    响应已存 ' + OUT_DIR + '/' + name + '  (' + text.length + ' 字节)');
      console.log('    响应前 500:', text.slice(0, 500).replace(/\s+/g, ' '));
    } catch (e) {
      console.log('    取响应失败:', e.message);
    }
  }

  // 页面商品渲染情况
  const shape = await page.evaluate(`return (function(){
    var t = document.body ? document.body.innerText : '';
    var links = document.querySelectorAll('a[href*="item.taobao.com"],a[href*="detail.tmall.com"]');
    return {
      bodyLen: t.length,
      商品链接数: links.length,
      首个链接: links[0] ? String(links[0].getAttribute('href')).slice(0, 120) : '',
      Item类命中: document.querySelectorAll('[class*="Item"]').length,
      尾部文本: t.slice(-260).replace(/\\s+/g, ' ')
    };
  })()`);
  console.log('\n=== 店铺页渲染情况 ===');
  console.log(JSON.stringify(shape, null, 1));

  await page.close();
  await b.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
