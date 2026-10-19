/**
 * 验证假设：详情接口的准入判据是请求的 Referer / Origin
 *
 * 已知：pcdetail.data.get 在详情页通、在搜索页超时，
 * 补 exParams 也没用。那剩下的可能就落在这条请求「是谁发起的」上——
 * 服务端按 Referer/Origin 区分页面类型，列表页来的详情请求直接晾着。
 *
 * 这里用 CDP 的 Fetch 域拦截发往 h5api 的请求，把 Referer/Origin 改成详情页，
 * 再看同一份代码在搜索页能否调通。通了就说明修法是在扩展里加一条 DNR 规则，
 * 不必自己实现签名、也不必搞 iframe。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const CDP = require('./cdp');

const ROOT = path.join(__dirname, '..');
const UTIL = fs.readFileSync(path.join(ROOT, 'src/common/util.js'), 'utf8');
const SITES = fs.readFileSync(path.join(ROOT, 'src/common/sites.js'), 'utf8');

const ID = process.argv[2] || '669745626548';

const PROBE = `return (async function(){
  var ID = ${JSON.stringify(ID)};
  function call(tag, api, v, data){
    return new Promise(function(resolve){
      var done = false;
      function finish(x){
        if (done) return; done = true;
        if (!x) return resolve(tag + ' → null');
        if (x.timeout) return resolve(tag + ' → 超时');
        if (x.fail) return resolve(tag + ' → 失败回调');
        if (x.threw) return resolve(tag + ' → 抛异常: ' + x.threw);
        var d = x.data;
        var n = d && typeof d === 'object' ? Object.keys(d).length : 0;
        return resolve(tag + ' → ret=' + JSON.stringify(x.ret||'').slice(0,26) + ' data键=' + n);
      }
      try {
        var ret = window.lib.mtop.request({ api: api, v: v, data: data },
          function(r){ finish(r); }, function(){ finish({fail:true}); });
        if (ret && typeof ret.then === 'function') ret.then(finish, function(){ finish(null); });
        else if (ret && typeof ret === 'object' && (ret.data || ret.ret)) finish(ret);
      } catch (e) { finish({threw: e.message}); }
      setTimeout(function(){ finish({timeout:true}); }, 12000);
    });
  }
  var out = { host: location.host, 结果: [] };
  out.结果.push(await call('pcdetail.data.get', 'mtop.taobao.pcdetail.data.get', '1.0',
    { id: ID, detail_v: '3.3.2' }));
  out.结果.push(await call('detail.getdesc v6.0', 'mtop.taobao.detail.getdesc', '6.0',
    { id: ID, detail_v: '3.3.0', preferWireless: 'true' }));
  return out;
})()`;

async function attempt(b, rewrite, label) {
  const { targetId } = await b.createTarget('about:blank');
  const page = await b.attachTarget({ id: targetId });

  if (rewrite) {
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*h5api.m.*' }] });
    page.on('Fetch.requestPaused', async (p) => {
      try {
        const orig = p.request.headers || {};
        const hs = Object.keys(orig)
          .filter((k) => !/^(referer|origin)$/i.test(k))
          .map((k) => ({ name: k, value: String(orig[k]) }));
        hs.push({ name: 'Referer', value: 'https://detail.tmall.com/' });
        hs.push({ name: 'Origin', value: 'https://detail.tmall.com' });
        await page.send('Fetch.continueRequest', { requestId: p.requestId, headers: hs });
      } catch (e) {
        try { await page.send('Fetch.continueRequest', { requestId: p.requestId }); } catch (e2) {}
      }
    });
  }

  await page.goto('https://s.taobao.com/search?q=' + encodeURIComponent('数据线'), 45000);
  await new Promise((r) => setTimeout(r, 7000));
  await page.evaluate(UTIL + '\n' + SITES + '\nreturn 1;');

  const r = await page.evaluate(PROBE, true);
  console.log('\n=== ' + label + '（当前页 ' + r.host + '）===');
  (r.结果 || []).forEach((l) => console.log('  ' + l));

  await page.close();
}

(async () => {
  const b = await CDP.connect(9222);
  await attempt(b, false, 'A 不改请求头（基线）');
  await attempt(b, true, 'B 把 Referer/Origin 改写成 detail.tmall.com');
  await b.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
