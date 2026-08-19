'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { DshApiClient } = require('../src/im/dsh-api');
const { OneBotAdapter } = require('../src/im/adapters/onebot');
const { SessionMapper } = require('../src/im/session-mapper');
const { ImBridge } = require('../src/im/bridge');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const BOT_UIN = 10086;

// ---------- WS 帧工具 ----------
function wsFrame(obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const head = Buffer.from([0x81, 126, (payload.length >> 8) & 0xff, payload.length & 0xff]);
  return Buffer.concat([head, payload]);
}

/** 增量解析客户端→服务端 WS 帧（含掩码） */
class WsInbox {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.texts = [];
    this.closed = false;
  }
  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    this._drain();
  }
  _drain() {
    let off = 0;
    for (;;) {
      if (off + 2 > this.buf.length) break;
      const b0 = this.buf[off];
      const b1 = this.buf[off + 1];
      const opcode = b0 & 0x0f;
      if (opcode === 0x8) {
        this.closed = true;
        off = this.buf.length;
        break;
      }
      let len = b1 & 0x7f;
      let idx = off + 2;
      if (len === 126) {
        if (idx + 2 > this.buf.length) break;
        len = this.buf.readUInt16BE(idx);
        idx += 2;
      } else if (len === 127) {
        if (idx + 8 > this.buf.length) break;
        len = Number(this.buf.readBigUInt64BE(idx));
        idx += 8;
      }
      const masked = (b1 & 0x80) !== 0;
      let maskKey = null;
      if (masked) {
        if (idx + 4 > this.buf.length) break;
        maskKey = this.buf.slice(idx, idx + 4);
        idx += 4;
      }
      if (idx + len > this.buf.length) break;
      let payload = this.buf.slice(idx, idx + len);
      if (maskKey) {
        const unmasked = Buffer.alloc(len);
        for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ maskKey[i % 4];
        payload = unmasked;
      }
      off = idx + len;
      if (opcode === 0x1) this.texts.push(payload.toString('utf8'));
    }
    this.buf = this.buf.slice(off);
  }
}

