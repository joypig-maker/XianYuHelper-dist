/**
 * 端到端：用「点方框」的方式勾两个商品，再点「勾选一键打包」，
 * 确认不再出现「没有可处理的商品」，而是走正常的补详情/打包。
 */
const CDP = require('./cdp.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STATE = `
  return {
    checks: document.querySelectorAll('.xy-check').length,
    count: ((document.querySelector('.xy-pick-count')||{}).textContent)||null
  };
`;

const COUNT = `return ((document.querySelector('.xy-pick-count')||{}).textContent)||null;`;
const TOAST = `return ((document.getElementById('xy-toast')||{}).textContent)||null;`;

// 像用户那样点方框，勾前两个
const PICK_TWO = `
  var labs = document.querySelectorAll('.xy-check[data-xy-id]');
  var n = 0;
  for (var i = 0; i < labs.length && n < 2; i++) {
    var inp = labs[i].querySelector('input');
    if (inp && !inp.__xyOn) { inp.click(); n++; }
  }
  return { clicked: n };
`;

const PACK = `
  var b = document.querySelector('.xy-btn[data-act="b-pack"]');
  if (!b) return 'no-btn';
  b.click();
  return 'clicked';
`;

(async () => {
  const b = await CDP.connect(9222);
  let page = null;
  for (let i = 0; i < 6 && !page; i++) {
    try { page = await b.attach(/1688\.com/); } catch (e) { await sleep(2500); }
  }
  if (!page) { console.log('没有开着的 1688 标签'); await b.close(); return; }

  let waited = 0;
  while (waited < 45000) {
    const st = await page.evaluate(STATE);
    if (st.checks > 0) break;
    await sleep(2000); waited += 2000;
  }

  console.log('--- 点方框勾选 2 个 ---');
  console.log('  ' + JSON.stringify(await page.evaluate(PICK_TWO)));
  await sleep(500);
  console.log('  count: ' + (await page.evaluate(COUNT)));

  console.log('\n--- 点「勾选一键打包」---');
  console.log('  ' + (await page.evaluate(PACK)));
  for (const ms of [1500, 3000, 6000]) {
    await sleep(ms);
    console.log('  +' + ms + 'ms toast: ' + (await page.evaluate(TOAST)));
  }

  await b.close();
})();
