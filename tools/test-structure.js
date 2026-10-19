/**
 * 下载目录结构回归
 *
 * 这套结构是**给铺货软件读的输入契约**，不是我们自己的内部约定——
 * 改错了用户不会看到报错，只会看到软件认不出商品。
 * 所以两个层面都要锁：
 *   ① 数据层：info.json 里的路径必须和真实落盘文件名严格一致
 *   ② 契约层：三个入口（SW / bridge / popup）都按同一套结构落盘
 *
 * 目录约定：
 *   <下载目录>/downloaded_items/<商品夹>/
 *     ├── info.json          软件靠它识别商品
 *     ├── images/            主图，文件名就是序号
 *     │   └── sku/           规格图单独一层
 *     ├── video/             主图视频
 *     └── 文案.txt
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
const U = win.XYUtil;

const SW = rd('src/background/service_worker.js');
const BR = rd('src/content/bridge.js');
const PO = rd('src/popup/popup.js');

/* ========================================================================== */
console.log('=== ① 目录常量 ===');
{
  ok('主图目录 images', U.IMAGES_DIR === 'images');
  ok('规格图目录 images/sku', U.SKU_DIR === 'images/sku');
  ok('视频目录 video', U.VIDEO_DIR === 'video');
  ok('info.json 文件名', U.INFO_FILE === 'info.json');
  ok('规格图在 images 之下（不混进主图那一层）',
    U.SKU_DIR.indexOf(U.IMAGES_DIR + '/') === 0);
}

/* ========================================================================== */
console.log('\n=== ② 文件名生成 ===');
{
  ok('主图按序号命名', U.imageFileName('https://a/b.jpg', 0) === '1.jpg');
  ok('主图第 3 张是 3', U.imageFileName('https://a/b.jpg', 2) === '3.jpg');
  // 淘宝的主图 URL 经常带压缩后缀，扩展名不能跟着走
  ok('压缩后缀不进文件名',
    U.imageFileName('https://img.alicdn.com/x.jpg_400x400q90.jpg', 0) === '1.jpg',
    U.imageFileName('https://img.alicdn.com/x.jpg_400x400q90.jpg', 0));
  ok('webp 保留', U.imageFileName('https://a/b.webp', 0) === '1.webp');
  ok('看不出来路时兜底 .jpg', U.imageFileName('https://a/noext', 0) === '1.jpg');

  // 对接规范 §2：images/sku/<维度序号>_<值序号>_<安全值名>.<ext>
  ok('规格图名 = 维度_值_安全值名',
    U.skuSpecImageName(0, 0, '红色', 'https://a/s.jpg') === '1_1_红色.jpg',
    U.skuSpecImageName(0, 0, '红色', 'https://a/s.jpg'));
  ok('第二个维度从 2 起，不会和第一个维度撞名',
    U.skuSpecImageName(1, 0, '红色', 'https://a/s.jpg') === '2_1_红色.jpg');
  // 非法字符是**替换**成 _，不是删掉——删掉就看不出原来是个两段值
  ok('非法字符替换成下划线（不是删除）',
    U.skuSpecImageName(0, 0, '红/蓝', 'https://a/s.jpg') === '1_1_红_蓝.jpg',
    U.skuSpecImageName(0, 0, '红/蓝', 'https://a/s.jpg'));
  ok('规格值为空时兜底「规格」',
    U.skuSpecImageName(0, 1, '', 'https://a/s.jpg') === '1_2_规格.jpg');
  ok('长值名截断到 40', U.skuSpecImageName(0, 0, 'x'.repeat(60), 'https://a/s.jpg') === '1_1_' + 'x'.repeat(40) + '.jpg');
  ok('扩展名保留原样（webp 不转 jpg）',
    U.skuSpecImageName(0, 0, '红', 'https://a/s.webp') === '1_1_红.webp');
  // 同维度内值重名靠值序号区分；跨维度重名靠维度序号
  ok('同名值不撞车',
    U.skuSpecImageName(0, 0, '红', 'x.jpg') !== U.skuSpecImageName(0, 1, '红', 'x.jpg'));
}

