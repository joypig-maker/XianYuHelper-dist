/**
 * 图片来源链路回归
 *
 * 锁的是这轮修掉的三个真问题（都是「下载目录里没图 / 只有 3 张」的根因）：
 *   ① 1688 关键词搜索页：接口数据认不出来 → 一张图都拿不到
 *   ② 列表页接口只给 1~3 张缩略图，完整主图集（5 张）随 SKU 响应一起被丢
 *   ③ 主图撑不满 9 个图位时，没有从详情正文补的机制
 *
 * 断言分成两层：
 *   数据层 —— 用真实抓包固件跑解析函数，看实际产出几张图
 *   契约层 —— 从源码抠调用关系，防止接好的线被人改回去
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const fx = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'fixtures', n), 'utf8'));

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('✓ ' + name); }
  else { fail++; console.log('✗ ' + name + (extra ? '  → ' + extra : '')); }
}

/* ---------------- 加载公共库 ---------------- */

const win = {};
vm.createContext(win);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/common/util.js'), 'utf8'), win, { timeout: 5000 });
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/common/sites.js'), 'utf8'), win, { timeout: 5000 });
const U = win.XYUtil;
const S = win.XYSites;
const SITE = S.p1688;

const INJ = fs.readFileSync(path.join(ROOT, 'src/content/injected.js'), 'utf8');
const BRG = fs.readFileSync(path.join(ROOT, 'src/content/bridge.js'), 'utf8');

console.log('=== ① 1688 关键词搜索页：必须能出卡片且有图 ===');
{
  const cards = U.collectCards(fx('1688-search-api.json'), { site: SITE });
  ok('搜索页接口数据能解析出商品', cards.length >= 5, '实际 ' + cards.length + ' 张');
  // 下面的断言全部带 cards.length 前缀：[].every() 恒为 true，
  // 不加这道判断的话，解析彻底失效时这里反而会一片全绿。
  ok('每张都带图（不再是零图）', cards.length > 0 && cards.every((c) => (c.images || []).length >= 1),
    '图数分布：' + cards.map((c) => (c.images || []).length).join('/'));
  ok('ID 取自 offerId 字段而非漏解析',
    cards.length > 0 && cards.every((c) => /^\d{6,}$/.test(String(c.itemId))),
    cards.length ? '样例 ' + cards[0].itemId : '没有卡片');
  ok('主图 URL 指向 alicdn 商品图',
    cards.length > 0 && (cards[0].images || []).length > 0 &&
    /alicdn\.com\/img\/(?:ibank|imgextra)\//.test(cards[0].images[0]),
    cards.length && cards[0].images.length ? cards[0].images[0] : '没有图');
  ok('单值主图也落到了 images 数组（下游只读这里）',
    cards.length > 0 && cards.every((c) => Array.isArray(c.images) && c.images.length));
}

console.log('\n=== ② 1688 整店页：回归原有能力 ===');
{
  const cards = U.collectCards(fx('1688-offerlist.json'), { site: SITE });
  ok('整店页仍能解析出商品', cards.length === 5, '实际 ' + cards.length);
  ok('列表接口给几张就是几张（不虚增）', cards[0].images.length === 3,
    '实际 ' + cards[0].images.length);
}

