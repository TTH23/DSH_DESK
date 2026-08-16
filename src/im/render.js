'use strict';
// 会话事件 → IM 文本渲染（纯对话 / 全部两种模式）与分段截断
// 事件词汇与 session.jsonl.zstd 一致：user/message、assistant/message、tool/call、tool/result、command/run 等。
const MODE_PURE = 'pure'; // 纯对话：仅用户/助手文本
const MODE_ALL = 'all'; // 全部：含工具调用/思考等
const DEFAULT_MAX_LEN = 4000; // QQ 单条消息安全上限（约 4500）

function textOfMessage(message) {
  const parts = (message && message.content) || [];
  return parts
    .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('')
    .trim();
}

function thinkTextOfMessage(message) {
  const parts = (message && message.content) || [];
  return parts
    .filter((p) => p && p.type === 'think' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n')
    .trim();
}

// 从会话事件里取 message（兼容两种形状）：
//   history/mux 事件体：{ type, seq, time, data: { message, usage } }
//   surface 事件：{ type, message }
function messageOf(event) {
  if (!event || typeof event !== 'object') return null;
  if (event.message && (event.message.content || event.message.role)) return event.message;
  if (event.data && typeof event.data === 'object' && event.data.message) return event.data.message;
  return null;
}

function truncate(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** 按 QQ 单条上限分段（每段 ≤ maxLen，不切词） */
function splitLong(text, maxLen = DEFAULT_MAX_LEN) {
  const s = String(text == null ? '' : text);
  if (!s) return [];
  if (s.length <= maxLen) return [s];
  const out = [];
  let rest = s;
  while (rest.length > maxLen) {
    let cut = rest.slice(0, maxLen);
    // 尽量在换行处断开
    const nl = cut.lastIndexOf('\n');
    const i = nl > maxLen * 0.5 ? nl : maxLen;
    out.push(cut.slice(0, i));
    rest = rest.slice(i);
  }
  if (rest) out.push(rest);
  return out;
}

/** 单条会话事件 → IM 文本（不适用当前模式/无文本时返回 null） */
function renderEvent(event, { mode = MODE_PURE } = {}) {
  if (!event || typeof event !== 'object') return null;
  const type = event.type;
  const message = messageOf(event);
  if (type === 'user/message') {
    const t = textOfMessage(message);
    return t ? `👤 ${t}` : null;
  }
  if (type === 'assistant/message') {
    const t = textOfMessage(message);
    if (!t) return null;
    if (mode === MODE_ALL) {
      const th = thinkTextOfMessage(message);
      return th ? `🤖 ${t}\n💭 ${th}` : `🤖 ${t}`;
    }
    return `🤖 ${t}`;
  }
  if (mode !== MODE_ALL) return null;
  if (type === 'tool/call') {
    const name = event.toolName || event.tool || 'tool';
    return `🔧 调用工具：${name}`;
  }
  if (type === 'tool/result') {
    return '📦 工具结果已返回';
  }
  if (type === 'command/run' || type === 'command/done') {
    return `⚙️ ${truncate((event.command && event.command.text) || event.type, 120)}`;
  }
  return null;
}

/**
 * 渲染历史/事件列表（entry 可为 {event, view} 或裸 event）。
 * 返回按时间顺序、截断到 limit 条的文本数组。
 */
function renderHistory(events, { mode = MODE_PURE, limit = 10 } = {}) {
  const out = [];
  const list = Array.isArray(events) ? events : [];
  for (const entry of list) {
    const ev = entry && entry.event ? entry.event : entry;
    const line = renderEvent(ev, { mode });
    if (line) out.push(line);
  }
  return out.slice(-Math.max(1, limit));
}

module.exports = {
  MODE_PURE,
  MODE_ALL,
  DEFAULT_MAX_LEN,
  textOfMessage,
  thinkTextOfMessage,
  truncate,
  splitLong,
  renderEvent,
  renderHistory,
};
