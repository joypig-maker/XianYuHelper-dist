/**
 * 「勾选 -> 一键打包」链路自测（node tools/test-packchain.js）
 *
 * 背景：用户勾选商品后点「勾选一键打包」，一个文件都没下载，也没有任何报错。
 * 根因是桥接层的一处死链——bridge 发出 ensure-cards 后就不管了，
 * 指望对端回一条 ensure-done 来唤醒批量动作，
 * 而那条消息从来没有任何地方发出过（注入端根本没有）。
 * 于是只要卡片数据偏薄（列表页常态：没描述、主图不足两张）
 * 就会走这条分支，回调永远不触发。
 *
 * 这个脚本锁两件事：
 *   1. 通道能力：postbus 的 ask 能等住异步 handler，把结果带回 await 方
 *   2. 代码契约：桥接层两侧的消息收发必须对得上，不许再出现无人发出的消息
 *
 * bridge.js 本身依赖真实 DOM，离线跑不起来，所以这里测的是
 * 「通道语义 + 源码契约」，真机上的点击链路仍需手工过一遍。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const INJ = fs.readFileSync(path.join(ROOT, 'src/content/injected.js'), 'utf8');
const BRG = fs.readFileSync(path.join(ROOT, 'src/content/bridge.js'), 'utf8');
const EXT = fs.readFileSync(path.join(ROOT, 'src/common/extract.js'), 'utf8');

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('✓ ' + name); }
  else { fail++; console.log('✗ ' + name + (extra ? '  → ' + extra : '')); }
}

/** 从 from 处开始按花括号配对取出一整个函数体 */
function grabBody(src, from) {
  let i = src.indexOf('{', from);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(from, i + 1);
    }
  }
  return src.slice(from);
}

/** 从 from 处开始按花括号配对取出一整个函数体 */

/* ================= 1. 通道：异步 handler 的完成信号能传回来 ================= */

function makeWindow() {
  const listeners = [];
  return {
    listeners,
    addEventListener(type, fn) { if (type === 'message') listeners.push(fn); },
    postMessage(data) {
      const ev = { data, source: this };
      // 浏览器里 postMessage 是异步派发的，这里也异步，别把顺序测成巧合
      setTimeout(() => {
        listeners.slice().forEach((fn) => {
          try { fn(ev); } catch (e) { console.log('    listener 抛错：' + e.message); }
        });
      }, 0);
    }
  };
}

