/**
 * 抓搜索页列表接口的原始响应，确认商品对象里的多图字段叫什么。
 *
 * 整店页实测 offerImages 是数组（每件 3 张），但关键词搜索页是另一套接口，
 * 字段可能完全不同。采集只取第一张图导致「主图只有一张」，
 * 修之前必须先确认搜索页到底有没有多图、字段名是什么——
 * 不然改了采集也只在整店页生效，搜索页照样一张。
 *
 * 用法：node tools/diag-search-api.js [关键词]
 */
'use strict';
const fs = require('fs');
const { chromium } = require('C:/Users/pc/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

const kw = process.argv[2] || '手机支架';
const OUT = 'dist/_search-api.json';
const url = 'https://s.1688.com/selloffer/offer_search.htm?keywords=' + encodeURIComponent(kw);

(async () => {
  const b = await chromium.connectOverCDP('http://localhost:9222');
  const ctx = b.contexts()[0];
  const page = await ctx.newPage();
  const hits = [];

  await page.route('**/*', async (route) => {
    const u = route.request().url();
    // 只关心带商品列表的 XHR（mtop / search / offer 相关）
    if (!/mtop|search|offer|unifiedRenderData/i.test(u)) return route.continue();
    if (/\.(js|css|png|jpg|gif|webp)(\?|$)/i.test(u)) return route.continue();
    try {
      const res = await route.fetch();
      const body = await res.text();
      if (body.length < 200) return route.continue();
      if (!/imageURI|imageUrl|picUrl|"images"|offerImages|imageInfos/i.test(body)) return route.continue();
      hits.push({ url: u.slice(0, 150), len: body.length, body: body });
    } catch (e) {}
    return route.continue();
  });

  console.log('打开：' + url);
  try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }); }
  catch (e) { console.log('goto: ' + String(e.message).split('\n')[0]); }
  await page.waitForTimeout(9000);

  console.log('\n=== 命中带图片字段的接口 ' + hits.length + ' 个 ===');
  hits.forEach(function (h, i) {
    console.log('\n[' + (i + 1) + '] ' + h.len + 'B  ' + h.url);
    // 统计商品条目里都出现了哪些图片字段名
    const fields = {};
    (h.body.match(/"[a-zA-Z]*[Ii]mages?[A-Za-z]*":/g) || []).forEach(function (k) {
      fields[k] = (fields[k] || 0) + 1;
    });
    console.log('  图片字段名：' + JSON.stringify(fields));
  });

  if (hits.length) {
    fs.writeFileSync(OUT, JSON.stringify(hits, null, 1), 'utf8');
    console.log('\n已存：' + OUT);
  }
  try { await page.close(); } catch (e) {}
  await b.close();
})().catch((e) => { console.error('失败：' + e.message); process.exit(1); });
