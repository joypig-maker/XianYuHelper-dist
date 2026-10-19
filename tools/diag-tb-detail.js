/**
 * 淘宝详情接口探路：验证「价格是否明文」和「主图能拿几张」
 *
 * 店铺列表接口返回的 discountPrice 是加密串（priceEncoded:true），
 * 这决定了我们的取价方案，必须先验清楚。
 * 同时确认主图集（用户要的 5 张首图）和视频在详情接口里的形态。
 */
'use strict';

const fs = require('fs');
const CDP = require('./cdp');

const ITEM = process.argv[2] || 'https://detail.tmall.com/item.htm?id=669745626548';
const OUT = 'dist/_dts';

(async () => {
  const b = await CDP.connect(9222);
  const { targetId } = await b.createTarget('about:blank');
  const page = await b.attachTarget({ id: targetId });

  const hits = [];
  await page.send('Network.enable');
  page.on('Network.responseReceived', (p) => {
    const u = (p.response && p.response.url) || '';
    if (!/mtop\.taobao\.(detail|pcdetail)/i.test(u)) return;
    hits.push({ requestId: p.requestId, url: u, status: p.response.status });
  });

  await page.goto(ITEM, 50000);
  await new Promise((r) => setTimeout(r, 9000));

  console.log('=== 详情接口命中 ' + hits.length + ' 个 ===');
  for (const h of hits) {
    const api = (h.url.match(/mtop\.[a-zA-Z0-9_.]+/) || [''])[0];
    console.log('\n--- ' + api + '  [' + h.status + ']');
    const q = h.url.split('?')[1] || '';
    const dataParam = decodeURIComponent((q.match(/[?&]data=([^&]*)/) || [])[1] || '');
    console.log('    data 参数:', dataParam.slice(0, 260));
    try {
      const body = await page.send('Network.getResponseBody', { requestId: h.requestId });
      const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
      const name = 'tb-detail-' + api.replace(/[^\w]/g, '_') + '.json';
      fs.writeFileSync(OUT + '/' + name, text);
      console.log('    已存 ' + OUT + '/' + name + ' (' + text.length + ' 字节)');
    } catch (e) { console.log('    取响应失败:', e.message); }
  }

  // 页面 DOM：价格与主图
  const dom = await page.evaluate(`return (function(){
    var priceEl = document.querySelector('[class*="priceText"],[class*="Price--"] ,[class*="price--"]');
    var imgs = [];
    document.querySelectorAll('[class*="thumbnails"] img, [class*="Thumbnail"] img, [class*="PicGallery"] li img').forEach(function(im){
      var s = im.getAttribute('src') || im.getAttribute('data-src') || '';
      if (s) imgs.push(s.slice(0, 100));
    });
    return {
      priceText: priceEl ? priceEl.innerText.replace(/\\s+/g,' ').slice(0, 40) : '(没有命中)',
      thumbCount: imgs.length,
      thumbs: imgs.slice(0, 8),
      hasVideo: !!document.querySelector('video,[class*="video"],[class*="Video"]'),
      title: (document.title||'').slice(0, 60)
    };
  })()`);
  console.log('\n=== 详情页 DOM ===');
  console.log(JSON.stringify(dom, null, 1));

  await page.close();
  await b.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
