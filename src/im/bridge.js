'use strict';
// IM 桥接核心：适配器消息 → 命令分发（普通文本提示词 / /斜杠命令透传 / /bot 控制）→ dsh-api → 回写 IM；
// 订阅 mux 事件收集回复，轮询 running 检测任务完成并推送。
const { EventEmitter } = require('node:events');
const { MODE_PURE, MODE_ALL, renderHistory, truncate, textOfMessage, thinkTextOfMessage } = require('./render');
const { WELCOME_TEXT, UNPROCESSABLE_TEXT, HELP_TEXT } = require('./help');
const { costOfProjection } = require('../usage');

const POLL_INTERVAL_MS = 2000;

function chatIdOf(chat) {
  return chat.type === 'group' ? `group:${chat.id}` : String(chat.id);
}

function chatFromKey(chatId) {
  // 群 key 前缀 'group:'；id 保持原样（OneBot 数字 or 官方 openid 字符串）
  if (chatId.startsWith('group:')) return { type: 'group', id: chatId.slice(6) };
  return { type: 'private', id: chatId };
}

function sameChat(a, b) {
  // id 归一化为字符串比较（OneBot 数字 user_id vs chatFromKey 字符串）
  return a && b && a.type === b.type && String(a.id) === String(b.id);
}

/** 解析 /bot 命令：兼容 `/bot xxx` 与 `/bot+xxx`（QQ 菜单/面板点击填入时空格被 URL 编码为 +） */
function normalizeBotCmd(text) {
  let s = String(text || '').trim();
  if (!/^\/bot/i.test(s)) return null;
  s = s.replace(/^\/bot/i, '').replace(/\+/g, ' ').trim(); // 前缀后的 + 全部还原为空格
  return s;
}

/** 短命令白名单：/ws /ses /setting /status /usage /history /model /stop /queue /help
 * 直接作为机器人命令（去掉 /bot 前缀）；其余 / 开头仍透传 dsh */
const SHORT_CMDS = new Set(['ws', 'ses', 'setting', 'status', 'usage', 'history', 'model', 'stop', 'queue', 'help']);
function SHORT_CMD(text) {
  const s = String(text || '').trim();
  const m = /^\/([a-z]+)(?:[+\s](.*))?$/i.exec(s);
  if (!m) return null;
  const name = m[1].toLowerCase();
  if (!SHORT_CMDS.has(name)) return null;
  const rest = (m[2] || '').replace(/\+/g, ' ').trim();
  return rest ? `${name} ${rest}` : name;
}

/** 按标题/id/序号匹配（精确优先，其次 ID 前缀，再标题包含；纯数字 = 列表序号 1 起） */
function pick(list, query) {
  const q = String(query).trim();
  const exact = (list || []).find((it) => it.title === q || it.sessionId === q || it.workspaceId === q || it.id === q || it.name === q);
  if (exact) return exact;
  // 纯数字 → 列表序号（1 起）
  if (/^\d+$/.test(q)) {
    const idx = Number(q) - 1;
    const it = (list || [])[idx];
    if (it) return it;
  }
  // ID 前缀匹配：会话无标题时发 /bot ses <ID前缀> 即可选中
  const byIdPrefix = (list || []).find(
    (it) => (it.sessionId && it.sessionId.startsWith(q)) || (it.workspaceId && it.workspaceId.startsWith(q)) || (it.id && it.id.startsWith(q))
  );
  if (byIdPrefix) return byIdPrefix;
  return (list || []).find((it) => (it.title || '').includes(q) || (it.name || '').includes(q));
}

function renderAccumulated(acc, mode) {
  if (!acc) return '';
  const parts = [];
  if (acc.text) parts.push(acc.text);
  if (mode === MODE_ALL && acc.think) parts.push('💭 ' + acc.think);
  return parts.join('\n');
}

/** 会话标题：顶层 title 或 projections.values.title（session.list 顶层无 title 字段） */
function sessionTitleOf(s) {
  if (!s) return '';
  if (s.title) return s.title;
  if (s.projections && s.projections.values && s.projections.values.title) return s.projections.values.title;
  return '';
}

/** 构造 QQ keyboard：每行最多 5 个按钮；makeCmd 返回 { label, cmd }，cmd 为点击后当作消息处理的命令文本 */
function keyboardOf(items, makeCmd, { perRow = 5 } = {}) {
  if (!items || !items.length) return null;
  const rows = [];
  for (let i = 0; i < items.length; i += perRow) {
    rows.push({ buttons: items.slice(i, i + perRow).map((it, j) => makeCmd(it, i + j)) });
  }
  return { rows };
}

