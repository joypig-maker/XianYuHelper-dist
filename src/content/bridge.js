/**
 * ISOLATED world 内容脚本
 *  - 接收 injected.js（MAIN world）抓到的商品数据
 *  - 在列表页插入复选框，支持滚动累积后批量勾选
 *  - 渲染页面悬浮操作面板
 *  - 复制走 navigator.clipboard，下载交给 background service worker
 */
(function () {
  'use strict';
  if (window.__XY_BRIDGE__) return;
  window.__XY_BRIDGE__ = true;
  // 调试标记：便于在页面控制台/自动化脚本里确认内容脚本是否注入成功
  try { document.documentElement.setAttribute('data-xy-bridge', '1'); } catch (e) {}

  var U = window.XYUtil;
  var SITES = window.XYSites;
  var MSG = 'xy-bridge';
  // extract.js 从 React fiber 里认出商品 ID 后，会把 ID 标到元素上，
  // 让无 class 无 id 的裸 div 卡片也能被定位到。
  // bridge 在 ISOLATED world，读不到 MAIN world 的对象，
  // 所以属性名在这里再写一份——两边同一份 manifest 发布，不会不同步。
  var E_ATTR = '[data-xy-card]';

  /**
   * 当前站点。面板文案、卡片定位、默认保存目录都跟着它走，
   * 所以三个站点共用同一套面板代码。
   */
  // 严格按当前站点走，绝不兜底：在淘宝页用闲鱼的选择器去扫，
  // 扫出来的东西会变成一批错数据，比不显示更糟。
  var SITE = (SITES && SITES.current(location)) || null;
  var SITE_NAME = SITE ? SITE.name : '商品采集';

  var DEFAULTS = {
    textFormat: 'txt',
    // 商品夹用 ID：不重名、无非法字符，软件靠 info.json 认商品
    dirTemplate: '{itemId}',
    // 与铺货软件约定的目录同名，固定成默认
    saveDir: 'downloaded_items',
    panelEnabled: true,
    showCheckbox: true,
    autoCopyTip: true
  };

  var settings = Object.assign({}, DEFAULTS);
  var detail = null;                    // 当前详情页商品
  var cardList = [];                    // 累积的商品池（滚动会不断增长）
  var cardIndex = Object.create(null);  // itemId -> card
  var selected = Object.create(null);   // 已勾选的 itemId
  var detailMap = Object.create(null);  // itemId -> 补全后的完整数据
  var panelEl = null;
  var toastTimer = null;

  /* ---------------- 设置 ---------------- */
  chrome.storage.sync.get(DEFAULTS, function (s) {
    settings = Object.assign({}, DEFAULTS, s || {});
  });
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'sync') return;
    Object.keys(DEFAULTS).forEach(function (k) {
      if (changes[k]) settings[k] = changes[k].newValue;
    });
    if (changes.panelEnabled) applyPanelVisibility();
  });

  /* ---------------- 与 MAIN world 通信 ----------------

     走签名通道（postbus）：每条消息自带 id / 时间戳 / 签名，
     页面里那些第三方脚本既伪造不了也抢答不了。
  */
  var bus = window.XYPostBus ? window.XYPostBus.channel('bridge') : null;

  bus && bus.on('injected', 'detail', function (m) {
    if (!m) return null;
    detail = m;
    if (m.itemId) detailMap[m.itemId] = m;
    render();
    return null;
  });
  bus && bus.on('injected', 'cards', function (m) {
    if (!m || !Array.isArray(m.list)) return null;
    var prev = cardList.length;
    cardList = m.list;
    cardList.forEach(function (c) { cardIndex[c.itemId] = c; });
    attachChecks();
    if (m.added > 0) render();
    else if (cardList.length !== prev) render();
    renderShopGrid();
    return null;
  });
  // extract.js 的 fiber 扫描是延后一拍跑的：这之前卡片数据已经到过 bridge，
  // 但那些节点还都没打上标记，复选框因此漏挂了一轮。
  // 扫描完成后把认出来的 id 推过来，这里补挂一次。
  bus && bus.on('injected', 'cards-relocate', function (m) {
    var ids = (m && m.ids) || [];
    var n = 0;
    for (var i = 0; i < ids.length; i++) {
      if (attachOne(ids[i])) n++;
    }
    if (n) render();
    return null;
  });
  bus && bus.on('injected', 'card-detail', function (m) {
    if (!m || !m.itemId) return null;
    // 细节接口可能比已缓存的卡片信息更全，也可能更薄，
    // 因此用「旧数据打底 + 新数据覆盖 + 主图取更全的那份」合并，别整体替换。
    var oldD = detailMap[m.itemId];
    if (oldD) {
      var keepImgs = (m.images && m.images.length) ? m.images : (oldD.images || []);
      detailMap[m.itemId] = Object.assign({}, oldD, m, { images: keepImgs });
    } else {
      detailMap[m.itemId] = m;
    }
    cardIndex[m.itemId] = Object.assign({}, cardIndex[m.itemId] || {}, m);
    return null;
  });
  bus && bus.on('injected', 'ensure-progress', function (m) {
    var p = m || {};
    toast('正在补齐商品详情 ' + p.done + '/' + p.total + '…');
    return null;
  });

  /* ---------------- 后台标签页补详情 ----------------
   *
   * 淘宝的详情接口只认真实详情页上下文（在搜索页调一律超时），
   * 所以 injected 会请求「借一个后台标签页」去采。这里只管转发：
   * 开页 / 导航 / 下发采集 / 回收全在 service worker 里做。
   */
  bus && bus.on('injected', 'bg-detail', function (p) {
    var id = p && p.itemId;
    if (!id) return { ok: false, error: '缺 itemId' };
    // 地址由页面侧给出（它最清楚本站详情页长什么样），SW 只做白名单校验。
    var url = (SITE && SITE.itemUrl) ? SITE.itemUrl(String(id)) : '';
    if (!url) return { ok: false, error: '本站无详情页地址规则' };
    return callBg({ type: 'xy:bg-detail', itemId: String(id), url: url });
  });
  bus && bus.on('injected', 'diagnose', function (m) {
    saveDiagnoseReport(m);
    return null;
  });
  bus && bus.on('injected', 'reset', function () {
    detail = null;
    selected = Object.create(null);
    cardList = [];
    cardIndex = Object.create(null);
    detailMap = Object.create(null);
    render();
    return null;
  });

  // 没有 postbus 时的旧通道（页面缓存了旧代码才会走到）
  window.addEventListener('message', function (e) {
    if (bus) return;   // 新通道已经在监听了，别重复处理
    if (e.source !== window) return;
    var m = e.data;
    if (!m || m.source !== 'xy-injected') return;

    if (m.type === 'detail' && m.payload) {
      detail = m.payload;
      detailMap[detail.itemId] = detail;
      render();
    } else if (m.type === 'cards' && m.payload && Array.isArray(m.payload.list)) {
      var prev = cardList.length;
      cardList = m.payload.list;
      cardList.forEach(function (c) { cardIndex[c.itemId] = c; });
      attachChecks();
      if (m.payload.added > 0) render();
      else if (cardList.length !== prev) render();
    } else if (m.type === 'card-detail' && m.payload && m.payload.itemId) {
      // 细节接口可能比已缓存的卡片信息更全，也可能更薄，
      // 因此用「旧数据打底 + 新数据覆盖 + 主图取更全的那份」合并，别整体替换。
      var pd = m.payload;
      var oldD = detailMap[pd.itemId];
      if (oldD) {
        var keepImgs = (pd.images && pd.images.length) ? pd.images : (oldD.images || []);
        detailMap[pd.itemId] = Object.assign({}, oldD, pd, { images: keepImgs });
      } else {
        detailMap[pd.itemId] = pd;
      }
      cardIndex[pd.itemId] = Object.assign({}, cardIndex[pd.itemId] || {}, pd);
    } else if (m.type === 'ensure-progress') {
      var p = m.payload || {};
      toast('正在补齐商品详情 ' + p.done + '/' + p.total + '…');
    } else if (m.type === 'diagnose' && m.payload) {
      saveDiagnoseReport(m.payload);
    } else if (m.type === 'reset') {
      detail = null;
      selected = Object.create(null);
      cardList = [];
      cardIndex = Object.create(null);
      detailMap = Object.create(null);
      render();
    }
  });

  /**
   * 向 MAIN world 发指令，回报 promise。
   * 走 postbus 通道时 postbus 会自动把返回值带回来（异步 handler 会等它 settle），
   * 所以调用方可以统一 await；postbus 没加载上时退回裸 postMessage，
   * 那条路没有回包，只能返回一个立刻决议的 promise——宁可少补数据，也不能让人干等。
   */
  function askInjected(type, payload, opts) {
    if (bus) {
      return bus.ask('injected', type, payload || {}, opts)
        .catch(function (err) {
          console.warn('[xy] ' + type + ' 失败：', err && err.message);
          return null;
        });
    }
    window.postMessage({ source: MSG, type: type, payload: payload || {} }, '*');
    return Promise.resolve(null);
  }

  /* ---------------- 复制 ---------------- */
  function copyText(text) {
    if (!text) return Promise.resolve(false);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text)
        .then(function () { return true; })
        .catch(function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }

  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px;left:0;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      var ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) {
      return false;
    }
  }

  function doCopy(text, tip) {
    copyText(text).then(function (ok) {
      toast(ok ? (tip || '已复制') : '复制失败，请手动选择文本');
    });
  }

  /* ---------------- 下载（交给 SW） ----------------

   * 判据：扩展上下文失效时，内容脚本还挂在页面上，但拿不到扩展 API，
   * 于是 `chrome.runtime.sendMessage` 同步抛
   *   Cannot read properties of undefined (reading 'sendMessage')
   * 这种错重试一百次也没用，唯一出路是让内容脚本重新注入 —— 也就是刷新页面。
   * 所以这里把它单独标成 expired，由展示层给一句人话，并顺手替用户刷新。
   */
  function ctxDead(m) {
    return /sendMessage|reading 'runtime'|Extension context invalidated|Could not establish|Receiving end does not exist/i.test(m || '');
  }

  /**
   * 刷新当前标签，让内容脚本按新版本的 manifest 重新注入。
   *
   * ⚠️ content script 里 **拿不到 tabId**，`chrome.tabs.reload()` 不带参数
   *    在内容脚本中是无效调用（会抛或静默失败），所以自愈从来就没成功过——
   *    之前的测试把 chrome.tabs.reload mock 成永远成功，正好把这个洞盖住了。
   *
   * 两条可靠路径，按优先级：
   *   ① chrome.tabs.reload(ChromeTabsQuery, {fromCache:false}) —— 需要 tabs 权限
   *   ② location.reload() —— 永远可用，且正好能重新注入当前页的内容脚本
   * ① 失败就用 ②，不能让「自动恢复」这条路也断掉。
   */
  function reloadSelf() {
    // ① 通过 tabs API：能拿到 windowId（content script 允许这样定位自己）
    try {
      if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.query &&
          chrome.tabs.reload) {
        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
          var ok = false;
          try {
            if (!chrome.runtime.lastError && tabs && tabs.length) {
              chrome.tabs.reload(tabs[0].id, { bypassCache: false });
              ok = true;
            }
          } catch (e) {}
          if (!ok) location.reload();     // ①失败立刻降级到 ②
        });
        return true;
      }
    } catch (e) {}

    // ② 兜底：直接刷当前页
    try {
      location.reload();
      return true;
    } catch (e) {}

    // ③ 最后手段：让用户自己按 F5
    try { toast('扩展已更新，请按 F5 刷新本页'); } catch (e) {}
    return false;
  }

  function callBg(msg) {
    return new Promise(function (resolve) {
      try {
        if (typeof chrome === 'undefined' || typeof chrome.runtime === 'undefined') {
          resolve({ ok: false, error: '扩展上下文已失效，请刷新页面', expired: true });
          return;
        }
        chrome.runtime.sendMessage(msg, function (res) {
          try {
            if (chrome.runtime.lastError) {
              var le = chrome.runtime.lastError.message || '';
              if (ctxDead(le)) return resolve({ ok: false, error: '扩展上下文已失效，请刷新页面', expired: true });
              return resolve({ ok: false, error: le || '后台无响应' });
            }
            resolve(res || { ok: false, error: '无响应' });
          } catch (e2) {
            var m2 = String(e2 && e2.message || e2);
            if (ctxDead(m2)) resolve({ ok: false, error: '扩展上下文已失效，请刷新页面', expired: true });
            else resolve({ ok: false, error: m2 });
          }
        });
      } catch (e) {
        var m = String(e && e.message || e);
        resolve(ctxDead(m)
          ? { ok: false, error: '扩展上下文已失效，请刷新页面', expired: true }
          : { ok: false, error: m });
      }
    });
  }

  /**
   * 后台标签页里的 bridge 会收到这条：SW 让我们「就在这个详情页上采一次」。
   * 只有被 tabs.sendMessage 点名的那个标签页收得到，其它页面不受影响。
   */
  try {
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (msg && msg.type === 'xy:collect-detail') {
        askInjected('collect-detail', { itemId: msg.itemId }, { timeout: 30000 })
          .then(function (r) { sendResponse(r || { ok: false, error: '采集无返回' }); })
          .catch(function (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); });
        return true;   // 异步响应，别让通道提前关掉
      }
      // 后台标签页要求：在 create-order 页采规格图（实测规格图只在这里）
      if (msg && msg.type === 'xy:collect-spec-images') {
        askInjected('collect-spec-images', msg.opt || {}, { timeout: 45000 })
          .then(function (r) { sendResponse(r || { ok: false, error: '采集无返回' }); })
          .catch(function (e) { sendResponse({ ok: false, error: String(e && e.message || e) }); });
        return true;
      }
      return false;
    });
  } catch (e) {}

  /**
   * 后台回来说失败时的统一文案。
   * 上下文失效不算「操作失败」，给一句能照做的提示，并顺手刷新页面自愈；
   * 其余情况把后台给的原因原样报出来。
   */
  function errText(res) {
    if (res && res.expired) {
      // 顺序有讲究：先把提示写进 sessionStorage 再刷新。
      // 直接 toast 的话，页面一刷提示就没了，用户只看到「失败」，
      // 不知道发生了什么、也不知道页面正在自动恢复。
      try {
        sessionStorage.setItem('xy_ctx_notice', '扩展已更新，正在重新加载页面，请稍候…');
      } catch (e) {}
      toast('扩展上下文已失效，正在刷新页面…（若没自动刷新请按 F5）');
      reloadSelf();
      return '扩展上下文已失效';
    }
    return ((res && res.error) || '未知错误');
  }

  function baseDir() {
    return (settings.saveDir || '').replace(/[\\/]+$/, '');
  }

  function dirOf(d) {
    var base = baseDir();
    return (base ? base + '/' : '') + U.buildDirName(d || {}, settings.dirTemplate);
  }

  async function downloadImages() {
    if (!detail) { toast('尚未获取到商品数据'); return; }
    // 只下图片，不生成文案文件；info.json 照写——没有它这个目录软件读不了
    var it = itemOf(detail, { text: false });
    if (!it || !it.images.length) { toast('没有获取到主图'); return; }
    toast('开始下载 ' + it.images.length + ' 张图片…');
    var res = await callBg({ type: 'xy:download-items', items: [it] });
    toast(res.ok
      ? '已下载 ' + res.images + '/' + res.imgTotal + ' 张' +
        (res.info ? '，info.json 已写入' : '')
      : '下载失败：' + errText(res));
  }

  async function saveText(data, filename) {
    var d = data || detail;
    if (!d) { toast('尚未获取到商品数据'); return; }
    var text = U.buildText(d, settings.textFormat);
    var res = await callBg({
      type: 'xy:save-text',
      text: text,
      dir: dirOf(d),
      filename: filename || ('文案' + U.textExt(settings.textFormat))
    });
    toast(res.ok ? '文案已保存' : '保存失败：' + errText(res));
  }

  async function packAll() {
    if (!detail) { toast('尚未获取到商品数据'); return; }
    var it = itemOf(detail);
    if (!it) { toast('尚未获取到商品数据'); return; }
    var vids = it.videos || [];
    if (!it.images.length && !vids.length && !(it.skus && it.skus.list && it.skus.list.length)) {
      toast('这件商品没有可下载的内容');
      return;
    }
    var res = await callBg({ type: 'xy:download-items', items: [it] });
    toast(res.ok
      ? '打包完成：图片 ' + res.images + '/' + res.imgTotal + ' 张' +
        (res.videos ? '，视频 ' + res.videos + ' 个' : '') +
        '，文案' + (res.textOk ? '✓' : '✗') + (res.info ? '，info.json ✓' : '')
      : '打包失败：' + errText(res));
  }

  /**
   * 只下视频，不带图和文案。
   * 视频动辄几十 MB，跟图片混在一次里会让人等不到进度反馈；
   * 想单独拿视频的场合（重新补下、只要视频）走这里。
   */
  async function downloadVideosOnly() {
    if (!detail) { toast('尚未获取到商品数据'); return; }
    var it = itemOf(detail, { text: false });
    if (!it) { toast('尚未获取到商品数据'); return; }
    var vids = it.videos || [];
    if (!vids.length) { toast('这件商品没有检测到视频'); return; }

    toast('正在下载 ' + vids.length + ' 个视频…');
    var res = await callBg({ type: 'xy:download-videos', item: it });
    if (!res || !res.ok) {
      toast('视频下载失败：' + errText(res));
      return;
    }
    toast(res.videosDone
      ? '视频下载完成：' + res.videosDone + '/' + vids.length + ' 个'
      : '视频下载失败：' + (res.errors && res.errors.length ? res.errors[0] : '未知原因'));
  }

  /**
   * 诊断报告落盘。它的用途是「把用户看到的页面结构搬到对话里」——
   * 选择器只能靠真实结构来定，光看代码猜必然返工。
   */
  function saveDiagnoseReport(report) {
    var head = [
      '站点：' + (report.siteName || '-') + '(' + (report.site || '-') + ')',
      '地址：' + (report.href || '-'),
      '识别模式：' + (report.mode || '-'),
      '商品池：' + (report.cardsInPool || 0) + ' 个'
    ];
    // 图上有没有存货是「下载只有一张」时最想先看的数字，放最前面，
    // 省得还得去底下 JSON 里翻 packCheck
    var pc = report.packCheck && report.packCheck.summary;
    if (pc) {
      head.push('打包体检：共 ' + pc.total + ' 个 → 无图 ' + pc.img0 +
        ' / 仅 1 张 ' + pc.img1 + ' / 少量(<5) ' + pc.imgFew +
        ' / 够用(≥5) ' + pc.imgEnough + '；带规格 ' + pc.withSkus +
        '；缺描述 ' + pc.noDesc);
    }
    var el = report.enrichLog || [];
    if (el.length) {
      var last = el[el.length - 1];
      head.push('最近一次补详情：要补 ' + last.todo + ' → 成功 ' + last.detailOk +
        ' / 失败 ' + last.detailFail + '；规格 ' + last.skuOk + '/' + last.skuTodo);
    }
    // 补图位的最后一环能不能跑通，看这一行就知道：
    // 「无响应」是接口没打通，「images 0」是商家没往正文传图，两者修法完全不同。
    var dp = report.descProbe;
    if (dp && typeof dp === 'object') {
      head.push('详情正文取图：返回 ' + dp.raw + ' → 抠出 ' + dp.images + ' 张（试的是商品 ' + dp.itemId + '）');
    } else if (dp) {
      head.push('详情正文取图：' + dp);
    }
    // 列表页最常见的「半死不活」状态就是「图有、标题有、唯独价格空」——
    // 而这既可能是选择器不对，也可能是命中了促销节点被长度检查挡掉。
    // 把候选节点连同文本摆到报告最前面，一眼就能看出该配哪个选择器，
    // 不用再让人去 Console 里手抠（京东店铺页多套模板，这事发生过）。
    var pp = report.priceProbe;
    // 注意别用 `pp && pp.length` 判数组 —— 字符串也有 length，
    // 会把 '(站点无 cardSel)' 这种提示语送进 forEach 然后崩掉。
    if (Array.isArray(pp) && pp.length) {
      head.push('价格节点探测：');
      pp.forEach(function (p) {
        head.push('  [' + p.卡片 + ']');
        (p.价格节点 || []).forEach(function (l) { head.push('    ' + l); });
      });
    } else if (pp) {
      head.push('价格节点探测：' + pp);
    }
    var text = head.join('\n') + '\n\n' + JSON.stringify(report, null, 2);
    callBg({
      type: 'xy:save-text',
      text: text,
      dir: baseDir() + '/诊断报告',
      filename: '站点诊断_' + (report.site || 'unknown') + '_' + Date.now() + '.txt'
    }).then(function (res) {
      toast(res.ok
        ? '诊断报告已保存，发出来即可精确调整'
        : '诊断导出失败：' + errText(res));
    });
  }

  function selectedIds() {
    return Object.keys(selected);
  }

  /* ---------------- 批量操作 ---------------- */

  // 一个对象里是否「有货」：标题 / 正文 / 主图 / 图集，有个就算数。
  // 详情接口偶尔会回一个只有 itemId 的空壳（请求失败或被风控打回时就是这样），
  // 空壳对象是 truthy，`detailMap[id] || cardIndex[id]` 会取到它，
  // 把卡片里本来就有的标题和主图挡在后面。
  function hasThing(x) {
    return !!(x && (x.title || x.desc || x.image || (x.images || []).length));
  }

  /**
   * 取一个商品可用于打包的数据。
   *
   * 之前写的是 `detailMap[id] || cardIndex[id] || {}`，这里的 `||` 只在
   * 对象「不存在」时才降级。而 detailMap 里很可能是一个只有 itemId、
   * 字段全空的空壳对象（truthy），于是取到空壳 → title/image 全空 →
   * selectedItems() 的过滤条件命中 → 整件商品被丢掉 → 报
   * 「没有可以处理的商品」（2026-09-27 真机实测，见 tools/diag-packdump.js）。
   *
   * 所以这里按「有没有实质内容」判定，而不是按对象是否 truthy：
   * 详情有货用详情，详情是空壳就退回卡片数据。
   */
  function dataOf(id) {
    var d = detailMap[id];
    var c = cardIndex[id];
    if (hasThing(d)) return d;
    if (hasThing(c)) return c;
    return d || c || {};
  }

  // 判定一个商品的数据是否「够用」：
  //   · 缺描述 → 文案里就没有正文
  //   · 没有可用主图（一张都没有，或只有头像）→ 打包时只会下一个头像
