/**
 * 下载去重回归
 *
 * 背景：批量打包时同一个 URL 被 downloads.download 发起多次，
 * conflictAction:'uniquify' 让它们存成 1.jpg / 1(1).jpg / 1(2).jpg，
 * 磁盘多出一堆重复图，info.json 里只有第一个路径指向真实文件。
 *
 * 三个最容易踩错的点，这个文件重点锁住：
 *   ① 跨商品必须各下一份（软件按商品夹读文件，串目录就读不到图）
 *   ② 去重后 info.json 的路径必须改成**首个请求的真实路径**
 *   ③ 失败不能记账，否则重试被自己的缓存挡掉
 *
 * 跑：node tools/test-dedup.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const SW_SRC = fs.readFileSync(path.join(ROOT, 'src/background/service_worker.js'), 'utf8');
const UT_SRC = fs.readFileSync(path.join(ROOT, 'src/common/util.js'), 'utf8');

let pass = 0, fail = 0;
function is(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra != null ? '  → ' + extra : '')); }
}
function section(t) { console.log('\n' + t); }

/* 从 SW 里抠出要测的函数 */
function grabFn(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('找不到 ' + name);
  let depth = 0, started = false;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') { depth++; started = true; }
    else if (src[j] === '}') { depth--; if (started && depth === 0) return src.slice(i, j + 1); }
  }
  throw new Error(name + ' 括号不配对');
}

/* 假环境：记录每一次真正发起的 downloads.download */
function makeCtx() {
  const calls = [];
  let nextId = 100;
  const sandbox = {
    console, setTimeout: (f) => f(), Promise, JSON, Math, Set,
    U: { IMAGES_DIR: 'images', SKU_DIR: 'images/sku' },
    chrome: {
      runtime: { lastError: null },
      downloads: {
        download(opts, cb) {
          calls.push({ url: opts.url, filename: opts.filename });
          nextId++;
          cb(nextId);
        }
      }
    }
  };
  sandbox.self = sandbox; sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  vm.runInContext('var dlCache = { inFlight: {}, done: {}, stats: { skipped: 0 } };', sandbox);
  vm.runInContext(grabFn(SW_SRC, 'dedupKey'), sandbox);
  vm.runInContext(grabFn(SW_SRC, 'dedupReset'), sandbox);
  vm.runInContext(grabFn(SW_SRC, 'downloadOnce'), sandbox);
  vm.runInContext(grabFn(SW_SRC, 'download'), sandbox);
  vm.runInContext(grabFn(SW_SRC, 'stripDir'), sandbox);

  return {
    calls,
    sandbox,
    dl: (o) => vm.runInContext('download(' + JSON.stringify(o) + ')', sandbox),
    key: (u, f) => vm.runInContext('dedupKey(' + JSON.stringify(u) + ',' + JSON.stringify(f) + ')', sandbox),
    reset: () => vm.runInContext('dedupReset()', sandbox),
    strip: (f, d) => vm.runInContext('stripDir(' + JSON.stringify(f) + ',' + JSON.stringify(d) + ')', sandbox)
  };
}

/* ============================================================ */
section('1) 去重键：签名参数折叠 + 目录隔离');
{
  const c = makeCtx();
  is('同一 URL + 同一目录 → 同键',
    c.key('https://i.alicdn.com/a.jpg', 'x/images/1.jpg') ===
    c.key('https://i.alicdn.com/a.jpg', 'x/images/9.jpg'));
  is('★ 不同签名 → 同键（OSS auth_key 变了也是同一张图）',
    c.key('https://i.alicdn.com/a.jpg?auth_key=X', 'x/images/1.jpg') ===
    c.key('https://i.alicdn.com/a.jpg?auth_key=Y', 'x/images/1.jpg'));
  is('★ 不同商品目录 → 不同键（跨商品必须各下一份）',
    c.key('https://i.alicdn.com/a.jpg', '商品A/images/1.jpg') !==
    c.key('https://i.alicdn.com/a.jpg', '商品B/images/1.jpg'),
    c.key('https://i.alicdn.com/a.jpg', '商品A/images/1.jpg'));
  is('主图与规格图同目录也算同键（同一商品夹内可共享）',
    c.key('https://i.alicdn.com/a.jpg', 'x/images/1.jpg') ===
    c.key('https://i.alicdn.com/a.jpg', 'x/images/sku/1_1_a.jpg'));
  is('data: URL 不产生键',
    c.key('data:image/png;base64,AAAA', 'x/images/1.png') === null);
  is('不同图片 → 不同键',
    c.key('https://i.alicdn.com/a.jpg', 'x/images/1.jpg') !==
    c.key('https://i.alicdn.com/b.jpg', 'x/images/2.jpg'));
}

