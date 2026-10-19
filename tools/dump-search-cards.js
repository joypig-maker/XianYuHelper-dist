/**
 * 1688 搜索页：把每个商品卡片周围的 DOM 原样挖出来。
 *
 *   node tools/dump-search-cards.js [关键词] [取几个]
 *
 * 用途：diag-search.js 已经证明搜索页卡片定位「三条路全断」，
 * 但不知道图指纹那一条到底断在哪：是 DOM 里根本没有 <img>，
 * 还是 src 跟接口字段形态不同（data-src 懒加载、带尺寸后缀…）。
 * 这里把卡片的 class、尺寸和里面每张图的 src / data-src 都打出来，
 * 据此决定选择器怎么写。
 */
'use strict';

const PORT = Number(process.env.CDP_PORT || 9222);
const KEYWORD = process.argv[2] || '手机支架';
const LIMIT = Number(process.argv[3] || 5);
const WAIT = 24000;

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

const EXPR = `(() => {
  var out = [];
  out.__ctx = { href: location.href.slice(0, 120), title: String(document.title || '').slice(0, 60), ready: document.readyState };
  var as = document.querySelectorAll('a[href*="offerId="]');
  for (var i = 0; i < as.length && out.length < ${LIMIT}; i++) {
    var a = as[i];
    var h = a.getAttribute('href') || '';
    var m = h.match(/offerId=(\\d{6,20})/);
    if (!m) continue;
    var r = a.getBoundingClientRect();
    var imgs = [];
    var list = a.querySelectorAll('img');
    for (var k = 0; k < list.length; k++) {
      imgs.push({
        src: String(list[k].getAttribute('src') || '').slice(0, 120),
        dsrc: String(list[k].getAttribute('data-src') || '').slice(0, 120),
        nat: list[k].naturalWidth || 0
      });
    }
    out.push({
      id: m[1],
      rect: Math.round(r.width) + 'x' + Math.round(r.height),
      cls: String(a.className || ''),
      href: h.slice(0, 90),
      title: String(a.getAttribute('title') || '').slice(0, 40),
      imgs: imgs
    });
  }
  // 再附一张页面上「ibly所有带 offer-item 的祖先容器」的图样，供核对 cardBox 落点
  var boxes = [];
  var hit = document.querySelectorAll('[class*="offer-item"]');
  for (var j = 0; j < hit.length && boxes.length < 3; j++) {
    var n = hit[j], chain = [], p = n;
    for (var t = 0; p && t < 4; t++) {
      chain.unshift(p.tagName + '.' + String(p.className || '').slice(0, 45));
      p = p.parentElement;
    }
    boxes.push({ cls: String(n.className || '').slice(0, 60), chain: chain.join(' > ') });
  }
  return { cards: out, boxes: boxes, offerItemCount: hit.length };
})()`;

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
  function valueOf(r) {
    if (!r) return undefined;
    if (r.result && r.result.value !== undefined) return r.result.value;
    if (r.result && r.result.result && r.result.result.value !== undefined) return r.result.result.value;
    return undefined;
  }

  await send('Runtime.enable', {});
  await sleep(WAIT);
  const v = valueOf(await send('Runtime.evaluate', { expression: EXPR, returnByValue: true }));
  console.log('页面上下文：', JSON.stringify((v && v.__ctx) || {}));
  console.log('offer-item 命中数：', v && v.offerItemCount);
  console.log('\n=== 卡片容器 ===');
  console.log(JSON.stringify((v && v.boxes) || [], null, 2));
  console.log('\n=== 卡片明细 ===');
  console.log(JSON.stringify((v && v.cards) || [], null, 2));

  ws.close();
  await http(PORT, '/json/close/' + tab.id);
}

main().catch((e) => { console.error('ERR', e && e.message || e); process.exit(1); });
