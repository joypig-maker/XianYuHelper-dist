/**
 * 京东图片各档位的真实像素尺寸 —— 决定铺货用哪一档。
 *
 * 动机：店铺列表页给的是 /n7/ 档（实测仅 17KB），明显是缩略图。
 * n0/n1/n12 体积差别很大（314KB / 48KB / 312KB），但不知道像素，
 * 不能凭体积猜。这里把图下下来直接读文件头拿宽高。
 *
 * 支持 JPEG（SOF0-SOF15）与 PNG（IHDR）。
 * 用法：node tools/diag-jd-imgsize.js [图片URL...]
 */
'use strict';

/** 从 buffer 里读出图片像素尺寸，读不出返回 null */
function imageSize(buf) {
  // ---- PNG：IHDR 紧跟在 8 字节签名 + 4 字节长度 + "IHDR" 之后 ----
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), fmt: 'PNG' };
  }

  // ---- JPEG：扫段找 SOFn ----
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      // 填充字节
      if (marker === 0xff) { i++; continue; }
      // 无长度字段的标记
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      // SOF0..SOF15（不含 C4 霍夫曼表 / C8 差分 / CC 算术编码表）
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return {
          h: buf.readUInt16BE(i + 5),
          w: buf.readUInt16BE(i + 7),
          fmt: 'JPEG'
        };
      }
      i += 2 + len;
    }
  }

  // ---- WebP（VP8X / VP8 ）----
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP') {
    const fourcc = buf.toString('ascii', 12, 16);
    if (fourcc === 'VP8X') {
      const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      return { w, h, fmt: 'WEBP' };
    }
    if (fourcc === 'VP8 ') {
      return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff, fmt: 'WEBP' };
    }
  }
  return null;
}

const SAMPLE = '//img10.360buyimg.com/n7/jfs/t1/425024/6/9565/2123818/69f02b5bFd8ee9ec9/00835a05a00c2a10.jpg';

(async () => {
  const inputs = process.argv.slice(2);
  const tails = inputs.length ? inputs : [
    SAMPLE,
    '//img14.360buyimg.com/n7/jfs/t1/282201/2/24318/140019/68076ed7F1a643785/3a7ddc0e26268d9e.jpg',
    '//img13.360buyimg.com/n7/jfs/t1/421372/40/5463/255692/69e1fcb3Fff840e1a/00835a05a0bbd050.jpg'
  ];

  const levels = ['n0', 'n1', 'n2', 'n7', 'n12'];
  for (const t0 of tails) {
    const t = t0.startsWith('http') ? t0.replace(/^https?:/, '') : t0;
    console.log('\n原图: ' + t.slice(-50));
    for (const lv of levels) {
      const u = 'https://' + t.replace(/\/n\d+\//, '/' + lv + '/');
      try {
        const r = await fetch(u, { headers: { Referer: 'https://mall.jd.com/' } });
        if (!r.ok) { console.log('  ' + lv.padEnd(5) + ' HTTP ' + r.status); continue; }
        const buf = Buffer.from(await r.arrayBuffer());
        const s = imageSize(buf);
        console.log('  ' + lv.padEnd(5) + (s ? (s.w + 'x' + s.h).padEnd(12) + s.fmt : '尺寸未知').padEnd(20) +
          (buf.length / 1024).toFixed(1) + 'KB');
      } catch (e) {
        console.log('  ' + lv.padEnd(5) + 'ERR ' + e.message);
      }
    }
  }
})().catch((e) => { console.error('ERR', e && e.message); process.exit(1); });
