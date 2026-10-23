/**
 * Background Service Worker (MV3)
 * 只负责"落地到磁盘"的事情：图片下载、文案保存、目录组织。
 * 数据提取一律在页面侧完成，SW 只接收纯数据。
 */
importScripts('/src/common/sites.js');
importScripts('/src/common/util.js');

var U = self.XYUtil;
var SITES = self.XYSites;

var DEFAULTS = {
  textFormat: 'txt',
  // 商品夹用 ID：不重名、无非法字符，软件靠 info.json 认商品
  dirTemplate: '{itemId}',
  saveDir: 'downloaded_items',
  panelEnabled: true,
  autoCopyTip: true,
  // 给 1688 图片下载补 Referer，绕防盗链（见下面 HOTLINK_RULES）
  hotlinkFix: true
};

/**
 * 防盗链兜底：chrome.downloads.download() 不支持自定义请求头，
 * 想给下载加 Referer 只能走 declarativeNetRequest 改请求头。
 * 规则在 install / startup 时装一次，用固定 ID，不做临时增删——
 * 动态规则表有数量上限，批量场景里反复装删不划算，也容易撞 ID。
 *
 * 覆盖面刻意收窄到 1688 自己的图床：cbu*.alicdn.com 就是 1688 主图 CDN。
 * 闲鱼商品图也挂在 alicdn 主域下，一起改反而可能把本来能下的图搞挂，
 * 所以这里不动 *.alicdn.com 泛指，只点名 1688 的图床和 1688 域名本身。
 */
var HOTLINK_RULES = [
  {
    id: 45056,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { header: 'Origin', operation: 'set', value: 'https://www.1688.com' },
        { header: 'Referer', operation: 'set', value: 'https://www.1688.com/' }
      ]
    },
    condition: { urlFilter: '*://cbu*.alicdn.com/*', resourceTypes: ['image', 'media'] }
  },
  {
    id: 45057,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { header: 'Origin', operation: 'set', value: 'https://www.1688.com' },
        { header: 'Referer', operation: 'set', value: 'https://www.1688.com/' }
      ]
    },
    condition: { urlFilter: '*://*.1688.com/*', resourceTypes: ['image', 'media'] }
  }
];

// 我们自己的规则 ID 段，清理时用
var HOTLINK_ID_MIN = 45050;
var HOTLINK_ID_MAX = 45060;

function hotlinkIdsInstalled() {
  var out = [];
  HOTLINK_RULES.forEach(function (r) {
    if (r.id >= HOTLINK_ID_MIN && r.id < HOTLINK_ID_MAX) out.push(r.id);
  });
  return out;
}

/**
 * 按设置项同步防盗链规则：关掉就先摘干净再装，
 * 避免「关了之后规则还留着」这种改了设置却没效果的情况。
 */
function syncHotlinkRules() {
  try {
    chrome.storage.sync.get({ hotlinkFix: true }, function (s) {
      var want = !(s && s.hotlinkFix === false);
      chrome.declarativeNetRequest.getDynamicRules(function (rules) {
        var stale = (rules || [])
          .map(function (r) { return r.id; })
          .filter(function (id) { return id >= HOTLINK_ID_MIN && id < HOTLINK_ID_MAX; });
        if (!want) {
          if (stale.length) {
            chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: stale });
          }
          return;
        }
        chrome.declarativeNetRequest.updateDynamicRules(
          { removeRuleIds: stale },
          function () {
            chrome.declarativeNetRequest.updateDynamicRules({ addRules: HOTLINK_RULES });
          }
        );
      });
    });
  } catch (e) {
    // declarativeNetRequest 在极老版本上没有，装不上就算了，别影响打包主流程
  }
}

// 这条是顶层语句，注册失败会连累后面所有监听一起注册不上，
// 所以判一下存在性——防盗链只是增强，不值得让整个 SW 哑掉。
if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(function () {
    syncHotlinkRules();
  });
}

chrome.runtime.onInstalled.addListener(function (info) {
  chrome.storage.sync.get(DEFAULTS, function (s) {
    chrome.storage.sync.set(Object.assign({}, DEFAULTS, s || {}));
  });
  syncHotlinkRules();

  // 更新/重装之后，已经开着的站点标签里的内容脚本还属于旧实例：
  // 它拿不到扩展 API，一点打包就报
  //   Cannot read properties of undefined (reading 'sendMessage')
  // 让用户手动刷新很容易忘，所以这里直接把相关标签刷新一遍，
  // 让内容脚本按新版本重新注入。只碰我们自己的站点，别的页面一律不动。
  if (info && (info.reason === 'update' || info.reason === 'install')) {
    // 必须覆盖 manifest 里全部站点，漏一个它就会一直报上下文失效。
    // （之前漏了 jd.com 和 tmall.hk。）
    var HOSTS = ['https://*.1688.com/*', 'https://*.xianyu.com/*', 'https://*.goofish.com/*',
      'https://*.taobao.com/*', 'https://*.tmall.com/*',
      'https://*.tmall.hk/*', 'https://*.jd.com/*'];
    // 整段包 try：onInstalled 里同步抛错会让整个安装流程看起来失败，
    // 而这里失败的后果是用户接下来每一批打包都报「上下文已失效」。
    try {
      chrome.tabs.query({ url: HOSTS }, function (tabs) {
        if (chrome.runtime.lastError) return;      // 查不到就放弃自愈，交给前端 location.reload
        (tabs || []).forEach(function (t) {
          try { chrome.tabs.reload(t.id); } catch (e) {}
        });
      });
    } catch (e) {}
  }
});

/* ---------------- 工具 ---------------- */

function safeName(name) {
  return U.cleanFileName(name, 120);
}

/**
 * 目录路径：逐段清理非法字符后重新拼回，
 * 不能整体 cleanFileName——那会把 "闲鱼采集/iPad" 斜杠吃掉，
 * 导致所有商品的目录被拍平到同一层。
 *
 * 另外要剔掉 ".." 和盘符开头的段：Chrome 的 downloads.download({filename})
 * 只认相对「默认下载目录」的路径，官方文档说绝对路径和 ".." 会被
 * **忽略**（不是报错）——所以要在这儿自己切干净，
 * 免得用户填了 D:\xxx 结果文件悄悄落到「下载」根目录。
 */
function safePath(p) {
  var out = [];
  String(p || '闲鱼采集')
    .split('/')
    .forEach(function (seg) {
      if (!seg) return; // 连写斜杠产生的空段
      // 盘符要在清理之前认出来：cleanFileName 会把冒号一起删掉，之后就认不出了
      var drive = seg.match(/^\s*[a-zA-Z]\s*[:：]\s*(.*)$/);
      var raw = drive ? drive[1] : seg;
      if (!raw || !raw.trim() || raw.trim() === '.' || raw.trim() === '..') return;
      var name = U.cleanFileName(raw, 120).replace(/^\.+/, '');
      if (!name || name === '.' || name === '..') return;
      out.push(name);
    });
  return out.join('/');
}

// 文本 -> data URL（SW 中没有 URL.createObjectURL）
function textToDataUrl(text, format) {
  var mime = format === 'json' ? 'application/json' : 'text/plain';
  return 'data:' + mime + ';charset=utf-8,' + encodeURIComponent(text);
}

