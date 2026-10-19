/**
 * 在调试浏览器里新开一个标签并等待渲染
 *
 *   node tools/open-page.js <URL> [--wait 毫秒]
 *
 * 实现要点：/json/new 建标签后，再从 /json/list 里取新标签自己的
 * webSocketDebuggerUrl 直连。不走 attachToTarget——Chrome 154 下会超时；
 * 走 http 而非 ws 代理，所以本机的 http_proxy 不影响这里。
 */
'use strict';

const PORT = Number(process.env.CDP_PORT || 9222);

function httpJson(port, p, method) {
  return new Promise((resolve, reject) => {
    const req = require('http').request(
      { host: '127.0.0.1', port, path: p, method: method || 'GET', timeout: 10000 },
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
    req.on('timeout', () => req.destroy(new Error('CDP 无响应')));
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connectTab(url) {
  const created = await httpJson(PORT, '/json/new?' + encodeURIComponent(url), 'PUT');
  const wantId = created.id;
  let tab = null;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const list = await httpJson(PORT, '/json/list');
    tab = list.find((t) => t.id === wantId && t.webSocketDebuggerUrl);
    if (tab) break;
  }
  if (!tab) throw new Error('新标签没出现在 /json/list');

  const ws = new globalThis.WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('ws 连接失败')));
  });
  const send = (method, params) => {
    const id = ++send._id;
    ws.send(JSON.stringify({ id, method, params: params || {} }));
    return new Promise((resolve, reject) => send._w.set(id, { resolve, reject }));
  };
  send._id = 0; send._w = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id != null && send._w.has(m.id)) {
      const w = send._w.get(m.id); send._w.delete(m.id);
      m.error ? w.reject(new Error(JSON.stringify(m.error))) : w.resolve(m.result);
    }
  });
  return {
    url: () => tab.url,
    close: () => { try { ws.close(); } catch (e) {} },
    async evaluate(exprStr, timeout) {
      const r = await send('Runtime.evaluate', {
        expression: '(()=>{' + exprStr + '})()',
        returnByValue: true,
        awaitPromise: true
      });
      if (r.exceptionDetails) {
        throw new Error('页面异常: ' + ((r.exceptionDetails.exception || {}).description || '').split('\n')[0]);
      }
      return r.result.value;
    }
  };
}

(async () => {
  const url = process.argv[2];
  const waitIdx = process.argv.indexOf('--wait');
  const wait = waitIdx > -1 ? Number(process.argv[waitIdx + 1]) : 6000;
  if (!url) throw new Error('用法: node tools/open-page.js <URL> [--wait 毫秒]');

  const tab = await connectTab(url);
  // 等 SPA 渲染 + 插件初始扫描
  for (let i = 0; i < Math.ceil(wait / 1500); i++) {
    await sleep(1500);
    let st = null;
    try { st = await tab.evaluate('return document.readyState'); } catch (e) {}
    const alive = await tab.evaluate('return { r: document.readyState, cards: (window.__XY__ && window.__XY__.getCards ? window.__XY__.getCards().length : -1), t: (document.title||"").slice(0,30) }');
    console.log('  ...渲染中 readyState=' + (alive && alive.r) + ' 已识别商品=' + (alive && alive.cards));
  }
  const info = await tab.evaluate('return { url: location.href, title: (document.title||"").slice(0,60), cards: (window.__XY__ && window.__XY__.getCards ? window.__XY__.getCards() : []) }');
  console.log('URL  :', info.url.slice(0, 110));
  console.log('标题 :', info.title);
  console.log('商品数:', info.cards.length);
  console.log(JSON.stringify(info.cards.slice(0, 12), null, 2));
  tab.close();
})().catch((e) => { console.error('ERR', e.message.split('\n')[0]); process.exit(1); });
