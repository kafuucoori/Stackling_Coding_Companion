/**
 * SettingsWindow —— 设置窗口。渲染 SettingsPanel；改动后广播 settings-changed，
 * 看板娘/面板实时跟进。✕ 关闭走 hide 而非销毁。
 */

import { useEffect, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import SettingsPanel from '@/features/settings/SettingsPanel'
import {
  broadcastSettingsChanged,
  loadSettings,
  type AppSettings,
} from '@/shared/appStore'
import type { ThemeName } from '@/features/info-panel/theme'

export default function SettingsWindow() {
  const [initialTheme, setInitialTheme] = useState<ThemeName>('pink')
  const [ready, setReady] = useState(false)

  useEffect(() => {
    loadSettings()
      .then((s) => {
        setInitialTheme(s.theme)
        setReady(true)
      })
      .catch(() => setReady(true))
  }, [])

  useEffect(() => {
    let unlisten: (() => void) | undefined
    let disposed = false
    const win = getCurrentWindow()
    win
      .onCloseRequested((e) => {
        e.preventDefault()
        win.hide().catch(() => {})
      })
      .then((u) => disposed ? u() : (unlisten = u))
      .catch(() => {})
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  if (!ready) return null

  return (
    <div style={{ width: '100vw', height: '100vh', overflow: 'hidden' }}>
      <SettingsPanel
        initialTheme={initialTheme}
        width="100%"
        height="100%"
        onSettingsChange={(s: AppSettings) => {
          broadcastSettingsChanged(s).catch(() => {})
        }}
      />
    </div>
  )
}
