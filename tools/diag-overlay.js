/**
 * 诊断 1688 页面上的浮层与勾选框现状
 *
 *   node tools/diag-overlay.js [--tabs] [--save out.json]
 *
 * 遍历浏览器里所有 1688 / 闲鱼标签，对每一个报出：
 *   - 内容脚本是否注入（XYSites / __XY_BRIDGE__ 是否就位）
 *   - 浮层面板 #xy-panel 是否存在 / 是否可见
 *   - 页面内复选框 .xy-check 挂了几个
 *   - cardSel / linkSel 能命中几个卡片节点
 *   - 面板 body 里实际渲染了什么（纯文本前 160 字）
 *
 * 只读，不导航、不发请求。
 */
'use strict';
const fs = require('fs');
const PORT = Number(process.env.CDP_PORT || 9222);

function httpJson(port, p) {
  return new Promise((resolve, reject) => {
    const req = require('http').request(
      { host: '127.0.0.1', port, path: p, timeout: 8000 },
      (res) => {
        let b = [];
        res.on('data', (d) => b.push(d));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(b).toString())); }
          catch (e) { reject(new Error('非 JSON: ' + Buffer.concat(b).slice(0, 120))); }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('CDP 无响应')));
    req.end();
  });
}

const EXPR = `
  var out = {};
  out.host = location.host;
  out.bridgeInjected = document.documentElement.getAttribute('data-xy-bridge') === '1';
  out.hasSites = typeof window.XYSites;
  var S = window.XYSites;
  var site = S ? S.current(location) : null;
  out.site = site ? site.key : null;
  var p = document.getElementById('xy-panel');
  out.panel = !!p;
  if (p) {
    var cs = getComputedStyle(p);
    out.panelVisible = cs.display !== 'none';
    var body = p.querySelector('.xy-body');
    out.panelText = body ? (body.innerText || '').replace(/\\s+/g, ' ').slice(0, 160) : '';
  }
  out.checks = document.querySelectorAll('.xy-check').length;
  out.checksOn = document.querySelectorAll('.xy-check.xy-check-on').length;
  var cards = (window.__XY__ && window.__XY__.getCards) ? window.__XY__.getCards() : [];
  out.cards = cards.length;
  if (site) {
    if (site.cardSel) {
      try { out.cardSelHit = document.querySelectorAll(site.cardSel).length; }
      catch (e) { out.cardSelHit = -1; }
    }
    if (site.linkSel && cards[0]) {
      try { out.linkSelHit = document.querySelectorAll(site.linkSel(cards[0].itemId)).length; }
      catch (e) { out.linkSelHit = -1; }
    }
    try {
      out.dataOfferHit = document.querySelectorAll('[data-offer-id]').length
        + document.querySelectorAll('[data-itemid]').length;
    } catch (e) { out.dataOfferHit = -1; }
  }
  return JSON.stringify(out);
`;

(async () => {
  if (!globalThis.WebSocket) throw new Error('当前 Node 无全局 WebSocket，需 22.4+');
  const wantAll = process.argv.includes('--tabs');
  const saveIdx = process.argv.indexOf('--save');
  const tabs = await httpJson(PORT, '/json/list');

  const results = [];
  for (const tab of tabs.filter((t) => t.type === 'page')) {
    const url = String(tab.url || '');
    if (!/1688\.com|goofish\.com|xianyu\.com/i.test(url)) continue;
    if (!wantAll && !/1688\.com/i.test(url)) continue;

    const rec = { url };
    const ws = new globalThis.WebSocket(tab.webSocketDebuggerUrl);
    try {
      await new Promise((res, rej) => {
        ws.addEventListener('open', res);
        ws.addEventListener('error', () => rej(new Error('ws 连接失败（多半被 http_proxy 拦截）')));
      });
      const send = (method, params) => {
        const id = ++send._id;
        ws.send(JSON.stringify({ id, method, params: params || {} }));
        return new Promise((resolve) => { send._w.set(id, resolve); });
      };
      send._id = 0;
      send._w = new Map();
      ws.addEventListener('message', (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id != null && send._w.has(m.id)) {
          const w = send._w.get(m.id); send._w.delete(m.id);
          m.error ? w({ __err: JSON.stringify(m.error).slice(0, 160) }) : w(m.result);
        }
      });
      const r = await send('Runtime.evaluate', {
        expression: '(()=>{' + EXPR + '})()', returnByValue: true
      });
      if (r.exceptionDetails) {
        rec.__err = String((r.exceptionDetails.exception || {}).description || '异常').split('\n')[0].slice(0, 160);
      } else {
        Object.assign(rec, JSON.parse(r.result.value));
      }
    } catch (e) {
      rec.__err = e.message;
    } finally {
      try { ws.close(); } catch (e) {}
    }
    results.push(rec);
  }

  results.forEach((r) => {
    console.log('─'.repeat(94));
    console.log('[' + String(r.site || '???').padEnd(7) + '] ' + String(r.url || '').slice(0, 74));
    console.log('  ' + (r.host || '').padEnd(40));
    if (r.__err) { console.log('    ERR: ' + r.__err); return; }
    console.log('  内容脚本   : ' + (r.bridgeInjected ? '已注入' : '未注入')
      + '   XYSites=' + r.hasSites
      + '   _XY_BRIDGE_=' + (r.hasBridge === undefined ? 'n/a' : r.hasBridge));
    console.log('  面板       : ' + (r.panel ? (r.panelVisible ? '已挂载/可见' : '已挂载/隐藏') : '未挂载')
      + (r.panel ? '   内容: ' + (r.panelText || '(空)') : ''));
    console.log('  页面复选框 : ' + r.checks + ' 个（已勾 ' + r.checksOn + '）');
    console.log('  抓到商品   : ' + r.cards
      + '   cardSel命中=' + (r.cardSelHit === undefined ? '-' : r.cardSelHit)
      + '  linkSel命中=' + (r.linkSelHit === undefined ? '-' : r.linkSelHit)
      + '  data-*命中=' + (r.dataOfferHit === undefined ? '-' : r.dataOfferHit));
  });

  if (saveIdx > -1 && process.argv[saveIdx + 1]) {
    fs.writeFileSync(process.argv[saveIdx + 1], JSON.stringify(results, null, 1));
    console.log('\n已存: ' + process.argv[saveIdx + 1]);
  }
})().catch((e) => { console.error('ERR ' + e.message); process.exit(1); });
