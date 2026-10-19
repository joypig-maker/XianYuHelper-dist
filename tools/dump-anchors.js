/**
 * 整店页卡片锚点探测。
 *
 * 目的：给 attachOne 找一个在整店页上依然可用的定位路径。
 * 已知整店页卡片是 inline-style div，无 class / id / data-* / href / onclick。
 * 所以只能从「卡片内部还剩下什么」切入。
 *
 * 用多段短 evaluate 分批取数——单次超长表达式在 CDP 下会返回
 * result.type='undefined'，排查过，不如拆开稳。
 *
 * 用法： node tools/dump-anchors.js
 */
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

(async () => {
  const tabs = await httpJson('/json/list');
  const tab = tabs.find((t) => t.type === 'page' && /offerlist/.test(t.url || ''));
  if (!tab) { console.log('没有 offerlist 标签'); process.exit(1); }
  console.log('标签:', String(tab.url).slice(0, 78));

  const ws = new globalThis.WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r) => { ws.addEventListener('open', r); ws.addEventListener('error', () => r(new Error('ws'))); });

  let n = 0;
  const w = new Map();
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
    if (m.id != null && w.has(m.id)) { const f = w.get(m.id); w.delete(m.id); f(m); }
  });
  function ev(expr) {
    const id = ++n;
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
    return new Promise((res) => w.set(id, res));
  }
  // CDP 返回是 {id, result:{result:{type,value}}} —— 取值要穿两层 result
  async function pick(expr) {
    const r = await ev(expr);
    if (r.exceptionDetails) return 'ERR: ' + String((r.exceptionDetails.exception || {}).description || '').split('\n')[0].slice(0, 160);
    if (!r || !r.result) return '(无 result) ' + JSON.stringify(r).slice(0, 200);
    const inner = r.result.result || {};
    if (inner.value === undefined) return '(undefined) type=' + inner.type;
    return inner.value;
  }

  console.log('\n===== 1. 主图形态与祖先链 =====');
  console.log(await pick(
    'JSON.stringify([].slice.call(document.querySelectorAll(".main-picture")).slice(0,3).map(function(img){' +
    'var chain=[],x=img;for(var i=0;i<5&&x&&x!==document.body;i++){chain.push(x.tagName.toLowerCase()+' +
    '+(x.getAttribute("id")?"#"+x.getAttribute("id"):"")+' +
    '+(typeof x.className==="string"&&x.className?".":(typeof x.className==="object"?"[classObj]":""))+' +
    '+(x.getAttribute("style")?"{style}":"")+(x.getAttribute("id")?"[id]":""));x=x.parentElement;}' +
    'return{src:img.getAttribute("src"),alt:img.getAttribute("alt"),chain:chain.join(" < ")}}),null,1)'
  ));

  console.log('\n===== 2. 主图完整 src（前5张，看是否与原图同构） =====');
  console.log(await pick(
    'JSON.stringify([].slice.call(document.querySelectorAll(".main-picture")).slice(0,5)' +
    '.map(function(i){return i.getAttribute("src")}))'
  ));

  console.log('\n===== 3. 所有 img 中含 ibank 的（看压缩后缀差异） =====');
  console.log(await pick(
    'JSON.stringify([].slice.call(document.querySelectorAll("img")).filter(function(i){' +
    'return /ibank/.test(i.src||"")}).slice(0,6).map(function(i){return i.getAttribute("src")}),null,1)'
  ));

  console.log('\n===== 4. 页面文本前 40 行（看标题/价格/销量排布） =====');
  console.log(await pick(
    'JSON.stringify((document.body.innerText||"").split(/\\n+/).map(function(s){return s.trim()})' +
    '.filter(Boolean).slice(0,40))'
  ));

  console.log('\n===== 5. 文本里含 "¥" 的行 =====');
  console.log(await pick(
    'JSON.stringify((document.body.innerText||"").split(/\\n+/).map(function(s){return s.trim()})' +
    '.filter(function(s){return /¥|\\u5143/.test(s)}).slice(0,15))'
  ));

  console.log('\n===== 6. 卡片容器候选：含 main-picture 的最近公共祖先层级 =====');
  console.log(await pick(
    'JSON.stringify([].slice.call(document.querySelectorAll(".main-picture")).slice(0,3).map(function(img){' +
    'var x=img,dep=0;while(x&&x!==document.body&&dep<4){x=x.parentElement;dep++;}return{depth:dep,' +
    'tag:x?x.tagName.toLowerCase():"?",id:x?(x.getAttribute("id")||""):"",cls:x?(x.className||""):"",' +
    'styleAttr:x?(x.getAttribute("style")||"").slice(0,60):""}}),null,1)'
  ));

  ws.close();
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
