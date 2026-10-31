/**
 * 决定性实验（两件事一次做完）：
 *
 * 1) 「列表接口没给『N人想要』标签」是不是就等于「0 人想要」？
 *    取 12 个无标签 + 4 个有标签的商品，用详情接口的 wantCnt 对账。
 *    如果对得上 → 列表页就能直接判定想要人数，1000 个商品也不用进详情页。
 *
 * 2) 在店铺页上下文**并发**调详情接口，实测 16 个要多久 → 推算 1000 个。
 *
 *   node tools/probe-xy-bulk.js
 */
'use strict';
const fs = require('fs');
const { chromium } = require('C:/Users/pc/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

// 从上次抓的列表响应里取样本：[itemId, 标签里的想要数(空=没给标签)]
function samples() {
  let src;
  try { src = JSON.parse(fs.readFileSync('dist/xy-shop-api.json', 'utf8')); }
  catch (e) { return []; }
  const withL = [], withoutL = [];
  src.filter((x) => x.api === 'mtop.idle.web.xyh.item.list').forEach((hit) => {
    const j = JSON.parse(hit.body);
    (j.data.cardList || []).forEach((c) => {
      const cd = c.cardData || {};
      const ld = (cd.itemLabelDataVO && cd.itemLabelDataVO.labelData) || {};
      let want = '';
      Object.keys(ld).forEach((rk) => {
        ((ld[rk] && ld[rk].tagList) || []).forEach((t) => {
          const ct = t.data && t.data.content;
          if (ct && /人想要/.test(ct)) want = ct;
        });
      });
      const rec = [String(cd.id || ''), want];
      if (!rec[0]) return;
      (want ? withL : withoutL).push(rec);
    });
  });
  return { withL: withL.slice(0, 4), withoutL: withoutL.slice(0, 12) };
}

const S = samples();
const ALL = [].concat(S.withL, S.withoutL);
console.log('样本：有标签 ' + S.withL.length + ' 个，无标签 ' + S.withoutL.length + ' 个');

const BULK = (ids) => `(function () {
  var mtop = window.lib && window.lib.mtop;
  if (!mtop) return Promise.resolve({ err: 'no mtop' });
  var ids = ${JSON.stringify(ids)};
  var t0 = Date.now();
  function one(id) {
    return new Promise(function (resolve) {
      var p = { api: 'mtop.taobao.idle.pc.detail', v: '1.0', data: { itemId: String(id) },
        type: 'POST', dataType: 'json', needLogin: false, needLoginPC: false,
        sessionOption: 'AutoLoginOnly', ecode: 0, H5Request: true,
        appKey: '34839810', spm_cnt: 'a21ybx.item.0.0' };
      var done = false;
      function fin(r) {
        if (done) return; done = true;
        var it = (r && r.data && r.data.itemDO) || {};
        resolve({ id: String(id), want: it.wantCnt, browse: it.browseCnt,
          err: (r && r.data) ? '' : 'FAIL' });
      }
      try {
        var r = mtop.request(p, function (res) { fin(res); }, function (e) { fin({ err: e }); });
        if (r && r.then) { r.then(function (res) { fin(res); })['catch'](function (e) { fin({ err: e }); }); }
      } catch (e) { fin({ err: e }); }
      setTimeout(function () { if (!done) { done = true; resolve({ id: String(id), err: 'TIMEOUT' }); } }, 30000);
    });
  }
  return Promise.all(ids.map(one)).then(function (rows) {
    return { ms: Date.now() - t0, rows: rows };
  });
})()`;

(async () => {
  const b = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = b.contexts()[0];
  const page = await ctx.newPage();
  try { await page.goto('https://www.goofish.com/personal?userId=2208526863302', { waitUntil: 'domcontentloaded', timeout: 60000 }); }
  catch (e) { console.log('goto:', String(e.message).split('\n')[0]); }
  await page.waitForTimeout(7000);

  const r = await page.evaluate(BULK(ALL.map((x) => x[0])));
  if (!r || r.err) { console.log('ERR', JSON.stringify(r)); await page.close(); await b.close(); return; }
  console.log('并发 ' + ALL.length + ' 个耗时 ' + r.ms + 'ms  (单个平均 ' + Math.round(r.ms / ALL.length) + 'ms)');
  console.log('推算 1000 个：约 ' + Math.round(r.ms / ALL.length * 1000 / 1000) + ' 秒\n');
  const map = {};
  (r.rows || []).forEach((x) => { map[x.id] = x; });
  console.log('itemId          | 列表标签 | 接口wantCnt | 一致');
  ALL.forEach(([id, label]) => {
    const api = map[id] ? map[id].want : 'ERR';
    const labelNum = label ? (label.match(/\d+/) || [''])[0] : '';
    const ok = label ? (String(labelNum) === String(api)) : (String(api) === '0');
    console.log(id.padEnd(15) + ' | ' + (label || '(无)').padEnd(8) + ' | ' + String(api).padEnd(11) + ' | ' + (ok ? 'OK' : '✗'));
  });
  await page.close();
  await b.close();
})().catch((e) => { console.error('ERR', String(e && e.message).split('\n')[0]); process.exit(1); });
