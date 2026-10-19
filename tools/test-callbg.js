/**
 * callBg() / errText() 自测（node tools/test-callbg.js）
 *
 * 起因（2026-09-27）：用户加载新版本扩展后，在还开着的 1688 页面上点批量打包，
 * 报「批量打包失败：Cannot read properties of undefined (reading 'sendMessage')」。
 * 根因：页面里的内容脚本还属于旧实例，拿不到扩展 API，
 *       `chrome.runtime.sendMessage` 同步抛 TypeError。
 * 这类错重试没用，唯一出路是让内容脚本重新注入（刷新页面），
 * 所以要么提前识别并自愈，要么给人话提示 —— 这两点由本测试看住。
 *
 * 这里不从整个 bridge.js 起环境，只把这几个函数从源码里抽出来单独跑。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src/content/bridge.js'), 'utf8');

/* 从 ctxDead 开始，到 baseDir() 之前，就是callBg 这一组函数 */
const start = SRC.indexOf('function ctxDead(m)');
const end = SRC.indexOf('function baseDir()');
assert.ok(start > 0 && end > start, '没定位到 callBg 那一段源码');
const snippet = SRC.slice(start, end);

/* ---------------- 跑在被测代码上的假环境 ----------------
 * sendImpl: 描述后台/扩展 API 的行为
 *   .sendMessage  给到 runtime.sendMessage
 *   .lastError    runtime.lastError（同步读的那个）
 *   .runtimeMissing 直接把 chrome.runtime 弄成 undefined
 */
function makeCtx(sendImpl) {
  const state = { toasts: [], reloads: 0, tabsReloads: 0, session: {}, locationReloads: 0 };
  const impl = sendImpl || {};
  // tabsQuery 失败时模拟真实情况：查不到标签 → 必须降级到 location.reload()
  // 之前把 chrome.tabs.reload mock 成永远成功，正好把「自愈其实从没成功过」这个洞盖住了。
  const tabsImpl = impl.tabsFails
    ? {
      query(_q, cb) { if (cb) cb([]); },              // 查不到标签
      reload() { throw new Error('no tabId'); }        // 不带参数在内容脚本里是无效调用
    }
    : {
      query(_q, cb) { if (cb) cb([{ id: 42 }]); },
      reload(id) { if (id == null) throw new Error('no tabId'); state.tabsReloads++; }
    };
  const runtime = {
    onInstalled: { addListener() {} },
    onMessage: { addListener() {} }
  };
  if (impl.runtimeMissing) {
    // 模拟「上下文失效」：chrome.runtime 整个没了
    runtime.sendMessage = boom;
    runtime.__missing = true;
  } else {
    runtime.sendMessage = impl.sendMessage || function () { /* 什么都不做，等后台回话 */ };
  }
  runtime.lastError = impl.lastError;

  const ctx = {
    state,
    toast(msg) { state.toasts.push(msg); },
    chrome: { tabs: tabsImpl, runtime },
    // location.reload 是自愈的最后一条路，必须能被观察到
    location: { reload() { state.locationReloads++; } },
    sessionStorage: {
      setItem(k, v) { state.session[k] = v; },
      getItem(k) { return state.session[k]; },
      removeItem(k) { delete state.session[k]; }
    },
    setTimeout() {},
    document: { documentElement: { setAttribute() {}, removeAttribute() {} } }
  };
  vm.createContext(ctx);
  vm.runInContext(snippet, ctx);
  return ctx;
}

const boom = () => { throw new TypeError("Cannot read properties of undefined (reading 'sendMessage')"); };

function run(sendImpl, msg) {
  const ctx = makeCtx(sendImpl);
  const p = vm.runInContext('callBg(' + JSON.stringify(msg || { type: 'x' }) + ')', ctx);
  return p.then((res) => ({ res, ctx }));
}

function show(ctx, res) {
  return vm.runInContext('errText(' + JSON.stringify(res) + ')', ctx);
}

