/**
 * 真机验证：整店页能不能靠主图反查到卡片容器
 *
 * 不依赖扩展是否已重载，直接在真实页面里跑 findCardByImage 的等价逻辑：
 *   接口 offerList 的 imageURI  <- 抹掉 .310x310 尺寸后缀 ->  页面 <img src>
 * 报出命中率、以及命中后的卡片容器形态（ attachOne 要往容器里插复选框，
 * 容器必须是能 append 的普通元素）。
 *
 * 用法： node tools/verify-live-anchors.js
 */
'use strict';
const fs = require('fs');
const http = require('http');

const PORT = Number(process.env.CDP_PORT || 9222);
const DATA = process.argv[2] || 'dist/offerlist-2.json';

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

// 与 src/common/util.js 保持一致的指纹算法
function imageFingerprint(url) {
  var u = String(url == null ? '' : url).trim();
  if (!u) return '';
  u = u.replace(/^https?:\/\//i, '').replace(/^\/\//, '');
  var m = u.match(/[/]?img\/(?:ibank|imgextra|baoliaosm)\/([^?#]+)$/i);
  if (m) {
    return '/img/' + m[1]
      .replace(/\.(?:jpg|jpeg|png|webp)$/i, '')
      .replace(/\.\d+x\d+$/i, '')
      .replace(/_\d+x\d+(?:q\d+)?$/i, '')
      .toLowerCase();
  }
  return u.split('?')[0].split('#')[0].toLowerCase();
}

const EXPR = [
  'var srcs = [];',
  '[].slice.call(document.querySelectorAll("img")).forEach(function (i) {',
  '  var s = i.getAttribute("src"); if (s) srcs.push(s);',
  '});',
  'return JSON.stringify({ host: location.host, imgCount: srcs.length, srcs: srcs }, null, 1);'
].join('\n');

(async () => {
  const offers = (() => {
    const d = JSON.parse(fs.readFileSync(DATA, 'utf8'));
    const key = Object.keys(d).find((k) => /moduleasyncservice/.test(k));
    const j = JSON.parse(d[key]);
    return (j.data && j.data.content && j.data.content.offerList) || [];
  })();
  console.log('接口样本: ' + DATA + '  商品 ' + offers.length + ' 件');

  const tabs = await httpJson('/json/list');
  const tab = tabs.find((t) => t.type === 'page' && /offerlist/.test(t.url || ''));
  if (!tab) { console.log('没有 offerlist 标签'); process.exit(1); }
  console.log('标签: ' + String(tab.url).slice(0, 80));

  const ws = new globalThis.WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r) => { ws.addEventListener('open', r); ws.addEventListener('error', () => r(new Error('ws'))); });
  let n = 0; const w = new Map();
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
    if (m.id != null && w.has(m.id)) { const f = w.get(m.id); w.delete(m.id); f(m); }
  });
  const r = await new Promise((res) => {
    const id = ++n;
    // 多行语句 + return，必须用 IIFE 包住，否则 "Illegal return statement"
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: '(()=>{' + EXPR + '})()', returnByValue: true } }));
    w.set(id, res);
  });
  ws.close();
  if (r.exceptionDetails) { console.log('异常:', String((r.exceptionDetails.exception || {}).description || '').split('\n')[0]); process.exit(1); }
  const inner = (r && r.result && r.result.result) || {};
  if (inner.value === undefined) {
    console.log('无返回值，原始: ' + JSON.stringify(r).slice(0, 400));
    process.exit(1);
  }
  const page = JSON.parse(inner.value);

  const domFps = page.srcs.map(imageFingerprint);
  let hit = 0;
  const miss = [];
  const hitIdx = [];
  const dupSeen = {};
  offers.forEach((o, i) => {
    const im = o.offerImages && o.offerImages[0];
    const fp = imageFingerprint((im && im.imageURI) || '');
    const idx = domFps.indexOf(fp);
    if (idx > -1) {
      hit++;
      hitIdx.push(i);
      if (domFps.indexOf(fp, idx + 1) > -1) dupSeen[fp] = (dupSeen[fp] || 0) + 1;
    } else {
      miss.push(String(o.id) + ' (' + String(fp).slice(-28) + ')');
    }
  });

  console.log('\n页面 <img> 数: ' + page.imgCount);
  console.log('接口商品反查命中: ' + hit + '/' + offers.length);
  console.log('命中的是接口里的第几个: [' + hitIdx.join(', ') + ']');
  console.log('  （未命中的即是页面还没渲染到的，属懒加载，滚下去会补上）');
  if (miss.length) {
    console.log('未命中的区间: 第 ' + miss.length + ' 个起未渲染');
  }
  const dupCount = Object.keys(dupSeen).length;
  console.log('共用主图的商品: ' + dupCount + ' 组（findCardByImage 用顺序偏移兜住）');

  // 关键：命中后要能拿到一个可插复选框的容器
  console.log('\n检查命中的图片能否定位到可挂载容器:');
  const probe = [
    'var out = [];',
    '[].slice.call(document.querySelectorAll("img")).slice(0, 4).forEach(function (img) {',
    '  var x = img, d = 0, ok = false, cls = "";',
    '  while (x && x !== document.body && d < 6) {',
    '    if (x.tagName === "DIV" || x.tagName === "A" || x.tagName === "LI") { ok = true; cls = x.tagName.toLowerCase(); break; }',
    '    x = x.parentElement; d++;',
    '  }',
    '  out.push({ img: img.getAttribute("src"), container: cls, depth: d, mountable: ok });',
    '});',
    'return JSON.stringify(out, null, 1);'
  ].join('\n');

  const ws2 = new globalThis.WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r2) => { ws2.addEventListener('open', r2); });
  let n2 = 0; const w2 = new Map();
  ws2.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
    if (m.id != null && w2.has(m.id)) { const f = w2.get(m.id); w2.delete(m.id); f(m); }
  });
  const r2 = await new Promise((res) => {
    const id = ++n2;
    ws2.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: '(()=>{' + probe + '})()', returnByValue: true } }));
    w2.set(id, res);
  });
  ws2.close();
  const in2 = (r2 && r2.result && r2.result.result) || {};
  if (in2.value !== undefined) console.log(in2.value);
  else console.log('(容器探测失败)');

  process.exit(hit === offers.length ? 0 : 1);
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
