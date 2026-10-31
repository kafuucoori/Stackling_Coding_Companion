# Stackling 开发文档

> **给新接手的 AI agent**：本文件是项目的完整上手地图。读完即可定位任意功能、理解数据流、安全改动。项目为 **Windows-only** 的 Tauri 2 桌面应用——一只 Live2D 看板娘浮在桌面上，实时监控本地 AI 编程 agent（Claude Code / Codex / Cursor）的工作状态，并用表情、徽标、提示音、完成弹窗反馈。

---

## 0. 一分钟速览

- **是什么**：Tauri 2（Rust 后端 + WebView 前端）桌面宠物。看板娘 = 监控仪表盘的可爱外壳。
- **技术栈**：前端 React 19 + Vite + pixi.js 7 + pixi-live2d-display（Cubism 4）；后端 Rust + Tauri 2 + Win32 API。
- **平台**：仅 Windows（macOS/Linux 代码分支已全部删除，勿再添加）。
- **它怎么拿到 agent 数据**：给 Claude Code / Codex / Cursor 装 **Hook 脚本（PowerShell）**，hook 把事件经 **本地 TCP** 转发给 Rust 后端，后端维护会话表，前端按事件刷新并以 10 秒轮询兜底；Cursor 关闭由后台被动检测补充。
- **跑起来**：`npm install` → `npx tauri dev`（首次会编译 Rust，较久）。前端单独调试 `npm run dev`（端口 5230）。
- **六个窗口**：`mascot`（看板娘）、`panel`（信息面板）、`settings`（设置）、`completion`（完成弹窗）、`chat-input`（模型提问框）、`chat-history`（对话记录）——同一 `index.html`，按 URL hash 路由。
- **辅助能力**：Hook 健康检查与修复、单轮任务/等待耗时、完成通知历史、多显示器边缘停靠、自动清理 Stackling 历史数据。

---

## 1. 目录结构（顶层）

```
Stackling/
├── index.html                  # 唯一 HTML 入口；引入 live2dcubismcore.min.js + /src-vite/main.tsx
├── package.json                # 前端依赖 + npm scripts
├── vite.config.ts              # 端口 5230、@ → src-vite 别名、输出 dist/
├── tsconfig.json               # paths: @/* → src-vite/*
├── .gitignore                  # 忽略 node_modules/ dist/ target/ gen/
│
├── public/                     # Vite 静态服务根（唯一一份，曾有重复已清理）
│   ├── live2dcubismcore.min.js #   Live2D Cubism Core 运行时（专有，必需）
│   ├── live2d/
│   │   ├── manifest.json       #   模型清单（加模型改这里）
│   │   └── moran-hanfu/        #   默认模型「墨染汉服」(model3.json/moc3/physics3/贴图…)
│   └── audio/                  #   ding.wav（完成音）、dong.wav（等待授权提示音）
│
├── src-vite/                   # ★ 全部前端代码（详见 §4）
│   ├── main.tsx                #   hash 路由 → 六窗口组件
│   ├── windows/                #   六个窗口 + windowManager
│   ├── shared/                 #   appStore（跨窗口事件/完成历史）/ notify / maintenance
│   └── features/               #   agent-monitor / live2d-mascot / info-panel / model-chat / settings
│
└── src-tauri/                  # ★ 全部 Rust 后端（详见 §6）
    ├── Cargo.toml              #   Rust 依赖（tauri、windows crate、notify、encoding_rs…）
    ├── tauri.conf.json         #   六窗口定义、bundle(nsis)、devUrl
    ├── build.rs                #   tauri_build::build()
    ├── capabilities/default.json  # 窗口权限白名单
    ├── icons/                  #   仅 Windows 图标（.ico/png/tray-icon.png）
    └── src/
        ├── main.rs             #   调 app_lib::run()
        ├── lib.rs              #   run()：插件/状态/托盘/setup/命令注册
        ├── agent_monitor.rs    #   事件解析与会话状态机
        ├── agent_sessions.rs   #   会话列表、删除、权限响应命令
        ├── agent_files.rs      #   JSONL 定位、watcher、对话读取
        ├── agent_focus.rs      #   前台应用、宿主终端与进程链识别
        ├── agent_sockets.rs    #   TCP 19283/19284 hook 入口
        ├── agent_stats.rs      #   Claude/Codex 统计
        ├── claude_hooks.rs     #   Claude Code Hook 安装与清理
        ├── codex_hooks.rs      #   Codex Hook 安装与清理
        ├── cursor_hooks.rs     #   Cursor Hook 安装与清理
        ├── cursor_lifecycle.rs #   Cursor 关闭检测：进程宿主 + 只读工作区状态
        ├── hook_utils.rs       #   Hook 配置读写和脚本公共工具
        ├── hook_health.rs      #   Hook 健康检查与一键修复命令
        ├── credentials.rs      #   Windows 凭据管理器中的模型 API 密钥
        ├── model_chat.rs       #   NewAPI 请求、流式输出与取消
        ├── uninstall_cleanup.rs #  卸载时清理 Stackling Hook 和可选应用数据
        └── updates.rs          #  GitHub Releases 最新正式版检查与版本比较
```

> `src-tauri/gen/` 与 `src-tauri/target/` 是构建生成物，已 gitignore，删了会自动重建。

---

## 2. 架构与数据流（必读）

### 2.1 多窗口模型
同一个前端 bundle，`tauri.conf.json` 预声明六个 window，每个 window 的 `url` 是 `index.html#/<label>`。`src-vite/main.tsx` 读 `location.hash` 决定渲染哪个窗口组件。**各窗口是独立 webview，不共享 JS 内存**——靠两条腿同步：
1. **`settings.json`（Tauri Store）**：持久化真相源。
2. **Tauri 事件**：改动后广播让其它窗口立即刷新。

