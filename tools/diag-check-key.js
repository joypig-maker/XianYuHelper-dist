/**
 * 「已勾选 N 个却提示没有可处理的商品」的定点实验。
 *
 * 勾选后把「复选框自己的 data-xy-id」与「注入脚本里的卡片数据」对上，
 * 看 selected 里那个 key 到底指向什么。
 */
const CDP = require('./cdp.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CLEAR = `
  var nb = document.querySelector('.xy-btn[data-act="sel-none"]');
  if (nb) nb.click();
  return 'cleared';
`;

// 勾第一个页面复选框，然后把所有复选框的 id/checked 列出来
const CLICK_ONE = `
  var labs = document.querySelectorAll('.xy-check[data-xy-id]');
  var res = { n: labs.length, states: [] };
  if (labs.length) {
    var inp = labs[0].querySelector('input');
    if (inp && !inp.checked) inp.click();
  }
  for (var i = 0; i < labs.length; i++) {
    res.states.push({
      id: labs[i].getAttribute('data-xy-id'),
      on: labs[i].classList.contains('xy-check-on')
    });
  }
  res.count = (document.querySelector('.xy-pick-count') || {}).textContent || null;
  return res;
`;

// 拿注入脚本侧的卡片数据，看 selected 里那个 key 对应什么
const LOOKUP = `
  var cards = (window.__XY__ && window.__XY__.getCards && window.__XY__.getCards()) || [];
  var byId = {};
  for (var i = 0; i < cards.length; i++) byId[cards[i].itemId] = cards[i];
  var on = [];
  var labs = document.querySelectorAll('.xy-check[data-xy-id]');
  for (var j = 0; j < labs.length; j++) {
    if (labs[j].classList.contains('xy-check-on')) on.push(labs[j].getAttribute('data-xy-id'));
  }
  return {
    checked: on,
    detail: on.map(function (id) {
      var c = byId[id] || {};
      return {
        id: id,
        inCards: !!byId[id],
        title: (c.title || '').slice(0, 20),
        image: (c.image || '').slice(0, 50),
        imagesN: (c.images || []).length
      };
    })
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
  console.log(await page.evaluate(CLEAR));
  await sleep(400);

  console.log('\n--- 勾第一个页面复选框 ---');
  const r = await page.evaluate(CLICK_ONE);
  console.log('复选框总数: ' + r.n + ' / count: ' + r.count);
  console.log('被勾上的: ' + JSON.stringify(r.states.filter((s) => s.on)));

  await sleep(500);
  console.log('\n--- 对照注入脚本的卡片数据 ---');
  console.log(JSON.stringify(await page.evaluate(LOOKUP), null, 2));

  console.log('\n--- 点打包 ---');
  console.log(await page.evaluate(PACK));
  for (const ms of [1200, 2600]) {
    await sleep(ms);
    console.log('  +' + ms + 'ms: ' +
      (await page.evaluate(`return (document.getElementById('xy-toast')||{}).textContent || null;`)));
  }

  await b.close();
})();
