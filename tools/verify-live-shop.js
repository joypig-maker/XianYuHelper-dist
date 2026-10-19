/**
 * 真机验证：店铺页整店采集
 *
 *   node tools/verify-live-shop.js  [URL正则]
 *
 * 只读当前已打开的店铺页标签（不导航、不发请求），报出：
 * 插件版本、抓到几个商品、字段完整度。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const PORT = Number(process.env.CDP_PORT || 9222);

function httpJson(port, p) {
  return new Promise((resolve, reject) => {
    const req = require('http').request(
      { host: '127.0.0.1', port, path: p, timeout: 8000 },
      (res) => {
        let b = [];
        res.on('data', (d) => b.push(d));
        res.on('end', () => resolve(JSON.parse(Buffer.concat(b).toString())));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('CDP 无响应')));
    req.end();
  });
}

const EXPR = `
(function () {
  var XY = window.__XY__ || {};
  var cards = XY.getCards ? XY.getCards() : [];
  var bad = cards.filter(function (c) {
    return !c.itemId || !c.title || !c.price || !/^https?:/.test(c.image || '');
  });
  return {
    extVersion: XY.v || '(未读到)',
    host: location.host,
    shopRecognized: /^shop[\\w.-]*\\.1688\\.com$/i.test(location.host),
    count: cards.length,
    badCount: bad.length,
    needSku: cards.filter(function (c) { return !c.skus; }).length,
    sample: cards.slice(0, 5).map(function (c) {
      return {
        id: c.itemId,
        price: c.price,
        title: (c.title || '').slice(0, 24),
        img: (c.image || '').slice(0, 58),
        hasSku: !!c.skus,
        url: (c.url || '').slice(0, 52)
      };
    })
  };
})()
`;

(async () => {
  const pattern = process.argv[2] || 'shop[\\w.-]*\\.1688\\.com';
  const list = await httpJson(PORT, '/json/list');
  const tab = list.find((t) => t.type === 'page' && new RegExp(pattern).test(t.url || ''));
  if (!tab) {
    console.log('没有匹配的页面。现有标签：');
    list.filter((t) => t.type === 'page').forEach((t) => console.log('  ', (t.url || '').slice(0, 90)));
    return;
  }
  const ws = new globalThis.WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws 失败（多半是 http_proxy 干扰，先 unset 代理变量）'))); });
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
  const r = await send('Runtime.evaluate', { expression: EXPR, returnByValue: true });
  if (r.exceptionDetails) throw new Error(((r.exceptionDetails.exception || {}).description || '页面异常').split('\n')[0]);
  console.log('扩展版本 :', r.result.value.extVersion);
  console.log('店铺域名 :', r.result.value.host, r.result.value.shopRecognized ? '(已识别为店铺页)' : '(未识别)');
  console.log('抓到商品 :', r.result.value.count);
  console.log('字段残缺 :', r.result.value.badCount);
  console.log('缺规格表 :', r.result.value.needSku);
  console.log('样例：');
  (r.result.value.sample || []).forEach((s) => {
    console.log('  ' + s.id + '  ¥' + s.price + '  ' + s.title);
    console.log('      img: ' + s.img);
    console.log('      ' + s.url + (s.hasSku ? '  [有规格表]' : ''));
  });
  ws.close();
})().catch((e) => { console.error('ERR', e.message.split('\n')[0]); process.exit(1); });
