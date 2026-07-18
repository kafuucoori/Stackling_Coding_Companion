// utils.ts —— info-panel 内部小工具

import type { ClaudeSession } from '@/features/agent-monitor/agentMonitor'

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

export function projectNameOf(cwd: string): string {
  if (!cwd) return '未知项目'
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || cwd
}

export type SessionDisplayState = 'waiting' | 'working' | 'compacting' | 'done' | 'idle'

export function displayStateOf(s: ClaudeSession): SessionDisplayState {
  switch (s.status) {
    case 'waiting':
      return 'waiting'
    case 'processing':
    case 'tool_running':
      return 'working'
    case 'compacting':
      return 'compacting'
    case 'stopped':
      return s.lastResponse ? 'done' : 'idle'
    default:
      return 'idle'
  }
}

export function sessionSortRank(s: ClaudeSession): number {
  switch (displayStateOf(s)) {
    case 'waiting':
      return 0
    case 'done':
      return 1
    case 'working':
    case 'compacting':
      return 2
    default:
      return 3
  }
}

export function sourceLabel(source: string): string {
  switch (source) {
    case 'codex':
      return 'Codex'
    case 'cursor':
      return 'Cursor'
    default:
      return 'Claude Code'
  }
}