// ---------- mock dsh ----------
async function makeMockDsh(t, initialSessions = [], workspaces = null, archivedSessionIds = []) {
  const state = {
    sessions: initialSessions,
    prompts: [],
    cancels: [],
    selectModels: [],
    responses: [],
    archivedSessionIds,
  };
  // 默认一个工作区，sessionIds 取自初始会话；可传 workspaces 覆盖
  const wsItems =
    workspaces ||
    (initialSessions.length
      ? [{ id: 'ws-1', workspaceId: 'ws-1', title: '项目A', sessionIds: initialSessions.map((s) => s.sessionId) }]
      : []);
  let muxSocket = null;
  const pushMux = (payload, rpcId = 'r-e') => {
    if (muxSocket) {
      muxSocket.write(wsFrame({ type: 'server-request', rpcId, method: 'events.mux', payload }));
    }
  };
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const env = JSON.parse(body || '{}');
      // /api/respond：approval/question 应答（client-response 帧）
      if (env.type === 'client-response') {
        state.responses.push(env);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ accepted: true }));
        return;
      }
      const send = (result) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'server-response', rpcId: env.rpcId, result }));
      };
      const method = env.method || '';
      switch (method) {
        case 'session.list':
          return send({ ok: true, value: { items: state.sessions } });
        case 'session.prompt': {
          state.prompts.push(env.payload);
          const text = env.payload && env.payload.content && env.payload.content[0] && env.payload.content[0].text;
          if (typeof text === 'string' && text.startsWith('/')) {
            return send({ ok: true, value: { accepted: true, command: { kind: 'success', text: '已执行：' + text } } });
          }
          return send({ ok: true, value: { accepted: true } });
        }
        case 'session.cancel':
          state.cancels.push(env.payload);
          return send({ ok: true, value: { accepted: true } });
        case 'session.history':
          return send({
            ok: true,
            value: {
              events: [
                { event: { type: 'user/message', message: { content: [{ type: 'text', text: '你好' }] } } },
                // 真实 dsh：message 在 data.message（曾因解析错导致任务完成无正文）；
                // 一条回复可能多条 assistant/message，需累加（曾只取第一条导致正文不全）
                { event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '这是回复内容' }] } } } },
                { event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '这是第一段回复' }] } } } },
                { event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '这是第二段回复' }] } } } },
              ],
              hasMore: false,
            },
          });
        case 'session.models':
          return send({
            ok: true,
            value: { current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' }, routable: true, groups: [{ name: 'DeepSeek', models: [{ id: 'deepseek-v4-flash', name: 'Flash' }] }], failures: [] },
          });
        case 'session.selectModel':
          state.selectModels.push(env.payload);
          return send({ ok: true, value: { selected: { provider: env.payload.provider, model: env.payload.model } } });
        case 'workspace.list':
          // 真实 dsh 返回 { items, archivedSessionIds }；每个工作区带 sessionIds（含归档会话）。
          // archivedSessionIds 才是归档依据（曾误用 sessionIds 判断导致归档会话被当成活跃）
          return send({ ok: true, value: { items: wsItems, archivedSessionIds: state.archivedSessionIds } });
        case 'host.describe':
          return send({ ok: true, value: { version: '0.0.1', provider: 'deepseek-official', model: 'deepseek-v4-flash' } });
        default:
          return send({ ok: false, error: { code: 'method-not-found', message: '未注册：' + method } });
      }
    });
  });
  srv.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'] || '';
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n'
    );
    socket.write(wsFrame({ type: 'server-request', rpcId: 'r1', method: 'events.mux', payload: { type: 'session/subscribed', sessionId: 's-1', lastSeq: 0 } }));
    muxSocket = socket;
    // 回应客户端 close 帧，避免 WS 半开卡住进程
    const inbox = new WsInbox();
    socket.on('data', (c) => {
      inbox.push(c);
      if (inbox.closed) {
        socket.write(Buffer.from([0x88, 0x00]));
        socket.end();
      }
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  return { port: srv.address().port, state, pushMux };
}

// ---------- mock OneBot WS 服务器 ----------
async function makeMockOneBot(t, { allowUsers = [], allowGroups = [] } = {}) {
  const sent = [];
  const sockets = new Set();
  const srv = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('ok');
  });
  srv.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'] || '';
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n'
    );
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const inbox = new WsInbox();
    socket.on('data', (c) => {
      inbox.push(c);
      while (inbox.texts.length) {
        const text = inbox.texts.shift();
        let action;
        try {
          action = JSON.parse(text);
        } catch {
          continue;
        }
        sent.push(action);
        let data = null;
        if (action.action === 'get_login_info') data = { user_id: BOT_UIN };
        socket.write(wsFrame({ status: 'ok', retcode: 0, data, echo: action.echo }));
      }
      if (inbox.closed) {
        // 回应 close 帧并关闭，避免客户端 WS 半开
        socket.write(Buffer.from([0x88, 0x00]));
        socket.end();
        sockets.delete(socket);
      }
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const push = (obj) => {
    for (const s of sockets) s.write(wsFrame(obj));
  };
  return {
    port: srv.address().port,
    sent,
    pushPrivate(userId, text, messageId) {
      push({ post_type: 'message', message_type: 'private', user_id: userId, message: text, raw_message: text, message_id: messageId });
    },
    pushGroup(groupId, userId, text) {
      push({ post_type: 'message', message_type: 'group', group_id: groupId, user_id: userId, message: text, raw_message: text });
    },
    pushAssistant(sessionId, text) {
      push({ type: 'server-request', rpcId: 'r-e', method: 'events.mux', payload: { type: 'session/event', sessionId, event: { type: 'assistant/message', message: { content: [{ type: 'text', text }] } } } });
    },
  };
}

function setup(t, { onebot = {}, config = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'im-bridge-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mapper = new SessionMapper(dir);
  return { dir, mapper };
}

function waitFor(fn, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (fn()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor 超时'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

function sendActionsOf(mockOneBot, action) {
  return mockOneBot.sent.filter((a) => a.action === action);
}

/** 每个测试：先等适配器连上 mock，再发消息（避免竞态） */
async function startBridgeAndWait(t, { mockDsh, mockBot, mapper, config = {}, usageFn = null, allowUsers, allowGroups, onTaskComplete = null, onConfigChange = null }) {
  const dsh = new DshApiClient({ port: mockDsh.port });
  const adapter = new OneBotAdapter({
    wsUrl: `ws://127.0.0.1:${mockBot.port}`,
    allowUsers: allowUsers || [111],
    allowGroups: allowGroups || [],
  });
  const bridge = new ImBridge({
    dsh,
    mapper,
    config,
    usageFn: usageFn || (() => null),
    notify: () => {},
    onTaskComplete: onTaskComplete || undefined,
    onConfigChange: onConfigChange || undefined,
    pollIntervalMs: 100,
  });
  bridge.setAdapters([{ name: 'qq', adapter }]);
  await bridge.start();
  t.after(() => bridge.stop());
  await waitFor(() => adapter.connected);
  await waitFor(() => adapter.botUin === BOT_UIN);
  return { dsh, adapter, bridge };
}

test('私聊提示词 → ack；完成后收到回复（纯对话）', async (t) => {
  const { mapper } = setup(t);
  const mockDsh = await makeMockDsh(t, [{ sessionId: 's-1', title: '会话A', running: false }]);
  const mockBot = await makeMockOneBot(t, { allowUsers: [111] });
  const { bridge } = await startBridgeAndWait(t, { mockDsh, mockBot, mapper });

  mapper.set('qq', '111', { sessionId: 's-1', mode: 'pure' });

  // 建立 busy 基线：等轮询观察到 running=true
  mockDsh.state.sessions[0].running = true;
  await waitFor(() => bridge.busy.get('s-1') === true);

  mockBot.pushPrivate(111, '你好');
  await waitFor(() => mockBot.sent.some((a) => a.action === 'send_private_msg' && /已提交|已加入队列/.test(String(a.params.message))));
  assert.strictEqual(mockDsh.state.prompts[0].content[0].text, '你好');

  // 完成：assistant 事件（走 dsh mux 流）+ running→false
  mockDsh.pushMux({ type: 'session/event', sessionId: 's-1', event: { type: 'assistant/message', message: { content: [{ type: 'text', text: '这是回复内容' }] } } });
  mockDsh.state.sessions[0].running = false;
  await waitFor(() => mockBot.sent.some((a) => a.action === 'send_private_msg' && String(a.params.message).includes('任务完成')));
  const done = sendActionsOf(mockBot, 'send_private_msg').map((a) => String(a.params.message)).join('\n');
  assert.ok(done.includes('这是回复内容'));
});

test('任务完成回复引用用户原文（官方适配器 messageReference = 用户消息 msgId）', async (t) => {
  const { EventEmitter } = require('node:events');
  class FakeOfficial extends EventEmitter {
    constructor() {
      super();
      this.platform = 'qqofficial';
      this.supportsKeyboard = true;
      this.sent = [];
      this.cmds = [];
    }
    isAllowlistValid() { return true; }
    start() {}
    stop() {}
    send(chat, text, opts) {
      this.sent.push({ chat, text, opts });
      if (opts && opts.keyboard) for (const row of opts.keyboard.rows) for (const b of row.buttons) this.cmds.push(b.cmd);
    }
  }
  const { mapper } = setup(t);
  const mockDsh = await makeMockDsh(t, [{ sessionId: 's-1', title: '会话A', running: false }]);
  const dsh = new DshApiClient({ port: mockDsh.port });
  const adapter = new FakeOfficial();
  const bridge = new ImBridge({ dsh, mapper, config: {}, usageFn: () => null, notify: () => {}, pollIntervalMs: 100 });
  bridge.setAdapters([{ name: 'official', adapter }]);
  await bridge.start();
  t.after(() => bridge.stop());
  mapper.set('qqofficial', 'openid-1', { sessionId: 's-1', workspaceId: 'ws-1', mode: 'pure' });

  // 用户消息 → prompter 记录 msgId
  await bridge.handleMessage({ adapter, platform: 'qqofficial', chat: { type: 'private', id: 'openid-1' }, senderId: 'openid-1', text: '帮我写个函数', msgId: 'ROBOT1.0_user_msg_xyz' });
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(bridge.prompter.get('s-1').msgId, 'ROBOT1.0_user_msg_xyz');

  // 完成 → 完成回复带 messageReference
  await bridge._onComplete({ sessionId: 's-1', title: '会话A' });
  await new Promise((r) => setTimeout(r, 100));
  const done = adapter.sent.find((s) => String(s.text).includes('任务完成'));
  assert.ok(done, '应发出任务完成回复');
  assert.strictEqual(done.opts.messageReference.message_id, 'ROBOT1.0_user_msg_xyz', '完成回复应引用用户原文');
});

test('任务完成系统通知走 onTaskComplete（标题用 projections.values.title，不走 notify 直发）', async (t) => {
  const { mapper } = setup(t);
  const mockDsh = await makeMockDsh(t, [{ sessionId: 's-1', running: false, projections: { values: { title: '深色主题任务' } } }]);
  const mockBot = await makeMockOneBot(t, { allowUsers: [111] });
  const notified = [];
  const { bridge } = await startBridgeAndWait(t, { mockDsh, mockBot, mapper, onTaskComplete: (title, body) => notified.push({ title, body }) });
  mapper.set('qq', '111', { sessionId: 's-1', mode: 'pure' });

  // 先让轮询观察到 running=true（建立 busy 基线），再转 false 触发完成
  mockDsh.state.sessions[0].running = true;
  await waitFor(() => bridge.busy.get('s-1') === true);
  mockDsh.state.sessions[0].running = false;
  await waitFor(() => notified.length >= 1);

  assert.strictEqual(notified.length, 1);
  assert.strictEqual(notified[0].title, '深色主题任务', '标题应取 projections.values.title 而非 sessionId');
  assert.ok(!String(notified[0].title).startsWith('session-'), '标题不应退化成 session ID');
});

test('mux 漏帧时任务完成正文从 history 兜底拉取（data.message 结构）', async (t) => {
  const { mapper } = setup(t);
  const mockDsh = await makeMockDsh(t, [{ sessionId: 's-1', running: false, projections: { values: { title: '会话甲' } } }]);
  const mockBot = await makeMockOneBot(t, { allowUsers: [111] });
  const sentReplies = [];
  const notified = [];
  const { bridge } = await startBridgeAndWait(t, {
    mockDsh,
    mockBot,
    mapper,
    onTaskComplete: (title, body) => notified.push({ title, body }),
  });
  mapper.set('qq', '111', { sessionId: 's-1', mode: 'pure' });

  // 不推送任何 mux assistant 事件（模拟漏帧），直接完成 → 应走 history 兜底
  mockDsh.state.sessions[0].running = true;
  await waitFor(() => bridge.busy.get('s-1') === true);
  mockDsh.state.sessions[0].running = false;
  await waitFor(() => mockBot.sent.some((a) => a.action === 'send_private_msg' && String(a.params.message).includes('任务完成')));

  const done = sendActionsOf(mockBot, 'send_private_msg').map((a) => String(a.params.message)).join('\n');
  assert.ok(done.includes('这是第一段回复') && done.includes('这是第二段回复'), '任务完成正文应累加多条 assistant/message');
  assert.ok(notified.length >= 1 && notified[0].body.includes('这是第一段回复') && notified[0].body.includes('这是第二段回复'), '系统通知 body 也应累加');
});

test('/plan 透传 → 返回 command 结果；/stop → cancel', async (t) => {
  const { mapper } = setup(t);
  const mockDsh = await makeMockDsh(t, [{ sessionId: 's-1', title: '会话A', running: false }]);
  const mockBot = await makeMockOneBot(t, { allowUsers: [111] });
  const { adapter } = await startBridgeAndWait(t, { mockDsh, mockBot, mapper });
  mapper.set('qq', '111', { sessionId: 's-1' });

  mockBot.pushPrivate(111, '/plan 做一件事');
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('已执行：/plan')));
  assert.strictEqual(mockDsh.state.prompts[0].mode, 'queue');
  assert.strictEqual(mockDsh.state.prompts[0].content[0].text, '/plan 做一件事');

  mockBot.pushPrivate(111, '/stop');
  await waitFor(() => mockDsh.state.cancels.length >= 1);
  assert.strictEqual(mockDsh.state.cancels[0].sessionId, 's-1');
  void adapter;
});

test('未绑定会话 → 首次收欢迎、之后提示绑定；/ws + /ses 选择', async (t) => {
  const { mapper } = setup(t);
  const mockDsh = await makeMockDsh(t, [{ sessionId: 's-1', title: '会话A', running: false }]);
  const mockBot = await makeMockOneBot(t, { allowUsers: [111] });
  await startBridgeAndWait(t, { mockDsh, mockBot, mapper });

  // 首条消息：欢迎（含快速开始），不出现"尚未绑定"
  mockBot.pushPrivate(111, '你好');
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('已连接 DSH Desk')));
  const first = sendActionsOf(mockBot, 'send_private_msg').map((a) => String(a.params.message)).join('\n');
  assert.ok(first.includes('快速开始'));
  assert.ok(!first.includes('尚未绑定会话'));

  // 第二条未绑定消息：自动弹「选择工作区」引导（欢迎只发一次）
  mockBot.pushPrivate(111, '你好');
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('选择工作区')));
  const welcomes = sendActionsOf(mockBot, 'send_private_msg').filter((a) => String(a.params.message).includes('已连接 DSH Desk'));
  assert.strictEqual(welcomes.length, 1);

  mockBot.pushPrivate(111, '/ws');
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('项目A')));
  mockBot.pushPrivate(111, '/ws 项目A');
  // 选完工作区 → 自动弹「选择会话」引导（不再回「工作区 →」）
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('选择会话')));
  mockBot.pushPrivate(111, '/ses 会话A');
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('会话 → 会话A')));
  assert.strictEqual(mapper.get('qq', '111').sessionId, 's-1');

  // 会话无标题时可用 ID 前缀选中（pick 前缀匹配）
  mockBot.pushPrivate(111, '/ses s-1');
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('会话 → 会话A')));
  assert.strictEqual(mapper.get('qq', '111').sessionId, 's-1');
});