/* ========================================================================== */
console.log('\n=== ③ info.json 内容 ===');
{
  const imgs = ['https://a/1.jpg', 'https://a/2.jpg', 'https://a/3.webp'];
  const skus = {
    specs: ['颜色'],
    specDefs: [
      {
        name: '颜色',
        values: [
          { value: '红', image: 'https://a/s1.jpg' },
          { value: '蓝', image: '' },                    // 没有图：占位但不产文件
          { value: '绿', image: 'https://a/s3.jpg' }
        ]
      }
    ],
    list: [
      { key: '红', price: '4.01', stock: '10', image: 'https://a/s1.jpg' },
      { key: '蓝', price: '4.01', stock: '8' },                       // 没有图
      { key: '绿', price: '4.5', stock: '0', image: 'https://a/s3.jpg' }
    ]
  };
  const info = U.buildInfo({ title: 'T', description: 'D', price: '4.01' }, imgs, skus);

  ok('title / description / price 直通',
    info.title === 'T' && info.description === 'D' && info.price === '4.01');
  ok('local_images 带 images/ 前缀',
    JSON.stringify(info.local_images) === JSON.stringify(['images/1.jpg', 'images/2.jpg', 'images/3.webp']),
    JSON.stringify(info.local_images));
  ok('sku_info 是数组且条数对得上', Array.isArray(info.sku_info) && info.sku_info.length === 3);
  ok('sku_info 带规格名/价格/库存',
    info.sku_info[0].name === '红' && info.sku_info[0].price === '4.01' && info.sku_info[0].stock === '10');

  // 组合行不再有 local_image：多维组合对应多张图，指哪个都不对，
  // 指一个不存在的文件比干脆不写更糟。图片一律走 sku_specs。
  ok('sku_info 不再带 local_image（避免指向不存在的文件）',
    info.sku_info.every((s) => s.local_image === undefined),
    JSON.stringify(info.sku_info.map((s) => s.local_image)));

  // ===== sku_specs（对接规范 §3）=====
  ok('sku_specs 存在且维度数对得上', Array.isArray(info.sku_specs) && info.sku_specs.length === 1);
  ok('维度名原样输出', info.sku_specs[0].name === '颜色');
  ok('值原样输出，不缩短', info.sku_specs[0].values[0].value === '红');
  ok('有图的值给出 local_image',
    info.sku_specs[0].values[0].local_image === 'images/sku/1_1_红.jpg',
    info.sku_specs[0].values[0].local_image);
  ok('有图的值给出 image_url（本地丢了可兜底重下）',
    info.sku_specs[0].values[0].image_url === 'https://a/s1.jpg');
  // 规范 §4.1：值序号按原始顺序，无图的值也占位，绝不跳
  ok('无图的值占位：local_image 空串 + 值序号不跳',
    info.sku_specs[0].values[1].value === '蓝' &&
    info.sku_specs[0].values[1].local_image === '' &&
    info.sku_specs[0].values[2].local_image === 'images/sku/1_3_绿.jpg',
    JSON.stringify(info.sku_specs[0].values.map((v) => v.local_image)));

  const multi = U.buildInfo({}, [], {
    specs: ['颜色', '尺码'],
    specDefs: [
      { name: '颜色', values: [{ value: '红色', image: 'https://a/r.jpg' }] },
      { name: '尺码', values: [{ value: 'S', image: '' }] }
    ],
    list: [{ key: '红色|S', price: '9.9', stock: '1999' }]
  });
  ok('多维时维度序号各自从 1 起，跨维度同名也不撞',
    multi.sku_specs[0].values[0].local_image === 'images/sku/1_1_红色.jpg' &&
    multi.sku_specs[1].values[0].local_image === '',
    JSON.stringify(multi.sku_specs.map((d) => d.values.map((v) => v.local_image))));
  ok('组合键用 | 连接维度值（规范 §4.2）', multi.sku_info[0].name === '红色|S');

  const empty = U.buildInfo(null, null, null);
  ok('全空时不炸，返回规整的空结构',
    empty.title === '' && empty.local_images.length === 0 &&
    empty.sku_info.length === 0 && empty.price === '' && empty.sku_specs.length === 0);

  // 主图数组里的空洞（解析失败留下的）不能把序号带偏
  const holey = U.buildInfo({}, ['https://a/1.jpg', '', 'https://a/3.jpg'], null);
  ok('主图里的空位被剔除',
    JSON.stringify(holey.local_images) === JSON.stringify(['images/1.jpg', 'images/2.jpg']),
    JSON.stringify(holey.local_images));
}

