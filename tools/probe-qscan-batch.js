/**
 * 批量扫描 q 值：找出对所有图（heic + jpg、大图 + 小图）都能改字节的档位
 *
 * 只比字节（md5），不解码 —— 够判断「改没改」，而且快很多倍。
 *
 * 用法：node tools/probe-qscan-batch.js [样本数]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const { load, longest } = require('./xy-shop-images.js');
const SIZE = '_1440x1440';
const QS = [100, 95, 90, 85, 80, 75, 70];

function dl(u) {
  return new Promise(function (resolve) {
    const req = https.get(String(u).replace(/^http:/i, 'https:'), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
          + '(KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'
      }
    }, function (res) {
      const bufs = [];
      res.on('data', function (d) { bufs.push(d); });
      res.on('end', function () {
        const b = Buffer.concat(bufs);
        resolve({ code: res.statusCode, len: b.length, md5: crypto.createHash('md5').update(b).digest('hex').slice(0, 10) });
      });
    });
    req.on('error', function () { resolve(null); });
    req.setTimeout(25000, function () { req.destroy(); resolve(null); });
  });
}

(async function main() {
  const n = parseInt(process.argv[2] || '10', 10);
  const uniq = load();

  // 分层取样：大图 / 小图 × heic / jpg 各取一些
  const pick = function (pred, cnt) {
    return uniq.filter(pred).sort(function () { return 0.5 - Math.random(); }).slice(0, cnt);
  };
  const big = function (r) { return longest(r) > 1440; };
  const small = function (r) { const L = longest(r); return L && L <= 1440; };
  const isHeic = function (r) { return /\.heic$/i.test(r.u); };
  const isJpg = function (r) { return /\.jpe?g$/i.test(r.u); };

  const samples = [].concat(
    pick(function (r) { return big(r) && isHeic(r); }, Math.ceil(n / 4)),
    pick(function (r) { return big(r) && isJpg(r); }, Math.ceil(n / 4)),
    pick(function (r) { return small(r) && isHeic(r); }, Math.ceil(n / 4)),
    pick(function (r) { return small(r) && isJpg(r); }, Math.ceil(n / 4))
  );

  console.log('样本 ' + samples.length + ' 张：大图heic / 大图jpg / 小图heic / 小图jpg 各取若干\n');
  console.log('原图                     ' + QS.map(function (q) { return ('q' + q).padEnd(7); }).join(''));
  console.log('─'.repeat(30 + QS.length * 7));

  const sameCount = {};
  QS.forEach(function (q) { sameCount[q] = 0; });

  for (const t of samples) {
    const base = await dl(t.u);
    if (!base || base.code !== 200) { console.log('下载失败 ' + t.u.slice(-40)); continue; }
    const cells = [];
    for (const q of QS) {
      const r = await dl(t.u + SIZE + 'q' + q + '.jpg');
      if (!r || r.code !== 200) { cells.push('ERR'.padEnd(7)); sameCount[q]++; continue; }
      if (r.md5 === base.md5) { cells.push('没变'.padEnd(7)); sameCount[q]++; }
      else cells.push((Math.round(r.len / 1024) + 'K').padEnd(7));
    }
    const L = longest(t);
    const ext = /\.heic$/i.test(t.u) ? 'heic' : 'jpg';
    console.log((L + ' ' + ext).padEnd(24) + cells.join(''));
  }

  console.log('─'.repeat(30 + QS.length * 7));
  console.log('字节未变的张数（越少越好）：');
  QS.forEach(function (q) {
    console.log('  q' + String(q).padEnd(5) + ' ' + sameCount[q] + ' / ' + samples.length
      + '   ' + '█'.repeat(sameCount[q]));
  });
})();
