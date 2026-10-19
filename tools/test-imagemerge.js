/**
 * 图集 / 规格合并策略自测（node tools/test-imagemerge.js）
 *
 * 背景：用户反馈「打包只下载了主图，其余主图和 SKU 图都没有」。
 * 排查下来是同一个根因的两副面孔——商品池里有两份合并逻辑，规则不一致：
 *   · mergeCards        ：concat + 去重（补全式）
 *   · ensureCardsDetail ：跟着标量字段走「只填空」
 * 后者导致列表页那张缩略图一旦占位，详情页返回的完整图集永远写不进来，
 * 补详情补了个寂寞，打包出来还是只有 1 张。
 *
 * 这里直接从源文件抠出三个函数跑，不重抄一份实现——
 * 重抄的话改了产品代码测试照样是绿的，等于没测。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const INJ = fs.readFileSync(path.join(ROOT, 'src/content/injected.js'), 'utf8');
const BRG = fs.readFileSync(path.join(ROOT, 'src/content/bridge.js'), 'utf8');

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('✓ ' + name); }
  else { fail++; console.log('✗ ' + name + (extra ? '  → ' + extra : '')); }
}

/** 从源文件里抠出某个具名函数的完整源码（按花括号配对取到闭合为止） */
function grab(src, signature) {
  const at = src.indexOf(signature);
  if (at < 0) throw new Error('没找到函数：' + signature);
  let i = src.indexOf('{', at);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(at, i + 1);
    }
  }
  throw new Error('花括号没配对：' + signature);
}

/* ---------------- 加载真实的 U ---------------- */

const win = { setTimeout, clearTimeout, Promise, BigInt };
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'src/common/util.js'), 'utf8'), win);
const U = win.XYUtil;
if (!U) throw new Error('XYUtil 没挂上来');

/* ---------------- 抠出被测函数 ---------------- */

const code = [
  grab(INJ, 'function pickCardImages('),
  grab(INJ, 'function pickCardSkus('),
  grab(INJ, 'function fixSingleImage('),
  grab(INJ, 'function uniqImg('),
  'return { pickCardImages: pickCardImages, pickCardSkus: pickCardSkus, fixSingleImage: fixSingleImage };'
].join('\n\n');

const M = new Function('U', code)(U);

const A = 'https://cbu01.alicdn.com/img/ibank/aaa.jpg';
const B = 'https://cbu01.alicdn.com/img/ibank/bbb.jpg';
const C = 'https://cbu01.alicdn.com/img/ibank/ccc.jpg';
// 卖家头像：filterItemImages 会判定为非商品图并剔除
const AVATAR = 'https://cbu01.alicdn.com/sellerpic/avatar.png';

console.log('== pickCardImages ==');

// ① 本次故障的核心场景：列表页 1 张占位，详情给来 5 张
let r = M.pickCardImages([A], [A, B, C]);
ok('详情的多图能并进来（不是被列表那一张占住）', r.length === 3, JSON.stringify(r));
ok('同一张图不被重复计入', r.filter((x) => x === A).length === 1);

// ② 旧的列表独有、详情没有的图也不能丢
r = M.pickCardImages([A], [B, C]);
ok('两边各有的图都保留（取并集）', r.length === 3, JSON.stringify(r));

// ③ 详情啥都没给时不许把已有的冲掉
r = M.pickCardImages([A, B], []);
ok('详情没给图时保留原图集', r.length === 2, JSON.stringify(r));
r = M.pickCardImages([A, B], null);
ok('传 null 也安全', r.length === 2);

// ④ 脏图依旧要剔掉
r = M.pickCardImages([AVATAR, A], [B]);
ok('头像类非商品图仍旧被剔除', r.indexOf(AVATAR) === -1 && r.length === 2, JSON.stringify(r));

// ⑤ 全空
ok('两边都空时返回空数组', Array.isArray(M.pickCardImages([], [])) && M.pickCardImages([], []).length === 0);
ok('传 undefined 也不炸', Array.isArray(M.pickCardImages(undefined, undefined)));

console.log('\n== pickCardSkus ==');

const skuNew = { specs: ['颜色'], list: [{ key: '红色', image: A }, { key: '蓝色', image: B }] };
const skuOld = { specs: ['尺寸'], list: [{ key: 'S', image: C }] };

