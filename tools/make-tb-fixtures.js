/**
 * 抓取淘宝详情接口响应，存为离线固件
 *
 * 离线测试不能依赖真机，但淘宝的关键结构（data.item.images / pcDescContent）
 * 必须用真实响应锁住——凭想象构造的 JSON 测不出「接口叫 get 而不是 adjust」这类坑。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const CDP = require('./cdp');

const ID = process.argv[2] || '669745626548';
const OUT = path.join(__dirname, 'fixtures');
fs.mkdirSync(OUT, { recursive: true });

const PROBE = `return (async function(){
  var ID = ${JSON.stringify(ID)};
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
  var main = await mtop('mtop.taobao.pcdetail.data.get', '1.0', { id: ID, detail_v: '3.3.2' });
  var desc = await mtop('mtop.taobao.detail.getdesc', '6.0', { id: ID, detail_v: '3.3.0', preferWireless: 'true' });
  return { main: main && main.data ? main.data : null, desc: desc && desc.data ? desc.data : null };
})()`;

(async () => {
  const b = await CDP.connect(9222);
  const { targetId } = await b.createTarget('about:blank');
  const page = await b.attachTarget({ id: targetId });
  await page.goto('https://detail.tmall.com/item.htm?id=' + ID, 45000);
  await new Promise((r) => setTimeout(r, 5000));

  const r = await page.evaluate(PROBE, true);
  if (r.main) {
    fs.writeFileSync(path.join(OUT, 'tb-detail.json'), JSON.stringify(r.main, null, 1));
    console.log('主数据固件: %d 字节, 键=%s', fs.statSync(path.join(OUT, 'tb-detail.json')).size,
      Object.keys(r.main).slice(0, 8).join(','));
  } else console.log('主数据抓取失败');

  if (r.desc) {
    fs.writeFileSync(path.join(OUT, 'tb-desc.json'), JSON.stringify(r.desc, null, 1));
    console.log('详情图固件: %d 字节, 键=%s', fs.statSync(path.join(OUT, 'tb-desc.json')).size,
      Object.keys(r.desc).join(','));
  } else console.log('详情图抓取失败');

  await page.close();
  await b.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
