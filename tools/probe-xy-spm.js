/**
 * 确认 spm_cnt 取哪个值都能通（代码里店铺页会取 a21ybx.personal.0）。
 * 只有详情页那个值能通的话，就得改成固定值。
 */
'use strict';
const { chromium } = require('C:/Users/pc/.workbuddy/binaries/node/workspace/node_modules/playwright-core');
const ID = '1095514180818';

const T = (spm) => `(function () {
  var mtop = window.lib && window.lib.mtop;
  if (!mtop) return Promise.resolve({ err: 'no mtop' });
  return new Promise(function (resolve) {
    var p = { api: 'mtop.taobao.idle.pc.detail', v: '1.0', data: { itemId: '${ID}' },
      type: 'POST', dataType: 'json', needLogin: false, needLoginPC: false,
      sessionOption: 'AutoLoginOnly', ecode: 0, H5Request: true,
      appKey: '34839810', spm_cnt: '${spm}' };
    var t0 = Date.now(); var done = false;
    function fin(r) { if (done) return; done = true;
      var it = (r && r.data && r.data.itemDO) || {};
      resolve({ ms: Date.now() - t0, want: it.wantCnt, browse: it.browseCnt,
        err: (r && r.data) ? '' : JSON.stringify(r || {}).slice(0, 120) }); }
    try {
      var r = mtop.request(p, fin, function (e) { fin({ err: String(e) }); });
      if (r && r.then) r.then(fin)['catch'](function (e) { fin({ err: String(e) }); });
    } catch (e) { fin({ err: String(e) }); }
    setTimeout(function () { fin({ err: 'TIMEOUT' }); }, 25000);
  });
})()`;

(async () => {
  const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = b.contexts()[0];
  const page = await ctx.newPage();
  try { await page.goto('https://www.goofish.com/personal?userId=2208526863302', { waitUntil: 'domcontentloaded', timeout: 60000 }); }
  catch (e) { console.log('goto:', String(e.message).split('\n')[0]); }
  await page.waitForTimeout(8000);
  for (const spm of ['a21ybx.item.0.0', 'a21ybx.personal.0', 'a21ybx.search.0.0']) {
    const r = await page.evaluate(T(spm));
    console.log(spm.padEnd(20) + ' → ' + JSON.stringify(r));
  }
  await page.close();
  await b.close();
})().catch((e) => { console.error('ERR', String(e && e.message).split('\n')[0]); process.exit(1); });
