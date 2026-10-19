/**
 * 读 batchPack 临时注入的 data-xydump（/tools/_inject_dump.js 注入的），
 * 看批量打包时到底收了几件商品、每件几张图、文案多长。
 */
const CDP = require('./cdp.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DUMP = `
  var el = document.documentElement;
  var v = el.getAttribute('data-xydump');
  el.removeAttribute('data-xydump');
  return v;
`;

(async () => {
  const b = await CDP.connect(9222);
  let page = null;
  for (let i = 0; i < 6 && !page; i++) {
    try { page = await b.attach(/1688\.com/); } catch (e) { await sleep(2500); }
  }
  if (!page) { console.log('没有开着的 1688 标签'); await b.close(); return; }

  for (let i = 0; i < 5; i++) {
    const d = await page.evaluate(DUMP);
    if (d) {
      let o;
      try { o = JSON.parse(d); } catch (e) { console.log('dump 解析失败:', d.slice(0, 200)); await b.close(); return; }
      console.log('勾选 ' + o.selCount + ' 件 → 进入打包 ' + o.itemCount + ' 件');
      (o.items || []).forEach((it, i) => {
        console.log('  [' + (i + 1) + '] 图 ' + it.imgN + ' 张 / 规格 ' + it.skuN +
          ' / 文案 ' + it.textN + ' 字 / ' + it.dir);
      });
      await b.close();
      return;
    }
    await sleep(1500);
  }
  console.log('没读到 dump（batchPack 还没执行过）');
  await b.close();
})();
