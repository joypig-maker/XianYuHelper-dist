/**
 * 查清 document 上的探针为什么收不到 click：
 * 事件是在哪一层被 stopPropagation 截断的。
 *
 * 探针挂在 window 捕获 / document 捕获 / document 冒泡 / body 捕获 四处。
 * 若 window 捕获收得到、document 捕获收不到 → 有人在 window 层截了。
 */
const CDP = require('./cdp.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const INSTALL = `
  window.__P = [];
  function note(where) { window.__P.push(where); }
  window.addEventListener('click', function (e) { note('win-capture'); }, true);
  document.addEventListener('click', function (e) { note('doc-capture'); }, true);
  document.addEventListener('click', function (e) { note('doc-bubble'); }, false);
  window.addEventListener('click', function (e) { note('win-bubble'); }, false);
  return 'ok';
`;

const RUN = `
  window.__P = [];
  var lab = document.querySelector('.xy-check[data-xy-id]');
  var inp = lab.querySelector('input');
  inp.click();
  return window.__P.slice();
`;

const RUN_LABEL = `
  window.__P = [];
  var lab = document.querySelector('.xy-check[data-xy-id]');
  lab.click();
  return window.__P.slice();
`;

const COUNT = `return ((document.querySelector('.xy-pick-count')||{}).textContent)||null;`;

(async () => {
  const b = await CDP.connect(9222);
  const page = await b.attach(/1688\.com/);
  if (!page) { console.log('没有开着的 1688 标签'); await b.close(); return; }

  await page.evaluate(INSTALL);
  console.log('探针已装');

  console.log('\n--- 点 input ---');
  console.log('  事件到达: ' + JSON.stringify(await page.evaluate(RUN)));
  await sleep(400);
  console.log('  count: ' + (await page.evaluate(COUNT)));

  console.log('\n--- 点 label ---');
  console.log('  事件到达: ' + JSON.stringify(await page.evaluate(RUN_LABEL)));
  await sleep(400);
  console.log('  count: ' + (await page.evaluate(COUNT)));

  await b.close();
})();
