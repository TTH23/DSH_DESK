'use strict';
// QQ 官方机器人适配器（QQ 开放平台，q.qq.com）：
// 鉴权 = AppID + AppSecret → POST https://bots.qq.com/app/getAppAccessToken → access_token（2h，缓存刷新）。
// 连接官方 WebSocket 网关（无需任何第三方客户端）：
//   鉴权头  Authorization: QQBot {access_token}，X-Union-Appid: {AppID}
//   握手    HELLO(op10) → IDENTIFY(op2, token=QQBot {access_token}, intents) → READY → DISPATCH(op0, t=事件名)
//   心跳    op1 携带最后 seq；断线重连 op6 RESUME（失败重新 IDENTIFY）
//   事件    GROUP_AT_MESSAGE_CREATE（群 @）、C2C_MESSAGE_CREATE（单聊）、INTERACTION_BUTTON_CLICK（按钮点击）
//   发送    POST https://api.sgroup.qq.com/v2/groups/{group_openid}/messages 或 /v2/users/{user_openid}/messages
// 按钮（keyboard）：/ws、/ses 列表附带按钮，data 编码命令文本；点击 → INTERACTION_BUTTON_CLICK → 当消息处理。
// 白名单（allowUsers/allowGroups，openid）为可选：留空 = 允许所有能联系到机器人的用户。
const { EventEmitter } = require('node:events');
const https = require('node:https');
const http = require('node:http');

const GATEWAY = 'wss://api.sgroup.qq.com/websocket';
const GATEWAY_SANDBOX = 'wss://sandbox.api.sgroup.qq.com/websocket';
const API_BASE = 'https://api.sgroup.qq.com';
const API_BASE_SANDBOX = 'https://sandbox.api.sgroup.qq.com';
const AUTH_BASE = 'https://bots.qq.com';

// C2C 单聊 + 群聊 @ 消息（官方意图位 1<<25）+ 互动事件（按钮点击 INTERACTION_BUTTON_CLICK，官方位 1<<26）。
// 注意：互动事件位是 1<<26（1<<28 会收到 4014 disallowed intents，那是论坛审核等其它能力位）。
// 1<<26 实测可被接受（READY），无需开放平台额外申请。
const INTENTS = (1 << 25) | (1 << 26);

