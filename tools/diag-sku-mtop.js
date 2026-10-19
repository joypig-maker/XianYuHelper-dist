/**
 * 直接调页面里的 mtop.request，看规格表接口到底能不能通。
 *
 * 补详情的第二、三条路（内嵌数据、JSONP）在关键词搜索页上都是死的，
 * mtop 是唯一还活着的通道，而它之前一次请求都没发出去。
 * 这个脚本把 mtop 原样调一遍，把成功/失败的结构都打出来，
 * 用来定位是「没发请求」「发了但被拒」还是「回调永远不回」。
 *
 * 用法：node tools/diag-sku-mtop.js
 */
'use strict';
const CDP = require('./cdp');

const PROBE = `return new Promise(function (resolve) {
  var out = { hasMtop: !!(window.lib && window.lib.mtop && typeof window.lib.mtop.request === 'function') };
  if (!out.hasMtop) return resolve(out);

  var map = window.__XY__ ? window.__XY__.getCardMap() : null;
  var id = '';
  if (map) { var ks = Object.keys(map); id = ks[0] || ''; }
  out.itemId = id;
  if (!id) return resolve(out);

  function call(name, params, ms) {
    return new Promise(function (res) {
      var t0 = Date.now();
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        res({ name: name, note: '回调未返回（超时 ' + ms + 'ms）', ms: Date.now() - t0 });
      }, ms || 12000);
      var r;
      try {
        r = window.lib.mtop.request(params, function (v) {
          if (settled) return;
          settled = true; clearTimeout(timer);
          var s = JSON.stringify(v);
          res({
            name: name, ms: Date.now() - t0,
            ok: true,
            ret: v && v.ret != null ? String(v.ret).slice(0, 80) : null,
            len: s.length,
            head: s.slice(0, 160),
            dataKeys: (v && v.data) ? Object.keys(v.data).slice(0, 12) : null
          });
        }, function (e) {
          if (settled) return;
          settled = true; clearTimeout(timer);
          var es;
          try { es = JSON.stringify(e); } catch (e2) { es = String(e); }
          res({ name: name, ms: Date.now() - t0, ok: false, err: es ? es.slice(0, 400) : String(e) });
        });
      } catch (e) {
        if (settled) return;
        settled = true; clearTimeout(timer);
        return res({ name: name, ms: Date.now() - t0, threw: String(e && e.message || e).slice(0, 120) });
      }
      if (r && typeof r.then === 'function') {
        r.then(function (v) {
          if (settled) return; settled = true; clearTimeout(timer);
          res({ name: name, ms: Date.now() - t0, viaPromise: true, head: JSON.stringify(v).slice(0, 160) });
        }).catch(function (e) {
          if (settled) return; settled = true; clearTimeout(timer);
          res({ name: name, ms: Date.now() - t0, viaPromise: true, rejected: String(e).slice(0, 120) });
        });
      }
    });
  }

  var calls = [];
  calls.push(call('sku选择器', {
    api: 'mtop.1688.wosc.queryofferskuselectormodel',
    v: '1.0',
    data: { offerId: String(id) },
    timeout: 15000,
    needLogin: false
  }));

  calls.push(call('laputa详情', {
    api: 'laputa.1688.offer.detail',
    v: '1.0',
    data: { offerId: String(id) },
    timeout: 15000,
    needLogin: false
  }));

  Promise.all(calls).then(function (rs) { out.calls = rs; resolve(out); });
})`;

(async () => {
  const b = await CDP.connect(9222);
  const page = await b.attach(/1688\.com/);
  if (!page) { console.log('没有 1688 标签'); await b.close(); return; }
  const r = await page.evaluate(PROBE, true);
  console.log('mtop 通道可用：' + r.hasMtop + '，商品：' + r.itemId);
  (r.calls || []).forEach(function (c) {
    console.log('\n--- ' + c.name + ' ---');
    console.log(JSON.stringify(c, null, 1));
  });
  await b.close();
})().catch((e) => { console.error('失败：' + e.message); process.exit(1); });
