/**
 * 闲鱼 SKU 数据抓取（一次性诊断脚本 · 一步到位版）
 *
 * 背景与已确认的事实（2026-10-16 查证 goofish-client 协议分析库的类型源码）：
 *   ① 规格表在商品详情接口 itemDO.skuList 里，页面打开就有，**不需要点击**
 *      结构：SkuDO { skuId, priceInCent, price, quantity, propertyList[] }
 *      SkuProperty { propertyText(维度名), valueText(值名), valueId, ... }
 *   ② **SkuProperty 九个字段里没有任何图片字段**
 *      —— 规格图压根不在详情接口里，所以无论怎么解析都拿不到图。
 *   ③ 规格图只在点「立即购买」后的确认单页/弹层上出现。
 *
 * 所以本脚本分两段跑：
 *   阶段一：详情接口响应（规格名 + 价格 + 库存）
 *   阶段二：**脚本自己点「立即购买」**，抓确认单接口响应（规格图在这里）
 * 两次响应合并成一个 json 下载下来。
 *
 * 用法（全程只需粘贴一次）：
 *   1. Chrome 打开那个闲鱼多规格商品页
 *   2. F12 → Console → 整段粘贴 → 回车
 *   3. **脚本会自动点「立即购买」**，等几秒后自动下载 json
 *   4. 把 json 放到 D:\work\闲鱼浏览器插件\tools\fixtures\ 目录
 *
 * 注意：
 *   · 控制台的「不要粘贴陌生代码」是 Chrome 正常提示，点「允许粘贴」即可
 *   · 本脚本只读页面数据 + 下载文件，不下单、不付款、不改任何商品数据
 *   · 点了「立即购买」只是打开确认单，不会产生任何交易
 *   · 如果不想让脚本点按钮，按 2 停下，我改成手动版
 */
