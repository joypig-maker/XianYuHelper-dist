/**
 * 感知哈希（aHash / dHash）实测：改 CDN 尺寸参数后，图在「系统眼里」到底还是不是同一张。
 *
 * MD5 变了不代表平台认不出 —— 平台比的是感知哈希（把图缩到极小再按像素算指纹）。
 * 这里把图片解码到 canvas，算 8x8 aHash 与 9x8→64bit dHash，
 * 再和原图比汉明距离：0 = 完全同一张，通常 >10 就会被判成不同图。
 *
 * 用法：node tools/probe-img-dhash.js <原图> <变体1> [变体2...]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('C:/Users/pc/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

const files = process.argv.slice(2).filter(Boolean);
if (files.length < 2) { console.error('用法: node probe-img-dhash.js <原图> <变体...>'); process.exit(1); }

const payload = files.map((f) => ({
  name: path.basename(f),
  data: 'data:image/jpeg;base64,' + fs.readFileSync(f).toString('base64')
}));

const COMPUTE = `async function (items) {
  function load(src) {
    return new Promise(function (res, rej) {
      var im = new Image();
      im.onload = function () { res(im); };
      im.onerror = function () { rej(new Error('decode fail')); };
      im.src = src;
    });
  }
  function hashes(im) {
    // aHash: 8x8 灰度，逐点与均值比较
    var c = document.createElement('canvas');
    c.width = 8; c.height = 8;
    var x = c.getContext('2d');
    x.drawImage(im, 0, 0, 8, 8);
    var d = x.getImageData(0, 0, 8, 8).data;
    var g = [], sum = 0, i;
    for (i = 0; i < 64; i++) {
      var v = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
      g.push(v); sum += v;
    }
    var avg = sum / 64;
    var ah = '';
    for (i = 0; i < 64; i++) ah += (g[i] > avg ? '1' : '0');

    // dHash: 9x8 灰度，每行相邻点比较 → 64 bit
    var c2 = document.createElement('canvas');
    c2.width = 9; c2.height = 8;
    var x2 = c2.getContext('2d');
    x2.drawImage(im, 0, 0, 9, 8);
    var d2 = x2.getImageData(0, 0, 9, 8).data;
    var g2 = [];
    for (i = 0; i < 72; i++) {
      g2.push(0.299 * d2[i * 4] + 0.587 * d2[i * 4 + 1] + 0.114 * d2[i * 4 + 2]);
    }
    var dh = '';
    for (var r = 0; r < 8; r++) {
      for (var cIdx = 0; cIdx < 8; cIdx++) {
        var a = g2[r * 9 + cIdx], b = g2[r * 9 + cIdx + 1];
        dh += (a > b ? '1' : '0');
      }
    }
    return { a: ah, d: dh, w: im.naturalWidth, h: im.naturalHeight };
  }
  function ham(s1, s2) {
    var n = 0;
    for (var i = 0; i < s1.length; i++) if (s1[i] !== s2[i]) n++;
    return n;
  }
  var out = [];
  for (var k = 0; k < items.length; k++) {
    var im = await load(items[k].data);
    out.push(Object.assign({ name: items[k].name }, hashes(im)));
  }
  var base = out[0];
  return {
    base: { name: base.name, w: base.w, h: base.h },
    rows: out.map(function (r) {
      return { name: r.name, size: r.w + 'x' + r.h, aHash: ham(base.a, r.a), dHash: ham(base.d, r.d) };
    })
  };
}`;

(async () => {
  const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = b.contexts()[0];
  const page = await ctx.newPage();
  await page.goto('about:blank');
  const r = await page.evaluate(`(${COMPUTE})(${JSON.stringify(payload)})`);
  console.log('原图: ' + r.base.name + '  ' + r.base.w + 'x' + r.base.h);
  console.log('');
  console.log('变体                     实际尺寸        aHash距离  dHash距离   判定');
  r.rows.forEach(function (row) {
    var verdict = row.aHash === 0 && row.dHash === 0 ? '完全同一张'
      : (row.dHash >= 10 || row.aHash >= 10) ? '不同图' : '可能仍被判重复';
    console.log(
      row.name.padEnd(24) + row.size.padEnd(14) +
      String(row.aHash).padEnd(10) + String(row.dHash).padEnd(11) + verdict
    );
  });
  await page.close();
  await b.close();
})().catch((e) => { console.error('ERR', String(e && e.message).split('\n')[0]); process.exit(1); });
