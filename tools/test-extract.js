/**
 * 三级取值兜底（src/common/extract.js）的离线回归测试。
 *
 * 用一个假 window + 假 DOM 元素 + 假 fiber 把 L1（window 全局数据）
 * 和 L2（React fiber）跑一遍——这两级只有在 MAIN world 里才看得见，
 * 离线只能靠搭假的 DOM 对象来验逻辑。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* ---------------- 假环境 ---------------- */

function loadCode(code, win) {
  // 和浏览器里注入顺序一致：模块都是 (function(root){...})(window) 形态
  new Function('window', 'document', 'location', 'setTimeout', 'Object', code)(
    win, win.document, win.location, setTimeout, Object);
  return win;
}

/** 假 DOM 元素：只实现 fiber 扫描用到的那几个方法 */
function makeEl(props) {
  const el = Object.assign({
    nodeType: 1,
    attrs: Object.assign({}, props && props.attrs),
    getAttribute(n) { return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null; },
    setAttribute(n, v) { this.attrs[n] = String(v); }
  }, props);
  return el;
}

/** 元素 + 挂在它上面的 fiber（键名带随机后缀，和真的 React 一致） */
function makeFiberEl(fiber, attrs) {
  const el = makeEl({ attrs: attrs || {} });
  el[Object.getOwnPropertySymbols && '__reactFiber$abc123'] = fiber;
  return el;
}

function makeDoc(els) {
  return { querySelectorAll: () => els };
}

function makeWin(extra) {
  return Object.assign({
    // postbus 在加载时就会往 window 上挂 message 监听
    addEventListener() {},
    document: makeDoc([]),
    location: { href: 'https://s.1688.com/x' }
  }, extra || {});
}

/* ---------------- 跑测试 ---------------- */

