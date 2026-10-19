/**
 * 把 chrome://extensions 的 DOM（含 shadow DOM）结构原样挖出来，
 * 目的是找到「移除」和「加载已解压的扩展」这两个按钮的确切节点，
 * 而不是照记忆写选择器——Chrome 每个大版本的内部结构都变过。
 *
 * 输出：所有带 id 的按钮 / 菜单项，以及命中关键词的那几处文本。
 */
'use strict';

const PORT = Number(process.env.CDP_PORT || 9222);

function http(p, method) {
  return new Promise((resolve, reject) => {
    const req = require('http').request(
      { host: '127.0.0.1', port: PORT, path: p, method: method || 'GET', timeout: 20000 },
      (res) => { let b = []; res.on('data', (d) => b.push(d)); res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(b))); } catch (e) { resolve({}); } }); }
    );
    req.on('error', reject); req.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function attach(wsUrl) {
  const ws = new globalThis.WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws 失败'))); });
  let mid = 0; const w = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id != null && w.has(m.id)) { const k = w.get(m.id); w.delete(m.id); m.error ? k.rej(new Error(JSON.stringify(m.error))) : k.res(m.result); }
  });
  const send = (method, params) => { const i = ++mid; ws.send(JSON.stringify({ id: i, method, params: params || {} })); return new Promise((res, rej) => w.set(i, { res, rej })); };
  return { send, val: (r) => (r && r.result && r.result.value !== undefined ? r.result.value : (r && r.exceptionDetails ? { __err: r.exceptionDetails.text } : undefined)), close: () => ws.close() };
}

(async () => {
  const opened = await http('/json/new?' + encodeURI('chrome://extensions/'), 'PUT');
  const target = opened.id || opened.targetId;
  let tab = null;
  for (let i = 0; i < 25; i++) {
    await sleep(400);
    const l = await http('/json/list');
    const t = l.find((x) => x.id === target && x.type === 'page' && /extensions/.test(x.url || ''));
    if (t && t.webSocketDebuggerUrl) { tab = t; break; }
  }
  if (!tab) { console.log('chrome://extensions 未就绪'); return; }

  const p = await attach(tab.webSocketDebuggerUrl);
  await p.send('Runtime.enable', {});
  await sleep(3500);

  const DUMP = `(() => {
    function deep(root, out, depth) {
      out = out || []; depth = depth || 0;
      var els = root.querySelectorAll('*');
      for (var i = 0; i < els.length; i++) {
        var e = els[i];
        out.push({
          d: depth, tag: e.tagName, id: e.id || '',
          type: e.getAttribute && e.getAttribute('type') || '',
          txt: (e.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40)
        });
        if (e.shadowRoot) deep(e.shadowRoot, out, depth + 1);
      }
      return out;
    }
    var mgr = document.querySelector('extensions-manager');
    if (!mgr) return { err: 'no-manager' };
    var all = [];
    deep(document, all, 0);
    var btns = all.filter(function (x) {
      return /button|menu-item|cr-button/i.test(x.tag) && (x.id || x.type === 'icon-button');
    });
    return {
      total: all.length,
      buttons: btns.slice(0, 80),
      keywordHits: all.filter(function (x) { return /采集助手|XianYuHelper/.test(x.txt); }).slice(0, 12)
    };
  })()`;

  const r = p.val(await p.send('Runtime.evaluate', { expression: DUMP, returnByValue: true }));
  if (!r || r.err) { console.log('结构读取失败：' + JSON.stringify(r)); }
  else {
    console.log('节点总数：' + r.total);
    console.log('\n== 按钮类节点 ==');
    (r.buttons || []).forEach((b) => console.log('  '.repeat(b.d) + '<' + b.tag + (b.id ? ' id=' + b.id : '') + (b.type ? ' type=' + b.type : '') + '> ' + b.txt));
    console.log('\n== 命中「采集助手/ XianYuHelper」的节点 ==');
    (r.keywordHits || []).forEach((b) => console.log('  '.repeat(b.d) + '<' + b.tag + (b.id ? ' id=' + b.id : '') + '> ' + b.txt));
  }
  p.close();
  await http('/json/close/' + tab.id, 'GET');
})().catch((e) => { console.error('ERR', e && e.message || e); process.exit(1); });
