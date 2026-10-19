/**
 * m3u8 合并下载的**运行级**验证。
 *
 * test-video-download.js 只验纯函数，这里真跑一遍 fetchM3u8Video：
 * 用假的 fetch 喂真实格式的播放列表，检查分片顺序、合并字节、Referer 头。
 *
 * MV3 service worker 没有 window/DOM，函数是挂在文件顶层的，
 * 所以这里直接把 service_worker.js 里的相关函数抠出来在沙箱里跑。
 *
 * 跑：node tools/test-m3u8-merge.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SW_SRC = fs.readFileSync(path.join(ROOT, 'src/background/service_worker.js'), 'utf8');
const UT_SRC = fs.readFileSync(path.join(ROOT, 'src/common/util.js'), 'utf8');

let pass = 0, fail = 0;
function is(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra != null ? '  → ' + extra : '')); }
}

/* ---- 把 SW 里需要的三个函数抠出来 ---- */
function grabFn(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('找不到函数 ' + name);
  let depth = 0, started = false;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') { depth++; started = true; }
    else if (src[j] === '}') { depth--; if (started && depth === 0) return src.slice(i, j + 1); }
  }
  throw new Error('函数 ' + name + ' 括号不配对');
}

// 用真实 fetchBinary / pump / fetchM3u8Video
const pieces = [
  'function originOf(url){var m=String(url||"").match(/^(https?:\\/\\/[^/]+)/i);return m?m[1]+"/":"";}',
  'function fetchBinary(url, referer){return fetch(url,{credentials:"omit",headers:referer?{Referer:referer}:{}}).then(function(res){if(!res.ok)throw new Error("HTTP "+res.status);return res.arrayBuffer();});}',
  grabFn(SW_SRC, 'pump'),
  'var U = {};'
];

// U.parseM3u8 用真实实现；absolutizeUrl 是 util.js 里的内部函数，
// parseM3u8 闭包引用它，但它没导出，所以直接从源码抠出来一起搬进沙箱
const win = {}; vm.createContext(win);
vm.runInContext(UT_SRC, win, { timeout: 5000 });
pieces[3] = grabFn(UT_SRC, 'absolutizeUrl')
  + '\nvar U = { parseM3u8: ' + win.XYUtil.parseM3u8.toString() + ' };';

const sandbox = {
  console, setTimeout, Uint8Array, TextDecoder, ArrayBuffer, Math, JSON,
  chrome: { runtime: { lastError: null }, downloads: { download() {} } }
};
sandbox.self = sandbox;
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(pieces.join('\n'), sandbox, { timeout: 5000 });
vm.runInContext(grabFn(SW_SRC, 'fetchM3u8Video'), sandbox, { timeout: 5000 });

const PL = [
  '#EXTM3U', '#EXT-X-TARGETDURATION:4',
  '#EXTINF:4.0,', 's0.ts',
  '#EXTINF:4.0,', 's1.ts',
  '#EXTINF:4.0,', 's2.ts',
  '#EXT-X-ENDLIST'
].join('\n');

(async function main(){

/* ---- 场景 1：正常三段，顺序必须正确 ---- */
{
  const seen = [];
  sandbox.fetch = function (url, opts) {
    seen.push({ url: url, ref: opts && opts.headers && opts.headers.Referer });
    let body;
    if (/index\.m3u8/.test(url)) body = new TextEncoder().encode(PL).buffer;
    else {
      // 每段内容 = 自己的序号，合并后应该 0,1,2 依次出现
      const n = Number(url.match(/s(\d)\.ts/)[1]);
      body = new Uint8Array([n, n, n]).buffer;
    }
    return Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(body) });
  };

  await sandbox.fetchM3u8Video('https://cdn.example.com/hls/index.m3u8').then((res) => {
    is('合并成功', res.ok, res.error);
    if (res.ok) {
      const out = Array.from(new Uint8Array(res.buffer));
      is('三段按播放顺序拼接（0,0,0,1,1,1,2,2,2）',
        JSON.stringify(out) === JSON.stringify([0, 0, 0, 1, 1, 1, 2, 2, 2]), JSON.stringify(out));
      is('请求带 Referer（OSS 防盗链）',
        seen.every((s) => s.ref === 'https://cdn.example.com/'),
        JSON.stringify(seen.map((s) => s.ref)));
      is('拉了 1 个清单 + 3 个分片', seen.length === 4, String(seen.length));
    }
  });
}

/* ---- 场景 2：HTTP 403 → 干净失败，不抛未捕获异常 ---- */
{
  sandbox.fetch = function () {
    return Promise.resolve({ ok: false, status: 403, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) });
  };
  await sandbox.fetchM3u8Video('https://cdn.example.com/hls/index.m3u8').then((res) => {
    is('403 返回 ok:false 而不是抛异常', res.ok === false);
    is('错误信息带 HTTP 状态码', /403/.test(res.error || ''), res.error);
    is('失败时不产出 buffer', !res.buffer);
  });
}

/* ---- 场景 3：某个分片 404 → 报分片失败，不产出半截视频 ---- */
{
  sandbox.fetch = function (url) {
    if (/index\.m3u8/.test(url)) {
      return Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(new TextEncoder().encode(PL).buffer) });
    }
    if (/s1\.ts/.test(url)) {
      return Promise.resolve({ ok: false, status: 404, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) });
    }
    return Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(new Uint8Array([9, 9]).buffer) });
  };
  await sandbox.fetchM3u8Video('https://cdn.example.com/hls/index.m3u8').then((res) => {
    is('分片失败时 ok:false', res.ok === false, JSON.stringify(res));
    is('报出「几个/共几个」', /1\/3|分片失败/.test(res.error || ''), res.error);
    is('不产出残缺文件', !res.buffer);
  });
}

/* ---- 场景 4：拿到的是 HTML 错误页 → 识别为非清单 ---- */
{
  sandbox.fetch = function () {
    const html = new TextEncoder().encode('<html><body>403</body></html>').buffer;
    return Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(html) });
  };
  await sandbox.fetchM3u8Video('https://cdn.example.com/hls/index.m3u8').then((res) => {
    is('HTML 错误页被识别为非清单', res.ok === false && /m3u8 无法解析/.test(res.error || ''), res.error);
    is('不产出垃圾文件', !res.buffer);
  });
}

/* ---- 场景 5：超大视频保护（>80MB 直接跳过，不硬拼） ---- */
{
  const bigSeg = 41 * 1024 * 1024;   // 两段 = 82MB > 80MB 上限
  const list2 = ['#EXTM3U', '#EXTINF:4.0,', 's0.ts', '#EXTINF:4.0,', 's1.ts', '#EXT-X-ENDLIST'].join('\n');
  sandbox.fetch = function (url) {
    if (/index\.m3u8/.test(url)) {
      return Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(new TextEncoder().encode(list2).buffer) });
    }
    return Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(new ArrayBuffer(bigSeg)) });
  };
  await sandbox.fetchM3u8Video('https://cdn.example.com/hls/index.m3u8').then((res) => {
    is('超大视频跳过而不是 OOM', res.ok === false && /过大/.test(res.error || ''), res.error);
    is('跳过时不产出 buffer', !res.buffer);
  });
}

})().catch(function(e){ console.error('测试自身抛错:', e); process.exitCode = 1; });

process.on('exit', () => {
  console.log('\n' + '─'.repeat(50));
  console.log(fail
    ? '✗ 有失败：' + pass + ' 通过 / ' + fail + ' 失败'
    : '✓ 全部通过：' + pass + ' 项断言');
  if (fail) process.exitCode = 1;
});