跨窗口事件（通用事件定义在 [src-vite/shared/appStore.ts](src-vite/shared/appStore.ts)，模型对话事件定义在 [modelChatStore.ts](src-vite/features/model-chat/modelChatStore.ts)）：
| 事件 | 谁发 | 谁收 | 作用 |
|---|---|---|---|
| `toggle-panel` | mascot 点击 | panel | 可见则隐藏，否则智能选位+显示 |
| `settings-changed` | settings 改动 | mascot/panel/completion | 换主题/模型/开关实时生效 |
| `show-completion` | mascot 检测到完成 | completion | 弹出完成提示窗 |
| `model-chat-history-changed` | 模型对话窗口 | chat-history/chat-input | 多会话历史、滚动摘要、当前会话切换刷新 |
| `model-chat-busy-changed` | chat-input | mascot | 生成中显示「对话中」徽标 |
| `stackling-update-available` | mascot | completion | 自动检查发现新版本时显示更新提示 |

### 2.2 监控数据流（核心）
```
Claude Code / Codex / Cursor 进程
        │ 触发 hook（UserPromptSubmit / PreToolUse / Elicitation / Stop …）
        ▼
PowerShell hook 脚本（Rust 在启动时自动写入并注册）
   ├─ ~/.claude/hooks/stackling-claude-hook.ps1 ──TCP──▶ 127.0.0.1:19283  (Claude Code)
   ├─ ~/.codex/hooks/stackling-codex-hook.ps1   ──TCP──▶ 127.0.0.1:19283  (Codex hooks)
   └─ ~/.cursor/hooks/stackling-cursor-hook.ps1 ──TCP──▶ 127.0.0.1:19284  (Cursor)
        ▼
Rust 后端（agent_monitor.rs）
   ├─ start_claude_socket_server  监听 19283
   ├─ start_cursor_socket_server  监听 19284
   ├─ process_claude_event()      解析事件 → 更新 sessions: HashMap<id, ClaudeSession>
   └─ emit("claude-session-update") / emit("claude-task-complete")
        ▼
前端（React）
   ├─ MascotWindow + InfoPanel 由事件实时刷新，并每 10s 调 get_claude_sessions() 兜底轮询
   ├─ 聚合成桌宠态 PetState → 看板娘表情/徽标
   ├─ 检测「首次完成」→ 播放完成音 + 弹 completion 窗
   └─ 用户操作 → invoke 命令（处理授权 / 删除会话）
```

> **Codex**：通过 `~/.codex/hooks.json` 接入。首次安装或脚本变化后，需要在 Codex 里执行 `/hooks` 审核并信任 `stackling-codex-hook.ps1`，否则 Codex 会跳过该 hook。

### 2.3 关键交互流
- **左键点看板娘**：`MascotWindow.onMouseUp` 判定（位移 <5px 且 <350ms = 点击）→ emit `toggle-panel` → PanelWindow 智能选位弹出。
- **拖看板娘**：位移 >5px → 先隐藏 `chat-history` → `startDragging()`；松手后 `saveMascotPosition()` 存到 settings.json，并重新定位 `chat-input`。历史窗口不会在拖动结束后自动弹回。
- **右键看板娘**：`invoke('open_settings_window')` 打开设置窗。
- **模型对话**：`chat-input` 固定跟随看板娘脚下；发送时调用 NewAPI 兼容接口流式输出；`chat-history` 优先贴在看板娘左侧，展示多会话历史。
- **面板失焦**：>400ms 自动 `hidePanel()`（防刚弹出就被自身 setFocus 误关）。
- **改设置**：`setSetting()` 写 Store → `broadcastSettingsChanged()` → 各窗口实时更新。

---

## 3. 跑起来 / 构建

```bash
npm install            # 装前端依赖
npx tauri dev          # 完整开发（编译 Rust + 起 vite + 开窗口）。首次编译较久
npm run dev            # 只起前端 vite（端口 5230），用于纯 UI 调试
npm run build          # tsc -b + vite build → dist/
npm run build:installer # 生成 Windows NSIS 安装包
```

`pixi-live2d-display` 固定为 `0.4.0`。该版本把仅用于上游文档发布的
`gh-pages` 错列为生产依赖，因此 `postinstall` 会运行
`scripts/remove-unused-gh-pages.mjs`，从安装结果和锁定依赖树中移除它。
升级 Live2D 库时应重新检查该补丁是否仍有必要。

**前置**：Node.js、Rust MSVC 工具链、Visual Studio C++ Build Tools、Windows SDK，以及 WebView2（Win11 自带）。Rust 编译和 SQLite bundled C 代码编译需要可用的 MSVC 环境；在 Developer PowerShell 中运行，或先加载 VsDevCmd.bat。若报找不到 link.exe，先修复构建环境，不改 Rust 业务代码。
**端口固定 5230**（`vite.config.ts` strictPort，对应 `tauri.conf.json` 的 devUrl）。

安装包输出到 `src-tauri/target/release/bundle/nsis/`，使用简体中文标准浅色向导，
按当前用户安装并创建开始菜单入口；完成页可选择创建桌面快捷方式或立即运行。
Windows“已安装的应用”可正常启动卸载器。卸载时会移除 Stackling 自己注册的
Claude、Codex、Cursor Hook 和脚本，但保留其他工具的 Hook 与 Agent 原始日志；
卸载页勾选“删除应用数据”后才会一并删除 Stackling 设置和历史数据。

### 常用排障命令（Windows / bash）
```bash
# tauri dev 报 os error 5（拒绝访问）= 旧 exe 没退，先杀
taskkill //F //IM stackling.exe
# 端口 5230 被占
netstat -ano | grep ':5230' | grep LISTENING   # 取 PID 后 taskkill //F //PID <pid>
```

---

## 4. 前端详解（`src-vite/`）

