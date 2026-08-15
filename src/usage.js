'use strict';
// DeepSeek 用量跟踪（主进程）：
// - 官方 Get User Balance 接口（GET https://api.deepseek.com/user/balance，Bearer API Key）
// - "本次启动消费" = 启动基线余额 − 当前余额；"清零小计" = 把基线重置为当前余额
// - API Key 读取顺序：环境变量 DEEPSEEK_API_KEY → %DSH_HOME%/.credentials.yaml
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');

const BALANCE_URL = 'https://api.deepseek.com/user/balance';

function readApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    const creds = fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8');
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

class UsageTracker extends EventEmitter {
  constructor() {
    super();
    this.baseline = null; // 启动/清零时的余额基线
    this.lastBalance = null; // 最近一次查询到的余额
    this.lastError = null; // 最近一次错误信息（无错误为 null）
    this.keyConfigured = Boolean(readApiKey());
    this._timer = null;
  }

  /** 查询一次余额；首次成功时设置基线（= 本次启动消费的起点） */
  async refresh() {
    try {
      const b = await fetchBalance();
      if (this.baseline === null) this.baseline = b.total;
      this.lastBalance = b.total;
      this.lastError = null;
      this.emit('updated');
    } catch (e) {
      this.lastError = e.message;
      this.emit('updated');
    }
    return this.snapshot();
  }

  /** 本次启动已消费金额：基线 − 当前（充值导致余额增加时钳制为 0） */
  spent() {
    if (this.baseline === null || this.lastBalance === null) return null;
    const d = this.baseline - this.lastBalance;
    return d > 0 ? d : 0;
  }

  /** 清零小计：把基线重置为当前余额 */
  resetBaseline() {
    if (this.lastBalance !== null) this.baseline = this.lastBalance;
    this.emit('updated');
  }

  snapshot() {
    return {
      keyConfigured: this.keyConfigured,
      balance: this.lastBalance,
      spent: this.spent(),
      error: this.lastError,
    };
  }

  start(intervalMs = 60000) {
    if (this._timer) return;
    this.refresh().catch(() => {});
    this._timer = setInterval(() => this.refresh().catch(() => {}), intervalMs);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}

module.exports = { UsageTracker, fetchBalance, readApiKey };
