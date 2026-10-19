/**
 * 抓一份京东店铺页的真实卡片固件，供后续离线调选择器。
 *
 * 为什么要这么做：京东店铺页限流极敏感 —— 实测两次请求只隔几分钟就会
 * 返回「稍后...」的降级页（商品列表整个消失）。照以前的节奏
 * （开页面 → 看字段 → 改选择器 → 再开页面）根本调不了几轮。
 *
 * 所以：**一次请求把结构抓全，之后全在本地固件上迭代**。
 *
 * 用法：node tools/make-jd-shop-fixture.js [url]
 * 产出：tools/fixtures/jd-shop-real.json
 */
'use strict';
const fs = require('fs');
const path = require('path');
const CDP = require('./cdp');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'tools/fixtures/jd-shop-real.json');

(async () => {
  const url = process.argv[2] || 'https://mall.jd.com/view_search-991882-0-99-1-20-1.html';
  const b = await CDP.connect(9222);
  const page = await b.open('about:blank');
  await page.goto(url, 40000);
  await sleep(9000);
  try { await page.evaluate('window.scrollTo(0, 1200); return 1;', true); } catch (e) {}
  await sleep(2500);

  const r = await page.evaluate(`
    var out = {};
    out.url = location.href.slice(0, 140);
    out.title = (document.title || '').slice(0, 60);
    out.glItem = document.querySelectorAll('.gl-item').length;
    var t = (document.body ? document.body.innerText : '') || '';
    out.限流 = /稍后|抱歉|异常|频繁/.test(t.slice(0, 600)) &&
      document.querySelectorAll('.gl-item').length === 0;

    // 卡片选择器的候选：哪些节点的子节点里"商品 ID 最集中"
    var lis = document.querySelectorAll('.gl-item');
    out.卡片选择器 = lis.length ? '.gl-item' : '(没采到 .gl-item，需要另找)';

    // 抓 2 张卡的 outerHTML —— 一张就够改选择器，两张能看出哪些字段是变的
    out.卡片HTML = [];
    for (var i = 0; i < Math.min(2, lis.length); i++) {
      out.卡片HTML.push(String(lis[i].outerHTML).replace(/\\s+/g, ' '));
    }

    // 页面级信息（店铺名、总数、分页）
    out.总数 = (t.match(/共\\s*\\d+\\s*件/) || [''])[0];
    out.分页 = (function () {
      var g = document.querySelector('.g-pager');
      return g ? String(g.innerText || '').replace(/\\s+/g, ' ') : '(无)';
    })();

    // 所有含 price 的类名（去重），用来补价格选择器
    var cls = new Set();
    Array.prototype.forEach.call(document.querySelectorAll('[class*="rice"]'), function (n) {
      cls.add(String(n.className || '').slice(0, 50));
    });
    out.含price的类名 = [...cls].slice(0, 25);

    // 所有含 img 的类名（去重）
    var icls = new Set();
    Array.prototype.forEach.call(document.querySelectorAll('.gl-item img'), function (n) {
      icls.add(String(n.className || '(无类名)').slice(0, 40) + ' | parent=' +
        String((n.parentElement && n.parentElement.className) || '').slice(0, 40));
    });
    out.卡片内img = [...icls].slice(0, 10);

    // 分页控件的真实结构（翻页怎么走）
    var gp = document.querySelector('.g-pager');
    out.分页HTML = gp ? String(gp.outerHTML).replace(/\\s+/g, ' ').slice(0, 800) : '(无)';
    // 页面里 view_search 链接（appId 的来源）
    var vs = new Set();
    Array.prototype.forEach.call(document.querySelectorAll('a[href*="view_search"]'), function (a) {
      vs.add(String(a.getAttribute('href') || '').slice(0, 100));
    });
    out.view_search链接 = [...vs].slice(0, 5);
    return out;
  `, true);

  console.log('URL    : ' + r.url);
  console.log('标题   : ' + r.title);
  console.log('gl-item: ' + r.glItem + '   限流=' + r.限流);
  console.log('总数   : ' + r.总数 + '   分页=' + r.分页);
  console.log('含 price 的类名: ' + JSON.stringify(r.含price的类名));
  console.log('卡片内 img     : ' + JSON.stringify(r.卡片内img));
  console.log('view_search 链接: ' + JSON.stringify(r.view_search链接));
  console.log('分页 HTML: ' + r.分页HTML);

  if (!r.卡片HTML || !r.卡片HTML.length) {
    console.log('\n✗ 没抓到卡片（' + (r.限流 ? '正被限流，等一会儿再来' : '选择器可能变了') + '）');
    try { await page.close(); } catch (e) {}
    await b.close();
    process.exit(1);
  }

  fs.writeFileSync(OUT, JSON.stringify(r, null, 1), 'utf8');
  console.log('\n✓ 固件已写入 ' + OUT + '（' + fs.statSync(OUT).size + ' 字节）');
  console.log('\n--- 第 1 张卡片（前 1200 字）---');
  console.log(r.卡片HTML[0].slice(0, 1200));

  try { await page.close(); } catch (e) {}
  await b.close();
})().catch((e) => { console.error('ERR', e && e.message); process.exit(1); });
