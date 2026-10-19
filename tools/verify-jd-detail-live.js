/**
 * 真机验证京东的详情补录（后台标签页 + DOM 解析）。
 *
 * 京东没有 mtop 这类接口，详情数据只能从详情页 DOM 里取，
 * 所以走的是：搜索页 → bridge → SW 开后台标签页 → 详情页 DOM 解析 → 回传。
 *
 * 用法：node tools/verify-jd-detail-live.js [关键词]
 */
'use strict';
const CDP = require('./cdp');

const KW = process.argv[2] || '手机支架';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await CDP.connect(9222);
  const page = await b.open('https://search.jd.com/Search?keyword=' + encodeURIComponent(KW) + '&enc=utf-8');

  const ctxs = [];
  page.on('Runtime.executionContextCreated', (p) => ctxs.push(p.context));
  await page.send('Runtime.enable');
  await sleep(10000);

  let iso = null;
  for (let i = ctxs.length - 1; i >= 0; i--) {
    const c = ctxs[i];
    if (!c.auxData || c.auxData.isDefault !== false) continue;
    const pr = await page.send('Runtime.evaluate', {
      expression: 'typeof window.XYUtil', returnByValue: true, contextId: c.id
    });
    if (pr.result && pr.result.value === 'object') { iso = c; break; }
  }
  if (!iso) { console.log('✗ 没找到装好 XYUtil 的 ISOLATED 上下文'); await b.close(); process.exit(1); }

  const out = await page.send('Runtime.evaluate', {
    expression: `
      (async function () {
        var U = window.XYUtil, S = window.XYSites;
        var site = S.match(location.host);
        var cards = U.scanCards(document, site);
        if (!cards.length) return { error: '搜索页没采到卡片' };
        var id = cards[0].itemId;
        var ch = window.XYPostBus.channel('bridge');
        var t0 = Date.now();
        var r = await ch.ask('bridge', 'bg-detail', { itemId: id }, { timeout: 90000 });
        var d = (r && r.detail) || null;
        return {
          商品ID: id,
          耗时ms: Date.now() - t0,
          ok: !!(r && r.ok),
          error: (r && r.error) || '',
          标题: d ? String(d.title || '').slice(0, 34) : '',
          价格: d ? d.price : '',
          图数: d ? (d.images || []).length : 0,
          图样例: d ? (d.images || []).slice(0, 4).map(function (u) { return u.slice(-58); }) : [],
          视频: d ? String(d.video || '').slice(0, 50) : '',
          来源: d ? d.source : ''
        };
      })()
    `,
    awaitPromise: true, returnByValue: true, contextId: iso.id
  });
  if (out.exceptionDetails) {
    console.log('ERR ' + String(out.exceptionDetails.exception &&
      out.exceptionDetails.exception.description || '?').slice(0, 200));
    await b.close();
    process.exit(1);
  }

  const r = out.result.value;
  console.log(JSON.stringify(r, null, 1));

  const good = r && r.ok && r.图数 >= 5;
  console.log('\n' + (good
    ? '✓ 详情补录可用：' + r.图数 + ' 张图（来源 ' + r.来源 + '）'
    : '✗ 没打通'));
  await b.close();
  process.exit(good ? 0 : 1);
})().catch((e) => { console.error('ERR', e && e.message); process.exit(1); });