test('会话无标题时可用 ID 前缀选中（pick 前缀匹配；列表不显示空白对话）', async (t) => {
  const { mapper } = setup(t);
  const mockDsh = await makeMockDsh(t, [
    { sessionId: 'session-a1', title: '', running: false },
    { sessionId: 'session-b2', title: '', running: false },
  ]);
  const mockBot = await makeMockOneBot(t, { allowUsers: [111] });
  await startBridgeAndWait(t, { mockDsh, mockBot, mapper });

  // 先选工作区（默认 ws-1 含两个会话），选完自动弹会话引导
  mockBot.pushPrivate(111, '/ws');
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('项目A')));
  mockBot.pushPrivate(111, '/ws 项目A');
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('选择会话')));

  // 无标题会话不显示在列表（不出现空白对话）
  mockBot.pushPrivate(111, '/ses');
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('选择会话')));
  const listText = sendActionsOf(mockBot, 'send_private_msg').map((a) => String(a.params.message)).join('\n');
  assert.ok(!listText.includes('session-a1') && !listText.includes('session-b2'), '无标题会话不应显示在列表');

  // 但显式 ID 前缀仍可选（用名称兜底「未命名会话」）
  mockBot.pushPrivate(111, '/ses session-a');
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('未命名会话')));
  assert.strictEqual(mapper.get('qq', '111').sessionId, 'session-a1');
});

test('列表带编号；/ses <数字> 按序号选择（pick 序号匹配）', async (t) => {
  const { mapper } = setup(t);
  const mockDsh = await makeMockDsh(
    t,
    [
      { sessionId: 's-1', running: false, title: '会话甲' },
      { sessionId: 's-2', running: false, title: '会话乙' },
      { sessionId: 's-3', running: false, title: '会话丙' },
    ],
    [
      { id: 'ws-1', workspaceId: 'ws-1', title: '项目A', sessionIds: ['s-1', 's-2', 's-3'] },
    ]
  );
  const mockBot = await makeMockOneBot(t, { allowUsers: [111] });
  await startBridgeAndWait(t, { mockDsh, mockBot, mapper });
  mockBot.pushPrivate(111, '/ws 项目A');
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('选择会话')));

  mockBot.pushPrivate(111, '/ses');
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('会话甲')));
  const list = sendActionsOf(mockBot, 'send_private_msg').map((a) => String(a.params.message)).join('\n');
  assert.ok(list.includes('1. 会话甲'), '列表应带编号');
  assert.ok(list.includes('2. 会话乙'));
  assert.ok(list.includes('3. 会话丙'));

  mockBot.pushPrivate(111, '/ses 2');
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('会话 → 会话乙')));
  assert.strictEqual(mapper.get('qq', '111').sessionId, 's-2');
});

test('已绑定工作区时 /ses 只列该工作区自己的会话', async (t) => {
  const { mapper } = setup(t);
  const mockDsh = await makeMockDsh(
    t,
    [
      { sessionId: 's-ws1', title: '会话1', running: false },
      { sessionId: 's-other', title: '别的会话', running: false },
      { sessionId: 's-ws2', title: '会话2', running: false },
    ],
    [
      { id: 'ws-1', workspaceId: 'ws-1', title: '项目A', sessionIds: ['s-ws1', 's-ws2'] },
      { id: 'ws-2', workspaceId: 'ws-2', title: '项目B', sessionIds: ['s-other'] },
    ]
  );
  const mockBot = await makeMockOneBot(t, { allowUsers: [111] });
  await startBridgeAndWait(t, { mockDsh, mockBot, mapper });

  // 绑定工作区项目A（含 s-ws1、s-ws2，不含 s-other）→ 自动弹会话引导
  mockBot.pushPrivate(111, '/ws 项目A');
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('选择会话')));

  mockBot.pushPrivate(111, '/ses');
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('当前工作区（项目A）')));
  const list = sendActionsOf(mockBot, 'send_private_msg').map((a) => String(a.params.message)).join('\n');
  assert.ok(list.includes('会话1') && list.includes('会话2'));
  assert.ok(!list.includes('别的会话')); // 别的工作区的会话不应出现
});

