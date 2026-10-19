/**
 * 淘宝详情主数据接口定位
 *
 * 现状：mtop.taobao.pcdetail.data.adjust 返回 SUCCESS 但 data 是空对象
 * ——名字里的 adjust 就是「增量调整」，它只在页面已有基准数据时才给东西，
 * 单独调用拿不到。真正的主数据接口得试出来，不能猜。
 *
 * 候选来自店透视的接口清单（它同时列了 pcdetail.data.get / detail.getdetail /
 * detail.data.get），加上实测抓到的参数形态（exParams / skuId 都不能随便省）。
 */
'use strict';

const path = require('path');
const CDP = require('./cdp');

const ID = process.argv[2] || '669745626548';
const SKU = process.argv[3] || '5743745873022';

const PROBE = `return (async function(){
  var U = window.XYUtil;
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

  var exParams = JSON.stringify({ id: ID, queryParams: 'id=' + ID,
    domain: location.origin, path_name: '/item.htm', pcSource: 'pcTaobaoMainSSR', skuId: SKU });

  var cases = [
    ['mtop.taobao.pcdetail.data.get',      '1.0', { id: ID, detail_v: '3.3.2' }],
    ['mtop.taobao.pcdetail.data.get',      '1.0', { id: ID, detail_v: '3.3.2', exParams: exParams }],
    ['mtop.taobao.pcdetail.data.adjust',   '1.0', { id: ID, detail_v: '3.3.2', exParams: exParams }],
    ['mtop.taobao.detail.getdetail',       '1.0', { itemNumId: ID }],
    ['mtop.taobao.detail.getdetail',       '6.0', { itemNumId: ID }],
    ['mtop.taobao.detail.data.get',        '1.0', { id: ID }],
    ['mtop.taobao.detail.getdesc',         '6.0', { id: ID, skuId: SKU, detail_v: '3.3.0', preferWireless: 'true' }],
    ['mtop.taobao.detail.getdesc',         '7.0', { id: ID, skuId: SKU, detail_v: '3.3.0', preferWireless: 'true' }]
  ];

  var out = [];
  for (var i = 0; i < cases.length; i++) {
    var c = cases[i];
    var r = await mtop(c[0], c[1], c[2]);
    var biz = r && r.data;
    var row = { api: c[0] + ' v' + c[1], 参数: Object.keys(c[2]).join('+'),
                ret: r && r.ret ? JSON.stringify(r.ret).slice(0, 46) : '(null)',
                data键数: biz && typeof biz === 'object' ? Object.keys(biz).length : '(无)' };

    if (biz && typeof biz === 'object' && Object.keys(biz).length) {
      // 主图 / 价格 / 详情图 三条线索
      var d = U.extractDetail(biz, { detailPaths: {
        images: ['componentsVO.headImageVO.images'],
        price: ['componentsVO.priceVO.extraPrice.priceText', 'componentsVO.priceVO.price.priceText'],
        title: ['componentsVO.titleVO.title.title']
      }});
      if (d) { row.图 = d.images.length; row.价 = d.price || '(空)'; }
      row.详情图 = U.parseTaobaoDesc(biz).length;
      row.顶层键 = Object.keys(biz).slice(0, 8).join(',');
    }
    out.push(row);
  }
  return out;
})()`;

(async () => {
  const b = await CDP.connect(9222);
  const { targetId } = await b.createTarget('about:blank');
  const page = await b.attachTarget({ id: targetId });
  await page.goto('https://detail.tmall.com/item.htm?id=' + ID, 45000);
  await new Promise((r) => setTimeout(r, 5000));

  const fs = require('fs');
  const ROOT = path.join(__dirname, '..');
  await page.evaluate(
    fs.readFileSync(path.join(ROOT, 'src/common/util.js'), 'utf8') + '\nreturn 1;'
  );

  const rows = await page.evaluate(PROBE, true);
  console.log('=== 详情主数据接口候选（首页是详情页，lib.mtop 可用）===');
  rows.forEach((r) => {
    console.log('\n▸ ' + r.api + '   参数=' + r.参数);
    console.log('    ret=' + r.ret + '  data键数=' + r.data键数);
    if (r.顶层键) console.log('    顶层键=' + r.顶层键);
    if (r.图 !== undefined) console.log('    → 主图 ' + r.图 + ' 张, 价格=' + r.价 + ', 详情图 ' + r.详情图 + ' 张');
  });

  await page.close();
  await b.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
