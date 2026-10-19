/**
 * 触发一次完整的「补详情 + 补规格」，看 SKU 到底补不补得回来。
 *
 * 在真机上直接给注入脚本发 ensure-cards，等它跑完，再回读 cardMap：
 *   · 补了多少 desc / images
 *   · 规格表补回来几条、规格图有没有
 *   · SKU 接口到底发起过几次、返回什么（用 performance 资源表 + 重放一次）
 *
 * 用法：node tools/diag-sku-ensure.js [最多试几个商品]
 */
'use strict';
const CDP = require('./cdp');

const TRIGGER = (max) => `{
  var map = window.__XY__ ? window.__XY__.getCardMap() : null;
  var ids = map ? Object.keys(map).slice(0, ${max}) : [];
  window.__XY__.__diag = { ids: ids, done: null, t0: Date.now() };
  window.addEventListener('message', function (e) {
    var m = e.data;
    if (m && m.source === 'xy-injected' && m.type === 'ensure-done') {
      window.__XY__.__diag.done = m.payload;
    }
  });
  // source 必须显式给 window：注入脚本第一句就校验 e.source === window，
  // 不传的话 MessageEvent.source 是 null，消息会被直接丢掉（踩过一次）
  window.dispatchEvent(new MessageEvent('message', {
    source: window,
    data: { source: 'xy-bridge', type: 'ensure-cards', payload: { ids: ids } }
  }));
  return { triggered: ids.length, firstIds: ids.slice(0, 5) };
}`;

const READBACK = `{
  var d = window.__XY__.__diag || {};
  var map = window.__XY__ ? window.__XY__.getCardMap() : {};
  function stat(list) {
    var r = { n: list.length, tried: 0, hasSkus: 0, skuImgs: 0, imgGt1: 0, hasDesc: 0 };
    list.forEach(function (id) {
      var c = map[id] || {};
      if (c.skusTried) r.tried++;
      if (c.skus && c.skus.list && c.skus.list.length) {
        r.hasSkus++;
        r.skuImgs += c.skus.list.filter(function (s) { return !!s.image; }).length;
      }
      var imgs = c.images || (c.image ? [c.image] : []);
      if (imgs.length > 1) r.imgGt1++;
      if (c.desc) r.hasDesc++;
    });
    return r;
  }
  var all = Object.keys(map);
  var diag = d.ids || [];
  // 只看这一批
  var batch = diag.filter(function (id) { return !!map[id]; });
  return {
    elapsed: ((Date.now() - (d.t0 || Date.now())) / 1000).toFixed(1) + 's',
    done: d.done,
    poolTotal: all.length,
    batch: stat(batch),
    sample: batch.slice(0, 5).map(function (id) {
      var c = map[id] || {};
      var imgs = c.images || (c.image ? [c.image] : []);
      return {
        id: id,
        imgs: imgs.length,
        desc: (c.desc || '').length,
        skus: (c.skus && c.skus.list) ? c.skus.list.map(function (s) {
          return s.key + '@' + s.price + (s.image ? '(图)' : '(无图)');
        }) : null
      };
    })
  };
}`;

/** SKU 接口被调过没有（performance 资源表只能看 URL，看不到返回） */
const NETWATCH = `{
  var es = (performance.getEntriesByType('resource') || []);
  var sku = es.filter(function (e) { return /queryofferskuselectormodel/.test(e.name); });
  var laputa = es.filter(function (e) { return /laputa/.test(e.name); });
  return {
    skuCalls: sku.length,
    skuUrls: sku.slice(-4).map(function (e) { return e.name.slice(0, 130); }),
    laputaCalls: laputa.length,
    laputaUrls: laputa.slice(-3).map(function (e) { return e.name.slice(0, 110); })
  };
}`;

(async () => {
  const max = Number(process.argv[2] || 6);
  const b = await CDP.connect(9222);
  let page = await b.attach(/1688\.com/);
  if (!page) {
    page = await b.open('https://s.1688.com/selloffer/offer_search.htm?keywords=' + encodeURIComponent('手机支架'));
    await new Promise((r) => setTimeout(r, 8000));
  }

  console.log('触发前网络：' + JSON.stringify(await page.evaluate(NETWATCH), null, 1));

  const t = await page.evaluate(TRIGGER(max));
  console.log('\n已触发补详情，商品数：' + t.triggered);
  console.log('前几个：' + t.firstIds.join(', '));

  // 补详情是串行的，每条约 400ms 间隔，给足时间
  const waitSec = Math.max(25, t.triggered * 2 + 20);
  console.log('等待 ' + waitSec + 's…');
  await new Promise((r) => setTimeout(r, waitSec * 1000));

  const r = await page.evaluate(READBACK);
  console.log('\n=== 补完后回读 ===');
  console.log('耗时：' + r.elapsed);
  console.log('ensure-done 回执：' + JSON.stringify(r.done));
  console.log('商品池总数：' + r.poolTotal + ' / 本批：' + r.batch.n);
  console.log('本批统计：' + JSON.stringify(r.batch));
  r.sample.forEach(function (s) {
    console.log('  ' + s.id + ' 图' + s.imgs + ' desc=' + s.desc +
      (s.skus ? '\n      规格：' + s.skus.join(' | ') : '\n      规格：无'));
  });

  console.log('\n补完后的网络：' + JSON.stringify(await page.evaluate(NETWATCH), null, 1));
  await b.close();
})().catch((e) => { console.error('失败：' + e.message); process.exit(1); });
