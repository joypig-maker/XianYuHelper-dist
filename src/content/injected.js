/**
 * MAIN world 注入脚本
 *
 * 职责（三层数据获取，逐级兜底）：
 *   L1 拦截页面自己发出的 mtop 请求响应（最稳，零额外请求、自带签名 cookie）
 *   L2 必要时用页面内的 window.lib.mtop 主动请求一次详情接口
 *   L3 直接解析 DOM
 *
 * 注意：运行在 MAIN world，不能使用 chrome.* API，
 *      数据统一通过 window.postMessage 交给 bridge.js。
 */
(function () {
  'use strict';
  if (window.__XY_INJECTED__) return;
  window.__XY_INJECTED__ = true;

  var U = window.XYUtil;
  var SITES = window.XYSites;
  var SEND = 'xy-injected';
  // 扩展版本从 manifest 注入（由 content_scripts 的 match_about_blank 之类无法读到，
  // 所以构建时写死在这里）。__XY__.v 供 tools/read-page.js 判断浏览器里的
  // 扩展是否已换成本地最新代码。
  var XYC = { version: '__VERSION__' };

  /**
   * 当前站点 adapter。所有「站点特有」的行为都从这里取，
   * 本文件里不允许再出现具体域名或选择器字面量。
   */
  // 严格按当前站点走，绝不兜底到别的站点：
  // 在淘宝页用闲鱼的选择器去扫，只会扫出一堆垃圾数据。
  var SITE = (SITES && SITES.current(location)) || null;

  /**
   * 商品池：按 itemId 累积，接口分页 / DOM 增量都往里合并，绝不整体覆盖。
   * 这是「滚动加载后链接不再增加」的根治点。
   */
  var cardMap = Object.create(null);
  var cardSeq = [];
  /**
   * enrichLog：最近几次「补详情」的战果。
   * 图上只剩一张时，第一件要查的事就是详情接口到底补没补到，
   * 而这个结果以前既不落盘也不上报，只能靠猜。
   */
  var state = { detail: null, raw: null, lastApiTime: 0, enrichLog: [], descProbe: null };

  var bus = window.XYPostBus ? window.XYPostBus.channel('injected') : null;

  /**
   * 往 bridge 推数据。走签名通道（自带 id / 签名，第三方脚本没法伪造或抢答）；
   * postbus 万一没加载上——比如页面缓存了旧的内容脚本——退回裸 postMessage，
   * 宁可少一层防护，也别让数据流整个断掉。
   */
  function post(type, payload) {
    if (bus) {
      bus.push('bridge', type, payload);
      return;
    }
    window.postMessage({ source: SEND, type: type, payload: payload }, '*');
  }

  function cardList() {
    return cardSeq.map(function (id) { return cardMap[id]; });
  }

  function mergeCards(incoming) {
    if (!incoming || !incoming.length) return 0;
    var added = 0, updated = 0;
    for (var i = 0; i < incoming.length; i++) {
      var c = incoming[i];
      var id = String(c && c.itemId || '');
      if (!id) continue;
      // 接口/DOM 偶尔会把卖家头像当成缩略图，先剔掉，别让它污染后面的打包
      if (c.image && U.isNonItemImage(c.image)) c.image = '';
      if (c.images && c.images.length) c.images = U.filterItemImages(c.images);
      var old = cardMap[id];
      if (!old) {
        cardMap[id] = c;
        cardSeq.push(id);
        added++;
      } else {
        // 已有则只补空缺字段，不被空的覆盖
        var merged = {};
        Object.keys(old).forEach(function (k) { merged[k] = old[k]; });
        ['title', 'price', 'image', 'sellerNick'].forEach(function (k) {
          if (!(String(merged[k] || '').trim()) && String(c[k] || '').trim()) merged[k] = c[k];
        });
        // images 也得跟着补：collectCards 现在会产出多图，
        // 但接口层与 DOM 层各跑一遍，不补的话后写的一方会把多图冲掉，
        // 结果又退回「只剩一张」（踩过：DOM 扫过时 image 只有单值）
        merged.images = pickCardImages(merged.images, c.images);
        fixSingleImage(merged);
        if (!merged.source) merged.source = c.source;
        cardMap[id] = merged;
        updated++;
      }
    }
    if (added || updated) {
      post('cards', { list: cardList(), added: added, updated: updated, total: cardSeq.length });
    }
    return added;
  }

  function clearCards() {
    cardMap = Object.create(null);
    cardSeq = [];
  }

  /**
   * 图片去重：接口层与 DOM 层各跑一遍采集，同一个 URL 可能被收两次。
   * 只按字符串去重——按图指纹去会误杀 Group 的相似命名
   * （o1cn01a_!!1.jpg 与 o1cn01b_!!2.jpg 指纹只差几位，但确实是两张不同的图）。
   */
  function uniqImg(list) {
    if (!list || !list.length) return [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && out.indexOf(list[i]) === -1) out.push(list[i]);
    }
    return out;
  }

  /**
   * 合并两份图集：取并集再过滤去重。
   *
   * 以前这里有两套规则——mergeCards 是 concat 去重，ensureCardsDetail 却跟着
   * 标量字段一起走「只填空」。后果是：列表页那张缩略图一旦占住位，
   * 详情页返回的完整图集就再也写不进来，打包永远只有那 1 张。
   * 「越多越全」的字段不能按「只填空」处理，两处统一用这一个函数。
   */
  function pickCardImages(oldImgs, newImgs) {
    return U.filterItemImages(uniqImg((oldImgs || []).concat(newImgs || [])));
  }

  /**
   * SKU 表：详情接口 / SKU 接口是唯一权威来源，有就直接取代旧的，
   * 没有就沿用——列表页本身给不出规格。
   */
  function pickCardSkus(oldSkus, newSkus) {
    if (newSkus && newSkus.list && newSkus.list.length) return newSkus;
    return oldSkus || null;
  }

  /**
   * 单值主图：接口偶尔会把卖家头像塞进来当 image，
   * 清掉后从图集里补一张，避免「图集有 5 张但主图字段是张头像」。
   */
  function fixSingleImage(card) {
    if (!card) return card;
    if (card.image && U.isNonItemImage(card.image)) card.image = '';
    if (!card.image && card.images && card.images.length) card.image = card.images[0];
    return card;
  }

  /* ---------------- 响应识别与分发 ---------------- */

  function getApiName(url, json) {
    var m = String(url || '').match(/mtop\.[a-zA-Z0-9_.]+/);
    if (m) return m[0];
    if (json && json.api) return json.api;
    return '';
  }

  function handleResponse(url, json) {
    if (!json) return;
    var api = getApiName(url, json);
    var data = json.data;
    if (!data) return;
    state.lastApiTime = Date.now();

    if (/detail/i.test(api)) {
      var d = U.extractDetail(data, SITE);
      if (d) {
        // 保留上一次缺失的字段（接口分页/增量返回时可能字段不全）
        state.detail = mergeDetail(state.detail, d);
        post('detail', state.detail);
      }
      return;
    }

    if (/search|list|recommend|feed|tab/i.test(api)) {
      // 分页/推荐流接口每次只返回一页，必须合并进累积池
      mergeCards(U.collectCards(data, { site: SITE }));
      // 接口抓到的卡片信息往往偏薄，再拿 DOM 扫一遍互相补全
      scheduleScan();
      return;
    }

    // 淘宝/天猫的店铺商品列表（mtop.taobao.shop.simple.item.fetch）。
    // 响应是 { totalCnt, data:[...], page, pageSize, hasNext }，商品在 data.data 里，
    // 由 collectCards 的 'data' 路径兜住。
    // 必须整名比对：店铺信息接口 mtop.taobao.shop.simple.fetch 和它只差一个 .item，
    // 用模糊匹配会把「店铺信息」也当成商品列表来处理。
    if (SITE.shopApi && SITE.shopApi.api && String(api).indexOf(SITE.shopApi.api) > -1) {
      var shopCards = U.collectCards(data, { site: SITE });
      if (shopCards.length) {
        mergeCards(shopCards);
        scheduleScan();
      }
      return;
    }

    // 店铺页的商品接口：1688 的店铺页不走搜索接口，
    // 返回可能是 JSON 也可能是渲染好的 HTML 片段，两条都试一遍。
    if (SITE.shopApiRe && SITE.shopApiRe.test(url)) {
      var cards = [];
      var payload = data;

      // 返回壳不统一：有的商品挂在 data 下，有的接口直接把内容铺在顶层。
      // 两种都试，只取命中的那个，别让"壳不认识"变成整店抓不到。
      if (payload && typeof payload === 'object') {
        cards = U.collectCards(payload, { site: SITE });
        if (!cards.length) cards = U.collectCards(json, { site: SITE });
      }

      // 也可能是服务端渲染好的 HTML 片段
      if (!cards.length && typeof data === 'string' && data.indexOf('<') > -1) {
        try {
          var parsed = new DOMParser().parseFromString(data, 'text/html');
          cards = U.scanCards(parsed, SITE);
        } catch (e) {}
      }

      if (cards.length) {
        mergeCards(cards);
        scheduleScan();
      }
    }
  }

  function mergeDetail(oldD, newD) {
    if (!oldD) return newD;
    var out = {};
    Object.keys(newD).forEach(function (k) { out[k] = newD[k]; });
    Object.keys(oldD).forEach(function (k) {
      if (out[k] === undefined || out[k] === '' || (Array.isArray(out[k]) && !out[k].length)) {
        out[k] = oldD[k];
      }
    });
    return out;
  }

  /* ---------------- L1: hook fetch ---------------- */

  var origFetch = window.fetch;
  if (typeof origFetch !== 'function') {
    // 少数页面会抹掉原生 fetch。这里预埋一个可被后续赋值替换的钩子，
    // 页面脚本一旦重新定义 window.fetch，我们的拦截会跟着生效。
    try {
      var pendingFetch = null;
      Object.defineProperty(window, 'fetch', {
        configurable: true,
        get: function () { return pendingFetch; },
        set: function (v) {
          pendingFetch = typeof v === 'function' ? wrapFetch(v) : v;
        }
      });
    } catch (e) {}
  } else {
    window.fetch = wrapFetch(origFetch);
  }

  function wrapFetch(orig) {
    return function () {
      var args = arguments;
      var p;
      try {
        p = orig.apply(this, args);
      } catch (e) {
        throw e;
      }
      try {
        var url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
        if (url && SITE && SITE.apiRe && SITE.apiRe.test(url)) {
          p.then(function (res) {
            if (!res || !res.clone) return res;
            var copy = res.clone();
            copy.json().then(function (j) {
              try { handleResponse(url, j); } catch (e) {}
            }).catch(function () {});
            return res;
          }).catch(function () {});
        }
      } catch (e) {}
      return p;
    };
  }

  /* ---------------- L1: hook XMLHttpRequest ---------------- */

  var OrigXHR = window.XMLHttpRequest;
  if (OrigXHR) {
    function PatchedXHR() {
      var xhr = new OrigXHR();
      var self = this;
      var method = '', url = '';
      var origOpen = xhr.open;
      var origSend = xhr.send;

      xhr.open = function (m, u) {
        method = m;
        url = u;
        return origOpen.apply(xhr, arguments);
      };
      xhr.send = function () {
        xhr.addEventListener('load', function () {
          if (!SITE || !SITE.apiRe || !SITE.apiRe.test(url)) return;
          if (xhr.responseType && xhr.responseType !== '' && xhr.responseType !== 'text') return;
          try {
            var txt = xhr.responseText || '';
            if (!txt || txt.length > 3e6) return;
            var j = JSON.parse(txt);
            handleResponse(url, j);
          } catch (e) {}
        });
        return origSend.apply(xhr, arguments);
      };
      return xhr;
    }
    PatchedXHR.prototype = OrigXHR.prototype;
    Object.defineProperty(PatchedXHR, 'UNSENT', { value: 0 });
    ['OPENED', 'HEADERS_RECEIVED', 'LOADING', 'DONE'].forEach(function (k, i) {
      try { Object.defineProperty(PatchedXHR, k, { value: i + 1 }); } catch (e) {}
    });
    try { window.XMLHttpRequest = PatchedXHR; } catch (e) {}
  }

  /* ---------------- L2: 主动调用页面 mtop ---------------- */

  function mtopRequest(params) {
    return new Promise(function (resolve) {
      try {
        var lib = window.lib || (window.lib = {});
        var mtop = lib.mtop;
        if (!mtop || typeof mtop.request !== 'function') return resolve(null);
        var done = false;
        var finish = function (v) {
          if (done) return;
          done = true;
          resolve(v);
        };
        var ret;
        try {
          ret = mtop.request(params, function (r) { finish(r && r.data ? r : null); }, function () { finish(null); });
        } catch (e) {
          return finish(null);
        }
        if (ret && typeof ret.then === 'function') {
          ret.then(function (r) { finish(r); }).catch(function () { finish(null); });
        }
        setTimeout(function () { finish(null); }, 15000);
      } catch (e) {
        resolve(null);
      }
    });
  }

  /**
   * JSONP 取数。1688 的 laputa 接口只支持这种跨域方式，
   * 页面同源所以回调能直接落地。
   */
  function jsonpGet(url, timeoutMs) {
    return new Promise(function (resolve) {
      var done = false;
      var cbName = '__xy_jsonp_' + Date.now() + '_' + Math.floor(Math.random() * 1e6);
      var script = null;
      var timer = setTimeout(function () { finish(null); }, timeoutMs || 8000);

      function finish(v) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { window[cbName] = undefined; } catch (e) {}
        if (script && script.parentNode) script.parentNode.removeChild(script);
        resolve(v);
      }
      try {
        window[cbName] = function (data) { finish(data); };
        script = document.createElement('script');
        script.src = url + (url.indexOf('?') > -1 ? '&' : '?') + 'callback=' + cbName;
        script.onerror = function () { finish(null); };
        (document.head || document.documentElement).appendChild(script);
      } catch (e) {
        finish(null);
      }
    });
  }

  /**
   * 按站点配置取详情，通道有优先级：
   *   1. 站点自己的 mtop（闲鱼走这条，签名 cookie 都是页面自带）
   *   2. 站点声明的 JSONP 接口（1688 走这条）
   * 任一失败都返回 null，由调用方决定是重试还是放弃。
   */
  /**
   * 从当前页面内嵌的数据里取详情。
   * 1688 的 window.context 里有完整商品数据（规格表就在 skuModel 里），
   * 不用再发一次请求——既快也不会触发风控。
   * 前提是确认了商品 ID 对得上，否则等于把别的商品的规格搬过来。
   */
  function siteEmbeddedData(itemId) {
    if (!SITE || !SITE.embedded) return null;
    var spec = SITE.embedded;
    try {
      if (typeof window[spec.global] === 'undefined') return null;
      var obj = window[spec.global];
      for (var i = 0; obj && i < spec.paths.length; i++) obj = obj[spec.paths[i]];
      if (!obj || typeof obj !== 'object') return null;

      // ID 对不上就直接放弃：宁可没数据，也不能张冠李戴
      if (spec.idPaths && spec.idPaths.length) {
        var matched = false;
        for (var j = 0; j < spec.idPaths.length; j++) {
          var v = U.pickPath(window[spec.global], spec.idPaths[j]);
          if (v != null && String(v) === String(itemId)) { matched = true; break; }
        }
        if (!matched) return null;
      }
      return obj;
    } catch (e) {
      return null;
    }
  }

  async function fetchCardDetail(itemId, isRetry) {
    var d = await fetchCardDetailCore(itemId, isRetry);
    if (!d) return null;
    // 规格表不在主数据里，详情拿到后单独补一次。
    // 顺带把详情正文的图也补进来——主图撑不满整套图位，靠这个凑。
    return await ensureSkus(d, itemId, { descImages: true });
  }

  /**
   * 借后台标签页取详情。
   *
   * 有些详情接口只认真正的详情页上下文——淘宝的 pcdetail.data.get /
   * detail.getdesc 在搜索页、店铺页调用一律超时（同页的对照接口却秒通，
   * 补 exParams、改 Referer 都无效，见 sites.js 的 detailPageOnly）。
   * 所以由 service worker 开一个后台标签页去访问详情页，采完立刻回收，
   * 链路见 service_worker.js 的 xy:bg-detail。
   *
   * 超时给到 45s：单个商品是「导航 3~8s + 解析 2s」，批量时还要排在
   * 前面商品后面等，给紧了会把本来能拿到的结果掐掉。
   */
  function fetchDetailViaTab(itemId) {
    if (!bus) return Promise.resolve(null);
    // url 由 bridge 层按 SITE.itemUrl 生成后透传给 SW（见 bridge.js 的 bg-detail），
    // 这里只需要给 itemId。
    return bus.ask('bridge', 'bg-detail', { itemId: String(itemId) }, { timeout: 45000 })
      .then(function (r) {
        return (r && r.ok && r.detail) ? r.detail : null;
      })
      .catch(function () { return null; });
  }

  async function fetchCardDetailCore(itemId, isRetry) {
    if (!itemId || !SITE) return null;
    var cfg = SITE.detailApi || {};

    // 详情接口不认列表页上下文时，借后台标签页采一次。
    // 拿不到就往下走原来的路（会失败，但保持既有行为不变、不额外报错）。
    if (SITE.detailPageOnly && !isOnDetailPage(itemId)) {
      var viaTab = await fetchDetailViaTab(itemId);
      if (viaTab) return viaTab;
    }

    // 当前页就是这个商品的详情页时，内嵌数据最全（含规格表）
    var embed = siteEmbeddedData(itemId);
    if (embed) {
      var d0 = U.extractDetail(embed, SITE);
      if (d0) {
        d0.itemId = String(itemId);
        d0.source = 'embedded';
        return d0;
      }
    }

    if (cfg.api && window.lib && window.lib.mtop && typeof window.lib.mtop.request === 'function') {
      var res = await mtopRequest({
        api: cfg.api,
        v: cfg.v || '1.0',
        data: cfg.buildData ? cfg.buildData(itemId) : { itemId: String(itemId) },
        timeout: 20000,
        needLogin: false,
        sessionOption: 'AutoLoginOnly'
      });
      if (res && res.data) {
        var d = U.extractDetail(res.data, SITE);
        if (d) {
          d.itemId = String(itemId);
          // 接口通了不代表数据全。闲鱼的规格表实测就是「接口通、规格空」，
          // 所以这里必须再走一遍详情页 DOM 的规格兜底——
          // 早退 return d 会让所有「接口有图没规格」的商品都丢规格。
          // 不是详情页时 DOM 拿不到（不是这个商品），自然什么都不补。
          if (isOnDetailPage(itemId)) {
            try {
              var domSkus = pickSkusFromDom();
              if (domSkus) {
                d.skus = (!d.skus || !d.skus.list || !d.skus.list.length)
                  ? domSkus
                  : mergeSkuImages(d.skus, domSkus);
              }
            } catch (e) {}
          }
          return d;
        }
      }
    }

    if (cfg.jsonp) {
      var raw = await jsonpGet(cfg.jsonp.url(itemId), 8000);
      if (raw) {
        var pd = fromOfferView(raw, String(itemId));
        if (pd) return pd;
      }
    }

    // 接口这条线走不通（站点压根没配接口，像京东；或者配了但这次没通）。
    // 只要当前页确实是「这一个」商品的详情页，就退到 DOM 解析——
    // 详情页 DOM 里的图集通常比接口还全（主图 + 详情正文图都在）。
    if (isOnDetailPage(itemId)) {
      var domD = domFallback();
      if (domD && String(domD.itemId || '') === String(itemId)) return domD;
    }

    if (!isRetry) {
      await new Promise(function (r) { setTimeout(r, 800); });
      return fetchCardDetail(itemId, true);
    }
    return null;
  }

  /**
   * 取规格表（1688 专用）。
   * 多 SKU 商品在列表页看起来和单规格没区别，只有补详情时才拿得到规格；
   * 规格表不在商品主数据里，要单独调 SKU 选择器接口。
   * 拿不到就返回 null，让上层继续用别的数据，不阻塞整个批量流程。
   */
  // 1688 后台的主图数量上限，也是 SKU 选择器接口 mainImageList 的固定长度。
  // 列表页接口只给 1~3 张，凑够这个数才算了事；超出说明详情页主体之外
  // 还有货，交给详情正文去补（见 ensureCardsDetail 的详情图兜底）。
  var MAIN_IMAGE_TARGET = 5;

  async function fetchSkus(itemId) {
    if (!SITE || !SITE.skuApi) return null;
    var cfg = SITE.skuApi;
    try {
      var res = await mtopRequest({
        api: cfg.api,
        v: cfg.v || '1.0',
        data: cfg.buildData ? cfg.buildData(itemId) : { offerId: String(itemId) },
        timeout: 15000,
        needLogin: false
      });
      if (!res) return null;
      // 规格表可能在 data 里，也可能被多包一层
      var skus = U.parseSkus(res.data) || U.parseSkus(res);
      // 同一个响应里还挂着完整主图集（mainImageList，实测 5 张）。
      // 以前只取规格、主图随响应一起丢掉，于是商品图永远是列表页给的那几张：
      // 搜索页 1 张、整店页 3 张。不额外多发请求，只是别再把它扔了。
      var images = U.parseMainImages(res.data);
      if (!images.length) images = U.parseMainImages(res);
      if (!skus && !images.length) return null;
      return { skus: skus || null, images: images };
    } catch (e) {
      return null;
    }
  }

  /**
   * 取详情正文里塞的图（补图位用）。
   *
   * 1688/淘宝的主图上限 5 张，闲鱼给到 9 个图位，中间那段得靠详情正文补。
   * 列表页/搜索页拿不到它，要额外发一个请求，所以只在主图补不满时才调，
   * 拿不到就返回空数组——宁可少图，也不能让它挡住打包。
   */
  async function fetchDescImages(itemId) {
    if (!SITE || !SITE.descApi || !itemId) return [];

    // 形态一：mtop 接口返回结构化 JSON（淘宝/天猫）。
    //   data.components.componentData.<detail_pic_*> .model.picUrl，实测 22 张。
    if (SITE.descApi.api && window.lib && window.lib.mtop) {
      var res = await mtopRequest({
        api: SITE.descApi.api,
        v: SITE.descApi.v || '1.0',
        data: SITE.descApi.buildData ? SITE.descApi.buildData(itemId) : { id: String(itemId) },
        timeout: 15000,
        needLogin: false
      });
      if (!res || !res.data) {
        state.descProbe = { itemId: itemId, raw: '(无响应)', images: 0 };
        return [];
      }
      var list = U.parseTaobaoDesc(res.data);
      state.descProbe = { itemId: itemId, raw: 'mtop-json', images: list.length };
      return list;
    }

    // 形态二：jsonp 拿一段 HTML 片段（1688）
    if (!SITE.descApi.jsonp) return [];
    var raw = await jsonpGet(SITE.descApi.jsonp.url(itemId), 8000);
    if (!raw) {
      state.descProbe = { itemId: itemId, raw: '(无响应)', images: 0 };
      return [];
    }
    var out = [];
    if (typeof raw === 'string') {
      // 老形态：直接是一段渲染好的 HTML
      out = U.imagesFromHtml(raw);
    } else if (raw && typeof raw === 'object') {
      // 新形态：正文在某个字段里。先找字段，找不到再把整个响应序列化兜一次
      var html = U.deepFind(raw, ['desc', 'description', 'detailhtml', 'detailhtmlurl', 'content', 'html'],
        function (v) { return typeof v === 'string' && v.indexOf('<') > -1; });
      if (html) out = U.imagesFromHtml(html);
      if (!out.length) out = U.imagesFromHtml(JSON.stringify(raw));
    }
    var images = U.filterItemImages(out);
    // 留痕：这个 widget 的形态不是一成不变的，届时一眼能看出
    // 是接口没打通、还是商家压根没往正文里传图。
    state.descProbe = {
      itemId: itemId,
      raw: typeof raw === 'string' ? 'html(' + raw.length + 'B)' : 'object',
      images: images.length
    };
    return images;
  }

  /**
   * 淘宝/天猫店铺页：主动把整店商品分页拉全。
   *
   * 为什么必须主动拉：实测这个页面**自己不会加载商品列表**——滚动、点分类都不触发，
   * DOM 里商品数恒为 0（对比搜索页是 SSR，DOM 里就是全的）。
   * 想拿到全店 140 件只能自己发请求。
   *
   * shopId / sellerId 在 URL 里没有，但整页 HTML 里带，正则能稳定取到
   * （见 sites.js 的 shopApi.idFromHtml）。
   */
  var SHOP_PAGE_MAX = 20;   // 单次最多翻 20 页（约 600 件），防接口异常时无限翻

  async function fetchShopItems() {
    var sa = SITE && SITE.shopApi;
    if (!sa || !sa.api || !sa.idFromHtml) return { pages: 0, items: 0 };
    var html = '';
    try { html = document.documentElement.innerHTML; } catch (e) { return { pages: 0, items: 0 }; }
    var mShop = html.match(sa.idFromHtml[0]);
    var mSeller = html.match(sa.idFromHtml[1]);
    if (!mShop || !mSeller) return { pages: 0, items: 0, err: '取不到 shopId/sellerId' };

    var shopId = mShop[1];
    var sellerId = mSeller[1];
    var pages = 0;
    var items = 0;
    for (var page = 1; page <= SHOP_PAGE_MAX; page++) {
      var res = await mtopRequest({
        api: sa.api,
        v: sa.v || '1.0',
        data: sa.buildData(shopId, sellerId, page),
        timeout: 15000,
        needLogin: false
      });
      if (!res || !res.data) break;
      var cards = U.collectCards(res.data, { site: SITE });
      if (!cards.length) break;
      mergeCards(cards);
      pages++;
      items += cards.length;
      // 每页都推一次，桥接层能边拉边显示进度，用户不用干等到底
      post('cards', { list: cardList(), added: cards.length, updated: 0, total: cardSeq.length });
      if (!res.data.hasNext) break;
      await new Promise(function (r) { setTimeout(r, 400); });   // 限速，别把风控引出来
    }
    scheduleScan();
    return { pages: pages, items: items, shopId: shopId, sellerId: sellerId };
  }

  // 详情里没有规格表时补一次；补到了就回写，让打包时能带上规格。
  // SKU 响应同时带完整主图集，一并并进图集——列表页给的那几张指望不上。
  async function ensureSkus(d, itemId, opts) {
    if (!d || !itemId) return d;

    // 第一段：补规格表 + 主图集。只有配了 skuApi 的站点能走（1688）。
    // 这里**不能早退**——淘宝没配 skuApi，但下面那段详情图补录还得继续跑，
    // 以前写成 `if (!got) return d;` 把两件事绑死，结果淘宝的详情图
    // （实测 22 张）从来没被补进去过，真机上只出列表页那 1 张缩略图。
    if (SITE && SITE.skuApi && !(d.skus && imageCount(d) >= MAIN_IMAGE_TARGET)) {
      var got = await fetchSkus(itemId);
      if (got) {
        if (got.images && got.images.length) {
          d.images = U.filterItemImages(
            (d.images && d.images.length ? d.images : (d.image ? [d.image] : [])).concat(got.images)
          );
          if (!d.image) d.image = d.images[0];
        }
        if (got.skus) d.skus = got.skus;
      }
    }

    // 第二段：补详情正文图，凑满闲鱼的 9 个图位。
    // 与 skuApi 无关：淘宝主图接口只给 5 张，剩下 4 张全指望这条。
    // 要走一个额外请求，所以只有真正准备打包的那批才补（opts.descImages），
    // ensureSkusPass 那种几十件的大批量扫描不占这个额度。
    if (opts && opts.descImages && imageCount(d) < U.IMAGE_CAP) {
      var descImgs = await fetchDescImages(itemId);
      if (descImgs.length) {
        d.images = U.capImages(U.filterItemImages(
          (d.images && d.images.length ? d.images : (d.image ? [d.image] : [])).concat(descImgs)
        ));
        if (!d.image) d.image = d.images[0];
      }
    }

    post('card-detail', d);
    return d;
  }

  /** 卡片当前的有效图数（列表页那条 store 和详情入参形态不同，统一入口） */
  function imageCount(c) {
    return U.filterItemImages(c.images || (c.image ? [c.image] : [])).length;
  }

  /**
   * 单批补规格的上限。列表页一页 15~30 个商品，滚动还会不断累积，
   * 不设上限就会一口气发上百个 mtop 请求，很容易把风控引出来。
   * 区间价的优先补——它们多半是多规格。
   */
  var SKU_PASS_BATCH = 40;

  /**
   * 多规格补录（第二遍）。
   *
   * 第一遍只补"信息薄"的卡片（缺描述 / 主图不足 2 张），
   * 但多规格商品在列表页往往描述齐全、图片也够，会被整批跳过，
   * 规格就再也补不回来——这正是多 SKU 漏采的根源。
   * 所以这里把没试过的卡片全过一遍，逐个补规格表。
   */
  async function ensureSkusPass(ids) {
    if (!SITE || !SITE.skuApi) return { done: 0, fail: 0, total: 0 };
    // 不用区间价当筛子：实测 1688 搜索页给的都是单值价（0.17、1.75…），
    // 拿它筛选会导致多规格商品一条都补不到。只能逐个试，靠 skusTried 去重。
    var todo = (ids || []).filter(function (id) {
      var c = cardMap[id];
      // 主图不够也得进来：第一遍按「信息薄」筛商品时，描述齐全但只有
      // 1~3 张缩略图的会被跳过，而它们恰恰是主图最需要补的那批。
      // 这个接口一次同时补规格和主图，不额外多发请求。
      return !!(c && !c.skusTried && (!c.skus || imageCount(c) < MAIN_IMAGE_TARGET));
    });
    var range = todo.filter(function (id) {
      return U.isRangePrice((cardMap[id] || {}).price);
    });
    todo = range.concat(todo.filter(function (id) {
      return range.indexOf(id) === -1;
    })).slice(0, SKU_PASS_BATCH);
    var done = 0;
    var fail = 0;
    for (var i = 0; i < todo.length; i++) {
      var id = todo[i];
      try {
        var got = await fetchSkus(id);
        if (got && (got.skus || got.images.length)) {
          var c = cardMap[id] || {};
          if (got.skus) c.skus = got.skus;
          if (got.images.length) {
            c.images = U.filterItemImages((c.images || []).concat(got.images));
            if (!c.image) c.image = c.images[0];
          }
          cardMap[id] = c;
          // 走同一条回写通道，桥接层存进 detailMap，勾选状态不受影响
          post('card-detail', c);
          done++;
        } else {
          // 标记已试过，同一批里不再重复请求
          if (cardMap[id]) cardMap[id].skusTried = true;
          fail++;
        }
      } catch (e) {
        fail++;
      }
      if (i < todo.length - 1) {
        await new Promise(function (r) { setTimeout(r, 400); });
      }
    }
    return { done: done, fail: fail, total: todo.length };
  }

  /**
   * 解析 laputa 返回的 offer 数据。
   * 这套接口给的是批发场景的字段（起订量、SKU 价、库存），
   * 描述和主图不一定在里面，所以只取拿得到的部分，不伪造字段。
   */
  function fromOfferView(raw, itemId) {
    var d = U.extractDetail(raw, SITE);
    if (!d) return null;
    d.itemId = itemId;

    // SKU 列表里可能带更细的图，能补则补
    var list = raw.skuPriceList || raw.skuList || raw.priceList;
    if (Array.isArray(list)) {
      var extra = [];
      for (var i = 0; i < list.length; i++) {
        var imgs = list[i] && (list[i].imageUrls || list[i].images || list[i].pic);
        if (Array.isArray(imgs)) extra = extra.concat(imgs);
        else if (typeof list[i] === 'string') extra.push(list[i]);
      }
      if (extra.length) d.images = U.filterItemImages(d.images.concat(extra));
    }
    if (raw.moq != null && !d.moq) d.moq = raw.moq;
    if (raw.quantity != null && !d.stock) d.stock = raw.quantity;
    d.source = 'api';
    return d;
  }

  /**
   * 批量补详情：卡片列表里的信息太薄（没有描述/店铺），
   * 勾选后统一回来补，串行限速避免触发风控。
   */
  async function ensureCardsDetail(ids) {
    var todo = (ids || []).filter(function (id) {
      var c = cardMap[id];
      if (!c) return false;
      // 列表接口只给标题 / 价格 / 缩略图，下面这些都缺，必须补：
      //   · 没有 desc → 文案就是空的
      //   · 主图不足 2 张 → 多半只抓到一张（可能是卖家头像）
      //   · ★ 规格表不完整 → **多规格恰恰是列表页看不出来的那种**，
      //     少了这一条，多规格商品的规格和 SKU 图就永远补不上。
      //     （这条必须和 bridge 的 dataThin 保持一致，两处判定不同
      //       会导致「这边认为不用补、那边认为要补」，互相打架。）
      if (!c.desc) return true;
      var imgs = U.filterItemImages(c.images || (c.image ? [c.image] : []));
      if (imgs.length < 2) return true;
      var skus = c.skus;
      if (!skus || !skus.list || !skus.list.length) return true;
      // 全部维度都只有 1 个值 = 没有真规格，不必为它再跑一次详情
      var hasRealSpec = (skus.specDefs || []).some(function (d) {
        return d && d.values && d.values.length > 1;
      });
      return !hasRealSpec;
    });
    var done = 0;
    var fail = 0;
    var failedIds = [];      // 失败的留到第二轮重试
    for (var i = 0; i < todo.length; i++) {
      var id = todo[i];
      try {
        var d = await fetchCardDetail(id);
        if (d) {
          // 详情页接口给出的主图列表才是权威的，这里统一剔掉头像/图标
          if (d.images && d.images.length) d.images = U.filterItemImages(d.images);
          if (d.image && U.isNonItemImage(d.image)) d.image = '';
          // 接口回个空壳（只有 itemId，说明请求被风控打回或字段解析失败）
          // 就别往回写了：空壳会盖住卡片里的标题和主图，
          // 打包时反而把整件商品筛掉（2026-09-27 实测）。
          var dHasThing = !!(d.title || d.desc || d.image || (d.images || []).length);
          if (dHasThing) post('card-detail', d);
          var c = cardMap[id] || {};
          var merged = Object.assign({}, c);
          // skus 也在内：多规格商品恰恰是列表页看不出来、只能靠补详情拿到的那批
          ['title', 'price', 'desc', 'sellerNick', 'sellerId', 'location'].forEach(function (k) {
            if (d[k] != null && d[k] !== '' && (merged[k] == null || merged[k] === '')) merged[k] = d[k];
          });
          // 图集和规格表不走「只填空」（那样永远补不进去），按各自的性质单独处理
          merged.images = pickCardImages(merged.images, d.images);
          merged.skus = pickCardSkus(merged.skus, d.skus);
          fixSingleImage(merged);
          cardMap[id] = merged;
          done++;
        } else {
          fail++;
          failedIds.push(id);
        }
      } catch (e) {
        fail++;
        failedIds.push(id);
      }
      post('ensure-progress', { done: done + fail, total: todo.length, ok: done });
      if (i < todo.length - 1) {
        await new Promise(function (r) { setTimeout(r, 400); });
      }
    }
    // 第二遍：第一遍会因为"卡片信息够用"而跳过多规格商品，这里把它们找回来
    var sk = await ensureSkusPass(ids);

    // ★ 第三遍：补失败的再来一次。
    //   批量跑到几十上百件时，中途被限流/风控挡一下是常事，
    //   一次失败就永久丢掉这件商品，正是用户遇到的「勾 100 下来 92」。
    //   限流往往是**暂时的**，隔几秒再试大概率能成。
    var retried = 0;
    if (failedIds.length) {
      post('ensure-progress', {
        done: 0, total: failedIds.length, ok: 0, retry: true
      });
      for (var j = 0; j < failedIds.length; j++) {
        var rid = failedIds[j];
        try {
          // 先歇一下，别紧接着再打同一个接口
          await new Promise(function (r) { setTimeout(r, 900); });
          var d2 = await fetchCardDetail(rid, true);
          if (d2 && (d2.title || d2.desc || d2.image || (d2.images || []).length)) {
            if (d2.images && d2.images.length) d2.images = U.filterItemImages(d2.images);
            if (d2.image && U.isNonItemImage(d2.image)) d2.image = '';
            post('card-detail', d2);
            var c2 = Object.assign({}, cardMap[rid] || {});
            ['title', 'price', 'desc', 'sellerNick', 'sellerId', 'location'].forEach(function (k) {
              if (d2[k] != null && d2[k] !== '' && (c2[k] == null || c2[k] === '')) c2[k] = d2[k];
            });
            c2.images = pickCardImages(c2.images, d2.images);
            c2.skus = pickCardSkus(c2.skus, d2.skus);
            fixSingleImage(c2);
            cardMap[rid] = c2;
            done++; retried++; fail--;
          }
        } catch (e2) { /* 再失败就认了，前面已经告诉用户有几件没补到 */ }
      }
    }

    // 记一笔战果。打包出来图只有一张时，能不能定位全靠这条记录：
    // done=0 且 fail>0 就是详情接口没打（风控 / 未登录），不是下载环节的问题。
    logEnrich({
      asked: ids.length, todo: todo.length,
      detailOk: done, detailFail: fail, retried: retried,
      skuTodo: sk && sk.total, skuOk: sk && sk.done, skuFail: sk && sk.fail
    });

    post('cards', { list: cardList(), added: 0, updated: 0, total: cardSeq.length });
    return {
      done: done, fail: fail, retried: retried, total: todo.length,
      stillFailed: failedIds, skus: sk
    };
  }

  /** 补详情的结果留痕，只保留最近 8 次 */
  function logEnrich(row) {
    if (!state.enrichLog) state.enrichLog = [];
    row.at = new Date().toISOString();
    state.enrichLog.push(row);
    if (state.enrichLog.length > 8) state.enrichLog.shift();
  }

  /* ---------------- L3: DOM 兜底 ---------------- */

  // 站点没配 pageIdRe 时的兜底正则
  var PAGE_ID_RE = /[?&]id=(\d{5,20})|itemId=(\d{5,20})/;

  function currentItemId() {
    if (!SITE) return '';
    var m = location.href.match(SITE.pageIdRe || PAGE_ID_RE);
    return m ? String(m[1] || m[2] || '') : '';
  }

  /**
   * 当前页是否就是「这一个」商品的详情页。
   *
   * 不能只看「URL 里有 id」：必须 id 对得上，否则在 A 商品的详情页去采 B 商品
   * 会张冠李戴；还得确认路径形态确实是详情页（item.htm / /item/），
   * 免得把带 id 参数的列表页误判成详情页。
   */
  function isOnDetailPage(itemId) {
    var here = currentItemId();
    if (!here) return false;
    if (itemId && String(here) !== String(itemId)) return false;
    var re = (SITE && SITE.detailPageRe) || /item\.htm|\/item\//i;
    return re.test(location.href);
  }

  // 当前页面属于哪种场景：商品详情 / 店铺全部商品 / 普通列表
  function detectMode() {
    if (currentItemId()) return 'detail';
    if (isShopPage()) return 'shop';
    return 'list';
  }

  function isShopPage() {
    var sp = SITE && SITE.shopPage;
    if (!sp) return false;
    if (sp.hostRe && sp.hostRe.test(location.host)) return true;
    if (sp.urlRe && (sp.urlRe.test(location.href) || sp.urlRe.test(location.pathname))) return true;
    return false;
  }

  // 店铺页的商品都属于同一家店，把店名补进卡片，导出时才知道出处
  function currentShopName() {
    var sp = SITE && SITE.shopPage;
    if (!sp || !sp.nameSel) return '';
    var el = document.querySelector(sp.nameSel.join(','));
    if (!el) return '';
    return String(el.textContent || '').trim().slice(0, 40);
  }

  function domFallback() {
    if (!SITE) return null;
    var dm = SITE.detailDom || {};
    var itemId = currentItemId();

    // 标题：站点默认标题必须剔除，否则会产出「闲不住？上闲鱼！」这种错误数据
    var DEFAULT_TITLES = dm.defaultTitles || [];
    var title = (document.title || '');
    (dm.titleStrip || [/[-_–]\s*闲鱼.*$/, /^\s*闲鱼\s*[-_–]\s*/]).forEach(function (re) {
      title = title.replace(re, '');
    });
    title = title.trim();
    if (DEFAULT_TITLES.indexOf(title) > -1) title = '';

    // 价格：优先取「纯数字」的价格元素，避免抓到"小刀价"等干扰值
    var price = '';
    var priceEls = document.querySelectorAll('[class*="price"],[class*="Price"]');
    var candidates = [];
    for (var i = 0; i < priceEls.length; i++) {
      var t = (priceEls[i].textContent || '').trim();
      if (!t || t.length > 30) continue;
      var mm = t.match(/^\s*[¥￥]?\s*(\d+(?:\.\d{1,2})?)\s*$/);
      if (mm) { price = mm[1]; break; }
      candidates.push(t);
    }
    if (!price && candidates.length) {
      var m2 = candidates[0].match(/(\d+(?:\.\d{1,2})?)/);
      if (m2) price = m2[1];
    }

    // 店铺名：卖家主页链接（textContent 会把整个信息块连起来，这里只取第一行）
    var sellerNick = '';
    var sellerId = '';
    var a = null;
    if (dm.shopLinkRe) {
      try {
        var shopAs = document.querySelectorAll('a[href]');
        for (var sa = 0; sa < shopAs.length; sa++) {
          var sh = shopAs[sa].getAttribute('href') || '';
          if (sh.length > 300) continue;
          if (dm.shopLinkRe.test(sh) || dm.shopLinkRe.test(shopAs[sa].getAttribute('href') || '')) {
            a = shopAs[sa];
            break;
          }
        }
      } catch (e) {}
    }
    if (a) {
      var raw = (a.innerText || a.textContent || '').trim();
      sellerNick = raw.split(/\n+/)[0].trim().slice(0, 30);
      var href = a.getAttribute('href') || '';
      var m3 = href.match(/[?&](?:userId|shopId|memberId)=(\d+)/);
      if (m3) sellerId = m3[1];
    }
    // 店铺页兜底：整页都是这家店的，直接取页面上的店名
    if (!sellerNick && isShopPage()) sellerNick = currentShopName();
    if (!sellerNick || sellerNick.length > 24) {
      var nickEl = document.querySelector(
        (SITE.field && SITE.field.shop || ['[class*="sellerName"]', '[class*="userNick"]', '[class*="shopName"]']).join(',')
      );
      if (nickEl) sellerNick = (nickEl.textContent || '').trim().slice(0, 30);
    }

    // 主图。
    // 站点给了精确选择器就用它：京东详情页光 img 就有 160+ 张
    // （评论图、推荐位、规格图全混在里面），全页扫会把它们一起当成主图。
    var imgEls;
    if (dm.mainImgSel) {
      try { imgEls = document.querySelectorAll(dm.mainImgSel); } catch (e) { imgEls = []; }
    } else {
      imgEls = document.querySelectorAll('img');
    }
    var imgs = [];
    for (var j = 0; j < imgEls.length; j++) {
      var src = U.imgFromElement(imgEls[j]);
      if (!src) continue;
      if (!U.IMAGE_HOST_RE.test(src)) continue;
      if (/avatar|head|logo|icon|tps-|\/tfs\//i.test(src)) continue;
      var w = imgEls[j].naturalWidth || imgEls[j].width || 0;
      if (w && w < (dm.imgMinWidth || 200)) continue;
      // 尺寸升级：京东把尺寸写在 URL 里（.../s228x228_jfs/...）。
      // 缩略图只有 6KB 且是 AVIF；换成 s800x800_ 才是能用的 JPEG（94KB）。
      var up = SITE.imageUpgrade || dm.imageUpgrade;
      if (up) src = up(src);
      imgs.push(U.normalizeImageUrl(src));
    }
    imgs = imgs.filter(function (v, i, s) { return s.indexOf(v) === i; });
    if (!dm.mainImgSel) {
      // 老站点（1688/淘宝）的商品图都在 bao/uploaded 目录下，优先取那批
      var preferred = imgs.filter(function (u) { return /bao\/uploaded/.test(u); });
      if (preferred.length) imgs = preferred;
    }

    // 详情正文图：主图就那么几张，凑满 9 个图位要靠它。
    // 单独取、不并进主图选择器——详情图又长又窄（实测 790px 宽），
    // 混在一起会让两边的选择器互相干扰。
    if (dm.descImgSel) {
      var descImgs = [];
      try {
        var dNodes = document.querySelectorAll(dm.descImgSel);
        for (var dq = 0; dq < dNodes.length; dq++) {
          var ds = U.imgFromElement(dNodes[dq]);
          if (!ds) continue;
          if (!U.IMAGE_HOST_RE.test(ds)) continue;
          if (/avatar|headimg|logo|\bicon\b|tps-|\/tfs\//i.test(ds)) continue;
          var dw = dNodes[dq].naturalWidth || dNodes[dq].width || 0;
          if (dw && dw < (dm.descImgMinWidth || 400)) continue;
          descImgs.push(U.normalizeImageUrl(up ? up(ds) : ds));
        }
      } catch (e2) {}
      if (descImgs.length) {
        // 主图在前、详情图在后——顺序即优先级，截到 9 张时先保主图
        imgs = U.capImages(U.filterItemImages(imgs.concat(descImgs)));
      }
    }

    // 主图视频：详情页 DOM 里的 <video>。
    // 1688 实测在 div.od-video-wrapper > video.lib-video，src 是
    // //cloud.video.taobao.com/play/u/.../401098362651705.mp4（不带协议头）。
    // 详情接口基本不带视频，所以这一路是视频地址的主要来源。
    //
    // 闲鱼的 <video> 多是 MSE 流，src 是 blob: —— normalizeVideoUrl 会丢掉，
    // 这时退到资源表里捞真实分片（见 pickVideoFromResources）。
    var videos = [];
    try {
      var vEls = document.querySelectorAll('video');
      for (var vi = 0; vi < vEls.length; vi++) {
        var vu = U.normalizeVideoUrl(
          vEls[vi].getAttribute('src') || U.videoFromElement(vEls[vi])
        );
        if (vu) {
          videos.push({ url: vu, duration: '', cover: U.imgFromElement(vEls[vi]) || '' });
          break;                                  // 主图视频只要第一个
        }
      }
      if (!videos.length) {
        var fromRes = pickVideoFromResources();
        if (fromRes) videos.push({ url: fromRes, duration: '', cover: '' });
      }
    } catch (e) {}

    // 规格表：接口给不出来时从 DOM 兜底。
    // 闲鱼没有实测样本，接口字段名只能猜；但详情页的规格按钮是**看得见摸得着**的，
    // 所以这条路不依赖任何字段名——只要商品页开着，就能读出规格值和规格图。
    var domSkus = pickSkusFromDom();
    if (!skus || !skus.list || !skus.list.length) {
      if (domSkus) skus = domSkus;
    } else if (domSkus) {
      // 接口解析出了规格表，但规格图全空 → 用 DOM 里的图补上
      skus = mergeSkuImages(skus, domSkus);
    }

    // 描述：取正文容器文本
    var desc = '';
    var descEl = document.querySelector(dm.descSel || '[class*="desc"],[class*="Desc"],[class*="content"]');
    if (descEl) desc = (descEl.innerText || descEl.textContent || '').trim();

    // 1688 详情页内嵌 schema.org 结构化数据，比 DOM 猜更全
    if (dm.jsonLd) {
      var ld = readJsonLd();
      if (ld) {
        if (ld.name && !title) title = ld.name;
        if (ld.description && !desc) desc = ld.description;
        if (ld.image && ld.image.length) {
          imgs = U.filterItemImages(imgs.concat(ld.image));
        }
        if (ld.price && !price) price = U.firstPrice(String(ld.price));
      }
    }

    // 有效性判定：标题和图片至少要有一个像样的，否则宁可返回空也不给错数据
    var meaningfulTitle = title.length > 3;
    if (!meaningfulTitle && imgs.length < 3) return null;

    var shop = currentShopName();

    return {
      itemId: itemId,
      title: title,
      desc: desc || title,
      price: price,
      images: U.capImages(imgs),
      sellerNick: sellerNick || shop,
      sellerId: sellerId,
      sellerUrl: sellerUrlOf(sellerId),
      location: '',
      wantNum: '',
      browseNum: '',
      publishTime: '',
      skus: skus || null,
      videos: videos,
      url: itemId ? SITE.itemUrl(itemId) : location.href,
      source: 'dom'
    };
  }

  function sellerUrlOf(sellerId) {
    if (!sellerId) return '';
    if (SITE && SITE.sellerUrl) return SITE.sellerUrl(sellerId);
    return 'https://www.goofish.com/personal?userId=' + sellerId;
  }

  /**
   * 从资源表（performance entries）里捞视频地址——专治 blob: / MSE 流。
   *
   * 闲鱼的商品视频走的是 MediaSource：<video src> 是 blob:http://...，
   * blob 地址没法直接下载。但它拉的分片都是普通的 http(s) 请求，
   * 会在资源表里留下记录。优先挑 mp4（能直接下），其次挑 m3u8（要合并）。
   *
   * 只在当前页面活着的时候有意义，所以这是个兜底而不是主路。
   * 返回 '' 表示没捞到。
   */
  function pickVideoFromResources() {
    try {
      if (!window.performance || !performance.getEntriesByType) return '';
      var entries = performance.getEntriesByType('resource');
      var m3u8 = '';
      for (var i = 0; i < entries.length; i++) {
        var n = entries[i].name || '';
        if (!/\.(mp4|m3u8|mov|webm)(\?|$)/i.test(n)) continue;
        // 分片（.ts / .m4s）单独出现时没有扩展名，这里靠 URL 特征兜一层
        var u = U.normalizeVideoUrl(n);
        if (!u) {
          // .ts 分片：连续数字段的那一串，多半是同一段视频
          if (/\/(seg|segment|hls)\//i.test(n) && /\.ts(\?|$)/i.test(n)) {
            if (!m3u8) m3u8 = 'hls:' + n;
          }
          continue;
        }
        if (/\.m3u8(\?|$)/i.test(u)) {
          if (!m3u8) m3u8 = u;
        } else {
          return u;                 // mp4 直接可用，优先级最高
        }
      }
      if (m3u8.indexOf('hls:') === 0) return '';   // 只看到分片、没有清单，无从下手
      return m3u8;
    } catch (e) {
      return '';
    }
  }

  // 读页面内嵌的 schema.org Product 数据（1688 详情页每个商品都带）
  /**
   * 从详情页 DOM 读规格表 —— **不依赖任何接口字段名**的兜底。
   *
   * 为什么必须写这条路：闲鱼的规格字段名从头到尾没有实测样本，
   * 现有解析全是照淘宝/1688 的形态猜的，实测在闲鱼上规格表和规格图全丢。
   * 但详情页的规格按钮是肉眼可见的：每个规格值一个可点元素，
   * 旁边常常直接挂着一张该规格的缩略图。所以只要商品页开着，
   * 规格值和规格图就能读出来——这条路不依赖接口长什么样。
   *
   * 认法：找「看起来像规格按钮」的元素集合。
   * 判据（任一命中即算一组）：
   *   · 类名含 sku/prop/spec/option/value/sku-item
   *   · 或者元素文本很短（≤6 字）且同级有 2~30 个类似兄弟（规格值都不长）
   * 图片取元素内的 img，或元素自身的 data-* 图片字段。
   *
   * 认不出就返回 null，绝不硬造。
   */
  /**
   * 从 create-order（确认单）页采集规格图。**实测确认的选择器，见下。**
   *
   * 为什么必须走这个页面（2026-10-17 CDP 实测）：
   *   · 商品详情接口 itemDO.skuList 里 **SkuProperty 九个字段没有任何图片字段**
   *   · 但 create-order 页上，切不同颜色/规格时**订单信息区的商品缩略图会跟着换**
   *     实测 1069136411938：黑色 → O1CN01kRc6ca1...jpg，灰色 → O1CN018gjvkj...jpg
   *   也就是说规格图确实存在，只是不在详情接口里，而在确认单的渲染结果中。
   *
   * 实测确认的页面结构：
   *   · 规格值按钮  class 含 `option--`，选中态背景色 rgb(255, 230, 15)（黄）
   *   · 维度名标签  class 含 `title--`，点击无效
   *   · 不可选的值背景是浅灰 rgb(247,247,247)
   *
   * 策略：只遍历「值最少」的那一维（规格图主要跟它相关，实测尺码维度切了图也不变）。
   *
   * ⚠️ 安全：只点规格值按钮（切换选中），绝不点「提交订单/立即下单/确认付款」，
   *    DANGER 文案黑名单硬性拦截。抓完由调用方关掉标签页。
   */
  var SPEC_OPTION_SEL = '[class*="option--"]';
  var SPEC_DANGER = /提交订单|立即下单|确认付款|去支付|付款|下单|支付|立即购买|立即抢购|立即预定|拍下|加入购物车|提交/;

  /** 把页面上的规格值按钮按维度分组 */
  function groupSpecOptions() {
    try {
      var items = document.querySelectorAll(SPEC_OPTION_SEL);
      var dims = {};
      for (var i = 0; i < items.length; i++) {
        var el = items[i];
        var t = (el.innerText || el.textContent || '').trim();
        if (!t || SPEC_DANGER.test(t)) continue;
        // 维度名 = 往上找几层的兄弟短文本
        var dim = '';
        var p = el.parentElement;
        for (var k = 0; k < 3 && p; k++, p = p.parentElement) {
          var sib = p.previousElementSibling;
          if (sib) {
            var s = (sib.innerText || '').trim();
            if (s && s.length <= 8) { dim = s; break; }
          }
        }
        var key = dim || '规格';
        if (!dims[key]) dims[key] = [];
        dims[key].push({ el: el, value: t });
      }
      return dims;
    } catch (e) {
      return {};
    }
  }

  /**
   * 遍历最小维度，记录每个规格值对应的订单信息区图片。
   * @returns {Promise<{dim:string, map:{value:url}}>}
   */
  function harvestSpecImages(opt) {
    opt = opt || {};
    var dims = groupSpecOptions();
    var keys = Object.keys(dims);
    if (!keys.length) return Promise.resolve(null);
    // 值最少的那一维
    keys.sort(function (a, b) { return dims[a].length - dims[b].length; });
    var dim = keys[0];
    var list = dims[dim];
    var limit = opt.limit || 20;
    var map = {};
    var lastSrc = '';
    var step = 0;

    function orderAreaImage() {
      // 订单信息区的商品缩略图：宽高在 30~200 之间、且不是导航小图标
      var imgs = document.querySelectorAll('img');
      var best = '';
      for (var i = 0; i < imgs.length; i++) {
        var im = imgs[i];
        var src = im.src || im.getAttribute('data-src') || '';
        if (!src || src.indexOf('data:') === 0) continue;
        var r = im.getBoundingClientRect();
        var w = Math.round(r.width), h = Math.round(r.height);
        if (w < 30 || h < 30) continue;          // 太小的多半是图标
        if (src === lastSrc) continue;           // 与上一步相同 = 没换
        best = src;
        break;
      }
      return best;
    }

    function next() {
      if (step >= list.length || step >= limit) {
        return Promise.resolve({ dim: dim, map: map });
      }
      var cur = list[step++];
      try {
        cur.el.click();
      } catch (e) {
        return next();
      }
      // 等图片刷新。实测 1.5s 足够；慢一点更稳但批量会拖长
      setTimeout(function () {
        var src = orderAreaImage();
        if (src) {
          map[cur.value] = src;
          lastSrc = src;
        }
        next();
      }, opt.delayMs || 1500);
      return null;
    }
    return next();
  }

  /** 判断页面是不是 create-order */
  function isCreateOrderPage() {
    return /\/create-order/i.test(location.pathname || '');
  }

  function pickSkusFromDom() {
    try {
      // 先按类名找，找不到再按「短文本 + 多兄弟」这个特征找
      var groups = [
        '[class*="sku-item"]', '[class*="skuItem"]',
        '[class*="sku-value"]', '[class*="skuValue"]',
        '[class*="prop-item"]', '[class*="propItem"]',
        '[class*="spec-item"]', '[class*="specItem"]',
        '[class*="option-item"]', '[class*="optionItem"]',
        '[class*="skuContent"] [class*="item"]',
        '[class*="sku"] [class*="value"]'
      ];

      for (var gi = 0; gi < groups.length; gi++) {
        var r = readSkuGroup(document.querySelectorAll(groups[gi]));
        if (r) return r;
      }

      // 特征法：全页扫一遍，找「文本短且同类兄弟多」的集合
      return readSkuGroupByShape();
    } catch (e) {
      return null;
    }
  }

  /** 把一组元素读成 {specs, specDefs, list} */
  function readSkuGroup(els) {
    if (!els || els.length < 2 || els.length > 60) return null;
    var values = [];
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!el) continue;
      var txt = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
      if (!txt || txt.length > 30) continue;
      // 「已售」「立即购买」这类按钮混进来的一律不要
      if (/^(立即购买|立即抢购|立即预定|免费|客服|举报|收藏|分享|下架|失效)$/.test(txt)) continue;
      var imgEl = el.querySelector ? el.querySelector('img') : null;
      var img = '';
      if (imgEl) {
        img = U.imgFromElement(imgEl);
        if (!img) {
          // 规格图常挂在背景图上
          var bg = imgEl.getAttribute && (imgEl.getAttribute('data-src') ||
            imgEl.style && (imgEl.style.backgroundImage || '').match(/url\(["']?([^"')]+)/ || [])[1]);
          if (bg) img = bg;
        }
      }
      if (!img) {
        // 有的实现把图挂在按钮自己的 data-* 上
        img = el.getAttribute && (el.getAttribute('data-img') ||
          el.getAttribute('data-image') || el.getAttribute('data-src') || '');
      }
      values.push({
        value: txt.slice(0, 40),
        image: img ? U.normalizeImageUrl(String(img)) : ''
      });
    }
    if (values.length < 2) return null;
    return packDomSkus(values);
  }

  /**
   * 特征法找规格组：按 class 名分组，挑「文本短、成员多、成员之间像兄弟」的那一组。
   * 用来兜住「类名不含 sku/prop 字样但确实是规格」的实现。
   */
  function readSkuGroupByShape() {
    try {
      var all = document.querySelectorAll('div,span,li,button,a');
      var buckets = {};
      for (var i = 0; i < all.length && i < 3000; i++) {
        var el = all[i];
        var txt = (el.innerText || el.textContent || '').trim();
        // 只认「自身文本」很短的（长文本是容器，不是规格按钮）
        if (!txt || txt.length > 12) continue;
        var own = txt;
        for (var c = 0; c < el.childNodes.length; c++) {
          if (el.childNodes[c].nodeType === 3) own = el.childNodes[c].textContent.trim();
        }
        if (!own || own.length > 12) continue;
        var cls = String(el.className || '');
        if (!cls) continue;
        // 取 class 里的第一个词做分组键
        var key = cls.split(/\s+/)[0] + '|' + (el.parentNode && el.parentNode.className
          ? String(el.parentNode.className).split(/\s+/)[0] : '');
        if (!buckets[key]) buckets[key] = [];
        buckets[key].push(el);
      }
      var best = null, bestScore = 0;
      for (var k in buckets) {
        if (!Object.prototype.hasOwnProperty.call(buckets, k)) continue;
        var group = buckets[k];
        if (group.length < 2 || group.length > 40) continue;
        // 要求这些元素确实是兄弟（同一个父节点），否则会把全页同名字段攒到一起
        if (group[0].parentNode !== group[group.length - 1].parentNode) continue;
        var score = group.length;
        if (group[0].querySelector && group[0].querySelector('img')) score += 5;
        if (score > bestScore) { bestScore = score; best = group; }
      }
      return best ? readSkuGroup(best) : null;
    } catch (e) {
      return null;
    }
  }

  /** 把 [{value,image}] 包成 parseSkus 的同构结构 */
  function packDomSkus(values) {
    var def = { name: '规格', values: values };
    var list = values.map(function (v) {
      return {
        key: v.value,
        names: [v.value],
        price: '',
        stock: '',
        image: v.image || ''
      };
    });
    return { specs: ['规格'], specDefs: [def], list: list };
  }

  /**
   * 用 DOM 结果补接口结果的规格图。
   * 只补图，不改接口的价格/库存——那部分接口更准。
   * 按规格值名匹配，认不出就跳过（宁可空着也不挂错）。
   */
  function mergeSkuImages(fromApi, fromDom) {
    if (!fromApi || !fromApi.specDefs || !fromDom || !fromDom.specDefs) return fromApi;
    var domImg = {};
    fromDom.specDefs.forEach(function (d) {
      (d.values || []).forEach(function (v) {
        if (v && v.image && !domImg[v.value]) domImg[v.value] = v.image;
      });
    });
    if (!Object.keys(domImg).length) return fromApi;
    fromApi.specDefs.forEach(function (d) {
      (d.values || []).forEach(function (v) {
        if (v && !v.image && domImg[v.value]) v.image = domImg[v.value];
      });
    });
    return fromApi;
  }

  function readJsonLd() {
    try {
      var nodes = document.querySelectorAll('script[type="application/ld+json"]');
      for (var i = 0; i < nodes.length; i++) {
        var j = JSON.parse((nodes[i].textContent || '').trim());
        var arr = Array.isArray(j) ? j : [j];
        for (var k = 0; k < arr.length; k++) {
          var o = arr[k] || {};
          var types = Array.isArray(o['@type']) ? o['@type'] : [String(o['@type'] || '')];
          if (types.join(' ').indexOf('Product') > -1) {
            var offer = o.offers;
            var price = '';
            if (offer && !Array.isArray(offer) && offer.price) price = offer.price;
            else if (Array.isArray(offer) && offer[0] && offer[0].price) price = offer[0].price;
            return {
              name: o.name || '',
              description: o.description || '',
              image: Array.isArray(o.image) ? o.image : (o.image ? [o.image] : []),
              price: String(price || '')
            };
          }
        }
      }
    } catch (e) {}
    return null;
  }

  /* ---------------- 列表页 DOM 增量扫描 ---------------- */

  var scanTimer = null;
  var scanIdle = null;

  function idleScan() {
    if (scanIdle) return;
    if (window.requestIdleCallback) {
      scanIdle = window.requestIdleCallback(function () { scanIdle = null; runScan(); }, { timeout: 1200 });
    } else {
      scanIdle = setTimeout(function () { scanIdle = null; runScan(); }, 300);
    }
  }

  function scheduleScan() {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(function () { scanTimer = null; idleScan(); }, 500);
  }

  function runScan() {
    if (!document.body) return;
    var before = cardSeq.length;
    var added;
    try {
      added = mergeCards(U.scanCards(document, SITE));
    } catch (e) {
      return;
    }
    // 扫描本身也可能触发新一轮渲染，留一次尾巴
    if (added > 0) scheduleScan();
    return { before: before, after: cardSeq.length };
  }

  function bindScanTriggers() {
    window.addEventListener('scroll', scheduleScan, { passive: true });
    window.addEventListener('resize', scheduleScan);
    document.addEventListener('mousewheel', scheduleScan, { passive: true });
    if (window.MutationObserver && document.body) {
      try {
        new window.MutationObserver(scheduleScan).observe(document.body, {
          childList: true, subtree: true
        });
      } catch (e) {}
    }
    // 兜底轮询：SPA 页面可能不触发可观测事件
    setInterval(function () {
      if (document.visibilityState === 'visible') runScan();
    }, 4000);
  }

  /* ---------------- 站点诊断 ---------------- */

  /**
   * 采集一份「现场体检报告」。
   * 选择器这类东西没法靠猜——插件作者看不到用户的页面，
   * 只能让用户点一下诊断，把实际的链接形态和类名命中数导出来再定选择器。
   */
  function buildDiagnose() {
    var report = {
      site: SITE ? SITE.key : null,
      siteName: SITE ? SITE.name : '(未匹配到站点)',
      host: location.host,
      href: location.href,
      mode: detectMode(),
      cardsInPool: cardList().length,
      timestamp: new Date().toISOString()
    };

    // 1) 站点自带选择器命中数
    var probe = {};
    try {
      probe['a[href]'] = document.querySelectorAll('a[href]').length;
      if (SITE && SITE.cardSel) {
        probe[SITE.cardSel] = document.querySelectorAll(SITE.cardSel).length;
      }
    } catch (e) {}
    report.selectorProbe = probe;

    // 2) 猜一批常见类名，看哪个命中最多（调选择器全靠这个）
    var guess = [
      '.sm-offer-item', '[class*="offer-item"]', '[data-offer-id]',
      '[class*="item"]', '[class*="card"]', '[class*="product"]',
      '[class*="goods"]', '[class*="shop-item"]'
    ];
    var hits = {};
    guess.forEach(function (sel) {
      try {
        var n = document.querySelectorAll(sel).length;
        if (n > 0) hits[sel] = n;
      } catch (e) {}
    });
    report.guessHits = hits;

    // 3) 商品链接样本：id + href + 祖先 class 链
    report.linkSamples = sampleLinks(12);

    // 4) 已抓到的卡片样本
    report.cardSample = cardList().slice(0, 3).map(function (c) {
      return {
        itemId: c.itemId, title: c.title, price: c.price,
        image: String(c.image || '').slice(0, 90), sellerNick: c.sellerNick,
        missing: {
          desc: !c.desc,
          images: U.filterItemImages(c.images || (c.image ? [c.image] : [])).length
        }
      };
    });

    // 4.5) 打包体检：图上到底有几张、规格补没补到。
    //      「下载只有一张图」的锅可能在补数据，也可能在下载，
    //      以前两边都没留下任何痕迹，只能一遍遍猜。
    report.packCheck = packCheck();
    report.enrichLog = (state.enrichLog || []).slice();

    // 4.6) 详情正文探测。补图位的最后一环依赖它，
    //      而这个 widget 的形态不是一成不变的，所以每次诊断都实测一次，
    //      顺便回答「到底是接口没通，还是商家压根没传细节图」。
    report.descProbe = state.descProbe || '(未探测)';

    // 4.7) 价格探测：列表页价格取空时，得看清卡片里究竟有哪些价格节点。
    //      京东店铺页有**多套模板**（同一家店，分类入口和「所有商品」入口的
    //      类名都不一样），光看「价格为 0 条」判断不出是选择器写错、
    //      还是命中了促销节点被长度检查挡掉。把候选节点连文本一起打出来，
    //      一眼就能看出该配哪个选择器。
    report.priceProbe = (function () {
      var out = [];
      try {
        if (!SITE || !SITE.cardSel) return '(站点无 cardSel)';
        var els;
        try { els = document.querySelectorAll(SITE.cardSel); } catch (e) { return '(cardSel 无效)'; }
        if (!els.length) return '(页面上没有卡片元素，可能是限流降级页)';
        for (var ci = 0; ci < Math.min(2, els.length); ci++) {
          var el = els[ci];
          var nodes = el.querySelectorAll('[class*="rice"],[class*="Price"]');
          var list = [];
          for (var ni = 0; ni < Math.min(nodes.length, 8); ni++) {
            var n = nodes[ni];
            var own = '';
            for (var k = 0; k < n.childNodes.length; k++) {
              if (n.childNodes[k].nodeType === 3) own += n.childNodes[k].textContent.trim();
            }
            list.push('.' + String(n.className || '(无类名)').slice(0, 40) +
              '  自身="' + own.slice(0, 18) +
              '"  整体="' + String(n.innerText || n.textContent || '')
                .replace(/\s+/g, ' ').trim().slice(0, 22) + '"');
          }
          out.push({
            卡片: String(el.className || '').slice(0, 34),
            价格节点: list.length ? list : '(该卡片里没有任何含 price 的节点)'
          });
        }
      } catch (e) {
        return ['价格探测异常: ' + (e && e.message)];
      }
      return out;
    })();

    // 5) 站点配置快照（函数换成占位符，方便直接贴给 AI 分析）
    report.config = snapshotConfig();
    return report;
  }

  /**
   * 盘点商品池的数据成色。
   *
   * packSummary 看全貌（多少商品只有 0/1 张图、多少带规格），
   * packThin 把「图少或没规格」的单独列出来——
   * 这批就是打包后目录里几乎空荡荡的那几个。
   */
  function packCheck() {
    var pool = cardList();
    var dist = { img0: 0, img1: 0, imgFew: 0, imgEnough: 0, withSkus: 0, noDesc: 0 };
    var thin = [];
    pool.forEach(function (c) {
      var imgs = U.filterItemImages(c.images || (c.image ? [c.image] : []));
      var n = imgs.length;
      if (n === 0) dist.img0++;
      else if (n === 1) dist.img1++;
      else if (n < 5) dist.imgFew++;
      else dist.imgEnough++;

      var hasSkus = !!(c.skus && c.skus.list && c.skus.list.length);
      if (hasSkus) dist.withSkus++;
      if (!c.desc) dist.noDesc++;

      if (n < 5 || !hasSkus) {
        thin.push({
          itemId: c.itemId, images: n,
          skus: hasSkus ? c.skus.list.length : 0,
          desc: !!c.desc,
          source: c.source || '(未知)',
          detailTried: !!c.skusTried
        });
      }
    });
    return { summary: Object.assign({ total: pool.length }, dist), thin: thin.slice(0, 30) };
  }

  function sampleLinks(limit) {
    var res = [];
    var seen = {};
    if (!SITE || !SITE.idRe) return res;
    try {
      var as = document.querySelectorAll('a[href]');
      for (var i = 0; i < as.length && res.length < limit; i++) {
        var href = as[i].getAttribute('href') || '';
        if (!href || href.length > 250) continue;
        var m = href.match(SITE.idRe);
        if (!m) continue;
        var id = String(m[1] || m[2] || '');
        var chain = [];
        var cur = as[i];
        for (var c = 0; cur && c < 4; c++) {
          var cls = cur.className ? String(cur.className).trim().split(/\s+/).slice(0, 3).join('.') : '';
          chain.unshift(cls ? cur.tagName.toLowerCase() + '.' + cls : cur.tagName.toLowerCase());
          cur = cur.parentElement;
        }
        var key = id + '|' + chain.join('>');
        if (seen[key]) continue;
        seen[key] = 1;
        res.push({ id: id, href: href.slice(0, 130), chain: chain.join(' > ') });
      }
    } catch (e) {}
    return res;
  }

  function snapshotConfig() {
    if (!SITE) return null;
    var out = {};
    Object.keys(SITE).forEach(function (k) {
      var v = SITE[k];
      if (typeof v === 'function') out[k] = '(function)';
      else if (v && typeof v === 'object') {
        var o = {};
        Object.keys(v).forEach(function (k2) {
          o[k2] = typeof v[k2] === 'function' ? '(function)' : v[k2];
        });
        out[k] = o;
      } else out[k] = v;
    });
    return out;
  }

  /* ---------------- 对外接口 ---------------- */

  async function resolveDetail(force) {
    var id = currentItemId();
    if (state.detail && !force) return state.detail;

    if (force || !state.detail) {
      var apiData = await fetchCardDetail(id);
      if (apiData) {
        state.detail = mergeDetail(state.detail, apiData);
        return state.detail;
      }
    }
    var dom = domFallback();
    if (dom) {
      state.detail = mergeDetail(state.detail, dom);
    }
    return state.detail;
  }

  function resolveCards() {
    runScan();
    return cardList();
  }

  // 接收 bridge 的指令。返回值会由 postbus 自动带回 _FINISH。
  if (bus) {
    bus.on('bridge', 'get-detail', function (p) {
      return resolveDetail(!!p && p.force);
    });
    bus.on('bridge', 'get-cards', function () {
      resolveCards();
      return null;
    });
    bus.on('bridge', 'ensure-cards', function (p) {
      return ensureCardsDetail((p && p.ids) || []);
    });
    // 来自 service worker 开的后台标签页：在 create-order 页采规格图。
    // 兜底路径 —— 详情接口已经带 propertyImage 了（2026-10-17 实测确认），
    // 只有少数商品的 skuList 里没挂图，才需要开确认单页点一遍。
    bus.on('bridge', 'collect-spec-images', function (p) {
      if (!isCreateOrderPage()) {
        return { ok: false, error: '当前页不是确认单页' };
      }
      // 页面是 SPA，DOM 渲染比 complete 晚，等一拍再动手
      return new Promise(function (r) { setTimeout(r, 1800); }).then(function () {
        return harvestSpecImages(p || {});
      }).then(function (res) {
        if (!res) return { ok: false, error: '没找到规格值' };
        var keys = Object.keys(res.map || {});
        if (!keys.length) return { ok: true, dim: res.dim, map: {}, n: 0 };
        return { ok: true, dim: res.dim, map: res.map, n: keys.length };
      });
    });

    // 详情类 mtop 接口才是可用的。采完把完整数据（含图集）回传，
    // 由 SW 带回发起采集的那个标签页。
    bus.on('bridge', 'collect-detail', function (p) {
      var id = (p && p.itemId) || currentItemId();
      if (!id) return { ok: false, error: '无商品 ID' };
      // 后台标签页「加载完成」不等于「内容渲染完成」——京东详情页是 SPA，
      // 刚 complete 时 DOM 里还是空的，立刻取会拿到空结果。等一拍再采。
      return new Promise(function (r) { setTimeout(r, 2500); }).then(function () {
        return fetchCardDetail(String(id));
      }).then(function (d) {
        return d ? { ok: true, detail: d } : { ok: false, error: '详情未取到' };
      });
    });
    bus.on('bridge', 'page-changed', function () {
      state.detail = null;
      clearCards();
      post('cards', { list: [], added: 0, updated: 0, total: 0 });
      return null;
    });
    bus.on('bridge', 'diagnose', function () {
      return buildDiagnose() || null;
    });
  }

  // 没有 postbus 时的旧通道（页面缓存了旧代码才会走到）
  window.addEventListener('message', function (e) {
    if (bus) return;   // 新通道已经在监听了，别重复处理
    if (e.source !== window) return;
    var msg = e.data;
    if (!msg || msg.source !== 'xy-bridge') return;
    if (msg.type === 'get-detail') {
      resolveDetail(!!msg.payload && msg.payload.force);
    } else if (msg.type === 'get-cards') {
      resolveCards();
    } else if (msg.type === 'ensure-cards') {
      ensureCardsDetail((msg.payload && msg.payload.ids) || []);
    } else if (msg.type === 'diagnose') {
      post('diagnose', buildDiagnose());
    }
  });

  // 页面首次加载完成时，若接口没抓到就走 DOM 兜底
  function boot() {
    // L1/L2 兜底：SSR 数据包和 React fiber 是 DOM 选择器全落空时
    // 唯一还能用的两条路（整店页那种纯 inline-style 裸卡片）
    var E = window.XYExtract;
    if (E && E.start) {
      try { E.start({ site: SITE }); } catch (e) {}
    }
    var id = currentItemId();
    setTimeout(function () {
      if (id) {
        if (!state.detail) {
          var d = domFallback();
          if (d) {
            state.detail = d;
            post('detail', d);
          }
        }
      } else {
        resolveCards();
      }
    }, 1500);

    // 淘宝/天猫店铺页的商品不会自己加载（实测滚动也不触发，DOM 里恒为 0 个），
    // 只有搜索页那种 SSR 才不用管。所以这里主动分页拉全店。
    if (SITE && SITE.shopApi && SITE.shopApi.api &&
        SITE.shopPageRe && SITE.shopPageRe.test(location.href)) {
      fetchShopItems().catch(function (e) {
        console.warn('[xy] 整店拉取失败：', e && e.message);
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // SPA 路由切换（搜索页 -> 详情页）时重置
  var lastHref = location.href;
  setInterval(function () {
    if (location.href !== lastHref && _isNavAway(location.href)) {
      lastHref = location.href;
      state.detail = null;
      clearCards();
      post('reset', null);
      setTimeout(boot, 300);
    }
  }, 800);

  // SPA 路由判断：进入商品详情 = 视为换页；其余（滚动、排序、筛选）保留商品池
  function _isNavAway(href) {
    if (!SITE || !SITE.pageIdRe) return false;
    if (SITE.pageIdRe.test(href)) return true;
    return false;
  }

  bindScanTriggers();
  setTimeout(runScan, 1200);

  // 供页面 console 调试。带版本号是为了能自动判断浏览器里的扩展
  // 是否已经换成本地最新的代码（tools/read-page.js 会读它）。
  window.__XY__ = {
    v: XYC.version,
    getDetail: function () { return state.detail; },
    getCards: function () { return cardList(); },
    getCardMap: function () { return cardMap; },
    scan: function () { return runScan(); },
    refresh: function () { return resolveDetail(true); }
  };
})();
