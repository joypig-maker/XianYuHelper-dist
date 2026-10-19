/**
 * 干净对照：清空后分别「点 input」与「点 label」，
 * 看视觉状态（input.checked / 高亮）与数据层（已勾选 N 个）是否一致。
 *
 * 要回答的问题：用户看到「勾上了」，但打包说没有可处理的商品——
 * 如果视觉变了而数据层没变，就说明 input 的默认勾选被保留、但 setSelected 没走到。
 */
const CDP = require('./cdp.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const count = `return ((document.querySelector('.xy-pick-count')||{}).textContent)||null;`;

const CLEAR = `
  var nb = document.querySelector('.xy-btn[data-act="sel-none"]');
  if (nb) nb.click();
  return 'cleared';
`;

const CLICK_INPUT = `
  var lab = document.querySelector('.xy-check[data-xy-id]');
  if (!lab) return { err: '没有页面复选框' };
  var inp = lab.querySelector('input');
  var before = inp.checked;
  inp.click();
  return {
    id: lab.getAttribute('data-xy-id'),
    inputBefore: before,
    inputAfter: inp.checked,
    labOnBefore: null,
    labOnAfter: lab.classList.contains('xy-check-on')
  };
`;

const CLICK_LABEL = `
  var lab = document.querySelector('.xy-check[data-xy-id]');
  if (!lab) return { err: '没有页面复选框' };
  var inp = lab.querySelector('input');
  var before = inp.checked;
  lab.click();
  return {
    id: lab.getAttribute('data-xy-id'),
    inputBefore: before,
    inputAfter: inp.checked,
    labOnAfter: lab.classList.contains('xy-check-on')
  };
`;

(async () => {
  const b = await CDP.connect(9222);
  const page = await b.attach(/1688\.com/);
  if (!page) { console.log('没有开着的 1688 标签'); await b.close(); return; }

  for (const [name, expr] of [['点 input 自身', CLICK_INPUT], ['点 label', CLICK_LABEL]]) {
    console.log('\n--- ' + name + ' ---');
    console.log(JSON.stringify(await page.evaluate(CLEAR)));
    await sleep(350);
    console.log('  清空后 count: ' + (await page.evaluate(count)));

    const r = await page.evaluate(expr);
    console.log('  ' + JSON.stringify(r));
    await sleep(350);
    console.log('  count: ' + (await page.evaluate(count)));
  }

  await b.close();
})();
