/**
 * 逐一点方框勾 3 个商品，每次都重新查 DOM（模拟真人：每次点的是
 * 当前页面上的那个方框），观察计数变化，最后打包。
 *
 * 为什么每次都要重查：勾选会触发面板重渲染，旧的 DOM 节点会被换掉，
 * 拿过期节点点是没有意义的（事件到不了 window 上的委托）。
 */
const CDP = require('./cdp.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const COUNT = `return ((document.querySelector('.xy-pick-count')||{}).textContent)||null;`;
const TOAST = `return ((document.getElementById('xy-toast')||{}).textContent)||null;`;

const CLEAR = `
  var nb = document.querySelector('.xy-btn[data-act="sel-none"]');
  if (nb) nb.click();
  return (document.querySelector('.xy-pick-count')||{}).textContent || null;
`;

/* 点第 N 个方框（ Practice: 勾选会让面板重渲染，旧节点会被换掉，
 * 所以每次都必须重新查 DOM，不能复用上一次的节点。 */
const CLICK_IDX = `
  var labs = document.querySelectorAll('.xy-check[data-xy-id]');
  var inp = labs[__N__] && labs[__N__].querySelector('input');
  if (!inp) return 'no-box';
  var id = labs[__N__].getAttribute('data-xy-id');
  inp.click();
  return { id: id, xyOn: inp.__xyOn, checked: inp.checked, live: document.contains(inp) };
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
    const n = await page.evaluate(`return document.querySelectorAll('.xy-check[data-xy-id]').length;`);
    if (n > 0) break;
    await sleep(2000); waited += 2000;
  }

  console.log('清空:', await page.evaluate(CLEAR));
  await sleep(500);

  // 每次点不同的方框（1 / 5 / 9），模拟真人依次勾选多个商品
  for (const idx of [1, 5, 9]) {
    const r = await page.evaluate(CLICK_IDX.replace(/__N__/g, String(idx - 1)));
    await sleep(600);
    console.log('点第 ' + idx + ' 个方框: ' + JSON.stringify(r) + '  → ' + (await page.evaluate(COUNT)));
  }

  console.log('\n点「勾选一键打包」');
  console.log('  ' + (await page.evaluate(PACK)));
  for (const ms of [1500, 2000, 3000]) {
    await sleep(ms);
    console.log('  +' + ms + 'ms: ' + (await page.evaluate(TOAST)));
  }

  await b.close();
})();