/* ============================================================ */
section('2) 同一商品内：重复图只下一次');
(async () => {
  const c = makeCtx();
  const A = await c.dl({ url: 'https://i.alicdn.com/a.jpg', filename: 'x/images/sku/1_1_红.jpg', conflictAction: 'uniquify' });
  const B = await c.dl({ url: 'https://i.alicdn.com/a.jpg?auth_key=Z', filename: 'x/images/sku/1_2_蓝.jpg', conflictAction: 'uniquify' });
  is('只发起了一次真实下载', c.calls.length === 1, String(c.calls.length));
  is('首个返回 ok', A.ok === true);
  is('★ 第二个也返回 ok（复用，不报错）', B.ok === true);
  is('★ 第二个带 deduped 标记', B.deduped === true, JSON.stringify(B));
  is('★ 第二个回传首个的真实路径（info.json 要靠它）',
    B.filename === 'x/images/sku/1_1_红.jpg', B.filename);
  is('首个也回传了自己的路径', A.filename === 'x/images/sku/1_1_红.jpg', A.filename);
})();

/* ============================================================ */
section('3) 跨商品：必须各下一份');
(async () => {
  const c = makeCtx();
  await c.dl({ url: 'https://i.alicdn.com/a.jpg', filename: '商品A/images/1.jpg', conflictAction: 'uniquify' });
  await c.dl({ url: 'https://i.alicdn.com/a.jpg', filename: '商品B/images/1.jpg', conflictAction: 'uniquify' });
  is('★ 跨商品各下一次（共 2 次）', c.calls.length === 2, String(c.calls.length));
})();

/* ============================================================ */
section('4) 失败不记账，否则重试会被自己的缓存挡掉');
(async () => {
  const c = makeCtx();
  // 造一个首调失败的环境
  c.sandbox.chrome.downloads.download = function (opts, cb) {
    c.calls.push({ url: opts.url, filename: opts.filename });
    c.sandbox.chrome.runtime.lastError = { message: '网络错误' };
    cb(undefined);
  };
  const r = await c.dl({ url: 'https://i.alicdn.com/fail.jpg', filename: 'x/images/9.jpg' });
  is('失败时返回 ok:false', r.ok === false, JSON.stringify(r));
  is('重试也试过一次（retries=1）', c.calls.length === 2, String(c.calls.length));
  // 恢复环境后再试，应该真能下。
  // ⚠️ 必须同时清掉 lastError：chrome.runtime.lastError 是**上一次**下载留下的，
  //    只换 download 实现不改它的话，每次调用都会被判成失败。
  c.sandbox.chrome.downloads.download = function (opts, cb) {
    c.calls.push({});
    c.sandbox.chrome.runtime.lastError = null;
    cb(999);
  };
  const r2 = await c.dl({ url: 'https://i.alicdn.com/fail.jpg', filename: 'x/images/9.jpg' });
  is('★ 失败过的图没有进缓存，后续能正常下载', r2.ok === true, JSON.stringify(r2));
  is('且不是复用旧结果', r2.deduped !== true);
})();

/* ============================================================ */
section('5) 批内缓存要重置（上一批的路径对下一批无效）');
{
  const c = makeCtx();
  const k1 = c.key('https://i.alicdn.com/a.jpg', 'x/images/1.jpg');
  c.sandbox.dlCache.done[k1] = { filename: 'x/images/1.jpg' };
  c.reset();
  is('★ dedupReset 清空已完成记录',
    Object.keys(c.sandbox.dlCache.done).length === 0,
    JSON.stringify(Object.keys(c.sandbox.dlCache.done)));
}

