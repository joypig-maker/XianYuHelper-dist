/**
 * 深挖详情页的视频封面 DOM，找视频地址落在哪
 *
 * 背景：1688 详情页有 li.video-image-cover / span.video-type-name，
 * 说明有视频位，但页面上没有 <video>，地址也不在 style 里。
 * 这个脚本把封面所在那一整块的 HTML 和全部属性打出来。
 *
 * 用法： node tools/dump-video-dom.js [--url <详情页URL>]
 */
'use strict';
const http = require('http');

const PORT = Number(process.env.CDP_PORT || 9222);

function httpJson(p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, timeout: 8000 }, (res) => {
      let b = [];
      res.on('data', (d) => b.push(d));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(b).toString())); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.end();
  });
}

const EXPR = `(function () {
  var out = { host: location.host, found: false };
  var li = document.querySelector('li.video-image-cover');
  if (li) {
    out.found = true;
    out.attrs = {};
    for (var i = 0; i < li.attributes.length; i++) {
      out.attrs[li.attributes[i].name] = String(li.attributes[i].value).slice(0, 140);
    }
    out.outerHTML = li.outerHTML.slice(0, 800);
    var p = li.parentElement;
    if (p) {
      out.parentTag = p.tagName.toLowerCase() + '.' + String(p.className || '');
      out.parentHTML = p.outerHTML.slice(0, 600);
      // 父容器上的属性（视频地址常挂在这一层）
      out.parentAttrs = {};
      for (var j = 0; j < p.attributes.length; j++) {
        out.parentAttrs[p.attributes[j].name] = String(p.attributes[j].value).slice(0, 140);
      }
    }
  }
  // 页面上所有带 video / play 字样的元素
  var all = [];
  document.querySelectorAll('[class*=video],[class*=Video],[data-video],[data-videoid]').forEach(function (n) {
    if (all.length >= 14) return;
    all.push({
      tag: n.tagName.toLowerCase(),
      cls: String(n.className || '').slice(0, 70),
      attrs: [].slice.call(n.attributes).slice(0, 8).map(function (a) {
        return a.name + '=' + String(a.value).slice(0, 90);
      })
    });
  });
  out.videoish = all;
  return JSON.stringify(out, null, 1);
})()`;

(async () => {
  const tabs = await httpJson('/json/list');
  const idx = process.argv.indexOf('--url');
  const want = idx > -1 ? process.argv[idx + 1] : 'detail.1688.com/offer/';
  const tab = tabs.find((t) => t.type === 'page' && String(t.url || '').indexOf(want) > -1);
  if (!tab) { console.log('没有匹配的标签'); process.exit(1); }
  console.log('标签:', String(tab.url).slice(0, 90));

  const ws = new globalThis.WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r) => { ws.addEventListener('open', r); ws.addEventListener('error', () => r(new Error('ws'))); });

  let n = 0;
  const w = new Map();
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
    if (m.id != null && w.has(m.id)) { const f = w.get(m.id); w.delete(m.id); f(m); }
  });
  const r = await new Promise((res) => {
    const id = ++n;
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: EXPR, returnByValue: true } }));
    w.set(id, res);
  });
  ws.close();

  if (r.exceptionDetails) { console.log('异常:', String((r.exceptionDetails.exception || {}).description || '').split('\n')[0]); process.exit(1); }
  const inner = (r && r.result && r.result.result) || {};
  if (inner.value === undefined) { console.log('无返回值:', JSON.stringify(r).slice(0, 200)); process.exit(1); }
  console.log(inner.value);
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
