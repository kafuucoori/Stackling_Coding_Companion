/**
 * SessionList —— CC / Codex / Cursor 会话列表。每行：状态点 + 项目名
 * + source 徽标；CC 等待授权时显示精简授权按钮。
 */

import { motion, AnimatePresence } from 'motion/react'
import { X } from 'lucide-react'
import {
  resolveClaudePermission,
  type ClaudeSession,
  type PermissionDecision,
} from '@/features/agent-monitor/agentMonitor'
import { useTheme } from './theme'
import css from './theme.module.css'
import {
  displayStateOf,
  sessionSortRank,
  projectNameOf,
  sourceLabel,
  type SessionDisplayState,
} from './utils'

export interface SourceToggles {
  cc?: boolean
  codex?: boolean
  cursor?: boolean
}

interface SessionListProps {
  sessions: ClaudeSession[]
  enabled?: SourceToggles
  onOpenChat?: (session: ClaudeSession) => void
  onOpenStats?: (source: string) => void
  onRemove?: (session: ClaudeSession) => void
}

const STATE_TEXT: Record<SessionDisplayState, string> = {
  waiting: '等待授权',
  working: '工作中',
  compacting: '压缩上下文',
  done: '已完成',
  idle: '空闲',
}

const PERMISSION_BUTTONS: { decision: PermissionDecision; label: string }[] = [
  { decision: 'deny', label: '拒绝' },
  { decision: 'allow_once', label: '允许一次' },
  { decision: 'allow_all', label: '全允许' },
  { decision: 'auto_approve', label: '自动' },
]

const CHOICE_TOOLS = new Set([
  'AskUserQuestion',
  'AskQuestion',
  'Elicitation',
  'AgentInput',
  'PermissionNotice',
])
function isChoiceTool(s: ClaudeSession): boolean {
  return !!s.tool && CHOICE_TOOLS.has(s.tool)
}

function isEnabled(s: ClaudeSession, en: SourceToggles): boolean {
  if (s.source === 'cursor') return en.cursor !== false
  if (s.source === 'codex') return en.codex !== false
  return en.cc !== false
}

function taskDurationText(session: ClaudeSession): string {
  const duration = session.taskDurationMs
    ?? (session.taskStartedAt ? Math.max(0, Date.now() - session.taskStartedAt) : 0)
  if (duration < 1000) return ''
  const minutes = Math.floor(duration / 60000)
  const seconds = Math.round((duration % 60000) / 1000)
  return minutes ? `${minutes}分${seconds}秒` : `${seconds}秒`
}

export default function SessionList({
  sessions,
  enabled = {},
  onOpenChat,
  onOpenStats,
  onRemove,
}: SessionListProps) {
  const { theme } = useTheme()

  const visible = sessions
    .filter((s) => isEnabled(s, enabled))
    .sort((a, b) => {
      const r = sessionSortRank(a) - sessionSortRank(b)
      return r !== 0 ? r : b.updatedAt - a.updatedAt
    })

  if (visible.length === 0) {
    return (
      <div className={css.scrollbarThin} style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        <div
          style={{
            padding: '10px 16px',
            borderBottom: `1px solid ${theme.border}`,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
            <div
              style={{
                flexShrink: 0,
                width: 24,
                height: 24,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: theme.textFaint,
                }}
              />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1, gap: 2 }}>
              <span
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: theme.text,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                暂无活动会话
              </span>
              <span style={{ fontSize: 11, color: theme.textDim }}>
                等待 Agent 开始工作
              </span>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const dotColor = (st: SessionDisplayState) =>
    st === 'waiting' ? theme.statusWaiting : st === 'done' ? theme.statusDone : theme.statusWorking

  return (
    <div className={css.scrollbarThin} style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      <AnimatePresence initial={false}>
        {visible.map((s, index) => {
          const st = displayStateOf(s)
          const isWaiting = st === 'waiting'
          return (
            <motion.div
              key={s.sessionId}
              layout
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, filter: 'blur(4px)' }}
              transition={{ duration: 0.2, delay: index * 0.04 }}
              style={{
                padding: '10px 16px',
                borderBottom: `1px solid ${theme.border}`,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                <div
                  onClick={() => onOpenChat?.(s)}
                  style={{
                    position: 'relative',
                    flexShrink: 0,
                    width: 24,
                    height: 24,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                  }}
                  title="查看对话"
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: dotColor(st),
                    }}
                  />
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1, gap: 2 }}>
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: theme.text,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {projectNameOf(s.cwd)}
                  </span>
                  <span style={{ fontSize: 11, color: theme.textDim }}>
                    {sourceLabel(s.source)} · {STATE_TEXT[st]}
                    {taskDurationText(s) ? ` · ${taskDurationText(s)}` : ''}
                  </span>
                </div>

                <button
                  onClick={() => onOpenStats?.(s.source)}
                  style={{
                    flexShrink: 0,
                    fontSize: 11,
                    padding: '2px 8px',
                    borderRadius: 6,
                    border: `1px solid ${theme.border}`,
                    background: 'transparent',
                    color: theme.textDim,
                    cursor: 'pointer',
                  }}
                  title="查看统计"
                >
                  统计
                </button>

                {onRemove && (
                  <button
                    onClick={() => onRemove(s)}
                    style={{
                      flexShrink: 0,
                      width: 22,
                      height: 22,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: 6,
                      border: `1px solid ${theme.border}`,
                      background: 'transparent',
                      color: theme.textFaint,
                      cursor: 'pointer',
                      padding: 0,
                    }}
                    title="清除此会话"
                    onMouseEnter={(e) => {
                      ;(e.currentTarget as HTMLElement).style.color = theme.statusWaiting
                    }}
                    onMouseLeave={(e) => {
                      ;(e.currentTarget as HTMLElement).style.color = theme.textFaint
                    }}
                  >
                    <X style={{ width: 13, height: 13 }} />
                  </button>
                )}
              </div>

              {isWaiting && s.source !== 'cursor' && isChoiceTool(s) && (
                <div
                  style={{
                    marginTop: 8,
                    paddingLeft: 36,
                    fontSize: 11,
                    color: theme.textDim,
                    lineHeight: 1.5,
                  }}
                >
                  Claude 正在等待输入或授权 —— 请到该会话中处理。
                </div>
              )}
              {isWaiting && s.source !== 'cursor' && !isChoiceTool(s) && (
                <div style={{ display: 'flex', gap: 6, marginTop: 8, paddingLeft: 36 }}>
                  {s.tool && (
                    <span
                      style={{
                        fontSize: 11,
                        color: theme.textDim,
                        alignSelf: 'center',
                        marginRight: 'auto',
                      }}
                    >
                      {s.tool}
                    </span>
                  )}
                  {(s.source === 'codex' ? PERMISSION_BUTTONS.slice(0, 2) : PERMISSION_BUTTONS).map((b) => (
                    <button
                      key={b.decision}
                      onClick={() => {
                        resolveClaudePermission(s.sessionId, b.decision).catch((err) =>
                          console.warn('resolve permission failed:', err),
                        )
                      }}
                      style={{
                        fontSize: 11,
                        padding: '3px 10px',
                        borderRadius: 6,
                        border: 'none',
                        cursor: 'pointer',
                        background: b.decision === 'deny' ? theme.surfaceHover : theme.accent,
                        color: b.decision === 'deny' ? theme.textDim : '#fff',
                        fontWeight: 500,
                      }}
                    >
                      {b.label}
                    </button>
                  ))}
                </div>
              )}
            </motion.div>
          )
        })}
      </AnimatePresence>
    </div>
  )
}
