/**
 * 「保存到下载目录」的边界测试。
 *
 * Chrome 的 downloads.download({filename}) 只接受相对「默认下载目录」的路径，
 * 官方文档：绝对路径、空路径、含 ".." 的路径「will be ignored」（静默忽略，不报错）。
 * 所以校验和后台的 safePath 都得自己拦一道，否则用户填 D:\xxx 时
 * 只会看到文件莫名落到「下载」根目录。
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const ctx = { console, window: null, globalThis: null };
ctx.window = ctx;
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/common/util.js'), 'utf8'), ctx);
const U = ctx.XYUtil;

let pass = 0;
function ok(cond, name) {
  assert.ok(cond, name);
  console.log('✓ ' + name);
  pass++;
}

/* ---------------- 1. util.checkSaveDir：拦下会被静默忽略的写法 ---------------- */

const good = ['闲鱼采集', '闲鱼采集/1688', '采集/2026/09', '我的 采集', 'a-b_c'];
good.forEach((v) => {
  const r = U.checkSaveDir(v);
  ok(r.ok === true && !r.msg, '正常路径放行：' + v);
});

ok(U.checkSaveDir('').ok === true, '空值放行（回落到默认目录名）');

const bad = [
  ['D:\\我的采集', '盘符反斜杠'],
  ['D:/我的采集', '盘符正斜杠'],
  ['/绝对/路径', '以 / 开头'],
  ['\\绝对\\路径', '以反斜杠开头'],
  ['../上级', '往上跳一级'],
  ['闲鱼采集/../../x', '路径里夹带 ..'],
  ['~/Downloads', '波浪号写法']
];
bad.forEach(([v, why]) => {
  const r = U.checkSaveDir(v);
  ok(r.ok === false && r.msg, '拦下（' + why + '）：' + v);
});

ok(/下载/.test(U.checkSaveDir('D:\\x').msg), '绝对路径的提示里说明了原因与改法');

/* ---------------- 2. safePath：后台侧也把盘符 / .. 切干净 ---------------- */

const swSrc = fs.readFileSync(path.join(ROOT, 'src/background/service_worker.js'), 'utf8');
const m = swSrc.match(/function safePath\(p\) \{[\s\S]*?\n\}/);
ok(!!m, '能定位到 safePath 实现');

const fnSrc = m[0].replace(/function safePath\(p\)/, 'function safePath(p)');
const fnCtx = { U: { cleanFileName: U.cleanFileName } };
vm.createContext(fnCtx);
vm.runInContext(fnSrc + '\nthis.safePath = safePath;', fnCtx);
const safePath = fnCtx.safePath;

ok(safePath('闲鱼采集/iPad 壳') === '闲鱼采集/iPad 壳', '普通多层路径原样保留');
ok(safePath('D:\\我的采集') === '我的采集', '盘符段被剥掉，不当成父目录');
ok(safePath('D:/我的采集') === '我的采集', '正斜杠盘符段也被剥掉');
ok(safePath('../../x') === 'x', '开头的 .. 被切掉，不会跳出下载目录');
ok(safePath('闲鱼/../x') === '闲鱼/x', '路径中间的 .. 被切掉');
ok(safePath('..') === '', '只有 .. 时结果为空（不往上跑）');
ok(safePath('') === '闲鱼采集', '空值回落到默认目录名');
ok(safePath('../..') === '', '".." 也被滤掉');
ok(safePath('C:/Users/pc/x') === 'Users/pc/x', 'C 盘绝对路径里的盘符段被剥掉');
ok(safePath('闲鱼//采集') === '闲鱼/采集', '连写斜杠产生的空段被跳过');

console.log('\n全部测试通过 ✅  (' + pass + ' 项)');