/* ============================================================ */
section('6) stripDir：去掉商品目录，只留商品夹内相对路径');
{
  const c = makeCtx();
  is('正常情况去掉前缀',
    c.strip('商品A/images/sku/1_1_红.jpg', '商品A') === 'images/sku/1_1_红.jpg',
    c.strip('商品A/images/sku/1_1_红.jpg', '商品A'));
  is('反斜杠路径也能处理',
    c.strip('商品A\\images\\1.jpg', '商品A') === 'images/1.jpg',
    c.strip('商品A\\images\\1.jpg', '商品A'));
  is('目录对不上时退回最后两段（不返回空）',
    c.strip('别的目录/images/1.jpg', '商品A') === 'images/1.jpg',
    c.strip('别的目录/images/1.jpg', '商品A'));
}

/* ============================================================ */
section('7) buildInfo 用真实路径（去重的收口）');
{
  const win = {}; vm.createContext(win);
  vm.runInContext(UT_SRC, win, { timeout: 5000 });
  const U = win.XYUtil;
  const skus = {
    specs: ['颜色'],
    specDefs: [{ name: '颜色', values: [
      { value: '红', image: 'https://i/a.jpg' },
      { value: '蓝', image: 'https://i/a.jpg' }      // 同图 → 去重后共用一份
    ] }],
    list: [{ key: '红', price: '1', stock: '1' }, { key: '蓝', price: '1', stock: '1' }]
  };

  const noMap = U.buildInfo({}, [], skus, null);
  is('没有真实路径时按序号推算（老行为）',
    noMap.sku_specs[0].values[0].local_image === 'images/sku/1_1_红.jpg',
    noMap.sku_specs[0].values[0].local_image);

  const withMap = U.buildInfo({}, [], skus, null, { 'https://i/a.jpg': 'images/sku/1_1_红.jpg' });
  is('★ 有真实路径时用它',
    withMap.sku_specs[0].values[0].local_image === 'images/sku/1_1_红.jpg');
  is('★ ★ 同图的第二个值也指向同一文件（去重后真实情况）',
    withMap.sku_specs[0].values[1].local_image === 'images/sku/1_1_红.jpg',
    withMap.sku_specs[0].values[1].local_image);
  is('image_url 仍保留（软件可自行重下）',
    withMap.sku_specs[0].values[1].image_url === 'https://i/a.jpg');

  // 主图侧
  const imgs = ['https://i/1.jpg', 'https://i/2.jpg'];
  const mi = U.buildInfo({}, imgs, null, null, { 'https://i/2.jpg': 'images/5.jpg' });
  is('主图没有真实路径时按序号推算',
    mi.local_images[0] === 'images/1.jpg', mi.local_images[0]);
  is('★ 主图有真实路径时用它（去重后可能不是 2.jpg）',
    mi.local_images[1] === 'images/5.jpg', mi.local_images[1]);
}

/* ============================================================ */
section('8) 无图值仍为空串（不能被真实路径污染）');
{
  const win = {}; vm.createContext(win);
  vm.runInContext(UT_SRC, win, { timeout: 5000 });
  const U = win.XYUtil;
  const skus = {
    specs: ['尺码'],
    specDefs: [{ name: '尺码', values: [{ value: 'M', image: '' }] }],
    list: [{ key: 'M', price: '1', stock: '1' }]
  };
  const info = U.buildInfo({}, [], skus, null, { 'https://i/any.jpg': 'images/x.jpg' });
  is('无图值 local_image 仍是空串',
    info.sku_specs[0].values[0].local_image === '',
    JSON.stringify(info.sku_specs[0].values[0]));
  is('无图值不写 image_url',
    !('image_url' in info.sku_specs[0].values[0]));
}

setTimeout(() => {
  console.log('\n' + '─'.repeat(50));
  if (fail) {
    console.log('✗ 有失败：' + pass + ' 通过 / ' + fail + ' 失败');
    process.exit(1);
  } else {
    console.log('✓ 全部通过：' + pass + ' 项断言');
  }
}, 300);