/**
 * 这件商品的数据「薄不薄」—— 薄就要先去补详情再下载。
 *
 * ⚠️ 必须把 **skus** 算进去（2026-10-17 修）：
 *     原来只看 desc 和图片数，导致「有描述 + 有 2 张图、但完全没有规格表」
 *     的卡片被判为「不薄」→ 跳过补详情 → 多规格商品的规格表永远拿不到，
 *     批量下载时 sku 全丢，而且**没有任何报错**。
 *     而多规格恰恰是那种详情页数据比列表页多得多的情况。
 *
 * 判断规格是否缺失：没有任何维度值，或所有维度值都只有 1 个值
 * （只有 1 个值的维度等于没规格，不必为它再跑一次详情）。
   */
  function dataThin(id) {
    var d = dataOf(id);
    var imgs = U.filterItemImages(d.images || (d.image ? [d.image] : []));
    if (!d.desc || imgs.length < 2) return true;
    // 有多规格吗？多个维度值才算真规格
    var skus = d.skus;
    if (!skus || !skus.list || !skus.list.length) return true;   // 完全没有规格表
    var defs = skus.specDefs || [];
    var hasRealSpec = defs.some(function (d2) {
      return d2 && d2.values && d2.values.length > 1;
    });
    return !hasRealSpec;
  }

