import { useEffect, useMemo, useState } from 'react'
import {
  clearCompletionHistory,
  loadCompletionHistory,
  onCompletionHistoryChanged,
  type CompletionHistoryEntry,
} from '@/shared/appStore'
import { sourceLabel } from './utils'
import { useTheme } from './theme'
import css from './theme.module.css'

function formatDuration(ms?: number | null): string {
  if (!ms || ms < 1000) return '—'
  const minutes = Math.floor(ms / 60000)
  const seconds = Math.round((ms % 60000) / 1000)
  return minutes ? `${minutes}分${seconds}秒` : `${seconds}秒`
}

export default function CompletionHistoryView() {
  const { theme } = useTheme()
  const [entries, setEntries] = useState<CompletionHistoryEntry[]>([])
  const refresh = () => loadCompletionHistory().then(setEntries).catch(() => {})

  useEffect(() => {
    refresh()
    let unlisten: (() => void) | undefined
    let disposed = false
    onCompletionHistoryChanged(refresh).then((un) => disposed ? un() : (unlisten = un))
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  const summary = useMemo(() => {
    const timed = entries.filter((entry) => (entry.taskDurationMs ?? 0) > 0)
    const total = timed.reduce((sum, entry) => sum + (entry.taskDurationMs ?? 0), 0)
    const waiting = timed.reduce((sum, entry) => sum + (entry.waitingDurationMs ?? 0), 0)
    return {
      average: timed.length ? total / timed.length : 0,
      waiting,
    }
  }, [entries])

  return (
    <div className={css.scrollbarThin} style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, padding: 12 }}>
        {[
          ['已完成', `${entries.length} 项`],
          ['平均耗时', formatDuration(summary.average)],
          ['等待授权', formatDuration(summary.waiting)],
        ].map(([label, value]) => (
          <div key={label} style={{ padding: 8, borderRadius: 9, background: theme.surface }}>
            <div style={{ fontSize: 10, color: theme.textDim }}>{label}</div>
            <div style={{ marginTop: 3, fontSize: 13, fontWeight: 600, color: theme.text }}>{value}</div>
          </div>
        ))}
      </div>
      {entries.length > 0 && (
        <div style={{ padding: '0 12px 8px', textAlign: 'right' }}>
          <button
            onClick={() => clearCompletionHistory().catch(() => {})}
            style={{ border: 0, background: 'transparent', color: theme.textDim, cursor: 'pointer', fontSize: 11 }}
          >
            清空记录
          </button>
        </div>
      )}
      {entries.length === 0 && <div style={{ padding: 24, textAlign: 'center', color: theme.textDim, fontSize: 12 }}>暂无完成记录</div>}
      {entries.map((entry) => {
        const project = entry.cwd.split(/[\\/]/).filter(Boolean).pop() || '未知项目'
        return (
          <div key={entry.id} style={{ padding: '9px 14px', borderTop: `1px solid ${theme.border}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span style={{ fontSize: 11, color: theme.accent }}>{sourceLabel(entry.source)}</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: theme.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project}</span>
              <span style={{ marginLeft: 'auto', fontSize: 10, color: theme.textFaint }}>{new Date(entry.completedAt).toLocaleString('zh-CN')}</span>
            </div>
            <div style={{ marginTop: 4, fontSize: 11, color: theme.textDim }}>
              总耗时 {formatDuration(entry.taskDurationMs)} · 等待 {formatDuration(entry.waitingDurationMs)}
            </div>
            {entry.lastResponse && <div style={{ marginTop: 4, fontSize: 11, color: theme.textDim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.lastResponse}</div>}
          </div>
        )
      })}
    </div>
  )
}
