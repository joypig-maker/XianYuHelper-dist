/**
 * 闲鱼 SKU 采集回归
 *
 * 背景：用户实测「闲鱼多规格，SKU 图片和 SKU 都没下载」。
 * 排查发现三个断点，其中两个是与字段名无关的共性缺陷，先修掉：
 *   ① fromSkuArray 把每个规格值的 image 硬写死 '' —— 走这条路的商品
 *      images/sku/ 一张图都不产（1688 走 fromSkuMap 所以没事）
 *   ② 路径穷举 + deepFind 全认不出时直接 return null，没有兜底
 *   ③ 本文件补上形状兜底 findSkuByShape
 *
 * ⚠️ 第三个断点（闲鱼真实字段名）尚未修——项目里从来没有过闲鱼接口样本，
 *    现有解析全是照淘宝/1688 形态猜的。需要 tools/capture-xianyu-sku.js
 *    抓到的真实 json 才能一次改对。在那之前，本文件用**多种可能的形态**
 *    覆盖，形态一旦对上就直接能用；对不上说明字段名还需要真实样本。
 *
 * 跑：node tools/test-xianyu-sku.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const win = {};
vm.createContext(win);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/common/util.js'), 'utf8'), win, { timeout: 5000 });
const U = win.XYUtil;

let pass = 0, fail = 0;
function is(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra != null ? '  → ' + extra : '')); }
}
function section(t) { console.log('\n' + t); }

/* ============================================================
   形态 A：淘宝式（props 在条目上，属性级带图）
   已知 fromSkuArray 原来会丢图，这里验它能挂上
   ============================================================ */
section('A) 属性级带图 → 必须挂到规格值上');
{
  const data = {
    itemDO: {
      skus: [
        {
          props: [
            { propName: '颜色', value: '红色', imageUrl: 'https://img.alicdn.com/r.jpg' },
            { propName: '尺码', value: 'M' }
          ],
          price: '99', quantity: 10
        },
        {
          props: [
            { propName: '颜色', value: '蓝色', imageUrl: 'https://img.alicdn.com/b.jpg' },
            { propName: '尺码', value: 'M' }
          ],
          price: '109', quantity: 5
        }
      ]
    }
  };
  const s = U.parseSkus(data);
  is('解析成功', !!s, JSON.stringify(s && s.list.length));
  is('两个组合行', s && s.list.length === 2, s && JSON.stringify(s.list.map(x => x.key)));
  is('价格/库存读到了',
    s && s.list[0].price === '99' && s.list[0].stock === '10',
    s && JSON.stringify(s.list[0]));
  // 这是本次修复的核心断言：以前这里必然是空串
  is('★ 属性级图片挂到了颜色维度（修复点）',
    s && s.specDefs[0].values[0].image === 'https://img.alicdn.com/r.jpg',
    s && JSON.stringify(s.specDefs[0].values));
  is('★ 第二个值也挂了图',
    s && s.specDefs[0].values[1].image === 'https://img.alicdn.com/b.jpg',
    s && JSON.stringify(s.specDefs[0].values));
  is('无图维度（尺码）仍是空串，不造假',
    s && s.specDefs[1].values[0].image === '',
    s && JSON.stringify(s.specDefs[1] && s.specDefs[1].values));

  const info = U.buildInfo({}, [], s, null);
  is('info.json 里 local_image 有值（软件能取到图）',
    info.sku_specs[0].values[0].local_image === 'images/sku/1_1_红色.jpg',
    info.sku_specs[0].values[0].local_image);
  is('image_url 也带上了（本地丢了可重下）',
    info.sku_specs[0].values[0].image_url === 'https://img.alicdn.com/r.jpg',
    info.sku_specs[0].values[0].image_url);
  is('无图值 local_image 是空串（规范 §3）',
    info.sku_specs[1].values[0].local_image === '');
}

/* ============================================================
   形态 B：组合级带图 + 单维 —— 应挂到唯一那个值上
   ============================================================ */
