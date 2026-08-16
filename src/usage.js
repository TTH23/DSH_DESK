'use strict';
// DeepSeek 用量跟踪（主进程）：
// - 余额：官方 Get User Balance 接口（GET https://api.deepseek.com/user/balance，Bearer API Key）
// - 本次启动消费：按 Harness 会话存储中的实际用量 × 现行峰谷计价（仅本应用消耗，
//   不受同账户其他 API Key 影响）；"清零小计" = 把本次消费计数基线重置为当前值
// - 会话文件：%DSH_HOME%/sessions/<encoded-cwd>/<session-id>/session.jsonl[.zstd]
//   （zstd = 多帧拼接，每帧解压出 JSONL 行）
// - API Key 读取顺序：环境变量 DEEPSEEK_API_KEY → %DSH_HOME%/.credentials.yaml
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { zstdDecompressSync } = require('node:zlib');

const BALANCE_URL = 'https://api.deepseek.com/user/balance';

// ========== 计价 ==========
// 现行价（2026-08-17 00:00 北京时间起生效）：峰谷定价，元/百万 tokens
// 高峰时段（北京时间）：9:00–12:00、14:00–18:00；空闲时段为高峰的一半
const PRICING_V2 = {
  'deepseek-v4-flash': {
    peak: { hit: 0.1, miss: 3.0, out: 9.0 },
    offpeak: { hit: 0.05, miss: 1.5, out: 4.5 },
  },
  'deepseek-v4-pro': {
    peak: { hit: 0.3, miss: 9.0, out: 27.0 },
    offpeak: { hit: 0.15, miss: 4.5, out: 13.5 },
  },
};
const DEFAULT_MODEL = 'deepseek-v4-flash';

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function isPeak(ts) {
  const d = new Date(ts + 8 * 3600e3); // 北京时间 = UTC+8
  const h = d.getUTCHours();
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}

function modelKey(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('deepseek-v4-pro')) return 'deepseek-v4-pro';
  return DEFAULT_MODEL; // flash 与未知模型均按 flash 计
}

/** 单次用量事件费用（元）。usage: { inputTokens(未命中), cacheReadTokens(命中), cacheWriteTokens(缓存写入), outputTokens(输出) }
 * 统一按现行峰谷价计（2026-08-17 00:00 北京时间起生效）。
 * 计费口径与 dsh-session-cost 插件一致：缓存写入按「未命中」单价计（对应官方 prompt_cache_miss_tokens）。 */
function costOfUsage(usage, model, ts) {
  const miss = ((usage.inputTokens || 0) + (usage.cacheWriteTokens || 0)) / 1e6;
  const hit = (usage.cacheReadTokens || 0) / 1e6;
  const out = (usage.outputTokens || 0) / 1e6;
  const modelFamily = modelKey(model);
  const table = PRICING_V2[modelFamily];
  const p = isPeak(ts) ? table.peak : table.offpeak;
  return miss * p.miss + hit * p.hit + out * p.out;
}

/** 会话累计费用（元）：与 dsh-session-cost 插件 computeCost 同口径，
 * 输入为 tokenUsage 投影 { uncachedInputTokens, cacheReadTokens, cacheWriteTokens, outputTokens }。
 * 结果 = (未命中 + 写入) × miss + 命中 × hit + 输出 × out。
 * @returns {{ total: number, hit: number, miss: number, out: number }} 各部分费用（元）
 */
function costOfProjection(tu, model, ts) {
  const hit = ((tu && tu.cacheReadTokens) || 0) / 1e6;
  const miss = (((tu && tu.uncachedInputTokens) || 0) + ((tu && tu.cacheWriteTokens) || 0)) / 1e6;
  const out = ((tu && tu.outputTokens) || 0) / 1e6;
  const modelFamily = modelKey(model);
  const table = PRICING_V2[modelFamily];
  const p = isPeak(ts) ? table.peak : table.offpeak;
  return {
    total: hit * p.hit + miss * p.miss + out * p.out,
    hit: hit * p.hit,
    miss: miss * p.miss,
    out: out * p.out,
  };
}

// ========== 会话存储读取 ==========
const ZSTD_MAGIC = 4247762216; // 0xFD2FB528

/** 扫描 zstd 帧边界（不整帧解压），返回完整帧列表与撕裂尾帧起点 */
function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error('invalid zstd frame magic');
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error('reserved frame-header bit');
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error('reserved block type');
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames };
}

/** 遍历会话目录，收集所有 session.jsonl / session.jsonl.zstd */
function listSessionFiles(home) {
  const out = [];
  const root = path.join(home, 'sessions');
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'session.jsonl' || e.name === 'session.jsonl.zstd') out.push(p);
    }
  };
  walk(root);
  return out;
}

