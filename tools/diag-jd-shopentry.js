/**
 * 找店铺页里的「全部商品 / view_search」入口，以及店铺 ID 的对应关系。
 *
 * 要回答的问题：
 *   1. 从 index-<shopId>.html 能不能直接拿到 view_search 的 URL？
 *   2. view_search-<A>-<B>-<C>-<page>-<size>-<D>.html 里 A/B/C/D 各是什么？
 *   3. 那两个「0 商品」的店铺是真没商品，还是渲染慢/需要点一下？
 *
 * 用法：node tools/diag-jd-shopentry.js <url> [...]
 */
'use strict';
const CDP = require('./cdp');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROBE = `
  var out = {};
  var html = document.documentElement.innerHTML;

  // ---- 1) 所有 view_search 链接 ----
  var vs = [];
  Array.prototype.forEach.call(document.querySelectorAll('a[href*="view_search"]'), function (a) {
    vs.push(String(a.getAttribute('href') || '').slice(0, 120));
  });
  out.view_search链接 = [...new Set(vs)].slice(0, 10);

  // 文本里提到的 view_search（有些是 JS 拼的）
  out.html里的view_search = [...new Set((html.match(/view_search[^"'\\\\\\s<>]{0,60}/g) || []))].slice(0, 8);

  // ---- 2) 店铺 ID 全谱 ----
  function uniq(re, cap) {
    var s = new Set(); var m;
    while ((m = re.exec(html)) !== null) { s.add(m[1]); if (s.size >= (cap || 6)) break; }
    return [...s];
  }
  out.ID = {
    venderId: uniq(/venderId["'\\s:=]+(\\d{5,12})/g),
    shopId: uniq(/shopId["'\\s:=]+"?(-?\\d{5,12})/g),
    index页: uniq(/index-(\\d{5,12})/g),
    view_search第1段: uniq(/view_search-(\\d{5,12})/g),
    店铺名: uniq(/"shopName"\\s*:\\s*"([^"]{2,30})"/g, 3)
  };

  // ---- 3) 商品卡片 ----
  out.glItem = document.querySelectorAll('.gl-item').length;
  out.dataSku = document.querySelectorAll('[data-sku]').length;
  out.itemLinks = document.querySelectorAll('a[href*="item.jd.com"]').length;
  out.含共N件 = (document.body.innerText || '').match(/共\\s*\\d+\\s*件/) || null;

  // ---- 4) 有没有「全部商品」这类标签页/按钮 ----
  var tabs = [];
  Array.prototype.forEach.call(document.querySelectorAll('a,li,span,div'), function (n) {
    var t = (n.innerText || '').trim();
    if (t && t.length < 12 && /^(全部商品|所有商品|商品分类|本店搜索|店内搜索)/.test(t)) {
      var a = n.closest('a') || n.querySelector('a');
      tabs.push(t + ' | ' + String((a && a.getAttribute('href')) || '(无链接)').slice(0, 100));
    }
  });
  out.全部商品相关 = [...new Set(tabs)].slice(0, 8);

  // ---- 5) 左侧分类树（view_search 的 B 段可能是分类 ID）----
  var cats = [];
  Array.prototype.forEach.call(document.querySelectorAll('a[href*="category"],a[href*="cid="]'), function (a) {
    cats.push(((a.innerText || '').trim().slice(0, 14) || '(无名)') + ' | ' + String(a.getAttribute('href') || '').slice(0, 100));
  });
  out.分类链接 = [...new Set(cats)].slice(0, 10);

  out.href = location.href.slice(0, 120);
  out.title = (document.title || '').slice(0, 50);
  return out;
`;

(async () => {
  const urls = process.argv.slice(2);
  if (!urls.length) { console.error('用法: node tools/diag-jd-shopentry.js <url> [...]'); process.exit(1); }
  const b = await CDP.connect(9222);
  for (const u of urls) {
    console.log('\n=============== ' + u.slice(0, 110));
    let page = null;
    try {
      page = await b.open('about:blank');
      await page.send('Network.enable');
      await page.goto(u, 40000);
      await sleep(8000);
      try { await page.evaluate('window.scrollTo(0, 2500); return 1;', true); } catch (e) {}
      await sleep(3000);
      const r = await page.evaluate(PROBE, true);
      console.log('  → ' + r.href);
      console.log('  标题: ' + r.title);
      console.log('  卡片: gl-item=' + r.glItem + '  data-sku=' + r.dataSku + '  item链接=' + r.itemLinks + '  共N件=' + JSON.stringify(r.含共N件));
      console.log('  ID: ' + JSON.stringify(r.ID));
      console.log('  view_search 链接: ' + JSON.stringify(r.view_search链接));
      console.log('  html 里的 view_search: ' + JSON.stringify(r.html里的view_search));
      console.log('  全部商品相关: ' + JSON.stringify(r.全部商品相关));
      console.log('  分类链接: ' + JSON.stringify(r.分类链接));
    } catch (e) {
      console.log('  ✗ ' + (e && e.message));
    } finally {
      if (page) { try { await page.close(); } catch (e) {} }
    }
    await sleep(600);
  }
  await b.close();
})().catch((e) => { console.error('ERR', e && e.message); process.exit(1); });
