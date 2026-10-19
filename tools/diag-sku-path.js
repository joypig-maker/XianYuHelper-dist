/**
 * 查「补详情为什么一步没走」：逐个通道探活。
 *
 * 补详情有三条路，命中哪条取决于运行时条件，这里把条件逐个打出来：
 *   1. siteEmbeddedData —— window.context 在不在、对不对得上 ID
 *   2. mtop             —— window.lib.mtop.request 在不在
 *   3. jsonp            —— 那个 URL 到底能不能拿到数据
 * 另外打开控制台监听，看 CSP / 跨域之类的报错。
 *
 * 用法：node tools/diag-sku-path.js
 */
'use strict';
const CDP = require('./cdp');

const PROBE = `{
  var out = {};
  var m = location.href.match(/offerId=(\\d{6,20})/);
  var id = m ? m[1] : '';
  if (!id) {
    var map = window.__XY__ ? window.__XY__.getCardMap() : null;
    if (map) { var ks = Object.keys(map); id = ks[0] || ''; }
  }
  out.itemId = id;

  /* 1. 内嵌数据 */
  out.embedded = {
    hasContext: typeof window.context !== 'undefined',
    contextKeys: (typeof window.context === 'object' && window.context)
      ? Object.keys(window.context).slice(0, 15) : null,
    _init_data: (typeof window._init_data !== 'undefined') ? String(window._init_data).length : undefined
  };

  /* 2. mtop 通道 */
  out.mtop = {
    hasLib: typeof window.lib !== 'undefined',
    hasMtop: !!(window.lib && window.lib.mtop),
    hasRequest: !!(window.lib && window.lib.mtop && typeof window.lib.mtop.request === 'function'),
    keys: (window.lib && window.lib.mtop) ? Object.keys(window.lib.mtop).slice(0, 10) : null
  };

  /* 3. jsonp 通道：直接探那个 URL */
  out.jsonpProbe = null;
  return new Promise(function (resolve) {
    if (!id) return resolve(out);
    var url = 'https://laputa.1688.com/offer/ajax/OfferDetailWidget.do?offerId=' + id;
    out.jsonpUrl = url;
    var img = new Image();
    img.onload = function () { out.jsonpProbe = { ok: true, w: img.naturalWidth, h: img.naturalHeight, src: img.src.slice(0, 80) }; resolve(out); };
    img.onerror = function () { out.jsonpProbe = { ok: false }; resolve(out); };
    img.src = url;
    setTimeout(function () { if (!out.jsonpProbe) { out.jsonpProbe = { ok: false, note: '超时' }; resolve(out); } }, 6000);
  });
}`;

/** 用 fetch 探 jsonp 接口（CORS 可能挡，但要看服务端给不给） */
const FETCH_PROBE = (id) => `return fetch(
  'https://laputa.1688.com/offer/ajax/OfferDetailWidget.do?offerId=${id}',
  { mode: 'cors' }
).then(function (r) { return r.text(); })
 .then(function (t) { return { ok: true, len: t.length, head: t.slice(0, 200) }; })
 .catch(function (e) { return { ok: false, err: String(e && e.message || e) }; });`;

(async () => {
  const b = await CDP.connect(9222);
  const page = await b.attach(/1688\.com/);
  if (!page) { console.log('没有 1688 标签'); await b.close(); return; }
  console.log('标签：' + (page.url ? page.url : '(attach)'));

  // 开控制台监听
  const logs = [];
  page.send('Runtime.enable').catch(() => {});
  page.send('Log.enable').catch(() => {});
  const origSend = page.send.bind(page);
  page.send = function (method, params) {
    return origSend(method, params).then((r) => {
      if (method === 'Runtime.consoleAPICalled' && params) {
        logs.push('[console.' + params.type + '] ' + JSON.stringify(params.args || []).slice(0, 220));
      }
      if (method === 'Log.entryAdded' && params) {
        logs.push('[log.' + params.entry.level + '] ' + String(params.entry.text).slice(0, 220));
      }
      return r;
    });
  };
  // console 事件是浏览器推的，探测结束后统一读
  setTimeout(() => {}, 0);

  const p = await page.evaluate(PROBE, true);
  console.log('\n=== 通道条件 ===');
  console.log('商品 ID：' + p.itemId);
  console.log('内嵌数据：' + JSON.stringify(p.embedded));
  console.log('mtop：' + JSON.stringify(p.mtop));
  console.log('jsonp URL：' + p.jsonpUrl);
  console.log('image 探活：' + JSON.stringify(p.jsonpProbe));

  const f = await page.evaluate(FETCH_PROBE(p.itemId), true);
  console.log('\n=== fetch 探 jsonp ===');
  console.log(JSON.stringify(f, null, 1));

  await new Promise((r) => setTimeout(r, 1500));
  console.log('\n=== 控制台片段 ===');
  console.log(logs.length ? logs.slice(0, 15).join('\n') : '(无)');

  await b.close();
})().catch((e) => { console.error('失败：' + e.message); process.exit(1); });
