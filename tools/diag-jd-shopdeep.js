/**
 * 深挖京东店铺页：卡片完整结构、分页机制、店铺 ID 来源。
 *
 * 与 diag-jd-usershop.js 的区别：这里是「打开空白页 → 挂好监听 → 再导航」，
 * 所以能抓到导航过程中的全部请求（先 open(url) 再 on() 会漏掉首屏请求）。
 *
 * 用法：node tools/diag-jd-shopdeep.js <url> [url2 ...]
 */
'use strict';
const CDP = require('./cdp');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROBE = `
  var out = {};

  // ---- 1) 完整 dump 第一张卡片，看字段落点 ----
  var card = document.querySelector('.gl-item, [data-sku]');
  if (card) {
    // 往上找真正的卡片层（gl-item 是 li）
    var li = card.closest('li') || card;
    out.卡片标签 = li.tagName + ' class=' + String(li.className || '');
    out.卡片属性 = {};
    Array.prototype.forEach.call(li.attributes || [], function (a) {
      out.卡片属性[a.name] = String(a.value).slice(0, 60);
    });

    // 递归列出内部结构（标签 + 类名 + 短文本）
    out.树 = [];
    (function walk(n, d) {
      if (d > 5 || out.树.length > 60) return;
      if (n.nodeType !== 1) return;
      var tag = n.tagName.toLowerCase();
      var cls = String(n.className || '').trim().slice(0, 50);
      var own = '';
      for (var i = 0; i < n.childNodes.length; i++) {
        if (n.childNodes[i].nodeType === 3) own += n.childNodes[i].textContent.trim();
      }
      var extra = '';
      if (tag === 'img') extra = ' src=' + String(n.getAttribute('src') || n.getAttribute('data-lazy-img') || '').slice(0, 80);
      if (tag === 'a') extra = ' href=' + String(n.getAttribute('href') || '').slice(0, 60);
      if (own) extra += ' 文本="' + own.slice(0, 30) + '"';
      out.树.push('  '.repeat(d) + tag + (cls ? '.' + cls : '') + extra);
      for (var c = 0; c < n.children.length; c++) walk(n.children[c], d + 1);
    })(li, 0);
  } else {
    out.树 = ['(没找到卡片)'];
  }

  // ---- 2) 分页机制 ----
  out.分页 = { 节点数: 0, 样例: [], 文本: [] };
  var pgNodes = document.querySelectorAll('[class*="page"],[class*="pagin"],[id*="page"],[id*="pagin"]');
  out.分页.节点数 = pgNodes.length;
  Array.prototype.slice.call(pgNodes, 0, 10).forEach(function (n) {
    out.分页.样例.push(n.tagName + '.' + String(n.className || '').slice(0, 40) +
      ' | ' + String(n.innerText || '').replace(/\\s+/g, ' ').slice(0, 50));
  });
  // 总条数线索
  var bodyTxt = (document.body.innerText || '');
  var m = bodyTxt.match(/(?:共|总计)\\s*(\\d+)\\s*(?:件|个|款)/);
  out.总数线索 = m ? m[0] : '(未找到「共 N 件」)';
  out.含下一页 = /下一页|下页|Next/.test(bodyTxt);

  // ---- 3) 店铺 ID / 分页参数来源 ----
  var html = document.documentElement.innerHTML;
  function grab(re) { var x = html.match(re); return x ? x.slice(0, 3) : null; }
  out.页面里的ID线索 = {
    venderId: grab(/venderId["'\\s:=]+(\\d{5,12})/g),
    shopId: grab(/shopId["'\\s:=]+(\\d{5,12})/g),
    'index-(\\d+)': grab(/index-(\\d{5,12})/g),
    'view_search-(-?\\d+)': grab(/view_search-(\\d{5,12})/g),
    pageNum: grab(/pageNum["'\\s:=]+(\\d{1,4})/g),
    pageSize: grab(/pageSize["'\\s:=]+(\\d{1,4})/g)
  };

  // ---- 4) 卡片数量与 ID 列表（用来看「一页多少件」） ----
  var ids = [];
  Array.prototype.forEach.call(document.querySelectorAll('.gl-item'), function (li) {
    var s = li.getAttribute('data-sku') || li.getAttribute('data-skuid') ||
      (li.querySelector('[data-sku]') ? li.querySelector('[data-sku]').getAttribute('data-sku') : '');
    if (s) ids.push(String(s).trim());
  });
  out.glItem数 = document.querySelectorAll('.gl-item').length;
  out.dataSku数 = document.querySelectorAll('[data-sku]').length;
  out.一页ID数 = ids.length;
  out.前5个ID = ids.slice(0, 5);

  // ---- 5) 价格节点精确位置 ----
  var li2 = document.querySelector('.gl-item');
  if (li2) {
    var pn = li2.querySelector('[class*="p-price"],[class*="price"]');
    out.价格节点 = pn ? { 类名: String(pn.className), html: pn.innerHTML.replace(/\\s+/g, ' ').slice(0, 160) } : null;
    var tn = li2.querySelector('[class*="p-name"],[class*="name"]');
    out.标题节点 = tn ? { 类名: String(tn.className), html: tn.innerHTML.replace(/\\s+/g, ' ').slice(0, 160) } : null;
    var sn = li2.querySelector('[class*="p-shop"],[class*="shop"]');
    out.店铺节点 = sn ? { 类名: String(sn.className), 文本: (sn.innerText || '').slice(0, 30) } : null;
  }

  return out;
`;

