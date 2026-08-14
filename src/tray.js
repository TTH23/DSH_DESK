'use strict';
// 系统托盘：图标 + 右键菜单（支持状态动态刷新）
const { Tray, Menu, nativeImage } = require('electron');

const STATUS_TEXT = {
  running: '运行中',
  attached: '已附着（外部实例）',
  starting: '启动中…',
  stopped: '已停止',
  failed: '启动失败',
};

/**
 * @param {object} opts
 * @param {string} opts.iconPath 托盘图标（32x32 PNG）
 * @param {() => { state: string, url: string|null }} opts.getState
 * @param {() => boolean} opts.isAutoStart
 * @param {(enabled: boolean) => void} opts.onToggleAutoStart
 * @param {() => void} opts.onToggleWindow
 * @param {() => void} [opts.onNewWindow] 新建窗口（多任务并行）
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

  function buildMenu() {
    const { state, url } = opts.getState();
    const statusText = STATUS_TEXT[state] || state;
    const running = state === 'running';
    const stopped = state === 'stopped' || state === 'failed';
    return Menu.buildFromTemplate([
      { label: `状态：${statusText}${url ? ' · ' + url : ''}`, enabled: false },
      { type: 'separator' },
      { label: '显示 / 隐藏主界面', click: opts.onToggleWindow },
      { label: '新建窗口', enabled: Boolean(opts.onNewWindow), click: opts.onNewWindow },
      { label: '在浏览器中打开', enabled: Boolean(url), click: opts.onOpenBrowser },
      { type: 'separator' },
      { label: '启动 DSH 服务', enabled: stopped, click: opts.onStart },
      { label: '停止 DSH 服务', enabled: running, click: opts.onStop },
      { label: '重启 DSH 服务', enabled: running, click: opts.onRestart },
      { type: 'separator' },
      {
        label: '开机自动启动',
        type: 'checkbox',
        checked: Boolean(opts.isAutoStart()),
        click: (item) => opts.onToggleAutoStart(item.checked),
      },
      { label: '查看日志目录', click: opts.onOpenLogs },
      { type: 'separator' },
      { label: '退出 DSH Desk', click: opts.onQuit },
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
