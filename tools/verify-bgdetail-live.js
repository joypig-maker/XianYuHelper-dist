/**
 * 真机验证「后台标签页补详情」整条链路。
 *
 * 直接在淘宝搜索页上以 injected 的身份走 postbus，问 bridge 要一份详情：
 *   injected → bridge → SW 开后台标签页 → 详情页采集 → 原路回传
 * 这条命令如果能拿到 9 张图，就说明详情接口的上下文限制被绕过去了。
 *
 * 用法：node tools/verify-bgdetail-live.js [商品ID]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const CDP = require('./cdp');

const ROOT = path.join(__dirname, '..');
const ITEM = process.argv[2] || '669745626548';
const POSTBUS = fs.readFileSync(path.join(ROOT, 'src/common/postbus.js'), 'utf8');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await CDP.connect(9222);
  console.log('已连上调试实例');

  const page = await b.open('https://s.taobao.com/search?q=' + encodeURIComponent('手机支架'));

  // 等扩展注入（ISOLATED 侧会在 <html> 上打标记）
  let ready = false;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    try {
      ready = await page.evaluate("return document.documentElement.hasAttribute('data-xy-bridge')");
    } catch (e) { ready = false; }
    if (ready) break;
  }
  console.log('扩展注入: ' + (ready ? '已就绪' : '未检测到（后面多半会超时）'));

  console.log('\n发起请求：injected → bridge → SW → 后台标签页 → 详情页采集');
  console.log('商品 ID: ' + ITEM);

  const expr = POSTBUS + `
    return (async function () {
      var t0 = Date.now();
      try {
        var ch = window.XYPostBus.channel('injected');
        var r = await ch.ask('bridge', 'bg-detail', { itemId: '${ITEM}' }, { timeout: 60000 });
        var d = (r && r.detail) || null;
        return {
          ms: Date.now() - t0,
          ok: !!(r && r.ok),
          error: (r && r.error) || '',
          title: d ? String(d.title || '').slice(0, 30) : '',
          price: d ? d.price : '',
          images: d ? (d.images || []).length : 0,
          sample: d ? (d.images || []).slice(0, 3).map(function (u) { return u.slice(0, 68); }) : [],
          skus: d && d.skus && d.skus.list ? d.skus.list.length : 0
        };
      } catch (e) {
        return { err: String(e && e.message || e) };
      }
    })()`;

  const out = await page.evaluate(expr, true);
  console.log('\n返回：');
  console.log('  ' + JSON.stringify(out, null, 1).split('\n').join('\n  '));

  // 后台标签页应该还在（忙完静置 8s 才回收），查一眼证明它确实被开过
  await sleep(300);
  const tabs = await b.list();
  const bg = tabs.filter((t) => t.type === 'page' &&
    /item\.(taobao|tmall)\.com\/item\.htm/i.test(t.url || ''));
  console.log('\n后台详情标签页: ' + (bg.length ? bg.map((t) => t.url.slice(0, 56)) : '（已回收或无）'));

  const good = out && out.ok && out.images >= 5;
  console.log('\n' + (good
    ? '✓ 链路打通：拿到 ' + out.images + ' 张图'
    : '✗ 未打通：' + JSON.stringify(out)));

  await b.close();
  process.exit(good ? 0 : 1);
})().catch((e) => { console.error('ERR', e && e.message); process.exit(1); });
