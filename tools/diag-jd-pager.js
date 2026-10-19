/**
 * dump 京东店铺页分页控件的真实结构 —— 翻页到底靠什么。
 *
 * 背景：view_search-<段1>-0-99-<第4段>-20-1.html 改第 4 段无效
 *（1 和 2 返回同一批商品、都显示 1/147），说明页码不在那一格。
 *
 * 用法：node tools/diag-jd-pager.js <view_search url>
 */
'use strict';
const CDP = require('./cdp');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROBE = `
  var out = {};
  out.href = location.href.slice(0, 130);
  var gp = document.querySelector('.g-pager');
  out.pagerHTML = gp ? gp.outerHTML.replace(/\\s+/g, ' ').slice(0, 1500) : '(无 .g-pager)';

  // 所有带页码语义的链接
  var links = [];
  Array.prototype.forEach.call(document.querySelectorAll('.g-pager a, [class*="pager"] a, [class*="page"] a'), function (a) {
    var href = String(a.getAttribute('href') || '');
    var txt = (a.innerText || '').trim().slice(0, 8);
    if (!href || href === 'javascript:;' || href === '#') {
      links.push('[无href] "' + txt + '" class=' + String(a.className || '').slice(0, 40));
    } else {
      links.push('"' + txt + '" -> ' + href.slice(0, 120));
    }
  });
  out.分页链接 = [...new Set(links)].slice(0, 14);

  // 页码相关的 input（跳页框）
  var inputs = [];
  Array.prototype.forEach.call(document.querySelectorAll('input'), function (i) {
    if (/page|num/i.test(String(i.name || '') + String(i.id || '') + String(i.className || ''))) {
      inputs.push('name=' + i.name + ' id=' + i.id + ' class=' + String(i.className || '').slice(0, 30) +
        ' value=' + i.value + ' max=' + i.max);
    }
  });
  out.跳页输入框 = inputs.slice(0, 6);

  // 页面里跟分页有关的 JS 变量 / 函数名
  var html = document.documentElement.innerHTML;
  out.JS线索 = {
    pageNum: (html.match(/pageNum["'\\s:=]+[^,;&"]{0,12}/g) || []).slice(0, 4),
    pageParam: (html.match(/[?&]page=\\d+/g) || []).slice(0, 4),
    searchPage: (html.match(/searchPage[^,;]{0,40}/g) || []).slice(0, 4),
    toPage: (html.match(/toPage\\([^)]{0,50}/g) || []).slice(0, 4),
    submitPage: (html.match(/[a-zA-Z_]*[Pp]age[a-zA-Z_]*\\([^)]{0,60}/g) || []).slice(0, 6)
  };
  return out;
`;

(async () => {
  const url = process.argv[2];
  if (!url) { console.error('用法: node tools/diag-jd-pager.js <url>'); process.exit(1); }

  const b = await CDP.connect(9222);
  const page = await b.open('about:blank');

  // 抓翻页请求：点「下一页」之后发了什么
  const reqs = [];
  page.on('Network.requestWillBeSent', (p) => {
    const u = (p && p.request && p.request.url) || '';
    if (/\\.(js|css|png|jpg|jpeg|webp|gif|svg|woff2?|ico)(\\?|$)/i.test(u)) return;
    if (/jd\\.com/.test(u) && !/log|report|stat|beacon|track/i.test(u)) {
      reqs.push((p.request.method || 'GET') + ' ' + u.slice(0, 150));
    }
  });
  await page.send('Network.enable');

  await page.goto(url, 40000);
  await sleep(6000);
  try { await page.evaluate('window.scrollTo(0, 1500); return 1;', true); } catch (e) {}
  await sleep(2000);

  const r = await page.evaluate(PROBE, true);
  console.log('URL      : ' + r.href);
  console.log('\n--- .g-pager HTML ---');
  console.log(r.pagerHTML);
  console.log('\n--- 分页链接 ---');
  r.分页链接.forEach((l) => console.log('   ' + l));
  console.log('\n--- 跳页输入框 ---');
  r.跳页输入框.forEach((l) => console.log('   ' + l));
  console.log('\n--- JS 线索 ---');
  Object.keys(r.JS线索).forEach((k) => console.log('   ' + k + ': ' + JSON.stringify(r.JS线索[k])));

  // 试着点「下一页」（>）按钮
  console.log('\n--- 尝试点击下一页 ---');
  const clicked = await page.evaluate(`
    var cands = document.querySelectorAll('.g-pager a, .g-pager input, [class*="pn-next"], [class*="next"]');
    for (var i = 0; i < cands.length; i++) {
      var t = (cands[i].innerText || cands[i].value || '').trim();
      if (t === '>' || t === '下一页' || /next/i.test(String(cands[i].className || ''))) {
        cands[i].click();
        return '已点击: ' + (t || '(' + cands[i].className + ')');
      }
    }
    return '没找到下一页按钮；候选=' + cands.length;
  `, true);
  console.log('   ' + clicked);

  await sleep(6000);
  let after = '';
  try { after = await page.evaluate('return location.href.slice(0, 130);', true); } catch (e) {}
  console.log('   点击后 URL: ' + after);

  const uniq = [...new Set(reqs)];
  console.log('\n--- 请求 (' + uniq.length + ') ---');
  uniq.slice(0, 20).forEach((x) => console.log('   ' + x));

  try { await page.close(); } catch (e) {}
  await b.close();
})().catch((e) => { console.error('ERR', e && e.message); process.exit(1); });
