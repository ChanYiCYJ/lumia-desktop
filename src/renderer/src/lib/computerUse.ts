/**
 * Computer Use（浏览器自动化）内置预设 —— 复用开源引擎 Microsoft @playwright/mcp（MIT）。
 * 不自己写浏览器自动化：把官方 Playwright MCP 作为一条 MCP 服务器接入现有
 * 「技能与 MCP」机制，AI 即可用 mcp_<id>_browser_* 工具驱动真实 Chromium 操作网页。
 * browsers 字段让主进程在首次「测试连接/调用」时自动 `npx playwright install chromium`。
 */
import type { McpServerConfig } from './mcp'

/** 内置 Computer Use 服务器预设（id 由添加时 mcpId() 生成） */
export const COMPUTER_USE_PRESET: Omit<McpServerConfig, 'id'> = {
  name: 'Computer Use',
  command: 'npx',
  args: ['-y', '@playwright/mcp@latest', '--browser', 'chromium'],
  enabled: true,
  tools: [],
  /** 首次连接前自动安装 Chromium（仅标记一次，之后不再重复安装） */
  browsers: 'chromium'
}

/** 识别 mcp 工具名是否属于 Playwright 浏览器工具（用于注入 Computer Use 技能段） */
const PLAYWRIGHT_RE =
  /browser_(navigate|snapshot|click|type|press|select_option|hover|screenshot|close|reload|go_back|go_forward|wait_for|tab_)/

/** mcp 工具清单文本里是否含 Playwright 浏览器工具 */
export function hasPlaywrightTools(mcpToolsText: string): boolean {
  return PLAYWRIGHT_RE.test(mcpToolsText || '')
}