/**
   * 批量处理：**逐件流水线** —— 补齐一件，立刻下载它，再处理下一件。
   *
   * ⚠️ 为什么必须是「补一个下一个」（2026-10-19 客户实测反馈）：
   *   客户反馈「一直提示在补齐，但我看没有下载」。查下来是三版递进的错：
   *     v1.8.0 全部补齐完才下 → 300 件干等 5.6 分钟零产出
   *     v1.8.1 改成分批（20 件一批）→ 第一批仍要等 20 件补完
   *   客户当场问出关键一句：「为什么不是补齐一个，下载一个呢？」
   *
   *   攒批在任何批大小下都有问题：批越大首个文件越晚，
   *   批越小往返开销越明显，而客户要的只是「看着它一个个往前走」。
   *
   * 现在就是最朴素的做法：一件一件来。
   * 实测补齐一件约 30 秒 → **第一个文件夹 30 秒内出现**，之后持续增加。
   *
   * 并行度保留：起 FLOW 个 worker 各自往下走，
   * 既保证「补一个下一个」的观感，又让总耗时不至于翻成单倍。
   */
  var FLOW = 3;              // 同时推进的件数（补齐本身在后台已是 3 路并行）

  async function withEnrichedSelected(cb) {
    var ids = selectedIds();
    if (!ids.length) {
      toast('请先在页面上勾选要处理的商品');
      return;
    }

    // 数据够全、不必补的那些，先原地处理掉，别占流水线
    var queue = ids.slice();

    // ★★ 先问后台：哪些已经下载过？（2026-10-19 用户实测发现的问题）
    //   判重原本只在下载那一步做，于是**已下载的商品仍要先花 30 秒补齐详情**，
    //   才轮到被判重跳过 —— 用户看到的就是「又提示补齐商品详情」，
    //   完全感受不到跳过。顺序必须反过来：先问、先剔、再补。
    var alreadyDirs = {};
    try {
      var probe = itemsOfIds(queue).map(function (it) {
        return { dir: it.dir, site: it.site, itemId: it.itemId };
      });
      if (probe.length) {
        var chk = await callBg({ type: 'xy:check-history', items: probe });
        if (chk && chk.ok && chk.dirs && chk.dirs.length) {
          chk.dirs.forEach(function (d) { alreadyDirs[d] = true; });
        }
      }
    } catch (e) {
      console.warn('[闲鱼助手] 下载历史预检失败（不影响下载）：', e);
    }

    var queueItems = {};
    itemsOfIds(queue).forEach(function (it) { queueItems[it.dir] = it; });
    var already = Object.keys(alreadyDirs).map(function (d) { return queueItems[d]; })
      .filter(Boolean);

    if (already.length) {
      toast('勾选的 ' + queue.length + ' 个里，有 ' + already.length +
        ' 个之前已下载过，将跳过');
    }

    // 真正要处理的：没下过的
    var todo = queue.filter(function (id) {
      var d = dataOf(id);
      if (!d) return false;
      var it = queueItems[dirOf(d)];
      return !it || !alreadyDirs[it.dir];
    });

    if (!todo.length) {
      toast('勾选的商品都下过了，没有需要处理的' +
        '（要重下请点「重下勾选商品」）');
      return;
    }

    var cursor = 0;
    var done = 0;
    var t0 = Date.now();

    function toastProgress() {
      var used = Math.round((Date.now() - t0) / 1000);
      toast('正在处理 ' + done + '/' + todo.length + '（已用 ' + used + ' 秒）');
    }

    // 一个 worker：从队列里一件一件取，补齐后立刻交给回调下载
    async function worker() {
      while (true) {
        var i = cursor++;
        if (i >= todo.length) return;
        var id = todo[i];
        try {
          await enrichOne(id, cb);
        } catch (e) {
          console.warn('[闲鱼助手] 第 ' + (i + 1) + ' 件处理出错：', e);
        }
        done++;
        toastProgress();
      }
    }

    if (todo.length <= 1) {
      await enrichOne(todo[0], cb);
      return;
    }
    toast('共 ' + todo.length + ' 件待处理，将逐件进行：补齐一件立即下载一件');
    var workers = [];
    for (var w = 0; w < Math.min(FLOW, todo.length); w++) {
      workers.push(worker());
    }
    await Promise.all(workers);
    console.log('[闲鱼助手] 全部完成，用时 ' +
      Math.round((Date.now() - t0) / 1000) + ' 秒');
  }

  /**
   * 补齐**一件**，然后立刻执行回调（也就是下载这一件）。
   *
   * 这一件数据本来就够全的话，直接下载，不必走接口。
   */
  async function enrichOne(id, cb) {
    var need = [];
    var c = cardIndex[id] || {};
    if ((c.itemId || (detailMap[id] && detailMap[id].itemId)) && dataThin(id)) {
      need = [id];
    }
    var res = null;
    if (need.length) {
      var t0 = Date.now();
      try {
        // 单件：给了 5 分钟是防死锁。一件实际约 30 秒，
        // 真正的保护是「别卡死」而不是「到点放弃」——
        // 放弃的代价是这一件下不全。
        res = await askInjected('ensure-cards', { ids: need },
          { timeout: 5 * 60 * 1000 });
      } catch (e) {
        console.warn('[闲鱼助手] 补详情中断：', e);
      }
      var missed = (res && res.stillFailed) ? res.stillFailed.length : 0;
      if (missed) {
        toast('有 1 个商品两次都没取到完整详情（可能已下架或被限流），按现有信息打包');
      }
      console.log('[闲鱼助手] 补齐一件用时 ' +
        Math.round((Date.now() - t0) / 1000) + ' 秒，失败 ' + missed);
    }
    // ★ 这一件补齐完就立刻下载，然后才轮到下一件。
    //   把 id 传给回调 —— 回调必须只处理这一件，
    //   否则「流水线」只是换了个说法，实际仍在整批下载。
    //   必须 await：不 await 会让多件并发下载，
    //   争抢下载队列和进度统计，计数会乱、
    //   甚至互相覆盖同一目录下的 info.json。
    try {
      await cb([id]);
    } catch (e) {
      console.warn('[闲鱼助手] 该件下载出错：', e);
    }
  }

  /**
   * 把一件商品包成下载任务。
   *
   * 批量与单件都走这里——目录结构是铺货软件的输入契约，
   * 绝不能出现「批量下的和单件下的长得不一样」这种情况。
   * opts.text === false 时只下图片/规格/视频，不生成文案文件。
   */
  function itemOf(d, opts) {
    opts = opts || {};
    if (!d) return null;
    // 过滤掉头像 / 图标等非商品图，避免打包时只下载到一张头像。
    // 再按闲鱼的单品图位上限截断——超出的图下了也没处用，只是拖慢打包。
    var images = U.capImages(U.filterItemImages(d.images || (d.image ? [d.image] : [])));
    var it = {
      dir: dirOf(d),
      // 跨批次去重要用。站点必须带——各站的数字 ID 会撞车，
      // 只记 itemId 会把 A 站的 123 当成 B 站的 123 而误跳过。
      site: (SITE && SITE.key) || '',
      itemId: String(d.itemId || ''),
      images: images,
      skus: skusOf(d),
      videos: videosOf(d),
      // info.json 的原料。图片与规格的路径不在这里拼——
      // 那些由 util 的命名函数单点生成，保证和真实落盘文件名一致。
      meta: {
        title: d.title || '',
        description: d.desc || d.title || '',
        price: d.price || ''
      }
    };
    if (opts.text !== false) {
      it.text = U.buildText(d, settings.textFormat);
      it.filename = '文案' + U.textExt(settings.textFormat);
    }
    return it;
  }

  function selectedItems() {
    var out = [];
    selectedIds().forEach(function (id) {
      var d = dataOf(id);
      if (!d || (!d.title && !d.desc && !d.image && !(d.images || []).length)) return;
      var it = itemOf(d);
      if (it) out.push(it);
    });
    return out;
  }

  /** 指定 ID 的商品包成下载任务（流水线按件调用，不用整个勾选集） */
  function itemsOfIds(ids) {
    var out = [];
    (ids || []).forEach(function (id) {
      var d = dataOf(id);
      if (!d || (!d.title && !d.desc && !d.image && !(d.images || []).length)) return;
      var it = itemOf(d);
      if (it) out.push(it);
    });
    return out;
  }

  // 多规格明细。图片单独交给下载流程处理，这里只带必要的字段过去。
  // ⚠️ specDefs 必须一起带过去：规格图改成「维度值级」落盘后，
  // 下载侧遍历的是 specDefs[].values[]，少了这个字段等于一张规格图都下不了。
  // 这里以前是随手 new 一个精简对象，多加一个字段就会被静默丢掉——
  // 对接规范落地时正是这么断的，所以每个字段都要显式列出。
  function skusOf(d) {
    if (!d || !d.skus || !d.skus.list || !d.skus.list.length) return null;
    return {
      specs: d.skus.specs || [],
      specDefs: (d.skus.specDefs || []).map(function (def) {
        return {
          name: def.name || '',
          values: (def.values || []).map(function (v) {
            // ★ 规格图也要过 normalizeImageUrl！
            //   主图走 filterItemImages → 里面调了 normalizeImageUrl，
            //   所以主图是 https；但规格图这条路径**原来没有**，
            //   拿到的是接口给的原始 http:// 地址。
            //   闲鱼页面是 HTTPS → 混合内容被浏览器拦截 → 规格图一张都下不来。
            //   同一个商品主图能下、规格图下不了，就是这个差别。
            return {
              value: v.value || '',
              image: U.normalizeImageUrl(v.image || '')
            };
          })
        };
      }),
      list: d.skus.list.map(function (s) {
        return { key: s.key, price: s.price, stock: s.stock, image: s.image || '' };
      })
    };
  }

  /**
   * 视频列表。跟 skusOf 同一个理由：这里重建的对象会经过 postbus，
   * 必须显式把字段带全，否则下游静默拿到空数组。
   * 兼容旧的单数 video 字段（老缓存数据）。
   */
  function videosOf(d) {
    var list = (d && d.videos) || [];
    if (!list.length && d && d.video) {
      list = [{ url: d.video, duration: '', cover: '' }];
    }
    return list.filter(function (v) {
      return v && U.normalizeVideoUrl(v.url);
    }).map(function (v) {
      return {
        url: U.normalizeVideoUrl(v.url, true),   // 保留签名参数
        duration: v.duration != null ? String(v.duration) : '',
        cover: v.cover || ''
      };
    }).slice(0, 5);
  }

  async function batchDownloadImages(ids) {
    var items = Array.isArray(ids) ? itemsOfIds(ids) : selectedItems();
    if (!items.length) { toast('勾选的商品里没有可用主图'); return; }
    var totalImg = items.reduce(function (n, it) { return n + it.images.length; }, 0);
    toast('共 ' + items.length + ' 个商品 / ' + totalImg + ' 张图，正在下载…');
    var res = await callBg({
      type: 'xy:download-items',
      items: items
    });
    toast(res.ok
      ? '批量下载完成：图片 ' + res.images + '/' + res.imgTotal + ' 张，文案 ' +
        (res.textOk || 0) + ' 份' + failNote(res, enriched)
      : '批量下载失败：' + errText(res) + failNote(res, enriched));
  }

  async function batchSaveText(ids) {
    var items = Array.isArray(ids) ? itemsOfIds(ids) : selectedItems();
    if (!items.length) { toast('没有可保存的商品'); return; }
    var res = await callBg({
      type: 'xy:download-items',
      items: items.map(function (it) { return { dir: it.dir, images: [], text: it.text, filename: it.filename }; })
    });
    toast(res.ok ? '已保存 ' + res.items + ' 份文案' + enrichNote(enriched)
      : '保存失败：' + errText(res) + enrichNote(enriched));
  }

  /**
   * 下载历史面板：告诉用户记住了多少件，并提供清空入口。
   *
   * 判重主要靠**商品目录里的 `已下载标识_<站点>_<商品ID>.txt`**：
   * 这个文件名只由站点和商品 ID 决定，**卖家改标题、店铺改名都不会失效**，
   * 也不依赖扩展存储 —— 重装扩展、换浏览器都还认得。
   * 「下载历史」这条记录只是加速用的，清了不影响按标记文件判重。
   *
   * 「清空」是破坏性操作，必须二次确认——这是客户的机器。
   */
  async function showHistory() {
    var res = await callBg({ type: 'xy:history-stats' });
    if (!res || !res.ok) { toast('读取下载历史失败'); return; }
    var n = res.count || 0;
    var msg =
      '已记住 ' + n + ' 件下载过的商品（用于快速跳过）。\n\n' +
      '另外，你的下载目录里每个商品文件夹中都有一个：\n' +
      '  已下载标识_站点_商品ID.txt\n' +
      '它才是判重的主要依据 —— 只跟商品 ID 有关，\n' +
      '卖家改标题、店铺改名都不影响，重装扩展、换浏览器也还认得。\n\n' +
      '点「确定」清空这份快速记录（不影响按标记文件判重）。\n' +
      '想强制重下某个商品：删掉那个标记文件即可。';
    if (!n) {
      msg = '目前没有快速记录（一般是因为重装过扩展）。\n\n' +
        '不要紧：只要商品文件夹里有「已下载标识_站点_商品ID.txt」，\n' +
        '下次批量就会自动跳过。\n\n' +
        '点「确定」仍要清空，点「取消」返回。';
    }
    if (!confirm(msg)) return;
    var r2 = await callBg({ type: 'xy:clear-history' });
    toast(r2 && r2.ok ? '下载历史已清空' : '清空失败');
  }

  async function batchPack(ids, force) {
    // 流水线传进来的是「当前这一件」，不是整个勾选集
    var items = Array.isArray(ids) ? itemsOfIds(ids) : selectedItems();
    if (!items.length) return;
    // 单件不弹提示：流水线里每件都弹会刷屏，
    // 进度由 withEnrichedSelected 的统一提示负责
    if (items.length > 1) toast('正在处理 ' + items.length + ' 个商品…');
    var res = await callBg({
      type: 'xy:download-items',
      items: items,
      forceRedownload: !!force
    });
    toast(res.ok
      ? (res.skippedAll
        // 整批都是历史里下过的：这不是失败，得说清楚，别让用户以为坏了
        ? '这 ' + res.skippedAll + ' 个都是下过的，已跳过' +
          (res.skippedSample && res.skippedSample.length
            ? '（如：' + res.skippedSample.slice(0, 2).join('、') + '）' : '') +
          '。要重下请点「重下选中」'
        : '批量打包完成：' + res.items + ' 个商品，图片 ' + res.images + '/' + res.imgTotal +
          ' 张，文案 ' + (res.textOk || 0) + ' 份' +
          (res.skippedHistory ? '，跳过已下载 ' + res.skippedHistory + ' 件' : '') +
          (res.dedupSkipped ? '，省去重复请求 ' + res.dedupSkipped + ' 次' : '') +
          failNote(res, enriched))
      : '批量打包失败：' + errText(res) + failNote(res, enriched));
  }

  /**
   * 补详情的战果顺带说一句。补详情失败的商品会带着薄数据打包，
   * 结果就是「文案没正文 / 主图只有一张」，这话不说清楚，
   * 用户只会觉得是下载环节坏了。
   */
  function enrichNote(enriched) {
    if (!enriched) return '';
    if (enriched.fail > 0) return '（补详情失败 ' + enriched.fail + ' 个，商品信息偏薄）';
    if (enriched.skus && enriched.skus.done > 0) return '（补到 ' + enriched.skus.done + ' 个多规格）';
    return '';
  }

  /**
   * 「图片 X/Y 张」里的差额到底去哪了——后台一直在收 errors，
   * 但没人展示，于是防盗链 403 和「压根没图」在用户看来一模一样，
   * 只能反复试用去猜。这里把第一原因带出来。
   */
  function failNote(res, enriched) {
    var out = enrichNote(enriched);
    if (!res || !res.imgTotal) return out;
    var miss = res.imgTotal - (res.images || 0);
    if (miss <= 0) return out;
    var first = (res.errors || [])[0];
    return out + '（' + miss + ' 张没下下来' + (first ? '：' + String(first).slice(0, 50) : '') + '）';
  }

  async function exportCards(scope) {
    var list = scope === 'selected' ? selectedIds().map(function (id) { return cardIndex[id]; }).filter(Boolean) : cardList;
    if (!list.length) { toast(scope === 'selected' ? '还没有勾选商品' : '本页没有识别到商品'); return; }
    var lines = list.map(function (c, i) {
      return [i + 1, c.itemId, c.title, c.price, c.sellerNick, c.url].join('\t');
    });
    var text = ['序号', '商品ID', '标题', '价格', '店铺', '链接'].join('\t') + '\n' + lines.join('\n');
    var res = await callBg({
      type: 'xy:save-text',
      text: text,
      dir: baseDir() + '/' + SITE_NAME + '列表',
      filename: '商品列表_' + Date.now() + '.txt'
    });
    toast(res.ok ? '列表已导出（' + list.length + ' 条）' : '导出失败：' + errText(res));
  }

  /* ---------------- 页面内复选框 ---------------- */

  function attachChecks() {
    if (!settings.showCheckbox) return;
    if (!isListPage()) return;
    for (var i = 0; i < cardList.length; i++) {
      var c = cardList[i];
      if (!c) continue;
      try { attachOne(c.itemId); } catch (e) {}
    }
  }

  // 卡片节点定位，按顺序尝试：
  //   1) 站点给的链接选择器（1688 详情页 / 搜索页）
  //   2) data-* 属性
  //   3) 主图反查（1688 整店页唯一可用的路，见下）
  //   4) extract.js 从 React fiber 标出来的 data-xy-card（见下）
  function findCardEl(itemId) {
    if (!SITE) return null;
    if (SITE.linkSel) {
      var a = cardLinkEl(itemId);
      if (a) return a;
    }
    try {
      var byAttr = document.querySelector(
        '[data-offer-id="' + itemId + '"],[data-itemid="' + itemId + '"],[data-item-id="' + itemId + '"]'
      );
      if (byAttr) return byAttr;
    } catch (e) {}
    // 整店页那种无 class 无 id 的裸 div 拿不到任何属性，
    // 只能靠 fiber 扫描在 page 侧给它补的这一个标记
    try {
      var byFiber = document.querySelector(E_ATTR + '="' + itemId + '"');
      if (byFiber) return byFiber;
    } catch (e) {}
    return findCardByImage(itemId);
  }

  /**
   * 从链接选择器命中的所有节点里挑出「卡片本体」。
   *
   * 同一个商品的链接在页面上可能不止一处。1688 搜索页实测：
   * 除了 210x358 的卡片 <a>，店铺那一行还有个 20x20 的在线聊天按钮，
   * href 里同样带着 offerId=xxx。链接选择器会两个都命中，
   * 直接取第一个的话复选框有可能被塞进那个小图标里。
   * 所以按面积挑最大的，一个都没有时退回第一个（行为与原先一致）。
   */
  function cardLinkEl(itemId) {
    var nodes;
    try { nodes = document.querySelectorAll(SITE.linkSel(itemId)); }
    catch (e) { return null; }
    if (!nodes || !nodes.length) return null;
    if (nodes.length === 1) return nodes[0];
    var best = null, bestArea = 0;
    for (var i = 0; i < nodes.length; i++) {
      var r = null;
      try { r = nodes[i].getBoundingClientRect(); } catch (e) {}
      if (!r) continue;
      var area = (r.width || 0) * (r.height || 0);
      // 100x100：卡片本体必然超过，聊天按钮 / 小图标必然不足
      if (area > 10000 && area > bestArea) { bestArea = area; best = nodes[i]; }
    }
    return best || nodes[0];
  }

  /**
   * 按主图反查卡片容器。
   *
   * 1688 整店页（/page/offerlist.htm）的商品卡片是纯 inline-style div：
   * 无 class、无 id、无 data-*、无 href，任何基于属性或链接的选择器都会落空，
   * 页面复选框也就挂不上去。但接口里的 offerImages[0].imageURI 和 DOM 里
   * 主图的 src（带 .310x310 尺寸后缀）去后缀后是同构的，所以只能靠图比对。
   */
  function findCardByImage(itemId) {
    var card = cardIndex[itemId];
    if (!card) return null;
    var fp = U.imageFingerprint(card.image);
    if (!fp) return null;

    var imgs = document.querySelectorAll('img');
    var hits = [];
    for (var i = 0; i < imgs.length; i++) {
      // 跳过扩展自己渲染的区域（整店页商品网格、浮窗清单、toast）。
      // 那些图是我们贴上去的，反查回来只会把勾选框重复挂一遍
      // ——实测网格里每格出现两道框（10 格 20 个）。
      if (imgs[i].closest && imgs[i].closest('.xy-shop-grid,.xy-panel,#xy-toast,.xy-toast')) continue;
      if (U.imageFingerprint(imgs[i].getAttribute('src')) === fp) hits.push(imgs[i]);
    }
    if (!hits.length) return null;

    // 同一张主图可能被多个商品共用（实测接口里确有重复），
    // 这时按该商品在 cardList 中的位置取第 n 张，避免两件商品抢同一个容器。
    if (hits.length > 1) {
      var n = 0;
      for (var k = 0; k < cardList.length; k++) {
        var c = cardList[k];
        if (!c || !c.itemId) continue;
        if (c.itemId === itemId) break;
        if (U.imageFingerprint(c.image) === fp) n++;
      }
      return hits[Math.min(n, hits.length - 1)];
    }
    return hits[0];
  }

  function attachOne(itemId) {
    if (!itemId) return false;
    var link = findCardEl(itemId);
    if (!link) return false;
    var box = U.cardBox(link);
    if (!box || box.__xyCheckAttached) return false;
    if (!box.querySelector) return false;

    // 复选框是绝对定位的，容器需要变成定位上下文
    var pos = 'static';
    try { pos = getComputedStyle(box).position; } catch (e) {}
    if (pos === 'static') box.style.position = 'relative';

    var lab = document.createElement('label');
    lab.className = 'xy-check' + (selected[itemId] ? ' xy-check-on' : '');
    lab.setAttribute('data-xy-id', itemId);
    lab.title = '勾选后批量下载';

    var input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!selected[itemId];
    // 勾选状态由扩展自己记一份：站点可能在捕获阶段翻动 checked（见 boxOn 注释）
    input.__xyOn = !!selected[itemId];
    input.addEventListener('change', function (ev) {
      ev.stopPropagation();
      setSelected(itemId, boxOn(input, itemId));
    });
    input.addEventListener('click', function (ev) { ev.stopPropagation(); });

    lab.appendChild(input);
    box.appendChild(lab);
    box.__xyCheckAttached = true;
    return true;
  }

  // 一个商品可能在页面上出现多处（卡片 + 浮层清单），勾一次要全部跟着变。
  // 两种形态的选择器必须一起扫，否则会出现"清单勾了、卡片没勾"的错位。
  function syncCheckUI(itemId, on) {
    var sel = '.xy-check[data-xy-id="' + itemId + '"],'
      + '.xy-pick-row[data-xy-id="' + itemId + '"]';
    var labs = document.querySelectorAll(sel);
    for (var i = 0; i < labs.length; i++) {
      var inp = labs[i].querySelector('input');
      if (inp) { inp.__xyOn = !!on; inp.checked = !!on; }
      labs[i].classList.toggle('xy-check-on', !!on);
    }
  }

  /**
   * 读一个复选框当前的勾选状态。
   *
   * 优先用扩展自己维护的 input.__xyOn：1688 会在 window 捕获阶段
   * preventDefault() 的同时把 checked 翻转一次，等到本委托执行时
   * checked 已经是「翻转之后」的值。直接读它再取反，等于点第二次，
   * 结果是方框看着没动、selected 里也没进人（2026-09-27 实测）。
   */
  function boxOn(input, id) {
    if (input && typeof input.__xyOn === 'boolean') return input.__xyOn;
    if (input) return !!input.checked;
    return !!selected[id];
  }

  function setSelected(itemId, on) {
    if (on) selected[itemId] = 1;
    else delete selected[itemId];
    syncCheckUI(itemId, on);
    renderCount();
  }

  function selectAll(on) {
    cardList.forEach(function (c) {
      if (!c || !c.itemId) return;
      if (on) selected[c.itemId] = 1;
      else delete selected[c.itemId];
      syncCheckUI(c.itemId, on);
    });
    renderCount();
  }

  /* ---------------- 整店页：把商品渲染到页面上 ----------------
   *
   * 淘宝店铺页的商品是接口拉来的（mtop.taobao.shop.simple.item.fetch），
   * 页面 DOM 里根本没有它们 —— 实测 [class*=doubleCardWrapper] 数量为 0，
   * 页面上一个可勾的元素都不存在。用户「在商品左上角点一下勾选」这个
   * 已经形成的习惯动作，在这类页面无处落脚。
   *
   * 所以这里把商品池渲染成网格贴到页面上，勾选框沿用 .xy-check[data-xy-id]：
   * 点击走的是同一套全局委托，状态同步走 syncCheckUI，
   * 于是页面网格与右下角清单天然双向联动，不必另写一份选中逻辑。
   *
   * 只在这种「页面自己没有商品 DOM」的站点页启用；1688 那种页面自己就渲染
   * 商品卡的整店页不铺这一层，免得重复。
   */
  var shopGridEl = null;

  function isShopPage() {
    return !!(SITE && SITE.shopPageRe && SITE.shopPageRe.test(location.href));
  }

  function renderShopGrid() {
    if (!isShopPage() || !cardList.length) return;
    // 页面自己就有商品卡片时不必接管
    try {
      if (SITE.cardSel && document.querySelectorAll(SITE.cardSel).length) return;
    } catch (e) {}

    if (!shopGridEl) {
      shopGridEl = el('div', 'xy-shop-grid');
      shopGridEl.id = 'xy-shop-grid';

      var gHead = el('div', 'xy-sg-head');
      gHead.appendChild(el('span', 'xy-sg-title', '本页商品'));
      gHead.appendChild(el('span', 'xy-sg-tip', '左上角勾选 · 与右下角面板同步'));
      var gClose = el('span', 'xy-icon-btn', '×');
      gClose.title = '隐藏这块，改用右下角面板';
      gClose.addEventListener('click', function () { shopGridEl.style.display = 'none'; });
      gHead.appendChild(gClose);
      shopGridEl.appendChild(gHead);
      shopGridEl.appendChild(el('div', 'xy-sg-body'));
      document.body.appendChild(shopGridEl);
    }

    var title = shopGridEl.querySelector('.xy-sg-title');
    if (title) title.textContent = '本页商品（' + cardList.length + '）';

    var body = shopGridEl.querySelector('.xy-sg-body');
    body.innerHTML = '';
    cardList.forEach(function (c) {
      if (!c || !c.itemId) return;
      var on = !!selected[c.itemId];

      var cell = el('label', 'xy-sg-cell' + (on ? ' xy-check-on' : ''));
      cell.setAttribute('data-xy-id', c.itemId);

      var lab = el('span', 'xy-check');
      lab.setAttribute('data-xy-id', c.itemId);
      var input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = on;
      input.__xyOn = on;
      lab.appendChild(input);
      cell.appendChild(lab);

      var img = document.createElement('img');
      img.loading = 'lazy';
      img.src = c.image || '';
      cell.appendChild(img);

      var info = el('div', 'xy-sg-info');
      info.appendChild(el('div', 'xy-sg-name', String(c.title || '').slice(0, 70)));
      info.appendChild(el('div', 'xy-sg-price', c.price ? '¥' + c.price : ''));
      cell.appendChild(info);

      body.appendChild(cell);
    });
  }

  /* ---------------- 面板 UI ---------------- */
  function toast(msg) {
    var box = document.getElementById('xy-toast');
    if (!box) {
      box = document.createElement('div');
      box.id = 'xy-toast';
      box.className = 'xy-toast';
      document.body.appendChild(box);
    }
    box.textContent = msg;
    box.classList.add('xy-toast-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      box.classList.remove('xy-toast-show');
    }, 2600);
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function btn(label, act, cls) {
    var b = el('button', 'xy-btn ' + (cls || ''), label);
    b.dataset.act = act;
    return b;
  }

  function buildPanel() {
    var p = el('div', 'xy-panel');
    p.id = 'xy-panel';

    var head = el('div', 'xy-head');
    var title = el('span', 'xy-title', SITE_NAME + '助手');
    // 版本号直接标在标题旁。排查「浮窗没出现 / 勾选框没有」时，
    // 第一个要确认的就是浏览器里跑的是哪一版——以前只能去 chrome://extensions 翻，
    // 用户报问题时经常忘了说版本，白白来回好几轮。
    // 注意用 chrome.runtime.getManifest()：window.XYC 是 MAIN world 的变量，
    // ISOLATED 侧的 bridge 读不到。
    var verText = '?';
    try { verText = chrome.runtime.getManifest().version; } catch (e) {}
    var ver = el('span', 'xy-ver', 'v' + verText);
    ver.title = '当前运行的扩展版本';
    head.appendChild(title);
    head.appendChild(ver);
    var collapse = el('span', 'xy-icon-btn', '—');
    collapse.title = '收起';
    head.appendChild(collapse);
    p.appendChild(head);

    var body = el('div', 'xy-body');
    p.appendChild(body);

    collapse.addEventListener('click', function () {
      p.classList.toggle('xy-collapsed');
      collapse.textContent = p.classList.contains('xy-collapsed') ? '＋' : '—';
      collapse.title = p.classList.contains('xy-collapsed') ? '展开' : '收起';
      chrome.storage.local.set({ xyCollapsed: p.classList.contains('xy-collapsed') });
    });

    // 拖拽
    var dragging = false, ox = 0, oy = 0;
    head.addEventListener('mousedown', function (e) {
      if (e.target === collapse) return;
      dragging = true;
      var r = p.getBoundingClientRect();
      ox = e.clientX - r.left;
      oy = e.clientY - r.top;
      p.style.left = r.left + 'px';
      p.style.top = r.top + 'px';
      p.style.right = 'auto';
      p.style.bottom = 'auto';
      e.preventDefault();
    });
    document.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      p.style.left = Math.max(0, Math.min(window.innerWidth - 60, e.clientX - ox)) + 'px';
      p.style.top = Math.max(0, Math.min(window.innerHeight - 30, e.clientY - oy)) + 'px';
    });
    document.addEventListener('mouseup', function () {
      if (!dragging) return;
      dragging = false;
      chrome.storage.local.set({ xyPos: { left: p.style.left, top: p.style.top } });
    });

    return { root: p, body: body };
  }

  function renderDetail(body) {
    var d = detail;
    var preview = el('div', 'xy-preview');
    if (d.images && d.images.length) {
      var img = document.createElement('img');
      img.src = d.images[0];
      img.referrerPolicy = 'no-referrer';
      preview.appendChild(img);
    }
    var info = el('div', 'xy-info');
    info.appendChild(el('div', 'xy-name', U.trimText(d.title, 40) || '（未获取到标题）'));
    var meta = el('div', 'xy-meta');
    meta.appendChild(el('span', 'xy-price', d.price ? '¥' + d.price : '—'));
    if (d.sellerNick) meta.appendChild(el('span', 'xy-shop', d.sellerNick));
    if (d.images && d.images.length) meta.appendChild(el('span', 'xy-count', '图 ' + d.images.length));
    var nv = (d.videos || []).length || (d.video ? 1 : 0);
    if (nv) meta.appendChild(el('span', 'xy-count', '视频 ' + nv));
    info.appendChild(meta);
    preview.appendChild(info);
    body.appendChild(preview);

    var grid = el('div', 'xy-grid');
    [
      ['link', '复制链接'],
      ['title', '复制标题'],
      ['shop', '复制店铺名'],
      ['all', '复制全部'],
      ['img', '下载主图'],
      ['text', '保存文案'],
      ['video', '下载视频'],
      ['pack', '一键打包']
    ].forEach(function (b) { grid.appendChild(btn(b[1], b[0])); });
    body.appendChild(grid);

    var tip = el('div', 'xy-tip', '数据来源：' + (d.source === 'dom' ? '页面解析' : '接口拦截'));
    if (d.source === 'dom') {
      var refresh = el('button', 'xy-link-btn', '重新获取');
      refresh.addEventListener('click', function () {
        toast('正在重新获取…');
        askInjected('get-detail', { force: true });
      });
      tip.appendChild(refresh);
    }
    body.appendChild(tip);
  }

  function renderCount() {
    if (!panelEl) return;
    var n = panelEl.querySelector('.xy-sel-num');
    if (n) n.textContent = selectedIds().length;
    // 清单里的行数跟"已识别数"可能不一致（超出部分不渲染），
    // 这里只做文案同步，行数由 renderPicker 负责。
    var c = panelEl.querySelector('.xy-pick-count');
    if (c) {
      c.textContent = '已勾选 ' + selectedIds().length + ' 个'
        + (cardList.length > PICK_LIMIT ? '（共 ' + cardList.length + ' 个）' : '');
    }
  }

  /* ---------------- 浮层内选品清单 ----------------
   * 页面上的复选框要先把卡片节点找出来才插得上去，而 1688 整店页的卡片
   * 是纯 inline-style div，没有任何可选中属性，那种路子直接断掉。
   * 所以清单在浮层里自己列一遍商品，勾选状态跟页面复选框共用同一份
   * selected，下游的批量下载 / 保存文案 / 一键打包完全不用改。
   */
  var PICK_LIMIT = 60;

  function renderPicker(body) {
    var box = el('div', 'xy-pick');
    var list = cardList.slice(0, PICK_LIMIT);

    list.forEach(function (c) {
      if (!c || !c.itemId) return;
      var row = el('label', 'xy-pick-row' + (selected[c.itemId] ? ' xy-check-on' : ''));
      row.setAttribute('data-xy-id', c.itemId);

      var input = document.createElement('input');
      input.type = 'checkbox';
      input.className = 'xy-pick-box';
      input.checked = !!selected[c.itemId];
      // 与页面复选框保持一致：状态由扩展记，不依赖 checked
      input.__xyOn = !!selected[c.itemId];
      row.appendChild(input);

      var main = el('div', 'xy-pick-main');
      main.appendChild(el('div', 'xy-pick-title', U.trimText(c.title || '（无标题）', 26)));
      var meta = el('div', 'xy-pick-meta');
      if (c.price) meta.appendChild(el('span', 'xy-pick-price', '¥' + c.price));
      if (c.skus && c.skus.list && c.skus.list.length) {
        meta.appendChild(el('span', 'xy-pick-tag', c.skus.list.length + ' 规格'));
      }
      main.appendChild(meta);
      row.appendChild(main);

      // 标题太多时给个点击直接跳转，勾选用上面的框
      row.title = c.url || c.title || '';

      box.appendChild(row);
    });

    if (cardList.length > PICK_LIMIT) {
      box.appendChild(el('div', 'xy-pick-more',
        '仅列出前 ' + PICK_LIMIT + ' 个，共识别 ' + cardList.length + ' 个，'
        + '其余用「全选」批量勾选'));
    }
    body.appendChild(box);
  }

  // 清单里某一行被勾上后，只更新这一行，不整块重绘（重绘会丢滚动位置）
  function syncPickRow(itemId, on) {
    if (!panelEl) return;
    var row = panelEl.querySelector('.xy-pick-row[data-xy-id="' + itemId + '"]');
    if (!row) return;
    row.classList.toggle('xy-check-on', !!on);
    var inp = row.querySelector('.xy-pick-box');
    if (inp) inp.checked = !!on;
  }

  function renderListTools(body) {
    var head = el('div', 'xy-list-head');
    var count = el('span', 'xy-name',
      '已识别 ' + cardList.length + ' 个 · 已勾选 ' + Object.keys(selected).length + ' 个');
    count.className = 'xy-name xy-sel-num';
    head.appendChild(count);
    var ops = el('div', 'xy-list-ops');
    ops.appendChild(btn('全选', 'sel-all'));
    ops.appendChild(btn('全不选', 'sel-none'));
    ops.appendChild(btn('反选', 'sel-inv'));
    head.appendChild(ops);
    body.appendChild(head);

    if (cardList.length) {
      var phead = el('div', 'xy-pick-head',
        '选品（点击商品名跳转到该商品）');
      var pcnt = el('span', 'xy-pick-count',
        '已勾选 ' + selectedIds().length + ' 个');
      phead.appendChild(pcnt);
      body.appendChild(phead);
      renderPicker(body);
    }

    var grid = el('div', 'xy-grid xy-grid-batch');
    grid.appendChild(btn('下载勾选主图', 'b-img'));
    grid.appendChild(btn('保存勾选文案', 'b-text'));
    grid.appendChild(btn('勾选一键打包', 'b-pack'));
    grid.appendChild(btn('重下勾选商品', 'b-repack'));
    body.appendChild(grid);

    var grid2 = el('div', 'xy-grid');
    grid2.appendChild(btn('复制全部链接', 'links'));
    grid2.appendChild(btn('复制标题+链接', 'titles'));
    body.appendChild(grid2);

    body.appendChild(el('div', 'xy-tip', '向下滚动会自动继续识别更多商品，勾选项一次性下载'));

    var grid3 = el('div', 'xy-grid');
    grid3.appendChild(btn('导出站点诊断', 'diagnose'));
    grid3.appendChild(btn('下载历史', 'history'));
    body.appendChild(grid3);
    body.appendChild(el('div', 'xy-tip',
      '识别不准时点「导出诊断」，报告文件存到本地后发出来，据此精确定位选择器'));
  }

  // 只在商品页/搜索页/首页显示面板，其他页面不打扰
  function isListPage() {
    return !detail;
  }

  function isTargetPage() {
    if (!SITE) return false;
    // 详情页、搜索页、店铺页都算目标页
    if (SITE.pageIdRe && SITE.pageIdRe.test(location.href)) return true;
    if (SITE.shopPage) {
      if (SITE.shopPage.hostRe && SITE.shopPage.hostRe.test(location.host)) return true;
      if (SITE.shopPage.urlRe && SITE.shopPage.urlRe.test(location.pathname + location.search)) return true;
    }
    try {
      if (SITE.cardSel && document.querySelector(SITE.cardSel)) return true;
      if (SITE.idRe) {
        var as = document.querySelectorAll('a[href]');
        for (var i = 0; i < as.length; i++) {
          var h = as[i].getAttribute('href') || '';
          if (!h || h.length > 250) continue;
          if (SITE.idRe.test(h)) return true;
        }
      }
    } catch (e) {}
    // 已经抓到商品就一定要显示浮层。
    // 1688 整店页（/page/offerlist.htm）的商品卡片是纯 inline-style div——
    // 无 class、无 id、无 data-*、无 href，上面这套 DOM 探测全部落空，
    // 可接口返回的 offerList 明明白白有 10 件商品。若还要求"DOM 里有卡片"
    // 才显示浮层，用户就既看不见清单、也没法勾选。
    if (cardList.length) return true;
    return false;
  }

  function buildPanelOnce() {
    if (panelEl) return;
    var built = buildPanel();
    panelEl = built.root;
    document.body.appendChild(panelEl);
    chrome.storage.local.get(['xyCollapsed', 'xyPos'], function (o) {
      if (!panelEl) return;
      if (o.xyCollapsed) {
        panelEl.classList.add('xy-collapsed');
        var c = panelEl.querySelector('.xy-icon-btn');
        if (c) c.textContent = '＋';
      }
      if (o.xyPos && o.xyPos.left) {
        panelEl.style.left = o.xyPos.left;
        panelEl.style.top = o.xyPos.top;
        panelEl.style.right = 'auto';
        panelEl.style.bottom = 'auto';
      }
    });
  }

  function render() {
    if (!settings.panelEnabled) return;

    // 站点认出来了但功能未上线：明确说一句，别让用户以为插件坏了
    var off = SITES && SITES.inactive(location);
    if (off) {
      buildPanelOnce();
      var ob = panelEl.querySelector('.xy-body');
      ob.textContent = '';
      ob.appendChild(el('div', 'xy-empty', off.name + '采集'));
      ob.appendChild(el('div', 'xy-tip', off.name + '的支持还在开发中，先去闲鱼 / 1688 用吧'));
      ob.appendChild(el('div', 'xy-tip', '当前站点：' + location.host));
      panelEl.style.display = '';
      renderCount();
      return;
    }

    if (!isTargetPage()) {
      if (panelEl) panelEl.style.display = 'none';
      return;
    }
    buildPanelOnce();
    var body = panelEl.querySelector('.xy-body');
    body.textContent = '';

    if (detail) renderDetail(body);
    else if (cardList.length) renderListTools(body);
    else {
      var isItem = /\/item/.test(location.pathname) || /[?&]id=\d+/.test(location.search);
      body.appendChild(el('div', 'xy-empty', isItem ? '正在识别商品数据…' : '正在识别本页商品…'));
      var hint = el('div', 'xy-tip');
      hint.textContent = isItem
        ? '若一直无数据，点「重新获取」或刷新页面'
        : '列表为空时，先登录，然后向下滚动页面加载商品';
      body.appendChild(hint);
      var reBtn = btn('重新识别', 'reload-cards');
      body.appendChild(reBtn);
    }
    applyPanelVisibility();
    renderCount();
  }

  function applyPanelVisibility() {
    if (!panelEl) return;
    panelEl.style.display = settings.panelEnabled ? '' : 'none';
  }

  /* ---------------- 事件委托 ----------------
   * 挂在 **window 的捕获阶段**，不是 document。原因有两条，都是实测挖出来的
   * （2026-09-27，1688 关键词搜索页）：
   *
   * 1) 站点会在 window 上注册捕获阶段的 click 监听并 stopPropagation()，
   *    事件走到 win-capture 就断了，document 上的监听器一个都收不到。
   *    委托挂在 document 时，「用户点复选框方块」这件事永远收不到，
   *    表现就是「点了没反应 → 打包时报没有可处理的商品」。
   *    window 上的所有捕获监听器都会执行，插不进去。
   *
   * 2) 站点还会在同一个捕获阶段 preventDefault() **并把 checked 翻一下**
   *    （实测进入本委托时 defaultPrevented 已是 true、checked 已被翻成 true）。
   *    于是不能再拿 input.checked 当「当前勾选状态」——读到的是翻转之后的值，
   *    跟着取反就又翻回去了，点一次净变化为零。
   *    所以勾选状态由扩展自己用 input.__xyOn 记（见 attachOne），别信 checked。
   *
   * 另外这里只 preventDefault()，不再 stopPropagation()：默认行为
   * （勾选 / 卡片跳转）取消掉就够用，捕获阶段就截断传播会连带掐掉
   * 页面自己的脚本，代价太大。
   */
  window.addEventListener('click', function (e) {
    var t = e.target;

    // 页面内复选框：挡掉卡片跳转的默认行为
    var chk = t && t.closest ? t.closest('.xy-check') : null;
    if (chk) {
      e.preventDefault();

      var chkId = chk.getAttribute ? chk.getAttribute('data-xy-id') : '';
      var chkInput = chk.querySelector ? chk.querySelector('input[type=checkbox]') : null;
      var turnOn = !boxOn(chkInput, chkId);
      if (chkInput) { chkInput.__xyOn = turnOn; chkInput.checked = !!turnOn; }
      if (chkId) setSelected(chkId, !!turnOn);
      return;
    }

    // 浮层选品清单里的某一行：整行都能点，别只在小方块上
    var pick = t && t.closest ? t.closest('.xy-pick-row') : null;
    if (pick) {
      e.preventDefault();

      var pickId = pick.getAttribute('data-xy-id');
      var pickInput = pick.querySelector('.xy-pick-box');
      var pickOn = !boxOn(pickInput, pickId);
      if (pickInput) { pickInput.__xyOn = pickOn; pickInput.checked = !!pickOn; }
      if (pickId) setSelected(pickId, !!pickOn);
      return;
    }

    var btnEl = t && t.closest ? t.closest('.xy-btn') : null;
    if (!btnEl || !panelEl || !panelEl.contains(btnEl)) return;
    var act = btnEl.dataset.act;
    var d = detail || {};

    if (act === 'sel-all') { selectAll(true); toast('已全选 ' + cardList.length + ' 个'); return; }
    if (act === 'sel-none') { selectAll(false); toast('已清空勾选'); return; }
    if (act === 'sel-inv') {
      var n = 0;
      cardList.forEach(function (c) {
        if (!c || !c.itemId) return;
        var on = !selected[c.itemId];
        if (on) { selected[c.itemId] = 1; n++; } else delete selected[c.itemId];
        syncCheckUI(c.itemId, on);
      });
      renderCount();
      toast('已反选 ' + n + ' 个');
      return;
    }

    if (act === 'b-img') { withEnrichedSelected(batchDownloadImages); return; }
    if (act === 'b-text') { withEnrichedSelected(batchSaveText); return; }
    if (act === 'b-pack') { withEnrichedSelected(batchPack); return; }
    if (act === 'b-repack') {
      // 强制重下：绕过判重（存储历史 + 目录检测都不看）。
      // 商品改了图/改了价、想重新铺一遍时用。
      toast('将重新下载勾选商品（含已下载过的）');
      withEnrichedSelected(function (en) { return batchPack(en, true); });
      return;
    }

    if (act === 'link') doCopy(d.url || location.href, '链接已复制');
    else if (act === 'title') doCopy(d.title || document.title, '标题已复制');
    else if (act === 'shop') doCopy(d.sellerNick || '', d.sellerNick ? '店铺名已复制' : '未识别到店铺名');
    else if (act === 'all') {
      var all = [
        '标题：' + (d.title || ''),
        '价格：' + (d.price ? '¥' + d.price : ''),
        '店铺：' + (d.sellerNick || ''),
        '链接：' + (d.url || location.href),
        '',
        d.desc || ''
      ].join('\n');
      doCopy(all, '全部信息已复制');
    }
    else if (act === 'img') downloadImages();
    else if (act === 'text') saveText();
    else if (act === 'pack') packAll();
    else if (act === 'video') downloadVideosOnly();
    else if (act === 'reload-cards') {
      toast('正在重新识别…');
      attachChecks();
      askInjected('get-cards', {});
    }
    else     if (act === 'diagnose') {
      toast('正在采集诊断信息…');      askInjected('diagnose', {});
    }
    else if (act === 'history') showHistory();
    else if (act === 'links') doCopy(cardList.map(function (c) { return c.url; }).join('\n'), '已复制 ' + cardList.length + ' 条链接');
    else if (act === 'titles') doCopy(cardList.map(function (c) { return (c.title || '') + '\t' + c.url; }).join('\n'), '已复制标题+链接');
    else if (act === 'export-selected') exportCards('selected');
  }, true);

  /* ---------------- popup / 快捷键 ---------------- */
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg && msg.type === 'xy:get-state') {
      sendResponse({
        detail: detail,
        cards: cardList,
        selected: selectedIds()
      });
      return true;
    }
    if (msg && msg.type === 'xy:refresh') {
      askInjected('get-detail', { force: true });
      sendResponse({ ok: true });
      return true;
    }
    if (msg && msg.type === 'xy:get-selected') {
      sendResponse({ ids: selectedIds(), items: selectedItems() });
      return true;
    }
  });

  // 初始主动问一次（先渲染出面板骨架，避免"页面匹配了但一直不出现"）
  setTimeout(function () {
    if (isTargetPage()) render();
    var onDetail = SITE && SITE.pageIdRe && SITE.pageIdRe.test(location.href);
    askInjected(onDetail ? 'get-detail' : 'get-cards', {});
  }, 800);

  // 扩展自动更新后，上一次操作留下的「正在恢复」提示在这里补显。
  // 直接 toast 的话刷新就把它冲掉了，用户只看到失败不知道发生了什么。
  setTimeout(function () {
    try {
      var note = sessionStorage.getItem('xy_ctx_notice');
      if (note) {
        sessionStorage.removeItem('xy_ctx_notice');
        toast(note);
      }
    } catch (e) {}
  }, 1000);

  // 页面结构被 React 重绘后，补回可能被清掉的复选框
  setInterval(function () {
    if (settings.showCheckbox && !detail && isTargetPage()) attachChecks();
  }, 3000);
})();