/* ========================================================================== */
console.log('\n=== ④ service worker 按新结构落盘 ===');
{
  // 这两条锚到行首缩进，而不是「文件里有没有出现过 U.IMAGES_DIR」——
  // 后者会被 `if (false) jobs.push(...)` 这类注入绕过：字还在，代码不跑。
  ok('主图写到 images/',
    /\n\s+filename: dir \+ '\/' \+ U\.IMAGES_DIR \+ '\/' \+ U\.imageFileName\(url, i\),/.test(SW));
  ok('规格图写到 images/sku/（维度值级命名）',
    /\n\s+filename: dir \+ '\/' \+ U\.SKU_DIR \+ '\/' \+/.test(SW));
  ok('规格图下载遍历的是 specDefs 而不是组合行 list',
    /var specDefs = \(skus && skus\.specDefs\) \|\| \[\]/.test(SW) &&
    /specDefs\.forEach\(function \(def, g\)/.test(SW));
  ok('视频写到 video/（文件名单点生成）',
    /U\.videoLocalPath\(vi\)/.test(SW) && /U\.VIDEO_DIR = 'video'/.test(rd('src/common/util.js')));
  ok('视频先落盘再写 info.json（local_video 依赖结果）',
    /jobs\.push\(function \(\) \{ return vjob; \}\)/.test(SW));
  ok('info.json 落盘任务不被条件挡住',
    /var preJobs = jobs\.slice\(\)/.test(SW) &&
    /pump\(preJobs, 3\)/.test(SW));
  ok('info.json 等前序 job 全跑完（local_image 依赖规格图）',
    /preJobs 必须|⚠️ 必须\*\*等前面所有 job 全部跑完\*\*/.test(SW));
  ok('规格图任务在补采之后入队（闲鱼详情接口不给图）',
    /return specReady\.then\(function \(\) \{/.test(SW));
  ok('info.json 走 JSON data URL',
    /textToDataUrl\(JSON\.stringify\(info, null, 2\), 'json'\)/.test(SW));
  // 编号改由 specDefs 的 (g, v) 下标决定——不是「自增计数器」也不是组合行下标，
// 所以这里锚的是 forEach 的两个下标参数。
  ok('规格图编号取 specDefs 的 (维度,值) 下标',
    /\(def\.values \|\| \[\]\)\.forEach\(function \(val, v\)/.test(SW) &&
    /U\.skuSpecImageName\(g, v, val\.value, val\.image\)/.test(SW));

  // 旧结构必须彻底消失，留着就是两套目录混在一起。
  // 查的是路径拼接（前面带 /），注释里提到旧名字不算
  ok('不再有「SKU图片」目录', SW.indexOf('/SKU图片') === -1);
  ok('不再有「视频」目录', SW.indexOf("'/视频/") === -1);
  ok('不再拼图片前缀', !/prefix \+ \(i \+ 1\)/.test(SW));
  ok('空商品不建目录也不写 info.json',
    /if \(!jobs\.length\) return Promise\.resolve\(\{ ok: 0, fail: 0 \}\);/.test(SW) &&
    SW.indexOf('if (!jobs.length)') < SW.indexOf('U.buildInfo(item.meta'));
  ok('返回结果里带上 info 计数', /info: infoOk/.test(SW));
}

/* ========================================================================== */
console.log('\n=== ⑤ 三个入口共用一份结构 ===');
{
  // bridge：批量与单件都从 itemOf 出，不能各拼各的
  ok('bridge 抽出统一的 itemOf', /function itemOf\(d, opts\)/.test(BR));
  ok('itemOf 带上 meta（标题/文案/价格）', /meta:\s*\{[\s\S]{0,120}title:/.test(BR));
  ok('itemOf 带上视频', /videos: videosOf\(d\)/.test(BR) && /function videosOf\(d\)/.test(BR));
  ok('selectedItems 复用 itemOf', /var it = itemOf\(d\);/.test(BR));
  ok('单件「下载主图」也走同一套', /itemOf\(detail, \{ text: false \}\)/.test(BR));
  ok('单件「一键打包」也走同一套', /var it = itemOf\(detail\);/.test(BR));
  ok('bridge 不再用老的 xy:download-images',
    BR.indexOf("type: 'xy:download-images'") === -1);

  // popup 自己那套（它直接调 downloads API，不走 SW）
  ok('popup 单图下载进 images/', /U\.IMAGES_DIR \+ '\/' \+ U\.imageFileName/.test(PO));
  ok('popup 也写 info.json', /U\.INFO_FILE/.test(PO) && /U\.buildInfo\(/.test(PO));
  ok('popup 主图与 info.json 用同一份图集（imagesOf）',
    /function imagesOf\(/.test(PO) && (PO.match(/imagesOf\(/g) || []).length >= 3);
}

/* ========================================================================== */
console.log('\n=== ⑥ 默认值：目录与命名 ===');
{
  ok('bridge 默认存到 downloaded_items', /saveDir: 'downloaded_items'/.test(BR));
  ok('bridge 默认商品夹用 ID', /dirTemplate: '\{itemId\}'/.test(BR));
  ok('SW 默认同样', /saveDir: 'downloaded_items'/.test(SW) && /dirTemplate: '\{itemId\}'/.test(SW));
  ok('popup 默认同样', /saveDir: 'downloaded_items'/.test(PO) && /dirTemplate: '\{itemId\}'/.test(PO));
  ok('图片前缀设置已彻底移除（HTML 与 JS 都不该再有）',
    rd('src/popup/popup.html').indexOf('cfg-prefix') === -1 &&
    PO.indexOf('imgPrefix') === -1);
  ok('列表导出不再混进商品夹',
    /'\/_列表\/商品列表_'/.test(PO) || PO.indexOf("'/_列表/") > -1);
}

console.log('\n———————————————————————————————');
console.log((fail === 0 ? '✓ 全部通过' : '✗ 有失败') + '：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
