'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  MODE_PURE,
  MODE_ALL,
  textOfMessage,
  thinkTextOfMessage,
  truncate,
  splitLong,
  renderEvent,
  renderHistory,
} = require('../src/im/render');
const { SessionMapper } = require('../src/im/session-mapper');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'im-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const USER_EVENT = { type: 'user/message', message: { role: 'user', content: [{ type: 'text', text: '你好' }] } };
const ASSIST_PURE = {
  type: 'assistant/message',
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: '回复内容' }, { type: 'think', text: '思考过程' }],
  },
};
const TOOL_EVENT = { type: 'tool/call', toolName: 'bash', tool: 'bash' };

test('textOfMessage 只取 text 类型', () => {
  assert.strictEqual(textOfMessage(ASSIST_PURE.message), '回复内容');
  assert.strictEqual(thinkTextOfMessage(ASSIST_PURE.message), '思考过程');
});

test('纯对话模式：不含工具/思考', () => {
  assert.strictEqual(renderEvent(USER_EVENT, { mode: MODE_PURE }), '👤 你好');
  assert.strictEqual(renderEvent(ASSIST_PURE, { mode: MODE_PURE }), '🤖 回复内容');
  assert.strictEqual(renderEvent(TOOL_EVENT, { mode: MODE_PURE }), null);
});

test('全部模式：含工具调用与思考', () => {
  assert.strictEqual(renderEvent(ASSIST_PURE, { mode: MODE_ALL }), '🤖 回复内容\n💭 思考过程');
  assert.strictEqual(renderEvent(TOOL_EVENT, { mode: MODE_ALL }), '🔧 调用工具：bash');
});

test('truncate / splitLong', () => {
  assert.strictEqual(truncate('abcdef', 4), 'abc…');
  const long = 'x'.repeat(10000);
  const chunks = splitLong(long, 4000);
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((c) => c.length <= 4000));
  assert.strictEqual(chunks.join(''), long);
  assert.deepStrictEqual(splitLong('短文本'), ['短文本']);
});

test('renderHistory：过滤 + 截取最近 N 条', () => {
  const events = [
    { event: USER_EVENT },
    { event: ASSIST_PURE },
    { event: TOOL_EVENT },
  ];
  const pure = renderHistory(events, { mode: MODE_PURE, limit: 2 });
  assert.deepStrictEqual(pure, ['👤 你好', '🤖 回复内容']);
  const all = renderHistory(events, { mode: MODE_ALL, limit: 10 });
  assert.ok(all.includes('🔧 调用工具：bash'));
});

test('SessionMapper：持久化增删改查', () => {
  const dir = tmpDir({ after: () => {} });
  const m = new SessionMapper(dir);
  m.set('qq', '10001', { sessionId: 'session-1', mode: 'all' });
  m.set('qq', 'group:888', { workspaceId: 'ws-9' });

  // 重载持久化
  const m2 = new SessionMapper(dir);
  assert.deepStrictEqual(m2.get('qq', '10001'), { sessionId: 'session-1', mode: 'all' });
  assert.strictEqual(m2.get('qq', 'group:888').workspaceId, 'ws-9');
  assert.strictEqual(m2.get('qq', 'nobody'), null);

  // 修改与清除
  m2.set('qq', '10001', { mode: 'pure' });
  assert.strictEqual(m2.get('qq', '10001').mode, 'pure');
  m2.set('qq', '10001', { sessionId: null });
  assert.strictEqual(m2.get('qq', '10001').sessionId, undefined);
  m2.clear('qq', '10001');
  assert.strictEqual(m2.get('qq', '10001'), null);
  assert.strictEqual(new SessionMapper(dir).get('qq', 'group:888').workspaceId, 'ws-9');
});

test('SessionMapper：非法 mode 被忽略', () => {
  const dir = tmpDir({ after: () => {} });
  const m = new SessionMapper(dir);
  m.set('qq', '1', { mode: 'bad' });
  assert.strictEqual(m.get('qq', '1').mode, undefined);
});
