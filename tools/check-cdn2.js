/**
 * 分发源候选的实测评测 —— 为「客户在国内裸网能不能更新」找依据。
 *
 * 背景：本机装了代理（HTTP_PROXY=http://127.0.0.1:60585），
 * 所以这里的结果**只能说明「有代理时通不通」，不能代表客户环境**。
 * 为了尽量逼近真实，脚本做两件事：
 *   1. 同时报「直连（不走代理）」和「走系统环境」两种结果
 *   2. 把 Gitee 的防盗链行为单独测出来 —— 它按 Referer 拦，
 *      而 Chrome 检查扩展更新时的 Referer 不是普通网页，这是能不能用的关键
 *
 * 用法：node tools/check-cdn2.js
 */
'use strict';
const https = require('https');
const http = require('http');
const { URL } = require('url');

/** 走指定代理（或直连）请求，拿状态码/长度/类型/前若干字节 */
function req(target, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    let u;
    try { u = new URL(target); } catch (e) { return resolve({ err: 'URL 无效' }); }
    const headers = Object.assign({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/154.0.0.0'
    }, opts.headers || {});

    const done = (o) => resolve(Object.assign({ url: target }, o));

    let agent = undefined;
    if (opts.proxy) {
      // HTTPS over HTTP 代理：CONNECT 隧道
      const p = new URL(opts.proxy);
      const connectReq = http.request({
        host: p.hostname, port: p.port, method: 'CONNECT',
        path: u.hostname + ':443', timeout: opts.timeout || 12000
      });
      connectReq.on('connect', (res, socket) => {
        if (res.statusCode !== 200) return done({ err: 'CONNECT ' + res.statusCode });
        const r = https.request({
          host: u.hostname, path: u.pathname + u.search,
          method: 'GET', headers, socket, agent: false, timeout: opts.timeout || 12000
        }, (resp) => {
          let n = 0;
          const chunks = [];
          resp.on('data', (d) => { n += d.length; if (chunks.length < 1) chunks.push(d.slice(0, 200)); });
          resp.on('end', () => done({
            status: resp.statusCode, bytes: n,
            type: resp.headers['content-type'],
            head: Buffer.concat(chunks).toString('utf8').slice(0, 120).replace(/\s+/g, ' ')
          }));
        });
        r.on('error', (e) => done({ err: e.message }));
        r.on('timeout', () => { r.destroy(); done({ err: '超时' }); });
        r.end();
      });
      connectReq.on('error', (e) => done({ err: '代理连接失败: ' + e.message }));
      connectReq.on('timeout', () => { connectReq.destroy(); done({ err: '代理超时' }); });
      connectReq.end();
      return;
    }

    const r = https.request({
      host: u.hostname, path: u.pathname + u.search, method: 'GET', headers,
      timeout: opts.timeout || 12000
    }, (resp) => {
      let n = 0;
      const chunks = [];
      resp.on('data', (d) => { n += d.length; if (chunks.length < 1) chunks.push(d.slice(0, 200)); });
      resp.on('end', () => done({
        status: resp.statusCode, bytes: n,
        type: resp.headers['content-type'],
        head: Buffer.concat(chunks).toString('utf8').slice(0, 120).replace(/\s+/g, ' ')
      }));
    });
    r.on('error', (e) => done({ err: e.message }));
    r.on('timeout', () => { r.destroy(); done({ err: '超时' }); });
    r.end();
  });
}

const PROXY = process.env.HTTPS_PROXY || process.env.https_proxy || '';
const BASE = 'https://cdn.jsdelivr.net/gh/joypig-maker/XianYuHelper-dist@main/XianYuHelper';

const TARGETS = [
  ['jsDelivr  cdn.jsdelivr.net', BASE + '/update.xml'],
  ['jsDelivr  fastly 端点', 'https://fastly.jsdelivr.net/gh/joypig-maker/XianYuHelper-dist@main/XianYuHelper/update.xml'],
  ['jsDelivr  gcore 端点', 'https://gcore.jsdelivr.net/gh/joypig-maker/XianYuHelper-dist@main/XianYuHelper/update.xml'],
  ['jsDelivr  testingcf 端点', 'https://testingcf.jsdelivr.net/gh/joypig-maker/XianYuHelper-dist@main/XianYuHelper/update.xml'],
  ['Gitee 首页', 'https://gitee.com/'],
  ['Gitee API（公开仓库搜索）', 'https://gitee.com/api/v5/search/repositories?q=test&per_page=1'],
  ['Gitee raw（示例镜像仓库）', 'https://gitee.com/mirrors/vue/raw/master/README.md'],
  ['GitHub raw', 'https://raw.githubusercontent.com/joypig-maker/XianYuHelper-dist/main/XianYuHelper/update.xml']
];

(async () => {
  console.log('本机代理: ' + (PROXY || '(未设置)'));
  console.log('说明：直连=不走代理（更接近客户裸网）；走代理=本机当前实际路径\n');
  console.log('  目标                              | 直连            | 走代理');
  console.log('  ----------------------------------|-----------------|----------------');
  for (const [name, url] of TARGETS) {
    const direct = await req(url, { timeout: 12000 });
    const proxied = PROXY ? await req(url, { proxy: PROXY, timeout: 12000 }) : { err: '(无代理)' };
    const fmt = (r) => {
      if (r.err) return ('✗ ' + r.err).slice(0, 15);
      return ('✓ ' + r.status + ' ' + (r.bytes / 1024).toFixed(1) + 'KB').slice(0, 15);
    };
    console.log('  ' + name.padEnd(33) + ' | ' + fmt(direct).padEnd(15) + ' | ' + fmt(proxied));
  }

  console.log('\n=== Gitee 防盗链测试（关键：Chrome 更新检查时没有普通 Referer）===');
  const giteeUrl = 'https://gitee.com/mirrors/vue/raw/master/README.md';
  const cases = [
    ['不带 Referer（最接近 Chrome 取扩展更新）', {}],
    ['带网页 Referer', { Referer: 'https://gitee.com/' }],
    ['带伪装 Referer', { Referer: 'https://example.com/' }],
    ['模拟 Chrome 扩展更新 UA', { Referer: '', 'X-Requested-With': '' }]
  ];
  for (const [label, h] of cases) {
    const r = await req(giteeUrl, { headers: h, proxy: PROXY, timeout: 12000 });
    const s = r.err ? ('✗ ' + r.err) : ('✓ ' + r.status + '  ' + (r.bytes / 1024).toFixed(1) + 'KB  ' +
      String(r.type).slice(0, 40) + '  ' + r.head.slice(0, 50));
    console.log('  ' + label.padEnd(38) + ' : ' + s);
  }
})().catch((e) => { console.error('ERR', e && e.message); process.exit(1); });
