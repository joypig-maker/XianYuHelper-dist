/**
 * 后台标签页补详情 回归
 *
 * 锁的是「详情接口只认详情页上下文」这条约束下的整条链路：
 *   injected(搜索页) → postbus → bridge → SW 开后台标签页 → 详情页 bridge
 *     → 详情页 injected 采集 → 原路回传
 *
 * 数据层跑真实固件（tools/fixtures/tb-*.json），契约层从源码抠接线。
 * 契约层在这里特别重要：这条链路的每一段都是「静默失败」的——
 * 少接一根线，表现只是「图又变成 1 张」，不会有任何报错。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const fx = (n) => JSON.parse(rd(path.join('tools', 'fixtures', n)));

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('✓ ' + name); }
  else { fail++; console.log('✗ ' + name + (extra ? '  → ' + extra : '')); }
}

/** 从源码里抠出某个函数/方法的函数体（按花括号配平） */
function bodyOf(src, sig) {
  const i = src.indexOf(sig);
  if (i < 0) return '';
  const j = src.indexOf('{', i);
  if (j < 0) return '';
  let depth = 0;
  for (let k = j; k < src.length; k++) {
    const c = src[k];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (!depth) return src.slice(j, k + 1); }
  }
  return src.slice(j);
}

/**
 * 剥掉注释再断言。
 * 代码里那段「以前写成 if (!got) return d;」的解释性注释是刻意留的文档，
 * 不剥掉的话，检查「这行还在不在」的断言会被自己的注释喂成假阳性。
 */
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const win = {};
vm.createContext(win);
vm.runInContext(rd('src/common/util.js'), win, { timeout: 5000 });
vm.runInContext(rd('src/common/sites.js'), win, { timeout: 5000 });
const U = win.XYUtil;
const S = win.XYSites;
const T = S.taobao;

const INJ = rd('src/content/injected.js');
const BR = rd('src/content/bridge.js');
const SW = rd('src/background/service_worker.js');

