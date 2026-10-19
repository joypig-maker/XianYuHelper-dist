/**
 * 京东搜索页结构探测。
 *
 * 目标：判定它是 SSR 还是接口渲染，并摸清卡片的字段落点。
 * 结论一律以真机为准——选择器靠猜必然返工（淘宝那轮就是教训）。
 *
 * 用法：node tools/diag-jd-search.js [关键词]
 */
'use strict';
const CDP = require('./cdp');

const KW = process.argv[2] || '手机支架';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await CDP.connect(9222);
  const url = 'https://search.jd.com/Search?keyword=' + encodeURIComponent(KW) + '&enc=utf-8';
  console.log('打开: ' + url);
  const page = await b.open(url);

  await sleep(10000);

  const r = await page.evaluate(`
    var out = {};
    out.href = location.href.slice(0, 130);
    out.title = document.title.slice(0, 80);
    out.bodyLen = (document.body.innerText || '').length;

    function n(sel) { try { return document.querySelectorAll(sel).length; } catch (e) { return 'err'; } }

    // 京东 PC 搜索页的经典结构是 ul.gl-warp > li.gl-item[data-sku]
    out.候选卡片选择器 = {
      'li.gl-item': n('li.gl-item'),
      '[data-sku]': n('[data-sku]'),
      '#J_goodsList li': n('#J_goodsList li'),
      '.gl-i-wrap': n('.gl-i-wrap'),
      'ul.gl-warp > li': n('ul.gl-warp > li'),
      '[class*="gl-item"]': n('[class*="gl-item"]')
    };

    // 挑一张卡片 dump 结构
    var card = document.querySelector('li.gl-item[data-sku]') || document.querySelector('li.gl-item') || document.querySelector('[data-sku]');
    if (card) {
      out.卡片 = {};
      out.卡片.tag = card.tagName + '.' + String(card.className || '').slice(0, 60);
      out.卡片.attrs = {};
      Array.prototype.forEach.call(card.attributes, function (a) { out.卡片.attrs[a.name] = String(a.value).slice(0, 40); });
      out.卡片.text = (card.innerText || '').replace(/\\s+/g, ' ').slice(0, 160);
      out.卡片.aHref = Array.prototype.slice.call(card.querySelectorAll('a[href]')).slice(0, 6)
        .map(function (a) { return String(a.getAttribute('href')).slice(0, 80); });
      out.卡片.imgs = Array.prototype.slice.call(card.querySelectorAll('img')).slice(0, 4)
        .map(function (i) {
          return { src: String(i.getAttribute('src') || '').slice(0, 70),
                   lazy: String(i.getAttribute('data-lazy-img') || '').slice(0, 70) };
        });
      out.卡片.classList = Array.prototype.slice.call(card.querySelectorAll('*')).slice(0, 30)
        .map(function (e) { return e.tagName.toLowerCase() + '.' + String(e.className || '').replace(/\\s+/g, '.').slice(0, 44); });
    } else {
      out.卡片 = '(没找到)';
    }

    // 正文开头，看是不是验证/登录页
    out.head = (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 180);
    return out;
  `, true);

  console.log('\n' + JSON.stringify(r, null, 1));
  await b.close();
})().catch((e) => { console.error('ERR', e && e.message); process.exit(1); });
