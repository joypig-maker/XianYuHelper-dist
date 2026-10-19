/**
 * 一次性探针：整店页商品区域 DOM 结构解剖。
 *
 *   node tools/dump-offerlist-dom.js
 *
 * 背景：整店页（offerlist.htm）页面文本里有 10 件商品（标题/价格/销量齐全），
 * 但 DOM 里 <a> 数为 0（没有任何商品链接），扩展因此报「商品数 0」。
 * 本探针从 .main-picture 主图出发一路往上爬祖先链，定位真正的商品卡片容器。
 * 注意：不要用 TreeWalker + SEED 文本，evaluate 里转义容易炸。
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
    // 1) 从主图往上爬 6 层祖先
    ['祖先链(主图出发)', `(() => {
      var img = document.querySelector('img.main-picture');
      if (!img) return { found: false };
      var chain = [], el = img;
      for (var d = 0; d < 6 && el; d++) {
        chain.push({
          tag: el.tagName,
          cls: String(el.className || '').slice(0, 100),
          id: el.id || '',
          kids: el.children.length,
          txt: String(el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 160),
          html: el.outerHTML.slice(0, 700)
        });
        el = el.parentElement;
      }
      return { found: true, chain: chain };
    })()`],

    // 2) 页面里带 data-* 属性、值看起来像商品 id 的元素
    ['商品ID线索', `(() => {
      var out = [];
      var all = document.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var e = all[i];
        for (var j = 0; j < e.attributes.length; j++) {
          var a = e.attributes[j];
          if (/^(data-)?(offer|item|product|sku|id|basket)/i.test(a.name || '')
              && /^\\d{6,20}$/.test(String(a.value || '').trim())) {
            out.push({ tag: e.tagName, attr: a.name, val: a.value, cls: String(e.className || '').slice(0, 60) });
            break;
          }
        }
      }
      return { count: out.length, sample: out.slice(0, 14) };
    })()`],

    // 3) 内联大脚本里是否内嵌了商品 JSON
    ['内嵌JSON线索', `(() => {
      var hits = [];
      document.querySelectorAll('script').forEach(function (x) {
        var t = x.textContent || '';
        if (t.length < 500) return;
        var m = t.match(/"(?:offerId|itemId|id)["\\s]*[:=]\\s*["']?(\\d{8,20})/g);
        if (m && m.length) {
          hits.push({ type: 'inline', len: t.length, keys: m.slice(0, 6), joined: m.join(' | ').slice(0, 260) });
        }
        if (/__INITIAL|__DATA__|window\\.__/.test(t)) hits.push({ type: 'marker', len: t.length, snippet: t.slice(0, 200) });
      });
      return hits.slice(0, 8);
    })()`],

    // 4) 数字区间里最大的图片容器（商品列表容器候选）
    ['商品列表容器', `(() => {
      var best = null;
      document.querySelectorAll('div').forEach(function (d) {
        var n = d.querySelectorAll('img').length;
        if (n >= 8 && d.innerText && d.innerText.indexOf('已售') > -1) {
          if (!best || n > best.n) best = { n: n, el: d };
        }
      });
      if (!best) return { found: false };
      return {
        found: true,
        imgCount: best.n,
        cls: String(best.el.className || '').slice(0, 120),
        id: best.el.id || '',
        html: best.el.outerHTML.slice(0, 1500)
      };
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
