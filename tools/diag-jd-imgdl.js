/**
 * 诊断京东主图为什么下不下来。
 *
 * 采集侧已经验证是好的（30/30 有图），所以重点看「能不能下载」：
 *   A. 浏览器里（带 Referer）加载 —— 用 <img> 试
 *   B. node 里直接抓（不带 Referer，等价于 chrome.downloads 的行为）
 * 两边结果一对比就知道是不是防盗链。
 *
 * 用法：node tools/diag-jd-imgdl.js [关键词]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const CDP = require('./cdp');

const ROOT = path.join(__dirname, '..');
const KW = process.argv[2] || '手机支架';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const UTIL = fs.readFileSync(path.join(ROOT, 'src/common/util.js'), 'utf8');
const SITES = fs.readFileSync(path.join(ROOT, 'src/common/sites.js'), 'utf8');

(async () => {
  const b = await CDP.connect(9222);
  const page = await b.open('https://search.jd.com/Search?keyword=' + encodeURIComponent(KW) + '&enc=utf-8');
  await sleep(10000);
  await page.evaluate(UTIL + '\n' + SITES + '\nreturn 1;');

  // ① 取三张真实主图（完整 URL）
  const urls = await page.evaluate(`
    return (function () {
      var U = window.XYUtil, S = window.XYSites;
      var cards = U.scanCards(document, S.match(location.host));
      var out = [];
      for (var i = 0; i < cards.length && out.length < 3; i++) {
        var u = cards[i].image || (cards[i].images || [])[0];
        if (u) out.push({ id: cards[i].itemId, image: u });
      }
      return out;
    })()
  `, true);

  console.log('采到的主图:');
  urls.forEach((x) => console.log('  ' + x.id + '  ' + x.image));
  if (!urls.length) { console.log('✗ 采集侧就没图'); await b.close(); process.exit(1); }

  // ② 浏览器里用 <img> 加载（带页面 Referer）
  console.log('\nA. 浏览器加载（带 Referer）：');
  for (const x of urls) {
    const r = await page.evaluate(`
      return new Promise(function (res) {
        var i = new Image();
        var done = false;
        i.onload = function () { if (!done) { done = true; res('ok  ' + i.naturalWidth + 'x' + i.naturalHeight); } };
        i.onerror = function () { if (!done) { done = true; res('ERR'); } };
        i.src = ${JSON.stringify(x.image)};
        setTimeout(function () { if (!done) { done = true; res('超时'); } }, 8000);
      })
    `, true);
    console.log('  ' + String(r).padEnd(12) + x.image.slice(-40));
  }

  // ③ node 直接抓（不带 Referer，等价于 chrome.downloads）
  console.log('\nB. node 直抓（不带 Referer，≈ chrome.downloads 的行为）：');
  for (const x of urls) {
    try {
      const r = await fetch(x.image, { method: 'GET' });
      const buf = r.ok ? await r.arrayBuffer() : null;
      console.log('  ' + String(r.status).padEnd(5) + (buf ? (buf.byteLength + 'B') : '').padEnd(10) +
        x.image.slice(-40));
    } catch (e) {
      console.log('  异常  ' + e.message);
    }
  }

  // ④ 带上 Referer 再抓一次（验证是不是防盗链）
  console.log('\nC. node 带京东 Referer 抓：');
  for (const x of urls) {
    try {
      const r = await fetch(x.image, {
        method: 'GET',
        headers: { Referer: 'https://item.jd.com/', Origin: 'https://item.jd.com' }
      });
      const buf = r.ok ? await r.arrayBuffer() : null;
      console.log('  ' + String(r.status).padEnd(5) + (buf ? (buf.byteLength + 'B') : '').padEnd(10) +
        x.image.slice(-40));
    } catch (e) {
      console.log('  异常  ' + e.message);
    }
  }

  await b.close();
})().catch((e) => { console.error('ERR', e && e.message); process.exit(1); });
