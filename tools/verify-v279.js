/**
 * 真机确认：当前页面跑的是哪一份 bridge.js？
 *
 * 内容脚本的闭包变量从外面读不到，但可以用 CDP 的 Debugger 把
 * 已加载的脚本源码抓下来 grep —— 这样不用重启浏览器就能确认
 * 「dataOf 这个修复到底有没有进到页面」。
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

  const scripts = [];
  page.on && page.on('Debugger.scriptParsed', (p) => scripts.push(p));
  await page.send('Debugger.enable');
  await sleep(1500);

  const hit = scripts.filter((s) => /content\/bridge\.js$/.test(s.url || ''));
  if (!hit.length) {
    console.log('没抓到 bridge.js 的脚本条目，Debugger 可能没订阅上');
    console.log('已解析脚本示例：', scripts.slice(0, 5).map((s) => s.url).join('\n  '));
    await b.close();
    return;
  }

  for (const s of hit) {
    const r = await page.send('Debugger.getScriptSource', { scriptId: s.scriptId });
    const src = (r && r.scriptSource) || '';
    console.log('脚本:', s.url);
    console.log('  有 dataOf():', src.includes('function dataOf(id)'));
    console.log('  仍有旧写法 detailMap[id] || cardIndex[id] || {}:', src.includes('detailMap[id] || cardIndex[id] || {}'));
    console.log('  长度:', src.length);
  }

  await page.send('Debugger.disable');
  await b.close();
})();
