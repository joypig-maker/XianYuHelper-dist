/**
 * 主图视频探测：详情页 / 详情接口里到底有没有视频地址
 *
 * 对一个商品详情页，报出：
 *   - 页面上有没有 <video> 元素、src 是什么
 *   - 详情接口响应里有没有视频字段（video / viedo / movie / playback 等）
 *
 * 用法： node tools/probe-video.js [--url <详情页URL>]
 */
'use strict';
const http = require('http');

const PORT = Number(process.env.CDP_PORT || 9222);
const PORT_TARGET = process.env.CDP_PORT || 9222;

function httpJson(p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, timeout: 8000 }, (res) => {
      let b = [];
      res.on('data', (d) => b.push(d));
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(b).toString())); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.end();
  });
}

// 页面侧：找 <video> 及常见视频容器
const PAGE_EXPR = [
  'var out = {url: location.href, host: location.host};',
  'var vs = document.querySelectorAll("video");',
  'out.videoTags = vs.length;',
  'out.videoSrcs = [].slice.call(vs).slice(0, 5).map(function(v){',
  '  return {src: v.getAttribute("src") || "", poster: v.getAttribute("poster") || "",',
  '          dataSrc: v.getAttribute("data-src") || "",',
  '          srcset: (v.getAttribute("srcset") || "").slice(0, 120)};',
  '});',
  '// 常见「视频图层」容器：背景图是 mp4、或带 data-video 属性',
  'out.playLayer = [].slice.call(document.querySelectorAll(',
  '  \'[class*="video"],[class*="Video"],[data-video],[data-videosrc],[class*="play"][class*="video"]\')',
  ').slice(0, 5).map(function(n){return {tag: n.tagName.toLowerCase(),',
  '  cls: (n.className||"").toString().slice(0,60),',
  '  attrVideo: n.getAttribute("data-video") || n.getAttribute("data-src") || n.getAttribute("style") || ""};});',
  '// 页面上出现的 .mp4 / .m3u8 痕迹（含 style 背景、data-*）',
  'var mp4 = [];',
  'document.querySelectorAll("*").length && [].slice.call(document.querySelectorAll("[style],[data-src],[data-url],[data-original]")).forEach(function(n){',
  '  var s = (n.getAttribute("style")||"") + " " + (n.getAttribute("data-src")||"") + " " + (n.getAttribute("data-url")||"") + " " + (n.getAttribute("data-original")||"");',
  '  if (/.mp4|\\.m3u8|\\.mov/i.test(s) && mp4.length < 6) mp4.push(n.tagName.toLowerCase() + " :: " + s.slice(0, 140));',
  '});',
  'out.mp4Hits = mp4;',
  'return JSON.stringify(out, null, 1);'
].join('\n');

// 拦截详情接口响应，找视频字段
const PROBE_SCRIPT = `
(function () {
  var WANT = /video|viedo|movie|playback|media|\\\\.(mp4|m3u8|mov)(\\\\?|$)|descvideos|videos/i;
  window.__XY_VIDEO__ = [];
  function grab(name, text) {
    try {
      var hits = [];
      JSON.stringify(function () { return text; }) ;
      // 用正则扫原始文本里的视频字段，比解析结构更省事且不会漏
      var re = /["']([A-Za-z0-9_.:/.-]*(?:video|movie|playback|media)["']\\s*:\\s*["']([^"']{6,200})["'])/gi;
      var m;
      while ((m = re.exec(text)) !== null) {
        hits.push(m[1]);
        if (hits.length > 12) break;
      }
      var re2 = /["']([^"']*\\.(?:mp4|m3u8|mov)(?:[^"']{0,20}))["']/gi;
      while ((m = re2.exec(text)) !== null) {
        hits.push(m[0]);
        if (hits.length > 24) break;
      }
      if (hits.length) window.__XY_VIDEO__.push({ name: name, hits: hits.slice(0, 24) });
    } catch (e) {}
  }
  var OrigXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function () {
    var self = this;
    var url = '', method = '', body = '';
    this.open = function (m, u) { method = m; url = u; return OrigXHR.prototype.open.apply(self, arguments); };
    this.send = function (b) {
      body = b || '';
      return OrigXHR.prototype.send.apply(self, arguments);
    };
    var iv = setInterval(function () {
      if (self.readyState === 4 && self.status === 200 && self.responseText) {
        clearInterval(iv);
        if (WANT.test(url) || WANT.test(self.responseText.slice(0, 20000))) grab(url.split('/h5/').pop(), self.responseText);
      }
    }, 40);
    return this;
  };
  window.XMLHttpRequest.prototype = OrigXHR.prototype;
  var origFetch = window.fetch;
  window.fetch = function (input) {
    var u = (typeof input === 'string') ? input : (input && input.url) || String(input);
    return origFetch.apply(window, arguments).then(function (res) {
      if (res && res.clone) {
        res.clone().text().then(function (t) {
          if (WANT.test(u) || WANT.test(t.slice(0, 20000))) grab(String(u).split('/h5/').pop(), t);
        }).catch(function () {});
      }
      return res;
    });
  };
})();
`;

(async () => {
  const tabs = await httpJson('/json/list');
  const argIdx = process.argv.indexOf('--url');
  const wantUrl = argIdx > -1 ? process.argv[argIdx + 1] : '';

  let tab = wantUrl
    ? tabs.find((t) => t.type === 'page' && t.url && wantUrl.indexOf(t.url.split('/')[2]) > -1)
    : tabs.find((t) => t.type === 'page' && /detail\.1688\.com|goofish|item\.taobao|detail\.tmall/.test(t.url || ''));
  if (!tab) {
    tab = tabs.find((t) => t.type === 'page' && /1688\.com\/page\/offerlist|1688\.com/.test(t.url || ''));
  }
  if (!tab) { console.log('没有可用的商品页标签'); process.exit(1); }
  console.log('标签:', String(tab.url).slice(0, 90));

  const ws = new globalThis.WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r) => { ws.addEventListener('open', r); ws.addEventListener('error', () => r(new Error('ws'))); });

  let n = 0;
  const w = new Map();
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
    if (m.id != null && w.has(m.id)) { const f = w.get(m.id); w.delete(m.id); f(m); }
  });
  function ev(expr) {
    const id = ++n;
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
    return new Promise((res) => w.set(id, res));
  }
  async function val(expr) {
    const r = await ev(expr);
    if (r.exceptionDetails) return 'ERR: ' + String((r.exceptionDetails.exception || {}).description || '').split('\n')[0].slice(0, 200);
    const inner = (r && r.result && r.result.result) || {};
    return inner.value === undefined ? '(空)' : inner.value;
  }

  // 1) 当前页面 DOM 里的 <video>
  console.log('\n===== 页面 DOM 里的视频 =====');
  console.log(await val('(function(){' + PAGE_EXPR + '})()'));

  // 2) 已经跑过的接口里有无视频字段
  const cached = await val('JSON.stringify(window.__XY_VIDEO__ || null)');
  if (cached && cached !== 'null' && cached !== '(空)') {
    console.log('\n===== 已拦截接口里的视频字段 =====');
    console.log(cached);
  } else {
    console.log('\n（本次会话没有拦截到含视频字段的接口，需要新开详情页页跑一次）');
  }

  ws.close();
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
