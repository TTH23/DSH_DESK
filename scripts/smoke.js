'use strict';
// DSH Desk 环境自检（纯 Node，不依赖 Electron）：
// 1) DSH 启动器（@deepseek-ai/dsh）是否就位
// 2) 127.0.0.1:3080 端口当前状态（dsh / other / none）
// 用法：npm run smoke   退出码：0=正常 1=缺少启动器 2=脚本异常
const { resolveLauncher, probeServer, DEFAULT_PORT } = require('../src/dsh-manager');

async function main() {
  const results = [];
  const launcher = resolveLauncher();
  results.push(['dsh launcher', launcher || 'MISSING']);
  const probe = await probeServer(DEFAULT_PORT);
  results.push([`probe 127.0.0.1:${DEFAULT_PORT}`, probe]);
  console.log('[smoke] ' + JSON.stringify(results));
  return Boolean(launcher);
}

main()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((err) => {
    console.error('[smoke] ERROR:', (err && err.stack) || err);
    process.exit(2);
  });
