/**
 * 一次性探针：dump 整店页单个商品卡片的完整 outerHTML。
 *
 *   node tools/dump-card.js
 *
 * 已知：商品卡片是 inline-style div，无 class 无 id；标题/价格/销量在内联文本里。
 * 本探针把一张卡片完整打印出来，找商品 ID 到底藏在哪
 * （候选：data-* 属性、onclick、图片 ibank URL 里的数字、标题周围节点）。
 */
'use strict';

const PORT = Number(process.env.CDP_PORT || 9222);
const URL_ = process.argv[2] ||
  'https://shop3653158894s77.1688.com/page/offerlist.htm';
const WAIT = Number(process.argv[3] || 9000);

function http(port, p, method) {
  return new Promise((resolve, reject) => {
    const req = require('http').request(
      { host: '127.0.0.1', port, path: p, method: method || 'GET', timeout: 15000 },
      (res) => {
        let b = [];
        res.on('data', (d) => b.push(d));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(b).toString())); }
          catch (e) { resolve({}); }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('CDP 无响应')));
    req.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const created = await http(PORT, '/json/new?' + encodeURIComponent(URL_), 'PUT');
  const wantId = created.id || created.targetId;
  let tab = null;
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    const list = await http(PORT, '/json/list');
    tab = list.find((t) => t.id === wantId && t.type === 'page');
    if (tab && tab.webSocketDebuggerUrl && /offerlist/.test(tab.url || '')) break;
  }
  if (!tab) throw new Error('标签未就绪');

  const ws = new globalThis.WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('ws 连接失败（检查 http_proxy）')));
  });
  let id = 0;
  const waiters = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id != null && waiters.has(m.id)) {
      const w = waiters.get(m.id); waiters.delete(m.id);
      m.error ? w.reject(new Error(JSON.stringify(m.error))) : w.resolve(m.result);
    }
  });
  const send = (method, params) => {
    const i = ++id;
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
    return new Promise((resolve, reject) => waiters.set(i, { resolve, reject }));
  };

  await sleep(WAIT);

  const steps = [
    ['完整卡片HTML', `(() => {
      // 商品卡片 = 含 img.main-picture 的 inline-block 容器
      var pics = [].slice.call(document.querySelectorAll('img.main-picture'));
      for (var i = 0; i < pics.length; i++) {
        var el = pics[i], d = 0;
        while (el && d < 5) {
          if (/inline-block/.test(el.getAttribute('style') || '')) break;
          el = el.parentElement; d++;
        }
        if (el) return { found: true, full: el.outerHTML, text: el.innerText };
      }
      return { found: false };
    })()`],

    ['卡片内属性扫描', `(() => {
      var pics = [].slice.call(document.querySelectorAll('img.main-picture'));
      var out = [];
      for (var i = 0; i < pics.length && i < 3; i++) {
        var el = pics[i], d = 0;
        while (el && d < 5) {
          if (/inline-block/.test(el.getAttribute('style') || '')) break;
          el = el.parentElement; d++;
        }
        if (!el) continue;
        var attrs = [];
        for (var j = 0; j < el.attributes.length; j++) {
          var a = el.attributes[j];
          attrs.push(a.name + '=' + String(a.value).slice(0, 120));
        }
        var inner = [];
        el.querySelectorAll('*').forEach(function (c) {
          for (var k = 0; k < c.attributes.length; k++) {
            var n = c.attributes[k].name;
            if (/data-|onclick|href|id=/i.test(n)) {
              inner.push(c.tagName + '[' + n + '=' + String(c.attributes[k].value).slice(0, 90) + ']');
            }
          }
        });
        out.push({ outerAttrs: attrs, innerAttrs: inner.slice(0, 20) });
      }
      return out;
    })()`],

    ['抽取器验证', `(() => {
      // 按「含 main-picture 的 inline-block 容器」抽取前 10 张卡
      var cards = [];
      var pics = [].slice.call(document.querySelectorAll('img.main-picture'));
      for (var i = 0; i < pics.length; i++) {
        var el = pics[i], d = 0;
        while (el && d < 5) {
          if (/inline-block/.test(el.getAttribute('style') || '')) break;
          el = el.parentElement; d++;
        }
        if (el) cards.push(el);
      }
      var seen = {}, uniq = [];
      cards.forEach(function (c) { if (!seen[c.id + c.innerHTML.length]) { seen[c.id + c.innerHTML.length] = 1; uniq.push(c); } });
      return uniq.slice(0, 10).map(function (c) {
        var t = String(c.innerText || '').replace(/\\s+/g, ' ').trim();
        var pm = c.querySelector('img.main-picture');
        var src = pm ? (pm.getAttribute('src') || '') : '';
        var m = src.match(/!!(\\d{6,20})/);
        return { text: t.slice(0, 90), imgSrc: src.slice(0, 80), idFromImg: m ? m[1] : '' };
      });
    })()`]
  ];

  for (const [name, expr] of steps) {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      console.log('\n### ' + name + ' 异常: ' + ((r.exceptionDetails.exception || {}).description || '?').split('\n')[0]);
      continue;
    }
    console.log('\n===== ' + name + ' =====');
    console.log(JSON.stringify(r.result.value, null, 1));
  }

  ws.close();
  await http(PORT, '/json/close/' + tab.id);
  console.log('\n探针标签已关闭');
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
