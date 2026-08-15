'use strict';
// DSH Desk —— DeepSeek Harness 桌面托盘程序
// 主进程：管理窗口（支持多窗口）、托盘、开机自启，以及 DSH 服务进程的生命周期
const { app, BrowserWindow, dialog, shell, ipcMain, Notification, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFile, spawn } = require('node:child_process');
const { DshManager } = require('./dsh-manager');
const { UsageTracker } = require('./usage');
const { createTray } = require('./tray');

const APP_DIR = path.join(__dirname, '..');
const ICON_PATH = path.join(APP_DIR, 'assets', 'icon.png');
const TRAY_ICON_PATH = path.join(APP_DIR, 'assets', 'tray.png');
const TRAY_ONLINE_PATH = path.join(APP_DIR, 'assets', 'tray-online.png');
const TRAY_ERROR_PATH = path.join(APP_DIR, 'assets', 'tray-error.png');
const TRAY_OFFLINE_PATH = path.join(APP_DIR, 'assets', 'tray-offline.png');
const LOADING_HTML = path.join(__dirname, 'loading.html');
const PRELOAD_JS = path.join(__dirname, 'preload.js');

const AUTOSTART_VALUE = 'DSH Desk';
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

// 设置 Windows AppUserModelID：任务栏右键菜单/分组按此显示应用名，避免显示成 "Electron"
app.setAppUserModelId('com.dshdesk.app');

let mainWindow = null; // 主窗口：托盘开关、加载进度页、错误弹窗使用
let trayCtl = null;
let manager = null;
let usage = null; // DeepSeek 用量跟踪（余额 + 本次启动消费）
let isQuitting = false;
let autoStartEnabled = false;
const windows = new Set(); // 所有窗口（含主窗口），用于多窗口管理

// ---------- 窗口配色（每窗口独立主题色，持久化到 userData/theme.json） ----------
let themeStore = { mode: 'window', workspaceColors: {}, sessionColors: {}, notifications: { task: true, startup: true, error: true } };
// mode: 'window'（本窗口临时色，不持久化）| 'workspace'（按工作区记忆）| 'session'（按会话记忆）
// notifications: 系统通知开关（任务完成 / 启动成功 / 出错）

function themeFile() {
  return path.join(app.getPath('userData'), 'theme.json');
}

function loadThemeStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(themeFile(), 'utf8'));
    if (parsed && typeof parsed === 'object') {
      const mode = ['window', 'workspace', 'session'].includes(parsed.mode) ? parsed.mode : 'window';
      const n = parsed.notifications && typeof parsed.notifications === 'object' ? parsed.notifications : {};
      themeStore = {
        mode,
        workspaceColors:
          parsed.workspaceColors && typeof parsed.workspaceColors === 'object' ? parsed.workspaceColors : {},
        sessionColors:
          parsed.sessionColors && typeof parsed.sessionColors === 'object' ? parsed.sessionColors : {},
        notifications: {
          task: n.task !== false,
          startup: n.startup !== false,
          error: n.error !== false,
        },
      };
    }
  } catch {
    /* 首次运行：使用默认 */
  }
}

function saveThemeStore() {
  try {
    fs.writeFileSync(themeFile(), JSON.stringify(themeStore, null, 2));
  } catch {
    /* ignore */
  }
}

function nextWinId() {
  // 仅用于窗口显示编号；窗口色不再按窗口持久化
  const n = (themeStore.__winSeq || 1) + 1;
  themeStore.__winSeq = n;
  return n;
}

// 读取主题状态（预加载页初始化用）
ipcMain.handle('dsh-desk:theme-get', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  return {
    mode: themeStore.mode,
    workspaceColors: themeStore.workspaceColors,
    sessionColors: themeStore.sessionColors,
    winId: win ? win._winId : 1,
  };
});

