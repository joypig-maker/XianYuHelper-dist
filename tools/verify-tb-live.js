/**
 * 淘宝采集逻辑真机验证（不依赖加载扩展）
 *
 * 把 util.js + sites.js + 关键采集函数直接注入页面执行，验证：
 *   ① 搜索页：scanCards 能否产出卡片，字段是否齐全
 *   ② 详情页：extractDetail + parseTaobaoDesc 的实际产出
 *   ③ 店铺页：能否取到 shopId/sellerId，并成功分页拉全店
 *
 * 这条路绕开了「扩展怎么装进调试实例」的问题，验的是逻辑本身。
 * 每一步都复用真实的 lib.mtop，不是模拟。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const CDP = require('./cdp');

const ROOT = path.join(__dirname, '..');
const UTIL = fs.readFileSync(path.join(ROOT, 'src/common/util.js'), 'utf8');
const SITES = fs.readFileSync(path.join(ROOT, 'src/common/sites.js'), 'utf8');

async function open(b, url) {
  const { targetId } = await b.createTarget('about:blank');
  const page = await b.attachTarget({ id: targetId });
  await page.goto(url, 45000);
  await new Promise((r) => setTimeout(r, 4500));
  return page;
}

/* ---------- ① 搜索页 ---------- */
async function checkSearch(b) {
  const page = await open(b, 'https://s.taobao.com/search?q=' + encodeURIComponent('手机支架'));
  console.log('\n' + '='.repeat(72));
  console.log('=== ① 淘宝搜索页：scanCards 实际产出 ===');
  try {
    await page.evaluate(UTIL + '\n' + SITES + '\nreturn 1;');
    const r = await page.evaluate(`return (function(){
      var U = window.XYUtil, S = window.XYSites;
      var site = S.match(location.host);
      var cards = U.scanCards(document, site);
      var good = cards.filter(function(c){ return c.image && c.title; });
      return {
        站点: site ? site.key : '(未命中)',
        卡片数: cards.length,
        有图有标题: good.length,
        有价格: cards.filter(function(c){ return !!c.price; }).length,
        有店铺: cards.filter(function(c){ return !!c.sellerNick; }).length,
        样例: cards.slice(0, 3).map(function(c){
          return { id: c.itemId, 标题: String(c.title).slice(0,24), 价格: c.price,
                   店铺: String(c.sellerNick).slice(0,14), 图: String(c.image).slice(0,58) };
        })
      };
    })()`);
    console.log(JSON.stringify(r, null, 1));
  } catch (e) { console.log('失败: ' + e.message); }
  await page.close();
}

