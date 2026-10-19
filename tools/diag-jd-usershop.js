/**
 * 探测用户实际在用的京东店铺页，摸清整店入口与取数方式。
 *
 * 用法：node tools/diag-jd-usershop.js [url ...]
 *
 * 关注顺序（决定实现方式）：
 *   1. 有没有 302   —— 换域/换路径都意味着要做归一
 *   2. DOM 有没有商品卡片 —— 有就 DOM 解析，没有才去抓接口
 *   3. 字段落点、分页机制
 *   4. h5st 签名的必要性（京东接口签名成本高，能绕就绕）
 */
'use strict';
const CDP = require('./cdp');

const DEFAULT_URLS = [
  'https://mall.jd.com/view_search-991882-8441300-99-1-20-1.html',
  'https://mall.jd.com/index-16052428.html?from=pc',
  'https://mall.jd.com/index-10288934.html?from=pc&cid=0',
  'https://mall.jd.com/index-109141625.html?from=pc&cid=0'
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 注意：cdp.js 的 evaluate 会自动包裹成 `(()=>{ <expression> })()`，
// 所以这里只能写「语句体 + return」，不能再套一层 IIFE（套了就永远返回 undefined）。
const PROBE = `
  var out = {};
  out.href = location.href.slice(0, 140);
  out.host = location.host;
  out.title = (document.title || '').slice(0, 60);
  out.bodyLen = (document.body ? (document.body.innerText || '') : '').length;

  // 商品卡片候选：京东新版店铺/搜索页用 data-sku 或 data-* 承载 sku
  var sel = {
    dataSku: document.querySelectorAll('[data-sku]').length,
    itemLinks: document.querySelectorAll('a[href*="item.jd.com"]').length,
    goodsItem: document.querySelectorAll('[class*="goods-item"],[class*="goodsItem"]').length,
    jItem: document.querySelectorAll('li.gl-item,.j-sku-item,[class*="sku-item"]').length
  };
  out.计数 = sel;

  // 找出「商品 ID 出现最集中的容器」——它就是卡片
  function idFrom(n) {
    var a = n.getAttribute && (n.getAttribute('data-sku') || n.getAttribute('data-skuid'));
    if (a) return String(a).trim();
    var h = n.getAttribute && n.getAttribute('href');
    var m = h && String(h).match(/item\\.jd\\.com\\/(\\d{6,20})\\.html/);
    return m ? m[1] : '';
  }
  // 以带 data-sku 的最近公共祖先为卡片
  var withSku = document.querySelectorAll('[data-sku]');
  if (withSku.length) {
    var c = withSku[0];
    var chain = [];
    for (var up = c; up && up !== document.body; up = up.parentElement) {
      chain.push((up.tagName || '') + '.' + String(up.className || '').slice(0, 60) +
        ' [子树里带 data-sku 的节点数=' + up.querySelectorAll('[data-sku]').length + ']');
    }
    out.卡片祖先链 = chain.slice(0, 6);
  }

  out.样例 = [];
  var seen = {};
  var nodes = document.querySelectorAll('[data-sku],a[href*="item.jd.com"]');
  for (var i = 0; i < nodes.length && out.样例.length < 3; i++) {
    var id = idFrom(nodes[i]);
    if (!id || seen[id]) continue;
    seen[id] = 1;
    var card = nodes[i].closest('[data-sku]') || nodes[i];
    // 往上找到「像一张卡片」的那层：含图片且高度够
    for (var p = card; p && p !== document.body; p = p.parentElement) {
      if (p.querySelector('img') && p.innerText && p.innerText.length > 8) { card = p; break; }
    }
    var img = card.querySelector('img');
    out.样例.push({
      id: id,
      卡片类名: String(card.className || '').slice(0, 80),
      标题: (card.innerText || '').replace(/\\s+/g, ' ').slice(0, 70),
      图: img ? String((img.getAttribute('src') || img.getAttribute('data-lazyload') || '')).slice(0, 110) : '(无)',
      价格节点: (function () {
        var p = card.querySelector('[class*="price"],[class*="_price_"]');
        return p ? (p.innerText || '').slice(0, 24) : '(无)';
      })()
    });
  }

  // 分页线索
  var pg = document.querySelectorAll('[class*="pagin"],[class*="page-"],.ui-page a,.pagination a');
  out.分页节点数 = pg.length;
  out.分页文本 = Array.prototype.slice.call(pg, 0, 6).map(function (n) {
    return (n.innerText || '').trim().slice(0, 12);
  }).filter(Boolean);

  // 是否有「全部商品/更多」入口
  var more = [];
  Array.prototype.forEach.call(document.querySelectorAll('a'), function (a) {
    var t = (a.innerText || '').trim();
    if (/全部商品|所有商品|更多商品|查看全部/.test(t) && t.length < 16) {
      more.push(t + ' -> ' + String(a.getAttribute('href') || '').slice(0, 90));
    }
  });
  out.全部商品入口 = more.slice(0, 3);

  // 页面里的 SSR 数据块（店铺页常把商品塞在 JSON 里）
  var scripts = document.querySelectorAll('script');
  var jsonHits = [];
  for (var s = 0; s < scripts.length; s++) {
    var t = scripts[s].textContent || '';
    if (t.length < 200) continue;
    if (/skuId|wareId|sku_id/.test(t)) {
      var ids = t.match(/"(?:skuId|wareId)"\\s*:\\s*"?\\d{6,20}/g);
      jsonHits.push({
        长度: t.length,
        有商品字段: true,
        样例ID数: ids ? ids.length : 0,
        开头: t.slice(0, 90).replace(/\\s+/g, ' ')
      });
    }
  }
  out.内嵌JSON块 = jsonHits.slice(0, 5);

  return out;
`;

(async () => {
  const urls = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_URLS;
  const b = await CDP.connect(9222);

  for (let i = 0; i < urls.length; i++) {
    const u = urls[i];
    console.log('\n================ [' + (i + 1) + '/' + urls.length + '] ================');
    console.log(u.slice(0, 120));
    let page = null;
    try {
      page = await b.open(u);

      // 抓网络：看有没有商品列表接口
      const xhr = [];
      page.on('Network.requestWillBeSent', (p) => {
        const url = (p && p.request && p.request.url) || '';
        if (/\\.(js|css|png|jpg|jpeg|webp|gif|woff2?)(\\?|$)/i.test(url)) return;
        if (/jd\\.com/.test(url)) xhr.push(url.slice(0, 130));
      });
      try { await page.send('Network.enable'); } catch (e) {}

      await sleep(9000);

      // 滚一屏，触发懒加载
      try { await page.evaluate('window.scrollTo(0, 1200); return 1;'); } catch (e) {}
      await sleep(2500);

      const r = await page.evaluate(PROBE, true);
      console.log('  host  : ' + r.host);
      console.log('  href  : ' + r.href);
      console.log('  标题  : ' + r.title);
      console.log('  正文  : ' + r.bodyLen + ' 字');
      console.log('  计数  : ' + JSON.stringify(r.计数));
      if (r.卡片祖先链) {
        console.log('  卡片祖先链:');
        r.卡片祖先链.forEach((c) => console.log('      ' + c));
      }
      if (r.样例 && r.样例.length) {
        console.log('  样例:');
        r.样例.forEach((s) => {
          console.log('      id=' + s.id + '  ' + s.卡片类名);
          console.log('         标题 ' + s.标题);
          console.log('         价格 ' + s.价格节点);
          console.log('         图   ' + s.图);
        });
      } else {
        console.log('  样例: （无商品节点）');
      }
      console.log('  分页  : ' + r.分页节点数 + ' 个  文本=' + JSON.stringify(r.分页文本));
      console.log('  全部商品入口: ' + JSON.stringify(r.全部商品入口));
      console.log('  内嵌JSON块: ' + JSON.stringify(r.内嵌JSON块, null, 0).slice(0, 400));

      const uniq = [...new Set(xhr)].filter((x) => !/log|report|stat|beacon|track/i.test(x));
      console.log('  XHR/文档请求 (' + uniq.length + '):');
      uniq.slice(0, 14).forEach((x) => console.log('      ' + x));
    } catch (e) {
      console.log('  ✗ 失败: ' + (e && e.message));
    } finally {
      if (page) { try { await page.close(); } catch (e) {} }
    }
    await sleep(700);
  }

  await b.close();
})().catch((e) => { console.error('ERR', e && e.message); process.exit(1); });
