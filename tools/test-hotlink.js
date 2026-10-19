/**
 * 防盗链规则（HOTLINK_RULES）的离线回归测试。
 *
 * 这里跑不了真正的 declarativeNetRequest，所以只验「规则本身写对了没」：
 * ID 段不撞、表头值对、urlFilter 真的能匹配到 1688 的图床、
 * resourceTypes 只覆盖 image/media（别顺手把页面导航请求也改了）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const swPath = path.join(ROOT, 'src', 'background', 'service_worker.js');
const sw = fs.readFileSync(swPath, 'utf8');

let pass = 0, fail = 0;
const results = [];

function ok(name, cond, detail) {
  if (cond) { pass++; results.push('  ✓ ' + name); }
  else { fail++; results.push('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}

function section(title) { results.push('\n' + title); }

/** 从源文件里抠出 HOTLINK_RULES / ID 段常量，避免在测试里重写一份实现 */
function grabConst(name) {
  const re = new RegExp('var\\s+' + name + '\\s*=\\s*(\\[[\\s\\S]*?\\]|\\d+|\\d+)\\s*;');
  const m = sw.match(re);
  return m ? m[1] : null;
}

/** 极简求值：只支持字面量数组 / 数字，够用就行 */
function evalLiteral(src) {
  // eslint-disable-next-line no-new-func
  return new Function('return ' + src)();
}

/* ---------------- 1. 规则表本身 ---------------- */

section('规则表 Shape');

const idMinSrc = grabConst('HOTLINK_ID_MIN');
const idMaxSrc = grabConst('HOTLINK_ID_MAX');
ok('能抠到 HOTLINK_ID_MIN', idMinSrc !== null);
ok('能抠到 HOTLINK_ID_MAX', idMaxSrc !== null);

const idMin = Number(evalLiteral(idMinSrc));
const idMax = Number(evalLiteral(idMaxSrc));
ok('ID 段是递增的（MIN < MAX）', idMin < idMax, `${idMin} vs ${idMax}`);
ok('ID 段不与常见动态规则撞车（>45000）', idMin > 45000, String(idMin));

const rulesSrc = grabConst('HOTLINK_RULES');
ok('能抠到 HOTLINK_RULES', rulesSrc !== null);

let rules = [];
try { rules = evalLiteral(rulesSrc); } catch (e) { /* 下面统一报失败 */ }
ok('规则能解析成数组', Array.isArray(rules) && rules.length > 0);

if (Array.isArray(rules) && rules.length) {
  const ids = rules.map(r => r.id);
  ok('规则 ID 唯一', new Set(ids).size === ids.length, ids.join(','));
  ok(
    '所有规则 ID 都落在我们自己的 ID 段内',
    ids.every(id => id >= idMin && id < idMax),
    ids.join(',')
  );
  ok(
    '每条规则都改 Referer 且指向 1688',
    rules.every(r => (r.action.requestHeaders || []).some(
      h => h.header === 'Referer' && h.value === 'https://www.1688.com/'
    )),
    JSON.stringify(rules.map(r => r.action))
  );
  ok(
    '每条规则都同时补 Origin',
    rules.every(r => (r.action.requestHeaders || []).some(
      h => h.header === 'Origin' && h.value === 'https://www.1688.com'
    ))
  );
  ok(
    '请求头操作是 set（不是 remove）',
    rules.every(r => (r.action.requestHeaders || []).every(h => h.operation === 'set'))
  );
  ok(
    'resourceTypes 只覆盖 image / media',
    rules.every(r => Array.isArray(r.condition.resourceTypes) &&
      r.condition.resourceTypes.every(t => t === 'image' || t === 'media')),
    JSON.stringify(rules.map(r => r.condition.resourceTypes))
  );
  ok(
    'action.type 是 modifyHeaders',
    rules.every(r => r.action.type === 'modifyHeaders')
  );
}

/* ---------------- 2. urlFilter 能不能匹配到真实图片地址 ---------------- */

section('urlFilter 匹配');

/** DNR 的 urlFilter：`*` 通配任意字符（含 `/`），需转义成正则 */
function filterToRegex(filter) {
  return new RegExp('^' + String(filter).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
}

const filters = rules.length ? rules.map(r => r.condition.urlFilter) : [];

const SHOULD_MATCH = [
  'https://cbu01.alicdn.com/img/ibank/test_123.jpg',
  'https://cbu02.alicdn.com/imgextra/i1/i1.jpg?a=1',
  'https://cbu06.alicdn.com/test.webp',
  'https://www.1688.com/x.jpg',
  'https://detail.1688.com/img/x.jpg'
];
SHOULD_MATCH.forEach(url => {
  const hit = filters.some(f => filterToRegex(f).test(url));
  ok('应命中：' + url, hit);
});

const SHOULD_NOT_MATCH = [
  'https://img.goofish.com/test_123.jpg',
  'https://goofish.alicdn.com/img/test.jpg',
  'https://www.taobao.com/img/x.jpg',
  'https://example.com/a.jpg'
];
SHOULD_NOT_MATCH.forEach(url => {
  const hit = filters.some(f => filterToRegex(f).test(url));
  ok('不应命中（别误伤闲鱼/淘宝）：' + url, !hit);
});

/* ---------------- 3. 开关与调用点 ---------------- */

section('开关与调用点');

ok('DEFAULTS 里有 hotlinkFix', /hotlinkFix:\s*true/.test(sw));
ok('有 onStartup 兜底（SW 被回收后重新装上）', /onStartup/.test(sw));
ok('syncHotlinkRules 会先摘旧规则再装', /removeRuleIds:\s*stale/.test(sw));
ok(
  '关掉开关时走的是 remove 分支',
  /s\.hotlinkFix === false/.test(sw) && /if\s*\(!want\)/.test(sw)
);
ok('getDynamicRules 有 try/catch 兜底（老版本没这 API）',
  /function syncHotlinkRules\(\)\s*\{\s*try\s*\{/.test(sw.replace(/\n\s*/g, ' ')));
ok('manifest 声明了 declarativeNetRequest',
  /"declarativeNetRequest"/.test(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')));

const popup = fs.readFileSync(path.join(ROOT, 'src', 'popup', 'popup.js'), 'utf8');
ok('popup.js 读 hotlinkFix', /hotlinkFix/.test(popup));
ok('popup.html 有 cfg-hotlink 开关',
  /id="cfg-hotlink"/.test(fs.readFileSync(path.join(ROOT, 'src', 'popup', 'popup.html'), 'utf8')));

/* ---------------- 输出 ---------------- */

console.log(results.join('\n'));
console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
