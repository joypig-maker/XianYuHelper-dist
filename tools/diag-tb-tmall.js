/**
 * 天猫搜索页探测 + 淘宝搜索页采集逻辑注入验证
 *
 * 用户的提醒：天猫和淘宝的网址不一样。
 *   淘宝搜索  s.taobao.com/search
 *   天猫搜索  list.tmall.com/search_product.htm   ← 这个还没测过
 * 两边的 DOM 结构未必同构，卡片锚点和字段选择器都要单独确认，
 * 不能拿淘宝的那套直接套上去。
 *
 * 顺带把写好的 scanCards + sites 配置注入淘宝搜索页跑一遍，
 * 验证采集逻辑本身能否产出卡片（不依赖加载扩展）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const CDP = require('./cdp');

const ROOT = path.join(__dirname, '..');
const UTIL = fs.readFileSync(path.join(ROOT, 'src/common/util.js'), 'utf8');
const SITES = fs.readFileSync(path.join(ROOT, 'src/common/sites.js'), 'utf8');

const KW = encodeURIComponent('手机支架');

// 每个页面统一问同一组问题，好横向比对
const PROBE = `return (function(){
  var sels = {
    doubleCard: '[class*="doubleCard"]',
    doubleCardWrapper: '[class*="doubleCardWrapper"]',
    spmActId: '[data-spm-act-id]',
    itemLink: 'a[href*="item.taobao.com"],a[href*="detail.tmall.com"]',
    // 天猫列表页的老结构
    J_Item: '[class*="product"]',
    itemHolder: '[class*="item-holder"],[class*="product-item"],[id*="item_"]'
  };
  var out = { host: location.host, url: location.href.slice(0, 110), counts: {} };
  Object.keys(sels).forEach(function(k){
    try { out.counts[k] = document.querySelectorAll(sels[k]).length; } catch(e){ out.counts[k] = 'err'; }
  });
  // 淘宝两套卡片选择器在天猫上是否还成立
  out.fieldHit = {};
  ['[class*="title--"]','[class*="mainPic"]','[class*="priceInt"]','[class*="shopNameText"]','[class*="realSales"]']
    .forEach(function(s){ try { out.fieldHit[s] = document.querySelectorAll(s).length; } catch(e){} });
  // 抓一张卡片的文本，看信息是否同级
  var node = document.querySelector('[class*="doubleCardWrapper"]') ||
             document.querySelector('[class*="product"]') ||
             document.querySelector('[class*="item-holder"]');
  out.sampleText = node ? (node.innerText || '').replace(/\\s+/g, ' ').slice(0, 150) : '(无卡片)';
  out.sampleCls = node ? String(node.className).slice(0, 60) : '';
  out.bodyLen = document.body ? document.body.innerText.length : 0;
  return out;
})()`;

async function probe(b, url, label) {
  const { targetId } = await b.createTarget('about:blank');
  const page = await b.attachTarget({ id: targetId });
  console.log('\n' + '='.repeat(72));
  console.log('=== ' + label + ' ===');
  console.log('URL: ' + url);
  try {
    await page.goto(url, 45000);
    await new Promise((r) => setTimeout(r, 5000));
    const r = await page.evaluate(PROBE);
    console.log('落地 host: ' + r.host);
    console.log('落地 url : ' + r.url);
    console.log('body 文本长度: ' + r.bodyLen);
    console.log('结构命中: ' + JSON.stringify(r.counts));
    console.log('淘宝那套字段选择器在天猫的命中: ' + JSON.stringify(r.fieldHit));
    console.log('首个卡片 class: ' + r.sampleCls);
    console.log('首个卡片文本: ' + r.sampleText);
  } catch (e) {
    console.log('失败: ' + e.message);
  }
  await page.close();
}

// 在淘宝搜索页注入采集逻辑，看实际产出
async function verifyScan(b, url, label) {
  const { targetId } = await b.createTarget('about:blank');
  const page = await b.attachTarget({ id: targetId });
  console.log('\n' + '='.repeat(72));
  console.log('=== 采集逻辑注入验证：' + label + ' ===');
  try {
    await page.goto(url, 45000);
    await new Promise((r) => setTimeout(r, 5000));
    await page.evaluate(UTIL + '\n' + SITES + '\nreturn 1;');
    const r = await page.evaluate(`return (function(){
      var U = window.XYUtil, S = window.XYSites;
      if (!U || !S) return { err: 'XYUtil/XYSites 未注入' };
      var site = S.match(location.host);
      if (!site) return { err: '站点未命中: ' + location.host };
      var cards = U.scanCards(document, site);
      return {
        site: site.key,
        cards: cards.length,
        firstThree: cards.slice(0, 3).map(function(c){
          return {
            id: c.itemId,
            title: String(c.title || '').slice(0, 26),
            price: c.price,
            img: String(c.image || '').slice(0, 60),
            shop: String(c.sellerNick || '').slice(0, 16)
          };
        })
      };
    })()`);
    console.log(JSON.stringify(r, null, 1));
  } catch (e) {
    console.log('失败: ' + e.message);
  }
  await page.close();
}

(async () => {
  const b = await CDP.connect(9222);
  await probe(b, 'https://list.tmall.com/search_product.htm?q=' + KW, '天猫搜索页（未验证过）');
  await verifyScan(b, 'https://s.taobao.com/search?q=' + KW, '淘宝搜索页');
  await b.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
