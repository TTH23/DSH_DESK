'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const { DshApiClient, DshApiError } = require('../src/im/dsh-api');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// 服务端→客户端文本帧（支持 126/65536 扩展长度；否则 undici 收到畸形帧会 1006 断开）
function jsonFrame(obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  if (payload.length < 65536) {
    const head = Buffer.from([0x81, 126, (payload.length >> 8) & 0xff, payload.length & 0xff]);
    return Buffer.concat([head, payload]);
  }
  const head = Buffer.alloc(10);
  head[0] = 0x81;
  head[1] = 127;
  head.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([head, payload]);
}

/** 模拟 dsh：HTTP /api + WS /api/events.mux */
async function makeMockDsh(t, { delayMs = 0 } = {}) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ url: req.url, body: JSON.parse(body || '{}') });
      const envelope = seen[seen.length - 1].body;
      const send = (result) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result }));
      };
      const finish = () => {
        const method = envelope.method || req.url.split('/').pop();
        switch (method) {
          case 'session.list':
            return send({
              ok: true,
              value: { items: [{ sessionId: 'session-1', title: '会话A', running: false, updatedAt: 1 }] },
            });
          case 'session.history':
            return send({
              ok: true,
              value: {
                events: [
                  { event: { seq: 1, type: 'user/message', message: { role: 'user', content: [{ type: 'text', text: '你好' }] } } },
                  { event: { seq: 2, type: 'assistant/message', message: { role: 'assistant', content: [{ type: 'text', text: '你好呀' }] } } },
                ],
                hasMore: false,
              },
            });
          case 'session.prompt': {
            const text = envelope.payload && envelope.payload.content && envelope.payload.content[0] && envelope.payload.content[0].text;
            if (typeof text === 'string' && text.startsWith('/')) {
              return send({ ok: true, value: { accepted: true, command: { kind: 'success', text: '已执行命令：' + text } } });
            }
            return send({ ok: true, value: { accepted: true } });
          }
          case 'session.cancel':
            return send({ ok: true, value: { accepted: true } });
          case 'session.models':
            return send({
              ok: true,
              value: { current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' }, routable: true, groups: [], failures: [] },
            });
          case 'sleep':
            return setTimeout(() => send({ ok: true, value: { slept: true } }), 500);
          default:
            return send({ ok: false, error: { code: 'method-not-found', message: '未注册的方法：' + method } });
        }
      };
      if (delayMs) setTimeout(finish, delayMs);
      else finish();
    });
  });
  srv.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'] || '';
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
    );
    socket.write(jsonFrame({ type: 'server-request', rpcId: 'r-sub', method: 'events.mux', payload: { type: 'session/subscribed', sessionId: 'session-1', lastSeq: 2 } }));
    socket.write(jsonFrame({ type: 'server-request', rpcId: 'r-ev', method: 'events.mux', payload: { type: 'session/event', sessionId: 'session-1', event: { seq: 3, type: 'assistant/message', message: { role: 'assistant', content: [{ type: 'text', text: '流式回复' }] } } } }));
    socket.write(jsonFrame({ type: 'server-request', rpcId: 'r-q', method: 'events.mux', payload: { type: 'session/queue', sessionId: 'session-1', items: [] } }));
    setTimeout(() => socket.destroy(), 2000);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  t.after(() => srv.close());
  return { port, seen };
}

test('call：成功返回 value；信封格式正确', async (t) => {
  const mock = await makeMockDsh(t);
  const api = new DshApiClient({ port: mock.port });
  const v = await api.listSessions();
  assert.strictEqual(v.items[0].sessionId, 'session-1');
  const req = mock.seen[0];
  assert.strictEqual(req.body.type, 'client-request');
  assert.strictEqual(req.body.method, 'session.list');
  assert.ok(req.body.rpcId);
});

test('call：RPC 错误映射为 DshApiError（带 code）', async (t) => {
  const mock = await makeMockDsh(t);
  const api = new DshApiClient({ port: mock.port });
  await assert.rejects(() => api.call('session.unknown', {}), (err) => {
    assert.ok(err instanceof DshApiError);
    assert.strictEqual(err.code, 'method-not-found');
    return true;
  });
});

test('call：连接失败 → DshApiError transport', async () => {
  const api = new DshApiClient({ port: 1 }); // 无监听
  await assert.rejects(() => api.listSessions(), (err) => {
    assert.ok(err instanceof DshApiError);
    assert.strictEqual(err.code, 'transport');
    return true;
  });
});

test('call：超时 → DshApiError timeout', async (t) => {
  const mock = await makeMockDsh(t, { delayMs: 0 });
  const api = new DshApiClient({ port: mock.port });
  await assert.rejects(() => api.call('sleep', {}, { timeoutMs: 100 }), (err) => {
    assert.ok(err instanceof DshApiError);
    assert.strictEqual(err.code, 'timeout');
    return true;
  });
});

test('prompt：/ 开头返回 command 槽位；普通文本 accepted', async (t) => {
  const mock = await makeMockDsh(t);
  const api = new DshApiClient({ port: mock.port });
  const cmd = await api.prompt('session-1', '/plan 做一件事');
  assert.strictEqual(cmd.command.kind, 'success');
  assert.ok(cmd.command.text.includes('/plan'));
  const normal = await api.prompt('session-1', '你好');
  assert.strictEqual(normal.accepted, true);
});

test('事件流：收到 session/subscribed、session/event、session/queue 帧', async (t) => {
  const mock = await makeMockDsh(t);
  const api = new DshApiClient({ port: mock.port });
  t.after(() => api.stopEvents());
  const got = [];
  api.on('frame', (f) => got.push(f.payload && f.payload.type));
  api.on('session/event', (p) => got.push('E:' + p.event.type));
  await new Promise((resolve) => {
    api.once('events-open', () => setTimeout(resolve, 300));
    api.startEvents();
  });
  assert.ok(got.includes('session/subscribed'));
  assert.ok(got.includes('session/queue'));
  assert.ok(got.includes('E:assistant/message'));
});

test('事件流：stopEvents 后不再重连', async (t) => {
  const mock = await makeMockDsh(t);
  const api = new DshApiClient({ port: mock.port });
  await new Promise((resolve) => {
    api.once('events-open', resolve);
    api.startEvents();
  });
  api.stopEvents();
  assert.strictEqual(api.isEventsOpen(), false);
  assert.strictEqual(api._retryTimer, null);
});
