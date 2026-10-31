// notify.ts —— 完成 / 等待提示音。完成固定“叮”，等待固定“咚”。
// 每次播放新建 Audio 实例，允许重叠。

import type { AppSettings } from '@/features/settings/settingsStore'
import type { AgentSource } from '@/features/agent-monitor/agentMonitor'

const COMPLETION_SOUND = '/audio/ding.wav'
const WAITING_SOUND = '/audio/dong.wav'

function play(src: string, volume = 0.8) {
  try {
    const a = new Audio(src)
    a.volume = volume
    void a.play().catch(() => {})
  } catch {
    /* 非浏览器环境忽略 */
  }
}

function sourceSoundEnabled(source: AgentSource | string, s: AppSettings): boolean {
  switch (source) {
    case 'codex':
      return s.codexSoundEnabled
    case 'cursor':
      return s.cursorSoundEnabled
    default:
      return s.ccSoundEnabled
  }
}

export function playCompletionSound(source: AgentSource | string, s: AppSettings): void {
  if (!sourceSoundEnabled(source, s)) return
  play(COMPLETION_SOUND)
}

export function playWaitingSound(s: AppSettings): void {
  if (!s.waitingSound) return
  play(WAITING_SOUND, 0.55)
}
