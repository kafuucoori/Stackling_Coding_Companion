/**
 * StatsView —— 近 14 天 token / 消息统计。主题驱动配色，纯 CSS flex 柱状图。
 */

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { motion } from 'motion/react'
import {
  getClaudeStats,
  type ClaudeStats,
  type ClaudeDailyStats,
  type AgentSource,
} from '@/features/agent-monitor/agentMonitor'
import { useTheme } from './theme'
import { formatTokens } from './utils'
import css from './theme.module.css'

type ChartMetric = 'tokens' | 'messages'

function DailyChart({ stats }: { stats: ClaudeDailyStats[] }) {
  const { theme } = useTheme()
  const [metric, setMetric] = useState<ChartMetric>('tokens')
  const isTokens = metric === 'tokens'
  const values = stats.map((d) =>
    isTokens
      ? d.input_tokens + d.output_tokens + d.cache_read_tokens + d.cache_write_tokens
      : d.messages,
  )
  const maxVal = Math.max(...values, 1)
  const chartH = 80

  const scale = isTokens && maxVal >= 1_000_000 ? 1_000_000 : isTokens && maxVal >= 1_000 ? 1_000 : 1
  const unitLabel = isTokens
    ? scale === 1_000_000
      ? 'M tokens'
      : scale === 1_000
        ? 'K tokens'
        : 'tokens'
    : '消息数'
  const fmtTick = (v: number) => {
    if (!isTokens) return String(v)
    const n = v / scale
    return n % 1 === 0 ? String(n) : n.toFixed(1)
  }
  const ticks = [maxVal, Math.round(maxVal / 2), 0]
  const todayVal = values[values.length - 1] ?? 0
  const today = new Date().toISOString().slice(0, 10)

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        background: theme.surface,
        border: `1px solid ${theme.border}`,
        borderRadius: 16,
        padding: 16,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span
          style={{
            fontSize: 10,
            fontWeight: 500,
            color: theme.textDim,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}
        >
          {isTokens ? '每日 Token' : '每日消息'}（近 14 天）
        </span>
        <div style={{ display: 'flex', background: theme.accentSoft, borderRadius: 6, padding: 2 }}>
          {(['tokens', 'messages'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMetric(m)}
              style={{
                fontSize: 10,
                padding: '2px 8px',
                borderRadius: 4,
                border: 'none',
                cursor: 'pointer',
                background: metric === m ? theme.accent : 'transparent',
                color: metric === m ? '#fff' : theme.textDim,
                fontWeight: metric === m ? 600 : 400,
              }}
            >
              {m === 'tokens' ? 'Token' : '消息'}
            </button>
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
        <span
          style={{
            fontSize: 12,
            fontWeight: 500,
            color: theme.accent,
            background: theme.accentSoft,
            padding: '2px 8px',
            borderRadius: 6,
          }}
        >
          今天 {isTokens ? formatTokens(todayVal) : `${todayVal} 条`}
        </span>
      </div>
      <div style={{ background: theme.accentSoft, borderRadius: 8, padding: 8, paddingTop: 4 }}>
        <div style={{ fontSize: 8, color: theme.textFaint, marginBottom: 2 }}>{unitLabel}</div>
        <div style={{ display: 'flex' }}>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
              paddingRight: 4,
              fontFamily: 'ui-monospace, monospace',
              width: 28,
              height: chartH,
            }}
          >
            {ticks.map((tk, i) => (
              <span
                key={i}
                style={{ fontSize: 8, color: theme.textFaint, textAlign: 'right', lineHeight: 1 }}
              >
                {fmtTick(tk)}
              </span>
            ))}
          </div>
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'flex-end',
              gap: 1,
              height: chartH,
              borderLeft: `1px solid ${theme.border}`,
              borderBottom: `1px solid ${theme.border}`,
              paddingLeft: 1,
            }}
          >
            {stats.map((d, i) => {
              const v = values[i]
              const h = Math.max(2, Math.round((v / maxVal) * (chartH - 6)))
              const isToday = d.date === today
              const tip = isTokens
                ? `${d.date}: ${formatTokens(v)}`
                : `${d.date}: ${v} 条`
              return (
                <div
                  key={d.date}
                  style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}
                  title={tip}
                >
                  <div
                    style={{
                      width: '100%',
                      borderTopLeftRadius: 2,
                      borderTopRightRadius: 2,
                      transition: 'all 0.3s',
                      height: h,
                      background: isToday
                        ? theme.accent
                        : v > 0
                          ? theme.accentSoft
                          : theme.border,
                    }}
                  />
                </div>
              )
            })}
          </div>
        </div>
        <div style={{ display: 'flex', marginTop: 4, paddingLeft: 32 }}>
          <div
            style={{
              flex: 1,
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: 8,
              color: theme.textFaint,
              fontFamily: 'ui-monospace, monospace',
            }}
          >
            <span>{stats[0]?.date.slice(5)}</span>
            <span>{stats[Math.floor(stats.length / 2)]?.date.slice(5)}</span>
            <span>{stats[stats.length - 1]?.date.slice(5)}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

