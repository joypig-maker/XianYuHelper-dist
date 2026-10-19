/**
 * 定位「补详情全部失败」的根因
 *
 * 现象：搜索页点打包 → toast 停在「正在补齐 N 个商品的详情…」→ 再无下文，
 * 最后用列表页的 1 张缩略图收场。
 *
 * 疑点：fetchCardDetailCore 调 mtopRequest 时带了 1688 那套参数
 * （sessionOption: 'AutoLoginOnly'），而淘宝不一定认。
 * 这里用搜索页的**真实卡片 ID** 逐个参数形式试，看哪种能拿到数据。
 */
'use strict';

const CDP = require('./cdp');

const PROBE = `return (async function(){
  var out = { };

  // 先拿搜索页真实卡片的 itemId。
  // 注意 data-spm-act-id 挂在卡片内部的 <a> 上，不在外层 wrapper 上
  // （scanCards 是靠 site.idFrom 向上查找才命中的），别写成复合选择器。
  var el = document.querySelector('[data-spm-act-id]');
  var id = el ? String(el.getAttribute('data-spm-act-id')).trim() : '';
  out.搜索页首卡ID = id;
  if (!id) return out;

  function call(params){
    return new Promise(function(resolve){
      var done = false;
      function finish(x){ if (!done) { done = true; resolve(x); } }
      try {
        var ret = window.lib.mtop.request(params,
          function(r){ finish(r); }, function(e){ finish({ fail: String(e).slice(0,80) }); });
        if (ret && typeof ret.then === 'function') ret.then(finish, function(){ finish(null); });
        else if (ret && typeof ret === 'object' && (ret.data || ret.ret)) finish(ret);
      } catch (e) { finish({ threw: e.message }); }
      setTimeout(function(){ finish({ timeout: true }); }, 12000);
    });
  }

  function summarize(tag, r){
    if (!r) return tag + ' → null';
    if (r.fail) return tag + ' → 失败回调: ' + r.fail;
    if (r.threw) return tag + ' → 抛异常: ' + r.threw;
    if (r.timeout) return tag + ' → 超时';
    var d = r.data;
    var keys = d && typeof d === 'object' ? Object.keys(d) : [];
    return tag + ' → ret=' + JSON.stringify(r.ret||'').slice(0,30) +
           ' data键数=' + keys.length + (keys.length ? ' [' + keys.slice(0,5).join(',') + ']' : '');
  }

  var API = 'mtop.taobao.pcdetail.data.get';
  var DATA = { id: id, detail_v: '3.3.2' };

  out.结果 = [];

  // A：injected.js 现在用的形式（1688 那套参数）
  out.结果.push(summarize('A 带 sessionOption:AutoLoginOnly',
    await call({ api: API, v: '1.0', data: DATA, timeout: 20000, needLogin: false, sessionOption: 'AutoLoginOnly' })));

  // B：最简形式
  out.结果.push(summarize('B 只给 api/v/data',
    await call({ api: API, v: '1.0', data: DATA })));

  // C：加 timeout + needLogin
  out.结果.push(summarize('C timeout+needLogin',
    await call({ api: API, v: '1.0', data: DATA, timeout: 15000, needLogin: false })));

  // D：加 sessionOption: AutoLogin
  out.结果.push(summarize('D sessionOption:AutoLogin',
    await call({ api: API, v: '1.0', data: DATA, timeout: 15000, needLogin: false, sessionOption: 'AutoLogin' })));

  return out;
})()`;

(async () => {
  const b = await CDP.connect(9222);
  const { targetId } = await b.createTarget('about:blank');
  const page = await b.attachTarget({ id: targetId });
  await page.goto('https://s.taobao.com/search?q=' + encodeURIComponent('手机支架'), 45000);
  await new Promise((r) => setTimeout(r, 7000));

  const r = await page.evaluate(PROBE, true);
  console.log('搜索页首卡 ID: ' + r.搜索页首卡ID);
  console.log('\n=== 各参数形式的结果 ===');
  (r.结果 || []).forEach((l) => console.log('  ' + l));

  await page.close();
  await b.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
