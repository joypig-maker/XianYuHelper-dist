/**
 * 重新加载扩展（load 的解压目录不会自动生效，改完代码必须这一步）
 *
 *   node tools/reload-ext.js
 *
 * 打开扩展自己的 popup 页面，在里面执行 chrome.runtime.reload()，
 * 比在 chrome://extensions 上模拟点击按钮稳（页面结构变过多次，选择器不可靠）。
 */
'use strict';
const PORT = Number(process.env.CDP_PORT || 9222);
const EXT = process.argv[2] || 'lfpfjplffgpbmfekakcnjfekbllilcki';

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

(async () => {
  const popupUrl = 'chrome-extension://' + EXT + '/src/popup/popup.html';
  const created = await httpJson(PORT, '/json/new?' + encodeURIComponent('about:blank'), 'PUT');
  const wantId = created.id;
  let tab = null;
  for (let i = 0; i < 30; i++) {
    await sleep(250);
    const list = await httpJson(PORT, '/json/list');
    tab = list.find((t) => t.id === wantId && t.webSocketDebuggerUrl);
    if (tab) break;
  }
  if (!tab) throw new Error('新标签没出现');

  const ws = new globalThis.WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws 失败'))); });
  const send = (m, p) => {
    const id = ++send._id;
    ws.send(JSON.stringify({ id, method: m, params: p || {} }));
    return new Promise((res, rej) => send._w.set(id, { res, rej }));
  };
  send._id = 0; send._w = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id != null && send._w.has(m.id)) {
      const w = send._w.get(m.id); send._w.delete(m.id);
      m.error ? w.rej(new Error(JSON.stringify(m.error))) : w.res(m.result);
    }
  });
  await send('Page.enable');
  await send('Page.navigate', { url: popupUrl });
  await sleep(2500);

  // 先看扩展可不可用，再决定要不要 reload
  let ping = null;
  try {
    const r = await send('Runtime.evaluate', {
      expression: '(()=>{try{return typeof chrome.runtime.reload;}catch(e){return "ERR:"+e.message;}})()',
      returnByValue: true
    });
    ping = r.result.value;
  } catch (e) {}

  if (ping === 'function') {
    await send('Runtime.evaluate', {
      expression: '(()=>{try{chrome.runtime.reload();return "reload() 已调用";}catch(e){return "ERR:"+e.message;}})()',
      returnByValue: true
    });
    console.log('已触发 chrome.runtime.reload()');
    await sleep(1500);
  } else {
    console.log('扩展页里没拿到 chrome.runtime（ping=' + ping + '），走刷新标签这条路');
  }

  // 顺手把 1688 相关标签刷新一遍，让新的 content script 立刻生效
  const list = await httpJson(PORT, '/json/list');
  const refreshed = [];
  for (const t of list) {
    if (t.type === 'page' && /1688\.com|goofish\.com|xianyu\.com/.test(t.url || '')) {
      await httpJson(PORT, '/json/close/' + t.id);
      refreshed.push((t.url || '').slice(0, 60));
    }
  }
  if (refreshed.length) {
    console.log('已关闭并刷新 ' + refreshed.length + ' 个站点标签，再次导航会重新注入脚本：');
    refreshed.forEach((u) => console.log('   ', u));
  } else {
    console.log('没有找到需要刷新的站点标签');
  }
  try { ws.close(); } catch (e) {}
  try { await httpJson(PORT, '/json/close/' + wantId); } catch (e) {}
})().catch((e) => { console.error('ERR', e.message.split('\n')[0]); process.exit(1); });
