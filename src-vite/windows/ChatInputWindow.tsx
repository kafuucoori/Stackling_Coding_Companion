import { useCallback, useEffect, useRef, useState } from 'react'
import { MessageSquare, Plus } from 'lucide-react'
import {
  THEMES,
  themeCssVars,
  type ThemeName,
} from '@/features/info-panel/theme'
import {
  appendModelChatMessages,
  cancelModelChatStream,
  createModelChatConversation,
  createMessage,
  loadActiveModelChatConversation,
  onModelChatStream,
  sendModelChatMessage,
  setModelChatBusy,
  streamModelChatMessage,
  toApiMessages,
  updateActiveModelChatSummary,
  type ModelChatApiMessage,
  type ModelChatConversation,
  type ModelChatMessage,
  updateModelChatMessage,
} from '@/features/model-chat/modelChatStore'
import css from '@/features/model-chat/modelChat.module.css'
import {
  loadSettings,
  onSettingsChanged,
  type AppSettings,
} from '@/shared/appStore'
import {
  hideChatInput,
  positionChatHistoryNearMascot,
  toggleChatHistory,
} from './windowManager'

function safeContextLimit(value: number): number {
  const n = Math.round(Number(value))
  return Number.isFinite(n) ? Math.min(50, Math.max(2, n)) : 20
}

function formatSummaryMessages(messages: ModelChatMessage[]): string {
  return messages
    .filter((m) => m.status === 'done' && m.content.trim())
    .map((m) => `${m.role === 'user' ? '用户' : '助手'}：${m.content.trim()}`)
    .join('\n')
}

const SUMMARY_BATCH_SIZE = 10

async function ensureRollingSummary(
  settings: AppSettings,
  conversation: ModelChatConversation,
): Promise<ModelChatConversation> {
  if (!settings.modelChatAutoSummary) return conversation

  const done = conversation.messages.filter((m) => m.status === 'done' && m.content.trim())
  const limit = safeContextLimit(settings.modelChatContextLimit)
  const summarizeThrough = done.length - limit
  if (summarizeThrough <= 0) return conversation

  const target = done[summarizeThrough - 1]
  if (!target || conversation.summarizedThroughMessageId === target.id) return conversation

  const previousIndex = conversation.summarizedThroughMessageId
    ? done.findIndex((m) => m.id === conversation.summarizedThroughMessageId)
    : -1
  const newMessages = done.slice(previousIndex + 1, summarizeThrough)
  if (newMessages.length < SUMMARY_BATCH_SIZE) return conversation

  const res = await sendModelChatMessage({
    providerUrl: settings.modelChatProviderUrl,
    apiKey: settings.modelChatApiKey,
    model: settings.modelChatModel,
    messages: [
      {
        role: 'system',
        content:
          '你负责维护一段桌面看板娘聊天的滚动摘要。请用简洁中文保留事实、用户偏好、未完成事项、重要决策和上下文线索。不要编造，不要输出 Markdown 标题。',
      },
      {
        role: 'user',
        content: [
          conversation.summary?.trim()
            ? `已有摘要：\n${conversation.summary.trim()}`
            : '已有摘要：无',
          `新增需要合并的早期消息：\n${formatSummaryMessages(newMessages)}`,
          '请输出更新后的完整摘要，控制在 600 字以内。',
        ].join('\n\n'),
      },
    ],
  })

  const summary = res.content.trim()
  if (!summary) return conversation
  await updateActiveModelChatSummary(summary, target.id)
  return {
    ...conversation,
    summary,
    summarizedThroughMessageId: target.id,
  }
}

function buildChatMessages(
  settings: AppSettings,
  conversation: ModelChatConversation,
  currentUserContent: string,
): ModelChatApiMessage[] {
  const messages: ModelChatApiMessage[] = []
  const systemPrompt = settings.modelChatSystemPrompt.trim()
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt })
  if (settings.modelChatAutoSummary && conversation.summary?.trim()) {
    messages.push({
      role: 'system',
      content: `以下是当前会话更早历史的滚动摘要，用于延续上下文：\n${conversation.summary.trim()}`,
    })
  }
  messages.push(...toApiMessages(conversation.messages, safeContextLimit(settings.modelChatContextLimit)))
  messages.push({ role: 'user', content: currentUserContent })
  return messages
}

