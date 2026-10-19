/**
 * 京东端到端：详情补录（后台标签页 + DOM）→ 下载 → 检查落盘。
 *
 * 不只是看文件在不在，还读文件头确认真实格式（京东图床会返回 AVIF），
 * 并检查主图是不是从 228 缩略图升级到了 800（缩略图只有 6KB，铺货不能用）。
 *
 * 用法：node tools/verify-jd-pack-live.js [关键词]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const CDP = require('./cdp');

const DOWNLOADS = process.env.XY_DOWNLOADS || 'C:/Users/pc/Downloads';
const KW = process.argv[2] || '手机支架';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sniff(file) {
  try {
    const b = fs.readFileSync(file);
    if (b.length < 12) return '空/太小';
    if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'JPEG';
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'PNG';
    const head = b.slice(0, 16).toString('latin1');
    if (head.indexOf('ftypavif') > -1 || head.indexOf('ftypmif1') > -1) return 'AVIF';
    if (head.indexOf('RIFF') === 0) return 'WEBP';
    return '未知';
  } catch (e) { return '读取失败'; }
}

(async () => {
  const b = await CDP.connect(9222);
  const page = await b.open('https://search.jd.com/Search?keyword=' + encodeURIComponent(KW) + '&enc=utf-8');

  const ctxs = [];
  page.on('Runtime.executionContextCreated', (p) => ctxs.push(p.context));
  await page.send('Runtime.enable');
  await sleep(10000);

  let iso = null;
  for (let i = ctxs.length - 1; i >= 0; i--) {
    const c = ctxs[i];
    if (!c.auxData || c.auxData.isDefault !== false) continue;
    const pr = await page.send('Runtime.evaluate', {
      expression: 'typeof window.XYUtil', returnByValue: true, contextId: c.id
    });
    if (pr.result && pr.result.value === 'object') { iso = c; break; }
  }
  if (!iso) { console.log('✗ 没找到装好 XYUtil 的 ISOLATED 上下文'); await b.close(); process.exit(1); }

  const out = await page.send('Runtime.evaluate', {
    expression: `
      (async function () {
        var U = window.XYUtil, S = window.XYSites;
        var site = S.match(location.host);
        var cards = U.scanCards(document, site);
        if (!cards.length) return { error: '搜索页没采到卡片' };
        var c = cards[0];

        // 先走详情补录（后台标签页 + DOM），这是京东拿到多图的唯一途径
        var ch = window.XYPostBus.channel('bridge');
        var t0 = Date.now();
        var r = await ch.ask('bridge', 'bg-detail', { itemId: c.itemId }, { timeout: 90000 });
        var d = (r && r.detail) || null;
        if (!d) return { error: '详情没取到：' + ((r && r.error) || '?') };
        var detailMs = Date.now() - t0;

        var dir = 'downloaded_items/_verifyjd_' + Date.now();
        var item = {
          dir: dir,
          images: U.capImages(U.filterItemImages(d.images || [])),
          skus: d.skus || null,
          video: d.video || '',
          meta: { title: d.title || '', description: d.desc || d.title || '', price: d.price || '' },
          text: U.buildText(d, 'txt'),
          filename: '文案.txt'
        };
        var res = await new Promise(function (done) {
          chrome.runtime.sendMessage({ type: 'xy:download-items', items: [item] },
            function (x) { done(x || { ok: false, error: '无响应' }); });
        });
        return {
          dir: dir,
          商品ID: c.itemId,
          详情耗时ms: detailMs,
          图数: item.images.length,
          首图URL: String(item.images[0] || ''),
          有800尺寸: String(item.images[0] || '').indexOf('s800x800') > -1,
          URL里还有avif: /avif/i.test(item.images.join(',')),
          标题: String(item.meta.title).slice(0, 24),
          结果: { ok: res.ok, images: res.images, imgTotal: res.imgTotal, info: res.info, errors: res.errors }
        };
      })()
    `,
    awaitPromise: true, returnByValue: true, contextId: iso.id
  });
  if (out.exceptionDetails) {
    console.log('ERR ' + String(out.exceptionDetails.exception &&
      out.exceptionDetails.exception.description || '?').slice(0, 220));
    await b.close();
    process.exit(1);
  }

  const r = out.result.value;
  console.log(JSON.stringify(r, null, 1));
  if (!r || r.error) { await b.close(); process.exit(1); }

  const abs = path.join(DOWNLOADS, r.dir);
  let files = [];
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    try {
      files = fs.readdirSync(abs, { recursive: true })
        .map((f) => String(f).replace(/\\/g, '/'))
        .filter((f) => !fs.statSync(path.join(abs, f)).isDirectory());
    } catch (e) { files = []; }
    if (files.length >= r.图数 + 2) break;
  }

  console.log('\n实际落盘（' + r.dir + '）：');
  const fails = [];
  files.sort().forEach((f) => {
    const full = path.join(abs, f);
    const size = (() => { try { return fs.statSync(full).size; } catch (e) { return 0; } })();
    let fmt = '';
    if (/\.(jpg|jpeg|png|webp|gif|avif)$/i.test(f)) {
      fmt = sniff(full);
      if (fmt === 'AVIF') fails.push(f + ' 是 AVIF（软件读不出）');
    }
    console.log('  ' + String(f).padEnd(22) + ((size / 1024).toFixed(1) + 'KB').padStart(10) + '  ' + fmt);
  });

  // 主图必须是「升级过的大图」。只看第 1 张——详情图本来就是又长又窄的小图，
  // 按体积一刀切会把它们全判成缩略图（上一版就误报了两张）。
  const firstImg = files.filter((f) => /^images\/1\./.test(f))[0];
  if (firstImg) {
    const sz = fs.statSync(path.join(abs, firstImg)).size;
    if (sz < 40000) fails.push('首图只有 ' + (sz / 1024).toFixed(1) + 'KB，不像 800 大图（228 缩略图约 6KB）');
  }

  if (files.indexOf('info.json') === -1) fails.push('缺 info.json');
  const imgCount = files.filter((f) => /^images\/\d+\./.test(f)).length;
  if (imgCount < 5) fails.push('images/ 里只有 ' + imgCount + ' 张图');
  if (r.有800尺寸 !== true) fails.push('主图 URL 没有升级到 s800x800');
  if (r.URL里还有avif === true) fails.push('图集 URL 里还有 avif');

  console.log('\n' + (fails.length ? '✗ ' + fails.join('；') : '✓ 详情补录 + 下载落盘全部正常'));
  await b.close();
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e && e.message); process.exit(1); });
