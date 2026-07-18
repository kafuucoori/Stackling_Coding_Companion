import { load } from '@tauri-apps/plugin-store'
import { cleanupModelChatConversations } from '@/features/model-chat/modelChatStore'
import type { AppSettings } from '@/features/settings/settingsStore'
import { loadCompletionHistory, replaceCompletionHistory } from './appStore'

const LAST_CLEANUP_KEY = 'last_auto_cleanup_at'
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000

export interface CleanupResult {
  notificationsRemoved: number
  conversationsRemoved: number
  skipped: boolean
}

export async function runAppCleanup(settings: AppSettings, force = false): Promise<CleanupResult> {
  const state = await load('settings.json', { defaults: {}, autoSave: true })
  const lastCleanup = (await state.get<number>(LAST_CLEANUP_KEY)) ?? 0
  if (!force && (!settings.autoCleanupEnabled || Date.now() - lastCleanup < CLEANUP_INTERVAL_MS)) {
    return { notificationsRemoved: 0, conversationsRemoved: 0, skipped: true }
  }

  const history = await loadCompletionHistory()
  const cutoff = Date.now() - Math.max(1, settings.completionHistoryRetentionDays) * 24 * 60 * 60 * 1000
  const retained = history
    .filter((entry) => entry.completedAt >= cutoff)
    .slice(0, Math.max(10, settings.maxCompletionHistory))
  const notificationsRemoved = history.length - retained.length
  if (notificationsRemoved > 0) await replaceCompletionHistory(retained)

  const conversationsRemoved = await cleanupModelChatConversations(settings.modelChatRetentionDays)
  await state.set(LAST_CLEANUP_KEY, Date.now())
  await state.save()
  return { notificationsRemoved, conversationsRemoved, skipped: false }
}
