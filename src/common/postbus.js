/**
 * 带签名的 postMessage 通道（借鉴 1688 官方插件的 ~libs/post-message）
 *
 * 背景：内容脚本（ISOLATED）和 injected.js（MAIN world）之间只能靠
 * window.postMessage 通信，而 1688 页面上跑着大量第三方脚本，谁都能
 * addEventListener('message') 伪造一条消息、或者抢答一条请求。
 * 所以每条消息都带上：
 *   id / timestamp —— 唯一请求号与时间戳，pending 按 id 存放，天然去重
 *   from / to      —— 路由，只处理发给自己的
 *   sign           —— fnv1a64(id & name & timestamp & payload)
 * 收到先验签，验不过直接丢；响应统一叫 `名字 + _FINISH`。
 *
 * 没有外部依赖：哈希自带，MAIN world 里也没法 require 别的文件。
 *
 * 验签规则：带 sign 的一律验，验不过丢弃；没 sign 的放行。
 * 后者是兜底——两边内容脚本同属一份 manifest，要么一起加载要么都加载不上，
 * 但没有 sign 的消息至少不会让对端直接崩掉，留条活路而已。
 */
(function (root) {
  'use strict';
  if (root.XYPostBus) return;

  /* ---------------- 消息签名 ----------------

   没有用手写 md5：32 位溢出、四组累加器的轮转顺序很容易写错，
   而且这里也不需要密码学强度——目的是「抗伪造、抗抢答」，不是「防解密」。
   所以取 FNV-1a 64 位：6 行、同步、无依赖，配合 id + timestamp
   已经把重放窗口压到毫秒级。
   若将来真要对付有组织的脚本，把这里换成 crypto.subtle.digest('SHA-256') 即可，
   通道其余部分不用动。
--------------------------------------------------------------------------- */

var MASK64 = 0xffffffffffffffffn;
var FNV_OFFSET = 0xcbf29ce484222325n;
var FNV_PRIME = 0x100000001b3n;

/** UTF-8 字节序列，签名只吃字节，避免中文 payload 被按 UTF-16 截断 */
function utf8Bytes(str) {
  var out = [], i, c;
  for (i = 0; i < str.length; i++) {
    c = str.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c < 0xd800 || c >= 0xe000) {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else {
      // 代理对，合成一个码点再编码
      i++;
      var c2 = str.charCodeAt(i);
      c = 0x10000 + (((c & 0x3ff) << 10) | (c2 & 0x3ff));
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f),
               0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return out;
}

function fnv1a64(str) {
  var bytes = utf8Bytes(String(str == null ? '' : str));
  var h = FNV_OFFSET;
  for (var i = 0; i < bytes.length; i++) {
    h = (h ^ BigInt(bytes[i])) & MASK64;
    h = (h * FNV_PRIME) & MASK64;
  }
  var hex = h.toString(16);
  while (hex.length < 16) hex = '0' + hex;
  return hex;
}

/* ---------------- 通道 ---------------- */

  var CHANNEL = 'xy-bus';
  var DEFAULT_TIMEOUT = 10000;

  var channels = Object.create(null);

  function stableJSON(v) {
    // 循环引用时 JSON.stringify 会抛，退化成字符串总比整个通道崩掉强
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  }

  function signOf(id, name, ts, payload) {
    return fnv1a64([id, name, ts, stableJSON(payload)].join('&'));
  }

  function uid() {
    return Date.now().toString(36) + '-' +
      Math.random().toString(36).substring(2, 10);
  }

  function createChannel(self) {
    var handlers = Object.create(null);
    var pending = Object.create(null);
    var listener = function (e) {
      if (e.source && e.source !== root) return;
      var m = e.data;
      if (!m || m.ch !== CHANNEL || m.to !== self) return;

      var payload = m.payload === undefined ? null : m.payload;
      var valid = typeof m.sign === 'string' &&
        m.sign === signOf(m.id, m.name, m.timestamp, payload);

      // 响应
      if (/_FINISH$/.test(m.name)) {
        var t = pending[m.id];
        if (!t) return;                      // 超时已清，或重复回包
        if (!valid || t.name !== m.name) {
          clearTimeout(t.timer);
          delete pending[m.id];
          t.reject(new Error('签名校验失败：' + m.name));
          return;
        }
        clearTimeout(t.timer);
        delete pending[m.id];
        t.resolve(payload);
        return;
      }

      // 请求
      var h = handlers[m.name];
      if (!h) return;
      if (m.sign !== undefined && !valid) return;   // 旧格式不带 sign，放行

      var out;
      try {
        out = h(payload, m);
      } catch (ex) {
        out = null;
      }
      if (out && typeof out.then === 'function') {
        out.then(function (v) {
          reply(m, v);
        }).catch(function () {
          reply(m, null);
        });
        return;
      }
      reply(m, out === undefined ? null : out);
    };

    function reply(m, value) {
      var name = m.name + '_FINISH';
      var id = m.id;
      var ts = Date.now();
      root.postMessage({
        ch: CHANNEL, id: id, from: self, to: m.from,
        name: name, timestamp: ts, payload: value,
        sign: signOf(id, name, ts, value)
      }, '*');
    }

    root.addEventListener('message', listener);

    return {
      self: self,

      /** 注册请求处理函数，返回取消函数。
       *  注意签名和 ask/push 一样是对端优先：on(peer, name, handler)，
       *  少传对端名会把处理器挂到 peer 上，请求永远取不到，静默超时。
       *  所以这里显式校验，宁可当场抛错也不要在几百毫秒后莫名其妙超时。 */
      on: function (peer, name, handler) {
        if (typeof peer === 'function') {
          throw new TypeError(
            'XYPostBus.on 的用法是 on(peer, name, handler)，' +
            '看着像少传了对端名');
        }
        if (!peer || !name || typeof handler !== 'function') {
          throw new TypeError('XYPostBus.on 需要对端名、消息名和处理器三个参数');
        }
        handlers[name] = handler;
        return function () { if (handlers[name] === handler) delete handlers[name]; };
      },

      /** 等回包地发给对端 */
      ask: function (peer, name, payload, opts) {
        opts = opts || {};
        return new Promise(function (resolve, reject) {
          var id = uid();
          var ts = Date.now();
          var value = payload === undefined ? null : payload;
          var timer = setTimeout(function () {
            delete pending[id];
            reject(new Error('请求超时（' + (opts.timeout || DEFAULT_TIMEOUT) +
              'ms）：' + name));
          }, opts.timeout || DEFAULT_TIMEOUT);
          pending[id] = { name: name + '_FINISH', resolve: resolve, reject: reject, timer: timer };
          root.postMessage({
            ch: CHANNEL, id: id, from: self, to: peer,
            name: name, timestamp: ts, payload: value,
            sign: signOf(id, name, ts, value)
          }, '*');
        });
      },

      /** 不等回包的推送（injected 主动往 bridge 推数据就用这个） */
      push: function (peer, name, payload) {
        var id = uid();
        var ts = Date.now();
        var value = payload === undefined ? null : payload;
        root.postMessage({
          ch: CHANNEL, id: id, from: self, to: peer,
          name: name, timestamp: ts, payload: value,
          sign: signOf(id, name, ts, value)
        }, '*');
      }
    };
  }

  root.XYPostBus = {
    CHANNEL: CHANNEL,
    fnv1a64: fnv1a64,
    signOf: signOf,
    /** 取得（或创建）绑定到 self 的通道，重复调用返回同一个，避免重复监听 */
    channel: function (self) {
      var c = channels[self];
      if (!c) c = channels[self] = createChannel(self);
      return c;
    }
  };
})(typeof window !== 'undefined' ? window : this);