### 4.1 入口与路由
- [index.html](index.html)：`<head>` 里 **先**加载 `/live2dcubismcore.min.js`（pixi-live2d-display 依赖全局 `window.Live2DCubismCore`），`body` 透明（看板娘/面板窗口需要）。
- [src-vite/main.tsx](src-vite/main.tsx)：`pickWindow()` 按 hash 路由——`#/mascot`(默认)/`#/panel`/`#/settings`/`#/completion`/`#/chat-input`/`#/chat-history`。
- **路径别名**：所有跨模块 import 用 `@/`（= `src-vite/`），如 `@/features/info-panel/theme`。同目录用 `./`。

### 4.2 窗口层（`src-vite/windows/`）
| 文件 | 职责 | 关键点 |
|---|---|---|
| [MascotWindow.tsx](src-vite/windows/MascotWindow.tsx) | 看板娘 | 透明置顶；窗口裁剪为 210×430 基准，scale 0.5~1.5 → 改窗口尺寸；`startSessionMonitor` 驱动 petState + 完成音/等待音；附属窗口在看板娘移动或缩放时跟随定位 |
| [PanelWindow.tsx](src-vite/windows/PanelWindow.tsx) | 信息面板 | `PANEL_W=360 PANEL_MAX_H=340`；失焦 400ms 自动隐；内容高变 → setSize + 重定位 |
| [SettingsWindow.tsx](src-vite/windows/SettingsWindow.tsx) | 设置 | 关闭走 `hide()` 而非销毁；改动 `broadcastSettingsChanged` |
| [CompletionWindow.tsx](src-vite/windows/CompletionWindow.tsx) | 完成弹窗 | listen `show-completion` → 定位看板娘/面板上方 → show 不抢焦点 → 按设置自动关 |
| [ChatInputWindow.tsx](src-vite/windows/ChatInputWindow.tsx) | 模型提问框 | NewAPI 流式请求；发送/停止生成；新对话；滚动摘要维护；生成中通知看板娘「对话中」 |
| [ChatHistoryWindow.tsx](src-vite/windows/ChatHistoryWindow.tsx) | 模型对话记录 | Markdown 渲染、代码块复制、`<think>` 思考过程默认折叠；历史对话列表/切换/删除 |
| [windowManager.ts](src-vite/windows/windowManager.ts) | 窗口定位/显隐/拖动 | `positionPanelNearMascot()`（上→下→侧→夹进屏内）；对话框跟随看板娘；`positionChatHistoryIfVisible()` 只移动可见窗口，不会把已关闭的记录窗口重新 show；位置持久化键 `mascot_x/mascot_y` |

### 4.3 共享层（`src-vite/shared/`）
- [appStore.ts](src-vite/shared/appStore.ts)：通用跨窗口事件、待显示完成通知和完成历史的持久化/清理 + `CompletionInfo` 类型 + 透传 `loadSettings`。模型对话事件由 `modelChatStore.ts` 管理。
- [notify.ts](src-vite/shared/notify.ts)：`playCompletionSound(source, settings)`（音量 0.8，按 source 开关）、`playWaitingSound(settings)`（音量 0.55，仅 `waitingSound` 开启）。音源 `/audio/ding.wav` 和 `/audio/dong.wav`。

### 4.4 功能模块（`src-vite/features/`）

**agent-monitor** — [agentMonitor.ts](src-vite/features/agent-monitor/agentMonitor.ts)：前端与 Rust 的契约层。
- 类型：`ClaudeSession`、`ClaudeStats`/`ClaudeDailyStats`、`ChatMessage`、`AgentSource`('cc'|'codex'|'cursor')、`AgentStatus`、`PetState`、`PermissionDecision`。
- invoke 封装：`getClaudeSessions` / `getClaudeStats(source?)` / `getClaudeConversation(id)` / `removeClaudeSession(id)` / `resolveClaudePermission(id, decision)`。
- `startSessionMonitor(cbs, {intervalMs=10000})`：事件驱动 + 10 秒兜底轮询，返回 stop 函数。每轮任务完成（stopped + lastResponse）触发一次 `onComplete`，下一轮开始后自动复位。
- 状态映射：`sessionToPetState`（单会话）、`aggregatePetState`（多会话，优先级 **waiting > working > compacting > idle**）。

**live2d-mascot** — Live2D 渲染。
- [Live2DMascot.tsx](src-vite/features/live2d-mascot/Live2DMascot.tsx)：动态 import pixi → 创建启用高 DPI/抗锯齿的透明 `PIXI.Application` → `Live2DModel.from(url)`。加载后先测量模型自然边界，再按 260×520 设计舞台、布局留白和 `fit=contain/width/height` 计算缩放；锚点与 pivot 均为 `(0,0)`，通过边界偏移居中。模型只在 `modelUrl` 变化时重建；缩放变化通过 renderer/root 同步到画布。RAF 持续驱动呼吸(`ParamBreath`)+微摆(`bodyZ`/`ParamAngleZ`)+状态表情（工作/对话 `exp5`、整理 `exp6`、等待 `exp3`）+水印关闭(`exp9=1`)。徽标见 `STATE_BADGE`。
- [Live2DMascotSwitcher.tsx](src-vite/features/live2d-mascot/Live2DMascotSwitcher.tsx)：包一层模型切换 UI（`showPicker`）。
- [live2dModels.ts](src-vite/features/live2d-mascot/live2dModels.ts)：读 `/live2d/manifest.json`。**加模型 = 放进 `public/live2d/<id>/` + manifest 加一条，无需改后端**。默认 `moran-hanfu`。

