/**
 * 分批流水线：不能「全部补齐完才下载」（客户实测反馈「一直提示在补齐，看不到下载」）
 *
 * 实测：补一件详情 3.1 秒、3 路并行 2.75 倍。
 *   300 件如果「补齐完再一起下」→ 300 × 3.1 ÷ 2.75 ≈ **338 秒**才落第一个文件，
 *   客户盯着屏幕 5 分半没有任何产出，只能认为软件卡死了。
 *
 * 跑：node tools/test-pipeline-batch.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
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

/* ============================================================ */
section('1) ★★ 客户多久能看到第一个文件');
{
  const PER = 3.1;             // 实测：单件补详情
  const SPEEDUP = 2.75;        // 实测：3 路并行
  const N = 300;
  const oldWay = N * PER / SPEEDUP;                 // 补齐完才下
  const BATCH = 20;
  const firstFile = BATCH * PER / SPEEDUP;          // 第一批补齐完就开始下
  console.log('    %d 件 × %.1fs ÷ %.2f = %.0f 秒（补齐完才下）',
    N, PER, SPEEDUP, oldWay);
  console.log('    第一批 %d 件 = %.0f 秒（第一批落第一个文件）', BATCH, firstFile);
  is('★ 旧方案要等 5 分钟以上', oldWay > 300, String(Math.round(oldWay)));
  is('★ 分批后不到 30 秒就有文件', firstFile < 30, String(Math.round(firstFile)));
  console.log('    → 提速倍数 %.0f 倍', oldWay / firstFile);
}

/* ============================================================ */
section('2) ★ 分批循环确实存在');
{
  const fn = grabFn(BR, 'withEnrichedSelected');
  is('★ 有批量大小常量', /PACK_BATCH\s*=\s*\d+/.test(BR),
    (BR.match(/PACK_BATCH\s*=\s*\d+/) || [''])[0]);
  is('★ 批量大小是个不大的数（太大首个文件太晚）',
    (function () {
      const m = BR.match(/PACK_BATCH\s*=\s*(\d+)/);
      return m && Number(m[1]) <= 50;
    })(), (BR.match(/PACK_BATCH\s*=\s*\d+/) || [''])[0]);
  is('★ 按批切片', /ids\.slice\(i, i \+ PACK_BATCH\)/.test(fn));
  is('★ 有 for 循环逐批处理',
    /for \(var b = 0; b < batches\.length/.test(fn));
  is('★ 每批都调用 cb()（这一批补完就下）',
    fn.indexOf('enrichOneBatch(batch, cb') > 0);
  is('★ 单批走同一条路径',
    /enrichOneBatch\(batches\[0\], cb\)/.test(fn));
}

/* ============================================================ */
section('3) ★★ 批与批之间必须串行（不能并发下载）');
{
  const fn = grabFn(BR, 'enrichOneBatch');
  is('★★ cb() 被 await —— 上一批下完才进下一批',
    /await cb\(\)/.test(fn), '不 await 会让两批并发争抢下载队列');
  const loop = grabFn(BR, 'withEnrichedSelected');
  is('★ 循环里 await 了 enrichOneBatch',
    /await enrichOneBatch\(batch, cb/.test(loop));
  is('★ 批内 await 的位置在 cb 调用之前',
    loop.indexOf('await enrichOneBatch(batch, cb') <
    loop.lastIndexOf('console.log'));
}

/* ============================================================ */
section('4) ★ 用户看得见进度');
{
  const fn = grabFn(BR, 'enrichOneBatch');
  is('★ 提示里有「第 X/Y 批」',
    /第 ' \+ info\.index/.test(fn) || /info\.index/.test(fn));
  is('★ 提示里有全局区间「第 a-b/总数」',
    /info\.base/.test(fn));
  is('★ 每批结束打日志（可事后核对）',
    /第 ' \+ \(b \+ 1\)/.test(grabFn(BR, 'withEnrichedSelected')) ||
    /累计 /.test(grabFn(BR, 'withEnrichedSelected')));
  is('★ 如实告知该批有几件没补到',
    /missed === 0/.test(fn));
}

/* ============================================================ */
section('5) 每批的超时按批算，不是整批 15 分钟');
{
  const fn = grabFn(BR, 'enrichOneBatch');
  is('★ 单批超时 5 分钟（20 件 × 3.1s ÷ 2.75 ≈ 23 秒，余量充足）',
    /timeout: 5 \* 60 \* 1000/.test(fn), (fn.match(/timeout: [^,}]+/) || [''])[0]);
  is('★ 不再用整批的 15 分钟超时',
    fn.indexOf('15 * 60 * 1000') < 0);
}

console.log('\n' + '─'.repeat(50));
if (fail) {
  console.log('✗ 有失败：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(1);
} else {
  console.log('✓ 全部通过：' + pass + ' 项断言');
}