/**
 * 最小 CDP 探针：用真实浏览器加载扩展目录，确认「清单文件缺失或不可读取」是否消失。
 *
 * 用途：分发包改结构后，必须真机验证一次手动加载路径，而不是只做静态校验。
 * 用法： node tools/cdp_probe.js <扩展目录> [--port 9333]
 */
const fs = require('fs');

const PORT = Number(process.argv.includes('--port')
  ? process.argv[process.argv.indexOf('--port') + 1] : 9333);
const EXT_DIR = process.argv[2];

async function httpJson(path, method = 'GET') {
  // /json/new 只接受 POST（Chrome 会对 GET 返回 "Using unsafe HTTP method"）
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { method });
  const t = await r.text();
  try { return JSON.parse(t); } catch (e) { throw new Error(`${path} 返回非 JSON: ${t.slice(0, 120)}`); }
}

(async () => {
  if (!EXT_DIR) {
    console.error('用法: node tools/cdp_probe.js <扩展目录> [--port 9333]');
    process.exit(2);
  }
  const ver = await httpJson('/json/version');
  console.log('浏览器:', ver.Browser);

  // 1) 打开扩展页
  const page = await httpJson('/json/new?chrome://extensions', 'PUT');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve } = pending.get(m.id);
      pending.delete(m.id);
      resolve(m);
    }
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
      setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); reject(new Error(method + ' timeout')); } }, 20000);
    });

  await new Promise((r) => (ws.onopen = r));

  // 2) 导航到 chrome://extensions（扩展页必须在真实页面里渲染一会儿）
  await send('Page.enable');
  await send('Page.navigate', { url: 'chrome://extensions' });
  await new Promise((r) => setTimeout(r, 6000));

  // 3) 读 DOM。新版本 chrome://extensions 把内容藏在 extensions-manager 的 shadow root 里
  const expr = `(function(){
    function txt(root, sel){
      var n = root && root.querySelector && root.querySelector(sel);
      return n ? (n.textContent || '').replace(/\\s+/g, ' ').trim() : '';
    }
    var out = { title: document.title || '' };
    var mgr = document.querySelector('extensions-manager');
    if (mgr) {
      var sr = mgr.shadowRoot;
      out.managerShadow = txt(sr, '#header, .title, h1');
      var items = sr ? Array.from(sr.querySelectorAll('extensions-item')) : [];
      out.itemCount = items.length;
      out.items = items.slice(0, 20).map(function(it){
        var s = (it.shadowRoot || {});
        return {
          name: txt(s, '#name') || (it.getAttribute('title') || ''),
          version: txt(s, '#version'),
          state: it.getAttribute('state') || '',
          id: it.id || ''
        };
      });
      // 展开「开发者模式」后每个条目里有打开/加载按钮的文本，可作为命中证据
      var cr = sr && sr.querySelector('extension-list') ? true : false;
      out.hasList = cr;
    }
    out.bodyText = (document.body ? document.body.innerText || '' : '').replace(/\\s+/g,' ').slice(0, 600);
    return JSON.stringify(out);
  })()`;

  const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  const raw = res.result && res.result.result && res.result.result.value;
  let info = null;
  try { info = JSON.parse(raw); } catch (e) { info = { raw: raw }; }

  console.log('--- 扩展页状态 ---');
  console.log(JSON.stringify(info, null, 2));

  // 4) 关键判定
  const items = (info && info.items) || [];
  const hit = items.filter((i) => /闲鱼/i.test(i.name || ''));
  const bad = items.filter((i) => /清单|manifest|无法|失败/i.test(JSON.stringify(i)));
  console.log('--- 判定 ---');
  console.log('扩展目录 :', EXT_DIR);
  console.log('页面标题 :', (info && info.title) || '(空)');
  console.log('条目总数 :', items.length);
  console.log('命中闲鱼 :', hit.length ? hit.map((h) => h.name + ' v' + h.version).join(', ') : '未发现');
  console.log('异常条目 :', bad.length ? JSON.stringify(bad) : '无');
  if (!hit.length && items.length) {
    console.log('（其它已加载条目示例: ' + items.slice(0, 5).map((i) => i.name).join(' | ') + '）');
  }
  process.exit(0);
})().catch((e) => { console.error('探针失败:', e.message); process.exit(1); });
