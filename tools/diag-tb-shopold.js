/**
 * 旧版店铺页（search.htm / shop<id>.taobao.com）取数方式补测
 *
 * 用户要求新旧两种整店入口都支持。新版（store.taobao.com/category.htm）已实测
 * 走接口 mtop.taobao.shop.simple.item.fetch；旧版还没碰过，得先弄清：
 *   ① 现在访问会不会 302 到新版
 *   ② 商品在 DOM 里还是靠接口
 *   ③ 若走接口，接口名与参数是什么
 * 店铺 ID 从上一轮搜索页抓到的真实链接里取，避免手写错。
 */
'use strict';

const CDP = require('./cdp');

const CANDIDATES = [
  'https://shop375415709.taobao.com/search.htm',
  'https://shop375415709.taobao.com/category.htm',
  'https://minwai.tmall.com/search.htm',
  'https://minwai.tmall.com/category.htm'
];

async function probe(b, url) {
  const { targetId } = await b.createTarget('about:blank');
  const page = await b.attachTarget({ id: targetId });
  const reqs = [];
  await page.send('Network.enable');
  page.on('Network.requestWillBeSent', (p) => {
    const u = (p.request && p.request.url) || '';
    if (!/shop\.simple|item\.fetch|category|search\.htm/i.test(u)) return;
    if (/\.(png|jpg|css|js)(\?|$)/i.test(u)) return;
    reqs.push(u);
  });

  const r = { url: url, };
  try {
    await page.goto(url, 35000);
    await new Promise((res) => setTimeout(res, 6000));
    const info = await page.evaluate(`return (function(){
      var links = document.querySelectorAll('a[href*="item.taobao.com"],a[href*="detail.tmall.com"]');
      var body = document.body ? document.body.innerText : '';
      return {
        title: (document.title||'').slice(0, 50),
        finalUrl: location.href.slice(0, 130),
        host: location.host,
        商品链接数: links.length,
        doubleCard: document.querySelectorAll('[class*="doubleCard"]').length,
        Item类: document.querySelectorAll('[class*="Item"]').length,
        文本长度: body.length,
        片段: body.slice(0, 150).replace(/\\s+/g, ' ')
      };
    })()`);
    Object.assign(r, info);
  } catch (e) {
    r.err = e.message;
  }
  r.apiCalls = [...new Set(reqs.map((u) => u.split('?')[0]))].slice(0, 6);
  await page.close();
  return r;
}

(async () => {
  const b = await CDP.connect(9222);
  for (const url of CANDIDATES) {
    console.log('\n' + '='.repeat(70));
    console.log('探测: ' + url);
    const r = await probe(b, url);
    if (r.err) { console.log('  失败:', r.err); continue; }
    console.log('  落地 host:' + r.host + '  url=' + r.finalUrl);
    console.log('  title=' + r.title);
    console.log('  商品链接=' + r.商品链接数 + '  doubleCard=' + r.doubleCard + '  Item类=' + r.Item类);
    console.log('  文本长度=' + r.文本长度 + '  片段=' + r.片段);
    console.log('  接口调用:');
    r.apiCalls.forEach((u) => console.log('    ' + u.slice(0, 120)));
  }
  await b.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
