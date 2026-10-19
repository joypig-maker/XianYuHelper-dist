/**
 * 重启浏览器后确认扩展重载情况，并复现「点复选框方块不勾上」。
 * 先跑一遍带诊断的扩展（dist 副本里有 document.__XYLOG / __XYDBG）。
 */
const CDP = require('./cdp.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STATE = `
  var cards = (window.__XY__ && window.__XY__.getCards && window.__XY__.getCards()) || [];
  return {
    ver: window.__XY__ ? window.__XY__.v : null,
    hasXYLOG: typeof document.__XYLOG,
    hasXYDBG: typeof document.__XYDBG,
    checks: document.querySelectorAll('.xy-check').length,
    injectedCards: cards.length,
    count: ((document.querySelector('.xy-pick-count')||{}).textContent)||null
  };
`;

// 点第一个复选框的 input，如实记录视觉与数据层的变化
const CLICK_INPUT = `
  var lab = document.querySelector('.xy-check[data-xy-id]');
  if (!lab) return { err: '没有复选框' };
  var inp = lab.querySelector('input');
  var before = inp.checked;
  inp.click();
  return {
    before: before,
    after: inp.checked,
    labOn: lab.classList.contains('xy-check-on')
  };
`;

(async () => {
  const b = await CDP.connect(9222);
  // attach 有 8s 超时，浏览器刚启动时容易超时，多试几次
  let page = null;
  for (let i = 0; i < 6 && !page; i++) {
    try { page = await b.attach(/1688\.com/); } catch (e) { await sleep(2500); }
  }
  if (!page) {
    page = await b.open('https://s.1688.com/selloffer/offer_search.htm?keywords=' + encodeURIComponent('手机支架'));
    await sleep(10000);
  }

  console.log('=== 页面状态 ===');
  console.log(JSON.stringify(await page.evaluate(STATE), null, 1));

  console.log('\n=== 点 input 方块 ===');
  console.log(JSON.stringify(await page.evaluate(CLICK_INPUT), null, 1));
  await sleep(500);
  const s = await page.evaluate(STATE);
  console.log('  勾选数: ' + s.count + ' / XYLOG: ' + s.hasXYLOG);
  const log = await page.evaluate('return document.__XYLOG || null;');
  console.log('  XYLOG: ' + JSON.stringify(log));

  await b.close();
})();
