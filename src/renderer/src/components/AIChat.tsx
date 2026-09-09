import { useState, useRef, useEffect, useCallback, useMemo, memo } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import type { AIChatConfig, Page } from '../lib/types'
import { useSite } from '../lib/site'
import { resolveAsset } from '../lib/api'
import { useTheme } from '../lib/theme'
import {
  searchAI,
  fetchWebpage,
  searchWithCache,
  readSearchCache,
  writeSearchCache,
  webSearchWithContent,
  isContentBlocked,
  filterSensitiveResults
} from '../lib/search'
import type { SearchResult } from '../lib/search'
import { todayStr } from '../lib/searchApi'
import { runSearchAgent, formatSearchContext } from '../lib/searchAgent'
import type { SearchAgentResult } from '../lib/searchAgent'
import type { SearchProgress } from '../lib/searchPlanner'
import {
  hashMessage,
  saveFeedbackEntry,
  loadFeedback,
  getRating,
  extractPositivePattern,
  extractNegativePattern
} from '../lib/feedback'
import { applyFeedbackToSearch } from '../lib/searchPlanner'
import { detectQueryType, detectQueryLang } from '../lib/search'
import { SITE_DOC_TEXT, isSiteDocQuery, isKnowledgeFusionQuery } from '../lib/siteDoc'
import { FusionMarkdown } from '../lib/FusionMarkdown'
import {
  isNotionQuery,
  isPersonalKnowledgeQuery,
  fetchNotionContext,
  loadNotionCfg,
  hasNotionCfg,
  loadNotionDbId,
  queryNotionDatabase,
  buildNotionDbContext
} from '../lib/notion'
import {
  getKbSelections,
  getKbNotes,
  assembleKnowledge,
  parseKbTool,
  saveKbEntry,
  detectKbSaveIntent,
  loadKbEntries
} from '../lib/kb'
import { getLocalCfg, type LocalAIConfig } from '../lib/localCfg'
import {
  loadKbStoreMode,
  saveKbStoreMode,
  saveKbEntrySmart,
  deleteKbEntrySmart,
  type KnowledgeStoreMode
} from '../lib/kbStore'
import {
  queueBackupSync,
  flushBackupSync,
  syncOnRefresh,
  subscribeBackupSync,
  type BackupSyncStatus
} from '../lib/backupSync'
import {
  mergeEffCfg,
  hasLocalApi,
  lsGet,
  saveCustomModelOn,
  loadChatFontSize,
  loadNetMode,
  saveNetMode,
  loadSearchSpeed,
  saveSearchSpeed,
  loadSearchDepth,
  saveSearchDepth,
  loadMemory,
  saveMemory,
  saveChatFontSize,
  compressMemory,
  loadPersonaKnowledge,
  savePersonaKnowledge,
  loadTtsAudioUrl,
  loadTtsOn,
  saveTtsOn,
  loadTtsVolume,
  ttsVolumeValue,
  loadTtsVoice,
  saveTtsVoice,
  loadTtsSource,
  saveTtsSource,
  resolveTtsAudioUrl,
  loadLocalToolsEnabled,
  saveLocalToolsEnabled,
  type TtsSource,
  type TtsVolume,
  type TtsVoice,
  type ChatFontSize,
  type ChatNetMode,
  type ChatSearchSpeed,
  type ChatSearchDepth
} from '../lib/chatSettings'
import { hasLocalTools, runLocalTool } from '../lib/localTools'
import { buildMcpToolName, loadMcpServers, mcpCall, parseMcpToolName } from '../lib/mcp'
import { extractToolCommands, toolArgsPreview } from '../lib/toolCmds'
import { LocalApiModal } from './LocalApiModal'
import { ArticleComposerModal } from './ArticleComposerModal'
import { AgentPanel } from './AgentPanel'
// 性能优化：AgentPanel 是重型组件（含编辑器/知识库/Live2D 等）且桌面+移动双实例渲染；
// memo 后配合稳定 props，在输入/冷却/流式等父组件重渲染时跳过不必要的重复渲染
const MemoAgentPanel = memo(AgentPanel)
import { KbPicker } from './KbPicker'
import {
  detectEmotion,
  detectReplyEmotion,
  characterNameOf,
  LIVE2D_CHARACTERS,
  LIVE2D_MODEL_AUTO,
  loadLive2dModel,
  onAutoPickRequest,
  parseEmotionTag,
  resolveLive2dModel,
  saveAutoPick,
  stripEmotionTag,
  type Emotion
} from '../lib/live2d'
import {
  applyActionCommands,
  emitLive2dState,
  getState,
  loadModel,
  prepareSpeaking,
  setEmotion as applyL2dModelEmotion,
  setLive2dBusy,
  speakAudio,
  speakAudioBuffer,
  stopSpeaking,
  subscribe
} from '../lib/live2dCore'
import { cleanTtsText, getTtsAudio } from '../lib/ttsCache'
import { isNative, tts as nativeTts } from '../lib/remote'
import {
  buildLorePrompt,
  loadLore,
  loadLoreToKb,
  loadPersonaMode,
  loreSearchQuery,
  loreToText,
  saveLore,
  type Live2dLore,
  type Live2dLoreDraft,
  type Live2dPersonaMode
} from '../lib/live2dLore'
import { pickLive2dCharacter } from '../lib/ai'
import { parseDelta, resolveMaxTokens } from '../lib/providerPresets'
import type { AgentSettingsProps } from './SettingsTab'
import { useToast } from '../lib/toast'
import { Live2DBackground } from './Live2DBackground'
import { TypeWriter } from './Spinner'

interface Message {
  role: 'user' | 'assistant'
  content: string
  /** 附加的知识库条目（对话中以卡片展示，AI 上下文仍会注入内容） */
  attachments?: { id: string; title: string; content: string }[]
}

/**
 * 从 AI 回复显示文本中过滤工具指令（[SEARCH:] / [BROWSE:] / [EDIT:] / [KB-*] 等），
 * 它们由 toolCalls 小卡片承载展示，避免在消息里露出原始标记。
 */
import { stripToolCmds, type ToolCommand } from '../lib/toolCmds'
// 性能优化：低性能设备检测 + 流式更新节流（同一帧/短窗口内合并多次 chunk 更新）
import { createStreamThrottle, isLowPerfDevice, trackAICall } from '../lib/perf'
// skill 模块化提示词：每个功能一个独立提示词段，按轮次 just-in-time 组装 system
import { assembleSystem } from '../lib/skills'
// 多模型角色路由（单模型时回落 primary，行为不变）
import { resolveModelRoles, routeModel } from '../lib/modelRouter'
// auto-knowledge 人格笔记：Mem0 风格实体抽取/去重
import { mergePersonaNote } from '../lib/persona'

interface Session {
  id: string
  title: string
  messages: Message[]
  createdAt: number
}

/**
 * 消息 Markdown 渲染（memo 化）：
 * 性能优化——流式生成/长会话时仅最后一条消息内容变化，其余消息的 ReactMarkdown
 * 解析（含 rehype-highlight）每次父组件重渲染都会重复执行；抽成 memo 后，
 * content 未变的消息直接复用上一次解析结果，避免长对话/流式下反复高亮渲染卡顿。
 */
/**
 * 消息 Markdown 渲染（memo 化）：
 * 性能优化——流式生成/长会话时仅最后一条消息内容变化，其余消息的 ReactMarkdown
 * 解析（含 rehype-highlight）每次父组件重渲染都会重复执行；抽成 memo 后，
 * content 未变的消息直接复用上一次解析结果，避免长对话/流式下反复高亮渲染卡顿。
 * 渲染能力委托给 FusionMarkdown（支持 <details> 折叠块 + emoji callout + notion:// 链接）。
 */
const MarkdownContent = memo(function MarkdownContent({
  content,
  fallback
}: {
  content: string
  fallback: string
}) {
  const cleaned = stripToolCmds(content) || fallback
  return <FusionMarkdown content={cleaned} />
})

/**
 * 手机沉浸 Live2D：统一的分阶段加载打字机（搜索 → 生成 逐字切换，与 Live2D 加载同风格）。
 * TypeWriter 在 text 变化时 effect 重置，阶段切换会自然重新逐字敲出，实现「正在搜索…→正在生成…」。
 */
const PhaseTypeWriter = memo(function PhaseTypeWriter({ phase }: { phase: 'search' | 'generate' }) {
  return (
    <TypeWriter
      key={phase}
      text={phase === 'search' ? '正在搜索…' : '正在生成…'}
      loop
      className="text-xs text-gray-400 dark:text-gray-500"
    />
  )
})

/** 角色设定档案生成中的加载卡片（列表上方，阻止聊天） */
const LoreLoadingCard = memo(function LoreLoadingCard({ modelName }: { modelName: string }) {
  return (
    <div className="mb-3 flex items-center gap-3 rounded-2xl border border-gray-200 bg-white/90 p-3.5 dark:border-gray-700 dark:bg-gray-800/90">
      <span className="grid h-9 w-9 shrink-0 place-content-center rounded-full bg-gray-100 dark:bg-gray-700">
        <svg
          className="h-4 w-4 animate-spin text-gray-500 dark:text-gray-400"
          viewBox="0 0 24 24"
          fill="none"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
          />
        </svg>
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium text-gray-700 dark:text-gray-200">
          正在为「{modelName}」深度整理角色设定…
        </p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-gray-400">
          将结合网络搜索资料与深度思考，生成完整的人物世界观·人格档案（世界观 / 性格 / 人物资料 /
          朋友关系），期间暂不能发送消息
        </p>
      </div>
    </div>
  )
})

/** 工具调用卡片（挂到 AI 消息底部，可点击打开 Agent 面板） */
interface ChatToolCall {
  msgIdx: number
  type: string
  detail: string
  tab?: 'web' | 'kb' | 'edit' | 'settings'
  /** 浏览/搜索关键词（点击卡片时传给 Agent 面板触发 AI 搜索） */
  query?: string
  /** 文章后台生成中（卡片显示「生成中…」） */
  pending?: boolean
  /** 所属会话 id（刷新后按会话恢复工具卡历史） */
  sessionId?: string
}

/** 稳定空数组：工具卡为空的消息传同一引用（避免每次渲染新建 [] 击穿 MessageItem memo） */
const EMPTY_TOOLCALLS: ChatToolCall[] = []

/** 工具卡片类型颜色（模块级常量，避免每次渲染重建） */
const TOOL_DOT: Record<string, string> = {
  保存知识库: 'bg-emerald-500',
  编辑知识库: 'bg-emerald-500',
  View: 'bg-sky-500',
  Search: 'bg-blue-500',
  优化文章: 'bg-indigo-500',
  网络资料: 'bg-amber-500',
  编辑文档: 'bg-orange-500',
  打开知识库: 'bg-teal-500',
  本地工具: 'bg-slate-500'
}

/**
 * 单条消息（memo 化）：性能优化——
 * 流式生成/长会话时父组件每次重渲染都会重建整条消息 DOM（头像/附件/工具卡/操作按钮等）。
 * 抽成 memo 后，仅 content 变化的最后一条消息重渲染，其余消息直接跳过协调；
 * 同时把工具卡预计算好传入（toolCalls 数组引用稳定），进一步减少父组件的重复过滤开销。
 * 流式中的最后一条用纯文本渲染（不做 ReactMarkdown/语法高亮），完成后切换完整 Markdown。
 */
const MessageItem = memo(function MessageItem({
  m,
  index,
  isStreamingMsg,
  avatar,
  botName,
  fontSizeCls,
  toolCalls,
  speakingIdx,
  ttsOn,
  onSpeak,
  onOpenAgent,
  onToolClick,
  feedbackRating,
  onFeedback
}: {
  m: Message
  index: number
  isStreamingMsg: boolean
  avatar?: string
  botName: string
  fontSizeCls: string
  toolCalls: ChatToolCall[]
  speakingIdx: number
  /** TTS 总开关：关闭时隐藏「朗读」按钮 */
  ttsOn: boolean
  onSpeak: (text: string, idx: number) => void
  onOpenAgent: (url: string | undefined) => void
  onToolClick: (tc: ChatToolCall) => void
  feedbackRating: 0 | 1 | -1
  onFeedback: (index: number, rating: 1 | -1) => void
}) {
  return (
    <div
      className={`group flex animate-[kfade_0.3s_ease-out] gap-3 py-4 ${
        m.role === 'user' ? 'justify-end' : ''
      } sm:py-5`}
    >
      {m.role === 'assistant' &&
        (avatar ? (
          <img src={avatar} alt="" className="mt-0.5 h-8 w-8 shrink-0 rounded-full object-cover" />
        ) : (
          <span className="mt-0.5 grid h-8 w-8 shrink-0 place-content-center rounded-full bg-gray-200 text-xs font-bold text-gray-500 dark:bg-gray-800">
            {botName.slice(0, 2) || 'AI'}
          </span>
        ))}
      <div
        className={`min-w-0 ${m.role === 'user' ? `max-w-[85%] rounded-2xl border border-gray-200 bg-gray-100 px-4 py-2.5 leading-relaxed text-gray-800 sm:max-w-[70%] dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 ${fontSizeCls}` : `flex-1 leading-relaxed text-gray-800 dark:text-gray-100 ${fontSizeCls}`}`}
      >
        {m.role === 'assistant' ? (
          <div className="chat-md">
            {isStreamingMsg ? (
              /* 流式进行中：纯文本渲染（跳过 Markdown 解析/语法高亮），完成后切回 Markdown */
              <span className="whitespace-pre-wrap">
                {stripToolCmds(stripEmotionTag(m.content))}
              </span>
            ) : (
              <MarkdownContent
                content={m.content}
                fallback={
                  toolCalls.length ? `（${toolCalls[0].type}：${toolCalls[0].detail}）` : ''
                }
              />
            )}
          </div>
        ) : (
          <>
            {m.attachments && m.attachments.length > 0 && (
              <div className="mb-1.5 flex flex-wrap gap-1.5">
                {m.attachments.map((a) => (
                  <span
                    key={a.id}
                    className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-2 py-1 text-[11px] font-medium text-blue-700 dark:border-blue-800 dark:bg-blue-900/30 dark:text-blue-300"
                    title={a.content.slice(0, 200)}
                  >
                    <svg
                      className="h-3.5 w-3.5 shrink-0"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25"
                      />
                    </svg>
                    <span className="truncate">{a.title}</span>
                  </span>
                ))}
              </div>
            )}
            <span className="whitespace-pre-wrap">{m.content}</span>
          </>
        )}
        {/* 工具调用小卡片：可点击（带箭头 + 按压反馈），不可点击则平淡 */}
        {/* 手机适配：flex-nowrap + 横向滚动，多张卡片不换行挤占空间（缩成一行滚动查看） */}
        {toolCalls.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1.5 max-sm:flex-nowrap max-sm:overflow-x-auto no-scrollbar">
            {toolCalls.map((tc, j) => (
              <button
                key={j}
                onClick={() => onToolClick(tc)}
                title={tc.tab ? '点击打开 Agent 面板' : undefined}
                className={`group inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-xs transition max-sm:shrink-0 max-sm:max-w-[70%] max-sm:px-2 max-sm:py-1 ${
                  tc.tab
                    ? 'cursor-pointer border-gray-200 bg-white text-gray-700 hover:border-blue-300 hover:bg-blue-50/50 hover:text-blue-600 active:scale-95 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:border-blue-700 dark:hover:bg-blue-900/20 dark:hover:text-blue-400'
                    : 'cursor-default border-gray-100 bg-gray-50 text-gray-400 dark:border-gray-800 dark:bg-gray-800/40 dark:text-gray-500'
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${TOOL_DOT[tc.type] || 'bg-gray-400'}`}
                />
                <span className="shrink-0 font-medium">{tc.type}</span>
                {tc.pending ? (
                  <span className="flex shrink-0 items-center gap-1 text-gray-400 dark:text-gray-500">
                    <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      />
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
                      />
                    </svg>
                    生成中…
                  </span>
                ) : (
                  <span className="min-w-0 truncate text-gray-400 dark:text-gray-500">
                    {tc.detail}
                  </span>
                )}
                {tc.tab && (
                  <svg
                    className="h-3.5 w-3.5 shrink-0 text-gray-300 transition group-hover:text-blue-500 dark:text-gray-600"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                )}
              </button>
            ))}
          </div>
        )}

        {m.role === 'assistant' && (
          <div
            className={`mt-1 flex items-center gap-1 opacity-0 transition group-hover:opacity-100 max-sm:opacity-100 ${speakingIdx === index ? 'opacity-100' : ''}`}
          >
            <button
              onClick={() => {
                navigator.clipboard.writeText(m.content).catch(() => {})
              }}
              className="rounded-md p-1 text-gray-400 transition hover:text-gray-600 dark:hover:text-gray-300"
              title="复制回复"
            >
              <svg
                className="h-3.5 w-3.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
                />
              </svg>
            </button>
            {ttsOn && (
              <button
                onClick={() => onSpeak(m.content, index)}
                className={`rounded-md p-1 transition ${speakingIdx === index ? 'text-blue-600 dark:text-blue-400' : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'}`}
                title="朗读"
              >
                <svg
                  className="h-4 w-4"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z"
                  />
                </svg>
              </button>
            )}
            <button
              onClick={() => {
                const urls = m.content.match(/https?:\/\/[^\s<>"{}|\\^`\[\]]+/g)
                onOpenAgent(urls?.[0])
              }}
              className="rounded-md p-1 text-gray-400 transition hover:text-blue-600 dark:hover:text-blue-400"
              title="在 Agent 中打开"
            >
              <svg
                className="h-3.5 w-3.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21"
                />
              </svg>
            </button>
            {/* 满意度反馈 */}
            <span className="mx-0.5 h-4 w-px bg-gray-200 dark:bg-gray-700" />
            <button
              onClick={() => onFeedback(index, 1)}
              className={`rounded-md p-1 transition ${
                feedbackRating === 1
                  ? 'text-gray-700 dark:text-gray-300'
                  : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'
              }`}
              title="满意"
            >
              <svg
                className="h-4 w-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M14 9V5a3 3 0 00-3-3l-4 9v11h11.28a2 2 0 002-1.7l1.38-9a2 2 0 00-2-2.3H14zM7 22H4a2 2 0 01-2-2v-7a2 2 0 012-2h3" />
              </svg>
            </button>
            <button
              onClick={() => onFeedback(index, -1)}
              className={`rounded-md p-1 transition ${
                feedbackRating === -1
                  ? 'text-gray-700 dark:text-gray-300'
                  : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-300'
              }`}
              title="不满意"
            >
              <svg
                className="h-4 w-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M10 15v4a3 3 0 003 3l4-9V2H5.72a2 2 0 00-2 1.7l-1.38 9a2 2 0 002 2.3H10zM17 2h3a2 2 0 012 2v7a2 2 0 01-2 2h-3" />
              </svg>
            </button>
          </div>
        )}
      </div>
    </div>
  )
})

/** auto 模式搜索计数卡：只显示获取到的词条数（不展示来源/链接——避免搜索资料窗口露出违规内容） */
const SearchResultsCard = memo(function SearchResultsCard({
  results
}: {
  results: { title: string; url: string; source: string }[]
}) {
  const count = results.length
  if (count === 0) return null
  return (
    <div className="mt-2 flex gap-3">
      <span className="mt-0.5 h-8 w-8 shrink-0" />
      <div className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white/80 px-3 py-1.5 text-[11px] font-medium text-gray-400 dark:border-gray-700 dark:bg-gray-800/80 dark:text-gray-500">
        <svg
          className="h-3.5 w-3.5 shrink-0"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4.35-4.35" strokeLinecap="round" />
        </svg>
        已获取 {count} 个词条
      </div>
    </div>
  )
})

/** 导航栏角色头像：懒加载 + 加载完成淡入（优化模型图片加载），无图时显示首字占位 */
function BotAvatar({
  src,
  name,
  className = 'h-5 w-5',
  textCls = ''
}: {
  src?: string
  name?: string
  className?: string
  textCls?: string
}) {
  const [loaded, setLoaded] = useState(false)
  if (!src) {
    return (
      <span
        className={`grid shrink-0 place-content-center rounded-full bg-gray-100 text-[9px] font-bold text-gray-500 dark:bg-gray-800 dark:text-gray-300 ${textCls} ${className}`}
      >
        {(name || 'AI').slice(0, 2)}
      </span>
    )
  }
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      onLoad={() => setLoaded(true)}
      className={`shrink-0 rounded-full object-cover transition-opacity duration-300 ${loaded ? 'opacity-100' : 'opacity-0'} ${className}`}
    />
  )
}

/**
 * 空态快捷建议：基于现有功能（Live2D / 知识库操作 / 站点文档）的紧凑提示，点击直接发送给 AI 回复。
 */
const EMPTY_PROMPTS = [
  '介绍一下你的 Live2D 角色',
  '看看我的知识库里有什么',
  '介绍一下这个站点的使用文档'
]

function EmptyStateFeatures({
  className = '',
  onPick
}: {
  className?: string
  onPick: (text: string) => void
}) {
  return (
    <div className={'flex w-full flex-wrap justify-center gap-2 ' + className}>
      {EMPTY_PROMPTS.map((s) => (
        <button
          key={s}
          onClick={() => onPick(s)}
          className="rounded-full border border-gray-300 bg-white px-4 py-2 text-sm text-gray-600 transition hover:border-gray-500 hover:text-gray-900 active:scale-95 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:text-white"
        >
          {s}
        </button>
      ))}
    </div>
  )
}

export interface BotItem {
  id: number
  name: string
  config: AIChatConfig
  page: Page
}

interface AIChatProps {
  config: AIChatConfig
  pageId: number
  center?: boolean
  bots?: BotItem[]
  onSwitchBot?: (id: number) => void
  canManage?: boolean
  onManage?: () => void
  enableArticles?: boolean
  enableCustomApi?: boolean
}

const STORAGE_PREFIX = 'kimo_chat_'

/** 截断长文本到上限（末尾省略号），避免知识库/浏览文章/网络结果等上下文过度消耗 token */
function clamp(text: string, max: number): string {
  if (!text || text.length <= max) return text
  return text.slice(0, max) + '…'
}

/** Agent 面板状态（打开/tab/地址/编辑内容）持久化 key */
const AGENT_STATE_KEY = (pageId: number) => `kimo_ai_agent_state_${pageId}`
/** 各会话最近生成的 View 文章话题持久化 key */
const VIEW_TOPIC_KEY = (pageId: number) => `kimo_ai_viewtopic_${pageId}`
/** 各会话最近生成的 View 文章简介持久化 key（AI 记忆用，避免每次对话重读整篇文章） */
const VIEW_INTRO_KEY = (pageId: number) => `kimo_view_intro_${pageId}`

