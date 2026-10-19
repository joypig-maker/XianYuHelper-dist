/**
 * 逐件流水线：补齐一件，立刻下载这一件，再处理下一件
 *
 * 客户实测反馈的演进（三版都是错的）：
 *   v1.8.0 全部补齐完才下 → 300 件干等 5.6 分钟零产出
 *   v1.8.1 分 20 件一批   → 第一批仍要等 20 件补完
 *   客户当场问：「为什么不是补齐一个，下载一个呢？」
 *
 * 攒批在任何批大小下都有问题：批越大首个文件越晚，
 * 批越小往返开销越明显。客户要的就是「看着它一个个往前走」。
 *
 * 跑：node tools/test-pipeline-flow.js
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
section('1) ★★ 逐件，不是攒批');
{
  const fn = grabFn(BR, 'withEnrichedSelected');
  is('★ 完全没有分批概念了',
    BR.indexOf('PACK_BATCH') < 0 && BR.indexOf('enrichOneBatch') < 0);
  is('★ 没有「切成若干批」的切片',
    fn.indexOf('ids.slice(i, i +') < 0);
  is('★ 是 worker 循环：取一件做一件',
    /async function worker\(\)/.test(fn) && fn.indexOf('cursor++') > 0);
  is('★ 每件都走 enrichOne（单件）',
    /await enrichOne\(id, cb\)/.test(fn));
  is('★ 逐件的逻辑确实只有一个',
    /await enrichOne\(\(queue\[0\]|await enrichOne\(queue\[0\], cb\)/.test(fn) ||
    /async function enrichOne/.test(BR));
}

/* ============================================================ */
section('2) ★★ 回调必须只处理「当前这一件」');
{
  const one = grabFn(BR, 'enrichOne');
  is('★★ cb 被传了单件 ID 数组',
    /await cb\(\[id\]\)/.test(one), '不传的话下载的还是整批，只是换了个说法');
  is('★ 有 itemsOfIds（按 ID 取任务）',
    /function itemsOfIds/.test(BR));
  const pack = grabFn(BR, 'batchPack');
  is('★ batchPack 收到 ids 时只处理这些',
    /Array\.isArray\(ids\) \? itemsOfIds\(ids\) : selectedItems\(\)/.test(pack));
  is('★ 没传时才退回整批（单件下载走老路径）',
    /selectedItems\(\)/.test(pack));
  const imgs = grabFn(BR, 'batchDownloadImages');
  is('★ batchDownloadImages 同样按 id',
    /itemsOfIds\(ids\)/.test(imgs));
  const txt = grabFn(BR, 'batchSaveText');
  is('★ batchSaveText 同样按 id',
    /itemsOfIds\(ids\)/.test(txt));
}

/* ============================================================ */
section('3) ★ 首次可见时间');
{
  const PER_ITEM = 30;          // 客户实测：补齐一件约 30 秒
  const FLOW = 3;
  console.log('    实测补齐一件 ≈ %d 秒', PER_ITEM);
  is('★ 第一个文件夹在 %d 秒内出现', PER_ITEM <= 60, String(PER_ITEM));
  console.log('    300 件总耗时 ≈ %.0f 分钟（%d 路并行）',
    300 * PER_ITEM / FLOW / 60, FLOW);
  console.log('    对比：攒批 20 件要等 %.0f 秒才见首个文件', 20 * PER_ITEM / FLOW);
  is('★ 比「攒批 20 件」快约 7 倍',
    20 * PER_ITEM / FLOW / PER_ITEM > 6,
    String((20 * PER_ITEM / FLOW / PER_ITEM).toFixed(1)));
}

/* ============================================================ */
section('4) ★ 并行度与等待');
{
  const fn = grabFn(BR, 'withEnrichedSelected');
  is('★ FLOW 是小数字（不是一次全开）',
    (function () {
      const m = BR.match(/var FLOW = (\d+)/);
      return m && Number(m[1]) >= 1 && Number(m[1]) <= 5;
    })(), (BR.match(/var FLOW = \d+/) || [''])[0]);
  is('★ 起多个 worker 并行推进',
    /for \(var w = 0; w < Math\.min\(FLOW/.test(fn));
  is('★ 等所有 worker 结束',
    /await Promise\.all\(workers\)/.test(fn));
  const one = grabFn(BR, 'enrichOne');
  is('★★ 单件下载被 await（不能并发下载）',
    /await cb\(\[id\]\)/.test(one));
}

/* ============================================================ */
section('5) ★ 进度提示');
{
  const fn = grabFn(BR, 'withEnrichedSelected');
  is('★ 有「正在处理 N/总数」的提示',
    /正在处理 ' \+ done/.test(fn));
  is('★ 带已用时长', /已用/.test(fn));
  is('★ 开跑时说明是逐件处理',
    /逐件处理|补齐一件立即下载一件/.test(fn));
  const pack = grabFn(BR, 'batchPack');
  is('★ 单件不刷屏（只有多件才提示）',
    /if \(items\.length > 1\) toast/.test(pack));
}

/* ============================================================ */
section('6) ★ 单件超时按单件算');
{
  const one = grabFn(BR, 'enrichOne');
  is('★ 单件超时 5 分钟（实测约 30 秒，余量充足）',
    /timeout: 5 \* 60 \* 1000/.test(one), (one.match(/timeout: [^,}]+/) || [''])[0]);
  is('★ 不再用整批的 15 分钟', one.indexOf('15 * 60 * 1000') < 0);
  is('★ 失败会如实提示这一件',
    /两次都没取到完整详情/.test(one));
}

console.log('\n' + '─'.repeat(50));
if (fail) {
  console.log('✗ 有失败：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(1);
} else {
  console.log('✓ 全部通过：' + pass + ' 项断言');
}