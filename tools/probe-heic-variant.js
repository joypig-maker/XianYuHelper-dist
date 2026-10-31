/**
 * 定点诊断：给定图片 URL，逐个档位输出 HTTP 码 / 字节数 / 解码尺寸 / dHash 距离
 * 用于查清「为什么某些图加后缀后字节没变」
 *
 * 用法：node tools/probe-heic-variant.js <url> [...]
 */
'use strict';
const path = require('path');
const https = require('https');
const { chromium } = require('C:/Users/pc/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

const VARIANTS = (process.env.VARIANTS || '_1440x1440q100.jpg,_1440x1440q95.jpg,_1440x1440q90.jpg,_1440x1440q85.jpg,_1440x1440q80.jpg,_1440x1440q75.jpg,_1440x1440q70.jpg,_1440x1440q50.jpg').split(',');

function dl(u) {
  return new Promise(function (resolve) {
    const req = https.get(String(u).replace(/^http:/i, 'https:'), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
          + '(KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'
      }
    }, function (res) {
      const bufs = [];
      res.on('data', function (d) { bufs.push(d); });
      res.on('end', function () { resolve({ code: res.statusCode, buf: Buffer.concat(bufs) }); });
    });
    req.on('error', function (e) { resolve({ code: 0, buf: Buffer.alloc(0), err: e.message }); });
    req.setTimeout(30000, function () { req.destroy(); resolve({ code: 0, buf: Buffer.alloc(0), err: 'timeout' }); });
  });
}

const ONE = async function (b64) {
  try {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([arr]));
    const W = bmp.width, H = bmp.height, N = 32;
    const cv = new OffscreenCanvas(N + 1, N);
    const cx = cv.getContext('2d');
    cx.drawImage(bmp, 0, 0, N + 1, N);
    const px = cx.getImageData(0, 0, N + 1, N).data;
    const gray = [];
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = (y * (N + 1) + x) * 4;
        gray.push((px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000);
      }
    }
    let d = '';
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const l = gray[y * N + x], r = gray[y * N + Math.min(x + 1, N - 1)];
        d += l > r ? '1' : '0';
      }
    }
    return { w: W, h: H, dh: d };
  } catch (e) { return { err: String(e.message || e).slice(0, 50) }; }
};

(async function main() {
  const urls = process.argv.slice(2);
  if (!urls.length) { console.log('用法: node tools/probe-heic-variant.js <url> [...]'); return; }

  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0] || await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('https://www.goofish.com/robots.txt', { waitUntil: 'domcontentloaded' }).catch(function () {});

  for (const u of urls) {
    console.log('\n■ ' + u.slice(-62));
    console.log('  档位                 HTTP   字节        解码尺寸      dHash距离   比例');
    console.log('  ' + '─'.repeat(76));

    const base = await dl(u);
    const rb = base.buf.length > 100 ? await page.evaluate(ONE, base.buf.toString('base64')) : { err: '下载失败' };

    for (const v of VARIANTS) {
      const url = v === '(原图)' ? u : u + v;
      const r = await dl(url);
      if (r.code !== 200 || r.buf.length < 100) {
        console.log('  ' + v.padEnd(20) + String(r.code).padEnd(7) + String(r.buf.length).padEnd(12) + '✗');
        continue;
      }
      const same = r.buf.equals(base.buf);
      const d = r.buf.length > 100 ? await page.evaluate(ONE, r.buf.toString('base64')) : { err: '?' };
      let dist = '-';
      if (!d.err && !rb.err && rb.dh) {
        dist = 0;
        for (let i = 0; i < rb.dh.length; i++) if (rb.dh[i] !== d.dh[i]) dist++;
      }
      const ratio = (!d.err && d.h) ? (d.w / d.h).toFixed(4) : '-';
      console.log('  ' + v.padEnd(20)
        + String(r.code).padEnd(7)
        + String(r.buf.length).padEnd(12)
        + String(d.err ? d.err : d.w + 'x' + d.h).padEnd(13)
        + String(dist).padEnd(12)
        + ratio
        + (same ? '   ← 与原图字节完全相同' : ''));
    }
  }
  console.log();
  await browser.close();
})();
