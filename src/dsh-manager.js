'use strict';
// DSH 进程管理器：隐藏启动 / 附着已有实例 / 重启 / 关停
// 启动方式：node <dsh 启动器> --profile web [--port N]，windowsHide 无控制台窗口
const { spawn, execFile } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { EventEmitter } = require('node:events');

const DEFAULT_PORT = 3080;
const PROBE_INTERVAL_MS = 350;
const READY_TIMEOUT_MS = 150000; // 首次冷启动最多等 150s
const START_FAIL_GRACE_MS = 8000; // spawn 后 8s 内退出且未就绪 → 判定启动失败（重试自动端口）
const KILL_TREE_TIMEOUT_MS = 6000;

// 真实进度阶段：每个阶段只由真实事件驱动推进，不伪造百分比
const STAGES = {
  spawn: { key: 'spawn', label: '正在启动 DSH 进程…', pct: 10 },
  config: { key: 'config', label: '正在组合 profile 配置…', pct: 35 },
  listen: { key: 'listen', label: '服务端口已监听，等待界面就绪…', pct: 70 },
  ready: { key: 'ready', label: '界面已就绪', pct: 100 },
};

// ---------- 环境解析 ----------
function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function resolveNodeCommand() {
  const candidates = [
    process.env.DSH_NODE_BIN,
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Program Files (x86)\\nodejs\\node.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'nodejs', 'node.exe') : null,
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return 'node'; // 交给 PATH 解析
}

function resolveLauncher() {
  const home = dshHome();
  const candidates = [
    path.join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    path.join(home, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** 定位 npm 的 npx-cli.js（首次部署用），找不到返回 null */
function resolveNpxCli() {
  const nodeCmd = resolveNodeCommand();
  const candidates = [];
  if (nodeCmd && nodeCmd !== 'node') {
    candidates.push(path.join(path.dirname(nodeCmd), 'node_modules', 'npm', 'bin', 'npx-cli.js'));
  }
  candidates.push(
    'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js',
    'C:\\Program Files (x86)\\nodejs\\node_modules\\npm\\bin\\npx-cli.js'
  );
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

// ---------- 端口探测 ----------
// 返回 'dsh'（已是 DSH 界面）| 'other'（端口被占用但不是 DSH）| 'none'（空闲）
function probeServer(port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const req = http.get(
      { host: '127.0.0.1', port, path: '/', timeout: timeoutMs },
      (res) => {
        let body = '';
        res.on('data', (c) => {
          body += c;
          if (body.length > 65536) req.destroy();
        });
        res.on('end', () => {
          const isDsh =
            res.statusCode === 200 &&
            (body.includes('__DSH_BOOT__') || /<div id="root">/.test(body)) &&
            /text\/html/i.test(res.headers['content-type'] || '');
          done(isDsh ? 'dsh' : 'other');
        });
        res.on('error', () => done('none'));
        res.on('close', () => done('none'));
      }
    );
    req.on('error', () => done('none'));
    req.on('timeout', () => {
      req.destroy();
      done('none');
    });
  });
}

// TCP 连通探测：服务器 socket 一旦绑定即可连上（早于 HTTP 内容就绪）
function tcpProbe(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on('error', () => resolve(false));
    sock.setTimeout(timeoutMs, () => {
      sock.destroy();
      resolve(false);
    });
  });
}

// 从 dsh 启动日志解析实际监听地址：`dsh web: http://127.0.0.1:PORT`
function parseWebUrl(line) {
  const m = String(line).match(/dsh web:\s*(https?:\/\/[^\s()]+)/);
  return m ? m[1] : null;
}

function portFromUrl(url) {
  const m = String(url).match(/:(\d+)/);
  return m ? Number(m[1]) : null;
}

/** 从系统申请一个空闲端口（listen(0) 由 OS 分配，天然避开 Windows 排除端口范围） */
function getFreePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', () => resolve(null));
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

