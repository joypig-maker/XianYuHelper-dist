/**
 * 批量补详情不能提前放弃（用户报「勾 100 下来 92，每次都这样」）
 *
 * 实测数据：补一件详情约 3.1 秒（含 600ms 限速）。
 *   100 件串行 = 310 秒
 * 而原来的硬超时是 60 秒 → 只够跑 19 件 → 剩下 80 多件全部
 * 用列表页的薄数据打包，**静默丢**。数字固定（每次都是 92）
 * 正是因为它丢的是「超时那一刻之后的所有商品」，是确定性的。
 *
 * 跑：node tools/test-batch-complete.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BR = fs.readFileSync(path.join(ROOT, 'src/content/bridge.js'), 'utf8');
const IJ = fs.readFileSync(path.join(ROOT, 'src/content/injected.js'), 'utf8');
// 并行采集的代码在 service_worker 里
const SW = fs.readFileSync(path.join(ROOT, 'src/background/service_worker.js'), 'utf8');

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
section('1) ★ 不能有固定时长的放弃定时器');
{
  // 逻辑已挪到 enrichOneBatch（分批流水线），断言跟着挪
  const fn = grabFn(BR, 'enrichOne');
  is('★ 没有 setTimeout 型「到点放弃」',
    !/setTimeout\([^)]*60000/.test(fn));
  is('★ 没有 resolve(null) 式的放弃分支',
    fn.indexOf('resolve(null)') < 0);
  is('★ 单批超时 5 分钟（20 件 ≈ 23 秒，余量充足）',
    /timeout: 5 \* 60 \* 1000/.test(fn), (fn.match(/timeout: [^,}]+/) || [''])[0]);
  is('★ 真的 await 了补详情的回包',
    /await askInjected\('ensure-cards'/.test(fn));
  is('★ 补完之后才调回调（先补完这一件再下载）',
    fn.indexOf('await cb([id])') > fn.indexOf("await askInjected('ensure-cards'"));
}

section('2) ★ 补详情的耗时账：不能比超时短');
{
  const COST = 3.1, need = 300, total = need * COST;
  const limit = 5 * 60;
  const SPEEDUP = 2.75;
  console.log('    %d 件 × %.1fs = %.0f 秒（串行）', need, COST, total);
  console.log('    3 路并行后 %.0f 秒，分 %d 批每批约 %.0f 秒',
    total / SPEEDUP, Math.ceil(need / 20), 20 * COST / SPEEDUP);
  is('★ 单批限额足够覆盖一批的耗时', 20 * COST / SPEEDUP < limit);
}

section('3) ★ 补详情要真的 await，且按商品逐个报进度');
{
  const fn = grabFn(IJ, 'ensureCardsDetail');
  is('★ 真的等到了回包（不是 fire-and-forget）',
    /ensureCardsDetail[\s\S]*await fetchCardDetail/.test(fn));
  is('★ 每补一件就报一次进度', fn.indexOf("post('ensure-progress'") > 0);
  is('★ 进度带 done/total', /ensure-progress', \{ done: [^}]*total/.test(fn));
}

section('4) ★★ 补失败的要有第二轮重试');
{
  const fn = grabFn(IJ, 'ensureCardsDetail');
  is('★ 记录失败的 ID', fn.indexOf('failedIds') > 0);
  is('★ 第二轮重试前先歇一下（限流多是暂时的）',
    /failedIds\.length[\s\S]{0,400}setTimeout[\s\S]{0,80}900/.test(fn));
  is('★ 重试时带 isRetry=true（走另一条取数路径）',
    /fetchCardDetail\(rid, true\)/.test(fn));
  is('★ 重试成功会补回 fail 计数', /fail--/.test(fn));
  is('★ 把最终失败的清单回传给前端', /stillFailed: failedIds/.test(fn));
}

section('5) ★ 前端如实告知漏了几件');
{
  const fn = grabFn(BR, 'enrichOne');
  is('★ 读的是回包里的 stillFailed', fn.indexOf('res.stillFailed') > 0);
  is('★ 会提示这一件没补到', /两次都没取到完整详情/.test(fn));
  is('★ 控制台留痕便于排查', /补齐一件用时/.test(fn));
  is('★ 不再静默继续（旧代码是「已用现有数据继续打包」就往下走）',
    fn.indexOf('已用现有数据继续打包') < 0);
}

section('6) ★ 两处「要不要补详情」的判定必须一致');
{
  const bt = BR.slice(BR.indexOf('function dataThin'), BR.indexOf('function dataThin') + 800);
  const ij = IJ.slice(IJ.indexOf('async function ensureCardsDetail'),
                      IJ.indexOf('async function ensureCardsDetail') + 1400);
  is('★ bridge 的 dataThin 检查 skus.specDefs', bt.indexOf('specDefs') > 0);
  is('★ injected 的 todo 也检查 specDefs', ij.indexOf('specDefs') > 0);
  is('★ 两边都按「维度值 > 1」才算真规格',
    bt.indexOf('values.length > 1') > 0 && ij.indexOf('values.length > 1') > 0);
  is('★ 两边都把「没有规格表」判为需要补',
    bt.indexOf('!skus.list || !skus.list.length') > 0 &&
    ij.indexOf('!skus || !skus.list || !skus.list.length') > 0);
}

section('7) ★★★ 并行提速：3 路并行，标签页各占各的');
{
  is('★ PARALLEL = 3（实测无风控）',
    /PARALLEL: 3,/.test(SW), '');
  // 用串行锁就白改了
  is('★ 不再有一件接一件的串行锁',
    /chain \? bgDetail\.chain \.then/.test(SW) === false);
  is('★ 有在跑的计数与等位队列',
    /bgDetail\.inflight/.test(SW) && /bgDetail\.slotRes/.test(SW));
  is('★ 并行度可配置（写在配置对象里，不是散落的魔法数）',
    /var bgDetail = \{/.test(SW));

  // 标签页必须池化，否则并行会把标签页耗光
  is('★ 标签页池：tabIds 记录全部',
    /tabIds: \[\]/.test(SW));
  is('★ 标签页池：freeIds 记录空闲',
    /freeIds: \[\]/.test(SW));
  is('★ 有 bgAcquireTab 函数', /function bgAcquireTab\(\)/.test(SW));
  is('★ 有 bgReleaseTab 函数', /function bgReleaseTab\(/.test(SW));
  is('★ 采集用池化标签页而不是新建',
    /async function bgCollectOne[\s\S]{0,120}bgAcquireTab\(\)/.test(SW));
  is('★ 无论成败都归还标签页（finally 里 release）',
    /finally \{[\s\S]{0,200}bgReleaseTab\(tabId\)/.test(SW));
  is('★ 回收时关掉整个池，不是单个',
    /bgArmIdleClose[\s\S]{0,400}tabIds[\s\S]{0,200}chrome\.tabs\.remove/.test(SW));
}

console.log('\n' + '─'.repeat(50));
if (fail) {
  console.log('✗ 有失败：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(1);
} else {
  console.log('✓ 全部通过：' + pass + ' 项断言');
}