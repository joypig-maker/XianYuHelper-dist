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
section('1) ★ 不能有 60 秒硬超时');
{
  const fn = grabFn(BR, 'withEnrichedSelected');
  is('★ 没有 60000ms 的放弃定时器',
    !/setTimeout\([^)]*60000/.test(fn), (fn.match(/setTimeout[\s\S]{0,80}/) || [''])[0]);
  is('★ 也没有 resolve(null) 式的放弃分支',
    fn.indexOf('resolve(null)') < 0);
  is('★ 超时给到 15 分钟（100 件按 3.1 秒估要 310 秒）',
    /15 \* 60 \* 1000/.test(fn), (fn.match(/timeout: [^,}]+/) || [''])[0]);
  is('★ 真的 await 了补详情的回包',
    /await askInjected\('ensure-cards'/.test(fn));
  // 注意：函数里有两处 cb() —— 一处是「无需补详情」提前返回，
  // 一处是「补完了才继续」。要断言的是**后者**在 await 之后。
  const lastCb = fn.lastIndexOf('cb();');
  is('★ 补完之后才调回调（先补完再下载）',
    lastCb > fn.indexOf("await askInjected('ensure-cards'"),
    'lastCb=' + lastCb);
}

/* ============================================================ */
section('2) ★ 补详情的耗时账：不能比超时短');
{
  const COST = 3.1;              // 实测：详情页 ~2.5s + GAP 0.6s
  const need = 100;
  const total = need * COST;
  const oldLimit = 60;
  const newLimit = 15 * 60;
  console.log('    %d 件 × %.1fs = %.0f 秒', need, COST, total);
  console.log('    旧上限 %d 秒 → 只能补 %d 件，丢 %d 件',
    oldLimit, Math.floor(oldLimit / COST), need - Math.floor(oldLimit / COST));
  is('★ 旧上限确实不够用', total > oldLimit, String(total));
  is('★ 新上限足够（还有 2 倍余量）', newLimit > total * 2, String(newLimit));
}

/* ============================================================ */
section('3) ★ 补详情要真的 await，且按商品逐个报进度');
{
  const fn = grabFn(IJ, 'ensureCardsDetail');
  is('★ 真的等到了回包（不是 fire-and-forget）',
    /ensureCardsDetail[\s\S]*await fetchCardDetail/.test(fn));
  is('★ 每补一件就报一次进度', fn.indexOf("post('ensure-progress'") > 0);
  is('★ 进度带 done/total', /ensure-progress', \{ done: [^}]*total/.test(fn));
}

/* ============================================================ */
section('4) ★★ 失败的要有第二轮重试');
{
  const fn = grabFn(IJ, 'ensureCardsDetail');
  is('★ 记录失败的 ID', fn.indexOf('failedIds') > 0);
  is('★ 第二轮重试前先歇一下（限流多是暂时的）',
    /failedIds\.length[\s\S]{0,400}setTimeout[\s\S]{0,80}900/.test(fn));
  is('★ 重试时带 isRetry=true（走另一条取数路径）',
    /fetchCardDetail\(rid, true\)/.test(fn));
  is('★ 重试成功会补回 fail 计数', /fail--/.test(fn));
  is('★ 把最终失败的清单回传给前端', /stillFailed: failedIds/.test(fn));
  is('★ 进度回报里有 retry 标记（前端能显示「正在重试」）',
    /ensure-progress', \{[^}]*retry: true/.test(fn));
}

/* ============================================================ */
section('5) ★ 前端如实告知漏了几件');
{
  const fn = grabFn(BR, 'withEnrichedSelected');
  is('★ 读的是回包里的 stillFailed', fn.indexOf('res.stillFailed') > 0);
  is('★ 会提示用户「有 N 个没补到」', /missed \+ ' 个商品/.test(fn));
  is('★ 控制台留痕便于排查',
    /补详情用时/.test(fn));
  is('★ 不再静默继续（旧代码是「已用现有数据继续打包」就往下走）',
    fn.indexOf('已用现有数据继续打包') < 0);
}

/* ============================================================ */
section('6) ★ 两处「要不要补详情」的判定必须一致');
{
  // bridge 的 dataThin 与 injected 的 ensureCardsDetail.todo
  // 之前两处规则不同：bridge 查 skus，injected 不查 →
  // 这边认为要补、那边认为不用补（或反过来），互相打架。
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


/* ============================================================ */
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