/** 预检某端口当前是否可绑定（被占用/被 Windows 排除都会失败） */
function portUsable(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

// ---------- 管理器 ----------
class DshManager extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.logDir  日志目录（DSH 子进程 stdout/stderr 与状态落盘）
   */
  constructor(opts = {}) {
    super();
    this.logDir = opts.logDir || path.join(os.tmpdir(), 'dsh-desk');
    try {
      fs.mkdirSync(this.logDir, { recursive: true });
    } catch {
      /* ignore */
    }
    this.logPath = path.join(this.logDir, `dsh-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
    this.portFile = path.join(path.dirname(this.logDir), 'dsh-desk-port.json');
    this.state = 'stopped'; // stopped | starting | running | attached | failed
    this.url = null;
    this.port = DEFAULT_PORT;
    this.startedByUs = false;
    this.child = null;
    this.childPid = null;
    this._stream = null;
    this._startToken = 0;
    this._retryState = null;
  }

  isRunning() {
    return this.state === 'running' || this.state === 'attached';
  }

  getDiagnostics() {
    return {
      state: this.state,
      url: this.url,
      port: this.port,
      startedByUs: this.startedByUs,
      childPid: this.childPid,
      dshHome: dshHome(),
      node: resolveNodeCommand(),
      launcher: resolveLauncher(),
      logPath: this.logPath,
    };
  }

  _logLine(stream, text) {
    const line = `[${new Date().toISOString()}] [${stream}] ${String(text).trimEnd()}\n`;
    try {
      fs.appendFile(this.logPath, line, () => {});
    } catch {
      /* ignore */
    }
    this.emit('log', { stream, text: String(text) });
  }

  /** 记住上次成功使用的端口（保持后续启动能附着到同一实例） */
  _savePort(port) {
    try {
      fs.writeFileSync(this.portFile, JSON.stringify({ port }));
    } catch {
      /* ignore */
    }
  }

  _loadPort() {
    try {
      return JSON.parse(fs.readFileSync(this.portFile, 'utf8')).port;
    } catch {
      return null;
    }
  }

  _emitStage(token, key) {
    if (this._startToken !== token) return;
    const stage = STAGES[key];
    if (!stage) return;
    if (this._stageIndex !== undefined && this._stageIndex >= stage.pct) return; // 只前进不退后
    this._stageIndex = stage.pct;
    this._logLine('info', `STAGE ${key} (${stage.pct}%) ${stage.label}`);
    this.emit('stage', stage);
  }

  /** 侦测 profile 配置写入（prepareProfile 会重写 cordis.yml）→ 真实“配置阶段”事件 */
  _watchConfigWrite(token) {
    const configPath = path.join(dshHome(), 'profiles', 'web', 'cordis.yml');
    let watcher = null;
    try {
      watcher = fs.watch(configPath, () => {
        try {
          watcher && watcher.close();
        } catch {
          /* ignore */
        }
        this._emitStage(token, 'config');
      });
      watcher.on('error', () => {
        try {
          watcher && watcher.close();
        } catch {
          /* ignore */
        }
      });
      // 15s 后不再等待配置写入事件（可能已错过或无需重写）
      setTimeout(() => {
        try {
          watcher && watcher.close();
        } catch {
          /* ignore */
        }
      }, 15000);
    } catch {
      /* 文件暂不存在等情况：静默跳过 */
    }
  }

  /** 入口：若 3080 已是 DSH 则附着；否则隐藏启动 */
  async start() {
    if (this.isRunning() || this.state === 'starting') return this.url;
    this.state = 'starting';
    const token = ++this._startToken;
    this._retryState = { token, retried: false };
    this._stageIndex = 0;
    const diag = this.getDiagnostics();
    this._logLine('info', `start requested; dshHome=${diag.dshHome} node=${diag.node} launcher=${diag.launcher} log=${diag.logPath}`);

    // 1) 依次探测「上次用过的端口」和默认 3080，有 DSH 则附着
    const lastPort = this._loadPort();
    const probePorts = [lastPort, DEFAULT_PORT].filter((p, i, a) => p && a.indexOf(p) === i);
    const probeResults = {};
    for (const p of probePorts) {
      const r = await probeServer(p);
      probeResults[p] = r;
      if (r === 'dsh') {
        this.state = 'attached';
        this.url = `http://127.0.0.1:${p}`;
        this.port = p;
        this.startedByUs = false;
        this._savePort(p);
        this._emitStage(token, 'ready');
        this._logLine('info', `probe 127.0.0.1:${p} => dsh; ATTACHED ${this.url}`);
        this.emit('ready', { url: this.url, attached: true });
        return this.url;
      }
    }
    if (token !== this._startToken) return null;

    // 2) 决定冷启动端口：优先「上次端口」→ 默认 3080 → 系统空闲端口（避开被占/Windows 排除）
    let port = null;
    if (lastPort && probeResults[lastPort] !== 'other' && (await portUsable(lastPort))) {
      port = lastPort;
    } else if (probeResults[DEFAULT_PORT] !== 'other' && (await portUsable(DEFAULT_PORT))) {
      port = DEFAULT_PORT;
    } else {
      port = await getFreePort();
    }
    if (!port) {
      this.state = 'failed';
      this.emit('failed', {
        code: 'NO_FREE_PORT',
        message: `无法获得空闲端口启动 DSH 服务。\n日志：${this.logPath}`,
      });
      return null;
    }
    this._logLine('info', `probes=${JSON.stringify(probeResults)}; spawning dsh (port=${port})`);

    const ok = this._spawn(token, port, port !== DEFAULT_PORT);
    if (!ok) return null;
    return this.url;
  }

  _spawn(token, port, expectStdoutUrl) {
    const launcher = resolveLauncher();
    if (!launcher) {
      this.state = 'failed';
      this.emit('failed', {
        code: 'NO_LAUNCHER',
        message: `未找到 DSH 启动器（@deepseek-ai/dsh）。\n请先运行一次：\nnpx @deepseek-ai/dsh --profile web\n以初始化 ${dshHome()} 下的 profile。`,
      });
      return false;
    }
    const nodeCmd = resolveNodeCommand();
    const args = [launcher, '--profile', 'web'];
    if (port) args.push('--port', String(port));

    this._logLine('info', `spawn: ${nodeCmd} ${args.join(' ')}`);

    const child = spawn(nodeCmd, args, {
      windowsHide: true, // 关键：不弹出 cmd 窗口
      cwd: dshHome(), // 显式工作目录，避免双击启动时 cwd 不确定
      env: { ...process.env, DSH_HOME: dshHome(), NO_COLOR: '1', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    this.childPid = child.pid;
    this.startedByUs = true;
    this._emitStage(token, 'spawn');
    this._watchConfigWrite(token);

    child.stdout.on('data', (d) => {
      const text = d.toString();
      this._logLine('out', text);
      const url = parseWebUrl(text);
      if (url && expectStdoutUrl && this._startToken === token && this.child === child) {
        const p = portFromUrl(url);
        if (p) this._onReady(token, url, p);
      }
    });
    child.stderr.on('data', (d) => this._logLine('err', d.toString()));

    const onExit = (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.childPid = null;
      const isCurrent = this._startToken === token;
      this._logLine('info', `dsh exited (code=${code}, signal=${signal}, state=${this.state})`);
      if (isCurrent && this.state === 'starting') {
        // 启动期退出
        if (code === 0) {
          this.state = 'stopped';
          this.emit('stopped');
          return;
        }
        // 固定端口失败（被占用/被 Windows 排除）→ 申请真实空闲端口重试
        const rs = this._retryState;
        if (rs && rs.token === token && !rs.retried && !expectStdoutUrl) {
          rs.retried = true;
          this._logLine('info', 'spawn on fixed port failed; picking a free port to retry');
          getFreePort().then((port) => {
            if (port && this._startToken === token) {
              this._spawn(token, port, true);
            } else {
              this.state = 'failed';
              this.emit('failed', {
                code: 'NO_FREE_PORT',
                message: `无法获得空闲端口启动 DSH 服务。\n日志：${this.logPath}`,
              });
            }
          });
          return;
        }
        this.state = 'failed';
        this.emit('failed', {
          code: 'SPAWN_EXIT',
          message: `DSH 服务启动失败（退出码 ${code}）。\n日志：${this.logPath}`,
        });
      } else if (this.state === 'running' || this.state === 'attached') {
        this.state = 'stopped';
        this.url = null;
        this.emit('stopped');
      }
    };
    child.on('exit', onExit);
    child.on('error', (err) => {
      this._logLine('err', `spawn error: ${err.message}`);
      if (this._startToken === token && this.state === 'starting') {
        this.state = 'failed';
        this.emit('failed', {
          code: 'SPAWN_ERROR',
          message: `无法启动 DSH 进程：${err.message}\nNode：${nodeCmd}`,
        });
      }
    });

    // 3) 轮询等待端口就绪（携带 child 引用，重试后旧轮询自动退出）
    this._waitReady(token, port, expectStdoutUrl, child);
    return true;
  }

  async _waitReady(token, port, expectStdoutUrl, child) {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let listenStageSent = false;
    while (
      Date.now() < deadline &&
      this._startToken === token &&
      this.state === 'starting' &&
      this.child === child
    ) {
      await new Promise((r) => setTimeout(r, PROBE_INTERVAL_MS));
      if (this._startToken !== token || this.state !== 'starting' || this.child !== child) return;
      // 真实阶段①：TCP 端口可连（服务器 socket 已绑定）
      if (!listenStageSent && (await tcpProbe(port))) {
        listenStageSent = true;
        this._emitStage(token, 'listen');
      }
      // 真实阶段②：HTTP 返回 DSH 界面 → 就绪
      const res = await probeServer(port);
      if (res === 'dsh') {
        this._onReady(token, `http://127.0.0.1:${port}`, port);
        return;
      }
    }
    if (this._startToken === token && this.state === 'starting' && this.child === child) {
      this._logLine('info', 'ready timeout, killing dsh');
      this.state = 'failed';
      await this._killChild();
      this.emit('failed', {
        code: 'TIMEOUT',
        message: `等待 DSH 服务就绪超时（${READY_TIMEOUT_MS / 1000}s）。\n日志：${this.logPath}`,
      });
    }
  }

  _onReady(token, url, port) {
    if (this._startToken !== token) return;
    this.state = 'running';
    this.url = url;
    this.port = port;
    this._savePort(port);
    this._emitStage(token, 'ready');
    this._logLine('info', `READY ${url} (pid=${this.childPid})`);
    this.emit('ready', { url, attached: false });
  }

  async _killChild() {
    const child = this.child;
    if (!child || child.killed) return;
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      const timer = setTimeout(finish, KILL_TREE_TIMEOUT_MS);
      child.once('exit', () => {
        clearTimeout(timer);
        finish();
      });
      // 先优雅终止，再用 taskkill 清理整棵进程树（子代理/工作线程等）
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        if (!done && this.childPid) {
          execFile(
            'taskkill',
            ['/pid', String(this.childPid), '/T', '/F'],
            { windowsHide: true },
            () => finish()
          );
        } else if (!done) {
          finish();
        }
      }, 1200);
    });
  }

  /** 首次部署完成后接管已就绪的 DSH 实例（由部署子进程启动，归本程序所有） */
  adopt(url, child) {
    this.state = 'running';
    this.url = url;
    this.port = portFromUrl(url) || DEFAULT_PORT;
    this.child = child || null;
    this.childPid = child ? child.pid : null;
    this.startedByUs = true;
    this._logLine('info', `adopted deployed instance ${url} (pid=${this.childPid})`);
    if (child) {
      // 兜底：被接管的部署进程异常退出时，状态自动转 stopped（正常停止走 stop() 的进程树清理）
      child.once('exit', (code) => {
        if (this.child !== child) return;
        this.state = 'stopped';
        this.url = null;
        this.child = null;
        this.childPid = null;
        this._logLine('info', `adopted dsh exited (code=${code})`);
        this.emit('stopped');
      });
    }
    this.emit('ready', { url, attached: false });
    return this.url;
  }

  /** 停止：附着实例不杀；自启实例杀进程树 */
  async stop() {
    const token = this._startToken;
    this._startToken++; // 使进行中的等待失效
    this._retryState = null;
    if (this.state === 'starting' || this.state === 'running') {
      await this._killChild();
    }
    this.state = 'stopped';
    this.url = null;
    this.child = null;
    this.childPid = null;
    this._logLine('info', 'stopped');
  }

  async restart() {
    await this.stop();
    return this.start();
  }
}

module.exports = { DshManager, probeServer, dshHome, resolveLauncher, resolveNodeCommand, resolveNpxCli, DEFAULT_PORT };