test('会话标题：优先 projections.values.title；运行中标「运行中」', async (t) => {
  const { mapper } = setup(t);
  const mockDsh = await makeMockDsh(
    t,
    [
      { sessionId: 's-run', running: true, projections: { values: { title: '正在干活的任务' } } },
      { sessionId: 's-title', running: false, title: '顶层标题', projections: { values: { title: '投影标题' } } },
    ],
    [
      { id: 'ws-1', workspaceId: 'ws-1', title: '项目A', sessionIds: ['s-run', 's-title'] },
    ]
  );
  const mockBot = await makeMockOneBot(t, { allowUsers: [111] });
  await startBridgeAndWait(t, { mockDsh, mockBot, mapper });
  mockBot.pushPrivate(111, '/ws 项目A');
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('选择会话')));

  mockBot.pushPrivate(111, '/ses');
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('正在干活的任务')));
  const list = sendActionsOf(mockBot, 'send_private_msg').map((a) => String(a.params.message)).join('\n');
  assert.ok(list.includes('正在干活的任务（运行中）'), '运行中会话应显示标题+运行中');
  assert.ok(list.includes('顶层标题'), '顶层 title 优先于 projections');
});

test('归档会话（在 archivedSessionIds 里，即使也在工作区 sessionIds 中）一律排除', async (t) => {
  const { mapper } = setup(t);
  const mockDsh = await makeMockDsh(
    t,
    [
      { sessionId: 's-active-1', running: false, title: '活跃一' },
      { sessionId: 's-active-2', running: false, title: '活跃二' },
      { sessionId: 's-archived', running: false, title: '归档的旧会话' },
    ],
    [
      // 归档会话仍挂在工作区 sessionIds 里（真实 dsh 行为）
      { id: 'ws-1', workspaceId: 'ws-1', title: '项目A', sessionIds: ['s-active-1', 's-archived'] },
      { id: 'ws-2', workspaceId: 'ws-2', title: '项目B', sessionIds: ['s-active-2'] },
    ],
    ['s-archived'] // archivedSessionIds 才是归档依据
  );
  const mockBot = await makeMockOneBot(t, { allowUsers: [111] });
  await startBridgeAndWait(t, { mockDsh, mockBot, mapper });

  // 未绑定工作区：只列非归档会话，归档不出现
  mockBot.pushPrivate(111, '/ses');
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('活跃一')));
  const list = sendActionsOf(mockBot, 'send_private_msg').map((a) => String(a.params.message)).join('\n');
  assert.ok(list.includes('活跃一') && list.includes('活跃二'), '非归档会话都应列出');
  assert.ok(!list.includes('归档的旧会话'), '归档会话不应出现（即使在工作区 sessionIds 里）');
});

test('首条消息为短指令：先欢迎再执行命令', async (t) => {
  const { mapper } = setup(t);
  const mockDsh = await makeMockDsh(t, [{ sessionId: 's-1', title: '会话A', running: false }]);
  const mockBot = await makeMockOneBot(t, { allowUsers: [111] });
  await startBridgeAndWait(t, { mockDsh, mockBot, mapper });

  mockBot.pushPrivate(111, '/ws');
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('项目A')));
  const all = sendActionsOf(mockBot, 'send_private_msg').map((a) => String(a.params.message)).join('\n');
  assert.ok(all.includes('已连接 DSH Desk')); // 欢迎在前
  assert.ok(all.includes('项目A')); // 命令结果随后
});

test('/help 输出完整帮助', async (t) => {
  const { mapper } = setup(t);
  const mockDsh = await makeMockDsh(t, [{ sessionId: 's-1', title: '会话A', running: false }]);
  const mockBot = await makeMockOneBot(t, { allowUsers: [111] });
  await startBridgeAndWait(t, { mockDsh, mockBot, mapper });

  mockBot.pushPrivate(111, '/help');
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('DSH 远程机器人')));
  const help = sendActionsOf(mockBot, 'send_private_msg').map((a) => String(a.params.message)).join('\n');
  for (const key of ['/ws', '/ses', '/usage', '/setting', '/help', '/plan', '排队', '白名单']) {
    assert.ok(help.includes(key), `帮助应包含「${key}」`);
  }
});

test('非文本消息（图片）→ 自动说明只支持文字，不静默丢弃', async (t) => {
  const { mapper } = setup(t);
  const mockDsh = await makeMockDsh(t, [{ sessionId: 's-1', title: '会话A', running: false }]);
  const mockBot = await makeMockOneBot(t, { allowUsers: [111] });
  await startBridgeAndWait(t, { mockDsh, mockBot, mapper });
  mapper.set('qq', '111', { sessionId: 's-1' });

  // OneBot 分段数组：只有 image 段 → 提取不到文字 → 回"只支持文字"
  mockBot.pushPrivate(111, [{ type: 'image', data: { file: 'a.png' } }]);
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('只支持文字')));
  assert.strictEqual(mockDsh.state.prompts.length, 0); // 不触发提示词

  // 混合段（文字+图片）→ 正常提取文字，照常处理
  mockBot.pushPrivate(111, [{ type: 'text', data: { text: '看图写代码' } }, { type: 'image', data: { file: 'b.png' } }]);
  await waitFor(() => mockDsh.state.prompts.length >= 1);
  assert.strictEqual(mockDsh.state.prompts[0].content[0].text, '看图写代码');
});

test('适配器注册名非 qq（生产为 onebot/official）时回复仍能送达', async (t) => {
  const { mapper } = setup(t);
  const mockDsh = await makeMockDsh(t, [{ sessionId: 's-1', title: '会话A', running: false }]);
  const mockBot = await makeMockOneBot(t, { allowUsers: [111] });
  const dsh = new DshApiClient({ port: mockDsh.port });
  const adapter = new OneBotAdapter({ wsUrl: `ws://127.0.0.1:${mockBot.port}`, allowUsers: [111] });
  const bridge = new ImBridge({ dsh, mapper, config: {}, usageFn: () => null, notify: () => {}, pollIntervalMs: 100 });
  bridge.setAdapters([{ name: 'onebot', adapter }]); // 生产命名（不是 'qq'）
  await bridge.start();
  t.after(() => bridge.stop());
  await waitFor(() => adapter.connected);
  await waitFor(() => adapter.botUin === BOT_UIN);
  mapper.set('qq', '111', { sessionId: 's-1' });

  mockBot.pushPrivate(111, '你好');
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('已提交')));
  assert.ok(mockDsh.state.prompts.length >= 1);
});

test('/usage 与 /history', async (t) => {
  const { mapper } = setup(t);
  const mockDsh = await makeMockDsh(t, [{ sessionId: 's-1', title: '会话A', running: false }]);
  const mockBot = await makeMockOneBot(t, { allowUsers: [111] });
  await startBridgeAndWait(t, { mockDsh, mockBot, mapper, usageFn: () => ({ balance: 15.85, spent: 1.2 }) });
  mapper.set('qq', '111', { sessionId: 's-1' });

  mockBot.pushPrivate(111, '/usage');
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('余额')));
  const usageView = sendActionsOf(mockBot, 'send_private_msg').map((a) => String(a.params.message)).join('\n');
  assert.ok(usageView.includes('¥15.85'), '应显示余额');
  assert.ok(usageView.includes('本次启动消费'), '应显示本次消费');
  mockBot.pushPrivate(111, '/history 5');
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('这是第一段回复')));
});

