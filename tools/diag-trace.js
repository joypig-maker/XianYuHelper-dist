/**
 * 用 DOM 属性（跨世界共享）追踪 window 委托是否被触发。
 * document.__XYTRACE 这类 JS 属性在隔离世界之间不共享，必须用 setAttribute。
 */
const CDP = require('./cdp.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TRACE = `return document.documentElement.getAttribute('data-xytrace');`;
const COUNT = `return ((document.querySelector('.xy-pick-count')||{}).textContent)||null;`;

const CLICK_INPUT = `
  document.documentElement.setAttribute('data-xytrace', '');
  var lab = document.querySelector('.xy-check[data-xy-id]');
  if (!lab) return { err: '没有复选框' };
  var inp = lab.querySelector('input');
  inp.click();
  return { after: inp.checked };
`;

const CLICK_LABEL = `
  document.documentElement.setAttribute('data-xytrace', '');
  var lab = document.querySelector('.xy-check[data-xy-id]');
  if (!lab) return { err: '没有复选框' };
  lab.click();
  return { ok: true };
`;

(async () => {
  const b = await CDP.connect(9222);
  let page = null;
  for (let i = 0; i < 6 && !page; i++) {
    try { page = await b.attach(/1688\.com/); } catch (e) { await sleep(2500); }
  }
  if (!page) { console.log('没有开着的 1688 标签'); await b.close(); return; }

  console.log('--- 点 input ---');
  console.log('  ' + JSON.stringify(await page.evaluate(CLICK_INPUT)));
  await sleep(400);
  console.log('  trace: ' + (await page.evaluate(TRACE)));
  console.log('  count: ' + (await page.evaluate(COUNT)));

  console.log('\n--- 点 label ---');
  console.log('  ' + JSON.stringify(await page.evaluate(CLICK_LABEL)));
  await sleep(400);
  console.log('  trace: ' + (await page.evaluate(TRACE)));
  console.log('  count: ' + (await page.evaluate(COUNT)));

  await b.close();
})();