/**
 * 有限并发的任务泵：顺序取任务、同时最多 limit 个
 *
 * 完成条件是「任务取完 **且** 在跑的都收尾了」——
 * 以前只判断前者（next() 取不到任务就 resolve），于是并发位没占满时会提前结算：
 * 比如只有 2 个任务、上限 3，两个同时启动，
 * 快的那个（info.json 走 data URL，几乎瞬时）一完成就把泵 resolve 了，
 * 慢的（网络图片）还在下 —— 调用方拿到的计数就是 0。
 * 京东搜索页每个商品只有 1 张主图，正好是这个形状，表现成「图片 0/1 张」，
 * 让人以为一张都没下。
 *
 * @param {Array<function():Promise<boolean>>} tasks
 */
function pump(tasks, limit) {
  return new Promise(function (resolve) {
    var list = tasks || [];
    if (!list.length) return resolve({ ok: 0, fail: 0 });
    var idx = 0, ok = 0, fail = 0, running = 0, settled = false;

    function finish() {
      if (settled) return;
      settled = true;
      resolve({ ok: ok, fail: fail });
    }

    function next() {
      if (idx >= list.length) {
        // 都取完了：还得等在跑的清零，否则会提前结算
        if (running === 0) finish();
        return;
      }
      var t = list[idx++];
      running++;
      var chained;
      try {
        chained = Promise.resolve().then(t);
      } catch (ex) {
        fail++;
        running--;
        return next();
      }
      chained.then(function (r) {
        if (r) ok++; else fail++;
      }, function () {
        fail++;
      }).then(function () {
        running--;
        next();
      });
    }

    var n = Math.max(1, Math.min(limit || 2, list.length));
    for (var k = 0; k < n; k++) next();
  });
}

/**
 * 下载一组视频到 <dir>/video/。
 * 「只下视频」和「一键打包」共用这一份逻辑——两条路必须产出同样的文件，
 * 否则用户会发现单独下的视频和打包里的对不上。
 *
 * @param results 输出数组，按下标写入，供 info.json 生成 local_video
 * @param onOk    每成功一个回调一次（打包时要累加计数）
 */
function downloadVideosInto(dir, videos, results, errors, onOk) {
  var errs = errors || [];
  return pump((videos || []).map(function (v, vi) {
    return function () {
      // keepQuery=true：OSS 签名地址剥掉 ?auth_key 就 403
      var url = U.normalizeVideoUrl(v && v.url, true);
      if (!url) {
        results[vi] = { url: '', localVideo: '', failed: '地址不合法' };
        if (errs.length < 10) errs.push('视频地址不合法');
        return false;
      }
      var path = dir + '/' + U.videoLocalPath(vi);

      function fail(reason) {
        results[vi] = { url: url, localVideo: '', failed: reason };
        if (errs.length < 10) errs.push(reason);
        return false;
      }
      function done() {
        results[vi] = {
          url: url, localVideo: path,
          duration: v.duration != null ? String(v.duration) : ''
        };
        if (v.cover) results[vi].cover = v.cover;
        if (typeof onOk === 'function') onOk();
        return true;
      }

      if (/\.m3u8(\?|$)/i.test(url)) {
        return fetchM3u8Video(url).then(function (res) {
          if (!res.ok) return fail('视频合并失败：' + res.error);
          return bufferToDownload(res.buffer, 'video/mp4', path)
            .then(function (ok2) { return ok2 ? done() : fail('视频落盘失败'); });
        });
      }

      return download({
        url: url, filename: path, conflictAction: 'uniquify', saveAs: false
      }).then(function (r) { return r.ok ? done() : fail(r.error); });
    };
  }), 2);
}

/**
 * ArrayBuffer → 落盘。m3u8 合并出来的 mp4 只能走这条路（不是 http 地址）。
 *
 * 用 base64 data URL 而不是 URL.createObjectURL：
 * MV3 的 service worker 里没有 DOM，URL.createObjectURL 不可用；
 * data URL 是 downloads 唯一能吃的非 http(s) 方案。
 * 代价是 base64 会膨胀 33%、占内存——视频通常几 MB，批量时靠并发 2 压住。
 */
function bufferToDownload(buffer, mime, filename) {
  return new Promise(function (resolve) {
    try {
      var bytes = new Uint8Array(buffer);
      // 分块转，避免 apply 传几十万参数直接爆栈
      var bin = '';
      var CH = 8192;
      for (var i = 0; i < bytes.length; i += CH) {
        bin += String.fromCharCode.apply(
          null, bytes.subarray(i, Math.min(i + CH, bytes.length))
        );
      }
      var url = 'data:' + (mime || 'video/mp4') + ';base64,' + btoa(bin);
      chrome.downloads.download(
        { url: url, filename: filename, conflictAction: 'uniquify', saveAs: false },
        function (id) { resolve(!chrome.runtime.lastError && !!id); }
      );
    } catch (e) {
      resolve(false);
    }
  });
}

/**
 * 视频下载。mp4/mov/webm 直接下；m3u8 必须自己合并分片。
 *
 * 为什么必须合并：直播形态和一部分商品视频给的是 .m3u8 播放列表，
 * 直接 downloads 下来的是几 KB 的索引文本，软件那边完全没法用。
 * 这里把分片按顺序拉下来拼成 Blob 再当文件落盘。
 *
 * 注意 fetch 要带 Referer：阿里云 OSS 的视频桶多数开了防盗链，
 * 空 Referer 会 403（图片那边已有同样处理）。
 */
function fetchBinary(url, referer) {
  return fetch(url, {
    credentials: 'omit',
    headers: referer ? { Referer: referer } : {}
  }).then(function (res) {
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.arrayBuffer();
  });
}

function originOf(url) {
  var m = String(url || '').match(/^(https?:\/\/[^/]+)/i);
  return m ? m[1] + '/' : '';
}

/**
 * 拉取并合并一个 m3u8 视频。
 * @returns {Promise<{ok:boolean, buffer?:ArrayBuffer, error?:string}>}
 */
function fetchM3u8Video(url) {
  var referer = originOf(url);
  return fetchBinary(url, referer).then(function (buf) {
    var text = new TextDecoder('utf-8').decode(new Uint8Array(buf));
    var segs = U.parseM3u8(text, url);
    if (!segs.length) {
      // 加密清单 / master 清单 / 响应不是清单 —— 都产不出可用视频
      return { ok: false, error: 'm3u8 无法解析（加密/master/非清单）' };
    }
    // 片段可能几百个，按下标占位保证顺序（pump 是并发执行，顺序必须靠下标固定）
    var chunks = new Array(segs.length);
    return pump(segs.map(function (s, i) {
      return function () {
        return fetchBinary(s, referer).then(function (b) {
          chunks[i] = b;
          return true;
        });
      };
    }), 6).then(function (r) {
      if (r.fail) return { ok: false, error: r.fail + '/' + segs.length + ' 个分片失败' };
      var total = 0;
      for (var k = 0; k < chunks.length; k++) {
        if (!chunks[k]) return { ok: false, error: '分片缺失：' + k };
        total += chunks[k].byteLength;
      }
      // base64 落盘会膨胀 33%，service worker 内存有限（超了直接被杀）。
      // 超过 80MB 就别硬拼了——交出地址让软件侧自己下，比静默丢文件好。
      if (total > 80 * 1024 * 1024) {
        return { ok: false, error: '视频过大（' + Math.round(total / 1048576) + 'MB），已跳过' };
      }
      var out = new Uint8Array(total);
      var off = 0;
      for (var m = 0; m < chunks.length; m++) {
        out.set(new Uint8Array(chunks[m]), off);
        off += chunks[m].byteLength;
      }
      return { ok: true, buffer: out.buffer };
    });
  }).catch(function (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  });
}

