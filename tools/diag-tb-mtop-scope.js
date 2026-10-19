/**
 * 判定：搜索页的 mtop 到底能不能用来调详情接口
 *
 * 已知：同一个 pcdetail.data.get，在**详情页**调通（拿到 5 张主图），
 * 在**搜索页**调全部超时。而批量补详情恰恰发生在搜索页——所以用户只下到 1 张图。
 *
 * 要区分两种可能：
 *   (a) 搜索页的 lib.mtop 整体不可用（token 域名/签名问题）
 *   (b) 只是详情类接口需要详情页上下文（referer、exParams 里的 domain/path）
 * 判据：拿几个「跟详情无关的简单接口」做对照。它们通了就说明是 (b)。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const CDP = require('./cdp');

const ROOT = path.join(__dirname, '..');
const UTIL = fs.readFileSync(path.join(ROOT, 'src/common/util.js'), 'utf8');
const SITES = fs.readFileSync(path.join(ROOT, 'src/common/sites.js'), 'utf8');

const PROBE = `return (async function(){
  var out = { host: location.host };

  function call(api, v, data){
    return new Promise(function(resolve){
      var done = false;
      function finish(x){ if (!done) { done = true; resolve(x); } }
      try {
        var ret = window.lib.mtop.request({ api: api, v: v, data: data },
          function(r){ finish(r); }, function(e){ finish({ fail: String(e).slice(0,60) }); });
        if (ret && typeof ret.then === 'function') ret.then(finish, function(){ finish(null); });
        else if (ret && typeof ret === 'object' && (ret.data || ret.ret)) finish(ret);
      } catch (e) { finish({ threw: e.message }); }
      setTimeout(function(){ finish({ timeout: true }); }, 10000);
    });
  }

  function brief(tag, r){
    if (!r) return tag + ' → null';
    if (r.timeout) return tag + ' → 超时';
    if (r.fail) return tag + ' → 失败回调: ' + r.fail;
    if (r.threw) return tag + ' → 抛异常: ' + r.threw;
    var d = r.data;
    var n = d && typeof d === 'object' ? Object.keys(d).length : 0;
    return tag + ' → ret=' + JSON.stringify(r.ret || '').slice(0, 28) + ' data键=' + n;
  }

  // 用 scanCards 拿真实商品 ID（比猜选择器可靠）。
  // 注意：ID 取空会让后面所有详情调用都拿空参数去撞，结果全是超时——
  // 那是探测脚本自己的锅，不能当成「接口不可用」的证据。
  // 页面状态：淘宝频繁访问会给空页/验证页，那时 DOM 里一张卡片都没有，
  // 不能把这种环境问题当成「选择器配错了」或「接口不可用」。
  out.页面状态 = {
    title: String(document.title).slice(0, 50),
    body长度: document.body ? document.body.innerText.length : 0,
    body前80: document.body ? document.body.innerText.replace(/\s+/g, ' ').slice(0, 80) : '',
    有滑块痕迹: !!document.querySelector('[class*="nc_"], [id*="nc_"], [class*="captcha"], [class*="baxia"]')
  };

  // 优先用 scanCards 拿真实 ID；拿不到就退回命令行传入的固定 ID
  // （固定值取自店铺列表接口，稳定可用），保证接口结论不被空 DOM 污染。
  var U = window.XYUtil, S = window.XYSites;
  var site = (S && S.match) ? S.match(location.host) : null;
  var cards = (U && site) ? U.scanCards(document, site) : [];
  out.dom探测 = site ? {
    wrapper数: document.querySelectorAll('[class*="doubleCardWrapper"]').length,
    cardSel: String(site.cardSel),
    cardSel命中: (function () { try { return document.querySelectorAll(site.cardSel).length; } catch (e) { return 'err'; } })(),
    idFrom类型: typeof site.idFrom
  } : '(无 site)';
  out.scanCards结果 = cards.length;

  var FALLBACK_ID = ${JSON.stringify(process.argv[3] || '669745626548')};
  var realId = cards.length ? String(cards[0].itemId) : FALLBACK_ID;
  out.真实商品ID = realId;
  out.ID来源 = cards.length ? 'search DOM' : '命令行固定值';

  out.结果 = [];
  // 对照 1：完全与详情无关的简单接口
  out.结果.push(brief('对照 mtop.user.getusersimple',
    await call('mtop.user.getusersimple', '1.0', {})));
  // 对照 2：店铺商品列表（已知在店铺页可用，与详情无关）
  out.结果.push(brief('对照 shop.simple.item.fetch',
    await call('mtop.taobao.shop.simple.item.fetch', '1.0',
      { page: 1, orderType: 'popular', catId: 0, feature: '{}', shopId: '375415709', sellerId: '2200811463590' })));
  // 目标 1：详情主数据
  out.结果.push(brief('详情 pcdetail.data.get',
    await call('mtop.taobao.pcdetail.data.get', '1.0', { id: realId, detail_v: '3.3.2' })));
  // 目标 2：老牌详情接口
  out.结果.push(brief('详情 detail.getdetail v6.0',
    await call('mtop.taobao.detail.getdetail', '6.0', { itemNumId: realId })));
  // 目标 3：详情描述
  out.结果.push(brief('详情 detail.getdesc v6.0',
    await call('mtop.taobao.detail.getdesc', '6.0', { id: realId, detail_v: '3.3.0', preferWireless: 'true' })));

  return out;
})()`;

(async () => {
  const b = await CDP.connect(9222);
  const { targetId } = await b.createTarget('about:blank');
  const page = await b.attachTarget({ id: targetId });

  const url = process.argv[2] || ('https://s.taobao.com/search?q=' + encodeURIComponent('手机支架'));
  console.log('页面: ' + url);
  await page.goto(url, 45000);
  await new Promise((r) => setTimeout(r, 8000));
  await page.evaluate(UTIL + '\n' + SITES + '\nreturn 1;');

  const r = await page.evaluate(PROBE, true);
  console.log('host: ' + r.host + '   真实商品ID: ' + r.真实商品ID);
  console.log('\n=== 结果 ===');
  (r.结果 || []).forEach((l) => console.log('  ' + l));
  if (r.页面状态) console.log('  页面: ' + JSON.stringify(r.页面状态));
  if (r.dom探测) console.log('  DOM: ' + JSON.stringify(r.dom探测));
  console.log('  scanCards=' + r.scanCards结果 + '  ID=' + r.真实商品ID + ' 来源=' + r.ID来源);

  await page.close();
  await b.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
