'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const { QqOfficialAdapter, stripGroupMention, INTENTS } = require('../src/im/adapters/qq-official');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const APP_ID = '1905439152';
const APP_SECRET = 'secret-value';
const ACCESS_TOKEN = 'acc-token-1';

function wsFrame(obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const head = Buffer.from([0x81, 126, (payload.length >> 8) & 0xff, payload.length & 0xff]);
  return Buffer.concat([head, payload]);
}

class WsInbox {
  constructor() { this.buf = Buffer.alloc(0); this.texts = []; this.closed = false; }
  push(c) { this.buf = Buffer.concat([this.buf, c]); this._drain(); }
  _drain() {
    let off = 0;
    for (;;) {
      if (off + 2 > this.buf.length) break;
      const b0 = this.buf[off], b1 = this.buf[off + 1];
      const opcode = b0 & 0x0f;
      if (opcode === 0x8) { this.closed = true; off = this.buf.length; break; }
      let len = b1 & 0x7f, idx = off + 2;
      if (len === 126) { if (idx + 2 > this.buf.length) break; len = this.buf.readUInt16BE(idx); idx += 2; }
      else if (len === 127) { if (idx + 8 > this.buf.length) break; len = Number(this.buf.readBigUInt64BE(idx)); idx += 8; }
      const masked = (b1 & 0x80) !== 0;
      let maskKey = null;
      if (masked) { if (idx + 4 > this.buf.length) break; maskKey = this.buf.slice(idx, idx + 4); idx += 4; }
      if (idx + len > this.buf.length) break;
      let payload = this.buf.slice(idx, idx + len);
      if (maskKey) { const u = Buffer.alloc(len); for (let i = 0; i < len; i++) u[i] = payload[i] ^ maskKey[i % 4]; payload = u; }
      off = idx + len;
      if (opcode === 0x1) this.texts.push(payload.toString('utf8'));
    }
    this.buf = this.buf.slice(off);
  }
}

