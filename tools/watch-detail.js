/**
 * 打开一个 1688 商品详情页，把「SKU 选择器接口」的原始响应完整落盘。
 *
 * 实测发现：补详情真正有效的是 mtop.1688.wosc.queryofferskuselectormodel
 * （不是配置里猜的 laputa.1688.offer.detail），规格表就在它的返回里。
 * 这个脚本把响应原样存下来，用来确定字段名。
 *
 *   node tools/watch-detail.js [商品URL]
 */
'use strict';
const fs = require('fs');
const { chromium } = require('C:/Users/pc/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

const url = process.argv[2] || 'https://detail.1688.com/offer/1001672530707.html';
const out = 'dist/laputa-sku-sample.json';

(async () => {
  const b = await chromium.connectOverCDP('http://localhost:9222');
  const ctx = b.contexts()[0];
  const page = await ctx.newPage();
  const saved = [];

  await page.route('**/*', async (route) => {
    const u = route.request().url();
    if (!/mtop\.1688|laputa|queryofferskuselectormodel/i.test(u)) return route.continue();
    try {
      const res = await route.fetch();
      const body = await res.text();
      if (/"skuInfoMap"|"skuList"|"discountPrice"/i.test(body)) {
        fs.appendFileSync(out, body + '\n');
        saved.push({ url: u.slice(0, 120), len: body.length, path: out });
      }
    } catch (e) {}
    return route.continue();
  });

  console.log('打开', url);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => console.log('goto:', e.message.split('\n')[0]));
  await page.waitForTimeout(6000);

  console.log('已落盘 SKU 接口响应:', saved.length);
  saved.forEach((s) => console.log('  ', s.len, 'B', s.url));
  if (saved.length) {
    const raw = fs.readFileSync(out, 'utf8').trim().split('\n')[0];
    try {
      const j = JSON.parse(raw);
      const d = j.data || {};
      const paths = [];
      (function walk(o, p, depth) {
        if (!o || typeof o !== 'object' || depth > 6) return;
        for (const k of Object.keys(o)) {
          const v = o[k];
          if (/sku|price|spec/i.test(k) && (Array.isArray(v) ? v.length : v && typeof v === 'object')) {
            if (paths.length < 10) {
              paths.push(p + '.' + k + ' = ' + (Array.isArray(v) ? 'array[' + v.length + ']' : 'object{' + Object.keys(v).slice(0, 8).join(',') + '}'));
            }
          }
          if (v && typeof v === 'object') walk(v, p + '.' + k, depth + 1);
        }
      })(d, 'data', 0);
      console.log('\n顶层键:', Object.keys(d).slice(0, 12).join(', '));
      console.log('SKU 相关路径:');
      paths.forEach((x) => console.log('  ', x));
    } catch (e) {
      console.log('解析失败:', raw.slice(0, 200));
    }
  }

  await page.close();
  await b.close();
})().catch((e) => { console.error('ERR', e.message.split('\n')[0]); process.exit(1); });