(async () => {
  const urls = process.argv.slice(2);
  if (!urls.length) { console.error('用法: node tools/diag-jd-shopdeep.js <url> [...]'); process.exit(1); }
  const b = await CDP.connect(9222);

  for (const u of urls) {
    console.log('\n=============== ' + u.slice(0, 110));
    let page = null;
    try {
      // 先开空白页挂监听，再导航 —— 这样首屏请求才不会漏
      page = await b.open('about:blank');
      const reqs = [];
      page.on('Network.requestWillBeSent', (p) => {
        const url = (p && p.request && p.request.url) || '';
        if (/\\.(js|css|png|jpg|jpeg|webp|gif|svg|woff2?|ico)(\\?|$)/i.test(url)) return;
        if (/jd\\.com/.test(url) && !/log|report|stat|beacon|track|ad\.|union/i.test(url)) reqs.push(url.slice(0, 150));
      });
      await page.send('Network.enable');
      await page.goto(u, 40000);
      await sleep(7000);
      try { await page.evaluate('window.scrollTo(0, 2000); return 1;', true); } catch (e) {}
      await sleep(3000);

      const r = await page.evaluate(PROBE, true);
      console.log('  卡片标签: ' + r.卡片标签);
      console.log('  卡片属性: ' + JSON.stringify(r.卡片属性));
      console.log('  gl-item=' + r.glItem数 + '  data-sku=' + r.dataSku数 +
        '  一页ID数=' + r.一页ID数 + '  前5=' + JSON.stringify(r.前5个ID));
      console.log('  分页节点数: ' + r.分页.节点数 + ' | 总数线索: ' + r.总数线索 + ' | 有下一页字样: ' + r.含下一页);
      (r.分页.样例 || []).slice(0, 6).forEach((s) => console.log('      ' + s));
      console.log('  ID 线索: ' + JSON.stringify(r.页面里的ID线索));
      console.log('  价格节点: ' + JSON.stringify(r.价格节点));
      console.log('  标题节点: ' + JSON.stringify(r.标题节点));
      console.log('  店铺节点: ' + JSON.stringify(r.店铺节点));
      console.log('  --- 卡片结构树 ---');
      (r.树 || []).slice(0, 42).forEach((l) => console.log('   ' + l));
      const uniq = [...new Set(reqs)];
      console.log('  --- 请求 (' + uniq.length + ') ---');
      uniq.slice(0, 18).forEach((x) => console.log('      ' + x));
    } catch (e) {
      console.log('  ✗ ' + (e && e.message));
    } finally {
      if (page) { try { await page.close(); } catch (e) {} }
    }
    await sleep(700);
  }
  await b.close();
})().catch((e) => { console.error('ERR', e && e.message); process.exit(1); });
