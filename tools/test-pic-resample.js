/**
 * 商品图 CDN 重采样（U.picResampleUrl）的单元验证。
 *
 * 背景（2026-11-01 实测，同一店铺 20 张图 jpg/heic 各半）：
 *   闲鱼商品图 URL 加 `_1440x1440q80.jpg` → 12/12 字节全变，
 *   原图 1440x1920 → 重采样后 1080x1440，dHash 距离 27~28（阈值 10）。
 *   这条链路的目的是让落盘的图不再是源站原图字节。
 *
 * 这里只做离线断言（不联网，保证 CI 稳定）；联网实测结论写在注释里。
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const w = {};
vm.createContext(w);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/common/util.js'), 'utf8'), w, { timeout: 5000 });
const U = w.XYUtil;

const BR = fs.readFileSync(path.join(ROOT, 'src/background/service_worker.js'), 'utf8');

let pass = 0, fail = 0;
function is(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

const XY_JPG = 'https://img.alicdn.com/bao/uploaded/i1/2220477906344/O1CN015kDfDZ1wjbnQZfnry_!!4611686018427387304-0-xy_item.jpg';
const XY_HEIC = 'http://img.alicdn.com/bao/uploaded/i2/O1CN01atSIuI1bcdpuV3hcQ_!!4611686018427381070-53-fleamarket.heic';
const SUF = '_1440x1440q80.jpg';

console.log('\n=== 商品图 CDN 重采样 ===');

is('★ 闲鱼 jpg 商品图会拼上尺寸后缀', U.picResampleUrl(XY_JPG) === XY_JPG + SUF);
is('★ 闲鱼 heic 商品图同样处理（实测也返回 200）',
  U.picResampleUrl(XY_HEIC) === XY_HEIC + SUF);
is('★ http 与 https 都认', U.picResampleUrl(XY_HEIC).indexOf(SUF) > 0);

is('★ 已带尺寸后缀的不二次拼接（拼了 CDN 就不认）',
  U.picResampleUrl('https://img.alicdn.com/bao/uploaded/i1/a.jpg_400x400q90.jpg')
  === 'https://img.alicdn.com/bao/uploaded/i1/a.jpg_400x400q90.jpg');
is('★ 已带 _1080x1080q75 的也不动',
  U.picResampleUrl('https://img.alicdn.com/bao/uploaded/i1/a.jpg_1080x1080q75.jpg')
  === 'https://img.alicdn.com/bao/uploaded/i1/a.jpg_1080x1080q75.jpg');

is('★ 幂等：改一次后再改一次结果不变',
  U.picResampleUrl(U.picResampleUrl(XY_JPG)) === U.picResampleUrl(XY_JPG));

is('★ 非 alicdn 域名不动（1688 的 cbu01 没实测过）',
  U.picResampleUrl('https://cbu01.alicdn.com/img/ibank/xxx.jpg')
  === 'https://cbu01.alicdn.com/img/ibank/xxx.jpg');
is('★ 非 /bao/uploaded/ 路径不动',
  U.picResampleUrl('https://img.alicdn.com/imgextra/i1/xxx.jpg')
  === 'https://img.alicdn.com/imgextra/i1/xxx.jpg');
is('★ 带 query 的不动',
  U.picResampleUrl(XY_JPG + '?x-oss-process=image/resize,w_800') === XY_JPG + '?x-oss-process=image/resize,w_800');

is('★ 视频不动', U.picResampleUrl('https://img.alicdn.com/bao/uploaded/i1/a.mp4')
  === 'https://img.alicdn.com/bao/uploaded/i1/a.mp4');
is('★ data URL 不动', U.picResampleUrl('data:text/plain;base64,AAAA') === 'data:text/plain;base64,AAAA');
is('★ 空值不炸', U.picResampleUrl('') === '' && U.picResampleUrl(null) === '' &&
  U.picResampleUrl(undefined) === '');

// 文件名一致性：jpg 场景改前后扩展名必须一样，
// 否则 info.json 记录的 local_images 会指向不存在的文件
is('★★ jpg 图改前后扩展名一致（文件名不会错位）',
  U.imageExt(XY_JPG) === U.imageExt(U.picResampleUrl(XY_JPG)));

console.log('\n=== 下载链路 ===');

is('★★ download() 里调用了 picResampleUrl', /U\.picResampleUrl\(/.test(BR));
is('★★ 只改 url、不动 filename（Object.assign 只覆盖 url）',
  /Object\.assign\(\{\}, options, \{ url: resampled \}\)/.test(BR));
is('★★ 原始 URL 留作兜底，重试时退回原图',
  /downloadOnce\(opt, retries, rawUrl\)/.test(BR) &&
  /next = Object\.assign\(\{\}, options, \{ url: fallbackUrl \}\)/.test(BR));
is('★★ 重采样是默认生效的（没有开关判断）',
  !/if \(.*[Ee]nable.*\)\s*\{[^}]*picResampleUrl/.test(BR));

// q 值不能随便改：q100/q95/q85 对小图 heic 原样返回，q90 对小图 jpg 原样返回，
// 实测只有 q80/q75/q70 能覆盖全部样本（12/12）。改回去会让一部分图白改。
is('★★ 质量档位必须是 q80（q100/q90 有整类图字节不变）',
  U.PIC_RESAMPLE_SUFFIX === '_1440x1440q80.jpg');
is('★★ 尺寸档位 1440 在白名单内（400/1080/1200/1440 有效）',
  /_1440x1440q\d+\.jpg$/.test(U.PIC_RESAMPLE_SUFFIX));

console.log('\n结果：' + (fail ? '✗ 有失败：' + pass + ' 通过 / ' + fail + ' 失败'
  : '✓ 全部通过：' + pass + ' 项断言'));
process.exit(fail ? 1 : 0);
