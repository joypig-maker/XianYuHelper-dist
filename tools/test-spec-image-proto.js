/**
 * 规格图的协议升级（v1.8.4）
 *
 * 客户反复报「SKU 图还是下不来」。查出的直接原因：
 *
 * **主图和规格图走的是两条路径，只有一条做了协议升级**
 *
 *   主图：  d.images → filterItemImages() → normalizeImageUrl() → https ✓
 *   规格图：val.image → skusOf() 原样复制 → **http** ✗
 *
 * 闲鱼页面是 HTTPS，接口给的图却是 http://img.alicdn.com/... →
 * 混合内容被浏览器直接拦截 → 规格图一张都下不来，
 * 而且扩展的 downloads API **不报错**（静默失败）。
 *
 * 所以同一个商品：主图能下、规格图下不了 —— 就是这个差别。
 *
 * 跑：node tools/test-spec-image-proto.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const UT = fs.readFileSync(path.join(ROOT, 'src/common/util.js'), 'utf8');
const BR = fs.readFileSync(path.join(ROOT, 'src/content/bridge.js'), 'utf8');
const SW = fs.readFileSync(path.join(ROOT, 'src/background/service_worker.js'), 'utf8');

let pass = 0, fail = 0;
function is(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra != null ? '  → ' + extra : '')); }
}
function section(t) { console.log('\n' + t); }

const w = {}; vm.createContext(w);
vm.runInContext(UT, w, { timeout: 5000 });
const U = w.XYUtil;

const HTTP_IMG = 'http://img.alicdn.com/bao/uploaded/i4/O1CN01w6UGhB1dBHFuJg4U9_!!0-mtopupload.jpg';

/* ============================================================ */
section('1) ★ 主图路径本来就有协议升级');
{
  const r = U.filterItemImages([HTTP_IMG]);
  is('★ filterItemImages 把 http 升成 https',
    r.length === 1 && r[0].indexOf('https://') === 0, JSON.stringify(r));
}

/* ============================================================ */
section('2) ★★★ 规格图路径以前没有 —— 这是根因');
{
  // 复刻修复前的 skusOf：原样复制
  const oldSkusOf = function (d) {
    return {
      specDefs: (d.skus.specDefs || []).map(function (def) {
        return {
          name: def.name || '',
          values: (def.values || []).map(function (v) {
            return { value: v.value || '', image: v.image || '' };
          })
        };
      })
    };
  };
  const d = { skus: { specDefs: [{ name: '颜色', values: [{ value: '皮面果绿', image: HTTP_IMG }] }] } };
  const oldOut = oldSkusOf(d);
  is('★★ 旧写法保留 http（原样复制）',
    oldOut.specDefs[0].values[0].image.indexOf('http://') === 0,
    oldOut.specDefs[0].values[0].image.slice(0, 40));
  is('★★ 这就是规格图下不来的直接原因', oldOut.specDefs[0].values[0].image.indexOf('https://') !== 0);
}

/* ============================================================ */
section('3) ★★★ 修复：bridge 的 skusOf 要过 normalize');
{
  const fn = BR.slice(BR.indexOf('function skusOf'),
                      BR.indexOf('function skusOf') + 900);
  is('★ skusOf 里规格图调了 normalizeImageUrl',
    /image:\s*U\.normalizeImageUrl\(v\.image/.test(fn),
    (fn.match(/image:.{0,60}/) || [''])[0]);
  is('★ 其它字段没被破坏（value 原样保留）',
    /value:\s*v\.value/.test(fn));
}

/* ============================================================ */
section('4) ★★ 后台层也要有一道保险');
{
  is('★ 下载规格图时再 normalize 一次',
    /url:\s*U\.normalizeImageUrl\(val\.image\)/.test(SW));
  is('★ 文件名仍用原始 URL 算扩展名（保证与 info.json 一致）',
    /U\.skuSpecImageName\(g, v, val\.value, val\.image\)/.test(SW));
  is('★ realPaths 的键仍是原始 URL（与 info.json 查的键一致）',
    /realPaths\[val\.image\]/.test(SW));
}

/* ============================================================ */
section('5) 端到端核对：两条路径现在协议一致');
{
  const d = { skus: { specDefs: [{ name: '颜色', values: [{ value: '皮面果绿', image: HTTP_IMG }] }] } };
  // 新写法
  const newOut = {
    specDefs: d.skus.specDefs.map(function (def) {
      return {
        name: def.name,
        values: def.values.map(function (v) {
          return { value: v.value, image: U.normalizeImageUrl(v.image || '') };
        })
      };
    })
  };
  const mainImgs = U.filterItemImages([HTTP_IMG]);
  const specImgs = newOut.specDefs[0].values.map(function (v) { return v.image; });
  is('★★ 主图与规格图协议一致（都是 https）',
    mainImgs[0].indexOf('https://') === 0 && specImgs[0].indexOf('https://') === 0,
    mainImgs[0].slice(0, 30) + ' | ' + specImgs[0].slice(0, 30));
  is('★ 扩展名不受影响（.jpg）',
    U.imageExt(specImgs[0]) === '.jpg', U.imageExt(specImgs[0]));
  is('★ 规格图文件名仍能正确生成',
    U.skuSpecImageName(0, 0, '皮面果绿', specImgs[0]) === '1_1_皮面果绿.jpg',
    U.skuSpecImageName(0, 0, '皮面果绿', specImgs[0]));
}

console.log('\n' + '─'.repeat(50));
if (fail) {
  console.log('✗ 有失败：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(1);
} else {
  console.log('✓ 全部通过：' + pass + ' 项断言');
}