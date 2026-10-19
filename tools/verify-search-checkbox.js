/**
 * 验证关键词搜索页上的页面内复选框真的挂出来了
 *
 *   node tools/verify-search-checkbox.js [关键词]
 *
 * 流程：重载扩展 → 打开搜索页 → 数页面上的 .xy-check，
 * 并逐条核对复选框是否落在 210x358 的卡片本体 <a> 上
 * （而不是 20x20 的店铺聊天按钮），以及能否真的点在它上面。
 *
 * 扩展重载必须走 chrome-extension://<id>/src/popup/popup.html 页面里的
 * chrome.runtime.reload()——chrome://extensions 在 CDP 下拿不到 runtime。
 */
'use strict';

const PORT = Number(process.env.CDP_PORT || 9222);
const EXT_ID = 'lfpfjplffgpbmfekakcnjfekbllilcki';
const KEYWORD = process.argv[2] || '手机支架';
const WAIT = 15000;

function http(port, p, method) {
  return new Promise((resolve, reject) => {
    const req = require('http').request(
      { host: '127.0.0.1', port, path: p, method: method || 'GET', timeout: 20000 },
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

const URL_ = 'https://s.1688.com/selloffer/offer_search.htm?keywords=' +
  encodeURIComponent(KEYWORD) + '&n=8&sortField=0';

async function attach(wsUrl) {
  const ws = new globalThis.WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('ws 连接失败（检查 http_proxy）')));
  });
  let mid = 0;
  const waiters = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id != null && waiters.has(m.id)) {
      const w = waiters.get(m.id); waiters.delete(m.id);
      m.error ? w.reject(new Error(JSON.stringify(m.error))) : w.resolve(m.result);
    }
  });
  const send = (method, params) => {
    const i = ++mid;
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
    return new Promise((resolve, reject) => waiters.set(i, { resolve, reject }));
  };
  return {
    ws, send,
    valueOf: function (r) {
      if (!r) return undefined;
      if (r.result && r.result.value !== undefined) return r.result.value;
      if (r.result && r.result.result && r.result.result.value !== undefined) return r.result.result.value;
      if (r.exceptionDetails) return { __err: r.exceptionDetails.text || 'exception' };
      return undefined;
    }
  };
}

/** 在页面里数复选框，并判断它挂在哪种元素上 */
const CHECK_EXPR = `(() => {
  var checks = document.querySelectorAll('.xy-check');
  var rows = [];
  var i, c, r, host, hr;
  // 同时核对扩展里跑的到底是新代码：把 linkSel 原样打出来并不算数，
  // 要看它在这个页面上真能命中几个节点、命中的是不是 210x358 的卡片本体
  var S = window.XYSites && window.XYSites.current(location);
  var firstId = (window.__XY__ && (window.__XY__.getCards() || [])[0] || {}).itemId;
  var sel = (S && S.linkSel && firstId) ? S.linkSel(firstId) : '';
  var hit = sel ? document.querySelectorAll(sel) : [];
  var hitInfo = [];
  for (var k = 0; k < hit.length && k < 3; k++) {
    var hk = hit[k].getBoundingClientRect();
    hitInfo.push(hit[k].tagName + '|' + String(hit[k].className || '').slice(0, 40) +
      '|' + Math.round(hk.width) + 'x' + Math.round(hk.height));
  }
  for (i = 0; i < checks.length; i++) {
    c = checks[i];
    host = c.parentElement;
    hr = host ? host.getBoundingClientRect() : null;
    rows.push({
      id: c.getAttribute('data-xy-id'),
      hostTag: host ? host.tagName : '',
      hostCls: host ? String(host.className || '').slice(0, 55) : '',
      hostRect: hr ? Math.round(hr.width) + 'x' + Math.round(hr.height) : ''
    });
  }
  // 抽样点一个，确认真的能勾（点了会写进插件数据层，我们只能看视觉状态回弹）
  return {
    host: location.host,
    href: location.href.slice(0, 90),
    injected: !!window.__XY__,
    cards: window.__XY__ ? (window.__XY__.getCards() || []).length : -1,
    checks: checks.length,
    rows: rows.slice(0, 6),
    panel: !!document.querySelector('.xy-panel'),
    linkSel: sel,
    linkHit: hit.length,
    linkHitInfo: hitInfo
  };
})()`;

