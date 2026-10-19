/**
 * 一次性探针：打开整店页（offerlist.htm），等渲染，把页面真实内容 dump 出来。
 *
 *   node tools/dump-offerlist.js
 *
 * 目的：搞清楚「全部商品」页到底是不是真为空，还是我们的解析路径没对上。
 * 走 /json/new 建标签 → 从 /json/list 取该标签自己的 ws → 直连 evaluate。
 */
'use strict';

const PORT = Number(process.env.CDP_PORT || 9222);
const URL_ = process.argv[2] ||
  'https://shop3653158894s77.1688.com/page/offerlist.htm';
const WAIT = Number(process.argv[3] || 9000);

function http(port, p, method) {
  return new Promise((resolve, reject) => {
    const req = require('http').request(
      { host: '127.0.0.1', port, path: p, method: method || 'GET', timeout: 15000 },
      (res) => {
        let b = [];
        res.on('data', (d) => b.push(d));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(b).toString())); }
          catch (e) { resolve({ __raw: Buffer.concat(b).toString().slice(0, 300) }); }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('CDP 无响应')));
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const created = await http(PORT, '/json/new?' + encodeURIComponent(URL_), 'PUT');
  const wantId = created.id || created.targetId;
  console.log('新建标签:', (created.url || '').slice(0, 100));

  let tab = null;
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    const list = await http(PORT, '/json/list');
    tab = list.find((t) => t.id === wantId && t.type === 'page');
    if (tab && tab.webSocketDebuggerUrl && (tab.url || '').indexOf('offerlist') > -1) break;
  }
  if (!tab) throw new Error('标签未就绪');

  const ws = new globalThis.WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('ws 连接失败（检查 http_proxy）')));
  });
  let id = 0;
  const waiters = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id != null && waiters.has(m.id)) {
      const w = waiters.get(m.id); waiters.delete(m.id);
      m.error ? w.reject(new Error(JSON.stringify(m.error))) : w.resolve(m.result);
    }
  });
  const send = (method, params) => {
    const i = ++id;
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
    return new Promise((resolve, reject) => waiters.set(i, { resolve, reject }));
  };

  const expr = `(() => {
    var b = document.body;
    var txt = (b.innerText || '').replace(/\\s+/g, ' ').trim();
    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      textLen: txt.length,
      textHead: txt.slice(0, 800),
      bodyHtmlLen: (b.innerHTML || '').length,
      anchors: document.querySelectorAll('a').length,
      imgs: document.querySelectorAll('img').length,
      links: Array.prototype.slice.call(document.querySelectorAll('a'))
        .slice(0, 15).map(function (a) { return (a.innerText || '').trim() + ' -> ' + a.href; }),
      // 抓不到商品时最想知道的是「页面上到底有没有商品痕迹」
      itemish: document.querySelectorAll('[class*="offer"],[class*="item"],[class*="product"]').length
    };
  })()`;

  await sleep(WAIT);
  const r = await send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true
  });
  if (r.exceptionDetails) throw new Error('页面异常: ' +
    ((r.exceptionDetails.exception || {}).description || '?').split('\n')[0]);
  console.log(JSON.stringify(r.result.value, null, 2));

  ws.close();
  await http(PORT, '/json/close/' + tab.id);
  console.log('\n已关闭探针标签（你原来的标签都还在）');
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
