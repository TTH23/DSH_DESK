'use strict';
// 预加载桥：
// 1) 把主进程的 stage/log/ready/failed 事件转发给加载页（loading.html）
// 2) 窗口配色（每窗口独立）：
//    - 菜单：预设色板 + 清除 + 互斥跟随开关（颜色随工作区 / 颜色随会话）
//    - 跟随模式下按工作区/会话标题记忆颜色（持久化到 theme.json），切换时自动换色
//    - 都关闭 = 窗口固定色：只在本窗口会话内生效，重启回归默认（不持久化）
//    - 点选颜色不自动关闭菜单
// 3) 调色板按钮动态锚定到设置键（侧边栏底部齿轮）正上方、贴左边缘，
//    找不到时回退到发送键/输入框上方，再回退到安全位置；页面正常后才显示
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshDesk', {
  onEvent: (callback) => {
    ipcRenderer.on('dsh-desk:event', (_event, data) => callback(data));
  },
  getTheme: () => ipcRenderer.invoke('dsh-desk:theme-get'),
});

// preload 隔离世界内直接用 ipcRenderer（window.dshDesk 只存在于页面世界）
function getThemeState() {
  return ipcRenderer.invoke('dsh-desk:theme-get');
}

// 其他窗口改了模式/颜色 → 主进程广播同步，本窗口立即生效
ipcRenderer.on('dsh-desk:theme-sync', (_event, t) => {
  if (!t) return;
  if (['window', 'workspace', 'session'].includes(t.mode)) themeMode = t.mode;
  if (t.workspaceColors && typeof t.workspaceColors === 'object') wsColors = t.workspaceColors;
  if (t.sessionColors && typeof t.sessionColors === 'object') sesColors = t.sessionColors;
  applyTheme(resolveColor());
  updatePaletteUI();
});

// ---------- 窗口配色状态 ----------
const PRESETS = ['#4da3ff', '#34d399', '#22d3ee', '#a78bfa', '#f472b6', '#fb923c', '#f87171', '#94a3b8'];
const BTN_SIZE = 40;
const WS_PLACEHOLDERS = ['选择工作区', 'Choose workspace'];
const WS_SELECTOR =
  'button[aria-label="选择工作区"], button[aria-label="Choose workspace"]';
const SESS_NAV_SELECTOR =
  'nav[aria-label="会话层级"], nav[aria-label="Session hierarchy"]';

let themeMode = 'window'; // window | workspace | session
let wsColors = {}; // 工作区标题 → 颜色
let sesColors = {}; // 会话标题 → 颜色
let winLabel = '窗口 1';
let windowColor = null; // window 模式：本窗口临时色（不持久化）
let currentColor = null; // 当前已应用的颜色
let lastWorkspaceKey = ''; // 最近一次可见的工作区标题（会话内回退用）
let prevWsKey = null;
let prevSesKey = null;
let stateLoaded = false;

// 会话层级 nav 里当前会话（disabled 的 crumb）文本 = 当前会话标题
function currentSessionKey() {
  const nav = document.querySelector(SESS_NAV_SELECTOR);
  if (nav) {
    const cur = nav.querySelector('button[disabled]');
    if (cur) return (cur.textContent || '').trim();
  }
  return '';
}

function detectContext() {
  const sesKey = currentSessionKey();
  let wsKey = '';
  // ① hero 页的工作区芯片
  const wsBtn = document.querySelector(WS_SELECTOR);
  if (wsBtn) {
    const label = (wsBtn.textContent || '').trim();
    if (label && !WS_PLACEHOLDERS.includes(label)) wsKey = label;
  }
  // ② 会话内：侧边栏工作区树定位
  if (!wsKey) wsKey = detectWorkspaceInSidebar(sesKey) || '';
  // ③ 回退：最近一次可见的工作区
  if (!wsKey) wsKey = lastWorkspaceKey;
  if (wsKey) lastWorkspaceKey = wsKey;
  return { wsKey, sesKey };
}

