/**
 * ID 标记文件判重 —— 根治「重装/改标题后又下一遍」
 *
 * 用户要求：
 *   ① 下载后写一个记录文件，把所有下载过的商品 ID 记进去，键要带站点前缀
 *      （xy / tb / al / jd）—— 因为各站数字 ID 会重复
 *   ② 下载时先看有没有下过，有就跳过
 *   ③ 无论什么时候更新版本都不重复
 *
 * 上一版（v1.6.3）失效的两个原因，这里都锁住：
 *   A. downloads.search 返回**绝对路径**，而我拿**相对路径**做全等比对 → 永不命中
 *   B. 判据是 info.json，路径含目录名（默认模板带**标题**）→ 卖家改标题就失效
 *
 * 跑：node tools/test-id-mark.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SW = fs.readFileSync(path.join(ROOT, 'src/background/service_worker.js'), 'utf8');
const UT = fs.readFileSync(path.join(ROOT, 'src/common/util.js'), 'utf8');

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

const win = {}; vm.createContext(win);
vm.runInContext(UT, win, { timeout: 5000 });
const U = win.XYUtil;

/** 假 downloads：磁盘文件用**绝对路径**（与真实行为一致） */
function makeCtx(absFiles) {
  const disk = new Set((absFiles || []).map(x => String(x).replace(/\\/g, '/')));
  const sb = {
    console, setTimeout: (f) => f(), Promise, JSON, Set,
    U: { INFO_FILE: 'info.json', ID_MARK_FILE: U.ID_MARK_FILE,
         idMarkFileName: U.idMarkFileName },
    chrome: {
      runtime: { lastError: null },
      downloads: {
        search(opt, cb) {
          const q = String(opt.filename || '').replace(/\\/g, '/');
          const rows = [];
          disk.forEach(f => {
            if (f.indexOf(q) >= 0) rows.push({ filename: f, state: 'complete', exists: true });
          });
          cb(rows);
        }
      }
    }
  };
  sb.self = sb; sb.window = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(grabFn(SW, 'historyOnDisk'), sb);
  return {
    disk,
    check: (its) => vm.runInContext('historyOnDisk(' + JSON.stringify(its) + ')', sb)
  };
}

/* ============================================================ */
section('1) 站点前缀：各站 ID 必须能区分开');
{
  is('★ 闲鱼 → xy', U.sitePrefix('xianyu') === 'xy', U.sitePrefix('xianyu'));
  is('★ 淘宝 → tb', U.sitePrefix('taobao') === 'tb', U.sitePrefix('taobao'));
  is('★ 天猫 → tb（与淘宝同 ID 体系，必须同前缀）',
    U.sitePrefix('tmall') === 'tb', U.sitePrefix('tmall'));
  is('★ 1688 → al', U.sitePrefix('p1688') === 'al', U.sitePrefix('p1688'));
  is('★ 京东 → jd', U.sitePrefix('jd') === 'jd', U.sitePrefix('jd'));

  const keys = ['xianyu', 'taobao', 'tmall', 'p1688', 'jd'].map(s => U.itemKey(s, '123'));
  console.log('    同一 ID 123 在各站的键:', keys.join(' / '));
  is('★★ 淘宝天猫视为同一件', U.itemKey('taobao', '123') === U.itemKey('tmall', '123'));
  is('★★ 闲鱼/淘宝/1688/京东 四者互不相同',
    new Set(keys).size === 4, keys.join(','));
  is('缺 itemId 返回空（不参与去重）', U.itemKey('xianyu', '') === '');
  // 未知站点用自己 key 当前缀 —— 这样以后加新站点，判重照样生效，
  // 不会因为「不认识」就退化成重复下载。
  is('★ 未知站点用自己的 key 当前缀（仍能判重）',
    U.itemKey('新站点', '123') === '新站点_123', U.itemKey('新站点', '123'));
  is('★ 缺站点返回空（不参与去重）', U.itemKey('', '123') === '');
}

/* ============================================================ */
section('2) 标记文件名只由 站点+ID 决定，与标题/店铺/日期无关');
{
  const a = U.idMarkFileName('xianyu', '844934128301');
  is('★ 文件名可拼出来', a === '已下载标识_xy_844934128301.txt', a);
  is('★ 不含标题/店铺/日期', a.indexOf('李宁') < 0 && a.indexOf('未知店铺') < 0, a);
  is('★ 缺 itemId 返回空', U.idMarkFileName('xianyu', '') === '');
}