let pass = 0, fail = 0;
const log = [];
function ok(name, cond, detail) {
  if (cond) { pass++; log.push('  ✓ ' + name); }
  else { fail++; log.push('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}

function freshBus() {
  // 假通道：记录 push 出去的消息
  const sent = [];
  const bus = {
    push(peer, name, payload) { sent.push({ peer, name, payload }); },
    on() { return function () {}; },
    ask() { return Promise.resolve(null); }
  };
  return { bus, sent };
}

function build(winExtra, docEls) {
  const win = makeWin(winExtra);
  win.document = makeDoc(docEls || []);
  const { bus, sent } = freshBus();
  // 按 manifest 的顺序注入
  for (const f of ['src/common/util.js', 'src/common/postbus.js', 'src/common/extract.js']) {
    loadCode(read(f), win);
  }
  win.XYPostBus.channel = () => bus;   // 让 extract 拿到可观测的通道
  // extract 在加载时就抓了 bus，重新赋值后要重新加载一次才生效
  delete win.XYExtract;
  loadCode(read('src/common/extract.js'), win);
  return { win, E: win.XYExtract, sent };
}

(async function run() {
  /* --- 商品 ID 形态 --- */
  log.push('\nID 判定');
  let { E } = build();
  ok('6 位以上纯数字算商品 ID', E.isGoodId('803347112456'));
  ok('1688 offerId（12 位）认', E.isGoodId('671812345678'));
  ok('4 位数字不算', !E.isGoodId('1234'));
  ok('带小数点的价格误值不算', !E.isGoodId('12.00'));
  ok('数组不算', !E.isGoodId([]));
  ok('null 不算', !E.isGoodId(null));

  /* --- L1：window 全局 --- */
  log.push('\nL1 window 全局数据');
  const data = { resultList: [
    { itemId: '70000001', title: 'iPad Air 5', price: '2100', picUrl: '//a.jpg' },
    { itemId: '70000002', title: 'Switch', price: '900', picUrl: '//b.jpg' }
  ] };

  let b1 = build({ __INITIAL_STATE__: data });
  ok('认出固定名 __INITIAL_STATE__', b1.E.windowRoots({ window: b1.win }).length === 1);
  let c1 = b1.E.collectFromRoots(b1.E.windowRoots({ window: b1.win }));
  ok('能抽到 2 张卡片', c1.length === 2, '实际 ' + c1.length);
  ok('字段映射沿用 util（itemId 正确）', c1[0] && c1[0].itemId === '70000001');

  // 字符串形态（SSR 常见：window.__DATA__={...} 或 <!--{...}-->）
  let b2 = build({ __DATA__: 'window.__DATA__=' + JSON.stringify(data) });
  ok('能从赋值语句形态的字符串里剥出数据',
    b2.E.collectFromRoots(b2.E.windowRoots({ window: b2.win })).length === 2);

  // 宽松扫描：名字不认识，但名字里带数据味道
  let b3 = build({ pageRenderStore: data });
  ok('宽松扫描能命中没见过的挂载名',
    b3.E.collectFromRoots(b3.E.windowRoots({ window: b3.win })).length === 2);

  // 全是垃圾值时不能误报
  let b4 = build({ __DATA__: 'not json at all', __PAGE_X__: '{{{', location2: {} });
  ok('解析失败的值不会进候选', b4.E.windowRoots({ window: b4.win }).length === 0);

  // script[type=application/json]
  let b5 = build({});
  b5.win.document = {
    querySelectorAll: (sel) => (/application\/json/.test(sel)
      ? [{ textContent: JSON.stringify(data) }] : [])
  };
  ok('内嵌 <script type="application/json"> 也收',
    b5.E.collectFromRoots(b5.E.windowRoots({ window: b5.win })).length === 2);

  /* --- L2：React fiber --- */
  log.push('\nL2 React fiber');
  const fiber = { memoizedProps: { itemId: '803347112456', title: 'nakedEl卡片' }, return: null };
  const nakedEl = makeFiberEl(fiber);
  const plain = makeEl();
  let b6 = build({}, [plain, nakedEl]);
  let r6 = b6.E.fiberScan({ doc: b6.win.document });
  ok('认出带 __reactFiber$ 的元素', b6.E.fiberKeyOf(nakedEl) === '__reactFiber$abc123');
  ok('fiber 里的 itemId 被标到元素上', nakedEl.getAttribute('data-xy-card') === '803347112456');
  ok('没 fiber 的元素不动', plain.getAttribute('data-xy-card') === null);
  ok('返回 marked 计数', r6.marked === 1, 'marked=' + r6.marked);
  ok('返回 ids', r6.ids.length === 1 && r6.ids[0] === '803347112456');

  // 同一元素重复扫描不会重复标注
  r6 = b6.E.fiberScan({ doc: b6.win.document });
  ok('已标注的元素跳过（重复扫描结果稳定）', r6.marked === 0);

  // 字段优先级：offerId 优先于泛化的 id
  const f2 = { memoizedProps: { id: '999', offerId: '70000003' }, return: null };
  const el2 = makeFiberEl(f2);
  let b7 = build({}, [el2]);
  ok('offerId 优先于 id', b7.E.fiberScan({ doc: b7.win.document }).ids[0] === '70000003');

  // 沿 return 链往上找
  const f3 = { memoizedProps: {}, return: { memoizedProps: { itemId: '70000004' } } };
  const el3 = makeFiberEl(f3);
  let b8 = build({}, [el3]);
  ok('父 fiber 里的 itemId 也能认出来',
    b8.E.fiberScan({ doc: b8.win.document }).ids[0] === '70000004');

  // 非数字的 id 不能拿
  const f4 = { memoizedProps: { itemId: 'abc' }, return: null };
  const el4 = makeFiberEl(f4);
  let b9 = build({}, [el4]);
  ok('非数字的 itemId 不认', b9.E.fiberScan({ doc: b9.win.document }).marked === 0);

  // budget 生效
  const many = [];
  for (let i = 0; i < 50; i++) many.push(makeFiberEl({ memoizedProps: { itemId: '700000' + i }, return: null }));
  let b10 = build({}, many);
  ok('budget 限制扫描量', b10.E.fiberScan({ doc: b10.win.document, budget: 5 }).marked <= 5);

  /* --- start：L1 推数据、L2 推定位 --- */
  log.push('\nstart 接线');
  const fb = build({ __INITIAL_STATE__: data }, [makeFiberEl(fiber)]);
  const started = fb.E.start({ now: true });
  ok('start 把 L1 的卡片推出去',
    fb.sent.some((m) => m.name === 'cards' && m.payload.list.length === 2));
  ok('start 不该立刻扫 fiber（React 还没挂载）', started.marked === 0);

  /* --- 接入点检查 --- */
  log.push('\n接入点');
  const manifest = JSON.parse(read('manifest.json'));
  const mainGroup = manifest.content_scripts[0];
  const idx = mainGroup.js.indexOf('src/common/extract.js');
  ok('extract.js 挂在了 MAIN world 那一组', idx > -1);
  ok('extract.js 在 injected.js 之前（U / bus 才就绪）',
    idx > -1 && mainGroup.js.indexOf('src/content/injected.js') > idx);
  ok('第二组（ISOLATED）没有多挂一份',
    !manifest.content_scripts[1].js.some((f) => /extract\.js$/.test(f)));

  const bridgeSrc = read('src/content/bridge.js');
  ok('bridge 认得 data-xy-card 定位', /data-xy-card/.test(bridgeSrc));
  ok('bridge 接了 cards-relocate 补挂复选框',
    /bus\.on\('injected', 'cards-relocate'/.test(bridgeSrc));
  const injectedSrc = read('src/content/injected.js');
  ok('injected 在 boot 里调了 E.start', /E\.start\(/.test(injectedSrc));

  console.log(log.join('\n'));
  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试自身出错：', e);
  process.exit(1);
});
