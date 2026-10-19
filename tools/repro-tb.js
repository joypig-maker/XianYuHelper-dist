/**
 * 淘宝页真机复现：浮窗 / 勾选框 / 控制台日志
 *
 * 用户反馈三个现象：搜索页只下到 1 张图、整店页浮窗不出现、商品勾不上。
 * 前两个如果是脚本报错导致的，页面控制台一定留了痕迹，
 * 所以这里把 console 与未捕获异常全部捕获下来，同时数一遍 UI 元素。
 */
'use strict';

const CDP = require('./cdp');

const CASES = [
  ['淘宝搜索页', 'https://s.taobao.com/search?q=' + encodeURIComponent('手机支架')],
  ['淘宝整店页', 'https://minwai.tmall.com/category.htm']
];

const SNAP = `return (function(){
  function n(sel){ try { return document.querySelectorAll(sel).length; } catch(e){ return -1; } }
  var panel = document.querySelector('.xy-panel');
  return {
    浮窗存在: !!panel,
    浮窗可见: panel ? (panel.style.display !== 'none' && !panel.classList.contains('xy-hide')) : false,
    浮窗class: panel ? String(panel.className) : '',
    勾选框数: n('.xy-check'),
    选择行数: n('.xy-pick-row'),
    doubleCardWrapper: n('[class*="doubleCardWrapper"]'),
    spmActId: n('[data-spm-act-id]'),
    XYUtil: !!window.XYUtil,
    XYSites: !!window.XYSites,
    当前站点: (function(){ try { return window.XYSites.match(location.host).key; } catch(e){ return '(match 失败:' + e.message + ')'; } })(),
    有libMtop: !!(window.lib && window.lib.mtop),
    页面脚本数: document.scripts.length
  };
})()`;

async function run(b, label, url) {
  const { targetId } = await b.createTarget('about:blank');
  const page = await b.attachTarget({ id: targetId });

  const logs = [];
  const errs = [];
  await page.send('Runtime.enable');
  await page.send('Log.enable').catch(() => {});
  page.on('Runtime.consoleAPICalled', (p) => {
    const text = (p.args || []).map((a) => {
      if (a.value !== undefined) return String(a.value);
      return a.description || a.type || '';
    }).join(' ');
    logs.push('[' + p.type + '] ' + text.slice(0, 300));
  });
  page.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails || {};
    const e = d.exception || {};
    errs.push((d.text || '') + ' :: ' + String(e.description || e.value || '').slice(0, 400));
  });

  console.log('\n' + '='.repeat(74));
  console.log('=== ' + label + ' ===');
  console.log(url);

  try {
    await page.goto(url, 45000);
    await new Promise((r) => setTimeout(r, 10000));
  } catch (e) {
    console.log('打开失败: ' + e.message);
  }

  const snap = await page.evaluate(SNAP);
  console.log('\n--- UI 与注入状态 ---');
  Object.keys(snap).forEach((k) => console.log('  ' + k + ': ' + JSON.stringify(snap[k])));

  console.log('\n--- 未捕获异常 (' + errs.length + ') ---');
  errs.slice(0, 8).forEach((e) => console.log('  ✗ ' + e));

  console.log('\n--- 控制台日志 (' + logs.length + ') ---');
  const mine = logs.filter((l) => /xy|XY|采集|批量|勾选/i.test(l));
  const rest = logs.filter((l) => !/xy|XY|采集|批量|勾选/i.test(l));
  console.log('  与插件相关的: ' + mine.length + ' 条');
  mine.slice(0, 15).forEach((l) => console.log('    ' + l));
  console.log('  其他日志: ' + rest.length + ' 条（前 5 条）');
  rest.slice(0, 5).forEach((l) => console.log('    ' + l.slice(0, 160)));

  await page.close();
}

(async () => {
  const b = await CDP.connect(9222);
  for (const [label, url] of CASES) await run(b, label, url);
  await b.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
