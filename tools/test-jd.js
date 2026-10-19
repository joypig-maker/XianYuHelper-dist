/**
 * 京东接入回归
 *
 * 结论全部来自真机实测（tools/diag-jd-*.js / verify-jd-live.js）：
 *   ① 搜索页 search.jd.com 是 SSR，卡片用 [data-sku]，但**卡片里没有商品直链**
 *      （a[href] 只有 //chat.jd.com 客服链接），ID 只能从 data-sku 取
 *   ② 类名是 CSS Modules（_wrapper_1y1ag_3），选择器只能 [class*=] 前缀匹配
 *   ③ 京东图床是 360buyimg.com —— 商品图白名单必须含它，
 *      否则卡片字段全有、唯独图 0 张，且毫无报错
 *
 * 数据层跑真实 DOM 片段，契约层从源码抠接线。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const rd = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('✓ ' + name); }
  else { fail++; console.log('✗ ' + name + (extra ? '  → ' + extra : '')); }
}

const win = {};
vm.createContext(win);
vm.runInContext(rd('src/common/util.js'), win, { timeout: 5000 });
vm.runInContext(rd('src/common/sites.js'), win, { timeout: 5000 });
const U = win.XYUtil;
const S = win.XYSites;
const J = S.jd;

const INJ = rd('src/content/injected.js');

/** 极简元素：只实现被测代码用到的那几个方法 */
function mkEl(attrs, parent, found) {
  return {
    getAttribute: (n) => (attrs && attrs[n] != null ? attrs[n] : null),
    parentElement: parent || null,
    // found 是「选择器 -> 元素」的映射，用来模拟 querySelector/closest。
    // 不传就退化成原来的两方法版本，老用例不受影响。
    querySelector: (sel) => (found && found[sel] != null ? found[sel] : null),
    closest: (sel) => (found && found['#' + sel] != null ? found['#' + sel] : null)
  };
}

/* ========================================================================== */
console.log('=== ① 站点与域名 ===');
{
  ok('京东站点存在', !!J);
  ok('已启用', J.enabled !== false);
  ok('search.jd.com 命中 jd', S.match('search.jd.com') && S.match('search.jd.com').key === 'jd');
  ok('item.jd.com 命中 jd', S.match('item.jd.com') && S.match('item.jd.com').key === 'jd');
  ok('mall.jd.com 命中 jd', S.match('mall.jd.com') && S.match('mall.jd.com').key === 'jd');
  ok('item.jd.hk 命中 jd', S.match('item.jd.hk') && S.match('item.jd.hk').key === 'jd');
  ok('active 返回站点而不是 null', !!S.active('search.jd.com'));
  ok('无关域名不命中', S.match('example.com') === null);
  // 别把别的域名误当京东。
  // 注意这个例子要选得准：`jd.com.evil.com` 用宽松的 indexOf('.jd.com') 也匹配不到
  // （那串里根本没有 ".jd.com" 子串），区分不出两种实现；
  // `x.jd.com.evil.com` 才会——它内部含 ".jd.com"，宽松写法会认，严格后缀匹配不会。
  ok('x.jd.com.evil.com 不算京东', S.match('x.jd.com.evil.com') === null);
  ok('jd.com.evil.com 不算京东', S.match('jd.com.evil.com') === null);
  ok('xjd.com 不算京东', S.match('xjd.com') === null);
  ok('详情页 ID 正则', J.idRe.test('https://item.jd.com/100066041106.html'));
  ok('itemUrl 生成正确', J.itemUrl('100066041106') === 'https://item.jd.com/100066041106.html');
}