async function main() {
  /* 1) 重载扩展
   *
   * chrome.runtime.reload() 在这台机器上拿不到（popup 页里 chrome.runtime 是
   * undefined，chrome://extensions 在 CDP 下也拿不到），而 load 的解压目录
   * 改完代码不会自动生效，因此只能去 chrome://extensions 的 shadow DOM 里
   * 点那颗 #dev-reload-button。实测 Chrome 154 的卡片结构：
   *   extensions-manager > shadow #container > extensions-item-list
   *     > shadow > extensions-item > shadow > #dev-reload-button
   */
  const tabs = await http(PORT, '/json/list');
  let extTab = tabs.find((t) => t.type === 'page' && /^chrome:\/\/extensions/.test(t.url || ''));
  if (!extTab) {
    extTab = await http(PORT, '/json/new?' + encodeURIComponent('chrome://extensions/'), 'PUT');
    for (let i = 0; i < 30 && !(extTab.webSocketDebuggerUrl && extTab.url); i++) {
      await sleep(300);
      const l = await http(PORT, '/json/list');
      extTab = l.find((t) => t.type === 'page' && /^chrome:\/\/extensions/.test(t.url || ''));
    }
  }
  if (!extTab || !extTab.webSocketDebuggerUrl) throw new Error('找不到 chrome://extensions 标签');
  const p1 = await attach(extTab.webSocketDebuggerUrl);
  await p1.send('Runtime.enable', {});
  await sleep(800);
  const reloaded = p1.valueOf(await p1.send('Runtime.evaluate', {
    expression: `(() => {
      var mgr = document.querySelector('extensions-manager');
      if (!mgr || !mgr.shadowRoot) return 'no-manager';
      var list = mgr.shadowRoot.querySelector('extensions-item-list');
      if (!list) return 'no-item-list';
      function deep(root, el) {
        var nodes = root.querySelectorAll('*');
        for (var i = 0; i < nodes.length; i++) {
          if (el(nodes[i])) return nodes[i];
          if (nodes[i].shadowRoot) { var got = deep(nodes[i].shadowRoot, el); if (got) return got; }
        }
        return null;
      }
      var btn = deep(list.shadowRoot, function (e) {
        return e.id === 'dev-reload-button' || e.getAttribute('aria-label') === '重新加载';
      });
      if (!btn) return 'no-reload-button';
      try { btn.click(); return 'clicked:' + btn.id; } catch (e) { return 'ERR:' + e.message; }
    })()`,
    returnByValue: true
  }));
  console.log('扩展重载：' + JSON.stringify(reloaded));
  p1.ws.close();
  // 扩展重载会连带重建标签，等待期间不能开新标签，否则可能落在“重载前”的旧页面
  await sleep(9000);

  /* 2) 打开搜索页并等它渲染 */
  // 扩展重载会连带重建标签，/json/new 返回的目标可能在重载瞬间被换掉，
  // 所以必须确认目标标签的 URL 真的就是搜索页，否则验证等于在别的页面上做
  const created = await http(PORT, '/json/new?' + encodeURIComponent(URL_), 'PUT');
  const wantId = created.id || created.targetId;
  let tab = null;
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    const list = await http(PORT, '/json/list');
    tab = list.find((t) => t.id === wantId && t.type === 'page');
    if (tab && tab.webSocketDebuggerUrl && tab.url && /selloffer/.test(tab.url)) break;
    tab = null;
  }
  if (!tab) throw new Error('搜索页标签未就绪（目标ID ' + wantId + '，请确认是搜索页而不是别的页面）');
  console.log('目标标签：' + tab.url.slice(0, 80));
  const p2 = await attach(tab.webSocketDebuggerUrl);
  await p2.send('Runtime.enable', {});
  await sleep(WAIT);

  const res = p2.valueOf(await p2.send('Runtime.evaluate', {
    expression: CHECK_EXPR, returnByValue: true
  }));
  console.log('');
  console.log('地址        : ' + (res && res.href));
  console.log('注入脚本    : ' + (res && res.injected));
  console.log('浮层面板    : ' + (res && res.panel));
  console.log('插件抓到商品: ' + (res && res.cards) + ' 件');
  console.log('页面复选框  : ' + ((res && res.checks) || 0) + ' 个');
  console.log('搭在卡片上  : ' + JSON.stringify((res && res.rows) || []));
  console.log('linkSel     : ' + (res && res.linkSel));
  console.log('linkSel命中 : ' + (res && res.linkHit) + '  ' + JSON.stringify((res && res.linkHitInfo) || []));

  /* 3) 真点一次，看勾选态是否回弹 */
  if (res && res.checks > 0) {
    const clickRes = p2.valueOf(await p2.send('Runtime.evaluate', {
      expression: `(() => {
        var c = document.querySelector('.xy-check input[type=checkbox]');
        if (!c) return 'no-input';
        c.click();
        var on = c.checked;
        c.click();
        return { first: on, second: c.checked };
      })()`,
      returnByValue: true
    }));
    console.log('点一下      : ' + JSON.stringify(clickRes));
  }

  p2.ws.close();
  await http(PORT, '/json/close/' + tab.id);
}

main().catch((e) => { console.error('ERR', e && e.message || e); process.exit(1); });
