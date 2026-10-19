/**
 * 检查页面里内容脚本看到的扩展 API 状态。
 * typeof chrome.runtime === 'undefined' 正是
 * 「Cannot read properties of undefined (reading 'sendMessage')」的成因。
 */
const CDP = require('./cdp.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const http = require('http');
  const getJson = (path) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: 9222, path, timeout: 8000 }, (res) => {
      let buf = [];
      res.on('data', (d) => buf.push(d));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(buf))); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.end();
  });

  const b = await CDP.connect(9222);
  const targets = await getJson('/json/list');
  console.log('当前 target 类型：', [...new Set(targets.map((t) => t.type))].join(', '));
  targets.filter((t) => t.type === 'service_worker').forEach((t) => console.log('  SW:', t.url));

  let page = null;
  for (let i = 0; i < 6 && !page; i++) {
    try { page = await b.attach(/1688\.com/); } catch (e) { await sleep(2500); }
  }
  if (!page) { console.log('没有开着的 1688 标签'); await b.close(); return; }

  const r = await page.evaluate(`try {
    return {
      hasChrome: typeof chrome,
      hasRuntime: (typeof chrome !== 'undefined') ? typeof chrome.runtime : 'n/a',
      rtId: (typeof chrome !== 'undefined' && chrome.runtime) ? chrome.runtime.id : '',
      sendMsg: (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) ? 'function' : (chrome.runtime ? 'undefined' : 'n/a'),
      lastErr: (typeof chrome !== 'undefined' && chrome.runtime) ? String(chrome.runtime.lastError || '') : ''
    };
  } catch (e) { return { err: String(e) }; }`);
  console.log('chrome API 状态:', JSON.stringify(r, null, 2));

  await b.close();
})();
