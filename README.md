# DSH Desk

Windows 10 / 11 桌面程序：把 DeepSeek Harness 的启动**内嵌到程序里**，
不再需要手动开 cmd 跑 `dsh web`，关闭/最小化窗口后自动隐藏到**系统托盘**，
服务持续运行，随时点托盘图标回来。

## 下载

👉 到 **[Releases](https://github.com/TTH23/DSH_DESK/releases/latest)** 下载最新版本。

| 文件 | 说明 |
|---|---|
| `DSH-Desk-v0.1.2-win32-x64.zip` | 免安装便携版：解压后双击 `DSH Desk.exe` 即可运行，**无需安装 Node.js** |

**SHA-256 校验**（与 release 中的 `*.sha256` 文件一致，防止下载损坏/被篡改）：

```powershell
Get-FileHash .\DSH-Desk-v0.1.2-win32-x64.zip -Algorithm SHA256
```

v0.1.2 校验值：`ea1bb94a8dc027ed4f625da8058d770e5ceb6b7b9ae5d5550c12ecf24bb0a4ce`

## 功能

- 🚀 **内嵌启动**：程序自动以隐藏方式启动 `dsh --profile web`（无任何 cmd 窗口，包括闪窗）
- 🖥️ **内嵌界面**：DSH Web 界面直接显示在程序窗口内（Chromium 内核）
- 📌 **托盘常驻**：关闭窗口（✕）→ 隐藏到托盘，服务继续运行；最小化 → 常规最小化到任务栏；托盘右键菜单退出才真正停止
- 🔄 **智能附着**：若 3080 端口已有一个 DSH 实例（如 Harness 会话），程序直接附着共用，不会重复启动
- 🔁 **一键重启**：托盘菜单可随时重启 DSH 服务
- ⚡ **开机自启**：托盘菜单勾选开关（写入 HKCU 注册表 Run 键）
- 🌐 **浏览器打开**：需要时可在系统默认浏览器中打开界面
- 🪟 **多窗口**：托盘菜单或任务栏右键「新建窗口」打开多个独立窗口，各自处理不同会话/任务，高效并行
- 🎨 **窗口配色**：每个窗口网页内右下角有调色板按钮（🎨），可为该窗口选主题色（顶栏着色 + 彩色按钮），多窗口一眼区分；颜色按窗口持久化，主窗口固定为窗口 1
- 🛠️ **首次自动部署**：未部署 Harness 时弹窗一键自动安装（`npx @deepseek-ai/dsh --profile web`），取消即退出

## 运行环境

- Windows 10 / 11（x64）
- 下载版：无需安装 Node.js
- 从源码运行：Node.js ≥ 20（本机已验证 v24）

## 使用说明

| 操作 | 行为 |
|---|---|
| 双击 `DSH Desk.exe` | 打开窗口并后台启动 DSH 服务（若 3080 已有实例则直接附着） |
| 点窗口 ✕ | 隐藏到系统托盘，服务继续跑 |
| 点最小化 | 常规最小化到任务栏（不从任务栏消失） |
| 单击托盘图标 | 显示 / 隐藏主窗口 |
| 托盘菜单「新建窗口」 | 打开一个新的独立窗口（可分别处理不同会话/任务） |
| 任务栏右键「新建窗口」 | 同上（跳转列表任务，多任务并行） |
| 右键托盘图标 | 状态行 + 菜单：显示/隐藏、**新建窗口**、浏览器打开、**启动/停止/重启 DSH 服务**、开机自启、查看日志、退出 |
| 托盘「退出 DSH Desk」 | 停止由本程序启动的 DSH 服务进程树并退出；附着的外部实例不受影响 |
| 开机自启模式 | 程序随登录后台启动，不弹窗口，服务就绪后常驻托盘 |

> **附着与冷启动**：程序启动时先探测 127.0.0.1:3080——若已有 DSH 实例（比如
> Harness 自身正在运行）则直接**附着**共用（托盘状态显示"已附着"）；若没有，
> 则由程序**自己隐藏启动**一个 `dsh web` 服务（冷启动，托盘状态显示"运行中"）。

> 首次启动 DSH 服务会初始化 profile，界面加载需要几秒到几十秒。
> 等待期间窗口显示**真实进度条**（由真实事件驱动：进程启动 → 配置写入 →
> 端口监听 → 界面就绪，只前进不后退、不伪造百分比）+ **实时日志尾流** + 已等待计时。

## 从源码运行（开发者）

```bat
:: 首次安装（国内镜像已配置在 .npmrc）
npm install

:: 启动
npm start
```

也可以直接双击启动脚本（无需控制台窗口）：

| 脚本 | 说明 |
|---|---|
| **`启动 DSH Desk（推荐）.vbs`** | ✅ **推荐双击这个**：无控制台闪窗，正常显示主窗口 |
| `启动 DSH Desk（备用）.bat` | 备用方案：启动瞬间会有一个控制台窗口闪一下 |

> 正常使用双击「推荐」那个即可。若系统禁用了 VBScript（企业安全策略等）
> 或双击 `.vbs` 没反应，再改用「备用」。

### 开发自检

| 命令 | 作用 |
|---|---|
| `npm run smoke` | 环境自检：DSH 启动器是否就位、3080 端口状态（退出码 0=正常 / 1=缺启动器 / 2=脚本异常） |
| `npm run check` | 源码语法检查（全部 JS 文件） |
| `npm run gen:icon` | 重新生成图标到 `assets/` |

## 运行日志

DSH 子进程输出与程序运行日志保存在：

```
%APPDATA%\DSH Desk\logs\
```

## 排障

- 启动失败时会弹窗显示**诊断信息**（Node 路径、DSH 启动器、DSH_HOME、日志位置），
  可直接点「打开日志目录」查看 `dsh-*.log`（含 dsh 子进程的完整输出）。
- 界面加载失败会自动重试最多 8 次。
- 3080 被其他程序占用时自动改用随机端口。
- 程序自身崩溃（初始化异常）会写入 `crash.log` 并弹窗提示。

## 常见问题

- **端口 3080 被其他程序占用**：程序会自动改用系统分配的随机端口，
  并解析实际地址加载；托盘提示与「浏览器打开」均使用真实地址。
- **首次启动未部署 Harness**：程序检测不到 DSH 启动器时弹出对话框，
  可选「**自动安装**」（自动运行 `npx @deepseek-ai/dsh --profile web` 部署并接管服务）
  或「**取消**」（退出程序）。开机自启模式下检测不到则直接静默退出。
- **打包安装版**：`npm run dist`（生成 NSIS 安装包 + 便携版到 `dist/`）。
  首次运行需下载打包工具（electron、NSIS 等）。若报错
  `unable to verify the first certificate`，先执行 `set NODE_OPTIONS=--use-system-ca`；
  下载慢可执行 `set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries`
  走 npmmirror 镜像（结尾**不要**加斜杠）。

## 项目结构

```
DSH_DESK/
├── src/
│   ├── main.js          # Electron 主进程：窗口、托盘、自启、生命周期
│   ├── dsh-manager.js   # DSH 服务管理器：隐藏启动/附着/重启/关停 + 阶段进度事件
│   ├── tray.js          # 托盘图标与右键菜单
│   ├── preload.js       # 加载页事件桥（stage/log/ready/failed → 渲染进程）
│   └── loading.html     # 启动进度页（真实阶段进度条 + 日志尾流 + 计时）
├── scripts/
│   ├── gen-icon.mjs     # 图标生成（纯 Node，零依赖）
│   ├── smoke.js         # 环境自检（npm run smoke）
│   └── run-electron.js  # electron 启动包装（移除 ELECTRON_RUN_AS_NODE）
├── assets/              # 生成的图标
├── 启动 DSH Desk（推荐）.vbs   # 静默启动器（推荐双击）
├── 启动 DSH Desk（备用）.bat   # 备用启动器（会闪一下控制台）
├── .npmrc               # npm 国内镜像配置
└── package.json
```

## 技术要点

- DSH 启动：`spawn(node, [dsh-launcher, '--profile', 'web', ...], { windowsHide: true })`
- 端口探测：轮询 `http://127.0.0.1:3080/`，识别 DSH 特征（`__DSH_BOOT__`）
- 优雅退出：`taskkill /pid <pid> /T /F` 清理 DSH 进程树（子代理、工作线程等）
- 单实例：`app.requestSingleInstanceLock()` 防止重复启动
- 自启：HKCU `...\CurrentVersion\Run` 注册表键
