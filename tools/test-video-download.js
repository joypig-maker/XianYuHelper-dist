/**
 * 视频下载能力回归
 *
 * 覆盖 4 块（都是这次新增的，缺一块软件侧就读不到视频）：
 *   ① normalizeVideoUrl 的 keepQuery —— 签名参数剥掉就 403
 *   ② pickVideos —— 从接口响应里捞视频地址（各站字段形态不同）
 *   ③ parseM3u8 —— 分片解析 + 相对路径补全 + 加密/master 拒绝
 *   ④ info.json 的 videos 段 —— local_video / video_url / failed 语义
 *
 * 跑：node tools/test-video-download.js
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
function eq(name, actual, expected) {
  is(name, JSON.stringify(actual) === JSON.stringify(expected),
    '实际: ' + JSON.stringify(actual) + ' 期望: ' + JSON.stringify(expected));
}
function section(t) { console.log('\n' + t); }

/* ============ ① keepQuery：签名地址不能被剥 ============ */
section('1) normalizeVideoUrl 的 keepQuery');
eq('默认剥查询串（去重要干净形式）',
  U.normalizeVideoUrl('https://x.com/a.mp4?t=1&e=2'), 'https://x.com/a.mp4');
eq('keepQuery=true 保留签名（下载必须）',
  U.normalizeVideoUrl('https://x.com/a.mp4?auth_key=abc&t=9', true),
  'https://x.com/a.mp4?auth_key=abc&t=9');
is('keepQuery 仍能认出带参的 mp4',
  U.normalizeVideoUrl('https://x.com/a.mp4?sign=1', true).indexOf('.mp4') > 0);
is('keepQuery 仍能认出带参的 m3u8',
  /\.m3u8(\?|$)/.test(U.normalizeVideoUrl('https://x.com/a.m3u8?t=9', true)));
is('非视频扩展名 + keepQuery 仍拒绝',
  U.normalizeVideoUrl('https://x.com/a.jpg?sign=1', true) === '');
eq('blob: 依然丢弃（MSE 流）', U.normalizeVideoUrl('blob:https://x.com/a'), '');
eq('data: 依然丢弃', U.normalizeVideoUrl('data:video/mp4;base64,AA'), '');

/* ============ ② pickVideos：接口字段形态 ============ */
section('2) pickVideos 从接口响应捞视频');

// 1688: offerVideo
eq('1688 offerVideo',
  U.pickVideos({ offerVideo: 'https://cloud.video.taobao.com/a/1.mp4' }).map((v) => v.url),
  ['https://cloud.video.taobao.com/a/1.mp4']);

// 1688: videoList 数组 + 时长
{
  const r = U.pickVideos({
    videoList: [
      { videoUrl: 'https://c.v.taobao.com/v1.mp4', duration: 30, coverUrl: 'https://c.v.taobao.com/c1.jpg' }
    ]
  });
  is('1688 videoList 取到地址', r.length === 1 && r[0].url === 'https://c.v.taobao.com/v1.mp4',
    JSON.stringify(r));
  is('时长被带上', r[0] && r[0].duration === '30', r[0] && r[0].duration);
  is('封面被带上', r[0] && /c1\.jpg$/.test(r[0].cover), r[0] && r[0].cover);
}

// 淘宝: videos[]
eq('淘宝 videos[]',
  U.pickVideos({ videos: [{ videoUrl: 'https://g.alicdn.com/t.mp4' }] }).map((v) => v.url),
  ['https://g.alicdn.com/t.mp4']);

// 闲鱼: videoInfo.videoList 深一层
eq('闲鱼 videoInfo.videoList（深搜）',
  U.pickVideos({ itemDO: { videoInfo: { videoList: [{ playUrl: 'https://g.alicdn.com/x.mp4' }] } } })
    .map((v) => v.url),
  ['https://g.alicdn.com/x.mp4']);

// 杂项：混在无关字段里也要能挖出来
eq('埋在深层字段里也能挖到',
  U.pickVideos({ a: { b: { c: { d: { playUrl: 'https://g.alicdn.com/deep.mp4' } } } } })
    .map((v) => v.url),
  ['https://g.alicdn.com/deep.mp4']);

// 脏数据
eq('没有视频返回空数组', U.pickVideos({ images: ['https://x.com/1.jpg'], price: '9.9' }), []);
eq('blob 地址不算视频',
  U.pickVideos({ video: 'blob:https://x.com/abc' }), []);
