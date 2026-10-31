// settingsStore.ts —— 设置读写（Tauri Store / settings.json，autoSave）。
// 与 agent-monitor / info-panel 共用同一份 settings.json；autostart 另调 plugin-autostart 注册。

import { load } from '@tauri-apps/plugin-store'
import { invoke } from '@tauri-apps/api/core'
import {
  enable as enableAutostart,
  disable as disableAutostart,
  isEnabled as isAutostartEnabled,
} from '@tauri-apps/plugin-autostart'
import type { ThemeName } from '@/features/info-panel/theme'

export interface AppSettings {
  enableClaudeCode: boolean
  enableCodex: boolean
  enableCursor: boolean
  theme: ThemeName
  live2dModelId: string
  live2dScale: number
  dockEnabled: boolean
  dockThreshold: number
  ccSoundEnabled: boolean
  codexSoundEnabled: boolean
  cursorSoundEnabled: boolean
  waitingSound: boolean
  autoCloseCompletion: boolean
  autoCloseCompletionSec: number
  debugBorder: boolean
  modelChatEnabled: boolean
  modelChatProviderUrl: string
  modelChatApiKey: string
  modelChatModel: string
  modelChatSystemPrompt: string
  modelChatContextLimit: number
  modelChatAutoSummary: boolean
  autoCleanupEnabled: boolean
  completionHistoryRetentionDays: number
  modelChatRetentionDays: number
  maxCompletionHistory: number
  autoCheckUpdates: boolean
  autostart: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  enableClaudeCode: true,
  enableCodex: true,
  enableCursor: true,
  theme: 'pink',
  live2dModelId: 'moran-hanfu',
  live2dScale: 1.0,
  dockEnabled: true,
  dockThreshold: 25,
  ccSoundEnabled: true,
  codexSoundEnabled: true,
  cursorSoundEnabled: true,
  waitingSound: true,
  autoCloseCompletion: true,
  autoCloseCompletionSec: 5,
  debugBorder: false,
  modelChatEnabled: true,
  modelChatProviderUrl: '',
  modelChatApiKey: '',
  modelChatModel: '',
  modelChatSystemPrompt: '你是用户桌面上的 Live2D 看板娘“墨墨”。回答要简洁、亲切，优先帮助用户完成当前问题。',
  modelChatContextLimit: 20,
  modelChatAutoSummary: true,
  autoCleanupEnabled: true,
  completionHistoryRetentionDays: 30,
  modelChatRetentionDays: 90,
  maxCompletionHistory: 30,
  autoCheckUpdates: true,
  autostart: false,
}

type StoredSettingKey = Exclude<keyof AppSettings, 'modelChatApiKey'>

const KEY: Record<StoredSettingKey, string> = {
  enableClaudeCode: 'enable_claudecode',
  enableCodex: 'enable_codex',
  enableCursor: 'enable_cursor',
  theme: 'theme',
  live2dModelId: 'live2d_model_id',
  live2dScale: 'live2d_scale',
  dockEnabled: 'dock_enabled',
  dockThreshold: 'dock_threshold',
  ccSoundEnabled: 'sound_enabled',
  codexSoundEnabled: 'codex_sound_enabled',
  cursorSoundEnabled: 'cursor_sound_enabled',
  waitingSound: 'waiting_sound',
  autoCloseCompletion: 'auto_close_completion',
  autoCloseCompletionSec: 'auto_close_completion_sec',
  debugBorder: 'debug_border',
  modelChatEnabled: 'model_chat_enabled',
  modelChatProviderUrl: 'model_chat_provider_url',
  modelChatModel: 'model_chat_model',
  modelChatSystemPrompt: 'model_chat_system_prompt',
  modelChatContextLimit: 'model_chat_context_limit',
  modelChatAutoSummary: 'model_chat_auto_summary',
  autoCleanupEnabled: 'auto_cleanup_enabled',
  completionHistoryRetentionDays: 'completion_history_retention_days',
  modelChatRetentionDays: 'model_chat_retention_days',
  maxCompletionHistory: 'max_completion_history',
  autoCheckUpdates: 'auto_check_updates',
  autostart: 'enable_autostart',
}

async function store() {
  return load('settings.json', { defaults: {}, autoSave: true })
}

export async function loadSettings(): Promise<AppSettings> {
  const s = await store()
  const out = { ...DEFAULT_SETTINGS }
  for (const k of Object.keys(KEY) as StoredSettingKey[]) {
    const v = await s.get(KEY[k])
    if (v !== undefined && v !== null) {
      ;(out as Record<string, unknown>)[k] = v
    }
  }
  try {
    out.modelChatApiKey = await invoke<string>('get_model_chat_api_key')
  } catch {
    /* 非 Tauri 环境忽略 */
  }
  try {
    out.autostart = await isAutostartEnabled()
  } catch {
    /* 非 Tauri 环境忽略 */
  }
  return out
}

export async function setSetting<K extends keyof AppSettings>(
  key: K,
  value: AppSettings[K],
): Promise<void> {
  if (key === 'modelChatApiKey') {
    await invoke('set_model_chat_api_key', { apiKey: value })
    return
  }
  const s = await store()
  await s.set(KEY[key as StoredSettingKey], value)
  await s.save()
}

export async function setAutostart(on: boolean): Promise<void> {
  if (on) await enableAutostart()
  else await disableAutostart()
  await setSetting('autostart', on)
}