/* ---------- ② 详情页 ---------- */
async function checkDetail(b, id) {
  const page = await open(b, 'https://detail.tmall.com/item.htm?id=' + id);
  console.log('\n' + '='.repeat(72));
  console.log('=== ② 详情页：走 lib.mtop 拉主图/价格/详情图 ===');
  try {
    await page.evaluate(UTIL + '\n' + SITES + '\nreturn 1;');
    const r = await page.evaluate(`return (async function(){
      var U = window.XYUtil, S = window.XYSites;
      var site = S.match(location.host);
      var ID = ${JSON.stringify(id)};

      // lib.mtop.request 是回调式（1688 那套就是 mtop.request(params, ok, fail)），
      // 直接把返回值当 Promise 会拿到 undefined——必须两条路都接。
      function mtop(params){
        return new Promise(function(resolve){
          var done = false;
          function finish(x){ if (!done) { done = true; resolve(x); } }
          try {
            var ret = window.lib.mtop.request(params,
              function(r){ finish(r); },
              function(){ finish(null); });
            if (ret && typeof ret.then === 'function') ret.then(finish, function(){ finish(null); });
            else if (ret && typeof ret === 'object' && (ret.data || ret.ret)) finish(ret);
          } catch (e) { finish(null); }
          setTimeout(function(){ finish(null); }, 15000);
        });
      }

      var out = { 站点: site && site.key };

      var main = await mtop({ api: site.detailApi.api, v: site.detailApi.v,
        data: site.detailApi.buildData(ID), timeout: 15000, needLogin: false });
      // 先看清层次：1688 的 lib.mtop 回调给的是完整响应（含 data/ret），
      // 返回体里再包一层 data 才是业务数据。层级搞错的表现就是「有响应但解析全空」。
      out.主接口原始键 = main ? Object.keys(main).join(',') : '(null)';
      out.主接口内层键 = (main && main.data) ? Object.keys(main.data).slice(0, 12).join(',') : '(无)';
      out.主接口ret = main && main.ret ? JSON.stringify(main.ret).slice(0, 90) : '(无)';

      // 两种层级都试
      var biz = main && main.data;
      var d = biz ? U.extractDetail(biz, site) : null;
      if (!d && biz && biz.data) d = U.extractDetail(biz.data, site);
      out.解析出的价格 = d ? d.price : '(失败)';
      out.解析出的标题 = d ? String(d.title).slice(0, 28) : '';
      out.主图张数 = d ? d.images.length : 0;

      var desc = await mtop({ api: site.descApi.api, v: site.descApi.v,
        data: site.descApi.buildData(ID), timeout: 15000, needLogin: false });
      out.详情接口原始键 = desc ? Object.keys(desc).join(',') : '(null)';
      out.详情接口ret = desc && desc.ret ? JSON.stringify(desc.ret).slice(0, 90) : '(无)';
      var dz = desc && desc.data;
      var dimgs = dz ? U.parseTaobaoDesc(dz) : [];
      if (!dimgs.length && dz && dz.data) dimgs = U.parseTaobaoDesc(dz.data);
      out.详情图张数 = dimgs.length;

      if (d) out.合并后总图数 = U.capImages(U.filterItemImages(d.images.concat(dimgs))).length;
      return out;
    })()`, true);
    console.log(JSON.stringify(r, null, 1));
  } catch (e) { console.log('失败: ' + e.message); }
  await page.close();
}

/* ---------- ③ 店铺页 ---------- */
async function checkShop(b, url) {
  const page = await open(b, url);
  console.log('\n' + '='.repeat(72));
  console.log('=== ③ 店铺页：取 shopId/sellerId 并分页拉全店 ===');
  try {
    await page.evaluate(UTIL + '\n' + SITES + '\nreturn 1;');
    const r = await page.evaluate(`return (async function(){
      var U = window.XYUtil, S = window.XYSites;
      var site = S.match(location.host);
      var sa = site && site.shopApi;
      if (!sa) return { err: '站点没有 shopApi' };

      var html = document.documentElement.innerHTML;
      var mShop = html.match(sa.idFromHtml[0]);
      var mSeller = html.match(sa.idFromHtml[1]);
      var out = {
        站点: site.key,
        URL判定为店铺页: site.shopPageRe.test(location.href),
        shopId: mShop ? mShop[1] : '(取不到)',
        sellerId: mSeller ? mSeller[1] : '(取不到)'
      };
      if (!mShop || !mSeller) return out;

      function mtop(data){
        return new Promise(function(resolve){
          try {
            var ret = window.lib.mtop.request({ api: sa.api, v: sa.v || '1.0', data: data,
              timeout: 15000, needLogin: false });
            if (ret && typeof ret.then === 'function') ret.then(resolve).catch(function(){ resolve(null); });
            else resolve(ret);
            setTimeout(function(){ resolve(null); }, 15000);
          } catch(e) { resolve(null); }
        });
      }

      var p1 = await mtop(sa.buildData(mShop[1], mSeller[1], 1));
      out.第1页响应 = !!(p1 && p1.data);
      if (p1 && p1.data) {
        out.totalCnt = p1.data.totalCnt;
        out.hasNext = p1.data.hasNext;
        var cards = U.collectCards(p1.data, { site: site });
        out.第1页卡片数 = cards.length;
        out.样例 = cards.slice(0, 3).map(function(c){
          return { id: c.itemId, 标题: String(c.title).slice(0,22), 价格: c.price || '(空)', 图: (c.images||[]).length };
        });
      }
      return out;
    })()`, true);
    console.log(JSON.stringify(r, null, 1));
  } catch (e) { console.log('失败: ' + e.message); }
  await page.close();
}

(async () => {
  const b = await CDP.connect(9222);
  await checkSearch(b);
  await checkDetail(b, '669745626548');
  await checkShop(b, 'https://minwai.tmall.com/category.htm');
  await b.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
