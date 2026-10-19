/**
 * 打包筛空时，读 bridge 写下的 data-xynodebug，
 * 看 detailMap / cardIndex 里这件商品到底有没有 title / 图。
 */
const CDP = require('./cdp.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CLICK_ONE = `
  var lab = document.querySelector('.xy-check[data-xy-id]');
  if (!lab) return 'no-check';
  lab.querySelector('input').click();
  return 'clicked';
`;

const PACK = `
  var b = document.querySelector('.xy-btn[data-act="b-pack"]');
  if (!b) return 'no-btn';
  b.click();
  return 'clicked';
`;

const DUMP = `return document.documentElement.getAttribute('data-xynodebug');`;

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

  console.log('点第一个方框…');
  await page.evaluate(CLICK_ONE);
  await sleep(400);
  await page.evaluate(PACK);
  await sleep(2500);

  const dump = await page.evaluate(DUMP);
  console.log('\n=== batchPack 筛空时的状态 ===');
  console.log(dump ? JSON.stringify(JSON.parse(dump), null, 1) : '(没有 dump)');

  await b.close();
})();
