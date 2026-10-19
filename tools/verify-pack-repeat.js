/**
 * 连续多轮打包，并把 callBg 留下的现场（data-xyerr）一起读出来。
 * 两种异常都要抓：卡的（一直停在「正在补齐…」）和报「批量打包失败：…」的。
 */
const CDP = require('./cdp.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CLICK = (n) => `
  var labs = document.querySelectorAll('.xy-check[data-xy-id]');
  var inp = labs[${n}] && labs[${n}].querySelector('input');
  if (!inp) return 'no-box';
  inp.click(); return labs[${n}].getAttribute('data-xy-id');
`;

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

  const DONE = /完成|失败|没有可处理|已保存/;
  const pick = (n) => page.evaluate(CLICK(n));
  const pack = () => page.evaluate(`var b=document.querySelector('.xy-btn[data-act="b-pack"]'); if(b) b.click(); return 'clicked';`);
  const toast = () => page.evaluate(`return ((document.getElementById('xy-toast')||{}).textContent)||'';`);
  const dump = () => page.evaluate(`return document.documentElement.getAttribute('data-xyerr');`);

  const round = async (label) => {
    await page.evaluate(`var nb=document.querySelector('.xy-btn[data-act="sel-none"]'); if(nb) nb.click(); return 1;`);
    await sleep(400);
    await pick(0); await sleep(250);
    await pick(4); await sleep(250);
    await pick(8); await sleep(250);
    if (label) { await sleep(label); }           // 可选：先静置一段时间
    await pack();
    let t = '', used = 0;
    for (let i = 0; i < 12; i++) {
      await sleep(2000); used += 2000;
      t = await toast();
      if (DONE.test(t)) break;
    }
    const err = await dump();
    const bad = /失败/.test(t) || !DONE.test(t);
    console.log(`[${label === 0 ? '立即' : '静置' + label + 'ms'}] ${(used / 1000).toFixed(0)}s → ${t}${bad ? '   <<< 异常' : ''}`);
    if (err) console.log('  现场: ' + err.replace(/\n/g, '\n         ').slice(0, 900));
  };

  for (let r = 1; r <= 3; r++) await round(0);
  await round(40000);      // 静置 40s，等 service worker 被回收后再打包
  await round(0);

  await b.close();
})();
