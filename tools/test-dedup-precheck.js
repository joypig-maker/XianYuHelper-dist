/**
 * 磁盘判重真的生效了吗（v1.8.3）
 *
 * 用户实测反馈：「下载了 30 个，再次勾选下载，插件又开始提示补齐详情了，
 * 丝毫没有跳过的意思」。查出两个真 bug：
 *
 * **Bug ①：`downloads.search` 的 filename 参数用法错了**
 *   Chrome 文档原文：filename 是 **The absolute path of the file**。
 *   我一直传「已下载标识_xy_123.txt」这种文件名片段 —— 匹配不上，
 *   所以从 v1.7.0 起磁盘判重**从来没生效过**。
 *   修法：不传 filename，拉全部记录自己按 basename 匹配。
 *
 * **Bug ②：判重在补齐详情「之后」**
 *   已下载的商品仍要先花 30 秒补齐详情，才轮到被判重跳过。
 *   用户看到的就是「又提示补齐」—— 判重形同虚设。
 *   修法：补齐前先向后台预检（xy:check-history），已下载的直接剔出队列。
 *
 * 跑：node tools/test-dedup-precheck.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SW = fs.readFileSync(path.join(ROOT, 'src/background/service_worker.js'), 'utf8');
const BR = fs.readFileSync(path.join(ROOT, 'src/content/bridge.js'), 'utf8');

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

const _w = {}; vm.createContext(_w);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/common/util.js'), 'utf8'), _w, { timeout: 5000 });
const U = _w.XYUtil;

/**
 * 模拟 Chrome 的 downloads.search —— **严格按文档行为**：
 * filename 参数要求完整绝对路径，传片段匹配不上。
 */
function makeCtx(realFiles, asFragment) {
  const disk = (realFiles || []).map(x => String(x).replace(/\\/g, '/'));
  const calls = [];
  const sb = {
    console, Promise, JSON, Object,
    U: { INFO_FILE: 'info.json' },
    chrome: {
      runtime: { lastError: null },
      downloads: {
        search(opt, cb) {
          calls.push(opt || {});
          if (asFragment || (opt && opt.filename)) {
            // 按文档：只有完整绝对路径相等才算命中
            const want = String((opt && opt.filename) || '').replace(/\\/g, '/');
            cb(disk.filter(f => f === want)
              .map(f => ({ filename: f, state: 'complete', exists: true })));
            return;
          }
          cb(disk.map(f => ({ filename: f, state: 'complete', exists: true })));
        }
      }
    }
  };
  sb.self = sb; vm.createContext(sb);
  vm.runInContext(`U.idMarkFileName = ${U.idMarkFileName.toString()};`, sb);
  vm.runInContext(`U.itemKey = ${U.itemKey.toString()};`, sb);
  vm.runInContext(`U.sitePrefix = ${U.sitePrefix.toString()};`, sb);
  vm.runInContext(grabFn(SW, 'historyOnDisk'), sb);
  return {
    calls,
    check: (its) => vm.runInContext('historyOnDisk(' + JSON.stringify(its) + ')', sb)
  };
}

const MARK = '已下载标识_xy_844934128301.txt';
const DIR = 'D:/下载/闲鱼采集/李宁_李宁童鞋_844934128301';
const ITEM = { dir: DIR, site: 'xianyu', itemId: '844934128301' };
const ON_DISK = [DIR + '/' + MARK];

