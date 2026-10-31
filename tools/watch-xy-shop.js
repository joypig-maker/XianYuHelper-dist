/**
 * 闲鱼店铺页：抓所有 mtop 接口的原始响应，找「想要人数」到底在哪个字段里。
 *
 * 背景：集市/奥莱商品的卡片上，想要人数被「行情价 xx 元」顶掉了，
 * 卡片 DOM 里读不到。逐个进详情页补又太慢（1000 个商品的店铺）。
 * 所以要看**列表接口自己**有没有带这个字段。
 *
 *   node tools/watch-xy-shop.js <店铺URL> [输出文件]
 */
'use strict';
const fs = require('fs');
const { chromium } = require('C:/Users/pc/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

const url = process.argv[2]
  || 'https://www.goofish.com/personal?userId=2208526863302';
const out = process.argv[3] || 'dist/xy-shop-api.json';

(async () => {
  const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = b.contexts()[0];
  const page = await ctx.newPage();
  const hits = [];

  page.on('response', async (r) => {
    const u = r.url() || '';
    if (!/mtop|idle/i.test(u)) return;
    let body = '';
    try { body = await r.text(); } catch (e) { body = '<<读取失败: ' + e.message + '>>'; }
    const api = (u.match(/api=([^&]+)/) || [])[1] || '';
    hits.push({ api, url: u.slice(0, 300), status: r.status(), len: body.length, body: body.slice(0, 200000) });
    console.log('捕获 [' + api + '] ' + r.status() + ' ' + body.length + 'B');
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
    .catch((e) => console.log('goto:', e.message.split('\n')[0]));
  await page.waitForTimeout(6000);
  for (let i = 0; i < 3; i++) {
    await page.evaluate('window.scrollTo(0, document.body.scrollHeight)').catch(() => {});
    await page.waitForTimeout(2500);
  }

  fs.mkdirSync('dist', { recursive: true });
  fs.writeFileSync(out, JSON.stringify(hits, null, 2), 'utf8');
  console.log('已保存 ' + hits.length + ' 条 → ' + out);

  // 直接把每个接口里的「想要」相关字段搜出来
  const keysWant = ['wantCnt', 'wantNum', 'want', 'favor', 'like', 'browseCnt', 'browse'];
  for (const h of hits) {
    if (!h.body) continue;
    const found = {};
    for (const k of keysWant) {
      const re = new RegExp('"' + k + '[^"]*"\\s*:\\s*("?[^,}"]{0,30}"?)', 'g');
      const m = h.body.match(re);
      if (m) found[k] = m.slice(0, 6);
    }
    if (Object.keys(found).length) {
      console.log('\n=== ' + h.api + ' ===');
      console.log(JSON.stringify(found, null, 1).slice(0, 1200));
    }
  }
  await page.close();
  await b.close();
})().catch((e) => { console.error('ERR', e.message.split('\n')[0]); process.exit(1); });
