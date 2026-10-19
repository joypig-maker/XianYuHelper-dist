/**
 * 在京东店铺页里找商品数据源。
 *
 * 线索：页面在调 mall.jd.com/view/checkFree.html?skuIds=100290805111,100291234557,...
 * 说明 skuId 列表页面手里已经有了，只是商品卡片没渲染出来。
 * 这一步去 HTML / 全局变量里把它挖出来。
 *
 * 用法：node tools/diag-jd-data.js [店铺首页 URL]
 */
'use strict';
const CDP = require('./cdp');

const HOME = process.argv[2] || 'https://mall.jd.com/index-1000004123.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await CDP.connect(9222);
  const page = await b.open(HOME);
  await sleep(14000);

  const r = await page.evaluate(`
    var out = {};
    var html = document.documentElement.innerHTML;
    out.html长度 = html.length;

    // ① HTML 里出现的 skuIds= 片段
    var m = html.match(/skuIds?["'=:]{1,3}[\\[\\"]?([0-9]{8,20}(?:[,\\"%2C]+[0-9]{8,20}){2,})/g);
    out.html里的skuIds片段 = m ? m.slice(0, 3).map(function (s) { return s.slice(0, 200); }) : [];

    // ② inline script 里含商品关键词的
    var scripts = Array.prototype.slice.call(document.querySelectorAll('script:not([src])'));
    out.inline脚本数 = scripts.length;
    var hits = [];
    scripts.forEach(function (s, i) {
      var t = s.textContent || '';
      if (/sku|goodsList|wareList|productList|shopGoods/i.test(t)) {
        hits.push({ i: i, len: t.length, head: t.replace(/\\s+/g, ' ').slice(0, 260) });
      }
    });
    out.含商品关键词的脚本 = hits.slice(0, 6);

    // ③ window 上的相关全局变量
    var g = [];
    try {
      Object.keys(window).forEach(function (k) {
        if (/^(goods|sku|ware|shop|list|page|data|_)/i.test(k) && !/^(webkit|on)/i.test(k)) {
          var v = window[k];
          var t = typeof v;
          if (t === 'object' && v) {
            var keys = Object.keys(v).slice(0, 8);
            g.push(k + ' : ' + t + '  keys=' + JSON.stringify(keys));
          } else if (t === 'string' || t === 'number') {
            g.push(k + ' : ' + t + ' = ' + String(v).slice(0, 40));
          }
        }
      });
    } catch (e) { g.push('枚举失败: ' + e.message); }
    out.全局变量 = g.slice(0, 24);

    // ④ 页面里像商品 ID 的长数字串（≥6 个连续不同 ID 才认为是一批商品）
    var ids = html.match(/\\b1\\d{10,12}\\b/g) || [];
    var uniq = [];
    var seen = {};
    ids.forEach(function (x) { if (!seen[x]) { seen[x] = 1; uniq.push(x); } });
    out.HTML里的长数字 = uniq.length;
    out.长数字样例 = uniq.slice(0, 10);

    return out;
  `, true);

  console.log('HTML 长度: ' + r.html长度);
  console.log('\n① HTML 里的 skuIds 片段:');
  (r.html里的skuIds片段 || []).forEach((s) => console.log('  ' + s));
  console.log('\n② inline 脚本 ' + r.inline脚本数 + ' 个，含商品关键词的:');
  (r.含商品关键词的脚本 || []).forEach((x) => console.log('  #' + x.i + ' (' + x.len + 'B) ' + x.head));
  console.log('\n③ 全局变量:');
  (r.全局变量 || []).forEach((x) => console.log('  ' + x));
  console.log('\n④ 页面里的长数字（疑似商品 ID）: ' + r.HTML里的长数字);
  console.log('  样例: ' + JSON.stringify(r.长数字样例));

  await b.close();
})().catch((e) => { console.error('ERR', e && e.message); process.exit(1); });
