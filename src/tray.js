'use strict';
// 系统托盘：图标（状态角标由主进程切换）+ 二级菜单
// 主菜单只留常用操作；服务/用量/通知收进二级菜单，信息不再分散
const { Tray, Menu, nativeImage } = require('electron');

const STATUS_TEXT = {
  running: '运行中',
  attached: '已附着',
  starting: '启动中…',
  stopped: '已停止',
  failed: '启动失败',
};

const STATE_ICON = {
  running: '●',
  attached: '●',
  starting: '…',
  stopped: '○',
  failed: '✕',
};

/**
 * @param {object} opts
 * @param {string} opts.iconPath 托盘图标（32x32 PNG，基础态）
 * @param {() => { state: string, url: string|null }} opts.getState
 * @param {() => { keyConfigured: boolean, balance: number|null, spent: number|null, error: string|null }} [opts.getUsage]
 * @param {() => void} [opts.onRefreshUsage]
 * @param {() => void} [opts.onResetUsage]
 * @param {() => { task: boolean, startup: boolean, error: boolean }} [opts.getNotifications]
 * @param {(type: string, enabled: boolean) => void} [opts.onToggleNotification]
 * @param {() => boolean} opts.isAutoStart
 * @param {(enabled: boolean) => void} opts.onToggleAutoStart
 * @param {() => void} opts.onToggleWindow
 * @param {() => void} [opts.onNewWindow]
 * @param {() => void} opts.onOpenBrowser
 * @param {() => void} opts.onStart
 * @param {() => void} opts.onStop
 * @param {() => void} opts.onRestart
 * @param {() => void} opts.onOpenLogs
 * @param {() => void} opts.onQuit
 * @returns {{ tray: Tray, refresh: () => void }}
 */
function createTray(opts) {
  const tray = new Tray(nativeImage.createFromPath(opts.iconPath));
  tray.setToolTip('DSH Desk');

  const fmt = (v) => (v === null || v === undefined ? '--' : v.toFixed(2));
  // 限制菜单项字符长度，保证菜单宽度合理
  const MAX_LEN = 44;
  const truncate = (s) => {
    s = String(s == null ? '' : s);
    return s.length > MAX_LEN ? s.slice(0, MAX_LEN - 1) + '…' : s;
  };

  function usageMenu() {
    if (typeof opts.getUsage !== 'function') return [];
    const u = opts.getUsage();
    let label;
    if (!u.keyConfigured) label = '未配置 API Key';
    else if (u.error) label = `查询失败（${u.error}）`;
    else label = `¥${fmt(u.balance)} · -¥${fmt(u.spent)}`;
    return [
      { label, enabled: false },
      { type: 'separator' },
      { label: '刷新用量', click: opts.onRefreshUsage },
      { label: '清零小计', click: opts.onResetUsage },
    ];
  }

  function notificationMenu() {
    if (typeof opts.getNotifications !== 'function') return [];
    const n = opts.getNotifications() || {};
    const mk = (type, label) => ({
      label,
      type: 'checkbox',
      checked: Boolean(n[type]),
      click: (item) => opts.onToggleNotification(type, item.checked),
    });
    const items = [
      mk('task', '任务完成通知'),
      mk('startup', '启动成功通知'),
      mk('error', '出错通知'),
    ];
    if (typeof opts.onTestNotification === 'function') {
      items.push({ type: 'separator' });
      items.push({ label: '测试通知', click: opts.onTestNotification });
    }
    return items;
  }

  // 用量信息（主菜单直接显示，拆成两行：余额 / 本次消费）
  function usageInfoItems() {
    if (typeof opts.getUsage !== 'function') return [];
    const u = opts.getUsage();
    if (!u.keyConfigured) return [{ label: '用量：未配置 Key', enabled: false }];
    if (u.error) return [{ label: truncate(`用量失败：${u.error}`), enabled: false }];
    return [
      { label: `¥${fmt(u.balance)}`, enabled: false },
      { label: `-¥${fmt(u.spent)}`, enabled: false },
    ];
  }

  function buildMenu() {
    const { state, url } = opts.getState();
    const statusText = STATUS_TEXT[state] || state;
    const running = state === 'running';
    const stopped = state === 'stopped' || state === 'failed';
    const infoItems = [
      { label: `${STATE_ICON[state] || '○'} ${statusText}`, enabled: false },
      ...usageInfoItems(),
    ];
    return Menu.buildFromTemplate([
      ...infoItems,
      { type: 'separator' },
      { label: '新建窗口', enabled: Boolean(opts.onNewWindow), click: opts.onNewWindow },
      { label: '打开网页', enabled: Boolean(url), click: opts.onOpenBrowser },
      { type: 'separator' },
      {
        label: '服务',
        submenu: [
          { label: truncate(`状态：${statusText}`), enabled: false },
          { type: 'separator' },
          { label: '启动 DSH 服务', enabled: stopped, click: opts.onStart },
          { label: '停止 DSH 服务', enabled: running, click: opts.onStop },
          { label: '重启 DSH 服务', enabled: running, click: opts.onRestart },
        ],
      },
      { label: '用量', submenu: usageMenu() },
      { label: '通知', submenu: notificationMenu() },
      { type: 'separator' },
      {
        label: '开机自启',
        type: 'checkbox',
        checked: Boolean(opts.isAutoStart()),
        click: (item) => opts.onToggleAutoStart(item.checked),
      },
      { label: '查看日志', click: opts.onOpenLogs },
      { type: 'separator' },
      { label: '退出', click: opts.onQuit },
    ]);
  }

  function refresh() {
    const info = opts.getState();
    const statusText = STATUS_TEXT[info.state] || info.state;
    tray.setToolTip(`DSH Desk — ${statusText}${info.url ? ' · ' + info.url : ''}`);
    tray.setContextMenu(buildMenu());
  }

  tray.setContextMenu(buildMenu());
  tray.on('click', opts.onToggleWindow);
  tray.on('double-click', opts.onToggleWindow);
  return { tray, refresh };
}

module.exports = { createTray };
