'use strict';
// DSH Desk —— DeepSeek Harness 桌面托盘程序
// 主进程：管理窗口、托盘、开机自启，以及 DSH 服务进程的生命周期
const { app, BrowserWindow, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { DshManager } = require('./dsh-manager');
const { createTray } = require('./tray');

const APP_DIR = path.join(__dirname, '..');
const ICON_PATH = path.join(APP_DIR, 'assets', 'icon.png');
const TRAY_ICON_PATH = path.join(APP_DIR, 'assets', 'tray.png');
const LOADING_HTML = path.join(__dirname, 'loading.html');
const PRELOAD_JS = path.join(__dirname, 'preload.js');

const AUTOSTART_VALUE = 'DSH Desk';
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

// 设置 Windows AppUserModelID：任务栏右键菜单/分组按此显示应用名，避免显示成 "Electron"
app.setAppUserModelId('com.dshdesk.app');

let mainWindow = null;
let trayCtl = null;
let manager = null;
let isQuitting = false;
let autoStartEnabled = false;
let loadRetries = 0;

// ---------- 开机自启（HKCU Run 键） ----------
function autoStartCommand() {
  const exe = process.execPath;
  if (app.isPackaged) return `"${exe}" --autostart`;
  // 开发态：electron.exe 需要带上应用目录参数
  return `"${exe}" "${APP_DIR}" --autostart`;
}

function isAutoStartEnabled() {
  return new Promise((resolve) => {
    execFile(
      'reg',
      ['query', RUN_KEY, '/v', AUTOSTART_VALUE],
      { windowsHide: true },
      (err, stdout) => {
        resolve(!err && stdout.includes('--autostart'));
      }
    );
  });
}

function setAutoStart(enabled) {
  return new Promise((resolve) => {
    const args = enabled
      ? ['add', RUN_KEY, '/v', AUTOSTART_VALUE, '/t', 'REG_SZ', '/d', autoStartCommand(), '/f']
      : ['delete', RUN_KEY, '/v', AUTOSTART_VALUE, '/f'];
    execFile('reg', args, { windowsHide: true }, () => resolve());
  });
}

// ---------- 窗口 ----------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 860,
    minHeight: 600,
    title: 'DSH Desk',
    icon: ICON_PATH,
    backgroundColor: '#0b0d12',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: PRELOAD_JS,
    },
  });
  mainWindow.setMenuBarVisibility(false);

  // 窗口标题固定为 "DSH Desk"：DSH 页面自带 <title>（如 "DeepSeek Harness"）
  // 加载后会覆盖标题栏，这里阻止页面标题生效
  mainWindow.webContents.on('page-title-updated', (e) => {
    e.preventDefault();
  });

  // 关闭 / 最小化 → 隐藏到托盘（服务继续运行）
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 外部链接交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (/^https?:/i.test(url) && !url.includes('127.0.0.1') && !url.includes('localhost')) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  // DSH 界面加载失败自动重试（ERR_ABORTED=-3 是正常取消，不重试）
  mainWindow.webContents.on('did-fail-load', (_e, code, _desc, validatedURL, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    if (manager && manager.url && validatedURL === manager.url && loadRetries < 8) {
      loadRetries++;
      setTimeout(() => navigateTo(manager.url, true), 1200);
    }
  });
  mainWindow.webContents.on('did-finish-load', () => {
    loadRetries = 0;
  });
}

function navigateTo(url, force = false) {
  if (!mainWindow || !url) return;
  // 普通调用：已在目标地址则跳过；force=true（加载失败重试）时强制重新加载，
  // 因为 did-fail-load 后 getURL() 仍可能是失败的那个 URL，会被上面的判断挡掉
  if (!force && mainWindow.webContents.getURL() === url) return;
  loadRetries = 0;
  mainWindow.loadURL(url).catch(() => {});
}

function showMainWindow() {
  if (!mainWindow) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (manager && manager.url) {
    navigateTo(manager.url);
  } else if (!mainWindow.webContents.getURL()) {
    mainWindow.loadFile(LOADING_HTML);
  }
  mainWindow.show();
  mainWindow.focus();
}

function toggleWindow() {
  if (!mainWindow) {
    showMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) {
    // 已最小化 → 恢复（不触发隐藏）
    mainWindow.restore();
    mainWindow.focus();
  } else if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    showMainWindow();
  }
}

// ---------- 状态 ----------
function updateStatus() {
  if (trayCtl) trayCtl.refresh();
  if (mainWindow && !mainWindow.isDestroyed()) {
    // 窗口标题保持简洁；详细状态在托盘提示与菜单中
    mainWindow.setTitle('DSH Desk');
  }
}

