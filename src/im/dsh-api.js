'use strict';
// dsh 本地 API 客户端：unary RPC（POST /api/<method>）+ mux 事件流（WS /api/events.mux）
// 协议（见 @deepseek-ai/dsh-host-apiproxy 与 dsh-client-connection 源码）：
//   请求   {type:'client-request', rpcId, method, payload}
//   响应   {type:'server-response', rpcId, result:{ok:true,value} | {ok:false,error:{code,message,details?}}}
//   WS 帧 {type:'server-request', rpcId, method, payload: MuxFrame}
//   MuxFrame 含 session/event、session/subscribed、session/queue、session/jobs、session/projection、approval/*、question/*、stream/error
// 本机调用（Host=127.0.0.1 回环、无 Origin）直接通过 dsh 的浏览器信任栅栏。
const http = require('node:http');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const MUX_PATH = '/api/events.mux';
const RESPOND_PATH = '/api/respond';

class DshApiError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'DshApiError';
    this.code = code;
    this.details = details;
  }
}

class DshApiClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {number} opts.port dsh 实际监听端口（必须显式传入）
   * @param {string} [opts.host] 默认 127.0.0.1
   * @param {string} [opts.wsUrl] 覆盖事件流地址（测试用）
   */
  constructor(opts = {}) {
    super();
    this.host = opts.host || '127.0.0.1';
    this.port = opts.port; // 数字或 (() => number) 函数（跟随 dsh 实际端口变化）
    this.wsUrl = opts.wsUrl;
    this._ws = null;
    this._wsOpen = false;
    this._retryTimer = null;
    this._retryDelay = 2000;
    this._closed = false;
  }

  _port() {
    return typeof this.port === 'function' ? this.port() : this.port;
  }

  _rpcId() {
    return crypto.randomUUID();
  }

  /**
   * unary RPC 调用。成功返回 value；失败抛 DshApiError。
   */
  call(method, payload = {}, { timeoutMs = 30000 } = {}) {
    return new Promise((resolve, reject) => {
      const port = this._port();
      if (!port) return reject(new DshApiError('transport', 'dsh 端口未知（服务未就绪）'));
      const rpcId = this._rpcId();
      const body = JSON.stringify({ type: 'client-request', rpcId, method, payload });
      let req;
      try {
        req = http.request(
          {
            host: this.host,
            port,
            method: 'POST',
            path: `/api/${method}`,
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
          },
          (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => {
              try {
                const parsed = JSON.parse(data);
                if (!parsed || parsed.type !== 'server-response') {
                  return reject(new DshApiError('bad-response', '服务器响应格式异常'));
                }
                const result = parsed.result || {};
                if (result.ok === true) return resolve(result.value);
                const e = result.error || {};
                reject(new DshApiError(e.code || 'rpc-error', e.message || 'RPC 调用失败', e.details));
              } catch (err) {
                reject(new DshApiError('bad-response', `响应解析失败：${err.message}`));
              }
            });
          }
        );
      } catch (err) {
        return reject(new DshApiError('transport', `无法连接 dsh：${err.message}`));
      }
      req.on('error', (err) => {
        // destroy(err) 携带 DshApiError（如超时）时原样透传
        if (err instanceof DshApiError) return reject(err);
        reject(new DshApiError('transport', `无法连接 dsh：${err.message}`));
      });
      req.setTimeout(timeoutMs, () => {
        req.destroy(new DshApiError('timeout', `${method} 调用超时`));
      });
      req.write(body);
      req.end();
    });
  }

  /**
   * 应答服务器发起的可应答帧（approval/question requested）。
   * 协议：POST /api/respond，body = client-response（echo 服务器帧的 rpcId）。
   * 返回 RpcReceipt { accepted: true } | { accepted: false, reason }。
   */
  respond(rpcId, value, { timeoutMs = 30000 } = {}) {
    return new Promise((resolve, reject) => {
      const port = this._port();
      if (!port) return reject(new DshApiError('transport', 'dsh 端口未知（服务未就绪）'));
      const body = JSON.stringify({
        type: 'client-response',
        rpcId,
        result: { ok: true, value },
      });
      let req;
      try {
        req = http.request(
          {
            host: this.host,
            port,
            method: 'POST',
            path: RESPOND_PATH,
            headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
          },
          (res) => {
            let data = '';
            res.on('data', (c) => (data += c));
            res.on('end', () => {
              try {
                const parsed = JSON.parse(data);
                resolve(parsed); // RpcReceipt: {accepted:true} | {accepted:false,reason}
              } catch (err) {
                reject(new DshApiError('bad-response', `respond 响应解析失败：${err.message}`));
              }
            });
          }
        );
      } catch (err) {
        return reject(new DshApiError('transport', `无法连接 dsh：${err.message}`));
      }
      req.on('error', (err) => {
        if (err instanceof DshApiError) return reject(err);
        reject(new DshApiError('transport', `无法连接 dsh：${err.message}`));
      });
      req.setTimeout(timeoutMs, () => {
        req.destroy(new DshApiError('timeout', 'respond 调用超时'));
      });
      req.write(body);
      req.end();
    });
  }

  // ---------- 事件流 ----------
  startEvents() {
    if (this._ws || this._closed) return;
    this._openWs();
  }

  stopEvents() {
    this._closed = true;
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    if (this._ws) {
      try {
        this._ws.close();
      } catch {
        /* ignore */
      }
      this._ws = null;
    }
    this._wsOpen = false;
  }

  isEventsOpen() {
    return this._wsOpen;
  }

  _openWs() {
    let ws;
    try {
      const port = this._port();
      const url = this.wsUrl || `ws://${this.host}:${port}${MUX_PATH}`;
      ws = new WebSocket(url);
    } catch (err) {
      this.emit('events-error', err);
      this._scheduleReconnect();
      return;
    }
    this._ws = ws;
    ws.addEventListener('open', () => {
      this._wsOpen = true;
      this.emit('events-open');
    });
    ws.addEventListener('message', (ev) => {
      let frame;
      try {
        frame = JSON.parse(ev.data);
      } catch {
        return; // 忽略坏帧
      }
      if (!frame || typeof frame !== 'object') return;
      this.emit('frame', frame);
      const payload = frame.payload;
      if (payload && typeof payload.type === 'string') {
        this.emit(payload.type, payload);
      }
    });
    ws.addEventListener('close', (ev) => {
      this._wsOpen = false;
      this._ws = null;
      this.emit('events-close', { code: ev && ev.code, reason: ev && ev.reason, clean: ev && ev.wasClean });
      this._scheduleReconnect();
    });
    ws.addEventListener('error', () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });
  }

  _scheduleReconnect() {
    if (this._closed || this._retryTimer) return;
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      this._openWs();
    }, this._retryDelay);
  }

  // ---------- 业务方法（薄封装） ----------
  describe() {
    return this.call('host.describe', {});
  }

  listSessions() {
    return this.call('session.list', {});
  }

  searchSessions(query) {
    return this.call('session.search', { query });
  }

  listWorkspaces() {
    return this.call('workspace.list', {});
  }

  history(sessionId, opts = {}) {
    return this.call('session.history', { sessionId, ...opts });
  }

  models(sessionId) {
    return this.call('session.models', { sessionId });
  }

  selectModel(sessionId, provider, model, reasoningEffort) {
    const payload = { sessionId, provider, model };
    if (reasoningEffort) payload.reasoningEffort = reasoningEffort;
    return this.call('session.selectModel', payload);
  }

  /** 发文本提示词；mode: 'queue'（忙时排队）| 'steer'（插话） */
  prompt(sessionId, text, { mode = 'queue' } = {}) {
    return this.call('session.prompt', {
      sessionId,
      mode,
      content: [{ type: 'text', text }],
    });
  }

  cancel(sessionId) {
    return this.call('session.cancel', { sessionId });
  }

  updateQueue(sessionId, itemId, action) {
    return this.call('session.updateQueue', { sessionId, itemId, action });
  }

  createSession(payload) {
    return this.call('session.create', payload);
  }

  renameSession(sessionId, title) {
    return this.call('session.rename', { sessionId, title });
  }
}

module.exports = { DshApiClient, DshApiError, MUX_PATH };