(function () {
  'use strict';

  var caught = [];        // 抓到的接口响应
  var phase = 1;           // 1=详情页阶段 2=购买弹层阶段
  var done = false;

  function log(m) { console.log('[闲鱼SKU抓取] ' + m); }

  /* ---------- 装响应钩子 ---------- */
  function installHooks() {
    var origFetch = window.fetch;
    window.fetch = function () {
      var url = (typeof arguments[0] === 'string') ? arguments[0]
        : (arguments[0] && arguments[0].url) || '';
      return origFetch.apply(this, arguments).then(function (res) {
        try {
          res.clone().text().then(function (body) {
            if (/mtop|detail|confirm|order|trade/i.test(url)) {
              caught.push({ phase: phase, via: 'fetch', url: url, body: body });
              log('捕获[' + phase + '] ' + caught.length + ' 条：' +
                  url.slice(0, 100));
            }
          }).catch(function () {});
        } catch (e) {}
        return res;
      });
    };

    var origOpen = XMLHttpRequest.prototype.open;
    var origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) {
      this.__xyurl = u;
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      var xhr = this;
      xhr.addEventListener('load', function () {
        try {
          var u = xhr.__xyurl || '';
          if (/mtop|detail|confirm|order|trade/i.test(u)) {
            caught.push({ phase: phase, via: 'xhr', url: u, body: xhr.responseText });
            log('捕获[' + phase + '] ' + caught.length + ' 条：' + u.slice(0, 100));
          }
        } catch (e) {}
      });
      return origSend.apply(this, arguments);
    };
  }

  /* ---------- 读 DOM：规格区 + 规格图 ---------- */
  function readDom() {
    var out = {};

    // 规格按钮：短文本 + 多兄弟
    var boxes = [];
    var all = document.querySelectorAll('div,span,li,button,a,img');
    var buckets = {};
    for (var i = 0; i < all.length && i < 4000; i++) {
      var el = all[i];
      var txt = (el.innerText || el.textContent || '').trim();
      if (!txt || txt.length > 12) continue;
      var own = txt;
      for (var c = 0; c < el.childNodes.length; c++) {
        if (el.childNodes[c].nodeType === 3) own = el.childNodes[c].textContent.trim();
      }
      if (!own || own.length > 12) continue;
      var cls = String(el.className || '');
      if (!cls) continue;
      var key = cls.split(/\s+/).slice(0, 2).join('.');
      (buckets[key] = buckets[key] || []).push(el);
    }
    for (var k in buckets) {
      var g = buckets[k];
      if (g.length < 2 || g.length > 40) continue;
      if (g[0].parentNode !== g[g.length - 1].parentNode) continue;
      boxes.push({
        cls: k,
        count: g.length,
        texts: g.slice(0, 12).map(function (x) {
          return (x.innerText || '').trim().slice(0, 20);
        }),
        hasImg: !!(g[0].querySelector && g[0].querySelector('img'))
      });
    }
    // 只留「像规格」的：成员多、且有图或有短文本
    out.specGroups = boxes.filter(function (b) { return b.count >= 2; }).slice(0, 12);

    // 所有图片（重点看小方图 = 规格图）
    out.images = [];
    var imgs = document.querySelectorAll('img');
    for (var j = 0; j < imgs.length && j < 500; j++) {
      var im = imgs[j];
      var src = im.getAttribute('src') || im.getAttribute('data-src') || '';
      if (!src || src.indexOf('data:') === 0) continue;
      var w = im.naturalWidth || im.width || 0;
      var h = im.naturalHeight || im.height || 0;
      out.images.push({
        src: src.slice(0, 250),
        w: w, h: h,
        cls: String(im.className || '').slice(0, 60),
        alt: im.getAttribute('alt') || ''
      });
      if (out.images.length >= 120) break;
    }
    return out;
  }

  /* ---------- 读页面内嵌数据 ---------- */
  function readEmbedded() {
    var found = [];
    var nodes = document.querySelectorAll('script[type="application/json"]');
    for (var i = 0; i < nodes.length; i++) {
      var txt = nodes[i].textContent || '';
      if (/sku|prop|propertyList|规格/i.test(txt)) {
        found.push({ from: 'script#' + i, json: txt.slice(0, 200000) });
      }
    }
    return found;
  }

  /* ---------- 点「立即购买」 ---------- */
  function clickBuy() {
    var cands = [];
    var texts = ['立即购买', '立即抢购', '立即预定', '我要买', '购买', '拍下'];
    var clickable = document.querySelectorAll('button,a,div[class*="buy"],span[class*="buy"],[class*="Buy"]');
    for (var i = 0; i < clickable.length; i++) {
      var t = (clickable[i].innerText || '').trim();
      for (var j = 0; j < texts.length; j++) {
        if (t === texts[j] || (t && t.length < 8 && t.indexOf(texts[j]) >= 0)) {
          cands.push({
            el: clickable[i],
            text: t,
            cls: String(clickable[i].className || '').slice(0, 60)
          });
        }
      }
    }
    if (!cands.length) return { ok: false, reason: '页面上没找到「立即购买」按钮' };
    var target = cands[0];
    target.el.scrollIntoView({ block: 'center' });
    setTimeout(function () {
      target.el.click();
      log('已点击「' + target.text + '」');
    }, 300);
    return { ok: true, text: target.text, cls: target.cls, total: cands.length };
  }

  /* ---------- 保存 ---------- */
  function save() {
    if (done) return;
    done = true;
    var payload = {
      _note: '闲鱼 SKU 抓取 ' + new Date().toISOString() +
        '。phase1=商品详情接口(规格名/价格)，phase2=购买确认单(规格图在这里)。',
      capturedAt: new Date().toISOString(),
      pageUrl: location.href,
      responses: caught,
      embedded: readEmbedded(),
      dom: readDom()
    };
    var text = JSON.stringify(payload, null, 2);
    var blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    var name = '闲鱼SKU抓取-' +
      new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.json';
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(a.href);
      document.body.removeChild(a);
    }, 3000);
    log('已下载：' + name);
    log('共捕获响应 ' + caught.length + ' 条（阶段一 ' +
        caught.filter(function (c) { return c.phase === 1; }).length +
        '，阶段二 ' +
        caught.filter(function (c) { return c.phase === 2; }).length + '）');
    if (!caught.length) {
      log('⚠ 一条接口响应都没抓到。手动执行 save() 也能把 DOM 部分存下来。');
    }
  }

  /* ---------- 流程 ---------- */
  installHooks();
  log('钩子已挂上（阶段一：详情页）');

  // 先让脚本自己补一次详情请求，确保 phase1 有数据
  try {
    if (window.lib && window.lib.mtop) {
      window.lib.mtop.request({
        api: 'mtop.taobao.idle.pc.detail',
        data: { itemId: String((location.search.match(/[?&]id=(\d+)/) || [])[1] || '') },
        type: 'POST', v: '1.0', dataType: 'json',
        needLogin: false, needLoginPC: false,
        sessionOption: 'AutoLoginOnly', ecode: 0
      }).then(function (r) {
        log('主动补抓详情接口完成');
      }).catch(function (e) {
        log('主动补抓失败（不影响，后面还有）：' + (e && e.message));
      });
    } else {
      log('window.lib.mtop 不存在，改为 F5 刷新时请保持控制台开着');
    }
  } catch (e) {}

  // 等详情页响应进来，再点购买
  setTimeout(function () {
    log('阶段一抓到 ' + caught.length + ' 条，现在点「立即购买」进阶段二…');
    phase = 2;
    var r = clickBuy();
    if (!r.ok) {
      log('⚠ ' + r.reason + '。请自己手动点一下「立即购买」，然后执行 save()');
      return;
    }
    log('已点击，等 6 秒抓确认单响应…');
    setTimeout(save, 6000);
  }, 3000);

  // 兜底：25 秒后无论如何都存一次
  setTimeout(save, 25000);

  window.save = save;   // 手动兜底
  log('若 25 秒内没自动下载，手动执行 save()');
})();