console.log('\n=== ③ SKU 响应里的完整主图集 ===');
{
  const main = U.parseMainImages(fx('1688-sku-selector.json'));
  ok('mainImageList 被提出主图集', main.length === 5, '实际 ' + main.length + ' 张');
  ok('全部是完整 https 地址（不是裸相对路径）',
    main.every((u) => /^https:\/\//.test(u)), main[0]);
  ok('异常输入返回空数组不抛错',
    U.parseMainImages(null).length === 0 && U.parseMainImages({}).length === 0);

  // 整店页只有 3 张 + SKU 补 5 张，并集后应当比原来多
  const shop = U.collectCards(fx('1688-offerlist.json'), { site: SITE })[0];
  const merged = U.filterItemImages(shop.images.concat(main));
  ok('列表 3 张 + 主图集 5 张 → 并集多于列表本身', merged.length > shop.images.length,
    '列表 ' + shop.images.length + ' → 合并 ' + merged.length);
}

console.log('\n=== ④ 详情正文补图 ===');
{
  const html = [
    '<p>说明文字</p>',
    '<img src="https://cbu01.alicdn.com/img/ibank/D1.jpg" />',
    '<img data-src="//cbu01.alicdn.com/img/ibank/D2.jpg" />',
    '<div style="background-image:url(https://cbu01.alicdn.com/img/ibank/D3.jpg)"></div>',
    '<img src="https://cbu01.alicdn.com/img/ibank/D1.jpg" />',
    '<img src="data:image/gif;base64,R0lGODlh" />'
  ].join('');
  const got = U.imagesFromHtml(html);
  ok('三种挂载形态都认：img/src、懒加载、background-image',
    got.some((u) => /D1\.jpg/.test(u)) && got.some((u) => /D2\.jpg/.test(u)) &&
    got.some((u) => /D3\.jpg/.test(u)), '拿到 ' + got.filter((u) => /D\d\.jpg/.test(u)).length + ' 张');
  ok('重复 URL 被去重', got.filter((u) => /D1\.jpg/.test(u)).length === 1);
  ok('协议相对地址 // 已被补成 https', got.every((u) => !/^\/\//.test(u)));
  ok('base64 占位图由 filterItemImages 剔除',
    !U.filterItemImages(got).some((u) => /^data:/.test(u)));
  ok('纯文本描述不产生任何图（不必跑正则）',
    U.imagesFromHtml('就是一段没有图的描叙').length === 0);
  // 畸形输入若触发死循环，这里会超时
  ok('畸形输入不死循环', U.imagesFromHtml('<img src= ').length === 0 &&
    U.imagesFromHtml('<img>').length === 0);
}

console.log('\n=== ⑤ 图集上限 ===');
{
  const twelve = Array.from({ length: 12 }, (_, i) => 'https://x.test/' + i + '.jpg');
  ok('超过 9 张被截断', U.capImages(twelve).length === 9);
  ok('不足 9 张原样保留', U.capImages(twelve.slice(0, 4)).length === 4);
  ok('IMAGE_CAP 就是闲鱼的图位上限 9', U.IMAGE_CAP === 9, String(U.IMAGE_CAP));

  // 顺序即优先级：主图必须排在详情图前面，否则截的就是主图
  const data = {
    itemId: '123456789', title: '一个有详情图也有主图的商品',
    desc: '<img src="https://cbu01.alicdn.com/img/ibank/DESC1.jpg" />',
    itemDO: { imageInfos: [{ url: 'https://cbu01.alicdn.com/img/ibank/MAIN1.jpg' }] }
  };
  const d = U.extractDetail({ data: data }, SITE);
  ok('详情解析把正文里的图也收进图集', (d.images || []).some((u) => /DESC1\.jpg/.test(u)),
    '图集：' + (d.images || []).map((u) => u.slice(-14)).join(', '));
  ok('主图排在详情图之前（截断时先保主图）',
    d.images[0] && /MAIN1\.jpg/.test(d.images[0]), String(d.images[0]));
}

console.log('\n=== ⑥ 源码契约：接好的线不许改回去 ===');
{
  ok('ensureSkus 消费了 SKU 响应带回的主图', /d\.images = U\.filterItemImages\([\s\S]{0,120}concat\(got\.images\)/.test(INJ),
    '没找到 d.images 合并 got.images');
  ok('fetchSkus 同时返回规格和主图', /return \{ skus: skus \|\| null, images: images \}/.test(INJ));
  ok('第二遍补录不再只按「有没有规格」筛（图少也得进来）',
    /!c\.skus \|\| imageCount\(c\) < MAIN_IMAGE_TARGET/.test(INJ),
    '否则描述齐全但只有 3 张图的商品会被永久跳过');
  ok('MAIN_IMAGE_TARGET 是 5（1688 后台主图上限）',
    /var MAIN_IMAGE_TARGET = 5;/.test(INJ));
  ok('只有准备打包的那批才补详情图（批量扫描不占请求额度）',
    /opts && opts\.descImages && imageCount\(d\) < U\.IMAGE_CAP/.test(INJ));
  ok('fetchCardDetail 打开了详情图补录', /ensureSkus\(d, itemId, \{ descImages: true \}\)/.test(INJ));
  ok('1688 配了详情正文取图地址', /descApi: \{[\s\S]{0,120}OfferDescriptionWidget\.do\?offerId=/.test(
    fs.readFileSync(path.join(ROOT, 'src/common/sites.js'), 'utf8')));
  ok('selectedItems 按上限截断', /U\.capImages\(U\.filterItemImages\(/.test(BRG));
  ok('详情 DOM 分支也按上限截断（内存里的图集不失控）', /images: U\.capImages\(imgs\)/.test(INJ));
}

console.log('\n' + '='.repeat(50));
if (fail === 0) console.log('全部通过 ✅  ' + pass + ' 项');
else console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项 ❌');
process.exit(fail === 0 ? 0 : 1);