test('白名单外不响应；群聊需 @机器人', async (t) => {
  const { mapper } = setup(t);
  const mockDsh = await makeMockDsh(t, [{ sessionId: 's-1', title: '会话A', running: false }]);
  const mockBot = await makeMockOneBot(t, { allowUsers: [111], allowGroups: [999] });
  await startBridgeAndWait(t, { mockDsh, mockBot, mapper, allowUsers: [111], allowGroups: [999] });
  mapper.set('qq', '111', { sessionId: 's-1' });
  mapper.set('qq', 'group:999', { sessionId: 's-1' });

  const sendsBefore = sendActionsOf(mockBot, 'send_private_msg').length + sendActionsOf(mockBot, 'send_group_msg').length;

  // 白名单外
  mockBot.pushPrivate(222, '你好');
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(sendActionsOf(mockBot, 'send_private_msg').length, sendsBefore);

  // 群聊无 @ → 忽略
  mockBot.pushGroup(999, 333, '大家好');
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(mockDsh.state.prompts.length, 0);

  // 群聊 @机器人 → 处理（剥离 @）
  mockBot.pushGroup(999, 333, `[CQ:at,qq=${BOT_UIN}] 帮我写代码`);
  await waitFor(() => mockDsh.state.prompts.length >= 1);
  assert.strictEqual(mockDsh.state.prompts[0].content[0].text, '帮我写代码');
});

test('口令：未解锁时拒绝；正确口令解锁后可对话', async (t) => {
  const { mapper } = setup(t);
  const mockDsh = await makeMockDsh(t, [{ sessionId: 's-1', title: '会话A', running: false }]);
  const mockBot = await makeMockOneBot(t, { allowUsers: [111] });
  await startBridgeAndWait(t, { mockDsh, mockBot, mapper, config: { passcode: 's3cret' } });
  mapper.set('qq', '111', { sessionId: 's-1' });

  mockBot.pushPrivate(111, '你好');
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('访问口令')));
  mockBot.pushPrivate(111, 's3cret');
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('已解锁')));
  mockBot.pushPrivate(111, '你好');
  await waitFor(() => mockDsh.state.prompts.length >= 1);
});

test('无白名单配置 → 桥接拒绝启动', async (t) => {
  const { mapper } = setup(t);
  const mockDsh = await makeMockDsh(t, []);
  const dsh = new DshApiClient({ port: mockDsh.port });
  const adapter = new OneBotAdapter({ wsUrl: 'ws://127.0.0.1:1', allowUsers: [] });
  const bridge = new ImBridge({ dsh, mapper, config: {}, usageFn: () => null, notify: () => {} });
  bridge.setAdapters([{ name: 'qq', adapter }]);
  await assert.rejects(() => bridge.start(), /白名单/);
});

test('官方适配器：/ws 列表带按钮；点击按钮 → 当作命令执行', async (t) => {
  const { EventEmitter } = require('node:events');
  class FakeOfficial extends EventEmitter {
    constructor() {
      super();
      this.platform = 'qqofficial';
      this.supportsKeyboard = true;
      this.sent = [];
      this.cmds = []; // button_id → cmd
    }
    isAllowlistValid() {
      return true;
    }
    start() {
      /* 假适配器：无需真实连接 */
    }
    stop() {
      /* noop */
    }
    send(chat, text, opts) {
      this.sent.push({ chat, text, opts });
      if (opts && opts.keyboard) {
        for (const row of opts.keyboard.rows) {
          for (const b of row.buttons) {
            this.cmds.push(b.cmd);
          }
        }
      }
    }
  }
  const { mapper } = setup(t);
  const mockDsh = await makeMockDsh(t, [{ sessionId: 's-1', title: '会话A', running: false }]);
  const dsh = new DshApiClient({ port: mockDsh.port });
  const adapter = new FakeOfficial();
  const bridge = new ImBridge({ dsh, mapper, config: {}, usageFn: () => null, notify: () => {}, pollIntervalMs: 100 });
  bridge.setAdapters([{ name: 'official', adapter }]);
  await bridge.start();
  t.after(() => bridge.stop());

  // /ws → 列表回复带 keyboard
  await bridge.handleMessage({ adapter, platform: 'qqofficial', chat: { type: 'private', id: 'openid-1' }, senderId: 'openid-1', text: '/ws' });
  await new Promise((r) => setTimeout(r, 100));
  const listMsg = adapter.sent.find((a) => String(a.text).includes('项目A'));
  assert.ok(listMsg, '/ws 应输出工作区列表');
  assert.ok(!String(listMsg.text).includes('ws-1'), '列表不应显示长 ID');
  assert.ok(String(listMsg.text).includes('1. 项目A'), '列表应带编号+标题');
  assert.ok(listMsg.opts && listMsg.opts.keyboard, '官方适配器列表应附带按钮');
  assert.ok(adapter.cmds.includes('/ws 项目A'), '按钮命令应编码 /ws 项目A');
  const wsLabel = listMsg.opts.keyboard.rows[0].buttons[0].label;
  assert.strictEqual(wsLabel, '项目A', '按钮 label 应为工作区名称');
  assert.ok(String(wsLabel).length <= 10, '按钮 label 不超 10 字符');

  // 点击按钮（模拟 INTERACTION_BUTTON_CLICK 转成的消息）
  await bridge.handleMessage({ adapter, platform: 'qqofficial', chat: { type: 'private', id: 'openid-1' }, senderId: 'openid-1', text: '/ws 项目A', isButton: true });
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(mapper.get('qqofficial', 'openid-1').workspaceId, 'ws-1');

  // /ses → 附带会话按钮（列表显示标题，不再显示 session ID 字节）
  await bridge.handleMessage({ adapter, platform: 'qqofficial', chat: { type: 'private', id: 'openid-1' }, senderId: 'openid-1', text: '/ses' });
  await new Promise((r) => setTimeout(r, 100));
  const sesMsg = adapter.sent.find((a) => String(a.text).includes('会话A'));
  assert.ok(sesMsg && sesMsg.opts && sesMsg.opts.keyboard, '/ses 应附带会话按钮');
  assert.ok(!String(sesMsg.text).includes('s-1'), '会话列表不应显示 session ID');
  assert.ok(adapter.cmds.includes('/ses s-1'), '按钮命令应编码 /ses s-1');
  const sesLabel = sesMsg.opts.keyboard.rows[0].buttons[0].label;
  assert.strictEqual(sesLabel, '会话A', '会话按钮 label 应为会话标题');

  // 点击会话按钮 → 绑定
  await bridge.handleMessage({ adapter, platform: 'qqofficial', chat: { type: 'private', id: 'openid-1' }, senderId: 'openid-1', text: '/ses s-1', isButton: true });
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(mapper.get('qqofficial', 'openid-1').sessionId, 's-1');

  // /model → 附带模型按钮（指令 = /model <provider>/<id>）
  await bridge.handleMessage({ adapter, platform: 'qqofficial', chat: { type: 'private', id: 'openid-1' }, senderId: 'openid-1', text: '/model' });
  await new Promise((r) => setTimeout(r, 100));
  const modelMsg = adapter.sent.find((a) => String(a.text).includes('deepseek-v4-flash'));
  assert.ok(modelMsg && modelMsg.opts && modelMsg.opts.keyboard, '/model 应附带模型按钮');
  assert.ok(adapter.cmds.includes('/model deepseek-official/deepseek-v4-flash'), '模型按钮应编码完整命令');
});