// 按工作区/会话记忆颜色：校验 hex → 存入对应表
ipcMain.on('dsh-desk:theme-set', (_event, { scope, key, color }) => {
  if (scope !== 'workspace' && scope !== 'session') return;
  if (typeof key !== 'string' || key.trim() === '') return;
  const map = scope === 'workspace' ? themeStore.workspaceColors : themeStore.sessionColors;
  if (color === null || color === undefined || color === '') {
    delete map[key];
  } else if (typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)) {
    map[key] = color.toLowerCase();
  } else {
    return; // 非法输入：忽略
  }
  saveThemeStore();
  broadcastThemeState();
});

// 切换跟随模式（互斥；window 模式不持久化颜色）
ipcMain.on('dsh-desk:theme-mode', (_event, mode) => {
  if (!['window', 'workspace', 'session'].includes(mode)) return;
  themeStore.mode = mode;
  saveThemeStore();
  broadcastThemeState();
});

// 主题状态变化 → 同步给所有窗口（多窗口模式/颜色保持一致）
function broadcastThemeState() {
  const state = {
    mode: themeStore.mode,
    workspaceColors: themeStore.workspaceColors,
    sessionColors: themeStore.sessionColors,
  };
  for (const win of windows) {
    if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send('dsh-desk:theme-sync', state);
    }
  }
}

// 通知文案工具：截断为单行
function truncateText(s, max) {
  s = String(s == null ? '' : s);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

// 页面检测到 Harness 任务完成（且无排队消息等待）→ 系统通知
// 第二行显示对话名开头（截断为单行）
ipcMain.on('dsh-desk:task-complete', (_event, data) => {
  const session = data && typeof data.session === 'string' && data.session.trim() ? data.session.trim() : '';
  notifyIf('task', '任务完成', session ? truncateText(session, 40) : 'DeepSeek Harness 已完成任务');
});

// 托盘「通知 → 测试通知」：验证系统通知是否正常落地
ipcMain.on('dsh-desk:test-notification', () => {
  notify('测试通知', '如果看到这条，通知功能正常');
});

// 窗口标题统一由 page-title-updated 转换处理（见 createWindow），不再走 IPC

// 工作区检测诊断（写入 logs/diag.log）
ipcMain.on('dsh-desk:diag', (_event, data) => {
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'diag.log'), `${new Date().toISOString()} ${JSON.stringify(data)}\n`);
  } catch {
    /* ignore */
  }
});

// ---------- 系统通知 ----------
let notificationLogPath = null;