**info-panel** — 会话列表、对话、统计与完成历史四视图。
- [InfoPanel.tsx](src-vite/features/info-panel/InfoPanel.tsx)：容器，视图 `list`/`chat`/`stats`/`history`，监听状态事件并以 10 秒轮询兜底。
- [SessionList.tsx](src-vite/features/info-panel/SessionList.tsx)：每行状态点+任务标题+source 徽标+统计/删除按钮；等待授权时显示 4 个决策按钮（拒绝/允许一次/全允许/自动），但 `AskUserQuestion` 类工具改为提示「去终端选择」。
- [ChatView.tsx](src-vite/features/info-panel/ChatView.tsx)：用户正文与上下文折叠交给 [UserMessage.tsx](src-vite/features/info-panel/UserMessage.tsx)，助手回复以 Markdown 展示；长文可展开，加载中不闪空态。
- [userMessagePresentation.ts](src-vite/features/info-panel/userMessagePresentation.ts)：只在展示层识别已知包装，保留代码围栏、行内代码和实际问题中的 XML 示例。
- [StatsView.tsx](src-vite/features/info-panel/StatsView.tsx)：总量卡片 + Token 明细 + 近 14 天柱状图；Cursor 显示「不支持详细统计」占位。
- [theme.ts](src-vite/features/info-panel/theme.ts)：**四主题** `pink/green/blue/dark`（`THEMES` 定义全部 token），`ThemeProvider`/`useTheme`/`themeCssVars`，顺序 `THEME_ORDER=['pink','green','blue','dark']`。**默认主题 pink**。dark 的 accent 是柔和蓝 `#6ea8fe`（不是黑，色板里「黑」点用 `dark.bg` 显示）。
- [utils.ts](src-vite/features/info-panel/utils.ts)：`formatTokens` / `projectNameOf` / `sessionTitleOf` / `displayStateOf` / `sessionSortRank` / `sourceLabel`。

**settings** — 设置界面 + 持久化。
- [SettingsPanel.tsx](src-vite/features/settings/SettingsPanel.tsx)：五区——连接 / 显示（主题、模型、缩放） / 模型对话（NewAPI 地址、密钥、模型、系统提示词、上下文与摘要） / 提示音 / 系统。缩放档位 `[0.5..1.5]` 步进 0.1。
- [settingsStore.ts](src-vite/features/settings/settingsStore.ts)：**`AppSettings` + `DEFAULT_SETTINGS` + `KEY`（字段→settings.json 键名）的真相源**。`loadSettings`/`setSetting`/`setAutostart`。详见 §5。
- [Toggle.tsx](src-vite/features/settings/Toggle.tsx)：主题化开关。

**model-chat** — 看板娘独立对话。
- [modelChatStore.ts](src-vite/features/model-chat/modelChatStore.ts)：在独立的 `model-chat.json` 中持久化多会话、当前会话、滚动摘要；流片段仅更新内存，完成后一次落盘。
- 每个会话最多保留最近 500 条消息，并保存 `summary`（滚动摘要）、`summarizedThroughMessageId`（摘要覆盖到哪条消息）。
- 请求上下文 = 系统提示词 + 当前会话滚动摘要 + 最近 N 条 done 消息 + 当前问题。默认 N=20。
- 开启「自动摘要历史」后，当离开最近 N 条窗口的新增消息累计到 10 条，先调用 NewAPI 更新会话摘要，再继续正式提问。
- 后端流式事件支持 `delta` / `reasoning` / `done` / `error`。`reasoning_content` / `reasoning` / `reasoningContent` 会转成 `<think>...</think>`，前端默认折叠显示。

### 4.5 会话标题与用户消息展示

会话列表和对话详情页标题统一由 `sessionTitleOf()` 生成：优先取最新 `userPrompt` 中实际请求的首个非空行（兼容 Codex 的 `# My request:` 包装并跳过环境上下文），最多 60 个 Unicode 字符；无有效提示词时回退为 `cwd` 的末级目录名。列表悬停可查看完整原始提示词和工作目录。这是本地文本截取，不是原应用中的聊天标题，也不会额外调用模型。

详情页优先使用会话表中的最新会话对象，避免列表更新后详情标题仍停留在打开时的值；会话已关闭时保留当前详情快照。详情标题的悬停提示包含任务标题和工作目录，列表悬停保留完整原始提示词与目录。

用户气泡由 `UserMessage.tsx` 渲染，`userMessagePresentation.ts` 只在展示层拆分消息：`user_query` 显示为正文，独立的 `environment_context/timestamp/external_codex_apps_open_page` 放入默认关闭的“附加信息”，展开可查看完整原文。仅含上下文的记录显示紧凑折叠行；正文支持 Markdown，长文可展开。已知标签出现在代码围栏、行内代码、普通句子或 user_query 内时保留为用户内容。此处理不改写 JSONL，不改变消息读取协议。运行 `npm run test:messages` 验证提取规则。

---

## 5. 设置项（`AppSettings` / `DEFAULT_SETTINGS`）

真相源：[settingsStore.ts](src-vite/features/settings/settingsStore.ts)。持久化到 Tauri Store 的 `settings.json`（字段名经 `KEY` 映射成 snake_case）。

