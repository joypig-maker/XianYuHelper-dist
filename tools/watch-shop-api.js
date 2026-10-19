/**
 * 拦截店铺页的商品渲染接口，把原始响应落盘。
 *
 * 1688 的店铺页初始 DOM 里没有商品（只有一堆 DIV 包 IMG），
 * 商品列表是从 wp.m.1688.com/pc/render/unifiedRenderData 异步拉回来的。
 * 想知道真实字段只能拦这个请求。
 *
 *   node tools/watch-shop-api.js <店铺URL> [输出文件]
 */
'use strict';
const fs = require('fs');
const { chromium } = require('C:/Users/pc/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

const url = process.argv[2] || 'https://shop3g5365975f5y2.1688.com/';
const out = process.argv[3] || 'dist/shop-api-sample.json';

(async () => {
  const b = await chromium.connectOverCDP('http://localhost:9222');
  const ctx = b.contexts()[0];
  const page = await ctx.newPage();
  const hits = [];

  page.on('response', async (r) => {
    const u = r.url();
    if (!/unifiedRenderData|sellerMemberId|offerList|offer_search|getShopItem/i.test(u)) return;
    try {
      const body = await r.text();
      hits.push({ url: u.slice(0, 220), status: r.status(), len: body.length, body: body });
      console.log('捕获', r.status(), body.length, 'B');
    } catch (e) {
      console.log('读取失败', e.message.split('\n')[0]);
    }
  });

  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }).catch((e) => console.log('goto:', e.message.split('\n')[0]));
  await page.waitForTimeout(4000);
  // 滚到底触发懒加载
  await page.evaluate('window.scrollTo(0, document.body.scrollHeight)').catch(() => {});
  await page.waitForTimeout(3000);

  if (hits.length) {
    fs.writeFileSync(out, JSON.stringify(hits, null, 2), 'utf8');
    console.log('已保存', hits.length, '条到', out);
    console.log('第一个响应摘要:');
    console.log(hits[0].body.replace(/\s+/g, ' ').slice(0, 400));
  } else {
    console.log('本次没有捕获到商品渲染接口。');
  }
  await page.close();
  await b.close();
})().catch((e) => { console.error('ERR', e.message.split('\n')[0]); process.exit(1); });
