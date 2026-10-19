/**
 * 让详情接口在「非详情页」也能调通
 *
 * 已确认：pcdetail.data.get / detail.getdetail / detail.getdesc 在搜索页全部超时，
 * 而同页面的 shop.simple.item.fetch 秒通——说明它们要求详情页上下文。
 * 抓包看到详情页请求时 data 里带了一长串 exParams（domain / path_name / pcSource…），
 * 这里逐个试，看补上它能否在搜索页调通。
 *
 * 这是成本最低的修法：若成立，只需给 sites.js 的 buildData 补一个字段。
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
        // 顺手看拿到几张主图
        var imgs = 0;
        try { imgs = window.XYUtil.extractDetail(d, {detailPaths:{images:['item.images']}}) ? window.XYUtil.extractDetail(d, {detailPaths:{images:['item.images']}}).images.length : 0; } catch(e){}
        resolve(tag + ' → ret=' + JSON.stringify(x.ret||'').slice(0,26) + ' data键=' + n + ' 主图=' + imgs);
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
  var API = 'mtop.taobao.pcdetail.data.get';

  // 0：不带 exParams（基线，应超时）
  out.结果.push(await call('基线 无 exParams', API, '1.0', { id: ID, detail_v: '3.3.2' }));

  // 1：完整 exParams（domain 指向详情页）
  var full = JSON.stringify({ id: ID, queryParams: 'id=' + ID,
    domain: 'https://detail.tmall.com', path_name: '/item.htm',
    pcSource: 'pcTaobaoMainSSR', skuId: '' });
  out.结果.push(await call('带完整 exParams(detail.tmall)', API, '1.0',
    { id: ID, detail_v: '3.3.2', exParams: full }));

  // 2：exParams 的 domain 用当前站点
  var same = JSON.stringify({ id: ID, queryParams: 'id=' + ID,
    domain: location.origin, path_name: '/item.htm', pcSource: 'pcTaobaoMainSSR', skuId: '' });
  out.结果.push(await call('exParams.domain=当前站', API, '1.0',
    { id: ID, detail_v: '3.3.2', exParams: same }));

  // 3：老接口 detail.getdetail 带 exParams
  out.结果.push(await call('detail.getdetail v6.0 + exParams', 'mtop.taobao.detail.getdetail', '6.0',
    { itemNumId: ID, exParams: full }));

  // 4：不传 detail_v 看看
  out.结果.push(await call('只给 id', API, '1.0', { id: ID }));

  return out;
})()`;

(async () => {
  const b = await CDP.connect(9222);
  const { targetId } = await b.createTarget('about:blank');
  const page = await b.attachTarget({ id: targetId });
  await page.goto('https://s.taobao.com/search?q=' + encodeURIComponent('数据线'), 45000);
  await new Promise((r) => setTimeout(r, 7000));
  await page.evaluate(UTIL + '\n' + SITES + '\nreturn 1;');

  const r = await page.evaluate(PROBE, true);
  console.log('当前页: ' + r.host + '（应为 s.taobao.com，非详情页）');
  console.log('\n=== 结果 ===');
  (r.结果 || []).forEach((l) => console.log('  ' + l));

  await page.close();
  await b.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
