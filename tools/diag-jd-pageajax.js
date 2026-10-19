/**
 * 挖京东店铺页 pageGoodsList() 的实现 —— 翻页到底请求哪个地址。
 *
 * 已知：分页控件是 <a class="fp-next" onclick="pageGoodsList(1 + 1, this)">
 * URL 不变，所以是 AJAX。本脚本 hook XHR/fetch + 找函数定义。
 *
 * 用法：node tools/diag-jd-pageajax.js <view_search url>
 */
'use strict';
const CDP = require('./cdp');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const url = process.argv[2];
  if (!url) { console.error('用法: node tools/diag-jd-pageajax.js <url>'); process.exit(1); }

  const b = await CDP.connect(9222);
  const page = await b.open('about:blank');

  // 页面级 hook：必须在导航前装（用 Page.addScriptToEvaluateOnNewDocument）
  await page.send('Page.enable');
  const HOOK = `
    (function () {
      if (window.__xyHooked) return;
      window.__xyHooked = true;
      window.__xyReqs = [];
      var oOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (m, u) {
        window.__xyReqs.push('XHR ' + m + ' ' + String(u).slice(0, 200));
        return oOpen.apply(this, arguments);
      };
      var oFetch = window.fetch;
      if (oFetch) {
        window.fetch = function (i, init) {
          var u = typeof i === 'string' ? i : (i && i.url);
          window.__xyReqs.push('FETCH ' + ((init && init.method) || 'GET') + ' ' + String(u).slice(0, 200));
          return oFetch.apply(this, arguments);
        };
      }
      // 记录 jQuery ajax（京东老页面用 jQuery）
      var oAjax = window.jQuery && window.jQuery.ajax;
      if (oAjax) {
        window.jQuery.ajax = function (o) {
          var u = typeof o === 'string' ? o : (o && o.url);
          window.__xyReqs.push('AJAX ' + String(u).slice(0, 200));
          return oAjax.apply(this, arguments);
        };
      }
    })();
  `;
  try { await page.send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK }); } catch (e) {
    console.log('hook 安装失败: ' + e.message);
  }

  await page.goto(url, 40000);
  await sleep(7000);

  // 1) 找 pageGoodsList 的函数定义
  const def = await page.evaluate(`
    var out = { 定义: [], 相关函数: [] };
    var src = '';
    Array.prototype.forEach.call(document.querySelectorAll('script'), function (s) {
      var t = s.textContent || '';
      if (t.indexOf('pageGoodsList') > -1 || t.indexOf('getPageRequire') > -1) src += t + '\\n';
    });
    if (!src) {
      out.定义.push('(页内 script 里没有，可能在外部 js)');
    } else {
      // 抠出 function pageGoodsList 的函数体
      ['function pageGoodsList', 'pageGoodsList = function', 'pageGoodsList:function',
       'function getPageRequire'].forEach(function (k) {
        var i = src.indexOf(k);
        if (i < 0) { out.定义.push(k + ' -> 未找到'); return; }
        var j = src.indexOf('{', i);
        var d = 0, end = j;
        for (var x = j; x < src.length && x < j + 3000; x++) {
          if (src[x] === '{') d++;
          else if (src[x] === '}') { d--; if (!d) { end = x; break; } }
        }
        out.定义.push('=== ' + k + ' ===\\n' + src.slice(i, Math.min(end + 1, i + 1600)));
      });
    }
    // 页面上所有函数名里带 page/goods 的
    var names = new Set();
    (src.match(/function\\s+([a-zA-Z_$][\\w$]*[Pp]age[\\w$]*)/g) || []).forEach(function (m) { names.add(m); });
    (src.match(/function\\s+([a-zA-Z_$][\\w$]*[Gg]oods[\\w$]*)/g) || []).forEach(function (m) { names.add(m); });
    out.相关函数 = [...names].slice(0, 20);
    return out;
  `, true);

  console.log('--- pageGoodsList 定义 ---');
  (def.定义 || []).forEach((d) => console.log(d));
  console.log('\n--- 相关函数名 ---');
  console.log('   ' + JSON.stringify(def.相关函数));

  // 2) 清空请求记录，点下一页，看发什么请求
  await page.evaluate('window.__xyReqs = []; return 1;', true);
  const clicked = await page.evaluate(`
    var a = document.querySelector('.g-pager .fp-next');
    if (!a) return '没找到 .fp-next';
    a.click();
    return '已点击 .fp-next（url 保持不变时靠 AJAX 换列表）';
  `, true);
  console.log('\n--- 点击下一页 ---');
  console.log('   ' + clicked);
  await sleep(7000);

  const after = await page.evaluate(`
    return {
      reqs: (window.__xyReqs || []).slice(0, 25),
      页码: (function () { var b = document.querySelector('.g-pager .fp-text b'); return b ? b.innerText : '?'; })(),
      总页: (function () { var i = document.querySelector('.g-pager .fp-text i'); return i ? i.innerText : '?'; })(),
      首图: (function () {
        var li = document.querySelector('.gl-item');
        var a = li && li.querySelector('a[href*="item.jd.com"]');
        return a ? a.getAttribute('href').slice(0, 70) : '(无)';
      })(),
      首标题: (function () {
        var li = document.querySelector('.gl-item');
        var d = li && (li.querySelector('.jDesc a') || li.querySelector('.p-name a'));
        return d ? (d.innerText || '').trim().slice(0, 34) : '(无)';
      })()
    };
  `, true);

  console.log('\n--- 点击后 ---');
  console.log('   页码: ' + after.页码 + ' / ' + after.总页);
  console.log('   首件: ' + after.首图);
  console.log('     标题: ' + after.首标题);
  console.log('   捕获到的请求 (' + (after.reqs || []).length + '):');
  (after.reqs || []).forEach((r) => console.log('      ' + r));

  try { await page.close(); } catch (e) {}
  await b.close();
})().catch((e) => { console.error('ERR', e && e.message); process.exit(1); });
