'use strict';
// 预加载桥：
// 1) 把主进程的 stage/log/ready/failed 事件转发给加载页（loading.html）
// 2) 窗口配色：在 DSH 网页内注入悬浮调色板（每窗口独立），选色后给该窗口
//    加主题色顶栏 + 彩色按钮，用于多窗口互相区分（颜色由主进程按窗口持久化）
// 3) 调色板按钮动态锚定到发送键（aria-label=发送消息/Send message，运行时为
//    停止/Stop）正上方，避免遮挡输入区；找不到时回退到安全位置并持续跟随布局
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

// 查找主输入区的锚点：优先发送/停止按钮，其次主 textarea
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

// 把调色板按钮（及展开面板）锚定到锚点正上方，右缘对齐
function positionPalette() {
  const btn = document.getElementById('dsh-desk-palette-btn');
  const panel = document.getElementById('dsh-desk-palette');
  if (!btn) return;
  const { sendBtn, textarea } = findComposer();
  const anchor = sendBtn || textarea;
  if (anchor) {
    const r = anchor.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && r.top > 0) {
      const gap = 12;
      const right = Math.max(8, window.innerWidth - r.right);
      const bottom = Math.max(8, window.innerHeight - r.top + gap);
      btn.style.right = right + 'px';
      btn.style.bottom = bottom + 'px';
      btn.classList.add('dsh-desk-anchored');
      if (panel) {
        panel.style.right = right + 'px';
        panel.style.bottom = bottom + BTN_SIZE + 10 + 'px';
      }
      return;
    }
  }
  // 兜底：右下角偏上，避开常见发送区
  btn.style.right = '16px';
  btn.style.bottom = '96px';
  btn.classList.remove('dsh-desk-anchored');
  if (panel) {
    panel.style.right = '16px';
    panel.style.bottom = '152px';
  }
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
    'border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:12px;' +
    'box-shadow:0 8px 32px rgba(0,0,0,.5);display:none;width:220px;' +
    'font-family:"Segoe UI","Microsoft YaHei",sans-serif;color:#d7e3f4;';
  const title = document.createElement('div');
  title.style.cssText = 'font-size:12px;color:#9fb0c9;margin-bottom:10px;';
  title.textContent = `窗口 ${winId ?? ''} 配色`;
  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:10px;';
  for (const c of PRESETS) {
    const sw = document.createElement('div');
    sw.style.cssText =
      `height:28px;border-radius:8px;background:${c};cursor:pointer;` +
      'border:2px solid rgba(255,255,255,.08);';
    sw.dataset.color = c;
    sw.title = c;
    sw.addEventListener('click', () => pick(c));
    grid.appendChild(sw);
  }
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:8px;align-items:center;';
  const custom = document.createElement('input');
  custom.type = 'color';
  custom.style.cssText = 'flex:1;height:28px;border:none;background:none;cursor:pointer;';
  custom.addEventListener('input', () => pick(custom.value));
  const clear = document.createElement('button');
  clear.textContent = '清除';
  clear.style.cssText =
    'padding:4px 10px;border-radius:6px;border:1px solid rgba(255,255,255,.2);' +
    'background:transparent;color:#9fb0c9;cursor:pointer;font-size:12px;';
  clear.addEventListener('click', () => pick(null));
  row.appendChild(custom);
  row.appendChild(clear);
  root.appendChild(title);
  root.appendChild(grid);
  root.appendChild(row);
  return root;
}

function pick(color) {
  // 交给主进程校验并持久化；随后主进程回发 dsh-desk:theme 应用
  ipcRenderer.send('dsh-desk:set-color', color);
  const palette = document.getElementById('dsh-desk-palette');
  if (palette) palette.style.display = 'none';
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
    'display:flex;align-items:center;justify-content:center;font-size:18px;' +
    'opacity:.92;transition:opacity .15s;';
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
  document.documentElement.appendChild(btn);
  document.documentElement.appendChild(buildPalette());
  applyTheme(currentColor);

  // 跟随布局变化：滚动/缩放/输入框高度变化等
  window.addEventListener('scroll', positionPalette, true);
  window.addEventListener('resize', positionPalette);
  setInterval(positionPalette, 1200);
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
