/**
 * 把一份解压版扩展装进正在跑的调试实例。
 *
 * 只负责「加载」，复制目录交给调用方（用 python 的 shutil.copytree）：
 * node 的 fs.cpSync 在这个仓库上会直接把进程搞死（exit 127、没有任何输出），
 * 而 python 的 copytree 一直很稳。
 *
 * 为什么不复用同一个目录：对同一路径重复 loadUnpacked 之后，
 * 新页面就不再注入内容脚本了，必须换个干净目录。
 *
 * 用法：node tools/load-ext.js [扩展目录]     默认 dist/_ext_live
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// loadUnpacked 只认绝对路径，传相对路径会得到 "File path cannot be resolved."
const DIR = path.resolve(process.argv[2] || path.join(ROOT, 'dist', '_ext_live'));

async function rawCall(method, params) {
  const v = await (await fetch('http://127.0.0.1:9222/json/version')).json();
  const ws = new globalThis.WebSocket(v.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  return new Promise((resolve) => {
    const id = 1;
    const h = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === id) { ws.removeEventListener('message', h); ws.close(); resolve(m); }
    };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
    setTimeout(() => { try { ws.close(); } catch (e) {} resolve({ error: { message: '超时' } }); }, 15000);
  });
}

(async () => {
  if (!fs.existsSync(path.join(DIR, 'manifest.json'))) {
    console.error('不是扩展目录：' + DIR);
    process.exit(1);
  }
  const ver = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8')).version;
  console.log('加载目录: ' + DIR + '  (v' + ver + ')');

  const r = await rawCall('Extensions.loadUnpacked', { path: DIR.replace(/\\/g, '/') });
  if (r && r.result && r.result.id) {
    console.log('✓ 扩展已加载  id=' + r.result.id);
  } else {
    console.error('✗ 加载失败: ' + JSON.stringify(r));
    process.exit(1);
  }
})().catch((e) => { console.error('ERR', e && e.message); process.exit(1); });
