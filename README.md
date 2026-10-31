# Stackling

一款实时监控 Claude Code、Codex 和 Cursor 工作状态的 Live2D 桌面伙伴。

[![Version](https://img.shields.io/badge/version-1.0.0-2f855a)](https://github.com/kafuucoori/Stackling_Coding_Companion)
[![Platform](https://img.shields.io/badge/platform-Windows-0078d4)](https://github.com/kafuucoori/Stackling_Coding_Companion)
[![Tauri](https://img.shields.io/badge/Tauri-2-24c8db)](https://tauri.app/)

Stackling 将 Live2D 看板娘与 AI 编程助手的任务监控结合起来。它常驻桌面，在 Agent 工作、等待操作、整理上下文或完成任务时，通过表情、状态徽标、提示音和弹窗及时反馈。

## 应用截图

<p align="center">
  <img src="stackling-preview.png" alt="Stackling Live2D 桌面伙伴" width="210">
</p>

模型画师 [一杯吃吃](https://space.bilibili.com/335573347)

## 功能亮点

- 同时监控 Claude Code、Codex 和 Cursor 的多个本地会话。
- 展示工作中、工具调用、等待授权、上下文整理和任务完成状态。
- 查看会话对话、任务耗时、等待耗时以及近 14 天使用统计。
- 会话列表与对话详情使用统一的任务标题；用户消息支持 Markdown，运行环境、时间和页面上下文默认折叠。
- 在面板中处理 Claude Code 和 Codex 支持的权限请求。
- 使用 Live2D 表情、状态徽标、完成弹窗和提示音反馈任务进度。
- 支持四套主题、模型切换、缩放、多显示器定位和屏幕边缘吸附。
- 提供独立的模型对话窗口，支持 OpenAI Chat Completions 兼容接口、流式输出、Markdown、思考折叠和多会话历史。
- 支持 Hook 健康检查、一键修复、开机启动和历史数据自动清理。
- 启动后自动检查 GitHub Releases，也可在设置中手动检查并打开最新版本下载页。

## 使用说明

Stackling 启动后会以透明置顶的 Live2D 角色显示在桌面上。

| 操作 | 效果 |
| --- | --- |
| 左键点击角色 | 打开或关闭 Agent 信息面板 |
| 拖动角色 | 移动位置，并按设置吸附屏幕边缘 |
| 右键点击角色 | 打开设置窗口 |
| 在角色下方输入 | 与配置的模型服务进行独立对话 |
| 使用系统托盘 | 显示角色、打开设置或退出应用 |

首次启动时，Stackling 会在当前用户目录中注册自己的 Claude Code、Codex 和 Cursor Hook。Codex Hook 首次安装或脚本发生变化后，需要在 Codex 中使用 `/hooks` 审核并信任。

### Agent 接入与会话记录

| 应用 | 状态与授权 | 对话记录 |
| --- | --- | --- |
| Claude Code | 工作、工具、等待输入、上下文压缩与任务完成；支持面板授权 | 读取本机 Claude JSONL 会话文件 |
| Codex | 支持中断和会话结束；面板仅提供“拒绝 / 允许一次” | 读取当前 `response_item` 消息格式，支持 `CODEX_HOME` |
| Cursor | 使用原生 Hook 监控任务，后台检测会话关闭 | 读取当前 `agent-transcripts` JSONL 文件；不提供详细 Token 统计 |

会话标题取自最近一次任务描述，没有有效描述时显示目录名。标题由本地文本处理生成，不额外请求模型。对话视图会把 `user_query` 中的实际问题显示为正文，将运行环境、时间戳和页面上下文收进可展开的“附加信息”，原始日志保持不变。

### Cursor 切换项目

为避开 Cursor 在切换工作区时等待结束 Hook 的问题，Stackling 不注册 Cursor `sessionEnd`，也不注册会被 Cursor 导入的 Claude `SessionEnd`。升级后启动或执行 Hook 修复，会清理 Stackling 自己的旧结束 Hook，保留其他工具的 Hook 和第三方导入设置。

会话关闭改为后台被动检测：结合本地执行宿主的进程生命周期与只读工作区状态，确认关闭后立即刷新面板。检测周期为 500ms；本地状态确认关闭后通常约 0.5–1 秒更新，实际延迟取决于 Cursor 的落盘和进程退出时机。读取失败或状态尚未确认时继续使用超时兜底，不推断删除会话。

## 安装

前往 [GitHub Releases](https://github.com/kafuucoori/Stackling_Coding_Companion/releases/latest) 下载最新版
`Stackling_1.0.0_x64-setup.exe`，运行后按向导完成安装。

也可以从源码构建 Windows 安装包：

```powershell
npm install
npm run build:installer
```

安装包将生成在：

```text
src-tauri/target/release/bundle/nsis/Stackling_1.0.0_x64-setup.exe
```

安装后的应用需要 Windows 10/11 和 WebView2，Windows 11 通常已包含 WebView2。从源码构建还需要 Node.js、Rust MSVC 工具链，以及 Visual Studio C++ Build Tools 和 Windows SDK。建议在 Visual Studio 的 Developer PowerShell 中执行构建；若提示找不到 `link.exe`，需先加载 MSVC 构建环境。

## 模型对话

模型对话功能需要在设置中填写：

- OpenAI Chat Completions 兼容服务地址
- API 密钥
- 模型名称
- 可选的系统提示词和上下文设置

API 密钥保存在 Windows 凭据管理器中，不会写入普通设置文件。模型对话内容会发送到你配置的服务商；Agent 状态监控本身通过本机 Hook 和本地 TCP 通信完成。

## 开发

项目采用 Tauri 2 构建，前端为 React 19、TypeScript、Vite、PixiJS 和 Cubism 4，后端使用 Rust 与 Windows API。

```powershell
# 安装依赖
npm install

# 启动完整桌面应用
npx tauri dev

# 仅启动前端界面
npm run dev

# 构建前端
npm run build

# 用户消息展示、会话刷新与真实 PowerShell Hook 传输测试
npm run test:messages
npm run test:monitor
npm run test:hooks

# Rust 检查与单元测试
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

更完整的目录说明、数据流、Hook 协议、设置项和维护约定请阅读 [Guide-Dev.md](Guide-Dev.md)。

## 项目结构

```text
public/       Live2D 模型、Cubism 运行时和提示音
src-vite/     React 窗口、状态管理和界面功能
src-tauri/    Tauri 配置、Rust 后端、Hook 与安装器
scripts/      依赖修补与 Hook、消息展示、会话刷新回归脚本
```

## 隐私与数据

- Agent Hook 事件仅发送到本机 `127.0.0.1` 的 Stackling 服务。
- 会话信息、完成历史和模型聊天记录保存在本地应用数据目录。
- Stackling 会读取 Agent 的本地会话文件，用于展示对话和统计信息。
- Cursor 关闭检测只读本地工作区状态并查询相关进程，不写入 Cursor 的聊天数据库。
- 只有独立模型对话功能会连接用户配置的第三方 API 服务。
- 卸载时可选择同时删除 Stackling 设置和历史数据。

## 平台与限制

- 当前仅支持 Windows，不包含 macOS 或 Linux 实现。
- Cursor 暂不提供详细 Token 统计。
- 对话解析仅保留当前支持的消息结构，旧格式专有的记录不会再作为聊天正文展示。
- Cursor 被动关闭检测已针对 3.27.22 的本地结构核对；数据库检测默认查找 `%APPDATA%/Cursor/User/workspaceStorage`，自定义用户目录或后续格式变化可能需要适配。
- 关闭检测属于近实时机制；尚未建立绑定的短会话或无法确认的状态会保留超时兜底。真实窗口切换的端到端时延尚未完成运行验收。
- 不同 Live2D 模型的参数可能不同，缺少对应参数时部分呼吸或状态表情不会生效。
- Codex Hook 需要用户主动审核和信任。

## GitHub

项目地址：[kafuucoori/Stackling_Coding_Companion](https://github.com/kafuucoori/Stackling_Coding_Companion)

## 许可证

本项目采用 [MIT License](LICENSE)。