/* ========================================================================== */
console.log('\n=== ② 商品 ID：搜索页认 data-sku，店铺页认 item.jd.com 直链 ===');
{
  // 两套页面结构完全不同，选择器必须同时覆盖：
  //   搜索页      [data-sku]（卡片里没有商品直链，唯一的 <a> 是客服链接）
  //   店铺页整店  li.gl-item（京东老版**经典类名**，不是 hash 名，可以写全名）
  ok('cardSel 同时覆盖搜索页 [data-sku] 与店铺页 li.gl-item',
    /\[data-sku\]/.test(J.cardSel) && /gl-item/.test(J.cardSel), J.cardSel);

  // ---- 搜索页这条路 ----
  ok('搜索页：直接从 data-sku 取', J.idFrom(mkEl({ 'data-sku': '100066041106' })) === '100066041106');
  ok('搜索页：自己没挂就往上层找', J.idFrom(mkEl({}, mkEl({ 'data-sku': '10122907704716' }))) === '10122907704716');
  ok('搜索页：非数字的 data-sku 不要', J.idFrom(mkEl({ 'data-sku': 'abc' })) === '');
  ok('搜索页：太短的不要', J.idFrom(mkEl({ 'data-sku': '123' })) === '');

  // ---- 店铺页这条路 ----
  ok('店铺页：从传进来的 href 取（通用路径会传）',
    J.idFrom(mkEl({}), '//item.jd.com/10216824761563.html?pcdk=A93i5DYmaExQsJe') === '10216824761563');
  ok('店铺页：href 带 #comment 锚点也能取',
    J.idFrom(mkEl({}), '//item.jd.com/10216824761563.html#comment') === '10216824761563');
  // 主路径 1 调用时 href 是空的（只有卡片元素），得靠卡片内部的直链
  const card = mkEl({ class: 'jSubObject gl-item' }, null, {
    'a[href*="item.jd.com/"]': mkEl({ href: '//item.jd.com/10099932587766.html' })
  });
  ok('店铺页：卡片内部直链取（href 为空时走这条）',
    J.idFrom(card, '') === '10099932587766');
  ok('linkSel 两种定位都给',
    J.linkSel('123456789') === '[data-sku="123456789"],a[href*="item.jd.com/123456789.html"]');

  ok('没有 data-sku、也没有任何直链时返回空', J.idFrom(mkEl({ href: '//item.jd.com/1.html' })) === '');
  // 真机事实：搜索页卡片里没有商品直链，ID 正则对 href 无效——这条锁住「别改回按 href 抠」
  ok('页面上不存在 item.jd.com 直链这个前提仍然成立（正则只用于详情页 URL）',
    !J.idRe.test('//chat.jd.com/index.action?entry=jd_search&pid=100275558589&score=0'));

  // 这条是实测撞出来的：店铺页上遍地是 data-id="774716" 这类 **shopId**，
  // 早先 scanCards 的兜底路径用通用属性名扫全页，就把 shopId 当成商品采了出来，
  // 结果是一条「没图没价没标题」的脏卡片。走 idFrom 之后两个来源都被限定住了。
  ok('shopId 这类非商品 ID 不会被采（idFrom 只认两个来源）',
    J.idFrom(mkEl({ 'data-id': '774716' })) === '');
  ok('venderId 同样不会被采', J.idFrom(mkEl({ 'data-id': '778749' })) === '');
}

/* ========================================================================== */
console.log('\n=== ③ 图片白名单：这次踩的坑 ===');
{
  // 京东图床是 360buyimg.com。三处白名单漏了它，卡片就是「字段全有、图 0 张」。
  const jdImg = 'https://img10.360buyimg.com/n2/s480x480_jfs/t1/393152/24/653/639/69d712e2F3241.jpg';
  ok('京东图被认作商品图', U.isNonItemImage(jdImg) === false,
    'isNonItemImage=' + U.isNonItemImage(jdImg));
  ok('白名单常量存在且含 360buyimg',
    typeof U.IMAGE_HOST_RE === 'object' && U.IMAGE_HOST_RE.test(jdImg));
  // 注意：不能写 `U.IMAGE_HOST_RE instanceof RegExp` —— util.js 跑在 vm 的
  // 另一个 Realm 里，跨 Realm 的 instanceof 恒为 false。

  // 老站点的图不能因为这次改动被误伤
  ok('alicdn 仍是商品图', U.isNonItemImage('https://img.alicdn.com/bao/uploaded/i1/a.jpg') === false);
  ok('taobaocdn 仍是商品图', U.isNonItemImage('https://img.taobaocdn.com/x.jpg') === false);
  ok('1688 图床仍是商品图', U.isNonItemImage('https://cbu01.alicdn.com/img/ibank/x.jpg') === false);

  // 挡非商品图的职责还在
  ok('陌生域名仍被挡', U.isNonItemImage('https://example.com/x.jpg') === true);
  ok('头像仍被挡', U.isNonItemImage('https://img10.360buyimg.com/avatar/x.jpg') === true);
  ok('logo 仍被挡', U.isNonItemImage('https://img10.360buyimg.com/logo.png') === true);
  ok('空值被挡', U.isNonItemImage('') === true);

  // 三处白名单必须同源，不能各写一份。
  // 剥掉常量定义本身再看——新常量里天然含旧的那串。
  const utilCode = rd('src/common/util.js');
  const withoutConst = utilCode.replace(/U\.IMAGE_HOST_RE\s*=\s*\/[^;]+;/g, '');
  ok('util 里不再有写死的 alicdn 白名单',
    !/alicdn\\\.com\|taobaocdn\\\.com\|1688\\\.com/i.test(withoutConst));
  ok('injected 里也不再有写死的白名单',
    !/alicdn\\\.com\|taobaocdn\\\.com\|1688\\\.com/i.test(INJ));
  ok('两处都改用 U.IMAGE_HOST_RE',
    (rd('src/common/util.js').match(/U\.IMAGE_HOST_RE/g) || []).length >= 2 &&
    (INJ.match(/U\.IMAGE_HOST_RE/g) || []).length >= 1);
}

