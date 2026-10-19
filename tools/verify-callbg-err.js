/**
 * 打包一次，然后把 callBg() catch 里记下的堆栈读出来。
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

  await page.evaluate(`var nb=document.querySelector('.xy-btn[data-act="sel-none"]'); if(nb) nb.click(); return 1;`);
  await sleep(500);
  await page.evaluate(CLICK(0)); await sleep(400);
  await page.evaluate(CLICK(4)); await sleep(400);
  console.log('勾选:', await page.evaluate(`return ((document.querySelector('.xy-pick-count')||{}).textContent)||null;`));

  await page.evaluate(`var b=document.querySelector('.xy-btn[data-act="b-pack"]'); if(b) b.click(); return 'clicked';`);
  await sleep(5000);

  console.log('\ntoast:', await page.evaluate(`return ((document.getElementById('xy-toast')||{}).textContent)||null;`));
  const msg = await page.evaluate(`return document.documentElement.getAttribute('data-xyerrmsg');`);
  console.log('\nerror.message:', msg);
  const stack = await page.evaluate(`return document.documentElement.getAttribute('data-xyerr');`);
  console.log('\nstack:\n' + (stack || '(无)'));

  await b.close();
})();
