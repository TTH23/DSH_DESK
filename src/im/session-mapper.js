'use strict';
// IM 频道 ↔ DSH 工作区/会话 绑定与每频道配置（持久化到 <userData>/im/bindings.json）
// 记录形状：{ [channelKey]: { workspaceId?, sessionId?, mode: 'pure'|'all' } }
// channelKey = `${platform}:${chatId}`，例如 'qq:123456'（私聊）、'qq:group:987654'（群）
const fs = require('node:fs');
const path = require('node:path');

const MODES = ['pure', 'all'];

class SessionMapper {
  /**
   * @param {string} dir 持久化目录（如 %APPDATA%\DSH Desk\im）
   */
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'bindings.json');
    this.map = this._load();
  }

  _load() {
    try {
      const m = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return m && typeof m === 'object' ? m : {};
    } catch {
      return {};
    }
  }

  _save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.map, null, 2));
    } catch {
      /* ignore */
    }
  }

  key(platform, chatId) {
    return `${platform}:${chatId}`;
  }

  get(platform, chatId) {
    return this.map[this.key(platform, chatId)] || null;
  }

  set(platform, chatId, patch) {
    const k = this.key(platform, chatId);
    const cur = this.map[k] || {};
    const next = { ...cur, ...patch };
    if (patch.mode !== undefined && !MODES.includes(patch.mode)) delete next.mode;
    if (patch.sessionId === null) delete next.sessionId;
    if (patch.workspaceId === null) delete next.workspaceId;
    this.map[k] = next;
    this._save();
    return this.map[k];
  }

  clear(platform, chatId) {
    delete this.map[this.key(platform, chatId)];
    this._save();
  }

  all() {
    return { ...this.map };
  }
}

module.exports = { SessionMapper, MODES };
