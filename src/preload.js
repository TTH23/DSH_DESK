'use strict';
// 预加载桥：
// 1) 把主进程的 stage/log/ready/failed 事件转发给加载页（loading.html）
// 2) 窗口配色：在 DSH 网页内注入悬浮调色板（每窗口独立），选色后给该窗口
//    加主题色顶栏 + 彩色按钮，用于多窗口互相区分（颜色由主进程按窗口持久化）
// 3) 调色板按钮动态锚定到设置键（侧边栏底部齿轮，aria-haspopup=dialog）正上方，
//    避免遮挡交互区；找不到时回退到发送键/输入框上方，再回退到安全位置，
//    并持续跟随布局变化（滚动/缩放/重渲染）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshDesk', {
  onEvent: (callback) => {
    ipcRenderer.on('dsh-desk:event', (_event, data) => callback(data));
  },
});

// ---------- 窗口配色 ----------
const PRESETS = ['#4da3ff', '#34d399', '#22d3ee', '#a78bfa', '#f472b6', '#fb923c', '#f87171', '#94a3b8'];
const BTN_SIZE = 40;
let currentColor = null; // '#rrggbb' 或 null
let winId = null;

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

// 把调色板按钮（及展开面板）放在设置键正上方：水平贴住屏幕左侧边框（侧边栏内，
// 不悬浮到内容区中央）；找不到设置键时回退到发送键/输入框上方，最后回退到
// 右下角偏上位置
function positionPalette() {
  const btn = document.getElementById('dsh-desk-palette-btn');
  const panel = document.getElementById('dsh-desk-palette');
  if (!btn) return;
  const settingsBtn = findSettingsButton();
  const anchor = settingsBtn || findComposer().sendBtn || findComposer().textarea;
  if (anchor) {
    const r = anchor.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && r.top > 0) {
      const gap = 10;
      const bottom = Math.max(4, window.innerHeight - r.top + gap);
      if (settingsBtn) {
        // 设置键锚定：贴住左侧边框（侧边栏内）
        btn.style.left = '6px';
      } else {
        // 发送键/输入框锚定：水平居中于锚点上方
        btn.style.left = Math.max(4, r.left + r.width / 2 - BTN_SIZE / 2) + 'px';
      }
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

// 颜色工具：hex → rgba（用于派生半透明变体）
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

// 真实页面元素着色：覆盖 DSH 主题 token（按钮/链接/选中态/悬停底色跟随所选色）。
// 基础样式表把 token 定义在 body / body[data-ds-dark-theme] 上（CSS 变量就近继承，
// 只覆盖 :root 无效），因此这里同样以 body 为目标选择器 + !important 压过它。
const THEME_TOKEN_VARS = [
  ['--dsw-alias-brand-primary', (c) => c],
  ['--dsw-alias-state-business-primary', (c) => c],
  ['--dsw-alias-state-business-tertiary', (c) => rgba(c, 0.22)],
  ['--dsw-alias-interactive-bg-hover', (c) => rgba(c, 0.12)],
  ['--dsw-alias-interactive-bg-active', (c) => rgba(c, 0.18)],
];

function applyTokenOverrides(color) {
  let style = document.getElementById('dsh-desk-theme-override');
  const body = document.body;
  if (!color) {
    if (style) style.remove();
    // 移除 body 内联覆盖
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
    // 双保险：body 内联 !important（防主题运行时以同样方式覆盖）
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
  // 真实页面元素着色
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

function buildPalette() {
  const root = document.createElement('div');
  root.id = 'dsh-desk-palette';
  root.style.cssText =
    'position:fixed;z-index:2147483647;background:#10141c;' +
    'border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:10px 12px;' +
    'box-shadow:0 8px 32px rgba(0,0,0,.5);display:none;width:200px;' +
    'font-family:"Segoe UI","Microsoft YaHei",sans-serif;color:#d7e3f4;';
  // 标题行：窗口名（左）+ 清除按钮（右），节省高度
  const titleRow = document.createElement('div');
  titleRow.style.cssText =
    'display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;';
  const title = document.createElement('div');
  title.style.cssText = 'font-size:12px;color:#9fb0c9;';
  title.textContent = `窗口 ${winId ?? ''} 配色`;
  const clear = document.createElement('button');
  clear.textContent = '清除';
  clear.style.cssText =
    'padding:2px 10px;border-radius:6px;border:1px solid rgba(255,255,255,.2);' +
    'background:transparent;color:#9fb0c9;cursor:pointer;font-size:12px;';
  clear.addEventListener('click', () => pick(null));
  titleRow.appendChild(title);
  titleRow.appendChild(clear);
  // 预设色板网格（只提供预设，不提供自定义取色）
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
  root.appendChild(titleRow);
  root.appendChild(grid);
  return root;
}

function pick(color) {
  // 交给主进程校验并持久化；随后主进程回发 dsh-desk:theme 应用
  ipcRenderer.send('dsh-desk:set-color', color);
  const palette = document.getElementById('dsh-desk-palette');
  if (palette) palette.style.display = 'none';
}

// 页面是否“正常”：锚点（设置键/发送键/输入框）已渲染且稳定出现（连续 2 次探测），
// 避免在页面加载/骨架屏阶段过早显示悬浮球
let pageReadyCount = 0;

function checkPageReady() {
  const anchor = findSettingsButton() || findComposer().sendBtn || findComposer().textarea;
  pageReadyCount = anchor ? pageReadyCount + 1 : 0;
  if (pageReadyCount >= 2) {
    const btn = document.getElementById('dsh-desk-palette-btn');
    if (btn && btn.style.display === 'none') {
      btn.style.display = 'flex';
    }
  }
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
      positionPalette(); // 打开时重新对齐
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
  applyTheme(currentColor);

  // 跟随布局变化：滚动/缩放/输入框高度变化等；定时探测页面就绪、重放主题色覆盖并重新对齐
  window.addEventListener('scroll', positionPalette, true);
  window.addEventListener('resize', positionPalette);
  setInterval(() => {
    checkPageReady();
    applyTokenOverrides(currentColor); // 防止深浅主题切换/重渲染时被重置
    positionPalette();
  }, 1200);
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

// 主进程下发主题：{ color, winId }
ipcRenderer.on('dsh-desk:theme', (_event, { color, winId: id }) => {
  winId = id;
  currentColor = color || null;
  if (location.protocol === 'http:') {
    if (!document.getElementById('dsh-desk-palette-btn')) initPicker();
    applyTheme(currentColor);
  }
});
