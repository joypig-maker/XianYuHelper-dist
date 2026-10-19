/**
 * 拦截店铺页的商品接口，看返回了什么、我们为什么没解析出来。
 *
 *   node tools/probe-shop.js <店铺URL> [--keep]
 *
 * 新开一个标签做这件事，不动用户当前打开的页面。
 * 拦 XHR + fetch，reload 一次把加载期的请求全部录下来。
 */
'use strict';

const PORT = Number(process.env.CDP_PORT || 9222);

function httpJson(port, p, method) {
  return new Promise((resolve, reject) => {
    const req = require('http').request(
      { host: '127.0.0.1', port, path: p, method: method || 'GET', timeout: 10000 },
      (res) => {
        let b = [];
        res.on('data', (d) => b.push(d));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(b).toString())); }
          catch (e) { reject(new Error('非 JSON: ' + Buffer.concat(b).slice(0, 160))); }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('CDP 无响应')));
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeSender(ws) {
  const send = (method, params) => {
    const id = ++send._id;
    ws.send(JSON.stringify({ id, method, params: params || {} }));
    return new Promise((resolve, reject) => send._w.set(id, { resolve, reject }));
  };
  send._id = 0; send._w = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id != null && send._w.has(m.id)) {
      const w = send._w.get(m.id); send._w.delete(m.id);
      m.error ? w.reject(new Error(JSON.stringify(m.error))) : w.resolve(m.result);
    }
  });
  return send;
}

/**
 * want 里的 URL 命中时，把响应全文留下来供事后分析。
 * 店铺页不把商品写进 DOM（连 <a> 都没有），只能靠接口反查。
 */
const INJECT = `
window.__PROBE__ = { reqs: [], texts: {} };
(function () {
  var P = window.__PROBE__;
  var WANT = ${JSON.stringify((process.env.PROBE_WANT || 'moduledata,offerlist,getShopOffer,unifiedRenderData').split(','))};
  function want(u) { for (var i = 0; i < WANT.length; i++) { if (u.indexOf(WANT[i]) > -1) return true; } return false; }
  function note(url, type, body, text) {
    P.reqs.push({ t: Date.now(), type: type, url: String(url).slice(0, 200), body: body });
    if (text != null && want(String(url))) {
      P.texts[WANT.filter(function (w) { return String(url).indexOf(w) > -1; }).join('_')] = text;
    }
  }
  var XO = window.XMLHttpRequest;
  function Patched() {
    var x = new XO();
    var u = '';
    var realOpen = x.open;
    x.open = function (m, url) { u = url; try { return realOpen.apply(this, arguments); } catch (e) { throw e; } };
    var realSend = x.send;
    x.send = function (b) {
      this.addEventListener('load', function () {
        var len = 0, head = '', txt = null;
        try { txt = this.responseText || ''; len = txt.length; head = txt.slice(0, 80); } catch (e) {}
        note(u, 'xhr', { len: len, head: head }, len < 400000 ? txt : null);
      });
      try { return realSend.apply(this, arguments); } catch (e) { throw e; }
    };
    return x;
  }
  window.XMLHttpRequest = Patched;
  var realFetch = window.fetch;
  window.fetch = function () {
    var u = (arguments[0] && arguments[0].url) ? arguments[0].url : String(arguments[0]);
    return realFetch.apply(this, arguments).then(function (r) {
      r.clone && r.clone().text && r.clone().text().then(function (t) {
        note(u, 'fetch', { len: (t || '').length, head: (t || '').slice(0, 80) }, (t || '').length < 400000 ? t : null);
      }).catch(function () {});
      return r;
    });
  };
})();
`;

