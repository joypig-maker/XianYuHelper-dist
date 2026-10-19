/**
 * 把 chrome://extensions 里已加载的扩展，从「项目内 dist 副本」换到「源码目录 C:\Users\Public\XianYuHelper」。
 *
 * 为什么要换：扩展一直是从 D:\work\闲鱼浏览器插件\dist\闲鱼助手-安装包-v1.2.5 加载的，
 * 那是构建时复制出去的一份副本。改 src/ 对它毫无影响——改完发现页面里跑的还是旧代码，
 * 查半天查不出所以然。换到源码目录后，cp -r src/. <target>/src/ 才真正生效。
 *
 * 难点：点「加载未打包的扩展程序」会弹系统文件选择框，CDP 默认管不了。
 * 解法是先 Page.setInterceptFileChooserDialog 打开拦截，再用 Page.handleFileChooser 直接喂路径。
 *
 * 用法：node tools/switch-ext-path.js [目标目录]     默认 C:\Users\Public\XianYuHelper
 */
'use strict';

const PORT = Number(process.env.CDP_PORT || 9222);
const DIR = process.argv[2] || 'C:\\Users\\Public\\XianYuHelper';

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

async function attach(wsUrl, onEvent) {
  const ws = new globalThis.WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('ws 失败'))); });
  let mid = 0; const w = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id != null && w.has(m.id)) { const k = w.get(m.id); w.delete(m.id); m.error ? k.rej(new Error(JSON.stringify(m.error))) : k.res(m.result); }
    else if (onEvent) onEvent(m.method, m.params);
  });
  const send = (method, params) => { const i = ++mid; ws.send(JSON.stringify({ id: i, method, params: params || {} })); return new Promise((res, rej) => w.set(i, { res, rej })); };
  return { send, close: () => ws.close() };
}

/** 在页面里执行一段表达式；失败时把真实异常文本打出来，不留 "Uncaught" 这种废话 */
function makeEval(p) {
  return async function ev(expr, tag) {
    let r;
    try { r = await p.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: false }); }
    catch (e) { console.log('  [' + (tag || 'eval') + '] 发送失败：' + e.message); return undefined; }
    if (!r || r.exceptionDetails) {
      const d = r && r.exceptionDetails;
      console.log('  [' + (tag || 'eval') + '] 异常：' + (d ? (d.exception && (d.exception.description || d.exception.value)) || d.text : '无返回'));
      return undefined;
    }
    return r.result ? r.result.value : undefined;
  };
}

/** 找出扩展卡片（含名字与版本）的那份文本 */
const CARD_DUMP = [
  '(() => {',
  '  function walk(root, out, d) {',
  '    out = out || []; d = d || 0;',
  '    var els = root.querySelectorAll("*");',
  '    for (var i = 0; i < els.length; i++) {',
  '      var e = els[i];',
  '      var t = (e.textContent || "").replace(/\\s+/g, " ").trim();',
  '      if (/采集助手/.test(t)) { out.push({ d: d, tag: e.tagName, id: e.id || "", txt: t.slice(0, 70) }); }',
  '      if (e.shadowRoot) walk(e.shadowRoot, out, d + 1);',
  '    }',
  '    return out;',
  '  }',
  '  var all = walk(document, [], 0);',
  '  var c = all.filter(function (x) { return x.id === "card"; })[0];',
  '  return c ? c.txt : JSON.stringify(all.slice(0, 6));',
  '})()'
].join('\n');

const CLICK = (sel) => '(() => { var b = document.querySelector(' + JSON.stringify(sel) + '); if (!b) return "not-found"; b.click(); return "clicked"; })()';

async function main() {
  const opened = await http('/json/new?' + encodeURI('chrome://extensions/'), 'PUT');
  const target = opened.id || opened.targetId;
  let tab = null;
  for (let i = 0; i < 25; i++) {
    await sleep(400);
    const l = await http('/json/list');
    const t = l.find((x) => x.id === target && x.type === 'page' && /extensions/.test(x.url || ''));
    if (t && t.webSocketDebuggerUrl) { tab = t; break; }
  }
  if (!tab) throw new Error('chrome://extensions 未就绪');

  let chooser = null;
  const p = await attach(tab.webSocketDebuggerUrl, (method, params) => { if (method === 'Page.fileChooserOpened') chooser = params; });
  const ev = makeEval(p);
  await p.send('Runtime.enable', {});
  await p.send('Page.enable', {});
  await p.send('Page.setInterceptFileChooserDialog', { enabled: true });
  await sleep(2500);

  console.log('换源前：' + (await ev(CARD_DUMP, 'before')));

  /* 1) 移除旧的（点完可能还会弹二次确认） */
  console.log('点移除：' + (await ev(CLICK('[id="removeButton"]'), 'remove')));
  await sleep(1800);
  console.log('点确认：' + (await ev([
    '(() => {',
    '  var els = document.querySelectorAll("*");',
    '  for (var k = 0; k < els.length; k++) {',
    '    var e = els[k];',
    '    var t = (e.textContent || "").trim();',
    '    if (/^(移除|删除|确认|移出|一定)/.test(t) && /BUTTON$/i.test(e.tagName) && e.offsetParent !== null) { e.click(); return "clicked:" + t.slice(0, 12); }',
    '  }',
    '  return "no-confirm-dialog";',
    '})()'
  ].join('\n'), 'confirm')));
  await sleep(2500);

  /* 2) 加载新目录 */
  console.log('点加载：' + (await ev(CLICK('[id="loadUnpacked"]'), 'load')));
  let ok = false;
  for (let i = 0; i < 30; i++) { if (chooser) { ok = true; break; } await sleep(300); }
  if (!ok) console.log('未拦到文件选择框');
  else {
    console.log('拦到选择框 mode=' + chooser.mode + '，喂入 ' + DIR);
    await p.send('Page.handleFileChooser', { mode: chooser.mode || 'open', files: [DIR] });
  }
  await sleep(4500);

  console.log('换源后：' + (await ev(CARD_DUMP, 'after')));
  p.close();
  await http('/json/close/' + tab.id, 'GET');
}

main().catch((e) => { console.error('ERR', e && e.message || e); process.exit(1); });