/* ============================================================ */
section('3) ★★ 核心场景：存储清零（重装扩展）+ 目录名变了（改标题）');
(async () => {
  // 昨天下的，目录名带当时的标题
  const mark = U.idMarkFileName('xianyu', '844934128301');
  const c = makeCtx([
    'D:/下载/闲鱼采集/李宁_李宁童鞋_844934128301/' + mark
  ]);
  // 今天扩展重装了（storage 全空），且卖家改了标题 → 目录名不一样
  const today = {
    dir: 'D:/下载/闲鱼采集/李宁_李宁童鞋夏季新款_844934128301',
    site: 'xianyu', itemId: '844934128301'
  };
  const r = await c.check([today]);
  is('★★ 存储没有 + 目录名变了 → 仍然认得出下过',
    !!r[today.dir], JSON.stringify(Object.keys(r)));
})();

/* ============================================================ */
section('4) ★ 绝对路径 vs 相对路径（v1.6.3 的死因）');
(async () => {
  const mark = U.idMarkFileName('jd', '555');
  // 磁盘上返回的是绝对路径（带盘符）
  const c = makeCtx(['C:/Users/pc/Downloads/商品X_555/' + mark]);
  const r = await c.check([{ dir: '商品X_555', site: 'jd', itemId: '555' }]);
  is('★ 绝对路径能被相对 dir 认出来',
    !!r['商品X_555'], JSON.stringify(Object.keys(r)));

  // 反斜杠的绝对路径
  const c2 = makeCtx(['C:\\Users\\pc\\Downloads\\商品X_555\\' + mark]);
  const r2 = await c2.check([{ dir: '商品X_555', site: 'jd', itemId: '555' }]);
  is('★ 反斜杠路径也认得出', !!r2['商品X_555'], JSON.stringify(Object.keys(r2)));
})();

/* ============================================================ */
section('5) 中断的临时文件不算下过（否则永不重试）');
(async () => {
  const mark = U.idMarkFileName('xianyu', '333');
  const sb = {
    console, setTimeout: (f) => f(), Promise, JSON, Set,
    U: { INFO_FILE: 'info.json', idMarkFileName: U.idMarkFileName },
    chrome: {
      runtime: { lastError: null },
      downloads: {
        search(opt, cb) {
          const q = String(opt.filename || '').replace(/\\/g, '/');
          cb([{ filename: 'D:/下载/x/' + mark + '.crdownload',
                state: 'interrupted', exists: false }]);
        }
      }
    }
  };
  sb.self = sb; vm.createContext(sb);
  vm.runInContext(grabFn(SW, 'historyOnDisk'), sb);
  const r = vm.runInContext("historyOnDisk([{dir:'x',site:'xianyu',itemId:'333'}])", sb);
  const v = await r;
  is('★ interrupted + exists:false → 不算下过', Object.keys(v).length === 0,
    JSON.stringify(Object.keys(v)));
})();

/* ============================================================ */
section('6) uniquify 的重名副本也算（重下后仍认得出）');
(async () => {
  const mark = U.idMarkFileName('xianyu', '444');
  const c = makeCtx(['D:/下载/x/' + mark + ' (1)']);
  const r = await c.check([{ dir: 'x', site: 'xianyu', itemId: '444' }]);
  is('★ 「...txt (1)」也算已下载', !!r['x'], JSON.stringify(Object.keys(r)));
})();

/* ============================================================ */
section('7) 不同站的同号商品互不干扰');
(async () => {
  const c = makeCtx([
    'D:/下载/闲鱼/x/' + U.idMarkFileName('xianyu', '888')
  ]);
  const r = await c.check([
    { dir: 'y', site: 'jd', itemId: '888' },          // 京东 888，没下过
    { dir: 'x', site: 'xianyu', itemId: '888' }        // 闲鱼 888，下过
  ]);
  is('★ 京东 888 不被闲鱼 888 牵连', !r['y'], JSON.stringify(Object.keys(r)));
  is('★ 闲鱼 888 认得出', !!r['x']);
})();

/* ============================================================ */
section('8) 下载时要真的写出这个文件');
{
  is('SW 里有 writeIdMark', typeof grabFn(SW, 'writeIdMark') === 'string');
  const fn = grabFn(SW, 'writeIdMark');
  is('★ 用 uniquify（不需要额外权限）', fn.indexOf("conflictAction: 'uniquify'") > 0);
  is('★ 文件名来自 idMarkFileName', fn.indexOf('U.idMarkFileName(site, itemId)') > 0);
  const sw = SW;
  is('★ info.json 成功后才写标记（顺序不能反）',
    sw.indexOf('infoOk++') > 0 &&
    sw.indexOf('infoOk++') < sw.indexOf('return writeIdMark(dir, item.site, item.itemId, errors)'),
    '');
}

setTimeout(() => {
  console.log('\n' + '─'.repeat(50));
  if (fail) {
    console.log('✗ 有失败：' + pass + ' 通过 / ' + fail + ' 失败');
    process.exit(1);
  } else {
    console.log('✓ 全部通过：' + pass + ' 项断言');
  }
}, 400);