// ========== 用量跟踪 ==========
let usageLogPath = null;
function logUsage(line) {
  if (!usageLogPath) {
    try {
      usageLogPath = path.join(process.env.APPDATA || os.homedir(), 'DSH Desk', 'logs', 'usage.log');
      fs.mkdirSync(path.dirname(usageLogPath), { recursive: true });
    } catch {
      return;
    }
  }
  try {
    fs.appendFileSync(usageLogPath, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* ignore */
  }
}

class UsageTracker extends EventEmitter {
  constructor() {
    super();
    this.keyConfigured = Boolean(readApiKey());
    this.lastBalance = null;
    this.balanceError = null;
    this.costError = null;
    this.startTs = Date.now(); // 本次启动时间
    this.sessionCost = 0; // 启动后累计用量费用（元）
    this.costBaseline = 0; // 清零小计基线
    // 会话水位：<path> → { bytes, model }；启动时记录水位（不解析历史）
    this.watermarks = new Map();
    this.knownAtLaunch = new Set();
    for (const f of listSessionFiles(dshHome())) {
      this.knownAtLaunch.add(f);
      try {
        this.watermarks.set(f, { bytes: fs.statSync(f).size, model: null });
      } catch {
        /* 文件可能刚删 */
      }
    }
    this._timer = null;
  }

  /** 本次启动消费（展示值）= 用量费用 − 清零基线 */
  spent() {
    return Math.max(0, this.sessionCost - this.costBaseline);
  }

  /** 清零小计：本次消费从当前值重新计数 */
  resetBaseline() {
    this.costBaseline = this.sessionCost;
    this.emit('updated');
  }

  async refresh() {
    // ① 余额（账户级；失败不影响用量）
    try {
      const b = await fetchBalance();
      this.lastBalance = b.total;
      this.balanceError = null;
    } catch (e) {
      this.balanceError = e.message;
    }
    // ② 本次启动用量费用（会话增量解析）
    try {
      this.sessionCost = this.computeSessionCost();
      this.costError = null;
    } catch (e) {
      this.costError = e.message;
      logUsage(`compute error: ${e.message}`);
    }
    this.emit('updated');
    return this.snapshot();
  }

  /** 增量解析会话存储，累计启动时间之后的用量费用 */
  computeSessionCost() {
    let total = 0;
    for (const file of listSessionFiles(dshHome())) {
      try {
        const size = fs.statSync(file).size;
        const st = this.watermarks.get(file);
        let prevBytes = st ? st.bytes : this.knownAtLaunch.has(file) ? size : 0;
        if (st && size <= prevBytes) {
          if (size < prevBytes) {
            // 文件被重写（压缩等）：跳过历史，从新起点开始
            this.watermarks.set(file, { bytes: size, model: null });
          }
          continue;
        }
        const state = { model: st ? st.model : null, cost: 0 };
        const isZstd = file.endsWith('.zstd');
        if (isZstd) {
          const buf = fs.readFileSync(file);
          const { frames } = scanZstdFrames(buf);
          for (const fr of frames) {
            if (fr.end <= prevBytes) continue; // 已在旧水位内
            const text = zstdDecompressSync(buf.subarray(fr.start, fr.end)).toString('utf8');
            this.accumulateJsonl(text, state);
          }
        } else {
          let text = fs.readFileSync(file, 'utf8');
          if (prevBytes > 0) {
            text = text.slice(prevBytes).replace(/^[^\n]*\n/, ''); // 丢弃跨水位的半行
          }
          this.accumulateJsonl(text, state);
        }
        total += state.cost;
        this.watermarks.set(file, { bytes: size, model: state.model });
      } catch (e) {
        logUsage(`session error ${file}: ${e.message}`);
      }
    }
    return total;
  }

  /** 解析一帧 JSONL：跟踪模型（request/context）、累计 assistant/message 用量费用 */
  accumulateJsonl(text, state) {
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let j;
      try {
        j = JSON.parse(t);
      } catch {
        continue;
      }
      if (j.data && typeof j.data.model === 'string') state.model = j.data.model;
      if (
        j.type === 'assistant/message' &&
        j.data &&
        j.data.usage &&
        typeof j.data.usage.outputTokens === 'number'
      ) {
        const ts = typeof j.time === 'number' ? j.time : this.startTs;
        if (ts >= this.startTs) state.cost += costOfUsage(j.data.usage, state.model, ts);
      }
    }
  }

  snapshot() {
    return {
      keyConfigured: this.keyConfigured,
      balance: this.lastBalance,
      spent: this.spent(),
      error: this.balanceError || this.costError,
    };
  }

  start(intervalMs = 30000) {
    if (this._timer) return;
    this.refresh().catch(() => {});
    this._timer = setInterval(() => this.refresh().catch(() => {}), intervalMs);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}

// ========== 余额接口 ==========
function readApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    const creds = fs.readFileSync(path.join(dshHome(), '.credentials.yaml'), 'utf8');
    const m = creds.match(/^\s*DEEPSEEK_API_KEY\s*:\s*(\S+)\s*$/m);
    if (m) return m[1];
  } catch {
    /* ignore */
  }
  return null;
}

/** 查询余额（CNY；无 CNY 则取第一项）。余额为 NaN 视为解析失败。 */
function fetchBalance() {
  return new Promise((resolve, reject) => {
    const key = readApiKey();
    if (!key) return reject(Object.assign(new Error('未配置 DeepSeek API Key'), { code: 'NO_KEY' }));
    const req = https.get(
      BALANCE_URL,
      { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, timeout: 10000 },
      (res) => {
        let body = '';
        res.on('data', (c) => {
          body += c;
          if (body.length > 1e6) req.destroy();
        });
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            const infos = Array.isArray(json.balance_infos) ? json.balance_infos : [];
            const entry = infos.find((b) => b.currency === 'CNY') || infos[0];
            const total = entry ? Number(entry.total_balance) : NaN;
            if (!Number.isFinite(total)) return reject(Object.assign(new Error('响应解析失败'), { code: 'BAD_RESPONSE' }));
            resolve({
              available: json.is_available !== false,
              currency: entry ? entry.currency : '?',
              total,
            });
          } catch {
            reject(Object.assign(new Error('响应解析失败'), { code: 'BAD_RESPONSE' }));
          }
        });
      }
    );
    req.on('error', (e) => reject(e));
    req.on('timeout', () => {
      req.destroy();
      reject(Object.assign(new Error('请求超时'), { code: 'TIMEOUT' }));
    });
  });
}

module.exports = { UsageTracker, fetchBalance, readApiKey, costOfUsage, costOfProjection, isPeak, PRICING_V2 };