function stripGroupMention(content) {
  const s = String(content || '').trim();
  const m = s.replace(/^@[^\s]+\s*/, '');
  return m.trim() || s;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

class QqOfficialAdapter extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.appId
   * @param {string} opts.appSecret
   * @param {boolean} [opts.sandbox]
   * @param {string[]} [opts.allowUsers] 可选白名单 user_openid（单聊）；留空=全部允许
   * @param {string[]} [opts.allowGroups] 可选白名单 group_openid（群聊）；留空=全部允许
   * @param {string} [opts.gatewayUrl] 覆盖网关地址（测试用）
   * @param {string} [opts.apiBase] 覆盖消息 API 地址（测试用，支持 http/https）
   * @param {string} [opts.authBase] 覆盖 access_token 接口地址（测试用）
   */
  constructor(opts = {}) {
    super();
    this.platform = 'qqofficial';
    this.supportsKeyboard = true; // 官方机器人支持消息按钮（点击选择）
    this.appId = String(opts.appId || '');
    this.appSecret = String(opts.appSecret || '');
    this.sandbox = Boolean(opts.sandbox);
    this.allowUsers = Array.isArray(opts.allowUsers) ? opts.allowUsers.map(String) : [];
    this.allowGroups = Array.isArray(opts.allowGroups) ? opts.allowGroups.map(String) : [];
    this.gatewayUrl = opts.gatewayUrl || (this.sandbox ? GATEWAY_SANDBOX : GATEWAY);
    this.apiBase = opts.apiBase || (this.sandbox ? API_BASE_SANDBOX : API_BASE);
    this.authBase = opts.authBase || AUTH_BASE;
    this.ws = null;
    this.connected = false;
    this._closed = false;
    this._retryTimer = null;
    this._hbTimer = null;
    this._seq = 0;
    this._sessionId = null;
    this._heartbeatInterval = 41250;
    this._accessToken = null; // { value, expiresAt }
    this._buttonSeq = 0; // 按钮 id 自增
    this._buttonCmds = new Map(); // 按钮 id → 命令文本（点击后按此当消息处理），保留最近 N 条
  }

  isAllowlistValid() {
    // 官方模式：AppID + AppSecret 即可（白名单可选）
    return this.appId !== '' && this.appSecret !== '';
  }

  /** 拿 access_token（缓存；提前 5 分钟刷新） */
  async _ensureAccessToken() {
    const now = Date.now();
    if (this._accessToken && this._accessToken.expiresAt > now + 5 * 60 * 1000) {
      return this._accessToken.value;
    }
    const payload = JSON.stringify({ appId: this.appId, clientSecret: this.appSecret });
    const url = new URL(this.authBase + '/app/getAppAccessToken');
    const mod = url.protocol === 'http:' ? http : https;
    const data = await new Promise((resolve, reject) => {
      const req = mod.request(
        url,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
        },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(body || '{}'));
            else reject(new Error(`getAppAccessToken ${res.statusCode}: ${body.slice(0, 200)}`));
          });
        }
      );
      req.on('error', reject);
      req.setTimeout(10000, () => req.destroy(new Error('getAppAccessToken 超时')));
      req.write(payload);
      req.end();
    });
    // 官方成功响应为嵌套结构 {code:0, data:{access_token, expires_in}}
    const code = data && data.code !== undefined ? Number(data.code) : undefined;
    if (code !== undefined && code !== 0) {
      throw new Error(`获取 access_token 失败：${data.message || ('code ' + code)}`);
    }
    const inner = data && data.data && typeof data.data === 'object' ? data.data : data;
    const token = inner && inner.access_token;
    if (!token) {
      throw new Error('获取 access_token 失败（响应缺少 access_token，请检查 AppID/AppSecret）');
    }
    this._accessToken = { value: token, expiresAt: Date.now() + (Number(inner.expires_in) || 7200) * 1000 };
    return this._accessToken.value;
  }

  // 鉴权格式（官方文档+实测）：HTTP 头与 IDENTIFY token 均为 `QQBot {access_token}`（不带 AppID 前缀）
  _auth(token) {
    return `QQBot ${token}`;
  }

  start() {
    if (this._closed) this._closed = false;
    this._connect().catch(() => {});
  }

  stop() {
    this._closed = true;
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    if (this._hbTimer) {
      clearInterval(this._hbTimer);
      this._hbTimer = null;
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

  async _connect() {
    let token;
    try {
      token = await this._ensureAccessToken();
    } catch (err) {
      this.emit('error', err);
      this._scheduleReconnect();
      return;
    }
    let ws;
    try {
      ws = new WebSocket(this.gatewayUrl, {
        headers: { authorization: this._auth(token), 'x-union-appid': this.appId },
      });
    } catch (err) {
      this.emit('error', err);
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this._onGatewayMessage(msg);
    });
    ws.addEventListener('close', (ev) => {
      this.connected = false;
      this.ws = null;
      if (this._hbTimer) {
        clearInterval(this._hbTimer);
        this._hbTimer = null;
      }
      this.emit('disconnected', { code: ev && ev.code, reason: ev && ev.reason });
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
      this._connect().catch(() => {});
    }, 3000);
  }

  _send(obj) {
    if (!this.ws) return;
    try {
      this.ws.send(JSON.stringify(obj));
    } catch {
      /* ignore */
    }
  }

  _onGatewayMessage(msg) {
    const op = msg && msg.op;
    if (op === 10) {
      this._heartbeatInterval = (msg.d && msg.d.heartbeat_interval) || 41250;
      this._startHeartbeat();
      this._ensureAccessToken()
        .then((token) => {
          const auth = this._auth(token);
          if (this._sessionId && this._seq > 0) {
            this._send({ op: 6, d: { token: auth, session_id: this._sessionId, seq: this._seq } });
          } else {
            this._send({ op: 2, d: { token: auth, intents: INTENTS, shard: [0, 1] } });
          }
        })
        .catch(() => {});
      return;
    }
    if (op === 0) {
      const t = msg.t;
      if (t === 'READY' || t === 'RESUMED') {
        this._sessionId = (msg.d && msg.d.session_id) || this._sessionId;
        this.connected = true;
        this.emit('connected');
        return;
      }
      if (typeof msg.s === 'number') this._seq = msg.s;
      if (t === 'GROUP_AT_MESSAGE_CREATE') this._onGroupAt(msg.d);
      else if (t === 'C2C_MESSAGE_CREATE') this._onC2C(msg.d);
      else if (t === 'INTERACTION_CREATE') this._onInteractionCreate(msg.d);
      return;
    }
    if (op === 7) {
      // INVALID_SESSION：清会话重新 IDENTIFY
      this._sessionId = null;
      this._ensureAccessToken()
        .then((token) => this._send({ op: 2, d: { token: this._auth(token), intents: INTENTS, shard: [0, 1] } }))
        .catch(() => {});
    }
  }

  _startHeartbeat() {
    if (this._hbTimer) clearInterval(this._hbTimer);
    this._hbTimer = setInterval(() => {
      this._send({ op: 1, d: this._seq });
    }, this._heartbeatInterval);
    if (this._hbTimer.unref) this._hbTimer.unref();
  }

  _allowedUser(uid) {
    return this.allowUsers.length === 0 || this.allowUsers.includes(String(uid));
  }

  _allowedGroup(gid) {
    return this.allowGroups.length === 0 || this.allowGroups.includes(String(gid));
  }

  _onGroupAt(d) {
    if (!d || !d.group_openid) return;
    const gid = String(d.group_openid);
    const uid = String((d.author && d.author.user_openid) || '');
    if (!this._allowedGroup(gid)) {
      this.emit('unauthorized', { kind: '群', id: gid, uid });
      return;
    }
    const text = stripGroupMention(d.content);
    const msgId = String(d.id || d.msg_id || '');
    this.emit('message', { adapter: this, platform: this.platform, chat: { type: 'group', id: gid }, senderId: uid, text, unprocessable: text === '', msgId });
  }

  _onC2C(d) {
    if (!d || !d.author || !d.author.user_openid) return;
    const uid = String(d.author.user_openid);
    if (!this._allowedUser(uid)) {
      this.emit('unauthorized', { kind: '用户', id: uid, uid });
      return;
    }
    const text = String(d.content || '').trim();
    const msgId = String(d.id || d.msg_id || '');
    this.emit('message', { adapter: this, platform: this.platform, chat: { type: 'private', id: uid }, senderId: uid, text, unprocessable: text === '', msgId });
  }

  /**
   * 互动事件（INTERACTION_CREATE，官方 intent 1<<26）。
   * 我们使用「指令按钮」（action.type=2 + enter:true）：用户点击后由 QQ 客户端
   * 自动把 data（命令文本）作为 @bot 消息发送，机器人经 C2C/GROUP_AT 消息流处理，
   * 无需在本事件里还原命令。本事件只需 PUT /interactions/{id} 回应 {"code":0}，
   * 否则客户端会一直 loading 直到超时（官方文档明确要求）。
   * 仅 type=11（消息按钮）/12（快捷菜单）需要回应；其它类型无需回应（尽力而为）。
   */
  _onInteractionCreate(d) {
    if (!d || typeof d !== 'object') return;
    const type = Number(d.type);
    const interactionId = String(d.id || '');
    if (type === 11 || type === 12) {
      if (interactionId) this._ackInteraction(interactionId);
    }
    // 其它类型（授权/反馈等）无需回应
  }

  /** 互动事件回应：PUT /interactions/{interaction_id}，body {"code":0}（不回应客户端会一直 loading） */
  _ackInteraction(interactionId) {
    this._ensureAccessToken()
      .then((token) => {
        const p = this._put(`/interactions/${encodeURIComponent(interactionId)}`, { code: 0 }, this._auth(token));
        p.catch((e) => this.emit('error', e));
      })
      .catch((e) => this.emit('error', e));
  }

  /** 发送文本（自动分段）；chat.id 为 openid 字符串；发送失败上报 error（不再静默）。
   *  opts.keyboard: QQ 按钮键盘 { rows: [{ buttons: [{ label, cmd }] }] }（label 展示，cmd 点击后当命令处理）
   *  超长文本用普通 markdown 消息分片串行发送（stream_messages 接口实测在你的 App 上 500，弃用）
   */
  send(chat, text, opts) {
    const keyboard = opts && opts.keyboard;
    const s = String(text == null ? '' : text);
    if (keyboard) {
      // 按钮必须用 markdown 消息（msg_type:2 + markdown.content）才能渲染——
      // 纯文本（msg_type:0）+ keyboard 虽 200 但按钮不显示（实测）。
      // markdown.content 不支持换行（40034009），列表文本压成单行用 · 分隔。
      const rows = Array.isArray(keyboard.rows) ? keyboard.rows : [];
      const kRows = [];
      for (const row of rows) {
        const btns = (row && row.buttons) || [];
        const kButtons = [];
        for (const b of btns) {
          // 指令按钮（type=2）：data = 点击后自动发送的文本（@bot data），enter:true 直接发送
          const cmd = String(b.cmd || b.label || '');
          kButtons.push({
            id: `b${(this._buttonSeq += 1)}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`,
            render_data: {
              label: String(b.label || '按钮').slice(0, 10), // 按钮文字最多 10 字符
              visited_label: String(b.visitedLabel || b.label || '按钮').slice(0, 10),
              style: 1, // 1=蓝线框
            },
            action: {
              type: 2, // 指令按钮：点击自动插入 @bot data 并发送
              permission: { type: 2 }, // 2=所有人可点
              data: cmd,
              enter: true, // 点击后直接自动发送（仅单聊）
              reply: true, // 指令带引用回复本消息
            },
          });
        }
        if (kButtons.length) kRows.push({ buttons: kButtons });
      }
      // 官方格式：rows 必须包在 keyboard.content 里
      const keyboardObj = { content: { rows: kRows } };
      this._ensureAccessToken()
        .then((token) => {
          const auth = this._auth(token);
          const body = { markdown: { content: s || '请选择' }, msg_type: 2, keyboard: keyboardObj };
          const p = chat.type === 'group'
            ? this._post(`/v2/groups/${encodeURIComponent(chat.id)}/messages`, body, auth)
            : this._post(`/v2/users/${encodeURIComponent(chat.id)}/messages`, body, auth);
          p.catch((e) => this.emit('error', e));
        })
        .catch((e) => this.emit('error', e));
      return;
    }
    // 普通回复用 markdown 消息（msg_type:2 + markdown.content）——粗体/列表等 markdown 语法可渲染；
    // markdown.content 实测支持换行（不再压行）。超长分割。
    const ref = opts && opts.messageReference;
    const chunks = splitForSend(s);
    this._ensureAccessToken()
      .then(async (token) => {
        const auth = this._auth(token);
        const bodies = chunks.length
          ? chunks.map((c) => ({ markdown: { content: c }, msg_type: 2 }))
          : [{ markdown: { content: s || ' ' }, msg_type: 2 }];
        // 引用回复：官方 message_reference.message_id = 用户消息事件的 d.id（仅第一条带）
        if (ref && ref.message_id && bodies[0]) bodies[0].message_reference = ref;
        // 串行发送 + 间隔，避免瞬时 QPS 超限触发 QQ 频控（50015001 系统繁忙）；
        // 单个分片失败不阻塞其余分片（保证完整送达）
        for (const body of bodies) {
          const p = chat.type === 'group'
            ? this._post(`/v2/groups/${encodeURIComponent(chat.id)}/messages`, body, auth)
            : this._post(`/v2/users/${encodeURIComponent(chat.id)}/messages`, body, auth);
          p.catch((e) => this.emit('error', e));
          await sleep(250); // 分片间 250ms 间隔（单关系 20qpm → 安全余量）
        }
      })
      .catch((e) => this.emit('error', e));
  }

  _put(path, body, auth) {
    return this._request(path, 'PUT', body, auth);
  }

  _post(path, body, auth) {
    return this._request(path, 'POST', body, auth);
  }

  _request(path, method, body, auth, _attempt = 0) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const url = new URL(this.apiBase + path);
      const mod = url.protocol === 'http:' ? http : https;
      const req = mod.request(
        url,
        {
          method,
          headers: {
            'content-type': 'application/json',
            authorization: auth,
            'content-length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(JSON.parse(data || '{}'));
              return;
            }
            // 瞬态错误（系统繁忙 500 / 频控 429）重试 2 次，间隔递增
            const transient = res.statusCode === 500 || res.statusCode === 429 || res.statusCode === 503;
            if (transient && _attempt < 2) {
              const delay = 800 * Math.pow(2, _attempt);
              setTimeout(() => {
                this._request(path, method, body, auth, _attempt + 1).then(resolve, reject);
              }, delay);
              return;
            }
            reject(new Error(`QQ 官方 API ${res.statusCode}: ${data.slice(0, 200)}`));
          });
        }
      );
      req.on('error', reject);
      req.setTimeout(10000, () => req.destroy(new Error('QQ 官方 API 超时')));
      req.write(payload);
      req.end();
    });
  }

  // ---------- 全局自定义菜单 / 指令面板（C2C 单聊） ----------

  /** 查询当前菜单：GET /v2/menu */
  async getMenu() {
    const token = await this._ensureAccessToken();
    const url = new URL(this.apiBase + '/v2/menu');
    const mod = url.protocol === 'http:' ? http : https;
    return new Promise((resolve, reject) => {
      const req = mod.request(url, { method: 'GET', headers: { authorization: this._auth(token) } }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(d || '{}'));
          else reject(new Error(`GET /v2/menu ${res.statusCode}: ${d.slice(0, 200)}`));
        });
      });
      req.on('error', reject);
      req.setTimeout(10000, () => req.destroy(new Error('GET /v2/menu 超时')));
      req.end();
    });
  }

  /** 设置全局菜单（覆盖）：PUT /v2/menu，menu = { items: [...] } */
  setMenu(items) {
    return this._ensureAccessToken().then((token) =>
      this._request('/v2/menu', 'PUT', { menu: { items } }, this._auth(token))
    );
  }

  /** 查询指令面板列表：GET /v2/panels?scope=c2c */
  async listPanels(scope = 'c2c') {
    const token = await this._ensureAccessToken();
    const url = new URL(this.apiBase + `/v2/panels?scope=${encodeURIComponent(scope)}&limit=20`);
    const mod = url.protocol === 'http:' ? http : https;
    return new Promise((resolve, reject) => {
      const req = mod.request(url, { method: 'GET', headers: { authorization: this._auth(token) } }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(d || '{}'));
          else reject(new Error(`GET /v2/panels ${res.statusCode}: ${d.slice(0, 200)}`));
        });
      });
      req.on('error', reject);
      req.setTimeout(10000, () => req.destroy(new Error('GET /v2/panels 超时')));
      req.end();
    });
  }

  /** 创建指令面板：POST /v2/panels，返回 panel_id */
  createPanel(scope, panel, opts = {}) {
    const body = { scope, target_type: opts.targetType || 'all', panel };
    if (opts.userOpenids) body.user_openids = opts.userOpenids;
    if (opts.groupOpenids) body.group_openids = opts.groupOpenids;
    return this._ensureAccessToken().then((token) =>
      this._request('/v2/panels', 'POST', body, this._auth(token))
    );
  }

  /** 删除指令面板：DELETE /v2/panels/{panel_id} */
  deletePanel(panelId) {
    return this._ensureAccessToken().then((token) =>
      this._request(`/v2/panels/${encodeURIComponent(panelId)}`, 'DELETE', {}, this._auth(token))
    );
  }

  /** 默认菜单：常用短命令（C2C 单聊全局菜单，最多 10 项） */
  static defaultMenu() {
    return [
      { type: 'send_message', name: '工作区', send_message: '/ws' },
      { type: 'send_message', name: '会话', send_message: '/ses' },
      { type: 'send_message', name: '状态', send_message: '/status' },
      { type: 'send_message', name: '用量', send_message: '/usage' },
      { type: 'send_message', name: '设置', send_message: '/setting' },
      { type: 'send_message', name: '帮助', send_message: '/help' },
    ];
  }

  /** 默认指令面板（c2c 场景，最多 20 项） */
  static defaultPanel() {
    return {
      items: [
        { type: 'command', name: '工作区', desc: '选择工作区' },
        { type: 'command', name: '会话', desc: '选择会话' },
        { type: 'command', name: '状态', desc: '连接与绑定状态' },
        { type: 'command', name: '用量', desc: '余额与会话费用' },
        { type: 'command', name: '设置', desc: '查看/修改设置' },
        { type: 'command', name: '帮助', desc: '完整帮助' },
        { type: 'command', name: '模型', desc: '切换模型' },
        { type: 'command', name: '最近记录', desc: '最近聊天记录' },
        { type: 'command', name: '停止', desc: '打断生成' },
        { type: 'command', name: '排队', desc: '查看排队' },
      ],
      remark: 'DSH Desk 远程机器人常用指令',
      version: 1,
    };
  }
}

function splitForSend(text, maxLen = 2000) {
  const s = String(text == null ? '' : text);
  if (!s) return [];
  if (s.length <= maxLen) return [s];
  const out = [];
  let rest = s;
  while (rest.length > maxLen) {
    let cut = rest.slice(0, maxLen);
    // 优先在最近的换行处断（不切段落/代码块中间）
    const nl = cut.lastIndexOf('\n');
    const i = nl > maxLen * 0.5 ? nl : maxLen;
    out.push(cut.slice(0, i));
    rest = rest.slice(i);
  }
  if (rest) out.push(rest);
  return out;
}

module.exports = { QqOfficialAdapter, stripGroupMention, INTENTS };
