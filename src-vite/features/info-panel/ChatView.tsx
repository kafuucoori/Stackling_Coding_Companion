/**
 * ChatView —— 会话对话记录。user 纯文本气泡 / assistant markdown，长消息可展开，自动滚到底。
 */

import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { ChevronDown } from 'lucide-react'
import type { ChatMessage } from '@/features/agent-monitor/agentMonitor'
import { useTheme } from './theme'
import css from './theme.module.css'

interface ChatViewProps {
  messages: ChatMessage[]
  loading?: boolean
}

export default function ChatView({ messages, loading = false }: ChatViewProps) {
  const { theme } = useTheme()
  const containerRef = useRef<HTMLDivElement>(null)
  const [expandedSet, setExpandedSet] = useState<Set<number>>(new Set())

  useEffect(() => {
    const el = containerRef.current
    if (el) requestAnimationFrame(() => (el.scrollTop = el.scrollHeight))
  }, [messages.length])

  const toggle = (i: number) =>
    setExpandedSet((prev) => {
      const s = new Set(prev)
      if (s.has(i)) s.delete(i)
      else s.add(i)
      return s
    })

  if (loading || messages.length === 0) {
    return (
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: theme.textFaint,
          fontSize: 13,
        }}
      >
        {loading ? '加载中…' : '暂无对话记录'}
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className={`${css.scrollbarThin} ${css.selectableText}`}
      style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '12px 14px' }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {messages.map((msg, i) => (
          <div key={i}>
            {msg.role === 'user'
              ? (() => {
                  const limit = 300
                  const truncated = !expandedSet.has(i) && msg.text.length > limit
                  return (
                    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                      <div
                        style={{
                          background: theme.accent,
                          borderRadius: 18,
                          padding: '8px 14px',
                          maxWidth: '80%',
                          color: '#fff',
                          fontSize: 13,
                          lineHeight: 1.5,
                          wordBreak: 'break-word',
                          whiteSpace: 'pre-wrap',
                        }}
                      >
                        {truncated ? msg.text.slice(0, limit) + '...' : msg.text}
                        {(truncated || (expandedSet.has(i) && msg.text.length > limit)) && (
                          <button
                            onClick={() => toggle(i)}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              width: '100%',
                              marginTop: 4,
                              padding: '2px 0',
                              background: 'none',
                              border: 'none',
                              color: 'rgba(255,255,255,0.6)',
                              fontSize: 11,
                              cursor: 'pointer',
                            }}
                          >
                            <ChevronDown
                              style={{
                                width: 12,
                                height: 12,
                                transition: 'transform 0.2s',
                                transform: expandedSet.has(i) ? 'rotate(180deg)' : 'none',
                              }}
                            />
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })()
              : (() => {
                  const limit = 500
                  const truncated = !expandedSet.has(i) && msg.text.length > limit
                  return (
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                      <div
                        style={{
                          width: 5,
                          height: 5,
                          borderRadius: '50%',
                          background: theme.accent,
                          marginTop: 6,
                          flexShrink: 0,
                        }}
                      />
                      <div className={css.markdownContent} style={{ color: theme.text, maxWidth: '90%' }}>
                        <ReactMarkdown>{truncated ? msg.text.slice(0, limit) + '...' : msg.text}</ReactMarkdown>
                        {(truncated || (expandedSet.has(i) && msg.text.length > limit)) && (
                          <button
                            onClick={() => toggle(i)}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              width: '100%',
                              marginTop: 2,
                              padding: '2px 0',
                              background: 'none',
                              border: 'none',
                              color: theme.textFaint,
                              fontSize: 11,
                              cursor: 'pointer',
                            }}
                          >
                            <ChevronDown
                              style={{
                                width: 12,
                                height: 12,
                                transition: 'transform 0.2s',
                                transform: expandedSet.has(i) ? 'rotate(180deg)' : 'none',
                              }}
                            />
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })()}
          </div>
        ))}
      </div>
    </div>
  )
}