| 字段 | 默认值 | settings.json 键 | 说明 |
|---|---|---|---|
| enableClaudeCode | `true` | enable_claudecode | 监控 Claude Code |
| enableCodex | `true` | enable_codex | 监控 Codex（hook 接入，需 `/hooks` trust） |
| enableCursor | `true` | enable_cursor | 监控 Cursor |
| theme | `'pink'` | theme | pink/green/blue/dark |
| live2dModelId | `'moran-hanfu'` | live2d_model_id | 当前模型 |
| live2dScale | `1.0` | live2d_scale | 0.5~1.5（100%=默认） |
| dockEnabled | `true` | dock_enabled | 拖动结束后吸附当前显示器工作区边缘 |
| dockThreshold | `25` | dock_threshold | 触发边缘停靠的像素距离（8~80） |
| ccSoundEnabled | `true` | sound_enabled | CC 完成音 |
| codexSoundEnabled | `true` | codex_sound_enabled | Codex 完成音 |
| cursorSoundEnabled | `true` | cursor_sound_enabled | Cursor 完成音 |
| waitingSound | `true` | waiting_sound | 等待授权提示音 |
| autoCloseCompletion | `true` | auto_close_completion | 完成弹窗自动关 |
| autoCloseCompletionSec | `5` | auto_close_completion_sec | 1~120 秒 |
| debugBorder | `false` | debug_border | 显示看板娘透明窗口边界 |
| modelChatEnabled | `true` | model_chat_enabled | 启用模型对话窗口 |
| modelChatProviderUrl | `''` | model_chat_provider_url | NewAPI 服务地址 |
| modelChatApiKey | `''` | Windows 凭据管理器 | 模型对话 API 密钥 |
| modelChatModel | `''` | model_chat_model | 模型对话模型名称 |
| modelChatSystemPrompt | `'你是用户桌面上的 Live2D 看板娘“墨墨”…'` | model_chat_system_prompt | 模型对话系统提示词 |
| modelChatContextLimit | `20` | model_chat_context_limit | 每次请求直接发送最近多少条历史消息（2~50） |
| modelChatAutoSummary | `true` | model_chat_auto_summary | 超过上下文条数时调用模型滚动总结早期消息 |
| autoCleanupEnabled | `true` | auto_cleanup_enabled | 每天自动清理一次 Stackling 历史数据 |
| completionHistoryRetentionDays | `30` | completion_history_retention_days | 完成通知保留天数 |
| modelChatRetentionDays | `90` | model_chat_retention_days | 模型会话保留天数；最近会话始终保留 |
| maxCompletionHistory | `30` | max_completion_history | 完成通知数量上限 |
| autoCheckUpdates | `true` | auto_check_updates | 启动后自动检查 GitHub 最新正式版；24 小时内不重复请求 |
| autostart | `false` | enable_autostart | 开机自启（plugin-autostart） |

> 看板娘位置另存两个键 `mascot_x` / `mascot_y`（windowManager 用）。
> 模型对话历史保存在独立的 `model-chat.json`；上下文条数限制「发给模型」的最近消息数量，本地每个会话最多保留 500 条。
> ⚠️ **改默认值不影响已存设置**：若 `settings.json` 已有用户值会覆盖默认。要看默认效果删 settings.json 或在设置里手动调。

---

## 6. Rust 后端详解（`src-tauri/`）

