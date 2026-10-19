/**
 * 验证「点复选框方块能勾上」是否真的修好。
 * 复现用户路径：直接点 .xy-check 里的 input（不是 label），看数据层跟不跟。
 */
const CDP = require('./cdp.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STATE = `
  return {
    ver: window.__XY__ ? window.__XY__.v : null,
    checks: document.querySelectorAll('.xy-check').length,
    count: ((document.querySelector('.xy-pick-count')||{}).textContent)||null
  };
`;

// 用户最常点的那个小方块
const CLICK_INPUT = `
  var lab = document.querySelector('.xy-check[data-xy-id]');
  if (!lab) return { err: '没有复选框' };
  var inp = lab.querySelector('input');
  var id = lab.getAttribute('data-xy-id');
  var before = inp.checked;
  inp.click();
  return { id: id, before: before, after: inp.checked, labOn: lab.classList.contains('xy-check-on') };
`;

const CLICK_LABEL = `
  var lab = document.querySelector('.xy-check[data-xy-id]');
  if (!lab) return { err: '没有复选框' };
  lab.click();
  return { on: lab.classList.contains('xy-check-on') };
`;

(async () => {
  const b = await CDP.connect(9222);
  let page = null;
  for (let i = 0; i < 6 && !page; i++) {
    try { page = await b.attach(/1688\.com/); } catch (e) { await sleep(2500); }
  }
  if (!page) { console.log('没有开着的 1688 标签'); await b.close(); return; }

  // 等页面采集出商品再动手，否则复选框还没挂上
  let waited = 0;
  while (waited < 45000) {
    const st = await page.evaluate(STATE);
    if (st.checks > 0) break;
    await sleep(2000); waited += 2000;
  }
  console.log('=== 初始 ===');
  console.log(JSON.stringify(await page.evaluate(STATE), null, 1));

  console.log('\n--- 1) 点方框 input ---');
  console.log(JSON.stringify(await page.evaluate(CLICK_INPUT), null, 1));
  await sleep(400);
  console.log('  → ' + (await page.evaluate(STATE)).count);

  console.log('\n--- 2) 再点一次（应取消）---');
  console.log(JSON.stringify(await page.evaluate(CLICK_INPUT), null, 1));
  await sleep(400);
  console.log('  → ' + (await page.evaluate(STATE)).count);

  console.log('\n--- 3) 点周围空白 label ---');
  console.log(JSON.stringify(await page.evaluate(CLICK_LABEL), null, 1));
  await sleep(400);
  console.log('  → ' + (await page.evaluate(STATE)).count);

  await b.close();
})();
