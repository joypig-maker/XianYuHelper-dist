/**
 * 只读探测当前已打开的页面
 *
 * 用途：浏览器已经开着目标页面时（尤其刚被风控过、不宜再发请求时），
 * 不导航、不刷新，直接在该页面里执行 JS 取结构。
 *
 *   node tools/read-page.js <URL正则> '<JS 表达式>'
 *   node tools/read-page.js <URL正则> --file probe.js
 *
 * 实现说明：直连该标签页自己的 webSocketDebuggerUrl（/json/list 里拿），
 * 不走 attachToTarget——实测 Chrome 154 下 attach 会超时。
 * 同时注意：本机会设 http_proxy，Node 的 WebSocket 可能因此把 127.0.0.1 也走了代理，
 * 连不上时先 `unset http_proxy https_proxy` 再跑。
 */
'use strict';
const path = require('path');
const fs = require('fs');

const PORT = Number(process.env.CDP_PORT || 9222);
const pattern = process.argv[2];
const exprArg = process.argv[3];
let expr = exprArg;
if (exprArg === '--file') expr = fs.readFileSync(path.resolve(process.argv[4]), 'utf8');

function httpJson(port, p) {
  return new Promise((resolve, reject) => {
    const req = require('http').request(
      { host: '127.0.0.1', port, path: p, timeout: 8000 },
      (res) => {
        let b = [];
        res.on('data', (d) => b.push(d));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(b).toString())); }
          catch (e) { reject(new Error('非 JSON: ' + Buffer.concat(b).slice(0, 160))); }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('CDP 端口 ' + port + ' 无响应')));
    req.end();
  });
}

(async () => {
  if (!/WebSocket/.test(globalThis.WebSocket ? 'WebSocket' : '')) {
    throw new Error('当前 Node 无全局 WebSocket，需 22.4+');
  }
  const list = await httpJson(PORT, '/json/list');
  const tab = list.find((t) => t.type === 'page' && new RegExp(pattern).test(t.url || ''));
  if (!tab) {
    console.log('没有匹配 /' + pattern + '/ 的页面。现有标签：');
    list.filter((t) => t.type === 'page').forEach((t) => console.log('  ', (t.url || '').slice(0, 100)));
    return;
  }
  console.log('页面:', (tab.url || '').slice(0, 110));

  const ws = new globalThis.WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('ws 连接失败（多半是被 http_proxy 拦截，先 unset 代理变量）')));
  });

  const send = (method, params) => {
    const id = ++send._id;
    ws.send(JSON.stringify({ id, method, params: params || {} }));
    return new Promise((resolve, reject) => { send._w.set(id, { resolve, reject }); });
  };
  send._id = 0;
  send._w = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id != null && send._w.has(m.id)) {
      const w = send._w.get(m.id); send._w.delete(m.id);
      m.error ? w.reject(new Error(JSON.stringify(m.error))) : w.resolve(m.result);
    }
  });

  const r = await send('Runtime.evaluate', {
    expression: '(()=>{' + expr + '})()',
    returnByValue: true,
    awaitPromise: true
  });
  if (r.exceptionDetails) {
    throw new Error('页面异常: ' + ((r.exceptionDetails.exception || {}).description || 'unknown').split('\n')[0]);
  }
  console.log(JSON.stringify(r.result.value, null, 2));
  ws.close();
})().catch((e) => { console.error('ERR', e.message.split('\n')[0]); process.exit(1); });
