/**
 * 重载已加载的扩展，然后验证改动是否生效
 *
 * 扩展是通过 Extensions.loadUnpacked 装的解压目录，改了源码必须重新加载
 * content script 才会更新（页面里跑的是旧副本）。
 * 这里让扩展的 service worker 执行 chrome.runtime.reload()，
 * 再打开用户给的那个店铺 URL，核对：
 *   ① 面板标题旁是否显示了版本号
 *   ② 整店页是否渲染出商品网格
 *   ③ 网格里的勾选框能否勾上、并与右下角面板联动
 */
'use strict';

const CDP = require('./cdp');

const URL = process.argv[2] ||
  'https://shop151421831.taobao.com/category.htm?spm=pc_detail.30350276.shop_block.dshopinfo.797f19ecmUIeEG&topIds=973720896210';

(async () => {
  const b = await CDP.connect(9222);

  // 1) 重新加载解压扩展。
  //    不能用 chrome.runtime.reload()：MV3 的 service worker 平时是休眠的，
  //    /json/list 里根本没有它的 target，拿不到会话就没法让它自己重载。
  //    Extensions.loadUnpacked 对同一路径再调一次即可刷新代码。
  const EXT = process.argv[3] || 'D:\\work\\闲鱼浏览器插件\\dist\\release\\extension';
  // Browser 类只包了 createTarget/attach 等几个方法，没有通用 send，
  // 这里照 createTarget 的写法直接用浏览器级 ws 发一条请求。
  function browserCall(method, params) {
    const id = 900 + Math.floor(Math.random() * 99);
    return new Promise((resolve) => {
      const h = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id === id) { b.ws.removeEventListener('message', h); resolve(m); }
      };
      b.ws.addEventListener('message', h);
      b.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => resolve({ error: { message: '超时' } }), 8000);
    });
  }

  const lr = await browserCall('Extensions.loadUnpacked', { path: EXT });
  console.log('Extensions.loadUnpacked → ' + JSON.stringify(lr).slice(0, 180));
  await new Promise((r) => setTimeout(r, 2500));

  const tabs = await b.list();
  const sws = tabs.filter((t) => t.type === 'service_worker');
  console.log('当前 service worker: ' + (sws.length ? sws.map((s) => s.url.slice(0, 52)).join(' | ') : '(无)'));

  // 2) 打开页面核对
  const { targetId } = await b.createTarget('about:blank');
  const page = await b.attachTarget({ id: targetId });
  await page.goto(URL, 45000);
  await new Promise((r) => setTimeout(r, 12000));

  const r = await page.evaluate(`return (function(){
    function n(s){ try { return document.querySelectorAll(s).length; } catch(e){ return -1; } }
    var ver = document.querySelector('.xy-ver');
    var grid = document.getElementById('xy-shop-grid');
    return {
      面板版本号: ver ? ver.innerText : '(没有版本号)',
      浮窗存在: !!document.querySelector('.xy-panel'),
      浮窗商品行: n('.xy-pick-row'),
      网格存在: !!grid,
      网格商品数: n('.xy-sg-cell'),
      网格勾选框: n('.xy-sg-cell .xy-check'),
      网格第一格标题: (function(){
        var c = document.querySelector('.xy-sg-cell .xy-sg-name');
        return c ? c.innerText.slice(0, 34) : '(无)';
      })(),
      网格第一格价格: (function(){
        var c = document.querySelector('.xy-sg-cell .xy-sg-price');
        return c ? c.innerText : '(无)';
      })(),
      网格第一格有图: (function(){
        var i = document.querySelector('.xy-sg-cell img');
        return i ? (i.naturalWidth + 'x' + i.naturalHeight) : '(无)';
      })()
    };
  })()`);
  console.log('\n=== 页面状态 ===');
  Object.keys(r).forEach((k) => console.log('  ' + k + ': ' + JSON.stringify(r[k])));

  // 3) 点网格里的第一格，看是否勾上并与面板联动
  const click = await page.evaluate(`return (function(){
    var cell = document.querySelector('.xy-sg-cell .xy-check');
    if (!cell) return '没有可点的勾选框';
    cell.click();
    return '已点击网格第 1 格的勾选框';
  })()`);
  console.log('\n' + click);
  await new Promise((r2) => setTimeout(r2, 1200));

  const after = await page.evaluate(`return (function(){
    var cnt = document.querySelector('.xy-sel-num');
    return {
      面板计数: cnt ? cnt.innerText : '(无)',
      网格选中态: document.querySelectorAll('.xy-sg-cell.xy-check-on').length,
      浮窗选中态: document.querySelectorAll('.xy-pick-row.xy-check-on').length
    };
  })()`);
  console.log('点击后: ' + JSON.stringify(after));

  await page.close();
  await b.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
