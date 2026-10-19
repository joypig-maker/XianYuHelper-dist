/**
 * 1688 关键词搜索页现场诊断
 *
 *   node tools/diag-search.js [关键词] [等待毫秒]
 *
 * 用途：整店页的页面内复选框已经能挂，但关键词搜索页挂不上，
 * 说明搜索页的「接口数据结构」或「DOM 卡片定位」跟整店页不是一回事。
 * 光看代码猜必然返工，所以这里把三样东西一次性抓回来：
 *   1. 页面上真实发出的接口，以及每个接口能否解析出商品（跑 collectCards）
 *   2. 页面里各个候选选择器的命中数（调 cardSel 全靠这个）
 *   3. 插件已经抓到的卡片，逐条试三种定位路径，看哪条断掉
 * 结果写入 tools/_out/diag-search.json，同时打印摘要。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PORT = Number(process.env.CDP_PORT || 9222);
const KEYWORD = process.argv[2] || '手机支架';
const WAIT = Number(process.argv[3] || 14000);

const OUT_DIR = path.join(__dirname, '_out');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
const OUT_FILE = path.join(OUT_DIR, 'diag-search.json');

/* ---- 把插件的两个公共模块载入 node，用来离线复算解析结果 ---- */
function loadModule(file, globalName) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'common', file), 'utf8');
  const sandbox = { window: {}, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: file });
  // 模块末尾挂到的是「window 优先」的那个 global，所以取 sandbox.window，
  // 不是 sandbox 本身。写成 sandbox[globalName] 会拿到 undefined。
  return (sandbox.window && sandbox.window[globalName]) || sandbox[globalName];
}
const U = loadModule('util.js', 'XYUtil');
const SITES = loadModule('sites.js', 'XYSites');

function http(port, p, method) {
  return new Promise((resolve, reject) => {
    const req = require('http').request(
      { host: '127.0.0.1', port, path: p, method: method || 'GET', timeout: 20000 },
      (res) => {
        let b = [];
        res.on('data', (d) => b.push(d));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(b).toString())); }
          catch (e) { resolve({}); }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('CDP 无响应')));
    req.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const URL_ = 'https://s.1688.com/selloffer/offer_search.htm?keywords=' +
  encodeURIComponent(KEYWORD) + '&n=8&sortField=0';

/* 页面内诊断表达式 */
function diagExpr() {
  return `(() => {
    var S = (window.XYSites && window.XYSites.current(location)) || null;
    var out = {
      href: location.href,
      host: location.host,
      site: S ? S.key : null,
      injected: !!window.__XY__,
      bridge: !!window.__XY_BRIDGE__,
      cardSelCfg: S && S.cardSel ? S.cardSel : null
    };
    var xy = window.__XY__;
    var cards = xy ? (xy.getCards() || []) : [];
    out.cards = cards.length;
    out.cardSample = cards.slice(0, 5).map(function (c) {
      return { id: c.itemId, title: String(c.title||'').slice(0, 30), price: c.price, img: String(c.image||'').slice(0, 70) };
    });

    if (!S) return out;

    // 1) 候选选择器命中数
    var sels = ['.sm-offer-item','[class*="offer-item"]','[class*="OfferItem"]','[data-offer-id]',
                '[class*="item"]','[class*="product"]','[class*="card"]','[class*="sm-offer"]',
                'li[itemprop="product"]','[class*="result"]'];
    out.selHits = {};
    sels.forEach(function (s) { try { var n = document.querySelectorAll(s).length; if (n) out.selHits[s] = n; } catch (e) {} });

    // 2) 商品链接样本
    var links = [];
    var as = document.querySelectorAll('a[href]');
    for (var i = 0; i < as.length && links.length < 8; i++) {
      var h = as[i].getAttribute('href') || '';
      if (!h || h.length > 250) continue;
      var m = String(h).match(S.idRe);
      if (!m) continue;
      links.push({ id: String(m[1] || m[2] || ''), href: h.slice(0, 110), tag: as[i].tagName, cls: String(as[i].className || '').slice(0, 50) });
    }
    out.linkSamples = links;

    // 3) 定位路径逐个试
    if (!cards.length) return out;
    var Fn = window.XYUtil;
    var stat = { total: cards.length, linkSel: 0, attr: 0, image: 0, none: 0, details: [] };
    cards.slice(0, 6).forEach(function (c) {
      var hit = 'none', node = null;
      try { var a = document.querySelector(S.linkSel(c.itemId)); if (a) { hit = 'linkSel'; node = a; } } catch (e) {}
      if (hit === 'none') {
        try { var b = document.querySelector('[data-offer-id="' + c.itemId + '"],[data-itemid="' + c.itemId + '"],[data-item-id="' + c.itemId + '"]'); if (b) { hit = 'attr'; node = b; } } catch (e) {}
      }
      if (hit === 'none' && Fn) {
        var fp = Fn.imageFingerprint(c.image);
        if (fp) {
          var imgs = document.querySelectorAll('img');
          for (var k = 0; k < imgs.length; k++) {
            if (Fn.imageFingerprint(imgs[k].getAttribute('src')) === fp) { hit = 'image'; node = imgs[k]; break; }
          }
        }
      }
      stat[hit]++;
      var d = { id: c.itemId, hit: hit };
      if (node) {
        try {
          var r = node.getBoundingClientRect();
          d.rect = Math.round(r.width) + 'x' + Math.round(r.height);
          d.cls = String(node.className || '').slice(0, 60);
          d.parent = node.parentElement ? (node.parentElement.tagName + '.' + String(node.parentElement.className || '').slice(0, 50)) : '';
        } catch (e) {}
      }
      stat.details.push(d);
    });
    out.locate = stat;

    // 4) 页面上所有 /offer/ 链接的祖先结构（linkSel 到底该怎么写）
    var chains = {};
    var as2 = document.querySelectorAll('a[href]');
    for (var j = 0; j < as2.length && Object.keys(chains).length < 6; j++) {
      var hh = as2[j].getAttribute('href') || '';
      if (!hh || hh.length > 250) continue;
      if (!S.idRe.test(hh)) continue;
      var key = as2[j].tagName + '.' + String(as2[j].className || '');
      if (chains[key]) continue;
      var p = as2[j].parentElement, chain = [];
      for (var t = 0; p && t < 4; t++) {
        chain.unshift(p.tagName + '.' + String(p.className || '').slice(0, 40));
        p = p.parentElement;
      }
      chains[key] = chain.join(' > ');
    }
    out.linkChains = chains;
    return out;
  })()`;
}

