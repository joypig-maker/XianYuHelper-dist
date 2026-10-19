/**
 * 在**真实 Chrome**里测分发源可达性 —— 模拟客户点「更新」时浏览器实际要走的请求。
 *
 * 为什么不能只用 curl：
 *   Chrome 走系统代理设置 / 自己的 DNS 缓存，和 curl 可能得出不同结果。
 *   而且会走的路径不止一个：update.xml（清单）→ crx（二进制），
 *   两段任意一段不通，更新就失败。
 *
 * 用法：node tools/check-cdn.js
 */
'use strict';
const CDP = require('./cdp');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 三个候选分发源（同一个 update.xml / crx，不同 CDN）
const SOURCES = [
  ['jsDelivr', 'https://cdn.jsdelivr.net/gh/joypig-maker/XianYuHelper-dist@main/XianYuHelper'],
  ['raw.githubusercontent', 'https://raw.githubusercontent.com/joypig-maker/XianYuHelper-dist/main/XianYuHelper']
];

(async () => {
  const b = await CDP.connect(9222);

  for (const [name, base] of SOURCES) {
    console.log('\n================ ' + name);
    console.log('  ' + base);

    for (const [what, file] of [['update.xml（清单）', 'update.xml'], ['crx（安装包）', 'XianYuHelper.crx']]) {
      const url = base + '/' + file;
      let page = null;
      try {
        page = await b.open('about:blank');
        // 记录这个页面发出的真实网络请求与响应
        const net = [];
        page.on('Network.responseReceived', (p) => {
          net.push({
            url: (p.response && p.response.url) || '',
            status: p.response && p.response.status,
            mime: p.response && p.response.mimeType,
            t: (p.response && p.response.timing) || null
          });
        });
        await page.send('Network.enable');

        // 用 XHR 取（能拿到状态码和真实字节数，又不触发下载弹窗）
        // 统一用 arraybuffer —— crx 是二进制，用 responseText 读长度会不准
        const r = await page.evaluate(`
          return new Promise(function (resolve) {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', ${JSON.stringify(url)}, true);
            xhr.responseType = 'arraybuffer';
            xhr.timeout = 25000;
            var done = false;
            function fin(o) { if (!done) { done = true; resolve(o); } }
            xhr.onload = function () {
              var buf = xhr.response;
              var bytes = buf ? buf.byteLength : 0;
              var head = '';
              try { head = new TextDecoder('utf-8').decode(buf.slice(0, 300)); } catch (e) {}
              fin({ ok: true, status: xhr.status,
                    type: xhr.getResponseHeader('content-type'),
                    bytes: bytes, head: head });
            };
            xhr.onerror = function () { fin({ ok: false, err: 'onerror（连接失败/被拦）' }); };
            xhr.ontimeout = function () { fin({ ok: false, err: '超时 25s' }); };
            try { xhr.send(); } catch (e) { fin({ ok: false, err: 'send 异常: ' + e.message }); }
          });
        `, true);

        const tag = r.ok ? '✓' : '✗';
        console.log('  ' + tag + ' ' + what);
        if (r.ok) {
          console.log('      状态=' + r.status + '  类型=' + r.type + '  字节=' + r.bytes);
          if (/xml/.test(file)) {
            console.log('      内容: ' + r.head.replace(/\s+/g, ' ').slice(0, 200));
          }
        } else {
          console.log('      失败: ' + r.err);
        }
      } catch (e) {
        console.log('  ✗ ' + what + ' —— ' + (e && e.message));
      } finally {
        if (page) { try { await page.close(); } catch (e) {} }
      }
      await sleep(400);
    }
  }

  await b.close();
})().catch((e) => { console.error('ERR', e && e.message); process.exit(1); });
