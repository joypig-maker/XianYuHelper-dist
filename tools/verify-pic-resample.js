/**
 * 商品图 CDN 重采样：**联网**验收。
 *
 * 单元测（test-pic-resample.js）只保证 URL 拼得对，这个脚本保证
 * 「拼完之后 CDN 真的给图、而且给的不是原来那份字节」。
 * CDN 的档位白名单是会变的，以后怀疑重采样失效就重跑它。
 *
 * 用法：
 *   node tools/verify-pic-resample.js                     用抓包里的闲鱼图（默认 10 张）
 *   node tools/verify-pic-resample.js <数量>
 *   node tools/verify-pic-resample.js <数量> <urls文件>   一行一个 URL
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const https = require('https');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const N = parseInt(process.argv[2], 10) || 10;
const urlFile = process.argv[3];

const w = {};
vm.createContext(w);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/common/util.js'), 'utf8'), w, { timeout: 5000 });
const U = w.XYUtil;

function urlsFromCapture() {
  const p = path.join(ROOT, 'dist/xy-shop-api.json');
  if (!fs.existsSync(p)) return [];
  const hits = JSON.parse(fs.readFileSync(p, 'utf8')).filter((x) => x.api === 'mtop.idle.web.xyh.item.list');
  const out = [];
  hits.forEach((h) => {
    const j = JSON.parse(h.body);
    (j.data.cardList || []).forEach((c) => {
      let inf = (c.cardData && c.cardData.detailParams && c.cardData.detailParams.imageInfos) || [];
      if (typeof inf === 'string') { try { inf = JSON.parse(inf); } catch (e) { inf = []; } }
      if (!Array.isArray(inf)) inf = [];
      inf.forEach((o) => { if (o && o.url) out.push(o.url); });
    });
  });
  return out;
}

const all = urlFile
  ? fs.readFileSync(urlFile, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)
  : urlsFromCapture();

if (!all.length) { console.error('没有可用图片 URL'); process.exit(1); }
const sample = all.slice(0, N);

function fetchBuf(url) {
  return new Promise((resolve) => {
    const mod = /^https:/i.test(url) ? https : http;
    const req = mod.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
          + '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
      }
    }, (r) => {
      const chunks = [];
      r.on('data', (d) => chunks.push(d));
      r.on('end', () => resolve({ code: r.statusCode, buf: Buffer.concat(chunks) }));
    });
    req.on('error', () => resolve({ code: 0, buf: Buffer.alloc(0) }));
    req.setTimeout(25000, () => { req.destroy(); resolve({ code: 0, buf: Buffer.alloc(0) }); });
  });
}

const md5 = (b) => require('crypto').createHash('md5').update(b).digest('hex').slice(0, 12);

(async () => {
  let ok = 0, changed = 0, bad = 0;
  console.log('抽样 ' + sample.length + ' 张，对比「原图」与「重采样版」\n');
  console.log('#    原字节      改后字节    MD5 是否变化  状态');
  for (let i = 0; i < sample.length; i++) {
    const raw = sample[i];
    const mod = U.picResampleUrl(raw);
    const a = await fetchBuf(raw);
    const b = await fetchBuf(mod);
    const same = a.buf.length && b.buf.length && md5(a.buf) === md5(b.buf);
    const good = b.code === 200 && b.buf.length > 1000 && !same;
    if (good) { ok++; changed++; }
    else if (b.code === 200) { ok++; }
    else bad++;
    console.log(
      String(i + 1).padEnd(5) +
      String(a.buf.length).padEnd(12) +
      String(b.buf.length).padEnd(12) +
      (same ? '未变化          ' : '已变化          ') +
      (b.code === 200 ? '200 OK' : 'HTTP ' + b.code)
    );
  }
  console.log('\n重采样可用 ' + ok + '/' + sample.length +
    '，其中字节确实改变 ' + changed + ' 张，失败 ' + bad + ' 张');
  process.exit(changed === sample.length ? 0 : 1);
})();