/** 按钮文字：官方限制 ≤10 字符，超长省略（保留开头，去掉省略号凑 10 字符内） */
function shortLabel(s) {
  const str = String(s == null ? '' : s);
  if (str.length <= 10) return str;
  return str.slice(0, 9) + '…';
}

/** 会话展示：标题 + 运行标记（归档会话已在列表阶段排除，不再用 blank 区分）；idx 从 0 起，显示 1 起 */
function sessionLine(s, idx) {
  const title = sessionTitleOf(s) || '(未命名)';
  // ID 只显示前 8 位（完整 ID 太长，选择用编号或按钮即可）
  const shortId = (s.sessionId || '').slice(0, 8);
  return `${idx + 1}. ${title}${s.running ? '（运行中）' : ''}${shortId ? ` [${shortId}]` : ''}`;
}

class ImBridge extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('./dsh-api').DshApiClient} opts.dsh
   * @param {import('./session-mapper').SessionMapper} opts.mapper
   * @param {object} [opts.config] { passcode, defaultMode }
   * @param {() => object|null} [opts.usageFn] UsageTracker.snapshot
   * @param {(title: string, body: string) => void} [opts.notify]
   * @param {(title: string, body: string) => void} [opts.onTaskComplete] 任务完成系统通知（走主进程去重通道）
   */
  constructor(opts = {}) {
    super();
    this.dsh = opts.dsh;
    this.mapper = opts.mapper;
    this.config = opts.config || {};
    this.usageFn = opts.usageFn || (() => null);
    this.notify = opts.notify || (() => {});
    this.onTaskComplete = opts.onTaskComplete || null;
    this.onConfigChange = opts.onConfigChange || null; // 修改全局配置的回调（主进程持久化）
    this.adapters = []; // [{name, adapter}]
    this.running = false;
    this.busy = new Map(); // sessionId → running
    this.replyBuf = new Map(); // sessionId → { text, think }
    this.queueState = new Map(); // sessionId → items
    this.prompter = new Map(); // sessionId → { platform, chat }
    this.unlocked = new Set(); // 已通过口令的 chatKey
    this.lastActive = new Map(); // chatKey → 最后活跃时间戳（闲置自动退出用）
    this._notifyAt = new Map(); // 通知标题 → 最后通知时间（节流：同类错误 30s 内只弹一次）
    this.pollTimer = null;
    this.idleTimer = null;
    this._pollToken = 0;
    this.pollIntervalMs = opts.pollIntervalMs || POLL_INTERVAL_MS;
    this.debug = Boolean(opts.debug);
    this.logFn = opts.log || null;
  }

  _log(...args) {
    if (this.logFn) {
      try {
        this.logFn(args.join(' '));
      } catch {
        /* ignore */
      }
    } else if (this.debug) {
      console.error('[bridge]', ...args);
    }
  }

  /** 节流通知：同标题 30s 内只弹一次（防 500 频控期通知刷屏） */
  _throttledNotify(title, body, windowMs = 30000) {
    const now = Date.now();
    const last = this._notifyAt.get(title) || 0;
    if (now - last < windowMs) return; // 节流期内跳过
    this._notifyAt.set(title, now);
    this.notify(title, body);
  }

  setAdapters(list) {
    this.adapters = list;
  }

  async start() {
    if (this.running) return;
    this._log('bridge.start begin');
    const valid = this.adapters.filter((a) => a.adapter.isAllowlistValid());
    if (!valid.length) throw new Error('未配置有效的机器人白名单（至少一个 QQ 号或群号）');
    this.adapters = valid;
    for (const { adapter } of this.adapters) {
      adapter.on('message', (m) => this.handleMessage(m).catch(() => {}));
      adapter.on('error', (e) => this._throttledNotify('IM 桥接', `适配器错误：${e && e.message}`));
      adapter.start();
    }
    this.dsh.on('frame', (frame) => this._onDshFrame(frame));
    this.dsh.startEvents();
    this._pollToken++;
    this.pollTimer = setInterval(() => this._pollRunning(this._pollToken), this.pollIntervalMs);
    // 闲置自动退出检查（每 30s；配置 idleMinutes>0 才生效）
    this._checkIdle();
    this.idleTimer = setInterval(() => this._checkIdle(), 30000);
    this.running = true;
    this.emit('status-change');
    this._log('bridge.start done');
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this._pollToken++;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    for (const { adapter } of this.adapters) {
      try {
        adapter.stop();
      } catch {
        /* ignore */
      }
    }
    this.dsh.stopEvents();
    this.emit('status-change');
  }

  status() {
    return {
      running: this.running,
      adapters: this.adapters.map(({ name, adapter }) => ({
        name,
        connected: Boolean(adapter.connected),
        botUin: typeof adapter.getBotUin === 'function' ? adapter.getBotUin() : null,
      })),
      boundChannels: Object.keys(this.mapper.all()).length,
      busy: Array.from(this.busy.entries())
        .filter(([, b]) => b)
        .map(([id]) => id),
    };
  }

  _adapterFor(platform) {
    const hit = this.adapters.find(
      (a) => a.adapter.platform === platform || a.name === platform || String(a.adapter.platform || '').startsWith(platform)
    );
    return hit || this.adapters[0] || null; // 兜底：找不到就回退第一个适配器
  }

  _reply(chat, text, adapter, opts) {
    // 兼容两种传入：{name, adapter} 包装对象 或 裸适配器（含 .send）
    let a = adapter;
    if (a && a.send && !a.adapter) a = { adapter: a };
    a = a || this._adapterFor('qq');
    if (!a) {
      this._log('reply dropped (无适配器):', JSON.stringify(chat));
      return;
    }
    this._log('reply →', JSON.stringify(chat), `len=${String(text).length}`, JSON.stringify(String(text).slice(0, 60)));
    a.adapter.send(chat, text, opts);
  }

  // ---------- 消息分发 ----------
  async handleMessage(msg) {
    const { adapter, platform, chat, text } = msg;
    const chatKey = this.mapper.key(platform, chatIdOf(chat));
    this._log('msg:', platform, JSON.stringify(chat), JSON.stringify(text).slice(0, 60));
    this._touchActive(chatKey); // 任意消息都算活跃（刷新闲置计时）

    // 口令（若配置）：首次需发送正确口令解锁（含非文本消息，统一提示口令）
    if (this.config.passcode && !this.unlocked.has(chatKey)) {
      if (text === this.config.passcode) {
        this.unlocked.add(chatKey);
        this._reply(chat, '🔓 已解锁，可以开始对话', adapter);
      } else {
        this._reply(chat, '🔒 请输入访问口令（passcode）', adapter);
      }
      return;
    }

    // 收到但无法处理的消息（图片/语音/表情等非文本）→ 自动说明，不静默丢弃
    if (!text) {
      if (msg.unprocessable) this._reply(chat, UNPROCESSABLE_TEXT, adapter);
      return;
    }

    // 首次使用欢迎：频道从未绑定且从未欢迎过 → 发欢迎并持久化标记（重启不重复）
    const chatId = chatIdOf(chat);
    const binding = this.mapper.get(platform, chatId);
    if (!binding) {
      this.mapper.set(platform, chatId, { welcomed: true });
      // /bot 指令、短命令 与 /help 视为"立即响应"命令：欢迎后继续处理（不拦截）
      const isBotCmd = Boolean(normalizeBotCmd(text)) || SHORT_CMD(text) !== null || text.trim().toLowerCase() === '/help';
      this._reply(chat, WELCOME_TEXT, adapter);
      this._log('welcomed channel', chatId);
      if (!isBotCmd) return; // 普通文本/斜杠命令：先引导，不再追加"未绑定"提示
    }

    // 命令识别：/bot xxx（兼容 /bot+xxx）与 短命令 /xxx 都支持。
    // 短命令白名单：仅这些直接作为机器人命令，其余 / 开头仍透传 dsh（如 /plan、/goal）
    const botArgs = normalizeBotCmd(text);
    if (botArgs !== null) {
      await this._handleControl(adapter, platform, chat, chatId, botArgs);
      return;
    }
    const short = SHORT_CMD(text);
    if (short !== null) {
      await this._handleControl(adapter, platform, chat, chatId, short);
      return;
    }
    // /help → 机器人帮助（与 /bot help 一致；未绑定也能查）
    if (text.trim().toLowerCase() === '/help') {
      this._reply(chat, HELP_TEXT, adapter);
      return;
    }
    // 未绑定 → 自动弹「选择工作区」按钮（降低使用门槛）；已绑会话则正常对话
    const b = this.mapper.get(platform, chatId);
    if (!b || !b.sessionId) {
      if (!b || !b.workspaceId) {
        await this._guideWorkspace(adapter, platform, chat, chatId);
      } else {
        await this._guideSession(adapter, platform, chat, chatId);
      }
      return;
    }
    // / 开头（非机器人命令）→ dsh 原生斜杠命令透传
    await this._prompt(adapter, platform, chat, text, { slash: text.startsWith('/'), msg });
  }

  async _prompt(adapter, platform, chat, text, { slash = false, msg = null } = {}) {
    const chatId = chatIdOf(chat);
    const binding = this.mapper.get(platform, chatId);
    if (!binding || !binding.sessionId) {
      this._reply(chat, '尚未绑定会话：/bot ws 选择工作区，/bot ses 选择会话', adapter);
      return;
    }
    const sessionId = binding.sessionId;
    try {
      const res = await this.dsh.prompt(sessionId, text, { mode: 'queue' });
      if (slash && res && res.command && res.command.text) {
        this._reply(chat, res.command.text, adapter);
        return;
      }
      const busyNow = this.busy.get(sessionId);
      this.prompter.set(sessionId, { platform, chat, msgId: (msg && msg.msgId) || '' });
      this._reply(chat, busyNow ? '⏳ 已加入队列，完成后会通知你' : '✅ 已提交，处理中…', adapter);
    } catch (err) {
      this._log('_prompt error:', err && err.message, err && err.code);
      this._reply(chat, `❌ ${err.message}`, adapter);
    }
  }

  // ---------- 绑定引导：自动弹「选择工作区/会话」按钮 ----------

  /** 引导选择工作区：列工作区 + 按钮（未绑定/绑定被清除时自动调用） */
  async _guideWorkspace(adapter, platform, chat, chatId) {
    let list = [];
    try {
      const ws = await this.dsh.listWorkspaces();
      list = (ws && ws.items) || (Array.isArray(ws) ? ws : []);
    } catch {
      /* dsh 不可用 */
    }
    const supportsBtn = adapter && adapter.supportsKeyboard;
    const hint = supportsBtn ? '👆 先选择工作区（点下方按钮，或回复编号）：\n' : '先选择工作区（回复编号）：\n';
    const lines = list.map((w, i) => `${i + 1}. ${w.title}`);
    const text = lines.length ? hint + lines.join('\n') : '（暂无工作区）';
    this._reply(chat, text, adapter, supportsBtn ? { keyboard: keyboardOf(list, (w) => ({ label: shortLabel(w.title), cmd: `/bot ws ${w.title}` })) } : null);
  }

  /** 引导选择会话：只列当前工作区的会话 + 按钮 */
  async _guideSession(adapter, platform, chat, chatId) {
    const binding = this.mapper.get(platform, chatId);
    let wsItems = [];
    let arch = new Set();
    try {
      const ws = await this.dsh.listWorkspaces();
      wsItems = (ws && ws.items) || (Array.isArray(ws) ? ws : []);
      arch = new Set(ws && Array.isArray(ws.archivedSessionIds) ? ws.archivedSessionIds : []);
    } catch {
      /* dsh 不可用 */
    }
    const boundWs = binding && binding.workspaceId ? wsItems.find((w) => (w.workspaceId || w.id) === binding.workspaceId) : null;
    let all = [];
    try {
      const sessions = await this.dsh.listSessions();
      all = (sessions && sessions.items) || [];
    } catch {
      /* dsh 不可用 */
    }
    const notArchived = (s) => !arch.has(s.sessionId);
    const items = boundWs && Array.isArray(boundWs.sessionIds)
      ? all.filter((s) => boundWs.sessionIds.includes(s.sessionId)).filter(notArchived)
      : all.filter(notArchived);
    const shown = items.slice(0, 20);
    const supportsBtn = adapter && adapter.supportsKeyboard;
    const scope = boundWs ? `当前工作区（${boundWs.title}）` : '全部（未绑定工作区）';
    const hint = supportsBtn ? `👆 选择会话 · ${scope}（点下方按钮，或回复编号）：\n` : `选择会话 · ${scope}（回复编号）：\n`;
    const lines = shown.map(sessionLine);
    const text = lines.length ? hint + lines.join('\n') : `（${scope}下暂无会话）`;
    this._reply(chat, text, adapter, supportsBtn ? { keyboard: keyboardOf(shown, (s) => ({ label: shortLabel(sessionTitleOf(s) || '未命名'), cmd: `/bot ses ${s.sessionId}` })) } : null);
  }

  // ---------- /bot 控制指令 ----------
  async _handleControl(adapter, platform, chat, chatId, args) {
    const binding = this.mapper.get(platform, chatId);
    const parts = args.split(/\s+/);
    const cmd = parts[0];
    const arg = parts.slice(1).join(' ').trim();
    const reply = (t, opts) => this._reply(chat, t, adapter, opts);
    try {
      switch (cmd) {
        case 'help':
          return reply(HELP_TEXT);
        case 'ws': {
          const ws = await this.dsh.listWorkspaces();
          // workspace.list 返回 {items:[...]}（与 session.list 一致），兼容纯数组
          const list = (ws && ws.items) || (Array.isArray(ws) ? ws : []);
          if (arg) {
            const hit = pick(list, arg);
            if (!hit) return reply('❌ 未找到工作区');
            this.mapper.set(platform, chatId, { workspaceId: hit.workspaceId || hit.id, workspaceTitle: hit.title });
            // 选完工作区 → 自动弹「选择会话」按钮（降低使用门槛）
            await this._guideSession(adapter, platform, chat, chatId);
            return;
          }
          // 列表只显示标题 + 编号（不带长 ID，简洁）；按钮 label 用工作区名称
          const lines = list.map((w, i) => `${i + 1}. ${w.title}`);
          const supportsBtn = adapter && adapter.supportsKeyboard;
          const hint = supportsBtn ? '点下方按钮，或回复编号选择工作区：\n' : '回复编号选择工作区：\n';
          const text = lines.length ? hint + lines.join('\n') : '（无工作区）';
          return reply(text, supportsBtn ? { keyboard: keyboardOf(list, (w) => ({ label: shortLabel(w.title), cmd: `/bot ws ${w.title}` })) } : null);
        }
        case 'ses': {
          // 归档依据 = workspace.list 响应的 archivedSessionIds（工作区的 sessionIds 里也含归档会话，
          // 不能用来区分活跃）。已绑定工作区 → 只列该工作区非归档的；未绑定 → 列所有工作区非归档的。
          const ws = await this.dsh.listWorkspaces();
          const wsItems = (ws && ws.items) || (Array.isArray(ws) ? ws : []);
          const boundWs = binding && binding.workspaceId ? wsItems.find((w) => (w.workspaceId || w.id) === binding.workspaceId) : null;
          const archivedIds = new Set(ws && Array.isArray(ws.archivedSessionIds) ? ws.archivedSessionIds : []);
          const sessions = await this.dsh.listSessions();
          const all = (sessions && sessions.items) || [];
          const notArchived = (s) => !archivedIds.has(s.sessionId);
          const items = boundWs && Array.isArray(boundWs.sessionIds)
            ? all.filter((s) => boundWs.sessionIds.includes(s.sessionId)).filter(notArchived)
            : all.filter(notArchived);
          if (arg) {
            const hit = pick(items, arg);
            if (!hit) return reply('❌ 未找到会话');
            this.mapper.set(platform, chatId, { sessionId: hit.sessionId, sessionTitle: hit.title });
            return reply(`✅ 会话 → ${hit.title || hit.sessionId}\n绑定完成，直接发消息即可对话。`);
          }
          const scope = boundWs ? `当前工作区（${boundWs.title}）` : '全部（未绑定工作区）';
          const shown = items.slice(0, 20);
          const lines = shown.map(sessionLine);
          const supportsBtn = adapter && adapter.supportsKeyboard;
          const hint = supportsBtn ? `点下方按钮，或回复编号选择会话 · ${scope}：\n` : `回复编号选择会话 · ${scope}：\n`;
          const text = lines.length ? hint + lines.join('\n') : `（${scope}下暂无会话）`;
          // 按钮 label 用会话标题（超长省略）；指令 = /bot ses <完整ID>
          return reply(text, supportsBtn ? { keyboard: keyboardOf(shown, (s) => ({ label: shortLabel(sessionTitleOf(s) || '未命名'), cmd: `/bot ses ${s.sessionId}` })) } : null);
        }
        case 'model': {
          if (!binding || !binding.sessionId) return reply('先 /bot ses 绑定会话');
          const models = await this.dsh.models(binding.sessionId);
          if (arg) {
            const [provider, model] = arg.split('/');
            if (!provider || !model) return reply('格式：/bot model <provider>/<model>');
            await this.dsh.selectModel(binding.sessionId, provider, model);
            return reply(`✅ 模型 → ${provider}/${model}`);
          }
          const groups = models.groups || [];
          const lines = groups.map((g) => `${g.name}：${(g.models || []).map((m) => `${m.id}（${m.name}）`).join('、')}`);
          const text = lines.length ? '可用模型（点按钮或 /bot model <provider>/<model>）：\n' + lines.join('\n') : '（无模型信息）';
          // 模型按钮：指令 = /bot model <provider>/<id>；provider 取 group 字段或当前 provider 兜底
          const curProvider = models.current && (models.current.provider || '');
          const btns = groups.flatMap((g) => (g.models || []).map((m) => ({
            provider: g.provider || g.id || curProvider || g.name || '',
            model: m.id,
            label: m.name || m.id,
          })));
          const supportsBtn = adapter && adapter.supportsKeyboard;
          return reply(text, supportsBtn && btns.length ? { keyboard: keyboardOf(btns, (b) => ({ label: shortLabel(b.label), cmd: `/bot model ${b.provider}/${b.model}` })) } : null);
        }
        case 'usage': {
          const u = this.usageFn();
          if (!u) return reply('用量不可用（未配置 Key 或服务未就绪）');
          if (u.error) return reply(`用量失败：${u.error}`);
          const fmt = (v) => (v === null || v === undefined ? '--' : Number(v).toFixed(2));
          const lines = [`💰 余额：¥${fmt(u.balance)}`];
          // 当前会话 Token 用量与费用（dsh 投影统计，口径同 dsh-session-cost 插件：整会话累计）
          if (binding && binding.sessionId) {
            try {
              const s = await this.dsh.listSessions();
              const me = ((s && s.items) || []).find((x) => x.sessionId === binding.sessionId);
              const tu = me && me.projections && me.projections.values && me.projections.values.tokenUsage;
              if (tu) {
                const cost = costOfProjection(tu, null, Date.now());
                const tok = (v) => (v ? Math.round(Number(v) / 1000) + 'k' : '0');
                if (cost.total > 0) {
                  lines.push(
                    `本次对话费用 ≈¥${fmt(cost.total)}（命中 ¥${fmt(cost.hit)} + 未命中 ¥${fmt(cost.miss)} + 输出 ¥${fmt(cost.out)}）`
                  );
                }
                lines.push(
                  `本次对话：输入 ${tok(tu.uncachedInputTokens)} + 缓存 ${tok(tu.cacheReadTokens)} → 输出 ${tok(tu.outputTokens)} tokens`
                );
              }
            } catch {
              /* token 用量获取失败忽略 */
            }
          }
          if (u.spent !== null && u.spent !== undefined && Number(u.spent) !== 0) {
            lines.push(`本次启动消费：-¥${fmt(u.spent)}`);
          }
          lines.push('每 30 秒自动刷新余额');
          return reply(lines.join('\n'));
        }
        case 'history': {
          if (!binding || !binding.sessionId) return reply('先 /bot ses 绑定会话');
          const n = Math.min(50, Math.max(1, parseInt(arg, 10) || 10));
          const h = await this.dsh.history(binding.sessionId, { limit: n });
          const lines = renderHistory(h.events || [], { mode: MODE_PURE, limit: n });
          return reply(lines.length ? '最近记录：\n' + lines.join('\n') : '（暂无记录）');
        }
        case 'setting': {
          // /setting —— 交互式设置菜单（按钮选择）
          // 用法：setting（主菜单）| setting idle <分钟> | setting idle（二级按钮）
          const [k, ...v] = arg.split(/\s+/);
          const supportsBtn = adapter && adapter.supportsKeyboard;
          if (k === 'idle') {
            const n = parseInt(v[0], 10);
            if (Number.isFinite(n) && n >= 0) {
              // 直接设置
              if (this.onConfigChange) {
                const next = await this.onConfigChange({ idleMinutes: n });
                if (next && next.idleMinutes !== undefined) this.config.idleMinutes = next.idleMinutes;
                return reply(`✅ 闲置自动退出 → ${next && next.idleMinutes !== undefined ? next.idleMinutes : n} 分钟`);
              }
              this.config.idleMinutes = n;
              return reply(`✅ 闲置自动退出 → ${n} 分钟（未持久化，重启失效）`);
            }
            // 二级按钮：选择闲置分钟
            const idle = Number(this.config && this.config.idleMinutes);
            const opts = [
              { label: '不退出', cmd: '/setting idle 0' },
              { label: '15 分钟', cmd: '/setting idle 15' },
              { label: '30 分钟', cmd: '/setting idle 30' },
              { label: '60 分钟', cmd: '/setting idle 60' },
            ];
            const text = `点按钮选择闲置自动退出时长（当前：${idle > 0 ? idle + ' 分钟' : '不退出'}）：`;
            return reply(text, supportsBtn ? { keyboard: keyboardOf(opts, (o) => ({ label: o.label, cmd: o.cmd })) } : null);
          }
          if (k === 'notify') {
            // 选择非 QQ 任务完成推送模式
            const mode = v[0];
            if (['full', 'brief', 'none'].includes(mode)) {
              if (this.onConfigChange) {
                const next = await this.onConfigChange({ notifyMode: mode });
                if (next && next.notifyMode) this.config.notifyMode = next.notifyMode;
                const label = { full: '全文推送', brief: '短固定提醒', none: '不提醒' }[mode];
                return reply(`✅ 非QQ任务推送 → ${label}`);
              }
              this.config.notifyMode = mode;
              return reply(`✅ 非QQ任务推送 → ${mode}（未持久化，重启失效）`);
            }
            // 二级按钮：选择推送模式
            const cur = this.config && this.config.notifyMode;
            const nopts = [
              { label: '全文推送', cmd: '/setting notify full' },
              { label: '短固定提醒', cmd: '/setting notify brief' },
              { label: '不提醒', cmd: '/setting notify none' },
            ];
            const ntext = `点按钮选择非 QQ 任务完成推送方式（当前：${cur === 'brief' ? '短固定提醒' : cur === 'none' ? '不提醒' : '全文推送'}）：`;
            return reply(ntext, supportsBtn ? { keyboard: keyboardOf(nopts, (o) => ({ label: o.label, cmd: o.cmd })) } : null);
          }
          // 主菜单：显示当前设置 + 可点按钮
          const idle = Number(this.config && this.config.idleMinutes);
          const nm = this.config && this.config.notifyMode;
          const lines = [
            `📋 当前设置`,
            `闲置自动退出：${idle > 0 ? idle + ' 分钟' : '不退出'}`,
            `非QQ任务推送：${nm === 'brief' ? '短固定提醒' : nm === 'none' ? '不提醒' : '全文推送'}`,
          ];
          if (binding && binding.sessionId) lines.push(`当前会话：${binding.sessionTitle || binding.sessionId}`);
          lines.push('点下方按钮修改设置：');
          const mainBtns = [
            { label: '闲置自动退出', cmd: '/setting idle' },
            { label: '非QQ推送', cmd: '/setting notify' },
            { label: '帮助', cmd: '/help' },
          ];
          return reply(lines.join('\n'), supportsBtn ? { keyboard: keyboardOf(mainBtns, (o) => ({ label: o.label, cmd: o.cmd })) } : null);
        }
        case 'stop': {
          if (!binding || !binding.sessionId) return reply('先 /bot ses 绑定会话');
          await this.dsh.cancel(binding.sessionId);
          return reply('🛑 已请求打断当前生成');
        }
        case 'queue': {
          if (!binding || !binding.sessionId) return reply('先 /bot ses 绑定会话');
          const items = this.queueState.get(binding.sessionId) || [];
          return reply(items.length ? '队列：\n' + items.map((it, i) => `${i + 1}. ${it.text || it.id || JSON.stringify(it)}`).join('\n') : '队列为空');
        }
        case 'status': {
          const st = this.status();
          const dshInfo = await this.dsh.describe().catch(() => null);
          const lines = [
            `桥接：${st.running ? '运行中' : '已停止'}`,
            `适配器：${st.adapters.map((a) => `${a.name}${a.connected ? '(已连接)' : '(断开)'}`).join(' ') || '无'}`,
            dshInfo ? `dsh：${dshInfo.provider || ''}/${dshInfo.model || ''}` : 'dsh：不可用',
          ];
          if (binding) lines.push(`绑定：${binding.sessionTitle || binding.sessionId || '未绑定会话'}`);
          return reply(lines.join('\n'));
        }
        default:
          return reply('未知指令，/bot help 查看用法');
      }
    } catch (err) {
      reply(`❌ ${err.message}`);
    }
  }

  // ---------- 事件流与任务完成 ----------
  _onDshFrame(frame) {
    const p = frame && frame.payload;
    if (!p || typeof p !== 'object') return;
    if (p.type === 'session/event') {
      const ev = p.event || {};
      if (ev.type === 'assistant/message') {
        // 事件体：{ type, seq, time, data: { message, usage } }，message 在 data.message
        const message = (ev.data && ev.data.message) || ev.message;
        const text = textOfMessage(message);
        const think = thinkTextOfMessage(message);
        const cur = this.replyBuf.get(p.sessionId) || { text: '', think: '' };
        if (text) cur.text = cur.text ? cur.text + '\n' + text : text;
        if (think) cur.think = cur.think ? cur.think + '\n' + think : think;
        this.replyBuf.set(p.sessionId, cur);
      }
    } else if (p.type === 'session/queue') {
      this.queueState.set(p.sessionId, p.items || []);
    }
  }

  async _pollRunning(token) {
    if (token !== this._pollToken || !this.running) return;
    let items = [];
    try {
      const res = await this.dsh.listSessions();
      items = (res && res.items) || [];
    } catch {
      return; // dsh 暂时不可用，下轮再试
    }
    const ids = new Set(items.map((i) => i.sessionId));
    for (const it of items) {
      const was = this.busy.get(it.sessionId);
      const now = Boolean(it.running);
      this.busy.set(it.sessionId, now);
      if (was === true && now === false) this._onComplete(it).catch(() => {});
    }
    for (const k of Array.from(this.busy.keys())) {
      if (!ids.has(k)) this.busy.delete(k);
    }
  }

  async _onComplete(item) {
    const acc = this.replyBuf.get(item.sessionId);
    this.replyBuf.delete(item.sessionId);
    const prompter = this.prompter.get(item.sessionId);
    this.prompter.delete(item.sessionId);
    const title = sessionTitleOf(item) || item.sessionId;

    // 正文来源：优先 history（完整回复，含流式 chunk 合并后的 assistant/message）；
    // replyBuf（mux 实时累积）可能只收到部分 chunk（曾导致正文只有开头一段）。
    let accText = '';
    try {
      const h = await this.dsh.history(item.sessionId, { limit: 200 });
      const evs = (h && h.events) || [];
      const parts = [];
      for (let i = evs.length - 1; i >= 0; i--) {
        const ev = (evs[i] && evs[i].event) || evs[i] || {};
        if (ev.type === 'user/message') break; // 遇到用户消息 = 上一条回复边界
        if (ev.type !== 'assistant/message') continue;
        const message = (ev.data && ev.data.message) || ev.message;
        const t = textOfMessage(message);
        if (t) parts.unshift(t);
      }
      accText = parts.join('\n');
    } catch {
      /* history 拉取失败则维持空正文 */
    }
    // history 未取到时回退 replyBuf（实时累积）
    if (!accText && acc && acc.text) accText = acc.text;
    const accBody = accText ? { text: accText, think: (acc && acc.think) || '' } : acc;

    for (const [key, b] of Object.entries(this.mapper.all())) {
      if (b.sessionId !== item.sessionId) continue;
      const [platform, chatId] = key.split(/:(.+)/);
      if (!platform || !chatId) continue;
      const chat = chatFromKey(chatId);
      const adapter = this._adapterFor(platform);
      if (!adapter) continue;
      const isPrompter = prompter && prompter.platform === platform && sameChat(prompter.chat, chat);
      const body = renderAccumulated(accBody, MODE_PURE);
      // 引用用户原文：官方 message_reference.message_id = 用户消息事件的 d.id（prompter.msgId）
      const refOpts = isPrompter && prompter.msgId ? { messageReference: { message_id: prompter.msgId } } : null;
      // 推送策略：prompter（QQ 发起的任务）始终全文；非 prompter 按 notifyMode：
      //   full=全文 | brief=短固定提醒 | none=不推送
      if (!isPrompter) {
        const mode = this.config && this.config.notifyMode;
        if (mode === 'none') continue; // 不推送
        if (mode === 'brief') {
          this._reply(chat, `✅ 任务完成「${title}」`, adapter);
          continue;
        }
      }
      // 全文推送（prompter 或 full 模式）
      this._reply(chat, body ? `✅ 任务完成「${title}」\n${body}` : `✅ 任务完成「${title}」`, adapter, refOpts);
    }
    // 系统通知：走共享去重通道（onTaskComplete，由 main.js 注入）——
    // 不再直发 this.notify，避免与 preload 检测重复弹两条、且正文退化成 session ID
    const finalText = accText;
    if (this.onTaskComplete) {
      this.onTaskComplete(title, finalText ? truncate(finalText, 40) : '');
    } else if (finalText) {
      this.notify('任务完成', truncate(finalText, 40));
    } else {
      this.notify('任务完成', truncate(title, 40));
    }
  }

  // ---------- 闲置自动退出 ----------
  /** 记录频道活跃时间（handleMessage 时调用） */
  _touchActive(chatKey) {
    this.lastActive.set(chatKey, Date.now());
  }

  /**
   * 闲置检查：绑定频道的「最后活跃时间」超过 idleMinutes 分钟 → 清空 ws/ses 绑定，
   * 下次进入需重新选择（安全/防误用）。idleMinutes<=0 或未配置 = 不自动退出。
   */
  _checkIdle() {
    const idleMinutes = Number(this.config && this.config.idleMinutes);
    if (!idleMinutes || idleMinutes <= 0) return;
    const limit = idleMinutes * 60 * 1000;
    const now = Date.now();
    const all = this.mapper.all();
    for (const [key, b] of Object.entries(all)) {
      if (!b || (!b.sessionId && !b.workspaceId)) continue; // 未绑定不用管
      const last = this.lastActive.get(key) || 0;
      // 绑定但从未活跃过：以当前时刻为基线（首次检查不误杀）
      const effective = last || now;
      if (now - effective < limit) continue;
      const [platform, chatId] = key.split(/:(.+)/);
      if (!platform || !chatId) continue;
      // 清空绑定（保留 welcomed 标记，不再重复欢迎）
      this.mapper.set(platform, chatId, { workspaceId: null, sessionId: null });
      this.lastActive.delete(key);
      this._log(`idle timeout: ${key}`);
      const chat = chatFromKey(chatId);
      const adapter = this._adapterFor(platform);
      if (adapter) this._reply(chat, '⏰ 长时间未对话，已自动退出（需重新选择工作区和会话）。', adapter);
    }
  }
}

module.exports = { ImBridge };
