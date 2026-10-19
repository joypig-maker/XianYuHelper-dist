/**
 * 公共工具库
 * 同时运行在三个环境：
 *   1. 页面 MAIN world（作为 content script 注入）
 *   2. 插件 ISOLATED world（content script）
 *   3. background service worker（importScripts 加载）
 * 因此不能依赖 window / document，统一用 global 兜底。
 */
(function (global) {
  'use strict';

  var U = {};

  /* ---------------- 基础文本处理 ---------------- */

  // Windows / macOS 文件名非法字符清理
  U.cleanFileName = function (name, maxLen) {
    var s = String(name == null ? '' : name)
      .replace(/[\\/:*?"<>|\r\n\t]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/^\.+/, '')
      .trim();
    if (!s) s = '未命名';
    if (maxLen && s.length > maxLen) s = s.slice(0, maxLen);
    return s;
  };

  U.trimText = function (s, maxLen) {
    s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    if (maxLen && s.length > maxLen) s = s.slice(0, maxLen) + '…';
    return s;
  };

  /**
   * 规格值安全文件名。对接规范 §2：
   *   非法字符 \ / : * ? " < > |  →  _   （**替换**不是删除）
   *   截断 40 字，空则用「规格」
   *
   * 为什么不复用 cleanFileName：那个是把非法字符**删掉**、兜底「未命名」。
   * `红/蓝` 删完是 `红蓝`，规范要的是 `红_蓝`——分隔符没了就没法一眼看出
   * 原来是个两段值。这里刻意独立一份，免得动到主图/目录名的既有行为。
   */
  U.sanitizeSpecName = function (name, maxLen) {
    var s = String(name == null ? '' : name)
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/[\r\n\t]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^\.+/, '')
      .trim();
    if (!s) s = '规格';
    if (maxLen && s.length > maxLen) s = s.slice(0, maxLen).trim();
    return s || '规格';
  };

  // 价格规范化：兼容 "123.00" / "¥123" / 123
  // 注意：闲鱼接口的价格单位是「元」，这里不做任何单位换算（避免 100 倍误差）。
  // 如后续发现某个接口返回「分」，可在调用处显式除以 100。
  /**
   * 判断价格串是不是"区间价"（"3.00-4.00"、"¥18 ~ ¥21"）。
   * 1688 列表页把 skuPriceScale 直接显示成区间价，所以
   * "价格是区间"基本等于"这商品有多规格"——这是列表页上
   * 唯一不用多发一次请求就能拿到多规格线索的地方。
   * 只认"后面的数比前面的大"，避免把负号、日期之类的东西误判成区间。
   */
  U.isRangePrice = function (p) {
    if (p == null) return false;
    // 前面可能带货币符号（闲鱼/淘宝会写 "¥18 ~ ¥21"），允许但不必需
    var m = String(p).match(/[¥￥$]?\s*(\d+(?:\.\d+)?)\s*[-~—－~]\s*[¥￥$]?\s*(\d+(?:\.\d+)?)/);
    if (!m) return false;
    return Number(m[2]) > Number(m[1]);
  };

  U.formatPrice = function (v) {
    if (v == null || v === '') return '';
    var s = String(v).trim();
    var n = Number(s.replace(/[^\d.]/g, ''));
    if (!isFinite(n)) return s;
    // 上限保护：淘宝店铺接口的加密价串（[1_7ij1w4tp#51#…]）被上面那句
    // 抽干数字之后会变成 1.7145190993087112e+22 这种科学计数法垃圾，
    // isFinite 也拦不住，最后被当成价格写进文案和目录名。
    // 没有任何商品是真·上亿的，超过就判为脏数据，宁可留空。
    if (n >= 1e8) return '';
    if (Math.floor(n) === n) return String(n);
    return n.toFixed(2);
  };

  /* ---------------- 图片 URL 处理 ---------------- */

  /**
   * 规范化图片地址
   *  - 补协议 //img.alicdn.com -> https://img.alicdn.com
   *  - 去掉压缩尺寸参数，尽量取原图
   *    //img.alicdn.com/xxx.jpg_400x400q90.jpg  -> //img.alicdn.com/xxx.jpg
   *    //img.alicdn.com/xxx.jpg_.webp           -> //img.alicdn.com/xxx.jpg
   */
  U.normalizeImageUrl = function (url, toOrigin) {
    if (!url || typeof url !== 'string') return '';
    var u = url.trim();
    if (u.indexOf('//') === 0) u = 'https:' + u;
    // 闲鱼的 imageInfos / propertyImage 给的是 **http://** 开头
    // （实测商品 844934128301：propertyImage.url = http://img.alicdn.com/...）。
    // 而扩展只授权了 https 域名，http 的图 downloads.download 会静默失败——
    // 表现为「规格读出来了，但一张图都没下」。这里统一升到 https，
    // Alicdn 两种协议都能正常访问。
    if (/^http:\/\//i.test(u)) u = 'https://' + u.slice(7);
    // 1688 店铺接口给的是 `img/ibank/xxx.jpg` 这种裸相对路径，
    // 少了一整段域名，不补就是张坏图（实测缺的正是 cbu01.alicdn.com）。
    if (/^(?:img|imgextra)\//i.test(u) && !/^https?:/i.test(u)) {
      u = 'https://cbu01.alicdn.com/' + u;
    }
    if (toOrigin === false) return u;
    // 去掉 OSS 图片处理后缀
    u = u.replace(/_\d+x\d+(q\d+)?\.(jpg|jpeg|png|webp)$/i, '');
    u = u.replace(/_\.(webp|jpg|jpeg|png)$/i, '');
    u = u.replace(/\.(jpg|jpeg|png)_\d+x\d+(q\d+)?\.(jpg|jpeg|png|webp)$/i, '.$1');
    // 京东图床会按浏览器的 Accept 协商成 AVIF，地址变成 .../xxx.jpg.avif。
    // 不剥掉的话，文件名按 .jpg 走、内容却是 AVIF —— 铺货软件一张都读不出来
    // （实测：同一 URL 去掉 .avif 后返回 image/jpeg，27907B vs 30981B）。
    // 只剥「双层」形态（.jpg.avif），单层 .avif 不敢动，剥了可能就 404 了。
    u = u.replace(/\.(jpg|jpeg|png|webp|gif|bmp)\.avif$/i, '.$1');
    return u;
  };

  /**
   * 图片指纹：抹掉协议 / CDN 域名 / 尺寸后缀之后的可比形态。
   *
   * 1688 整店页的商品图带尺寸后缀，接口给的裸 imageURI 不带：
   *   接口  img/ibank/O1CN…!!…-0-cib.jpg
   *   DOM   //cbu01.alicdn.com/img/ibank/O1CN…!!…-0-cib.310x310.jpg
   * 直接比 URL 永远比不上，去后缀后两者同构（实测 2026-09-27）。
   *
   * 卡片定位只能靠它：整店页的商品卡片是纯 inline-style div，
   * 无 class / id / data-* / href / onclick，页面上唯一的线索就是主图。
   */
  U.imageFingerprint = function (url) {
    var u = String(url == null ? '' : url).trim();
    if (!u) return '';
    u = u.replace(/^https?:\/\//i, '').replace(/^\/\//, '');
    // 斜杠只能选不能必：接口给的是裸 `img/ibank/…`（前面没有斜杠），
    // DOM 给的是 `//cbu01.alicdn.com/img/ibank/…`。写成必选会漏掉前者。
    var m = u.match(/[/]?img\/(?:ibank|imgextra|baoliaosm)\/([^?#]+)$/i);
    if (m) return '/img/' + cutCdnSuffix(m[1]).toLowerCase();
    return stripImageSuffixes(u.split('?')[0].split('#')[0]).toLowerCase();
  };

  /**
   * 1688 的 ibank 图上，`…!!<图号>-0-cib` 之后剩下的全是 CDN 变体后缀，
   * 而且不止一段（`.jpg_460x460q100.jpg_.webp` 这种）。截到 -cib 为止，
   * 比逐段猜后缀可靠——猜会漏，截不会错。
   */
  function cutCdnSuffix(seg) {
    var m = String(seg).match(/^(.*?-\w+-cib)/i);
    return m ? m[1] : stripImageSuffixes(seg);
  }

  /**
   * 剥掉图片后缀，只留稳定的「图号」。
   *
   * 后缀形态不是一套，而是一串，单次替换剥不干净。1688 搜索页实测：
   *   DOM:  O1CN…_!!2217964505482-0-cib.jpg_460x460q100.jpg_.webp
   *   接口: img/ibank/O1CN…_!!2217964505482-0-cib.jpg
   * 单一 replace 会留下 `_460x460q100.jpg_` 这种残渣，两边指纹对不上，
   * 图反查那条定位路就等于废了。所以反复剥离到不再变化为止。
   */
  function stripImageSuffixes(s) {
    var prev;
    do {
      prev = s;
      s = String(s)
        .replace(/\.(?:jpg|jpeg|png|webp|gif)$/i, '')
        .replace(/_\.(?:jpg|jpeg|png|webp|gif)$/i, '')
        .replace(/_\d+x\d+(?:q\d+)?$/i, '')
        .replace(/\.\d+x\d+$/i, '');
    } while (s !== prev);
    return s;
  }

  /**
   * 视频地址规范化。
   * 1688 详情页的 <video src> 是 protocol-relative：
   *   //cloud.video.taobao.com/play/u/.../401098362651705.mp4
   * 不补协议就是一张坏链接。只认 http(s) 结尾，其余（data:、blob:）一律丢弃。
   *
   * @param {string} url
   * @param {boolean} [keepQuery] 保留 ?auth_key=... 这类签名参数。
   *   **下载时必须传 true**：阿里云 OSS 的视频地址带签名，剥掉查询串会直接 403。
   *   默认 false 是因为去重/比对时希望地址干净（两个不同签名其实是同一个视频）。
   */
  U.normalizeVideoUrl = function (url, keepQuery) {
    var u = String(url == null ? '' : url).trim();
    if (!u) return '';
    if (u.indexOf('//') === 0) u = 'https:' + u;
    // 扩展名只看 pathname —— 带查询串时 a.mp4?t=1 也得认出是 mp4
    var path = u.split('?')[0].split('#')[0];
    if (!keepQuery) u = path;
    else u = u.split('#')[0];
    if (!/^https?:\/\//i.test(u)) return '';
    return /\.mp4$|\.m3u8$|\.mov$|\.webm$/i.test(path) ? u : '';
  };

  /**
   * 从详情接口响应里提取视频地址。
   *
   * 为什么不能只靠 DOM 的 <video src>：
   *   · 接口分支（source='api'）拿不到 DOM，只能靠这里；
   *   · 而且很多站的 <video> 是懒加载的，进详情页第一眼 src 还是空的，
   *     但接口响应里已经带了完整地址。
   *
   * 各站实测字段：
   *   1688   offerVideo / videoList[].videoUrl / offerVideoInfo.videoUrl
   *   淘宝   videos[].videoUrl、itemVideos[].url、detailData.videos[].url
   *   闲鱼   itemDO.videoInfo.videoList[].videoUrl、videoInfo.playUrl
   *
   * 只收 http(s) 且带视频扩展名的；对象型字段一律深搜字符串再筛，
   * 宁可漏掉也不能把一坨 JSON 当地址塞给 downloads。
   *
   * @returns {Array<{url, duration, cover}>} 最多 MAX_VIDEOS 个
   */
  var MAX_VIDEOS = 5;

  U.pickVideos = function (data) {
    var out = [];
    var seen = {};

    function push(rawUrl, duration, cover) {
      var u = U.normalizeVideoUrl(rawUrl);
      if (!u || seen[u]) return;
      seen[u] = 1;
      out.push({
        url: u,
        duration: duration != null && duration !== '' ? String(duration) : '',
        cover: U.normalizeImageUrl(cover || '')
      });
    }

    // 深搜：递归找所有像视频地址的字符串。
    // 代价是对大响应慢，所以限深度 + 限扫描节点数，避免在巨型商品详情上卡死。
    var scanned = 0;
    function walk(node, depth) {
      if (!node || depth > 6 || out.length >= MAX_VIDEOS) return;
      if (++scanned > 4000) return;
      if (typeof node === 'string') {
        push(node);
        return;
      }
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length && i < 60; i++) walk(node[i], depth + 1);
        return;
      }
      if (typeof node !== 'object') return;
      // 带时长/封面的对象单独处理，拿得到就一起带上
      var dur = node.duration != null ? node.duration
        : (node.videoLength != null ? node.videoLength
          : (node.length != null && /^\d+(\.\d+)?$/.test(String(node.length)) ? node.length : ''));
      var cov = node.coverUrl || node.picUrl || node.cover || node.poster || node.thumbnail || '';
      var direct = node.videoUrl || node.playUrl || node.url || node.src || node.video || '';
      if (direct) {
        push(direct, dur, cov);
        return;                        // 命中就不再往里深挖同一个对象
      }
      for (var k in node) {
        if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
        walk(node[k], depth + 1);
      }
    }

    try {
      walk(data, 0);
    } catch (e) {}

    // m3u8 排在 mp4 后面：能直接下 mp4 就别去合并分片
    out.sort(function (a, b) {
      var am = /\.m3u8$/i.test(a.url) ? 1 : 0;
      var bm = /\.m3u8$/i.test(b.url) ? 1 : 0;
      return am - bm;
    });
    return out.slice(0, MAX_VIDEOS);
  };

  /**
   * m3u8 播放列表解析（只支持最常见的「分片列表」形态）。
   *
   * 为什么需要：直播/部分商品视频给的是 .m3u8，直接 downloads 下来的
   * 是几 KB 的索引文本，不是视频本体，软件那边根本没法用。
   *
   * 故意不支持：
   *   · #EXT-X-KEY（AES 加密）——解密要拿 key 请求，先不碰；
   *     遇到就整体放弃，宁可不产出也不产出解密错的垃圾。
   *   · #EXT-X-MAP（fMP4 初始化分片）——需要额外拼 container，复杂且少见。
   *   · 主子清单（master playlist）——不递归，只认叶子清单。
   *
   * @param {string} text 播放列表文本
   * @param {string} baseUrl 清单自身地址，用于把相对路径补成绝对
   * @returns {Array<string>} 分片绝对地址；非叶子清单/加密清单返回 []
   */
  U.parseM3u8 = function (text, baseUrl) {
    var lines = String(text || '').split(/\r?\n/);
    var segs = [];
    var encrypted = false;
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i].trim();
      if (!ln) continue;
      if (ln.indexOf('#EXT-X-KEY') === 0) { encrypted = true; break; }
      if (ln.indexOf('#') === 0) continue;
      // 普通行 = 分片地址
      var abs = absolutizeUrl(ln, baseUrl);
      if (abs) segs.push(abs);
    }
    if (encrypted) return [];
    // 分片太少的（<2）多半是 master playlist 或垃圾响应
    if (segs.length < 2) return [];
    return segs;
  };

  /** 把相对地址补成绝对（m3u8 里分片经常是 ../seg/1.ts 这种） */
  function absolutizeUrl(u, base) {
    var s = String(u || '').trim();
    if (!s) return '';
    if (/^https?:\/\//i.test(s)) return s;
    if (s.indexOf('//') === 0) return 'https:' + s;
    if (!base) return '';
    var m = String(base).match(/^(https?:\/\/[^/]+)(\/[^?#]*)?/i);
    if (!m) return '';
    var origin = m[1];
    var path = m[2] || '/';
    if (s.charAt(0) === '/') return origin + s;
    var dir = path.slice(0, path.lastIndexOf('/') + 1);
    var out = dir + s;
    // 折叠 ../
    var parts = out.split('/');
    var stack = [];
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] === '..') stack.pop();
      else if (parts[i] !== '.') stack.push(parts[i]);
    }
    return origin + stack.join('/');
  }

  /**
   * 视频落盘文件名。与 skuSpecImageName 同一套「序号_名」思路，
   * 但视频可能多个（主图视频 + 详情视频），所以给序号 + 时长。
   *   主图视频.mp4 / 主图视频_2.mp4
   */
  U.videoFileName = function (index) {
    return '主图视频' + (index > 0 ? '_' + (index + 1) : '') + '.mp4';
  };

  /** video 在 info.json 里的相对路径（与落盘文件名保持单一来源） */
  U.videoLocalPath = function (index) {
    return U.VIDEO_DIR + '/' + U.videoFileName(index);
  };

  // 从 <video> 元素取地址：优先 src，其次 <source> 子元素，最后 data-*
  U.videoFromElement = function (v) {
    if (!v) return '';
    if (typeof v.getAttribute === 'function') {
      var s = v.getAttribute('src');
      if (s) return s;
      try {
        var srcs = v.querySelectorAll && v.querySelectorAll('source');
        if (srcs && srcs.length && srcs[0].getAttribute) return srcs[0].getAttribute('src');
      } catch (e) {}
    }
    var d = v.dataset || {};
    return d.videoSrc || d.video || d.src || '';
  };

  // 从 <img> 的 src / data-src / srcset 里取地址
  U.imgFromElement = function (el) {
    if (!el) return '';
    return (
      el.getAttribute('data-origin') ||
      el.getAttribute('data-src') ||
      el.currentSrc ||
      el.src ||
      ''
    );
  };

  /**
   * 判定「非商品主图」：卖家头像、站点 logo、图标、装饰图。
   * 列表页卡片常常只有一张图，若不剔除，批量打包就会只下载到一张头像。
   */
  /**
   * 商品图 CDN 白名单。
   *
   * 「非商品图」的判定依据：只有来自这些图床的才算商品图，
   * 用来挡掉头像 / 图标 / 店铺 logo 之类。
   *
   * **每接一个新站点都要把它的图床加进来**——漏加的表现是
   * 卡片字段全都有、唯独图片 0 张，而且**一声不吭**（接京东时就踩了：
   * 360buyimg.com 不在名单里，30 张卡片全军覆没）。
   */
  U.IMAGE_HOST_RE = /alicdn\.com|taobaocdn\.com|1688\.com|360buyimg\.com/i;

  U.isNonItemImage = function (url) {
    if (!url) return true;
    var u = String(url);
    if (!U.IMAGE_HOST_RE.test(u)) return true;
    if (/avatar|headimg|head_pic|logo|\bicon\b|tps-|\/tfs\/|sellerpic|seller_pic|userribbon|qrcode/i.test(u)) {
      return true;
    }
    return false;
  };

  // 过滤 + 去重 + 规范化，保留商品主图
  U.filterItemImages = function (list) {
    if (!list || !list.length) return [];
    var seen = Object.create(null);
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var u = U.normalizeImageUrl(list[i]);
      if (!u || seen[u] || U.isNonItemImage(u)) continue;
      seen[u] = 1;
      out.push(u);
    }
    return out;
  };

  /**
   * 从一段 HTML 正文里提图片地址。
   *
   * 详情正文普遍是商家后台存的一段 HTML，里面常常塞着十几张细节图。
   * 1688/淘宝的主图只有 5 张，凑不满 9 张图位时，剩下的要从这里补。
   *
   * 三种挂载形态都得认：
   *   <img src>
   *   <img data-src|data-ks-lazyload|data-original>   详情页常见的懒加载写法
   *   background-image: url(...)
   * data:image/base64 和 1px 占位图由 filterItemImages 统一筛掉，这里不重复判断。
   */
  U.imagesFromHtml = function (html) {
    var out = [];
    if (!html || typeof html !== 'string') return out;
    // 纯文本描述（多数列表页给的那种）连尖括号都没有，不必跑正则
    if (html.indexOf('<') === -1 && html.indexOf('url(') === -1) return out;
    // `[^>]*?` 必须允许 0 个字符、且分隔空白归后面的 \s 消耗，
    // 否则 `<img src=`（属性紧贴标签名）匹配不上，只会漏掉最常见的一种写法。
    var pats = [
      /<img\b[^>]*?\ssrc\s*=\s*["']([^"']+)["']/gi,
      /<img\b[^>]*?\sdata-(?:src|original|ks-lazyload|lazyload-src)\s*=\s*["']([^"']+)["']/gi,
      /background-image\s*:\s*url\(["']?([^"')\s]+)["']?\)/gi
    ];
    for (var p = 0; p < pats.length; p++) {
      var m;
      var re = pats[p];
      re.lastIndex = 0;
      while ((m = re.exec(html)) !== null) {
        // 长度 0 的匹配不会推进 lastIndex，会变成死循环
        if (!m[0].length) { re.lastIndex++; continue; }
        var u = U.normalizeImageUrl(m[1]);
        if (u && out.indexOf(u) === -1) out.push(u);
      }
    }
    return out;
  };

  /**
   * 图集上限。闲鱼一个商品最多配 9 张图，多下载既没处用又拖慢打包，
   * 所以超出部分直接截掉（顺序即优先级：主图在前、详情正文图在后）。
   */
  U.IMAGE_CAP = 9;

  U.capImages = function (list, cap) {
    if (!Array.isArray(list)) return [];
    var n = cap || U.IMAGE_CAP;
    return list.slice(0, n);
  };

  // 猜图片扩展名
  U.imageExt = function (url) {
    // avif 要认：它是合法图片格式，万一某条路径没经过 normalizeImageUrl 的
    // 「剥 .avif」处理，至少能让扩展名和真实内容一致，别再产出
    // 「叫 .jpg 其实是 AVIF」这种谁都读不了的文件。
    var m = String(url).match(/\.(jpg|jpeg|png|webp|gif|bmp|avif)(?:$|\?)/i);
    if (m) return '.' + m[1].toLowerCase();
    if (/\.webp/i.test(url)) return '.webp';
    return '.jpg';
  };

  /* ---------------- JSON 深搜 ---------------- */

  U.pickPath = function (obj, path) {
    if (!obj) return undefined;
    var parts = String(path).split('.');
    var cur = obj;
    for (var i = 0; i < parts.length; i++) {
      if (cur == null) return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  };

  /**
   * 广度优先深搜：在任意层级的 JSON 里找第一个 key 命中（忽略大小写）的值
   * @param {object} root
   * @param {string[]} keyNames 候选 key（小写）
   * @param {function} [predicate] 值过滤
   */
  U.deepFind = function (root, keyNames, predicate, maxDepth) {
    if (!root || typeof root !== 'object') return undefined;
    maxDepth = maxDepth || 8;
    var lower = keyNames.map(function (k) { return String(k).toLowerCase(); });
    var queue = [{ v: root, d: 0 }];
    var seen = new Set();
    var head = 0;
    while (head < queue.length) {
      var item = queue[head++];
      var v = item.v;
      if (!v || typeof v !== 'object' || item.d > maxDepth) continue;
      if (seen.has(v)) continue;
      seen.add(v);
      var keys = Array.isArray(v) ? Object.keys(v) : Object.keys(v);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        var val = v[k];
        if (lower.indexOf(String(k).toLowerCase()) > -1) {
          if (!predicate || predicate(val)) return val;
        }
        if (val && typeof val === 'object') queue.push({ v: val, d: item.d + 1 });
      }
    }
    return undefined;
  };

  /**
   * 从接口 JSON 里抽取商品卡片列表
   * 策略：「已知列表路径优先」→「结构化深搜兜底」，
   * 避免把卖家信息、分页游标之类的同名字段误判成商品。
   * @returns {{itemId:string,title:string,price:string,image:string,sellerNick:string,url:string}[]}
   */
  var CARD_LIST_PATHS = [
    'resultList', 'data.resultList', 'data.data.resultList',
    'itemList', 'data.itemList',
    'itemsList', 'data.itemsList',
    'itemVoList', 'data.itemVoList',
    'list', 'data.list', 'data.data.list',
    'items', 'data.items', 'data.data.items',
    'data.searchResult', 'searchResult',
    // 1688 店铺页（实测 2026-09-27）：
    //   店铺首页  -> data.offerModuleList
    //   整店页 /page/offerlist.htm -> data.content.offerList
    //   （moduleasyncservice 接口，只有它给真实商品；offerModuleList 在整店页上是空的）
    'offerModuleList', 'data.offerModuleList', 'data.data.offerModuleList',
    'content.offerList', 'data.content.offerList', 'data.data.content.offerList',
    // 淘宝店铺商品列表（实测 2026-09-28）：
    //   mtop.taobao.shop.simple.item.fetch 的 data 就是
    //   { totalCnt, data:[{itemId,title,image,itemUrl,...}], page, pageSize, hasNext }
    // 放最后：'data' 太通用，只有前面全落空时才轮到它。
    'data'
  ];

  /**
   * 把商品节点里的图片全收下来（数组形态）。收不到返回空数组。
   *
   * 各家叫法不同，且同一条数据里可能同时存在几套字段
   * （1688 整店页的 offerImages、imageInfos 结构不同但都是数组）。
   * 这里「先到先得」：命中一套就够，不混着拼，
   * 免得把不同尺寸变体（220x220 / 310x310 指向同一张图）当成多张图下载。
   * 注意同一套内部只按 URL 字符串去重——1638 的 CDN 变体后缀形态太多
   * （_460x460q100.jpg_.webp 这种连着好几段），按图指纹去不可靠，
   * 而且真实数据里同一套内部的图本来就是不同的几张。
   */
  function collectImageList(node) {
    if (!node || typeof node !== 'object') return [];
    // mainImageList：1688 SKU 选择器接口给的**完整主图集**（实测 5 张，带
    // fullPathImageURI）。列表页接口往往只缩到 3 张，靠它才能补齐到 5 张。
    var arrays = [node.offerImages, node.imageInfos, node.mainImageList,
      node.images, node.imageList, node.imgs];
    for (var a = 0; a < arrays.length; a++) {
      var arr = arrays[a];
      if (!Array.isArray(arr)) continue;
      var out = [];
      for (var i = 0; i < arr.length; i++) {
        var one = arr[i];
        var u = (one && typeof one === 'object')
          // 1688 店铺接口：imageURI 是不带域名的相对路径（img/ibank/xxx.jpg）。
          // mainImageList 同时给 fullPathImageURI（完整 https URL），优先用它，
          // 免去 normalize 补域名这一层可能踩错的假设。
          ? (one.fullPathImageURI || one.imageURI || one.url || one.pic || one.image || one.img)
          : (typeof one === 'string' ? one : '');
        if (u && out.indexOf(u) === -1) out.push(u);
      }
      // 数组存在但全是空值时继续找下一套，别白拿一张都没有的
      if (out.length) return out;
    }
    return [];
  }

  U.collectCards = function (root, opts) {
    if (!root || typeof root !== 'object') return [];
    opts = opts || {};
    var site = opts.site || null;
    var itemUrl = (site && site.itemUrl) ||
      function (id) { return 'https://www.goofish.com/item?id=' + id; };
    var byId = new Set();
    var out = [];

    function isId(v) {
      if (v == null) return false;
      return /^\d{6,20}$/.test(String(v));
    }

    function pick(node, depth) {
      if (!node || typeof node !== 'object') return null;
      // 1688 全站官方术语叫 offerId（搜索 / 店铺 / 详情三处接口的同一个名）。
      // 之前只认 itemId / item_id / id，1688 搜索页一个都匹配不到，
      // 商品全靠 DOM 兜底——于是「标题和文案有、主图一张没有」（实测 2026-09-28，
      // 关键词搜索页 60 件商品 collectCards 返回 0）。
      var rawId = node.itemId != null ? node.itemId
        : (node.item_id != null ? node.item_id
          : (node.offerId != null ? node.offerId
            : (node.offerid != null ? node.offerid : node.id)));
      if (!isId(rawId)) {
        // 兼容多包了一层的结构，如 { item: { itemId, title } }
        if ((depth || 0) < 2) {
          var nested = node.item || node.data || node.card || node.itemDO || node.goods || node.result;
          if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
            return pick(nested, (depth || 0) + 1);
          }
        }
        return null;
      }
      var id = String(rawId);
      if (byId.has(id)) return null;

      var title = node.title || node.itemTitle || node.subject || node.name;
      if (typeof title !== 'string' || title.trim().length < 2) return null;

      // 价格字段各家叫法不同：1688 店铺接口给的是 consignPrice（"12.00"），
      // 也有商品把价格拆成 finalPriceVo.priceView 的高低位两段，都得认。
      var priceRaw = node.price != null ? node.price
        : (node.soldPrice != null ? node.soldPrice
          : (node.priceShow != null ? node.priceShow
            : (node.consignPrice != null ? node.consignPrice
              : (node.finalPrice != null ? node.finalPrice : ''))));
      // 淘宝店铺列表接口给的是 discountPrice，而且**默认是加密串**
      // （priceEncoded:true，形如 [1_7ij1w4tp#51#<base64>#]）。
      // 加密值比不填更糟——它会被当成价格写进文案和目录名，所以只认明文。
      // 明文价由详情补录负责拿（见 sites.js 的 shopField.price 注释）。
      if (!priceRaw && typeof node.discountPrice === 'string' &&
          !node.priceEncoded && node.discountPrice.charAt(0) !== '[') {
        priceRaw = node.discountPrice;
      }
      if (!priceRaw && node.finalPriceVo && node.finalPriceVo.priceView) {
        var pv = node.finalPriceVo.priceView;
        if (pv.humpHighPart != null) priceRaw = pv.humpHighPart + (pv.humpLowPart || '');
      }
      var seller = node.seller || node.user || {};
      // 图片先收数组，收不到才退回单值字段。
      // 原来这里只取 offerImages[0] / imageInfos[0]，等于把"一件的图"缩成一张，
      // 于是在整店页上稳定表现为「下载主图只有一张」。
      // image 仍取第一张（保持旧行为不变），多出来的进 images，
      // 下游 selectedItems / 打包 / 补详情的判据都读 images，能直接吃下。
      var imgs = collectImageList(node).map(function (u) {
        return U.normalizeImageUrl(u);
      }).filter(Boolean);
      var img = imgs.length ? imgs[0] : U.normalizeImageUrl(
        // 1688 搜索页的主图是单值字段 offerPicUrl（odPicUrl 是同一张的另一种叫法），
        // 不在上面任何一套数组里。不认它就只能拿到空图——这就是搜索页零图的原因。
        node.offerPicUrl || node.odPicUrl || node.fullPathImageURI ||
        node.picUrl || node.imageUrl || node.pic || node.imgUrl ||
        node.image || node.mainImage || ''
      );
      // 只有单值时也要落到数组里：下游一律读 images 判数量，
      // 只给 image 会让 selectedItems 算出「0 张图」。
      if (!imgs.length && img) imgs = [img];

      byId.add(id);
      return {
        itemId: id,
        title: title.trim().slice(0, 200),
        price: U.formatPrice(priceRaw),
        image: img,
        images: imgs.length ? imgs : undefined,
        sellerNick: String(
          node.userNick || node.nick || node.sellerNick || node.shopName ||
          seller.userNick || seller.nick || ''
        ).trim(),
        url: itemUrl(id)
      };
    }

    // 1) 已知列表路径优先
    var maxPathDepth = opts.maxPathDepth || 4;
    for (var p = 0; p < CARD_LIST_PATHS.length; p++) {
      var seg = String(CARD_LIST_PATHS[p]).split('.');
      if (seg.length > maxPathDepth) continue;
      var cur = root;
      for (var s = 0; s < seg.length; s++) {
        if (cur == null || typeof cur !== 'object') { cur = null; break; }
        cur = cur[seg[s]];
      }
      if (Array.isArray(cur) && cur.length) {
        for (var i = 0; i < cur.length; i++) {
          var c = pick(cur[i]);
          if (c) out.push(c);
        }
        if (out.length) return out;
      }
    }

    // 2) 深搜兜底（限制遍历量，避免超大 body 卡死页面）
    var budget = opts.budget || 20000;
    var queue = [root];
    var visited = new Set();
    var depth = 0;
    while (queue.length && budget > 0 && depth < (opts.maxDepth || 9)) {
      var size = queue.length;
      for (var q = 0; q < size; q++) {
        var node = queue.shift();
        if (!node || typeof node !== 'object' || visited.has(node)) continue;
        visited.add(node);
        budget--;
        if (Array.isArray(node)) {
          for (var k = 0; k < node.length && budget > 0; k++) {
            var got = pick(node[k]);
            if (got) { out.push(got); budget--; }
          }
        } else {
          var hit = pick(node);
          if (hit) out.push(hit);
          for (var key in node) {
            if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
            var val = node[key];
            if (val && typeof val === 'object') queue.push(val);
          }
        }
      }
      depth++;
    }
    return out;
  };

  /* ---------------- 列表页 DOM 扫描 ---------------- */

  // 商品链接的多种形态：/item?id=xx /item.html?id=xx /item/xx
  U.CARD_LINK_RE = /[?&]id=(\d{5,20})|(?:^|\/)item\/(\d{5,20})/i;

  function textOf(el) {
    return el ? String(el.textContent || el.innerText || '').trim() : '';
  }

  /**
   * 找出商品卡片容器：从链接节点向上找第一个「有图且有文字」的合理区块。
   * 站点自带显式 cardSel 时优先按它认，比靠尺寸猜准。
   */
  U.cardBox = function (node, site) {
    if (site && site.cardSel && node && node.parentElement) {
      var cur = node;
      for (var c = 0; cur && c < 6; c++) {
        if (cur.matches && cur.matches(site.cardSel)) return cur;
        cur = cur.parentElement;
      }
    }
    var n = node;
    for (var i = 0; n && i < 6; i++) {
      try {
        var r = n.getBoundingClientRect();
        if (r.width > 140 && r.height > 110 && r.width * r.height > 10000) {
          var hasImg = n.querySelector && n.querySelector('img');
          var txt = textOf(n);
          if ((hasImg && txt.length > 3) || (txt.length > 10 && txt.length < 400)) return n;
        }
      } catch (e) {}
      n = n.parentElement;
    }
    return (node && node.parentElement) || node;
  };

  /**
   * 扫描页面 DOM 上的商品卡片（不依赖接口，滚动加载后也能持续产出）
   * @param {object} [site] 站点配置，决定 ID 正则、链接形态、字段名
   * @returns 卡片数组，字段与 collectCards 保持一致
   */
  U.scanCards = function (root, site) {
    root = root || (typeof document !== 'undefined' ? document : null);
    if (!root || !root.querySelectorAll) return [];
    site = site || {};
    var idRe = site.idRe || U.CARD_LINK_RE;
    var itemUrl = site.itemUrl || function (id) { return 'https://www.goofish.com/item?id=' + id; };
    var out = [];
    var seen = {};

    function firstId(text) {
      if (!text) return '';
      var m = String(text).match(idRe);
      return m ? String(m[1] || m[2] || '') : '';
    }

    /**
     * 从卡片元素上认商品 ID。
     *
     * 站点可以给 idFrom(el, href) 自己实现——淘宝搜索页必须走这条路：
     * 卡片里的 a[href] 全是 click.simba.taobao.com（广告跳转）或店铺链接，
     * **没有一条指向 item.taobao.com**，ID 只挂在卡片容器的 data-spm-act-id 上。
     * 靠 href 正则永远认不出来，也就一个复选框都挂不上。
     */
    function idOf(el, href) {
      if (site.idFrom) {
        try {
          var custom = site.idFrom(el, href);
          if (custom) return String(custom);
        } catch (e) {}
      }
      return firstId(href);
    }

    // 承载商品 ID 的常见属性，按可靠性排序
    function attrId(el) {
      if (!el || !el.getAttribute) return '';
      var names = ['data-offer-id', 'data-itemid', 'data-item-id', 'data-id', 'data-spm-act-id'];
      for (var i = 0; i < names.length; i++) {
        var v = el.getAttribute(names[i]);
        if (v && /^\d{6,20}$/.test(String(v).trim())) return String(v).trim();
      }
      return '';
    }

    function add(id, linkEl) {
      if (!id || seen[id]) return;
      seen[id] = 1;
      var box = null;
      try { box = U.cardBox(linkEl, site); } catch (e) { box = null; }
      var scope = box || linkEl;
      out.push({
        itemId: id,
        title: U.cardField(scope, site.field && site.field.title),
        price: U.cardPrice(scope, site.field && site.field.price, site.priceIsRange),
        image: U.cardImage(scope, site.field && site.field.image, site.imageUpgrade),
        sellerNick: U.cardField(scope, site.field && site.field.shop),
        url: itemUrl(id),
        source: 'dom'
      });
    }

    // 主路径 1：站点给了显式卡片选择器，直接在容器里认
    if (site.cardSel) {
      var cards;
      try { cards = root.querySelectorAll(site.cardSel); } catch (e) { cards = []; }
      for (var i = 0; i < cards.length; i++) {
        var box = cards[i];
        // 容器自己挂着 ID 的情况优先——淘宝搜索页只此一路可走
        var selfId = attrId(box) || (site.idFrom ? String(site.idFrom(box, '') || '') : '');
        if (selfId) { add(selfId, box); continue; }
        var as;
        try { as = box.querySelectorAll('a[href]'); } catch (e) { as = []; }
        var hit = null;
        for (var a = 0; a < as.length; a++) {
          var hid = idOf(as[a], as[a].getAttribute('href'));
          if (hid) { hit = as[a]; break; }
        }
        if (hit) add(idOf(hit, hit.getAttribute('href')), hit);
      }
    }

    // 主路径 2：通用 —— 全站 <a> 逐个用站点 ID 正则匹配
    var links;
    try { links = root.querySelectorAll('a[href]'); } catch (e) { links = []; }
    for (var k = 0; k < links.length; k++) {
      var href = links[k].getAttribute('href') || '';
      if (href.length > 250) continue;
      var id = idOf(links[k], href);
      if (id) add(id, links[k]);
    }

    // 补充：无 <a> 包裹、用 data-* 属性承载 id 的卡片
    if (!out.length && site.cardSel) {
      var nodes;
      try { nodes = root.querySelectorAll('[data-offer-id],[data-itemid],[data-item-id],[data-id],[data-spm-act-id]'); } catch (e) { nodes = []; }
      for (var j = 0; j < nodes.length; j++) {
        // 站点自己实现了 idFrom 就必须用它 —— 别退回通用 attrId。
        // 这里的属性名太泛（尤其 data-id），京东店铺页上就吃过亏：
        // 页面里遍地是 data-id="774716" 这类 **shopId**，通用扫法会把
        // 店铺 ID 当成商品采出来，最后变成一条「没有图没有价没有标题」的脏卡片。
        // 走 idFrom 之后，京东只认 data-sku / item.jd.com 直链，自然就挡住了。
        var did = site.idFrom
          ? String(site.idFrom(nodes[j], '') || '')
          : attrId(nodes[j]);
        if (did) add(did, nodes[j]);
      }
    }
    return out;
  };

  // 在卡片容器内按选择器取第一段「像人话」的文本
  U.cardField = function (scope, selectors) {
    if (!scope || !scope.querySelectorAll) return '';
    var list = selectors || ['[class*=title]', '[class*=Title]', 'h1', 'h2', 'h3', 'h4', '[class*=name]', '[class*=desc]'];
    for (var i = 0; i < list.length; i++) {
      var nodes;
      try { nodes = scope.querySelectorAll(list[i]); } catch (e) { continue; }
      for (var j = 0; j < nodes.length; j++) {
        var t = textOf(nodes[j]);
        if (t.length < 2 || t.length > 300) continue;
        if (/^[\d.,元起¥\s]+$/.test(t)) continue; // 价格、纯数字aria跳过
        return t.slice(0, 200);
      }
    }
    return '';
  };

  U.cardPrice = function (scope, selectors, isRange) {
    if (!scope || !scope.querySelectorAll) return '';
    var sel = selectors || ['[class*=price]', '[class*=Price]'];
    var nodes;
    try { nodes = scope.querySelectorAll(sel.join(',')); } catch (e) { return ''; }
    for (var i = 0; i < nodes.length; i++) {
      var raw = textOf(nodes[i]);
      if (!raw || raw.length > 30) continue;
      var t = isRange ? U.firstPrice(raw) : raw.replace(/[^\d.]/g, '');
      if (t && /^\d+(\.\d{1,2})?$/.test(t)) return t;
    }
    return '';
  };

  // 区间价 "18.90-25.00" / "¥18.90起" 取下限
  U.firstPrice = function (raw) {
    var s = String(raw == null ? '' : raw).trim();
    var m = s.match(/(\d+(?:\.\d{1,2})?)/);
    return m ? m[1] : '';
  };

  /**
   * 从卡片容器里抠主图。upgrade 是可选的「尺寸升级」钩子——
   * 京东把尺寸写在 URL 里（.../s228x228_jfs/...），缩略图只有 6KB，
   * 站点可以借这个钩子换成 s800x800。
   */
  U.cardImage = function (scope, selector, upgrade) {
    if (!scope || !scope.querySelectorAll) return '';
    var nodes;
    try { nodes = scope.querySelectorAll(selector || 'img'); } catch (e) { return ''; }
    for (var i = 0; i < nodes.length; i++) {
      var url = U.imgFromElement(nodes[i]);
      if (!url) continue;
      if (!U.IMAGE_HOST_RE.test(url)) continue;
      if (/avatar|head|logo|icon|tps-|\/tfs\//i.test(url)) continue;
      var w = nodes[i].naturalWidth || nodes[i].width || 0;
      if (w && w < 80) continue;
      var out = U.normalizeImageUrl(url);
      return upgrade ? upgrade(out) : out;
    }
    return '';
  };

  /* ---------------- 详情数据提取 ---------------- */

  function fromImages(v) {
    var arr = [];
    if (Array.isArray(v)) arr = v;
    else if (v && Array.isArray(v.imageInfos)) arr = v.imageInfos;
    else if (v && Array.isArray(v.images)) arr = v.images;
    return arr
      .map(function (x) {
        if (typeof x === 'string') return x;
        if (!x) return '';
        return x.url || x.imageUrl || x.picUrl || x.img || x.origin || '';
      })
      .filter(Boolean)
      .map(function (u) { return U.normalizeImageUrl(u); });
  }

  function uniq(arr) {
    var seen = {};
    var out = [];
    arr.forEach(function (x) {
      if (!x || seen[x]) return;
      seen[x] = 1;
      out.push(x);
    });
    return out;
  }

  /**
   * 从 mtop 详情接口返回的 data 中提取结构化商品信息
   * 采用「候选路径优先 + 深搜兜底」，接口改版也不容易全挂
   */
  U.extractDetail = function (data, site) {
    if (!data || typeof data !== 'object') return null;
    var itemUrl = (site && site.itemUrl) ||
      function (id) { return 'https://www.goofish.com/item?id=' + id; };

    /**
     * 候选路径优先 + 深搜兜底。
     *
     * fieldKey 用于让站点插入自己的候选路径：淘宝的详情数据全挂在 componentsVO
     * 下面（主图在 headImageVO.images、价格在 priceVO.*.priceText），
     * 通用路径（itemDO.*）一条都命中不了；而深搜只能按「键名像 image」找，
     * 价格这种键名叫 priceText/priceMoney 的根本捞不着。
     */
    function grab(paths, keys, predicate, fieldKey) {
      var list = paths;
      // site 可能整个不传（测试与部分调用点都这样），必须容错
      var custom = fieldKey && site && site.detailPaths && site.detailPaths[fieldKey];
      if (custom && custom.length) list = custom.concat(paths);
      for (var i = 0; i < list.length; i++) {
        var v = U.pickPath(data, list[i]);
        if (v != null && v !== '' && (!predicate || predicate(v))) return v;
      }
      return U.deepFind(data, keys, predicate);
    }

    var isStr = function (v) { return typeof v === 'string' && v.length > 1; };

    var itemId = String(
      grab(['itemDO.itemId', 'itemDetailDO.itemDO.itemId', 'itemId', 'item.itemId'], ['itemid'], function (v) {
        return v != null && String(v).length > 5;
      }) || ''
    );

    var title = grab(
      ['itemDO.title', 'itemDetailDO.itemDO.title', 'title', 'item.title'],
      ['title'],
      function (v) { return typeof v === 'string' && v.length > 1; },
      'title'
    ) || '';

    var desc = grab(
      ['itemDO.desc', 'itemDetailDO.itemDO.desc', 'desc', 'itemDO.description', 'description', 'detail'],
      ['desc', 'description', 'detaildesc', 'content'],
      function (v) { return typeof v === 'string' && v.length > 1; },
      'desc'
    ) || '';

    // 价格：淘宝给的是 priceText（"4.01"）这种带小数的字符串。
    // 兜底深搜必须限制成「字符串/数字」——否则会捞到 price 对象
    // （{priceMoney, priceText, priceTitle}），String(对象) 出来是垃圾。
    var price = grab(
      ['itemDO.price', 'itemDetailDO.itemDO.price', 'price', 'itemDO.priceShow', 'soldPrice'],
      ['price', 'soldprice'],
      function (v) {
        return (typeof v === 'string' || typeof v === 'number') && String(v).trim() !== '';
      },
      'price'
    );

    var imagesRaw = grab(
      ['itemDO.imageInfos', 'itemDetailDO.itemDO.imageInfos', 'itemDO.images', 'images', 'itemDO.picList'],
      ['imageinfos', 'images', 'piclist', 'imglist'],
      function (v) { return Array.isArray(v) && v.length > 0; },
      'images'
    );
    var images = uniq(fromImages(imagesRaw));
    // 详情正文里塞的图也要收：1688/淘宝的主图（mainImageList）只有 5 张，
    // 凑不满 9 张图位时，剩下的从这些细节图补。
    // 注意顺序——先主图后正文图，截断时优先保住主图。
    var descImages = U.imagesFromHtml(desc);
    if (descImages.length) images = uniq(images.concat(descImages));
    images = U.capImages(images);

    var sellerNick = grab(
      ['sellerDO.userNick', 'itemDetailDO.sellerDO.userNick', 'userNick', 'sellerDO.nick', 'nick', 'sellerName'],
      ['usernick', 'nick', 'sellernick', 'sellername'],
      isStr
    ) || '';

    var sellerId = String(
      grab(
        ['sellerDO.userId', 'itemDO.sellerId', 'sellerDO.sellerId', 'userId', 'sellerId'],
        ['userid', 'sellerid'],
        function (v) { return v != null && String(v).length > 3; }
      ) || ''
    );

    var location = grab(
      ['itemDO.location', 'itemDO.area', 'sellerDO.location', 'location', 'city', 'province'],
      ['location', 'cityname', 'area'],
      isStr
    ) || '';

    var want = grab(['itemDO.wantNum', 'itemDO.favorCount', 'wantNum'], ['wantnum', 'favorcount'], function (v) { return v != null; });
    var browse = grab(['itemDO.browseNum', 'itemDO.viewCount', 'browseNum'], ['browsenum', 'viewcount'], function (v) { return v != null; });
    var publishTime = grab(['itemDO.publishTime', 'itemDO.gmtCreate', 'publishTime'], ['publishtime', 'gmtcreate'], function (v) { return v != null; });

    if (!title && !images.length && !itemId) return null;

    return {
      itemId: itemId,
      title: String(title || '').trim(),
      desc: String(desc || '').trim(),
      price: U.formatPrice(price),
      images: images,
      sellerNick: String(sellerNick || '').trim(),
      sellerId: sellerId,
      sellerUrl: sellerUrlOf(sellerId, site),
      location: String(location || '').trim(),
      wantNum: want == null ? '' : String(want),
      browseNum: browse == null ? '' : String(browse),
      publishTime: publishTime ? String(publishTime) : '',
      url: itemId ? itemUrl(itemId) : (global.location ? global.location.href : ''),
      // 主图视频。详情页接口基本不带视频，DOM 分支才是主力；
      // 但接口里偶尔会带（1688 offerVideo / 淘宝 videos[] / 闲鱼 videoInfo），
      // 这里一并收集，两路合并去重。接口没有就留空数组，不编造。
      videos: U.pickVideos(data),
      // 多规格商品的规格表。多 SKU 商品在列表页看不出区别，
      // 等铺到别处才发现规格全丢了，所以这里必须跟着详情一起带出来。
      skus: U.parseSkus(data),
      source: 'api'
    };
  };

  // 店铺主页地址各站不同：闲鱼是 /personal?userId=，1688 是 shop{id}.1688.com
  function sellerUrlOf(sellerId, site) {
    if (!sellerId) return '';
    if (site && site.sellerUrl) return site.sellerUrl(sellerId);
    return 'https://www.goofish.com/personal?userId=' + sellerId;
  }

  /* ---------------- 多规格（SKU） ---------------- */

  // 各站给的 SKU 字段名不一样（闲鱼 itemDO.skus、1688 skuPriceList），
  // 先按已知路径逐个试，再退回递归找。都找不到就当这商品没有规格表，
  // 绝不能凭空造一个出来。
  var SKU_LIST_PATHS = [
    'itemDO.skus', 'itemDetailDO.itemDO.skus', 'itemDO.skuList', 'itemDO.priceList',
    'skuList', 'skuPriceList', 'skus', 'priceList'
  ];

  // 规格明细（键即规格名）的落点，用于兜底
  var SKU_MAP_PATHS = ['skuModel', 'skuInfoMap', 'skumodel'];

  // 真实布局（实测 1688 queryofferskuselectormodel）：
  //   data.skuSelectorBizModel.skuInfoMap   规格明细：{ "【6格】CD支架": {discountPrice, ...} }
  //   data.skuSelectorBizModel.skuProps     规格维度：[{prop:"颜色", value:[{name, imageUrl}]}]
  //   data.originalSkuInfoMap               与 skuInfoMap 同内容的旧字段，不能优先取
  // 容器不是 skuModel 而是 skuSelectorBizModel，deepFind 按 key 精确匹配会整条漏掉。
  var SKU_MODEL_PATHS = ['skuSelectorBizModel', 'skuModel', 'skuInfoModel'];

  // 完整主图集的路径。1688 的 SKU 选择器接口把它挂在 skuSelectorModel 下，
  // 详情页则挂在 offerDetail / itemDO 下，形态不统一，逐个试。
  var MAIN_IMAGE_PATHS = [
    'skuSelectorBizModel.skuSelectorModel.mainImageList',
    'skuSelectorBizModel.mainImageList',
    'skuSelectorModel.mainImageList',
    'mainImageList',
    'offerDetail.mainImageList',
    'itemDO.mainImageList'
  ];

  /**
   * 取商品的完整主图集。
   *
   * 1688 列表页接口（搜索 / 整店）只给缩略图——搜索页 1 张、整店页 3 张，
   * 而真正的完整主图集在 SKU 选择器接口里：
   *   skuSelectorBizModel.skuSelectorModel.mainImageList
   * 实测 5 张（正是 1688 后台上传的主图数量），元素形如
   *   { fullPathImageURI:"https://cbu01.alicdn.com/img/ibank/O1CN…", imageURI:"img/ibank/O1CN…" }
   *
   * 之前 fetchSkus 只从这里提规格表，这 5 张主图跟着响应一起被丢掉了，
   * 于是稳定表现为「整店只有 3 张图」——不是下载失败，是数据源里就没拿到。
   *
   * @returns {string[]} 规范化 + 过滤后的图集，没有则空数组
   */
  U.parseMainImages = function (data) {
    if (!data || typeof data !== 'object') return [];
    var list = null;
    for (var i = 0; i < MAIN_IMAGE_PATHS.length; i++) {
      var v = U.pickPath(data, MAIN_IMAGE_PATHS[i]);
      if (Array.isArray(v) && v.length) { list = v; break; }
    }
    if (!list || !list.length) {
      list = U.deepFind(data, ['mainimagelist'], function (x) {
        return Array.isArray(x) && x.length > 0;
      });
    }
    if (!list || !list.length) return [];
    return U.filterItemImages((list || []).map(function (one) {
      if (one && typeof one === 'object') {
        return one.fullPathImageURI || one.imageURI || one.url ||
          one.pic || one.image || one.img || '';
      }
      return typeof one === 'string' ? one : '';
    }));
  };

  /**
   * 淘宝/天猫的详情正文图（mtop.taobao.detail.getdesc）。
   *
   * 两种形态都得认，因为主动调用和页面自请求拿到的不是同一套：
   *   v6.0（我们能主动调的）     data.pcDescContent —— 一段 750px 宽的 HTML，里面直接是 <img>
   *   v7.0（页面自己请求的）     data.components.componentData.<detail_pic_*>.model.picUrl
   * 实测同一个商品两种形态都是 22 张图。
   */
  U.parseTaobaoDesc = function (data) {
    if (!data || typeof data !== 'object') return [];

    var out = [];
    // 形态一：正文 HTML
    if (typeof data.pcDescContent === 'string' && data.pcDescContent) {
      out = U.imagesFromHtml(data.pcDescContent);
    }

    // 形态二：组件式结构
    if (!out.length) {
      var cd = U.pickPath(data, 'components.componentData');
      if (cd && typeof cd === 'object') {
        Object.keys(cd).forEach(function (k) {
          if (/pricedesc/i.test(k)) return;      // 平台插的价格说明图，非商品实拍
          var url = U.pickPath(cd[k], 'model.picUrl');
          if (typeof url === 'string' && url) out.push(url);
        });
      }
    }

    // filterItemImages 会顺带剔掉 tps- 开头的运营图/价格说明图
    return U.filterItemImages(out);
  };

  /**
   * 找「规格容器」：规格明细和规格维度平级的那一层。
   *
   * 不能一看到 skuInfoMap 就当容器——规格图挂在 skuProps 上，
   * 少了这一层，SKU 明细里根本没有图字段，最后就下载到一堆空引用。
   * 所以按内容认：同时挂着「规格明细」和「规格维度」的才算容器。
   */
  function findSkuModel(root) {
    if (!root || typeof root !== 'object') return null;
    var queue = [root];
    var seen = new Set();
    while (queue.length) {
      var cur = queue.shift();
      if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
      seen.add(cur);

      var isMap = false;
      var hasProps = false;
      var keys = Object.keys(cur);
      for (var i = 0; i < keys.length; i++) {
        var lk = keys[i].toLowerCase();
        var val = cur[keys[i]];
        if (lk === 'skuinfomap' || lk === 'originalskuinfomap') {
          if (val && typeof val === 'object') isMap = true;
        }
        if (lk === 'skuprops') {
          if (Array.isArray(val)) hasProps = val.length > 0;
          else if (val && typeof val === 'object') hasProps = Object.keys(val).length > 0;
        }
      }
      if (isMap && hasProps) return cur;

      for (i = 0; i < keys.length; i++) {
        if (cur[keys[i]] && typeof cur[keys[i]] === 'object') queue.push(cur[keys[i]]);
      }
    }
    return null;
  }

  function findSkuProps(scope) {
    if (!scope || typeof scope !== 'object') return null;
    var direct = U.pickPath(scope, 'skuProps');
    if (Array.isArray(direct) && direct.length) return direct;
    var d = U.deepFind(scope, ['skuprops'], function (x) { return Array.isArray(x) && x.length; });
    return Array.isArray(d) && d.length ? d : null;
  }

  function firstVal(o, keys) {
    if (!o || typeof o !== 'object') return null;
    var i, j, m;
    for (i = 0; i < keys.length; i++) {
      if (o[keys[i]] != null && o[keys[i]] !== '') return o[keys[i]];
    }
    // 键名的命名风格不统一（propName / propname / PropName），比小写
    var ks = Object.keys(o);
    for (i = 0; i < keys.length; i++) {
      var low = keys[i].toLowerCase();
      for (j = 0; j < ks.length; j++) {
        if (ks[j].toLowerCase() === low && o[ks[j]] != null && o[ks[j]] !== '') return o[ks[j]];
      }
    }
    return null;
  }

  /**
   * 解析多规格商品。
   * 列表页只给一个总价，规格表只在详情里；丢掉规格就等于
   * 把一个 S/M/L 分的商品当成单规格搬运，铺出去卖不动。
   * @returns null（无规格表）或 { specs:[维度名], list:[{key,names,price,stock,image}] }
   */
  /**
   * 闲鱼专有形态：itemDO.skuList。
   *
   * 字段名与淘宝/1688 完全不同，走通用分支一定错。结构据
   * goofish-client（第三方协议分析库）的类型源码，2026-10-16 查证：
   *
   *   interface SkuDO {
   *     skuId, itemId, sellerId, inventoryId,
   *     price, priceInCent,          // price 单位是「分」，要除 100
   *     quantity,
   *     propertyList: SkuProperty[]  // 属性列表
   *   }
   *   interface SkuProperty {
   *     propertyText, valueText, actualValueText, // 维度名 / 值名
   *     propertyId, valueId, enabled, status, string,
   *     propertySortOrder, valueSortOrder
   *     // ⚠️ 九个字段，**没有任何图片字段**
   *   }
   *
   * 也就是说：**闲鱼规格图不在商品详情接口里**，它在点「立即购买」后的
   * 确认单接口/弹层上。所以这里 image 一律空串 —— 不是漏了，是接口没给。
   * 软件侧可据此判断该不该自己去确认单接口补图。
   *
   * 还要注意：闲鱼是「一物一价」的平台，**大量商品根本没有多规格**，
   * skuList 会是空数组或不存在。那种情况返回 null（= 无规格），是正确的。
   */
  function fromXianyuSkuList(data) {
    var list = U.pickPath(data, 'itemDO.skuList')
      || U.pickPath(data, 'data.itemDO.skuList');
    if (!Array.isArray(list) || !list.length) return null;

    var specs = [];
    var specDefs = [];
    var defByName = {};
    var rows = [];

    /**
     * 规格图在 **SkuDO 层**的 propertyImage 里，不是 propertyList 里。
     *
     * ⚠️ 这里纠正过一个错误判断：之前看第三方库的类型源码说
     * 「SkuProperty 九个字段没有图片字段」，于是断定闲鱼规格图必须去
     * 确认单页点。**那是错的** —— 类型文档里漏了 propertyImage。
     * 2026-10-17 CDP 实测（商品 844934128301，132 个 SKU）确认：
     *   propertyImage: { major:boolean, pvPairDO:{...}, url:"http://img.alicdn.com/..." }
     *
     * pvPairDO 指明这张图属于哪个维度值，major 区分主图/细节图。
     */
    function imageOf(o, dimName, valText) {
      try {
        var pi = o && o.propertyImage;
        if (!pi) return '';
        // pvPairDO 可能说明这张图属于哪个维度值；不属于当前维度就不挂
        var pv = pi.pvPairDO || {};
        var pvDim = String(pv.propertyText || '').trim();
        var pvVal = String(pv.actualValueText || pv.valueText || '').trim();
        if (pvDim && pvVal && (pvDim !== dimName || pvVal !== valText)) return '';
        if (pi.url) return U.normalizeImageUrl(String(pi.url));
        // 兼容图挂在 pvPairDO 自己身上的情况
        if (pv.url) return U.normalizeImageUrl(String(pv.url));
      } catch (e) {}
      return '';
    }

    for (var i = 0; i < list.length; i++) {
      var o = list[i];
      if (!o || typeof o !== 'object') continue;
      var props = o.propertyList;
      if (!Array.isArray(props) || !props.length) continue;

      var names = [];
      for (var p = 0; p < props.length; p++) {
        var pr = props[p];
        if (!pr || typeof pr !== 'object') continue;
        // propertyText = 维度名（颜色），valueText = 值名（红色）
        var dim = String(firstVal(pr, ['propertyText', 'propName', 'name']) || '').trim();
        var val = String(firstVal(pr, ['actualValueText', 'valueText', 'value', 'propValue']) || '').trim();
        if (!val) continue;
        names.push(val);
        if (!dim) dim = '规格';
        if (specs.indexOf(dim) < 0) specs.push(dim);
        var def = defByName[dim];
        if (!def) {
          def = { name: dim, values: [] };
          defByName[dim] = def;
          specDefs.push(def);
        }
        var hit = def.values.some(function (v) { return v.value === val; });
        if (!hit) {
          // 无图值照样占位（规范 §4.1）：值序号不能跳，跳了软件全错行
          def.values.push({ value: val, image: imageOf(o, dim, val) });
        } else {
          // 同一个值可能被多条 SKU 重复带上不同的图，补上漏的那张
          var exist = null;
          for (var q = 0; q < def.values.length; q++) {
            if (def.values[q].value === val) { exist = def.values[q]; break; }
          }
          if (exist && !exist.image) exist.image = imageOf(o, dim, val);
        }
      }
      if (!names.length) continue;

      // 价格单位 —— 实测（2026-10-17，闲鱼真实响应）修正：
      //   price 与 priceInCent **数值完全相同**，两个都是「分」。
      //   例：price:3900, priceInCent:3900 → 实际售价 39 元。
      // 之前这里「优先用 price 当元」，会把 39 元的鞋写成 3900 元。
      // 现在：取两者较大值（它们一致），再按「分」换算。
      // 万一某个版本 price 真的已是元，值会小 100 倍，
      // 所以用启发式兜底：换算后若明显小于 1 元，说明它本来就是元。
      var price = '';
      var pv = Number(firstVal(o, ['price']));
      var pc = Number(firstVal(o, ['priceInCent']));
      var raw = Math.max(pv || 0, pc || 0);
      if (raw > 0) {
        var yuan = raw / 100;
        // 原本就是「元」的情况：raw 很小且不像是分
        price = yuan < 1 && raw >= 1 ? String(raw) : String(yuan);
      }

      var qty = firstVal(o, ['quantity']);
      rows.push({
        // 用 | 连接，和 fromSkuMap / 规范 §4.2 保持一致。
        // 之前这里写 '/'，导致同一份 info.json 里闲鱼的多维组合键
        // 与 1688/淘宝格式不同，软件侧按下标或按分隔符解析都会错。
        key: names.join('|'),
        names: names,
        price: U.formatPrice(price),
        stock: (qty == null || qty === '') ? '' : String(qty),
        image: ''
      });
    }
    if (!rows.length) return null;
    return finish(specs, rows, specDefs);
  }

  U.parseSkus = function (data) {
    if (!data || typeof data !== 'object') return null;

    // 闲鱼专有形态必须**前置**判断。原因见 fromXianyuSkuList 的注释：
    // 通用数组分支会先把 itemDO.skuList 认走，然后按淘宝的 props 字段去找属性，
    // 而闲鱼是 propertyList + propertyText/valueText —— 结果解析出空的。
    var xy = fromXianyuSkuList(data);
    if (xy) return xy;

    // 淘宝/天猫专有形态必须**前置**判断。原因见 fromTaobaoSkuBase 的注释：
    // 通用数组分支会先把 skuBase.skus 认走然后整条跳过，图就再也拿不到了。
    var tb = fromTaobaoSkuBase(data);
    if (tb) return tb;

    // 两种形态都要认：
    //   · 数组   data.skuList / data.skus（多数站的形态）
    //   · 对象   data.skuModel.skuInfoMap（1688：键就是规格名）
    var arr = null;
    for (var i = 0; i < SKU_LIST_PATHS.length; i++) {
      var v = U.pickPath(data, SKU_LIST_PATHS[i]);
      if (Array.isArray(v) && v.length) { arr = v; break; }
    }
    if (!arr) {
      arr = U.deepFind(data, ['skulist', 'skupricelist', 'skus', 'pricelist'], function (x) {
        return Array.isArray(x) && x.length > 0 && x.some(function (o) {
          return o && typeof o === 'object';
        });
      });
    }
    if (!arr || !arr.length) {
      var model = null;
      for (i = 0; i < SKU_MODEL_PATHS.length; i++) {
        var mv = U.pickPath(data, SKU_MODEL_PATHS[i]);
        if (mv && typeof mv === 'object' && Object.keys(mv).length) { model = mv; break; }
      }
      // 已知路径都不对上就按内容认容器（见 findSkuModel 的说明）
      if (!model) model = findSkuModel(data);
      // 只认顶层为「SKU 明细」的对象还不够：如果它自己不带规格维度
      // （skuProps 在更外层），规格名和规格图就全丢了，所以把 data 一起带进去兜底。
      if (model) {
        var viaMap = fromSkuMap(model, data);
        if (viaMap) return viaMap;
      }
    }
    if (!Array.isArray(arr) || !arr.length) {
      // 路径、深搜、对象形态全认不出 → 按形状兜底。
      // 闲鱼一直没有实测样本，字段名只能靠猜；这一层是「猜不出来也别空着」。
      var viaShape = findSkuByShape(data);
      if (viaShape) return viaShape;
      return null;
    }

    var viaArray = fromSkuArray(arr);
    // 深搜认出来的数组可能是「不像规格」的东西（比如导航标签）。
    // 拿它解析出了东西不代表对——这里再验一次，
    // 不合格就退给形状兜底，总比把错误规格写进 info.json 强。
    if (viaArray && !looksLikeSku(viaArray)) {
      var shape2 = findSkuByShape(data);
      if (shape2) return shape2;
    }
    return viaArray;
  };

  /**
   * 解析结果「像不像规格表」的体检。
   * 判据：至少 2 个组合、至少一半带价或库存、至少建出一个维度。
   * 导航标签、分类数组之类只有文字的东西过不了这一关。
   */
  function looksLikeSku(res) {
    if (!res || !res.list || res.list.length < 2) return false;
    var priced = res.list.filter(function (s) {
      return (s.price != null && s.price !== '') || (s.stock != null && s.stock !== '');
    }).length;
    if (priced < res.list.length * 0.5) return false;
    return !!(res.specDefs && res.specDefs.length);
  }

  /**
   * 形状兜底：完全不认识字段名时，靠「数组里每个元素长什么样」来认规格。
   *
   * 为什么需要：各家的 SKU 字段名没有共同标准（闲鱼/淘宝/1688 各叫各的，
   * 而且同一家还在改版）。穷举路径和深搜都认不出时，
   * 只能退一步看形状——「一组条目，每条都有规格文字 + 价格 + 数量」。
   *
   * 认得很保守，宁可漏也不误认：
   *   · 至少 2 条（单条的更可能是别的数组）
   *   · 至少 60% 的条目能拆出规格名
   *   · 至少 60% 的条目有价格或库存（只有文字没有价的，多半是标签/分类）
   */
  function findSkuByShape(data) {
    var best = null;

    function scan(node, depth) {
      if (!node || typeof node !== 'object' || depth > 7) return;
      if (best) return;
      if (Array.isArray(node)) {
        // 数组自身就长得像规格表？
        var objCount = node.filter(function (x) {
          return x && typeof x === 'object' && !Array.isArray(x);
        }).length;
        if (objCount >= 2 && objCount >= node.length * 0.6) {
          var probe = fromSkuArray(node);
          // 用与主流程同一套体检口径，避免两处标准不一致
          if (looksLikeSku(probe)) {
            best = probe;
            return;
          }
        }
        for (var i = 0; i < node.length && i < 40; i++) scan(node[i], depth + 1);
        return;
      }
      for (var k in node) {
        if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
        scan(node[k], depth + 1);
        if (best) return;
      }
    }

    try { scan(data, 0); } catch (e) {}
    return best;
  }

  // 1688 形态：{ "【6格】CD支架": { discountPrice, canBookCount, specAttrs, skuId }, ... }
  function fromSkuMap(map, root) {
    var specs = [];
    var specDefs = [];          // [{name, values:[{value, image}]}] → info.json 的 sku_specs
    var imgByName = {};
    // 规格名清单：用来分辨「键」到底是规格名还是别的东西。
    // 少了它就会把 skuPriceScale:"1.85-2.47" 这种价格区间当成规格收进来。
    var specNames = {};

    // 规格维度与规格图都在 skuProps 里：
    //   { prop:"颜色", value:[{ name:"【6格】CD支架", imageUrl:"https://cbu01..." }] }
    // 规格图是按规格名挂的，不在 SKU 明细字段上，所以必须单独取。
    var props = findSkuProps(map) || findSkuProps(root);
    if (props && props.length) {
      for (var t = 0; t < props.length; t++) {
        var pr = props[t];
        if (!pr || typeof pr !== 'object') continue;
        var dim = String(firstVal(pr, ['prop', 'propName', 'specName', 'name']) || '').trim();
        if (dim && specs.indexOf(dim) < 0) specs.push(dim);
        var vals = pr.value || pr.values || [];
        if (!Array.isArray(vals)) continue;
        var def = { name: dim, values: [] };
        for (var q = 0; q < vals.length; q++) {
          var ov = vals[q];
          if (!ov || typeof ov !== 'object') continue;
          var nm = String(firstVal(ov, ['name', 'value', 'propValue']) || '').trim();
          if (!nm) continue;
          specNames[nm] = 1;
          var im = firstVal(ov, ['imageUrl', 'image', 'picUrl', 'pic', 'img']);
          // 同一值出现多次图 URL 只取第一个，其余丢弃（规范 §5）
          if (im && !imgByName[nm]) imgByName[nm] = U.normalizeImageUrl(String(im));
          // 无图的值**照样占位**（规范 §4.1）：值序号不能跳，
          // 跳了后面所有值在发布页都会往上错一行。
          def.values.push({ value: nm, image: imgByName[nm] || '' });
        }
        if (dim && def.values.length) specDefs.push(def);
      }
    }

    var list = [];
    collect(map);
    if (!list.length) return null;
    return finish(specs, list, specDefs);

    /**
     * 递归收集 SKU 明细。
     * 1688 是 skuModel.skuInfoMap{规格名:明细}，明细还可能在更深的地方，
     * 所以要一层层往下找；同时要能分辨「容器」和「SKU 明细」——
     * 容器不含任何 SKU 特征字段，就继续下钻而不是收进来。
     */
    function collect(obj) {
      if (!obj || typeof obj !== 'object') return;
      var keys = Object.keys(obj);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        var o = obj[k];
        // 数组不是 SKU 明细：skuProps 会混进来，
        // typeof [] === 'object'，不排掉就会被当成一条假规格。
        if (Array.isArray(o)) continue;
        if (!o || typeof o !== 'object') {
          // 值不是对象时，键只有在确实是规格名的情况下才算一条规格，
          // 否则 skuPriceScale:"1.85-2.47" 这种价格区间会被误当成规格。
          if (typeof o === 'string' && o && specNames[k]) {
            list.push({ key: o, names: splitSpec(o), price: '', stock: '', image: imgByName[k] || '' });
          }
          continue;
        }
        var specName = firstVal(o, ['specAttrs', 'skuName', 'name']);
        var price = firstVal(o, ['discountPrice', 'price', 'salePrice', 'actualPrice']);
        var stock = firstVal(o, ['canBookCount', 'quantity', 'stock', 'availableQuantity']);
        var skuId = firstVal(o, ['skuId', 'id', 'specId']);
        // 至少认出一个 SKU 特征字段才收，否则这是个容器，继续往下钻
        if (specName == null && skuId == null && price == null && stock == null) {
          if (Object.keys(o).length) collect(o);
          continue;
        }
        var rawKey = specName == null ? k : String(specName);
        // 多维时把组合键还原成「维度值|维度值」（规范 §4.2）；
        // 还原不出来就保持原串，绝不猜。
        var attrNames = namesFromAttr(rawKey, specDefs);
        var key = attrNames ? attrNames.join('|') : rawKey;
        list.push({
          key: key,
          names: attrNames || splitSpec(rawKey),
          price: U.formatPrice(price),
          stock: (stock == null || stock === '') ? '' : String(stock),
          // 按**原始**属性串找图：多维组合在 imgByName 里本来就没有对应键，
          // 查不到就是没有组合级图（留空串），规格图仍由 sku_specs 逐值给出。
          image: imgByName[rawKey] || imgByName[key] || ''
        });
      }
    }
  }

  function splitSpec(s) {
    var out = [];
    String(s).split(/[\/｜|·,，]/).forEach(function (seg) {
      seg = seg.trim();
      if (seg) out.push(seg);
    });
    return out.length ? out : [String(s)];
  }

  /**
   * 淘宝/天猫专有形态（实测 tools/fixtures/tb-detail.json，mtop.taobao.pcdetail.data.get）：
   *
   *   skuBase.props[].values[]  { name, vid, image }   ← 维度名 + 值名 + **规格图在这里**
   *   skuBase.skus[].propPath   "1627207:35558819414"   ← 与 pid:vid 拼键精确对上
   *   skuCore.sku2info[skuId]   { subPrice.priceText, price.priceText, quantity }
   *
   * 为什么必须前置：通用数组分支的 deepFind 会先认到 `skuBase.skus`，
   * 而它的条目只有 propPath + skuId，`fromSkuArray` 拆不出名字就整条跳过，
   * 最后返回 null——图明明在 props 里却拿不到。多维的 propPath 用 `;` 分隔。
   */
  function fromTaobaoSkuBase(data) {
    var base = U.pickPath(data, 'skuBase');
    if (!base || !Array.isArray(base.props) || !Array.isArray(base.skus)) return null;
    if (!base.props.length || !base.skus.length) return null;

    var specs = [];
    var specDefs = [];
    var byPidVid = {};
    for (var i = 0; i < base.props.length; i++) {
      var pr = base.props[i];
      if (!pr || typeof pr !== 'object') continue;
      var dim = String(firstVal(pr, ['name', 'propName', 'nameDesc']) || '').trim();
      if (!dim) continue;
      if (specs.indexOf(dim) < 0) specs.push(dim);
      var def = { name: dim, values: [] };
      var vals = Array.isArray(pr.values) ? pr.values : [];
      for (var q = 0; q < vals.length; q++) {
        var ov = vals[q];
        if (!ov || typeof ov !== 'object') continue;
        var nm = String(firstVal(ov, ['name', 'value', 'propValue']) || '').trim();
        if (!nm) continue;
        var pid = String(pr.pid == null ? '' : pr.pid).trim();
        var vid = String(ov.vid == null ? '' : ov.vid).trim();
        if (pid && vid) byPidVid[pid + ':' + vid] = { dim: dim, value: nm };
        var im = firstVal(ov, ['image', 'imageUrl', 'picUrl', 'pic']);
        def.values.push({ value: nm, image: im ? U.normalizeImageUrl(String(im)) : '' });
      }
      if (def.values.length) specDefs.push(def);
    }
    if (!specDefs.length) return null;

    var infoMap = U.pickPath(data, 'skuCore.sku2info') || {};
    var list = [];
    for (var k = 0; k < base.skus.length; k++) {
      var s = base.skus[k];
      if (!s || typeof s !== 'object') continue;
      var propPath = String(firstVal(s, ['propPath', 'propPathStr']) || '');
      var ids = propPath.split(/[;；]/).map(function (x) { return x.trim(); }).filter(Boolean);
      var hit = false;
      var picked = [];
      for (var n = 0; n < ids.length; n++) {
        var e = byPidVid[ids[n]];
        if (!e) continue;
        hit = true;
        // 组合键的维度顺序必须与 sku_specs 一致（规范 §4.2），按下标重排
        for (var g = 0; g < specDefs.length; g++) {
          if (specDefs[g].name === e.dim) picked.push({ g: g, name: e.value });
        }
      }
      if (!hit || !picked.length) continue;
      picked.sort(function (a, b) { return a.g - b.g; });
      var names = picked.map(function (x) { return x.name; });

      var skuId = firstVal(s, ['skuId', 'id']);
      var info = skuId == null ? null : infoMap[String(skuId)];
      info = info && typeof info === 'object' ? info : null;
      var priceText = info && info.subPrice && info.subPrice.priceText != null
        ? info.subPrice.priceText
        : (info && info.price && info.price.priceText != null ? info.price.priceText : null);
      if (priceText == null) priceText = firstVal(s, ['price', 'priceText']);

      // 组合级图片下沉到「第一个有图的维度值」（规范 §5）
      var comboImg = '';
      for (var d = 0; d < specDefs.length && !comboImg; d++) {
        for (var vi = 0; vi < specDefs[d].values.length; vi++) {
          if (specDefs[d].values[vi].image) { comboImg = specDefs[d].values[vi].image; break; }
        }
      }

      list.push({
        key: names.join('|'),
        names: names,
        price: U.formatPrice(priceText),
        stock: info && info.quantity != null ? String(info.quantity) : '',
        image: comboImg
      });
    }
    if (!list.length) return null;
    return finish(specs, list, specDefs);
  }

  // 数组形态：{ skuName, price, quantity, props:[...] }
  /**
   * 数组形态的 SKU（多数站的形态）。
   *
   * ⚠️ 这条分支历来拿不到规格图：原来每个值都硬写 image:''，
   *    注释理由是「免得把别的维度的图错安到这个值上」。但代价太大——
   *    凡走这条路的商品（闲鱼很可能是其中之一），
   *    specDefs 里所有 image 都是空串，于是 images/sku/ 一张图都不产，
   *    info.json 的 sku_specs 也没有 image_url，软件彻底没法补。
   *
   * 现在的做法：把 SKU 条目上**明确属于该值**的图片挂上去
   * （组合级图对多维确实没有唯一归属，但对单维商品它就是唯一的那张），
   * 挂不上就留空串——仍然不造假，但至少不主动放弃唯一可得的图。
   */
  function fromSkuArray(arr) {
    var specs = [];
    var specDefs = [];
    var defByName = {};
    var list = [];
    for (var k = 0; k < arr.length; k++) {
      var o = arr[k];
      if (!o || typeof o !== 'object') continue;

      var names = [];
      var props = firstVal(o, ['props', 'specs', 'properties', 'skuProps', 'propList']);
      if (Array.isArray(props)) {
        for (var p = 0; p < props.length; p++) {
          var pr = props[p];
          if (!pr || typeof pr !== 'object') continue;
          var pn = firstVal(pr, ['propName', 'name', 'specName', 'key', 'prop']) || '';
          var pv = firstVal(pr, ['value', 'propValue', 'val', 'valueName']) || '';
          pn = String(pn).trim();
          if (pn && specs.indexOf(pn) < 0) specs.push(pn);
          pv = String(pv).trim();
          if (pn && pv) names.push(pv);
          if (pn && pv) {
            var def = defByName[pn];
            if (!def) {
              def = { name: pn, values: [] };
              defByName[pn] = def;
              specDefs.push(def);
            }
            if (!def.values.some(function (v) { return v.value === pv; })) {
              // 图片优先取**这个属性自己**带的；没有再退回整条 SKU 的图。
              // 属性级图是唯一能确定归属的，组合级图只对单维有效。
              var own = firstVal(pr, ['imageUrl', 'image', 'picUrl', 'pic', 'img']);
              def.values.push({
                value: pv,
                image: own ? U.normalizeImageUrl(String(own)) : ''
              });
            }
          }
        }
      }
      // 没拆到属性级时退回整条规格名（"红色/M码" 这种）
      //
      // 这里必须**自己建 specDefs**：以前只往 names 里塞字符串，
      // 结果 specDefs 是空的 → 规格图无处可挂 → images/sku/ 一张都不产。
      // 闲鱼很可能就走这条分支（实测样本待补），没有它等于没实现。
      // 维度名用「规格」占位：接口没给维度名时，宁可叫「规格」
      // 也不能让软件对不上行（规范 §4.1 的值序号必须连续）。
      var DEFAULT_DIM = '规格';
      if (!names.length) {
        var whole = firstVal(o, ['skuName', 'skuDesc', 'name', 'key', 'propText']);
        if (whole) {
          String(whole).split(/[\/｜|·,，]/).forEach(function (seg) {
            seg = seg.trim();
            if (!seg) return;
            names.push(seg);
            // 单维时归到占位维度下；多维（拆出 2 段以上）时
            // 无法确定维度归属，仍归到占位维度——至少值序号是连续的。
            var def = defByName[DEFAULT_DIM];
            if (!def) {
              def = { name: DEFAULT_DIM, values: [] };
              defByName[DEFAULT_DIM] = def;
              specDefs.push(def);
              if (specs.indexOf(DEFAULT_DIM) < 0) specs.push(DEFAULT_DIM);
            }
            if (!def.values.some(function (v) { return v.value === seg; })) {
              def.values.push({ value: seg, image: '' });
            }
          });
        }
      }
      if (!names.length) continue;

      var price = firstVal(o, ['price', 'skuPrice', 'salePrice', 'actualPrice', 'priceShow']);
      var stock = firstVal(o, ['quantity', 'stock', 'skuStock', 'availableQuantity', 'inventory']);
      var img = firstVal(o, ['imageUrls', 'image', 'pic', 'picUrl', 'images', 'skuImage']);
      var rowImg = img ? U.normalizeImageUrl(String(Array.isArray(img) ? img[0] : img)) : '';

      // 组合级图留到循环结束后统一挂：这里 specDefs 还没长全，
      // 现在判断「是不是只有一个维度」会拿到错误的中间态。
      list.push({
        // 与 fromSkuMap / fromXianyuSkuList 一致用 | 连接（规范 §4.2）
        key: names.join('|'),
        names: names,
        price: U.formatPrice(price),
        stock: (stock == null || stock === '') ? '' : String(stock),
        image: rowImg
      });
    }
    if (!list.length) return null;

    // 统一挂组合级图。只有「整个商品就一个维度」时才算确定归属——
    // 那时这张图唯一地属于某个规格值。多维时挂上去就是造假（规范 §5），
    // 一律留空，等属性级图或 DOM 兜底来补。
    if (specDefs.length === 1) {
      var dim = specDefs[0];
      list.forEach(function (row) {
        if (!row.image || !row.names) return;
        for (var vi = 0; vi < dim.values.length; vi++) {
          if (row.names.indexOf(dim.values[vi].value) >= 0) {
            if (!dim.values[vi].image) dim.values[vi].image = row.image;
            break;
          }
        }
      });
    }

    return finish(specs, list, specDefs);
  }

  function finish(specs, list, specDefs) {
    if (!list.length) return null;
    // 同一规格组合会重复出现，去重
    var seen = {};
    var uniqList = [];
    list.forEach(function (s) {
      if (seen[s.key]) return;
      seen[s.key] = 1;
      uniqList.push(s);
    });
    return { specs: specs, specDefs: specDefs || [], list: uniqList };
  }

  /**
   * 从「规格属性串」里还原出各维度的**值名**，顺序按 specDefs（规范 §4.2）。
   *
   * 1688 的 specAttrs 形态实测有两种：
   *   单维：`【8格】CD支架`                     —— 直接就是值名
   *   多维：`颜色:红;尺码:M` / `颜色:红;尺码:L` —— 维度名:值名，; 分隔
   * 单维样本只有第一种（dist/laputa-sku-sample.json），
   * 第二种是按 1688 skuProps 的 prop/value 结构推的，**没有真实样本验证**，
   * 所以这里对认不出的形态一律退回 splitSpec 的老行为，
   * 宁可 key 不标准，也不要把价格/库存挂到错的行上。
   */
  function namesFromAttr(attrText, specDefs) {
    var raw = String(attrText == null ? '' : attrText).trim();
    if (!raw || !specDefs || specDefs.length < 2) return null;

    var pairs = [];
    raw.split(/[;；]/).forEach(function (seg) {
      seg = seg.trim();
      if (!seg) return;
      var m = seg.match(/^([^:：]+)[:：](.*)$/);
      if (m) pairs.push({ dim: m[1].trim(), val: m[2].trim() });
      else pairs.push({ dim: null, val: seg });
    });
    // 一个都没拆出「维度:值」就说明不是多维形态，别硬套
    if (!pairs.length || !pairs.some(function (p) { return p.dim; })) return null;

    // 按 specDefs 顺序取值，而不是按 pairs 的原始顺序——规范 §4.2 要求
    // 组合键的维度顺序与 sku_specs 一致，软件那边是按下标对齐的。
    var out = [];
    var used = {};
    specDefs.forEach(function (d, gi) {
      var hit = null;
      for (var i = 0; i < pairs.length; i++) {
        if (used[i]) continue;
        if (pairs[i].dim && pairs[i].dim === d.name) { hit = i; break; }
      }
      if (hit == null) {
        for (var j = 0; j < pairs.length; j++) {
          if (!used[j]) { hit = j; break; }   // 维度名对不上就按顺序兜底
        }
      }
      if (hit == null) return;
      used[hit] = 1;
      var val = pairs[hit].val;
      // 值名以 skuProps 为准（那边才是用户看到的原名）
      for (var k = 0; k < (d.values || []).length; k++) {
        if (d.values[k].value === val) { val = d.values[k].value; break; }
      }
      out.push({ idx: gi, name: val });
    });
    if (out.length !== specDefs.length) return null;   // 对不齐就放弃，走老路
    out.sort(function (a, b) { return a.idx - b.idx; });
    return out.map(function (o) { return o.name; });
  }

  // 规格表转文字，追加进文案
  U.formatSkus = function (skus) {
    if (!skus || !skus.list || !skus.list.length) return '';
    var lines = ['【规格与价格】'];
    if (skus.specs && skus.specs.length) lines.push('规格：' + skus.specs.join(' / '));
    skus.list.forEach(function (s) {
      var seg = s.key + (s.price ? ' ¥' + s.price : '');
      if (s.stock) seg += ' 库存' + s.stock;
      lines.push('· ' + seg);
    });
    return lines.join('\n');
  };

  /* ---------------- 落盘结构 ----------------

     下载产物的目录约定（各平台统一，铺货软件按这个结构读），
     对接规范见 sku_image_contract.md v1.0：

       <下载目录>/downloaded_items/<商品夹>/
         ├── info.json        商品元数据，软件靠它识别商品
         ├── images/          主图，文件名就是序号
         │   └── sku/         规格图单独一层，别混进主图
         │        ├── 1_1_红色.jpg      维度1的值1
         │        └── 1_2_蓝色.jpg      维度1的值2（无图的维度值不产文件）
         ├── video/           主图视频
         └── 文案.txt

     info.json 里的 local_images / sku_specs[].values[].local_image
     必须和真实落盘文件名**严格一致**，所以文件名一律由下面这几个函数
     单点生成，谁都不许自己拼字符串。
--------------------------------------------------------------------------- */
  U.IMAGES_DIR = 'images';
  U.SKU_DIR = 'images/sku';
  U.VIDEO_DIR = 'video';
  U.INFO_FILE = 'info.json';

  /**
   * 商品目录里的「ID 标记文件」名。
   *
   * 为什么需要它（用户提出、要根治的方案）：
   *   storage.local 按扩展 ID 隔离，解压重装后历史清零，
   *   于是昨天下过的今天又下一遍。而 info.json 能否被认出来，
   *   取决于目录名 —— 默认模板是 `{shop}_{title}_{itemId}`，
   *   **卖家一改标题，目录名就变了，按 info.json 判重立刻失效**。
   *
   * 这个文件名**只由站点+商品ID 决定，与标题、店铺、日期全都无关**，
   * 所以标题改了、店铺改名了、日期变了，它都还在同一个位置。
   * 判重只看它在不在，不需要读它的内容（扩展也没有读本地文件的权限），
   * 所以只用 chrome.downloads.search 判断存在性即可 —— 跨浏览器、跨重装都认。
   */
  U.ID_MARK_FILE = '已下载标识.txt';

  /** ID 标记文件名，如「已下载标识_xy_844934128301.txt」 */
  U.idMarkFileName = function (site, itemId) {
    var key = U.itemKey(site, itemId);
    if (!key) return '';
    return '已下载标识_' + key + '.txt';
  };

  /** 主图文件名：1.jpg / 2.webp …（序号同时也是顺序，也就是优先级） */
  U.imageFileName = function (url, index) {
    return (index + 1) + U.imageExt(url);
  };

  /**
   * 规格图文件名（对接规范 §2）：
   *
   *   images/sku/<维度序号>_<值序号>_<安全值名>.<ext>
   *
   * 维度序号 / 值序号都从 1 起。值序号**按 sku_specs 里的原始顺序**，
   * 无图的值也要占位——发布页是按下标对齐的，跳过一个后面全错行。
   *
   * 文件名由这一个函数单点生成：下载侧和 info.json 侧共用，
   * 两边各拼一次字符串迟早会对不上。
   */
  U.skuSpecImageName = function (specIdx, valIdx, valueName, url) {
    var name = U.sanitizeSpecName(valueName, 40);
    return (specIdx + 1) + '_' + (valIdx + 1) + '_' + name + U.imageExt(url || '');
  };

  /** 某个维度值的相对路径，空图返回 ''（规范 §3：空串 = 无图，不是 null） */
  U.skuSpecLocalImage = function (specIdx, valIdx, def) {
    var val = def && def.values && def.values[valIdx];
    if (!val || !val.image) return '';
    return U.SKU_DIR + '/' + U.skuSpecImageName(specIdx, valIdx, val.value, val.image);
  };

  /**
   * info.json 的内容。
   *
   *   meta    { title, description, price }
   *   images  主图地址数组
   *   skus    { specs, specDefs, list }
   *   videos  [{ url, duration, cover, localVideo?, failed? }]
   *   realPaths  可选。**下载侧回传的真实落盘路径** { <图片URL>: '<真实相对路径>' }。
   *
   *   为什么需要它：下载层做了去重后，同一张图只会落盘一次。
   *   第二个规格值如果图一样，它自己的路径下**并没有文件**，
   *   照常写就会让软件读到不存在的路径。所以路径一律以下载侧
   *   回传的真实值为准，没有回传时才用推算值。
   *
   * 输出三段（对接规范 §3）：
   *   sku_info  组合行 —— name 是各维度值用 `|` 连接的组合键，填价/库存照用
   *   sku_specs 维度值级 —— 值↔图片的权威映射，软件按 [g].values[v] 下标对齐
   *   videos    视频段 —— local_video 相对路径 + video_url 原始地址
   *
   * ⚠️ sku_info 不再带 local_image：规格图改成「维度值级」落盘后，
   * 一个组合可能对应多张图（多维），组合行没有唯一的图可指；
   * 指向不存在的文件比干脆不写更糟。软件侧改读 sku_specs。
   */
  U.buildInfo = function (meta, images, skus, videos, realPaths) {
    meta = meta || {};
    var imgs = (images || []).filter(Boolean);
    var list = (skus && skus.list) || [];
    var specDefs = (skus && skus.specDefs) || [];
    var vids = videos || [];
    var rp = realPaths || {};          // 图片URL → 真实落盘相对路径

    /**
     * 取某张图真实落在哪。
     * 下载层去重后，第二个规格值图相同的话它自己的路径下并没有文件，
     * 必须用下载侧回传的真实路径，否则 info.json 会指向不存在的文件。
     */
    function realPathOf(url, fallback) {
      if (!url) return '';
      return rp[url] || fallback || '';
    }

    var skuInfo = [];
    list.forEach(function (s) {
      if (!s) return;
      skuInfo.push({
        name: s.key || '',
        price: s.price != null ? String(s.price) : '',
        stock: s.stock != null ? String(s.stock) : ''
      });
    });
    var skuSpecs = specDefs.map(function (def, g) {
      return {
        name: def.name || '',
        values: (def.values || []).map(function (val, v) {
          var row = { value: val.value || '' };
          // 有真实路径就用它；没有才退回按序号推算的路径
          row.local_image = val.image
            ? realPathOf(val.image, U.skuSpecLocalImage(g, v, def))
            : '';                              // 空串 = 无图（规范 §3）
          if (val.image) row.image_url = val.image;   // 建议字段：本地丢了可兜底重下
          return row;
        })
      };
    });
    return {
      title: meta.title || '',
      description: meta.description || '',
      price: meta.price != null ? String(meta.price) : '',
      sku_info: skuInfo,
      sku_specs: skuSpecs,
      local_images: imgs.map(function (u, i) {
        return realPathOf(u, U.IMAGES_DIR + '/' + U.imageFileName(u, i));
      }),
      // 视频段。local_video 是相对路径；m3u8 合并成功才是 .mp4，
      // 合并失败时 local_video 留空、只给 video_url，软件那边能判断该不该重试。
      videos: vids.map(function (v, i) {
        var row = {
          index: i,
          local_video: v.localVideo || '',
          video_url: v.url || '',
          duration: v.duration != null ? String(v.duration) : ''
        };
        if (v.cover) row.cover = v.cover;
        if (v.failed) row.failed = v.failed;
        return row;
      })
    };
  };

  /* ---------------- 目录名 / 文案生成 ---------------- */

  /**
   * 商品的「站点内唯一键」—— 跨批次判重靠它。
   *
   * ⚠️ **必须带站点前缀**：各站的数字 ID 真的会撞车。
   *    闲鱼的 123、淘宝的 123、1688 的 123、京东的 123 是四件完全不同的商品，
   *    只按 ID 去重会漏下别的站的东西（用户明确提过这个风险）。
   *
   * 前缀沿用各站既有的 key，别另造一套，免得两处对不上。
   */
  U.itemKey = function (site, itemId) {
    var id = String(itemId == null ? '' : itemId).trim();
    if (!id) return '';
    var prefix = U.sitePrefix(site);
    if (!prefix) return '';      // 认不出的站点不去重，宁可多下也不能误跳
    return prefix + '_' + id;
  };

  /** 站点 → ID 前缀 */
  U.sitePrefix = function (site) {
    var k = String(site || '').trim().toLowerCase();
    if (!k) return '';
    // 闲鱼（含 xianyu.com / goofish.com 两个域名）
    if (k === 'xianyu' || k === 'goofish') return 'xy';
    // 淘宝与天猫共用一套 ID 体系，必须统一前缀，否则同一件商品在
    // 淘宝和天猫下会算成两件
    if (k === 'taobao' || k === 'tmall' || k === 'tmallhk') return 'tb';
    if (k === 'p1688' || k === '1688') return 'al';
    if (k === 'jd') return 'jd';
    // 新站点：直接用自己的 key 当前缀。判重照样生效，
    // 总比「不认识就不去重」导致天天重复下载要好。
    return k;
  };

  U.buildDirName = function (data, template) {
    var tpl = template || '{shop}_{title}_{itemId}';
    var map = {
      shop: data.sellerNick || '未知店铺',
      title: data.title || '未命名',
      itemId: data.itemId || '0',
      price: data.price || '0',
      date: new Date().toISOString().slice(0, 10)
    };
    var s = tpl.replace(/\{(\w+)\}/g, function (_, k) {
      return map[k] != null ? String(map[k]) : '';
    });
    // 变量内的非法字符也要处理，之后再整体截断
    return U.cleanFileName(s, 80);
  };

  U.buildText = function (data, format) {
    format = (format || 'txt').toLowerCase();
    var lines = [];
    lines.push('标题：' + (data.title || ''));
    lines.push('价格：' + (data.price ? '¥' + data.price : ''));
    lines.push('店铺：' + (data.sellerNick || ''));
    if (data.sellerUrl) lines.push('店铺主页：' + data.sellerUrl);
    if (data.location) lines.push('所在地：' + data.location);
    if (data.wantNum) lines.push('想要人数：' + data.wantNum);
    if (data.browseNum) lines.push('浏览人数：' + data.browseNum);
    lines.push('商品链接：' + (data.url || ''));
    lines.push('');
    lines.push('【商品描述】');
    lines.push(data.desc || data.title || '');
    lines.push('');
    if (data.images && data.images.length) {
      lines.push('【主图地址】');
      data.images.forEach(function (u, i) {
        lines.push((i + 1) + '. ' + u);
      });
    }
    var skuText = U.formatSkus(data.skus);
    if (skuText) {
      lines.push('');
      lines.push(skuText);
    }
    var body = lines.join('\n');

    if (format === 'json') {
      return JSON.stringify(data, null, 2);
    }
    if (format === 'md') {
      var md = [];
      md.push('# ' + (data.title || ''));
      md.push('');
      md.push('- 价格：¥' + (data.price || '-'));
      md.push('- 店铺：' + (data.sellerNick || '-'));
      md.push('- 链接：' + (data.url || ''));
      if (data.location) md.push('- 所在地：' + data.location);
      md.push('');
      md.push('## 商品描述');
      md.push('');
      md.push(data.desc || data.title || '');
      md.push('');
      if (data.images && data.images.length) {
        md.push('## 主图');
        md.push('');
        data.images.forEach(function (u) {
          md.push('![](' + u + ')');
        });
      }
      return md.join('\n');
    }
    return body;
  };

  U.textExt = function (format) {
    return format === 'json' ? '.json' : format === 'md' ? '.md' : '.txt';
  };

  /**
   * 校验「保存到下载目录」这个设置。
   *
   * Chrome 的 downloads.download({filename}) 只接受相对「默认下载目录」的路径，
   * 官方文档原话：
   *   "Absolute paths, empty paths, and paths containing back-references '..'
   *    will be ignored."
   * 也就是说填 D:\我的采集 这种绝对路径**不会报错，只是被忽略**，
   * 文件悄悄落回默认下载目录 —— 用户会以为插件坏了。所以提前拦下来说明白。
   *
   * 想存到别的盘 / 别的文件夹，办法是把 Chrome 的「下载」默认目录改过去
   * （chrome://settings/downloads），这里再填它下面的子目录名。
   *
   * @returns {{ok:boolean, msg:string}} ok=false 时 msg 是要给用户看的人话
   */
  U.checkSaveDir = function (v) {
    var s = String(v == null ? '' : v).trim();
    if (!s) return { ok: true, msg: '' };
    // 盘符：D:\xxx、D:/xxx
    if (/^[a-zA-Z]:/.test(s)) {
      return { ok: false, msg: '这是绝对路径。浏览器只认「下载」文件夹下的子目录，' +
        '请只填子文件夹名字（例如：闲鱼采集/1688）；想存到别的盘，' +
        '先在 chrome://settings/downloads 里把「下载」目录改过去。' };
    }
    if (/^[\\/]/.test(s)) {
      return { ok: false, msg: '不能以斜杠开头，请只填「下载」文件夹下的子目录名字。' };
    }
    if (s.indexOf('..') >= 0) {
      return { ok: false, msg: '不能包含 ".."：浏览器会直接把这段路径忽略掉。' };
    }
    if (s.charAt(0) === '~') {
      return { ok: false, msg: '不支持 ~ 写法，请填相对「下载」文件夹的路径。' };
    }
    return { ok: true, msg: '' };
  };

  global.XYUtil = U;
})(typeof window !== 'undefined' ? window : globalThis);
