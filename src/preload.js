'use strict';
// 预加载桥：把主进程的 stage/log/ready/failed 事件转发给加载页（loading.html）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dshDesk', {
  onEvent: (callback) => {
    ipcRenderer.on('dsh-desk:event', (_event, data) => callback(data));
  },
});
