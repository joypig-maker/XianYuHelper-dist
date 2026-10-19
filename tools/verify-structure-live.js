/**
 * 真机验证下载落盘结构。
 *
 * 在扩展自己的 ISOLATED world 里，用真实商品数据走一遍 SW 的落盘流程
 * （和用户点「打包」时调的是同一个 xy:download-items），
 * 然后直接读磁盘确认目录长相：
 *
 *   downloaded_items/_verify_<ts>/
 *     ├── info.json
 *     ├── images/1.jpg …
 *     ├── video/主图.mp4（有视频才会有）
 *     └── 文案.txt
 *
 * 用 _verify_ 前缀是为了不污染真实商品目录，验完可以整目录删掉。
 *
 * 用法：node tools/verify-structure-live.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const CDP = require('./cdp');

const DOWNLOADS = process.env.XY_DOWNLOADS || 'C:/Users/pc/Downloads';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await CDP.connect(9222);
  const page = await b.open('https://s.taobao.com/search?q=' + encodeURIComponent('手机支架'));

  const ctxs = [];
  page.on('Runtime.executionContextCreated', (p) => ctxs.push(p.context));
  await page.send('Runtime.enable');
  await sleep(9000);

  const isoCtxs = ctxs.filter((c) => c.auxData && c.auxData.isDefault === false);
  if (!isoCtxs.length) {
    console.log('✗ 没有 ISOLATED world —— 扩展没注入');
    await b.close();
    process.exit(1);
  }

  // 同名 ISOLATED 上下文可能不止一个（多次加载过扩展的实例留下的），
  // 挑真正装了 postbus 的那个，别拿到个空壳上下文就报「XYPostBus undefined」
  let iso = null;
  for (let i = isoCtxs.length - 1; i >= 0; i--) {
    const p = await page.send('Runtime.evaluate', {
      expression: 'typeof window.XYPostBus', returnByValue: true, contextId: isoCtxs[i].id
    });
    const v = p.result && p.result.value;
    console.log('  ISOLATED ctx ' + isoCtxs[i].id + ' → XYPostBus: ' + v);
    if (v === 'object' && !iso) iso = isoCtxs[i];
  }
  if (!iso) {
    console.log('✗ ' + isoCtxs.length + ' 个 ISOLATED 上下文都没装上 postbus');
    await b.close();
    process.exit(1);
  }

  async function ask(expr) {
    const r = await page.send('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true, contextId: iso.id
    });
    if (r.exceptionDetails) {
      throw new Error('页面异常: ' + String(r.exceptionDetails.exception &&
        r.exceptionDetails.exception.description || '?').slice(0, 200));
    }
    return r.result ? r.result.value : null;
  }

  const expr = `
    (async function () {
      var U = window.XYUtil;
      var ch = window.XYPostBus.channel('bridge');

      var seen = {}, ids = [];
      Array.prototype.forEach.call(document.querySelectorAll('a[data-spm-act-id]'), function (el) {
        var v = String(el.getAttribute('data-spm-act-id') || '').trim();
        if (/^\\d{6,20}$/.test(v) && !seen[v]) { seen[v] = 1; ids.push(v); }
      });
      if (!ids.length) return { error: '页面上没有商品' };

      var r = await ch.ask('bridge', 'bg-detail', { itemId: ids[0] }, { timeout: 60000 });
      var d = r && r.detail;
      if (!d) return { error: '详情没取到：' + ((r && r.error) || '?') };

      var dir = 'downloaded_items/_verify_' + Date.now();
      // 照 bridge 的 itemOf 拼一份，字段完全一致
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
        title: item.meta.title.slice(0, 24),
        expectImages: item.images.length,
        res: { ok: res.ok, images: res.images, imgTotal: res.imgTotal, info: res.info, textOk: res.textOk }
      };
    })()`;

  const out = await ask(expr);
  console.log('请求结果:', JSON.stringify(out));
  if (!out || out.error) { await b.close(); process.exit(1); }

  // 等落盘（下载是异步队列，响应只表示已提交）
  const abs = path.join(DOWNLOADS, out.dir);
  let files = [];
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    try {
      files = fs.readdirSync(abs, { recursive: true })
        .map((f) => String(f).replace(/\\/g, '/'))
        .filter((f) => !fs.statSync(path.join(abs, f)).isDirectory());
    } catch (e) { files = []; }
    if (files.length >= out.expectImages + 2) break;
  }

  console.log('\n实际落盘（' + out.dir + '）：');
  files.sort().forEach((f) => console.log('  ' + f));

  const fails = [];
  const need = (rel) => { if (files.indexOf(rel) === -1) fails.push('缺 ' + rel); };

  need('info.json');
  need('文案.txt');
  for (let i = 1; i <= out.expectImages; i++) need('images/' + i + '.jpg');
  if (files.some((f) => /^images\/sku\//.test(f)) && out.expectImages) { /* 有规格图也行 */ }

  // info.json 内容必须和实际文件名对上
  let info = null;
  try {
    info = JSON.parse(fs.readFileSync(path.join(abs, 'info.json'), 'utf8'));
    console.log('\ninfo.json：');
    console.log('  title        : ' + info.title);
    console.log('  price        : ' + info.price);
    console.log('  description  : ' + String(info.description).slice(0, 40) + '…');
    console.log('  local_images : ' + JSON.stringify(info.local_images));
    console.log('  sku_info     : ' + info.sku_info.length + ' 条');
    (info.local_images || []).forEach((rel) => {
      if (files.indexOf(rel) === -1) fails.push('local_images 指向 ' + rel + '，但没这个文件');
    });
  } catch (e) {
    fails.push('info.json 读不出来：' + e.message);
  }

  // 目录根下不该出现散落的图片
  const stray = files.filter((f) => /^\d+\.(jpg|png|webp|gif)$/i.test(f));
  if (stray.length) fails.push('根目录有散图：' + stray.join(','));

  console.log('\n' + (fails.length ? '✗ ' + fails.join('；') : '✓ 结构正确'));
  await b.close();
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e && e.message); process.exit(1); });
