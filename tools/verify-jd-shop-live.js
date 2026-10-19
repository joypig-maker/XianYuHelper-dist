/**
 * 京东店铺页采集的真机验证（走真实 scanCards，不写死选择器）。
 *
 * 做两件事：
 *   1. 注入 util.js + sites.js 到页面，直接用站点配置扫卡片 ——
 *      这样验的是「配置对不对」，而不是「我脚本里的选择器对不对」
 *   2. 顺手报告限流状态（京东对高频访问会降级成「不带商品列表」的页面）
 *
 * 用法：node tools/verify-jd-shop-live.js [url] [url2 ...]
 *      不带参数时只测一个店铺页（省得又撞限流）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const CDP = require('./cdp');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROOT = path.join(__dirname, '..');
const UTIL = fs.readFileSync(path.join(ROOT, 'src/common/util.js'), 'utf8');
const SITES = fs.readFileSync(path.join(ROOT, 'src/common/sites.js'), 'utf8');

const DEFAULT = ['https://mall.jd.com/view_search-991882-0-99-1-20-1.html'];

(async () => {
  const urls = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT;
  const b = await CDP.connect(9222);

  for (let i = 0; i < urls.length; i++) {
    const u = urls[i];
    console.log('\n=============== [' + (i + 1) + '/' + urls.length + '] ' + u.slice(0, 108));
    let page = null;
    try {
      page = await b.open('about:blank');
      await page.goto(u, 40000);
      await sleep(8000);
      try { await page.evaluate('window.scrollTo(0, 1500); return 1;', true); } catch (e) {}
      await sleep(2000);

      const r = await page.evaluate(`
        var out = {};
        out.href = location.href.slice(0, 130);
        out.title = (document.title || '').slice(0, 60);

        // 限流/风控信号
        out.glItem = document.querySelectorAll('.gl-item').length;
        out.dataSku = document.querySelectorAll('[data-sku]').length;
        var t = (document.body ? document.body.innerText : '') || '';
        out.有列表容器 = !!document.querySelector('.goods-list,.J-goods-list,#J_goodsList');
        out.提示 = (t.match(/(稍后|抱歉|异常|频繁|验证|没有找到|暂无)[^。\\n]{0,24}/) || [''])[0];
        out.总数 = (t.match(/共\\s*(\\d+)\\s*件/) || [])[0] || '(无)';

        // ==== 走真实站点配置扫卡片 ====
        try {
          ${UTIL}
        } catch (e) { out.utilErr = e.message; }
        try {
          ${SITES}
        } catch (e) { out.sitesErr = e.message; }
        out.有Util = typeof XYUtil !== 'undefined';
        out.有Sites = typeof XYSites !== 'undefined';
        if (out.有Util && out.有Sites) {
          var site = XYSites.match(location.host);
          out.站点 = site ? site.key : '(未命中)';
          var cards = XYUtil.scanCards(document, site);
          out.卡片数 = cards.length;
          out.样例 = cards.slice(0, 4).map(function (c) {
            return {
              id: c.itemId,
              标题: String(c.title || '').slice(0, 26),
              价: c.price || '(空)',
              图: String(c.image || '').slice(-46) || '(空)',
              是n0: /\\/n0\\//.test(String(c.image || '')),
              店铺: String(c.sellerNick || '').slice(0, 12) || '(空)'
            };
          });
          // 有 ID 但没图的，单独数一下（这是最容易被静默漏掉的一环）
          out.有ID无图 = cards.filter(function (c) { return !c.image; }).length;
          out.有ID无价 = cards.filter(function (c) { return !c.price; }).length;
          out.有ID无标题 = cards.filter(function (c) { return !c.title; }).length;

          // 价格为什么取不到 —— 把首张卡片里所有带 price 的节点 dump 出来。
          // 实测发现「分类页」和「所有商品页」的卡片结构并不一样，
          // 不能拿一个页面的结构树去配另一个页面。
          out.价格诊断 = (function () {
            var li = document.querySelector('li.gl-item') || document.querySelector('.gl-item');
            if (!li) return '(没有卡片)';
            var hits = [];
            Array.prototype.forEach.call(li.querySelectorAll('[class*="rice"],[class*="Price"]'), function (n) {
              var own = '';
              for (var k = 0; k < n.childNodes.length; k++) {
                if (n.childNodes[k].nodeType === 3) own += n.childNodes[k].textContent.trim();
              }
              hits.push({
                类名: String(n.className || '').slice(0, 40),
                自身文本: own.slice(0, 24),
                整体文本: (n.innerText || '').replace(/\\s+/g, ' ').slice(0, 30),
                子节点数: n.children.length
              });
            });
            return hits.slice(0, 8);
          })();
          out.卡片类名 = (function () {
            var li = document.querySelector('li.gl-item');
            return li ? String(li.className) : '(无)';
          })();
          // 把首张卡片的价格那一小块原始 HTML 留下来，照着它改选择器
          out.价格区HTML = (function () {
            var li = document.querySelector('li.gl-item');
            if (!li) return '';
            var info = li.querySelector('[class*="GoodsInfo"],[class*="goods-info"]') || li;
            return String(info.outerHTML).replace(/\\s+/g, ' ').slice(0, 900);
          })();
        }
        return out;
      `, true);

      console.log('  → ' + r.title);
      console.log('  限流信号: gl-item=' + r.glItem + '  data-sku=' + r.dataSku +
        '  列表容器=' + r.有列表容器 + '  总数=' + r.总数);
      if (r.提示) console.log('  ⚠ 页面提示: ' + r.提示);
      console.log('  注入: XYUtil=' + r.有Util + ' XYSites=' + r.有Sites + ' 站点=' + r.站点);
      if (r.utilErr) console.log('  util 注入异常: ' + r.utilErr);
      if (r.sitesErr) console.log('  sites 注入异常: ' + r.sitesErr);
      console.log('  === scanCards 结果 ===');
      console.log('  卡片数: ' + r.卡片数 + '   缺图 ' + r.有ID无图 + ' / 缺价 ' + r.有ID无价 + ' / 缺标题 ' + r.有ID无标题);
      (r.样例 || []).forEach((s) => {
        console.log('    id=' + s.id + '  [' + s.价 + ']' + (s.是n0 ? ' n0✓' : ' ✗非n0') + '  ' + s.标题);
        console.log('        图 ' + s.图);
      });

      if (r.价格诊断 && r.价格诊断 !== '(没有卡片)') {
        console.log('\n  --- 价格节点诊断（卡片的类名 ' + r.卡片类名 + '）---');
        r.价格诊断.forEach((h) => {
          console.log('    .' + h.类名 + '  自身="' + h.自身文本 + '"  整体="' + h.整体文本 +
            '"  子节点=' + h.子节点数);
        });
        console.log('\n  --- 价格区原始 HTML ---');
        console.log('    ' + r.价格区HTML);
      } else if (r.价格诊断) {
        console.log('\n  价格诊断: ' + r.价格诊断);
      }
    } catch (e) {
      console.log('  ✗ ' + (e && e.message));
    } finally {
      if (page) { try { await page.close(); } catch (e) {} }
    }
    // 间隔久一点 —— 京东对店铺页的高频访问会降级返回，别把自己的验证搞垮
    if (i < urls.length - 1) await sleep(9000);
  }
  await b.close();
})().catch((e) => { console.error('ERR', e && e.message); process.exit(1); });
