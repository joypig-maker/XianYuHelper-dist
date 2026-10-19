/**
 * 任务泵 pump 的并发语义回归
 *
 * 这次踩的坑：pump 原来把「任务队列取空」当成「全部完成」。
 * 并发位没占满时会提前结算——比如只有 2 个任务、上限 3，两个同时启动，
 * 快的那个（info.json 走 data URL）一完成就 resolve，慢的（网络图片）还在下，
 * 调用方拿到的 images 计数就是 0。
 *
 * 表现：京东搜索页每个商品只有 1 张主图 → 界面永远显示「图片 0/1 张」，
 * 看着像一张都没下（其实文件好好的）。
 * 既有的 test-batch 用的是 3 张图，图片任务多、info 排在后面，正好绕过了这个形状。
 *
 * 直接把 pump 从 service_worker.js 里抠出来单独跑，不依赖任何 mock DOM。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('✓ ' + name); }
  else { fail++; console.log('✗ ' + name + (extra ? '  → ' + extra : '')); }
}

/** 从源码里抠出一个函数（按花括号配平） */
function extractFn(src, sig) {
  const i = src.indexOf(sig);
  if (i < 0) return '';
  const j = src.indexOf('{', i);
  let d = 0;
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
  return '';
}

const SW = fs.readFileSync(path.join(ROOT, 'src/background/service_worker.js'), 'utf8');
const fnSrc = extractFn(SW, 'function pump(');

const ctx = vm.createContext({});
vm.runInContext(fnSrc + '\nthis.__pump = pump;', ctx);
const pump = (ctx.__pump).bind(null);

(async () => {
  console.log('=== ① 并发位没占满时，不能提前结算（这次的 bug） ===');
  {
    let slowDone = false;
    let fastDone = false;
    // 2 个任务、上限 3：两个会同时启动。
    // 第二个几乎瞬时完成，第一个要 60ms——老实现会被第二个触发结算。
    const t0 = Date.now();
    const r = await pump([
      () => new Promise((res) => setTimeout(() => { slowDone = true; res(true); }, 60)),
      () => { fastDone = true; return Promise.resolve(true); }
    ], 3);
    const ms = Date.now() - t0;

    ok('慢任务被等到了（不是提前结算）', slowDone, 'slowDone=' + slowDone);
    ok('快任务也算了', fastDone);
    ok('ok 计数是 2 而不是 1', r.ok === 2, JSON.stringify(r));
    ok('确实等了慢任务那么久（≥50ms）', ms >= 50, ms + 'ms');
  }

  console.log('\n=== ② 单张图 + 瞬时 info.json 的最小复现 ===');
  {
    // 这就是京东的形状：图片（慢） + info.json（瞬时），上限 3 → 两个同时起跑
    let imgDone = false;
    const r = await pump([
      () => new Promise((res) => setTimeout(() => { imgDone = true; res(true); }, 50)),
      () => Promise.resolve(true)
    ], 3);
    ok('图片任务完成前不会返回', imgDone, 'imgDone=' + imgDone);
    ok('ok=2', r.ok === 2, JSON.stringify(r));
  }

  console.log('\n=== ③ 常规并发（超过上限要排队） ===');
  {
    let peak = 0;
    let now = 0;
    const mk = () => () => {
      now++;
      peak = Math.max(peak, now);
      return new Promise((res) => setTimeout(() => { now--; res(true); }, 20));
    };
    const r = await pump([mk(), mk(), mk(), mk(), mk()], 2);
    ok('5 个任务全部完成', r.ok === 5, JSON.stringify(r));
    ok('并发没超过上限 2', peak <= 2, 'peak=' + peak);
  }

  console.log('\n=== ④ 失败与异常都要计入 ===');
  {
    const r = await pump([
      () => Promise.resolve(true),
      () => Promise.resolve(false),                 // 自己返回失败
      () => Promise.reject(new Error('炸了')),      // reject
      () => { throw new Error('同步抛'); },          // 同步抛
      () => Promise.resolve(true)
    ], 3);
    ok('ok 只算成功的 2 个', r.ok === 2, JSON.stringify(r));
    ok('fail 是 3 个', r.fail === 3, JSON.stringify(r));
  }

  console.log('\n=== ⑤ 边界 ===');
  {
    const r0 = await pump([], 3);
    ok('空数组直接返回 0/0', r0.ok === 0 && r0.fail === 0, JSON.stringify(r0));
    const r1 = await pump([() => Promise.resolve(true)], 3);
    ok('单个任务', r1.ok === 1, JSON.stringify(r1));
    const rNo = pump(null, 3);
    ok('传 null 不炸', !!(rNo && rNo.then));
    const pr = pump(undefined, 3);
    const rU = await pr;
    ok('传 undefined 不炸且返回 0/0', rU.ok === 0 && rU.fail === 0, JSON.stringify(rU));
    const rLimit = await pump([() => Promise.resolve(true), () => Promise.resolve(true)], 0);
    ok('limit=0 也能跑完（兜底到 1）', rLimit.ok === 2, JSON.stringify(rLimit));
  }

  console.log('\n=== ⑥ 源码里必须留着 in-flight 计数 ===');
  {
    // 契约层：这个修复很容易被"简化"回去，锁一下
    ok('pump 里有 running 计数', /var idx = 0, ok = 0, fail = 0, running = 0/.test(fnSrc));
    ok('取空任务时还要看 running', /if \(idx >= list\.length\)[\s\S]{0,120}running === 0/.test(fnSrc));
    ok('收尾时递减 running', /running--;\s*\n\s*next\(\);/.test(fnSrc));
  }

  console.log('\n———————————————————————————————');
  console.log((fail === 0 ? '✓ 全部通过' : '✗ 有失败') + '：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail ? 1 : 0);
})();
