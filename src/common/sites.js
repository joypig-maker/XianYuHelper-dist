/**
 * 站点适配表
 *
 * 把「某个站点特有的知识」集中到一处，主体引擎（商品池 / 复选框 / 面板 /
 * 批量打包 / 落盘）完全不知道自己跑在哪个站点上。
 *
 * 站点知识分四类：
 *   1. 身份        hosts / idRe / itemUrl —— 怎么认出这是该站的商品
 *   2. 列表页 DOM  cardSel / field —— 怎么在页面上定位卡片、取字段
 *   3. 接口        apiRe / detailApi —— 怎么拦响应、怎么补详情
 *   4. 文案习惯    defaultDir / priceIsRange —— 目录名、价格形态的差别
 *
 * 新增一个站点 = 在这张表里加一项，通常不超过 40 行。
 */
(function (global) {
  'use strict';

  var S = {};

  /* ============================ 闲鱼 ============================ */

  S.xianyu = {
    key: 'xianyu',
    name: '闲鱼',
    hosts: ['goofish.com', 'xianyu.com'],

    // 商品 ID：既支持 /item?id=123 也支持 /item/123
    idRe: /[?&]id=(\d{5,20})|(?:^|\/)item\/(\d{5,20})/i,
    pageIdRe: /[?&]id=(\d{5,20})|\/item\/(\d{5,20})/i,
    itemUrl: function (id) { return 'https://www.goofish.com/item?id=' + id; },
    linkSel: function (id) { return 'a[href*="item?id=' + id + '"]'; },

    // 卡片容器。闲鱼的卡片是 <a> 直接包住整块，cardBox 推断就够用，
    // 所以这里留空，交给通用逻辑。
    cardSel: '',

    field: {
      title: ['[class*=title]', '[class*=Title]', 'h1', 'h2', 'h3', 'h4', '[class*=name]', '[class*=desc]'],
      price: ['[class*=price]', '[class*=Price]'],
      shop: ['[class*=userNick]', '[class*=sellerName]', '[class*=seller]', '[class*=shopName]', '[class*=userName]'],
      image: 'img'
    },

    // 接口拦截：只认闲鱼自己的 mtop 前缀，别把淘宝主站的接口混进来
    apiRe: /mtop\.taobao\.idle|mtop\.taobao\.idlemtopsearch|h5\/mtop\./i,

    // ⚠️ 详情接口**只在商品详情页的上下文里才通**（2026-10-17 CDP 实测）：
    //   在搜索页/店铺页调 mtop.taobao.idle.pc.detail → TIMEOUT::接口超时
    //   在商品详情页调同一个接口 → 正常返回（实测商品 844934128301 带 132 条 skuList）
    // 所以批量补详情必须借后台标签页打开详情页去拿，详见 fetchDetailViaTab。
    // 这条漏了会导致：列表页勾选批量打包时，多规格商品的规格表全丢，
    // 而且**没有任何报错**（用户只看到「没下载 sku」）。
    detailPageOnly: true,

    detailApi: {
      api: 'mtop.taobao.idle.pc.detail',
      v: '1.0',
      buildData: function (id) { return { itemId: String(id) }; }
    },

    // 详情页 DOM 兜底（interface 拿不到时）
    detailDom: {
      shopLinkRe: /personal\?userId=/i,
      descSel: '[class*="desc"],[class*="Desc"],[class*="detailContent"],[class*="content"]',
      titleStrip: [/[-_–]\s*闲鱼.*$/, /^\s*闲鱼\s*[-_–]\s*/],
      defaultTitles: ['闲鱼', '闲鱼 - 闲不住？上闲鱼！', '闲不住？上闲鱼！'],
      imgMinWidth: 200
    },

    defaultDir: '闲鱼采集',
    priceIsRange: false
  };

  /* ============================ 1688 ============================ */

  S.p1688 = {
    key: 'p1688',
    name: '1688',
    hosts: ['1688.com'],

    // 商品 ID（官方术语叫 offerId）
    //   https://detail.1688.com/offer/671812345678.html
    //   https://s.1688.com/selloffer/offer_view.htm?offerId=671812345678
    //   https://detail.m.1688.com/page/index.html?offerId=671812345678  ← 搜索结果页
    idRe: /(?:offer\/)(\d{6,20})|\bofferId=(\d{6,20})/i,
    pageIdRe: /(?:offer\/)(\d{6,20})|\bofferId=(\d{6,20})/i,
    itemUrl: function (id) { return 'https://detail.1688.com/offer/' + id + '.html'; },
    // 链接形态在 1688 上至少有两套，只认其中一种会直接让一类页面上的
    // 复选框全挂不上。实测（2026-09-27，关键词搜索页 s.1688.com/selloffer/offer_search.htm
    // 关键词「手机支架」）：15 件商品，卡片链接全是
    //   http://detail.m.1688.com/page/index.html?offerId=803347112456&...
    // 而 linkSel 只写了 a[href*="/offer/<id>"]，一条都匹配不到，
    // 于是 findCardEl 的三条路全断、页面上一个复选框都没有。
    // 两套形态必须一起认，否则「整店页能勾、搜索页不能勾」。
    linkSel: function (id) {
      return 'a[href*="/offer/' + id + '"],a[href*="offerId=' + id + '"]';
    },

    // 卡片容器优先用显式选择器：1688 的卡片有独立 class，
    // 比靠尺寸猜可靠得多（列表页顶部还有一堆 banner 图会被 cardBox 误判）。
    cardSel: '.sm-offer-item,[class*="offer-item"],[class*="OfferItem"],[data-offer-id]',

    field: {
      title: ['a.title', '[class*="offer-title"]', '.title', '[title]', '[class*="title"]'],
      price: ['.price', '[class*="price"]', '[class*="Price"]'],
      shop: ['[class*="company"]', '[class*="companyName"]', '[class*="shopName"]', '[class*="sellerName"]'],
      image: 'img'
    },

    apiRe: /1688\.com(?!.*\.(?:js|css|png|jpg|gif))|mtop\.1688|laputa\.1688|s\.1688\.com\/selloffer/i,

    // 店铺页的商品不走搜索接口，也不走 unifiedRenderData。
    // 实测（2026-09-27，店铺 shop3653158894s77.1688.com）：店铺页发起的是
    //   POST h5api.m.1688.com/h5/mtop.alisite.cbu.winport.sync.moduledata.get/1.0/
    //   data.offerModuleList: [ { id, subject, consignPrice, offerImages:[{imageURI}], ... } x10 ]
    // 之前配的 wp.m.1688.com/pc/render/unifiedRenderData 在店铺页上根本没被调用过，
    // 所以整店一直抓不到商品——不是解析写错，是接口名就是错的。
    // 注意商品 ID 字段叫 id、标题叫 subject、价格叫 consignPrice，
    // 都不匹配通用字段名，得靠 util.collectCards 的字段映射（见 CARD_LIST_PATHS）。
    // 返回壳不统一，可能是 JSON 也可能是渲染好的 HTML 片段，两条都试。
    // 实测（2026-09-27）：店铺首页走 moduledata.get，整店页（/page/offerlist.htm）
    // 走的是另一个接口 mtop.alibaba.alisite.cbu.server.moduleasyncservice，
    // 只有它返回真实的 offerList（offerCount=10）。前者在整店页上返回空 categories。
    shopApiRe: /moduledata|offerModuleList|shopItem|getShopOffer|shopPageData|moduleasyncservice/i,

    // 1688 的详情补录有三条路，按优先级尝试：
    //   jsonp  —— laputa 的 OfferDetailWidget 支持 callback，同源可直连
    //   jsonld —— 详情页内嵌 schema.org Product，字段最全但只能进详情页
    //   dom    —— 当前页本身就是详情页时，直接读 DOM
    detailApi: {
      api: 'laputa.1688.offer.detail',
      v: '1.0',
      buildData: function (id) { return { offerId: String(id) }; },
      jsonp: {
        url: function (id) {
          return 'https://laputa.1688.com/offer/ajax/OfferDetailWidget.do?offerId=' + id;
        }
      }
    },

    // 规格表专用接口（实测，非猜测）
    // 1688 的多规格信息不跟商品主数据走，而是单独放在 SKU 选择器接口里：
    //   POST https://h5api.m.1688.com/h5/mtop.1688.wosc.queryofferskuselectormodel/1.0/?...
    // 返回：
    //   data.skuSelectorBizModel.skuInfoMap   { 规格名: {discountPrice, canBookCount, skuId} }
    //   data.skuSelectorBizModel.skuProps     [{ prop:"颜色", value:[{name, imageUrl}] }]  ← 规格图在这
    //   data.skuSelectorBizModel.skuPriceScale
    //   data.originalSkuInfoMap               与 skuInfoMap 同内容的旧字段，不能优先取
    // 之前配置里写的 laputa.1688.offer.detail 并不是规格表来源，所以多 SKU 一直漏。
    //
    // 「业务参数」两个都不能少（2026-09-27 实测，逐组参数试出来的）：
    //   只给 offerId        -> FAIL_SYS_BIZPARAM_MISSED::缺少业务参数useCase
    //   补 useCase          -> FAIL_SYS_BIZPARAM_MISSED::缺少业务参数bizScene
    //   补 useCase+bizScene -> SUCCESS::调用成功，data 里就是 skuSelectorBizModel
    // 真实请求体（抓包 1688 详情页）是
    //   { offerId, useCase:"1688detail", bizScene:"pcod", urlParam:"actionType=dxOrder&sk=consign" }
    // 少了 useCase / bizScene 任意一个都是 100ms 内直接失败，
    // 而且失败得很"安静"——上层只会看到 skus 为空，
    // 所以表现为「没有 SKU 图、txt 里没有规格价格」，排查时很容易当成解析问题。
    skuApi: {
      api: 'mtop.1688.wosc.queryofferskuselectormodel',
      v: '1.0',
      buildData: function (id) {
        return {
          offerId: String(id),
          useCase: '1688detail',
          bizScene: 'pcod'
        };
      }
    },

    // 1688/淘宝的主图上限是 5 张，闲鱼却给到 9 个图位，
    // 剩下的只能从详情正文里补——那段是商家自己传的，往往十几张。
    // 注意这是**额外的一个请求**，所以只在主图补不满时才发（见 fetchDescImages），
    // 且失败必须静默：宁可少几张图，也不能让整个打包流程卡在这里。
    descApi: {
      jsonp: {
        url: function (id) {
          return 'https://laputa.1688.com/offer/ajax/OfferDescriptionWidget.do?offerId=' + id;
        }
      }
    },

    detailDom: {
      // 详情页的 schema.org 结构化数据，1688 每个商品页都带
      jsonLd: true,
      shopLinkRe: /shop\w*\.1688\.com|\/page\/shopshopfeature|\/page\/shop\b|\/shop\//i,
      descSel: '[class*="desc"],[class*="Desc"],[class*="detail-content"],[class*="content"]',
      titleStrip: [],
      defaultTitles: [],
      imgMinWidth: 200
    },

    // 页面内嵌的完整数据（实测 2026-09）
    // 详情页把整个商品数据挂在 window.context 上，规格表就在里面：
    //   window.context.result.data.Root.fields.dataJson.skuModel
    //   { skuProps:[{prop:"颜色", value:[{name:"【6格】CD支架", imageUrl:"..."}]}],
    //     skuInfoMap:{ "【6格】CD支架":{discountPrice:"3.00", canBookCount:29861, skuId:...} },
    //     skuPriceScale:"3.00-4.00" }
    // 数值取自实测样本 dist/laputa-sku-sample.json，别手改成别的价。
    // 批量补详情时接口不一定给规格表，而当前页恰好就是这个商品详情页时，
    // 直接从这里取最可靠，也不会多发请求触发风控。
    embedded: {
      global: 'context',
      paths: ['result', 'data', 'Root', 'fields', 'dataJson'],
      // 必须能确认是同一个商品，否则会把 A 的规格安到 B 头上
      idPaths: ['result.global.globalData.model.offerDetail.offerId', 'result.data.gallery.fields.offerId']
    },

    // 店铺页：1688 找货源的主战场，进店抓全店商品
    //
    // 实测（2026-09）：店铺域名是「shop」+ 随机字母数字串，
    //   shop3g5365975f5y2.1688.com / shop289586509g3k1.1688.com
    // 不是 shop123.1688.com 这种纯数字。早期写成 /^shop\d*\.1688\.com/
    // 匹配不到真实店铺，整店模式直接失效——这是"整店加载不出商品"的首因。
    // 路径也没有固定形态：根路径就是店铺首页，/page/xxx.html 是子页。
    shopPage: {
      hostRe: /^shop[\w.-]*\.1688\.com/i,
      urlRe: /^\/?$|^\/?\?|shopId=\d+|\/page\//i,
      nameSel: ['[class*="shopName"]', '[class*="company"]', '[class*="shop-name"]', '.shopName']
    },

    defaultDir: '1688采集',
    // 批发价常写成 "18.90-25.00"，取下限
    priceIsRange: true
  };

  /* ============================ 淘宝 / 天猫 ============================ */

  // 全部选择器与接口均来自 2026-09-28 的真机实测（Chrome 154，已登录态），
  // 诊断脚本见 tools/diag-tb-*.js，抓包样本在 dist/_dts/。
  S.taobao = {
    key: 'taobao',
    name: '淘宝',
    hosts: ['taobao.com', 'tmall.com', 'tmall.hk', 'jiyoujia.com', 'liangxinyao.com', 'fliggy.com'],

    // 商品 ID：详情页 URL 的 id 参数
    //   https://item.taobao.com/item.htm?id=669745626548
    //   https://detail.tmall.com/item.htm?id=669745626548
    idRe: /[?&]id=(\d{6,20})|item\.htm\?id=(\d{6,20})/i,
    pageIdRe: /[?&]id=(\d{6,20})/i,
    itemUrl: function (id) { return 'https://item.taobao.com/item.htm?id=' + id; },

    // 搜索页的卡片里**没有商品链接**——a[href] 全是 click.simba.taobao.com
    // （广告跳转）或店铺链接，靠 href 正则一个 ID 都抠不出来。
    // 商品 ID 只挂在卡片容器的 data-spm-act-id 上（实测等于商品 ID）。
    idFrom: function (el) {
      var cur = el;
      for (var i = 0; cur && i < 5; i++) {
        if (cur.getAttribute) {
          var v = cur.getAttribute('data-spm-act-id');
          if (v && /^\d{6,20}$/.test(String(v).trim())) return String(v).trim();
        }
        cur = cur.parentElement;
      }
      return '';
    },

    // 卡片外层是 doubleCardWrapperAdapt--<hash>，它挂着 data-spm-act-id。
    // 内层 doubleCard--<hash> 是同一件的另一层，去重靠 add() 的 seen 兜住。
    linkSel: function (id) {
      return '[data-spm-act-id="' + id + '"]';
    },
    cardSel: '[class*="doubleCardWrapper"],[class*="doubleCard--"]',

    field: {
      title: ['[class*="title--"]', '[class*="Title--"]'],
      // 价格被拆成整数/小数两个兄弟节点（priceInt「22」+ priceFloat「.01」），
      // 取包住这两段的父节点才能拼出完整值；直接取 priceInt 会丢小数。
      price: ['[class*="innerPriceWrapper"]', '[class*="priceInt"]', '[class*="Price--"]'],
      shop: ['[class*="shopNameText"]', '[class*="shopName"]'],
      image: 'img[class*="mainPic"],img[class*="mainImg"]'
    },

    // 搜索/店铺列表相关接口 + 详情接口，命中任一个就值得跑一次合并
    apiRe: /mtop\.taobao\.(?:shop\.simple|detail|pcdetail|wsearch)|h5api\.m\.(?:taobao|tmall)\.com/i,

    // 整店页（新版 store.taobao.com/category.htm 与旧版 shop<id>.taobao.com/search.htm
    // 实测都会 302 到品牌域名，最终是同一套 SPA + 同一个接口）。
    //
    // 重要：这个页面的商品**不会自动加载**（滚动也不触发，DOM 里商品数恒为 0），
    // 所以必须我们自己主动分页拉。shopId / sellerId 页面 URL 里没有，
    // 但整页 HTML 里带（正则能稳定取到）。
    shopApi: {
      api: 'mtop.taobao.shop.simple.item.fetch',
      v: '1.0',
      host: 'h5api.m.<site>',
      buildData: function (shopId, sellerId, page) {
        return {
          page: page || 1,
          orderType: 'popular',
          sortType: '',
          catId: 0,
          keyword: '',
          filterType: '',
          feature: '{}',
          shopId: String(shopId),
          sellerId: String(sellerId)
        };
      },
      // 店铺上下文：shopId / sellerId 从整页 HTML 里抠
      idFromHtml: [
        /"shopId"\s*:\s*"?(\d+)"?/,
        /"sellerId"\s*:\s*"?(\d+)"?/
      ]
    },

    // 店铺页判定。新旧两套入口实测都会归一到品牌域名：
    //   store.taobao.com/category.htm?appUid=... → minwai.tmall.com/category.htm
    //   shop375415709.taobao.com/search.htm      → minwai.tmall.com/search.htm
    // 所以不必分版本处理，认路径特征即可。
    shopPageRe: /store\.taobao\.com|\/category\.htm|\/search\.htm|\/category-|shop[\w-]*\.(?:taobao|tmall)\.com/i,

    // 店铺页的字段锚点（响应结构见 dist/_dts/shop-fetch-*.txt）
    shopField: {
      id: ['itemId'],
      title: ['title'],
      image: ['image'],
      // 列表接口的价格是加密串（priceEncoded: true，形如 [1_7ij1w4tp#51#<base64>#]），
      // 拿不到明文，价格一律由详情补录负责，这里只记标记。
      price: [],
      sales: ['vagueSold365']
    },

    // 详情接口只认详情页上下文——在搜索页/店铺页调它们一律超时。
    //
    // 实测（同一页对照，排除风控与未登录）：
    //   mtop.user.getusersimple   ✅ 秒通
    //   shop.simple.item.fetch    ✅ 秒通
    //   pcdetail.data.get         ❌ 超时
    //   detail.getdetail          ❌ 超时
    //   detail.getdesc            ❌ 超时
    // 补 exParams（domain / path_name / pcSource 全带上）无效；
    // 用 CDP 把请求的 Referer / Origin 改写成详情页也无效。
    // 服务端只认真实详情页，绕不过去——所以补详情要借一个后台标签页
    // （见 service_worker.js 的 xy:bg-detail）。
    detailPageOnly: true,
    detailPageRe: /item\.htm|\/item\//i,

    // 详情主接口：给 5 张完整主图 + 明文价格 + SKU。
    //
    // 注意接口名是 **data.get** 不是 data.adjust。抓包时看到的 adjust 是
    // 页面在已有 SSR 基准数据之后请求的「增量」，单独调用它返回 SUCCESS 但 data 是空的
    // （实测：{ret:["SUCCESS::调用成功"], data:{}}），照它写会一路「有响应却解析全空」。
    // 实测 mtop.taobao.pcdetail.data.get v1.0，参数只要 {id, detail_v}，
    // 不需要 exParams 那一长串。
    detailApi: {
      api: 'mtop.taobao.pcdetail.data.get',
      v: '1.0',
      buildData: function (id) {
        return { id: String(id), detail_v: '3.3.2' };
      }
    },

    // 详情图（正文）：pcDescContent 是一段 HTML，里面直接是 22 个 <img>。
    // **必须用 v6.0** —— v7.0 只有页面自己带全套参数时才通，我们主动调返回 null。
    // skuId 实测可省（带与不带返回完全一致），批量补录时拿不到也无妨。
    descApi: {
      api: 'mtop.taobao.detail.getdesc',
      v: '6.0',
      buildData: function (id) {
        return { id: String(id), detail_v: '3.3.0', preferWireless: 'true' };
      }
    },

    // 详情数据落点（实测自 tools/diag-tb-detailshape.js）
    //   5 张主图  data.item.images（componentsVO.headImageVO.images 是同一份副本）
    //   到手价    data.skuCore.sku2info.0.subPrice.priceText（4.01）
    //   原价      data.skuCore.sku2info.0.price.priceText（5.01）
    detailPaths: {
      images: ['item.images', 'componentsVO.headImageVO.images'],
      price: [
        'skuCore.sku2info.0.subPrice.priceText',
        'skuCore.sku2info.0.price.priceText'
      ],
      title: ['item.title'],
      sales: ['item.vagueSellCount']
    },

    detailDom: {
      shopLinkRe: /shop\.taobao\.com|tmall\.com\/shop/i,
      descSel: '[class*="desc"],[class*="Desc"],[class*="detail-content"]',
      titleStrip: [],
      defaultTitles: [],
      imgMinWidth: 200
    },

    // 主图上限就是 5 张，凑不满 9 个图位时用详情图补
    mainImageTarget: 5,

    defaultDir: '淘宝采集',
    priceIsRange: true
  };

  /* ============================ 京东 ============================ */

  // 实测（2026-09-28，登录态）：
  //   搜索页 search.jd.com/Search?keyword=x —— SSR，[data-sku] 首屏 30 个。
  //     类名是 CSS Modules（_wrapper_1y1ag_3 这种，hash 随版本变），
  //     所以选择器一律 [class*=] 前缀匹配。
  //   **卡片里没有商品直链**：a[href] 只有 //chat.jd.com 客服链接，
  //     商品 ID 只能从卡片的 data-sku 取——和淘宝搜索页同一个坑。
  //   详情页 item.jd.com/<sku>.html —— 新版 SPA，.sku-name/.p-price 这些
  //     经典选择器全失效（只有 [class*="price"] 还能拿到 ¥28.23）。
  //   店铺页 mall.jd.com/index-<venderId>.html —— 只有店铺装修的图片热区，
  //     没配「全部商品」模块的店铺不会有商品列表（小米自营实测就是这样，
  //     抓包也证实没有任何商品列表接口）。
  //   另外：京东的搜索页和详情页**都强制登录**，未登录直接 302 到 passport。
  S.jd = {
    key: 'jd',
    name: '京东',
    hosts: ['jd.com', 'jd.hk', 'jingdonghealth.cn', 'jkcsjd.com', 'yiyaojd.com'],
    enabled: true,

    idRe: /item\.jd\.com\/(\d{6,20})\.html|item\.jd\.hk\/(\d{6,20})\.html/i,
    pageIdRe: /item\.jd\.com\/(\d{6,20})\.html|item\.jd\.hk\/(\d{6,20})\.html/i,
    itemUrl: function (id) { return 'https://item.jd.com/' + id + '.html'; },

    // 商品 ID 有两个来源，两套页面各用一个，漏掉任何一套都会「一类页面一件都采不到」：
    //
    //   搜索页 search.jd.com   —— 卡片的 <a> 全是客服链接（//chat.jd.com/index.action?pid=<sku>），
    //                              没有商品直链，ID 只挂在卡片的 data-sku 上
    //   店铺页 mall.jd.com/view_search-*  —— 卡片是 li.gl-item，**里面有直链**
    //                              //item.jd.com/<id>.html（实测一页 20 件、共 60 个链接），
    //                              这种页面反而一个 data-sku 都取不满（实测只有 4~8 个）
    //
    // 顺序要紧：先认传进来的 href（店铺页的 <a> 走这条），再往上找 data-sku（搜索页走这条）。
    idFrom: function (el, href) {
      if (href) {
        var hm = String(href).match(/item\.jd\.com\/(\d{6,20})/i);
        if (hm) return hm[1];
      }
      if (!el) return '';

      // 1) 自身或祖先上挂着 data-sku
      var cur = el;
      for (var i = 0; cur && i < 5; i++) {
        if (cur.getAttribute) {
          var v = cur.getAttribute('data-sku');
          if (v && /^\d{6,20}$/.test(String(v).trim())) return String(v).trim();
        }
        cur = cur.parentElement;
      }

      // 2) 卡片内部的商品直链（店铺页）
      var scope = el;
      try {
        if (el.closest) scope = el.closest('.gl-item') || el;
      } catch (e) { scope = el; }
      var a = null;
      try {
        a = (scope.querySelector && scope.querySelector('a[href*="item.jd.com/"]')) ||
          (el.querySelector && el.querySelector('a[href*="item.jd.com/"]')) || null;
      } catch (e) { a = null; }
      if (a) {
        var am = String(a.getAttribute('href') || '').match(/item\.jd\.com\/(\d{6,20})/i);
        if (am) return am[1];
      }
      return '';
    },

    linkSel: function (id) {
      return '[data-sku="' + id + '"],a[href*="item.jd.com/' + id + '.html"]';
    },

    // 搜索页：[data-sku]；店铺页「所有商品」：li.gl-item（京东的老版经典类名，
    // 不是 CSS Modules 的 hash 名，所以可以写全名，不用 [class*=] 前缀匹配）
    cardSel: '[data-sku], li.gl-item',

    field: {
      // 京东店铺页有**多套模板**，同一家店不同入口用的模板就不一样 ——
      // 实测：分类页 view_search-991882-8441300-99-... 是装修模板
      //       （.jPic / .jDesc / .jPrice>.jdPrice>.jRmb+.jdNum），
      //       而「所有商品」页 view_search-991882-0-99-... 拿不到价格，
      //       说明它不是这套。候选选择器全部并列，取不到的自然跳过。
      title: [
        '[class*="title_container"]', '[class*="goods_title"]',   // 搜索页（CSS Modules）
        '.jDesc a',                                               // 店铺页·装修模板
        '[class*="p-name"] a', '.p-name a'                        // 店铺页·老搜索模板
      ],
      // 价格被拆成相邻节点，取包住它们的那层：
      //   搜索页        [class*="_price_"]   → 「¥28.23」
      //   店铺·装修模板  .jdPrice             → 「￥64.30」（￥ 在 .jRmb，数值在 .jdNum）
      //   店铺·老模板    .p-price             → 「￥64.30」（<strong><i>￥</i><em>64.30</em></strong>）
      //
      // 这里**不要**收 [class*="price"] 这类泛匹配：cardPrice 只做
      // 「长度<=30 + 能解析成数字」两项检查，命中 .price-promo（「满199减20」）
      // 这种促销节点会解析出 19920 并且一路写进文案和目录名 —— 宁可取不到，不可取错。
      price: ['[class*="_price_"]', '.jdPrice', '.jPrice', '.p-price'],
      // 店铺页卡片里没有店名（整店页所有商品同属一家店），只能拿到搜索页的
      shop: ['[class*="_limit_"]', '[class*="_name_"]'],
      // cardImage 拿到的是「一个选择器字符串」（直接喂 querySelectorAll），
      // 不像 title/price 那样是候选数组，所以多套模板要写成逗号选择器
      image: 'img[class*="_img_"], .jPic img, .p-img img'
    },

    apiRe: /api\.m\.jd\.com|mall\.jd\.com\/view|search\.jd\.com/i,

    // 详情只在详情页拿得到——搜索页里没有详情数据，
    // 而京东详情页是 SPA，得等它渲染完。补详情时借后台标签页（既有机制）。
    detailPageOnly: true,
    detailPageRe: /item\.jd\.com\/\d+|item\.jd\.hk\/\d+|\/item\/\d+/i,

    detailDom: {
      shopLinkRe: /mall\.jd\.com|shop\.jd\.com/i,
      // 主图：新版详情页的缩略图轮播（实测 10 张，URL 里尺寸是 228）。
      // 必须精确指定——详情页光 img 就有 160+ 张，评论图、推荐位全在里面，
      // 全页扫会把它们一起当主图。
      mainImgSel: '[class*="image-carousel"] [class*="item"] img, img.image',
      // 详情描述图：详情区容器（实测 30+ 张 790px 宽的长图）
      descImgSel: '[class*="preview-wrap"] img, [class*="page-content-left"] img',
      descSel: '[class*="preview-wrap"],[class*="parameter"]',
      titleStrip: [/【行情[^】]*】?$/],
      defaultTitles: [],
      imgMinWidth: 200,
      descImgMinWidth: 400
    },

    // 京东把图片尺寸写在 URL 里，两套路径要用两种规则：
    //
    //   详情页 pcpubliccms：.../pcpubliccms/s228x228_jfs/t1/...jpg.avif
    //      缩略图只有 6KB 且是 AVIF；换成 s800x800_ 是 94KB 的 JPEG
    //      （实测 s1440x1440 有 229KB —— 800 够铺货用，流量省一半多）
    //
    //   店铺/搜索列表：.../img10.360buyimg.com/n7/jfs/t1/...jpg
    //      实测各档位真实像素（读文件头量的，不是猜）：
    //          n0  800x800  314KB   ← 原图，用这个
    //          n1  350x350   48KB      尺寸不够铺货
    //          n2  160x160   13KB
    //          n7  220x220   17KB   ← 页面给的列表缩略图
    //          n12 800x800  312KB   ← 也是原图，与 n0 等价
    //      注意 s800x800_ 只对 pcpubliccms 生效，套到列表图上是 400。
    //      升到 n0 后正好和详情页同为 800x800，两处来源的图规格一致。
    imageUpgrade: function (url) {
      var s = String(url);
      s = s.replace(/\/(s\d+x\d+)_/, '/s800x800_');
      // 尺寸段**紧跟在域名后面**（img10.360buyimg.com/n7/jfs/...），
      // 所以锚定域名再替换。写成裸的 /\/n\d{1,2}\// 会误伤路径中间偶然出现的
      // n1/n2 段（如 /jfs/t1/n1/xxx.jpg），把好好的图改成另一张。
      s = s.replace(/(360buyimg\.com\/)n\d{1,2}\//, '$1n0/');
      return s;
    },

    /* ---- 京东店铺页（整店）----------------------------------------------
     * 入口形如 https://mall.jd.com/view_search-991882-0-99-1-20-1.html
     *   · 段1 = 店铺的 appId，**既不是 shopId 也不是 venderId**
     *     （罗蒙：appId=991882 / shopId=774716 / venderId=778749）
     *     只能从店铺首页里那些「商品分类」链接抓 —— 见 injected 的店铺页处理
     *   · 段2 = 分类 ID，传 0 即「全部商品不筛选」（实测共 2935 件 / 147 页）
     *   · 段3 = 99、段5 = 20（每页条数）、段6 = 1 固定
     *   · 段4 看着像页码，但实测改成 2 返回的仍是第 1 页同一批商品，
     *     翻页是页面自己用 JSONP 做的
     *     （module-jshop.jd.com/module/allGoods/goods.html?...&pageNo=2）
     *     所以我们不自己翻页，采当前页 —— 用户在页面上翻，翻到哪采到哪。
     * ------------------------------------------------------------------- */
    shopPageRe: /mall\.jd\.com\/view_search-|mall\.jd\.com\/index-/i,
    shopIndexRe: /mall\.jd\.com\/index-(\d{5,12})\.html/i,
    shopAppIdRe: /view_search-(\d{5,12})-/i,

    // 从任意页面内容里揪出 appId —— 店铺首页的「商品分类」链接长这样：
    //   //mall.jd.com/view_search-4779926-1021895104-99-1-20-1.html
    shopAppIdIn: function (text) {
      var m = String(text || '').match(/view_search-(\d{5,12})-/);
      return m ? m[1] : '';
    },

    // 「所有商品」页地址（分类传 0 = 全店）
    allGoodsUrl: function (appId) {
      return 'https://mall.jd.com/view_search-' + appId + '-0-99-1-20-1.html';
    },

    defaultDir: '京东采集',
    priceIsRange: false
  };

  /* ============================ 查找 ============================ */

  var ORDER = ['p1688', 'xianyu', 'taobao', 'jd'];

  // 命中即返回，不管启用与否。
  // 未启用的站点照样要能被认出来——否则用户打开淘宝页面时插件完全静默，
  // 既没面板也没提示，只会让人以为插件坏了。
  S.match = function (host) {
    host = String(host || '').toLowerCase();
    for (var i = 0; i < ORDER.length; i++) {
      var s = S[ORDER[i]];
      if (!s) continue;
      for (var j = 0; j < s.hosts.length; j++) {
        var h = s.hosts[j];
        // 精确匹配，或者作为**子域后缀**匹配。
        // 别写成 host.indexOf('.' + h) > -1 —— 那会把 jd.com.evil.com 也认成京东。
        if (host === h || host.slice(-(h.length + 1)) === '.' + h) return s;
      }
    }
    return null;
  };

  // 只要已启用的站点，未启用返回 null
  S.active = function (host) {
    var s = S.match(host);
    return (s && s.enabled !== false) ? s : null;
  };

  S.get = function (key) {
    if (!key) return null;
    return S[key] || null;
  };

  // 从 location 对象里取主机名。
  // 别指望每个运行环境都把 location 字段给全——拿不到就退回去解析 href，
  // 否则一处字段缺失就会让整个插件在该站点上"凭空消失"。
  function hostOf(loc) {
    var l = loc || (typeof location !== 'undefined' ? location : null);
    if (!l) return '';
    if (l.host) return String(l.host);
    var m = String(l.href || '').match(/^https?:\/\/([^/?#]+)/i);
    if (m) return m[1];
    if (l.hostname) return String(l.hostname);
    return '';
  }

  // 当前页面命中的站点；没命中返回 null（插件在本站不工作）
  S.current = function (loc) {
    return S.active(hostOf(loc));
  };

  // 命中但没启用时，用来给用户一句明确答复
  S.inactive = function (loc) {
    var s = S.match(hostOf(loc));
    return (s && s.enabled === false) ? s : null;
  };

  global.XYSites = S;
})(typeof window !== 'undefined' ? window : globalThis);
