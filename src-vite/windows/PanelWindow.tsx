/**
 * PanelWindow —— 信息面板窗口（透明置顶）。
 * 看板娘点击切换显隐（智能选位），失焦自动隐藏；主题/源开关随设置更新。
 */

import { useEffect, useRef, useState } from 'react'
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window'
import { X } from 'lucide-react'
import InfoPanel from '@/features/info-panel/InfoPanel'
import type { SourceToggles } from '@/features/info-panel/SessionList'
import type { ThemeName } from '@/features/info-panel/theme'
import { positionPanelNearMascot, hidePanel, isPanelVisible } from './windowManager'
import {
  onTogglePanel,
  onSettingsChanged,
  loadSettings,
  type AppSettings,
} from '@/shared/appStore'

const PANEL_W = 360
const PANEL_MAX_H = 340

function toToggles(s: AppSettings): SourceToggles {
  return {
    cc: s.enableClaudeCode,
    codex: s.enableCodex,
    cursor: s.enableCursor,
  }
}

export default function PanelWindow() {
  const [theme, setTheme] = useState<ThemeName>('pink')
  const [enabled, setEnabled] = useState<SourceToggles>({})
  const justShownRef = useRef(0)
  const visibleRef = useRef(false)

  useEffect(() => {
    loadSettings()
      .then((s) => {
        setTheme(s.theme)
        setEnabled(toToggles(s))
      })
      .catch(() => {})

    const uns: (() => void)[] = []
    let disposed = false
    const add = (pending: Promise<() => void>) => pending
      .then((unlisten) => disposed ? unlisten() : uns.push(unlisten))
      .catch(() => {})
    add(onSettingsChanged((s) => {
      setTheme(s.theme)
      setEnabled(toToggles(s))
    }))

    add(onTogglePanel(async () => {
      try {
        if (await isPanelVisible()) {
          await hidePanel()
          visibleRef.current = false
        } else {
          await positionPanelNearMascot()
          visibleRef.current = true
          justShownRef.current = Date.now()
        }
      } catch (e) {
        console.error('[panel] toggle failed', e)
      }
    }))

    const win = getCurrentWindow()
    add(win.onFocusChanged(({ payload: focused }) => {
        if (!focused && Date.now() - justShownRef.current > 400) {
          hidePanel().catch(() => {})
          visibleRef.current = false
        }
      }))

    return () => {
      disposed = true
      uns.forEach((u) => u())
    }
  }, [])

  const handleContentResize = (h: number) => {
    const win = getCurrentWindow()
    win
      .setSize(new LogicalSize(PANEL_W, h))
      .then(() => {
        if (visibleRef.current) return positionPanelNearMascot()
      })
      .catch(() => {})
  }

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}>
      <InfoPanel
        initialTheme={theme}
        enabledSources={enabled}
        width="100%"
        maxHeight={PANEL_MAX_H}
        onContentResize={handleContentResize}
      />
      <button
        onClick={() => hidePanel().catch(() => {})}
        title="关闭"
        style={{
          position: 'absolute',
          top: 8,
          right: 10,
          width: 22,
          height: 22,
          borderRadius: '50%',
          border: 'none',
          background: 'rgba(0,0,0,0.08)',
          color: 'inherit',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 50,
        }}
      >
        <X style={{ width: 14, height: 14 }} />
      </button>
    </div>
  )
}