// 把 DSH 启动进度事件转发给加载页（loading.html 通过 preload 接收）
function sendToWindow(type, payload) {
  if (
    mainWindow &&
    !mainWindow.isDestroyed() &&
    mainWindow.webContents &&
    !mainWindow.webContents.isDestroyed()
  ) {
    mainWindow.webContents.send('dsh-desk:event', { type, ...payload });
  }
}

// ---------- 托盘 ----------
function createTrayUI() {
  trayCtl = createTray({
    iconPath: TRAY_ICON_PATH,
    getState: () => ({
      state: manager ? manager.state : 'stopped',
      url: manager ? manager.url : null,
    }),
    isAutoStart: () => autoStartEnabled,
    onToggleAutoStart: async (enabled) => {
      await setAutoStart(enabled);
      autoStartEnabled = enabled;
      updateStatus();
    },
    onToggleWindow: toggleWindow,
    onOpenBrowser: () => {
      if (manager && manager.url) shell.openExternal(manager.url);
    },
    onStart: () => {
      if (manager) manager.start().catch(() => {});
    },
    onStop: () => {
      if (manager && manager.state === 'running') manager.stop().catch(() => {});
    },
    onRestart: () => {
      if (manager) manager.restart().catch(() => {});
    },
    onOpenLogs: () => {
      if (manager) shell.openPath(manager.logDir);
    },
    onQuit: quit,
  });
  updateStatus();
}

// ---------- 退出 ----------
async function quit() {
  isQuitting = true;
  if (manager) {
    try {
      await manager.stop(); // 停掉由我们启动的 DSH 进程树
    } catch {
      /* ignore */
    }
  }
  app.quit();
}

// ---------- 启动 ----------
async function init() {
  try {
    if (!app.requestSingleInstanceLock()) {
      // 已有实例在运行：让主实例把窗口带出来，本实例兜底强制退出
      // （app.quit() 挂起时会出现“启动无反应/黑屏”，用定时器确保进程结束）
      app.quit();
      setTimeout(() => process.exit(0), 1500);
      return;
    }
    app.on('second-instance', () => showMainWindow());

    manager = new DshManager({ logDir: path.join(app.getPath('userData'), 'logs') });
    manager.on('stage', (stage) => {
      updateStatus();
      sendToWindow('stage', stage);
    });
    manager.on('ready', ({ url, attached }) => {
      updateStatus();
      sendToWindow('ready', { url, attached });
      if (mainWindow && mainWindow.isVisible()) navigateTo(url);
    });
    manager.on('stopped', updateStatus);
    manager.on('log', (entry) => sendToWindow('log', entry));
    manager.on('failed', ({ code, message }) => {
      updateStatus();
      sendToWindow('failed', { code, message });
      if (isQuitting) return;
      const full = `${message}\n\n诊断：${JSON.stringify(manager.getDiagnostics(), null, 2)}`;
      if (mainWindow && mainWindow.isVisible()) {
        dialog
          .showMessageBox(mainWindow, {
            type: 'error',
            title: 'DSH 服务启动失败',
            message: full,
            buttons: ['打开日志目录', '确定'],
            defaultId: 1,
            cancelId: 1,
          })
          .then(({ response }) => {
            if (response === 0) shell.openPath(manager.logDir);
          });
      } else {
        dialog.showErrorBox('DSH 服务启动失败', full);
      }
    });

    autoStartEnabled = await isAutoStartEnabled();
    createTrayUI();

    const startServer = () => manager.start().catch(() => {});
    if (process.argv.includes('--autostart')) {
      // 开机自启：直接后台运行，不打扰用户
      startServer();
    } else {
      showMainWindow();
      startServer();
    }
  } catch (err) {
    // init 崩溃兜底：写崩溃日志 + 弹窗，避免“加载页永远转圈”
    const crashLog = path.join(app.getPath('userData'), 'logs', 'crash.log');
    try {
      fs.mkdirSync(path.dirname(crashLog), { recursive: true });
      fs.appendFileSync(crashLog, `${new Date().toISOString()} ${(err && err.stack) || String(err)}\n`);
    } catch {
      /* ignore */
    }
    dialog.showErrorBox(
      'DSH Desk 初始化失败',
      `${(err && err.stack) || String(err)}\n\n崩溃日志：${crashLog}`
    );
  }
}

app.whenReady().then(init);
app.on('window-all-closed', () => {
  /* 托盘应用：关闭窗口不退出 */
});
app.on('before-quit', () => {
  isQuitting = true;
});
