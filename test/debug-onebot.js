'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const { OneBotAdapter } = require('../src/im/adapters/onebot');
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsFrame(obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

(async () => {
  const sockets = new Set();
  const srv = http.createServer((req, res) => { res.writeHead(200); res.end('ok'); });
  srv.on('upgrade', (req, socket) => {
    console.log('[mock] onebot upgrade, key=', req.headers['sec-websocket-key']);
    const key = req.headers['sec-websocket-key'] || '';
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    sockets.add(socket);
    socket.on('data', (c) => console.log('[mock] client bytes:', c.toString('latin1').slice(0, 120)));
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;

  const adapter = new OneBotAdapter({ wsUrl: `ws://127.0.0.1:${port}`, allowUsers: [111] });
  adapter.on('connected', () => console.log('[adapter] connected'));
  adapter.on('disconnected', () => console.log('[adapter] disconnected'));
  adapter.on('message', (m) => console.log('[adapter] message:', JSON.stringify(m)));
  adapter.on('error', (e) => console.log('[adapter] error:', e && e.message));
  adapter.start();

  await new Promise((r) => setTimeout(r, 500));
  console.log('[adapter] connected flag:', adapter.connected, 'botUin:', adapter.botUin);
  for (const s of sockets) {
    s.write(wsFrame({ post_type: 'message', message_type: 'private', user_id: 111, message: '你好', raw_message: '你好' }));
  }
  await new Promise((r) => setTimeout(r, 500));
  console.log('[adapter] send 测试');
  adapter.send({ type: 'private', id: 111 }, '回复内容');
  await new Promise((r) => setTimeout(r, 500));
  adapter.stop();
  srv.close();
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
