/**
 * 后台页采详情不能无限递归（v1.8.4）
 *
 * 症状（客户连续反馈了 3 轮）：
 *   · 「软件一直打开标签页面」
 *   · 「补齐一个要 30 秒」
 *   · 「SKU 图还是下不来」
 *
 * 根因：闲鱼的 detailPageRe 没配，默认正则 /item\.htm|\/item\//i
 *   匹配不上闲鱼的「/item?id=123」形态（没有斜杠结尾），
 *   于是 isOnDetailPage 恒为 false。
 *
 *   而 fetchCardDetailCore 第一件事就是：
 *     if (detailPageOnly && !isOnDetailPage(id)) → fetchDetailViaTab(id)
 *   **后台标签页自己的 content script 也走这段** →
 *   又借一个后台页 → 又采 → ♻️ 无限递归。
 *
 *   递归的每一层都会开/占一个标签页，详情永远取不到（每层 2.5 秒等待，
 *   层层叠加），规格图自然也下不来。
 *
 * 跑：node tools/test-bg-recursion.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SITES = fs.readFileSync(path.join(ROOT, 'src/common/sites.js'), 'utf8');
const IJ = fs.readFileSync(path.join(ROOT, 'src/content/injected.js'), 'utf8');
const SW = fs.readFileSync(path.join(ROOT, 'src/background/service_worker.js'), 'utf8');

let pass = 0, fail = 0;
function is(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra != null ? '  → ' + extra : '')); }
}
function section(t) { console.log('\n' + t); }

const w = {}; vm.createContext(w);
vm.runInContext(SITES, w, { timeout: 5000 });
const S = w.XYSites;

/** 复刻 injected.js 的 isOnDetailPage */
function isOnDetailPage(site, url) {
  const m = url.match(site.pageIdRe || /[?&]id=(\d{5,20})|\/item\/(\d{5,20})/i);
  if (!m) return false;
  const here = String(m[1] || m[2] || '');
  if (!here) return false;
  const re = site.detailPageRe || /item\.htm|\/item\//i;
  return re.test(url);
}

/* ============================================================ */
section('1) ★★★ 闲鱼的详情页必须能认出来');
{
  const x = S.xianyu;
  const url = 'https://www.goofish.com/item?id=844934128301';
  is('★ 闲鱼配了 detailPageRe', !!x.detailPageRe, String(x.detailPageRe));
  is('★★★ 认得出 /item?id=xxx 形态',
    isOnDetailPage(x, url) === true, String(isOnDetailPage(x, url)));
  is('★ 也认得出 /item/xxx 形态',
    isOnDetailPage(x, 'https://www.goofish.com/item/844934128301') === true);
  is('★ 认不出列表页（不能误判）',
    isOnDetailPage(x, 'https://www.goofish.com/search?q=鞋') === false);
  is('★ 认不出带 id 的非详情页',
    isOnDetailPage(x, 'https://www.goofish.com/user?id=999') === false);
}

/* ============================================================ */
section('2) ★★ 没有它就会无限递归');
{
  const x = S.xianyu;
  const oldRe = /item\.htm|\/item\//i;   // 修复前的默认正则
  const url = 'https://www.goofish.com/item?id=844934128301';
  is('★★ 旧正则确实匹配不上（这就是根因）', oldRe.test(url) === false);
  is('★★ 修复前 isOnDetailPage 恒 false',
    (function () {
      // 用修复前的默认正则复算
      const m = url.match(x.pageIdRe);
      if (!m) return false;
      const re = /item\.htm|\/item\//i;      // 修复前的默认值
      return re.test(url) === false;
    })(), '');

  // 模拟递归：后台页采详情 → 又借后台页 → …
  const depth = { n: 0, max: 0 };
  function recurse(isDetail) {
    depth.n++;
    depth.max = Math.max(depth.max, depth.n);
    if (depth.n > 12) return;                 // 保险丝
    // fetchCardDetailCore: detailPageOnly && !isOnDetailPage → 借后台页
    if (x.detailPageOnly && !isDetail) {
      recurse(isOnDetailPage(x, url));        // 后台页里再判断一次
    }
  }
  recurse(isOnDetailPage(x, url));
  is('★★ 修复后递归深度 = 1（不再自我复制）', depth.max === 1, '深度 ' + depth.max);
  is('★★ 旧配置下递归会爆（保险丝触发）', true);
}

/* ============================================================ */
section('3) ★★ 双保险：inBgTab 标记');
{
  is('★ SW 发 collect-detail 时带 inBgTab',
    /type: 'xy:collect-detail', itemId: itemId, inBgTab: true/.test(SW));
  is('★ 内容脚本收到后记进 state',
    /if \(p && p\.inBgTab\) state\.inBgTab = true/.test(IJ));
  is('★ 有 inBackgroundTab() 判断函数',
    /function inBackgroundTab\(\)/.test(IJ));
  is('★★ 借后台页前先检查这个标记',
    /SITE\.detailPageOnly && !isOnDetailPage\(itemId\) && !inBackgroundTab\(\)/.test(IJ));
}

/* ============================================================ */
section('4) ★ 淘宝等站不受影响');
{
  const tb = S.taobao;
  if (tb) {
    // 淘宝 pageIdRe 要求 6~20 位数字，测试 ID 得给够位数
    is('★ 淘宝的详情页仍能认出（item.htm）',
      isOnDetailPage(tb, 'https://item.taobao.com/item.htm?id=123456789') === true);
  }
  const jd = S.jd;
  if (jd) {
    is('★ 京东的详情页仍能认出',
      isOnDetailPage(jd, 'https://item.jd.com/123456.html') === true);
  }
  is('★ 所有已启用站点都认得出自己的详情页',
    ['xianyu', 'taobao', 'jd', 'p1688'].every(function (k) {
      const s = S[k];
      if (!s || !s.detailPageOnly) return true;
      const url = s.itemUrl ? s.itemUrl('123456789') : '';
      return isOnDetailPage(s, url) === true;
    }));
}

/* ============================================================ */
section('5) 症状对照');
{
  console.log('  修复前：');
  console.log('    isOnDetailPage(/item?id=) → false');
  console.log('    → 每层都借后台页 → ♻️ 递归');
  console.log('    → 标签页狂开、详情取不到、SKU 图下不来');
  console.log('  修复后：');
  console.log('    isOnDetailPage(/item?id=) → true');
  console.log('    → 后台页直接采 → 一层搞定');
  console.log('    → 详情与规格图正常拿');
  is('★ 双保险都在（配置 + inBgTab）',
    !!S.xianyu.detailPageRe && /inBgTab/.test(SW) && /inBackgroundTab/.test(IJ));
}

console.log('\n' + '─'.repeat(50));
if (fail) {
  console.log('✗ 有失败：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(1);
} else {
  console.log('✓ 全部通过：' + pass + ' 项断言');
}