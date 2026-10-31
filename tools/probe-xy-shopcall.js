/**
 * 关键实验：在**店铺页**上下文里直接调闲鱼详情接口 mtop.taobao.idle.pc.detail。
 *
 * 如果能通 → 1000 个商品不用开标签页、不用导航，并发拉详情即可，
 *            「补齐想要人数」从每个 5 秒降到几百毫秒。
 * 如果不通 → 只能继续走后台标签页，或另找批量接口。
 *
 * 试三组参数，逐组打印结果，哪组通就用哪组。
 *
 *   node tools/probe-xy-shopcall.js <店铺URL>
 */
'use strict';
const { chromium } = require('C:/Users/pc/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

const url = process.argv[2] || 'https://www.goofish.com/personal?userId=2208526863302';
const ID = '1096046749258';

const PROBE = `(function (id) {
  var mtop = window.lib && window.lib.mtop;
  if (!mtop) return Promise.resolve({ all: [{ name: 'env', err: 'no mtop' }] });
  var cfg = {};
  try { cfg = { appKey: mtop.config && mtop.config.appKey, keys: Object.keys(mtop.config || {}) }; } catch (e) {}

  function call(name, extra) {
    return new Promise(function (resolve) {
      var p = {
        api: 'mtop.taobao.idle.pc.detail',
        v: '1.0',
        data: { itemId: String(id) },
        type: 'POST', dataType: 'json',
        needLogin: false, needLoginPC: false,
        sessionOption: 'AutoLoginOnly', ecode: 0, H5Request: true
      };
      for (var k in extra) p[k] = extra[k];
      var t0 = Date.now();
      var done = false;
      function fin(r) {
        if (done) return; done = true;
        var out = { name: name, ms: Date.now() - t0 };
        try {
          var d = r && r.data;
          if (!d) { out.err = 'no data: ' + JSON.stringify(r || {}).slice(0, 200); return resolve(out); }
          out.wantCnt = d.itemDO ? d.itemDO.wantCnt : null;
          out.browseCnt = d.itemDO ? d.itemDO.browseCnt : null;
          out.price = d.itemDO ? (d.itemDO.price != null ? d.itemDO.price : d.itemDO.soldPrice) : null;
          out.ok = true;
        } catch (e) { out.err = String(e); }
        resolve(out);
      }
      try {
        var r = mtop.request(p, function (res) { fin(res); }, function (e) { fin({ err: e }); });
        if (r && r.then) { r.then(function (res) { fin(res); })['catch'](function (e) { fin({ err: e }); }); }
      } catch (e) { fin({ err: e }); }
      setTimeout(function () { fin({ err: 'TIMEOUT' }); }, 25000);
    });
  }

  return Promise.resolve()
    .then(function () { return call('A-基础', {}); })
    .then(function (a) {
      return call('B-带appKey', { appKey: '34839810' }).then(function (b) { return [a, b]; });
    })
    .then(function (arr) {
      return call('C-appKey+spm', { appKey: '34839810', spm_cnt: 'a21ybx.item.0.0' })
        .then(function (c) { arr.push(c); return arr; });
    })
    .then(function (arr) { return { cfg: cfg, all: arr }; });
})('${ID}')`;

(async () => {
  const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = b.contexts()[0];
  const page = await ctx.newPage();
  try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }); }
  catch (e) { console.log('goto:', String(e.message).split('\n')[0]); }
  await page.waitForTimeout(7000);

  const r = await page.evaluate(PROBE);
  console.log('mtop.config → ' + JSON.stringify(r && r.cfg));
  (r && r.all || []).forEach((x) => console.log(JSON.stringify(x)));
  await page.close();
  await b.close();
})().catch((e) => { console.error('ERR', String(e && e.message).split('\n')[0]); process.exit(1); });