test('闲置自动退出：超过 idleMinutes 无对话 → 清空 ws/ses 绑定并提示', async (t) => {
  const { mapper } = setup(t);
  const mockDsh = await makeMockDsh(t, [{ sessionId: 's-1', title: '会话A', running: false }]);
  const mockBot = await makeMockOneBot(t, { allowUsers: [111] });
  // idleMinutes=0 由 _checkIdle 直接判定超时（limit=0），便于测试；先正常绑定
  const { bridge } = await startBridgeAndWait(t, { mockDsh, mockBot, mapper, config: { idleMinutes: 1 } });

  // 绑定 ws + ses
  await bridge.handleMessage({ adapter: null, platform: 'qq', chat: { type: 'private', id: '111' }, senderId: '111', text: '/ws 项目A' });
  await new Promise((r) => setTimeout(r, 100));
  await bridge.handleMessage({ adapter: null, platform: 'qq', chat: { type: 'private', id: '111' }, senderId: '111', text: '/ses 会话A' });
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(mapper.get('qq', '111').sessionId, 's-1');

  // 人为把活跃时间推回 2 分钟前 → 触发 _checkIdle 应清空绑定
  bridge.lastActive.set('qq:111', Date.now() - 2 * 60 * 1000);
  bridge._checkIdle();
  const after = mapper.get('qq', '111');
  assert.ok(!after.sessionId, '闲置后 sessionId 应被清空');
  assert.ok(!after.workspaceId, '闲置后 workspaceId 应被清空');
  assert.ok(after.welcomed, '保留 welcomed 标记（不再重复欢迎）');
  await waitFor(() => mockBot.sent.some((a) => a.action === 'send_private_msg' && String(a.params.message).includes('自动退出')));

  // 再发消息 → 自动弹「选择工作区」引导
  mockBot.pushPrivate(111, '你好');
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('选择工作区')));
});

test('闲置退出配置为 0 = 不自动退出', async (t) => {
  const { mapper } = setup(t);
  const mockDsh = await makeMockDsh(t, [{ sessionId: 's-1', title: '会话A', running: false }]);
  const mockBot = await makeMockOneBot(t, { allowUsers: [111] });
  const { bridge } = await startBridgeAndWait(t, { mockDsh, mockBot, mapper, config: { idleMinutes: 0 } });
  mapper.set('qq', '111', { sessionId: 's-1', workspaceId: 'ws-1' });
  bridge.lastActive.set('qq:111', Date.now() - 999 * 60 * 1000);
  bridge._checkIdle();
  assert.strictEqual(mapper.get('qq', '111').sessionId, 's-1', 'idleMinutes=0 时不应自动退出');
});

test('错误通知节流：同标题 30s 内只弹一次（防 500 频控刷屏）', async (t) => {
  const { mapper } = setup(t);
  const mockDsh = await makeMockDsh(t, []);
  const notified = [];
  const dsh = new DshApiClient({ port: mockDsh.port });
  const adapter = { platform: 'qq', isAllowlistValid: () => true, start: () => {}, stop: () => {}, send: () => {}, on: () => {}, emit: () => {} };
  const bridge = new ImBridge({
    dsh,
    mapper,
    config: {},
    usageFn: () => null,
    notify: (title, body) => notified.push({ title, body }),
    pollIntervalMs: 100,
  });
  bridge.setAdapters([{ name: 'qq', adapter }]);
  await bridge.start();
  t.after(() => bridge.stop());

  // 连续触发 5 次同类错误 → 节流期内只弹 1 次
  for (let i = 0; i < 5; i++) bridge._throttledNotify('IM 桥接', '适配器错误：系统繁忙');
  assert.strictEqual(notified.length, 1, '30s 节流期内同类错误只弹一次');

  // 不同标题不受影响
  bridge._throttledNotify('QQ 机器人', '其他错误');
  assert.strictEqual(notified.length, 2);
});

test('/setting：查看/修改闲置退出分钟（渲染模式已移除）', async (t) => {
  const { mapper } = setup(t);
  const mockDsh = await makeMockDsh(t, [{ sessionId: 's-1', title: '会话A', running: false }]);
  const mockBot = await makeMockOneBot(t, { allowUsers: [111] });
  const configPatches = [];
  const { bridge } = await startBridgeAndWait(t, {
    mockDsh,
    mockBot,
    mapper,
    config: { idleMinutes: 30 },
    onConfigChange: async (patch) => {
      configPatches.push(patch);
      return { idleMinutes: patch.idleMinutes ?? 30 };
    },
  });
  mapper.set('qq', '111', { sessionId: 's-1', workspaceId: 'ws-1' });

  // 查看设置（只显示闲置自动退出 + 当前会话）
  mockBot.pushPrivate(111, '/setting');
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('闲置自动退出')));
  const view = sendActionsOf(mockBot, 'send_private_msg').map((a) => String(a.params.message)).join('\n');
  assert.ok(view.includes('30 分钟'), '应显示闲置分钟');
  assert.ok(!view.includes('渲染模式'), '不应再有渲染模式');

  // 修改闲置分钟（写回配置）
  mockBot.pushPrivate(111, '/setting idle 15');
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('15 分钟')));
  assert.deepStrictEqual(configPatches, [{ idleMinutes: 15 }], '应通过 onConfigChange 写回');
  assert.strictEqual(bridge.config.idleMinutes, 15, 'bridge 配置应热更新');

  // idle 无参数 → 二级按钮（选择时长）
  mockBot.pushPrivate(111, '/setting idle');
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('点按钮选择闲置自动退出')));
  assert.ok(sendActionsOf(mockBot, 'send_private_msg').some((a) => a.params.message && a.params.message.includes('点按钮')), 'idle 二级菜单应显示');

  // 主菜单带按钮（官方机器人场景下）
  // /mode 已删除 → 不再响应
  mockBot.pushPrivate(111, '/mode');
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(!sendActionsOf(mockBot, 'send_private_msg').some((a) => String(a.params.message).includes('渲染模式')), '/mode 应已移除');
});

test('按钮点击填入的 /xxx+yyy 与 /xxx yyy 等价（+ 还原为空格）', async (t) => {
  const { mapper } = setup(t);
  const mockDsh = await makeMockDsh(t, [{ sessionId: 's-1', title: '会话A', running: false }]);
  const mockBot = await makeMockOneBot(t, { allowUsers: [111] });
  await startBridgeAndWait(t, { mockDsh, mockBot, mapper, config: { idleMinutes: 30 } });
  mapper.set('qq', '111', { sessionId: 's-1', workspaceId: 'ws-1' });

  // /setting（按钮 URL 编码）应等同 /setting
  mockBot.pushPrivate(111, '/setting');
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('闲置自动退出')));
  const view = sendActionsOf(mockBot, 'send_private_msg').map((a) => String(a.params.message)).join('\n');
  assert.ok(view.includes('30 分钟'), '/setting 应被识别为 setting 命令');

  // /ws+DSH_DESK 多参数编码也应正确还原（mock 工作区标题为「项目A」）
  mockBot.pushPrivate(111, '/ws+项目A');
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('选择会话')));
  assert.strictEqual(mapper.get('qq', '111').workspaceId, 'ws-1', '/ws+项目A 应绑定工作区');
});

test('旧版面板按钮 /bot+xxx（平台缓存）→ 归一化为短命令执行', async (t) => {
  const { mapper } = setup(t);
  const mockDsh = await makeMockDsh(t, [{ sessionId: 's-1', title: '会话A', running: false }]);
  const mockBot = await makeMockOneBot(t, { allowUsers: [111] });
  await startBridgeAndWait(t, { mockDsh, mockBot, mapper });
  mapper.set('qq', '111', { sessionId: 's-1', workspaceId: 'ws-1' });

  // 旧菜单/面板点击 → QQ 填入 /bot+usage 或 /bot+ws+项目A（URL 编码空格为 +）
  // usageFn 未注入 → /usage 会回"用量不可用"，但仍应被识别为机器人命令（不提交对话）
  mockBot.pushPrivate(111, '/bot+usage');
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('用量不可用') || String(a.params.message).includes('余额')));
  assert.strictEqual(mockDsh.state.prompts.length, 0, '/bot+usage 不应透传给 dsh');

  mockBot.pushPrivate(111, '/bot+ws+项目A');
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('选择会话')));
  assert.strictEqual(mapper.get('qq', '111').workspaceId, 'ws-1', '/bot+ws+项目A 应还原为 /ws 项目A');

  // /bot 空格形式同样兼容
  mockBot.pushPrivate(111, '/bot ses');
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('会话A')));
});

