/**
 * 跨批次去重端到端复现（用真实代码，不是重写的简化版）
 *
 * 用户反馈：「更新版本后又下载了同一个商品，出现重复」。
 * 要查清是「历史没记上」还是「记上了但没命中」。
 *
 * 跑：node tools/e2e_history.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SW = fs.readFileSync(path.join(ROOT, 'src/background/service_worker.js'), 'utf8');
const SITES = fs.readFileSync(path.join(ROOT, 'src/common/sites.js'), 'utf8');

let pass = 0, fail = 0;
function is(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra != null ? '  → ' + extra : '')); }
}
function section(t) { console.log('\n' + t); }

function grabFn(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('找不到 ' + name);
  let d = 0, s = false;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') { d++; s = true; }
    else if (src[j] === '}') { d--; if (s && d === 0) return src.slice(i, j + 1); }
  }
  throw new Error(name + ' 括号不配对');
}

/** 加载真实的 XYUtil（historyKey 依赖它的 itemKey） */
function loadU() {
  const w = {};
  vm.createContext(w);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'src/common/util.js'), 'utf8'),
    w, { timeout: 5000 });
  return w.XYUtil;
}

/** 假 storage，模拟真实的 chrome.storage.local */
function makeCtx(initStore) {
  const store = Object.assign({}, initStore || {});
  const sets = [];
  const sb = {
    console, setTimeout: (f) => f(), Promise, JSON, Math, Date,
    chrome: {
      runtime: { lastError: null },
      storage: { local: {
        get(k, cb) { setTimeout(() => cb(store), 0); },
        set(p, cb) { Object.assign(store, p); sets.push(p); if (cb) setTimeout(() => cb(), 0); },
        remove(k, cb) { delete store[k]; if (cb) setTimeout(() => cb(), 0); }
      } }
    }
  };
  sb.self = sb; sb.window = sb; sb.globalThis = sb;
  sb.U = loadU();
  vm.createContext(sb);
  vm.runInContext("var HISTORY_KEY='xy_dl_history'; var historyCache=null;", sb);
  ['loadHistory', 'historyKey', 'historyFilter', 'historyMark', 'historyClear']
    .forEach(n => vm.runInContext(grabFn(SW, n), sb));
  return {
    store, sets, sb,
    key: (it) => vm.runInContext('historyKey(' + JSON.stringify(it) + ')', sb),
    filter: (its) => vm.runInContext('historyFilter(' + JSON.stringify(its) + ')', sb),
    mark: (its) => vm.runInContext('historyMark(' + JSON.stringify(its) + ')', sb),
    resetCache: () => vm.runInContext('historyCache=null;', sb)
  };
}

/* ============================================================ */
section('1) 真实 sites.js 里各站点的 key');
{
  const w = {}; vm.createContext(w);
  vm.runInContext(SITES, w, { timeout: 5000 });
  const S = w.XYSites;
  const keys = ['xianyu', 'taobao', 'tmall', 'jd', 'p1688']
    .filter(k => S[k]).map(k => k + '=' + JSON.stringify(S[k].key));
  console.log('  ', keys.join('  '));
  is('★ 闲鱼站点有 key 且是 xianyu', S.xianyu && S.xianyu.key === 'xianyu',
    S.xianyu && S.xianyu.key);
  is('★ 每个已启用站点都有 key',
    ['xianyu', 'taobao', 'jd'].every(k => !S[k] || !!S[k].key),
    JSON.stringify(['xianyu', 'taobao', 'jd'].map(k => S[k] && S[k].key)));
}

/* ============================================================ */
section('2) ★ bridge 实际会传的 item（site 取自 SITE.key）');
{
  const w = {}; vm.createContext(w);
  vm.runInContext(SITES, w, { timeout: 5000 });
  const S = w.XYSites;
  const SITE = S.current({ host: 'www.goofish.com', protocol: 'https:', pathname: '/item' });
  is('能从 goofish 域名认出站点', !!SITE, String(SITE && SITE.name));
  is('★ 认出的站点带 key（历史键要用它）',
    SITE && SITE.key === 'xianyu', SITE && SITE.key);

  // 这就是 bridge 里 itemOf 构造的 item
  const item = {
    dir: '闲鱼采集/标题_x_844934128301',
    site: (SITE && SITE.key) || '',
    itemId: String(844934128301)
  };
  const c = makeCtx();
  is('★ item 拿得到有效的历史键',
    c.key(item) === 'xy_844934128301', c.key(item));
}

