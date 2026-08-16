'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createTaskNotifier, SESSION_ID_BODY_RE } = require('../src/task-notify');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

test('同一任务多窗口事件（含 session ID 垃圾）→ 合并成一条且内容最全', async () => {
  const sent = [];
  const send = createTaskNotifier((title, body) => sent.push({ title, body }), { windowMs: 30 });

  // 附加窗口先发：无会话名 + session ID 垃圾 body
  send('', 'session-ab100ca2-a87a-45ee-942d-06108e09bd90');
  // 主窗口后发：会话名 + 真实回复
  send('DeepSeek Harness托盘启动程序', '修好了，是连接失败');
  await sleep(60);

  assert.strictEqual(sent.length, 1, '多窗口同一任务应只发一条');
  assert.ok(sent[0].title.startsWith('任务完成「') && !sent[0].title.includes('session-'), '标题应带会话名而非 session ID');
  assert.ok(!SESSION_ID_BODY_RE.test(sent[0].body), 'body 不应是 session ID');
  assert.strictEqual(sent[0].body, '修好了，是连接失败');
});

test('主窗口先发正确 → 附加窗口后发垃圾不覆盖', async () => {
  const sent = [];
  const send = createTaskNotifier((title, body) => sent.push({ title, body }), { windowMs: 30 });

  send('DeepSeek Harness托盘启动程序', '改好了，43/43 测试通过');
  send('', 'session-ab100ca2-a87a-45ee-942d-06108e09bd90');
  await sleep(60);

  assert.strictEqual(sent.length, 1);
  assert.ok(sent[0].title.startsWith('任务完成「') && !sent[0].title.includes('session-'), '标题应带会话名');
  assert.strictEqual(sent[0].body, '改好了，43/43 测试通过');
});

test('窗口内连续事件持续合并（3 个窗口事件）', async () => {
  const sent = [];
  const send = createTaskNotifier((title, body) => sent.push({ title, body }), { windowMs: 30 });

  send('', 'session-11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  send('会话甲', '');
  send('会话甲', '最终回复内容');
  await sleep(60);

  assert.strictEqual(sent.length, 1);
  assert.ok(sent[0].title.includes('会话甲'));
  assert.strictEqual(sent[0].body, '最终回复内容');
});

test('不同任务（间隔超过窗口）→ 各自发一条', async () => {
  const sent = [];
  const send = createTaskNotifier((title, body) => sent.push({ title, body }), { windowMs: 30 });

  send('会话A', '第一个任务回复');
  await sleep(60);
  send('会话B', '第二个任务回复');
  await sleep(60);

  assert.strictEqual(sent.length, 2);
  assert.ok(sent[0].title.includes('会话A'));
  assert.ok(sent[1].title.includes('会话B'));
});

test('无会话名且无回复 → 默认文案兜底', async () => {
  const sent = [];
  const send = createTaskNotifier((title, body) => sent.push({ title, body }), { windowMs: 30 });

  send('', '');
  await sleep(60);

  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].title, '任务完成');
  assert.strictEqual(sent[0].body, 'DeepSeek Harness 已完成任务');
});
