/**
 * 复现「1688 提示没有可以处理的商品」。
 *
 * 提示有两层，先分清卡在哪层：
 *   withEnrichedSelected: '请先在页面上勾选要处理的商品'   ← selected 为空
 *   batchPack           : '没有可处理的商品'               ← selected 非空但 items 为空
 *
 * bridge 的 selected / cardIndex 是闭包私有，页面里读不到，
 * 但以下三处可以观测（这也是本脚本的取值来源）：
 *   · #xy-toast 的文本（toast 会写 textContent）
 *   · .xy-pick-count 的「已勾选 N 个」
 *   · 注入脚本的 __XY__.getCards()
 */
const CDP = require('./cdp.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 注意：cdp.evaluate 会包成 (()=>{ EXPR })()，探针里不要再自带外层包裹
const STEP1 = `
  var tp = document.getElementById('xy-toast');
  var cards = (window.__XY__ && window.__XY__.getCards && window.__XY__.getCards()) || [];
  var panel = document.getElementById('xy-panel');
  return {
    url: location.href.slice(0, 90),
    ver: window.__XY__ ? window.__XY__.v : null,
    hasPanel: !!panel,
    panelVisible: panel ? (panel.style.display !== 'none') : null,
    checkCount: document.querySelectorAll('.xy-check').length,
    injectedCards: cards.length,
    // 卡片数据长什么样：图文是否齐全
    sample: cards.slice(0, 3).map(function (c) {
      return {
        id: c.itemId,
        title: (c.title || '').slice(0, 18),
        hasTitle: !!c.title,
        hasDesc: !!c.desc,
        image: (c.image || '').slice(0, 60),
        imagesN: (c.images || []).length,
        skus: c.skus ? c.skus.list.length : 0
      };
    }),
    toast: tp ? tp.textContent : null
  };
`;

const STEP2 = `
  var boxes = document.querySelectorAll('.xy-check input[type=checkbox], .xy-check input');
  var n = 0;
  for (var i = 0; i < boxes.length && i < 3; i++) {
    if (!boxes[i].checked) { boxes[i].click(); n++; }
  }
  return { clicked: n, toast: (document.getElementById('xy-toast') || {}).textContent || null };
`;

const STEP3 = `
  var tp = document.getElementById('xy-toast');
  var cnt = document.querySelector('.xy-pick-count');
  return {
    toast: tp ? tp.textContent : null,
    pickCount: cnt ? cnt.textContent : null
  };
`;

const STEP4 = `
  var b = document.querySelector('.xy-btn[data-act="b-pack"]');
  if (!b) return { err: '面板里没有 b-pack 按钮，面板可能没打开' };
  b.click();
  return { clicked: true };
`;

(async () => {
  const b = await CDP.connect(9222);
  const page = await b.attach(/1688\.com/);
  if (!page) { console.log('没有开着的 1688 标签'); await b.close(); return; }

  console.log('=== 1. 当前页面状态 ===');
  const s1 = await page.evaluate(STEP1);
  console.log(JSON.stringify(s1, null, 2));

  console.log('\n=== 2. 模拟勾选前 3 个页面复选框 ===');
  const s2 = await page.evaluate(STEP2);
  console.log(JSON.stringify(s2, null, 2));

  await sleep(600);
  console.log('\n=== 3. 勾选后的反馈 ===');
  console.log(JSON.stringify(await page.evaluate(STEP3), null, 2));

  console.log('\n=== 4. 点「勾选一键打包」 ===');
  const s4 = await page.evaluate(STEP4);
  console.log(JSON.stringify(s4, null, 2));

  for (const ms of [1200, 2500, 4000]) {
    await sleep(ms);
    const t = await page.evaluate(`return (document.getElementById('xy-toast')||{}).textContent || null;`);
    console.log('  +' + ms + 'ms toast: ' + t);
  }

  await b.close();
})();
