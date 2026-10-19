/**
 * CDP 最小客户端
 *
 * 用途：连上一台带 --remote-debugging-port 的 Chrome，
 * 开标签、执行 JS、把结果取回来。用于在有登录态的浏览器里
 * 做站点结构实测（选择器、SKU 结构、接口字段都只能这么验）。
 *
 * 用法：
 *   const CDP = require('./cdp');
 *   const b = await CDP.connect(9222);
 *   const page = await b.open('https://www.1688.com/');
 *   const r = await page.evaluate('document.title');
 *   await b.close();
 */
'use strict';

const http = require('http');

function httpJson(port, path, method) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: method || 'GET', timeout: 8000 },
      (res) => {
        let b = [];
        res.on('data', (d) => b.push(d));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(b).toString())); }
          catch (e) { reject(new Error('返回非 JSON: ' + Buffer.concat(b).slice(0, 200))); }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('CDP 端口 ' + port + ' 无响应，浏览器是否开了调试端口？')); });
    req.end();
  });
}

class Page {
  constructor(ws, sessionId, targetId) {
    this.ws = ws;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this._id = 0;
    this._waiters = new Map();
    this._handlers = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id != null && this._waiters.has(msg.id)) {
        const w = this._waiters.get(msg.id);
        this._waiters.delete(msg.id);
        msg.error ? w.reject(new Error(JSON.stringify(msg.error))) : w.resolve(msg.result);
        return;
      }
      // 事件：只派发给订阅过该方法的监听者（Debugger.scriptParsed 之类）
      if (msg.method && this._handlers.has(msg.method)) {
        this._handlers.get(msg.method).forEach((fn) => { try { fn(msg.params || {}); } catch (e) {} });
      }
    });
  }

  /** 订阅 CDP 事件，例如 page.on('Debugger.scriptParsed', (p) => ...) */
  on(method, fn) {
    if (!this._handlers.has(method)) this._handlers.set(method, []);
    this._handlers.get(method).push(fn);
    return this;
  }

  send(method, params) {
    const id = ++this._id;
    this.ws.send(JSON.stringify({ id, method, params: params || {}, sessionId: this.sessionId }));
    return new Promise((resolve, reject) => this._waiters.set(id, { resolve, reject }));
  }

  /**
   * 执行 JS 并返回序列化结果。
   * 返回值必须可 JSON 序列化——要复杂结构就自己 JSON.stringify。
   */
  async evaluate(expression, awaitPromise) {
    const r = await this.send('Runtime.evaluate', {
      expression: '(()=>{' + expression + '})()',
      awaitPromise: !!awaitPromise,
      returnByValue: true,
      allowUnsafeEvalBlockedByCSP: true
    });
    if (r.exceptionDetails) {
      throw new Error('页面异常: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || 'unknown'));
    }
    return r.result.value;
  }

  async goto(url, timeout) {
    await this.send('Page.enable');
    await this.send('Page.navigate', { url });
    const t = Date.now();
    while (Date.now() - t < (timeout || 30000)) {
      await new Promise((r) => setTimeout(r, 400));
      try {
        const ready = await this.evaluate('return document.readyState');
        if (ready === 'complete' || ready === 'interactive') {
          // 给 SPA 一点渲染时间
          await new Promise((r) => setTimeout(r, 1200));
          return true;
        }
      } catch (e) {}
    }
    return false;
  }

  async close() {
    // 关掉的是**标签页**，不是 WebSocket。
    // 这里原来写的是 this.ws.close()——那条 ws 是 Browser 级共享连接，
    // 一关整个会话就断，后续 createTarget 必然超时；而且标签页根本没被关掉，
    // 跑几轮就堆到二三十个把浏览器拖死（连续探测时必踩）。
    try {
      await this.send('Target.closeTarget', { targetId: this.targetId });
    } catch (e) {}
  }
}

class Browser {
  constructor(port, ws, targets) {
    this.port = port;
    this.ws = ws;
    this.targets = targets;
  }

