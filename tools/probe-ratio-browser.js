/**
 * 用浏览器解码测图片真实尺寸（权威）：Node 的 WEBP 尺寸解析可能不准，
 * 这里用 createImageBitmap 拿到解码后的真实像素，顺便算 dHash。
 *
 * 目的：确认 CDN 加 _1440x1440q100.jpg 后，是「等比缩放」还是「拉伸变形」。
 *
 * 用法：node tools/probe-ratio-browser.js [每组几张]
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('C:/Users/pc/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

const { load, ratioOf } = require('./xy-shop-images.js');
const SUFFIX = '_1440x1440q80.jpg';

/** Node 侧下载图片字节；URL 是 http 也升到 https（https 实测返回 200） */
function dl(u) {
  const https = require('https');
  return new Promise(function (resolve) {
    const req = https.get(String(u).replace(/^http:/i, 'https:'), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
          + '(KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'
      }
    }, function (res) {
      const bufs = [];
      res.on('data', function (d) { bufs.push(d); });
      res.on('end', function () {
        const b = Buffer.concat(bufs);
        resolve(res.statusCode === 200 && b.length > 100 ? b : null);
      });
    });
    req.on('error', function () { resolve(null); });
    req.setTimeout(30000, function () { req.destroy(); resolve(null); });
  });
}


(async function main() {
  const perGroup = parseInt(process.argv[2] || '2', 10);
  const all = load();

  const groups = {};
  all.forEach(function (r) { const g = ratioOf(+r.w, +r.h); (groups[g] = groups[g] || []).push(r); });
  const picked = [];
  Object.keys(groups).forEach(function (g) {
    const list = groups[g].slice().sort(function (a, b) { return (+a.w) - (+b.w); });
    const idxs = [0, Math.floor(list.length / 2), list.length - 1].slice(0, Math.max(1, perGroup + 1));
    idxs.forEach(function (i) { if (list[i]) picked.push(Object.assign({ g: g }, list[i])); });
  });
  const urls = picked.map(function (p) { return { g: p.g, w: p.w, h: p.h, a: p.u, b: p.u + SUFFIX }; });

  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0] || await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('https://www.goofish.com/robots.txt', { waitUntil: 'domcontentloaded' }).catch(function () {});

  // 单张：解码拿真实尺寸 + dHash
  // 字节由 Node 侧下载好传进来 —— 页面是 https，直接 fetch http 图会被混合内容拦
  const ONE = async function (b64) {
    try {
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const bmp = await createImageBitmap(new Blob([arr]));
      const W = bmp.width, H = bmp.height;
      const N = 32;
      const cv = new OffscreenCanvas(N + 1, N);
      const cx = cv.getContext('2d');
      cx.drawImage(bmp, 0, 0, N + 1, N);
      const px = cx.getImageData(0, 0, N + 1, N).data;
      let aHash = '', dHash = '';
      let sum = 0;
      const gray = [];
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const i = (y * (N + 1) + x) * 4;
          const v = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000;
          gray.push(v); sum += v;
        }
      }
      const avg = sum / gray.length;
      for (let i = 0; i < gray.length; i++) aHash += gray[i] > avg ? '1' : '0';
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const l = gray[y * N + x], rr = gray[y * N + Math.min(x + 1, N - 1)];
          dHash += l > rr ? '1' : '0';
        }
      }
      return { w: W, h: H, ah: aHash, dh: dHash };
    } catch (e) { return { err: String(e.message || e).slice(0, 60) }; }
  };

  console.log('比例      声明尺寸      原图真实        改后真实        比例漂移   长边   dHash距离  判定');
  console.log('─'.repeat(100));

  let ok = 0, bad = 0, same = 0, fail = 0;

  for (const t of urls) {
    // Node 侧下载（走 https，避开混合内容），把字节喂给浏览器解码
    const ba = await dl(t.a), bb = await dl(t.b);
    if (!ba || !bb) {
      fail++;
      console.log(t.g.padEnd(9), String(t.w + 'x' + t.h).padEnd(13), '下载失败', '—');
      continue;
    }
    const ra = await page.evaluate(ONE, ba.toString('base64'));
    const rb = await page.evaluate(ONE, bb.toString('base64'));
    if (ra.err || rb.err) {
      fail++;
      console.log(t.g.padEnd(9), String(t.w + 'x' + t.h).padEnd(13),
        (ra.err || ra.w + 'x' + ra.h).padEnd(15), (rb.err || rb.w + 'x' + rb.h).padEnd(15), '—');
      continue;
    }
    const qa = ra.w / ra.h, qb = rb.w / rb.h;
    const drift = Math.abs(qa - qb) / qa;
    let dist = 0;
    for (let i = 0; i < ra.dh.length; i++) if (ra.dh[i] !== rb.dh[i]) dist++;
    const longest = Math.max(rb.w, rb.h);
    const kept = drift < 0.005;
    if (kept && dist > 0) ok++; else if (!kept) bad++; else same++;

    console.log(
      t.g.padEnd(9),
      String(t.w + 'x' + t.h).padEnd(13),
      (ra.w + 'x' + ra.h).padEnd(15),
      (rb.w + 'x' + rb.h).padEnd(15),
      ((drift * 100).toFixed(2) + '%').padEnd(11),
      String(longest).padEnd(6),
      String(dist).padEnd(10),
      kept ? (dist > 0 ? '✓ 等比且已变' : '⚠ 字节没变') : '✗ 变形'
    );
  }

  console.log('─'.repeat(100));
  console.log('等比且哈希已变: ' + ok + '  |  变形: ' + bad + '  |  没变: ' + same + '  |  失败: ' + fail);
  await page.close();
  await browser.close();
})();
