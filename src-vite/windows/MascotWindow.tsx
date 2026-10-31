/**
 * MascotWindow —— 看板娘窗口（透明置顶）
 * 左键点击=开/关面板、拖动=移窗；右键=打开设置。
 * 联动 agent 状态驱动头顶徽标/表情，按设置播放完成/等待音。
 */

import { useEffect, useRef, useState } from 'react'
import { getCurrentWindow, LogicalPosition, LogicalSize } from '@tauri-apps/api/window'
import { invoke } from '@tauri-apps/api/core'
import Live2DMascotSwitcher from '@/features/live2d-mascot/Live2DMascotSwitcher'
import {
  startSessionMonitor,
  aggregatePetState,
  isSourceEnabled,
  type PetState,
  type ClaudeSession,
} from '@/features/agent-monitor/agentMonitor'
import {
  restoreMascotPosition,
  saveMascotPosition,
  snapMascotToNearestEdge,
  startDragging,
  positionCompletionIfVisible,
  positionCompletionNearMascot,
  hideChatInput,
  hideChatHistory,
  positionChatInputNearMascot,
  positionChatHistoryIfVisible,
  positionPanelIfVisible,
} from './windowManager'
import {
  requestTogglePanel,
  requestShowCompletion,
  loadSettings,
  onSettingsChanged,
  type AppSettings,
} from '@/shared/appStore'
import { playCompletionSound, playWaitingSound } from '@/shared/notify'
import { onModelChatBusyChanged } from '@/features/model-chat/modelChatStore'
import type { MascotPetState } from '@/features/live2d-mascot/Live2DMascot'
import { runAppCleanup } from '@/shared/maintenance'
import { checkForUpdates } from '@/shared/updateChecker'

const CLICK_THRESHOLD_PX = 5
const CLICK_TIME_MS = 350

const VIEWPORT_W = 210
const VIEWPORT_H = 430

function clampScale(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return 1
  return Math.min(1.5, Math.max(0.5, n))
}

function windowSizeForScale(scale: number) {
  return {
    width: Math.round(VIEWPORT_W * scale),
    height: Math.round(VIEWPORT_H * scale),
  }
}

function isWaiting(s: ClaudeSession): boolean {
  return s.status === 'waiting'
}

