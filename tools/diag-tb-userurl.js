/**
 * 针对性诊断：用户给的这个整店 URL 上，插件到底有没有工作
 *
 * https://shop151421831.taobao.com/category.htm?spm=...&topIds=973720896210
 * 这是旧版店铺域名（shop<数字>.taobao.com），我先前测的是品牌域名
 * （minwai.tmall.com）——两者落地地址、DOM、host 都不同，很可能就卡在这。
 *
 * 逐项检查：站点识别 → 脚本注入 → 浮窗 → 店铺页判定 → shopId/sellerId
 * → 接口调用 → 商品池。哪一环断了一眼能看出来。
 */
'use strict';

const CDP = require('./cdp');

const URL = process.argv[2] ||
  'https://shop151421831.taobao.com/category.htm?spm=pc_detail.30350276.shop_block.dshopinfo.797f19ecmUIeEG&topIds=973720896210';

const SNAP = `return (function(){
  function n(s){ try { return document.querySelectorAll(s).length; } catch(e){ return -1; } }
  var host = location.host;
  var S = window.XYSites;
  var site = (S && S.match) ? S.match(host) : null;
  var panel = document.querySelector('.xy-panel');
  return {
    落地url: location.href.slice(0, 130),
    落地host: host,
    XYUtil注入: !!window.XYUtil,
    XYSites注入: !!window.XYSites,
    站点命中: site ? site.key : '(未命中！)',
    店铺页判定: site ? site.shopPageRe.test(location.href) : '(无 site)',
    浮窗存在: !!panel,
    浮窗位置: panel ? (panel.style.cssText || '').slice(0, 80) : '',
    勾选框: n('.xy-check'),
    浮窗商品行: n('.xy-pick-row'),
    面板计数: (function(){ var e=document.querySelector('.xy-sel-num'); return e?e.innerText:''; })(),
    页面商品卡: n('[class*="doubleCardWrapper"]') + n('[class*="item-holder"]') + n('[class*="product"]'),
    有libMtop: !!(window.lib && window.lib.mtop),
    html里的shopId: (document.documentElement.innerHTML.match(/"shopId"\\s*:\\s*"?(\\d+)"?/) || [])[1] || '(无)',
    html里的sellerId: (document.documentElement.innerHTML.match(/"sellerId"\\s*:\\s*"?(\\d+)"?/) || [])[1] || '(无)',
    body长度: document.body ? document.body.innerText.length : 0
  };
})()`;

(async () => {
  const b = await CDP.connect(9222);
  const { targetId } = await b.createTarget('about:blank');
  const page = await b.attachTarget({ id: targetId });

  const logs = [];
  const errs = [];
  await page.send('Runtime.enable');
  page.on('Runtime.consoleAPICalled', (p) => {
    const t = (p.args || []).map((a) => (a.value !== undefined ? String(a.value) : (a.description || ''))).join(' ');
    logs.push('[' + p.type + '] ' + t.slice(0, 220));
  });
  page.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails || {};
    const e = d.exception || {};
    errs.push(String(e.description || d.text || '').slice(0, 350));
  });

  console.log('打开: ' + URL);
  try {
    await page.goto(URL, 45000);
    await new Promise((r) => setTimeout(r, 12000));
  } catch (e) { console.log('打开异常: ' + e.message); }

  const r = await page.evaluate(SNAP);
  console.log('\n=== 逐项检查 ===');
  Object.keys(r).forEach((k) => console.log('  ' + k + ': ' + JSON.stringify(r[k])));

  console.log('\n=== 未捕获异常 (' + errs.length + ') ===');
  errs.slice(0, 6).forEach((e) => console.log('  ✗ ' + e));

  console.log('\n=== 与插件相关的日志 ===');
  const mine = logs.filter((l) => /xy|XY|整店|采集|勾选|补详情/i.test(l));
  mine.slice(0, 20).forEach((l) => console.log('  ' + l));
  if (!mine.length) console.log('  (无)');

  await page.close();
  await b.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
