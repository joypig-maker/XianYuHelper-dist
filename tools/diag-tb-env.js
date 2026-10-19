/**
 * 淘宝页面环境探测：能不能直接发 mtop 请求
 *
 * 我们在 1688 是靠页面自带的 window.lib.mtop 发请求的。
 * 淘宝不一定有这个，若没有就得自己算签名 + 自己 fetch
 * （店透视就是这么干的：MD5(_m_h5_tk前缀 & t & appKey & data)）。
 * 这里把两件事一次问清：有没有 lib.mtop；_m_h5_tk 在不在 cookie 里。
 */
'use strict';

const CDP = require('./cdp');

const TARGETS = [
  ['淘宝搜索页', 'https://s.taobao.com/search?q=' + encodeURIComponent('手机支架')],
  ['淘宝详情页', 'https://detail.tmall.com/item.htm?id=669745626548']
];

(async () => {
  const b = await CDP.connect(9222);
  for (const [label, url] of TARGETS) {
    const { targetId } = await b.createTarget('about:blank');
    const page = await b.attachTarget({ id: targetId });
    try {
      await page.goto(url, 40000);
      await new Promise((r) => setTimeout(r, 5000));
      const r = await page.evaluate(`return (function(){
        var lib = window.lib || {};
        var mtop = lib.mtop || null;
        function ck(n){
          var m = document.cookie.match(new RegExp('(?:^|;\\\\s*)' + n + '=([^;]*)'));
          return m ? m[1].slice(0, 24) + '…' : '';
        }
        return {
          host: location.host,
          有_lib: !!window.lib,
          有_lib_mtop: !!mtop,
          mtop_request类型: mtop ? typeof mtop.request : '(无)',
          lib键: Object.keys(lib).slice(0, 12),
          cookie_tk: ck('_m_h5_tk'),
          cookie_tk_enc: ck('_m_h5_tk_enc') ? '有' : '无',
          cookie_tbToken: ck('_tb_token_') ? '有' : '无',
          cookie_unb: ck('unb') ? '有' : '无'
        };
      })()`);
      console.log('\n=== ' + label + ' ===');
      console.log(JSON.stringify(r, null, 1));
    } catch (e) {
      console.log('\n=== ' + label + ' === 失败: ' + e.message);
    }
    await page.close();
  }
  await b.close();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