eq('同一地址多个签名只留一个（去重按干净地址）',
  U.pickVideos({ a: 'https://x.com/v.mp4?t=1', b: 'https://x.com/v.mp4?t=2' }).length, 1);

// mp4 排在 m3u8 前面（能直接下就别合并）
{
  const r = U.pickVideos({
    v1: 'https://x.com/a.m3u8',
    v2: 'https://x.com/b.mp4'
  });
  is('mp4 优先于 m3u8', r.length === 2 && /\.mp4$/.test(r[0].url), JSON.stringify(r.map(v => v.url)));
}

/* ============ ③ parseM3u8 ============ */
section('3) parseM3u8 分片解析');
{
  const base = 'https://cdn.example.com/hls/720p/index.m3u8';
  const list = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:6',
    '#EXTINF:6.0,',
    'seg0.ts',
    '#EXTINF:6.0,',
    'seg1.ts',
    '#EXTINF:6.0,',
    '/abs/seg2.ts',
    '#EXT-X-ENDLIST'
  ].join('\n');
  const segs = U.parseM3u8(list, base);
  eq('相对路径补成绝对 + 绝对路径原样', segs, [
    'https://cdn.example.com/hls/720p/seg0.ts',
    'https://cdn.example.com/hls/720p/seg1.ts',
    'https://cdn.example.com/abs/seg2.ts'
  ]);

  const segs2 = U.parseM3u8(list.replace('seg0.ts', '../seg/seg0.ts'), base);
  is('..路径被折叠', segs2[0] === 'https://cdn.example.com/hls/seg/seg0.ts', segs2[0]);

  eq('加密清单整体放弃',
    U.parseM3u8(['#EXTM3U', '#EXT-X-KEY:METHOD=AES-128,URI="https://k"', 'a.ts', 'b.ts'].join('\n'), base), []);
  eq('master playlist（<2 分片）不产出',
    U.parseM3u8(['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=1', 'low.m3u8'].join('\n'), base), []);
  eq('非清单文本返回空', U.parseM3u8('<html>403 Forbidden</html>', base), []);
  eq('空文本返回空', U.parseM3u8('', base), []);
  is('无 base 时相对路径无法补全 → 空',
    U.parseM3u8(['#EXTM3U', 'a.ts', 'b.ts'].join('\n'), '').length === 0);
}

/* ============ ④ info.json 的 videos 段 ============ */
section('4) info.json 的 videos 段');
{
  const info = U.buildInfo({ title: 'T', description: '', price: '1' }, [], null, [
    { url: 'https://x.com/v1.mp4', localVideo: 'video/主图视频.mp4', duration: '30', cover: 'https://x.com/c.jpg' },
    { url: 'https://x.com/v2.m3u8', localVideo: '', failed: 'm3u8 无法解析（加密）' }
  ]);
  is('videos 是数组且长度正确', Array.isArray(info.videos) && info.videos.length === 2,
    JSON.stringify(info.videos));
  is('local_video 用 U.videoLocalPath 同一来源',
    info.videos[0].local_video === U.videoLocalPath(0), info.videos[0].local_video);
  eq('下标从 0 开始', info.videos.map((v) => v.index), [0, 1]);
  is('失败项 local_video 为空串（不是 null）',
    info.videos[1].local_video === '', JSON.stringify(info.videos[1].local_video));
  is('失败原因写进 failed，软件能判断该不该重试',
    /m3u8/.test(info.videos[1].failed || ''), info.videos[1].failed);
  is('video_url 始终保留原始地址', info.videos[0].video_url === 'https://x.com/v1.mp4');
  is('封面透传', /c\.jpg$/.test(info.videos[0].cover || ''));
  eq('没有视频时是空数组（不是缺字段）', U.buildInfo({}, [], null, undefined).videos, []);
  eq('不传 videos 也不炸', U.buildInfo({}, ['https://x.com/1.jpg'], null).videos, []);
}

section('5) 文件名规则');
eq('第一个不带序号', U.videoFileName(0), '主图视频.mp4');
eq('第二个起带序号', U.videoFileName(1), '主图视频_2.mp4');
eq('相对路径进 video/', U.videoLocalPath(0), 'video/主图视频.mp4');
eq('相对路径进 video/（第2个）', U.videoLocalPath(2), 'video/主图视频_3.mp4');

/* ============ 汇总 ============ */
console.log('\n' + '─'.repeat(50));
if (fail) {
  console.log('✗ 有失败：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(1);
} else {
  console.log('✓ 全部通过：' + pass + ' 项断言');
}