/* ========================================================================== */
console.log('=== ① 为什么需要后台标签页：站点标注与详情页判定 ===');
{
  ok('淘宝标注了「详情接口只认详情页上下文」', T.detailPageOnly === true);
  ok('detailPageRe 认淘宝详情页',
    T.detailPageRe.test('https://item.taobao.com/item.htm?id=669745626548'));
  ok('detailPageRe 认天猫详情页',
    T.detailPageRe.test('https://detail.tmall.com/item.htm?id=669745626548'));
  ok('detailPageRe 不误伤搜索页', !T.detailPageRe.test('https://s.taobao.com/search?q=x'));
  ok('detailPageRe 不误伤店铺页',
    !T.detailPageRe.test('https://minwai.tmall.com/category.htm?shopId=1'));

  // isOnDetailPage：必须「URL 里有 id」且「id 对得上」且「路径像详情页」三者同时成立
  const fn = bodyOf(INJ, 'function isOnDetailPage');
  ok('isOnDetailPage 取到 itemId 才继续', /currentItemId\(\)/.test(fn));
  ok('isOnDetailPage 比对 id，防止张冠李戴', /String\(here\)\s*!==\s*String\(itemId\)/.test(fn));
  ok('isOnDetailPage 校验路径形态', /detailPageRe/.test(fn));

  ok('fetchCardDetailCore 会在非详情页时改走后台标签页',
    /SITE\.detailPageOnly\s*&&\s*!isOnDetailPage\(itemId\)/.test(bodyOf(INJ, 'async function fetchCardDetailCore')));
  ok('fetchDetailViaTab 经 postbus 请求 bridge', /ask\('bridge',\s*'bg-detail'/.test(bodyOf(INJ, 'function fetchDetailViaTab')));
  ok('fetchDetailViaTab 超时给足批量排队的时间（≥30s）',
    (function () {
      const m = bodyOf(INJ, 'function fetchDetailViaTab').match(/timeout:\s*(\d+)/);
      return m && Number(m[1]) >= 30000;
    })());
}

/* ========================================================================== */
console.log('\n=== ② 详情页侧：接采集指令（这条是链路的折返点） ===');
{
  ok('injected 注册了 collect-detail', /bus\.on\('bridge',\s*'collect-detail'/.test(INJ));
  const h = bodyOf(INJ, "bus.on('bridge', 'collect-detail'");
  ok('collect-detail 复用 fetchCardDetail（含图集补录）', /fetchCardDetail\(/.test(h));
  ok('collect-detail 回包带 ok 标记', /ok:\s*true/.test(h) && /ok:\s*false/.test(h));

  ok('bridge 监听 SW 下发的 xy:collect-detail',
    /chrome\.runtime\.onMessage\.addListener/.test(BR) && /xy:collect-detail/.test(BR));
  const mh = bodyOf(BR, 'chrome.runtime.onMessage.addListener');
  ok('收到后转发给 injected 的 collect-detail', /askInjected\('collect-detail'/.test(mh));
  ok('返回 true 保持异步响应通道', /return true/.test(mh));
}

/* ========================================================================== */
console.log('\n=== ③ bridge 与 SW 之间的转发 ===');
{
  ok('bridge 注册了 bg-detail 处理器', /bus\.on\('injected',\s*'bg-detail'/.test(BR));
  const h = bodyOf(BR, "bus.on('injected', 'bg-detail'");
  ok('转发给 SW 的 xy:bg-detail', /callBg\(\{\s*type:\s*'xy:bg-detail'/.test(h));
  ok('地址由页面侧按站点规则生成（不硬编码）', /SITE\.itemUrl/.test(h));
  ok('缺 itemId 直接拒绝', /缺 itemId/.test(h));
}

/* ========================================================================== */
console.log('\n=== ④ service worker：开页 / 导航 / 下发 / 回收 ===');
{
  ok('处理 xy:bg-detail', /'xy:bg-detail'/.test(bodyOf(SW, 'chrome.runtime.onMessage.addListener')));
  ['bgTabGet', 'bgWaitComplete', 'bgSend', 'bgNavigate', 'bgCollectOne',
    'bgDetailJob', 'bgArmIdleClose', 'bgUrlAllowed'].forEach((fn) => {
      ok('存在 ' + fn, new RegExp('function\\s+' + fn + '\\b').test(SW));
    });

  ok('后台标签页不抢焦点（active:false）',
    /chrome\.tabs\.create\(\{\s*url:\s*'about:blank',\s*active:\s*false\s*\}/.test(SW) ||
    /chrome\.tabs\.create\(\{[^}]*active:\s*false/.test(SW));
  ok('等的是 onUpdated 的 complete', /info\.status\s*===\s*'complete'/.test(SW));
  ok('导航前先挂监听（否则会漏掉 complete 事件）',
    (function () {
      const nav = bodyOf(SW, 'async function bgNavigate');
      const iWait = nav.indexOf('bgWaitComplete');
      const iUpd = nav.indexOf('chrome.tabs.update');
      return iWait > -1 && iUpd > -1 && iWait < iUpd;
    })());
  ok('已在目标页就不再导航（重复导航不一定发 complete）', /cur\.url === url/.test(SW));
  ok('串行执行，不并发开页', /bgDetail\.chain/.test(SW));
  ok('件与件之间有限速', /bgDetail\.GAP/.test(SW));
  ok('忙完静置回收标签页', /chrome\.tabs\.remove/.test(SW));

  ok('商品 ID 做合法性校验', /\/\^\\d\{5,20\}\$\//.test(SW));
  ok('目标地址走白名单（别让消息把 SW 当跳板）', /bgUrlAllowed\(bgUrl\)/.test(SW));
  const au = bodyOf(SW, 'function bgUrlAllowed');
  ok('白名单依据站点表判定', /SITES\.match/.test(au));
  ok('站点被停用也不放行', /enabled\s*!==\s*false/.test(au));

  // 取不到就放弃，而不是反复拿同一个结果去磨接口
  const one = bodyOf(SW, 'async function bgCollectOne');
  ok('bridge 已应答但采不到时立即放弃（不重试）', /if \(r\) return null;/.test(one));
  ok('只有在 bridge 未就绪时才重试', /bgSleep\(700\)/.test(one));
}

/* ========================================================================== */
console.log('\n=== ⑤ 图集拼装：5 张主图 + 22 张详情图 → 截断到 9 ===');
{
  const detail = U.extractDetail(fx('tb-detail.json'), T);
  const main = U.filterItemImages(detail.images || []);
  const desc = U.parseTaobaoDesc(fx('tb-desc.json'));
  ok('详情主接口给主图', main.length > 0, String(main.length));
  ok('主图不超过 5 张（平台上限）', main.length <= 5, String(main.length));
  ok('详情正文给 20+ 张图', desc.length >= 20, String(desc.length));
  ok('详情图里没有混进价格说明图',
    !desc.some((u) => /tmallPriceDesc|tps-/i.test(u)));

  const merged = U.capImages(U.filterItemImages(main.concat(desc)));
  ok('合并后正好截断到 9 张（闲鱼图位上限）', merged.length === 9, String(merged.length));
  ok('截断时保住主图（顺序即优先级）',
    main.every((u, i) => merged[i] === u));
  ok('详情主接口的价格是到手价 4.01', String(detail.price) === '4.01', String(detail.price));
}

/* ========================================================================== */
console.log('\n=== ⑥ ensureSkus：详情图补录不能挂在 skuApi 上 ===');
{
  const es = bodyOf(INJ, 'async function ensureSkus');
  ok('ensureSkus 源码取到', es.length > 200);
  // 回归点：以前是 `if (!got) return d;` —— 淘宝没有 skuApi，
  // 于是详情图那段（在它后面）永远跑不到，真机只出 1 张图。
  // 断言前先剥注释：解释这个 bug 的注释里就写着那行原文。
  const esCode = stripComments(es);
  ok('没有「拿不到 sku 就整个返回」的早退', !/if\s*\(!got\)\s*return d;/.test(esCode));
  ok('补规格那段有 skuApi 守卫', /SITE\.skuApi/.test(esCode));
  ok('详情图补录独立于 skuApi 段（fetchDescImages 仍在）', /fetchDescImages\(itemId\)/.test(esCode));
  ok('详情图补录仍受 opts.descImages 约束（大批量扫描不占额度）',
    /opts\.descImages/.test(esCode));
  ok('详情图补录前检查图位是否已满', /imageCount\(d\)\s*<\s*U\.IMAGE_CAP/.test(esCode));
  // 图集拼接两条路都要兜底 d.images 缺失的情况（列表页卡片可能只有单张 image）
  ok('两段拼图都兼容「只有单张 image」的卡片',
    (esCode.match(/d\.image \? \[d\.image\] : \[\]/g) || []).length >= 2);
}

console.log('\n———————————————————————————————');
console.log((fail === 0 ? '✓ 全部通过' : '✗ 有失败') + '：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
