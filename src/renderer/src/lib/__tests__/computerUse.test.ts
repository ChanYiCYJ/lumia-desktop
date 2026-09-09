import { describe, it, expect } from 'vitest'
import { assembleSystem } from '../skills'
import { computerUseSection } from '../skills/computerUseSkill'
import { hasPlaywrightTools } from '../computerUse'

const MCP_WITH_BROWSER =
  '- mcp_cu123_browser_navigate（服务器「Computer Use」）\n- mcp_cu123_browser_snapshot（服务器「Computer Use」）'
const MCP_PLAIN = '- mcp_fs_ab_read_file（服务器「filesystem」）'

describe('computerUse · Playwright 工具识别', () => {
  it('包含 browser_* 工具 → 判定为 Computer Use', () => {
    expect(hasPlaywrightTools(MCP_WITH_BROWSER)).toBe(true)
  })
  it('普通 MCP 工具 / 空 → 不是 Computer Use', () => {
    expect(hasPlaywrightTools(MCP_PLAIN)).toBe(false)
    expect(hasPlaywrightTools('')).toBe(false)
  })
})

describe('computerUseSection', () => {
  it('有 browser 工具 → 注入网页操作指南', () => {
    const s = computerUseSection({ mcpTools: MCP_WITH_BROWSER })
    expect(s).not.toBeNull()
    expect(s!.text).toContain('【Computer Use · 网页操作】')
    expect(s!.text).toContain('browser_navigate')
    expect(s!.text).toContain('browser_snapshot')
    expect(s!.text).toContain('先看快照再操作')
  })
  it('无 browser 工具 → 不注入', () => {
    expect(computerUseSection({})).toBeNull()
    expect(computerUseSection({ mcpTools: MCP_PLAIN })).toBeNull()
  })
})

describe('assembleSystem 集成', () => {
  it('mcpTools 含 browser 工具时注入 Computer Use 段（在 MCP 工具段之后）', () => {
    const s = assembleSystem({ mcpTools: MCP_WITH_BROWSER })
    const tools = s.indexOf('【MCP 扩展工具】')
    const cu = s.indexOf('【Computer Use · 网页操作】')
    expect(tools).toBeGreaterThan(-1)
    expect(cu).toBeGreaterThan(tools)
  })
  it('mcpTools 无 browser 工具时不注入 Computer Use 段', () => {
    const s = assembleSystem({ mcpTools: MCP_PLAIN })
    expect(s).not.toContain('【Computer Use · 网页操作】')
  })
})