/**
 * 下载去重。
 *
 * 为什么需要：同一张图在一次批量里会被反复请求到。实测过的几种情况：
 *   · 闲鱼/1688 的列表页给的缩略图和详情接口给的 imageInfos 大量重叠
 *   · 同一商品的多个规格值指向同一张图（尤其无图维度，图会落到同一个值上）
 *   · 批量里多件商品共用同一张图（同店同款、不同买家复用的同一张图）
 * 结果是同一个 URL 被 downloads.download 发起多次，
 * conflictAction:'uniquify' 又会让它们存成 1.jpg / 1(1).jpg / 1(2).jpg——
 * **磁盘上多出一堆重复图，info.json 里只有第一个路径指向真实文件**。
 *
 * 去重的键用「URL 去掉签名参数后的干净形式」：阿里云 OSS 的
 * a.jpg?auth_key=X 和 a.jpg?auth_key=Y 是同一张图，但都会真实下载，
 * 只按完整 URL 去重等于没去。
 *
 * 三种命中：
 *   inFlight  正在下载 → 直接复用那个 Promise，不发第二次请求
 *   done      本次会话已下过 → 直接返回 ok（不再发请求）
 *   miss      没下过 → 正常下载
 *
 * 注意：失败的**不**记入 done，否则重试逻辑会被自己的缓存挡掉。
 */
var dlCache = {
  inFlight: {},      // key → Promise
  done: {},          // key → {filename}
  stats: { skipped: 0 }
};

/**
 * 取去重键：**目标目录 + 去掉签名参数的 URL**。
 *
 * 为什么必须带上目标目录：同一个商品夹里，同一张图被多个规格值引用时
 * 只需要下一份；但跨商品（批量里两件商品共用一张图）是**各要各的**——
 * 软件是按商品夹读文件的，A 商品的图不会出现在 B 商品的目录里。
 * 只按 URL 去重会让 B 商品的 info.json 指到 A 的目录，直接读不到图。
 *
 * 为什么要去掉查询串：阿里云 OSS 的 a.jpg?auth_key=X 与 a.jpg?auth_key=Y
 * 是同一张图，但 URL 不同，只按完整 URL 比等于没去。
 */
function dedupKey(url, filename) {
  var s = String(url || '');
  // data: URL 不去重（base64 内容相同但极耗内存，交给上层自己管）
  if (s.indexOf('data:') === 0) return null;
  var q = s.indexOf('?');
  if (q >= 0) s = s.slice(0, q);
  var h = s.indexOf('#');
  if (h >= 0) s = s.slice(0, h);
  // 目录部分取到商品夹那一层即可（同一商品夹内的去重才是安全的）
  var dir = String(filename || '').replace(/\\/g, '/');
  var cut = dir.indexOf(U.IMAGES_DIR + '/');
  if (cut >= 0) dir = dir.slice(0, cut);
  return (dir + '|' + s) || null;
}

function dedupReset() {
  dlCache.inFlight = {};
  dlCache.done = {};
  dlCache.stats = { skipped: 0 };
}

/* ============================================================
   跨批次持久去重（下载历史）
   ------------------------------------------------------------
   场景：今天批量下载了 1000 件，明天再抓一批新的，里面有昨天下过的。
   要求别把昨天那批重新下一遍 —— 磁盘、时间、CDN 流量都是白花。

   存哪：chrome.storage.local（不是 sync —— 几千条记录 sync 每次都要同步，
   而且 sync 有配额，1000 件商品就够呛了；local 默认 5MB，几万条都放得下）。

   ⚠️ 但这层**不够可靠**：storage.local 按**扩展 ID 隔离**。用户「解压 zip 重装」
   时扩展 ID 会变，历史就全丢了 —— 表现就是「明明昨天下过，重装后又下一遍」。

   记什么：**站点 + 商品ID**。不能只记 ID —— 1688 的 123456789 和
   闲鱼的 123456789 是两个商品，只记 ID 会误跳过。

   什么时候写：**下载成功之后**，不是开始时。开始就写的话，
   中途失败的商品会被永久标记成「已下载」，再也不会重试。

   记多久：只记 id 和时间，不记标题/价格 —— 那些变了也不该触发重下，
   用户想更新可以手动清历史或用「强制重下」。
   ============================================================ */

var HISTORY_KEY = 'xy_dl_history';      // { '站点前缀_商品ID': 时间戳 }
var historyCache = null;                // 内存副本，避免每件都读一次存储

function loadHistory() {
  if (historyCache) return Promise.resolve(historyCache);
  return new Promise(function (resolve) {
    try {
      chrome.storage.local.get(HISTORY_KEY, function (s) {
        if (chrome.runtime.lastError) {
          historyCache = {};
          return resolve(historyCache);
        }
        var v = s && s[HISTORY_KEY];
        historyCache = (v && typeof v === 'object') ? v : {};
        resolve(historyCache);
      });
    } catch (e) {
      historyCache = {};
      resolve(historyCache);
    }
  });
}

function historyKey(item) {
  if (!item) return '';
  // 键格式统一走 util 的 itemKey（站点前缀 + 商品ID，如 xy_844934128301），
  // 免得这里一套、磁盘标记文件那套，两处对不上。
  // 必须带前缀：各站数字 ID 会撞车，闲鱼的 123 和淘宝的 123 是两件商品。
  return U.itemKey(item.site, item.itemId) || '';
}

/** 判断哪些 item 已下载过（返回 Set 的 key） */
function historyFilter(items) {
  return loadHistory().then(function (h) {
    var hit = {};
    (items || []).forEach(function (it) {
      var k = historyKey(it);
      if (k && h[k]) hit[k] = true;
    });
    return hit;
  });
}

/** 记一批已成功的商品 */
function historyMark(items) {
  return loadHistory().then(function (h) {
    var now = Date.now();
    var changed = false;
    (items || []).forEach(function (it) {
      var k = historyKey(it);
      if (!k || h[k]) return;
      h[k] = now;
      changed = true;
    });
    if (!changed) return null;
    return new Promise(function (resolve) {
      var payload = {};
      payload[HISTORY_KEY] = h;
      try {
        chrome.storage.local.set(payload, function () { resolve(); });
      } catch (e) { resolve(); }
    });
  });
}

/** 清空下载历史（用户想重新抓一批时用） */
function historyClear() {
  historyCache = {};
  return new Promise(function (resolve) {
    try {
      chrome.storage.local.remove(HISTORY_KEY, function () { resolve(true); });
    } catch (e) { resolve(false); }
  });
}

/**
 * 查磁盘上有没有下过 —— **第二层判重，不依赖任何存储**。
 *
 * 为什么必须有这层：storage.local 按扩展 ID 隔离，用户解压 zip 重装时
 * ID 会变，历史清零，于是昨天下的今天又下一遍。
 *
 * 判据是**商品目录里的 ID 标记文件**（`已下载标识_<站点>_<商品ID>.txt`），
 * 不是 info.json —— 因为 info.json 的路径带目录名，而目录名默认模板是
 * `{shop}_{title}_{itemId}`，**卖家一改标题路径就变了，判重立刻失效**。
 * ID 标记文件名只由 站点+商品ID 决定，标题怎么改都不影响。
 *
 * 做法：downloads.search 判断文件在不在（扩展没有读本地文件的权限，
 * 也不需要读内容）。
 *
 * ⚠️⚠️ 两个踩过的坑：
 *   ① 下载时传的是**相对路径**，而 downloads.search 返回的 r.filename 是
 *      **带盘符的绝对路径**。全等比对 `f === want` 永远不成立
 *      （v1.6.3 判重失效的真凶）。要比尾部片段。
 *   ② downloads.search 是**模糊匹配**，同目录下的
 *      `已下载标识_xy_123.txt.crdownload`（下载中断的临时文件）也会命中，
 *      判成「下过」的话，失败的商品就永远不会被重试。
 *   所以必须精确比对尾部片段，且只认 state === 'complete'。
 */
