/**
 * 真机端到端：在淘宝搜索页走「勾选 → 补详情」这条真实路径。
 *
 * 在扩展自己的 ISOLATED world 里以 bridge 的身份问 injected 要卡片、
 * 再让它补详情——和用户点打包按钮时走的完全是同一条路：
 *   bridge → injected.ensureCardsDetail → fetchCardDetail
 *     → （淘宝详情接口只认详情页）→ SW 开后台标签页 → 详情页采集
 *
 * 用法：node tools/verify-tb-pack-live.js [补几个]
 */
'use strict';
const CDP = require('./cdp');

const N = Number(process.argv[2] || 2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await CDP.connect(9222);
  const page = await b.open('https://s.taobao.com/search?q=' + encodeURIComponent('手机支架'));

  const ctxs = [];
  page.on('Runtime.executionContextCreated', (p) => ctxs.push(p.context));
  await page.send('Runtime.enable');

  // 等扩展注入 + 采集跑完
  await sleep(9000);

  const iso = ctxs.filter((c) => c.auxData && c.auxData.isDefault === false).pop();
  if (!iso) {
    console.log('✗ 没有 ISOLATED world —— 扩展没注入');
    await b.close();
    process.exit(1);
  }
  console.log('ISOLATED context id=' + iso.id + '（同名上下文 ' +
    ctxs.filter((c) => c.auxData && c.auxData.isDefault === false).length + ' 个）');

  async function ask(expr) {
    const r = await page.send('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true, contextId: iso.id
    });
    if (r.exceptionDetails) {
      throw new Error('页面异常: ' + String(r.exceptionDetails.exception &&
        r.exceptionDetails.exception.description || '?').slice(0, 180));
    }
    return r.result ? r.result.value : null;
  }

  const expr = `
    (async function () {
      var ch = window.XYPostBus.channel('bridge');

      // 直接从前端 DOM 取真实商品 ID。
      // 不用 injected 的 get-cards：那个 handler 只负责「触发一次扫描 + 把结果 push 给
      // bridge」，回包恒为 null，拿它当取列表的接口会永远得到空数组。
      var seen = {}, ids = [];
      Array.prototype.forEach.call(
        document.querySelectorAll('a[data-spm-act-id]'),
        function (el) {
          var v = String(el.getAttribute('data-spm-act-id') || '').trim();
          if (/^\\d{6,20}$/.test(v) && !seen[v]) { seen[v] = 1; ids.push(v); }
        });
      if (!ids.length) return { error: '页面上没有带 data-spm-act-id 的商品' };

      var pick = ids.slice(0, ${N});
      var out = [];
      var t0 = Date.now();
      for (var i = 0; i < pick.length; i++) {
        var s = Date.now();
        var r = await ch.ask('bridge', 'bg-detail', { itemId: pick[i] }, { timeout: 60000 });
        var d = (r && r.detail) || null;
        out.push({
          id: pick[i],
          ms: Date.now() - s,
          ok: !!(r && r.ok),
          error: (r && r.error) || '',
          title: d ? String(d.title || '').slice(0, 20) : '',
          price: (d && d.price) || '',
          images: d ? (d.images || []).length : 0
        });
      }
      return { found: ids.length, asked: pick.length, totalMs: Date.now() - t0, items: out };
    })()`;

  const out = await ask(expr);
  console.log('\n结果：');
  console.log('  ' + JSON.stringify(out, null, 1).split('\n').join('\n  '));

  const items = (out && out.items) || [];
  const good = items.length > 0 && items.every((it) => it.images >= 5);
  console.log('\n' + (good
    ? '✓ 补齐生效：' + items.map((i) => i.images).join(' / ') + ' 张图'
    : '✗ 未补齐'));

  await b.close();
  process.exit(good ? 0 : 1);
})().catch((e) => { console.error('ERR', e && e.message); process.exit(1); });
