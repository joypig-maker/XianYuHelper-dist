/**
 * 诊断「下载商品只下一张主图 / 没有 SKU 图 / txt 无 SKU 价」
 *
 * 不依赖扩展版本，直接在真机上取三样东西：
 *   1. 页面里一张卡片 DOM 到底有几个 <img>（列表页到底给了几张图）
 *   2. 扩展抓到的卡片数据里 images 有几项、desc 有没有、skus 有没有
 *   3. 手动调 SKU 选择器接口，看返回里规格表在哪个字段
 *
 * 用法：node tools/diag-sku-live.js
 */
'use strict';
const CDP = require('./cdp');

const PROBE = `{
  var out = {};

  /* 1. 卡片 DOM 里到底有几个 img */
  var nodes = document.querySelectorAll('[class*="offer-item"],[data-offer-id]');
  out.cardDom = { count: nodes.length, imgsPerCard: [] };
  for (var i = 0; i < Math.min(nodes.length, 5); i++) {
    var imgs = nodes[i].querySelectorAll('img');
    var srcs = [];
    for (var k = 0; k < imgs.length; k++) {
      var s = imgs[k].getAttribute('src') || imgs[k].getAttribute('data-src') || '';
      srcs.push(s.slice(0, 60));
    }
    out.cardDom.imgsPerCard.push({ n: imgs.length, srcs: srcs });
  }

  /* 2. 扩展抓到的卡片数据 */
  var map = (window.__XY__ && window.__XY__.getCardMap) ? window.__XY__.getCardMap() : null;
  out.xy = {
    hasXY: !!window.__XY__,
    ver: window.__XY__ ? window.__XY__.v : null,
    cardCount: map ? Object.keys(map).length : 0,
    cards: []
  };
  if (map) {
    var ids = Object.keys(map).slice(0, 8);
    ids.forEach(function (id) {
      var c = map[id] || {};
      var imgs = c.images || (c.image ? [c.image] : []);
      out.xy.cards.push({
        itemId: id,
        title: (c.title || '').slice(0, 18),
        hasDesc: !!c.desc,
        descLen: (c.desc || '').length,
        imgCount: imgs.length,
        hasSkus: !!(c.skus && c.skus.list && c.skus.list.length),
        skuList: (c.skus && c.skus.list) ? c.skus.list.map(function (s) { return s.key; }).slice(0, 4) : [],
        skuImgCount: (c.skus && c.skus.list)
          ? c.skus.list.filter(function (s) { return !!s.image; }).length : 0,
        skusTried: !!c.skusTried
      });
    });
  }

  /* 3. window.context 里有没有规格表（详情页才全，搜索页多半没有） */
  var ctxKeys = [];
  try {
    if (typeof window.context === 'object' && window.context) {
      Object.keys(window.context).forEach(function (k) {
        var v = window.context[k];
        if (v && typeof v === 'object') {
          var s = JSON.stringify(v);
          if (/skuInfoMap|skuProps|skuList|discountPrice/i.test(s)) {
            ctxKeys.push(k + '(<含规格字段, ' + s.length + 'B>)');
          }
        }
      });
    }
  } catch (e) { ctxKeys.push('读取异常: ' + e.message); }
  out.contextSkuHits = ctxKeys;
  return out;
}`;

/** 手动调 SKU 选择器接口：不改造扩展，直接在页面里发一次请求看返回 */
const SKU_PROBE = `return new Promise(function (resolve) {
  function done(o) { resolve(o); }
  var id = (function () {
    var map = (window.__XY__ && window.__XY__.getCardMap) ? window.__XY__.getCardMap() : null;
    if (map) { var ks = Object.keys(map); if (ks.length) return ks[0]; }
    var m = location.href.match(/offerId=(\\d{6,20})/);
    return m ? m[1] : '';
  })();
  if (!id) return done({ err: '拿不到商品 ID' });

  var xhr = new XMLHttpRequest();
  xhr.open('POST', 'https://h5api.m.1688.com/h5/mtop.1688.wosc.queryofferskuselectormodel/1.0/?' +
    'jsv=2.7.2&appKey=12574478&t=' + Date.now() + '&sign=&api=mtop.1688.wosc.queryofferskuselectormodel' +
    '&v=1.0&type=originaljson&accountSite=xianyu&dataType=json&timeout=20000&apiSite=mtop&apiVersion=1.0', true);
  xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
  xhr.setRequestHeader('x-sign', '');
  xhr.setRequestHeader('x-mtop-rms-token', '');
  xhr.setRequestHeader('user-agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15');
  xhr.setRequestHeader('referer', location.href);
  xhr.onload = function () {
    var body = xhr.responseText || '';
    var r = null;
    try { r = JSON.parse(body); } catch (e) {}
    done({
      id: id,
      len: body.length,
      ret: r && r.ret ? String(r.ret).slice(0, 60) : null,
      hasSkuInfoMap: /skuInfoMap/.test(body),
      hasSkuProps: /skuProps/.test(body),
      hasSkuSelector: /skuSelectorBizModel/.test(body),
      discountPriceCount: (body.match(/discountPrice/g) || []).length,
      imageUrlCount: (body.match(/imageUrl/g) || []).length
    });
  };
  xhr.onerror = function () { done({ id: id, err: '请求失败' }); };
  xhr.send('{"offerId":"' + id + '"}');
})`;

(async () => {
  const b = await CDP.connect(9222);
  // 优先复用已经开着的 1688 标签（有登录态、商品已经在池子里，不用重抓）
  let page = await b.attach(/1688\.com/);
  if (!page) {
    page = await b.open('https://s.1688.com/selloffer/offer_search.htm?keywords=' + encodeURIComponent('手机支架'));
    await new Promise((r) => setTimeout(r, 6000));
  }
  console.log('目标标签：' + page.url);

  const r1 = await page.evaluate(PROBE);
  console.log('\n=== 卡片 DOM ===');
  console.log('命中卡片节点：' + r1.cardDom.count);
  r1.cardDom.imgsPerCard.forEach(function (c, i) {
    console.log('  卡片' + (i + 1) + '：' + c.n + ' 个 img');
    c.srcs.forEach((s) => console.log('      ' + s));
  });

  console.log('\n=== 扩展抓到的卡片数据 ===');
  console.log('扩展版本：' + r1.xy.ver + ' / 卡片数：' + r1.xy.cardCount);
  r1.xy.cards.forEach(function (c) {
    console.log('  ' + c.itemId + ' | 图' + c.imgCount + ' | desc=' + c.descLen +
      ' | skus=' + (c.hasSkus ? c.skuList.join(',') : '无') +
      ' | sku图' + c.skuImgCount + ' | tried=' + c.skusTried);
  });

  console.log('\n=== 页面 context 里的规格字段 ===');
  console.log(r1.contextSkuHits.length ? r1.contextSkuHits.join(' , ') : '(无)');

  console.log('\n=== 手动调 SKU 选择器接口 ===');
  const r2 = await page.evaluate(SKU_PROBE, true);
  console.log(JSON.stringify(r2, null, 2));

  await b.close();
})().catch((e) => { console.error('失败：' + e.message); process.exit(1); });