### 6.1 启动（[lib.rs](src-tauri/src/lib.rs) 的 `run()`）
1. 设 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--disable-accelerated-video-decode`（透明渲染稳定性）。
2. 注册插件：store / autostart / log(debug)。
3. `.manage(ClaudeState { sessions, pending_permissions })` 全局状态（`Arc<Mutex<HashMap>>`）。
4. `.setup()`：安装/更新 Claude Code、Codex、Cursor Hook → 起两个 socket server（19283/19284）和 Cursor 生命周期检测线程 → 建系统托盘（图标 `include_bytes!("../icons/tray-icon.png")`，菜单 显示看板娘/设置/退出）→ 显示 mascot 窗口。
5. `generate_handler!` 注册命令（见下）。

**已注册命令（15 个）**：`open_settings_window`、`quit_app`、`get_claude_sessions`、`remove_claude_session`、`resolve_claude_permission`、`get_claude_stats`、`get_claude_conversation`、`send_model_chat_message`、`stream_model_chat_message`、`cancel_model_chat_stream`、`get_model_chat_api_key`、`set_model_chat_api_key`、`get_hook_health`、`repair_hooks`、`check_for_updates`。

### 6.2 监控核心（[src-tauri/src](src-tauri/src)，Windows-only）
- **`ClaudeSession`**：对前端输出会话 ID、目录、状态、工具、提示词、更新时间、最终回复和来源；另维护 PID、子 Agent 数量、活动标签、宿主终端、transcript_path 和 cursor_host；除可选 PID 外，这些内部辅助字段不发送给前端。
- **状态机**（hook 事件 → status）：`UserPromptSubmit/UserPromptExpansion→processing`、`PreToolUse(AskUserQuestion)→waiting` 其余 `→tool_running`、`PermissionRequest/Elicitation→waiting`、`PostToolUse/PostToolUseFailure/PostToolBatch/PostCompact→processing`、`Stop/StopFailure/Interrupt→stopped`、`SessionEnd→移除会话`（当前仅 Codex 注册）。`CwdChanged` 会同步新的工作目录；MCP 征询和 agent 求助只提示去原会话作答，不会被误当成权限授权。
- **事件入口**：[agent_sockets.rs](src-tauri/src/agent_sockets.rs) 监听 TCP **19283**（CC+Codex）和 **19284**（Cursor），再交给 [agent_monitor.rs](src-tauri/src/agent_monitor.rs) 的 `process_claude_event()`。
- **辅助职责**：[agent_files.rs](src-tauri/src/agent_files.rs) 管 JSONL/watcher/对话读取，[agent_sessions.rs](src-tauri/src/agent_sessions.rs) 管会话命令，[agent_focus.rs](src-tauri/src/agent_focus.rs) 管前台应用与宿主终端识别（不提供点击跳转），[agent_stats.rs](src-tauri/src/agent_stats.rs) 管统计。

### 6.3 命令职责速查
| 命令 | 作用 |
|---|---|
| `get_claude_sessions` | 返回会话列表（含 PID 存活检查、120s 超时标记 stopped、活跃标签判定） |
| `get_claude_stats(source?)` | 扫 JSONL 算近 14 天 token/消息/会话；Cursor 返回空 |
| `get_claude_conversation(id)` | 读会话 JSONL 倒序取最多 1000 条消息 |
| `resolve_claude_permission(id, decision)` | 把授权决定经 mpsc 发回 hook；Claude 支持拒绝/允许一次/会话规则/自动模式，Codex 按官方协议仅支持拒绝或允许一次 |
| `remove_claude_session(id)` | 从内存表删会话 |
| `send_model_chat_message` | 非流式 NewAPI 聊天补全请求（设置页测试连接、滚动摘要更新） |
| `stream_model_chat_message` | 流式 NewAPI 聊天补全请求，向前端 emit `model-chat-stream` |
| `cancel_model_chat_stream` | 标记指定 requestId 取消，流读取循环检测后结束 |
| `get_model_chat_api_key` / `set_model_chat_api_key` | 从 Windows 凭据管理器读取或保存模型 API 密钥，避免把密钥明文写入设置文件 |
| `get_hook_health` | 检查 Claude Code、Codex、Cursor 的脚本、配置注册和 Stackling 本地监听端口 |
| `repair_hooks` | 按指定来源或全部来源重新安装/更新 Hook；前端随后重新执行健康检查 |
| `open_settings_window` / `quit_app` | 显示设置窗口 / 退出 Stackling 进程 |

### 6.4 Hook 注册、协议与迁移

协议核对基线为 2026-10-31：[Claude Code Hooks](https://code.claude.com/docs/en/hooks)、[Codex Hooks](https://learn.chatgpt.com/docs/hooks)、[Cursor Hooks](https://cursor.com/docs/hooks)。事件名称和输入字段以各应用当前文档及已验证的本地结构为准。

| 来源 | 配置与脚本 | 当前注册事件 |
|---|---|---|
| Claude Code | `~/.claude/settings.json`；`~/.claude/hooks/stackling-claude-hook.ps1` | SessionStart、UserPromptSubmit、UserPromptExpansion、PreToolUse、PermissionRequest、PermissionDenied、PostToolUse、PostToolUseFailure、PostToolBatch、Notification、SubagentStart、SubagentStop、TaskCreated、TaskCompleted、Stop、StopFailure、TeammateIdle、CwdChanged、PreModelSwitch、PostModelSwitch、PreCompact、PostCompact、Elicitation、ElicitationResult |
| Codex | `~/.codex/hooks.json`；`~/.codex/hooks/stackling-codex-hook.ps1` | SessionStart、SessionEnd、Interrupt、UserPromptSubmit、PreToolUse、PermissionRequest、PostToolUse、PreCompact、PostCompact、SubagentStart、SubagentStop、Stop |
| Cursor | `~/.cursor/hooks.json`；`~/.cursor/hooks/stackling-cursor-hook.ps1` | sessionStart、beforeSubmitPrompt、preToolUse、postToolUse、postToolUseFailure、subagentStart、subagentStop、preCompact、afterAgentResponse、afterAgentThought、stop |

- **注册与迁移**：`claude_hooks.rs/codex_hooks.rs/cursor_hooks.rs` 安装时替换 Stackling 自己的注册；Claude 共享 matcher 组中其他工具的 handler 也必须保留。格式损坏的用户配置拒绝覆盖。Cursor 原生 `sessionEnd` 和 Claude `SessionEnd` 不再注册，旧条目在启动或修复时移除；空事件键必须删除。第三方导入开关不做修改。
- **来源标识**：Codex 注入 `stackling_source=codex`，保留官方 `source`（startup/resume/clear/compact/fork）。Cursor 来源由独立 socket 确定；Claude 默认来源为 cc。不能将 `source=startup` 当作应用名，也不能仅凭 `turn_id` 推断 Codex。旧 `source=codex` 应用标识不再读取。
- **Claude**：命令采用显式 PowerShell shell form。检测到 `CURSOR_VERSION` 时，在读取 stdin 或查询进程前返回无 BOM 的 UTF-8 `{}`；其他非 claude.exe 宿主也只返回空 JSON，避免重复上报。普通观察事件超时 10 秒，PermissionRequest 最多等待 600 秒。
- **Codex**：保留 `commandWindows` 覆盖，SessionStart 不设 matcher，覆盖 fork。普通事件超时 10 秒，Interrupt/SessionEnd 为 3 秒，PermissionRequest 为 600 秒。TCP 连接等待 250ms、发送上限 500ms；离线、空输入和异常返回无 BOM 的 UTF-8 `{}`。首次安装或定义/脚本变化后，需要用户通过 `/hooks` 审核信任，不自动绕过信任。
- **权限协议**：Claude 支持拒绝、允许一次、会话规则和自动模式；Codex 只支持拒绝或允许一次，不返回 `updatedPermissions/updatedInput/interrupt` 等未支持字段。Cursor hook 只观察，不覆盖原应用权限决策。
- **状态与子代理**：UserPromptSubmit 重置任务计时和子代理计数；只用 SubagentStart/SubagentStop 增减计数，不重复计入 PreToolUse(Agent)。子代理结束不关闭主会话 watcher。中断清空旧回复、停止计时、释放待处理权限连接，不发送完成提醒。模型切换与压缩后的 SessionStart 保留进行中的状态；afterAgentThought 只刷新活跃状态，不保存思考文本。
- **观察范围**：不注册会替换默认创建行为的 WorktreeCreate；不注册高频 MessageDisplay/文件监听事件；workspaceOpen 没有会话 ID，不作为会话事件。最终回复仍通过各应用当前字段和 transcript 读取。

#### Cursor 切换工作区等待结束 Hook 的规避

Cursor 3.27.22 的本机日志显示：工作区关闭时等待 hook 配置重载 10 秒，然后在脚本启动前报 `MainThreadShellExec not initialized`。本项目不再注册 Cursor `sessionEnd`，也不再注册 Claude `SessionEnd`（Cursor 会自动导入它）。安装/修复会迁移旧配置，删除 Stackling 自己的旧结束 hook；若事件数组为空则删除整个键，因为当前 Cursor 会把原生空数组也当作已配置的事件。其他工具的 hook 和同组 handler 必须保留，第三方导入设置不做修改。

Claude 脚本发现 `CURSOR_VERSION` 时，在读取 stdin 和查询进程前直接返回空 JSON，避免导入调用重复查询进程。任务结束仍由 `Stop/stop` 上报；Codex 的 `SessionEnd` 保留。Claude/Cursor 不再通过结束 hook 上报关闭。Cursor 使用下述被动生命周期检测；Claude 继续使用现有 PID/120 秒活动超时作为状态兜底。此规避针对本项目注册的结束 hook，不承诺解决其他工具的结束 hook 或 Cursor 的所有重载问题。

#### Cursor 会话关闭的被动检测

`cursor_lifecycle.rs` 在独立线程中每 500ms 检测当前 Cursor 本地状态。Cursor 脚本仅在 sessionStart/beforeSubmitPrompt 捕获最近的本地 Cursor NodeService 执行宿主 PID 与创建时间；宿主退出时直接移除所属会话，创建时间用于防止 PID 重用。无法识别宿主时不绑定。仅在先观察到某会话位于已打开的工作区后才建立绑定；当前 `state.vscdb` 的 `ItemTable/composer.composerData/selectedComposerIds` 用于识别会话标签关闭，Windows `NtQueryInformationFile(FileProcessIdsUsingFileInformation)` 用于确认工作区文件被其他进程释放。文件探测只请求元数据访问并允许完整共享，不采用独占打开；SQLite 连接只读、不等待写锁，不改动 Cursor 配置或聊天数据。

宿主退出确认后直接移除会话；数据库或文件状态需连续两次确认关闭后才移除会话，关闭 transcript watcher，并广播 `claude-session-update`。InfoPanel 复用事件驱动的 `startSessionMonitor`，并在请求期间收到更新时补发刷新，避免等 10 秒兜底轮询。Cursor 会话若仍在其他工作区打开则重新绑定，不误判为关闭。`sessionEnd/SessionEnd` 仍保持停用。

这是近实时检测：识别到的执行宿主退出后约 0.5 秒更新；Cursor 写入会话列表或释放工作区文件后约 0.5–1 秒更新；从用户点击关闭到落盘的延迟由 Cursor 决定。该实现已针对本机 Cursor 3.27.22 的当前数据布局核对，仅自动查找默认 `%APPDATA%/Cursor/User/workspaceStorage`。尚未观察到的短会话、定制用户目录、格式变化或读取失败不触发推断删除，保留原有超时兜底。`cargo test --manifest-path src-tauri/Cargo.toml --lib` 覆盖确认/重开/未知状态/多工作区及真实 SQLite/跨进程文件探测、宿主退出/PID 重用；`npm run test:monitor` 验证并发刷新不丢关闭事件。

### 6.5 Windows 专属辅助
`is_pid_alive`(OpenProcess)、`find_host_app_for_pid_win`（遍历进程链识别 Claude Desktop / Windows Terminal）、`try_recover_cursor_mojibake`(GBK→UTF8 恢复 CJK 乱码)、`normalize_cursor_path`(`/g:/x`→`g:\x`)。

### 6.6 配置文件
- [tauri.conf.json](src-tauri/tauri.conf.json)：定义 Stackling 应用标识、六个窗口、简体中文 NSIS 安装/卸载配置与图标，并启用本地资源 CSP。
- [capabilities/default.json](src-tauri/capabilities/default.json)：六个窗口的 window/event/store/autostart 权限白名单，并仅允许设置页打开项目的 GitHub 仓库地址。
- [Cargo.toml](src-tauri/Cargo.toml)：`tauri`(tray-icon,image-png)、store/autostart/log 插件、`chrono`、`dirs`、`reqwest`、`futures-util`；Windows-only：`notify`、`encoding_rs`、`rusqlite`（bundled SQLite）、`windows`（含进程、文件元数据查询、窗口和凭据管理器 API）。

### 6.7 会话日志定位与解析

对话历史按会话来源分别解析当前格式，不做跨应用猜测：

| 应用 | 当前读取结构 | 验证依据 |
|---|---|---|
| Claude Code | 顶层 `type=user/assistant`，正文 `message.content`；用户字符串或 `text` 内容块 | [官方 SDK SessionMessage](https://code.claude.com/docs/en/agent-sdk/typescript#getsessionmessages)、[SDKUserMessage](https://code.claude.com/docs/en/agent-sdk/typescript#sdkusermessage) 与结构测试；本机暂无 Claude JSONL |
| Codex | `response_item.payload.type=message`，角色为 user/assistant；正文数组中 `input_text/output_text` | 本机当前 Codex JSONL 实测 |
| Cursor | 顶层 `role=user/assistant`，正文 `message.content[]` 的 `text` 块 | 本机 Cursor JSONL 实测；[官方 Hook 文档](https://cursor.com/docs/hooks)提供 `transcript_path` |

已移除 Codex `event_msg.user_message/agent_message` 对话回退、`human` 角色别名、猜测的 Codex 字符串正文/`text` 块，以及 hook 的旧回复字段 `lastResponse/codex_last_assistant_message`。工具结果、思考和控制记录不作为聊天正文。`event_msg.turn_aborted/task_started/task_complete` 是当前生命周期事件，保留用于中断判定，与已删除的旧聊天正文分支无关。旧格式专有的日志不会再显示。

历史与 watcher 优先使用 hook 上报的 `transcript_path`；目录查找按来源进行：Claude 的 projects、Codex 的 `CODEX_HOME`/`.codex` 下 sessions 与 archived_sessions、Cursor 的 `.cursor/projects/<project>/agent-transcripts/<id>/<id>.jsonl`。不读取旧 Cursor 文本日志或旧目录布局。可设置 `STACKLING_TEST_TRANSCRIPT`（Codex）和 `STACKLING_TEST_CURSOR_TRANSCRIPT`（Cursor）后执行 `cargo test --manifest-path src-tauri/Cargo.toml reads_local_ --lib -- --ignored --nocapture`，只输出消息数量。

---

## 7. 约定与坑（改代码前必看）

1. **仅 Windows**：macOS/Linux/unix 代码分支已**删除**（不是 cfg 掉）。新增系统调用直接写 Windows 实现，别再加 `#[cfg(target_os="macos")]` 占位。
2. **Live2D 不要重建 PIXI**：尺寸变化用 `resizeTo`+`ResizeObserver`+`fitModel`；只有换模型(modelUrl 变)才重建 Application。重建会耗尽 WebGL 上下文 → `checkMaxIfStatementsInShader(0)` 死循环。启动那条单发 `Live2DModel._render` warn 是已知良性自恢复。
3. **跨模块 import 一律 `@/`**（指向 src-vite）；同目录用 `./`。CSS module 与 `.tsx` 同级。
4. **改默认设置**要同时改 `DEFAULT_SETTINGS` 与多处组件兜底（`InfoPanel`/`ThemeProvider`/`useTheme` no-Provider/各 Window 的 `useState` 初值）以免启动闪旧值。
5. **图标只保留 Windows 必需**（.ico/png/tray-icon）；iOS/Android/macOS 图标已删，别用 `tauri icon` 重新全量生成。
6. **生成物不进库**：`dist/`、`src-tauri/target/`、`src-tauri/gen/` 已 gitignore。`gen/` 删了 `cargo build`/`tauri dev` 会重建（编译实际用 `target/.../out/`，不依赖 `gen/`）。

