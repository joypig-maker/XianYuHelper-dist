/**
 * 读扩展自身服务的 bridge.js，确认浏览器里跑的是哪一份。
 * chrome-extension:// 资源只能从扩展同源的世界里 fetch，
 * 在隔离世界（CDP 默认）里 fetch 需要扩展的 host 权限，通常不行——
 * 所以先试页面主世界，不行再用扩展 ID 直接 fetch。
 */
const CDP = require('./cdp.js');

const EXT_ID = 'ndkobihbhiaodpipefnpokehicjikgmh';

const FETCH = `
  return fetch('chrome-extension://${EXT_ID}/src/content/bridge.js')
    .then(function (r) { return r.text(); })
    .then(function (t) {
      return {
        len: t.length,
        hasXYLOG: t.indexOf('__XYLOG') > -1,
        hasXYDBG: t.indexOf('__XYDBG') > -1,
        marker: t.indexOf('__XYDBG') > -1 ? 'DIST-诊断版' : (t.indexOf('事件委托') > -1 ? '普通版' : '未知')
      };
    })
    .catch(function (e) { return { err: String(e && e.message || e).slice(0, 120) }; });
`;

(async () => {
  const b = await CDP.connect(9222);
  const page = await b.attach(/1688\.com/);
  if (!page) { console.log('没有开着的 1688 标签'); await b.close(); return; }
  console.log(JSON.stringify(await page.evaluate(FETCH), null, 1));
  await b.close();
})();
