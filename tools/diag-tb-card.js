/**
 * 淘宝搜索页：单卡片结构树 dump
 *
 * 上一轮已知卡片锚点是 [class*="doubleCard"]，但价格/店铺选择器会捞到
 * 成交数、地区、回头客率等杂质，不能用。这里把一张卡片剥成缩进的
 * tag+class 树，标出 img 和纯文本，据此定精确选择器。
 */
'use strict';

const CDP = require('./cdp');
const KEYWORD = process.argv[2] || '手机支架';
const URL = 'https://s.taobao.com/search?q=' + encodeURIComponent(KEYWORD);

const DUMP = `(function(){
  // 取第一个「内层」真卡片（不含嵌套的 doubleCard）
  var all = document.querySelectorAll('[class*="doubleCard"]');
  var card = null;
  for (var i = 0; i < all.length; i++) {
    if (!all[i].querySelector('[class*="doubleCard"]')) { card = all[i]; break; }
  }
  if (!card) return { err: 'no card' };

  function nameOf(el) {
    var c = String(el.className || '').trim().replace(/\\s+/g, '.');
    return el.tagName.toLowerCase() + (c ? '.' + c.slice(0, 60) : '');
  }

  var lines = [];
  function walk(el, d) {
    if (d > 9) return;
    var pad = new Array(d + 1).join('  ');
    var extra = '';
    if (el.tagName === 'IMG') {
      extra = ' [IMG src=' + String(el.getAttribute('src') || '').slice(0, 88) + ']';
      lines.push(pad + nameOf(el) + extra);
      return;
    }
    if (el.tagName === 'A') {
      extra = ' [A href=' + String(el.getAttribute('href') || '').slice(0, 60) + ']';
    }
    // 只保留有意义的直接文本（不含子元素的）
    var own = '';
    for (var k = 0; k < el.childNodes.length; k++) {
      var n = el.childNodes[k];
      if (n.nodeType === 3) {
        var t = String(n.nodeValue || '').trim();
        if (t) own += t.slice(0, 40) + ' ';
      }
    }
    lines.push(pad + nameOf(el) + extra + (own ? '  「' + own.trim() + '」' : ''));
    for (var j = 0; j < el.children.length; j++) walk(el.children[j], d + 1);
  }
  walk(card, 0);

  return {
    cardAttrs: (function(){ var o={}; for(var i=0;i<card.attributes.length;i++){var a=card.attributes[i]; o[a.name]=String(a.value).slice(0,50);} return o; })(),
    tree: lines.join('\\n'),
    imgCount: card.querySelectorAll('img').length,
    allImgs: Array.prototype.map.call(card.querySelectorAll('img'), function(im){
      return { src: String(im.getAttribute('src')||'').slice(0,95), w: im.naturalWidth, h: im.naturalHeight };
    })
  };
})()`;

(async () => {
  const b = await CDP.connect(9222);
  const { targetId } = await b.createTarget('about:blank');
  const page = await b.attachTarget({ id: targetId });
  await page.goto(URL, 40000);
  await new Promise((r) => setTimeout(r, 4500));

  const r = await page.evaluate(`return ${DUMP}`);
  if (r.err) { console.log('失败:', r.err); }
  else {
    console.log('=== 卡片属性 ===');
    console.log(JSON.stringify(r.cardAttrs, null, 1));
    console.log('\n=== 结构树 ===');
    console.log(r.tree);
    console.log('\n=== 卡片内所有 img (' + r.imgCount + ') ===');
    r.allImgs.forEach((im, i) => console.log('  [' + i + '] ' + im.w + 'x' + im.h + '  ' + im.src));
  }

  // 顺便看 data-spm-act-id 是不是商品 ID 的稳定来源
  const ids = await page.evaluate(`return (function(){
    var out = [];
    document.querySelectorAll('[class*="doubleCardWrapper"]').forEach(function(el, i){
      if (i > 5) return;
      var a = el.querySelector('a[href]');
      out.push({
        spm: el.getAttribute('data-spm-act-id') || (a && a.getAttribute('data-spm-act-id')) || '',
        href: String(a && a.getAttribute('href') || '').slice(0, 60)
      });
    });
    return out;
  })()`);
  console.log('\n=== data-spm-act-id 是否 = 商品ID ===');
  ids.forEach((x, i) => console.log('  [' + i + '] spm=' + x.spm + ' | href=' + x.href));

  await page.close();
  await b.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
