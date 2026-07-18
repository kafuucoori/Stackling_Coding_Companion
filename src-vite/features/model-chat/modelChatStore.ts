import { invoke } from '@tauri-apps/api/core'
import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event'
import { load } from '@tauri-apps/plugin-store'

const CONVERSATIONS_KEY = 'model_chat_conversations'
const ACTIVE_CONVERSATION_KEY = 'model_chat_active_conversation_id'
const MODEL_CHAT_HISTORY_CHANGED = 'model-chat-history-changed'
const MODEL_CHAT_BUSY_CHANGED = 'model-chat-busy-changed'
const MAX_CONVERSATIONS = 20
const MAX_MESSAGES_PER_CONVERSATION = 500

export type ModelChatRole = 'user' | 'assistant' | 'system'
export type ModelChatStatus = 'sending' | 'done' | 'error'

export interface ModelChatMessage {
  id: string
  role: ModelChatRole
  content: string
  createdAt: number
  status: ModelChatStatus
}

export interface ModelChatConversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: ModelChatMessage[]
  summary?: string
  summarizedThroughMessageId?: string
}

export interface ModelChatApiMessage {
  role: ModelChatRole
  content: string
}

export interface SendModelChatRequest {
  providerUrl: string
  apiKey: string
  model: string
  messages: ModelChatApiMessage[]
}

export interface SendModelChatResponse {
  content: string
}

export interface ModelChatStreamEvent {
  requestId: string
  kind: 'delta' | 'reasoning' | 'done' | 'error'
  content?: string | null
  error?: string | null
}

async function store() {
  return load('model-chat.json', { defaults: {}, autoSave: true })
}

function createId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function createMessage(
  role: ModelChatRole,
  content: string,
  status: ModelChatStatus = 'done',
): ModelChatMessage {
  return {
    id: createId(),
    role,
    content,
    status,
    createdAt: Date.now(),
  }
}

function defaultConversationTitle(messages: ModelChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === 'user' && m.content.trim())
  if (!firstUser) return '新对话'
  return firstUser.content.trim().replace(/\s+/g, ' ').slice(0, 24)
}

function createConversation(messages: ModelChatMessage[] = []): ModelChatConversation {
  const now = Date.now()
  return {
    id: createId(),
    title: defaultConversationTitle(messages),
    createdAt: now,
    updatedAt: now,
    messages,
    summary: '',
    summarizedThroughMessageId: undefined,
  }
}

function latestConversation(conversations: ModelChatConversation[]): ModelChatConversation | undefined {
  return conversations.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0]
}

async function loadConversationState(): Promise<{
  conversations: ModelChatConversation[]
  activeId: string
}> {
  const s = await store()
  let conversations = await s.get<ModelChatConversation[]>(CONVERSATIONS_KEY)
  let activeId = await s.get<string>(ACTIVE_CONVERSATION_KEY)

  if (!Array.isArray(conversations) || conversations.length === 0) {
    conversations = [createConversation()]
    activeId = conversations[0].id
    await s.set(CONVERSATIONS_KEY, conversations)
    await s.set(ACTIVE_CONVERSATION_KEY, activeId)
    await s.save()
  }

  conversations = conversations
    .filter((c) => c && typeof c.id === 'string')
    .map((c) => ({
      ...c,
      title: c.title || defaultConversationTitle(c.messages ?? []),
      messages: Array.isArray(c.messages) ? c.messages.slice(-MAX_MESSAGES_PER_CONVERSATION) : [],
      summary: typeof c.summary === 'string' ? c.summary : '',
      summarizedThroughMessageId:
        typeof c.summarizedThroughMessageId === 'string' ? c.summarizedThroughMessageId : undefined,
    }))
    .slice(-MAX_CONVERSATIONS)

  if (!activeId || !conversations.some((c) => c.id === activeId)) {
    activeId = latestConversation(conversations)?.id ?? createConversation().id
  }

  if (conversations.length === 0) {
    const conv = createConversation()
    conversations = [conv]
    activeId = conv.id
  }

  return { conversations, activeId }
}

async function saveConversationState(
  conversations: ModelChatConversation[],
  activeId: string,
): Promise<void> {
  const s = await store()
  const next = conversations
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .slice(-MAX_CONVERSATIONS)
  const nextActiveId = next.some((c) => c.id === activeId) ? activeId : next[next.length - 1]?.id
  await s.set(CONVERSATIONS_KEY, next)
  await s.set(ACTIVE_CONVERSATION_KEY, nextActiveId)
  await s.save()
  await emit(MODEL_CHAT_HISTORY_CHANGED)
}

export async function loadModelChatConversations(): Promise<{
  conversations: ModelChatConversation[]
  activeId: string
}> {
  return loadConversationState()
}

export async function loadActiveModelChatConversation(): Promise<ModelChatConversation> {
  const { conversations, activeId } = await loadConversationState()
  return conversations.find((c) => c.id === activeId) ?? conversations[0]
}

export async function activateLatestModelChatConversation(): Promise<{
  conversations: ModelChatConversation[]
  activeId: string
}> {
  const { conversations } = await loadConversationState()
  const latest = latestConversation(conversations)
  if (!latest) {
    const conv = await createModelChatConversation()
    return { conversations: [conv], activeId: conv.id }
  }
  await saveConversationState(conversations, latest.id)
  return { conversations, activeId: latest.id }
}