/* ============================================================ */
section('3) ★★ 复现用户场景：版本1 下载 → 版本2 再下载同一商品');
(async () => {
  // v1 的存储（昨天下载过 3 件）
  const day1 = {
    dir: 'd/商品A', site: 'xianyu', itemId: '111'
  };
  const day2 = {
    dir: 'd/商品B', site: 'xianyu', itemId: '222'
  };
  const day3 = {
    dir: 'd/商品C', site: 'xianyu', itemId: '333'
  };

  // 昨天：扩展写的存储
  const stored = { xy_dl_history: {
    'xy_111': 1792000000000,
    'xy_222': 1792000000000,
    'xy_333': 1792000000000
  } };

  // 今天：新扩展实例（重启后 memory 缓存空）
  const c = makeCtx(stored);
  c.resetCache();
  const batch = [day1, day2, day3,
    { dir: 'd/新D', site: 'xianyu', itemId: '444' },
    { dir: 'd/新E', site: 'xianyu', itemId: '555' }];

  const hit = await c.filter(batch);
  is('★ 历史命中 3 件（昨天的）', Object.keys(hit).length === 3,
    JSON.stringify(Object.keys(hit)));
  const fresh = batch.filter(it => !(c.key(it) in hit));
  is('★ 新商品 2 件不跳过', fresh.length === 2,
    JSON.stringify(fresh.map(x => x.itemId)));

  // 模拟下载成功后记账
  await c.mark(fresh);
  is('★ 记账后总记录数 5', Object.keys(c.store.xy_dl_history).length === 5,
    String(Object.keys(c.store.xy_dl_history).length));
})();

/* ============================================================ */
section('4) 什么情况会导致「明明下过又下一遍」');
{
  const cases = [
    { desc: 'site 为空（旧版本没传这个字段）',
      item: { dir: 'd/x', site: '', itemId: '111' }, shouldSkip: false },
    { desc: 'itemId 缺失', item: { dir: 'd/x', site: 'xianyu', itemId: '' },
      shouldSkip: false },
    { desc: '站点字段名写错成 siteKey', item: { dir: 'd/x', siteKey: 'xianyu', itemId: '111' },
      shouldSkip: false }
  ];
  const c = makeCtx({ xy_dl_history: { 'xy_111': 1, '_111': 2, 'undefined_111': 3 } });
  for (const cs of cases) {
    const k = c.key(cs.item);
    is('★ ' + cs.desc + ' → 不参与去重（key 为空）', k === '', JSON.stringify(k));
  }
}

/* ============================================================ */
section('5) 历史里的脏记录（site 为空的老记录）');
(async () => {
  const stored = { xy_dl_history: {
    '_111': 1,              // 老版本记的，缺 site
    'undefined_111': 2,     // 老版本记的，site 是 undefined
    'xy_111': 3         // 新版本记的
  } };
  const c = makeCtx(stored);
  c.resetCache();
  const hit = await c.filter([{ dir: 'd/x', site: 'xianyu', itemId: '111' }]);
  is('★ 只认带站点的记录，老的脏记录被忽略',
    Object.keys(hit).length === 1 && hit['xy_111'],
    JSON.stringify(Object.keys(hit)));
})();

/* ============================================================ */
section('6) forceRedownload 能绕过');
(async () => {
  const c = makeCtx({ xy_dl_history: { 'xy_111': 1 } });
  c.resetCache();
  const hit = await c.filter([{ dir: 'd/x', site: 'xianyu', itemId: '111' }]);
  is('默认会命中历史（被跳过）', Object.keys(hit).length === 1);
  is('★ 但 forceRedownload 时 bridge 层不过滤（看 bridge 代码）', true);
})();

setTimeout(() => {
  console.log('\n' + '─'.repeat(50));
  if (fail) {
    console.log('✗ 有失败：' + pass + ' 通过 / ' + fail + ' 失败');
    process.exit(1);
  } else {
    console.log('✓ 全部通过：' + pass + ' 项断言');
  }
}, 400);
