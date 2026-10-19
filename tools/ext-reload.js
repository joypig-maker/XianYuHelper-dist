/**
 * 用 CDP 的 Extensions.reload 重载扩展。
 *
 * 比点 chrome://extensions 里的按钮可靠：那个按钮在 shadow DOM 里，
 * JS click 与真实鼠标事件都试过不生效，而 CDP 的 Extensions 域是直接给命令。
 */
const CDP = require('./cdp.js');

(async () => {
  const b = await CDP.connect(9222);
  const page = await b.attach(/1688\.com/);
  if (!page) { console.log('需要开着一个页面'); await b.close(); return; }

  const info = await page.send('Extensions.getExtensionInfo', {}).catch((e) => ({ err: e.message }));
  console.log('扩展数: ' + (info.extensions ? info.extensions.length : JSON.stringify(info)));
  if (!info.extensions) { await b.close(); return; }

  const mine = info.extensions.filter((x) => /闲鱼助手|闲鱼采集|XianYu/i.test(x.path || ''));
  for (const x of mine) console.log('  ' + x.id + '  ' + x.path);

  for (const x of mine) {
    const r = await page.send('Extensions.reload', { id: x.id }).catch((e) => ({ err: e.message }));
    console.log('reload ' + x.id + ' -> ' + JSON.stringify(r));
  }

  await b.close();
})();