---

## 8. 验证基线（改完怎么自查）

```bash
npm run build                 # 预期：tsc -b + vite build 成功；可能有 chunk >500k 的 Vite 警告
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml --lib
npm run test:hooks            # Windows：真实 PowerShell、随机 TCP 端口、权限回传与宿主字段
npm run test:messages         # 用户正文/上下文拆分与代码保留
npm run test:monitor          # 请求期间的关闭事件不丢失
```

Rust 标准测试不依赖个人配置；两个本机 transcript 测试默认忽略，需要按 §6.7 提供路径后显式运行。Hook 传输测试不启动 Agent，也不修改用户 Hook 配置。Cursor 生命周期测试使用临时 SQLite 和辅助进程；真实 Cursor 窗口切换时延仍需手工验收。

**运行自查**（`npx tauri dev`）：看板娘完整显示+待机微摆；左键开/关面板、右键开设置、失焦隐藏；会话列表/查看对话/查看统计；完成弹窗+提示音；切主题/切模型大小；模型对话输入框跟随看板娘、历史窗口优先在左侧、多会话切换/删除、Markdown/代码复制/思考折叠可用；关闭历史窗口不会被跟随逻辑重新弹出；拖动看板娘时历史窗口隐藏且拖完不自动弹回；console 无 `[Live2D] 模型加载失败`、无 `Failed to resolve import`。启动时单发 `Live2DModel._render` warn 是已知良性警告。

