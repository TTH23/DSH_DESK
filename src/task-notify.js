'use strict';
// 任务完成通知去重合并（独立模块便于测试）。
// 背景：多窗口（主窗口 + 附加窗口）的 preload 各自检测同一任务完成并发 IPC，
// 且各窗口解析出的会话名可能不同（有的拿不到 crumb → 空名 + session ID 垃圾 body）。
// 方案：按时间窗口全局合并——窗口内所有 task-complete 事件合并成一条通知，
// 内容取信息最全的一次（有会话名优先、有回复优先；body 为 session ID 形态视为垃圾不覆盖）。
// 用法：
//   const { createTaskNotifier } = require('./task-notify');
//   const send = createTaskNotifier((title, body) => notifyIf('task', title, body));
//   send(session, reply);

const SESSION_ID_BODY_RE = /^session-[0-9a-f-]{8,}/i;

function truncateText(s, max) {
  s = String(s == null ? '' : s);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/**
 * @param {(title: string, body: string) => void} emit 真正发通知的回调
 * @param {object} [opts] { windowMs, now }
 */
function createTaskNotifier(emit, opts = {}) {
  // 窗口 3s：preload 轮询 1.2s、im-bridge 轮询 2s，两检测源相位差最大约 2s，
  // 窗口需覆盖该差，否则同一任务仍会拆成两条。
  const windowMs = opts.windowMs || 3000;
  const pending = new Map(); // 'pending' → { title, body, timer }
  return function sendTaskNotification(session, reply) {
    const title = session ? `任务完成「${truncateText(session, 20)}」` : '任务完成';
    const body = truncateText(reply || 'DeepSeek Harness 已完成任务', 40);
    const prev = pending.get('pending');
    const schedule = (entry) => {
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        pending.delete('pending');
        emit(entry.title, entry.body);
      }, windowMs);
      if (entry.timer.unref) entry.timer.unref();
    };
    if (prev) {
      // 合并优先级：新通知有会话名且旧标题无「」→ 替换标题；
      // body：新 body 非默认文本、非 session ID 形态，且旧 body 是默认或 session ID → 替换
      if (session && !prev.title.includes('「')) prev.title = title;
      if (
        reply &&
        body !== 'DeepSeek Harness 已完成任务' &&
        !SESSION_ID_BODY_RE.test(body) &&
        (prev.body === 'DeepSeek Harness 已完成任务' || SESSION_ID_BODY_RE.test(prev.body))
      ) {
        prev.body = body;
      }
      schedule(prev);
      return;
    }
    const entry = { title, body, timer: null };
    schedule(entry);
    pending.set('pending', entry);
  };
}

module.exports = { createTaskNotifier, SESSION_ID_BODY_RE };
