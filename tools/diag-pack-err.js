/**
 * 抓「批量打包失败：Cannot read properties of undefined (reading 'sendMessage')」
 * 的真实堆栈。
 *
 * 内容脚本里的 callBg() 有 try/catch，同步 TypeError 会被吞成
 * { ok:false, error:'Cannot read properties of undefined (reading 'sendMessage')' }，
 * 只凭这条消息看不出是谁调的。用 CDP 的 Runtime.exceptionThrown 能拿到完整 stack。
 */
const CDP = require('./cdp.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await CDP.connect(9222);
  let page = null;
  for (let i = 0; i < 6 && !page; i++) {
    try { page = await b.attach(/1688\.com/); } catch (e) { await sleep(2500); }
  }
  if (!page) { console.log('没有开着的 1688 标签'); await b.close(); return; }

  const errs = [];
  page.on('Runtime.exceptionThrown', (p) => {
    const d = p.exceptionDetails || {};
    errs.push({
      text: (d.exception && (d.exception.description || d.exception.value)) || d.text,
      stack: (d.stackTrace && d.stackTrace.callFrames || []).slice(0, 8)
        .map((f) => `    ${f.functionName || '(anon)'} @ ${(f.url || '').slice(-70)}:${f.lineNumber + 1}`)
    });
  });
  await page.send('Runtime.enable');
  await sleep(800);

  // 勾 2 个后打包
  const CLICK = (n) => `
    var labs = document.querySelectorAll('.xy-check[data-xy-id]');
    var inp = labs[${n}] && labs[${n}].querySelector('input');
    if (!inp) return 'no-box';
    inp.click(); return labs[${n}].getAttribute('data-xy-id');
  `;
  await page.evaluate(CLICK(0));
  await sleep(400);
  await page.evaluate(CLICK(4));
  await sleep(400);

  errs.length = 0;   // 只收集打包阶段产生的异常
  await page.evaluate(`
    var b = document.querySelector('.xy-btn[data-act="b-pack"]');
    if (b) b.click(); return 'clicked';
  `);
  await sleep(5000);

  console.log('打包期间捕获异常:', errs.length);
  errs.forEach((e, i) => {
    console.log(`\n--- [${i}] ${e.text}`);
    console.log(e.stack.join('\n'));
  });

  const toast = await page.evaluate(`return ((document.getElementById('xy-toast')||{}).textContent)||null;`);
  console.log('\ntoast:', toast);

  await b.close();
})();
