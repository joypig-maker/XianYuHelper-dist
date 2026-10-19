/**
 * 淘宝搜索页探路：确认登录态 + 摸清商品卡片的 DOM 结构与取数接口
 *
 * 只读不改：打开页面、收集网络请求、读 DOM，不点任何东西。
 */
'use strict';

const CDP = require('./cdp');

const KEYWORD = process.argv[2] || '手机支架';
const URL = 'https://s.taobao.com/search?q=' + encodeURIComponent(KEYWORD);

(async () => {
  const b = await CDP.connect(9222);
  // Chrome 111+ 移除了 PUT /json/new，必须走 Target.createTarget
  const { targetId } = await b.createTarget('about:blank');
  const page = await b.attachTarget({ id: targetId });

  // 收网络请求
  const reqs = [];
  await page.send('Network.enable');
  page.on('Network.requestWillBeSent', (p) => {
    const u = p.request && p.request.url;
    if (!u) return;
    if (!/^https?:/.test(u)) return;
    if (/\.(png|jpg|jpeg|gif|webp|css|woff2?|ttf|svg)(\?|$)/i.test(u)) return;
    reqs.push({ url: u, method: p.request.method, type: p.type });
  });

  await page.goto(URL, 40000);
  await new Promise((r) => setTimeout(r, 5000));

  console.log('=== 页面 ===');
  console.log('title:', await page.evaluate('return document.title'));
  console.log('url  :', await page.evaluate('return location.href').then((u) => String(u).slice(0, 140)));

  // 登录态
  const login = await page.evaluate(`return (function(){
    var s = document.body ? document.body.innerText.slice(0, 400) : '';
    return {
      hasLoginText: /登录|亲，请登录/.test(s),
      nickEl: !!document.querySelector('.site-nav-user,.site-nav-login-info-nick,#J_SiteNavLogin'),
      nickname: (document.querySelector('.site-nav-user')||{}).innerText || ''
    };
  })()`);
  console.log('登录态:', JSON.stringify(login));

  // 商品卡片
  const cards = await page.evaluate(`return (function(){
    function pick(sel){ return document.querySelectorAll(sel).length; }
    var sels = ['[class*="Card--doubleCard"]','[class*="doubleCard"]','[class*="Card"]',
      '[class*="item"]','[data-nid]','a[href*="item.taobao.com"]','a[href*="detail.tmall.com"]'];
    var out = {};
    sels.forEach(function(s){ try{ out[s]=pick(s); }catch(e){ out[s]='err'; } });
    return out;
  })()`);
  console.log('\n=== 候选选择器命中数 ===');
  console.log(JSON.stringify(cards, null, 1));

  // 取一个卡片看结构
  const sample = await page.evaluate(`return (function(){
    var nodes = document.querySelectorAll('[class*="doubleCard"],[class*="Card--"]');
    if(!nodes.length) return {err:'no card node'};
    var el = nodes[0];
    var a = el.querySelector('a[href]');
    var img = el.querySelector('img');
    return {
      cls: el.className,
      innerText: (el.innerText||'').slice(0,160),
      href: a ? a.getAttribute('href') : '',
      imgSrc: img ? (img.getAttribute('src')||'').slice(0,120) : '',
      imgDataSrc: img ? (img.getAttribute('data-src')||'') : '',
      html: el.outerHTML.slice(0, 700)
    };
  })()`);
  console.log('\n=== 首个卡片结构 ===');
  console.log(JSON.stringify(sample, null, 1));

  console.log('\n=== 请求（共 ' + reqs.length + ' 个，取与商品/搜索相关的）===');
  const hit = reqs.filter((r) => /search|item|mtop|h5api|list|offer|goods|async/i.test(r.url));
  hit.slice(0, 40).forEach((r) => console.log('  [' + r.type + '] ' + r.url.slice(0, 155)));
  console.log('  … 共 ' + hit.length + ' 个');

  await page.close();
  await b.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
