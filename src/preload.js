'use strict';
// 预加载桥：
// 1) 把主进程的 stage/log/ready/failed 事件转发给加载页（loading.html）
// 2) 窗口配色：在 DSH 网页内注入悬浮调色板（每窗口独立），选色后给该窗口
//    加主题色顶栏 + 彩色按钮，用于多窗口互相区分（颜色由主进程按窗口持久化）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshDesk', {
  onEvent: (callback) => {
    ipcRenderer.on('dsh-desk:event', (_event, data) => callback(data));
  },
});

// ---------- 窗口配色 ----------
const PRESETS = ['#4da3ff', '#34d399', '#22d3ee', '#a78bfa', '#f472b6', '#fb923c', '#f87171', '#94a3b8'];
let currentColor = null; // '#rrggbb' 或 null
let winId = null;

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
  }
}

function buildPalette() {
  const root = document.createElement('div');
  root.id = 'dsh-desk-palette';
  root.style.cssText =
    'position:fixed;right:16px;bottom:66px;z-index:2147483647;background:#10141c;' +
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
    'position:fixed;right:16px;bottom:16px;width:40px;height:40px;border-radius:50%;' +
    'z-index:2147483646;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.4);' +
    'display:flex;align-items:center;justify-content:center;font-size:18px;';
  btn.addEventListener('click', () => {
    const palette = document.getElementById('dsh-desk-palette');
    if (palette) palette.style.display = palette.style.display === 'none' ? 'block' : 'none';
  });
  document.documentElement.appendChild(btn);
  document.documentElement.appendChild(buildPalette());
  applyTheme(currentColor);
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
