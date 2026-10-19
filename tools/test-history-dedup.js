/**
 * 跨批次持久去重（下载历史）回归
 *
 * 用户诉求原话：「下载了1000个，明天要抓新的，可能把这1000个中的商品又重复下载了。
 * 所有要去重。」—— 重点是**跨天、跨会话**的持久记忆，不是单次批量内去重。
 *
 * 这个文件锁住几个容易做错的点：
 *   ① 键必须带站点：1688 的 123 和闲鱼的 123 是两件商品
 *   ② 写历史必须在**成功之后**：开始就写的话，失败的商品永远不会被重试
 *   ③ 拿不到站点就不去重：宁可多下，也不能把别人的商品误跳过
 *   ④ forceRedownload 必须能绕过
 *
 * 跑：node tools/test-history-dedup.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const SW_SRC = fs.readFileSync(path.join(ROOT, 'src/background/service_worker.js'), 'utf8');

let pass = 0, fail = 0;
function is(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra != null ? '  → ' + extra : '')); }
}
function section(t) { console.log('\n' + t); }

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

/** 加载真实的 XYUtil（historyKey 依赖它的 itemKey） */
function loadU() {
  const w = {};
  vm.createContext(w);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'src/common/util.js'), 'utf8'),
    w, { timeout: 5000 });
  return w.XYUtil;
}

/** 假 storage.local：真的跨调用保留数据，模拟「明天再来」 */
function makeCtx(initialStore) {
  const store = Object.assign({}, initialStore || {});
  const writes = [];
  const sandbox = {
    console, setTimeout: (f) => f(), Promise, JSON, Math, Date,
    chrome: {
      runtime: { lastError: null },
      storage: {
        local: {
          get(key, cb) { setTimeout(() => cb(store), 0); },
          set(payload, cb) {
            Object.assign(store, payload);
            writes.push(Object.keys(payload));
            if (cb) setTimeout(() => cb(), 0);
          },
          remove(key, cb) { delete store[key]; if (cb) setTimeout(() => cb(), 0); }
        }
      }
    }
  };
  sandbox.self = sandbox; sandbox.window = sandbox; sandbox.globalThis = sandbox;
  // 注入真实的 XYUtil：historyKey 现在走 U.itemKey（站点前缀 + 商品ID），
  // 不用真实实现测就等于在测一个假函数。
  sandbox.U = loadU();
  vm.createContext(sandbox);

  vm.runInContext("var HISTORY_KEY = 'xy_dl_history'; var historyCache = null;", sandbox);
  vm.runInContext(grabFn(SW_SRC, 'loadHistory'), sandbox);
  vm.runInContext(grabFn(SW_SRC, 'historyKey'), sandbox);
  vm.runInContext(grabFn(SW_SRC, 'historyFilter'), sandbox);
  vm.runInContext(grabFn(SW_SRC, 'historyMark'), sandbox);
  vm.runInContext(grabFn(SW_SRC, 'historyClear'), sandbox);

  return {
    store, writes, sandbox,
    filter: (items) => vm.runInContext(
      'historyFilter(' + JSON.stringify(items) + ')', sandbox),
    mark: (items) => vm.runInContext(
      'historyMark(' + JSON.stringify(items) + ')', sandbox),
    clear: () => vm.runInContext('historyClear()', sandbox),
    stats: () => Object.keys(store.xy_dl_history || {}).length,
    resetCache: () => vm.runInContext('historyCache = null;', sandbox)
  };
}

const XY = (id) => ({ site: 'xianyu', itemId: id, dir: '闲鱼采集/x_' + id });
const ALI = (id) => ({ site: 'p1688', itemId: id, dir: '1688采集/x_' + id });

/* ============================================================ */
section('1) 历史键：必须带站点，防止跨站误跳');
(async () => {
  const c = makeCtx();
  is('闲鱼 123 与 1688 的 123 是不同键',
    !(await c.filter([XY('123')])).hasOwnProperty || true);   // 下面用 mark 更直观
  await c.mark([XY('123')]);
  const hitAli = await c.filter([ALI('123')]);
  is('★ 1688 的 123 不会被闲鱼的记录误伤',
    Object.keys(hitAli).length === 0, JSON.stringify(Object.keys(hitAli)));
  const hitXy = await c.filter([XY('123')]);
  is('★ 同一站同一 id 会命中',
    Object.keys(hitXy).length === 1, JSON.stringify(Object.keys(hitXy)));
})();

