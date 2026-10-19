/**
 * 淘宝搜索页卡片结构深挖
 *
 * 第一轮探测已知：搜索页是 SSR，商品卡片在 DOM 里（[class*="doubleCard"] 命中 94）。
 * 这一轮要回答的是「怎么稳定地把 ID/标题/价格/图/店铺 抠出来」——
 * 淘宝的类名带 hash 后缀（doubleCardWrapperAdapt--mEcC7olq），
 * 跟着版本变，所以必须先搞清哪些锚点稳定、哪些会漂。
 */
'use strict';

const CDP = require('./cdp');

const KEYWORD = process.argv[2] || '手机支架';
const URL = 'https://s.taobao.com/search?q=' + encodeURIComponent(KEYWORD);

const PROBE = `(function(){
  var out = { total: 0, carriers: {}, linkKinds: {}, idSources: {}, attrSample: [], cards: [] };

  // 1) 候选容器逐个统计命中，找出最稳的那个
  var carrySels = ['[class*="doubleCard"]','[class*="doubleCardWrapper"]','[class*="Card--"]',
                   '[class*="Content--"]','[data-nid]','[data-itemid]','[data-id]','[data-spm-act-id]'];
  carrySels.forEach(function(s){
    var n = 0;
    try { n = document.querySelectorAll(s).length; } catch(e) { n = -1; }
    out.carriers[s] = n;
  });

  // 2) 以 doubleCard 为锚点，逐个卡片分析
  var nodes = document.querySelectorAll('[class*="doubleCard"]');
  out.total = nodes.length;

  function txt(el, sel){
    var t = el.querySelector(sel);
    return t ? (t.innerText || t.textContent || '').trim() : '';
  }

  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    // 跳过包裹层（内层才是真卡片）
    if (el.querySelector('[class*="doubleCard"]')) continue;

    var a = el.querySelector('a[href]');
    var href = a ? a.getAttribute('href') : '';

    // 链接形态归类
    var kind = 'other';
    if (/item\\.taobao\\.com/.test(href)) kind = 'item.taobao.com';
    else if (/detail\\.tmall\\.com/.test(href)) kind = 'detail.tmall.com';
    else if (/click\\.simba\\.taobao\\.com/.test(href)) kind = 'simba(ad)';
    out.linkKinds[kind] = (out.linkKinds[kind] || 0) + 1;

    // 商品 ID 从哪来：链接参数 / data-* / 跳转参数
    var id = '';
    var from = '';
    var m = href.match(/[?&]id=(\\d{6,})/);
    if (m) { id = m[1]; from = 'href?id='; }
    if (!id) {
      var m2 = href.match(/topIds%3D(\\d{6,})|topIds=(\\d{6,})/);
      if (m2) { id = m2[1] || m2[2]; from = 'ad:topIds'; }
    }
    if (!id) {
      var m3 = href.match(/[?&]itemId=(\\d{6,})|[?&]nid=(\\d{6,})/);
      if (m3) { id = m3[1] || m3[2]; from = 'href:itemId/nid'; }
    }

    // 卡片上的 data-* 属性（哪怕只用得上一个也值）
    var attrs = {};
    for (var k = 0; k < el.attributes.length; k++) {
      var at = el.attributes[k];
      if (/^data-/.test(at.name)) attrs[at.name] = String(at.value).slice(0, 40);
    }

    var img = el.querySelector('img');
    var card = {
      cls: String(el.className).trim().slice(0, 70),
      hrefKind: kind,
      idFrom: from,
      id: id,
      attrs: attrs,
      title: txt(el, '[class*="Title--"]') || txt(el, '[class*="title"]'),
      price: txt(el, '[class*="Price--"]') || txt(el, '[class*="price"]'),
      shop: txt(el, '[class*="ShopInfo--"]') || txt(el, '[class*="shopName"]'),
      img: img ? (img.getAttribute('src') || img.getAttribute('data-src') || '').slice(0, 110) : '',
      text: (el.innerText || '').replace(/\\s+/g, ' ').slice(0, 130)
    };
    if (id) out.idSources[from] = (out.idSources[from] || 0) + 1;
    if (out.cards.length < 4) out.cards.push(card);
    if (out.attrSample.length < 4 && Object.keys(attrs).length) out.attrSample.push(attrs);
  }
  return out;
})()`;

(async () => {
  const b = await CDP.connect(9222);
  const { targetId } = await b.createTarget('about:blank');
  const page = await b.attachTarget({ id: targetId });

  await page.goto(URL, 40000);
  await new Promise((r) => setTimeout(r, 4500));
  // 滚动一次，触发懒加载，看商品数会不会涨
  const before = await page.evaluate(`return document.querySelectorAll('[class*="doubleCard"]').length`);
  await page.evaluate(`window.scrollTo(0, document.body.scrollHeight); return 1;`);
  await new Promise((r) => setTimeout(r, 3000));
  const after = await page.evaluate(`return document.querySelectorAll('[class*="doubleCard"]').length`);
  console.log('滚动前 ' + before + ' 个卡片 → 滚动后 ' + after + ' 个（看是否懒加载）');

  const r = await page.evaluate(`return ${PROBE}`);
  console.log('\n=== 候选容器命中 ===');
  Object.entries(r.carriers).forEach(([k, v]) => console.log('  ' + (v > 0 ? '✓' : ' ') + ' ' + k + ' → ' + v));
  console.log('\n总卡片数:', r.total);
  console.log('链接形态:', JSON.stringify(r.linkKinds));
  console.log('ID 来源:', JSON.stringify(r.idSources));

  console.log('\n=== data-* 属性样本 ===');
  console.log(JSON.stringify(r.attrSample, null, 1));

  console.log('\n=== 卡片样本 ===');
  r.cards.forEach((c, i) => {
    console.log('[' + i + '] cls=' + c.cls);
    console.log('    链接=' + c.hrefKind + '  ID=' + (c.id || '(取不到)') + ' 来源=' + (c.idFrom || '-'));
    console.log('    标题=' + c.title.slice(0, 50));
    console.log('    价格=[' + c.price.replace(/\s+/g, '|') + ']  店铺=' + c.shop.slice(0, 24));
    console.log('    图=' + c.img.slice(0, 95));
    console.log('    文本=' + c.text.slice(0, 100));
  });

  await page.close();
  await b.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
