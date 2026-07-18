// agentMonitor.ts —— 前端 client：对接 Rust 端的 Agent 监控管线

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export type AgentSource = 'cc' | 'codex' | 'cursor'

export type AgentStatus =
  | 'processing'
  | 'tool_running'
  | 'compacting'
  | 'waiting'
  | 'idle'
  | 'stopped'

export interface ClaudeSession {
  sessionId: string
  cwd: string
  status: AgentStatus | string
  tool?: string | null
  toolInput?: string | null
  userPrompt?: string | null
  updatedAt: number
  taskStartedAt?: number | null
  taskDurationMs?: number | null
  waitingDurationMs: number
  lastResponse?: string | null
  source: AgentSource | string
}

export interface ClaudeDailyStats {
  date: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  messages: number
  sessions: number
}

export interface ClaudeStats {
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheWriteTokens: number
  totalMessages: number
  totalSessions: number
  dailyStats: ClaudeDailyStats[]
  model: string
}

export interface ChatMessage {
  role: string
  text: string
}

export type PermissionDecision = 'deny' | 'allow_once' | 'allow_all' | 'auto_approve'

export function getClaudeSessions(): Promise<ClaudeSession[]> {
  return invoke<ClaudeSession[]>('get_claude_sessions')
}

export function removeClaudeSession(sessionId: string): Promise<void> {
  return invoke('remove_claude_session', { sessionId })
}

export function resolveClaudePermission(
  sessionId: string,
  decision: PermissionDecision,
): Promise<void> {
  return invoke('resolve_claude_permission', { sessionId, decision })
}

export function getClaudeStats(source?: AgentSource): Promise<ClaudeStats> {
  return invoke<ClaudeStats>('get_claude_stats', { source })
}

export function getClaudeConversation(sessionId: string): Promise<ChatMessage[]> {
  return invoke<ChatMessage[]>('get_claude_conversation', { sessionId })
}

export interface SessionMonitorCallbacks {
  onSessions?: (sessions: ClaudeSession[]) => void
  onComplete?: (session: ClaudeSession) => void
  onTaskCompleteEvent?: (payload: unknown) => void
  onError?: (err: unknown) => void
}

export interface SessionMonitorOptions {
  intervalMs?: number
}

interface TaskCompletePayload {
  sessionId?: string
  waiting?: boolean
}

export function startSessionMonitor(
  cbs: SessionMonitorCallbacks,
  opts: SessionMonitorOptions = {},
): () => void {
  const intervalMs = opts.intervalMs ?? 10000
  const seenCompletions = new Set<string>()
  let stopped = false
  let busy = false

  const poll = async () => {
    if (stopped || busy) return
    busy = true
    try {
      const sessions = await getClaudeSessions()
      if (stopped) return
      cbs.onSessions?.(sessions)
      for (const s of sessions) {
        if (s.status !== 'stopped' || !s.lastResponse) {
          seenCompletions.delete(s.sessionId)
          continue
        }
        if (s.lastResponse && s.status === 'stopped' && !seenCompletions.has(s.sessionId)) {
          seenCompletions.add(s.sessionId)
          cbs.onComplete?.(s)
        }
      }
      const alive = new Set(sessions.map((s) => s.sessionId))
      for (const id of Array.from(seenCompletions)) {
        if (!alive.has(id)) seenCompletions.delete(id)
      }
    } catch (err) {
      cbs.onError?.(err)
    } finally {
      busy = false
    }
  }

  const timer = setInterval(poll, intervalMs)
  void poll()

  const completeFromEvent = async (payload: TaskCompletePayload) => {
    if (stopped || payload.waiting || !payload.sessionId || seenCompletions.has(payload.sessionId)) {
      return
    }
    try {
      const sessions = await getClaudeSessions()
      if (stopped) return
      cbs.onSessions?.(sessions)
      const session = sessions.find((s) => s.sessionId === payload.sessionId)
      if (!session || seenCompletions.has(session.sessionId)) return
      seenCompletions.add(session.sessionId)
      cbs.onComplete?.(session)
    } catch (err) {
      cbs.onError?.(err)
    }
  }

  const unlistenPromises: Promise<UnlistenFn>[] = [
    listen('claude-session-update', () => {
      void poll()
    }),
    listen('claude-task-complete', (ev) => {
      cbs.onTaskCompleteEvent?.(ev.payload)
      void completeFromEvent(ev.payload as TaskCompletePayload)
    }),
  ]

  return () => {
    stopped = true
    clearInterval(timer)
    for (const p of unlistenPromises) p.then((un) => un()).catch(() => {})
  }
}

export type PetState = 'idle' | 'working' | 'compacting' | 'waiting'

export function sessionToPetState(s: ClaudeSession): PetState {
  switch (s.status) {
    case 'processing':
    case 'tool_running':
      return 'working'
    case 'compacting':
      return 'compacting'
    case 'waiting':
      return 'waiting'
    default:
      return 'idle'
  }
}

export function aggregatePetState(sessions: ClaudeSession[]): PetState {
  let working = false
  let compacting = false
  for (const s of sessions) {
    const st = sessionToPetState(s)
    if (st === 'waiting') return 'waiting'
    if (st === 'working') working = true
    if (st === 'compacting') compacting = true
  }
  if (working) return 'working'
  if (compacting) return 'compacting'
  return 'idle'
}

export function isSourceEnabled(source: string, settings: {
  enableClaudeCode: boolean
  enableCodex: boolean
  enableCursor: boolean
}): boolean {
  if (source === 'cc') return settings.enableClaudeCode
  if (source === 'codex') return settings.enableCodex
  if (source === 'cursor') return settings.enableCursor
  return true
}
