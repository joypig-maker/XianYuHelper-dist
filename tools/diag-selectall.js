/**
 * 对照实验：面板「全选」(key 来自 cardList) vs 页面复选框 (key 来自 attachOne)。
 * 若全选能打包、点复选框不行，问题就在页面复选框写进 selected 的 key。
 */
const CDP = require('./cdp.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const toast = `return (document.getElementById('xy-toast')||{}).textContent || null;`;
const count = `return ((document.querySelector('.xy-pick-count')||{}).textContent)||null;`;

const CLEAR = `
  var nb = document.querySelector('.xy-btn[data-act="sel-none"]');
  if (nb) nb.click();
  return 'cleared';
`;

// 面板「全选」按钮
const SELECT_ALL = `
  var b = document.querySelector('.xy-btn[data-act="sel-all"]');
  if (!b) return 'no-sel-all';
  b.click();
  return 'clicked';
`;

const REPORT = `
  var rows = document.querySelectorAll('.xy-pick-row[data-xy-id]');
  var on = [];
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].classList.contains('xy-check-on')) on.push(rows[i].getAttribute('data-xy-id'));
  }
  return {
    rows: rows.length,
    onRows: on.length,
    firstIds: rows.length ? rows[0].getAttribute('data-xy-id') : null
  };
`;

const PACK = `
  var b = document.querySelector('.xy-btn[data-act="b-pack"]');
  if (!b) return 'no-btn';
  b.click();
  return 'clicked';
`;

(async () => {
  const b = await CDP.connect(9222);
  const page = await b.attach(/1688\.com/);
  if (!page) { console.log('没有开着的 1688 标签'); await b.close(); return; }

  console.log('--- 清空 ---');
  await page.evaluate(CLEAR);
  await sleep(400);
  console.log('  count: ' + (await page.evaluate(count)));

  console.log('\n--- 面板「全选」---');
  console.log('  ' + JSON.stringify(await page.evaluate(SELECT_ALL)));
  await sleep(500);
  console.log('  ' + JSON.stringify(await page.evaluate(REPORT), null, 1));
  console.log('  count: ' + (await page.evaluate(count)));

  console.log('\n--- 点打包 ---');
  console.log('  ' + (await page.evaluate(PACK)));
  for (const ms of [1200, 2600, 5000]) {
    await sleep(ms);
    console.log('  +' + ms + 'ms toast: ' + (await page.evaluate(toast)));
  }

  await b.close();
})();