export default function ChatInputWindow() {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [themeName, setThemeName] = useState<ThemeName>('pink')
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const streamTextRef = useRef('')
  const reasoningOpenRef = useRef(false)
  const activeRequestRef = useRef<{ id: string; assistantId: string } | null>(null)

  useEffect(() => {
    loadSettings()
      .then((s) => {
        setSettings(s)
        setThemeName(s.theme)
        if (!s.modelChatEnabled) hideChatInput().catch(() => {})
      })
      .catch(() => {})
    let un: (() => void) | undefined
    let disposed = false
    onSettingsChanged((s) => {
      setSettings(s)
      setThemeName(s.theme)
      if (!s.modelChatEnabled) hideChatInput().catch(() => {})
    }).then((u) => disposed ? u() : (un = u))
    return () => {
      disposed = true
      un?.()
    }
  }, [])

  const stop = useCallback(async () => {
    const active = activeRequestRef.current
    if (!active) return
    await cancelModelChatStream(active.id).catch(() => {})
    await updateModelChatMessage(active.assistantId, {
      content: streamTextRef.current || '已停止生成。',
      status: 'done',
    }).catch(() => {})
    activeRequestRef.current = null
    setSending(false)
    setModelChatBusy(false).catch(() => {})
  }, [])

  const send = useCallback(async () => {
    const s = settings
    const content = text.trim()
    if (!s || !content || sending) return
    if (!s.modelChatProviderUrl.trim() || !s.modelChatApiKey.trim() || !s.modelChatModel.trim()) {
      await appendModelChatMessages([
        createMessage('assistant', '请先在设置中填写提供商地址、API 密钥和模型名称。', 'error'),
      ])
      await positionChatHistoryNearMascot().catch(() => {})
      return
    }

    setSending(true)
    setText('')
    let conversation = await loadActiveModelChatConversation()
    try {
      conversation = await ensureRollingSummary(s, conversation)
    } catch (e) {
      console.warn('[model-chat] summary update failed:', e)
    }
    const history = conversation.messages
    const user = createMessage('user', content)
    const assistant = createMessage('assistant', '', 'sending')
    const requestId = assistant.id
    streamTextRef.current = ''
    reasoningOpenRef.current = false
    activeRequestRef.current = { id: requestId, assistantId: assistant.id }
    await appendModelChatMessages([user, assistant])
    await positionChatHistoryNearMascot().catch(() => {})
    await setModelChatBusy(true).catch(() => {})

    let unlisten: (() => void) | undefined
    try {
      unlisten = await onModelChatStream((event) => {
        if (event.requestId !== requestId) return
        if (event.kind === 'delta' && event.content) {
          if (reasoningOpenRef.current) {
            streamTextRef.current += '\n</think>\n\n'
            reasoningOpenRef.current = false
          }
          streamTextRef.current += event.content
          return
        }
        if (event.kind === 'reasoning' && event.content) {
          if (!reasoningOpenRef.current) {
            streamTextRef.current += '<think>\n'
            reasoningOpenRef.current = true
          }
          streamTextRef.current += event.content
          return
        }
        if (event.kind === 'done') {
          if (reasoningOpenRef.current) {
            streamTextRef.current += '\n</think>'
            reasoningOpenRef.current = false
          }
          updateModelChatMessage(assistant.id, {
            content: streamTextRef.current || '（无回复内容）',
            status: 'done',
          }).catch(() => {})
          unlisten?.()
          activeRequestRef.current = null
          setSending(false)
          setModelChatBusy(false).catch(() => {})
          return
        }
        if (event.kind === 'error') {
          updateModelChatMessage(assistant.id, {
            content: `请求失败：${event.error ?? '未知错误'}`,
            status: 'error',
          }).catch(() => {})
          unlisten?.()
          activeRequestRef.current = null
          setSending(false)
          setModelChatBusy(false).catch(() => {})
        }
      })
      await streamModelChatMessage(requestId, {
        providerUrl: s.modelChatProviderUrl,
        apiKey: s.modelChatApiKey,
        model: s.modelChatModel,
        messages: buildChatMessages(s, { ...conversation, messages: history }, content),
      })
    } catch (e) {
      unlisten?.()
      activeRequestRef.current = null
      await updateModelChatMessage(assistant.id, { content: `请求失败：${String(e)}`, status: 'error' })
      setSending(false)
      setModelChatBusy(false).catch(() => {})
    }
  }, [settings, sending, text])

  const startNewChat = useCallback(async () => {
    if (sending) await stop()
    streamTextRef.current = ''
    reasoningOpenRef.current = false
    activeRequestRef.current = null
    await createModelChatConversation().catch(() => {})
    await positionChatHistoryNearMascot().catch(() => {})
  }, [sending, stop])

  const t = THEMES[themeName]

  return (
    <div className={css.shell} style={themeCssVars(t)}>
      <div className={css.inputBar}>
        <button
          className={css.iconButton}
          title="对话记录"
          onClick={() => toggleChatHistory().catch(() => {})}
        >
          <MessageSquare size={16} />
        </button>
        <button
          className={css.iconButton}
          title="新对话"
          onClick={() => startNewChat().catch(() => {})}
        >
          <Plus size={16} />
        </button>
        <input
          className={css.input}
          value={text}
          disabled={sending}
          placeholder="和看板娘说点什么..."
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
        />
        <button
          className={css.sendButton}
          disabled={!sending && !text.trim()}
          onClick={() => {
            if (sending) void stop()
            else void send()
          }}
        >
          {sending ? '停止' : '发送'}
        </button>
      </div>
    </div>
  )
}
