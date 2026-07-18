import { invoke } from '@tauri-apps/api/core'
import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event'
import { openUrl } from '@tauri-apps/plugin-opener'
import { load } from '@tauri-apps/plugin-store'

const UPDATE_AVAILABLE = 'stackling-update-available'
const LAST_CHECKED_AT_KEY = 'last_update_check_at'
const LAST_NOTIFIED_VERSION_KEY = 'last_notified_update_version'
const PENDING_UPDATE_KEY = 'pending_update'
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

export const RELEASES_URL =
  'https://github.com/kafuucoori/Stackling_Coding_Companion/releases/latest'

export interface UpdateInfo {
  currentVersion: string
  latestVersion: string
  updateAvailable: boolean
  releaseName: string
  releaseUrl: string
  publishedAt?: string | null
}

async function updateStore() {
  return load('settings.json', { defaults: {}, autoSave: true })
}

export async function checkForUpdates(
  force = false,
  notifyWhenAvailable = true,
): Promise<UpdateInfo | null> {
  const store = await updateStore()
  const lastCheckedAt = (await store.get<number>(LAST_CHECKED_AT_KEY)) ?? 0
  if (!force && Date.now() - lastCheckedAt < CHECK_INTERVAL_MS) return null

  const info = await invoke<UpdateInfo>('check_for_updates')
  await store.set(LAST_CHECKED_AT_KEY, Date.now())

  if (info.updateAvailable && notifyWhenAvailable) {
    const lastNotifiedVersion = await store.get<string>(LAST_NOTIFIED_VERSION_KEY)
    if (lastNotifiedVersion !== info.latestVersion) {
      await store.set(LAST_NOTIFIED_VERSION_KEY, info.latestVersion)
      await store.set(PENDING_UPDATE_KEY, info)
      await store.save()
      await emit(UPDATE_AVAILABLE, info)
      return info
    }
  }

  await store.save()
  return info
}

export async function loadPendingUpdate(): Promise<UpdateInfo | null> {
  const store = await updateStore()
  return (await store.get<UpdateInfo>(PENDING_UPDATE_KEY)) ?? null
}

export async function clearPendingUpdate(): Promise<void> {
  const store = await updateStore()
  await store.delete(PENDING_UPDATE_KEY)
  await store.save()
}

export function onUpdateAvailable(cb: (info: UpdateInfo) => void): Promise<UnlistenFn> {
  return listen<UpdateInfo>(UPDATE_AVAILABLE, (event) => cb(event.payload))
}

export function openLatestRelease(): Promise<void> {
  return openUrl(RELEASES_URL)
}
