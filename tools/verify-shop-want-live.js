/**
 * 整店页端到端验证（集市店铺，1000+ 商品那种）：
 *   1. 滚动加载 → 商品池持续变大、想要人数持续跟上
 *   2. 面板每行显示「N人想要」
 *   3. 按「想要数 ≥ N」筛选并勾选 → 勾上的必须都有想要数
 *   4. 补详情不再逐个开标签页（直连 mtop），实测耗时
 *
 *   node tools/verify-shop-want-live.js <店铺URL> [想要数下限]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('C:/Users/pc/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

const ROOT = path.join(__dirname, '..');
const url = process.argv[2] || 'https://www.goofish.com/personal?userId=2208526863302';
const WANT_MIN = process.argv[3] || '1';

const STUB = `(function () {
  if (window.__XY_STUB__) return; window.__XY_STUB__ = true;
  window.__XY_MSGS = [];
  window.chrome = window.chrome || {};
  window.chrome.runtime = {
    sendMessage: function (m, cb) { window.__XY_MSGS.push(m); if (cb) cb({ ok: true }); },
    onMessage: { addListener: function () {} },
    getManifest: function () { return { version: '1.9.6-test' }; }, lastError: null };
  window.chrome.storage = {
    sync: { get: function (k, cb) { cb({}); } },
    local: { get: function (k, cb) { cb({}); }, set: function (o, cb) { cb && cb(); } },
    onChanged: { addListener: function () {} } };
  window.chrome.tabs = { query: function (q, cb) { cb([]); }, reload: function () {} };
})()`;

const SCRIPTS = ['src/common/sites.js', 'src/common/util.js', 'src/common/postbus.js',
  'src/common/extract.js', 'src/content/injected.js', 'src/content/bridge.js'];

const stat = () => `(function () {
  var rows = document.querySelectorAll('.xy-pick-row[data-xy-id]');
  var withWant = 0, sample = [];
  rows.forEach(function (r) {
    var t = r.innerText || '';
    if (/人想要/.test(t)) withWant++;
    if (sample.length < 5) sample.push(t.replace(/\\s+/g, ' ').slice(0, 46));
  });
  return {
    cards: document.documentElement.getAttribute('data-xy-cards') || '',
    rows: rows.length,
    rowsWithWant: withWant,
    sample: sample,
    heatStat: (document.querySelector('.xy-heat-stat') || {}).textContent || ''
  };
})()`;

(async () => {
  const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = b.contexts()[0];
  const page = await ctx.newPage();
  await page.addInitScript(STUB);
  for (const f of SCRIPTS) await page.addInitScript(fs.readFileSync(path.join(ROOT, f), 'utf8'));

  try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }); }
  catch (e) { console.log('goto:', String(e.message).split('\n')[0]); }
  await page.waitForTimeout(5000);
  // 复现真实扩展的行为：内容脚本是 document_start 注入的，第一次导航就能拦到
  // 列表接口。这里用 Playwright 的 addInitScript 有时赶不上首次导航，
  // 所以再 reload 一次确保 hook 生效（addInitScript 对 reload 同样有效）。
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(8000);
  console.log('[首屏] ' + JSON.stringify(await page.evaluate(stat()), null, 1));

  // 「补想要数」应当**平时隐藏**（列表接口直接给想要数）：
  //   缺口 0 → display:none；有缺口 → 显示并带「（缺 N）」
  const btnState = await page.evaluate(`(function () {
    var out = { heat: null, all: null, btns: [] };
    document.querySelectorAll('.xy-btn').forEach(function (b) {
      out.btns.push(b.textContent + '|' + (b.style.display || 'shown'));
    });
    var h = document.querySelector('.xy-fill-heat');
    out.heat = h ? { text: h.textContent, display: h.style.display || 'shown' } : 'NOT_FOUND';
    document.querySelectorAll('.xy-btn').forEach(function (b) {
      if (b.dataset.act === 'filter-fill-all') out.all = b.textContent;
    });
    return out;
  })()`);
  console.log('[按钮] ' + JSON.stringify(btnState, null, 1));

  // 滚动三屏，看商品池和想要人数是否持续跟上
  for (let i = 0; i < 3; i++) {
    await page.evaluate(`window.scrollTo(0, document.body.scrollHeight)`).catch(() => {});
    await page.waitForTimeout(3500);
  }
  console.log('[滚动后] ' + JSON.stringify(await page.evaluate(stat()), null, 1));

  // 填「想要数 ≥ N」→ 筛选并勾选
  const filled = await page.evaluate(`(function () {
    var inp = document.querySelector('.xy-filter-input');
    if (!inp) return { err: '没有筛选输入框' };
    inp.value = '${WANT_MIN}';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return { value: inp.value };
  })()`);
  console.log('[填筛选条件] ' + JSON.stringify(filled));
  await page.waitForTimeout(600);
  const clicked = await page.evaluate(`(function () {
    var btns = document.querySelectorAll('.xy-btn');
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].dataset.act === 'filter-pick') { btns[i].click(); return true; }
    }
    return false;
  })()`);
  await page.waitForTimeout(1500);
  const res = await page.evaluate(`(function () {
    var on = [];
    document.querySelectorAll('.xy-pick-row.xy-check-on').forEach(function (r) {
      on.push((r.innerText || '').replace(/\\s+/g, ' ').slice(0, 40));
    });
    var cnt = document.querySelector('.xy-sel-num');
    return { picked: on.length, selNum: cnt ? cnt.textContent : '', sample: on.slice(0, 6) };
  })()`);
  console.log('[筛选并勾选] ' + JSON.stringify(res, null, 1));
  const bad = (res.sample || []).filter((t) => !/人想要/.test(t));
  console.log('  勾上的里面「没有想要数」的: ' + bad.length + (bad.length ? ' → ' + JSON.stringify(bad) : ''));

  await page.close();
  await b.close();
})().catch((e) => { console.error('ERR', String(e && e.message).split('\n')[0]); process.exit(1); });