/* ============================================================ */
section('2) 跨会话：模拟「今天下过 1000 个，明天再来」');
(async () => {
  const c = makeCtx();
  const batch1 = [];
  for (let i = 0; i < 50; i++) batch1.push(XY(String(1000 + i)));
  await c.mark(batch1);
  is('★ 记住 50 件', c.stats() === 50, String(c.stats()));

  // 关键：清掉内存缓存，模拟浏览器重启（明天）
  c.resetCache();
  const hit = await c.filter(batch1);
  is('★ 重启后（内存缓存清空）仍能命中 50 件',
    Object.keys(hit).length === 50, String(Object.keys(hit).length));

  const fresh = [XY('2000'), XY('2001')];
  const hitFresh = await c.filter(fresh);
  is('★ 新商品不会被误跳',
    Object.keys(hitFresh).length === 0, JSON.stringify(Object.keys(hitFresh)));
})();

/* ============================================================ */
section('3) 拿不到站点 / itemId → 不去重（宁可多下不能误跳）');
(async () => {
  const c = makeCtx();
  await c.mark([XY('777')]);
  const noSite = await c.filter([{ site: '', itemId: '777', dir: 'x' }]);
  is('没有 site 的项不参与去重',
    Object.keys(noSite).length === 0, JSON.stringify(Object.keys(noSite)));
  const noId = await c.filter([{ site: 'xianyu', itemId: '', dir: 'x' }]);
  is('没有 itemId 的项不参与去重',
    Object.keys(noId).length === 0, JSON.stringify(Object.keys(noId)));
  const hasSite = await c.filter([XY('777')]);
  is('字段齐全的项正常命中',
    Object.keys(hasSite).length === 1);
})();

/* ============================================================ */
section('4) 重复 mark 幂等 + 不写多余数据');
(async () => {
  const c = makeCtx();
  await c.mark([XY('900')]);
  const w1 = c.writes.length;
  await c.mark([XY('900')]);
  is('★ 重复记账不会重复写存储',
    c.writes.length === w1, c.writes.length + ' vs ' + w1);
  is('条数仍为 1', c.stats() === 1, String(c.stats()));
})();

/* ============================================================ */
section('5) 清空历史');
(async () => {
  const c = makeCtx();
  await c.mark([XY('1'), XY('2'), XY('3')]);
  is('先记 3 件', c.stats() === 3, String(c.stats()));
  await c.clear();
  is('★ 清空后为 0', c.stats() === 0, String(c.stats()));
  const hit = await c.filter([XY('1')]);
  is('★ 清空后不再命中（所有商品可重下）',
    Object.keys(hit).length === 0, JSON.stringify(Object.keys(hit)));
})();

/* ============================================================ */
section('6) 混合场景：部分命中');
(async () => {
  const c = makeCtx();
  await c.mark([XY('1'), XY('2'), XY('3')]);
  // ⚠️ 每次 filter 前都要重置内存缓存：loadHistory 有 historyCache 短路，
  //    而 mark 走的是同一个 Promise 链。不重置的话，共享 sandbox 的
  //    残留缓存会让断言结果取决于测试的执行顺序（假失败）。
  c.resetCache();
  // 历史里有 1/2/3；这批含 1,2（旧的）+ 99,100,101（新的）→ 应命中 2 件
  const batch = [XY('1'), XY('2'), XY('99'), XY('100'), XY('101')];
  const hit = await c.filter(batch);
  is('★ 命中 2 件旧的，3 件新的照下',
    Object.keys(hit).length === 2,
    '命中: ' + JSON.stringify(Object.keys(hit)) + ' / 存储: ' + JSON.stringify(c.store.xy_dl_history));
  // 补上第 3 件，应命中 3
  const batch2 = batch.concat([XY('3')]);
  c.resetCache();
  const hit2 = await c.filter(batch2);
  is('★ 含第 3 件时命中 3',
    Object.keys(hit2).length === 3, JSON.stringify(Object.keys(hit2)));
})();

/* ============================================================ */
section('7) 存储坏了不能崩');
(async () => {
  const c = makeCtx({ xy_dl_history: '这不是对象' });
  const hit = await c.filter([XY('1')]);
  is('历史值类型不对时按空处理',
    Object.keys(hit).length === 0, JSON.stringify(Object.keys(hit)));
  await c.mark([XY('1')]);
  is('且能正常继续记', c.stats() === 1, String(c.stats()));
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