/** mock 官方网关（HELLO/IDENTIFY/heartbeat/DISPATCH） */
async function makeMockGateway(t) {
  const received = [];
  const handshakeHeaders = [];
  const sockets = new Set();
  const srv = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });
  srv.on('upgrade', (req, socket) => {
    handshakeHeaders.push(req.headers);
    const key = req.headers['sec-websocket-key'] || '';
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
        crypto.createHash('sha1').update(key + WS_GUID).digest('base64') + '\r\n\r\n'
    );
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.write(wsFrame({ op: 10, d: { heartbeat_interval: 500 } })); // HELLO
    const inbox = new WsInbox();
    socket.on('data', (c) => {
      inbox.push(c);
      while (inbox.texts.length) {
        const m = JSON.parse(inbox.texts.shift());
        received.push(m);
        if (m.op === 2) {
          socket.write(wsFrame({ op: 0, s: 1, t: 'READY', d: { session_id: 'ses-1' } }));
        } else if (m.op === 6) {
          socket.write(wsFrame({ op: 0, s: 1, t: 'RESUMED', d: { session_id: 'ses-1' } }));
        }
      }
      if (inbox.closed) { socket.write(Buffer.from([0x88, 0x00])); socket.end(); sockets.delete(socket); }
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const push = (obj) => { for (const s of sockets) s.write(wsFrame(obj)); };
  return { port: srv.address().port, received, handshakeHeaders, push };
}

/** mock 鉴权接口（bots.qq.com/app/getAppAccessToken） */
async function makeMockAuth(t, response = { code: 0, data: { access_token: ACCESS_TOKEN, expires_in: 7200 } }) {
  const requests = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      requests.push(JSON.parse(body || '{}'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(response));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  return { port: srv.address().port, requests };
}

/** mock 消息/互动 API（含菜单/面板） */
async function makeMockApi(t) {
  const posts = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      posts.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') });
      res.writeHead(200, { 'content-type': 'application/json' });
      // 菜单/面板 GET 返回空配置（幂等检查用）
      if (req.method === 'GET' && req.url.startsWith('/v2/menu')) {
        res.end(JSON.stringify({ menu: { items: [] } }));
      } else if (req.method === 'GET' && req.url.startsWith('/v2/panels')) {
        res.end(JSON.stringify({ records: [], next_cursor: '', is_end: true }));
      } else if (req.method === 'POST' && req.url.startsWith('/v2/panels')) {
        res.end(JSON.stringify({ panel_id: 'p_test_001' }));
      } else {
        res.end(JSON.stringify({ id: 'msg-' + posts.length }));
      }
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  return { port: srv.address().port, posts };
}

function makeAdapter(gatewayPort, apiPort, authPort, overrides = {}) {
  return new QqOfficialAdapter({
    appId: APP_ID,
    appSecret: APP_SECRET,
    gatewayUrl: `ws://127.0.0.1:${gatewayPort}`,
    apiBase: `http://127.0.0.1:${apiPort}`,
    authBase: `http://127.0.0.1:${authPort}`,
    allowUsers: ['u-allow'],
    allowGroups: ['g-allow'],
    ...overrides,
  });
}

test('鉴权：AppID+AppSecret 换 access_token；IDENTIFY 与握手头用 QQBot 凭证', async (t) => {
  const gw = await makeMockGateway(t);
  const api = await makeMockApi(t);
  const auth = await makeMockAuth(t);
  const adapter = makeAdapter(gw.port, api.port, auth.port);
  adapter.start();
  t.after(() => adapter.stop());
  await new Promise((resolve, reject) => {
    adapter.once('connected', resolve);
    setTimeout(() => reject(new Error('connected 超时')), 3000);
  });
  assert.strictEqual(auth.requests[0].appId, APP_ID);
  assert.strictEqual(auth.requests[0].clientSecret, APP_SECRET);
  const h = gw.handshakeHeaders[0];
  assert.strictEqual(h.authorization, `QQBot ${ACCESS_TOKEN}`);
  assert.strictEqual(h['x-union-appid'], APP_ID);
  const identify = gw.received.find((m) => m.op === 2);
  assert.ok(identify);
  assert.strictEqual(identify.d.token, `QQBot ${ACCESS_TOKEN}`);
  assert.strictEqual(identify.d.intents, INTENTS);
});

test('access_token 缓存：连接+发送只请求一次鉴权', async (t) => {
  const gw = await makeMockGateway(t);
  const api = await makeMockApi(t);
  const auth = await makeMockAuth(t);
  const adapter = makeAdapter(gw.port, api.port, auth.port);
  adapter.start();
  t.after(() => adapter.stop());
  await new Promise((resolve) => adapter.once('connected', resolve));
  adapter.send({ type: 'private', id: 'u-allow' }, '回复');
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(auth.requests.length, 1);
  assert.strictEqual(api.posts.length, 1);
  assert.strictEqual(api.posts[0].auth, `QQBot ${ACCESS_TOKEN}`);
});

test('心跳 op1 携带 seq', async (t) => {
  const gw = await makeMockGateway(t);
  const api = await makeMockApi(t);
  const auth = await makeMockAuth(t);
  const adapter = makeAdapter(gw.port, api.port, auth.port);
  adapter.start();
  t.after(() => adapter.stop());
  await new Promise((resolve) => adapter.once('connected', resolve));
  await new Promise((r) => setTimeout(r, 1200));
  assert.ok(gw.received.filter((m) => m.op === 1).length >= 1);
});

test('群 @消息 → message 事件（剥离 @）；C2C → message 事件', async (t) => {
  const gw = await makeMockGateway(t);
  const api = await makeMockApi(t);
  const auth = await makeMockAuth(t);
  const adapter = makeAdapter(gw.port, api.port, auth.port);
  const msgs = [];
  adapter.on('message', (m) => msgs.push(m));
  adapter.start();
  t.after(() => adapter.stop());
  await new Promise((resolve) => adapter.once('connected', resolve));
  gw.push({ op: 0, s: 2, t: 'GROUP_AT_MESSAGE_CREATE', d: { group_openid: 'g-allow', author: { user_openid: 'u-allow' }, content: '@机器人 帮我写代码', msg_id: 'm1' } });
  gw.push({ op: 0, s: 3, t: 'C2C_MESSAGE_CREATE', d: { author: { user_openid: 'u-allow' }, content: '你好', msg_id: 'm2' } });
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(msgs.length, 2);
  assert.deepStrictEqual(msgs[0].chat, { type: 'group', id: 'g-allow' });
  assert.strictEqual(msgs[0].text, '帮我写代码');
  assert.strictEqual(msgs[0].msgId, 'm1', '群消息应带 msgId');
  assert.deepStrictEqual(msgs[1].chat, { type: 'private', id: 'u-allow' });
  assert.strictEqual(msgs[1].msgId, 'm2', 'C2C 消息应带 msgId');
});

test('白名单可选：留空 = 允许所有；配置后未命中 → unauthorized', async (t) => {
  // 留空白名单 → 任何用户都能触发 message
  const gw = await makeMockGateway(t);
  const api = await makeMockApi(t);
  const auth = await makeMockAuth(t);
  const open = makeAdapter(gw.port, api.port, auth.port, { allowUsers: [], allowGroups: [] });
  const msgs = [];
  open.on('message', (m) => msgs.push(m));
  open.start();
  t.after(() => open.stop());
  await new Promise((resolve) => open.once('connected', resolve));
  gw.push({ op: 0, s: 2, t: 'C2C_MESSAGE_CREATE', d: { author: { user_openid: 'stranger' }, content: 'hi', msg_id: 'm3' } });
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(msgs.length, 1);
  assert.strictEqual(msgs[0].chat.id, 'stranger');

  // 配置白名单 → 未命中触发 unauthorized
  const gw2 = await makeMockGateway(t);
  const api2 = await makeMockApi(t);
  const auth2 = await makeMockAuth(t);
  const closed = makeAdapter(gw2.port, api2.port, auth2.port, { allowUsers: ['u-allow'], allowGroups: [] });
  const msgs2 = [];
  const unauth = [];
  closed.on('message', (m) => msgs2.push(m));
  closed.on('unauthorized', (u) => unauth.push(u));
  closed.start();
  t.after(() => closed.stop());
  await new Promise((resolve) => closed.once('connected', resolve));
  gw2.push({ op: 0, s: 2, t: 'C2C_MESSAGE_CREATE', d: { author: { user_openid: 'stranger' }, content: 'hi', msg_id: 'm4' } });
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(msgs2.length, 0);
  assert.strictEqual(unauth.length, 1);
  assert.strictEqual(unauth[0].id, 'stranger');
});

test('C2C 空内容（如图片消息）→ message 事件带 unprocessable 标记', async (t) => {
  const gw = await makeMockGateway(t);
  const api = await makeMockApi(t);
  const auth = await makeMockAuth(t);
  const adapter = makeAdapter(gw.port, api.port, auth.port);
  const msgs = [];
  adapter.on('message', (m) => msgs.push(m));
  adapter.start();
  t.after(() => adapter.stop());
  await new Promise((resolve) => adapter.once('connected', resolve));
  gw.push({ op: 0, s: 2, t: 'C2C_MESSAGE_CREATE', d: { author: { user_openid: 'u-allow' }, content: '', msg_id: 'm-img' } });
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(msgs.length, 1);
  assert.strictEqual(msgs[0].unprocessable, true);
  assert.strictEqual(msgs[0].text, '');
});

test('send：私聊/群聊走对应 API 端点并携带 QQBot 凭证', async (t) => {
  const gw = await makeMockGateway(t);
  const api = await makeMockApi(t);
  const auth = await makeMockAuth(t);
  const adapter = makeAdapter(gw.port, api.port, auth.port);
  adapter.start();
  t.after(() => adapter.stop());
  await new Promise((resolve) => adapter.once('connected', resolve));
  adapter.send({ type: 'private', id: 'u-allow' }, '回复内容');
  adapter.send({ type: 'group', id: 'g-allow' }, '群回复');
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(api.posts.length, 2);
  const privatePost = api.posts.find((p) => p.url.includes('/v2/users/u-allow/messages'));
  const groupPost = api.posts.find((p) => p.url.includes('/v2/groups/g-allow/messages'));
  assert.ok(privatePost && groupPost);
  assert.strictEqual(privatePost.auth, `QQBot ${ACCESS_TOKEN}`);
  assert.strictEqual(privatePost.body.markdown.content, '回复内容', '普通回复用 markdown 内容');
  assert.strictEqual(privatePost.body.msg_type, 2);
});

test('send 带 messageReference：回复引用用户原文（message_id）', async (t) => {
  const gw = await makeMockGateway(t);
  const api = await makeMockApi(t);
  const auth = await makeMockAuth(t);
  const adapter = makeAdapter(gw.port, api.port, auth.port);
  adapter.start();
  t.after(() => adapter.stop());
  await new Promise((resolve) => adapter.once('connected', resolve));
  adapter.send({ type: 'private', id: 'u-allow' }, '任务完成回复', { messageReference: { message_id: 'ROBOT1.0_user_msg_123' } });
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(api.posts.length, 1);
  const body = api.posts[0].body;
  assert.deepStrictEqual(body.message_reference, { message_id: 'ROBOT1.0_user_msg_123' }, '应携带引用回复');
});

test('isAllowlistValid：AppID+AppSecret 即可，白名单可选', () => {
  assert.ok(makeAdapter(1, 1, 1).isAllowlistValid());
  assert.ok(new QqOfficialAdapter({ appId: 'a', appSecret: 's' }).isAllowlistValid());
  assert.ok(!new QqOfficialAdapter({ appId: '', appSecret: 's' }).isAllowlistValid());
  assert.ok(!new QqOfficialAdapter({ appId: 'a', appSecret: '' }).isAllowlistValid());
});

test('凭证错误：透出服务器错误信息（如 invalid appid or secret）', async (t) => {
  const gw = await makeMockGateway(t);
  const api = await makeMockApi(t);
  const auth = await makeMockAuth(t, { code: 100016, message: 'invalid appid or secret' });
  const adapter = makeAdapter(gw.port, api.port, auth.port);
  const errors = [];
  adapter.on('error', (e) => errors.push(e.message));
  adapter.start();
  t.after(() => adapter.stop());
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(errors.some((m) => m.includes('invalid appid or secret')));
});

test('stripGroupMention', () => {
  assert.strictEqual(stripGroupMention('@机器人 你好'), '你好');
  assert.strictEqual(stripGroupMention('没有艾特'), '没有艾特');
});

test('send 带 keyboard：markdown 消息 + 指令按钮（按钮只能 markdown 渲染）', async (t) => {
  const gw = await makeMockGateway(t);
  const api = await makeMockApi(t);
  const auth = await makeMockAuth(t);
  const adapter = makeAdapter(gw.port, api.port, auth.port);
  adapter.start();
  t.after(() => adapter.stop());
  await new Promise((resolve) => adapter.once('connected', resolve));
  adapter.send({ type: 'private', id: 'u-allow' }, '点按钮选择\n第二行', {
    keyboard: { rows: [{ buttons: [{ label: '工作区A', cmd: '/bot ws 工作区A' }, { label: '工作区B', cmd: '/bot ws 工作区B' }] }] },
  });
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(api.posts.length, 1);
  const body = api.posts[0].body;
  // 按钮必须用 markdown 消息（msg_type:2 + markdown.content）才能渲染（纯文本+keyboard 不显示）
  assert.strictEqual(body.msg_type, 2, '按钮消息用 markdown 类型');
  assert.strictEqual(body.markdown.content, '点按钮选择\n第二行', 'markdown 支持换行');
  const kb = body.keyboard;
  // 官方格式：rows 必须包在 keyboard.content 里（曾漏掉 content 层导致按钮不显示/400）
  assert.ok(kb && kb.content && Array.isArray(kb.content.rows) && kb.content.rows.length === 1, 'keyboard 应含 content.rows');
  const btns = kb.content.rows[0].buttons;
  assert.strictEqual(btns.length, 2);
  assert.ok(btns[0].id !== btns[1].id);
  assert.strictEqual(btns[0].render_data.label, '工作区A');
  assert.strictEqual(btns[0].action.type, 2, '指令按钮 type=2');
  assert.strictEqual(btns[0].action.data, '/bot ws 工作区A', '指令按钮 data=点击后发送的命令');
  assert.strictEqual(btns[0].action.enter, true, '点击后自动发送');
  assert.strictEqual(btns[0].action.permission.type, 2);
});

test('超长回复用普通 markdown 分片串行（stream_messages 接口实测 500，弃用）', async (t) => {
  const gw = await makeMockGateway(t);
  const api = await makeMockApi(t);
  const auth = await makeMockAuth(t);
  const adapter = makeAdapter(gw.port, api.port, auth.port);
  adapter.start();
  t.after(() => adapter.stop());
  await new Promise((resolve) => adapter.once('connected', resolve));
  // 构造超长文本（超过单条上限 2000，约 2 片）
  const longText = Array.from({ length: 25 }, (_, i) => `第 ${i + 1} 段：${'内容'.repeat(100)}`).join('\n');
  assert.ok(longText.length > 2000, '测试文本应超单条上限');
  adapter.send({ type: 'private', id: 'u-allow' }, longText);
  await new Promise((r) => setTimeout(r, 1500)); // 2 片 × 250ms 间隔 + 余量

  // 全部走普通 /messages（markdown），不碰 stream_messages
  assert.ok(!api.posts.some((p) => p.url.includes('/stream_messages')), '不应使用流式接口');
  const msgs = api.posts.filter((p) => p.url.includes('/messages'));
  assert.ok(msgs.length >= 2, '超长文本应拆成多条普通消息');
  msgs.forEach((p) => {
    assert.strictEqual(p.body.msg_type, 2, '分片用 markdown 消息');
    assert.ok(p.body.markdown.content.length <= 2000, '每片不超过单条上限');
  });
  // 拼接不丢失
  const all = msgs.map((p) => p.body.markdown.content).join('\n');
  const normalized = all.replace(/\n\n+/g, '\n').trimEnd();
  const expected = longText.replace(/\n\n+/g, '\n').trimEnd();
  assert.strictEqual(normalized, expected, '分片拼接应等于原文（不丢失）');
});

test('无 keyboard 时普通回复用 markdown（粗体可渲染，保留换行）', async (t) => {
  const gw = await makeMockGateway(t);
  const api = await makeMockApi(t);
  const auth = await makeMockAuth(t);
  const adapter = makeAdapter(gw.port, api.port, auth.port);
  adapter.start();
  t.after(() => adapter.stop());
  await new Promise((resolve) => adapter.once('connected', resolve));
  adapter.send({ type: 'private', id: 'u-allow' }, '**粗体**\n第二行');
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(api.posts.length, 1);
  const body = api.posts[0].body;
  assert.strictEqual(body.msg_type, 2, '普通回复用 markdown 类型（粗体可渲染）');
  assert.strictEqual(body.markdown.content, '**粗体**\n第二行', 'markdown 保留换行与语法');
  assert.ok(!body.keyboard, '无按钮时不应带 keyboard');
});

test('INTERACTION_CREATE(type=11) → PUT 回应互动（防客户端 loading 卡死）', async (t) => {
  const gw = await makeMockGateway(t);
  const api = await makeMockApi(t);
  const auth = await makeMockAuth(t);
  const adapter = makeAdapter(gw.port, api.port, auth.port);
  const msgs = [];
  adapter.on('message', (m) => msgs.push(m));
  adapter.start();
  t.after(() => adapter.stop());
  await new Promise((resolve) => adapter.once('connected', resolve));
  // 指令按钮点击由 QQ 自动发消息，INTERACTION_CREATE 仅需回应（不触发 message 事件）
  gw.push({
    op: 0, s: 4, t: 'INTERACTION_CREATE',
    d: {
      id: 'inter-1',
      type: 11,
      scene: 'c2c',
      chat_type: 2,
      user_openid: 'u-allow',
      data: { type: 11, resolved: { button_id: 'whatever', button_data: '/bot ws 工作区A' } },
    },
  });
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(msgs.length, 0, '指令按钮方案：点击由 QQ 自动发消息，不在此转 message');
  // 必须 PUT 回应互动（不回应客户端会一直 loading）
  const ack = api.posts.find((p) => p.method === 'PUT' && p.url.includes('/interactions/inter-1'));
  assert.ok(ack, '应 PUT 回应互动事件');
  assert.deepStrictEqual(ack.body, { code: 0 });
});

test('INTERACTION_CREATE 非按钮类型（如 type=18 授权）→ 不触发 message 事件', async (t) => {
  const gw = await makeMockGateway(t);
  const api = await makeMockApi(t);
  const auth = await makeMockAuth(t);
  const adapter = makeAdapter(gw.port, api.port, auth.port);
  const msgs = [];
  adapter.on('message', (m) => msgs.push(m));
  adapter.start();
  t.after(() => adapter.stop());
  await new Promise((resolve) => adapter.once('connected', resolve));
  gw.push({
    op: 0, s: 4, t: 'INTERACTION_CREATE',
    d: { id: 'inter-2', type: 18, scene: 'c2c', chat_type: 2, user_openid: 'u-allow', data: {} },
  });
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(msgs.length, 0);
});

test('按钮点击：未知 button_id → 仍 PUT 回应（避免客户端卡 loading），不触发消息', async (t) => {
  const gw = await makeMockGateway(t);
  const api = await makeMockApi(t);
  const auth = await makeMockAuth(t);
  const adapter = makeAdapter(gw.port, api.port, auth.port);
  const msgs = [];
  adapter.on('message', (m) => msgs.push(m));
  adapter.start();
  t.after(() => adapter.stop());
  await new Promise((resolve) => adapter.once('connected', resolve));
  gw.push({
    op: 0, s: 4, t: 'INTERACTION_CREATE',
    d: { id: 'inter-x', type: 11, scene: 'c2c', chat_type: 2, user_openid: 'u-allow', data: { type: 11, resolved: { button_id: 'b999_1' } } },
  });
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(msgs.length, 0, '指令按钮方案不在此转 message');
  assert.ok(api.posts.some((p) => p.method === 'PUT' && p.url.includes('/interactions/inter-x')), '应 PUT 回应');
});

test('菜单/面板：默认菜单与面板结构；getMenu/setMenu/createPanel 调用正确', async (t) => {
  const gw = await makeMockGateway(t);
  const api = await makeMockApi(t);
  const auth = await makeMockAuth(t);
  const adapter = makeAdapter(gw.port, api.port, auth.port);
  adapter.start();
  t.after(() => adapter.stop());
  await new Promise((resolve) => adapter.once('connected', resolve));

  // 默认菜单：send_message 项，点击自动填入短命令
  const menu = QqOfficialAdapter.defaultMenu();
  assert.ok(Array.isArray(menu) && menu.length >= 5, '默认菜单至少 5 项');
  assert.ok(menu.every((m) => m.type === 'send_message' && m.name && m.send_message.startsWith('/')), '菜单项为 send_message + 短命令');

  // 默认面板：command 项
  const panel = QqOfficialAdapter.defaultPanel();
  assert.ok(panel.items.length >= 5, '默认面板至少 5 项');
  assert.ok(panel.items.every((i) => i.type === 'command' && i.name && i.desc), '面板项为 command + 名称/描述');

  // getMenu（空）→ setMenu → listPanels（空）→ createPanel
  const current = await adapter.getMenu();
  assert.ok(current && current.menu, 'getMenu 应返回菜单结构');
  await adapter.setMenu(menu);
  const setCall = api.posts.find((p) => p.method === 'PUT' && p.url === '/v2/menu');
  assert.ok(setCall, '应 PUT /v2/menu');
  assert.deepStrictEqual(setCall.body.menu.items, menu, '菜单内容正确');
  assert.ok(setCall.auth === `QQBot ${ACCESS_TOKEN}`, '菜单请求带鉴权');

  const panels = await adapter.listPanels('c2c');
  assert.ok(panels && Array.isArray(panels.records), 'listPanels 返回 records');
  const created = await adapter.createPanel('c2c', panel);
  assert.strictEqual(created.panel_id, 'p_test_001', 'createPanel 返回 panel_id');
  const createCall = api.posts.find((p) => p.method === 'POST' && p.url === '/v2/panels');
  assert.ok(createCall, '应 POST /v2/panels');
  assert.strictEqual(createCall.body.scope, 'c2c');
  assert.strictEqual(createCall.body.target_type, 'all');
  assert.deepStrictEqual(createCall.body.panel, panel, '面板内容正确');
});
