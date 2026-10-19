/**
 * 端到端验收
 * 用无头 Edge（Chrome 137+ 已移除 --load-extension，只能靠 Edge/Chromium）加载本扩展，
 * 打开闲鱼商品页，检查：内容脚本是否注入 / 悬浮面板是否出现 / 是否抓到商品数据，并截图。
 *
 * 用法：
 *   node tools/verify.js                       # 默认商品页
 *   node tools/verify.js "<商品URL>"           # 指定商品
 *   XY_HEADED=1 node tools/verify.js           # 用真实窗口（窗口移到屏幕外）
 */
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const EXT = process.env.XY_EXT || ROOT;
const PORT = 9333;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TARGET = process.argv[2] || 'https://www.goofish.com/item?id=1054899470781';
const HEADED = !!process.env.XY_HEADED;

const BROWSERS = [
  process.env.XY_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
].filter(Boolean);

const browserPath = BROWSERS.find((p) => fs.existsSync(p));
if (!browserPath) {
  console.error('未找到 Edge / Chrome');
  process.exit(1);
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xy-ext-verify-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function session(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      }
    };
    ws.onerror = () => reject(new Error('ws error'));
    ws.onopen = () =>
      resolve({
        send(method, params) {
          return new Promise((res, rej) => {
            const myId = ++id;
            pending.set(myId, { res, rej });
            ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
          });
        },
        close() { ws.close(); }
      });
  });
}

async function evalJs(sess, expression) {
  const r = await sess.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return '异常：' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description);
  return r.result && r.result.value;
}

const PROBE = `(() => {
  const panel = document.getElementById('xy-panel');
  let detail = null;
  try { detail = (window.__XY__ && window.__XY__.getDetail()) || null; } catch (e) {}
  return JSON.stringify({
    url: location.href,
    pageTitle: document.title,
    panelExists: !!panel,
    panelVisible: !!(panel && panel.offsetHeight > 0),
    panelText: panel ? panel.innerText.replace(/\\s+/g, ' ').slice(0, 260) : '',
    mainWorld: { util: typeof window.XYUtil, injected: typeof window.__XY__ },
    isolatedWorldInjected: document.documentElement.getAttribute('data-xy-bridge'),
    detail: detail ? {
      itemId: detail.itemId, title: detail.title, price: detail.price,
      images: (detail.images || []).length, seller: detail.sellerNick,
      desc: (detail.desc || '').slice(0, 50), source: detail.source
    } : null,
    cards: (window.__XY__ && window.__XY__.getCards ? window.__XY__.getCards().length : 0),
    cardSample: (window.__XY__ && window.__XY__.getCards ? window.__XY__.getCards().slice(0, 2) : []),
    bodyText: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 120)
  });
})()`;

(async () => {
  console.log('浏览器：', browserPath, HEADED ? '(可见窗口)' : '(无头)');
  console.log('加载扩展：', EXT);

  const args = [
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile,
    '--disable-extensions-except=' + EXT,
    '--load-extension=' + EXT,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--window-size=1440,900',
    '--window-position=-2400,-1400',
    'about:blank'
  ];
  if (!HEADED) args.unshift('--headless=new');
  const proc = spawn(browserPath, args, { stdio: 'ignore' });

  let version = null;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    try {
      version = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json());
      break;
    } catch (e) {}
  }
  if (!version) {
    console.error('浏览器启动失败');
    proc.kill();
    process.exit(1);
  }
  console.log('版本：', version['Browser']);

  // 扩展是否加载
  try {
    const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
    const ids = [...new Set(list.map((t) => (t.url || '').match(/^chrome-extension:\/\/([a-p]+)/)).filter(Boolean).map((m) => m[1]))];
    console.log('已加载的扩展 ID：', ids.length ? ids.join(', ') : '（无）');
    if (!ids.length) console.log('提示：Chrome 137+ 官方版不支持命令行加载扩展，请用 Edge 或 Chromium。');
  } catch (e) {}

  // 新建空白页 -> 设置 UA -> 导航
  const tab = await fetch(`http://127.0.0.1:${PORT}/json/new`, { method: 'PUT' }).then((r) => r.json());
  const sess = await session(tab.webSocketDebuggerUrl);
  await sess.send('Page.enable');
  await sess.send('Runtime.enable');
  await sess.send('Network.enable');
  await sess.send('Network.setUserAgentOverride', {
    userAgent: UA,
    acceptLanguage: 'zh-CN,zh;q=0.9',
    platform: 'Win32'
  });

  console.log('\n打开页面：', TARGET);
  await sess.send('Page.navigate', { url: TARGET });

  console.log('等待页面与内容脚本…');
  for (let i = 0; i < 6; i++) {
    await sleep(5000);
    const st = await evalJs(sess, PROBE).catch(() => '?');
    let brief = st;
    try {
      const o = JSON.parse(st);
      brief = `panel=${o.panelExists} source=${o.detail ? o.detail.source : 'null'} imgs=${o.detail ? o.detail.images : 0}`;
      if (o.detail && o.detail.source === 'api' && o.panelVisible) break;
    } catch (e) {}
    console.log('  [' + (i + 1) * 5 + 's] ' + brief);
  }

  const result = await evalJs(sess, PROBE);
  console.log('\n===== 验收结果 =====');
  try {
    console.log(JSON.stringify(JSON.parse(result), null, 2));
  } catch (e) {
    console.log(result);
  }

  // 截图存档
  try {
    const shot = await sess.send('Page.captureScreenshot', { format: 'png' });
    const outDir = path.join(ROOT, 'dist');
    fs.mkdirSync(outDir, { recursive: true });
    const shotPath = path.join(outDir, 'verify-screenshot.png');
    fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
    console.log('\n截图已保存：' + shotPath);
  } catch (e) {
    console.log('截图失败：' + e.message);
  }

  sess.close();
  proc.kill();
  await sleep(800);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  console.log('\n验收结束');
})();