/** 判断用户消息是否与当前 View 文章相关（决定是否注入整篇全文 —— token 优化） */
function viewArticleRelevant(userMsg: string, topic: string): boolean {
  const t = userMsg || ''
  if (
    /文章|总结|优化|修改|精简|改|上文|这篇|那篇|内容|继续|展开|详细|推荐|介绍|讲讲|说说|作品|资料|补充|哪几部|列表|清单|整理/.test(
      t
    )
  )
    return true
  // 话题任意 ≥2 字片段命中（跳过通用词，避免误判）：如话题「2026年7月新番」→ 用户说「新番」命中
  const tk = (topic || '').replace(/[，。、；：""''（）()·\-—\s]+/g, '')
  const stop = new Set([
    '今天',
    '昨天',
    '最新',
    '今年',
    '什么',
    '怎么',
    '还有',
    '那个',
    '这个',
    '关于',
    '一个',
    '一下',
    '2026',
    '2025',
    '推荐',
    '介绍'
  ])
  for (let i = 0; i + 2 <= tk.length; i++) {
    const seg = tk.slice(i, i + 2)
    if (stop.has(seg) || /^[\d]+$/.test(seg)) continue
    if (t.includes(seg)) return true
  }
  return false
}

/**
 * View 文章生成完整后，AI 以「角色人格」提炼一段简短介绍（供聊天展示 + 记忆注入）。
 * persona 传角色人格（role 档案 buildLorePrompt 或系统提示词），让简介像角色本人说话，
 * 而非千篇一律的"已为你整理好…"。失败返回空串（不阻塞浏览流程）。
 */
async function deriveViewIntro(
  cfg: AIChatConfig,
  topic: string,
  article: string,
  persona: string
): Promise<string> {
  try {
    const body = () =>
      JSON.stringify({
        model: cfg.model,
        messages: [
          {
            role: 'system',
            content:
              (persona ? persona + '\n\n' : '') +
              '今天是 ' +
              todayStr() +
              '。你刚帮用户查到了关于「' +
              topic +
              '」的资料（综合研究文章，含多语言来源资料）。请以**你自己的性格与语气**（平时怎么跟用户聊天就怎么说），用 1-3 句简短自然地向用户介绍查到的核心内容与亮点（涉及具体数据/日期/来源站名时保留并注明）。要求：像角色本人说话，有辨识度；不要输出 Markdown 标题；不要出现「已为你整理好/简介如下/文章生成/完整文章请看面板」这类说明性套话；不要用 📋 等 emoji 前缀；不要附 [表情:] 或任何工具指令。'
          },
          { role: 'user', content: clamp(article, 3000) }
        ],
        temperature: 0.7,
        // 推理模型会先消耗 reasoning token，按模型调大避免 content 为空
        max_tokens: resolveMaxTokens(cfg.model, 400),
        stream: false
      })
    const fetchOnce = async () => {
      const res = await fetch(cfg.endpoint.replace(/\/+$/, '') + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`
        },
        body: body()
      })
      if (!res.ok) return ''
      const j = (await res.json()) as {
        choices?: { message?: { content?: string } }[]
      }
      return String(j?.choices?.[0]?.message?.content || '').trim()
    }
    let raw = await fetchOnce()
    if (!raw) raw = await fetchOnce()
    return stripToolCmds(raw).replace(/\s+/g, ' ').slice(0, 300)
  } catch {
    return ''
  }
}

async function streamChat(
  cfg: AIChatConfig,
  msgs: Message[],
  onUpdate: (content: string) => void,
  signal: AbortSignal,
  summary = '',
  knowledge = '',
  memory = '',
  web = '',
  webTools = true,
  browseMode = false,
  viewArticle = '',
  viewIntro = '',
  personaKnowledge = '',
  autoMode = false,
  fastMode = false,
  lorePrompt = '',
  pureRole = false,
  l2dEnabled = false,
  ttsMode = false,
  siteDoc = '',
  knowledgeFusion = false,
  notion = '',
  notionIntent = false,
  localTools = false,
  toolResult = undefined as { ok: boolean; output: string; error?: string } | undefined,
  mcpTools = ''
) {
  // skill 模块化：按轮次上下文与开关「just-in-time」组装 system 提示词。
  // 每个功能一个独立 skill 段（搜索/知识库/View/人格/记忆/Live2D），只注入相关段，
  // 减少「多 skill 拼一条」造成的混乱与 token 浪费（参考 Anthropic context engineering）。
  // 上下文段各自 clamp（可压缩段），指令段不 clamp（保留段）；Live2D 段仅开启时注入。
  const sys = assembleSystem({
    knowledge,
    memory,
    personaKnowledge,
    summary,
    web,
    viewArticle,
    viewIntro,
    siteDoc,
    knowledgeFusion,
    notion,
    notionIntent,
    lorePrompt,
    systemPrompt: cfg.systemPrompt,
    pureRole,
    webTools,
    browseMode,
    autoMode,
    fastMode,
    l2dEnabled,
    ttsMode,
    localTools,
    toolResult,
    mcpTools
  })
  const t0 = performance.now()
  const res = await fetch(cfg.endpoint.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: 'system', content: sys },
        ...msgs.map((m) => ({ role: m.role, content: m.content }))
      ],
      temperature: 0.7,
      stream: true,
      // 按模型适配输出上限：推理模型（reasoner/thinking）思考先占 token 必须给足；
      // Kimi moonshot-v1 默认仅 1024，长文/文章生成易被截断，自动调大
      max_tokens: resolveMaxTokens(cfg.model)
    }),
    signal
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new Error(`AI 请求失败 (${res.status})${t ? ': ' + t.slice(0, 100) : ''}`)
  }
  const reader = res.body?.getReader()
  if (!reader) throw new Error('不支持流式')
  const dec = new TextDecoder()
  let full = ''
  // 推理模型（reasoner/thinking）思考在 delta.reasoning_content 或 <|thinking|> 内，
  // 本地累计仅用于从正文剥离，不展示、不入消息
  let reasoning = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    for (const line of dec
      .decode(value, { stream: true })
      .split('\n')
      .filter((l) => l.startsWith('data: '))) {
      const d = line.slice(6)
      if (d === '[DONE]') continue
      try {
        const j = JSON.parse(d)
        const { content: t, reasoning: rt } = parseDelta(j.choices?.[0]?.delta)
        // 兼容部分服务端把思考直接放 content（无 reasoning_content）的模型：
        // 形如 <|thinking|>...<|/thinking|> 时剥离，仅保留正文
        if (rt) {
          reasoning += rt
        } else if (t) {
          const isReasoningStream =
            cfg.model.toLowerCase().includes('reasoner') ||
            cfg.model.toLowerCase().includes('thinking')
          if (isReasoningStream && t.includes('<|thinking|>')) {
            let rest = t
            while (rest.includes('<|thinking|>')) {
              const i0 = rest.indexOf('<|thinking|>')
              const i1 = rest.indexOf('<|/thinking|>')
              if (i1 > i0) {
                full += rest.slice(0, i0)
                reasoning += rest.slice(i0 + '<|thinking|>'.length, i1)
                rest = rest.slice(i1 + '<|/thinking|>'.length)
              } else {
                // 未闭合：当前块之后的剩余都视为思考（下次 chunk 拼接）
                full += rest.slice(0, i0)
                reasoning += rest.slice(i0 + '<|thinking|>'.length)
                rest = ''
              }
            }
            full += rest
            onUpdate(full)
          } else {
            full += t
            onUpdate(full)
          }
        }
      } catch {}
    }
  }
  // 埋点：记录 system 字符数（≈token）与耗时，供优化前后对比（不影响功能）
  trackAICall({
    task: 'chat',
    model: cfg.model,
    sysChars: sys.length,
    ms: Math.round(performance.now() - t0),
    ts: Date.now()
  })
  return { content: full }
}

/** TTS 朗读文本 */
const SESSION_STORAGE = (pageId: number) => STORAGE_PREFIX + 'sessions_' + pageId

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}

/** 用 AI 从对话上下文提炼 1 个搜索关键词（避免把闲聊/追问当关键词），失败返回空串 */
async function deriveSearchKeyword(cfg: AIChatConfig, msgs: Message[]): Promise<string> {
  try {
    const t0 = performance.now()
    const convo = msgs
      .slice(-5)
      .map(
        (m) =>
          `${m.role === 'user' ? '用户' : 'AI'}：${m.content
            .replace(/\[[\s\S]*?\]/g, '')
            .slice(0, 200)}`
      )
      .join('\n')
    if (!convo.trim()) return ''
    const sys =
      '你是搜索关键词提取器。今天是 ' +
      todayStr() +
      '。根据下面这段对话，提炼 1 个最合适的网络搜索关键词，**必须多语言混合**：保留用户原语言关键词 + 空格 + 英文翻译（整体 5-40 字，可直接用于搜索引擎）；若话题涉及日本动漫/新番/日文资料，再附日文关键词；涉及韩国内容附韩文。示例：中文「2026年7月新番」→「2026年7月新番 anime summer 2026 夏アニメ」；日文「2026年夏アニメ」→「2026年夏アニメ 一覧 anime summer 2026 2026年7月新番」；英文「summer anime lineup」→「2026 summer anime lineup 2026年7月新番 夏アニメ」。这样中英日多语源都能命中；若涉及近期/最新事件，关键词里带上日期如 2026年8月。只输出关键词本身，不要引号、不要解释、不要换行。'
    const body = () =>
      JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: convo }
        ],
        temperature: 0.3,
        // 推理模型会先消耗 reasoning token，按模型调大避免 content 为空
        max_tokens: resolveMaxTokens(cfg.model, 800),
        stream: false
      })
    // 推理模型会先消耗 reasoning token，max_tokens 给足 + 空内容重试一次
    const fetchOnce = async () => {
      const res = await fetch(cfg.endpoint.replace(/\/+$/, '') + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`
        },
        body: body()
      })
      if (!res.ok) return ''
      const j = (await res.json()) as {
        choices?: { message?: { content?: string } }[]
      }
      return String(j?.choices?.[0]?.message?.content || '').trim()
    }
    let raw = await fetchOnce()
    if (!raw) raw = await fetchOnce()
    const kw = raw.replace(/["'“”]/g, '').replace(/\n+/g, ' ')
    trackAICall({
      task: 'deriveKeyword',
      model: cfg.model,
      sysChars: sys.length,
      ms: Math.round(performance.now() - t0),
      ts: Date.now()
    })
    return kw.slice(0, 40)
  } catch {
    return ''
  }
}

/**
 * auto-knowledge：对话完成后在后台提炼「人格笔记」+ 值得联网补充的话题关键词。
 * 返回 { note, keyword }；失败返回空。
 */
async function derivePersonaKnowledge(
  cfg: AIChatConfig,
  msgs: Message[],
  currentKnowledge: string
): Promise<{ note: string; keyword: string }> {
  try {
    const t0 = performance.now()
    const convo = msgs
      .slice(-6)
      .map(
        (m) =>
          `${m.role === 'user' ? '用户' : 'AI'}：${m.content
            .replace(/\[[\s\S]*?\]/g, '')
            .slice(0, 180)}`
      )
      .join('\n')
    const sys =
      '你是「人格学习引擎」。阅读这段对话，提炼 1 条能让你更贴合自己人设、更懂用户的简短笔记（≤60 字，写人格洞察/用户偏好/相处之道），并给出 1 个值得联网补充了解的话题关键词（若有，否则写“无”）。严格按两行输出：\n笔记：...\n关键词：... 或 无'
    const userMsg = `已有笔记：\n${currentKnowledge || '（无）'}\n\n本次对话：\n${convo}`
    const body = () =>
      JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: userMsg }
        ],
        temperature: 0.5,
        // 推理模型会先消耗 reasoning token，按模型调大避免 content 为空
        max_tokens: resolveMaxTokens(cfg.model, 1200),
        stream: false
      })
    // 推理模型会先消耗 reasoning token，max_tokens 给足 + 空内容重试一次
    const fetchOnce = async () => {
      const res = await fetch(cfg.endpoint.replace(/\/+$/, '') + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`
        },
        body: body()
      })
      if (!res.ok) return ''
      const j = (await res.json()) as {
        choices?: { message?: { content?: string } }[]
      }
      return String(j?.choices?.[0]?.message?.content || '').trim()
    }
    let raw = await fetchOnce()
    if (!raw) raw = await fetchOnce()
    // 解析：优先 "笔记：" 前缀；取不到时把整段第一行当笔记，避免格式漂移丢数据
    const lines = raw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    let note = ''
    let keyword = ''
    for (const l of lines) {
      if (!note && /^笔记[:：]/.test(l)) note = l.replace(/^笔记[:：]\s*/, '')
      else if (/^关键词[:：]/.test(l)) keyword = l.replace(/^关键词[:：]\s*/, '')
    }
    if (!note && lines.length) {
      const first = lines[0].replace(/^笔记[:：]\s*/, '')
      if (!/^关键词[:：]/.test(first)) note = first
    }
    if (!keyword) {
      const k = lines.find((l) => l.startsWith('关键词'))
      if (k) keyword = k.replace(/^关键词[:：]\s*/, '')
    }
    note = note
      .replace(/["'“”]/g, '')
      .replace(/\n+/g, ' ')
      .slice(0, 80)
    const kwRaw = keyword
      .replace(/["'“”]/g, '')
      .replace(/\n+/g, ' ')
      .trim()
    const kw = kwRaw && kwRaw !== '无' ? kwRaw.slice(0, 40) : ''
    trackAICall({
      task: 'personaNote',
      model: cfg.model,
      sysChars: sys.length,
      ms: Math.round(performance.now() - t0),
      ts: Date.now()
    })
    return { note, keyword: kw }
  } catch {
    return { note: '', keyword: '' }
  }
}

/**
 * Live2D 角色设定：根据（可空的）网络资料 + AI 既有知识，生成「人物世界观·人格档案」。
 * 只输出 JSON（world/personality/tone/background/likes/relations/notes），失败返回 null。
 */
/**
 * Live2D 角色设定：分项生成「人物世界观·人格档案」。
 * 为避免一次生成敷衍，按维度分开调用 AI：①世界观与性格 ②人物资料（背景/喜好） ③朋友与重要关系 ④资料要点。
 * 每维度独立 JSON 输出、独立容错（失败返回空字段），合并后整体校验。
 */
async function deriveLive2dLore(
  cfg: AIChatConfig,
  name: string,
  webText: string
): Promise<Live2dLoreDraft | null> {
  const slice = (s: string, n = 320) => (s || '').trim().slice(0, n)
  const baseUser = webText
    ? `角色：${name}\n\n===== 网络资料 =====\n${clamp(webText, 6000)}\n===== 资料结束 =====`
    : `角色：${name}\n\n（未搜索到网络资料，请基于你的既有认知整理。）`

  /** 单次分项调用：返回 JSON 字段，失败返回 null（内部重试一次） */
  const gen = async (system: string): Promise<Record<string, string> | null> => {
    const body = () =>
      JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: baseUser }
        ],
        temperature: 0.6,
        // 推理模型会先消耗 reasoning token，按模型调大避免 content 为空
        max_tokens: resolveMaxTokens(cfg.model, 1200),
        stream: false
      })
    const fetchOnce = async () => {
      const res = await fetch(cfg.endpoint.replace(/\/+$/, '') + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`
        },
        body: body()
      })
      if (!res.ok) return ''
      const j = (await res.json()) as {
        choices?: { message?: { content?: string } }[]
      }
      return String(j?.choices?.[0]?.message?.content || '').trim()
    }
    let raw = await fetchOnce()
    if (!raw) raw = await fetchOnce()
    // 容错：剥掉 ```json ... ``` 包裹（AI 偶尔会包一层代码块）
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    try {
      const j = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>
      const out: Record<string, string> = {}
      for (const k of Object.keys(j)) out[k] = String(j[k] ?? '').trim()
      return out
    } catch {
      return null
    }
  }

  // 分项并行生成（分开生成更完整，避免一次生成敷衍）
  const head =
    '你是角色资料整理引擎。请深度思考，结合网络资料（可能为空则依赖你对这个角色的既有认知）、官方设定与剧情细节，从多角度深入挖掘，专注整理角色的【'
  const tail =
    '】。只输出一个 JSON 对象（不要多余文字、不要 markdown 代码块），中文，客观克制，不要露骨或编造明显违背作品设定的内容。'
  const [core, profile, rels, notesGen] = await Promise.all([
    gen(
      head +
        '世界观与性格' +
        tail +
        ' 字段：world（世界观，角色所在作品/世界的背景，40-180 字）、personality（性格，40-180 字）、tone（语气/说话风格，20-120 字）'
    ),
    gen(
      head +
        '人物资料' +
        tail +
        ' 字段：background（背景故事/经历，40-200 字）、likes（喜好与擅长，40-160 字）'
    ),
    gen(
      head +
        '朋友与重要关系' +
        tail +
        ' 字段：relations（重要关系/同伴/家人，列出具体名字与关系，越具体越好，40-220 字）'
    ),
    gen(
      head +
        '资料要点' +
        tail +
        ' 字段：notes（把网络资料中的关键事实浓缩成 2-4 条，各条用分号分隔；若无资料写空字符串）'
    )
  ])

  const draft: Live2dLoreDraft = {
    world: slice(core?.world ?? ''),
    personality: slice(core?.personality ?? ''),
    tone: slice(core?.tone ?? ''),
    background: slice(profile?.background ?? ''),
    likes: slice(profile?.likes ?? ''),
    relations: slice(rels?.relations ?? ''),
    notes: slice(notesGen?.notes ?? '', 500)
  }
  if (!draft.world && !draft.personality && !draft.background && !draft.relations) return null
  return draft
}

