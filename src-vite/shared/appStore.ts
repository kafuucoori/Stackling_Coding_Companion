// appStore.ts —— 跨窗口同步：settings.json（持久化真相源）+ Tauri 事件（改动后广播刷新）。
// 各窗口是独立 webview 不共享 JS 内存，故靠这两条腿同步。复用 settings/settingsStore。

import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event'
import { load } from '@tauri-apps/plugin-store'
import {
  loadSettings,
  type AppSettings,
} from '@/features/settings/settingsStore'

export type { AppSettings }

export const SETTINGS_CHANGED = 'settings-changed'
export const TOGGLE_PANEL = 'toggle-panel'
export const SHOW_COMPLETION = 'show-completion'
const PENDING_COMPLETION_KEY = 'pending_completion'
const PENDING_COMPLETION_TTL_MS = 30_000
const COMPLETION_HISTORY_KEY = 'completion_history'
const COMPLETION_HISTORY_CHANGED = 'completion-history-changed'
const MAX_COMPLETION_HISTORY = 500

export interface CompletionInfo {
  sessionId: string
  source: string
  cwd: string
  lastResponse?: string | null
  taskDurationMs?: number | null
  waitingDurationMs?: number | null
  autoClose: boolean
  autoCloseMs?: number
}

interface PendingCompletionInfo extends CompletionInfo {
  createdAt: number
}

export interface CompletionHistoryEntry extends CompletionInfo {
  id: string
  completedAt: number
}

async function appStore() {
  return load('settings.json', { defaults: {}, autoSave: true })
}

async function activityStore() {
  return load('activity.json', { defaults: {}, autoSave: true })
}

export async function requestShowCompletion(info: CompletionInfo): Promise<void> {
  const s = await appStore()
  await s.set(PENDING_COMPLETION_KEY, { ...info, createdAt: Date.now() })
  await s.save()
  const activity = await activityStore()
  const current = await activity.get<CompletionHistoryEntry[]>(COMPLETION_HISTORY_KEY)
  const completedAt = Date.now()
  const next = [
    ...(Array.isArray(current) ? current : []),
    { ...info, id: `${completedAt.toString(36)}-${info.sessionId}`, completedAt },
  ].sort((a, b) => a.completedAt - b.completedAt).slice(-MAX_COMPLETION_HISTORY)
  await activity.set(COMPLETION_HISTORY_KEY, next)
  await activity.save()
  await emit(COMPLETION_HISTORY_CHANGED)
  await emit(SHOW_COMPLETION, info)
}

export async function loadCompletionHistory(): Promise<CompletionHistoryEntry[]> {
  const activity = await activityStore()
  const entries = await activity.get<CompletionHistoryEntry[]>(COMPLETION_HISTORY_KEY)
  return Array.isArray(entries) ? entries.slice().sort((a, b) => b.completedAt - a.completedAt) : []
}

export async function replaceCompletionHistory(entries: CompletionHistoryEntry[]): Promise<void> {
  const activity = await activityStore()
  const ordered = entries.slice().sort((a, b) => a.completedAt - b.completedAt)
  await activity.set(COMPLETION_HISTORY_KEY, ordered.slice(-MAX_COMPLETION_HISTORY))
  await activity.save()
  await emit(COMPLETION_HISTORY_CHANGED)
}

export async function clearCompletionHistory(): Promise<void> {
  await replaceCompletionHistory([])
}

export function onCompletionHistoryChanged(cb: () => void): Promise<UnlistenFn> {
  return listen(COMPLETION_HISTORY_CHANGED, cb)
}

export async function loadPendingCompletion(): Promise<CompletionInfo | null> {
  const s = await appStore()
  const pending = await s.get<PendingCompletionInfo>(PENDING_COMPLETION_KEY)
  if (!pending || Date.now() - pending.createdAt > PENDING_COMPLETION_TTL_MS) {
    if (pending) {
      await s.delete(PENDING_COMPLETION_KEY)
      await s.save()
    }
    return null
  }
  const { createdAt: _createdAt, ...info } = pending
  return info
}

export async function clearPendingCompletion(): Promise<void> {
  const s = await appStore()
  await s.delete(PENDING_COMPLETION_KEY)
  await s.save()
}

export function onShowCompletion(cb: (info: CompletionInfo) => void): Promise<UnlistenFn> {
  return listen<CompletionInfo>(SHOW_COMPLETION, (e) => cb(e.payload))
}

export async function broadcastSettingsChanged(settings: AppSettings): Promise<void> {
  await emit(SETTINGS_CHANGED, settings)
}

export function onSettingsChanged(cb: (s: AppSettings) => void): Promise<UnlistenFn> {
  return listen<AppSettings>(SETTINGS_CHANGED, (e) => cb(e.payload))
}

export async function requestTogglePanel(): Promise<void> {
  await emit(TOGGLE_PANEL)
}

export function onTogglePanel(cb: () => void): Promise<UnlistenFn> {
  return listen(TOGGLE_PANEL, () => cb())
}

export { loadSettings }
