'use strict';
// QQ OneBot v11 适配器：以 WebSocket 客户端连接 go-cqhttp / NapCat / LLOneBot 的 WS 服务。
// 事件：message.private / message.group；发送：send_private_msg / send_group_msg。
// 白名单：allowUsers（QQ 号）+ allowGroups（群号）——任一为空则此适配器拒绝启动。
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');

/** 从 OneBot message 字段取纯文本（兼容字符串 CQ 码与分段数组），并去掉 [CQ:at,...] */
function rawText(message) {
  let text = '';
  if (typeof message === 'string') {
    text = message;
  } else if (Array.isArray(message)) {
    text = message
      .filter((s) => s && s.type === 'text' && s.data && typeof s.data.text === 'string')
      .map((s) => s.data.text)
      .join('');
  }
  return text.replace(/\[CQ:[^\]]+\]/g, '').trim();
}

class OneBotAdapter extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.wsUrl 例如 ws://127.0.0.1:6700
   * @param {string} [opts.accessToken] 访问令牌（可选）
   * @param {number[]} [opts.allowUsers] 允许的 QQ 号（私聊）
   * @param {number[]} [opts.allowGroups] 允许的群号（群聊，需 @机器人）
   */
  constructor(opts = {}) {
    super();
    this.platform = 'qq'; // 平台标识（bridge._adapterFor 匹配用）
    this.wsUrl = String(opts.wsUrl || '');
    this.accessToken = String(opts.accessToken || '');
    this.allowUsers = Array.isArray(opts.allowUsers) ? opts.allowUsers.map(Number) : [];
    this.allowGroups = Array.isArray(opts.allowGroups) ? opts.allowGroups.map(Number) : [];
    this.ws = null;
    this.botUin = null;
    this.connected = false;
    this._closed = false;
    this._retryTimer = null;
    this._pending = new Map(); // echo → resolve
  }

  /** 白名单是否有效（私聊或群聊至少配置一项） */
  isAllowlistValid() {
    return this.allowUsers.length > 0 || this.allowGroups.length > 0;
  }

  start() {
    if (this._closed) this._closed = false;
    this._connect();
  }

  stop() {
    this._closed = true;
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.connected = false;
  }

  _connect() {
    let url = this.wsUrl;
    if (this.accessToken) {
      url += (url.includes('?') ? '&' : '?') + `access_token=${encodeURIComponent(this.accessToken)}`;
    }
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.emit('error', err);
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.connected = true;
      this.emit('connected');
      this._loginInfo();
    });
    ws.addEventListener('message', (ev) => {
      let obj;
      try {
        obj = JSON.parse(ev.data);
      } catch {
        return;
      }
      this._dispatch(obj);
    });
    ws.addEventListener('close', () => {
      this.connected = false;
      this.ws = null;
      this.emit('disconnected');
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
      this._connect();
    }, 3000);
  }

  _loginInfo() {
    this.sendAction('get_login_info', {})
      .then((v) => {
        if (v && v.user_id) this.botUin = Number(v.user_id);
      })
      .catch(() => {});
  }

  /** 发送 OneBot 动作，返回带 echo 的响应（超时 8s 拒绝） */
  sendAction(action, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.ws || !this.connected) return reject(new Error('onebot 未连接'));
      const echo = crypto.randomUUID();
      const timer = setTimeout(() => {
        this._pending.delete(echo);
        reject(new Error(`${action} 超时`));
      }, 8000);
      this._pending.set(echo, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ action, params, echo }));
    });
  }

  _dispatch(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (obj.echo && this._pending.has(obj.echo)) {
      const p = this._pending.get(obj.echo);
      this._pending.delete(obj.echo);
      clearTimeout(p.timer);
      if (obj.status === 'ok' || obj.retcode === 0) p.resolve(obj.data);
      else p.reject(new Error(`${obj.action || 'action'} 失败：${obj.status || obj.retcode}`));
      return;
    }
    if (obj.post_type !== 'message') return;
    // 是否有真实内容（图片/表情等：有 message 字段但提取不到文字）
    const hasContent = typeof obj.message === 'string' ? obj.message.trim() !== '' : Array.isArray(obj.message) && obj.message.length > 0;
    if (!hasContent) return;
    const text = rawText(obj.message);
    const unprocessable = text === '';
    if (obj.message_type === 'private') {
      if (!this.allowUsers.includes(Number(obj.user_id))) return;
      this.emit('message', {
        adapter: this,
        platform: 'qq',
        chat: { type: 'private', id: Number(obj.user_id) },
        senderId: Number(obj.user_id),
        text,
        unprocessable,
        msgId: obj.message_id ? String(obj.message_id) : '',
      });
    } else if (obj.message_type === 'group') {
      if (!this.allowGroups.includes(Number(obj.group_id))) return;
      // 仅处理 @机器人 的消息：CQ 码在剥离前判断（rawText 会去掉 [CQ:...]）
      const raw = typeof obj.message === 'string' ? obj.message : JSON.stringify(obj.message || []);
      if (!this.botUin || !raw.includes(`[CQ:at,qq=${this.botUin}]`)) return;
      const cleaned = rawText(obj.message).replace(/\[CQ:at,qq=\d+\]/g, '').trim();
      this.emit('message', {
        adapter: this,
        platform: 'qq',
        chat: { type: 'group', id: Number(obj.group_id) },
        senderId: Number(obj.user_id),
        text: cleaned,
        unprocessable: unprocessable || cleaned === '',
        msgId: obj.message_id ? String(obj.message_id) : '',
      });
    }
  }

  /** 发送文本（自动分段；私聊/群聊按 chat 类型分发）；发送失败上报 error（不再静默） */
  send(chat, text) {
    const chunks = splitForSend(text);
    for (const chunk of chunks) {
      const p = chat.type === 'group'
        ? this.sendAction('send_group_msg', { group_id: Number(chat.id), message: chunk })
        : this.sendAction('send_private_msg', { user_id: Number(chat.id), message: chunk });
      p.catch((e) => this.emit('error', e));
    }
  }

  /** 机器人 QQ 号（群聊 @检测用） */
  getBotUin() {
    return this.botUin;
  }
}

// 与 render.splitLong 一致的分段（避免循环依赖，内联一份）
function splitForSend(text, maxLen = 4000) {
  const s = String(text == null ? '' : text);
  if (!s) return [];
  if (s.length <= maxLen) return [s];
  const out = [];
  let rest = s;
  while (rest.length > maxLen) {
    let cut = rest.slice(0, maxLen);
    const nl = cut.lastIndexOf('\n');
    const i = nl > maxLen * 0.5 ? nl : maxLen;
    out.push(cut.slice(0, i));
    rest = rest.slice(i);
  }
  if (rest) out.push(rest);
  return out;
}

module.exports = { OneBotAdapter, rawText };