/* ========================================================================== */
console.log('\n=== ④ 字段锚点（真机实测的落点） ===');
{
  // 类名是 CSS Modules，hash 会随版本变，所以一律 [class*=] 前缀
  const f = J.field;
  ok('标题用 title_container 前缀', f.title.some((s) => s.indexOf('[class*="title_container"]') === 0));
  ok('价格用 _price_ 前缀', f.price.some((s) => s.indexOf('[class*="_price_"]') === 0));
  ok('店铺用 _limit_ 前缀', f.shop.some((s) => s.indexOf('[class*="_limit_"]') === 0));
  ok('主图用 _img_ 前缀', /class\*="_img_"/.test(f.image));
  // 卡片里那几张不带 class 的图（活动图/角标）不能被当成主图
  ok('主图选择器不会误抓角标图（_imgTag_ 不含 _img_）',
    '_imgTag_1qvb0_1'.indexOf('_img_') === -1);
  ok('所有字段选择器都是前缀匹配，没有写死 hash',
    [].concat(f.title, f.price, f.shop, [f.image]).every((s) => !/_[0-9a-z]{5}_\d/.test(s)));
  ok('detailDom 已配', !!(J.detailDom && J.detailDom.descSel));
  ok('默认保存目录是京东采集', J.defaultDir === '京东采集');
}

/* ========================================================================== */
console.log('\n=== ⑤ 京东图床的 AVIF 陷阱 ===');
{
  // 京东按浏览器 Accept 协商格式，地址会变成 .../xxx.jpg.avif。
  // 不剥掉就是「文件名 .jpg、内容 AVIF」，铺货软件一张读不出来，
  // 而页面侧毫无报错——用户看到的现象是「主图一张都没下」。
  const avif = 'https://img14.360buyimg.com/n2/s480x480_jfs/t1/458998/17/1003/93738/6a2d99a8Ffef82a24/065c32032031a9c7.jpg.avif';
  ok('剥掉双层的 .jpg.avif',
    U.normalizeImageUrl(avif) === 'https://img14.360buyimg.com/n2/s480x480_jfs/t1/458998/17/1003/93738/6a2d99a8Ffef82a24/065c32032031a9c7.jpg',
    U.normalizeImageUrl(avif));
  ok('.png.avif 也剥', U.normalizeImageUrl('https://a/b.png.avif') === 'https://a/b.png');
  ok('.webp.avif 也剥', U.normalizeImageUrl('https://a/b.webp.avif') === 'https://a/b.webp');
  // 单层的 .avif 剥了可能直接 404，不敢动
  ok('单层 .avif 保持原样', U.normalizeImageUrl('https://a/b.avif') === 'https://a/b.avif');
  // 老站点的处理后缀清理不能受影响
  ok('alicdn 的 _400x400 后缀照旧清理',
    U.normalizeImageUrl('https://img.alicdn.com/bao/uploaded/i1/a.jpg_400x400q90.jpg') ===
    'https://img.alicdn.com/bao/uploaded/i1/a.jpg');
  ok('imageExt 认 avif（兜底：万一漏剥，至少扩展名和内容一致）',
    U.imageExt('https://a/b.avif') === '.avif');

  // 端到端：走完采集侧的过滤链之后，扩展名必须是 .jpg（内容也确实是 JPEG）
  const filtered = U.filterItemImages([avif]);
  ok('过滤之后仍然是京东图', filtered.length === 1, JSON.stringify(filtered));
  ok('过滤之后的扩展名是 .jpg', U.imageExt(filtered[0]) === '.jpg', U.imageExt(filtered[0]));
  ok('过滤之后 URL 里不再有 avif', filtered[0].indexOf('.avif') === -1, filtered[0]);
}

