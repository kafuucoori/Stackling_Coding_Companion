/**
 * InfoPanel —— 展开态信息面板：顶部导航 + 三视图（会话列表 / 对话 / 统计）。
 * 事件刷新会话，10 秒轮询兜底。ThemeProvider 提供四主题。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  startSessionMonitor,
  getClaudeConversation,
  removeClaudeSession,
  type ClaudeSession,
  type ChatMessage,
  type AgentSource,
} from '@/features/agent-monitor/agentMonitor'
import {
  ThemeProvider,
  useTheme,
  themeCssVars,
  type ThemeName,
} from './theme'
import SessionList, { type SourceToggles } from './SessionList'
import ChatView from './ChatView'
import StatsView from './StatsView'
import CompletionHistoryView from './CompletionHistoryView'
import { sessionTitleOf } from './utils'

type View = 'list' | 'chat' | 'stats' | 'history'

interface InfoPanelProps {
  initialTheme?: ThemeName
  onThemeChange?: (name: ThemeName) => void
  enabledSources?: SourceToggles
  pollIntervalMs?: number
  width?: number | string
  maxHeight?: number
  onContentResize?: (height: number) => void
}

function InfoPanelInner({
  enabledSources,
  pollIntervalMs = 10000,
  width = 360,
  maxHeight = 340,
  onContentResize,
}: Pick<InfoPanelProps, 'enabledSources' | 'pollIntervalMs' | 'width' | 'maxHeight' | 'onContentResize'>) {
  const { theme } = useTheme()
  const [sessions, setSessions] = useState<ClaudeSession[]>([])
  const [view, setView] = useState<View>('list')
  const [chatSession, setChatSession] = useState<ClaudeSession | null>(null)
  const [conversation, setConversation] = useState<ChatMessage[]>([])
  const [conversationLoading, setConversationLoading] = useState(false)
  const [statsSource, setStatsSource] = useState<AgentSource>('cc')
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = rootRef.current
    if (!el || !onContentResize) return
    let last = -1
    const report = () => {
      const h = Math.ceil(el.getBoundingClientRect().height)
      if (h > 0 && h !== last) {
        last = h
        onContentResize(h)
      }
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    return () => ro.disconnect()
  }, [onContentResize])

  useEffect(() => startSessionMonitor({ onSessions: setSessions }, {
    intervalMs: pollIntervalMs,
  }), [pollIntervalMs])

  const openChat = useCallback((s: ClaudeSession) => {
    setChatSession(s)
    setView('chat')
    setConversation([])
    setConversationLoading(true)
    getClaudeConversation(s.sessionId)
      .then((msgs) => setConversation(msgs))
      .catch(() => {})
      .finally(() => setConversationLoading(false))
  }, [])

  const openStats = useCallback((source: string) => {
    setStatsSource((source as AgentSource) || 'cc')
    setView('stats')
  }, [])

  const removeSession = useCallback((s: ClaudeSession) => {
    setSessions((prev) => prev.filter((x) => x.sessionId !== s.sessionId))
    removeClaudeSession(s.sessionId).catch((e) =>
      console.warn('remove session failed:', e),
    )
  }, [])

  const back = useCallback(() => {
    setView('list')
    setChatSession(null)
  }, [])

  const inDetail = view !== 'list'
  const displayedChatSession = sessions.find(session => session.sessionId === chatSession?.sessionId)
    ?? chatSession

  return (
    <div
      ref={rootRef}
      style={{
        ...themeCssVars(theme),
        width,
        height: inDetail ? maxHeight : undefined,
        maxHeight,
        display: 'flex',
        flexDirection: 'column',
        background: theme.bg,
        color: theme.text,
        borderRadius: 14,
        overflow: 'hidden',
        boxShadow: `inset 0 0 0 1px ${theme.border}`,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 14px',
          flexShrink: 0,
          borderBottom: `1px solid ${theme.border}`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          {inDetail ? (
            <button
              onClick={back}
              style={{
                background: 'none',
                border: 'none',
                color: theme.textDim,
                cursor: 'pointer',
                fontSize: 13,
                padding: 0,
              }}
            >
              ‹ 返回
            </button>
          ) : (
            <>
              <span style={{ fontSize: 14, fontWeight: 600, color: theme.text }}>会话</span>
              <button
                onClick={() => setView('history')}
                style={{ border: 0, background: 'transparent', color: theme.textDim, cursor: 'pointer', fontSize: 11 }}
              >
                完成历史
              </button>
            </>
          )}
          {view === 'chat' && displayedChatSession && (
            <span
              title={[sessionTitleOf(displayedChatSession), displayedChatSession.cwd].filter(Boolean).join('\n')}
              style={{ fontSize: 12, color: theme.textDim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {sessionTitleOf(displayedChatSession)}
            </span>
          )}
        </div>
      </div>

      {view === 'list' && (
        <SessionList
          sessions={sessions}
          enabled={enabledSources}
          onOpenChat={openChat}
          onOpenStats={openStats}
          onRemove={removeSession}
        />
      )}
      {view === 'chat' && <ChatView messages={conversation} loading={conversationLoading} />}
      {view === 'stats' && <StatsView source={statsSource} />}
      {view === 'history' && <CompletionHistoryView />}
    </div>
  )
}

export default function InfoPanel({
  initialTheme = 'pink',
  onThemeChange,
  ...rest
}: InfoPanelProps) {
  return (
    <ThemeProvider initialTheme={initialTheme} onThemeChange={onThemeChange}>
      <InfoPanelInner {...rest} />
    </ThemeProvider>
  )
}
