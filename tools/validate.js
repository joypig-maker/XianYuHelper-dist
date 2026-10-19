/**
 * 静态校验：manifest 引用路径、popup 资源、DOM id 一致性、权限覆盖
 * 用法：node tools/validate.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let errors = 0;
let warns = 0;

function ok(msg) { console.log('  ✓ ' + msg); }
function fail(msg) { console.log('  ✗ ' + msg); errors++; }
function warn(msg) { console.log('  ! ' + msg); warns++; }
function exists(p) { return fs.existsSync(path.join(ROOT, p)); }

console.log('\n[1] manifest 引用文件');
const mf = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
console.log('  名称：' + mf.name + '  v' + mf.version + '  MV' + mf.manifest_version);

const refs = [];
Object.values(mf.icons).forEach((p) => refs.push(p));
refs.push(mf.action.default_popup, mf.background.service_worker, ...mf.web_accessible_resources[0].resources);
mf.content_scripts.forEach((cs) => {
  (cs.js || []).forEach((p) => refs.push(p));
  (cs.css || []).forEach((p) => refs.push(p));
});
refs.filter((p) => !p.includes('*')).forEach((p) => {
  if (exists(p)) ok(p);
  else fail('缺失文件：' + p);
});

console.log('\n[2] popup.html 资源引用');
const html = fs.readFileSync(path.join(ROOT, 'src/popup/popup.html'), 'utf8');
const srcs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((s) => !s.startsWith('http'));
srcs.forEach((s) => {
  if (exists('src/popup/' + s)) ok('src/popup/' + s);
  else fail('缺失：src/popup/' + s);
});

console.log('\n[3] popup.js 使用的元素 id 是否存在于 HTML');
const popupJs = fs.readFileSync(path.join(ROOT, 'src/popup/popup.js'), 'utf8');
const usedIds = [...popupJs.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]);
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
[...new Set(usedIds)].forEach((id) => {
  if (htmlIds.has(id)) ok('#' + id);
  else fail('HTML 中不存在 id=' + id);
});

console.log('\n[4] 权限覆盖');
const allJs = ['src/content/bridge.js', 'src/content/injected.js', 'src/background/service_worker.js', 'src/popup/popup.js']
  .map((p) => fs.readFileSync(path.join(ROOT, p), 'utf8'))
  .join('\n');
const apiMap = {
  'chrome.downloads': 'downloads',
  'chrome.storage': 'storage',
  'chrome.tabs': 'tabs',
  'chrome.notifications': 'notifications',
  'chrome.scripting': 'scripting'
};
Object.entries(apiMap).forEach(([api, perm]) => {
  if (new RegExp(api.replace('.', '\\.')).test(allJs)) {
    if (mf.permissions.includes(perm)) ok(api + ' -> 权限 ' + perm);
    else fail(api + ' 缺少权限 ' + perm);
  }
});

console.log('\n[5] 危险代码扫描');
const dangerous = [/eval\s*\(/, /new Function/, /document\.write/, /innerHTML\s*=\s*[^'"]/];
['src/content/injected.js', 'src/content/bridge.js', 'src/background/service_worker.js', 'src/popup/popup.js'].forEach((p) => {
  const code = fs.readFileSync(path.join(ROOT, p), 'utf8');
  dangerous.forEach((re) => {
    if (re.test(code)) warn(p + ' 命中 ' + re);
  });
});
ok('扫描完成');

console.log('\n结果：' + errors + ' 个错误，' + warns + ' 个警告\n');
process.exit(errors ? 1 : 0);