(async () => {
  const url = process.argv[2];
  if (!url) throw new Error('用法: node tools/probe-shop.js <店铺URL>');
  const keep = process.argv.includes('--keep');

  const created = await httpJson(PORT, '/json/new?' + encodeURIComponent('about:blank'), 'PUT');
  const wantId = created.id;
  let tab = null;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const list = await httpJson(PORT, '/json/list');
    tab = list.find((t) => t.id === wantId && t.webSocketDebuggerUrl);
    if (tab) break;
  }
  if (!tab) throw new Error('新标签没出现');

  const ws = new globalThis.WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws 失败'))); });
  const send = makeSender(ws);
  await send('Runtime.enable');
  await send('Page.enable');
  // 文档开始时就装监听，reload 时才拦得住
  await send('Page.addScriptToEvaluateOnNewDocument', { source: INJECT });

  await send('Page.navigate', { url });
  await sleep(12000);

  // 先把留存下来的原始响应落盘，供离线断言用
  const saveIdx = process.argv.indexOf('--save');
  if (saveIdx > -1) {
    const saveTo = process.argv[saveIdx + 1];
    const dump = await send('Runtime.evaluate', {
      expression: 'JSON.stringify((window.__PROBE__||{texts:{}}).texts)',
      returnByValue: true
    });
    require('fs').mkdirSync(require('path').dirname(saveTo), { recursive: true });
    require('fs').writeFileSync(saveTo, dump.result.value || '{}', 'utf8');
    console.log('已保存响应到', saveTo);
  }

  const out = await send('Runtime.evaluate', {
    expression: '(function(){var P=window.__PROBE__||{reqs:[],texts:{}};'
      + 'var keys=Object.keys(P.texts||{});'
      + 'var found=keys.map(function(k){'
      + '  var j=null; try{ j=JSON.parse(P.texts[k]); }catch(e){ return {key:k,err:"非JSON"}; }'
      + '  var hits=[];'
      + '  (function walk(o,p,d){'
      + '    if(!o||typeof o!=="object"||d>9) return;'
      + '    for(var kk of Object.keys(o)){'
      + '      var v=o[kk], lp=String(kk).toLowerCase();'
      + '      if(/^(offerid|itemid|skuid|productid)$/.test(lp)&&v!=null) hits.push({path:p+"."+kk,val:String(v).slice(0,22)});'
      + '      if(v&&typeof v==="object") walk(v,p+"."+kk,d+1);'
      + '    }'
      + '  })(j,k,0);'
      + '  var tree=[];'
      + '  (function shape(o,p,d){'
      + '    if(!o||typeof o!=="object"||d>4) return;'
      + '    for(var kk of Object.keys(o).slice(0,14)){'
      + '      var v=o[kk];'
      + '      var t=Array.isArray(v)?("array("+v.length+")"):(v&&typeof v==="object"?"object":typeof v);'
      + '      tree.push(p+"."+kk+" :: "+t+(v&&typeof v==="object"?"":" = "+String(v).slice(0,26)));'
      + '      if(v&&typeof v==="object") shape(v,p+"."+kk,d+1);'
      + '    }'
      + '  })(j.data||j,k,0);'
      + '  return {key:k,len:P.texts[k].length,topKeys:Object.keys(j).slice(0,12),'
      + '          hitCount:hits.length,hits:hits.slice(0,10),tree:tree.slice(0,40)};'
      + '});'
      + 'return {url:location.href.slice(0,110),'
      + '        cards:((window.__XY__&&window.__XY__.getCards)?window.__XY__.getCards():[]).length,'
      + '        reqCount:P.reqs.length, textsKeys:keys, found:found};})()',
    returnByValue: true
  });
  const r = out.result.value;
  console.log('URL     :', r.url);
  console.log('插件抓到:', r.cards, '个商品');
  console.log('拦到请求:', r.reqCount, '条');
  console.log('留存响应:', JSON.stringify(r.textsKeys));
  (r.found || []).forEach(function (f) {
    console.log('  === ' + f.key + '  ' + (f.len || f.err || ''));
    if (f.topKeys) console.log('      顶层键: ' + f.topKeys.join(', '));
    console.log('      offerId 命中 ' + (f.hitCount != null ? f.hitCount : '-') + ' 处');
    (f.hits || []).forEach(function (h) { console.log('        ' + h.path + ' = ' + h.val); });
    if (f.tree) { console.log('      结构:'); f.tree.forEach(function (t) { console.log('        ' + t); }); }
  });
  console.log('-------------------------------------------------------------');
  r.reqs.forEach((q) => {
    const u = q.url.replace(/^https?:\/\//, '');
    console.log('[' + q.type + '] ' + u.slice(0, 120));
    console.log('       body: ' + JSON.stringify(q.body).slice(0, 150));
  });
  if (!keep) { try { ws.close(); await httpJson(PORT, '/json/close/' + wantId); } catch (e) {} }
})().catch((e) => { console.error('ERR', e.message.split('\n')[0]); process.exit(1); });
