/**
 * 插件弹窗：预览当前页面商品数据 + 快捷操作 + 设置
 */
(function () {
  'use strict';
  // 优先用 util.js 里那份（下载目录的校验规则就在那儿，两份实现容易漂移）；
  // util.js 万一没加载上，退回下面的极简实现，保证弹窗不至于白屏。
  var U = window.XYUtil || {
    cleanFileName: function (n, max) {
      var s = String(n == null ? '' : n)
        .replace(/[\\/:*?"<>|\r\n\t]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!s) s = '未命名';
      return max && s.length > max ? s.slice(0, max) : s;
    },
    buildDirName: function (d, tpl) {
      var map = {
        shop: d.sellerNick || '未知店铺',
        title: d.title || '未命名',
        itemId: d.itemId || '0',
        price: d.price || '0',
        date: new Date().toISOString().slice(0, 10)
      };
      var s = String(tpl || '{shop}_{title}_{itemId}').replace(/\{(\w+)\}/g, function (_, k) {
        return map[k] != null ? String(map[k]) : '';
      });
      return U.cleanFileName(s, 80);
    },
    buildText: function (d, fmt) {
      fmt = (fmt || 'txt').toLowerCase();
      if (fmt === 'json') return JSON.stringify(d, null, 2);
      var L = [];
      L.push('标题：' + (d.title || ''));
      L.push('价格：' + (d.price ? '¥' + d.price : ''));
      L.push('店铺：' + (d.sellerNick || ''));
      if (d.sellerUrl) L.push('店铺主页：' + d.sellerUrl);
      if (d.location) L.push('所在地：' + d.location);
      L.push('商品链接：' + (d.url || ''));
      L.push('');
      L.push('【商品描述】');
      L.push(d.desc || d.title || '');
      L.push('');
      if (d.images && d.images.length) {
        L.push('【主图地址】');
        d.images.forEach(function (u, i) { L.push((i + 1) + '. ' + u); });
      }
      if (fmt === 'md') {
        var M = [];
        M.push('# ' + (d.title || ''));
        M.push('');
        M.push('- 价格：¥' + (d.price || '-'));
        M.push('- 店铺：' + (d.sellerNick || '-'));
        M.push('- 链接：' + (d.url || ''));
        M.push('');
        M.push('## 商品描述');
        M.push('');
        M.push(d.desc || d.title || '');
        M.push('');
        (d.images || []).forEach(function (u) { M.push('![](' + u + ')'); });
        return M.join('\n');
      }
      return L.join('\n');
    },
    textExt: function (f) { return f === 'json' ? '.json' : f === 'md' ? '.md' : '.txt'; },
    imageExt: function (u) {
      var m = String(u).match(/\.(jpg|jpeg|png|webp|gif)(?:$|\?)/i);
      return m ? '.' + m[1].toLowerCase() : '.jpg';
    },
    // 兜底：util.js 加载上时用的是它的真正实现
    checkSaveDir: function (v) {
      var s = String(v == null ? '' : v).trim();
      if (!s) return { ok: true, msg: '' };
      if (/^[a-zA-Z]:/.test(s)) return { ok: false, msg: '这是绝对路径，浏览器会忽略它。' };
      if (/^[\\/]/.test(s)) return { ok: false, msg: '不能以斜杠开头。' };
      if (s.indexOf('..') >= 0) return { ok: false, msg: '不能包含 ".."。' };
      return { ok: true, msg: '' };
    }
  };

  // 站点适配表由 sites.js 注入，这里只做兜底
  var SITES = window.XYSites || null;

  function defaultSaveDir() {
    var xy = SITES && SITES.get('xianyu');
    return (xy && xy.defaultDir) || '商品采集';
  }

  var DEFAULTS = {
    textFormat: 'txt',
    // 商品夹用 ID 命名：不重名、没有非法字符，软件靠 info.json 认商品
    dirTemplate: '{itemId}',
    // 铺货软件的下载目录就叫这个名字，固定成默认，省得每次装完还要改
    saveDir: 'downloaded_items',
    panelEnabled: true,
    showCheckbox: true,
    // 与 service_worker.js 的 DEFAULTS 保持同一份语义：关掉就不给图片补 Referer
    hotlinkFix: true
  };

  var settings = Object.assign({}, DEFAULTS);
  var detail = null;
  var cards = [];

  /* ---------------- UI ---------------- */
  var $ = function (id) { return document.getElementById(id); };

  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(function () { t.classList.remove('show'); }, 1800);
  }

  function loadSettings(cb) {
    chrome.storage.sync.get(DEFAULTS, function (s) {
      settings = Object.assign({}, DEFAULTS, s || {});
      $('cfg-dir').value = settings.saveDir;
      $('cfg-tpl').value = settings.dirTemplate;
      $('cfg-format').value = settings.textFormat;
      $('cfg-panel').checked = !!settings.panelEnabled;
      $('cfg-check').checked = settings.showCheckbox !== false;
      $('cfg-hotlink').checked = settings.hotlinkFix !== false;
      if (cb) cb();
    });
  }

  function saveSettings() {
    // Chrome 会静默忽略绝对路径和 ".."，不拦的话用户只会看到文件莫名落错地方
    var chk = U.checkSaveDir($('cfg-dir').value);
    if (!chk.ok) {
      toast(chk.msg);
      $('cfg-dir').focus();
      return;
    }
    settings.saveDir = $('cfg-dir').value.trim() || 'downloaded_items';
    settings.dirTemplate = $('cfg-tpl').value.trim() || '{itemId}';
    settings.textFormat = $('cfg-format').value;
    settings.panelEnabled = $('cfg-panel').checked;
    settings.showCheckbox = $('cfg-check').checked;
    settings.hotlinkFix = $('cfg-hotlink').checked;
    chrome.storage.sync.set(settings, function () { toast('设置已保存'); });
  }

  ['cfg-dir', 'cfg-tpl'].forEach(function (id) {
    $(id).addEventListener('change', saveSettings);
  });
  $('cfg-format').addEventListener('change', saveSettings);
  $('cfg-panel').addEventListener('change', saveSettings);
  $('cfg-check').addEventListener('change', saveSettings);
  $('cfg-hotlink').addEventListener('change', saveSettings);

  /* ---------------- 当前标签页数据 ---------------- */
  function loadState() {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      var tab = tabs && tabs[0];
      var host = '';
      try { host = new URL(tab.url).host; } catch (e) {}
      var site = SITES && SITES.active(host);
      if (!tab || !site) {
        var off = SITES && SITES.inactive({ host: host });
        $('site-state').textContent = off
          ? off.name + '支持开发中'
          : '请在闲鱼 / 1688 商品页使用';
        return;
      }
      $('site-state').textContent = '已连接 ' + site.name + ' 页面';
      chrome.tabs.sendMessage(tab.id, { type: 'xy:get-state' }, function (res) {
        if (chrome.runtime.lastError || !res) {
          $('site-state').textContent = '页面未加载完成，请刷新';
          return;
        }
        detail = res.detail;
        cards = res.cards || [];
        renderItem();
        renderList();
      });
    });
  }

  function renderItem() {
    if (!detail) return;
    $('item-img').src = (detail.images && detail.images[0]) || '';
    $('item-title').textContent = detail.title || '（未获取到标题）';
    $('item-price').textContent = detail.price ? '¥' + detail.price : '';
    $('item-shop').textContent = detail.sellerNick || '';
  }

  function renderList() {
    if (!cards.length) return;
    $('list-card').style.display = '';
    $('list-desc').textContent = '识别到 ' + cards.length + ' 个商品';
  }

  /* ---------------- 复制 / 下载 ---------------- */
  function copy(text, tip) {
    navigator.clipboard.writeText(text).then(function () {
      toast(tip || '已复制');
    }).catch(function () {
      toast('复制失败');
    });
  }

  function dirOf() {
    var base = (settings.saveDir || '').replace(/[\\/]+$/, '');
    return (base ? base + '/' : '') + U.buildDirName(detail || {}, settings.dirTemplate);
  }

  function dl(opts) {
    return new Promise(function (resolve) {
      chrome.downloads.download(opts, function (id) {
        resolve(!!id && !chrome.runtime.lastError);
      });
    });
  }

  /** 这件商品实际会落盘的那几张图（顺序 == 文件名里的序号） */
  function imagesOf(d) {
    if (!d) return [];
    return U.capImages(U.filterItemImages(d.images || (d.image ? [d.image] : [])));
  }

  /**
   * 写 info.json —— 铺货软件靠它识别商品，是这套目录结构的核心。
   * 里面的 local_images 用的就是下面 downloadImages 实际落盘的文件名，
   * 两边都出自 util 的同一套命名函数。
   */
  function writeInfo(dir, d) {
    var info = U.buildInfo(
      { title: d.title, description: d.desc || d.title, price: d.price },
      imagesOf(d),
      d.skus
    );
    return dl({
      url: 'data:application/json;charset=utf-8,' +
        encodeURIComponent(JSON.stringify(info, null, 2)),
      filename: dir + '/' + U.INFO_FILE,
      conflictAction: 'uniquify',
      saveAs: false
    });
  }

  function downloadImages() {
    if (!detail) { toast('暂无数据'); return; }
    var urls = imagesOf(detail);
    if (!urls.length) { toast('没有主图'); return; }
    var dir = dirOf();
    Promise.all(urls.map(function (u, i) {
      return dl({
        url: u,
        filename: dir + '/' + U.IMAGES_DIR + '/' + U.imageFileName(u, i),
        conflictAction: 'uniquify',
        saveAs: false
      });
    }).concat([writeInfo(dir, detail)])).then(function () {
      toast('主图 ' + urls.length + ' 张 + info.json 已提交');
    });
  }

  function saveText() {
    if (!detail) { toast('暂无数据'); return; }
    var text = U.buildText(detail, settings.textFormat);
    dl({
      url: 'data:text/plain;charset=utf-8,' + encodeURIComponent(text),
      filename: dirOf() + '/文案' + U.textExt(settings.textFormat),
      conflictAction: 'uniquify',
      saveAs: false
    }).then(function () { toast('文案已保存'); });
  }

  async function pack() {
    if (!detail) { toast('暂无数据'); return; }
    await saveText();
    downloadImages();
  }

  /* ---------------- 事件 ---------------- */
  $('btn-link').addEventListener('click', function () { copy(detail && detail.url || '', '链接已复制'); });
  $('btn-title').addEventListener('click', function () { copy(detail && detail.title || '', '标题已复制'); });
  $('btn-shop').addEventListener('click', function () { copy(detail && detail.sellerNick || '', '店铺名已复制'); });
  $('btn-all').addEventListener('click', function () {
    if (!detail) return toast('暂无数据');
    copy([
      '标题：' + (detail.title || ''),
      '价格：' + (detail.price ? '¥' + detail.price : ''),
      '店铺：' + (detail.sellerNick || ''),
      '链接：' + (detail.url || ''),
      '',
      detail.desc || ''
    ].join('\n'), '已复制全部信息');
  });
  $('btn-img').addEventListener('click', downloadImages);
  $('btn-text').addEventListener('click', saveText);
  $('btn-pack').addEventListener('click', pack);
  $('btn-links').addEventListener('click', function () {
    copy(cards.map(function (c) { return c.url; }).join('\n'), '已复制 ' + cards.length + ' 条链接');
  });
  $('btn-export').addEventListener('click', function () {
    var lines = [['序号', '商品ID', '标题', '价格', '店铺', '链接'].join('\t')];
    cards.forEach(function (c, i) {
      lines.push([i + 1, c.itemId, c.title, c.price, c.sellerNick, c.url].join('\t'));
    });
    dl({
      url: 'data:text/plain;charset=utf-8,' + encodeURIComponent(lines.join('\n')),
      filename: (settings.saveDir || 'downloaded_items') +
        '/_列表/商品列表_' + Date.now() + '.txt',
      conflictAction: 'uniquify',
      saveAs: false
    }).then(function () { toast('列表已导出'); });
  });
  $('btn-folder').addEventListener('click', function () {
    chrome.downloads.showDefaultFolder();
  });

  loadSettings(loadState);
})();
