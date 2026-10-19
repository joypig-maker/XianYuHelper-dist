/**
 * 确认页面里跑的扩展是不是我改过的那份：
 * dist 副本里加了 document.__XYLOG / document.__XYDBG 两段诊断，
 * src 里没有。它们存在就说明加载的是 dist 副本。
 */
const CDP = require('./cdp.js');

const PROBE = `
  return {
    hasXYLOG: typeof document.__XYLOG,
    xyLogLen: (document.__XYLOG || []).length,
    hasXYDBG: typeof document.__XYDBG,
    xyDBG: document.__XYDBG || null
  };
`;

(async () => {
  const b = await CDP.connect(9222);
  const page = await b.attach(/1688\.com/);
  if (!page) { console.log('没有开着的 1688 标签'); await b.close(); return; }
  console.log(JSON.stringify(await page.evaluate(PROBE), null, 1));
  await b.close();
})();
