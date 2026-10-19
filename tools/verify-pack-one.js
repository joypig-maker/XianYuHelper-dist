/**
 * 最小化：只点一个方框，观察 selected 与打包结果。
 * 并对比面板清单勾选（不走站点拦截的那条路）能否打包成功。
 */
const CDP = require('./cdp.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const COUNT = `return ((document.querySelector('.xy-pick-count')||{}).textContent)||null;`;
const TOAST = `return ((document.getElementById('xy-toast')||{}).textContent)||null;`;

const CLICK_ONE = `
  var lab = document.querySelector('.xy-check[data-xy-id]');
  if (!lab) return 'no-check';
  var inp = lab.querySelector('input');
  inp.click();
  return {
    id: lab.getAttribute('data-xy-id'),
    xyOn: inp.__xyOn,
    nowChecked: inp.checked,
    labOn: lab.classList.contains('xy-check-on')
  };
`;

const PACK = `
  var b = document.querySelector('.xy-btn[data-act="b-pack"]');
  if (!b) return 'no-btn';
  b.click();
  return 'clicked';
`;

const CLEAR = `
  var nb = document.querySelector('.xy-btn[data-act="sel-none"]');
  if (nb) nb.click();
  return 'cleared';
`;

const PICK_ROW = `
  var row = document.querySelector('.xy-pick-row');
  if (!row) return 'no-row';
  var box = row.querySelector('input');
  box.click();
  return { id: row.getAttribute('data-xy-id'), xyOn: box.__xyOn, checked: box.checked };
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
    const st = await page.evaluate(`return document.querySelectorAll('.xy-check[data-xy-id]').length;`);
    if (st > 0) break;
    await sleep(2000); waited += 2000;
  }

  console.log('--- A. 只点一个方框 ---');
  await page.evaluate(CLEAR); await sleep(300);
  console.log('  ' + JSON.stringify(await page.evaluate(CLICK_ONE)));
  await sleep(400);
  console.log('  count: ' + (await page.evaluate(COUNT)));
  console.log('  ' + (await page.evaluate(PACK)));
  for (const ms of [1200, 2500, 4500]) { await sleep(ms); console.log('  +' + ms + 'ms: ' + (await page.evaluate(TOAST))); }

  console.log('\n--- B. 面板清单勾选（不经站点拦截）---');
  await page.evaluate(CLEAR); await sleep(300);
  console.log('  ' + JSON.stringify(await page.evaluate(PICK_ROW)));
  await sleep(400);
  console.log('  count: ' + (await page.evaluate(COUNT)));
  console.log('  ' + (await page.evaluate(PACK)));
  for (const ms of [1200, 2500, 4500]) { await sleep(ms); console.log('  +' + ms + 'ms: ' + (await page.evaluate(TOAST))); }

  await b.close();
})();