---

## 9. 常见任务定位

| 想做的事 | 改哪里 |
|---|---|
| 加 Live2D 模型 | `public/live2d/<id>/` + `public/live2d/manifest.json`（无需改代码） |
| 加/改主题 | [theme.ts](src-vite/features/info-panel/theme.ts) 的 `THEMES` + `THEME_ORDER` + `THEME_LABELS` |
| 加设置项 | [settingsStore.ts](src-vite/features/settings/settingsStore.ts)（AppSettings+DEFAULT+KEY）→ [SettingsPanel.tsx](src-vite/features/settings/SettingsPanel.tsx) 加 UI → 消费方读取 |
| 改看板娘表情/徽标 | [Live2DMascot.tsx](src-vite/features/live2d-mascot/Live2DMascot.tsx) 的 `STATE_BADGE` / `STATE_EXP` / RAF |
| 加 Rust 命令 | 按职责写到 `agent_*` 模块 → [lib.rs](src-tauri/src/lib.rs) `generate_handler!` 注册 → 前端 [agentMonitor.ts](src-vite/features/agent-monitor/agentMonitor.ts) 加 invoke 封装 |
| 改窗口大小/属性 | [tauri.conf.json](src-tauri/tauri.conf.json) 的 `app.windows` |
| 加窗口权限 | [capabilities/default.json](src-tauri/capabilities/default.json) |
| 改面板选位逻辑 | [windowManager.ts](src-vite/windows/windowManager.ts) `positionPanelNearMascot` |
| 改会话标题/用户消息展示 | info-panel 下 `utils.ts` / `UserMessage.tsx` / `userMessagePresentation.ts` |
| 改 Cursor 关闭检测 | `src-tauri/src/cursor_lifecycle.rs`；保持结束 hook 停用 |
| 改提示音 | [notify.ts](src-vite/shared/notify.ts) + `public/audio/` |
| 改模型对话 | [modelChatStore.ts](src-vite/features/model-chat/modelChatStore.ts) + [ChatInputWindow.tsx](src-vite/windows/ChatInputWindow.tsx) + [ChatHistoryWindow.tsx](src-vite/windows/ChatHistoryWindow.tsx) + Rust [model_chat.rs](src-tauri/src/model_chat.rs) |

---

## 10. 已知边界 / 未做

- 对话仅读取 §6.7 列出的当前格式，旧格式专有的记录不再作为聊天正文展示。
- Cursor 被动关闭检测依赖当前执行宿主和默认用户目录结构，无法确认时不删除；它是近实时检测，不是关闭 hook 的同步回调。
- 当前验证含本机 Codex/Cursor 日志解析、结构测试和构建；暂无 Claude 本机 JSONL 供实测，真实 Cursor 项目切换的端到端验收尚未完成。
- **Codex hook 需要 trust**： Codex hooks 会在首次安装或脚本变化后进入待审核状态，需要用户在 Codex 中信任 `hooks` （设置里的钩子）后才会运行。
- 待机摆动用墨染模型实际参数（`ParamBreath`/小写 `bodyZ`/`ParamAngleZ`）；换模型若无这些参数，会被 try/catch 静默跳过（物理+眨眼仍在）。
