/**
 * 真机验证（不依赖扩展被 Chrome 接受）：把内容脚本按 manifest 的顺序
 * **直接注入页面**，用一个 chrome.* 桩顶替扩展运行时，然后实测
 *
 *   1. 点页面卡片左上角的 .xy-check → 面板里那一行变勾选
 *   2. 点面板里的某一行          → 页面卡片左上角的 .xy-check 变勾选
 *   3. 集市商品的想要人数有没有读出来
 *
 * 为什么要绕这一圈：这台机器的 Chrome 被组织策略接管、开发者模式被禁，
 * --load-extension 装不上解压扩展，只能这样把内容脚本跑起来。
 *
 *   node tools/verify-sync-injected.js <店铺URL>
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('C:/Users/pc/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

const ROOT = path.join(__dirname, '..');
const url = process.argv[2] || 'https://www.goofish.com/personal?userId=2208526863302';

const STUB = `(function () {
  if (window.__XY_STUB__) return; window.__XY_STUB__ = true;
  window.__XY_MSGS = [];
  var store = {};
  window.chrome = window.chrome || {};
  window.chrome.runtime = {
    sendMessage: function (m, cb) { window.__XY_MSGS.push(m); if (cb) cb({ ok: true }); },
    onMessage: { addListener: function () {} },
    getManifest: function () { return { version: '1.9.6-test' }; },
    lastError: null
  };
  window.chrome.storage = {
    sync: { get: function (k, cb) { cb({}); } },
    local: { get: function (k, cb) { cb({}); }, set: function (o, cb) { cb && cb(); } },
    onChanged: { addListener: function () {} }
  };
  window.chrome.tabs = {
    query: function (q, cb) { cb([]); },
    reload: function () {}
  };
})()`;

const SCRIPTS = [
  'src/common/sites.js',
  'src/common/util.js',
  'src/common/postbus.js',
  'src/common/extract.js',
  'src/content/injected.js',
  'src/content/bridge.js'
];

const snap = () => `(function () {
  var on = [];
  document.querySelectorAll('.xy-check[data-xy-id]').forEach(function (n) {
    if (n.classList.contains('xy-check-on')) on.push(n.getAttribute('data-xy-id'));
  });
  var ron = [];
  document.querySelectorAll('.xy-pick-row[data-xy-id]').forEach(function (n) {
    if (n.classList.contains('xy-check-on')) ron.push(n.getAttribute('data-xy-id'));
  });
  return {
    bridge: document.documentElement.getAttribute('data-xy-bridge') || '',
    pageChecks: document.querySelectorAll('.xy-check[data-xy-id]').length,
    panelRows: document.querySelectorAll('.xy-pick-row[data-xy-id]').length,
    pageOn: on, panelOn: ron,
    cards: (document.documentElement.getAttribute('data-xy-cards') || '')
  };
})()`;

(async () => {
  const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = b.contexts()[0];
  const page = await ctx.newPage();
  // ★ 必须在**页面加载前**注入：injected.js 是 hook fetch/XHR 的，
  //   晚一步就抓不到店铺列表接口 mtop.idle.web.xyh.item.list，
  //   想要人数自然一个都读不到（manifest 里也是 document_start）。
  await page.addInitScript(STUB);
  for (const f of SCRIPTS) {
    const code = fs.readFileSync(path.join(ROOT, f), 'utf8');
    await page.addInitScript(code);
  }
  try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }); }
  catch (e) { console.log('goto:', String(e.message).split('\n')[0]); }
  await page.waitForTimeout(8000);

  console.log('[注入后] ' + JSON.stringify(await page.evaluate(snap())));

  // 方向 1：页面卡片左上角 → 面板
  const r1 = await page.evaluate(`(function () {
    var n = document.querySelector('.xy-check[data-xy-id]');
    if (!n) return { err: '页面上没有 .xy-check' };
    var id = n.getAttribute('data-xy-id');
    n.click();
    return { clicked: id };
  })()`);
  await page.waitForTimeout(1200);
  const s1 = await page.evaluate(snap());
  console.log('[点页面复选框] ' + JSON.stringify(r1));
  console.log('  面板已勾: ' + JSON.stringify(s1.panelOn.slice(0, 5)));
  console.log('  → 页面→面板: ' + (r1.clicked && s1.panelOn.indexOf(r1.clicked) > -1 ? 'OK' : '✗'));

  // 方向 2：面板 → 页面卡片左上角
  const r2 = await page.evaluate(`(function () {
    var rows = document.querySelectorAll('.xy-pick-row[data-xy-id]');
    for (var i = 0; i < rows.length; i++) {
      var id = rows[i].getAttribute('data-xy-id');
      if (id === '${r1.clicked || ''}') continue;
      rows[i].click();
      return { clicked: id };
    }
    return { err: '面板没有行' };
  })()`);
  await page.waitForTimeout(1200);
  const s2 = await page.evaluate(snap());
  console.log('[点面板行] ' + JSON.stringify(r2));
  console.log('  页面已勾: ' + JSON.stringify(s2.pageOn.slice(0, 5)));
  console.log('  → 面板→页面: ' + (r2.clicked && s2.pageOn.indexOf(r2.clicked) > -1 ? 'OK' : '✗'));

  await page.close();
  await b.close();
})().catch((e) => { console.error('ERR', String(e && e.message).split('\n')[0]); process.exit(1); });
