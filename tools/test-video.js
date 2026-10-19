/**
 * 主图视频采集的回归测试
 *
 * 视频不跟详情接口走（实测 mtop.1688.mmga.offerdetail.service 里没有视频字段），
 * 只存在于详情页 DOM 的 <video src> 上：
 *   <video class="lib-video" src="//cloud.video.taobao.com/play/u/.../401098362651705.mp4">
 * 所以这一块的正确性全靠 normalizeVideoUrl / videoFromElement 两个函数兜住。
 *
 * 用法： node tools/test-video.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

function loadUtil() {
  const ctx = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, Promise,
    Math, Date, JSON, Object, Array, String, Number, RegExp, Error, Set, Map
  };
  ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
  ctx.location = { href: 'https://s.1688.com/', host: 's.1688.com', pathname: '/', search: '' };
  ctx.document = {
    readyState: 'complete',
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener() {},
    createElement: () => ({ style: {}, appendChild() {}, addEventListener() {} }),
    documentElement: { setAttribute() {} },
    get body() { return { appendChild() {}, addEventListener() {} }; },
    visibilityState: 'visible'
  };
  ctx.navigator = {};
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/common/util.js'), 'utf8'), ctx);
  return ctx.XYUtil;
}

const U = loadUtil();

/* ============ 1. 真实抓到的 1688 视频地址 ============ */
console.log('1) 真实 1688 详情页的 video src');
const REAL_SRC = '//cloud.video.taobao.com/play/u/2201448362121/p/2/e/6/t/1/401098362651705.mp4';
const norm = U.normalizeVideoUrl(REAL_SRC);
assert.strictEqual(norm, 'https://cloud.video.taobao.com/play/u/2201448362121/p/2/e/6/t/1/401098362651705.mp4',
  'protocol-relative 的 src 必须补上 https:');
assert.ok(norm.indexOf('//cloud') !== 0, '不应留下协议相对地址');
console.log('   ✓ ' + norm);

/* ============ 2. 脏数据不能混进来 ============ */
console.log('2) 非视频 / 非地址一律拒绝');
assert.strictEqual(U.normalizeVideoUrl(''), '');
assert.strictEqual(U.normalizeVideoUrl(null), '');
assert.strictEqual(U.normalizeVideoUrl('data:video/mp4;base64,AAAA'), '', 'data: URI 必须丢弃');
assert.strictEqual(U.normalizeVideoUrl('blob:https://x.com/abc'), '', 'blob: 必须丢弃');
assert.strictEqual(U.normalizeVideoUrl('不是地址'), '', '普通文本必须丢弃');
assert.strictEqual(U.normalizeVideoUrl('https://x.com/a.mp4?t=1&e=2'), 'https://x.com/a.mp4', '应剥掉查询串');
assert.strictEqual(U.normalizeVideoUrl('https://x.com/a.m3u8'), 'https://x.com/a.m3u8', 'm3u8 应保留');
console.log('   ✓ 空值/data/blob/文本/查询串 全部处理正确');

/* ============ 3. videoFromElement 的三种形态 ============ */
console.log('3) 从 <video> 元素取地址');
function fakeVideo(attrs, childSrc) {
  const el = {
    attrs: attrs || {},
    dataset: attrs && attrs['data-src'] ? { src: attrs['data-src'] } : {},
    querySelectorAll: (sel) => (sel === 'source' && childSrc ? [{ getAttribute: (n) => (n === 'src' ? childSrc : null) }] : [])
  };
  el.getAttribute = (n) => (n in el.attrs ? el.attrs[n] : null);
  return el;
}
assert.strictEqual(
  U.videoFromElement(fakeVideo({ src: REAL_SRC })), REAL_SRC,
  '优先取 src 属性'
);
assert.strictEqual(
  U.videoFromElement(fakeVideo({}, 'https://x.com/a.mp4')), 'https://x.com/a.mp4',
  '没有 src 时取 <source> 子元素'
);
assert.strictEqual(
  U.videoFromElement(fakeVideo({ 'data-src': 'https://x.com/b.mp4' })), 'https://x.com/b.mp4',
  '都没有时取 data-src'
);
assert.strictEqual(U.videoFromElement(fakeVideo({})), '', '空元素应返回空串');
assert.strictEqual(U.videoFromElement(null), '', 'null 不能炸');
console.log('   ✓ src / source / data-src 三级兜底正常');

/* ============ 4. 组合：元素 → 规范化 ============ */
console.log('4) 元素到最终地址');
const viaSrc = U.normalizeVideoUrl(U.videoFromElement(fakeVideo({ src: REAL_SRC })));
assert.ok(/^https:\/\/cloud\.video\.taobao\.com/.test(viaSrc), '整条链路应产出 https 地址');
// 脏 src 经 videoFromElement 出来后，normalize 必须把它拦在门外，
// 否则会把 data: URI 当成视频地址去下载。
assert.strictEqual(U.normalizeVideoUrl(U.videoFromElement(fakeVideo({ src: 'data:video/mp4;base64,AA' }))), '',
  'data: URI 必须被拦下，不能当作视频地址');
console.log('   ✓ ' + viaSrc);

/* ============ 5. 详情接口分支不留假视频 ============ */
console.log('5) 接口分支的 video 必须是空');
assert.strictEqual(U.normalizeVideoUrl(undefined), '', '未定义应为空');

console.log('\n全部通过');
