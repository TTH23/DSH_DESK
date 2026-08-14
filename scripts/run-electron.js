'use strict';
// Electron 启动包装器：强制移除 ELECTRON_RUN_AS_NODE 后启动 electron。
// 某些环境（如 DeepSeek Harness）会注入该变量，导致 electron 退化成纯 Node 模式：
// require('electron') 只返回二进制路径字符串，app/BrowserWindow 等主进程 API 全是 undefined。
// 包装器确保本项目在任何环境下 npm start / npm run smoke 都能正常启动。
const { spawn } = require('node:child_process');

delete process.env.ELECTRON_RUN_AS_NODE;

const electronPath = require('electron'); // 普通 Node 下 = electron.exe 的绝对路径
const args = process.argv.slice(2);

const child = spawn(electronPath, args, { stdio: 'inherit' });
child.on('error', (err) => {
  console.error('[run-electron] 无法启动 electron：', err.message);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  process.exit(code == null ? (signal ? 1 : 0) : code);
});
