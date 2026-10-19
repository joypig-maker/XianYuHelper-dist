/**
 * 追踪 chk 分支内部：是否命中、turnOn 算成什么、preventDefault 状态、
 * 手动设置之后 checked 又变成什么。
 */
const CDP = require('./cdp.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const T1 = `return document.documentElement.getAttribute('data-xytrace');`;
const T2 = `return document.documentElement.getAttribute('data-xytrace2');`;
const T3 = `return document.documentElement.getAttribute('data-xytrace3');`;
const COUNT = `return ((document.querySelector('.xy-pick-count')||{}).textContent)||null;`;

const CLICK_INPUT = `
  document.documentElement.setAttribute('data-xytrace', '');
  document.documentElement.setAttribute('data-xytrace2', '');
  document.documentElement.setAttribute('data-xytrace3', '');
  var lab = document.querySelector('.xy-check[data-xy-id]');
  var inp = lab.querySelector('input');
  inp.click();
  return { after: inp.checked };
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
  await sleep(500);
  console.log('  trace  : ' + (await page.evaluate(T1)));
  console.log('  trace2 : ' + (await page.evaluate(T2)));
  console.log('  trace3 : ' + (await page.evaluate(T3)));
  console.log('  count  : ' + (await page.evaluate(COUNT)));

  await b.close();
})();