(async function main() {
  section('1) ★★★ Bug ①：downloads.search 的 filename 用法');
  {
    const oldCtx = makeCtx(ON_DISK, true);
    const oldR = await oldCtx.check([ITEM]);
    is('★ 旧写法（传文件名片段）匹配不上',
      Object.keys(oldR).length === 0, JSON.stringify(Object.keys(oldR)));
    is('★ 这正是「丝毫没有跳过」的原因：磁盘上有标记也没认出来', oldCtx.calls.length === 1);
  }
  {
    const ctx = makeCtx(ON_DISK, false);
    const r = await ctx.check([ITEM]);
    is('★★ 不再传 filename 参数', ctx.calls.length === 1 && ctx.calls[0].filename === undefined,
      JSON.stringify(ctx.calls[0]));
    is('★★★ 能认出磁盘上的标记文件', !!r[ITEM.dir], JSON.stringify(Object.keys(r)));
  }

  section('2) 边界情况');
  {
    const ctx = makeCtx([], false);
    is('空输入不崩', JSON.stringify(await ctx.check([])) === '{}');
    const r1 = await ctx.check([{ dir: 'x', site: 'xianyu', itemId: '1' }]);
    is('磁盘上没有对应标记 → 不判为已下载', JSON.stringify(r1) === '{}', JSON.stringify(r1));
  }
  {
    const sb = {
      console, Promise, JSON, Object,
      U: { INFO_FILE: 'info.json' },
      chrome: {
        runtime: { lastError: null },
        downloads: {
          search(opt, cb) {
            cb([{ filename: 'D:/x/' + MARK + '.crdownload',
                  state: 'interrupted', exists: false }]);
          }
        }
      }
    };
    sb.self = sb; vm.createContext(sb);
    vm.runInContext(`U.idMarkFileName = ${U.idMarkFileName.toString()};`, sb);
    vm.runInContext(`U.itemKey = ${U.itemKey.toString()};`, sb);
    vm.runInContext(`U.sitePrefix = ${U.sitePrefix.toString()};`, sb);
    vm.runInContext(grabFn(SW, 'historyOnDisk'), sb);
    const r = await vm.runInContext('historyOnDisk(' + JSON.stringify([ITEM]) + ')', sb);
    is('★ 未完成的（interrupted）不算已下载',
      Object.keys(r).length === 0, JSON.stringify(Object.keys(r)));
  }

  section('3) ★★ Bug ②：判重必须在补齐之前');
  {
    const fn = grabFn(BR, 'withEnrichedSelected');
    const iPre = fn.indexOf('xy:check-history');
    const iWorker = fn.indexOf('async function worker');
    is('★ 前端有预检调用', iPre > 0);
    is('★★ 预检在 worker（补齐）开始之前', iPre > 0 && iPre < iWorker,
      '预检@' + iPre + ' worker@' + iWorker);
    is('★ worker 只取 todo（已剔掉下过的）',
      /i >= todo\.length/.test(fn) && /var id = todo\[i\]/.test(fn));
    is('★ 全部下过时直接返回，不进补齐',
      /if \(!todo\.length\)/.test(fn) && /都下过了/.test(fn));
    is('★ 有「N 个已下载过，将跳过」的提示', /之前已下载过，将跳过/.test(fn));
    is('★ 进度分母是 todo 而非全部勾选', fn.indexOf("done + '/' + todo.length") > 0);
    is('★ SW 有 xy:check-history 接口', /msg\.type === 'xy:check-history'/.test(SW));
    is('★ SW 的预检也走两层判重',
      /historyFilter\(probe\), historyOnDisk\(probe\)/.test(SW));
  }

  section('4) 用户这次的场景：30 个再下一遍');
  {
    const marks = [], items = [];
    for (let k = 0; k < 30; k++) {
      const id = '9000000000' + k;
      const dir = 'D:/下载/闲鱼采集/商品' + k + '_' + id;
      marks.push(dir + '/' + U.idMarkFileName('xianyu', id));
      items.push({ dir: dir, site: 'xianyu', itemId: id });
    }
    const ctx = makeCtx(marks, false);
    const r = await ctx.check(items);
    is('★★★ 30 件全部认出来（一个都不该重下）',
      Object.keys(r).length === 30, Object.keys(r).length + '/30');
    // 只有 15 个下过时
    const ctx2 = makeCtx(marks.slice(0, 15), false);
    const r2 = await ctx2.check(items);
    is('★ 只下过 15 个 → 认出 15 个',
      Object.keys(r2).length === 15, Object.keys(r2).length + '/30');
    is('★ 剩下 15 个照常处理（不会误跳）',
      items.length - Object.keys(r2).length === 15);
  }

  console.log('\n' + '─'.repeat(50));
  if (fail) {
    console.log('✗ 有失败：' + pass + ' 通过 / ' + fail + ' 失败');
    process.exit(1);
  }
  console.log('✓ 全部通过：' + pass + ' 项断言');
})();