interface StatsViewProps {
  source?: AgentSource
}

export default function StatsView({ source = 'cc' }: StatsViewProps) {
  const { theme } = useTheme()
  const [stats, setStats] = useState<ClaudeStats | null>(null)

  useEffect(() => {
    setStats(null)
    getClaudeStats(source)
      .then((s) => setStats(s))
      .catch(() => {})
  }, [source])

  if (!stats) {
    return (
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '96px 0',
          gap: 12,
        }}
      >
        <motion.div animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}>
          <Loader2 style={{ width: 20, height: 20, color: theme.textFaint }} />
        </motion.div>
        <span style={{ color: theme.textFaint, fontSize: 12, fontWeight: 500, letterSpacing: '0.02em' }}>
          加载中...
        </span>
      </div>
    )
  }

  const totalTokens =
    stats.totalInputTokens + stats.totalOutputTokens + stats.totalCacheReadTokens + stats.totalCacheWriteTokens
  const title = source === 'cursor' ? 'Cursor 统计' : source === 'codex' ? 'Codex 统计' : 'Claude Code 统计'

  if (source === 'cursor') {
    return (
      <div style={{ flex: 1, minHeight: 0, padding: 20, display: 'flex', flexDirection: 'column', gap: 24 }}>
        <h1 style={{ fontSize: 18, fontWeight: 600, color: theme.text, letterSpacing: '-0.01em', margin: 0 }}>
          {title}
        </h1>
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            textAlign: 'center',
            padding: '0 24px',
          }}
        >
          <span style={{ color: theme.textDim, fontSize: 14, fontWeight: 500 }}>Cursor 暂不支持详细统计</span>
          <span style={{ color: theme.textFaint, fontSize: 12, lineHeight: 1.6, maxWidth: 360 }}>
            Cursor 不向第三方工具暴露每次请求的 token 用量，无法在本地准确还原。请在 Cursor 应用内查看用量。
          </span>
        </div>
      </div>
    )
  }

  const totalCard = (label: string, value: string, sub: string) => (
    <div
      style={{
        background: theme.surface,
        border: `1px solid ${theme.border}`,
        borderRadius: 16,
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <span style={{ fontSize: 10, fontWeight: 500, color: theme.textDim, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </span>
      <span style={{ fontSize: 24, fontWeight: 600, color: theme.text, letterSpacing: '-0.01em', marginTop: 4 }}>
        {value}
      </span>
      <span style={{ fontSize: 12, color: theme.textDim }}>{sub}</span>
    </div>
  )

  return (
    <div
      className={css.scrollbarThin}
      style={{
        flex: 1,
        minHeight: 0,
        padding: 20,
        display: 'flex',
        flexDirection: 'column',
        gap: 24,
        overflowY: 'auto',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h1 style={{ fontSize: 18, fontWeight: 600, color: theme.text, letterSpacing: '-0.01em', margin: 0 }}>
          {title}
        </h1>
        <span style={{ fontSize: 12, color: theme.textDim }}>近 14 天</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {totalCard('总 Token', formatTokens(totalTokens), `${stats.totalSessions} 个会话`)}
        {totalCard('消息数', String(stats.totalMessages), 'AI 回复')}
      </div>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          background: theme.surface,
          border: `1px solid ${theme.border}`,
          borderRadius: 16,
          padding: 16,
        }}
      >
        <span style={{ fontSize: 10, fontWeight: 500, color: theme.textDim, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Token 明细
        </span>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, fontSize: 12, marginTop: 4 }}>
          {(
            [
              ['输入', stats.totalInputTokens],
              ['输出', stats.totalOutputTokens],
              ['缓存读', stats.totalCacheReadTokens],
              ['缓存写', stats.totalCacheWriteTokens],
            ] as [string, number][]
          ).map(([label, val]) => (
            <div key={label} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ color: theme.textDim, fontSize: 10 }}>{label}</span>
              <span style={{ color: theme.text, fontFamily: 'ui-monospace, monospace' }}>{formatTokens(val)}</span>
            </div>
          ))}
        </div>
      </div>

      {stats.dailyStats.length > 0 && <DailyChart stats={stats.dailyStats} />}
    </div>
  )
}
