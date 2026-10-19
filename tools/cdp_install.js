/**
 * 真机验证「手动加载」路径：通过 CDP 的 chrome.developerPrivate 内部接口
 * 安装未打包扩展目录，再读回扩展列表，确认 Chrome 不再报「清单文件缺失或不可读取」。
 *
 * 为什么不直接用 --load-extension：Chrome 141+ 起该命令行开关在正式版被忽略
 * （日志：--load-extension is not allowed in Google Chrome, ignoring.），
 * 必须走 CDP 才能在没有 UI 交互的环境里真机验证。
 *
 * 用法：
 *   1) 后台启动 Chrome：chrome --remote-debugging-port=9333 --user-data-dir=... about:blank
 *   2) node tools/cdp_install.js <扩展目录> [--port 9333]
 */
const PORT = Number(process.argv.includes('--port')
  ? process.argv[process.argv.indexOf('--port') + 1] : 9333);
const EXT_DIR = process.argv[2];

(async () => {
  if (!EXT_DIR) {
    console.error('用法: node tools/cdp_install.js <扩展目录> [--port 9333]');
    process.exit(2);
  }
  const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  console.log('浏览器:', ver.Browser);

  const ws = new WebSocket(ver.webSocketDebuggerUrl); // browser-level endpoint
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
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); reject(new Error(method + ' timeout')); } }, 25000);
  });

  await new Promise((r) => (ws.onopen = r));

  // 开发者模式内部接口需要一次 auth token（任意值即可让 installUnpackedExtension 通过前置检查）
  try {
    await send('chrome.developerPrivate.addAuthToken', { token: 'cdp-probe' });
    console.log('[1/5] addAuthToken ok');
  } catch (e) {
    console.log('[1/5] addAuthToken 失败（不代表后续不可用）:', e.message);
  }

  process.chdir('/'); // 避免 C++ 层把相对路径当成相对当前工作目录
  const path = require('path');
  const abs = (p) => path.resolve(p).replace(/\\/g, '/');

  // [2/5] 对照组：故意放一个没有 manifest.json 的空壳目录，
  // 用它判断 installUnpackedExtension 的返回值到底可不可信。
  // （实测：Chrome 154 下假目录同样返回 SUCCESS，说明该接口只校验路径、不解析清单，
  //   所以任何"返回 SUCCESS 就是加载成功"的判定都是自欺欺人。）
  const fsx = require('fs');
  const ctrlDir = path.join(require('os').tmpdir(), 'cdp_ctrl_' + Date.now());
  fsx.mkdirSync(ctrlDir, { recursive: true });
  fsx.writeFileSync(path.join(ctrlDir, 'install.bat'), 'hello');
  const ctrl = await send('chrome.developerPrivate.installUnpackedExtension', { path: abs(ctrlDir) });
  const ctrlErr = ctrl.result && ctrl.result.error;
  const ctrlOk = !(ctrlErr && ctrlErr.uniqueType !== 'SUCCESS');
  console.log('[2/5] 对照（无 manifest 的空壳目录）→',
    ctrlOk ? '也被判 SUCCESS（该接口不解析清单，返回值不可作为通过依据）' : '被拒绝（该接口会校验）');
  fsx.rmSync(ctrlDir, { recursive: true, force: true });

  // [3/5] 正式安装
  const target = abs(EXT_DIR);
  console.log('[3/5] 安装未打包扩展:', target);
  const inst = await send('chrome.developerPrivate.installUnpackedExtension', { path: target });
  const err = inst.result && inst.result.error;
  const ok = !(err && err.uniqueType !== 'SUCCESS');
  if (!ok) {
    console.log('[NG] 安装被拒绝:', JSON.stringify(err));
    console.log('     → 这正是「清单文件缺失或不可读取」对应的失败点');
    process.exit(1);
  }
  console.log('[4/5] 安装调用返回 SUCCESS（需结合上面的对照判断）');

  await new Promise((r) => setTimeout(r, 3000));
  const list = await send('chrome.developerPrivate.getExtensionsInfo');
  const infos = (list.result && list.result.extensionsInfo) || [];
  const mine = infos.filter((i) => /闲鱼/.test(JSON.stringify(i)));
  console.log('[5/5] 已安装扩展数:', infos.length, '| 命中闲鱼:', mine.length);
  for (const m of mine) {
    console.log('   ·', m.name, 'v' + m.version, '| id=' + m.id, '| 状态:', m.state || m.status || '');
  }

  console.log('\n判定: ' + (ctrlOk
    ? '本接口不做清单校验，无法证明加载成功；请用 tools/verify_unpacked.py 做静态结构校验。'
    : (ok ? '接口真实校验了清单，扩展应已加载。' : '扩展未被接受。')));
  process.exit(0);
})().catch((e) => {
  console.error('失败:', e.message);
  console.error('若报 "not supported"，说明该 Chrome 版本未启用 developerPrivate（多半需要 dev/canary 通道）。');
  process.exit(1);
});
