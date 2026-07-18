import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { Copy, History, Trash2, X } from 'lucide-react'
import {
  THEMES,
  themeCssVars,
  type ThemeName,
} from '@/features/info-panel/theme'
import {
  activateLatestModelChatConversation,
  deleteModelChatConversation,
  loadModelChatConversations,
  onModelChatHistoryChanged,
  onModelChatStream,
  setActiveModelChatConversation,
  type ModelChatConversation,
  type ModelChatMessage,
} from '@/features/model-chat/modelChatStore'
import css from '@/features/model-chat/modelChat.module.css'
import { loadSettings, onSettingsChanged } from '@/shared/appStore'
import { hideChatHistory } from './windowManager'

function MarkdownMessage({ content }: { content: string }) {
  const parts = content.split(/<think>|<\/think>/g)
  return (
    <>
      {parts.map((part, index) => {
        if (!part) return null
        const isThinking = index % 2 === 1
        if (isThinking) {
          return (
            <details key={index} className={css.thinkingBlock}>
              <summary>思考过程</summary>
              <div>{part.trim()}</div>
            </details>
          )
        }
        return (
          <ReactMarkdown
            key={index}
            components={{
              code({ className, children, ...props }) {
                const text = String(children).replace(/\n$/, '')
                const isBlock = typeof className === 'string' && className.startsWith('language-')
                if (!isBlock) {
                  return (
                    <code className={css.inlineCode} {...props}>
                      {children}
                    </code>
                  )
                }
                return (
                  <div className={css.codeBlock}>
                    <button
                      className={css.copyCodeButton}
                      title="复制代码"
                      onClick={() => navigator.clipboard.writeText(text).catch(() => {})}
                    >
                      <Copy size={12} />
                      复制
                    </button>
                    <pre>
                      <code className={className} {...props}>
                        {children}
                      </code>
                    </pre>
                  </div>
                )
              },
            }}
          >
            {part}
          </ReactMarkdown>
        )
      })}
    </>
  )
}

export default function ChatHistoryWindow() {
  const [themeName, setThemeName] = useState<ThemeName>('pink')
  const [messages, setMessages] = useState<ModelChatMessage[]>([])
  const [conversations, setConversations] = useState<ModelChatConversation[]>([])
  const [activeId, setActiveId] = useState('')
  const [showHistory, setShowHistory] = useState(false)
  const listRef = useRef<HTMLDivElement | null>(null)

  const refresh = () => {
    loadModelChatConversations()
      .then((state) => {
        setConversations(state.conversations)
        setActiveId(state.activeId)
        setMessages(state.conversations.find((c) => c.id === state.activeId)?.messages ?? [])
      })
      .catch(() => {})
  }

  useEffect(() => {
    loadSettings().then((s) => setThemeName(s.theme)).catch(() => {})
    activateLatestModelChatConversation().then(refresh).catch(refresh)
    const uns: (() => void)[] = []
    let disposed = false
    const add = (pending: Promise<() => void>) => pending
      .then((unlisten) => disposed ? unlisten() : uns.push(unlisten))
      .catch(() => {})
    add(onSettingsChanged((s) => setThemeName(s.theme)))
    add(onModelChatHistoryChanged(refresh))
    add(onModelChatStream((event) => {
      if (event.kind !== 'delta' && event.kind !== 'reasoning') return
      if (!event.content) return
      setMessages((current) => current.map((message) => {
        if (message.id !== event.requestId || message.status !== 'sending') return message
        let content = message.content
        if (event.kind === 'reasoning') {
          if (!content.includes('<think>')) content += '<think>\n'
          content += event.content
        } else {
          if (content.includes('<think>') && !content.includes('</think>')) content += '\n</think>\n\n'
          content += event.content
        }
        return { ...message, content }
      }))
    }))
    return () => {
      disposed = true
      uns.forEach((u) => u())
    }
  }, [])

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  const t = THEMES[themeName]
  const sortedConversations = conversations.slice().sort((a, b) => b.updatedAt - a.updatedAt)

  return (
    <div className={css.shell} style={themeCssVars(t)}>
      <div className={css.historyCard}>
        <div className={css.historyHeader}>
          <div className={css.historyTitle}>模型对话</div>
          <button
            className={css.historyButton}
            title="历史对话"
            onClick={() => setShowHistory((v) => !v)}
          >
            <History size={13} />
            历史对话
          </button>
          <button className={css.closeButton} title="关闭" onClick={() => hideChatHistory().catch(() => {})}>
            <X size={14} />
          </button>
        </div>
        {showHistory && (
          <div className={css.conversationList}>
            {sortedConversations.map((c) => (
              <button
                key={c.id}
                className={[
                  css.conversationItem,
                  c.id === activeId ? css.conversationItemActive : '',
                ].join(' ')}
                onClick={async () => {
                  await setActiveModelChatConversation(c.id).catch(() => {})
                  setShowHistory(false)
                }}
              >
                <span className={css.conversationName}>{c.title}</span>
                <span className={css.conversationMeta}>
                  {new Date(c.updatedAt).toLocaleString('zh-CN', {
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
                <span
                  className={css.conversationDelete}
                  title="删除会话"
                  onClick={(e) => {
                    e.stopPropagation()
                    deleteModelChatConversation(c.id).catch(() => {})
                  }}
                >
                  <Trash2 size={12} />
                </span>
              </button>
            ))}
          </div>
        )}
        <div className={css.messageList} ref={listRef}>
          {messages.length === 0 && <div className={css.empty}>暂无对话</div>}
          {messages.map((m) => (
            <div
              key={m.id}
              className={[
                css.message,
                m.role === 'user' ? css.user : css.assistant,
                m.status === 'error' ? css.error : '',
              ].join(' ')}
            >
              {m.role === 'assistant' ? <MarkdownMessage content={m.content} /> : m.content}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
