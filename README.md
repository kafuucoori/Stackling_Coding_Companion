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

安装后的应用需要 Windows 10/11 和 WebView2，Windows 11 通常已包含 WebView2。从源码构建还需要 Node.js 与 Rust 工具链。

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

# 运行 Rust 测试
cd src-tauri
cargo test
```

更完整的目录说明、数据流、Hook 协议、设置项和维护约定请阅读 [Guide-Dev.md](Guide-Dev.md)。

## 项目结构

```text
public/       Live2D 模型、Cubism 运行时和提示音
src-vite/     React 窗口、状态管理和界面功能
src-tauri/    Tauri 配置、Rust 后端、Hook 与安装器
scripts/      安装阶段的依赖修补脚本
```

## 隐私与数据

- Agent Hook 事件仅发送到本机 `127.0.0.1` 的 Stackling 服务。
- 会话信息、完成历史和模型聊天记录保存在本地应用数据目录。
- Stackling 会读取 Agent 的本地会话文件，用于展示对话和统计信息。
- 只有独立模型对话功能会连接用户配置的第三方 API 服务。
- 卸载时可选择同时删除 Stackling 设置和历史数据。

## 平台与限制

- 当前仅支持 Windows，不包含 macOS 或 Linux 实现。
- Cursor 暂不提供详细 Token 统计。
- 不同 Live2D 模型的参数可能不同，缺少对应参数时部分呼吸或状态表情不会生效。
- Codex Hook 需要用户主动审核和信任。

## GitHub

项目地址：[kafuucoori/Stackling_Coding_Companion](https://github.com/kafuucoori/Stackling_Coding_Companion)

## 许可证

本项目采用 [MIT License](LICENSE)。
