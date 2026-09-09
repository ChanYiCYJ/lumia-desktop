import { describe, it, expect } from 'vitest'
import { extractToolCommands, stripToolCmds, toolArgsPreview } from '../toolCmds'

describe('本机工具指令解析（[TOOL:{"name":"shell","args":{...}}]）', () => {
  it('解析 shell 工具调用', () => {
    const tools = extractToolCommands('[TOOL:{"name":"shell","args":{"cmd":"ls -la"}}]')
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('shell')
    expect(tools[0].args.cmd).toBe('ls -la')
  })

  it('解析文件读写与剪贴板工具', () => {
    const t = extractToolCommands(
      '[TOOL:{"name":"read_file","args":{"path":"/tmp/a.txt"}}] [TOOL:{"name":"clipboard_write","args":{"text":"你好"}}]'
    )
    expect(t.map((x) => x.name)).toEqual(['read_file', 'clipboard_write'])
    expect(t[1].args.text).toBe('你好')
  })

  it('非法 JSON 跳过且不影响其它指令', () => {
    const t = extractToolCommands(
      '先看下 [TOOL:{bad json}] 然后 [TOOL:{"name":"list_dir","args":{"path":"/tmp"}}]'
    )
    expect(t).toHaveLength(1)
    expect(t[0].name).toBe('list_dir')
  })

  it('无工具指令返回空数组', () => {
    expect(extractToolCommands('普通回复没有工具')).toEqual([])
    expect(extractToolCommands('[SEARCH:test]')).toEqual([])
  })

  it('stripToolCmds 剥离 [TOOL:...]', () => {
    const s = stripToolCmds(
      '我来查看目录：[TOOL:{"name":"list_dir","args":{"path":"/tmp"}}] 这是结果说明'
    )
    expect(s).toBe('我来查看目录： 这是结果说明'.replace(/\s+/g, ' ').trimStart())
  })

  it('toolArgsPreview 生成可读摘要', () => {
    expect(toolArgsPreview({ name: 'shell', args: { cmd: 'ls' }, raw: '' })).toBe('ls')
    expect(toolArgsPreview({ name: 'read_file', args: { path: '/a' }, raw: '' })).toBe('/a')
    expect(toolArgsPreview({ name: 'clipboard_read', args: {}, raw: '' })).toBe('读取剪贴板')
  })
})