async function main() {
  const created = await http(PORT, '/json/new?' + encodeURIComponent(URL_), 'PUT');
  const wantId = created.id || created.targetId;
  let tab = null;
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    const list = await http(PORT, '/json/list');
    tab = list.find((t) => t.id === wantId && t.type === 'page');
    if (tab && tab.webSocketDebuggerUrl && tab.url) break;
  }
  if (!tab) throw new Error('标签未就绪');

  const ws = new globalThis.WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('ws 连接失败（检查 http_proxy）')));
  });
  let mid = 0;
  const waiters = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id != null && waiters.has(m.id)) {
      const w = waiters.get(m.id); waiters.delete(m.id);
      m.error ? w.reject(new Error(JSON.stringify(m.error))) : w.resolve(m.result);
    }
  });
  const send = (method, params) => {
    const i = ++mid;
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
    return new Promise((resolve, reject) => waiters.set(i, { resolve, reject }));
  };
  // CDP 的 Runtime.evaluate 返回多层嵌套，取值地方不统一，统一在这里归一化
  function valueOf(r) {
    if (!r) return undefined;
    if (r.result && r.result.value !== undefined) return r.result.value;
    if (r.result && r.result.result && r.result.result.value !== undefined) return r.result.result.value;
    if (r.exceptionDetails) return { __error: r.exceptionDetails.text || 'exception', detail: r.exceptionDetails };
    return undefined;
  }

  const responses = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Network.responseReceived' && m.params) {
      const r = m.params.response || {};
      if (r.url) responses.push({ requestId: m.params.requestId, url: r.url, status: r.status, type: r.type });
    }
  });
  await send('Network.enable', { maxTotalBufferSize: 80 * 1024 * 1024 });
  await send('Runtime.enable', {});

  await sleep(WAIT);

  // 逐个取响应体，只关心可能带商品数据的接口
  const SITE = SITES.p1688;
  const parsed = [];
  for (const r of responses) {
    if (r.status >= 400) continue;
    if (!SITE.apiRe.test(r.url)) continue;
    let bodyText = '';
    try {
      const g = await send('Network.getResponseBody', { requestId: r.requestId });
      bodyText = (g && g.body) || '';
    } catch (e) { continue; }
    if (!bodyText || bodyText.length < 200) continue;
    let json = null;
    try { json = JSON.parse(bodyText); } catch (e) { continue; }
    const data = json && json.data != null ? json.data : null;
    const cards = data != null ? U.collectCards(data, { site: SITE }) : [];
    parsed.push({
      url: r.url.slice(0, 160),
      bytes: bodyText.length,
      hasData: data != null,
      cardCount: cards.length,
      sample: cards.slice(0, 3).map((c) => ({ id: c.itemId, title: String(c.title).slice(0, 24), price: c.price, img: String(c.image).slice(0, 60) }))
    });
  }

  const diag = valueOf(await send('Runtime.evaluate', {
    expression: diagExpr(), returnByValue: true, awaitPromise: false
  }));

  const result = {
    keyword: KEYWORD,
    url: URL_,
    page: diag,
    api: parsed,
    scrapedAt: new Date().toISOString()
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 2), 'utf8');

  console.log('=== 页面诊断 ===');
  console.log('site        :', result.page && result.page.site);
  console.log('injected    :', result.page && result.page.injected, ' bridge:', result.page && result.page.bridge);
  console.log('cards       :', result.page && result.page.cards);
  console.log('cardSample  :', JSON.stringify((result.page && result.page.cardSample) || []));
  console.log('selHits     :', JSON.stringify((result.page && result.page.selHits) || {}));
  console.log('linkSamples :', JSON.stringify((result.page && result.page.linkSamples) || []));
  console.log('locate      :', JSON.stringify((result.page && result.page.locate) || {}));
  console.log('');
  console.log('=== 接口解析 ===');
  if (!parsed.length) console.log('（没有命中的接口响应）');
  parsed.forEach((p, i) => {
    console.log(String(i + 1) + '. ' + p.cardCount + ' 张  ' + p.bytes + 'B  ' + p.url);
    if (p.sample.length) console.log('    ' + JSON.stringify(p.sample));
  });
  console.log('');
  console.log('linkChains  :', JSON.stringify((result.page && result.page.linkChains) || {}));
  console.log('\n完整结果 → ' + OUT_FILE);

  ws.close();
  await http(PORT, '/json/close/' + tab.id);
}

main().catch((e) => { console.error('ERR', e && e.message || e); process.exit(1); });
