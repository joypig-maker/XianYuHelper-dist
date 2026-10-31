/**
 * 从抓包数据里提取闲鱼商品图清单（URL + 声明宽高）
 *
 * 数据源：dist/xy-shop-api.json（tools/watch-xy-shop.js 抓的真实店铺页接口）
 * 这个文件是实测样本，重采样相关的验证脚本都从这里取图，
 * 保证「换个人、换个时间跑」用的是同一批真实 URL。
 *
 * 用法：const { load } = require('./xy-shop-images.js');
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function load() {
  const f = path.join(ROOT, 'dist', 'xy-shop-api.json');
  if (!fs.existsSync(f)) {
    throw new Error('缺少 dist/xy-shop-api.json，请先跑：\n'
      + '  node tools/watch-xy-shop.js "https://www.goofish.com/personal?userId=xxx" dist/xy-shop-api.json');
  }
  const hits = JSON.parse(fs.readFileSync(f, 'utf8'))
    .filter(function (x) { return x.api === 'mtop.idle.web.xyh.item.list'; });

  const rows = [];
  hits.forEach(function (h) {
    let j;
    try { j = JSON.parse(h.body); } catch (e) { return; }
    const cl = (j.data && j.data.cardList) || [];
    cl.forEach(function (c) {
      let inf = (c.cardData && c.cardData.detailParams && c.cardData.detailParams.imageInfos) || [];
      if (typeof inf === 'string') { try { inf = JSON.parse(inf); } catch (e) { inf = []; } }
      if (!Array.isArray(inf)) inf = [];
      inf.forEach(function (o) {
        if (o && o.url) rows.push({ u: o.url, w: +o.widthSize || 0, h: +o.heightSize || 0 });
      });
    });
  });

  // 去重
  const seen = new Set();
  const uniq = [];
  rows.forEach(function (r) { if (!seen.has(r.u)) { seen.add(r.u); uniq.push(r); } });
  return uniq;
}

/** 按声明宽高比归类：1:1 / 3:4 / 9:16 / 4:3 / 横图 / 长竖图 / 其它竖图 */
function ratioOf(w, h) {
  if (!w || !h) return '未知';
  const r = w / h;
  if (Math.abs(r - 1) < 0.02) return '1:1';
  if (Math.abs(r - 0.75) < 0.02) return '3:4';
  if (Math.abs(r - 0.5625) < 0.02) return '9:16';
  if (Math.abs(r - 1.3333) < 0.02) return '4:3';
  if (r > 1.2) return '横图';
  if (r < 0.72) return '长竖图';
  return '其它竖图';
}

/** 长边 */
function longest(r) { return Math.max(+r.w || 0, +r.h || 0); }

module.exports = { load: load, ratioOf: ratioOf, longest: longest };