(async () => {
  /* 1) sendMessage 同步抛 TypeError —— 用户实际遇到的那条 */
  {
    const { res, ctx } = await run({ sendMessage: boom, lastError: undefined });
    assert.strictEqual(res.ok, false, '应判定失败');
    assert.strictEqual(res.expired, true, '应标记为上下文失效');
    assert.ok(/扩展上下文已失效/.test(res.error), 'error 应是人话，不是 TypeError: ' + res.error);
    const text = show(ctx, res);
    assert.ok(/扩展上下文已失效/.test(text), '展示文案要给指引');
    assert.strictEqual(ctx.state.tabsReloads + ctx.state.locationReloads, 1,
      '应主动刷新页面自愈（tabs 或 location 任一路径生效即可）');
    console.log('✓ 同步抛 sendMessage TypeError → 认成上下文失效，提示 + 刷新');
  }

  /* 2) chrome.runtime 整个不见了（失效上下文） */
  {
    const { res, ctx } = await run({ runtimeMissing: true });
    assert.strictEqual(res.expired, true, '应认成上下文失效');
    assert.ok(/扩展上下文已失效/.test(show(ctx, res)));
    assert.strictEqual(ctx.state.tabsReloads + ctx.state.locationReloads, 1, '同样要刷新');
    console.log('✓ chrome.runtime 缺失 → 同样认成上下文失效并刷新');
  }

  /* 3) 后台回来说 Extension context invalidated */
  {
    const { res } = await run({
      sendMessage: (m, cb) => cb(),
      lastError: { message: 'Extension context invalidated for content script.' }
    });
    assert.strictEqual(res.expired, true, '后台报的失效也要认出来');
    console.log('✓ 后台 lastError 报 context invalidated → 认成上下文失效');
  }

  /* 4) 普通的后台错误（比如限流）不能被误伤，也不能乱刷新页面 */
  {
    const { res, ctx } = await run({
      sendMessage: (m, cb) => cb(),
      lastError: { message: '服务器忙' }
    });
    assert.ok(!res.expired, '普通错误不该伪装成失效');
    assert.strictEqual(res.error, '服务器忙');
    assert.ok(/服务器忙/.test(show(ctx, res)), '原样透传');
    assert.strictEqual(ctx.state.tabsReloads + ctx.state.locationReloads, 0,
      '普通错误不该刷新页面');
    console.log('✓ 普通后台错误原样透传，且不触发刷新');
  }

  /* 5) 正常返回照旧 */
  {
    const { res } = await run({
      sendMessage: (m, cb) => cb({ ok: true, items: 3 }),
      lastError: undefined
    });
    assert.deepStrictEqual(res, { ok: true, items: 3 });
    console.log('✓ 后台正常返回时原样透传');
  }

  /* 6) 自愈的关键回归：tabs 路径不可用时必须降级到 location.reload()
   *
   * 起因（2026-10-16）：用户报「批量打包失败：拓展上下文已失效」，
   * 而代码里明明有自动刷新逻辑却从没生效过——
   * content script 里拿不到 tabId，`chrome.tabs.reload()` 不带参数是无效调用。
   * 之前的测试把 chrome.tabs.reload mock 成永远成功，正好把这个洞盖住了。
   * 这条断言就是防止它再退化回去。 */
  {
    const { res, ctx } = await run({
      sendMessage: boom,
      lastError: undefined,
      tabsFails: true            // tabs.query 返回空 + tabs.reload 抛错
    });
    assert.strictEqual(res.expired, true, '应认成上下文失效');
    show(ctx, res);
    assert.strictEqual(ctx.state.tabsReloads, 0, 'tabs 路径不该成功（它是无效调用）');
    assert.strictEqual(ctx.state.locationReloads, 1,
      '★ tabs 路径失效时必须降级到 location.reload()，否则自愈形同虚设');
    console.log('✓ tabs API 不可用时降级到 location.reload()（自愈不再形同虚设）');
  }

  /* 7) 恢复提示要能跨刷新存活：直接 toast 会被刷新冲掉 */
  {
    const { res, ctx } = await run({ sendMessage: boom, lastError: undefined });
    show(ctx, res);
    assert.ok(ctx.state.session['xy_ctx_notice'],
      '★ 应把提示写进 sessionStorage，否则页面一刷新用户就看不到任何解释');
    console.log('✓ 恢复提示写入 sessionStorage，刷新后仍可补显');
  }

  console.log('\n全部测试通过 ✅');
})().catch((e) => {
  console.error('测试失败：', e.message);
  process.exit(1);
});
