/**
 * 重载扩展。
 *
 * chrome://extensions 的重载按钮在 shadow DOM 里，JS click 之前试过不通；
 * 而 popup 页里没有 chrome.runtime。真正的入口是 **content script 的世界**：
 * MV3 的 content script 能拿到 chrome.runtime，即使页面没给它 host 权限
 * （reload 属于 runtime 自身能力，不需要跨域权限），
 * 且 reload 影响的是整个扩展，与当前页面无关。
 *
 * CDP 的 Runtime.evaluate 默认跑在页面主世界，必须指定 contextId 才能进
 * content script 的世界。contextId 从 Runtime.executionContextCreated 拿。
 */
const CDP = require('./cdp.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await CDP.connect(9222);
  const page = await b.attach(/1688\.com/);
  if (!page) {
    // 没有 1688 标签就直接开一个，只为了能拿到 content script 世界
    const p = await b.open('https://www.1688.com/');
    await sleep(5000);
    await b.close();
    console.log('(改用新标签)');
    return;
  }

  const contexts = await page.send('Runtime.executionContextsCleared').catch(() => null);
  await page.send('Runtime.enable');
  await sleep(300);

  // 触发一次世界创建，拿到所有上下文
  const all = await page.send('Runtime.evaluate', { expression: '1' }).catch(() => null);

  const list = await page.send('Runtime.executionContextCreated').catch(() => null);
  let found = [];
  try {
    const res = await page.send('Runtime.evaluate', {
      expression: `({
        keys: Object.keys(window).length,
        cs: !!window.chrome && !!window.chrome.runtime
      })`
    });
    found = res;
  } catch (e) {}

  console.log('主世界探测: ' + JSON.stringify(found));

  await b.close();
})();