function historyOnDisk(items) {
  return new Promise(function (resolve) {
    var list = (items || []).filter(function (it) {
      return it && it.dir && U.idMarkFileName(it.site, it.itemId);
    });
    if (!list.length) return resolve({});
    if (!chrome.downloads || typeof chrome.downloads.search !== 'function') {
      return resolve({});
    }

    var norm = function (p) {
      return String(p || '').replace(/\\/g, '/').replace(/^\/+/, '');
    };

    // 把要查的标记文件名收成一组
    var wantMarks = {};
    list.forEach(function (it) {
      wantMarks[U.idMarkFileName(it.site, it.itemId)] = true;
    });

    var hit = {};
    try {
      // ⚠️⚠️ 不传 filename 参数，改为**拉全部下载记录自己匹配**。
      //   原因：downloads.search 的 filename 参数要求**完整绝对路径**
      //   （Chrome 文档原话：The absolute path of the file），
      //   传「已下载标识_xy_123.txt」这种片段是匹配不上的 ——
      //   而我们只知道相对于用户保存目录的相对路径，不知道盘符和上级目录。
      //   v1.7.0 一直用错这个 API，所以判重从来没生效过。
      chrome.downloads.search({}, function (rows) {
        if (!rows || !rows.length) return resolve({});
        // 先把磁盘上真实存在的标记文件名收成一组
        var onDisk = {};
        rows.forEach(function (r) {
          if (!r || r.state !== 'complete' || !r.exists) return;
          var f = norm(r.filename);
          var base = f.slice(f.lastIndexOf('/') + 1);
          if (!base) return;
          // 精确匹配
          if (wantMarks[base]) { onDisk[base] = true; return; }
          // ⚠️ 还要兼容 uniquify 的重名副本「已下载标识_xy_123.txt (1)」。
          //   强制重下时写过一次就可能留下这种副本，只认精确名会漏跳过
          //   （用户「下载 30 个再勾一次」的诉求就落在这里）。
          //   去尾部「 (数字)」后再比一次。
          var clean = base.replace(/ \(\d+\)$/, '');
          if (wantMarks[clean]) onDisk[clean] = true;
        });
        if (!Object.keys(onDisk).length) return resolve({});
        list.forEach(function (it) {
          var mark = U.idMarkFileName(it.site, it.itemId);
          if (onDisk[mark]) hit[it.dir] = true;
        });
        resolve(hit);
      });
    } catch (e) {
      resolve({});
    }
  });
}

/**
 * 落一个 ID 标记文件到商品目录里。
 *
 * 内容写不写无所谓（扩展读不回来），但写上站点+商品ID+时间，
 * 万一用户直接打开文件夹能看到是哪个商品，顺便也能手动删来强制重下。
 *
 * 必须在 info.json 之后写 —— 标记存在就表示「整个商品下完了」。
 */
function writeIdMark(dir, site, itemId, errors) {
  var name = U.idMarkFileName(site, itemId);
  if (!name) return Promise.resolve(false);
  var body = [
    '商品标识：' + U.itemKey(site, itemId),
    '站点：' + (site || ''),
    '商品ID：' + String(itemId),
    '下载时间：' + new Date().toLocaleString('zh-CN'),
    '',
    '这个文件用于避免重复下载。删掉它，下次就会重新下载这个商品。'
  ].join('\n');
  return download({
    url: textToDataUrl(body, 'txt'),
    filename: dir + '/' + name,
    // 用 uniquify 而不是 overwrite：后者需要「修改下载历史」类权限，
    // 而这里根本不依赖文件名唯一 —— 判重只看「有没有这个前缀的标记文件」，
    // 重下时多出 (1) 也照样认得出来。
    conflictAction: 'uniquify',
    saveAs: false
  }).then(function (r) {
    if (!r.ok && errors && errors.length < 10) errors.push('标识文件写入失败');
    return r.ok;
  });
}

/**
 * 把完整落盘路径去掉商品目录前缀，只留商品夹内的相对路径。
 * info.json 里的 local_images / sku_specs[].local_image 要的是这个，
 * 而不是带目录的绝对相对路径（软件是按商品夹找文件的）。
 */
