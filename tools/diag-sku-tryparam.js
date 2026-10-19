/**
 * 验证「补齐 useCase 之后 SKU 接口能不能通」。
 *
 * 抓包拿到真实请求体是：
 *   { offerId, useCase:"1688detail", bizScene:"pcod", urlParam:"actionType=dxOrder&sk=consign" }
 * 但抓包不等于能跑——签名是页面自己算的，这里用页面里的 mtop 通道原样重放，
 * 逐组参数试，看到底哪几个是必需的。
 *
 * 用法：node tools/diag-sku-tryparam.js [商品ID]
 */
'use strict';
const CDP = require('./cdp');

const PROBE = (offerId) => `return new Promise(function (resolve) {
  var id = '${offerId}';
  function call(name, data) {
    return new Promise(function (res) {
      var settled = false;
      var t0 = Date.now();
      var timer = setTimeout(function () {
        if (settled) return; settled = true;
        res({ name: name, note: '超时未返回' });
      }, 15000);
      try {
        window.lib.mtop.request({
          api: 'mtop.1688.wosc.queryofferskuselectormodel',
          v: '1.0',
          data: data,
          timeout: 15000,
          needLogin: false
        }, function (v) {
          if (settled) return; settled = true; clearTimeout(timer);
          var s = JSON.stringify(v);
          res({
            name: name, ms: Date.now() - t0, ok: true,
            ret: v && v.ret != null ? String(v.ret).slice(0, 70) : null,
            len: s.length,
            dataKeys: (v && v.data) ? Object.keys(v.data).slice(0, 10) : null,
            head: s.slice(0, 120)
          });
        }, function (e) {
          if (settled) return; settled = true; clearTimeout(timer);
          var es = ''; try { es = JSON.stringify(e); } catch (e2) {}
          res({ name: name, ms: Date.now() - t0, ok: false, err: es.slice(0, 220) });
        });
      } catch (e) {
        if (settled) return; settled = true; clearTimeout(timer);
        res({ name: name, threw: String(e && e.message || e).slice(0, 120) });
      }
    });
  }

  Promise.all([
    call('① 只 offerId（现状）', { offerId: id }),
    call('② +useCase', { offerId: id, useCase: '1688detail' }),
    call('③ +useCase+bizScene', { offerId: id, useCase: '1688detail', bizScene: 'pcod' }),
    call('④ 全部（与抓包一致）', {
      offerId: id, useCase: '1688detail', bizScene: 'pcod',
      urlParam: 'actionType=dxOrder&sk=consign'
    })
  ]).then(function (rs) { resolve(rs); });
})`;

(async () => {
  const b = await CDP.connect(9222);
  const page = await b.attach(/1688\.com/);
  if (!page) { console.log('没有 1688 标签'); await b.close(); return; }
  let id = process.argv[2];
  if (!id) {
    id = await page.evaluate(`return (function(){var m=window.__XY__&&window.__XY__.getCardMap?window.__XY__.getCardMap():null;if(m){var k=Object.keys(m);return k[0]||'';}var x=location.href.match(/offerId=(\\d{6,20})/);return x?x[1]:'';})()`);
  }
  if (!id) { console.log('拿不到商品 ID'); await b.close(); return; }
  console.log('商品：' + id);
  const rs = await page.evaluate(PROBE(id), true);
  rs.forEach(function (r) {
    console.log('\n--- ' + r.name + ' ---');
    console.log(JSON.stringify(r, null, 1));
  });
  await b.close();
})().catch((e) => { console.error('失败：' + e.message); process.exit(1); });
