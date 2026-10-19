/**
 * 抓「SKU 选择器接口」的真实请求参数。
 *
 * 实测扩展调这个接口会直接报 FAIL_SYS_BIZPARAM_MISSED::缺少业务参数useCase，
 * 说明 buildData 里少了个业务参数，但它的取值不能靠猜
 * （猜错一样是 100ms 就失败，还会把排查带偏）。
 * 这里打开一个真实的 1688 商品详情页，把它自己发起的 SKU 请求原样抓下来。
 *
 * 用法：node tools/diag-sku-capture.js [商品URL]
 */
'use strict';
const fs = require('fs');
const { chromium } = require('C:/Users/pc/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

const url = process.argv[2] ||
  'https://detail.1688.com/offer/1001672530707.html';
// 抓哪类接口：默认 SKU 选择器，传 detail 抓详情接口（参数分开存，免得互相盖掉）
const WANT = process.argv[3] || 'sku';
const OUT = process.argv[4] || (WANT === 'detail' ? 'dist/_detail-req.json' : 'dist/_sku-req.json');

(async () => {
  const b = await chromium.connectOverCDP('http://localhost:9222');
  const ctx = b.contexts()[0];
  const page = await ctx.newPage();
  const hits = [];
  // 接口名不能猜：详情页实测调的是 mmga.offerdetail.service，
  // 配置里写的 laputa.1688.offer.detail 这个页面一次都没发起过。
  const RE = WANT === 'detail'
    ? /mmga\.offerdetail\.service/i
    : /queryofferskuselectormodel/i;

  await page.route('**/*', async (route) => {
    const u = route.request().url();
    if (!RE.test(u)) return route.continue();
    let post = '';
    try { post = route.request().postData() || ''; } catch (e) {}
    let serviceName = '';
    try { serviceName = decodeURIComponent(post).match(/"serviceName":"([^"]+)"/)[1] || ''; } catch (e) {}
    const rec = {
      url: u,
      method: route.request().method(),
      serviceName: serviceName,
      post: post.slice(0, 400)
    };
    // detail 是聚合接口，靠 serviceName 区分业务。
    // 想知道哪个服务真正返回了图，只能看响应——这里顺手抓一次响应体。
    if (WANT === 'detail') {
      try {
        const res = await route.fetch();
        const body = await res.text();
        rec.respLen = body.length;
        rec.imgCount = (body.match(/imageUrl/g) || []).length +
          (body.match(/palette|imageList/g) || []).length;
        rec.ret = (body.match(/"ret":\["([^"]{0,40})/) || [])[1] || null;
        rec.respHead = body.slice(0, 300);
      } catch (e) { rec.respErr = e.message.slice(0, 80); }
    }
    hits.push(rec);
    return route.continue();
  });

  console.log('打开：' + url);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) { console.log('goto: ' + String(e.message).split('\n')[0]); }
  await page.waitForTimeout(8000);

  console.log('\n=== 抓到的 ' + WANT + ' 请求 ===');
  if (!hits.length) {
    console.log('(没有抓到——这个页面没发起该请求)');
  }
  hits.forEach(function (h, i) {
    console.log('\n[' + (i + 1) + '] ' + h.method + (h.serviceName ? (' serviceName=' + h.serviceName) : '') +
      ' ret=' + (h.ret || '-') + ' len=' + (h.respLen || 0) + ' 图引用=' + (h.imgCount || 0));
    console.log('    post: ' + h.post);
    if (h.respHead) console.log('    resp: ' + h.respHead);
  });
  // 请求体落盘，直接喂给下一轮的「改参数试」脚本
  try {
    fs.writeFileSync(OUT, JSON.stringify(hits, null, 1), 'utf8');
    console.log('\n已存：' + OUT);
  } catch (e) { console.log('存盘失败：' + e.message); }

  // 顺手把响应也留一份，方便后面直接改参数试
  if (hits.length) {
    const res = await page.request.post(hits[0].url.split('?')[0], {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      data: hits[0].post
    }).catch(() => null);
    if (res) {
      const body = await res.text().catch(() => '');
      console.log('\n=== 回打一次（用抓到的参数） ===');
      console.log('长度：' + body.length);
      console.log('片段：' + body.slice(0, 300));
    }
  }

  try { await page.close(); } catch (e) {}
  await b.close();
})().catch((e) => { console.error('失败：' + e.message); process.exit(1); });
