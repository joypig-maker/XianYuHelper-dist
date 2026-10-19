/**
 * 去混淆：obfuscator.io 的字符串表 dump
 *
 * 店透视的远程模块（tb_shop / tb_detail …）是 obfuscator.io 混淆过的：
 * 所有字面量都 base64 塞进一个字符串数组，用 a0_0x1eb9(idx) 取值后解码。
 * 好在解码算法就在文件里，这里直接复刻它，把整个数组翻成明文——
 * 接口名、选择器、字段名全都看得见了，不必逆控制流。
 */
const fs = require('fs');
const path = require('path');

const file = process.argv[2];
if (!file) { console.error('用法: node dts-deobf.js <file>'); process.exit(1); }
const src = fs.readFileSync(file, 'utf8');

// 1) 找字符串表。
//    形态各家不同：有的把数组直接写在解码函数里，有的拆到另一个函数
//    （a0_0x4d60 -> a0_0x2c69）。这里统一处理：
//    先定位解码函数，再沿它调用的那个「无参函数」去找数组。
function pickArray(src, startPos) {
  const open = src.indexOf('[', startPos);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

let body = null;
const inline = src.match(/function\s+([a-zA-Z0-9_$]+)\s*\([^)]*\)\s*\{[\s\S]{0,900}?var\s+(_0x[0-9a-fA-F]+)\s*=\s*\[/);
if (inline) {
  body = pickArray(src, src.indexOf(inline[0]) + inline[0].length - 1);
} else {
  // 解码函数 -> 它内部调用的建表函数（形如 a0_0x4d60(...) 内 return a0_0x2c69();）
  const dec = src.match(/function\s+(a0_0x[0-9a-fA-F]+)\s*\([^)]*\)\s*\{([\s\S]{0,600}?)\}/);
  if (dec) {
    const ref = dec[2].match(/(a0_0x[0-9a-fA-F]+)\s*\(\s*\)/);
    if (ref) {
      const tf = src.indexOf('function ' + ref[1] + '(');
      if (tf >= 0) body = pickArray(src, tf);
    }
  }
}
if (!body) { console.error('没找到字符串表'); process.exit(1); }
const arr = body.match(/'([^']*)'|"([^"]*)"/g) || [];
const raw = arr.map((s) => s.slice(1, -1));
console.log('// 字符串表 %d 条', raw.length);

// 2) 复刻解码：文件里 a0_0x1eb9 内部那个 autqHW —— base64 解 + decodeURIComponent
function dec(str) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=';
  let out = '';
  let esc = '';
  for (let i = 0, a, b, c = 0; (b = str.charAt(c++)); ) {
    b = chars.indexOf(b);
    if (~b) {
      a = i % 4 ? a * 64 + b : b;
      if (i++ % 4) out += String.fromCharCode(0xff & (a >> ((-2 * i) & 6)));
    }
  }
  for (let k = 0; k < out.length; k++) {
    esc += '%' + ('00' + out.charCodeAt(k).toString(16)).slice(-2);
  }
  try { return decodeURIComponent(esc); } catch (e) { return out; }
}

const terms = process.argv.slice(3);
const out = raw.map((s, i) => {
  const v = dec(s);
  return { i: i, raw: s, v: v };
});

// --at 0x17d,0x17e ：按「调用时传的索引」查。
// 混淆器把 a0_0xXXXX(idx) 里的 idx 做了一次常量偏移才当下标用，
// 而 chunk 名表这类地方写的就是原始 idx，直接查下标会错位，
// 所以先从解码函数定义里把偏移抠出来。
function findOffset(src, fnName) {
  const re = new RegExp('function\\s+' + fnName + '\\s*\\([^)]*\\)\\s*\\{[\\s\\S]{0,400}?-\\s*(0x[0-9a-fA-F]+)');
  const m = src.match(re);
  return m ? parseInt(m[1], 16) : 0;
}
const fnName = (src.match(/function\s+(a0_0x[0-9a-fA-F]+)\s*\([^)]*\)\s*\{\s*[^;]{0,200}?-\s*0x[0-9a-fA-F]+/) || [])[1];
const off = fnName ? findOffset(src, fnName) : 0;

const atArg = process.argv.find((a) => a.startsWith('--at='));
if (atArg) {
  const want = atArg.slice(5).split(',').map((x) => parseInt(x.trim(), 16) - off);
  console.log('// 解码函数 %s，索引偏移 0x%s', fnName || '(未识别)', off.toString(16));
  want.forEach((w, k) => {
    const o = out[w];
    const orig = parseInt(atArg.slice(5).split(',')[k].trim(), 16).toString(16);
    console.log('[0x' + orig + '] -> ' + (o ? JSON.stringify(o.v) : '(越界)'));
  });
  process.exit(0);
}

const list = terms.length
  ? out.filter((o) => terms.some((t) => o.v.toLowerCase().includes(t.toLowerCase())))
  : out;
console.log('// 命中 %d 条', list.length);
list.forEach((o) => console.log('[' + o.i + '] ' + o.v));
