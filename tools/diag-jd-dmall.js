/**
 * 挖 dmAllGoods 模块的数据源。
 *
 * 线索：window._JModuleRequireMap 里有个 dmAllGoods（店铺装修的「全部商品」模块），
 * 而页面又在调 checkFree.html?skuIds=...。找到它的配置就能知道商品从哪来。
 *
 * 用法：node tools/diag-jd-dmall.js [店铺首页 URL]
 */
'use strict';
const CDP = require('./cdp');

const HOME = process.argv[2] || 'https://mall.jd.com/index-1000004123.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await CDP.connect(9222);
  const page = await b.open(HOME);
  await sleep(12000);

  const r = await page.evaluate(`
    var out = {};
    function sj(v, n) {
      try { var s = JSON.stringify(v); return s.length > (n || 900) ? s.slice(0, n || 900) + ' …(' + s.length + 'B)' : s; }
      catch (e) { return '(循环引用)'; }
    }
    var M = window._JModuleRequireMap;
    out.模块名 = M ? Object.keys(M) : '(没有 _JModuleRequireMap)';
    out.dmAllGoods = M && M.dmAllGoods ? sj(M.dmAllGoods, 1600) : '(无)';

    // 装修模块数据往往挂在别的全局上
    ['pageConfig', '_JModuleConfig', 'JModuleData', 'dmData', 'pageData', 'shopConfig'].forEach(function (k) {
      if (window[k]) out['window.' + k] = sj(window[k], 700);
    });

    // HTML 里 dmAllGoods 附近的片段
    var html = document.documentElement.innerHTML;
    var i = html.indexOf('dmAllGoods');
    out.dmAllGoods在HTML的位置 = i;
    if (i > -1) out.dmAllGoods附近 = html.slice(Math.max(0, i - 200), i + 900).replace(/\\s+/g, ' ');

    // 找所有像「商品列表数据」的 JSON 块
    var pats = [
      { name: 'skuId数组', re: /\\[\\s*(?:\\d{8,20}\\s*,\\s*){3,}\\d{8,20}\\s*\\]/g },
      { name: 'wareList', re: /"wareList"\\s*:\\s*\\[/g },
      { name: 'goodsList', re: /"goods(?:List|Info|Data)"\\s*:/g }
    ];
    out.数据块 = {};
    pats.forEach(function (p) {
      var m = html.match(p.re);
      out.数据块[p.name] = m ? { 次数: m.length, 首个: m[0].slice(0, 220) } : null;
    });

    return out;
  `, true);

  console.log('模块名: ' + JSON.stringify(r.模块名));
  console.log('\ndmAllGoods 配置:');
  console.log('  ' + String(r.dmAllGoods || '').slice(0, 1400));
  console.log('\ndmAllGoods 在 HTML 位置: ' + r.dmAllGoods在HTML的位置);
  console.log('附近片段:');
  console.log('  ' + String(r.dmAllGoods附近 || '').slice(0, 700));
  console.log('\n其他全局:');
  Object.keys(r).filter((k) => k.indexOf('window.') === 0).forEach((k) => {
    console.log('  ' + k + ' = ' + String(r[k]).slice(0, 400));
  });
  console.log('\n数据块:');
  Object.keys(r.数据块 || {}).forEach((k) => {
    const v = r.数据块[k];
    console.log('  ' + k + ': ' + (v ? '次数 ' + v.次数 + '  首个 ' + v.首个 : '无'));
  });

  await b.close();
})().catch((e) => { console.error('ERR', e && e.message); process.exit(1); });