test('/help 返回机器人帮助（未绑定也能查，不触发对话）', async (t) => {
  const { mapper } = setup(t);
  const mockDsh = await makeMockDsh(t, [{ sessionId: 's-1', title: '会话A', running: false }]);
  const mockBot = await makeMockOneBot(t, { allowUsers: [111] });
  await startBridgeAndWait(t, { mockDsh, mockBot, mapper });

  // 未绑定发 /help → 直接返回帮助（不提交对话、不弹独立引导）
  mockBot.pushPrivate(111, '/help');
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('DSH 远程机器人指令')));
  assert.strictEqual(mockDsh.state.prompts.length, 0, '/help 不应提交对话');
  // 欢迎消息含「选择工作区」属正常；除欢迎外不应有独立的「先选择工作区」引导
  const nonWelcome = sendActionsOf(mockBot, 'send_private_msg').filter((a) => !String(a.params.message).includes('已连接 DSH Desk'));
  assert.ok(!nonWelcome.some((a) => String(a.params.message).includes('先选择工作区')), '/help 不应触发绑定引导');
});

test('短命令 /ws /ses /setting 等直接可用', async (t) => {
  const { mapper } = setup(t);
  const mockDsh = await makeMockDsh(t, [{ sessionId: 's-1', title: '会话A', running: false }]);
  const mockBot = await makeMockOneBot(t, { allowUsers: [111] });
  await startBridgeAndWait(t, { mockDsh, mockBot, mapper, config: { idleMinutes: 30 } });

  // /ws 列工作区（短命令）
  mockBot.pushPrivate(111, '/ws');
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('项目A')));

  // /setting 显示设置（短命令）
  mockBot.pushPrivate(111, '/setting');
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('闲置自动退出')));

  // /ses 列会话（短命令，绑定 ws 后）
  mockBot.pushPrivate(111, '/ws 项目A');
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('选择会话')));
  mockBot.pushPrivate(111, '/ses');
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('会话A')));

  // /help 短命令 = 机器人帮助
  mockBot.pushPrivate(111, '/help');
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('DSH 远程机器人指令')));

  // 短命令带参数（/setting+idle+10 编码）
  mockBot.pushPrivate(111, '/setting+idle+10');
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('10 分钟')));
});

test('非QQ任务推送：none=不推 / brief=短提醒 / full=全文', async (t) => {
  const { mapper } = setup(t);
  const mockDsh = await makeMockDsh(t, [{ sessionId: 's-1', title: '会话A', running: false }]);
  const mockBot = await makeMockOneBot(t, { allowUsers: [111] });
  const { bridge } = await startBridgeAndWait(t, { mockDsh, mockBot, mapper, config: { notifyMode: 'none' } });
  // 绑定（非 prompter：软件侧任务，无 prompter 记录）
  mapper.set('qq', '111', { sessionId: 's-1', workspaceId: 'ws-1' });

  const runComplete = async () => {
    const before = sendActionsOf(mockBot, 'send_private_msg').length;
    await bridge._onComplete({ sessionId: 's-1', title: '会话A' });
    await new Promise((r) => setTimeout(r, 100));
    return sendActionsOf(mockBot, 'send_private_msg').slice(before);
  };

  // none：不推送
  let msgs = await runComplete();
  assert.ok(!msgs.some((a) => String(a.params.message).includes('任务完成')), 'none 模式不推送');

  // brief：短固定提醒（无正文）
  bridge.config.notifyMode = 'brief';
  msgs = await runComplete();
  assert.ok(msgs.some((a) => String(a.params.message).includes('任务完成「会话A」')), 'brief 模式发完成提醒');
  const briefText = msgs.map((a) => String(a.params.message)).join('\n');
  assert.ok(!briefText.includes('这是第一段回复'), 'brief 模式不带正文');

  // full：全文
  bridge.config.notifyMode = 'full';
  msgs = await runComplete();
  const fullText = msgs.map((a) => String(a.params.message)).join('\n');
  assert.ok(fullText.includes('任务完成「会话A」') && fullText.includes('这是第一段回复'), 'full 模式发全文');
});

test('/compact 透传 dsh 原生压缩命令并回显结果', async (t) => {
  const { mapper } = setup(t);
  const mockDsh = await makeMockDsh(t, [{ sessionId: 's-1', title: '会话A', running: false }]);
  const mockBot = await makeMockOneBot(t, { allowUsers: [111] });
  const { bridge } = await startBridgeAndWait(t, { mockDsh, mockBot, mapper });
  mapper.set('qq', '111', { sessionId: 's-1', workspaceId: 'ws-1' });

  mockBot.pushPrivate(111, '/compact');
  await waitFor(() => mockBot.sent.some((a) => /🗜️|Compacted|已执行/.test(String(a.params.message))));
  const sent = sendActionsOf(mockBot, 'send_private_msg').map((a) => String(a.params.message)).join('\n');
  // 断言 prompt 里发的是原生 /compact 且结果被回显
  assert.strictEqual(mockDsh.state.prompts.at(-1).content[0].text, '/compact');
  assert.ok(sent.length > 0);
});

test('工具结果独立气泡：🔧 一行实时发送，正文完成时单独一条', async (t) => {
  const { mapper } = setup(t);
  const mockDsh = await makeMockDsh(t, [{ sessionId: 's-1', title: '会话A', running: false }]);
  const mockBot = await makeMockOneBot(t, { allowUsers: [111] });
  const { bridge } = await startBridgeAndWait(t, { mockDsh, mockBot, mapper });
  mapper.set('qq', '111', { sessionId: 's-1', workspaceId: 'ws-1' });

  // 用户发消息 → prompter 建立
  mockBot.pushPrivate(111, '帮我看看');
  await waitFor(() => mockBot.sent.some((a) => /已提交|已加入队列/.test(String(a.params.message))));

  // 建立 busy 基线（轮询观察到 running=true）
  mockDsh.state.sessions[0].running = true;
  await waitFor(() => bridge.busy.get('s-1') === true);

  // 模拟 mux 流：tool/call → tool/result（成功 → 独立气泡一行，实时发）
  mockDsh.pushMux({ type: 'session/event', sessionId: 's-1', event: { type: 'tool/call', data: { callId: 'call-1', name: 'pwsh', arguments: '{}' } } });
  mockDsh.pushMux({
    type: 'session/event',
    sessionId: 's-1',
    event: {
      type: 'tool/result',
      seq: 5,
      data: {
        message: {
          source: { callId: 'call-1' },
          content: [{ type: 'tool-result', isError: false, content: [{ type: 'text', text: '命令输出内容 abc' }] }],
        },
      },
    },
  });
  // 工具行应实时单独发（一行，不含正文、不含原始输出）
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('🔧 `pwsh` 完成')));
  const toolMsg = sendActionsOf(mockBot, 'send_private_msg').map((a) => String(a.params.message)).find((m) => m.includes('🔧'));
  assert.ok(!toolMsg.includes('命令输出内容 abc'), '工具气泡不带原始输出（避免刷屏）');

  // 完成 → 正文独立一条
  mockDsh.state.sessions[0].running = false;
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('任务完成')));
  const done = sendActionsOf(mockBot, 'send_private_msg').map((a) => String(a.params.message)).join('\n');
  assert.ok(done.includes('这是回复内容'), '完成消息应含正文');
});