(async () => {
  console.log('== 通道：异步回包 ==');

  const win = makeWindow();
  win.setTimeout = setTimeout;
  win.clearTimeout = clearTimeout;
  win.Promise = Promise;
  win.BigInt = BigInt;
  vm.runInNewContext(
    fs.readFileSync(path.join(ROOT, 'src/common/postbus.js'), 'utf8'),
    win, { timeout: 5000 }
  );

  const bus = win.XYPostBus;
  ok('postbus 已挂载到 window', !!bus);

  const injected = bus.channel('injected');
  const bridge = bus.channel('bridge');

  // 模拟注入端的 ensure-cards：补详情是耗时操作，handler 返回的是 promise
  let resolved = false;
  injected.on('bridge', 'ensure-cards', (p) => {
    return new Promise((resolve) => {
      setTimeout(() => {
        resolved = true;
        resolve({
          done: p.ids.length, fail: 0, total: p.ids.length,
          skus: { done: 1, fail: 0, total: 1 }
        });
      }, 30);
    });
  });

  // 复刻 withEnrichedSelected 的等待方式：等回包，而不是发完就不管
  const t0 = Date.now();
  const raced = await new Promise((resolve) => {
    bridge.ask('injected', 'ensure-cards', { ids: ['70000001', '70000002'] }, { timeout: 3000 })
      .then(resolve);
  });
  const wait = Date.now() - t0;

  ok('回包里带上了异步结果', !!raced && raced.done === 2, JSON.stringify(raced));
  ok('确实是等 handler 跑完才回来（不是立刻返回）', resolved && wait >= 25, 'wait=' + wait + 'ms');
  ok('补详情结果里带多规格战绩（用于成功提示）', !!(raced && raced.skus),
    JSON.stringify(raced && raced.skus));

  // 反例：handler 不存在时应当超时报错，而不是永远挂着
  const t1 = Date.now();
  let timedOut = false;
  try {
    await bridge.ask('injected', 'nope-not-registered', {}, { timeout: 300 });
  } catch (e) {
    timedOut = /超时/.test(e.message);
  }
  ok('没有注册的消息会超时报错（不会被静默吞掉）', timedOut && Date.now() - t1 < 2000);

  /* ================= 2. 源码契约：桥接两侧不许再有断链 ================= */

  console.log('\n== 源码契约 ==');

  // 取某个模式的捕获组。用 exec 拿 group[1]——
  // 别再拿匹配到的整串做一次简单匹配，那会取到第一个引号里的内容
  function names(src, re) {
    const out = [];
    const rx = new RegExp(re.source, 'g');
    let m;
    while ((m = rx.exec(src))) out.push(m[1]);
    return out;
  }

  // 注入端发出的消息名
  const sentByInjected = new Set([
    ...names(INJ, /post\(\s*'([a-z-]+)'/),
    ...names(INJ, /bus\.push\(\s*'bridge'\s*,\s*'([a-z-]+)'/),
    ...names(EXT, /bus\.push\(\s*'bridge'\s*,\s*'([a-z-]+)'/),
    // 注入端也会「反向询问」bridge。它跑在 MAIN world、拿不到 chrome API，
    // 有些事只能请 bridge 代劳（借后台标签页补详情 = bg-detail 就是这条），
    // 所以这种 ask 同样算「注入端发出去的消息」，别当成孤儿。
    ...names(INJ, /bus\.ask\(\s*'bridge'\s*,\s*'([a-z-]+)'/)
  ]);

  // bridge 发出的询问名（要等回包）
  const askedByBridge = new Set([
    ...names(BRG, /bus\.ask\(\s*'injected'\s*,\s*'([a-z-]+)'/),
    ...names(BRG, /askInjected\(\s*'([a-z-]+)'/)
  ]);

  // 两侧各自的接收端
  const recvInjected = new Set(names(INJ, /bus\.on\(\s*'bridge'\s*,\s*'([a-z-]+)'/));
  const recvBridge = new Set(names(BRG, /bus\.on\(\s*'injected'\s*,\s*'([a-z-]+)'/));

  console.log('  注入端发出: ' + [...sentByInjected].sort().join(', '));
  console.log('  bridge 询问: ' + [...askedByBridge].sort().join(', '));
  console.log('  注入端接收: ' + [...recvInjected].sort().join(', '));
  console.log('  bridge 接收: ' + [...recvBridge].sort().join(', '));

  // ① bridge 问的事，注入端必须有人接——否则是打空炮
  const unanswered = [...askedByBridge].filter((n) => !recvInjected.has(n));
  ok('bridge 询问的每个消息名，注入端都有处理器', unanswered.length === 0,
    '没人接：' + unanswered.join(', '));

  // ② bridge 侧注册了接收端的消息，必须真的有人发。
  //    这条就是本次事故的直接复发点：ensure-done 曾经有接收、无发送。
  const orphans = [...recvBridge].filter((n) => !sentByInjected.has(n) && !askedByBridge.has(n));
  ok('bridge 侧没有「只接收、从不发送」的孤儿消息', orphans.length === 0,
    '孤儿：' + orphans.join(', '));

  // ③ 本次回归的直接锁定：补齐详情必须真的被等，回调只能在等完之后触发
  const wiAt = BRG.indexOf('async function withEnrichedSelected');
  const askAt = wiAt > -1 ? BRG.indexOf("askInjected('ensure-cards'", wiAt) : -1;
  const cbAt = wiAt > -1 ? BRG.indexOf('\n    cb(', wiAt) : -1;
  ok('withEnrichedSelected 里发出了 ensure-cards', askAt > wiAt && askAt > -1);
  ok('回调 cb 在 ensure-cards 之后才被调用（不是发完就跑）',
    cbAt > askAt && cbAt > -1, 'ask@' + askAt + ' cb@' + cbAt);
  // [^;] 是关键：中间夹一个分号就说明调用已经结算完毕、
  // 后面的 .then 属于另一条不相干的语句链（fire-and-forget 就是这个形态）
  ok('ensure-cards 的返回被 then 消费（不再 fire-and-forget）',
    /askInjected\(\s*'ensure-cards'[^;]{0,80}?\.then\(/.test(BRG));

  // ④ 补详情拖太久时要有兜底，不能让人无限等
  ok('补详情有超时兜底（不会无限等待）',
    /setTimeout\(function \(\)[\s\S]{0,160}?resolve\(null\)/.test(BRG));

  // ⑤ 死代码清理：pendingBatch / ensure-done 那套间接层已废弃，
  //    留着会让人以为还有一条完成信号的路子
  ok('已移除不再发出的 ensure-done 接收端', !/on\(\s*'injected'\s*,\s*'ensure-done'/.test(BRG));
  ok('已移除 pendingBatch 间接层', !/pendingBatch/.test(BRG));

  // ⑥ 批量动作要能吃下补齐结果。
  //    之前这里写成 `(enriched)?`——参数可有可无，结果 batchDownloadImages
  //    函数体里用了 enriched 却没在签名里声明，跑起来直接 ReferenceError，
  //    测试照样是绿的。所以改成「用了就得声明」这条通用规则。
  const batchFns = [...BRG.matchAll(/function (batch\w+)\(([^)]*)\)\s*\{/g)];
  ok('至少找到三个批量动作', batchFns.length >= 3, '实际 ' + batchFns.length + ' 个');
  batchFns.forEach((m) => {
    const body = grabBody(BRG, m.index);
    const uses = /\benriched\b/.test(body);
    ok((uses ? '· ' + m[1] + ' 用了 enriched，签名已声明' : '· ' + m[1] + ' 未引用 enriched'),
      !uses || /enriched/.test(m[2]), '声明的参数：(' + m[2] + ')');
  });

  // 不再尝试用正则扫描「未声明变量」：res.images、settings.imgPrefix
  // 这类属性访问会被误判成自由变量，误报一堆反而掩盖真问题。
  // 真要抓 ReferenceError，靠下面这条精确规则 + 真机跑一遍更实在。

  // ⑦ askInjected 必须返回 promise，否则调用方没法 await
  ok('askInjected 在无 postbus 时仍返回 promise（旧通道不会把人卡死）',
    /window\.postMessage\(\{[\s\S]{0,120}?return Promise\.resolve\(null\);/.test(BRG));

  console.log('\n' + (fail === 0 ? '全部通过 ✅  ' + pass + ' 项' : '失败 ' + fail + ' 项 / 通过 ' + pass + ' 项'));
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('\n测试自身出错：' + e.stack);
  process.exit(2);
});
