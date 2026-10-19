/**
 * 真实页面取数验证
 * 用无头 Chrome 打开闲鱼商品页，把 util.js + injected.js 以 document_start 注入，
 * 检查「接口拦截 / DOM 兜底」两种取数路径是否都能拿到数据，并输出页面 DOM 线索。
 *
 * 用法：node tools/probe-page.js [商品URL]
 */
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
];
const PORT = 9334;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TARGET = process.argv[2] || 'https://www.goofish.com/item?id=1054899470781';

const chromePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xy-probe-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 简易 CDP 会话：串行发消息 */
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

(async () => {
  console.log('Chrome：', chromePath);
  const proc = spawn(chromePath, [
    '--headless=new',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1440,900',
    'about:blank'
  ], { stdio: 'ignore' });

  let version = null;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    try {
      version = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json());
      break;
    } catch (e) {}
  }
  if (!version) { console.error('浏览器启动失败'); proc.kill(); process.exit(1); }
  console.log('浏览器：', version['Browser']);

  const tab = await fetch(`http://127.0.0.1:${PORT}/json/new`, { method: 'PUT' }).then((r) => r.json());
  const sess = await session(tab.webSocketDebuggerUrl);

  await sess.send('Page.enable');
  await sess.send('Runtime.enable');
  await sess.send('Network.enable');
  await sess.send('Network.setUserAgentOverride', { userAgent: UA });

  // 记录 mtop 请求，确认页面自己调了哪些接口
  const mtopApis = new Set();
  await sess.send('Network.setRequestInterception', { patterns: [] }).catch(() => {});

  const utilSrc = fs.readFileSync(path.join(ROOT, 'src/common/util.js'), 'utf8');
  const injSrc = fs.readFileSync(path.join(ROOT, 'src/content/injected.js'), 'utf8');
  await sess.send('Page.addScriptToEvaluateOnNewDocument', { source: utilSrc });
  await sess.send('Page.addScriptToEvaluateOnNewDocument', { source: injSrc });

  console.log('\n打开页面：', TARGET);
  await sess.send('Page.navigate', { url: TARGET });

  for (let i = 0; i < 10; i++) {
    await sleep(3000);
    const st = await evalJs(sess, `JSON.stringify({rs: document.readyState, imgs: document.querySelectorAll('img').length, xy: typeof window.__XY__})`);
    console.log('  [' + (i + 1) * 3 + 's]', st);
    if (st && st.indexOf('"xy":"object"') > -1 && st.indexOf('"rs":"complete"') > -1 && i >= 3) break;
  }

  const probe = `(() => {
    const q = (s) => document.querySelector(s);
    const detail = (window.__XY__ && window.__XY__.getDetail()) || null;
    const imgs = [...document.querySelectorAll('img')].map(i => i.currentSrc || i.src).filter(u => /alicdn/.test(u));
    return JSON.stringify({
      url: location.href,
      title: document.title,
      xyLoaded: typeof window.__XY__ === 'object',
      detail: detail ? {
        itemId: detail.itemId, title: detail.title, price: detail.price,
        images: (detail.images || []).length, seller: detail.sellerNick,
        desc: (detail.desc || '').slice(0, 60), source: detail.source
      } : null,
      dom: {
        aPersonal: (q('a[href*="personal?userId="]') || {}).textContent || null,
        aPersonalHref: (q('a[href*="personal?userId="]') || {}).getAttribute ? q('a[href*="personal?userId="]').getAttribute('href') : null,
        titleTagCount: document.querySelectorAll('[class*="title"],[class*="Title"]').length,
        priceEl: [...document.querySelectorAll('[class*="price"],[class*="Price"]')].slice(0,3).map(e => e.textContent.trim().slice(0,20)),
        alicdnImgs: imgs.length,
        bigImgs: imgs.filter(u => !/_\\d+x\\d+/.test(u)).length,
        imgSample: imgs.slice(0, 3),
        h1: (q('h1') || {}).textContent || null,
        bodyText: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 200)
      }
    });
  })()`;

  const result = await evalJs(sess, probe);
  console.log('\n===== 取数结果 =====');
  try { console.log(JSON.stringify(JSON.parse(result), null, 2)); } catch (e) { console.log(result); }

  sess.close();
  proc.kill();
  await sleep(800);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
})();
