/**
 * 清理调试实例里堆积的标签页，并验证详情页有没有 lib.mtop
 *
 * 前面的诊断脚本每次 createTarget 都可能留下 about:blank，
 * 堆多了之后 Target.createTarget 会开始超时——这也是为什么上一轮探测中断。
 */
'use strict';

const CDP = require('./cdp');

(async () => {
  const b = await CDP.connect(9222);
  const tabs = await b.list();
  console.log('=== 当前标签 ' + tabs.length + ' 个 ===');
  tabs.forEach((t) => console.log('  ' + t.type + '  ' + String(t.url || '').slice(0, 80)));

  // 关掉 about:blank 这类空标签，保留有内容的
  let closed = 0;
  for (const t of tabs) {
    if (t.type !== 'page') continue;
    if (/^about:blank$/.test(t.url || '')) {
      try {
        await b.send('Target.closeTarget', { targetId: t.id });
        closed++;
      } catch (e) { /* 忽略 */ }
    }
  }
  console.log('已关闭空标签:', closed);

  const after = await b.list();
  console.log('清理后剩余:', after.length);

  // 验证详情页的 mtop 环境
  const { targetId } = await b.createTarget('about:blank');
  const page = await b.attachTarget({ id: targetId });
  try {
    await page.goto('https://detail.tmall.com/item.htm?id=669745626548', 45000);
    await new Promise((r) => setTimeout(r, 6000));
    const r = await page.evaluate(`return (function(){
      var lib = window.lib || {};
      return {
        host: location.host,
        有_lib_mtop: !!(lib.mtop && typeof lib.mtop.request === 'function'),
        lib键: Object.keys(lib).slice(0, 12),
        有video标签: document.querySelectorAll('video').length,
        主图张数: document.querySelectorAll('[class*="thumbnails"] img,[class*="Thumbnail"] img').length,
        价格文本: (function(){
          var e = document.querySelector('[class*="priceText"],[class*="Price--"]');
          return e ? e.innerText.replace(/\\s+/g,' ').slice(0,40) : '';
        })()
      };
    })()`);
    console.log('\n=== 详情页环境 ===');
    console.log(JSON.stringify(r, null, 1));
  } catch (e) {
    console.log('详情页验证失败:', e.message);
  }
  await page.close();
  await b.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