function logNotify(line) {
  if (!notificationLogPath) {
    try {
      notificationLogPath = path.join(app.getPath('userData'), 'logs', 'notify.log');
      fs.mkdirSync(path.dirname(notificationLogPath), { recursive: true });
    } catch {
      return;
    }
  }
  try {
    fs.appendFileSync(notificationLogPath, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* ignore */
  }
}

function notify(title, body) {
  try {
    const supported = Notification.isSupported();
    logNotify(`attempt: supported=${supported} title="${title}" body="${body}"`);
    if (!supported) {
      logNotify('skipped: Notification.isSupported() === false');
      return;
    }
    new Notification({ title, body, icon: ICON_PATH, silent: false }).show();
    logNotify('shown');
  } catch (err) {
    logNotify(`error: ${(err && err.message) || err}`);
  }
}

function notifyIf(type, title, body) {
  const n = themeStore.notifications || {};
  if (n[type] !== false) notify(title, body);
  else logNotify(`skipped (${type} disabled): "${title}"`);
}

function setNotification(type, enabled) {
  if (!['task', 'startup', 'error'].includes(type)) return;
  themeStore.notifications[type] = Boolean(enabled);
  saveThemeStore();
}

// ---------- 托盘状态图标（状态角标：在线绿 / 出错红 / 离线灰） ----------
function trayIconForState(state) {
  if (state === 'running' || state === 'attached') return TRAY_ONLINE_PATH;
  if (state === 'failed') return TRAY_ERROR_PATH;
  if (state === 'stopped') return TRAY_OFFLINE_PATH;
  return TRAY_ICON_PATH; // starting / 其他 → 基础
}

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
/**
 * 创建窗口。
 * @param {object} [opts]
 * @param {boolean} [opts.primary] 主窗口（默认 true）：点 ✕ 隐藏到托盘；附加窗口点 ✕ 直接关闭
 * @param {number} [opts.winId] 指定窗口 ID（主窗口固定 1；缺省时新窗口自动递增）
 */
function createWindow(opts = {}) {
  const isPrimary = opts.primary !== false;
  const winId = opts.winId ?? (isPrimary ? 1 : nextWinId());
  const win = new BrowserWindow({
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
  win.setMenuBarVisibility(false);
  win._winId = winId;

  // DSH 界面加载完成 → 重置加载重试计数（主题状态由 preload 自行通过 IPC 获取）

  // 窗口标题直接采用 DSH 页面自身的格式（"<会话名> — DeepSeek Harness"），
  // 不拦截、不转换，避免多写入者导致标题跳动

  // 主窗口点 ✕ → 隐藏到托盘（服务继续运行）；附加窗口点 ✕ → 直接关闭
  win.on('close', (e) => {
    if (!isQuitting && isPrimary) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    windows.delete(win);
    if (win === mainWindow) mainWindow = null;
  });

  // 外部链接交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (/^https?:/i.test(url) && !url.includes('127.0.0.1') && !url.includes('localhost')) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  // DSH 界面加载失败自动重试（ERR_ABORTED=-3 是正常取消，不重试）
  // 重试计数挂在窗口自身（win._loadRetries），多窗口互不干扰
  win._loadRetries = 0;
  win.webContents.on('did-fail-load', (_e, code, _desc, validatedURL, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    if (manager && manager.url && validatedURL === manager.url && win._loadRetries < 8) {
      win._loadRetries++;
      setTimeout(() => navigateTo(win, manager.url, true), 1200);
    }
  });
  win.webContents.on('did-finish-load', () => {
    win._loadRetries = 0;
  });

  windows.add(win);
  if (isPrimary) mainWindow = win;

  // 服务已就绪 → 加载 DSH 界面；否则加载启动进度页
  if (manager && manager.url) {
    navigateTo(win, manager.url);
  } else {
    win.loadFile(LOADING_HTML).catch(() => {});
  }
  return win;
}

function navigateTo(win, url, force = false) {
  if (!win || win.isDestroyed() || !url) return;
  // 普通调用：已在目标地址则跳过；force=true（加载失败重试）时强制重新加载，
  // 因为 did-fail-load 后 getURL() 仍可能是失败的那个 URL，会被上面的判断挡掉
  if (!force && win.webContents.getURL() === url) return;
  win.loadURL(url).catch(() => {});
}

function showMainWindow() {
  if (!mainWindow) createWindow({ primary: true });
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (manager && manager.url) {
    navigateTo(mainWindow, manager.url);
  } else if (!mainWindow.webContents.getURL()) {
    mainWindow.loadFile(LOADING_HTML).catch(() => {});
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

/** 新建一个独立窗口（多任务并行） */
function newWindow() {
  const win = createWindow({ primary: false });
  win.show();
  win.focus();
}

/** Windows 任务栏跳转列表：添加「新建窗口」任务 */
function setupJumpList() {
  if (process.platform !== 'win32') return;
  try {
    const args = app.isPackaged ? '--new-window' : `"${APP_DIR}" --new-window`;
    app.setUserTasks([
      {
        program: process.execPath,
        arguments: args,
        iconPath: TRAY_ICON_PATH,
        iconIndex: 0,
        title: '新建窗口',
        description: '打开一个新的 DSH Desk 窗口',
      },
    ]);
  } catch {
    /* 跳转列表设置失败不影响主功能 */
  }
}

// ---------- 状态 ----------
function updateStatus() {
  if (trayCtl) {
    // 状态角标图标：在线绿 / 出错红 / 离线灰
    const state = manager ? manager.state : 'stopped';
    try {
      trayCtl.tray.setImage(nativeImage.createFromPath(trayIconForState(state)));
    } catch {
      /* ignore */
    }
    trayCtl.refresh();
  }
  // 窗口标题由页面上报（侧边栏隐藏时显示会话名），此处不再强改
}

// 把 DSH 启动进度事件转发给所有窗口的加载页（loading.html 通过 preload 接收）
function sendToWindow(type, payload) {
  const data = { type, ...payload };
  for (const win of windows) {
    if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send('dsh-desk:event', data);
    }
  }
}

// ---------- 首次部署 ----------
let deployChild = null;

/** NO_LAUNCHER：弹窗让用户选择「自动安装 / 取消」，取消即退出 */
async function handleNoLauncher(message) {
  if (process.argv.includes('--autostart')) {
    // 自启模式：没有 Harness 无法运行，静默退出（不打扰用户）
    app.quit();
    return;
  }
  const opts = {
    type: 'warning',
    title: 'DSH Desk',
    message: '尚未部署 DeepSeek Harness',
    detail: `${message}\n\n是否现在自动安装？`,
    buttons: ['自动安装', '取消'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
  const box =
    mainWindow && !mainWindow.isDestroyed()
      ? dialog.showMessageBox(mainWindow, opts)
      : dialog.showMessageBox(opts);
  const { response } = await box;
  if (response === 0) {
    deployHarness();
  } else {
    quit();
  }
}

/** 首次部署：运行 npx @deepseek-ai/dsh --profile web 初始化，服务就绪后接管 */
async function deployHarness() {
  if (isQuitting || !manager) return;
  const { resolveNodeCommand, resolveNpxCli, dshHome, probeServer, DEFAULT_PORT } = require('./dsh-manager');
  const nodeCmd = resolveNodeCommand();
  const npxCli = resolveNpxCli();
  sendToWindow('stage', { key: 'deploy', label: '正在首次部署 DeepSeek Harness…', pct: 25 });
  if (!npxCli) {
    dialog.showErrorBox(
      '无法自动部署',
      `未找到 npm/npx（Node 路径：${nodeCmd}）。请手动运行：\nnpx @deepseek-ai/dsh --profile web`
    );
    return;
  }

  const child = spawn(nodeCmd, [npxCli, '@deepseek-ai/dsh', '--profile', 'web'], {
    windowsHide: true,
    cwd: os.homedir(),
    env: { ...process.env, DSH_HOME: dshHome(), NO_COLOR: '1', FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  deployChild = child;
  child.stdout.on('data', (d) => manager.emit('log', { stream: 'deploy', text: d.toString() }));
  child.stderr.on('data', (d) => manager.emit('log', { stream: 'deploy', text: d.toString() }));

  // 轮询等待 3080 出现 DSH 界面（首次部署含下载/初始化，最多等 3 分钟）
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1200));
    if (isQuitting) return;
    const probe = await probeServer(DEFAULT_PORT);
    if (probe === 'dsh') {
      if (child.exitCode === null) {
        // 部署进程仍存活 → 接管归本程序所有
        manager.adopt(`http://127.0.0.1:${DEFAULT_PORT}`, child);
      } else {
        // 部署进程已退出但 3080 已有 DSH（用户可能手动起了实例）：
        // 按普通附着处理，不接管外部进程
        manager._logLine(
          'info',
          'deploy child exited before ready but DSH is up on 3080; attaching instead of adopting'
        );
        manager.start().catch(() => {});
      }
      deployChild = null;
      return;
    }
    if (child.exitCode !== null) {
      dialog.showErrorBox(
        '首次部署失败',
        `部署进程已退出（退出码 ${child.exitCode}）。请手动运行：\nnpx @deepseek-ai/dsh --profile web`
      );
      deployChild = null;
      return;
    }
  }
  dialog.showErrorBox('首次部署超时', '部署超时（3 分钟）。请手动运行：\nnpx @deepseek-ai/dsh --profile web');
  deployChild = null;
}

// ---------- 托盘 ----------
function createTrayUI() {
  trayCtl = createTray({
    iconPath: TRAY_ICON_PATH,
    getState: () => ({
      state: manager ? manager.state : 'stopped',
      url: manager ? manager.url : null,
    }),
    getUsage: () => (usage ? usage.snapshot() : null),
    onRefreshUsage: () => {
      if (usage) usage.refresh().catch(() => {});
    },
    onResetUsage: () => {
      if (usage) usage.resetBaseline();
    },
    onOpenUsage: () => {
      shell.openExternal('https://platform.deepseek.com/usage');
    },
    getNotifications: () => themeStore.notifications,
    onToggleNotification: setNotification,
    onTestNotification: () => {
      notify('测试通知', '如果看到这条，通知功能正常');
    },
    isAutoStart: () => autoStartEnabled,
    onToggleAutoStart: async (enabled) => {
      await setAutoStart(enabled);
      autoStartEnabled = enabled;
      updateStatus();
    },
    onToggleWindow: toggleWindow,
    onNewWindow: newWindow,
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
  if (deployChild) {
    // 部署进行中退出：清掉部署进程树，避免残留
    try {
      execFile('taskkill', ['/pid', String(deployChild.pid), '/T', '/F'], { windowsHide: true }, () => {});
    } catch {
      /* ignore */
    }
    deployChild = null;
  }
  if (manager) {
    try {
      await manager.stop(); // 停掉由我们启动的 DSH 进程树
    } catch {
      /* ignore */
    }
  }
  if (usage) usage.stop();
  app.quit();
}

// ---------- 启动 ----------
async function init() {
  try {
    if (!app.requestSingleInstanceLock()) {
      // 已有实例在运行：让主实例处理（带出窗口或新建窗口），本实例兜底强制退出
      // （app.quit() 挂起时会出现“启动无反应/黑屏”，用定时器确保进程结束）
      app.quit();
      setTimeout(() => process.exit(0), 1500);
      return;
    }
    app.on('second-instance', (_e, argv) => {
      if (argv.includes('--new-window')) {
        newWindow(); // 任务栏跳转列表「新建窗口」→ 在现有实例中开新窗口
      } else {
        showMainWindow();
      }
    });

    loadThemeStore();
    manager = new DshManager({ logDir: path.join(app.getPath('userData'), 'logs') });
    manager.on('stage', (stage) => {
      updateStatus();
      sendToWindow('stage', stage);
    });
    manager.on('ready', ({ url, attached }) => {
      updateStatus();
      sendToWindow('ready', { url, attached });
      // 启动成功通知（自启模式不打扰）
      if (!process.argv.includes('--autostart')) {
        notifyIf('startup', 'DeepSeek Harness 已就绪', attached ? `已附着到 ${url}` : `服务已启动：${url}`);
      }
      // 所有窗口（含最小化/不可见）都切到 DSH 界面
      for (const win of windows) {
        if (!win.isDestroyed()) navigateTo(win, url);
      }
    });
    manager.on('stopped', updateStatus);
    manager.on('log', (entry) => sendToWindow('log', entry));
    manager.on('failed', ({ code, message }) => {
      updateStatus();
      sendToWindow('failed', { code, message });
      if (isQuitting) return;
      notifyIf(
        'error',
        'DSH 服务出错',
        truncateText(code === 'NO_LAUNCHER' ? '未找到 DSH 启动器' : message.split('\n')[0], 90)
      );
      if (code === 'NO_LAUNCHER') {
        handleNoLauncher(message);
        return;
      }
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

    // DeepSeek 用量跟踪：余额 + 本次启动消费（基线 = 启动时余额），每 30s 刷新（匹配网页端）
    usage = new UsageTracker();
    usage.on('updated', updateStatus);
    usage.start(30000);

    createTrayUI();
    setupJumpList();

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
