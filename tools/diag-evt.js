/**
 * 在页面里挂事件探针，查清「手动点复选框为什么不进 selected」。
 * 全部只依赖 DOM，不需要重载扩展。
 *
 * 已知事实（不需要再验）：
 *   · 面板「全选」→ 直接调 selectAll()，能打包
 *   · 手动点 .xy-check 的 input → selected 完全没变化
 * 所以差异只能出在 DOM 事件链上。
 */
const CDP = require('./cdp.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const INSTALL = `
  window.__EVT = [];
  function note(o) { window.__EVT.push(o); }
  document.addEventListener('click', function (e) {
    note({ phase: 'doc-capture', tag: e.target.tagName, dp: e.defaultPrevented });
  }, true);
  document.addEventListener('click', function (e) {
    note({ phase: 'doc-bubble', tag: e.target.tagName, dp: e.defaultPrevented });
  }, false);
  document.addEventListener('change', function (e) {
    note({ phase: 'doc-change', tag: e.target.tagName, checked: e.target.checked });
  }, true);
  return 'installed';
`;

const CLICK_INPUT = `
  var lab = document.querySelector('.xy-check[data-xy-id]');
  if (!lab) return { err: '没有页面复选框' };
  var inp = lab.querySelector('input');
  window.__EVT = [];
  var before = inp.checked;
  inp.click();
  return {
    id: lab.getAttribute('data-xy-id'),
    before: before,
    after: inp.checked,
    labOn: lab.classList.contains('xy-check-on'),
    count: ((document.querySelector('.xy-pick-count')||{}).textContent)||null
  };
`;

const CLICK_LABEL = `
  var lab = document.querySelector('.xy-check[data-xy-id]');
  if (!lab) return { err: '没有页面复选框' };
  window.__EVT = [];
  lab.click();
  return {
    labOn: lab.classList.contains('xy-check-on'),
    count: ((document.querySelector('.xy-pick-count')||{}).textContent)||null
  };
`;

(async () => {
  const b = await CDP.connect(9222);
  const page = await b.attach(/1688\.com/);
  if (!page) { console.log('没有开着的 1688 标签'); await b.close(); return; }

  console.log('安装探针: ' + await page.evaluate(INSTALL));

  console.log('\n=== A. 点 input 本身 ===');
  console.log(JSON.stringify(await page.evaluate(CLICK_INPUT), null, 1));
  console.log('  事件流: ' + JSON.stringify(await page.evaluate('return window.__EVT')));

  await sleep(400);

  console.log('\n=== B. 点 label（用户实际会点的地方更大）===');
  console.log(JSON.stringify(await page.evaluate(CLICK_LABEL), null, 1));
  console.log('  事件流: ' + JSON.stringify(await page.evaluate('return window.__EVT')));

  await b.close();
})();