export async function setActiveModelChatConversation(id: string): Promise<void> {
  const { conversations } = await loadConversationState()
  if (!conversations.some((c) => c.id === id)) return
  await saveConversationState(conversations, id)
}

export async function deleteModelChatConversation(id: string): Promise<void> {
  const { conversations, activeId } = await loadConversationState()
  const remaining = conversations.filter((c) => c.id !== id)
  if (remaining.length === 0) {
    const conv = createConversation()
    await saveConversationState([conv], conv.id)
    return
  }
  const nextActiveId = activeId === id ? latestConversation(remaining)?.id ?? remaining[0].id : activeId
  await saveConversationState(remaining, nextActiveId)
}

export async function cleanupModelChatConversations(retentionDays: number): Promise<number> {
  const { conversations, activeId } = await loadConversationState()
  const cutoff = Date.now() - Math.max(1, retentionDays) * 24 * 60 * 60 * 1000
  const latest = latestConversation(conversations)
  const next = conversations.filter((conversation) =>
    conversation.updatedAt >= cutoff || conversation.id === latest?.id,
  )
  const removed = conversations.length - next.length
  if (removed > 0) {
    await saveConversationState(next, next.some((c) => c.id === activeId) ? activeId : next[0].id)
  }
  return removed
}

export async function createModelChatConversation(): Promise<ModelChatConversation> {
  const state = await loadConversationState()
  const conv = createConversation()
  await saveConversationState([...state.conversations, conv], conv.id)
  return conv
}

async function loadModelChatHistory(): Promise<ModelChatMessage[]> {
  const { conversations, activeId } = await loadConversationState()
  return conversations.find((c) => c.id === activeId)?.messages ?? []
}

async function saveModelChatHistory(history: ModelChatMessage[]): Promise<void> {
  const { conversations, activeId } = await loadConversationState()
  const now = Date.now()
  const next = conversations.map((c) =>
    c.id === activeId
      ? {
          ...c,
          title: defaultConversationTitle(history),
          updatedAt: now,
          messages: history.slice(-MAX_MESSAGES_PER_CONVERSATION),
        }
      : c,
  )
  await saveConversationState(next, activeId)
}

export async function updateActiveModelChatSummary(
  summary: string,
  summarizedThroughMessageId: string,
): Promise<void> {
  const { conversations, activeId } = await loadConversationState()
  const now = Date.now()
  const next = conversations.map((c) =>
    c.id === activeId
      ? {
          ...c,
          summary,
          summarizedThroughMessageId,
          updatedAt: now,
        }
      : c,
  )
  await saveConversationState(next, activeId)
}

export async function appendModelChatMessages(messages: ModelChatMessage[]): Promise<ModelChatMessage[]> {
  const history = await loadModelChatHistory()
  const next = [...history, ...messages]
  await saveModelChatHistory(next)
  return next
}

export async function updateModelChatMessage(
  id: string,
  patch: Partial<Pick<ModelChatMessage, 'content' | 'status'>>,
): Promise<ModelChatMessage[]> {
  const { conversations, activeId } = await loadConversationState()
  const now = Date.now()
  const next = conversations.map((c) => {
    if (!c.messages.some((m) => m.id === id)) return c
    return {
      ...c,
      updatedAt: now,
      messages: c.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    }
  })
  await saveConversationState(next, activeId)
  return next.find((c) => c.id === activeId)?.messages ?? []
}

export function onModelChatHistoryChanged(cb: () => void): Promise<UnlistenFn> {
  return listen(MODEL_CHAT_HISTORY_CHANGED, () => cb())
}

export function toApiMessages(history: ModelChatMessage[], limit = 20): ModelChatApiMessage[] {
  return history
    .filter((m) => m.status === 'done' && m.content.trim())
    .slice(-limit)
    .map((m) => ({ role: m.role, content: m.content }))
}

export async function setModelChatBusy(busy: boolean): Promise<void> {
  await emit(MODEL_CHAT_BUSY_CHANGED, busy)
}

export function onModelChatBusyChanged(cb: (busy: boolean) => void): Promise<UnlistenFn> {
  return listen<boolean>(MODEL_CHAT_BUSY_CHANGED, (e) => cb(Boolean(e.payload)))
}

export function sendModelChatMessage(
  request: SendModelChatRequest,
): Promise<SendModelChatResponse> {
  return invoke<SendModelChatResponse>('send_model_chat_message', { request })
}

export function streamModelChatMessage(
  requestId: string,
  request: SendModelChatRequest,
): Promise<void> {
  return invoke('stream_model_chat_message', {
    request: {
      requestId,
      ...request,
    },
  })
}

export function cancelModelChatStream(requestId: string): Promise<void> {
  return invoke('cancel_model_chat_stream', { requestId })
}

export function onModelChatStream(
  cb: (event: ModelChatStreamEvent) => void,
): Promise<UnlistenFn> {
  return listen<ModelChatStreamEvent>('model-chat-stream', (e) => cb(e.payload))
}