test('工具结果：错误结果优先展示（isError / error 字段）', async (t) => {
  const { mapper } = setup(t);
  const mockDsh = await makeMockDsh(t, [{ sessionId: 's-1', title: '会话A', running: false }]);
  const mockBot = await makeMockOneBot(t, { allowUsers: [111] });
  const { bridge } = await startBridgeAndWait(t, { mockDsh, mockBot, mapper });
  mapper.set('qq', '111', { sessionId: 's-1', workspaceId: 'ws-1' });

  mockBot.pushPrivate(111, '执行下');
  await waitFor(() => mockBot.sent.some((a) => /已提交|已加入队列/.test(String(a.params.message))));

  mockDsh.pushMux({ type: 'session/event', sessionId: 's-1', event: { type: 'tool/call', data: { callId: 'call-2', name: 'read' } } });
  mockDsh.pushMux({
    type: 'session/event',
    sessionId: 's-1',
    event: {
      type: 'tool/result',
      data: {
        message: {
          source: { callId: 'call-2' },
          content: [{ type: 'tool-result', isError: true, content: [{ type: 'text', text: 'ENOENT no such file' }] }],
        },
      },
    },
  });
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('❌ 工具 `read` 失败')));
});

test('远程审批：approval/requested → QQ 按钮询问 → /approve 应答 allowed-once', async (t) => {
  const { mapper } = setup(t);
  const mockDsh = await makeMockDsh(t, [{ sessionId: 's-1', title: '会话A', running: false }]);
  const mockBot = await makeMockOneBot(t, { allowUsers: [111] });
  const { bridge } = await startBridgeAndWait(t, { mockDsh, mockBot, mapper });
  mapper.set('qq', '111', { sessionId: 's-1', workspaceId: 'ws-1' });

  // 用户发消息 → prompter 建立
  mockBot.pushPrivate(111, '帮我执行');
  await waitFor(() => mockBot.sent.some((a) => /已提交|已加入队列/.test(String(a.params.message))));

  // dsh 推 approval/requested（rpcId 在帧外层）
  mockDsh.pushMux({ type: 'approval/requested', sessionId: 's-1', approvalId: 'appr-1', toolName: 'pwsh', reason: '需要执行 powershell 命令' }, 'rpc-appr-1');
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('请求执行权限')));

  // 用户点「允许一次」→ QQ 发 /approve appr-1
  mockBot.pushPrivate(111, '/approve appr-1');
  await waitFor(() => mockDsh.state.responses.length === 1);
  const resp = mockDsh.state.responses[0];
  assert.strictEqual(resp.type, 'client-response');
  assert.strictEqual(resp.rpcId, 'rpc-appr-1', '应答应 echo 服务器帧 rpcId');
  assert.deepStrictEqual(resp.result.value, { sessionId: 's-1', approvalId: 'appr-1', outcome: 'allowed-once' });
  assert.ok(mockBot.sent.some((a) => String(a.params.message).includes('✅ 已允许')), '应回显已允许');

  // approval/resolved 帧 → 状态清理 + 通知
  mockDsh.pushMux({ type: 'approval/resolved', sessionId: 's-1', approvalId: 'appr-1', outcome: 'allowed-once' });
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(bridge.pendingApprovals.has('appr-1'), false, 'resolved 后清理 pending');
});

test('远程审批：/reject 应答 rejected；未知 id 提示', async (t) => {
  const { mapper } = setup(t);
  const mockDsh = await makeMockDsh(t, [{ sessionId: 's-1', title: '会话A', running: false }]);
  const mockBot = await makeMockOneBot(t, { allowUsers: [111] });
  const { bridge } = await startBridgeAndWait(t, { mockDsh, mockBot, mapper });
  mapper.set('qq', '111', { sessionId: 's-1', workspaceId: 'ws-1' });

  mockBot.pushPrivate(111, '跑一下');
  await waitFor(() => mockBot.sent.some((a) => /已提交|已加入队列/.test(String(a.params.message))));

  // 未知 id：直接提示不存在
  mockBot.pushPrivate(111, '/reject bogus-id');
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('不存在')));

  // 真实审批 → 拒绝
  mockDsh.pushMux({ type: 'approval/requested', sessionId: 's-1', approvalId: 'appr-2', toolName: 'read', reason: '读取文件' }, 'rpc-appr-2');
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('请求执行权限')));
  mockBot.pushPrivate(111, '/reject appr-2');
  await waitFor(() => mockDsh.state.responses.length === 1);
  assert.strictEqual(mockDsh.state.responses[0].result.value.outcome, 'rejected');
});

test('远程提问：question/requested → QQ 按钮 → /answer 批量提交', async (t) => {
  const { mapper } = setup(t);
  const mockDsh = await makeMockDsh(t, [{ sessionId: 's-1', title: '会话A', running: false }]);
  const mockBot = await makeMockOneBot(t, { allowUsers: [111] });
  const { bridge } = await startBridgeAndWait(t, { mockDsh, mockBot, mapper });
  mapper.set('qq', '111', { sessionId: 's-1', workspaceId: 'ws-1' });

  mockBot.pushPrivate(111, '问问你');
  await waitFor(() => mockBot.sent.some((a) => /已提交|已加入队列/.test(String(a.params.message))));

  mockDsh.pushMux(
    { type: 'question/requested', sessionId: 's-1', questions: [{ id: 'q-1', question: '选哪个方案？', options: [{ label: '方案A' }, { label: '方案B' }] }] },
    'rpc-q-1'
  );
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('dsh 提问')));

  // 点「方案B」→ /answer rpc-q-1 0 1
  mockBot.pushPrivate(111, '/answer rpc-q-1 0 1');
  await waitFor(() => mockDsh.state.responses.length === 1);
  const resp = mockDsh.state.responses[0];
  assert.strictEqual(resp.rpcId, 'rpc-q-1');
  assert.deepStrictEqual(resp.result.value.answer, { answers: [{ id: 'q-1', selected: ['方案B'] }] });
});

test('远程提问多选：/mtoggle 切换选中 → /mdone 提交 selected[]', async (t) => {
  const { mapper } = setup(t);
  const mockDsh = await makeMockDsh(t, [{ sessionId: 's-1', title: '会话A', running: false }]);
  const mockBot = await makeMockOneBot(t, { allowUsers: [111] });
  const { bridge } = await startBridgeAndWait(t, { mockDsh, mockBot, mapper });
  mapper.set('qq', '111', { sessionId: 's-1', workspaceId: 'ws-1' });

  mockBot.pushPrivate(111, '选几个');
  await waitFor(() => mockBot.sent.some((a) => /已提交|已加入队列/.test(String(a.params.message))));

  mockDsh.pushMux(
    { type: 'question/requested', sessionId: 's-1', questions: [{ id: 'q-m', question: '多选：喜欢哪些？', multiSelect: true, options: [{ label: '红' }, { label: '蓝' }, { label: '绿' }] }] },
    'rpc-q-m'
  );
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('多选')));

  // 点「蓝」「绿」两个开关（先选蓝，再选绿；toggle 已选中的会取消）
  mockBot.pushPrivate(111, '/mtoggle rpc-q-m 0 1');
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('✅ 已选')));
  mockBot.pushPrivate(111, '/mtoggle rpc-q-m 0 2');
  await waitFor(() => mockBot.sent.some((a) => String(a.params.message).includes('蓝、绿')));

  // 提交
  mockBot.pushPrivate(111, '/mdone rpc-q-m 0');
  await waitFor(() => mockDsh.state.responses.length === 1);
  const resp = mockDsh.state.responses[0];
  assert.strictEqual(resp.rpcId, 'rpc-q-m');
  assert.deepStrictEqual(resp.result.value.answer, { answers: [{ id: 'q-m', selected: ['蓝', '绿'] }] });
});
