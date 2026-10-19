/**
 * 整店分页诊断：为什么这个店只拉到一页
 *
 * 现象：shop151421831.taobao.com 的浮窗里只有 10 个商品，而 minwai 那边有 60。
 * fetchShopItems 的循环判据是 res.data.hasNext：
 *   { page, orderType, catId, keyword, filterType, feature, shopId, sellerId }
 * 这里直接按同样的参数逐页调，看返回的条数、hasNext 到底是什么形态
 * （字符串 "true" 还是布尔 true，两者在 ! 运算下行为不同）。
 */
'use strict';

const CDP = require('./cdp');

const URL = process.argv[2] ||
  'https://shop151421831.taobao.com/category.htm?spm=pc_detail.30350276.shop_block.dshopinfo.797f19ecmUIeEG&topIds=973720896210';

const PROBE = `return (async function(){
  var html = document.documentElement.innerHTML;
  var mShop = html.match(/"shopId"\\s*:\\s*"?(\\d+)"?/);
  var mSeller = html.match(/"sellerId"\\s*:\\s*"?(\\d+)"?/);
  var out = { host: location.host,
    shopId: mShop ? mShop[1] : '(无)',
    sellerId: mSeller ? mSeller[1] : '(无)' };
  if (!mShop || !mSeller) return out;

  function call(page){
    return new Promise(function(resolve){
      var done = false;
      function finish(x){ if (!done) { done = true; resolve(x); } }
      try {
        var ret = window.lib.mtop.request({
          api: 'mtop.taobao.shop.simple.item.fetch', v: '1.0',
          data: { page: page, orderType: 'popular', sortType: '', catId: 0,
                  keyword: '', filterType: '', feature: '{}',
                  shopId: mShop[1], sellerId: mSeller[1] }
        }, function(r){ finish(r); }, function(){ finish(null); });
        if (ret && typeof ret.then === 'function') ret.then(finish, function(){ finish(null); });
        else if (ret && typeof ret === 'object' && (ret.data || ret.ret)) finish(ret);
      } catch (e) { finish({ threw: e.message }); }
      setTimeout(function(){ finish({ timeout: true }); }, 12000);
    });
  }

  out.页 = [];
  for (var p = 1; p <= 4; p++) {
    var r = await call(p);
    if (!r) { out.页.push('page' + p + ' → null'); continue; }
    if (r.timeout) { out.页.push('page' + p + ' → 超时'); break; }
    if (r.threw) { out.页.push('page' + p + ' → 异常'); break; }
    var d = r.data || {};
    out.页.push('page' + p + ' → 本页 ' + ((d.data || []).length) +
      ' 条, totalCnt=' + d.totalCnt + ', pageSize=' + d.pageSize +
      ', hasNext=' + JSON.stringify(d.hasNext) + ' (' + typeof d.hasNext + ')' +
      ', 返回的page=' + JSON.stringify(d.page));
    if (!d.hasNext) break;
  }
  return out;
})()`;

(async () => {
  const b = await CDP.connect(9222);
  const { targetId } = await b.createTarget('about:blank');
  const page = await b.attachTarget({ id: targetId });
  await page.goto(URL, 45000);
  await new Promise((r) => setTimeout(r, 9000));

  const r = await page.evaluate(PROBE, true);
  console.log('host: ' + r.host);
  console.log('shopId: ' + r.shopId + '  sellerId: ' + r.sellerId);
  console.log('\n=== 逐页结果 ===');
  (r.页 || []).forEach((l) => console.log('  ' + l));

  await page.close();
  await b.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
