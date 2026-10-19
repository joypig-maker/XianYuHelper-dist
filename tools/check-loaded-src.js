/**
 * 把浏览器里「实际在服务」的扩展源码读出来看看是哪一代。
 *
 * 现象：磁盘上的 sites.js 已经是双分支 linkSel，但页面里跑的仍是单分支，
 * 说明扩展不是从 C:/Users/Public/XianYuHelper 加载的。
 * 本脚本直接打开 chrome-extension://<id>/src/common/sites.js，
 * 把扩展自己返回的文本抓下来，跟磁盘上的文件逐字比对——
 * 这是「浏览器里到底跑的是什么」的唯一直接证据，不靠任何推断。
 */
'use strict';

const PORT = Number(process.env.CDP_PORT || 9222);
const EXT_ID = 'lfpfjplffgpbmfekakcnjfekbllilcki';
const REL = process.argv[2] || 'src/common/sites.js';

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
  return { send, val: (r) => (r && r.result && r.result.value !== undefined ? r.result.value : (r && r.exceptionDetails ? { __err: r.exceptionDetails.text } : undefined)) };
}

async function main() {
  const url = 'chrome-extension://' + EXT_ID + '/' + REL;
  console.log('打算读取：' + url);

  const opened = await http('/json/new?' + encodeURI(url), 'PUT');
  const target = opened.id || opened.targetId;
  let tab = null;
  for (let i = 0; i < 25; i++) {
    await sleep(400);
    const l = await http('/json/list');
    const t = l.find((x) => x.id === target && x.type === 'page');
    if (t && t.webSocketDebuggerUrl) { tab = t; break; }
  }
  if (!tab) { console.log('目标页未就绪'); return; }

  const p = await attach(tab.webSocketDebuggerUrl);
  await p.send('Runtime.enable', {});
  await sleep(3000);

  const disk = require('fs').readFileSync('C:/Users/Public/XianYuHelper/' + REL, 'utf8');
  const live = p.val(await p.send('Runtime.evaluate', { expression: 'document.documentElement.textContent || ""', returnByValue: true }));

  if (!live || live.length < 50) { console.log('读不到页面文本，返回：' + JSON.stringify(live).slice(0, 300)); }

  const norm = (s) => String(s || '').replace(/\r\n/g, '\n');
  const a = norm(disk), b = norm(live);
  console.log('\n磁盘文件长度：' + a.length);
  console.log('浏览器返回长度：' + (b ? b.length : 0));
  console.log('内容一致：' + (a === b));

  const marker = 'offerId=\' + id';
  console.log('磁盘含双分支标记：' + a.indexOf('offerId=') > -1);
  console.log('浏览器含双分支标记：' + (b || '').indexOf('offerId=') > -1);

  if (a !== b && b) { console.log('\n首处差异：'); let i = 0; while (i < a.length && a[i] === b[i]) i++; console.log('  偏移 ' + i + '\n  磁盘: ...' + a.slice(Math.max(0, i - 60), i + 60) + '\n  线上: ...' + b.slice(Math.max(0, i - 60), i + 60)); }

  p.ws.close();
  await http('/json/close/' + tab.id, 'GET');
}

main().catch((e) => { console.error('ERR', e && e.message || e); process.exit(1); });
