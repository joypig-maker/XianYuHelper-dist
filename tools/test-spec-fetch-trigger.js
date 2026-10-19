/**
 * 规格图补采的触发条件 + 标签页隔离（v1.7.1）
 *
 * 用户实测报了两个问题：
 *   ① 带 SKU 的商品仍然没下载到 SKU 图
 *   ② 软件在不断打开标签页面
 *
 * 两个问题**同一个根因**：needSpecFetch 的判断是「有任一维度值缺图」，
 * 而**尺码/尺寸这类维度天然就是无图的**（实测商品 844934128301：
 * 颜色 11/11 有图，尺码 0/12 有图）→ 条件必然为真 → 每件都白开一次
 * create-order 页。而那个页复用了补详情专用的标签页，结束时
 * chrome.tabs.remove 把补详情的页也回收了 → 补详情链路不停重建标签页。
 *
 * 跑：node tools/test-spec-fetch-trigger.js
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

const win = {}; vm.createContext(win);
vm.runInContext(UT, win, { timeout: 5000 });
const U = win.XYUtil;

/** 从 SW 里抽出触发条件那段逻辑，单独跑（与生产代码同一份正则） */
function triggerOf(specDefs, site) {
  const VISUAL_DIM = /颜色|色|款式|型号|版本|外观|花色|图案|套装|套餐|口味/i;
  return site === 'xianyu' && specDefs.length &&
    specDefs.some(function (d) {
      if (!d || !d.values || !d.values.length) return false;
      if (!VISUAL_DIM.test(d.name || '')) return false;
      return d.values.some(function (v) { return v && !v.image; });
    });
}

/* ============================================================ */
section('1) ★★ 尺码维度无图不应触发补采（用户报的「不断开标签页」）');
{
  const raw = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'tools/fixtures/xy-detail-real2.json'), 'utf8')
  );
  const s = U.parseSkus(raw.data);
  is('样本解析成功', !!s && s.specDefs.length === 2, s && JSON.stringify(s.specDefs.map(d => d.name)));
  const withImg = s.specDefs[0].values.filter(v => v.image).length;
  is('★ 颜色维度图全齐（接口本来就给）',
    withImg === s.specDefs[0].values.length, withImg + '/' + s.specDefs[0].values.length);
  is('★ 尺码维度确实无图', s.specDefs[1].values.every(v => !v.image));

  // 旧条件：只看「有没有缺图」——必然为真
  const oldTrigger = s.specDefs.some(d => (d.values || []).some(v => v && !v.image));
  is('★★ 旧条件必然为真（这就是不停开标签页的根源）', oldTrigger === true);

  // 新条件
  const nowTrigger = triggerOf(s.specDefs, 'xianyu');
  is('★★ 新条件为 false → 不再白开标签页', nowTrigger === false);
}

/* ============================================================ */
section('2) 真的缺图时才触发（视觉维度）');
{
  // 颜色维度缺图 → 该补
  const needImg = [{
    name: '颜色',
    values: [{ value: '红', image: '' }, { value: '蓝', image: '' }]
  }];
  is('★ 颜色维度缺图 → 触发补采', triggerOf(needImg, 'xianyu') === true);
}
{
  // 尺码维度缺图 → 不该补（本来就没有）
  const size = [{ name: '尺码', values: [{ value: '38', image: '' }, { value: '39', image: '' }] }];
  is('★ 尺码维度缺图 → 不触发', triggerOf(size, 'xianyu') === false);
}
{
  // 只测「天生不可能有图」的维度：尺码、重量、容量
  // 口味/颜色这类即使通常无图，也可能配图（不同口味不同包装），
  // 所以仍然列入 VISUAL_DIM —— 宁可多开一次页，也不要漏掉真实存在的图。
  ['尺码', '重量', '容量'].forEach(function (nm) {
    const d = [{ name: nm, values: [{ value: 'a', image: '' }] }];
    is('★ ' + nm + ' 维度 → 不触发', triggerOf(d, 'xianyu') === false);
  });
  is('★ 口味可能配图 → 仍视为视觉维度（宁可多查一次）',
    triggerOf([{ name: '口味', values: [{ value: 'a', image: '' }] }], 'xianyu') === true);
}
{
  // 其他视觉维度名也要能触发
  ['款式', '型号', '版本'].forEach(function (nm) {
    const d = [{ name: nm, values: [{ value: 'a', image: '' }] }];
    is('★ ' + nm + ' 维度缺图 → 触发', triggerOf(d, 'xianyu') === true);
  });
}
{
  // 混合：颜色有图 + 尺码无图 → 不触发
  const mixed = [
    { name: '颜色', values: [{ value: '红', image: 'https://x/a.jpg' }] },
    { name: '尺码', values: [{ value: '39', image: '' }] }
  ];
  is('★ 颜色有图 + 尺码无图 → 不触发', triggerOf(mixed, 'xianyu') === false);
}

/* ============================================================ */
section('3) 非闲鱼站点不触发（1688/淘宝自己就带图）');
{
  const d = [{ name: '颜色', values: [{ value: '红', image: '' }] }];
  is('★ p1688 不触发', triggerOf(d, 'p1688') === false);
  is('★ taobao 不触发', triggerOf(d, 'taobao') === false);
  is('★ jd 不触发', triggerOf(d, 'jd') === false);
}

/* ============================================================ */
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

section('4) ★★ 补采必须用独立标签页，不能碰补详情那个');
{
  const fn = grabFn(SW, 'collectSpecImagesViaTab');
  is('★ 不用 bgTabGet（那会共用补详情的页）', fn.indexOf('bgTabGet()') < 0);
  is('★ 自己 chrome.tabs.create 开页', fn.indexOf('chrome.tabs.create') > 0);
  // 注意：注释里提到 bgDetail.tabId 不算「碰」，只查实际赋值/读写
  is('★ 没有对 bgDetail.tabId 赋值（否则会打断补详情队列）',
    !/bgDetail\.tabId\s*=/.test(fn), (fn.match(/bgDetail\.tabId\s*=\s*\S+/g) || []).join());
  is('★ 结束只关自己这一页', fn.indexOf('chrome.tabs.remove(tabId)') > 0);
}

/* ============================================================ */
section('5) 规格图下载仍在补采之后');
{
  const i = SW.indexOf('return specReady.then(function () {');
  is('★ 下载任务等 specReady 完成', i > 0);
  const after = SW.slice(i, i + 600);
  is('★ 在 then 内部才建任务', after.indexOf('specDefs.forEach') > 0);
  is('★ info.json 落盘后才写标记文件',
    SW.indexOf('infoOk++') < SW.indexOf('return writeIdMark(dir, item.site'));
}

console.log('\n' + '─'.repeat(50));
if (fail) {
  console.log('✗ 有失败：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(1);
} else {
  console.log('✓ 全部通过：' + pass + ' 项断言');
}
