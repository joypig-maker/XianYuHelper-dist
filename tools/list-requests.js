/**
 * 列出打开某个页面时发出的全部请求 URL（不做过滤）。
 *
 *   node tools/list-requests.js <URL> [等待毫秒]
 *
 * 用途：整店页（offerlist.htm）里商品是 CSR 渲染的，SSR 没嵌 JSON，
 * 数据必然来自某个 XHR。这个脚本把全部请求 URL 打出来，
 * 用来确认到底哪个接口带商品数据。
 */
'use strict';

const PORT = Number(process.env.CDP_PORT || 9222);
const URL_ = process.argv[2] ||
  'https://shop3653158894s77.1688.com/page/offerlist.htm';
const WAIT = Number(process.argv[3] || 11000);

function http(port, p, method) {
  return new Promise((resolve, reject) => {
    const req = require('http').request(
      { host: '127.0.0.1', port, path: p, method: method || 'GET', timeout: 15000 },
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

  const seen = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Network.requestWillBeSent' && m.params) {
      const r = m.params.request || {};
      seen.set(m.params.requestId, (r.url || '').slice(0, 200));
    }
  });
  await send('Network.enable', { maxTotalBufferSize: 50 * 1024 * 1024 });

  await sleep(WAIT);

  console.log('=== ' + seen.size + ' 条请求 ===');
  [...seen.values()].forEach((u, i) => console.log(String(i + 1).padStart(3) + '. ' + u));

  ws.close();
  await http(PORT, '/json/close/' + tab.id);
  console.log('\n探针标签已关闭');
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
