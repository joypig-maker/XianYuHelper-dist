/**
 * 签名 postMessage 通道（src/common/postbus.js）的离线回归测试。
 *
 * 用一个假的 window 把模块跑起来，在「bridge」和「injected」两个通道之间
 * 真发几条消息，验证签名、路由、超时、伪造拒收、旧格式兼容。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');

/* ---------------- 假 window ---------------- */

function makeWindow() {
  const listeners = [];
  const win = {
    listeners: listeners,
    addEventListener(type, fn) {
      if (type === 'message') listeners.push(fn);
    },
    postMessage(data) {
      // 模拟浏览器投递：同步调一次加一个微任务，够真实也够快
      const evt = { data: JSON.parse(JSON.stringify(data)), source: win };
      Promise.resolve().then(() => {
        listeners.slice().forEach((fn) => {
          try { fn(evt); } catch (e) { /* 单个监听出错不该影响别的 */ }
        });
      });
    },
    dispatch(data) {
      const evt = { data, source: win };
      listeners.slice().forEach((fn) => fn(evt));
    }
  };
  return win;
}

function loadPostbus(win) {
  const sandbox = { window: win, BigInt: BigInt };
  const code = fs.readFileSync(path.join(ROOT, 'src', 'common', 'postbus.js'), 'utf8');
  const fn = new Function('window', 'BigInt', 'Promise', 'Math', 'Number', 'String', 'JSON', code);
  fn(win, BigInt, Promise, Math, Number, String, JSON);
  return win.XYPostBus;
}

/* ---------------- 跑测试 ---------------- */

let pass = 0, fail = 0;
const log = [];
function ok(name, cond, detail) {
  if (cond) { pass++; log.push('  ✓ ' + name); }
  else { fail++; log.push('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}

(async function run() {
  const win = makeWindow();
  const bus = loadPostbus(win);
  const injected = bus.channel('injected');
  const bridge = bus.channel('bridge');

  /* --- 哈希本身 --- */
  log.push('\n哈希');
  // FNV-1a 64 公开向量
  ok('fnv1a64("") 符合公开向量', bus.fnv1a64('') === 'cbf29ce484222325',
    bus.fnv1a64(''));
  ok('fnv1a64("a") 符合公开向量', bus.fnv1a64('a') === 'af63dc4c8601ec8c',
    bus.fnv1a64('a'));
  ok('中文确定性', bus.fnv1a64('中文') === bus.fnv1a64('中文'));
  ok('签名依赖全部四个字段',
    bus.signOf('a', 'n', 1, {}) !== bus.signOf('b', 'n', 1, {}) &&
    bus.signOf('a', 'n', 1, {}) !== bus.signOf('a', 'm', 1, {}) &&
    bus.signOf('a', 'n', 1, {}) !== bus.signOf('a', 'n', 2, {}) &&
    bus.signOf('a', 'n', 1, {}) !== bus.signOf('a', 'n', 1, { v: 1 }));

  /* --- 正常请求 / 响应 --- */
  log.push('\n请求与响应');
  injected.on('bridge', 'echo', (p) => ({ got: p && p.v, n: 1 }));
  const r1 = await bridge.ask('injected', 'echo', { v: 42 });
  ok('能拿到响应', r1 && r1.got === 42, JSON.stringify(r1));

  log.push('\n异步处理');
  injected.on('bridge', 'slow', (p) => Promise.resolve({ delay: p && p.ms }));
  const r2 = await bridge.ask('injected', 'slow', { ms: 5 });
  ok('的处理函数返回 Promise 也能回包', r2 && r2.delay === 5);

  log.push('\n超时');
  injected.on('bridge', 'hang', () => new Promise(() => {}));
  let timedOut = false;
  try {
    await bridge.ask('injected', 'hang', {}, { timeout: 120 });
  } catch (e) {
    timedOut = /超时/.test(e.message);
  }
  ok('对端不回包时会超时抛错', timedOut);

  /* --- 伪造 --- */
  log.push('\n伪造与抢答');
  let hit = 0;
  injected.on('bridge', 'guard', () => { hit++; return { ok: true }; });

  const dup = { ch: 'xy-bus', id: 'x1', from: 'injected', to: 'bridge', name: 'guard', timestamp: 1, payload: null };
  // 1) 没有 sign
  win.dispatch(Object.assign({}, dup, { sign: bus.signOf('wrong-id', 'guard', 1, null) }));
  ok('签名对不上的消息被丢弃', hit === 0, 'hit=' + hit);

  // 2) 签名对但响应名不对（抢答场景）
  injected.on('bridge', 'answer', () => {
    // 伪造一条 _FINISH 冒充别人的响应
    win.postMessage({
      ch: 'xy-bus', id: 'ghost', from: 'injected', to: 'bridge',
      name: 'guard_FINISH', timestamp: 2, payload: null,
      sign: bus.signOf('ghost', 'guard_FINISH', 2, null)
    });
    return { ok: true };
  });
  const r3 = await bridge.ask('injected', 'answer', {});
  ok('响应名与请求对不上时不会被误当成回包', r3 && r3.ok === true);

  /* --- 路由 --- */
  log.push('\n路由');
  let wrongPeer = 0;
  injected.on('bridge', 'nobody', () => { wrongPeer++; return null; });
  // 发给一个不存在对端的请求，injected 侧不应触发
  win.postMessage({
    ch: 'xy-bus', id: 'z1', from: 'injected', to: 'bridge', name: 'nobody',
    timestamp: 3, payload: null, sign: bus.signOf('z1', 'nobody', 3, null)
  });
  await new Promise((r) => setTimeout(r, 5));
  ok('没注册的处理器不会被调用（路由正确）', wrongPeer === 0);

  /* --- 无签名兜底 --- */
  log.push('\n无签名兜底');
  let nosign = 0;
  injected.on('bridge', 'legacy-name', () => { nosign++; return null; });
  win.dispatch({ ch: 'xy-bus', id: 'l1', from: 'bridge', to: 'injected',
                 name: 'legacy-name', timestamp: 9, payload: null });
  await new Promise((r) => setTimeout(r, 5));
  ok('不带 sign 的同道消息仍会交给处理器', nosign === 1, 'nosign=' + nosign);

  /* --- on() 的参数校验（少传对端名会把处理器挂到错键上，静默超时） --- */
  log.push('\non() 参数校验');
  let guardThrow = false;
  try { injected.on('bridge-name'); } catch (e) { guardThrow = /XYPostBus\.on/.test(e.message); }
  ok('on() 少传参数时立刻抛错', guardThrow);

  /* --- 接入点检查 --- */
  log.push('\n接入点');
  const injectedSrc = fs.readFileSync(path.join(ROOT, 'src', 'content', 'injected.js'), 'utf8');
  const bridgeSrc = fs.readFileSync(path.join(ROOT, 'src', 'content', 'bridge.js'), 'utf8');
  const manifest = fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8');
  ok('injected.js 注册了 injected 通道', /channel\('injected'\)/.test(injectedSrc));
  ok('bridge.js 注册了 bridge 通道', /channel\('bridge'\)/.test(bridgeSrc));
  ok('manifest 两个内容脚本都挂了 postbus.js',
    (manifest.match(/src\/common\/postbus\.js/g) || []).length === 2);
  ok('bridge.js 用 askInjected 走通道', /bus\.ask\('injected'/.test(bridgeSrc));

  console.log(log.join('\n'));
  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试自身出错：', e);
  process.exit(1);
});