export function AIChat({
  config,
  pageId,
  center,
  bots,
  onSwitchBot,
  canManage,
  onManage,
  enableCustomApi
}: AIChatProps) {
  const { settings } = useSite()
  const { toast } = useToast()
  const { mode: themeMode, setMode: setThemeMode } = useTheme()
  // 站点标签/图标：AI Chat 页面用当前 AI 机器人的名称与头像（Layout/SiteProvider 在 /ai 路径已跳过站点标题设置，避免覆盖）
  useEffect(() => {
    document.title = config.botName || 'AI'
    if (config.avatar) {
      const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
      if (link) link.href = resolveAsset(config.avatar)
    }
  }, [config.botName, config.avatar])
  const [sessions, setSessions] = useState<Session[]>(() => {
    try {
      const r = localStorage.getItem(SESSION_STORAGE(pageId))
      if (r) {
        const p = JSON.parse(r)
        if (Array.isArray(p) && p.length) return p
      }
    } catch {}
    return [{ id: uid(), title: '新对话', messages: [], createdAt: Date.now() }]
  })
  const [activeId, setActiveId] = useState<string>(() => sessions[0]?.id || '')
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  /**
   * 流式进行中标记：用于「流式期间最后一条消息走轻量纯文本渲染，完成后切回 Markdown」，
   * 避免每条 stream chunk 触发 ReactMarkdown 解析 + 语法高亮拖垮低端设备。
   */
  const [streaming, setStreaming] = useState(false)
  /** 流式生命周期：开启时标记 streaming（最后一条走纯文本渲染）并在低性能设备上暂挂 Live2D 渲染，
   *  结束/失败/中止时恢复，避免生成期间 Live2D 与 React 重渲染在主线程抢资源 */
  const beginStreaming = useCallback(() => {
    setStreaming(true)
    setImmersiveExpand(false)
    if (isLowPerfDevice()) setLive2dBusy(true)
  }, [])
  const endStreaming = useCallback(() => {
    setStreaming(false)
    if (isLowPerfDevice()) setLive2dBusy(false)
  }, [])
  const [cooldown, setCooldown] = useState(() => {
    try {
      const end = Number(localStorage.getItem(STORAGE_PREFIX + 'cooldown_' + pageId))
      if (end > Date.now()) return Math.ceil((end - Date.now()) / 1000)
    } catch {}
    return 0
  })
  const [speakingIdx, setSpeakingIdx] = useState(-1)
  /** 朗读播放 token：新朗读/停止会使 in-flight 异步合成作废（防旧的缓存命中后覆盖新朗读） */
  const ttsPlayRef = useRef(0)
  const [stick, setStick] = useState(true)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem('kimo_ai_sidebar_collapsed') === '1'
    } catch {
      return false
    }
  })
  /** 侧边栏会话拖拽排序：拖拽中的卡片索引 + 悬停目标索引（用于插入指示） */
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null)
  const [localCfg, setLocalCfg] = useState(() => getLocalCfg(pageId))
  // 自定义模型开关：关闭后不再识别为自定义（本地配置保留，重新开启即恢复）
  const [customModelOn, setCustomModelOn] = useState(() => {
    // 显式关闭("0")必须尊重用户选择；"1"=开启；从未设置过则按旧数据迁移（已配置本地 API 视为开启）
    const raw = lsGet('kimo_ai_custom_model')
    if (raw === '0') return false
    if (raw === '1') return true
    return hasLocalApi(getLocalCfg(pageId))
  })
  const toggleCustomModel = useCallback(() => {
    setCustomModelOn((v) => {
      const n = !v
      saveCustomModelOn(n)
      return n
    })
    queueBackupSync('settings') // 设置变更 → 自动备份
  }, [])
  const [apiModalOpen, setApiModalOpen] = useState(false)
  const [articleOpen, setArticleOpen] = useState(false)
  const [agentOpen, setAgentOpen] = useState(() => {
    try {
      const s = JSON.parse(localStorage.getItem(AGENT_STATE_KEY(pageId)) || '{}')
      return s.open === true
    } catch {}
    return false
  })
  /** 移动端「工具箱」入口小提示（浏览/知识库/编辑器），首次显示几秒后消失 */
  const [agentHint, setAgentHint] = useState(false)
  useEffect(() => {
    // 桌面端不需要提示；仅移动端且尚未提示过时显示
    const shown = localStorage.getItem('kimo_agent_hint_shown') === '1'
    if (window.innerWidth < 1024 && !shown && !agentOpen) {
      setAgentHint(true)
      const t = setTimeout(() => {
        setAgentHint(false)
        try {
          localStorage.setItem('kimo_agent_hint_shown', '1')
        } catch {}
      }, 4000)
      return () => clearTimeout(t)
    }
  }, [agentOpen])
  const [kbPickerOpen, setKbPickerOpen] = useState(false)
  const [kbPickerSelected, setKbPickerSelected] = useState<string[]>([])
  const [kbAttachments, setKbAttachments] = useState<
    { id: string; title: string; content: string }[]
  >([])
  /** 知识库弹窗：选中回调稳定化（配合 KbPicker 的 memo 行组件，弹窗期间父组件重渲染不导致全量重建） */
  const onKbPickerToggle = useCallback((id: string) => {
    setKbPickerSelected((p) => (p.includes(id) ? p.filter((x: string) => x !== id) : [...p, id]))
  }, [])
  const onKbPickerInsert = useCallback(
    (notes: { id: string; title: string; content: string }[]) => {
      setKbAttachments((prev) => [
        ...prev,
        ...notes.filter((n) => !prev.find((x) => x.id === n.id))
      ])
    },
    []
  )
  // Live2D 化身：默认开启（「/」弹窗可关），AI 根据对话情境控制表情
  const [live2dOn, setLive2dOn] = useState(() => {
    try {
      return localStorage.getItem('kimo_live2d_on') !== '0'
    } catch {
      return true
    }
  })
  /** Live2D 功能是否生效（用户开关 + 后台开关） */
  const l2dEnabled = live2dOn && settings.live2d_enable !== '0'
  /** 手机布局检测（沉浸 Live2D 模式仅手机） */
  const [isMobile, setIsMobile] = useState(() =>
    typeof window === 'undefined' ? false : window.innerWidth < 1024
  )
  useEffect(() => {
    const onR = () => setIsMobile(window.innerWidth < 1024)
    window.addEventListener('resize', onR)
    return () => window.removeEventListener('resize', onR)
  }, [])
  /** 手机沉浸 Live2D：角色全屏背景 + 保留顶栏/旧输入条浮空 + 只展示 AI 一句 */
  const live2dImmersive = l2dEnabled && !agentOpen && isMobile
  /** 手机沉浸：输入框聚焦（键盘弹出）时减少底部安全区留白，避免对话栏下方出现大块空白 */
  const [inputFocused, setInputFocused] = useState(false)
  /** 手机沉浸：长回复默认限高滚动（避免遮挡 Live2D 角色），点击「展开全文」查看完整内容 */
  const [immersiveExpand, setImmersiveExpand] = useState(false)
  const toggleLive2d = useCallback(() => {
    setLive2dOn((prev) => {
      const next = !prev
      try {
        localStorage.setItem('kimo_live2d_on', next ? '1' : '0')
      } catch {}
      return next
    })
  }, [])
  /** 应用表情：直接写入 live2dCore（Agent 面板 Live2D 舞台 / 移动端 dock 订阅其状态） */
  const applyL2dEmotion = useCallback((em: Emotion) => {
    applyL2dModelEmotion(em)
  }, [])
  const [agentInitUrl, setAgentInitUrl] = useState<string | undefined>(() => {
    try {
      const s = JSON.parse(localStorage.getItem(AGENT_STATE_KEY(pageId)) || '{}')
      return s.url || undefined
    } catch {}
    return undefined
  })
  const [agentTab, setAgentTab] = useState<'web' | 'kb' | 'edit' | 'settings' | 'live2d'>(() => {
    try {
      const s = JSON.parse(localStorage.getItem(AGENT_STATE_KEY(pageId)) || '{}')
      if (s.tab === 'web' || s.tab === 'edit' || s.tab === 'settings' || s.tab === 'live2d')
        return s.tab
    } catch {}
    return 'live2d'
  })
  const [agentEditContent, setAgentEditContent] = useState<string | undefined>(() => {
    try {
      const s = JSON.parse(localStorage.getItem(AGENT_STATE_KEY(pageId)) || '{}')
      return s.edit || undefined
    } catch {}
    return undefined
  })
  /** 当前会话浏览生成的 View 文章话题（用于让 AI 读取文章并支持对话续优化） */
  const [viewTopic, setViewTopic] = useState('')
  // Agent 面板状态持久化：刷新后恢复打开状态 / tab / 地址 / 编辑内容
  useEffect(() => {
    try {
      localStorage.setItem(
        AGENT_STATE_KEY(pageId),
        JSON.stringify({
          open: agentOpen,
          tab: agentTab,
          url: agentInitUrl || '',
          edit: agentEditContent || ''
        })
      )
    } catch {}
  }, [agentOpen, agentTab, agentInitUrl, agentEditContent, pageId])
  // viewTopic 按会话记忆：切换会话恢复、变更时显式保存（避免跨会话串写）
  const saveViewTopic = useCallback(
    (sid: string, topic: string) => {
      try {
        const m = JSON.parse(localStorage.getItem(VIEW_TOPIC_KEY(pageId)) || '{}')
        if (topic) m[sid] = topic
        else delete m[sid]
        localStorage.setItem(VIEW_TOPIC_KEY(pageId), JSON.stringify(m))
      } catch {}
    },
    [pageId]
  )
  const changeViewTopic = useCallback(
    (topic: string) => {
      setViewTopic(topic)
      saveViewTopic(activeId, topic)
    },
    [activeId, saveViewTopic]
  )
  useEffect(() => {
    try {
      const m = JSON.parse(localStorage.getItem(VIEW_TOPIC_KEY(pageId)) || '{}')
      setViewTopic(m[activeId] || '')
    } catch {
      setViewTopic('')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, pageId])
  /** 当前会话 View 文章简介（生成完整后由 AI 提炼并记忆，后续对话引用省 token） */
  const [viewIntro, setViewIntro] = useState('')
  const saveViewIntro = useCallback(
    (sid: string, topic: string, intro: string) => {
      try {
        const m = JSON.parse(localStorage.getItem(VIEW_INTRO_KEY(pageId)) || '{}')
        m[sid] = { topic, intro, time: Date.now() }
        localStorage.setItem(VIEW_INTRO_KEY(pageId), JSON.stringify(m))
      } catch {}
    },
    [pageId]
  )
  // viewIntro 按会话 + 话题恢复：切换会话/话题变更时同步（话题不匹配则不注入旧简介）
  useEffect(() => {
    try {
      const m = JSON.parse(localStorage.getItem(VIEW_INTRO_KEY(pageId)) || '{}')
      const e = m[activeId]
      setViewIntro(e && e.topic === viewTopic ? String(e.intro || '') : '')
    } catch {
      setViewIntro('')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, pageId, viewTopic])
  const [agentKbOpen, setAgentKbOpen] = useState<
    | {
        nonce: number
        entry: { id: string; name: string; content: string; createdAt: number }
      }
    | undefined
  >()
  const [agentWidth, setAgentWidth] = useState(() => {
    // 拖拽允许范围 [300, 视口-360]（给聊天区留空间），这里保持一致，避免拖宽后刷新被丢弃
    const maxW = typeof window === 'undefined' ? 520 : Math.max(320, window.innerWidth - 360)
    try {
      const saved = Number(localStorage.getItem('kimo_ai_agent_width'))
      if (saved >= 300 && saved <= maxW) return saved
    } catch {}
    if (typeof window === 'undefined') return 384
    return Math.min(520, Math.max(320, Math.round(window.innerWidth * 0.3)))
  })
  const [attachedFile, setAttachedFile] = useState('')
  const [searching, setSearching] = useState(false)
  /** 分段搜索进度（阶段文字 + 子查询进度） */
  const [searchPlan, setSearchPlan] = useState<SearchProgress | null>(null)
  /** 当前轮次在对话中展示的搜索结果（auto 折叠结果卡，点击在新标签打开来源，非 view 入口） */
  const [dialogResults, setDialogResults] = useState<
    { title: string; url: string; source: string }[]
  >([])
  const [kbText, setKbText] = useState('')
  const [chatFontSize, setChatFontSize] = useState<ChatFontSize>(() => loadChatFontSize())
  const fontSizeCls =
    chatFontSize === 'sm' ? 'text-sm' : chatFontSize === 'lg' ? 'text-lg' : 'text-[15px]'
  /** TTS 总开关（默认关闭）：关闭时隐藏消息「朗读」按钮，不朗读 */
  const [ttsOn, setTtsOn] = useState<boolean>(() => loadTtsOn())
  const toggleTts = () => {
    setTtsOn((v) => {
      saveTtsOn(!v)
      return !v
    })
  }
  /** TTS 音量（音频输出控制，默认中等；设置页已移除音量调节） */
  const [ttsVolume] = useState<TtsVolume>(() => loadTtsVolume())
  /** TTS 音色（voice 参数，edge-tts 免费中文神经语音） */
  const [ttsVoice, setTtsVoice] = useState<TtsVoice>(() => loadTtsVoice())
  const setTtsVoicePersist = (v: TtsVoice) => {
    setTtsVoice(v)
    saveTtsVoice(v)
  }
  /** TTS 来源：backend=内置后端 /api/v1/tts；thirdparty=第三方地址 */
  const [ttsSource, setTtsSource] = useState<TtsSource>(() => loadTtsSource())
  const setTtsSourcePersist = (v: TtsSource) => {
    setTtsSource(v)
    saveTtsSource(v)
  }
  /** 知识库保存目标（auto/本地/Notion）：配置 Notion 后 AI 保存自动双写到 Notion */
  const [kbStoreMode, setKbStoreMode] = useState<KnowledgeStoreMode>(() => loadKbStoreMode())
  const changeKbStoreMode = (m: KnowledgeStoreMode) => {
    setKbStoreMode(m)
    saveKbStoreMode(m)
    queueBackupSync('settings') // 设置变更 → 自动备份
  }
  /** 设置页「试听」：按当前配置播一段，验证 TTS 调用 + Live2D 口型 */
  const testTts = useCallback(() => {
    const text = '你好，我是你的 AI 助手，欢迎使用语音朗读。'
    const clean = text.replace(/[*_`#~>\[\]\(\)]/g, '')
    const url = resolveTtsAudioUrl(ttsSource, loadTtsAudioUrl(), ttsVoice, clean)
    if (!url) {
      toast('请先配置音频 TTS 地址', 'error')
      return
    }
    stopSpeaking()
    if (l2dEnabled) {
      prepareSpeaking()
      applyL2dModelEmotion('happy')
    }
    speakAudio(url, {
      volume: ttsVolumeValue(ttsVolume),
      onEnd: () => stopSpeaking()
    })
    toast('正在试听…')
  }, [ttsSource, ttsVoice, ttsVolume, l2dEnabled])
  /** 网络模式：Auto(智能,默认,先按速度回答，缺准确数据自动升级) / search(联网搜索并自动生成综合文章；原 view 已整合进 search) */
  const [netMode, setNetMode] = useState<ChatNetMode>(() => loadNetMode())
  const browseAgentOn = netMode === 'search' // 仅 Deep 模式（netMode=search）：搜索并生成综合文章，View 页面仅此模式可调用
  const changeNetMode = useCallback((mode: ChatNetMode) => {
    setNetMode(mode)
    saveNetMode(mode)
  }, [])
  // 搜索速度（Fast=快速）/ 搜索深度（auto=按时敏自动判断）
  const [searchSpeed, setSearchSpeed] = useState<ChatSearchSpeed>(() => loadSearchSpeed())
  const [searchDepth, setSearchDepth] = useState<ChatSearchDepth>(() => loadSearchDepth())
  const changeSearchSpeed = useCallback((v: ChatSearchSpeed) => {
    setSearchSpeed(v)
    saveSearchSpeed(v)
  }, [])
  const changeSearchDepth = useCallback((v: ChatSearchDepth) => {
    setSearchDepth(v)
    saveSearchDepth(v)
  }, [])
  /** 搜索模式（设置页「搜索模式」卡片与「/」弹窗共用同一单选，双向同步） */
  const searchMode: 'fast' | 'auto' | 'deep' =
    netMode === 'search' ? 'deep' : searchSpeed === 'fast' ? 'fast' : 'auto'
  const changeSearchMode = useCallback(
    (m: 'fast' | 'auto' | 'deep') => {
      if (m === 'fast') {
        changeNetMode('auto')
        changeSearchSpeed('fast')
        changeSearchDepth('auto')
      } else if (m === 'deep') {
        changeNetMode('search')
        changeSearchSpeed('standard')
        changeSearchDepth('deep')
      } else {
        changeNetMode('auto')
        changeSearchSpeed('standard')
        changeSearchDepth('auto')
      }
      queueBackupSync('settings') // 设置变更 → 自动备份
    },
    [changeNetMode, changeSearchSpeed, changeSearchDepth]
  )
  /** auto-knowledge：对话后自动学习人格笔记，越聊越贴合人设（默认开启） */
  const [personaKnowledge, setPersonaKnowledge] = useState(() => loadPersonaKnowledge(pageId))
  // 防并发：一次只跑一个后台人格学习任务
  const personaRunningRef = useRef(false)
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [botMenuOpen, setBotMenuOpen] = useState(false)
  /** 模型切换下拉（portal 到 body，避免被 Agent 面板/移动弹层遮盖）；记录锚定位置 */
  const botBtnRef = useRef<HTMLButtonElement>(null)
  const [botMenuPos, setBotMenuPos] = useState<{
    left: number
    top: number
  } | null>(null)
  const toggleBotMenu = () => {
    setBotMenuOpen((v) => {
      const nv = !v
      if (nv) {
        const r = botBtnRef.current?.getBoundingClientRect()
        if (r) {
          const W = 240
          const left = Math.min(r.left, window.innerWidth - W - 8)
          setBotMenuPos({
            left: Math.max(8, left),
            top: r.bottom + 4
          })
        }
      }
      return nv
    })
  }
  const [limitReached, setLimitReached] = useState(false)
  const [toolCalls, setToolCalls] = useState<ChatToolCall[]>(() => {
    try {
      const r = JSON.parse(localStorage.getItem('kimo_ai_toolcalls_' + pageId) || '[]')
      return Array.isArray(r)
        ? r
            .filter(
              (t) => typeof t?.msgIdx === 'number' && typeof t?.type === 'string' && !t.pending
            )
            // 兼容旧数据：网络搜索/浏览网页 → Search（历史卡片名统一；原 View 已整合进 Search）
            .map((t) => ({
              ...t,
              type:
                t.type === 'search' ||
                t.type === '网络搜索' ||
                t.type === 'view' ||
                t.type === '浏览网页' ||
                t.type === 'View'
                  ? 'Search'
                  : t.type
            }))
        : []
    } catch {
      return []
    }
  })
  // 工具卡持久化（刷新后保留历史；不含生成中 pending）
  useEffect(() => {
    try {
      localStorage.setItem(
        'kimo_ai_toolcalls_' + pageId,
        JSON.stringify(toolCalls.filter((t) => !t.pending))
      )
    } catch {}
  }, [toolCalls, pageId])
  // 卡片点击后强制重新触发浏览（避免同关键词二次点击不生效）
  const [agentSearchNonce, setAgentSearchNonce] = useState(0)
  const [dailyUsed, setDailyUsed] = useState(() => {
    const today = new Date().toISOString().slice(0, 10)
    try {
      return Number(localStorage.getItem(STORAGE_PREFIX + 'daily_' + pageId + '_' + today) || 0)
    } catch {
      return 0
    }
  })
  const [memory, setMemory] = useState(() => loadMemory(pageId))
  const customApiEnabled = enableCustomApi !== false
  // 桌面版删除同意页：直接进入对话（背景约束已写入设置/文档，无需再弹一次）
  const consented = true
  // 本机工具（终端/文件/剪贴板）：仅桌面（preload 桥存在）且开关开启时注入/执行
  const [localToolsOn, setLocalToolsOn] = useState(() => hasLocalTools() && loadLocalToolsEnabled())
  const toggleLocalTools = useCallback(() => {
    setLocalToolsOn((v) => {
      const n = !v
      saveLocalToolsEnabled(n)
      return n
    })
  }, [])
  // 待确认的本机工具调用（AI 发出 [TOOL:...] 后弹确认，用户点「运行」才执行）
  const [pendingTool, setPendingTool] = useState<(ToolCommand & { msgIdx: number }) | null>(null)
  const [toolBusy, setToolBusy] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const msgListRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  // 卸载/切换会话（AICenter 用 key 重挂载）时中止进行中的流式请求，避免已卸载组件继续 setState（浪费网络/主线程）
  useEffect(() => {
    return () => {
      abortRef.current?.abort()
      abortRef.current = null
    }
  }, [])
  const timerRef = useRef<ReturnType<typeof setInterval>>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const agentPanelRef = useRef<HTMLDivElement>(null)
  /** 「/」按钮 ref：知识库弹窗锚定在其上方 */
  const kbAnchorRef = useRef<HTMLButtonElement>(null)
  const active = sessions.find((s) => s.id === activeId) || sessions[0]
  const messages = active?.messages || []
  /** 消息引用：供稳定反馈回调按索引读取最新消息（避免闭包捕获过期引用） */
  const messagesRef = useRef(messages)
  messagesRef.current = messages

  /** 工具卡按消息索引预计算（流式中 toolCalls 不变 → 映射引用稳定，配合 MessageItem memo 跳过无关消息重渲染） */
  const toolCallsByMsg = useMemo(() => {
    const map: Record<number, ChatToolCall[]> = {}
    for (const tc of toolCalls) {
      if (tc.sessionId !== activeId) continue
      // auto/fast 模式：隐藏所有指向 web 面板的工具卡（Search/View——不显示任何 view 入口）
      if (tc.tab === 'web' && searchMode !== 'deep') continue
      ;(map[tc.msgIdx] ||= []).push(tc)
    }
    return map
  }, [toolCalls, activeId, searchMode])
  /** 反馈评分缓存：msgHash → rating，跨渲染持久（流式/长会话避免对每条历史消息反复 localStorage 读） */
  const ratingCacheRef = useRef<Map<string, 0 | 1 | -1>>(new Map())
  /**
   * 反馈评分预计算：仅 messages 变化时重建；命中缓存跳过 localStorage/hash；
   * 流式中正在增长的最后一条直接 0（尚未评价，无需查），避免每 tick 对新内容做 I/O。
   */
  const feedbackRatingMap = useMemo(() => {
    const cache = ratingCacheRef.current
    const map: Record<number, 0 | 1 | -1> = {}
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]
      if (m.role !== 'assistant') continue
      if (streaming && i === messages.length - 1) {
        map[i] = 0
        continue
      }
      const h = hashMessage(m.content)
      let r = cache.get(h)
      if (r === undefined) {
        r = getRating(pageId, h)
        cache.set(h, r)
        if (cache.size > 1000) cache.clear()
      }
      map[i] = r
    }
    return map
  }, [messages, pageId, streaming])
  /** 工具卡点击：按 tab 打开 Agent 面板（web 附带关键词触发搜索） */
  const handleToolClick = useCallback(
    (tc: ChatToolCall) => {
      if (!tc.tab) return
      // auto/fast 下禁止通过工具卡打开 view 面板（Search/浏览卡点击不再进入 web 面板）
      if (tc.tab === 'web' && searchMode !== 'deep') return
      const q = tc.query || (tc.type === 'Search' ? tc.detail.split(' ')[0] : undefined)
      setAgentTab(tc.tab)
      if (tc.tab === 'web') {
        setAgentInitUrl(q)
        setAgentSearchNonce((n) => n + 1)
      }
      setAgentEditContent(undefined)
      setAgentOpen(true)
    },
    [searchMode]
  )
  /** 消息「在 Agent 中打开」：切到 web 面板并载入首个 URL */
  const handleOpenAgent = useCallback((url: string | undefined) => {
    setAgentTab('web')
    setAgentInitUrl(url)
    setAgentEditContent(undefined)
    setAgentOpen(true)
  }, [])
  // Agent 面板宽度拖拽：拖拽期间直接改 DOM 宽度（不触发 React 重渲染），松手才提交 state
  const onResizeDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const el = agentPanelRef.current
    if (!el) return
    const startX = e.clientX
    const startW = el.offsetWidth
    const prevTransition = el.style.transition
    el.style.transition = 'none'
    const onMove = (ev: MouseEvent) => {
      const d = startX - ev.clientX
      // 上限 = 视口 - 360（给聊天区留至少 360px），避免拖宽后面板/画布溢出屏幕
      const w = Math.min(Math.round(window.innerWidth - 360), Math.max(300, startW + d))
      el.style.width = w + 'px'
    }
    const onUp = () => {
      el.style.transition = prevTransition
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      // 安全宽度：拖拽结束时若面板被异常拖塌/拖出范围，钳回合法区间（防 canvas/角色塌陷）
      const w = el.offsetWidth
      const safe = Math.max(
        300,
        Math.min(window.innerWidth - 360, Number.isFinite(w) && w > 0 ? w : 380)
      )
      setAgentWidth(safe)
      try {
        localStorage.setItem('kimo_ai_agent_width', String(safe))
      } catch {}
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [])

  // 人设选择（多套人设由 BotEditorModal 配置；选中后覆盖默认 systemPrompt）
  const [activePromptIdx, setActivePromptIdx] = useState<number | null>(null)
  const allPrompts = (config.prompts || []).filter((p: { systemPrompt: string }) =>
    p.systemPrompt.trim()
  )

  // 有效配置：本地自定义 API/提示词（开关开启时生效）> 选中人设 > 机器人默认（非管理员各自本地设置）
  const effLocal: LocalAIConfig = customModelOn
    ? localCfg
    : { endpoint: '', apiKey: '', model: '', prompt: '' }
  const effCfg: AIChatConfig = mergeEffCfg(config, effLocal, activePromptIdx)
  const hasCustom = customModelOn && hasLocalApi(localCfg)
  /** 满意度反馈：存储 + 偏好学习 + 搜索定式优化 */
  const handleFeedback = useCallback(
    (m: Message, rating: 1 | -1) => {
      const msgHash = hashMessage(m.content)
      const current = getRating(pageId, msgHash)
      const finalRating = current === rating ? 0 : rating
      if (finalRating === 0) {
        const list = loadFeedback(pageId).filter((e) => e.msgHash !== msgHash)
        try {
          localStorage.setItem(`kimo_feedback_${pageId}`, JSON.stringify(list))
        } catch {}
        ratingCacheRef.current.delete(msgHash)
        toast('已取消反馈')
        return
      }
      saveFeedbackEntry(pageId, {
        msgHash,
        rating: finalRating,
        query: '',
        model: effCfg.model,
        ts: Date.now(),
        searchResults: dialogResults.length
      })
      ratingCacheRef.current.set(msgHash, finalRating)
      try {
        if (finalRating === 1) {
          const pattern = extractPositivePattern(m.content, '')
          if (pattern) {
            const existing = loadPersonaKnowledge(pageId)
            const lines = existing ? existing.split('\n').filter(Boolean) : []
            lines.push(`用户偏好（来自 👍）：${pattern}`)
            savePersonaKnowledge(pageId, lines.slice(-12).join('\n'))
            queueBackupSync('persona') // 人格笔记变更 → 自动备份
          }
          applyFeedbackToSearch(
            detectQueryType(m.content || ''),
            detectQueryLang(m.content || ''),
            1
          )
        } else {
          const pattern = extractNegativePattern(m.content, '')
          if (pattern) {
            const oldMem = loadMemory(pageId)
            const newMem = compressMemory(oldMem, `用户 👎 的回答：${pattern}`, '')
            saveMemory(pageId, newMem)
          }
          applyFeedbackToSearch(
            detectQueryType(m.content || ''),
            detectQueryLang(m.content || ''),
            -1
          )
        }
      } catch {
        /* 偏好学习失败不阻塞 */
      }
      toast(finalRating === 1 ? '已标记为满意 ✓' : '已标记为不满意 ✗')
    },
    [pageId, effCfg.model, dialogResults.length, toast]
  )

  /** 稳定反馈回调：按索引从消息引用读取，避免每次渲染新建闭包击穿 MessageItem memo */
  const handleMessageFeedback = useCallback(
    (index: number, rating: 1 | -1) => {
      const m = messagesRef.current[index]
      if (m) handleFeedback(m, rating)
    },
    [handleFeedback]
  )

  // Live2D auto 模式：让 AI 根据人设/记忆/人格笔记/知识库选一个最契合的角色
  // 挂载时（auto 已开）与收到 requestAutoPick 时各选一次；缓存 saveAutoPick，避免反复换角
  const autoPickBusyRef = useRef(false)
  useEffect(() => {
    const run = async () => {
      if (!l2dEnabled || loadLive2dModel() !== LIVE2D_MODEL_AUTO) return
      if (autoPickBusyRef.current) return
      autoPickBusyRef.current = true
      // 延迟等知识库异步加载完成后再选角
      await new Promise((r) => setTimeout(r, 1000))
      try {
        const model = await pickLive2dCharacter(
          {
            persona: effCfg.systemPrompt || '',
            botName: effCfg.botName || '',
            memory: memory || '',
            personaKnowledge: personaKnowledge || '',
            knowledge: kbText || ''
          },
          LIVE2D_CHARACTERS
        )
        if (model && getState().modelName !== model) {
          saveAutoPick(model)
          loadModel(model).catch(() => {})
        }
      } catch {
        /* AI 选角失败则保持当前（随机兜底）角色 */
      }
      autoPickBusyRef.current = false
    }
    run()
    const unsub = onAutoPickRequest(run)
    return () => unsub()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [l2dEnabled, effCfg.systemPrompt, effCfg.botName])

  // ---- Live2D 人格来源：默认「角色设定」（AI 以 Live2D 角色人格扮演）；无切换 UI，符合用户偏好 ----
  const [personaMode] = useState<Live2dPersonaMode>(() => loadPersonaMode())
  /** 角色设定档案生成中：阻止聊天并显示加载过程 */
  const [loreLoading, setLoreLoading] = useState(false)
  /** 当前 Live2D 角色（订阅 live2dCore 实际加载的模型；未加载时用配置/auto 解析结果兜底） */
  const [currentModel, setCurrentModel] = useState<string>(
    () => getState().modelName || resolveLive2dModel(settings.live2d_model)
  )
  useEffect(() => {
    const unsub = subscribe(() => {
      const st = getState()
      if (st.modelName) setCurrentModel(st.modelName)
    })
    return unsub
  }, [])
  /** 当前角色设定档案（role 模式作为人格来源；无档案/非 role 为 null） */
  const lore = useMemo(
    () => (personaMode === 'role' && currentModel ? loadLore(currentModel) : null),
    [personaMode, currentModel]
  )
  /** role 模式注入 streamChat 的人格片段（避免每次渲染重复 build） */
  const lorePrompt = useMemo(() => {
    if (personaMode !== 'role') return ''
    if (lore) return buildLorePrompt(lore)
    // 档案尚未生成/生成失败/auto 随机到无档案角色时：至少让 AI 认识自己是当前 Live2D 角色，不彻底回退助手人格
    const name = currentModel ? characterNameOf(currentModel) : ''
    return name
      ? `你是「${name}」，是对话界面中显示的 Live2D 虚拟角色。请始终以「${name}」的身份与用户自然互动，保持角色感（详细的角色设定档案整理完成后会自动补充）。当用户问你是谁、你的名字或来历时，直接告诉用户你就是「${name}」，不要说自己是通用 AI 助手。`
      : ''
  }, [personaMode, lore, currentModel])
  /** 已尝试自动搜索过的模型（避免重复触发；角色切换并发时也不会被跳过） */
  const loreProcessedRef = useRef<Set<string>>(new Set())
  const effCfgRef = useRef(effCfg)
  effCfgRef.current = effCfg

  const dailyLimit = effCfg.dailyLimit || config.dailyLimit || 0
  const dailyRemaining = dailyLimit > 0 ? Math.max(0, dailyLimit - dailyUsed) : -1

  // 性能优化：流式期间每条 chunk 都会更新会话 → localStorage 写入改防抖（300ms 合并），
  // 避免同步 setItem 高频执行阻塞主线程；卸载时兜底 flush 最新状态
  const sessionsRef = useRef<Session[]>(sessions)
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    sessionsRef.current = sessions
  }, [sessions])
  const flushSessions = useCallback(() => {
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current)
      persistTimerRef.current = null
    }
    try {
      localStorage.setItem(SESSION_STORAGE(pageId), JSON.stringify(sessionsRef.current))
    } catch {}
    queueBackupSync('sessions') // 会话变更 → 自动备份到 Notion（长防抖合并）
  }, [pageId])
  const persistSessions = useCallback(
    (next: Session[]) => {
      // 立即更新 ref（保证 flush/卸载读到最新），写入延迟合并
      sessionsRef.current = next
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current)
      persistTimerRef.current = setTimeout(flushSessions, 300)
    },
    [flushSessions]
  )
  useEffect(() => {
    return () => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current)
      try {
        localStorage.setItem(SESSION_STORAGE(pageId), JSON.stringify(sessionsRef.current))
      } catch {}
    }
  }, [pageId])

  const saveSessions = useCallback(
    (next: Session[]) => {
      setSessions(next)
      persistSessions(next)
    },
    [persistSessions]
  )

  // 更新当前会话消息：用函数式 setState 避免异步流式回调里的旧闭包导致消息丢失
  const updateActive = useCallback(
    (mut: (msgs: Message[]) => Message[]) => {
      setSessions((prev) => {
        const next = prev.map((s) => {
          if (s.id !== activeId) return s
          const msgs = mut(s.messages)
          // 首次对话自动根据用户消息设置标题
          const title =
            s.title === '新对话' && msgs.length && msgs[0].role === 'user'
              ? msgs[0].content.slice(0, 20)
              : s.title
          return { ...s, messages: msgs, title }
        })
        persistSessions(next)
        return next
      })
    },
    [activeId, persistSessions]
  )

  const newSession = useCallback(() => {
    const s: Session = {
      id: uid(),
      title: '新对话',
      messages: [],
      createdAt: Date.now()
    }
    saveSessions([s, ...sessions])
    setActiveId(s.id)
    setStick(true)
    setSidebarOpen(false)
    setLimitReached(false)
    // 新建会话：清空上一会话遗留的工具卡/内嵌浏览/搜索结果等临时状态
    setToolCalls([])
    setDialogResults([])
    setAgentKbOpen(undefined)
    setAgentEditContent(undefined)
    setAgentInitUrl(undefined)
    setAgentSearchNonce((n) => n + 1)
    setKbPickerOpen(false)
  }, [sessions, saveSessions])

  const selectSession = useCallback((id: string) => {
    setActiveId(id)
    setStick(true)
    setSidebarOpen(false)
  }, [])

  const deleteSession = useCallback(
    (e: React.MouseEvent, id: string) => {
      e.stopPropagation()
      const rest = sessions.filter((s) => s.id !== id)
      saveSessions(
        rest.length
          ? rest
          : [
              {
                id: uid(),
                title: '新对话',
                messages: [],
                createdAt: Date.now()
              }
            ]
      )
      if (id === activeId) setActiveId((rest[0] || sessions[0]).id)
    },
    [sessions, activeId, saveSessions]
  )

  // 侧边栏会话拖拽排序（HTML5 DnD，桌面端）：拖动卡片重排，顺序随 sessions 持久化；重命名中禁止拖拽
  const handleSessionDragStart = useCallback(
    (e: React.DragEvent, idx: number) => {
      if (editingSessionId) {
        e.preventDefault()
        return
      }
      setDragIdx(idx)
      try {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', String(idx))
      } catch {}
    },
    [editingSessionId]
  )
  const handleSessionDragOver = useCallback(
    (e: React.DragEvent, idx: number) => {
      e.preventDefault()
      if (dragOverIdx !== idx) setDragOverIdx(idx)
    },
    [dragOverIdx]
  )
  const handleSessionDrop = useCallback(
    (e: React.DragEvent, toIdx: number) => {
      e.preventDefault()
      const from = dragIdx
      setDragIdx(null)
      setDragOverIdx(null)
      if (from === null || from === toIdx) return
      setSessions((prev) => {
        if (from < 0 || from >= prev.length) return prev
        const next = [...prev]
        const [moved] = next.splice(from, 1)
        next.splice(Math.min(toIdx, next.length), 0, moved)
        persistSessions(next)
        return next
      })
    },
    [dragIdx, persistSessions]
  )
  const handleSessionDragEnd = useCallback(() => {
    setDragIdx(null)
    setDragOverIdx(null)
  }, [])

  useEffect(() => {
    if (activeId && !sessions.find((s) => s.id === activeId)) setActiveId(sessions[0].id)
  }, [activeId, sessions])

  const isNearBottom = () => {
    const el = msgListRef.current
    if (!el) return true
    return el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }
  // stick 的 ref 副本：让 autoScroll 回调保持稳定（不随 stick 重建），避免 focus effect 反复重绑定
  const stickRef = useRef(stick)
  stickRef.current = stick
  /** 性能优化：直接对消息容器 scrollTop 赋值（替代 scrollIntoView），避免同步布局/页面级滚动 */
  const autoScroll = useCallback(() => {
    if (!stickRef.current) return
    const el = msgListRef.current
    if (!el) return
    if (isNearBottom()) el.scrollTop = el.scrollHeight
  }, [])
  const onScroll = useCallback(() => {
    if (!isNearBottom()) setStick(false)
  }, [])
  useEffect(() => {
    if (stick) autoScroll()
  }, [messages, stick, autoScroll])

  // 手机键盘（依赖数组：autoScroll 稳定后只绑定一次，不再每次渲染重新绑定/解绑）
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    const onFocus = () => {
      setStick(true)
      setTimeout(autoScroll, 300)
    }
    el.addEventListener('focus', onFocus)
    return () => el.removeEventListener('focus', onFocus)
  }, [autoScroll])

  useEffect(() => {
    if (cooldown <= 0) {
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
      try {
        localStorage.removeItem(STORAGE_PREFIX + 'cooldown_' + pageId)
      } catch {}
      return
    }
    timerRef.current = setInterval(() => setCooldown((c) => c - 1), 1000)
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
    }
  }, [cooldown, pageId])

  const playTTS = useCallback(
    (text: string, idx: number) => {
      // TTS 总开关关闭时不朗读（隐藏按钮兜底）
      if (!ttsOn) return
      if (speakingIdx === idx) {
        ttsPlayRef.current++ // 使 in-flight 合成作废
        stopSpeaking()
        setSpeakingIdx(-1)
        return
      }
      setSpeakingIdx(idx)
      // 朗读用「清洗后的对话文字」：去 [表情:]/[工具指令] 标签 + Markdown 符号 + 多余空白
      // （cleanTtsText 与 TTS 缓存共用同一清洗，保证缓存 key 一致），避免读出“表情冒号 happy”等
      const clean = cleanTtsText(text)
      // 朗读时也触发 Live2D 表情/动作指令：用「原始文本」（含 [表情:]/[PARAM:]/[LOOK:] 等，
      // 尚未被清洗）让角色在朗读时同步表演——AI 对话里的隐藏指令被 TTS 朗读调用
      if (l2dEnabled) {
        // 朗读意图：表情动画不覆盖嘴部开合（lipSync 优先）+ 口型准备态微张
        prepareSpeaking()
        applyActionCommands(text)
        const te = parseEmotionTag(text)
        applyL2dModelEmotion(te || detectReplyEmotion(text))
      }
      const vol = ttsVolumeValue(ttsVolume)
      const thirdPartyUrl = loadTtsAudioUrl()
      // 音频 TTS（真实波形驱动口型）：按来源解析 URL
      const url = resolveTtsAudioUrl(ttsSource, thirdPartyUrl, ttsVoice, clean)
      // 桌面端：未配置第三方音频地址时由主进程 msedge-tts 本地合成（无后端依赖）
      if (isNative() && !thirdPartyUrl) {
        const token = ++ttsPlayRef.current
        const onEnd = () => {
          stopSpeaking()
          setSpeakingIdx(-1)
        }
        nativeTts({ text: clean, voice: ttsVoice })
          .then((r) => {
            if (token !== ttsPlayRef.current) return
            if (r.ok && r.url) {
              speakAudio(r.url, { volume: vol, onEnd })
            } else {
              toast(r.error || '本地语音合成失败', 'error')
              setSpeakingIdx(-1)
            }
          })
          .catch(() => setSpeakingIdx(-1))
        return
      }
      if (!url) {
        toast('请先配置音频 TTS 地址', 'error')
        setSpeakingIdx(-1)
        return
      }
      const token = ++ttsPlayRef.current
      const onEnd = () => {
        stopSpeaking()
        setSpeakingIdx(-1)
      }
      // 速度优化：命中 TTS 缓存 → decode 后的 AudioBuffer 秒播（0 网络请求 + 口型第一帧即同步）；
      // 未命中 → 合成后同样走 AudioBuffer（播放起点精确），同时写缓存供下次秒播
      getTtsAudio({
        text: clean,
        voice: ttsVoice,
        source: ttsSource,
        thirdPartyUrl
      })
        .then((r) => {
          if (token !== ttsPlayRef.current) return // 已被新朗读/停止取代
          if (r?.arrayBuffer) {
            speakAudioBuffer(r.arrayBuffer, { volume: vol, onEnd })
          } else {
            // 合成失败：回退 <audio> 直连（同 URL，兼容第三方静态音频）
            speakAudio(url, { volume: vol, onEnd })
          }
        })
        .catch(() => {
          if (token === ttsPlayRef.current) {
            speakAudio(url, { volume: vol, onEnd })
          }
        })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [speakingIdx, l2dEnabled, ttsOn, ttsVolume, ttsVoice, ttsSource]
  )

  // 知识库：根据选择 + 本地笔记组装文本（KbModal 保存后调用 refreshKb 刷新缓存）
  const refreshKb = useCallback(async () => {
    try {
      const sel = getKbSelections(pageId)
      const notes = getKbNotes()
      const text = await assembleKnowledge(sel, notes)
      setKbText(text)
    } catch {
      setKbText('')
    }
  }, [pageId])

  // ---- Notion 同步：同步状态（侧滑栏加载图标）+ 初次同步 + 恢复重载（多端收敛）+ 卸载兜底 flush ----
  const [syncStatus, setSyncStatus] = useState<BackupSyncStatus>(() => ({
    state: 'idle'
  }))
  useEffect(() => subscribeBackupSync(setSyncStatus), [])
  // 页面加载/刷新同步：双向收敛——拉取云端最新合并到本机 + 本机有而云端空则推送填充
  // （不依赖 getInitialSynced：即使首次推送失败/遗漏，刷新也会把本机数据推上云端）
  useEffect(() => {
    if (!hasNotionCfg()) return
    void syncOnRefresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // 移动端：从后台切回前台时自动同步一次（手机上长时间挂后台的数据也能同步，1 分钟内不重复）
  useEffect(() => {
    let lastVisSync = 0
    const onVis = () => {
      if (document.visibilityState !== 'visible' || !hasNotionCfg()) return
      const now = Date.now()
      if (now - lastVisSync < 60_000) return
      lastVisSync = now
      void syncOnRefresh()
    }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    const onRestored = () => {
      setMemory(loadMemory(pageId))
      setPersonaKnowledge(loadPersonaKnowledge(pageId))
      setKbStoreMode(loadKbStoreMode())
      refreshKb()
      // 多端收敛：会话历史同步后重新载入（其他设备的会话立即出现）
      try {
        const r = localStorage.getItem(SESSION_STORAGE(pageId))
        if (r) {
          const p = JSON.parse(r)
          if (Array.isArray(p) && p.length) setSessions(p)
        }
      } catch {
        /* 忽略 */
      }
    }
    window.addEventListener('kimo:backup:restored', onRestored)
    return () => window.removeEventListener('kimo:backup:restored', onRestored)
  }, [pageId, refreshKb])
  // 配置 Notion 后：重置知识库保存目标为 auto（消除残留 local，创建/编辑自动同步）+ 刷新 KB 视图
  useEffect(() => {
    const onConfigured = () => {
      setKbStoreMode(loadKbStoreMode())
      refreshKb()
    }
    window.addEventListener('kimo:notion:configured', onConfigured)
    window.addEventListener('kimo:notion:cleared', onConfigured)
    return () => {
      window.removeEventListener('kimo:notion:configured', onConfigured)
      window.removeEventListener('kimo:notion:cleared', onConfigured)
    }
  }, [refreshKb])
  useEffect(() => {
    const onUnload = () => {
      void flushBackupSync() // 离开/刷新前把待同步分类刷完（本地已即时落盘，此为云端兜底）
    }
    window.addEventListener('beforeunload', onUnload)
    window.addEventListener('pagehide', onUnload)
    return () => {
      window.removeEventListener('beforeunload', onUnload)
      window.removeEventListener('pagehide', onUnload)
    }
  }, [])

  // ---- 首次自动搜索（Live2D 角色设定）：role 模式 + 当前角色还没有档案时，自动搜索资料并写入知识库 ----
  const autoBuildLoreRef = useRef<((model: string) => Promise<void>) | null>(null)
  /** 自动搜索角色资料 + AI 生成「人物世界观·人格档案」→ 写入本地档案 + 存入知识库 */
  const autoBuildLore = useCallback(
    async (model: string) => {
      const name = characterNameOf(model)
      if (!name) return
      setLoreLoading(true)
      try {
        const query = loreSearchQuery(name, model)
        let webText = ''
        try {
          webText = query ? await webSearchWithContent(query, 4, 1800) : ''
        } catch {
          webText = ''
        }
        const draft = await deriveLive2dLore(effCfgRef.current, name, webText)
        if (!draft) {
          toast(`未能自动搜索「${name}」的角色资料，将按其已知设定回答`)
          return
        }
        const loreObj: Live2dLore = {
          model,
          name,
          ...draft,
          searched: !!webText,
          updatedAt: Date.now()
        }
        saveLore(model, loreObj)
        // 知识库隔离：默认不把角色档案混入用户知识库（设置里可开启「写入知识库」）
        if (loadLoreToKb()) {
          try {
            saveKbEntry(`「${name}」角色设定档案`, loreToText(loreObj))
          } catch {}
          refreshKb()
          toast(`已整理「${name}」角色设定档案并存入知识库`, 'success')
        } else {
          toast(`已整理「${name}」角色设定档案（可在知识库查看）`, 'success')
        }
      } finally {
        setLoreLoading(false)
        // 通知订阅组件（LoreDetail 角色资料面板）重新读档案：生成完成后自动显示新档案，
        // 无需用户重开面板（否则一直显示「暂无档案」误以为无法切换角色档案）
        emitLive2dState()
      }
    },
    [refreshKb, toast]
  )
  // 让 effect 始终调用最新的 autoBuildLore（避免 effCfg 引用变化导致 effect 反复触发）
  autoBuildLoreRef.current = autoBuildLore
  // 首次自动搜索 effect：role 模式 + 当前角色还没有档案 → 自动搜索资料并写入知识库
  // 用 Set 记录已尝试模型：即使上一个角色的搜索仍在进行，新角色出现也会被单独触发（不会因并发被跳过）
  useEffect(() => {
    // 同意规则后才自动生成角色设定（避免未同意就开始搜索/提示突兀）
    if (!consented || personaMode !== 'role' || !l2dEnabled || !currentModel) return
    if (loadLore(currentModel)) {
      loreProcessedRef.current.add(currentModel)
      return
    }
    if (loreProcessedRef.current.has(currentModel)) return
    loreProcessedRef.current.add(currentModel)
    autoBuildLoreRef.current?.(currentModel).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personaMode, l2dEnabled, currentModel, consented])

  // 知识库默认启用，初始加载时刷新
  useEffect(() => {
    refreshKb()
  }, [refreshKb])

  // 会话重命名
  const startRename = useCallback((e: React.MouseEvent, s: Session) => {
    e.stopPropagation()
    setEditingSessionId(s.id)
    setEditTitle(s.title)
  }, [])
  const commitRename = useCallback(() => {
    if (editingSessionId) {
      saveSessions(
        sessions.map((x) =>
          x.id === editingSessionId ? { ...x, title: editTitle.trim() || '新对话' } : x
        )
      )
    }
    setEditingSessionId(null)
  }, [editingSessionId, editTitle, sessions, saveSessions])

  const learn = useCallback(
    (q: string, a: string) => {
      // 自动压缩记忆（合并同主题 + 限制条数/长度），防止 token 滥用
      const next = compressMemory(memory, q, a)
      setMemory(next)
      saveMemory(pageId, next)
      queueBackupSync('memory') // AI 记忆变更 → 自动备份到 Notion
    },
    [memory, pageId]
  )

  // Markdown 文件上传解析
  const onUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setAttachedFile(file.name)
    const reader = new FileReader()
    reader.onload = () => {
      const text = String(reader.result || '')
      if (inputRef.current) {
        setInput((prev) => (prev ? prev + '\n\n' : '') + text)
      }
    }
    reader.readAsText(file)
    if (fileRef.current) fileRef.current.value = ''
  }, [])

  const send = async (overrideText?: string) => {
    const t = (overrideText ?? input).trim()
    // 手机沉浸模式：角色资料生成在后台静默进行，不阻止手机聊天
    if (!t || loading || (loreLoading && !live2dImmersive) || cooldown > 0) return

    // AI→Agent 语音触发：仅 Deep 模式（browseAgentOn）下，用户明确「打开/浏览 浏览器/网页/网站」
    // 才自动打开 Agent 网页 tab；**auto/fast 绝不自动打开 view 面板**（auto 走对话内搜索+结果卡）
    const browserCmd = t.match(/(?:打开|用|浏览)\s*(?:浏览器|网页|网站)\s*(?:搜索|查|找)?\s*(.+)?/)
    const browserUrl = t.match(/(?:打开|浏览)\s*(https?:\/\/[^\s，,。]+)/)
    if ((browserCmd || browserUrl) && browseAgentOn) {
      const target = browserUrl?.[1] || browserCmd?.[1]?.trim()
      if (target) {
        const searchUrl = target.startsWith('http')
          ? target
          : `https://www.google.com/search?q=${encodeURIComponent(target)}`
        setAgentInitUrl(searchUrl)
      }
      setAgentTab('web')
      setAgentEditContent(undefined)
      setAgentOpen(true)
    }

    // 默认服务端 API 有限制；用户自定义 API 时解除次数/冷却限制
    if (!hasCustom) {
      if (dailyLimit > 0 && dailyUsed >= dailyLimit) {
        const msg: Message = {
          role: 'assistant' as const,
          content: `今日额度已用完（${dailyLimit} 条/天）。可使用自定义 API 解除限制，或明天再试。`
        }
        updateActive((prev) => [...prev, msg])
        return
      }
      const today = new Date().toISOString().slice(0, 10)
      const newUsed = dailyUsed + 1
      setDailyUsed(newUsed)
      try {
        localStorage.setItem(STORAGE_PREFIX + 'daily_' + pageId + '_' + today, String(newUsed))
      } catch {}
      const max = effCfg.maxMessages || 0
      if (max > 0 && messages.length >= max) {
        setLimitReached(true)
        const msg: Message = {
          role: 'assistant' as const,
          content: `单次对话已达上限（${max} 条）。可使用自定义 API 解除限制，或新建会话。`
        }
        updateActive((prev) => [...prev, msg])
        return
      }
    }
    const user: Message = {
      role: 'user' as const,
      content: t,
      attachments: kbAttachments.length ? kbAttachments : undefined
    }
    const allMsgs = [...messages, user]
    // 知识库保存意图（AI 漏发 [KB-SAVE:] 时前端兜底，保证知识库操作可靠）
    const kbSaveIntent = detectKbSaveIntent(t)
    let summary = ''
    const recent = allMsgs.length > 6 ? allMsgs.slice(-6) : allMsgs
    // 用户明确要求保存时，给 AI 强调务必输出 [KB-SAVE:]，并兜底指令只追加到当前用户消息
    const kbInstr = kbSaveIntent
      ? `\n\n（用户明确要求把以上内容保存到知识库。请务必输出工具指令 [KB-SAVE:简短标题]完整内容[/KB-SAVE] 来保存，标题概括主题，内容是完整要点；不要只口头答应。如果你漏发，系统会自动保存。）`
      : ''
    // 注入附件的完整内容给 AI（显示层只展示卡片，不显示大段文字；每条截断防 token 膨胀）
    const injectAttachments = (msgs: Message[]) =>
      msgs.map((m, idx) => {
        const suffix = idx === msgs.length - 1 ? kbInstr : ''
        return m.role === 'user' && m.attachments?.length
          ? {
              role: m.role,
              content:
                m.content +
                (m.content.trim() ? '\n\n【附加知识条目】\n' : '【附加知识条目】\n') +
                m.attachments.map((a) => '- ' + a.title + '：' + clamp(a.content, 800)).join('\n') +
                suffix
            }
          : { role: m.role, content: m.content + suffix }
      })
    if (allMsgs.length > 6)
      summary = clamp(
        allMsgs
          .slice(0, allMsgs.length - 6)
          .map((m, i) => `${m.role === 'user' ? '问' : '答'}${i + 1}: ${m.content.slice(0, 60)}`)
          .join('; '),
        1500
      )
    updateActive((prev) => [...prev, user])
    setInput('')
    setKbAttachments([])
    setLoading(true)
    // Live2D 预判：先按用户消息情绪做出反应（听到你开心/难过就相应表情）；中性时按消息类型随机回应
    if (l2dEnabled) {
      const reacted = detectEmotion(t)
      if (reacted === 'neutral') {
        // 按用户消息类型多样化预判：问句→思考/惊讶，感叹→开心/惊讶，短消息→眨眼/害羞，长消息→思考
        const hasQ = /[?？]/.test(t) || /什么|怎么|如何|为什么|哪|谁|能不能/i.test(t)
        const hasExcl = /[!！]/.test(t) || /哈哈|哇|天哪|太/i.test(t)
        const isShort = t.length <= 5
        const responses: Emotion[] = hasQ
          ? ['thinking', 'thinking', 'surprised', 'thinking']
          : hasExcl
            ? ['happy', 'surprised', 'happy', 'wink']
            : isShort
              ? ['wink', 'shy', 'surprised', 'thinking']
              : ['thinking', 'thinking', 'wink', 'shy', 'surprised', 'happy']
        applyL2dEmotion(responses[Math.floor(Math.random() * responses.length)])
      } else {
        applyL2dEmotion(reacted)
      }
    }
    setStick(true)
    if (!hasCustom) {
      setCooldown(effCfg.cooldown || 60)
      try {
        localStorage.setItem(
          STORAGE_PREFIX + 'cooldown_' + pageId,
          String(Date.now() + (effCfg.cooldown || 60) * 1000)
        )
      } catch {}
    }
    const ctrl = new AbortController()
    abortRef.current = ctrl
    let reply = ''
    // Token 优化：搜索模式（browseAgentOn）下不再预抓取 webSearch(t) 注入上下文——
    // 该模式下 AI 只需输出简短引导语，真实数据由 triggerBrowse → searchWithCache 生成文章承担，
    // 预抓取既重复搜索又白耗最多 6000 字符 token；改为仅在有 URL / auto 重答时按需抓取
    let web = ''
    // 浏览器浏览：消息里含 http(s) URL 时自动抓取正文注入上下文
    const urlMatch = t.match(/https?:\/\/[^\s，,。]+/)
    if (urlMatch) {
      setSearching(true)
      try {
        const pageText = await fetchWebpage(urlMatch[0])
        if (pageText) web = '网页 ' + urlMatch[0] + ' 的内容：\n' + pageText
      } catch {
      } finally {
        setSearching(false)
      }
    }
    // 前端主动分段搜索（fast/auto）：不再依赖 AI 发 [SEARCH:] 标记
    // 启发式：必须有信息检索特征（疑问/搜索动词/较长描述），避免名字/闲聊误触"混淆"
    const isInfoQuery =
      t.length >= 4 &&
      /[\u4e00-\u9fff\u3040-\u30ffa-zA-Z]{3,}/.test(t) &&
      (/[?？吗呢么怎谁哪如何为何能不能有没有什么是不是]/.test(t) ||
        /搜索|查|找|介绍|推荐|评价|对比|区别|最新|今天|现在|当前|最近|新闻|资讯|什么是|怎么|如何|为什么/.test(
          t
        ) ||
        t.length >= 15) &&
      !/^[哈嘿嗯哦嘻呵呜哇噗喵嗷啧]{1,6}$/.test(t)
    // 已搜索到的结果（供 auto 重答复用：一次搜索、避免二次联网/清空卡片）
    // 先答后搜：预搜改为后台并行（不阻塞首字流式输出），完成后仅写 preSearched/preAnswer；
    // 结果卡不再在预搜索完成时弹出——只在 AI 发 [SEARCH:] 真正触发重答时展示，
    // 避免 AI 直接回答时残留「已获取 N 个词条」卡片却无后续重答的困惑。
    let preSearched: SearchResult[] | null = null
    let preAnswer = ''
    let preAgentResult: SearchAgentResult | null = null
    // 预搜索 Promise：AI 发 [SEARCH:] 时若预搜仍在进行，直接 await 复用，避免重复联网搜索
    let preSearchPromise: Promise<void> | null = null
    // 搜索状态协调：预搜索 / auto 重答可能并行运行，用操作计数统一管理 searching/searchPlan，
    // 解决「预搜索 finally 提前清掉重答中的『正在搜索…』」的状态竞态
    let activeSearchOps = 0
    const beginSearchOp = () => {
      activeSearchOps++
      setSearching(true)
      setSearchPlan({ stage: 'thinking' })
    }
    const endSearchOp = () => {
      activeSearchOps--
      if (activeSearchOps <= 0) {
        setSearching(false)
        setSearchPlan(null)
      }
    }
    if (!browseAgentOn && !urlMatch && isInfoQuery && searchMode === 'auto') {
      // 仅 Auto 模式做前端适当联网搜索（Fast=纯本地不做；Deep 由浏览面板搜索生成文章承担）
      preSearchPromise = (async () => {
        beginSearchOp()
        try {
          // 用 AI 从对话上下文提炼更准的关键词（快任务路由 fast 角色；失败回退原始消息）
          const derivedKw = await deriveSearchKeyword(
            routeModel(resolveModelRoles(effCfg), 'fast'),
            allMsgs
          ).catch(() => '')
          const searchQ = (derivedKw || t.trim()).slice(0, 60)
          if (!searchQ) return
          // 高级搜索智能：意图分析 → 查询改写（official/github 等后缀）→ 结构化搜索 →
          // 低质过滤 → 权威排序 → 事实提取（runSearchAgent 引擎自适应：Tavily 直连 /
          // 免费引擎分段多引擎；空结果内部 searchAI 兜底）
          const agentResult = await runSearchAgent(searchQ, '', 'auto')
          preAgentResult = agentResult
          preAnswer = agentResult.answer ?? ''
          if (agentResult.results && agentResult.results.length > 0) {
            // 结果已含低质过滤 + 相关性排序；暂存供 auto 重答复用，结果卡统一由重答时展示
            preSearched = agentResult.results
          }
        } catch {
          /* 搜索失败不阻塞对话 */
        } finally {
          endSearchOp()
        }
      })()
    }
    // 流式：始终只保留一条正在增长的 assistant 消息（替换上一条）
    // 性能优化：高频 chunk 经 rAF 节流合并（同一帧多次更新只渲一次；低性能设备刷写间隔更长），
    // 避免每个 chunk 都触发整树重渲染 + Markdown 高亮拖垮主线程
    const upsertAssistant = createStreamThrottle((content: string) => {
      updateActive((prev) => {
        const last = prev[prev.length - 1]
        return last && last.role === 'assistant'
          ? [...prev.slice(0, -1), { role: 'assistant' as const, content }]
          : [...prev, { role: 'assistant' as const, content }]
      })
    })
    // 每次发送时实时读取知识库（尊重 AI读取开关 + 附件；供主回复与 auto 重答共用）
    const kbKnowledge = (() => {
      try {
        const aiReadAll = localStorage.getItem('kimo_kb_ai_read_all') !== '0'
        const notes = aiReadAll ? getKbNotes() : []
        const attachNotes = kbAttachments.map((a: { title: string; content: string }) => ({
          title: a.title,
          content: a.content
        }))
        const all = aiReadAll ? [...attachNotes, ...notes] : attachNotes
        const unique = new Map<string, { title: string; content: string }>()
        for (const n of all) {
          if (n.content && !unique.has(n.content)) unique.set(n.content, n)
        }
        const valid = [...unique.values()]
        if (valid.length)
          return (
            '【知识库条目】\n' +
            valid
              .map((n) => '- ' + n.title + '：' + clamp(n.content, 600))
              .join('\n')
              .slice(0, 6000)
          )
      } catch {}
      return ''
    })()
    // 每次发送时读取当前 View 文章：token 优化——仅当用户消息与浏览文章相关时才注入整篇全文，
    // 否则只注入 AI 已记忆的简短简介（viewIntro），避免每次对话重复搬运整篇文章
    const viewArticle = (() => {
      if (!viewTopic) return ''
      try {
        const e = readSearchCache(viewTopic)
        if (!e?.article) return ''
        return viewArticleRelevant(t, viewTopic) ? clamp(e.article, 4000) : ''
      } catch {
        return ''
      }
    })()
    // View 简介（AI 记忆）：任何消息都注入，让 AI 始终记得已生成的资料（省 token）
    const viewIntroText = viewTopic ? viewIntro : ''
    // 本站操作文档：用户询问「本站怎么用/怎么操作/有哪些功能」时按需注入（省 token）
    const siteDoc = isSiteDocQuery(t) ? SITE_DOC_TEXT : ''
    // MCP 扩展工具：启用中的服务器 → 工具清单（提示词注入，AI 可用 mcp_<id>_<tool> 调用）
    const enabledMcp = localToolsOn
      ? loadMcpServers().filter((s) => s.enabled !== false && (s.tools?.length ?? 0) > 0)
      : []
    const mcpToolsText = enabledMcp
      .map((s) =>
        (s.tools || [])
          .map((tool) => `- ${buildMcpToolName(s, tool)}（服务器「${s.name}」）`)
          .join('\n')
      )
      .filter(Boolean)
      .join('\n')
    // 知识融合：用户要求综合多源资料（本地知识库 + 网络结果等）时按需注入（省 token）。
    // 是否有可融合的内容源由 knowledgeFusionSection 内部自行判定（无源时输出空串、零开销）
    const knowledgeFusion = isKnowledgeFusionQuery(t)
    // Notion 工作区：配置了 Token 时，显式 Notion 查询 或 个人知识/内容类查询都融合检索注入
    // （把 Notion 当作知识库的一部分，Notion 页面已自动以卡片显示在知识库）。
    // 未配置时仅显式提 Notion 才说明未连接，其余「我的知识库」类查询正常走本地知识库、不误报
    let notion = ''
    let notionIntent = false
    if (hasNotionCfg()) {
      if (isNotionQuery(t) || isPersonalKnowledgeQuery(t)) {
        const token = loadNotionCfg().token
        const parts: string[] = []
        // 配置了默认数据库且查询涉及结构化内容（任务/状态/清单等）时，自动列出最近条目
        const dbId = loadNotionDbId()
        if (dbId && /(数据库|任务|状态|清单|列表|看板|进度|事项)/.test(t)) {
          parts.push(
            await queryNotionDatabase(token, dbId, { page_size: 10 })
              .then((r) => buildNotionDbContext(r, '默认数据库'))
              .catch(() => '')
          )
        }
        parts.push(await fetchNotionContext(t, { token }).catch(() => ''))
        notion = parts.filter(Boolean).join('\n\n').slice(0, 4000)
        notionIntent = !notion
      }
    } else {
      notionIntent = isNotionQuery(t)
    }
    try {
      beginStreaming()
      const result = await streamChat(
        effCfg,
        injectAttachments(recent),
        upsertAssistant,
        ctrl.signal,
        summary,
        kbKnowledge || kbText,
        memory,
        web,
        searchMode !== 'fast',
        browseAgentOn,
        viewArticle,
        viewIntroText,
        personaKnowledge,
        searchMode === 'auto',
        searchMode === 'fast',
        lorePrompt,
        personaMode === 'role',
        l2dEnabled,
        ttsOn && (ttsSource === 'backend' || !!loadTtsAudioUrl()),
        siteDoc,
        knowledgeFusion,
        notion,
        notionIntent,
        localToolsOn,
        undefined,
        mcpToolsText
      )
      reply = result.content
    } catch (e: unknown) {
      if ((e as Error).name === 'AbortError') return
      // 违规/敏感内容被模型或网关拒绝（400/403 内容策略）→ 友好兜底，不显示"错误：…"红字
      if (isContentBlocked(e)) {
        reply = '这个话题涉及敏感或违规内容，我这边不太方便搜索和展示，咱们换个话题聊聊吧。'
      } else {
        reply = `错误：${e instanceof Error ? e.message : '请求失败'}`
      }
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null
      endStreaming()
      setLoading(false)
    }
    // Live2D 化身：AI 控制表情（[表情:xxx] 标签优先；无标签则按回复的表演提示推断）
    // 标签一律从显示文本剥离（含方括号/中文括号），Live2D 关闭时也隐藏，避免露出明文
    const tagEmotion = l2dEnabled ? parseEmotionTag(reply) : null
    // AI 动作指令（[PARAM:…]/[MOTION:…]/[EXPRESSION:…]）：在剥离前用原始回复执行，
    // 让角色实时表演参数级动作（精细控制，超出 9 种情绪标签的表达范围）
    if (l2dEnabled) applyActionCommands(reply)
    const cleanReply = stripEmotionTag(reply)
    if (l2dEnabled) {
      applyL2dEmotion(tagEmotion || detectReplyEmotion(cleanReply))
    }
    reply = cleanReply
    upsertAssistant(reply)

    // 回复完成后立即后台预合成 TTS（fire-and-forget 写缓存）：自动朗读/手动点朗读时
    // getTtsAudio 命中 in-flight 去重或缓存 → 几乎立即返回，口型从点击那一刻就动
    if (ttsOn && (ttsSource === 'backend' || !!loadTtsAudioUrl())) {
      const clean = cleanTtsText(reply)
      if (clean) {
        getTtsAudio({
          text: clean,
          voice: ttsVoice,
          source: ttsSource,
          thirdPartyUrl: loadTtsAudioUrl()
        }).catch(() => {})
      }
    }

    // 开启朗读模式（TTS）时：回复完成后自动朗读（像人一样说话）。
    // 复用 playTTS：内部清洗文本、用「原始 reply」触发 Live2D 表演（含 [PARAM:]/[LOOK:] 等指令）、
    // 走 TTS 缓存合成（首次合成并写缓存，二次秒播）并播放驱动口型。
    if (ttsOn && (ttsSource === 'backend' || !!loadTtsAudioUrl())) {
      // AI 回复在消息列表中的索引（messages 为发送前快照，assistant 回复在末尾 +1）
      const autoIdx = messages.length + 1
      playTTS(reply, autoIdx)
    }

    // AI→Agent 工具调用：解析 [BROWSE:url] / [SEARCH:query] / [EDIT:content] / [VIEW:文章] / [KB:指令]
    const browseCmd = reply.match(/\[BROWSE:\s*(https?:\/\/[^\s\]]+)\s*\]/)
    const searchCmdClosed = reply.match(/\[SEARCH:\s*([^\]]+)\s*\]/)
    // 兼容 AI 漏写闭合 ] 的 [SEARCH:（深思考模型偶发截断在 '[' 或未闭合）→ 提取已有关键词
    const searchCmdOpen =
      !searchCmdClosed && reply.includes('[SEARCH:') ? reply.match(/\[SEARCH:\s*([^\n\]]*)/) : null
    const searchCmd = searchCmdClosed || searchCmdOpen
    // EDIT 内容可能较长且 AI 偶尔不写闭合 ]，兼容未闭合到末尾的情况
    const editClosed = reply.match(/\[EDIT:\s*([\s\S]*?)\s*\]/)
    const editOpen =
      !editClosed && reply.includes('[EDIT:') ? reply.match(/\[EDIT:\s*([\s\S]*)/) : null
    const editCmd = editClosed || editOpen
    // VIEW 更新：AI 基于当前浏览文章输出优化后的完整文章
    const viewClosed = reply.match(/\[VIEW:\s*([\s\S]*?)\s*\]/)
    const viewOpen =
      !viewClosed && reply.includes('[VIEW:') ? reply.match(/\[VIEW:\s*([\s\S]*)/) : null
    const viewCmd = viewClosed || viewOpen
    const kbCmd = reply.match(/\[(?:KB|OPEN_KB|知识库)(?::\s*([^\]]+))?\]/)
    const kbSaveCmd = parseKbTool(reply)
    // 本机工具调用（[TOOL:{"name":"shell","args":{"cmd":"ls"}}]）——桌面版 AI 操作电脑
    const toolCmds = localToolsOn ? extractToolCommands(reply) : []
    // 工具卡/内嵌浏览挂到 AI 消息底部（messages 是发送前的快照：用户消息在 messages.length，AI 回复在 +1）
    const msgIdx = messages.length + 1
    // 电脑端工具触发后自动打开 Agent 面板；手机端仅展示小卡片，用户点击卡片才打开
    const autoOpenAgent = () => {
      if (window.innerWidth >= 1024) setAgentOpen(true)
    }
    // 浏览 Agent 接管：让对话回复自然——AI 已给简短回复则保留；长篇则取其开头自然引语
    const setBrowseNote = (q: string) => {
      updateActive((prev) => {
        let lastAsstIdx = -1
        for (let i = prev.length - 1; i >= 0; i--) {
          if (prev[i].role === 'assistant') {
            lastAsstIdx = i
            break
          }
        }
        if (lastAsstIdx < 0) return prev
        const c = (prev[lastAsstIdx].content || '').trim()
        // 已给出简短自然的回复（≤200 字，如“好的，我去搜一下”）→ 保留，不替换
        if (c.length <= 200) return prev
        // 长篇全问答 → 取其第一句自然引语作为简短回复，其余交给浏览文章
        const firstLine =
          c
            .split('\n')
            .map((s) => s.trim())
            .filter((s) => s && !/^[#>-]/.test(s))[0] || ''
        let short = ''
        if (firstLine) {
          const sent = firstLine.slice(0, 100)
          if (sent.length >= 6) short = sent
        }
        if (!short) short = `好的，已为你联网搜索「${q}」，正在生成综合文章，结果请看浏览面板。`
        return prev.map((m, i) => (i === lastAsstIdx ? { ...m, content: short } : m))
      })
    }
    // 统一浏览触发：桌面自动弹面板、手机仅出卡片；后台生成文章（写缓存）供点卡片即看
    const triggerBrowse = (q: string, label: string, opts?: { keepReply?: boolean }) => {
      // 防线（关键）：仅 Deep 模式可触发 view 生成/打开面板；
      // auto/fast 一律直接忽略——即使未来新增任何误调路径也绝不自动打开 view
      if (searchMode !== 'deep') return
      setAgentTab('web')
      setAgentInitUrl(q)
      autoOpenAgent()
      if (!opts?.keepReply) setBrowseNote(q.slice(0, 60))
      setToolCalls((prev) => [
        ...prev,
        {
          msgIdx,
          type: label,
          detail: q.slice(0, 60),
          tab: 'web',
          query: q,
          pending: true,
          sessionId: activeId
        }
      ])
      // 来源数/正文长度按速度与深度调整：Fast 精简、deep 加量
      const srcs = searchSpeed === 'fast' ? 3 : searchDepth === 'deep' ? 7 : 5
      const chars = searchSpeed === 'fast' ? 1400 : searchDepth === 'deep' ? 2600 : 2200
      searchWithCache(q, { maxSources: srcs, perSourceChars: chars })
        .then((r) => {
          // 生成成功：记录当前 View 文章话题，供 AI 读取 / 对话续优化
          if (r && r.article) {
            changeViewTopic(q)
            // View 生成完整后：AI 以角色人格提炼简短介绍 → 直接以角色口吻追加到对话（不套模板）
            // + 存入记忆（后续对话引用省 token）
            if (r.article.trim()) {
              const persona = lorePrompt || effCfgRef.current.systemPrompt || ''
              deriveViewIntro(effCfgRef.current, q, r.article, persona)
                .then((intro) => {
                  if (!intro) return
                  saveViewIntro(activeId, q, intro)
                  setViewIntro(intro)
                  // 简介就是角色本人的话，直接作为一条 assistant 消息追加
                  updateActive((prev) => [...prev, { role: 'assistant' as const, content: intro }])
                })
                .catch(() => {})
            }
          }
          return null
        })
        .catch(() => null)
        .then(() => {
          setToolCalls((prev) =>
            prev.map((tc) => (tc.query === q ? { ...tc, pending: false } : tc))
          )
        })
    }
    // AUTO 模式：AI 发出 [SEARCH:q] → 联网搜索后用结果重新回答，给出准确答案
    const autoSearchAndReanswer = async (sq: string): Promise<string> => {
      let newReply = reply
      beginSearchOp()
      try {
        let results: SearchResult[] | null = null
        let answer = ''
        let agentResult = preAgentResult
        if (preSearched && preSearched.length > 0) {
          // 一次搜索 + 复用：本消息已在前端后台搜到结果，直接基于已有资料重答——
          // 不再二次联网（避免"清空重新搜一遍"）
          results = preSearched
          answer = preAnswer
        } else if (preSearchPromise) {
          // 预搜索仍在进行（尚未写回 preSearched）：等待其完成再复用，避免重复联网搜索
          await preSearchPromise
          if (preSearched && preSearched.length > 0) {
            results = preSearched
            answer = preAnswer
            agentResult = preAgentResult
          }
        }
        if (!results) {
          // 预搜索未触发（非信息查询）或未拿到结果 → 高级搜索智能兜底重搜
          agentResult = await runSearchAgent(sq, '', 'auto').catch(() => null)
          if (agentResult && agentResult.results.length > 0) {
            results = agentResult.results
            answer = agentResult.answer ?? ''
          }
          // 引擎全空时 AI 兜底：保证搜索后必有结果卡 + 重答（不出现"搜索了却没结果"）
          if (!results || !results.length) {
            results = await searchAI(sq, 6).catch(() => [])
            agentResult = null
          }
        }
        const hasResults = !!(results && results.length)
        const webBlock = hasResults
          ? '今天是 ' +
            todayStr() +
            (answer
              ? '。以下是 Tavily 官方 AI 直接答案（基于实时检索）：\n' +
                answer +
                '\n\n以及以下网络搜索结果，请基于它们回答，引用具体数据/来源：\n'
              : '。以下是来自网络的最新搜索结果，请基于它们回答，引用具体数据/来源：\n') +
            (agentResult && agentResult.results.length
              ? formatSearchContext(agentResult)
              : results!
                  .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description || ''}`)
                  .join('\n\n'))
          : // 搜索仍无结果也要保证「有后文」：注入空结果说明，让 AI 基于既有知识诚实回答
            '今天是 ' +
            todayStr() +
            '。本次网络搜索未能获取到可用的相关结果。请基于你已有的知识回答用户的问题，并在结尾如实告知用户「未能搜索到相关网络资料，以上回答基于既有知识」。'
        if (webBlock) {
          // 折叠结果卡：只在真正基于搜索结果重答时展示（含复用预搜结果的情况），
          // 覆盖上一轮残留卡片，避免「搜到资料却无后续回答」的残留
          if (hasResults) {
            setDialogResults(
              filterSensitiveResults(results!).map((r) => ({
                title: r.title,
                url: r.url,
                source: r.source
              }))
            )
          } else {
            // 无结果：不保留上一轮残留卡片
            setDialogResults([])
          }
          beginStreaming()
          try {
            const result = await streamChat(
              effCfg,
              injectAttachments(recent),
              upsertAssistant,
              ctrl.signal,
              summary,
              kbKnowledge || kbText,
              memory,
              webBlock,
              true,
              false,
              viewArticle,
              viewIntroText,
              personaKnowledge,
              searchMode === 'auto',
              false,
              lorePrompt,
              personaMode === 'role',
              l2dEnabled,
              ttsOn && (ttsSource === 'backend' || !!loadTtsAudioUrl()),
              siteDoc,
              knowledgeFusion,
              notion,
              notionIntent
            )
            newReply = result.content
            upsertAssistant(newReply)
            // 重答完成后预合成 TTS（后台缓存，配合 playTTS 秒播）
            if (newReply && ttsOn && (ttsSource === 'backend' || !!loadTtsAudioUrl())) {
              const clean2 = cleanTtsText(newReply)
              if (clean2) {
                getTtsAudio({
                  text: clean2,
                  voice: ttsVoice,
                  source: ttsSource,
                  thirdPartyUrl: loadTtsAudioUrl()
                }).catch(() => {})
              }
            }
            // 搜索重答完成：TTS 开启时自动朗读重答（替换主回复朗读，同一消息位置）
            if (newReply && ttsOn && (ttsSource === 'backend' || !!loadTtsAudioUrl())) {
              playTTS(newReply, messages.length + 1)
            }
          } finally {
            endStreaming()
          }
        }
      } catch {
        /* 重答失败：保留原回复 */
      } finally {
        endSearchOp()
      }
      return newReply
    }

    if (viewCmd) {
      const vc = (viewCmd[1] || '').trim()
      // 判断是「更新当前浏览文章」（有浏览文章且内容为完整长文）还是「请求生成新文章」
      const looksLikeArticle = vc.length > 80 || vc.includes('\n\n')
      if (searchMode === 'deep' && viewTopic && looksLikeArticle) {
        // AI 基于当前浏览文章输出优化后的完整文章 → 更新 View 面板（写缓存 + 重触发浏览；仅 Deep 模式可调用 View，auto/fast 不碰）
        if (vc) {
          writeSearchCache(viewTopic, { article: vc })
          setAgentTab('web')
          setAgentInitUrl(viewTopic)
          setAgentEditContent(undefined)
          setAgentSearchNonce((n) => n + 1)
          autoOpenAgent()
          setToolCalls((prev) => [
            ...prev,
            {
              msgIdx,
              type: '优化文章',
              detail: viewTopic.slice(0, 60),
              tab: 'web',
              query: viewTopic,
              sessionId: activeId
            }
          ])
        }
      } else if (searchMode === 'deep' && vc) {
        // Deep：仅此模式可调用 View 页面生成完整文章（兜底，AI 通常走 [SEARCH:] 生成文章）
        const sq = vc.slice(0, 60)
        if (sq) triggerBrowse(sq, 'Search')
      } else if (searchMode === 'auto' && vc) {
        // Auto：彻底禁止 AI 调用 View 生成详细文章（慢、质量差）——[VIEW:] 一律作为普通文本
        // 回复展示（不写缓存、不开面板、不二次搜索）。完整文章生成仅限 Deep 模式。
        updateActive((prev) => {
          for (let i = prev.length - 1; i >= 0; i--) {
            if (prev[i].role === 'assistant') {
              return prev.map((m, j) => (j === i ? { ...m, content: vc } : m))
            }
          }
          return prev
        })
        reply = vc
      }
      // Fast：忽略 [VIEW:]（纯本地快速，不联网不生成文章）
    } else if (kbSaveCmd?.mode === 'delete') {
      // 知识库删除：按标题删除条目（自动同步删除对应的 Notion 页面）
      const kEntries = loadKbEntries()
      const target = kEntries.find(
        (e) => e.name.trim().toLowerCase() === kbSaveCmd.title.trim().toLowerCase()
      )
      if (target) {
        await deleteKbEntrySmart({ id: target.id, mode: kbStoreMode })
        const confirm = `\n\n（已从知识库删除「${target.name}」${target.notionId ? '，并同步删除对应的 Notion 页面' : ''}）`
        updateActive((prev) => {
          for (let i = prev.length - 1; i >= 0; i--) {
            if (prev[i].role === 'assistant') {
              return prev.map((m, j) => (j === i ? { ...m, content: m.content + confirm } : m))
            }
          }
          return prev
        })
        reply += confirm
        setToolCalls((prev) => [
          ...prev,
          {
            msgIdx,
            type: '删除知识库',
            detail: target.name.slice(0, 60),
            tab: 'kb',
            sessionId: activeId
          }
        ])
      }
    } else if (kbSaveCmd) {
      // 知识库保存：本机 always + 按「知识库保存」目标（auto/本地/Notion）入队后台同步 Notion
      const res = await saveKbEntrySmart({
        title: kbSaveCmd.title,
        content: kbSaveCmd.content,
        mode: kbStoreMode
      })
      const entry = res.entry
      setAgentKbOpen({ nonce: Date.now(), entry })
      setAgentTab('edit')
      setAgentInitUrl(undefined)
      setAgentEditContent(kbSaveCmd.content)
      autoOpenAgent()
      if (res.error) toast(res.error)
      setToolCalls((prev) => [
        ...prev,
        {
          msgIdx,
          type: kbSaveCmd.mode === 'edit' ? '编辑知识库' : '保存知识库',
          detail: kbSaveCmd.title.slice(0, 60),
          tab: 'edit',
          sessionId: activeId
        }
      ])
    } else if (kbSaveIntent) {
      // AI 漏发 [KB-SAVE:] 但用户明确要求保存 → 前端兜底直接保存，并让 AI 回复补充确认
      const res = await saveKbEntrySmart({
        title: kbSaveIntent.title,
        content: kbSaveIntent.content,
        mode: kbStoreMode
      })
      const entry = res.entry
      setAgentKbOpen({ nonce: Date.now(), entry })
      setAgentTab('edit')
      setAgentInitUrl(undefined)
      setAgentEditContent(kbSaveIntent.content)
      autoOpenAgent()
      if (res.error) toast(res.error)
      setToolCalls((prev) => [
        ...prev,
        {
          msgIdx,
          type: '保存知识库',
          detail: kbSaveIntent.title.slice(0, 60),
          tab: 'edit',
          sessionId: activeId
        }
      ])
      // 在 AI 回复末尾补一句已保存确认（用户能明确知道存进去了）
      const confirm = `\n\n（已自动保存到知识库「${kbSaveIntent.title}」，可在 Agent 面板「知识库」查看）`
      updateActive((prev) => {
        for (let i = prev.length - 1; i >= 0; i--) {
          if (prev[i].role === 'assistant') {
            return prev.map((m, j) => (j === i ? { ...m, content: m.content + confirm } : m))
          }
        }
        return prev
      })
      reply += confirm
    } else if (browseCmd && searchMode === 'deep') {
      // Deep：仅此模式可调用 View 页面（[BROWSE:url] 抓取并生成文章）；Auto/Fast 中用户粘贴 URL 已由顶部 urlMatch 自动抓取注入上下文
      setAgentEditContent(undefined)
      triggerBrowse(browseCmd[1], 'Search', { keepReply: true })
    } else if (
      searchCmd ||
      // 兜底：AI 回复被截断在 '['（本应是 [SEARCH:...]）→ 视为搜索意图，用原查询重答
      (searchMode === 'auto' && isInfoQuery && /[\[【]\s*$/.test(reply))
    ) {
      const sq = (searchCmd ? searchCmd[1] : '').trim() || t.trim()
      if (browseAgentOn) {
        // Deep 搜索模式开启时自动生成文章：桌面自动开面板，手机只出卡片（生成中→可点）
        if (sq) triggerBrowse(sq, 'Search')
      } else if (searchMode === 'auto' && sq) {
        // AUTO：AI 认为缺少数据 → 联网搜索重答（结果只以对话文字展示，不产生 view 卡片）
        reply = await autoSearchAndReanswer(sq)
      }
      // Fast：webTools 已关闭，[SEARCH:] 不生效（忽略，不联网）
      setAgentEditContent(undefined)
    } else if (editCmd) {
      setAgentTab('edit')
      setAgentInitUrl(undefined)
      setAgentEditContent(editCmd[1].trim())
      autoOpenAgent()
      setToolCalls((prev) => [
        ...prev,
        {
          msgIdx,
          type: '编辑文档',
          detail: editCmd[1].trim().slice(0, 60),
          tab: 'edit',
          sessionId: activeId
        }
      ])
    } else if (kbCmd) {
      setAgentTab('kb')
      setAgentInitUrl(undefined)
      setAgentEditContent(undefined)
      autoOpenAgent()
      setToolCalls((prev) => [
        ...prev,
        {
          msgIdx,
          type: '打开知识库',
          detail: (kbCmd[1] || '查看/整理知识库条目').slice(0, 60),
          tab: 'kb',
          sessionId: activeId
        }
      ])
    }
    // 显式搜索兜底：搜索模式开启时无需再说「搜索」，任何提问都自动生成文章
    // （除非 AI 已发工具指令或给出代码块）；桌面自动开面板、手机只出卡片
    if (
      browseAgentOn &&
      !viewCmd &&
      !kbSaveCmd &&
      !kbSaveIntent &&
      !browseCmd &&
      !searchCmd &&
      !editCmd &&
      !kbCmd &&
      !toolCmds.length
    ) {
      const isCode = /```/.test(reply) || /```[a-zA-Z]*\n/.test(reply)
      if (!isCode) {
        // 用 AI 从对话上下文提炼搜索关键词，避免把闲聊/追问当关键词（如"没有图片啊"）；
        // 关键词提炼是「快任务」→ 路由到 fast 角色（单模型时回落主模型，行为不变）
        const derived = await deriveSearchKeyword(
          routeModel(resolveModelRoles(effCfg), 'fast'),
          allMsgs
        )
        const q = (derived || t.trim()).slice(0, 60)
        if (q) {
          setAgentSearchNonce((n) => n + 1)
          triggerBrowse(q, 'Search')
        }
      }
    }
    // 网络资料不再以卡片展示（浏览结果由浏览面板自动呈现），避免刷屏

    // 本机工具：AI 请求操作电脑（[TOOL:...]）→ 剥离指令进入「确认 → 执行 → 续答」闭环
    if (toolCmds.length) {
      const cleaned = stripToolCmds(reply)
      reply = cleaned
      updateActive((prev) => {
        for (let i = prev.length - 1; i >= 0; i--) {
          if (prev[i].role === 'assistant') {
            return prev.map((m, j) => (j === i ? { ...m, content: cleaned } : m))
          }
        }
        return prev
      })
      const first = toolCmds[0]
      setPendingTool({ ...first, msgIdx })
      setToolCalls((prev) => [
        ...prev,
        {
          msgIdx,
          type: '本地工具',
          detail: `待确认 · ${first.name} ${toolArgsPreview(first)}`.slice(0, 60),
          sessionId: activeId
        }
      ])
    }

    if (!reply.startsWith('错误')) learn(t, reply)
    // Token 优化：简短回复（如"好的，我帮你查一下"）或仅含工具指令（[SEARCH:]/[VIEW:] 等）的
    // 引导性回复不触发人格学习——避免对每次搜索/浏览请求都白耗一次 AI 提炼调用
    const trivialReply = reply.trim().length < 30 || /\[(SEARCH|VIEW|BROWSE|EDIT|KB)/.test(reply)
    // auto-knowledge：对话完成后后台自动学习人格笔记 + 联网补充（不阻塞发送）
    if (!reply.startsWith('错误') && !trivialReply && !personaRunningRef.current) {
      personaRunningRef.current = true
      const pkSnapshot = personaKnowledge
      const msgsSnapshot = allMsgs
      const cfgSnapshot = effCfg
      derivePersonaKnowledge(cfgSnapshot, msgsSnapshot, pkSnapshot)
        .then(({ note, keyword }) => {
          if (note) {
            setPersonaKnowledge((prev) => {
              // Mem0 风格：实体去重 + 上限（同一话题合并为最新一条，减少重复注入 token）
              const next = mergePersonaNote(prev, note, 12)
              if (next.trim() === prev.trim()) return prev
              savePersonaKnowledge(pageId, next)
              queueBackupSync('persona') // 人格笔记变更 → 自动备份
              return next
            })
          }
          // 值得补充的话题：后台自动搜索，完成后记入人格笔记（供后续 AI 读取）
          if (keyword) {
            searchWithCache(keyword, {
              maxSources: 3,
              perSourceChars: 1500
            })
              .then((r) => {
                if (r && r.article) {
                  setPersonaKnowledge((prev) => {
                    const next = mergePersonaNote(prev, `资料：${keyword}（已自动补充）`, 12)
                    if (next.trim() === prev.trim()) return prev
                    savePersonaKnowledge(pageId, next)
                    queueBackupSync('persona') // 人格笔记变更 → 自动备份
                    return next
                  })
                }
              })
              .catch(() => {})
          }
        })
        .catch(() => {})
        .finally(() => {
          personaRunningRef.current = false
        })
    }
  }

  // 本机工具闭环（用户在确认弹窗点击「运行」后）：
  // 执行 → 把结果注入 system（toolResult）→ 继续流式让 AI 基于结果完成任务
  const continueWithToolResult = async (r: { ok: boolean; output: string; error?: string }) => {
    setLoading(true)
    beginStreaming()
    const contUpsert = createStreamThrottle((content: string) => {
      updateActive((prev) => {
        const last = prev[prev.length - 1]
        return last && last.role === 'assistant'
          ? [...prev.slice(0, -1), { role: 'assistant' as const, content }]
          : [...prev, { role: 'assistant' as const, content }]
      })
    })
    try {
      updateActive((prev) => [...prev, { role: 'assistant' as const, content: '' }])
      const cont = await streamChat(
        effCfg,
        messages,
        contUpsert,
        abortRef.current?.signal ?? new AbortController().signal,
        '',
        kbText,
        memory,
        '',
        searchMode !== 'fast',
        browseAgentOn,
        '',
        '',
        personaKnowledge,
        searchMode === 'auto',
        searchMode === 'fast',
        lorePrompt,
        personaMode === 'role',
        l2dEnabled,
        ttsOn && (ttsSource === 'backend' || !!loadTtsAudioUrl()),
        '',
        false,
        '',
        false,
        localToolsOn,
        r
      )
      const contReply = stripEmotionTag(cont.content)
      // 续答中若又发起工具调用 → 继续确认（一次一个，形成工具链）
      const nextTools = localToolsOn ? extractToolCommands(contReply) : []
      if (nextTools.length) {
        const cleaned = stripToolCmds(contReply)
        updateActive((prev) => {
          const last = prev[prev.length - 1]
          return last ? [...prev.slice(0, -1), { ...last, content: cleaned }] : prev
        })
        setPendingTool({ ...nextTools[0], msgIdx: messages.length + 1 })
      } else {
        updateActive((prev) => {
          const last = prev[prev.length - 1]
          return last ? [...prev.slice(0, -1), { ...last, content: contReply }] : prev
        })
      }
    } catch (e: unknown) {
      updateActive((prev) => {
        const last = prev[prev.length - 1]
        const msg = e instanceof Error ? e.message : '请求失败'
        return last ? [...prev.slice(0, -1), { ...last, content: `工具续答失败：${msg}` }] : prev
      })
    } finally {
      endStreaming()
      setLoading(false)
    }
  }

  const runPendingTool = async (tc: ToolCommand & { msgIdx: number }) => {
    setToolBusy(true)
    // mcp_ 前缀 → MCP 服务器工具；其余 → 本机工具
    const mcpParsed = parseMcpToolName(tc.name)
    let r: { ok: boolean; output: string; error?: string }
    if (mcpParsed) {
      const server = loadMcpServers().find((s) => s.id === mcpParsed.serverId)
      r = server
        ? await mcpCall(server, mcpParsed.tool, (tc.args || {}) as Record<string, unknown>)
        : { ok: false, output: '', error: '未找到对应的 MCP 服务器，请到 设置 → 技能与 MCP 检查' }
    } else {
      r = await runLocalTool({ tool: tc.name, args: tc.args })
    }
    setToolBusy(false)
    setPendingTool(null)
    if (!r.ok) {
      // 失败：在对话里补一条失败说明（保持上下文清楚）
      updateActive((prev) => [
        ...prev,
        {
          role: 'assistant' as const,
          content: `工具「${tc.name}」执行失败：${r.error || '未知错误'}`
        }
      ])
      return
    }
    await continueWithToolResult(r)
  }

  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')

  // 性能优化：lastAssistantContent 只在回复完成后（loading→false）提交，
  // 流式期间保持上一次稳定值，让 memo(AgentPanel) 不随每条 stream chunk 重渲染
  const lastAssistantRef = useRef<string | undefined>(undefined)
  lastAssistantRef.current = lastAssistant?.content
  const [settledAssistant, setSettledAssistant] = useState<string | undefined>(undefined)
  const wasLoadingRef = useRef(false)
  useEffect(() => {
    if (wasLoadingRef.current && !loading) {
      setSettledAssistant(lastAssistantRef.current)
    }
    wasLoadingRef.current = loading
  }, [loading])

  // AgentPanel 稳定回调（配合 memo）：桌面/移动双实例共用，避免每次父组件重渲染重建引用
  const closeAgentPanel = useCallback(() => {
    refreshKb()
    setAgentOpen(false)
  }, [refreshKb])
  const consumeKbOpen = useCallback(() => setAgentKbOpen(undefined), [])
  const onCustomSaved = useCallback(() => {
    setLocalCfg(getLocalCfg(pageId))
    setCustomModelOn(true)
    saveCustomModelOn(true)
  }, [pageId])

  // 沉浸卡片上可点击的工具按钮（View/搜索等）：显示当前会话最近的工具指令，
  // 不限于最后一条 AI 消息——方便用户随时点击打开 View/搜索（搜索后按钮常驻可点）
  // useMemo：父组件重渲染（流式/输入等）时跳过重复 sort/filter/slice
  // 注意：必须放在早期 return（consent/adminOnly/未配置）之前，否则违反 Rules of Hooks
  const immersiveTools = useMemo(
    () =>
      toolCalls
        .filter(
          (tc) =>
            tc.sessionId === activeId &&
            // auto/fast 模式：隐藏指向 web 面板的工具卡（不显示 view 入口）
            !(tc.tab === 'web' && searchMode !== 'deep')
        )
        .sort((a, b) => (b.msgIdx ?? 0) - (a.msgIdx ?? 0))
        .slice(0, 3),
    [toolCalls, activeId, searchMode]
  )

  // Agent 面板「设置」tab 数据（desktop/mobile 双渲染共用一份；useMemo 稳定引用配合 AgentPanel memo）
  const settingsData: AgentSettingsProps = useMemo(
    () => ({
      pageId,
      canManage: !!canManage,
      hasCustom,
      botName: config.botName || 'AI',
      searchMode,
      onSetSearchMode: changeSearchMode,
      chatFontSize,
      onSetFontSize: (v) => {
        setChatFontSize(v)
        saveChatFontSize(v)
        queueBackupSync('settings') // 设置变更 → 自动备份
      },
      onCustomSaved,
      customModelOn,
      onToggleCustomModel: toggleCustomModel,
      allowCustomApi: customApiEnabled,
      ttsOn,
      onToggleTts: toggleTts,
      ttsVoice,
      onSetTtsVoice: setTtsVoicePersist,
      ttsSource,
      onSetTtsSource: setTtsSourcePersist,
      onTestTts: testTts,
      kbStoreMode,
      onSetKbStoreMode: changeKbStoreMode,
      localToolsOn,
      onToggleLocalTools: toggleLocalTools
    }),
    [
      pageId,
      canManage,
      hasCustom,
      config.botName,
      searchMode,
      changeSearchMode,
      chatFontSize,
      onCustomSaved,
      customModelOn,
      toggleCustomModel,
      customApiEnabled,
      ttsOn,
      toggleTts,
      ttsVoice,
      setTtsVoicePersist,
      ttsSource,
      setTtsSourcePersist,
      testTts,
      kbStoreMode,
      changeKbStoreMode,
      refreshKb,
      localToolsOn,
      toggleLocalTools
    ]
  )

  // 仅管理员可用的助手：普通访客无法访问
  if (config.adminOnly && !canManage) {
    return (
      <div className="flex h-full w-full items-center justify-center px-4">
        <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-8 text-center dark:border-gray-700 dark:bg-gray-900">
          <p className="text-base font-medium text-gray-700 dark:text-gray-300">
            此 AI 助手仅管理员可用
          </p>
          <p className="mt-1 text-sm text-gray-400">请联系管理员调整适用范围。</p>
          <Link
            to="/"
            className="mt-4 inline-block text-sm text-blue-600 hover:underline dark:text-blue-400"
          >
            返回首页
          </Link>
        </div>
      </div>
    )
  }

  if (!effCfg.endpoint || !effCfg.apiKey || !effCfg.model) {
    return (
      <>
        {/* 未配置引导也要渲染 LocalApiModal，否则「在本机配置模型 API」点了弹窗打不开 */}
        <LocalApiModal
          open={apiModalOpen}
          onClose={() => setApiModalOpen(false)}
          pageId={pageId}
          botName={config.botName || 'AI'}
          onSaved={onCustomSaved}
        />
        <div className="mx-auto max-w-md rounded-2xl border border-dashed border-gray-200 bg-gray-50/50 p-8 text-center text-sm text-gray-400 dark:border-gray-700 dark:bg-gray-800/50">
          <p>AI 对话未配置。</p>
          {!canManage && customApiEnabled ? (
            <button
              onClick={() => setApiModalOpen(true)}
              className="mt-4 rounded-xl bg-gray-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-gray-700 dark:bg-gray-200 dark:text-gray-900"
            >
              在本机配置模型 API
            </button>
          ) : (
            <p className="mt-2">请在后台「AI 管理」中配置。</p>
          )}
        </div>
      </>
    )
  }

  const iconBtn =
    'grid h-9 w-9 shrink-0 place-items-center rounded-full text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800'

  // 沉浸模式展示的 AI 最后一句（带索引，用于匹配工具卡）
  const lastAiIdx = [...messages].reverse().findIndex((m) => m.role === 'assistant')
  const lastAi = lastAiIdx >= 0 ? messages[messages.length - 1 - lastAiIdx] : undefined
  const chatBody = (
    <div
      className={
        'flex h-full min-h-0 flex-col ' +
        (live2dImmersive ? 'bg-transparent' : 'bg-white dark:bg-gray-900')
      }
    >
      {/* 顶栏：左侧历史+机器人，右侧Agent+主题（沉浸模式保留，加毛玻璃背景；顶部安全区避让刘海） */}
      <div
        className={
          'flex shrink-0 items-center gap-1.5 border-b px-3 py-2 sm:px-4 ' +
          (live2dImmersive
            ? 'border-gray-200/80 bg-white/90 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))] backdrop-blur dark:border-gray-800 dark:bg-gray-900/90'
            : 'border-gray-100 dark:border-gray-700')
        }
      >
        {/* 左侧：历史按钮（桌面切换侧边栏收起/展开，移动端打开抽屉） */}
        <button
          onClick={() => {
            if (window.innerWidth >= 1024)
              setSidebarCollapsed((v) => {
                const n = !v
                try {
                  localStorage.setItem('kimo_ai_sidebar_collapsed', n ? '1' : '0')
                } catch {}
                return n
              })
            else setSidebarOpen(true)
          }}
          className={iconBtn + (sidebarCollapsed ? ' text-gray-600 dark:text-gray-300' : '')}
          title="会话列表"
          aria-label="会话列表"
        >
          <svg
            className="h-5 w-5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
          >
            <path strokeLinecap="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
          </svg>
        </button>

        {center ? (
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            {bots && bots.length > 1 ? (
              <div className="relative min-w-0">
                <button
                  ref={botBtnRef}
                  onClick={toggleBotMenu}
                  className="flex max-w-[170px] items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-2.5 py-1.5 text-sm text-gray-700 transition hover:bg-gray-50 active:scale-95 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200"
                >
                  <BotAvatar src={config.avatar} name={config.botName || 'AI'} />
                  <span className="min-w-0 truncate">{config.botName || 'AI'}</span>
                  <svg
                    className={`h-3.5 w-3.5 shrink-0 text-gray-400 transition-transform duration-200 ${botMenuOpen ? 'rotate-180' : ''}`}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M19.5 8.25l-7.5 7.5-7.5-7.5"
                    />
                  </svg>
                </button>
                {botMenuOpen &&
                  botMenuPos &&
                  createPortal(
                    <>
                      <div className="fixed inset-0 z-[70]" onClick={() => setBotMenuOpen(false)} />
                      <div
                        className="fixed z-[71] w-60 overflow-hidden rounded-xl border border-gray-200 bg-white py-1 shadow-xl animate-[kpop_0.2s_ease-out] dark:border-gray-700 dark:bg-gray-900"
                        style={{ left: botMenuPos.left, top: botMenuPos.top }}
                      >
                        {bots.map((b) => (
                          <button
                            key={b.id}
                            onClick={() => {
                              onSwitchBot?.(b.id)
                              setBotMenuOpen(false)
                            }}
                            className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition hover:bg-gray-50 dark:hover:bg-gray-800 ${b.id === pageId ? 'font-medium text-gray-900 dark:text-gray-100' : 'text-gray-600 dark:text-gray-300'}`}
                          >
                            <BotAvatar src={b.config.avatar} name={b.name} />
                            <span className="min-w-0 flex-1 truncate">{b.name}</span>
                            {b.id === pageId && <span className="text-xs text-gray-400">✓</span>}
                          </button>
                        ))}
                      </div>
                    </>,
                    document.body
                  )}
              </div>
            ) : (
              <div className="flex min-w-0 items-center gap-2">
                {config.avatar ? (
                  <img
                    src={config.avatar}
                    alt=""
                    className="h-7 w-7 shrink-0 rounded-full object-cover"
                  />
                ) : (
                  <span className="grid h-7 w-7 shrink-0 place-content-center rounded-full bg-gray-100 text-xs font-bold text-gray-500 dark:bg-gray-800 dark:text-gray-300">
                    {(config.botName || 'AI').slice(0, 2)}
                  </span>
                )}
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                      {config.botName || 'AI 助手'}
                    </span>
                    {allPrompts.length > 1 && (
                      <select
                        value={activePromptIdx ?? ''}
                        onChange={(e) =>
                          setActivePromptIdx(e.target.value === '' ? null : Number(e.target.value))
                        }
                        className="rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs text-gray-600 outline-none dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
                      >
                        <option value="">默认</option>
                        {allPrompts.map((p, i) => (
                          <option key={i} value={i}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                </div>
              </div>
            )}
            <div className="flex-1" />
            <button
              onClick={() => {
                if (agentOpen) refreshKb()
                setAgentOpen((v) => {
                  if (!v) {
                    // 默认打开 Live2D 页面（角色即 AI 化身）；最后一条 AI 消息含 URL 时优先浏览
                    setAgentTab('live2d')
                    setAgentEditContent(undefined)
                    const last = messages[messages.length - 1]
                    if (last?.role === 'assistant') {
                      const m = last.content.match(/https?:\/\/[^\s<>"{}|\\^`\[\]]+/)
                      if (m) {
                        setAgentTab('web')
                        setAgentInitUrl(m[0])
                      }
                    }
                  }
                  return !v
                })
              }}
              className={`relative ${iconBtn} ${agentOpen ? 'text-gray-600 dark:text-gray-300' : ''}`}
              title={agentOpen ? '关闭 Agent' : 'Agent 工具箱'}
              aria-label={agentOpen ? '关闭 Agent' : 'Agent 工具箱'}
            >
              {agentOpen ? (
                isMobile ? (
                  /* 手机：叉号图标 */
                  <svg
                    className="h-5 w-5 animate-[kpop_0.2s_ease-out]"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path strokeLinecap="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                ) : (
                  /* 电脑：右方向图标（与工具箱图标同尺寸 h-5 w-5） */
                  <svg
                    className="h-5 w-5 animate-[kpop_0.2s_ease-out]"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M8.25 4.5l7.5 7.5-7.5 7.5"
                    />
                  </svg>
                )
              ) : (
                <svg
                  className="h-5 w-5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21"
                  />
                </svg>
              )}
              {/* 移动端小提示：浏览/知识库/编辑器 */}
              {agentHint && (
                <span className="pointer-events-none absolute -bottom-9 right-0 z-30 whitespace-nowrap rounded-xl bg-gray-900 px-3 py-1.5 text-xs font-medium text-white shadow-lg animate-[kfade_0.3s_ease-out] dark:bg-gray-200 dark:text-gray-900">
                  浏览 · 知识库 · 编辑器
                  <span
                    className="absolute right-3 top-0 -translate-y-1/2 rotate-45 border-l border-t border-gray-900 bg-gray-900 dark:border-gray-200 dark:bg-gray-200"
                    style={{ width: 6, height: 6 }}
                  />
                </span>
              )}
            </button>
            {canManage && (
              <button
                onClick={onManage}
                className="shrink-0 rounded-lg px-2.5 py-1.5 text-sm text-gray-500 transition hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800"
              >
                管理
              </button>
            )}
          </div>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Link
              to="/"
              className="flex shrink-0 items-center gap-1 rounded-lg px-1.5 py-1 text-gray-500 transition hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-gray-800"
              title="返回首页"
            >
              <svg
                className="h-4 w-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18"
                />
              </svg>
              <span className="hidden text-sm sm:block">返回</span>
            </Link>
            {config.avatar ? (
              <img
                src={config.avatar}
                alt=""
                className="h-7 w-7 shrink-0 rounded-full object-cover"
              />
            ) : (
              <span className="grid h-7 w-7 shrink-0 place-content-center rounded-full bg-gray-100 text-xs font-bold text-gray-500 dark:bg-gray-800 dark:text-gray-300">
                {(config.botName || 'AI').slice(0, 2)}
              </span>
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                  {config.botName || 'AI 助手'}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 消息区：沉浸模式隐藏（角色全屏背景），正常模式显示消息列表 */}
      {!live2dImmersive && (
        <>
          {/* 消息区（铺满的多重水印暗纹网格，不随消息滚动） */}
          <div className="relative min-h-0 flex-1">
            <div className="pointer-events-none absolute inset-0 z-0 select-none overflow-hidden">
              <div className="grid h-full grid-cols-2 content-center gap-x-14 gap-y-20 px-4 opacity-20 sm:grid-cols-3">
                {Array.from({ length: 12 }).map((_, i) => (
                  <span
                    key={i}
                    className="rotate-[-16deg] whitespace-nowrap text-[10px] font-medium tracking-[0.2em] text-gray-400/60 dark:text-gray-500/40"
                  >
                    AI 生成 · {effCfg.model || 'AI'} · {hasCustom ? '自定义' : '站点'}
                  </span>
                ))}
              </div>
            </div>
            <div
              ref={msgListRef}
              onScroll={onScroll}
              className="absolute inset-0 z-10 overflow-y-auto"
            >
              <div className="mx-auto w-full max-w-3xl px-3 py-4 sm:px-6 sm:py-6">
                {/* 角色设定生成中：加载过程（阻止聊天，输入/发送已禁用） */}
                {loreLoading && <LoreLoadingCard modelName={characterNameOf(currentModel || '')} />}
                {messages.length === 0 ? (
                  <div className="flex flex-col items-center pt-[12vh] text-center">
                    {config.avatar ? (
                      <img
                        src={config.avatar}
                        alt={config.botName}
                        className="mb-4 h-16 w-16 rounded-full object-cover"
                      />
                    ) : (
                      <span className="mb-4 grid h-16 w-16 place-content-center rounded-full bg-gray-100 text-2xl font-bold text-gray-400 dark:bg-gray-800">
                        AI
                      </span>
                    )}
                    <p className="text-base font-medium text-gray-700 dark:text-gray-300">
                      {config.botName || 'AI 助手'}
                    </p>
                    <p className="mt-1 text-sm text-gray-400">有什么可以帮你？</p>
                    <EmptyStateFeatures
                      className="mt-8 max-w-md"
                      onPick={(s) => {
                        void send(s)
                      }}
                    />
                  </div>
                ) : (
                  <>
                    {messages.map((m, i) => (
                      <MessageItem
                        key={i}
                        m={m}
                        index={i}
                        isStreamingMsg={
                          streaming && i === messages.length - 1 && m.role === 'assistant'
                        }
                        avatar={config.avatar}
                        botName={config.botName || 'AI'}
                        fontSizeCls={fontSizeCls}
                        toolCalls={toolCallsByMsg[i] || EMPTY_TOOLCALLS}
                        speakingIdx={speakingIdx}
                        ttsOn={ttsOn}
                        onSpeak={playTTS}
                        onOpenAgent={handleOpenAgent}
                        onToolClick={handleToolClick}
                        feedbackRating={feedbackRatingMap[i] || 0}
                        onFeedback={handleMessageFeedback}
                      />
                    ))}
                    {dialogResults.length > 0 && <SearchResultsCard results={dialogResults} />}
                    {loading && (
                      <div className="flex gap-3 py-4 sm:py-5">
                        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-content-center rounded-full bg-gray-200 text-xs font-bold text-gray-500 dark:bg-gray-800">
                          AI
                        </span>
                        <div className="flex items-center gap-1.5 rounded-xl bg-gray-100 px-4 py-3 dark:bg-gray-800">
                          <span className="h-2 w-2 animate-bounce rounded-full bg-gray-400" />
                          <span
                            className="h-2 w-2 animate-bounce rounded-full bg-gray-400"
                            style={{ animationDelay: '0.15s' }}
                          />
                          <span
                            className="h-2 w-2 animate-bounce rounded-full bg-gray-400"
                            style={{ animationDelay: '0.3s' }}
                          />
                        </div>
                      </div>
                    )}
                    {limitReached && !hasCustom && customApiEnabled && (
                      <div className="flex justify-center pt-3">
                        <button
                          onClick={() => setApiModalOpen(true)}
                          className="rounded-full border border-gray-300 bg-white px-4 py-2 text-xs text-gray-600 transition hover:border-gray-500 hover:text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300"
                        >
                          配置自定义 API 消除限制
                        </button>
                      </div>
                    )}
                  </>
                )}
                <div ref={bottomRef} />
              </div>
            </div>
          </div>
        </>
      )}
      {live2dImmersive && <div className="min-h-0 flex-1" />}

      {/* 输入栏：ChatGPT 风格整合，按钮统一尺寸 */}
      <div
        className={
          'shrink-0 px-3 pt-2 sm:px-6 ' +
          (live2dImmersive
            ? 'animate-[kslideUp_0.35s_ease-out] ' +
              (inputFocused ? 'pb-3' : 'pb-[calc(env(safe-area-inset-bottom)+0.75rem)]')
            : 'bg-white pb-3 sm:pb-4 dark:bg-gray-900')
        }
      >
        <div className="mx-auto w-full max-w-3xl">
          {/* 沉浸模式：浮空展示 AI 最后一句（Markdown + 工具按钮 + 生成中加载）；新对话时给快捷提示词 */}
          {live2dImmersive && (
            <div className="relative mb-2 animate-[kslideUp_0.3s_ease-out] rounded-2xl border border-gray-200 bg-white/85 px-3.5 py-2.5 text-sm leading-relaxed text-gray-700 backdrop-blur dark:border-gray-700 dark:bg-gray-900/85 dark:text-gray-200">
              {loading && !lastAi ? (
                /* 新对话、生成中：统一分阶段加载打字机（搜索→生成 逐字切换，不再单独漂浮「正在搜索…」） */
                <div className="flex items-center gap-1.5 text-gray-400 dark:text-gray-500">
                  <PhaseTypeWriter phase={searching || searchPlan ? 'search' : 'generate'} />
                </div>
              ) : lastAi ? (
                <div className="min-w-0">
                  {/* AI 回复：Markdown 滑动展示（默认限高避免遮挡 Live2D 角色，超长内部滚动；点「展开全文」查看完整） */}
                  <div
                    className={`chat-md overflow-y-auto pt-1 ${immersiveExpand ? 'max-h-[62vh]' : 'max-h-[24vh]'}`}
                  >
                    {streaming ? (
                      /* 流式进行中：纯文本渲染，完成后切回 Markdown */
                      <span className="whitespace-pre-wrap">
                        {stripToolCmds(stripEmotionTag(lastAi.content))}
                      </span>
                    ) : (
                      <MarkdownContent
                        content={lastAi.content}
                        fallback={
                          immersiveTools.length
                            ? `（${immersiveTools[0].type}：${immersiveTools[0].detail}）`
                            : ''
                        }
                      />
                    )}
                  </div>
                  {/* 搜索结果卡：auto 重答产生的「已获取 N 条资料」折叠卡，沉浸模式下也显示（点击新标签开来源，不打开 Agent 面板） */}
                  {dialogResults.length > 0 && <SearchResultsCard results={dialogResults} />}
                  {/* 工具按钮：View/搜索等，点击打开 Agent 面板；生成中显示加载 */}
                  {/* 手机适配：flex-nowrap + 横向滚动，多张卡片不换行（沉浸卡片空间本就紧张） */}
                  {immersiveTools.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5 max-sm:flex-nowrap max-sm:overflow-x-auto no-scrollbar">
                      {immersiveTools.map((tc, j) => {
                        const dot: Record<string, string> = {
                          保存知识库: 'bg-emerald-500',
                          编辑知识库: 'bg-emerald-500',
                          View: 'bg-sky-500',
                          Search: 'bg-blue-500',
                          优化文章: 'bg-indigo-500',
                          网络资料: 'bg-amber-500',
                          编辑文档: 'bg-orange-500',
                          打开知识库: 'bg-teal-500'
                        }
                        return (
                          <button
                            key={j}
                            onClick={() => {
                              if (!tc.tab) return
                              // auto/fast 下禁止通过工具卡打开 view 面板
                              if (tc.tab === 'web' && searchMode !== 'deep') return
                              const q =
                                tc.query ||
                                (tc.type === 'Search' ? tc.detail.split(' ')[0] : undefined)
                              setAgentTab(tc.tab)
                              if (tc.tab === 'web') {
                                setAgentInitUrl(q)
                                setAgentSearchNonce((n) => n + 1)
                              }
                              setAgentEditContent(undefined)
                              setAgentOpen(true)
                            }}
                            title={tc.tab ? '点击打开 Agent 面板' : undefined}
                            className={`group inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-xs transition max-sm:shrink-0 max-sm:max-w-[70%] max-sm:px-2 max-sm:py-1 ${
                              tc.tab
                                ? 'cursor-pointer border-gray-200 bg-white text-gray-700 hover:border-blue-300 hover:bg-blue-50/50 hover:text-blue-600 active:scale-95 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:hover:border-blue-700 dark:hover:bg-blue-900/20 dark:hover:text-blue-400'
                                : 'cursor-default border-gray-100 bg-gray-50 text-gray-400 dark:border-gray-800 dark:bg-gray-800/40 dark:text-gray-500'
                            }`}
                          >
                            <span
                              className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot[tc.type] || 'bg-gray-400'}`}
                            />
                            <span className="shrink-0 font-medium">{tc.type}</span>
                            {tc.pending ? (
                              <span className="flex shrink-0 items-center gap-1 text-gray-400 dark:text-gray-500">
                                <svg
                                  className="h-3 w-3 animate-spin"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                >
                                  <circle
                                    className="opacity-25"
                                    cx="12"
                                    cy="12"
                                    r="10"
                                    stroke="currentColor"
                                    strokeWidth="4"
                                  />
                                  <path
                                    className="opacity-75"
                                    fill="currentColor"
                                    d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
                                  />
                                </svg>
                                生成中…
                              </span>
                            ) : (
                              <span className="min-w-0 truncate text-gray-400 dark:text-gray-500">
                                {tc.detail}
                              </span>
                            )}
                            {tc.tab && (
                              <svg
                                className="h-3 w-3 shrink-0 text-gray-300 transition group-hover:text-blue-500 dark:text-gray-600"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  d="M9 5l7 7-7 7"
                                />
                              </svg>
                            )}
                          </button>
                        )
                      })}
                    </div>
                  )}
                  {/* 搜索/生成中：统一分阶段加载打字机（搜索→生成 逐字切换，与输入栏上方漂浮状态合并进卡片） */}
                  {loading && (
                    <div className="mt-2 flex items-center gap-1.5 text-gray-400 dark:text-gray-500">
                      <PhaseTypeWriter phase={searching || searchPlan ? 'search' : 'generate'} />
                    </div>
                  )}
                  {/* 底部操作组：朗读 + 展开/收起全文（合并一行右对齐，避免两行胶囊突兀） */}
                  {!streaming &&
                    lastAi &&
                    (ttsOn || stripToolCmds(stripEmotionTag(lastAi.content)).length > 80) && (
                      <div className="mt-2 flex justify-end gap-1.5">
                        {/* 朗读：读这条 AI 回复的对话文字（清洗掉指令标签），沉浸角色同步口型；朗读中高亮可再点停止 */}
                        {ttsOn && (
                          <button
                            onClick={() => playTTS(lastAi.content, -2)}
                            className={`inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs font-medium transition active:scale-95 ${
                              speakingIdx === -2
                                ? 'border-blue-300 bg-blue-50 text-blue-600 dark:border-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                                : 'border-gray-200 bg-white/70 text-gray-500 hover:border-gray-300 hover:bg-gray-50 hover:text-gray-700 dark:border-gray-700 dark:bg-gray-800/70 dark:text-gray-400 dark:hover:border-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300'
                            }`}
                          >
                            <svg
                              className="h-3.5 w-3.5"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.8"
                            >
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z"
                              />
                            </svg>
                            {speakingIdx === -2 ? '停止朗读' : '朗读'}
                          </button>
                        )}
                        {/* 长回复：展开/收起全文 */}
                        {stripToolCmds(stripEmotionTag(lastAi.content)).length > 80 && (
                          <button
                            onClick={() => setImmersiveExpand((v) => !v)}
                            className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white/70 px-3 py-1.5 text-xs font-medium text-gray-500 transition hover:border-gray-300 hover:bg-gray-50 hover:text-gray-700 active:scale-95 dark:border-gray-700 dark:bg-gray-800/70 dark:text-gray-400 dark:hover:border-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
                          >
                            {immersiveExpand ? (
                              <>
                                收起
                                <svg
                                  className="h-3.5 w-3.5"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d="M4.5 15.75l7.5-7.5 7.5 7.5"
                                  />
                                </svg>
                              </>
                            ) : (
                              <>
                                展开全文
                                <svg
                                  className="h-3.5 w-3.5"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d="M19.5 8.25l-7.5 7.5-7.5-7.5"
                                  />
                                </svg>
                              </>
                            )}
                          </button>
                        )}
                      </div>
                    )}
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2">
                  <span className="text-gray-500 dark:text-gray-400">
                    {config.botName || 'AI'} 有什么可以帮你？
                  </span>
                  <EmptyStateFeatures
                    className="mt-2"
                    onPick={(s) => {
                      void send(s)
                    }}
                  />
                </div>
              )}
            </div>
          )}
          {/* 可关闭的圆角小卡片（网络模式 search/view / 附加文件 / 搜索中） */}

          {/* KB附件卡片 */}
          {kbAttachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {kbAttachments.map((a) => (
                <span
                  key={a.id}
                  className="inline-flex items-center gap-1.5 rounded-full border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs text-blue-700 dark:border-blue-800 dark:bg-blue-900/30 dark:text-blue-300"
                >
                  {a.title.slice(0, 20)}
                  <button
                    onClick={() => setKbAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                    className="text-blue-400 hover:text-blue-600"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          {(attachedFile || (!live2dImmersive && (searching || searchPlan))) && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {/* 分段搜索进度：手机沉浸模式已合并进对话卡片（分阶段打字机），不再漂浮在此 */}
              {!live2dImmersive && searchPlan && (
                <span
                  className={
                    'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs ' +
                    (live2dImmersive
                      ? 'border-gray-200/80 bg-white/85 text-gray-600 backdrop-blur dark:border-gray-700 dark:bg-gray-800/85 dark:text-gray-300'
                      : 'border-gray-200 bg-gray-50 text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300')
                  }
                >
                  <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                    />
                  </svg>
                  {searchPlan && '正在搜索…'}
                </span>
              )}
              {/* searching 通用卡：已有 searchPlan 分段进度卡时不再重复渲染（避免两个"正在搜索…"） */}
              {!live2dImmersive && searching && !searchPlan && (
                <span
                  className={
                    'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs ' +
                    (live2dImmersive
                      ? 'border-gray-200/80 bg-white/85 text-gray-600 backdrop-blur dark:border-gray-700 dark:bg-gray-800/85 dark:text-gray-300'
                      : 'border-gray-200 bg-gray-50 text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300')
                  }
                >
                  <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                    />
                  </svg>
                  正在搜索…
                </span>
              )}
              {attachedFile && (
                <span
                  className={
                    'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs ' +
                    (live2dImmersive
                      ? 'border-gray-200/80 bg-white/85 text-gray-600 backdrop-blur dark:border-gray-700 dark:bg-gray-800/85 dark:text-gray-300'
                      : 'border-gray-200 bg-gray-50 text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300')
                  }
                >
                  文件：{attachedFile}
                  <button
                    onClick={() => setAttachedFile('')}
                    className="text-gray-400 transition hover:text-gray-600"
                    aria-label="移除文件"
                  >
                    ×
                  </button>
                </span>
              )}
            </div>
          )}
          <div className="flex items-center gap-0.5 rounded-2xl border border-gray-200 bg-white p-1.5 transition hover:border-gray-300 focus-within:border-gray-400 focus-within:ring-2 focus-within:ring-gray-100 dark:border-gray-700 dark:bg-gray-800/70 dark:hover:border-gray-600 dark:focus-within:ring-gray-700/40">
            {/* / 按钮：知识库弹窗（锚定弹窗位置） */}
            <div className="relative">
              <button
                ref={kbAnchorRef}
                onClick={() => {
                  setKbPickerOpen(!kbPickerOpen)
                  setKbPickerSelected([])
                }}
                className={
                  'grid h-9 w-9 shrink-0 place-items-center rounded-full text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300 ' +
                  (kbPickerOpen ? 'bg-gray-100 text-gray-600 dark:bg-gray-800' : '')
                }
                title="知识库条目"
                aria-label="知识库条目"
              >
                <svg
                  className="h-4 w-4"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                >
                  <path d="M14.5 4l-5 16" />
                </svg>
              </button>
              {kbPickerOpen && (
                <>
                  <div
                    className="fixed inset-0 z-40"
                    style={{ bottom: '80px' }}
                    onClick={() => setKbPickerOpen(false)}
                  />
                  <KbPicker
                    selected={kbPickerSelected}
                    onToggle={onKbPickerToggle}
                    onInsert={onKbPickerInsert}
                    mode={searchMode}
                    onModeChange={changeSearchMode}
                    anchorRef={kbAnchorRef}
                    live2dOn={live2dOn}
                    onToggleLive2d={toggleLive2d}
                  />
                </>
              )}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".md,.markdown,text/markdown"
              onChange={onUpload}
              className="hidden"
            />
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onFocus={() => setInputFocused(true)}
              onBlur={() => setInputFocused(false)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send()
                }
              }}
              placeholder={`向 ${config.botName || 'AI'} 发送消息...`}
              disabled={loading || (loreLoading && !live2dImmersive)}
              rows={1}
              style={{ resize: 'none' }}
              className="no-scrollbar max-h-40 min-h-[38px] flex-1 self-center bg-transparent px-1.5 py-2 text-sm leading-6 text-gray-800 outline-none placeholder:text-gray-400 disabled:opacity-50 sm:text-[15px] dark:text-gray-100"
            />
            <button
              onClick={() => {
                void send()
              }}
              disabled={
                loading || (loreLoading && !live2dImmersive) || !input.trim() || cooldown > 0
              }
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gray-900 text-white transition hover:bg-gray-700 disabled:opacity-40 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-300"
            >
              {cooldown > 0 ? (
                <span className="text-xs font-medium">{cooldown}</span>
              ) : (
                <svg className="h-4 w-4 translate-x-px" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M3.478 2.404a.75.75 0 00-.926.941l2.432 7.905H13.5a.75.75 0 010 1.5H4.984l-2.432 7.905a.75.75 0 00.926.94 60.519 60.519 0 0018.445-8.986.75.75 0 000-1.218A60.517 60.517 0 003.478 2.404z" />
                </svg>
              )}
            </button>
          </div>
          <p className="mt-1.5 text-center text-[10px] text-gray-400/70 dark:text-gray-500/70">
            Shift+Enter 换行 · AI 生成内容仅供参考
          </p>
        </div>
      </div>
    </div>
  )

  const sidebar = (
    <div className="flex h-full w-64 flex-col bg-gray-100 dark:bg-gray-950">
      {/* 顶部：新建会话（圆角卡片）+ 同步中加载指示 */}
      <div className="p-2.5 pb-1.5">
        <button
          onClick={newSession}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-gray-200/70 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition hover:border-gray-300 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:border-gray-600 dark:hover:bg-gray-800"
        >
          <svg
            className="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path strokeLinecap="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          新建会话
        </button>
        {syncStatus.state === 'syncing' && (
          <div className="mt-1.5 flex items-center justify-center gap-1.5 rounded-lg border border-gray-200/70 bg-white px-3 py-1.5 text-[11px] text-gray-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
            <svg className="h-3 w-3 animate-spin text-amber-500" viewBox="0 0 24 24" fill="none">
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
            正在同步到 Notion…
          </div>
        )}
      </div>
      <div className="flex-1 space-y-1 overflow-y-auto px-2.5 pb-2">
        {sessions.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-gray-200/70 text-gray-400 dark:bg-gray-800 dark:text-gray-500">
              <svg
                className="h-5 w-5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z"
                />
              </svg>
            </span>
            <p className="text-xs leading-relaxed text-gray-400 dark:text-gray-500">
              暂无会话
              <br />
              点击上方「新建会话」开始对话
            </p>
          </div>
        )}
        {sessions.map((s, idx) => {
          const active = s.id === activeId
          const isDragging = dragIdx === idx
          const isDragOver = dragOverIdx === idx && dragIdx !== null && dragIdx !== idx
          return (
            <div
              key={s.id}
              onClick={() => selectSession(s.id)}
              draggable={!editingSessionId}
              onDragStart={(e) => handleSessionDragStart(e, idx)}
              onDragOver={(e) => handleSessionDragOver(e, idx)}
              onDrop={(e) => handleSessionDrop(e, idx)}
              onDragEnd={handleSessionDragEnd}
              title={active ? '当前会话（可拖动排序）' : '点击切换 · 可拖动排序'}
              className={`group relative flex cursor-pointer items-center gap-1.5 rounded-xl border py-2 pl-3.5 pr-1.5 text-sm transition active:scale-[0.99] ${active ? 'border-gray-300/80 bg-white text-gray-900 dark:border-gray-600/80 dark:bg-gray-800 dark:text-gray-100' : 'border-transparent bg-transparent text-gray-600 hover:border-gray-200/80 hover:bg-white/80 dark:text-gray-400 dark:hover:border-gray-700/80 dark:hover:bg-gray-900/80'} ${isDragging ? 'opacity-50' : ''} ${isDragOver ? 'ring-1 ring-inset ring-gray-900/15 dark:ring-gray-400/30' : ''}`}
            >
              {/* 激活态左侧竖条 */}
              {active && (
                <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-gray-900 dark:bg-gray-200" />
              )}
              {s.id === editingSessionId ? (
                <input
                  autoFocus
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename()
                    if (e.key === 'Escape') setEditingSessionId(null)
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-1.5 py-0.5 text-xs outline-none dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
                />
              ) : (
                <span className="min-w-0 flex-1 truncate">{s.title}</span>
              )}
              {s.id !== editingSessionId && (
                <button
                  onClick={(e) => startRename(e, s)}
                  className="hidden shrink-0 rounded-md p-1.5 text-gray-400 transition hover:bg-gray-200/70 hover:text-gray-700 group-hover:flex max-sm:flex dark:hover:bg-gray-600/60 dark:hover:text-gray-200"
                  title="重命名"
                  aria-label="重命名"
                >
                  <svg
                    className="h-3.5 w-3.5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125"
                    />
                  </svg>
                </button>
              )}
              <button
                onClick={(e) => deleteSession(e, s.id)}
                className="hidden shrink-0 rounded-md p-1.5 text-gray-400 transition hover:bg-red-100 hover:text-red-500 group-hover:flex max-sm:flex dark:hover:bg-red-900/30 dark:hover:text-red-400"
                title="删除"
                aria-label="删除"
              >
                <svg
                  className="h-3.5 w-3.5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          )
        })}
      </div>
      {/* 底部：内嵌圆角卡片（额度 + 主题 + 站点名） */}
      <div className="shrink-0 p-2.5">
        <div className="rounded-xl border border-gray-200/70 bg-white/70 p-2 dark:border-gray-700/70 dark:bg-gray-900/70">
          {dailyLimit > 0 && (
            <div className="mt-2 space-y-1 px-1">
              <div className="flex items-center justify-between text-[10px] text-gray-400 dark:text-gray-500">
                <span>额度</span>
                <span>
                  {dailyRemaining}/{dailyLimit}
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
                <div
                  className="h-full rounded-full bg-gray-400 transition-all duration-500 dark:bg-gray-500"
                  style={{
                    width: `${Math.round((dailyRemaining / dailyLimit) * 100)}%`
                  }}
                />
              </div>
            </div>
          )}
          {/* 主题切换：Auto / 亮 / 暗 三态（默认 Auto 跟随系统） */}
          <div className="mt-2 flex items-center rounded-lg bg-gray-100 p-0.5 dark:bg-gray-800">
            <button
              onClick={() => setThemeMode('auto')}
              title="自动（跟随系统）"
              aria-label="自动主题"
              className={`flex flex-1 items-center justify-center rounded-md p-1.5 transition ${themeMode === 'auto' ? 'bg-white text-gray-900 dark:bg-gray-700 dark:text-gray-100' : 'text-gray-400 hover:text-gray-600 dark:text-gray-400 dark:hover:text-gray-200'}`}
            >
              <svg
                className="h-4 w-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
              >
                <circle cx="12" cy="12" r="9" />
                <path d="M12 3a9 9 0 010 18z" fill="currentColor" stroke="none" />
              </svg>
            </button>
            <button
              onClick={() => setThemeMode('light')}
              title="亮色"
              aria-label="亮色主题"
              className={`flex flex-1 items-center justify-center rounded-md p-1.5 transition ${themeMode === 'light' ? 'bg-white text-gray-900 dark:bg-gray-700 dark:text-gray-100' : 'text-gray-400 hover:text-gray-600 dark:text-gray-400 dark:hover:text-gray-200'}`}
            >
              <svg
                className="h-4 w-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z"
                />
              </svg>
            </button>
            <button
              onClick={() => setThemeMode('dark')}
              title="暗色"
              aria-label="暗色主题"
              className={`flex flex-1 items-center justify-center rounded-md p-1.5 transition ${themeMode === 'dark' ? 'bg-white text-gray-900 dark:bg-gray-700 dark:text-gray-100' : 'text-gray-400 hover:text-gray-600 dark:text-gray-400 dark:hover:text-gray-200'}`}
            >
              <svg
                className="h-4 w-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z"
                />
              </svg>
            </button>
          </div>
          {/* 站点标识：默认使用当前 AI 机器人的名称与头像（在 AI Chat 页面以 AI 作为站点） */}
          <div className="mt-2 flex items-center gap-1.5 px-1">
            <BotAvatar src={config.avatar} name={config.botName || 'AI'} className="h-5 w-5" />
            <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-gray-400 dark:text-gray-500">
              {config.botName || 'AI 助手'}
            </span>
          </div>
          <p className="px-1 pb-1 text-[10px] leading-relaxed text-gray-300 dark:text-gray-600">
            AI 生成内容仅供参考
          </p>
        </div>
      </div>
    </div>
  )

  // 桌面端侧边栏（可折叠）
  const desktopSidebar = (
    <div
      className={
        'hidden shrink-0 overflow-hidden border-r border-gray-200 transition-all duration-300 ease-in-out lg:block dark:border-gray-800 ' +
        (sidebarCollapsed ? 'w-0 border-r-0' : 'w-64')
      }
    >
      {!sidebarCollapsed && sidebar}
    </div>
  )

  const mobileSidebar = (
    <div
      aria-hidden={!sidebarOpen}
      className={`fixed inset-0 z-50 transition-opacity duration-300 lg:hidden ${
        sidebarOpen ? 'opacity-100' : 'pointer-events-none opacity-0'
      }`}
    >
      <div
        className={`absolute inset-0 bg-black/40 backdrop-blur-sm transition-opacity duration-300 ${
          sidebarOpen ? 'opacity-100' : 'opacity-0'
        }`}
        onClick={() => setSidebarOpen(false)}
      />
      <div
        className={`absolute inset-y-0 left-0 w-64 shadow-2xl transition-transform duration-300 ease-in-out ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {sidebar}
      </div>
    </div>
  )

  const agentSidebar = (
    <>
      {/* 桌面端：右侧可拖拽面板 + 滑入动画 */}
      <div
        ref={agentPanelRef}
        className="hidden shrink-0 overflow-hidden border-l border-gray-200 transition-all duration-300 ease-in-out lg:block dark:border-gray-700"
        style={{
          width: agentOpen ? agentWidth : 0,
          borderLeftWidth: agentOpen ? undefined : 0
        }}
      >
        <div className="relative flex h-full w-full">
          {/* 拖拽手柄 */}
          <div
            className="absolute left-0 top-0 z-10 h-full w-4 cursor-col-resize hover:bg-gray-300/30 active:bg-gray-400/40 dark:hover:bg-gray-600/30"
            onMouseDown={onResizeDown}
          />
          {agentOpen && (
            <div className="min-w-0 flex-1 animate-[kfade_0.25s_ease-out]">
              <MemoAgentPanel
                onClose={closeAgentPanel}
                initUrl={agentInitUrl}
                initTab={agentTab}
                searchNonce={agentSearchNonce}
                initEditContent={agentEditContent}
                lastAssistantContent={settledAssistant}
                pageId={pageId}
                onKbChanged={refreshKb}
                settings={settingsData}
                kbOpen={agentKbOpen}
                onKbOpenConsumed={consumeKbOpen}
                live2dOn={l2dEnabled}
                onTabChange={setAgentTab}
                allowWebAutoDetect={browseAgentOn}
              />
            </div>
          )}
        </div>
      </div>
      {/* 移动端：底部滑入，无模糊遮罩 */}
      {agentOpen && (
        <div className="fixed inset-0 z-50 lg:hidden pointer-events-none">
          <div
            className="absolute inset-x-0 bottom-0 pointer-events-auto animate-[kslideUp_0.35s_ease-out] bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-800 shadow-2xl"
            style={{ top: '52px', maxHeight: 'calc(100vh - 52px)' }}
          >
            <MemoAgentPanel
              onClose={closeAgentPanel}
              initUrl={agentInitUrl}
              initTab={agentTab}
              searchNonce={agentSearchNonce}
              initEditContent={agentEditContent}
              lastAssistantContent={settledAssistant}
              pageId={pageId}
              onKbChanged={refreshKb}
              settings={settingsData}
              kbOpen={agentKbOpen}
              onKbOpenConsumed={consumeKbOpen}
              live2dOn={l2dEnabled}
              onTabChange={setAgentTab}
              allowWebAutoDetect={browseAgentOn}
            />
          </div>
        </div>
      )}
    </>
  )

  const layout = (
    <div
      className={
        'flex h-full min-h-0 overflow-hidden ' +
        fontSizeCls +
        ' ' +
        (live2dImmersive ? '' : 'bg-white dark:bg-gray-900')
      }
    >
      {/* 手机沉浸：铺满的多重水印暗纹网格（浮在 Live2D 之上、聊天内容之下），恢复“暗纹”显示 */}
      {live2dImmersive && (
        <div className="pointer-events-none fixed inset-0 z-0 select-none overflow-hidden">
          <div className="grid h-full grid-cols-2 content-center gap-x-14 gap-y-20 px-4 opacity-20 sm:grid-cols-3">
            {Array.from({ length: 12 }).map((_, i) => (
              <span
                key={i}
                className="rotate-[-16deg] whitespace-nowrap text-[10px] font-medium tracking-[0.2em] text-gray-400/60 dark:text-gray-500/40"
              >
                AI 生成 · {effCfg.model || 'AI'} · {hasCustom ? '自定义' : '站点'}
              </span>
            ))}
          </div>
        </div>
      )}
      {desktopSidebar}
      <div className="relative z-10 flex min-h-0 min-w-0 flex-1 flex-col">{chatBody}</div>
      {agentSidebar}
      {mobileSidebar}
    </div>
  )

  return (
    <>
      <LocalApiModal
        open={apiModalOpen}
        onClose={() => setApiModalOpen(false)}
        pageId={pageId}
        botName={config.botName || 'AI'}
        onSaved={onCustomSaved}
      />
      <ArticleComposerModal open={articleOpen} onClose={() => setArticleOpen(false)} />
      {/* 本机工具确认弹窗：AI 请求操作电脑（终端/文件/剪贴板）→ 用户确认后才执行 */}
      {pendingTool && (
        <div className="fixed inset-0 z-[96] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => {
              if (!toolBusy) setPendingTool(null)
            }}
          />
          <div className="relative w-full max-w-md rounded-3xl border border-gray-200 bg-white shadow-2xl dark:border-gray-700 dark:bg-gray-900">
            <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3 dark:border-gray-700">
              <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                本机工具 · {pendingTool.name}
              </h3>
              <button
                onClick={() => {
                  if (!toolBusy) setPendingTool(null)
                }}
                className="grid h-9 w-9 place-items-center rounded-full text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800"
                aria-label="关闭"
              >
                <svg
                  className="h-5 w-5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path strokeLinecap="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="space-y-3 p-4">
              <p className="rounded-xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-700 dark:bg-amber-900/20 dark:text-amber-400">
                AI 请求调用本机{pendingTool.name === 'shell' ? '终端' : '文件/剪贴板'}
                工具，将直接在你的电脑上执行，请确认命令/路径无误。
              </p>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-gray-50 p-3 text-[11px] leading-relaxed text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                {toolArgsPreview(pendingTool) || '(无参数)'}
              </pre>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setPendingTool(null)}
                  disabled={toolBusy}
                  className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm text-gray-600 transition hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
                >
                  取消
                </button>
                <button
                  onClick={() => void runPendingTool(pendingTool)}
                  disabled={toolBusy}
                  className="flex items-center gap-2 rounded-xl bg-gray-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-gray-700 disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900"
                >
                  {toolBusy && (
                    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      />
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                      />
                    </svg>
                  )}
                  {toolBusy ? '执行中…' : '运行'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {live2dImmersive && <Live2DBackground />}
      {layout}
    </>
  )
}