ok('详情给了规格就用详情的（规格只能靠详情拿）',
  M.pickCardSkus(skuOld, skuNew).list.length === 2);
ok('详情没给规格就沿用旧的',
  M.pickCardSkus(skuOld, null).list.length === 1);
ok('详情给的规格是空壳时不许覆盖旧的',
  M.pickCardSkus(skuOld, { specs: [], list: [] }).list.length === 1);
ok('原本没有规格时返回 null',
  M.pickCardSkus(undefined, undefined) === null);

console.log('\n== fixSingleImage ==');

let card = { image: AVATAR, images: [A, B] };
M.fixSingleImage(card);
ok('主图是头像时清掉', card.image !== AVATAR, card.image);
ok('清掉后从图集补一张', card.image === A, card.image);

card = { image: A, images: [A, B] };
M.fixSingleImage(card);
ok('正常主图不动', card.image === A);

card = { images: [B, C] };
M.fixSingleImage(card);
ok('没有主图时取图集首图', card.image === B);

console.log('\n== 源码契约 ==');

// 两处合并必须走同一个函数，否则又会攒出两套规则
const mcAt = INJ.indexOf('function mergeCards');
const ecAt = INJ.indexOf('async function ensureCardsDetail');
const mergeBlock = INJ.slice(mcAt, mcAt + 1800);
const ensureBlock = INJ.slice(ecAt, ecAt + 4200);
ok('mergeCards 用了 pickCardImages', /pickCardImages\(/.test(mergeBlock));
ok('ensureCardsDetail 用了 pickCardImages', /pickCardImages\(/.test(ensureBlock));
ok('ensureCardsDetail 用了 pickCardSkus', /pickCardSkus\(/.test(ensureBlock));

// 「images 跟随标量一起只填空」就是本次事故的形态，不许再出现
const fillEmptyFields = ensureBlock.match(/\[[^\]]*'images'[^\]]*\]\.forEach/);
ok('images 已被移出「只填空」字段列表', !fillEmptyFields,
  fillEmptyFields ? fillEmptyFields[0] : '');
const fillEmptySkus = ensureBlock.match(/\[[^\]]*'skus'[^\]]*\]\.forEach/);
ok('skus 已被移出「只填空」字段列表', !fillEmptySkus,
  fillEmptySkus ? fillEmptySkus[0] : '');

// 标量字段仍应只填空（降价/店铺名等不允许被空值覆盖冲掉）
ok('标量字段（title/price/desc 等）仍保持只填空',
  /\['title', 'price', 'desc'[^\]]*\]\.forEach/.test(ensureBlock));

console.log('\n== 下载失败原因要能看得见 ==');

const fnBlock = grab(BRG, 'function failNote(');
const enBlock = grab(BRG, 'function enrichNote(');
const F = new Function(fnBlock + '\n' + enBlock + '\nreturn { failNote: failNote, enrichNote: enrichNote };')();
const { failNote, enrichNote } = F;

// 下全了就别啰嗦
ok('全部下载成功时不追加任何说明',
  failNote({ imgTotal: 5, images: 5, errors: [] }) === '');
// 少下了必须说出原因——以前这个 errors 一直躺在后台没人用
let note = failNote({ imgTotal: 5, images: 1, errors: ['NETWORK_FAILED'] });
ok('少下的张数报出来', /4 张没下下来/.test(note), note);
ok('失败原因一并带出来', /NETWORK_FAILED/.test(note), note);

note = failNote({ imgTotal: 5, images: 1, errors: [] });
ok('没有原因时也照样报张数', /4 张没下下来/.test(note), note);

// 补详情失败同样要说清楚
ok('补详情失败会提示商品信息偏薄',
  /补详情失败 1 个，商品信息偏薄/.test(enrichNote({ done: 2, fail: 1 })));
ok('补详情全成时不啰嗦', enrichNote({ done: 2, fail: 0, skus: { done: 0 } }) === '');
ok('没补过（旧通道）时不追加说明', enrichNote(null) === '');

console.log('\n' + (fail === 0 ? '全部通过 ✅  ' + pass + ' 项' : '失败 ' + fail + ' 项 / 通过 ' + pass + ' 项'));
process.exit(fail === 0 ? 0 : 1);
