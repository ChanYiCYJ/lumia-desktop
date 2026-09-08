# 项目说明（Copilot Instructions）

本仓库是 Lumia Desktop —— 从 lumia-frontend 的 Agent 功能抽取而来的 Electron 桌面应用。

## 架构原则（重要）
- **Lumia 已有功能不重写**：`src/renderer/src/lib/*`（search/searchAgent/searchPlanner/skills/kb/kbStore/live2d/live2dCore/live2dLore/ttsCache/notion/persona/chatSettings/promptPresets/providerPresets/modelRouter/toolCmds/markdownExt/FusionMarkdown/format/perf/feedback/siteDoc）与 `AIChat.tsx` / `AgentPanel.tsx` / `SettingsTab.tsx` / Live2D 组件全家 是从 lumia-frontend 原样迁入的成熟代码，**只做迭代与缺陷修复，不得重写**。
- **抄 Cherry Studio 只补缺失**：Electron 壳（IPC/窗口/托盘/自动更新）、文件存储模式、Ollama/LM Studio 本地模型等 lumia 没有的功能，从 CherryHQ/cherry-studio（AGPL-3.0）借鉴结构；新文件保留来源注释。
- **复用优先**（ponytail 阶梯）：能抄开源/自家代码 → 装成熟依赖 → 才手写。参考 AGENTS.md。
- **许可**：本仓库为 AGPL-3.0（与 Cherry Studio 一致），README 需声明「基于 Cherry Studio 社区版」，复制其代码的文件保留版权头。

## 命令
- `npm run dev` 启动开发（electron-vite dev）
- `npm test` 跑 vitest（lumia 迁入的 200+ 用例）
- `npm run build` 类型检查 + 构建
- `npm run build:linux` / `build:win` 打包

## 技术栈
Electron 39 + electron-vite 5 + React 19 + TS + Tailwind CSS 4（渲染层沿用 lumia 的 Tailwind 样式体系）+ Milkdown（编辑器）+ pixi-live2d-display（Live2D）。
