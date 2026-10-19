/**
 * 找出「浏览器里真正装着的那份多站点商品采集助手」是哪个扩展 ID。
 *
 * 背景：磁盘源码已改成双分支 linkSel，但页面里跑的还是单分支，
 * 说明 C:/Users/Public/XianYuHelper 里的那份根本没被浏览器加载。
 * 硬编码的 ID 可能是早前某次安装留下的旧记录。
 *
 * 办法：从 profile 的 Preferences / Secure Preferences 里把所有扩展 ID 抠出来，
 * 逐个打开 chrome-extension://<id>/manifest.json 读名字，认出我们那份。
 */
'use strict';

const fs = require('fs');
const PORT = Number(process.env.CDP_PORT || 9222);
const PROFILE = process.env.CHROME_PROFILE || 'D:/work/xydebug-profile';

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
  return { send, val: (r) => (r && r.result && r.result.value !== undefined ? r.result.value : undefined), close: () => ws.close() };
}

/** 抠出 profile 里记录过的所有扩展 ID */
function collectIds() {
  const ids = new Set();
  ['Default/Preferences', 'Default/Secure Preferences'].forEach((f) => {
    const p = PROFILE + '/' + f;
    if (!fs.existsSync(p)) return;
    const txt = fs.readFileSync(p, 'utf8');
    let re = /(?:"extensions":\{"settings":\{|,)"?([a-z]{32})"?:\{/g, m;
    while ((m = re.exec(txt))) ids.add(m[1]);
    re = /\b([a-z]{32})\b/g;
    while ((m = re.exec(txt))) ids.add(m[1]);
  });
  return [...ids];
}

async function readManifest(id) {
  const opened = await http('/json/new?' + encodeURI('chrome-extension://' + id + '/manifest.json'), 'PUT');
  const target = opened.id || opened.targetId;
  let tab = null;
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    const l = await http('/json/list');
    const t = l.find((x) => x.id === target && x.type === 'page');
    if (t && t.webSocketDebuggerUrl) { tab = t; break; }
  }
  if (!tab) return null;
  const p = await attach(tab.webSocketDebuggerUrl);
  await p.send('Runtime.enable', {});
  await sleep(1800);
  const txt = p.val(await p.send('Runtime.evaluate', { expression: 'document.documentElement.textContent||""', returnByValue: true })) || '';
  p.close();
  await http('/json/close/' + tab.id, 'GET');
  const m = txt.match(/"name"\s*:\s*"([^"]+)"/) || txt.match(/name[\s\S]{0,40}?"?([^\s",]{3,40})"?\s*}/);
  return { ok: txt.indexOf('manifest_version') > -1 || /"version"/.test(txt), name: m ? m[1] : null, live: txt.length };
}

(async () => {
  const ids = collectIds();
  console.log('profile 里出现过的候选扩展 ID（' + ids.length + ' 个）：');
  ids.forEach((i) => console.log('  ' + i));
  console.log('');
  for (const id of ids) {
    const r = await readManifest(id);
    if (!r) { console.log(id + '  -> 打不开'); continue; }
    const ours = /采集|XianYu|闲鱼|多站点/.test(r.name || '');
    console.log(id + '  -> ' + (r.name || '(无名字)') + (ours ? '   <<<< 这就是我们那份' : ''));
  }
})().catch((e) => { console.error('ERR', e && e.message || e); process.exit(1); });
