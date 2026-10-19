/**
 * 真机端到端复现：勾选 → 一键打包 → 数下载到的图片
 *
 * 用户反馈「只下载一个图片和文案」。搜索页接口只给 1 张主图，
 * 要靠详情补录（ensure-cards → fetchCardDetail → pcdetail.data.get）才能拿到 5 张。
 * 这里真点一次按钮，把这条链路整条跑通，看它到底断在哪一环。
 */
'use strict';

const CDP = require('./cdp');

async function run(b) {
  const { targetId } = await b.createTarget('about:blank');
  const page = await b.attachTarget({ id: targetId });

  const logs = [];
  await page.send('Runtime.enable');
  page.on('Runtime.consoleAPICalled', (p) => {
    const t = (p.args || []).map((a) => (a.value !== undefined ? String(a.value) : (a.description || ''))).join(' ');
    if (/xy|XY|补详情|打包|采集|ensure/i.test(t)) logs.push('[' + p.type + '] ' + t.slice(0, 260));
  });
  page.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails || {};
    const e = d.exception || {};
    logs.push('[异常] ' + String(e.description || d.text || '').slice(0, 300));
  });

  await page.goto('https://s.taobao.com/search?q=' + encodeURIComponent('手机支架'), 45000);
  await new Promise((r) => setTimeout(r, 9000));

  console.log('=== 勾选前 ===');
  let s = await page.evaluate(`return (function(){
    return { 勾选框: document.querySelectorAll('.xy-check').length,
             浮窗行: document.querySelectorAll('.xy-pick-row').length,
             面板计数文本: (function(){ var e=document.querySelector('.xy-sel-num'); return e?e.innerText:'(无)'; })() };
  })()`);
  console.log(JSON.stringify(s));

  // 点前 3 个勾选框
  console.log('\n=== 点击前 3 个勾选框 ===');
  const clicked = await page.evaluate(`return (function(){
    var boxes = document.querySelectorAll('.xy-check input');
    var n = 0;
    for (var i = 0; i < Math.min(3, boxes.length); i++) {
      boxes[i].click();
      n++;
    }
    return { 已点击: n, 勾选框总数: boxes.length };
  })()`);
  console.log(JSON.stringify(clicked));
  await new Promise((r) => setTimeout(r, 1500));

  s = await page.evaluate(`return (function(){
    var e = document.querySelector('.xy-sel-num');
    return { 选中计数: e ? e.innerText : '(无)',
             带勾选态: document.querySelectorAll('.xy-check.xy-check-on').length };
  })()`);
  console.log('勾选后状态: ' + JSON.stringify(s));

  // 找批量按钮
  const btns = await page.evaluate(`return (function(){
    return Array.prototype.map.call(document.querySelectorAll('.xy-grid-batch .xy-btn, .xy-panel button'),
      function(b){ return (b.innerText||'').trim().slice(0, 20); }).filter(Boolean);
  })()`);
  console.log('\n浮窗里的按钮: ' + JSON.stringify(btns));

  // 点「一键打包」
  console.log('\n=== 点击一键打包 ===');
  const r = await page.evaluate(`return (function(){
    var bs = document.querySelectorAll('.xy-grid-batch .xy-btn, .xy-panel button');
    for (var i = 0; i < bs.length; i++) {
      var t = (bs[i].innerText || '').trim();
      if (t.indexOf('打包') > -1) { bs[i].click(); return 'clicked: ' + t; }
    }
    return '没找到打包按钮';
  })()`);
  console.log(r);

  // 盯着 toast 看流程走到哪
  for (let i = 0; i < 12; i++) {
    await new Promise((r2) => setTimeout(r2, 2500));
    const toast = await page.evaluate(`return (function(){
      var t = document.querySelector('.xy-toast');
      return t && t.classList.contains('xy-toast-show') ? (t.innerText||'').slice(0,90) : '';
    })()`);
    if (toast) console.log('  [' + (i * 2.5 + 2.5) + 's] toast: ' + toast);
  }

  console.log('\n=== 插件相关日志 ===');
  logs.slice(0, 25).forEach((l) => console.log('  ' + l));
  if (!logs.length) console.log('  (无)');

  const final = await page.evaluate(`return (function(){
    var e = document.querySelector('.xy-sel-num');
    return { 选中计数: e ? e.innerText : '(无)' };
  })()`);
  console.log('\n最终: ' + JSON.stringify(final));

  await page.close();
}

(async () => {
  const b = await CDP.connect(9222);
  await run(b);
  await b.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
