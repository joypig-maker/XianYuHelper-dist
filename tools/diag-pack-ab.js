/**
 * 判定「已勾选 N 个但打包说没有可处理的商品」卡在哪。
 *
 * 两条勾选路径共用同一份 selected，但写入的 key 不一定一致：
 *   · 面板清单 .xy-pick-row  → data-xy-id 是 cardList 里的真实 itemId
 *   · 页面复选框 .xy-check   → key 来自 attachOne(itemId)，可能为 undefined
 * 若前者能打包、后者不能，问题就在页面复选框写进 selected 的 key。
 */
const CDP = require('./cdp.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const toastExpr = `return (document.getElementById('xy-toast')||{}).textContent || null;`;
// 注意：这个要当作「表达式」嵌进更大的语句里，所以不能自带 return
const countExpr = `(document.querySelector('.xy-pick-count')||{}).textContent || null`;

// 清干净，避免上次的勾选干扰
const CLEAR = `
  var nb = document.querySelector('.xy-btn[data-act="sel-none"]');
  if (nb) nb.click();
  return { cleared: !!nb, count: ${countExpr} };
`;

// 用面板清单里的真实 itemId 勾选第一条
const PICK_ROW = `
  var row = document.querySelector('.xy-pick-row');
  if (!row) return { err: '面板里没有选品行' };
  var id = row.getAttribute('data-xy-id');
  var box = row.querySelector('input[type=checkbox]');
  if (box && !box.checked) box.click();
  return { id: id, count: ${countExpr} };
`;

const PACK = `
  var b = document.querySelector('.xy-btn[data-act="b-pack"]');
  if (!b) return { err: '没有 b-pack 按钮' };
  b.click();
  return { clicked: true };
`;

const PAGE_CHECK_ID = `
  // 页面上已勾的那个复选框，它的容器里能不能反推出 offerId
  var boxes = document.querySelectorAll('.xy-check');
  var out = [];
  for (var i = 0; i < boxes.length && i < 5; i++) {
    var host = boxes[i].parentElement || boxes[i].parentNode;
    out.push({
      cls: (host.className || '').toString().slice(0, 60),
      offerId: (host.getAttribute && (host.getAttribute('data-offer-id') || host.getAttribute('data-itemid'))) || null,
      checked: !!boxes[i].querySelector('input') ? boxes[i].querySelector('input').checked : null
    });
  }
  return out;
`;

(async () => {
  const b = await CDP.connect(9222);
  const page = await b.attach(/1688\.com/);
  if (!page) { console.log('没有开着的 1688 标签'); await b.close(); return; }

  console.log('--- A. 清空勾选 ---');
  console.log(JSON.stringify(await page.evaluate(CLEAR), null, 2));
  await sleep(400);
  console.log('   toast: ' + (await page.evaluate(toastExpr)));

  console.log('\n--- B. 用面板清单的真实 id 勾选 ---');
  const pb = await page.evaluate(PICK_ROW);
  console.log(JSON.stringify(pb, null, 2));
  await sleep(400);
  console.log('   count: ' + (await page.evaluate(countExpr)));

  console.log('\n--- C. 点打包 ---');
  await page.evaluate(PACK);
  for (const ms of [1200, 2500]) {
    await sleep(ms);
    console.log('   +' + ms + 'ms toast: ' + (await page.evaluate(toastExpr)));
  }

  console.log('\n--- D. 页面复选框的容器属性 ---');
  console.log(JSON.stringify(await page.evaluate(PAGE_CHECK_ID), null, 2));

  await b.close();
})();