console.log('\n=== ⑦ 详情页：后台标签页 + DOM 解析 ===');
{
  // 京东没有 mtop 这类接口，详情数据只能靠详情页 DOM，所以必须借后台标签页
  ok('标注了「详情只在详情页拿得到」', J.detailPageOnly === true);
  ok('detailPageRe 认详情页', J.detailPageRe.test('https://item.jd.com/10118613870035.html'));
  ok('detailPageRe 认 jd.hk', J.detailPageRe.test('https://item.jd.hk/1234567.html'));
  ok('detailPageRe 不误伤搜索页', !J.detailPageRe.test('https://search.jd.com/Search?keyword=x'));
  ok('detailPageRe 不误伤店铺页', !J.detailPageRe.test('https://mall.jd.com/index-1000004123.html'));

  const dm = J.detailDom;
  // 详情页光 img 就有 160+ 张（评论图、推荐位全在里面），必须精确指定主图
  ok('主图有精确选择器（不全页扫）', /image-carousel/.test(dm.mainImgSel), dm.mainImgSel);
  ok('详情图单独配了选择器', !!dm.descImgSel, dm.descImgSel);
  ok('详情图有最小宽度阈值（挡小图标）', dm.descImgMinWidth >= 300, String(dm.descImgMinWidth));

  // 尺寸升级：京东把尺寸写在 URL 里，缩略图 6KB 且是 AVIF
  const up = J.imageUpgrade;
  ok('imageUpgrade 是函数', typeof up === 'function');
  const thumb = 'https://img10.360buyimg.com/pcpubliccms/s228x228_jfs/t1/a/b/c.jpg';
  ok('228 缩略图升到 800', up(thumb).indexOf('s800x800_') > -1, up(thumb));
  ok('升级只动路径参数，不碰域名', up(thumb).indexOf('img10.360buyimg.com') > -1);
  // 详情图本来就没有尺寸前缀，升级钩子不能凭空加（加了会 404）
  ok('没有尺寸前缀的 URL 保持原样',
    up('https://img13.360buyimg.com/pcpubliccms/jfs/t1/a/b.jpg') ===
    'https://img13.360buyimg.com/pcpubliccms/jfs/t1/a/b.jpg');

  // 契约层：这几根线断了的表现是「图又变成缩略图 / 又混进评论图」，都无声无息
  ok('domFallback 用站点级升级钩子', /var up = SITE\.imageUpgrade \|\| dm\.imageUpgrade;/.test(INJ));
  ok('domFallback 优先用 mainImgSel', /if \(dm\.mainImgSel\)/.test(INJ));
  ok('domFallback 把详情图并进图集',
    /imgs = U\.capImages\(U\.filterItemImages\(imgs\.concat\(descImgs\)\)\)/.test(INJ));
  ok('详情图在主图之后（截断时先保主图）',
    INJ.indexOf('imgs.concat(descImgs)') > INJ.indexOf('var descImgs = []'));
  // 上一版的坑：钩子挂在 detailDom 上，domFallback 却读站点级，两边对不上，
  // 表现是「升级看起来配了、其实没生效」，图还是 228 缩略图
  ok('升级钩子没被挂在 detailDom 里（避免两处不一致）', !dm.imageUpgrade);
  ok('cardImage 支持升级钩子', /U\.cardImage = function \(scope, selector, upgrade\)/.test(rd('src/common/util.js')));
  ok('scanCards 传了站点的升级钩子', /site\.imageUpgrade/.test(rd('src/common/util.js')));
}