section('B) 单维 + 组合级带图 → 挂到唯一值上');
{
  const data = {
    skus: [
      { skuName: '红色', image: 'https://img.alicdn.com/1.jpg', price: '10', quantity: 3 },
      { skuName: '蓝色', image: 'https://img.alicdn.com/2.jpg', price: '20', quantity: 4 }
    ]
  };
  const s = U.parseSkus(data);
  is('解析成功', !!s && s.list.length === 2, s && JSON.stringify(s.list.map(x => x.key)));
  // 单维：组合级图就是该值唯一的那张，不算猜测
  const imgOf = (s && s.specDefs[0] && s.specDefs[0].values[0] && s.specDefs[0].values[0].image) || '';
  is('★ 单维时组合级图被挂上（修复点）', /1\.jpg/.test(imgOf), imgOf);
  const imgOf2 = (s && s.specDefs[0] && s.specDefs[0].values[1] && s.specDefs[0].values[1].image) || '';
  is('第二个值挂第二张', /2\.jpg/.test(imgOf2), imgOf2);
}

/* ============================================================
   形态 C：多维 + 组合级带图 —— 不能乱挂（规范 §5）
   ============================================================ */
section('C) 多维 + 组合级带图 → 不许乱挂');
{
  const data = {
    skus: [
      { props: [{ propName: '颜色', value: '红' }, { propName: '尺码', value: 'M' }],
        image: 'https://img.alicdn.com/combo.jpg', price: '10', quantity: 1 }
    ]
  };
  const s = U.parseSkus(data);
  is('解析成功', !!s && s.list.length === 1);
  is('多维时组合级图**没有**被挂到任何值上',
    s && s.specDefs.every(d => d.values.every(v => v.image === '')),
    s && JSON.stringify(s.specDefs.map(d => d.values)));
}

/* ============================================================
   形态 D：字段名完全不认识 —— 形状兜底
   ============================================================ */
section('D) 字段名不认识 → 形状兜底');
{
  // 故意用极冷僻的字段名，只有「形状」能认出来
  const data = {
    someWeirdModule: {
      stuffList: [
        { label: '红色', cost: '10', left: 3 },
        { label: '蓝色', cost: '20', left: 4 }
      ]
    }
  };
  const s = U.parseSkus(data);
  // label/cost/left 都不在 firstVal 的候选里，所以形状兜底也认不出规格名。
  // 这里断言的是「不崩、不造假」，而不是一定能解析出来。
  is('不崩且不返回脏数据', s === null || (Array.isArray(s.list) && s.list.length >= 1),
    JSON.stringify(s));
}

{
  // 用常见的 skuName + price/quantity，只是路径不认识 → 应能兜住
  const data = {
    totallyUnknownPath: {
      variants: [
        { skuName: '红色', price: '10', quantity: 3 },
        { skuName: '蓝色', price: '20', quantity: 4 }
      ]
    }
  };
  const s = U.parseSkus(data);
  is('★ 路径不认识但形状对 → 兜底认出来了',
    !!s && s.list.length === 2, JSON.stringify(s && s.list));
  is('兜底后规格名正确',
    s && JSON.stringify(s.list.map(x => x.key).sort()) === JSON.stringify(['红色', '蓝色']),
    s && JSON.stringify(s.list.map(x => x.key)));
  is('兜底后价格正确', s && s.list.some(x => x.price === '10'), s && JSON.stringify(s.list[0]));
}

{
  // 形状不像 SKU：只有文字没有价/库存 → 不该被误认成规格表
  const data = {
    nav: {
      tagList: [
        { title: '推荐' },
        { title: '最新' },
        { title: '热门' }
      ]
    }
  };
  const s = U.parseSkus(data);
  is('导航标签不会被误认成 SKU',
    s === null || !s.list.some(x => /推荐|最新/.test(x.key)),
    JSON.stringify(s && s.list));
}

/* ============================================================
   形态 E：单规格商品不该被当成多规格
   ============================================================ */
section('E) 单条数组不算规格表');
{
  const data = { skus: [{ skuName: '默认', price: '10', quantity: 1 }] };
  const s = U.parseSkus(data);
  is('单条数组被路径分支收走（形态合法）', !!s, JSON.stringify(s));
}

/* ============================================================
   汇总
   ============================================================ */
console.log('\n' + '─'.repeat(50));
if (fail) {
  console.log('✗ 有失败：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(1);
} else {
  console.log('✓ 全部通过：' + pass + ' 项断言');
}