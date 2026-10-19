/**
 * 主动清除 jsDelivr 缓存并验证 —— 解决「发版后要等 6 分钟甚至更久才生效」。
 *
 * jsDelivr 对 @main 这类分支引用的缓存刷新时间不可控：实测 v1.2.25 是 6 分钟，
 * 而 v1.2.26 等了 9 分钟还没动。官方提供 purge 接口可以主动清：
 *   https://purge.jsdelivr.net/gh/<user>/<repo>@<ref>/<path>
 *
 * 注意：回读必须**直连**（Node 默认不走环境变量代理）。
 * 本机有 HTTP_PROXY，curl 会走代理，而代理自己也会缓存，
 * 用它判断 purge 是否生效会被带偏。
 *
 * 用法：node tools/purge-jsdelivr.js [--wait]
 */
'use strict';
const https = require('https');

const REPO = 'gh/joypig-maker/XianYuHelper-dist@main/XianYuHelper';
const FILES = ['update.xml', 'XianYuHelper.crx'];

function get(target, timeout) {
  return new Promise((resolve) => {
    const r = https.request(target, { method: 'GET', timeout: timeout || 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 Chrome/154.0.0.0' } }, (resp) => {
      let n = 0; const chunks = [];
      resp.on('data', (d) => { n += d.length; if (chunks.length < 3) chunks.push(d); });
      resp.on('end', () => resolve({ status: resp.statusCode, bytes: n,
        body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', (e) => resolve({ err: e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ err: '超时' }); });
    r.end();
  });
}

function versionIn(xml) {
  const i = xml.indexOf('updatecheck');
  const k = xml.indexOf("version='", i);
  return k < 0 ? '?' : xml.slice(k + 9, xml.indexOf("'", k + 9));
}

async function readLive() {
  const xml = await get('https://cdn.jsdelivr.net/' + REPO + '/update.xml');
  const crx = await get('https://cdn.jsdelivr.net/' + REPO + '/XianYuHelper.crx');
  return {
    version: xml.body ? versionIn(xml.body) : ('读不到(' + (xml.err || xml.status) + ')'),
    crxBytes: crx.bytes || 0
  };
}

(async () => {
  console.log('=== purge 前 ===');
  let before = await readLive();
  console.log('  清单=' + before.version + '  crx=' + before.crxBytes + 'B');

  console.log('\n=== 调 purge ===');
  for (const f of FILES) {
    const r = await get('https://purge.jsdelivr.net/' + REPO + '/' + f, 30000);
    if (r.err) { console.log('  ' + f + ' : ✗ ' + r.err); continue; }
    let detail = r.body;
    try {
      const j = JSON.parse(r.body);
      const k = Object.keys(j.paths || {})[0];
      const st = k ? j.paths[k] : null;
      detail = 'HTTP ' + r.status + '  status=' + j.status +
        (st ? '  path.status=' + JSON.stringify(st) : '');
    } catch (e) {
      detail = 'HTTP ' + r.status + '  ' + r.body.slice(0, 160).replace(/\s+/g, ' ');
    }
    console.log('  ' + f.padEnd(18) + ': ' + detail);
  }

  if (process.argv.indexOf('--wait') > -1) {
    console.log('\n=== 等待生效（每 15 秒回读一次，最多 5 分钟）===');
    for (let i = 1; i <= 20; i++) {
      await new Promise((r) => setTimeout(r, 15000));
      const now = await readLive();
      console.log('  [' + (i * 15) + 's] 清单=' + now.version + '  crx=' + now.crxBytes + 'B');
      if (now.version !== before.version) {
        console.log('\n  ✓ 已刷新到 ' + now.version);
        break;
      }
    }
  } else {
    await new Promise((r) => setTimeout(r, 8000));
    const after = await readLive();
    console.log('\n=== purge 后 8 秒 ===');
    console.log('  清单=' + after.version + '  crx=' + after.crxBytes + 'B' +
      (after.version !== before.version ? '   ✓ 已刷新' : '   （还没变）'));
  }
})().catch((e) => { console.error('ERR', e && e.message); process.exit(1); });