console.log('\n=== ⑧ 店铺页（整店）：URL 规则与列表图档位 ===');
{
  // 入口长这样：https://mall.jd.com/view_search-991882-0-99-1-20-1.html
  //   段1 = appId，既不是 shopId 也不是 venderId
  //        （罗蒙：appId=991882 / shopId=774716 / venderId=778749）
  //   段2 = 分类 ID，传 0 就是「全部商品不筛选」（实测 2935 件 / 147 页）
  ok('店铺页正则认得 view_search',
    J.shopPageRe.test('https://mall.jd.com/view_search-991882-0-99-1-20-1.html'));
  ok('店铺页正则也认得 index',
    J.shopPageRe.test('https://mall.jd.com/index-16052428.html?from=pc'));
  ok('普通搜索页不算店铺页',
    !J.shopPageRe.test('https://search.jd.com/Search?keyword=%E6%89%8B%E6%9C%BA'));

  // appId 只能从店铺首页里那些「商品分类」链接里抓
  //（实测回力店铺首页里全是 view_search-4779926-<分类ID>-99-1-20-1.html）
  ok('从分类链接里认出 appId',
    J.shopAppIdIn('//mall.jd.com/view_search-4779926-1021895104-99-1-20-1.html') === '4779926');
  ok('从 view_search 页自己的 URL 里也能认',
    J.shopAppIdIn('https://mall.jd.com/view_search-991882-0-99-1-20-1.html') === '991882');
  ok('index 页 URL 里认不出 appId（那儿确实没有，得去 DOM 里找分类链接）',
    J.shopAppIdIn('https://mall.jd.com/index-16052428.html?from=pc') === '');
  ok('「所有商品」地址用分类 0 = 不筛选', /-0-99-1-20-1\.html$/.test(J.allGoodsUrl('991882')));

  // 列表图档位（读文件头量出来的真实像素，不是按体积猜的）：
  //   n0 = 800x800 原图 314KB / n12 = 800x800 312KB / n1 = 350x350 48KB（太小）
  //   n7 = 220x220 17KB ← 页面给的就是这个，必须升上去
  ok('列表图 n7 升到 n0（800x800 原图）',
    J.imageUpgrade('https://img14.360buyimg.com/n7/jfs/t1/425024/6/9565/x.jpg') ===
    'https://img14.360buyimg.com/n0/jfs/t1/425024/6/9565/x.jpg');
  ok('已经是 n12 的也归到 n0', /\/n0\//.test(J.imageUpgrade('https://img10.360buyimg.com/n12/jfs/t1/x/y.jpg')));
  // 尺寸段只该在域名后面。裸的 /\/n\d{1,2}\// 会把路径中间的 n1/n2 也换掉，
  // 把图悄悄换成另一张 —— 那是最难查的一类错。
  ok('路径中间的 n1 段不会被误改',
    J.imageUpgrade('https://img10.360buyimg.com/jfs/t1/n1/abc/x.jpg') ===
    'https://img10.360buyimg.com/jfs/t1/n1/abc/x.jpg');
  ok('详情页 pcpubliccms 的 s228x228 升到 s800x800',
    /\/s800x800_jfs\//.test(J.imageUpgrade('https://img10.360buyimg.com/pcpubliccms/s228x228_jfs/t1/x/y.jpg')));
  ok('非京东图不受影响（不会误伤淘宝图）',
    J.imageUpgrade('https://img.alicdn.com/bao/uploaded/i1/a.jpg_400x400q90.jpg') ===
    'https://img.alicdn.com/bao/uploaded/i1/a.jpg_400x400q90.jpg');

  // 字段锚点：店铺页和搜索页各一套，都要在
  ok('店铺页标题锚点 .jDesc a', J.field.title.indexOf('.jDesc a') > -1);
  ok('店铺页价格锚点 .jdPrice', J.field.price.indexOf('.jdPrice') > -1);
  ok('店铺页主图锚点 .jPic img', String(J.field.image).indexOf('.jPic img') > -1);
  ok('搜索页的老锚点没被挤掉',
    J.field.title.indexOf('[class*="title_container"]') > -1 &&
    J.field.price.indexOf('[class*="_price_"]') > -1 &&
    String(J.field.image).indexOf('img[class*="_img_"]') > -1);
  // cardImage 收的是「一个选择器字符串」（直接喂 querySelectorAll），不是候选数组
  // 契约层：兜底路径必须走站点 idFrom，不能退回通用属性名扫全页。
  // 只测 idFrom 纯函数是不够的 —— 真正把 shopId 采进来的是 scanCards 的那条兜底分支。
  const UTIL_SRC = rd('src/common/util.js');
  ok('scanCards 兜底路径优先用站点 idFrom',
    /var did = site\.idFrom\s*\n?\s*\?/.test(UTIL_SRC) &&
    /site\.idFrom\(nodes\[j\], ''\)/.test(UTIL_SRC));
  ok('兜底路径不再无条件用通用 attrId',
    !/for \(var j = 0; j < nodes\.length; j\+\+\) \{\s*var did = attrId\(nodes\[j\]\);/.test(UTIL_SRC));
}

console.log('\n=== ⑨ manifest 覆盖京东 ===');
{
  const m = JSON.parse(rd('manifest.json'));
  const inAll = [
    m.content_scripts[0].matches,
    m.content_scripts[1].matches,
    m.web_accessible_resources[0].matches
  ].every((arr) => arr.indexOf('https://*.jd.com/*') > -1);
  ok('三组 matches 都含 https://*.jd.com/*', inAll);
  ok('host_permissions 含京东图床', m.host_permissions.indexOf('https://*.360buyimg.com/*') > -1);
  ok('站点表与 manifest 不脱节（sites.js 有 jd，manifest 有域名）',
    /S\.jd = \{/.test(rd('src/common/sites.js')) && inAll);
}

console.log('\n———————————————————————————————');
console.log((fail === 0 ? '✓ 全部通过' : '✗ 有失败') + '：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
