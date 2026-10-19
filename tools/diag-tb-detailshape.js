/**
 * 定位 pcdetail.data.get 与 detail.getdesc(v6.0) 的精确结构
 *
 * 上一轮结论：
 *   主数据  mtop.taobao.pcdetail.data.get v1.0  参数 {id, detail_v} → 5 图 + 价格
 *   详情图  mtop.taobao.detail.getdesc   v6.0  参数需带 skuId → 返回 pcDescContent
 * 两者结构与抓包时的 v7.0（components.componentData）**完全不同**，
 * 必须按实际结构重配路径，否则又是一轮「有响应但解析全空」。
 *
 * 另外要验：批量补录时拿不到 skuId，getdesc 不传 skuId 还能不能用。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const CDP = require('./cdp');

const ID = process.argv[2] || '669745626548';
const SKU = process.argv[3] || '5743745873022';

const PROBE = `return (async function(){
  var ID = ${JSON.stringify(ID)}, SKU = ${JSON.stringify(SKU)};
  function mtop(api, v, data){
    return new Promise(function(resolve){
      var done = false;
      function finish(x){ if (!done) { done = true; resolve(x); } }
      try {
        var ret = window.lib.mtop.request({ api: api, v: v, data: data, timeout: 15000, needLogin: false },
          function(r){ finish(r); }, function(){ finish(null); });
        if (ret && typeof ret.then === 'function') ret.then(finish, function(){ finish(null); });
        else if (ret && typeof ret === 'object' && (ret.data || ret.ret)) finish(ret);
      } catch (e) { finish(null); }
      setTimeout(function(){ finish(null); }, 15000);
    });
  }

  var out = {};

  /* ---- 1. 主数据：层次与图片/价格落点 ---- */
  var main = await mtop('mtop.taobao.pcdetail.data.get', '1.0', { id: ID, detail_v: '3.3.2' });
  var m = main && main.data;
  if (m) {
    out.主数据_顶层键 = Object.keys(m);
    out.主数据_item键 = m.item ? Object.keys(m.item).slice(0, 22) : '(无 item)';
    // 图片数组落在哪
    var imgHits = [];
    (function scan(o, p, d){
      if (d > 6 || !o || typeof o !== 'object') return;
      if (Array.isArray(o) && o.length >= 3 && o.every(function(x){ return typeof x === 'string' && /alicdn/.test(x); }))
        imgHits.push(p + ' (' + o.length + ')');
      for (var k in o) scan(o[k], p + '.' + k, d + 1);
    })(m, 'data', 0);
    out.主数据_图片数组 = imgHits.slice(0, 8);
    // 价格
    var priceHits = [];
    (function scan2(o, p, d){
      if (d > 6 || !o || typeof o !== 'object') return;
      for (var k in o) {
        if (/^(priceText|priceMoney|price)$/i.test(k) && typeof o[k] !== 'object') priceHits.push(p + '.' + k + '=' + o[k]);
        if (/^(priceText|priceMoney)$/i.test(k) && o[k]) priceHits.push(p + '.' + k + '=' + o[k]);
        scan2(o[k], p + '.' + k, d + 1);
      }
    })(m, 'data', 0);
    out.主数据_价格字段 = priceHits.slice(0, 10);
    // SKU
    out.主数据_skuBase键 = m.skuBase ? Object.keys(m.skuBase).slice(0, 10) : '(无)';
    out.主数据_skuCore键 = m.skuCore ? Object.keys(m.skuCore).slice(0, 10) : '(无)';
  } else out.主数据 = '(无响应)';

  /* ---- 2. 详情图：带/不带 skuId ---- */
  for (var i = 0; i < 2; i++) {
    var withSku = i === 0;
    var dd = withSku
      ? { id: ID, skuId: SKU, detail_v: '3.3.0', preferWireless: 'true' }
      : { id: ID, detail_v: '3.3.0', preferWireless: 'true' };
    var r2 = await mtop('mtop.taobao.detail.getdesc', '6.0', dd);
    var b2 = r2 && r2.data;
    var key = withSku ? '详情图_带skuId' : '详情图_不带skuId';
    if (!b2) { out[key] = '(无响应)'; continue; }
    out[key + '_键'] = Object.keys(b2);
    var pc = b2.pcDescContent;
    out[key + '_pcDescContent类型'] = typeof pc;
    if (typeof pc === 'string') {
      out[key + '_长度'] = pc.length;
      var imgs = (pc.match(/<img[^>]+src=["']([^"']+)["']/gi) || []).length;
      out[key + '_img标签数'] = imgs;
      out[key + '_前120字符'] = pc.slice(0, 120);
    } else if (pc && typeof pc === 'object') {
      out[key + '_pcDescContent键'] = Object.keys(pc).slice(0, 15);
    }
    out[key + '_priceDescImg'] = b2.priceDescImg ? String(b2.priceDescImg).slice(0, 80) : '(无)';
  }

  return out;
})()`;

(async () => {
  const b = await CDP.connect(9222);
  const { targetId } = await b.createTarget('about:blank');
  const page = await b.attachTarget({ id: targetId });
  await page.goto('https://detail.tmall.com/item.htm?id=' + ID, 45000);
  await new Promise((r) => setTimeout(r, 5000));

  const ROOT = path.join(__dirname, '..');
  await page.evaluate(fs.readFileSync(path.join(ROOT, 'src/common/util.js'), 'utf8') + '\nreturn 1;');

  const r = await page.evaluate(PROBE, true);
  Object.keys(r).forEach((k) => {
    const v = r[k];
    console.log(k + ': ' + (Array.isArray(v) ? JSON.stringify(v) : String(v)));
  });

  await page.close();
  await b.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