export default function MascotWindow() {
  const [modelId, setModelId] = useState<string | undefined>(undefined)
  const [scale, setScale] = useState(1)
  const [debugBorder, setDebugBorder] = useState(false)
  const mascotSize = windowSizeForScale(scale)
  const [petState, setPetState] = useState<PetState>('idle')
  const [chatBusy, setChatBusy] = useState(false)
  const downRef = useRef<{ x: number; y: number; t: number; dragging: boolean } | null>(null)
  const settingsRef = useRef<AppSettings | null>(null)
  const waitingSeenRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    restoreMascotPosition().catch(() => {})
    loadSettings()
      .then((s: AppSettings) => {
        settingsRef.current = s
        setModelId(s.live2dModelId)
        setScale(clampScale(s.live2dScale))
        setDebugBorder(s.debugBorder)
        runAppCleanup(s).catch((e) => console.warn('[cleanup] automatic cleanup failed', e))
        if (s.autoCheckUpdates) {
          checkForUpdates().catch((e) => console.warn('[updates] automatic check failed', e))
        }
        if (s.modelChatEnabled) positionChatInputNearMascot().catch(() => {})
        else hideChatInput().catch(() => {})
      })
      .catch(() => {})
    let un: (() => void) | undefined
    let disposed = false
    onSettingsChanged((s) => {
      settingsRef.current = s
      setModelId(s.live2dModelId)
      setScale(clampScale(s.live2dScale))
      setDebugBorder(s.debugBorder)
      if (s.autoCheckUpdates) {
        checkForUpdates().catch((e) => console.warn('[updates] automatic check failed', e))
      }
      if (s.modelChatEnabled) positionChatInputNearMascot().catch(() => {})
      else hideChatInput().catch(() => {})
    }).then((u) => disposed ? u() : (un = u))
    return () => {
      disposed = true
      un?.()
    }
  }, [])

  useEffect(() => {
    const win = getCurrentWindow()
    void (async () => {
      try {
        const nextSize = windowSizeForScale(scale)
        const [size, pos, sf] = await Promise.all([
          win.outerSize(),
          win.outerPosition(),
          win.scaleFactor(),
        ])
        const curW = Math.round(size.width / sf)
        const curH = Math.round(size.height / sf)
        if (curW === nextSize.width && curH === nextSize.height) return
        const curX = pos.x / sf
        const curY = pos.y / sf
        const nextX = curX + (curW - nextSize.width) / 2
        const nextY = curY + (curH - nextSize.height)
        await win.setSize(new LogicalSize(nextSize.width, nextSize.height))
        await win.setPosition(new LogicalPosition(Math.round(nextX), Math.round(nextY)))
        await saveMascotPosition()
        const s = settingsRef.current
        if (s?.modelChatEnabled) {
          await positionChatInputNearMascot()
          await positionChatHistoryIfVisible()
        }
      } catch {
        /* 取尺寸/设尺寸失败时静默（窗口可能尚未就绪） */
      }
    })()
  }, [scale])

  useEffect(() => {
    const win = getCurrentWindow()
    let timer: number | undefined
    const syncAttachedWindows = () => {
      if (timer !== undefined) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
      positionPanelIfVisible().catch(() => {})
      positionCompletionIfVisible().catch(() => {})
      const s = settingsRef.current
      if (!s?.modelChatEnabled) return
      positionChatInputNearMascot().catch(() => {})
      positionChatHistoryIfVisible().catch(() => {})
      }, 50)
    }
    const unlisten = [win.onMoved(syncAttachedWindows), win.onResized(syncAttachedWindows)]
    syncAttachedWindows()
    return () => {
      if (timer !== undefined) window.clearTimeout(timer)
      for (const pending of unlisten) pending.then((un) => un()).catch(() => {})
    }
  }, [])

  useEffect(() => {
    let un: (() => void) | undefined
    let disposed = false
    onModelChatBusyChanged(setChatBusy).then((u) => disposed ? u() : (un = u))
    return () => {
      disposed = true
      un?.()
    }
  }, [])

  useEffect(() => {
    const stop = startSessionMonitor({
      onSessions: (sessions) => {
        const s = settingsRef.current
        const enabledSessions = s ? sessions.filter((session) => isSourceEnabled(session.source, s)) : sessions
        setPetState(aggregatePetState(enabledSessions))

        const seen = waitingSeenRef.current
        const aliveWaiting = new Set<string>()
        for (const sess of enabledSessions) {
          if (isWaiting(sess)) {
            aliveWaiting.add(sess.sessionId)
            if (!seen.has(sess.sessionId)) {
              seen.add(sess.sessionId)
              if (s) playWaitingSound(s)
            }
          }
        }
        for (const id of Array.from(seen)) {
          if (!aliveWaiting.has(id)) seen.delete(id)
        }
      },
      onComplete: (session) => {
        const s = settingsRef.current
        if (s && !isSourceEnabled(session.source, s)) return
        if (s) playCompletionSound(session.source, s)
        const completionInfo = {
          sessionId: session.sessionId,
          source: session.source,
          cwd: session.cwd,
          lastResponse: session.lastResponse,
          taskDurationMs: session.taskDurationMs,
          waitingDurationMs: session.waitingDurationMs,
          autoClose: s ? s.autoCloseCompletion : true,
          autoCloseMs: s ? s.autoCloseCompletionSec * 1000 : 5000,
        }
        requestShowCompletion(completionInfo)
          .then(() => positionCompletionNearMascot())
          .catch((e) => console.warn('[completion] request failed', e))
      },
    })
    return stop
  }, [])

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    downRef.current = { x: e.screenX, y: e.screenY, t: Date.now(), dragging: false }
  }

  const onMouseMove = (e: React.MouseEvent) => {
    const d = downRef.current
    if (!d || d.dragging) return
    const moved = Math.hypot(e.screenX - d.x, e.screenY - d.y)
    if (moved > CLICK_THRESHOLD_PX) {
      d.dragging = true
      hideChatHistory().catch(() => {})
      startDragging().catch(() => {})
    }
  }

  const onMouseUp = () => {
    const d = downRef.current
    downRef.current = null
    if (!d) return
    if (d.dragging) {
      setTimeout(() => {
        const s = settingsRef.current
        const save = s?.dockEnabled
          ? snapMascotToNearestEdge(s.dockThreshold).then(async (snapped) => {
              if (!snapped) await saveMascotPosition()
            })
          : saveMascotPosition()
        save.catch(() => {})
        if (s?.modelChatEnabled) {
          positionChatInputNearMascot().catch(() => {})
        }
      }, 120)
      return
    }
    const elapsed = Date.now() - d.t
    if (elapsed <= CLICK_TIME_MS) {
      requestTogglePanel().catch(() => {})
    }
  }

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    invoke('open_settings_window').catch(() => {})
  }

  const displayPetState: MascotPetState = chatBusy ? 'chatting' : petState

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        cursor: 'pointer',
        boxSizing: 'border-box',
        border: debugBorder ? '2px solid rgba(255, 48, 96, 0.9)' : 'none',
        boxShadow: debugBorder ? 'inset 0 0 0 1px rgba(255, 255, 255, 0.8)' : 'none',
      }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onContextMenu={onContextMenu}
    >
      <Live2DMascotSwitcher
        key={modelId ?? 'default'}
        showPicker={false}
        initialModelId={modelId}
        petState={displayPetState}
        width={mascotSize.width}
        height={mascotSize.height}
        stageScale={scale}
      />
    </div>
  )
}