function stripDir(fullPath, dir) {
  var s = String(fullPath || '').replace(/\\/g, '/');
  var d = String(dir || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (d && s.indexOf(d) === 0) return s.slice(d.length).replace(/^\/+/, '');
  // 目录名对不上（去重时可能来自别的商品）就取最后两段，够软件定位
  var parts = s.split('/');
  return parts.length <= 2 ? s : parts.slice(-2).join('/');
}

/**
 * 下载一张资源。批量打包时经常撞上 CDN 的瞬时限流/连接重置，
 * 所以失败自动重试一次（隔 500ms），比直接漏文件好得多。
 *
 * 带去重：见 dlCache 的说明。
 *
 * ⚠️ 去重时**把首个请求的真实落盘路径回传**（res.filename）。
 *    conflictAction:'uniquify' 下第二个同名请求会存成 1(1).jpg，
 *    但 info.json 里写的是 1.jpg —— 只省请求不修路径的话，
 *    软件侧读到的就是**不存在的文件**。所以调用方必须用回来的 filename。
 *
 * 重试绕过去重：已经失败的东西不能因为「缓存里有」被当成成功。
 */
function download(options, retries, skipDedup) {
  retries = retries == null ? 1 : retries;

  if (!skipDedup) {
    var key = dedupKey(options && options.url, options && options.filename);
    if (key) {
      // 正在下 → 等它那个结果，不重复发请求
      if (dlCache.inFlight[key]) {
        dlCache.stats.skipped++;
        return dlCache.inFlight[key];
      }
      // 本次会话已成功下过 → 直接复用它的路径
      if (dlCache.done[key]) {
        dlCache.stats.skipped++;
        return Promise.resolve({
          ok: true, id: -1, deduped: true, filename: dlCache.done[key].filename
        });
      }
      var p = downloadOnce(options, retries).then(function (r) {
        if (r.ok) dlCache.done[key] = { filename: options.filename };
        else delete dlCache.done[key];      // 失败不记账，留给重试
        delete dlCache.inFlight[key];
        return r;
      });
      dlCache.inFlight[key] = p;
      return p;
    }
  }
  return downloadOnce(options, retries);
}

function downloadOnce(options, retries) {
  return new Promise(function (resolve) {
    try {
      chrome.downloads.download(options, function (id) {
        if (chrome.runtime.lastError || !id) {
          var err = (chrome.runtime.lastError && chrome.runtime.lastError.message) || '下载失败';
          if (retries > 0) {
            setTimeout(function () {
              // 重试绕过去重：刚才失败的不该被 dedupKey 命中挡住
              downloadOnce(options, retries - 1).then(function (r) { resolve(r); });
            }, 500);
            return;
          }
          resolve({ ok: false, error: err });
        } else {
          resolve({ ok: true, id: id, filename: options.filename });
        }
      });
    } catch (e) {
      resolve({ ok: false, error: String(e && e.message || e) });
    }
  });
}

/* ---------------- 后台标签页补详情 ----------------

 * 有些站点的详情接口只认「真正的详情页上下文」——淘宝的 pcdetail.data.get /
 * detail.getdesc 在搜索页、店铺页调用一律超时（同一页上的对照接口却秒通，
 * 补 exParams、用 CDP 改 Referer/Origin 全都无效，见 sites.js 的 detailPageOnly）。
 * 服务端只认页面本身，绕不过去，所以补详情时开一个**后台标签页**去访问详情页，
 * 采完立刻回收。
 *
 * 只开一个标签页、串行复用：批量 10 件不会同时挂 10 个页面，内存和风控都可控，
 * 浏览器的图片/脚本缓存也能接着用。active:false 不抢焦点，用户至多瞥见
 * 标签栏闪一下。
 */
var bgDetail = {
  tabId: null,             // 兼容旧代码的单一标签页字段
  tabIds: [],              // 本 worker 持有的全部标签页
  freeIds: [],             // 可复用的空闲标签页
  inflight: 0,             // 当前在跑的任务数
  slotRes: null,           // 等位的 resolve 队列
  slotWait: null,
  PARALLEL: 3,             // 并行度：实测 3 路无风控、提速 2.75 倍
  idleTimer: null,
  IDLE_CLOSE: 8000,     // 忙完静置这么久就回收标签页
  NAV_TIMEOUT: 25000,   // 单次导航等待上限
  MAX_TRY: 8,           // 采集下发重试次数（content script 就绪需要一点时间）
  GAP: 400              // 商品之间歇一口，别把这批请求打成突击
};

function bgSleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

/** 目标地址必须属于我们支持的站点——别让任何消息把 SW 当跳板去开任意页面 */
function bgUrlAllowed(url) {
  try {
    var u = new URL(url);
    var site = SITES && SITES.match ? SITES.match(u.host) : null;
    return !!(site && site.enabled !== false);
  } catch (e) {
    return false;
  }
}

/** 等某个标签页加载完成（onUpdated 的 complete） */
function bgWaitComplete(tabId, timeoutMs) {
  return new Promise(function (resolve) {
    var done = false;
    function finish(ok) {
      if (done) return;
      done = true;
      try { chrome.tabs.onUpdated.removeListener(onUpd); } catch (e) {}
      clearTimeout(timer);
      resolve(ok);
    }
    function onUpd(id, info) {
      if (id === tabId && info && info.status === 'complete') finish(true);
    }
    chrome.tabs.onUpdated.addListener(onUpd);
    var timer = setTimeout(function () { finish(false); }, timeoutMs || bgDetail.NAV_TIMEOUT);
  });
}

/** 往指定标签页发消息。content script 还没就绪时返回 null，由调用方重试 */
/**
 * 在后台标签页打开闲鱼 create-order 页，采规格值 → 规格图 的映射。
 *
 * 这是**兜底路径**。实测（2026-10-17）闲鱼详情接口的 skuList 里本来就带
 * propertyImage.url，颜色维度的图开箱即有。所以这里只处理少数
 * 「视觉维度缺图」的商品。
 *
 * ⚠️ 必须用**自己的标签页**，不能复用补详情那个：
 *   复用的后果是这里结束时 chrome.tabs.remove 把补详情的页也回收了，
 *   bgDetail.tabId 被置空 → 补详情链路不停重建标签页
 *   —— 就是用户报的「软件不断打开标签页」。
 *
 * 安全边界：只点规格值按钮切换选中，**绝不点「提交订单/立即下单/确认付款」**。
 * 采完立刻关掉标签页。
 *
 * @returns {Promise<{ok, dim?, map?, n?, error?}>}
 */
async function collectSpecImagesViaTab(itemId, opt) {
  opt = opt || {};
  if (!itemId) return { ok: false, error: '无商品 ID' };
  var url = 'https://www.goofish.com/create-order?itemId=' +
    encodeURIComponent(String(itemId));
  if (!bgUrlAllowed(url)) return { ok: false, error: '不允许的地址' };

  // 独立标签页：不碰补详情那个标签页池（bgAcquireTab）
  var tabId = await new Promise(function (resolve) {
    try {
      chrome.tabs.create({ url: 'about:blank', active: false }, function (t) {
        if (chrome.runtime.lastError || !t) return resolve(null);
        resolve(t.id);
      });
    } catch (e) { resolve(null); }
  });
  if (!tabId) return { ok: false, error: '无法开标签页' };

  try {
    await bgNavigate(tabId, url);
    // 内容脚本 + SPA 渲染要时间
    await bgWaitComplete(tabId, 20000);
    await new Promise(function (r) { setTimeout(r, 2500); });

    var resp = await bgSend(tabId, {
      type: 'xy:collect-spec-images',
      opt: { limit: opt.limit || 20, delayMs: opt.delayMs || 1500 }
    });
    // 内容脚本可能还没就绪，重试一次
    if (!resp) {
      await new Promise(function (r) { setTimeout(r, 1500); });
      resp = await bgSend(tabId, {
        type: 'xy:collect-spec-images',
        opt: { limit: opt.limit || 20, delayMs: opt.delayMs || 1500 }
      });
    }
    if (!resp) return { ok: false, error: '后台页无响应' };
    return resp;
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  } finally {
    // 只关自己这一页，**不碰补详情的标签页池**
    try { chrome.tabs.remove(tabId); } catch (e) {}
  }
}

function bgSend(tabId, msg) {
  return new Promise(function (resolve) {
    try {
      chrome.tabs.sendMessage(tabId, msg, function (resp) {
        if (chrome.runtime.lastError) return resolve(null);
        resolve(resp || null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

/** 导航到详情页并等它加载完 */
async function bgNavigate(tabId, url) {
  var cur = await new Promise(function (r) {
    chrome.tabs.get(tabId, function (t) { r(t || null); });
  });
  // 已经停在目标页就别再导航：重复导航不一定触发 onUpdated，会白等到超时
  if (cur && cur.url === url) return true;
  var wait = bgWaitComplete(tabId, bgDetail.NAV_TIMEOUT);   // 先挂监听，再导航
  try {
    chrome.tabs.update(tabId, { url: url }, function () {});
  } catch (e) {
    return false;
  }
  return wait;
}

/** 在后台标签页里采一个商品 */
async function bgCollectOne(itemId, url) {
  var tabId = await bgAcquireTab();
  if (tabId == null) return null;
  var loaded = false;
  try {
    loaded = await bgNavigate(tabId, url);
    if (!loaded) return null;
    for (var i = 0; i < bgDetail.MAX_TRY; i++) {
      // ★ inBgTab 标记：这个页面是 SW 自己开的后台标签页。
      //   内容脚本收到它就知道「别再借后台页了」——
      //   否则会无限递归（后台页采详情 → 发现自己不在详情页 → 又借后台页 → …）。
      //   闲鱼曾因 detailPageRe 没配、isOnDetailPage 恒为 false 而踩中，
      //   表现是标签页狂开 + 详情永远取不到 + 规格图下不来。
      var r = await bgSend(tabId, {
        type: 'xy:collect-detail', itemId: itemId, inBgTab: true
      });
      if (r && r.ok && r.detail) return r.detail;
      // bridge 已经应答但说采不到（接口超时 / 风控页），再重试也是同样结果
      if (r) return null;
      await bgSleep(700);
    }
    return null;
  } finally {
    // 无论成败都还回池子，否则并行时会把标签页耗光
    if (loaded) bgReleaseTab(tabId);
    else {
      try { chrome.tabs.remove(tabId); } catch (e) {}
      var arr = bgDetail.tabIds || [];
      var k = arr.indexOf(tabId);
      if (k >= 0) arr.splice(k, 1);
    }
  }
}

/** 静置一段时间后回收标签页 */
function bgArmIdleClose() {
  if (bgDetail.idleTimer) clearTimeout(bgDetail.idleTimer);
  bgDetail.idleTimer = setTimeout(function () {
    var ids = bgDetail.tabIds && bgDetail.tabIds.length
      ? bgDetail.tabIds.slice() : (bgDetail.tabId ? [bgDetail.tabId] : []);
    bgDetail.tabIds = [];
    bgDetail.tabId = null;
    ids.forEach(function (id) {
      try { chrome.tabs.remove(id); } catch (e) {}
    });
  }, bgDetail.IDLE_CLOSE);
}

/**
 * 取一个空闲的后台标签页；没有就新开一个。
 *
 * ⚠️ 每个 worker 有**自己的**标签页池。多路并行时各占各的，
 *    绝不能共用 —— 共用会导致两个任务把同一个页导航到不同商品，
 *    采到的数据张冠李戴。
 */
function bgAcquireTab() {
  var free = bgDetail.freeIds || [];
  while (free.length) {
    var id = free.shift();
    if (id != null) return Promise.resolve(id);
  }
  return new Promise(function (resolve) {
    try {
      chrome.tabs.create({ url: 'about:blank', active: false }, function (t) {
        if (chrome.runtime.lastError || !t) return resolve(null);
        var arr = bgDetail.tabIds || (bgDetail.tabIds = []);
        arr.push(t.id);
        resolve(t.id);
      });
    } catch (e) { resolve(null); }
  });
}

function bgReleaseTab(tabId) {
  if (tabId == null) return;
  (bgDetail.freeIds || (bgDetail.freeIds = [])).push(tabId);
}

/**
 * 排队入口：**最多 PARALLEL 路并行**，件与件之间限速，忙完后回收标签页。
 *
 * ⚠️ 之前是纯串行（chain 一件接一件）。实测每件约 3.1 秒，
 *    100 件要 328 秒 —— 这正是「勾 100 个、60 秒超时只补了 19 个」
 *    那个漏下问题的放大器。
 *
 * 实测并行 3 路：3 件从 9.8 秒降到 3.6 秒（**2.75 倍**），
 * 100 件从 328 秒降到 119 秒，且 3 个页面都正常取到数据、**没触发限流**。
 *
 * 并行度不设更高：闲鱼是风控敏感的电商站，3 路是实测安全的边，
 * 再往上很可能换来「更多商品取不到」——那比慢更糟。
 */
function bgDetailJob(itemId, url) {
  function run() {
    return bgCollectOne(itemId, url).then(function (d) {
      return bgSleep(bgDetail.GAP).then(function () { return d; });
    });
  }
  var inflight = bgDetail.inflight || 0;
  var p;
  if (inflight >= bgDetail.PARALLEL) {
    // 达到并行上限：等一个空位出来再跑
    var wait = bgDetail.slotWait;
    if (!wait) {
      wait = bgDetail.slotWait = new Promise(function (res) {
        bgDetail.slotRes = bgDetail.slotRes || [];
        bgDetail.slotRes.push(res);
      });
    }
    p = wait.then(function () { return run(); });
  } else {
    p = run();
  }

  (bgDetail.inflight = (bgDetail.inflight || 0) + 1);
  function settle(v) {
    bgDetail.inflight = Math.max(0, (bgDetail.inflight || 1) - 1);
    // 放行一个等位的
    var rs = bgDetail.slotRes;
    if (rs && rs.length) {
      var next = rs.shift();
      if (!rs.length) { bgDetail.slotRes = null; bgDetail.slotWait = null; }
      next();
    }
    return v;
  }
  var out = p.then(function (d) { return settle(d); },
                  function (e) { return settle(null); });
  out.then(bgArmIdleClose, bgArmIdleClose);
  return out;
}

/* ---------------- 消息处理 ---------------- */

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return;

  // 批量下载图片
  if (msg.type === 'xy:download-images') {
    var urls = (msg.urls || []).filter(Boolean);
    if (!urls.length) {
      sendResponse({ ok: false, error: '没有图片地址' });
      return true;
    }
    var dir = safePath(msg.dir);
    var done = 0;
    var failed = 0;

    var tasks = urls.map(function (url, i) {
      // 单图下载也进 images/，和批量走同一套命名——不然同一商品的目录
      // 会因为「从哪下的」而有两种长相
      var filename = dir + '/' + U.IMAGES_DIR + '/' + U.imageFileName(url, i);
      return download({
        url: url,
        filename: filename,
        conflictAction: 'uniquify',
        saveAs: false
      }).then(function (r) {
        if (r.ok) done++; else failed++;
      });
    });

    Promise.all(tasks).then(function () {
      sendResponse({ ok: done > 0, count: done, failed: failed });
    });
    return true; // 异步响应
  }

  // 保存文案
  if (msg.type === 'xy:save-text') {
    var text = msg.text || '';
    if (!text) {
      sendResponse({ ok: false, error: '内容为空' });
      return true;
    }
    var dataUrl = textToDataUrl(text, msg.format || 'txt');
    // Chrome 对 data: URL 下载有体积上限，超过 2MB 时提示
    if (dataUrl.length > 2 * 1024 * 1024) {
      sendResponse({ ok: false, error: '文案过大（>2MB），请改用 JSON 精简字段' });
      return true;
    }
    var dir2 = safePath(msg.dir);
    var file = safeName(msg.filename || '文案.txt');
    download({
      url: dataUrl,
      filename: dir2 + '/' + file,
      conflictAction: 'uniquify',
      saveAs: false
    }).then(function (r) {
      sendResponse(r);
    });
    return true;
  }

  // 只下视频：给「下载视频」按钮用。不碰图片/文案，也不写 info.json。
  if (msg.type === 'xy:download-videos') {
    var it = msg.item;
    if (!it || !it.dir) {
      sendResponse({ ok: false, error: '没有可下载的商品' });
      return true;
    }
    var vs = (it.videos || []).filter(function (v) {
      return v && U.normalizeVideoUrl(v.url);
    }).slice(0, 5);
    if (!vs.length) {
      sendResponse({ ok: false, error: '没有可下载的视频' });
      return true;
    }
    var vErrs = [];
    var vOut = [];
    var vOk = 0;
    downloadVideosInto(safePath(it.dir), vs, vOut, vErrs, function () { vOk++; })
      .then(function () {
        sendResponse({
          ok: vOk > 0,
          videosDone: vOk,
          videosTotal: vs.length,
          errors: vErrs.slice(0, 3),
          error: vErrs[0] || ''
        });
      });
    return true;
  }

  // 批量下载：勾选的多个商品，各自一个目录（图片 + 文案）
  // ★ 预检：在补齐详情**之前**先问哪些已经下载过。
  //   顺序反了的话，已下载的商品仍要先花 30 秒补齐详情，
  //   才轮到判重跳过 —— 用户看到的是「又提示补齐商品详情」，
  //   判重形同虚设（2026-10-19 用户实测发现）。
  if (msg.type === 'xy:check-history') {
    var probe = (msg.items || []).filter(function (it) {
      return it && it.dir && U.idMarkFileName(it.site, it.itemId);
    });
    if (!probe.length) {
      sendResponse({ ok: true, skipped: 0, dirs: [] });
      return true;
    }
    Promise.all([historyFilter(probe), historyOnDisk(probe)]).then(function (rs) {
      var store = rs[0] || {};
      var disk = rs[1] || {};
      var dirs = [];
      probe.forEach(function (it) {
        var k = historyKey(it);
        if ((k && store[k]) || disk[it.dir]) dirs.push(it.dir);
      });
      sendResponse({ ok: true, skipped: dirs.length, dirs: dirs });
    });
    return true;
  }

  if (msg.type === 'xy:download-items') {
    var allItems = (msg.items || []).filter(function (it) { return it && it.dir; });
    if (!allItems.length) {
      sendResponse({ ok: false, error: '没有可下载的商品' });
      return true;
    }

    // forceRedownload 时不过滤历史（用户明确要重下）
    var forceRedownload = !!msg.forceRedownload;

    // 两层判重：存储历史 + 磁盘目录。后者不依赖扩展 ID，
    // 解压重装换了 ID 导致历史丢失时，靠它兜住。
    Promise.all([historyFilter(allItems), historyOnDisk(allItems)])
      .then(function (rs) {
      var storeHit = rs[0] || {};
      var diskHit = rs[1] || {};
      var skipped = [];
      var items = allItems;
      if (!forceRedownload) {
        items = [];
        allItems.forEach(function (it) {
          var k = historyKey(it);
          var inStore = k && storeHit[k];
          // 目录已经在磁盘上 = 下过（换浏览器/重装扩展也认得出来）
          var onDisk = it.dir && diskHit[it.dir];
          if (inStore || onDisk) skipped.push({ item: it, key: k, from: onDisk ? 'disk' : 'store' });
          else items.push(it);
        });
      }
      // 全被跳过了：也要回一个正常响应，前端好显示「跳过 N 件」
      if (!items.length) {
        sendResponse({
          ok: true, items: 0, images: 0, imgTotal: 0, videos: 0,
          info: 0, textOk: 0, textFail: 0,
          skippedAll: skipped.length,
          skippedSample: skipped.slice(0, 5).map(function (s) {
            return (s.item.meta && s.item.meta.title) || s.key;
          }),
          hint: '全部都是已下载过的商品',
          errors: []
        });
        return;
      }      runDownloadItems(items, skipped, forceRedownload);
    });
    return true;
  }

  // 清空下载历史
  if (msg.type === 'xy:clear-history') {
    historyClear().then(function (ok) {
      sendResponse({ ok: !!ok });
    });
    return true;
  }

  // 查下载历史条数（设置面板显示）
  if (msg.type === 'xy:history-stats') {
    loadHistory().then(function (h) {
      sendResponse({ ok: true, count: Object.keys(h).length });
    });
    return true;
  }

  function runDownloadItems(items, skippedBefore, forceRedl) {
    var prefix = msg.prefix || '';   // 已废弃：新结构里主图固定进 images/ 用序号命名
    var format = msg.format || 'txt';
    // 每批都重置去重缓存。
    dedupReset();
    var imgTotal = 0;
    var imagesDone = 0;
    var videosDone = 0;
    var itemOk = 0;
    var infoOk = 0;                  // info.json 落盘数
    var errors = [];

    /**
     * 单个商品的下载。落盘结构（铺货软件按这个读，对接规范 sku_image_contract.md v1.0）：
     *   <dir>/images/序号.ext              主图
     *   <dir>/images/sku/维度_值_名.ext    规格图（维度值级）
     *   <dir>/video/主图.mp4               视频
     *   <dir>/info.json                    商品元数据（sku_specs 在这里）
     *   <dir>/文案.txt
     */
    function oneItem(item) {
      var dir = safePath(item.dir);
      var jobs = [];
      // 图片URL → 真实落盘相对路径。去重后同一张图只落一次，
      // 后面的规格值/主图要跟着首个的真实路径走，否则 info.json
      // 会写到「没下过的那个文件名」上，软件读到的就是空。
      var realPaths = {};

      var urls = (item.images || []).filter(Boolean);
      if (urls.length) {
        imgTotal += urls.length;
        // 每个商品内部的图片并发 3，避免被浏览器限流
        urls.forEach(function (url, i) {
          jobs.push(function () {
            return download({
              url: url,
              // 文件名由 util 单点生成——info.json 里的 local_images 用的是同一套，
              // 两边各拼一次字符串迟早会对不上
              filename: dir + '/' + U.IMAGES_DIR + '/' + U.imageFileName(url, i),
              conflictAction: 'uniquify',
              saveAs: false
            }).then(function (r) {
              if (r.ok) {
                imagesDone++;
                if (r.filename) realPaths[url] = stripDir(r.filename, dir);
              } else if (errors.length < 10) errors.push(r.error);
              return r.ok;
            });
          });
        });
      }

      // 规格图：按「维度值」逐个下，不是按组合行。
      // 组合行在多维商品里对应多张图，没有唯一文件名可指；
      // 而 sku_specs[].values[v] 是软件侧按下标对齐的权威映射，
      // 这里必须和 buildInfo 用同一个 U.skuSpecImageName，否则两边对不上。
      // 无图的值不产任务（也不产文件）。
      var skus = item.skus;
      var specDefs = (skus && skus.specDefs) || [];
      // 规格图必须先补齐再枚举下载。
      //
      // ⚠️⚠️ 实测发现的严重 bug（用户报「不断打开标签页」+「SKU 图没下」）：
      //   原来的触发条件是「有任一维度值缺图」——
      //   但**尺码/尺寸这类维度天然就是无图的**（实测 844934128301：
      //   颜色 11/11 有图，尺码 0/12 有图），于是条件**必然为真**，
      //   每个商品都会白开一次 create-order 确认单页。
      //   而 collectSpecImagesViaTab 的 finally 会 chrome.tabs.remove，
      //   把「专门用于补详情」的那个标签页也一起回收了 ——
      //   于是补详情链路不停重建标签页，就是用户看到的「不断打开标签页」。
      //
      // 正确条件：**只有「可能有视觉变体」的维度缺图才值得补采**。
      // 尺码/码数/重量/口味这类维度本来就没有图，补采也补不出来。
      var VISUAL_DIM = /颜色|色|款式|型号|版本|外观|花色|图案|套装|套餐|口味/i;
      var needSpecFetch = item.site === 'xianyu' && specDefs.length &&
        specDefs.some(function (d) {
          if (!d || !d.values || !d.values.length) return false;
          // 尺码这类维度天生无图，直接跳过不看
          if (!VISUAL_DIM.test(d.name || '')) return false;
          return d.values.some(function (v) { return v && !v.image; });
        });
      var specReady = Promise.resolve(null);
      if (needSpecFetch) {
        // imgTotal 不在这里加：补采回来的图会由下面的规格图循环正常计数，
        // 提前加会让进度条显示的比实际多。
        specReady = collectSpecImagesViaTab(item.itemId, {})
          .then(function (res) {
            if (!res || !res.ok || !res.map) return null;
            // 把采到的图挂到对应的规格值上
            var hit = 0;
            specDefs.forEach(function (d) {
              (d.values || []).forEach(function (v) {
                if (v && !v.image && res.map[v.value]) {
                  v.image = res.map[v.value];
                  hit++;
                }
              });
            });
            return hit;
          });
      }
      // 规格图任务必须在**补采完成之后**才入队，否则循环里看到的
      // val.image 全是空串，任务会被整个跳过 —— 闲鱼的图正是补采来的。
      // pump 是并发执行、顺序不定，所以把「补采 → 建任务 → 下载」串成一个 job。
      jobs.push(function () {
        return specReady.then(function () {
          var tasks = [];
          specDefs.forEach(function (def, g) {
            (def.values || []).forEach(function (val, v) {
              if (!val || !val.image) return;
              imgTotal++;
              tasks.push(function () {
                return download({
                  // ★ 这里也过一道 normalizeImageUrl。
                  //   规格图的地址来自接口，闲鱼给的是 **http://**；
                  //   闲鱼页面是 HTTPS → 混合内容被浏览器拦截 → 规格图下不来。
                  //   bridge 层已经转过一次，这里再转一次是保险：
                  //   后台标签页采回来的详情也走同一条下载路径，
                  //   不能指望每一层都记得转。
                  url: U.normalizeImageUrl(val.image),
                  filename: dir + '/' + U.SKU_DIR + '/' +
                    U.skuSpecImageName(g, v, val.value, val.image),
                  conflictAction: 'uniquify',
                  saveAs: false
                }).then(function (r) {
                  if (r.ok) {
                    imagesDone++;
                    if (r.filename) realPaths[val.image] = stripDir(r.filename, dir);
                  } else if (errors.length < 10) errors.push(r.error);
                  return r.ok;
                });
              });
            });
          });
          return pump(tasks, 3);
        });
      });

      // 视频：单独进 video/。视频几 MB 到几十 MB，
      // 混在图片序号里既难找也会拖慢铺货。
      //
      // m3u8 要先合并分片才能落盘，所以视频任务必须**先跑完**，
      // 因为 info.json 里要写 local_video（成功才有路径）。
      var videos = (item.videos || []).slice(0, 5);
      var videoResults = [];
      if (videos.length) {
        imgTotal += videos.length;
        var vjob = downloadVideosInto(dir, videos, videoResults, errors, function () {
          videosDone++;
        });
        // 视频全部落定后才写 info.json —— 里面的 local_video 依赖这里的结果
        jobs.push(function () { return vjob; });
      }

      // 这个商品什么都没有就别建目录了
      if (!jobs.length) return Promise.resolve({ ok: 0, fail: 0 });

      // info.json —— 铺货软件靠它识别商品，是这套目录结构的核心。
      // 里面写的路径就是上面那几个 download 实际用的文件名。
      //
      // ⚠️ 必须**等前面所有 job 全部跑完**再写。pump 并发执行、顺序不定，
      //    sku_specs[].local_image 依赖规格图已经落盘，提前写就会记录
      //    下不存在的文件；local_video 同理。
      //    做法：把前序 job 从队列里取出来先跑完，再写 info.json。
      var preJobs = jobs.slice();
      jobs.length = 0;
      jobs.push(function () {
        return pump(preJobs, 3).then(function () {
          var info = U.buildInfo(item.meta, item.images, item.skus,
            videoResults.filter(Boolean), realPaths);
          var dataUrl = textToDataUrl(JSON.stringify(info, null, 2), 'json');
          return download({
            url: dataUrl,
            filename: dir + '/' + U.INFO_FILE,
            conflictAction: 'uniquify',
            saveAs: false
          }).then(function (r) {
            if (!r.ok) {
              if (errors.length < 10) errors.push(r.error);
              return false;
            }
            infoOk++;
            // info.json 落盘后再写 ID 标记 —— 标记存在 = 整个商品下完了。
            // 顺序反了的话，中途失败的商品也会被标成「下过」，
            // 于是再也不会重试。判重全靠这个文件。
            return writeIdMark(dir, item.site, item.itemId, errors);
          });
        });
      });

      return pump(jobs, 3).then(function (r) {
        // info.json 写成功才算这个商品「下过了」——中途失败的商品不该被
        // 永久标记成已下载，否则再也不会重试。
        if (r && r.ok) succeededItems.push(item);
        return r;
      });
    }
    var succeededItems = [];

    pump(items.map(function (it, i) { return function () { return oneItem(it); }; }), 2)
      .then(function () {
        // 文案单独落盘，失败不影响图片结果
        var textJobs = items.filter(function (it) { return it.text; }).map(function (it) {
          return function () {
            var dir = safePath(it.dir);
            var dataUrl = textToDataUrl(it.text, format);
            if (dataUrl.length > 2 * 1024 * 1024) return false;
            return download({
              url: dataUrl,
              filename: dir + '/' + safeName(it.filename || ('文案' + U.textExt(format))),
              conflictAction: 'uniquify',
              saveAs: false
            }).then(function (r) { return r.ok; });
          };
        });
        return pump(textJobs, 2);
      })
      .then(function (t) {
        itemOk = items.length - t.fail;
        // 成功的才写进历史，跨批次用
        return historyMark(succeededItems).then(function () {
          var skippedCount = (skippedBefore || []).length;
          sendResponse({
            ok: true,
            items: itemOk,
            images: imagesDone,
            imgTotal: imgTotal,
            videos: videosDone,
            info: infoOk,
            textOk: t.ok,
            textFail: t.fail,
            // 本批省掉多少次重复请求——用户能直观看到去重起了作用
            dedupSkipped: dlCache.stats.skipped,
            // 历史里已下过、本批直接跳过的商品数
            skippedHistory: skippedCount,
            errors: errors
          });
        });
      });
    return true;
  }

  // 借后台标签页采一个商品的详情（详情接口只认详情页上下文的站点走这条）
  // 采闲鱼规格图：详情接口不给图，只能开后台确认单页点规格值。
  if (msg.type === 'xy:spec-images') {
    collectSpecImagesViaTab(msg.itemId, msg.opt).then(function (r) {
      sendResponse(r);
    });
    return true;
  }

  if (msg.type === 'xy:bg-detail') {
    // 整段包 try：onMessage 回调里同步抛错的话，Chrome 会直接关掉消息端口，
    // 页面侧只能看到一句「The message port closed…」，根本猜不到哪里出错。
    try {
      var bgId = String(msg.itemId || '').trim();
      var bgUrl = String(msg.url || '');
      if (!bgId || !/^\d{5,20}$/.test(bgId)) {
        sendResponse({ ok: false, error: '商品 ID 不合法' });
        return true;
      }
      if (!bgUrlAllowed(bgUrl)) {
        sendResponse({ ok: false, error: '不允许的地址' });
        return true;
      }
      bgDetailJob(bgId, bgUrl).then(function (d) {
        sendResponse(d ? { ok: true, detail: d } : { ok: false, error: '详情未取到' });
      }, function (e) {
        sendResponse({ ok: false, error: '后台补详情失败：' + String(e && e.message || e) });
      });
      return true;   // 异步响应；也正因这个未返回的端口，SW 不会中途休眠
    } catch (e) {
      sendResponse({ ok: false, error: '后台补详情异常：' + String(e && e.message || e) });
      return true;
    }
  }

  // 自检：出问题时先问它一句，比猜快得多
  if (msg.type === 'xy:ping') {
    sendResponse({
      ok: true,
      version: chrome.runtime.getManifest().version,
      hasSites: !!(SITES && SITES.match),
      hasTabsApi: !!(chrome.tabs && chrome.tabs.create && chrome.tabs.sendMessage),
      bgDetailReady: !!(bgDetail && bgDetail.IDLE_CLOSE)
    });
    return true;
  }

  // 打开下载文件夹
  if (msg.type === 'xy:open-downloads') {
    chrome.downloads.showDefaultFolder();
    sendResponse({ ok: true });
    return true;
  }
});
