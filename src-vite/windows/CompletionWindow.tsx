/**
 * CompletionWindow —— 任务完成提示窗（透明置顶小弹窗）。
 * listen('show-completion') → 定位到看板娘上方 → show → 按设置自动关。
 */

import { useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { ExternalLink, X } from 'lucide-react'
import {
  THEMES,
  themeCssVars,
  type ThemeName,
} from '@/features/info-panel/theme'
import { sourceLabel } from '@/features/info-panel/utils'
import {
  onShowCompletion,
  onSettingsChanged,
  loadSettings,
  loadPendingCompletion,
  clearPendingCompletion,
  type CompletionInfo,
} from '@/shared/appStore'
import { positionCompletionNearMascot, hideCompletion, resizeCompletionToContent } from './windowManager'
import {
  clearPendingUpdate,
  loadPendingUpdate,
  onUpdateAvailable,
  openLatestRelease,
  type UpdateInfo,
} from '@/shared/updateChecker'

const DEFAULT_AUTO_CLOSE_MS = 5000

function formatDuration(ms?: number | null): string {
  if (!ms || ms < 1000) return ''
  const minutes = Math.floor(ms / 60000)
  const seconds = Math.round((ms % 60000) / 1000)
  return minutes > 0 ? `${minutes}分${seconds}秒` : `${seconds}秒`
}

export default function CompletionWindow() {
  const [theme, setTheme] = useState<ThemeName>('pink')
  const [info, setInfo] = useState<CompletionInfo | null>(null)
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const closeTimer = useRef<number | undefined>(undefined)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)

  const showInfo = (next: CompletionInfo) => {
    flushSync(() => {
      setUpdateInfo(null)
      setInfo(next)
    })
    void (async () => {
      const cardHeight = cardRef.current?.getBoundingClientRect().height
      const h = cardHeight ? cardHeight + 12 : rootRef.current?.getBoundingClientRect().height
      try {
        if (h) await resizeCompletionToContent(h)
      } catch (e) {
        console.warn('[completion] resize failed', e)
      }
      try {
        await positionCompletionNearMascot()
      } catch (e) {
        console.warn('[completion] show failed', e)
      }
    })()
    window.clearTimeout(closeTimer.current)
    if (next.autoClose) {
      const ms = next.autoCloseMs ?? DEFAULT_AUTO_CLOSE_MS
      closeTimer.current = window.setTimeout(() => {
        hideCompletion().then(clearPendingCompletion).catch(() => {})
      }, ms)
    }
  }

  const showUpdate = (next: UpdateInfo) => {
    flushSync(() => {
      setInfo(null)
      setUpdateInfo(next)
    })
    window.clearTimeout(closeTimer.current)
    void (async () => {
      const cardHeight = cardRef.current?.getBoundingClientRect().height
      const h = cardHeight ? cardHeight + 12 : rootRef.current?.getBoundingClientRect().height
      try {
        if (h) await resizeCompletionToContent(h)
        await positionCompletionNearMascot()
      } catch (e) {
        console.warn('[updates] show notification failed', e)
      }
    })()
  }

  useEffect(() => {
    loadSettings().then((s) => setTheme(s.theme)).catch(() => {})
    loadPendingCompletion()
      .then((pending) => {
        if (pending) showInfo(pending)
      })
      .catch(() => {})
    loadPendingUpdate()
      .then((pending) => {
        if (pending) showUpdate(pending)
      })
      .catch(() => {})

    const uns: (() => void)[] = []
    let disposed = false
    const add = (pending: Promise<() => void>) => pending
      .then((unlisten) => disposed ? unlisten() : uns.push(unlisten))
      .catch(() => {})
    add(onSettingsChanged((s) => setTheme(s.theme)))

    add(onShowCompletion((next) => {
      showInfo(next)
    }))
    add(onUpdateAvailable(showUpdate))

    return () => {
      disposed = true
      uns.forEach((u) => u())
      window.clearTimeout(closeTimer.current)
    }
  }, [])

  const close = () => {
    window.clearTimeout(closeTimer.current)
    hideCompletion()
      .then(() => Promise.all([clearPendingCompletion(), clearPendingUpdate()]))
      .catch(() => {})
  }

  const t = THEMES[theme]
  const project = info?.cwd ? info.cwd.split(/[\\/]/).filter(Boolean).pop() : ''
  const reply = updateInfo
    ? `当前版本 v${updateInfo.currentVersion}，GitHub 已发布 v${updateInfo.latestVersion}。`
    : (info?.lastResponse ?? '').trim()
  const duration = formatDuration(info?.taskDurationMs)

  return (
    <div
      ref={rootRef}
      style={{
        ...themeCssVars(t),
        width: '100%',
        display: 'flex',
        padding: 6,
        boxSizing: 'border-box',
        overflow: 'hidden',
      }}
    >
      <div
        ref={cardRef}
        style={{
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          padding: '10px 14px',
          background: t.bg,
          color: t.text,
          border: `1px solid ${t.border}`,
          borderRadius: 14,
          boxShadow: `inset 0 0 0 1px ${t.border}`,
          overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              padding: '2px 8px',
              borderRadius: 999,
              background: t.accent,
              color: '#fff',
              whiteSpace: 'nowrap',
            }}
          >
            {updateInfo ? '更新' : info ? sourceLabel(info.source) : ''}
          </span>
          <span style={{ fontSize: 13, fontWeight: 600, color: t.text }}>
            {updateInfo ? '✨ 发现新版本' : '✅ 任务完成'}
          </span>
          {duration && <span style={{ fontSize: 11, color: t.textDim }}>{duration}</span>}
          {project && (
            <span
              style={{
                fontSize: 11,
                color: t.textDim,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                minWidth: 0,
              }}
            >
              {project}
            </span>
          )}
          <button
            onClick={close}
            title="关闭"
            style={{
              marginLeft: 'auto',
              width: 20,
              height: 20,
              borderRadius: '50%',
              border: 'none',
              background: 'rgba(0,0,0,0.08)',
              color: 'inherit',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <X style={{ width: 12, height: 12 }} />
          </button>
        </div>

        {reply && (
          <div
            style={{
              fontSize: 12,
              lineHeight: 1.5,
              color: t.textDim,
              display: '-webkit-box',
              WebkitLineClamp: 3,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {reply}
          </div>
        )}
        {updateInfo && (
          <button
            onClick={() => openLatestRelease().catch((e) => console.warn('[updates] open release failed', e))}
            style={{
              alignSelf: 'flex-start',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              padding: '5px 10px',
              border: 'none',
              borderRadius: 8,
              background: t.accent,
              color: '#fff',
              fontSize: 11,
              cursor: 'pointer',
            }}
          >
            前往 GitHub 下载
            <ExternalLink style={{ width: 12, height: 12 }} />
          </button>
        )}
      </div>
    </div>
  )
}