  static async connect(port) {
    const ver = await httpJson(port, '/json/version');
    const list = await httpJson(port, '/json/list');
    const http = require('http');
    // 必须是浏览器级 ws（/json/version 那个）——列表里第一个不一定是 browser target
    const wsUrl = ver.webSocketDebuggerUrl;
    const WebSocket = globalThis.WebSocket;
    if (!WebSocket) throw new Error('当前 Node 无全局 WebSocket，请升级到 22.4+');
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', rej);
    });
    return new Browser(port, ws, list);
  }

  async open(url) {
    // 以前走 PUT /json/new，但 Chrome 111 起这个端点被移除了（会 405），
    // 拿不到有效 targetId，后面的 attach 必然超时。
    // 之前几个诊断脚本是自己另外调 Target.createTarget 绕过去的，
    // 现在把这条正路修好，别再让每个新脚本都踩一遍。
    const r = await this.createTarget(url || 'about:blank');
    const targetId = r && r.targetId;
    if (!targetId) throw new Error('createTarget 未返回 targetId：' + JSON.stringify(r));
    const sessionId = await this._attach(targetId);
    return new Page(this.ws, sessionId, targetId);
  }

  /**
   * 接管一个「已经开着」的标签（有登录态、页面已经跑过一轮，不用重抓）。
   * 找不到符合 urlRe 的标签就返回 null，调用方自己决定是新建还是放弃。
   */
  async attach(urlRe) {
    const tabs = await this.list();
    for (const t of tabs) {
      if (t.type !== 'page') continue;
      if (urlRe && !urlRe.test(t.url || '')) continue;
      const sessionId = await this._attach(t.id);
      return new Page(this.ws, sessionId, t.id);
    }
    return null;
  }

  /** 接管任意类型的 target：service_worker / shared_worker / page 都行。 */
  async attachTarget(target) {
    if (!target) return null;
    const sessionId = await this._attach(target.id);
    return new Page(this.ws, sessionId, target.id);
  }

  /** 浏览器级开一个 target（/json/new 开不了 chrome-extension:// 这类特殊 url）。 */
  createTarget(url) {
    const id = (this._attachId = (this._attachId || 0) + 1);
    return new Promise((resolve, reject) => {
      const handler = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id === id) {
          this.ws.removeEventListener('message', handler);
          msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
        }
      };
      this.ws.addEventListener('message', handler);
      this.ws.send(JSON.stringify({ id, method: 'Target.createTarget', params: { url } }));
      setTimeout(() => reject(new Error('createTarget 超时')), 8000);
    });
  }

  /** 按 target 类型找（例如 attachType('service_worker') 拿扩展后台）。 */
  async attachType(type, urlRe) {
    const t = (await this.list()).find((x) => x.type === type && (!urlRe || urlRe.test(x.url || '')));
    return this.attachTarget(t);
  }

  _attach(targetId) {
    return new Promise((resolve, reject) => {
      const id = ++this._attachId;
      const handler = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id === id && msg.result && msg.result.sessionId) {
          this.ws.removeEventListener('message', handler);
          resolve(msg.result.sessionId);
        }
      };
      this.ws.addEventListener('message', handler);
      this.ws.send(JSON.stringify({ id, method: 'Target.attachToTarget', params: { targetId, flatten: true } }));
      setTimeout(() => reject(new Error('attach 超时')), 8000);
    });
  }

  async list() {
    return httpJson(this.port, '/json/list');
  }

  /**
   * 浏览器级 target 列表。比 /json/list 全 —— /json/list 里看不到
   * service_worker，扩展后台只能从这儿拿。
   */
  async browserTargets() {
    const id = (this._attachId = (this._attachId || 0) + 1);
    return new Promise((resolve, reject) => {
      const handler = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id === id && msg.result) {
          this.ws.removeEventListener('message', handler);
          resolve(msg.result.targetInfos || []);
        }
      };
      this.ws.addEventListener('message', handler);
      this.ws.send(JSON.stringify({ id, method: 'Target.getTargets', params: {} }));
      setTimeout(() => reject(new Error('Target.getTargets 超时')), 8000);
    });
  }

  async close() {
    try { this.ws.close(); } catch (e) {}
  }
}
Browser.prototype._attachId = 0;

module.exports = Browser;

/* ---------------- CLI ---------------- */
if (require.main === module) {
  (async () => {
    const url = process.argv[2] || 'https://www.1688.com/';
    const js = process.argv[3];
    const b = await Browser.connect(9222);
    const tabs = await b.list();
    console.log('=== 当前标签 ===');
    tabs.forEach((t) => console.log(' ', t.type, '|', (t.url || '').slice(0, 90)));
    if (url) {
      const page = await b.open(url);
      console.log('\n=== 已打开', url, '===');
      console.log('title:', await page.evaluate('return document.title'));
      if (js) {
        console.log('eval:', JSON.stringify(await page.evaluate(js), null, 2).slice(0, 3000));
      }
      await page.close();
    }
    await b.close();
  })().catch((e) => { console.error('ERR', e.message); process.exit(1); });
}
