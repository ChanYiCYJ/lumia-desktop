/**
 * Computer Use Skill（网页操作）：当已启用 MCP 服务器暴露 Playwright 浏览器工具
 * （mcp_<id>_browser_*，来自内置 Computer Use 预设 / 用户自加 @playwright/mcp）时，
 * 注入「用真实浏览器替用户操作网页」的使用指南 —— 引擎复用 @playwright/mcp（MIT），
 * 不自研浏览器自动化。多步操作（导航→快照→点击→输入）在长驻 MCP 会话内保持状态。
 */
import type { SkillContext, SkillSection } from './util'
import { hasPlaywrightTools } from '../computerUse'

export function computerUseSection(ctx: SkillContext): SkillSection | null {
  if (!ctx.mcpTools || !hasPlaywrightTools(ctx.mcpTools)) return null
  return {
    id: 'computerUse',
    text:
      '\n\n【Computer Use · 网页操作】检测到已连接浏览器自动化工具（真实 Chromium 窗口，会显示在用户屏幕上，同一浏览器在多步操作间保持状态）。当用户要求「帮我在网页上/浏览器里做…」（查资料、填表、点按钮、下单前确认等）时使用。\n' +
      '推荐循环：\n' +
      '1. browser_navigate(url) 打开页面 → 2. browser_snapshot 查看当前可交互内容（无障碍树，含可点击元素）→ 3. 据此用 browser_click / browser_type / browser_press / browser_select_option 操作 → 4. 操作后再 browser_snapshot 确认结果，直到完成任务。\n' +
      '规则：\n' +
      '1. 工具名带 mcp_ 前缀（如 mcp_xxx_browser_navigate），参数照 Playwright 语义：navigate 传 url，click 传 selector（优先用快照给出的元素/文本选择器），type 传 selector + text。\n' +
      '2. 每一步先看快照再操作，不要凭空猜选择器；页面是动态的，操作后务必再快照确认。\n' +
      '3. 登录/账号密码/支付/删除等敏感或不可逆操作，先问用户、得到明确同意再做，不要自动提交未知表单。\n' +
      '4. 只操作与用户请求相关的网页，不访问无关站点；完成后用 1-2 句话总结结果。'
  }
}
