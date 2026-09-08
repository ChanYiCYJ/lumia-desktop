# Lumia Desktop

Lumia Agent 的桌面版 —— Electron 桌面应用，包含 AI 对话 / 三模式联网搜索 / 知识库 / 本地模型（Ollama、LM Studio）/ Live2D 虚拟形象 / TTS 朗读 / Notion 同步。

## 功能

- **AI 对话**：多模型（DeepSeek / Kimi / OpenAI / Ollama / LM Studio / 任意 OpenAI 兼容 API）、流式输出、人格笔记、会话管理（重命名/搜索/导出导入）
- **联网搜索**：Fast / Auto / Deep 三模式；本地多引擎（Bing、DuckDuckGo、Brave、Google News、Baidu、Wikipedia、天气、Bangumi、Bilibili 等）+ 可选 Tavily / Brave / SearXNG 平台；搜索意图分析、分段搜索、事实提取
- **知识库**：Markdown 条目 CRUD + AI 保存（`[KB-SAVE]`）、Notion 工作区融合（📓）与同步备份
- **Live2D**：Bestdori 角色（25+）、第三方 model.json 导入、AI 驱动表情/动作、真实音频口型同步、鼠标凝视
- **TTS**：主进程 msedge-tts 本地合成（免后端），口型与朗读同步
- **本地模型**：一键连接本机 Ollama（`http://127.0.0.1:11434/v1`）或 LM Studio（`http://127.0.0.1:1234/v1`）
- **安全**：API Key / Notion Token 经 Electron `safeStorage` 加密落盘；数据位于系统 userData 目录

## 开发

```bash
npm install          # Node 22+；Electron 二进制下载慢时可设 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm run dev          # 启动开发（electron-vite dev）
npm test             # vitest（jsdom，迁自 lumia-frontend 的 600+ 用例）
npm run build        # 类型检查 + 构建
```

## 打包

```bash
npm run build:linux  # AppImage + deb（dist/）
npm run build:win    # Windows NSIS 安装包（在 Windows 上执行）
```

标签推送 `v*` 时 GitHub Actions 自动构建 Linux + Windows 并发布 Release。

## 架构

- **Lumia 核心原样迁入**：`src/renderer/src/lib/*` 与聊天/Agent 面板组件来自 [lumia-frontend](https://github.com/ChanYiCYJ/lumia-frontend)（仅做迭代与缺陷修复，未重写）
- **本地引擎**：`src/main/agent/engine.mjs` 移植自 lumia-frontend 的 `worker.js`（Cloudflare Worker）——搜索/抓取/图片/Notion/Live2D 全部在本地执行，无 CORS、支持系统代理
- **桌面骨架**：类型安全 IPC（`src/shared/ipc.ts` + preload 桥）、窗口管理/单实例/窗口状态持久化、文件 KV 存储、safeStorage 密钥层——模式借鉴 [Cherry Studio](https://github.com/CherryHQ/cherry-studio)

## 开源致谢

本项目为 **AGPL-3.0**，大量复用了以下开源项目：

- [Cherry Studio](https://github.com/CherryHQ/cherry-studio)（AGPL-3.0）：IPC/窗口/数据服务架构与部分模式借鉴
- [lumia-frontend](https://github.com/ChanYiCYJ/lumia-frontend)：Agent 核心（搜索/技能/知识库/Live2D/TTS/Notion）
- [electron-vite](https://github.com/alex8088/electron-vite)（MIT）
- [Milkdown](https://github.com/Milkdown/milkdown)（MIT）：Markdown 编辑器
- [pixi-live2d-display](https://github.com/guansss/pixi-live2d-display)（MIT）+ Live2D Cubism
- [msedge-tts](https://github.com/Migushthe2nd/MsEdgeTTS)（MIT）：本地语音合成
- [@mozilla/readability](https://github.com/mozilla/readability)（Apache-2.0）：正文提取
- [lucide-react](https://github.com/lucide-icons/lucide)（ISC）：图标
- [Ponytail](https://github.com/DietrichGebert/ponytail)（MIT）：开发规则（`AGENTS.md`）

## 许可

AGPL-3.0（见 [LICENSE](./LICENSE)）。基于 Cherry Studio 社区版（AGPL-3.0）二次分发。