const ACTION_LABEL_RE = /^工作区["“「]([^"”」]+)["”」]|^Workspace actions for (.+)/;
// 只匹配真正的工作区行：操作按钮 aria-label 以 工作区/Workspace actions 开头
// （会话行是 "会话"{name}"的操作"，不能算）
const WS_ACTION_SEL =
  'button[aria-label^="工作区"], button[aria-label^="Workspace actions"]';

function workspaceNameOf(row) {
  const btn = row.querySelector(WS_ACTION_SEL);
  const m = ACTION_LABEL_RE.exec((btn && btn.getAttribute('aria-label')) || '');
  return m ? (m[1] || m[2] || '').trim() : '';
}

// 侧边栏工作区定位（对 HoverCard wrapper 免疫）：
// 每行被 <span> wrapper 包裹（HoverCard），会话行与工作区行是同一分组区下的兄弟。
// 从每个工作区行出发，向上找到同时含会话行的分组区，再匹配当前会话标题。
function detectWorkspaceInSidebar(sesKey) {
  if (!sesKey) return null;
  for (const row of document.querySelectorAll('[role="treeitem"]')) {
    if (!row.querySelector(WS_ACTION_SEL)) continue;
    const name = workspaceNameOf(row);
    if (!name) continue;
    // 向上找同时包含会话行的容器 = 该工作区的分组区
    let section = row.parentElement;
    let hops = 0;
    while (section && section !== document.body && hops < 4) {
      const hasSession = Array.from(section.querySelectorAll('[role="treeitem"]')).some(
        (r) => r !== row && !r.querySelector(WS_ACTION_SEL)
      );
      if (hasSession) break;
      hops++;
      section = section.parentElement;
    }
    if (section && section.textContent.includes(sesKey)) return name;
  }
  return null;
}

// 工作区检测诊断（工作区模式仍解析不到时上报，便于定位真实 DOM 结构）
function reportWorkspaceDiag(wsKey, sesKey) {
  const rows = Array.from(document.querySelectorAll('[role="treeitem"]'));
  const wsRows = rows.filter((r) => r.querySelector(WS_ACTION_SEL));
  const ariaSelected = rows.filter((r) => r.getAttribute('aria-selected') === 'true').length;
  ipcRenderer.send('dsh-desk:diag', {
    wsKey: wsKey || '',
    sesKey: sesKey || '',
    treeitemCount: rows.length,
    workspaceRowCount: wsRows.length,
    ariaSelectedCount: ariaSelected,
    wsRowLabels: wsRows.slice(0, 5).map((r) => {
      const btn = r.querySelector(WS_ACTION_SEL);
      return (btn && btn.getAttribute('aria-label')) || '';
    }),
  });
}

// 当前应显示的颜色：按模式 + 上下文解析（无匹配 → 默认）
function resolveColor() {
  const { wsKey, sesKey } = detectContext();
  if (themeMode === 'workspace') return wsKey ? wsColors[wsKey] || null : null;
  if (themeMode === 'session') return sesKey ? sesColors[sesKey] || null : null;
  return windowColor;
}

// 查找设置触发键：侧边栏底部的齿轮按钮（aria-haspopup=dialog，含 "设置"/"Settings" 文案或为最左侧的 dialog 触发键）
function findSettingsButton() {
  const candidates = Array.from(
    document.querySelectorAll('button[aria-haspopup="dialog"]')
  ).filter((b) => {
    const r = b.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  if (!candidates.length) return null;
  const labeled = candidates.filter((b) => /设置|Settings/.test(b.textContent || ''));
  const pool = labeled.length ? labeled : candidates;
  // 侧边栏在页面左侧：取最靠左的（设置键位于侧边栏底部）
  pool.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
  return pool[0];
}

// 查找主输入区的锚点（回退用）：优先发送/停止按钮，其次主 textarea
function findComposer() {
  const sendBtn = document.querySelector(
    'button[aria-label="发送消息"], button[aria-label="Send message"], ' +
      'button[aria-label="停止生成"], button[aria-label="Stop generating"]'
  );
  let textarea =
    document.querySelector(
      'textarea[placeholder="给智能体发消息"], textarea[placeholder="Message the agent"]'
    ) || null;
  if (!textarea) {
    // 兜底：取页面上面积最大的 textarea（通常是主输入框）
    let best = null;
    for (const t of document.querySelectorAll('textarea')) {
      const r = t.getBoundingClientRect();
      if (r.width > 4 && r.height > 4) {
        const area = r.width * r.height;
        if (!best || area > best.area) best = { el: t, area };
      }
    }
    textarea = best ? best.el : null;
  }
  return { sendBtn, textarea };
}

// 把调色板按钮（及展开面板）放在设置键上方：贴住屏幕左侧边框（侧边栏内）。
// 垂直用固定底部偏移（不跟随设置键的垂直位置——侧边栏收放/动画时设置键会上下
// 移动，跟随会导致悬浮球高度跳动）；找不到设置键时回退到发送键/输入框上方，
// 最后回退到右下角偏上位置
const SIDEBAR_BOTTOM_PX = 76; // 侧边栏锚定时的固定底部偏移（稳定不跳动）
function positionPalette() {
  const btn = document.getElementById('dsh-desk-palette-btn');
  const panel = document.getElementById('dsh-desk-palette');
  if (!btn) return;
  const settingsBtn = findSettingsButton();
  if (settingsBtn) {
    const r = settingsBtn.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && r.top > 0) {
      // 侧边栏锚定：贴左边缘 + 固定底部
      btn.style.left = '6px';
      btn.style.right = 'auto';
      btn.style.bottom = SIDEBAR_BOTTOM_PX + 'px';
      btn.classList.add('dsh-desk-anchored');
      if (panel) {
        panel.style.left = '6px';
        panel.style.right = 'auto';
        panel.style.bottom = SIDEBAR_BOTTOM_PX + BTN_SIZE + 10 + 'px';
      }
      return;
    }
  }
  const anchor = findComposer().sendBtn || findComposer().textarea;
  if (anchor) {
    const r = anchor.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && r.top > 0) {
      const gap = 10;
      const bottom = Math.max(4, window.innerHeight - r.top + gap);
      // 发送键/输入框锚定：水平居中于锚点上方
      btn.style.left = Math.max(4, r.left + r.width / 2 - BTN_SIZE / 2) + 'px';
      btn.style.right = 'auto';
      btn.style.bottom = bottom + 'px';
      btn.classList.add('dsh-desk-anchored');
      if (panel) {
        panel.style.left = btn.style.left;
        panel.style.right = 'auto';
        panel.style.bottom = bottom + BTN_SIZE + 10 + 'px';
      }
      return;
    }
  }
  // 兜底：右下角偏上，避开常见交互区
  btn.style.right = '16px';
  btn.style.left = 'auto';
  btn.style.bottom = '96px';
  btn.classList.remove('dsh-desk-anchored');
  if (panel) {
    panel.style.right = '16px';
    panel.style.left = 'auto';
    panel.style.bottom = '152px';
  }
}

// 颜色工具：hex → rgba / lighten（用于派生半透明与浅色变体）
function hexToRgb(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function rgba(hex, alpha) {
  const c = hexToRgb(hex);
  return c ? `rgba(${c.r},${c.g},${c.b},${alpha})` : hex;
}
function lighten(hex, factor) {
  const c = hexToRgb(hex);
  if (!c) return hex;
  const mix = (v) => Math.round(v + (255 - v) * factor);
  return `rgb(${mix(c.r)},${mix(c.g)},${mix(c.b)})`;
}

// 真实页面元素着色：覆盖 DSH 主题 token（按钮/链接/选中态/悬停底色跟随所选色）。
// 基础样式表把 token 定义在 body / body[data-ds-dark-theme] 上（CSS 变量就近继承，
// 只覆盖 :root 无效），因此这里同样以 body 为目标选择器 + !important 压过它。
const THEME_TOKEN_VARS = [
  ['--dsw-alias-brand-primary', (c) => c],
  ['--dsw-alias-state-business-primary', (c) => c],
  ['--dsw-alias-state-business-tertiary', (c) => rgba(c, 0.22)],
  ['--dsw-alias-interactive-bg-hover', (c) => rgba(c, 0.12)],
  ['--dsw-alias-interactive-bg-active', (c) => rgba(c, 0.18)],
  // 发送/停止按钮底色（原为 deepseek 品牌蓝）
  ['--dsw-alias-button-info-fill', (c) => c],
  ['--dsw-alias-button-info-hover', (c) => lighten(c, 0.2)],
  // 静态品牌色："Deep diving..." 等文字渐变/logo/品牌点缀
  ['--dsw-static-deepseek-500', (c) => c],
  ['--dsw-static-deepseek-400', (c) => lighten(c, 0.2)],
  ['--dsw-static-deepseek-200', (c) => lighten(c, 0.55)],
];

function applyTokenOverrides(color) {
  let style = document.getElementById('dsh-desk-theme-override');
  const body = document.body;
  if (!color) {
    if (style) style.remove();
    if (body) {
      for (const [name] of THEME_TOKEN_VARS) body.style.removeProperty(name);
    }
    return;
  }
  if (!style) {
    style = document.createElement('style');
    style.id = 'dsh-desk-theme-override';
    document.documentElement.appendChild(style);
  }
  const lines = [':root, body, body[data-ds-dark-theme] {'];
  for (const [name, derive] of THEME_TOKEN_VARS) {
    const value = derive(color);
    lines.push(`  ${name}: ${value} !important;`);
    if (body) body.style.setProperty(name, value, 'important');
  }
  lines.push('}');
  style.textContent = lines.join('\n');
}

function applyTheme(color) {
  currentColor = color;
  // 顶部主题色条
  let bar = document.getElementById('dsh-desk-accent-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'dsh-desk-accent-bar';
    bar.style.cssText =
      'position:fixed;top:0;left:0;right:0;height:4px;z-index:2147483647;pointer-events:none;';
    document.documentElement.appendChild(bar);
  }
  bar.style.background = color || 'transparent';
  applyTokenOverrides(color);
  // 按钮底色跟随主题色
  const btn = document.getElementById('dsh-desk-palette-btn');
  if (btn) {
    btn.style.background = color
      ? `linear-gradient(135deg, ${color}, ${color}cc)`
      : 'linear-gradient(135deg, #167af2, #4da3ff)';
    positionPalette();
  }
}

// ---------- 选色 / 清除 / 模式 ----------
function pick(color) {
  if (themeMode === 'window') {
    windowColor = color; // 本窗口临时色，不持久化
    applyTheme(windowColor);
    return;
  }
  const { wsKey, sesKey } = detectContext();
  const key = themeMode === 'workspace' ? wsKey : sesKey;
  if (key) {
    const map = themeMode === 'workspace' ? wsColors : sesColors;
    if (color) map[key] = color;
    else delete map[key];
    ipcRenderer.send('dsh-desk:theme-set', { scope: themeMode, key, color });
    applyTheme(color);
  } else {
    // 无法解析跟随目标：退化为本窗口临时色（不持久化）
    windowColor = color;
    applyTheme(windowColor);
  }
}

function setMode(mode) {
  if (mode !== 'window' && mode !== 'workspace' && mode !== 'session') return;
  themeMode = mode;
  ipcRenderer.send('dsh-desk:theme-mode', mode);
  applyTheme(resolveColor());
  updatePaletteUI();
}

// ---------- 面板 UI ----------
function updatePaletteUI() {
  const wsDot = document.getElementById('dsh-desk-mode-ws');
  const sesDot = document.getElementById('dsh-desk-mode-ses');
  if (wsDot) {
    wsDot.textContent = themeMode === 'workspace' ? '●' : '○';
    wsDot.style.color = themeMode === 'workspace' ? '#4da3ff' : '#5c6b84';
  }
  if (sesDot) {
    sesDot.textContent = themeMode === 'session' ? '●' : '○';
    sesDot.style.color = themeMode === 'session' ? '#4da3ff' : '#5c6b84';
  }
}

function buildPalette() {
  const root = document.createElement('div');
  root.id = 'dsh-desk-palette';
  root.style.cssText =
    'position:fixed;z-index:2147483647;background:#10141c;' +
    'border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:10px 12px;' +
    'box-shadow:0 8px 32px rgba(0,0,0,.5);display:none;width:232px;' +
    'font-family:"Segoe UI","Microsoft YaHei",sans-serif;color:#d7e3f4;';

  // 互斥跟随开关 + 清除（同一行，清除靠右）
  const modeRow = document.createElement('div');
  modeRow.style.cssText =
    'display:flex;align-items:center;gap:2px;margin-bottom:8px;font-size:12px;';
  const mkMode = (id, text, mode) => {
    const row = document.createElement('div');
    row.style.cssText =
      'display:flex;align-items:center;gap:4px;cursor:pointer;padding:3px 5px;' +
      'border-radius:6px;color:#c3d0e4;user-select:none;white-space:nowrap;';
    row.addEventListener('mouseenter', () => {
      row.style.background = 'rgba(255,255,255,.06)';
    });
    row.addEventListener('mouseleave', () => {
      row.style.background = 'transparent';
    });
    const dot = document.createElement('span');
    dot.id = id;
    dot.style.cssText = 'font-size:11px;width:12px;color:#5c6b84;';
    const label = document.createElement('span');
    label.textContent = text;
    row.appendChild(dot);
    row.appendChild(label);
    row.addEventListener('click', () => {
      // 互斥：点中当前项则关闭（回到窗口模式），否则切换
      setMode(themeMode === mode ? 'window' : mode);
    });
    return row;
  };
  const clear = document.createElement('button');
  clear.textContent = '清除';
  clear.style.cssText =
    'margin-left:auto;padding:2px 8px;border-radius:6px;border:1px solid rgba(255,255,255,.2);' +
    'background:transparent;color:#9fb0c9;cursor:pointer;font-size:11px;flex:none;';
  clear.addEventListener('click', () => pick(null));
  modeRow.appendChild(mkMode('dsh-desk-mode-ws', '颜色随工作区', 'workspace'));
  modeRow.appendChild(mkMode('dsh-desk-mode-ses', '颜色随会话', 'session'));
  modeRow.appendChild(clear);

  // 预设色板网格
  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(4,1fr);gap:8px;';
  for (const c of PRESETS) {
    const sw = document.createElement('div');
    sw.style.cssText =
      `height:26px;border-radius:8px;background:${c};cursor:pointer;` +
      'border:2px solid rgba(255,255,255,.08);';
    sw.dataset.color = c;
    sw.title = c;
    sw.addEventListener('click', () => pick(c));
    grid.appendChild(sw);
  }

  root.appendChild(modeRow);
  root.appendChild(grid);
  return root;
}

// 页面是否“正常”：锚点（设置键/发送键/输入框）已渲染且稳定出现（连续 2 次探测）
let pageReadyCount = 0;

function checkPageReady() {
  const anchor = findSettingsButton() || findComposer().sendBtn || findComposer().textarea;
  pageReadyCount = anchor ? pageReadyCount + 1 : 0;
  if (pageReadyCount >= 2) {
    const btn = document.getElementById('dsh-desk-palette-btn');
    if (btn && btn.style.display === 'none') btn.style.display = 'flex';
  }
}

async function initThemeState() {
  try {
    const t = await getThemeState();
    if (t) {
      themeMode = ['window', 'workspace', 'session'].includes(t.mode) ? t.mode : 'window';
      wsColors = t.workspaceColors || {};
      sesColors = t.sessionColors || {};
      if (t.winId) winLabel = `窗口 ${t.winId}`;
    }
  } catch {
    /* 保持默认 */
  }
  stateLoaded = true;
  applyTheme(resolveColor());
  updatePaletteUI();
}

function initPicker() {
  if (document.getElementById('dsh-desk-palette-btn')) return;
  const btn = document.createElement('div');
  btn.id = 'dsh-desk-palette-btn';
  btn.title = '窗口配色';
  btn.textContent = '🎨';
  btn.style.cssText =
    `position:fixed;width:${BTN_SIZE}px;height:${BTN_SIZE}px;border-radius:50%;` +
    'z-index:2147483646;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.4);' +
    'display:none;align-items:center;justify-content:center;font-size:18px;' +
    'opacity:.92;transition:opacity .15s;'; // 初始隐藏，页面正常后才显示
  btn.addEventListener('mouseenter', () => {
    btn.style.opacity = '1';
  });
  btn.addEventListener('mouseleave', () => {
    btn.style.opacity = '.92';
  });
  btn.addEventListener('click', () => {
    const palette = document.getElementById('dsh-desk-palette');
    if (palette) {
      palette.style.display = palette.style.display === 'none' ? 'block' : 'none';
      updatePaletteUI();
      positionPalette();
    }
  });
  // 点击面板与按钮之外任意处 → 关闭配色菜单
  document.addEventListener('click', (e) => {
    const palette = document.getElementById('dsh-desk-palette');
    const b = document.getElementById('dsh-desk-palette-btn');
    if (!palette || !b || palette.style.display === 'none') return;
    if (!palette.contains(e.target) && !b.contains(e.target)) {
      palette.style.display = 'none';
    }
  });
  document.documentElement.appendChild(btn);
  document.documentElement.appendChild(buildPalette());
  initThemeState();

  // 上下文变化即时检测：MutationObserver 监听会话面包屑/工作区芯片的 DOM 变化，
  // 切换会话/工作区时立即换色（不再等 1.2s 轮询）；消息流式输出不影响它们，零负担
  const ctxTimer = { id: null };
  const scheduleContextCheck = () => {
    if (ctxTimer.id) return;
    ctxTimer.id = setTimeout(() => {
      ctxTimer.id = null;
      checkContextChanged();
    }, 25); // 防抖收紧：切换会话后 ~25ms 内换色
  };
  const ctxSelector = SESS_NAV_SELECTOR + ', ' + WS_SELECTOR;
  try {
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        const el = m.target && m.target.nodeType === 1 ? m.target : m.target && m.target.parentElement;
        if (el && el.closest && el.closest(ctxSelector)) {
          scheduleContextCheck();
          return;
        }
        if (m.addedNodes) {
          for (const n of m.addedNodes) {
            if (n.nodeType === 1 && n.matches && n.matches(ctxSelector)) {
              scheduleContextCheck();
              return;
            }
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  } catch {
    /* 不支持 MutationObserver 时退回轮询 */
  }

  // 跟随布局变化与上下文变化（轮询作兜底：防重渲染/路由切换漏检）
  window.addEventListener('scroll', positionPalette, true);
  window.addEventListener('resize', positionPalette);
  setInterval(() => {
    checkPageReady();
    checkContextChanged();
    checkTaskState();
    sendTitleIfNeeded(); // 侧边栏隐藏时窗口标题显示当前会话名
    applyTokenOverrides(currentColor); // 防止深浅主题切换/重渲染时被重置
    positionPalette();
  }, 1200);
}

// ---------- 窗口标题：始终跟随当前会话名 ----------
let lastSentTitle = null;

function sendTitleIfNeeded() {
  if (location.protocol !== 'http:') return;
  const { sesKey } = detectContext();
  const title = sesKey ? `DSH Desk · ${sesKey}` : 'DSH Desk';
  if (title !== lastSentTitle) {
    lastSentTitle = title;
    ipcRenderer.send('dsh-desk:title', title);
  }
}

// 上下文（工作区/会话）变化 → 按新模式重算颜色（即时监听与轮询共用）
let followUpScheduled = false;
let lastDiagAt = 0;
function checkContextChanged() {
  const { wsKey, sesKey } = detectContext();
  if (wsKey !== prevWsKey || sesKey !== prevSesKey) {
    prevWsKey = wsKey;
    prevSesKey = sesKey;
    applyTheme(resolveColor());
    updatePaletteUI();
    sendTitleIfNeeded(); // 会话切换 → 标题立即跟随
    // 侧边栏工作区树可能比面包屑晚一步更新：400ms 后复查一次
    if (!followUpScheduled) {
      followUpScheduled = true;
      setTimeout(() => {
        followUpScheduled = false;
        checkContextChanged();
      }, 400);
    }
  }
  // 工作区模式解析不到工作区 → 上报诊断（限频 10s，便于定位真实 DOM）
  if (themeMode === 'workspace' && !wsKey) {
    const now = Date.now();
    if (now - lastDiagAt > 10000) {
      lastDiagAt = now;
      reportWorkspaceDiag(wsKey, sesKey);
    }
  }
}

// ---------- 任务完成通知检测 ----------
// 运行中 = 存在"停止生成"按钮；从运行→空闲且无排队/插话队列等待 → 任务完成
const STOP_BTN_SEL = 'button[aria-label="停止生成"], button[aria-label="Stop generating"]';
const QUEUE_SEL =
  '[aria-label*="排队消息"], [aria-label*="queued message"], [aria-label*="插话发送"], ' +
  '[aria-label*="Steer"], textarea[placeholder*="排队消息"], textarea[placeholder*="queued"]';
let wasTaskRunning = false;
let taskTrackSession = ''; // 正在跟踪的会话（切换会话时重置，避免误报）
let idleTicks = 0; // 空闲持续确认次数（连续 2 次才发，防 DOM 切换竞态）

function hasQueuedMessages() {
  return Boolean(document.querySelector(QUEUE_SEL));
}

function checkTaskState() {
  const { sesKey } = detectContext();
  const running = Boolean(document.querySelector(STOP_BTN_SEL));
  // 会话切换：重置跟踪但记录新会话的当前运行状态（避免误报，也不丢运行中状态）
  if (sesKey !== taskTrackSession) {
    taskTrackSession = sesKey;
    wasTaskRunning = running;
    idleTicks = 0;
    return;
  }
  if (running) {
    wasTaskRunning = true;
    idleTicks = 0;
    return;
  }
  // 当前会话内空闲：先确认两次（同一会话、无排队）才发"任务完成"（附会话名）
  if (wasTaskRunning) {
    idleTicks++;
    if (idleTicks >= 2 && !hasQueuedMessages()) {
      ipcRenderer.send('dsh-desk:task-complete', { session: sesKey });
      wasTaskRunning = false;
      idleTicks = 0;
    }
  } else {
    idleTicks = 0;
  }
}

function onDomReady() {
  // 仅 DSH 网页（http）注入调色板；loading 页（file://）不显示
  if (location.protocol === 'http:') initPicker();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', onDomReady);
} else {
  onDomReady();
}
