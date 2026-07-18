/**
 * SettingsPanel —— 设置界面（连接 / 显示 / 提示音 / 系统）。
 * 必须被 ThemeProvider 包裹（与 info-panel 共用 context）。Tauri Store 持久化。
 */

import { useCallback, useEffect, useState } from 'react'
import { getVersion } from '@tauri-apps/api/app'
import { invoke } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'
import { Github } from 'lucide-react'
import {
  ThemeProvider,
  useTheme,
  THEME_ORDER,
  THEME_LABELS,
  THEMES,
  themeCssVars,
  type ThemeName,
} from '@/features/info-panel/theme'
import {
  loadLive2DModels,
  type Live2DModelEntry,
} from '@/features/live2d-mascot/live2dModels'
import {
  loadSettings,
  setSetting,
  setAutostart,
  DEFAULT_SETTINGS,
  type AppSettings,
} from './settingsStore'
import { sendModelChatMessage } from '@/features/model-chat/modelChatStore'
import { runAppCleanup } from '@/shared/maintenance'
import {
  checkForUpdates,
  openLatestRelease,
  type UpdateInfo,
} from '@/shared/updateChecker'
import Toggle from './Toggle'
import css from './settings.module.css'

const SCALE_OPTIONS = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5]
const GITHUB_URL = 'https://github.com/kafuucoori/Stackling_Coding_Companion'

interface HookHealth {
  source: 'cc' | 'codex' | 'cursor'
  installed: boolean
  configValid: boolean
  registered: boolean
  listenerReady: boolean
  healthy: boolean
  message: string
}

const HOOK_LABELS: Record<HookHealth['source'], string> = {
  cc: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
}

function snapScale(v: number): number {
  let best = SCALE_OPTIONS[0]
  let bestD = Infinity
  for (const o of SCALE_OPTIONS) {
    const d = Math.abs(o - v)
    if (d < bestD) {
      bestD = d
      best = o
    }
  }
  return best
}

interface SettingsPanelProps {
  onSettingsChange?: (settings: AppSettings) => void
  width?: number | string
  height?: number | string
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className={css.section}>
      <h2 className={css.sectionTitle}>{title}</h2>
      <div className={css.card}>{children}</div>
    </section>
  )
}
function Row({
  label,
  desc,
  children,
}: {
  label: string
  desc?: string
  children: React.ReactNode
}) {
  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <span className={css.rowLabel}>{label}</span>
        {desc && <span className={css.rowDesc}>{desc}</span>}
      </div>
      {children}
    </div>
  )
}

function SettingsInner({
  onSettingsChange,
  width = 380,
  height = 560,
}: SettingsPanelProps) {
  const { theme, setTheme } = useTheme()
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [models, setModels] = useState<Live2DModelEntry[]>([])
  const [chatTestHint, setChatTestHint] = useState<string | null>(null)
  const [hookHealth, setHookHealth] = useState<HookHealth[]>([])
  const [hookChecking, setHookChecking] = useState(false)
  const [cleanupHint, setCleanupHint] = useState<string | null>(null)
  const [appVersion, setAppVersion] = useState('')
  const [updateChecking, setUpdateChecking] = useState(false)
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [updateHint, setUpdateHint] = useState<string | null>(null)

  const checkHooks = useCallback(async () => {
    setHookChecking(true)
    try {
      setHookHealth(await invoke<HookHealth[]>('get_hook_health'))
    } catch (e) {
      console.warn('[hooks] health check failed', e)
    } finally {
      setHookChecking(false)
    }
  }, [])

  const repairHook = useCallback(async (source: HookHealth['source']) => {
    setHookChecking(true)
    try {
      await invoke('repair_hooks', { source })
      setHookHealth(await invoke<HookHealth[]>('get_hook_health'))
    } catch (e) {
      console.warn('[hooks] repair failed', e)
    } finally {
      setHookChecking(false)
    }
  }, [])

  useEffect(() => {
    loadSettings().then((s) => {
      setSettings(s)
      setTheme(s.theme)
    })
    loadLive2DModels().then(setModels).catch(() => {})
    getVersion().then(setAppVersion).catch(() => {})
    checkHooks()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkHooks])

  const update = useCallback(
    async <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
      setSettings((prev) => {
        const next = { ...prev, [key]: value }
        onSettingsChange?.(next)
        return next
      })
      await setSetting(key, value).catch((e) => console.warn('[settings] save failed', key, e))
    },
    [onSettingsChange],
  )

  const pickTheme = useCallback(
    (name: ThemeName) => {
      setTheme(name)
      void update('theme', name)
    },
    [setTheme, update],
  )

  const toggleAutostart = useCallback(
    async (on: boolean) => {
      try {
        await setAutostart(on)
        setSettings((prev) => {
          const next = { ...prev, autostart: on }
          onSettingsChange?.(next)
          return next
        })
      } catch (e) {
        console.warn('[settings] autostart failed', e)
      }
    },
    [onSettingsChange],
  )

  const testModelChat = useCallback(async () => {
    setChatTestHint('测试中...')
    try {
      const res = await sendModelChatMessage({
        providerUrl: settings.modelChatProviderUrl,
        apiKey: settings.modelChatApiKey,
        model: settings.modelChatModel,
        messages: [
          ...((settings.modelChatSystemPrompt || DEFAULT_SETTINGS.modelChatSystemPrompt).trim()
            ? [
                {
                  role: 'system' as const,
                  content: (settings.modelChatSystemPrompt || DEFAULT_SETTINGS.modelChatSystemPrompt).trim(),
                },
              ]
            : []),
          { role: 'user', content: '请只回复 OK' },
        ],
      })
      setChatTestHint(`连接成功：${res.content.slice(0, 48) || 'OK'}`)
    } catch (e) {
      setChatTestHint(`连接失败：${String(e)}`)
    }
  }, [settings])

  const cleanupNow = useCallback(async () => {
    setCleanupHint('清理中…')
    try {
      const result = await runAppCleanup(settings, true)
      setCleanupHint(`已清理 ${result.notificationsRemoved} 条完成记录、${result.conversationsRemoved} 个模型会话`)
    } catch (e) {
      setCleanupHint(`清理失败：${String(e)}`)
    }
  }, [settings])

  const checkUpdatesNow = useCallback(async () => {
    setUpdateChecking(true)
    setUpdateHint('正在连接 GitHub…')
    try {
      const info = await checkForUpdates(true, false)
      setUpdateInfo(info)
      setUpdateHint(info?.updateAvailable
        ? `发现新版本 v${info.latestVersion}（当前 v${info.currentVersion}）`
        : `已是最新版 v${info?.currentVersion ?? appVersion}`)
    } catch (e) {
      setUpdateInfo(null)
      setUpdateHint(`检查失败：${String(e)}`)
    } finally {
      setUpdateChecking(false)
    }
  }, [appVersion])

  return (
    <div className={css.root} style={{ ...themeCssVars(theme), width, height }}>
      <Section title="连接">
        <Row label="显示 Claude Code" desc="关闭后不参与列表、Stackling 状态和通知">
          <Toggle checked={settings.enableClaudeCode} onChange={(v) => update('enableClaudeCode', v)} />
        </Row>
        <Row label="显示 Codex" desc="关闭后不参与列表、Stackling 状态和通知">
          <Toggle checked={settings.enableCodex} onChange={(v) => update('enableCodex', v)} />
        </Row>
        <Row label="显示 Cursor" desc="关闭后不参与列表、Stackling 状态和通知">
          <Toggle checked={settings.enableCursor} onChange={(v) => update('enableCursor', v)} />
        </Row>
        <div className={css.row} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', width: '100%', gap: 12 }}>
            <div className={css.rowText} style={{ flex: 1 }}>
              <span className={css.rowLabel}>Hook 健康检查</span>
              <span className={css.rowDesc}>检查脚本、配置注册和本地监听端口</span>
            </div>
            <button className={css.btn} style={{ flexShrink: 0 }} disabled={hookChecking} onClick={checkHooks}>
              {hookChecking ? '检查中…' : '重新检查'}
            </button>
          </div>
          {hookHealth.map((item) => (
            <div key={item.source} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
              <span style={{ color: item.healthy ? theme.statusDone : theme.statusWaiting }}>●</span>
              <span style={{ minWidth: 76, color: theme.text }}>{HOOK_LABELS[item.source]}</span>
              <span style={{ flex: 1, color: theme.textDim }}>{item.message}</span>
              {!item.healthy && (
                <button className={css.btn} disabled={hookChecking || !item.configValid} onClick={() => repairHook(item.source)}>
                  修复
                </button>
              )}
            </div>
          ))}
          {hookHealth.some((item) => item.source === 'codex' && item.registered) && (
            <div className={css.hint}>注意：Codex 连接需要在设置中信任钩子</div>
          )}
        </div>
      </Section>

      <Section title="显示">
        <Row label="主题色" desc="切换面板配色">
          <div className={css.themeRow}>
            {THEME_ORDER.map((name) => {
              const active = theme.name === name
              const dotColor = name === 'dark' ? THEMES.dark.bg : THEMES[name].accent
              return (
                <button
                  key={name}
                  className={css.themeDot}
                  title={THEME_LABELS[name]}
                  onClick={() => pickTheme(name)}
                  style={{
                    background: dotColor,
                    borderColor: active
                      ? theme.text
                      : name === 'dark'
                        ? 'rgba(0,0,0,0.18)'
                        : 'transparent',
                  }}
                />
              )
            })}
          </div>
        </Row>

        <Row label="Live2D 模型" desc="折叠态看板娘使用的模型">
          <select
            className={css.select}
            value={settings.live2dModelId}
            onChange={(e) => update('live2dModelId', e.target.value)}
          >
            {models.length === 0 && <option value={settings.live2dModelId}>{settings.live2dModelId}</option>}
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </Row>

        <Row label="模型大小" desc="缩放折叠态看板娘（50%~150%）">
          <select
            className={css.select}
            value={snapScale(settings.live2dScale)}
            onChange={(e) => update('live2dScale', Number(e.target.value))}
          >
            {SCALE_OPTIONS.map((v) => (
              <option key={v} value={v}>
                {Math.round(v * 100)}%
              </option>
            ))}
          </select>
        </Row>
        <Row label="多显示器边缘停靠" desc="拖动结束时吸附到当前显示器工作区边缘">
          <Toggle checked={settings.dockEnabled} onChange={(v) => update('dockEnabled', v)} />
        </Row>
        <Row label="停靠距离" desc="距离屏幕边缘多少像素时自动吸附（8~80）">
          <input
            type="number"
            className={css.numInput}
            min={8}
            max={80}
            disabled={!settings.dockEnabled}
            value={settings.dockThreshold}
            onChange={(e) => {
              const n = Math.round(Number(e.target.value))
              update('dockThreshold', Number.isFinite(n) ? Math.min(80, Math.max(8, n)) : 25)
            }}
          />
        </Row>
      </Section>

      <Section title="模型对话">
        <Row label="启用模型对话" desc="在看板娘脚下显示独立提问框">
          <Toggle checked={settings.modelChatEnabled} onChange={(v) => update('modelChatEnabled', v)} />
        </Row>
        <div className={css.row} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          <div className={css.rowText} style={{ marginBottom: 8 }}>
            <span className={css.rowLabel}>NewAPI 地址</span>
            <span className={css.rowDesc}>填写 NewAPI 服务地址</span>
          </div>
          <input
            className={css.textInput}
            placeholder="http://localhost:3000"
            value={settings.modelChatProviderUrl}
            onChange={(e) => update('modelChatProviderUrl', e.target.value)}
          />
        </div>
        <div className={css.row} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          <div className={css.rowText} style={{ marginBottom: 8 }}>
            <span className={css.rowLabel}>API 密钥</span>
            <span className={css.rowDesc}>用于请求 NewAPI</span>
          </div>
          <input
            className={css.textInput}
            type="password"
            placeholder="sk-..."
            value={settings.modelChatApiKey}
            onChange={(e) => update('modelChatApiKey', e.target.value)}
          />
        </div>
        <div className={css.row} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          <div className={css.rowText} style={{ marginBottom: 8 }}>
            <span className={css.rowLabel}>模型名称</span>
            <span className={css.rowDesc}>填写 NewAPI 中可用的模型名</span>
          </div>
          <input
            className={css.textInput}
            placeholder="gpt-4o-mini"
            value={settings.modelChatModel}
            onChange={(e) => update('modelChatModel', e.target.value)}
          />
        </div>
        <div className={css.row} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          <div className={css.rowText} style={{ marginBottom: 8 }}>
            <span className={css.rowLabel}>系统提示词</span>
            <span className={css.rowDesc}>定义看板娘的回复风格和边界</span>
          </div>
          <textarea
            className={css.textArea}
            value={settings.modelChatSystemPrompt}
            onChange={(e) => update('modelChatSystemPrompt', e.target.value)}
          />
        </div>
        <Row label="上下文条数" desc="每次请求直接发送最近多少条历史消息">
          <input
            type="number"
            className={css.numInput}
            min={2}
            max={50}
            value={settings.modelChatContextLimit}
            onChange={(e) => {
              const n = Math.round(Number(e.target.value))
              const v = Number.isFinite(n) ? Math.min(50, Math.max(2, n)) : 20
              update('modelChatContextLimit', v)
            }}
          />
        </Row>
        <Row label="自动摘要历史" desc="超过上下文条数时，调用模型滚动总结更早消息">
          <Toggle checked={settings.modelChatAutoSummary} onChange={(v) => update('modelChatAutoSummary', v)} />
        </Row>
        <div className={css.row} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          <button className={`${css.btn} ${css.btnPrimary}`} onClick={testModelChat}>
            测试连接
          </button>
          {chatTestHint && <div className={css.hint}>{chatTestHint}</div>}
        </div>
      </Section>

      <Section title="提示音">
        <Row label="Claude Code 完成音" desc="Claude Code 完成任务时播放">
          <Toggle checked={settings.ccSoundEnabled} onChange={(v) => update('ccSoundEnabled', v)} />
        </Row>
        <Row label="Codex 完成音" desc="Codex 完成任务时播放">
          <Toggle checked={settings.codexSoundEnabled} onChange={(v) => update('codexSoundEnabled', v)} />
        </Row>
        <Row label="Cursor 完成音" desc="Cursor 完成任务时播放">
          <Toggle checked={settings.cursorSoundEnabled} onChange={(v) => update('cursorSoundEnabled', v)} />
        </Row>
        <Row label="等待提示音" desc="需要用户处理（等待授权）时播放">
          <Toggle checked={settings.waitingSound} onChange={(v) => update('waitingSound', v)} />
        </Row>
        <Row label="自动关闭完成弹窗" desc="完成弹窗在设定时间后自动关闭">
          <Toggle checked={settings.autoCloseCompletion} onChange={(v) => update('autoCloseCompletion', v)} />
        </Row>
        <Row label="自动关闭延时" desc="多少秒后自动关闭完成弹窗（1~120）">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="number"
              className={css.numInput}
              min={1}
              max={120}
              disabled={!settings.autoCloseCompletion}
              value={settings.autoCloseCompletionSec}
              onChange={(e) => {
                const n = Math.round(Number(e.target.value))
                const v = Number.isFinite(n) ? Math.min(120, Math.max(1, n)) : 5
                update('autoCloseCompletionSec', v)
              }}
            />
            <span className={css.value}>秒</span>
          </div>
        </Row>
      </Section>

      <Section title="系统">
        <Row label="调试边框" desc="显示看板娘透明窗口边界">
          <Toggle checked={settings.debugBorder} onChange={(v) => update('debugBorder', v)} />
        </Row>
        <Row label="开机自启" desc="登录系统时自动启动">
          <Toggle checked={settings.autostart} onChange={toggleAutostart} />
        </Row>
        <Row label="自动检查更新" desc="每天检查一次 GitHub 最新正式版">
          <Toggle checked={settings.autoCheckUpdates} onChange={(v) => update('autoCheckUpdates', v)} />
        </Row>
        <div className={css.row} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div className={css.rowText} style={{ flex: 1 }}>
              <span className={css.rowLabel}>软件更新</span>
              <span className={css.rowDesc}>当前版本 {appVersion ? `v${appVersion}` : '读取中…'}</span>
            </div>
            <button className={css.btn} disabled={updateChecking} onClick={checkUpdatesNow}>
              {updateChecking ? '检查中…' : '立即检查'}
            </button>
          </div>
          {updateHint && <div className={css.hint}>{updateHint}</div>}
          {updateInfo?.updateAvailable && (
            <button
              className={`${css.btn} ${css.btnPrimary}`}
              onClick={() => openLatestRelease().catch((e) => setUpdateHint(`打开下载页失败：${String(e)}`))}
            >
              前往 GitHub 下载 v{updateInfo.latestVersion}
            </button>
          )}
        </div>
        <div className={`${css.row} ${css.cleanupRow}`}>
          <div className={css.cleanupHeader}>
            <div className={css.rowText}>
              <span className={css.rowLabel}>自动清理</span>
              <span className={css.rowDesc}>每天清理一次 Stackling 的历史数据</span>
            </div>
            <Toggle checked={settings.autoCleanupEnabled} onChange={(v) => update('autoCleanupEnabled', v)} />
          </div>
          <button className={css.btn} onClick={cleanupNow}>立即清理</button>
          {cleanupHint && <div className={css.hint}>{cleanupHint}</div>}
        </div>
        <Row label="完成历史保留天数" desc="超过此天数的完成通知会被删除（1~365）">
          <input
            type="number"
            className={css.numInput}
            min={1}
            max={365}
            value={settings.completionHistoryRetentionDays}
            onChange={(e) => {
              const n = Math.round(Number(e.target.value))
              update('completionHistoryRetentionDays', Number.isFinite(n) ? Math.min(365, Math.max(1, n)) : 30)
            }}
          />
        </Row>
        <Row label="完成历史上限条数" desc="最多保留最近 10~500 条记录">
          <input
            type="number"
            className={css.numInput}
            min={10}
            max={500}
            value={settings.maxCompletionHistory}
            onChange={(e) => {
              const n = Math.round(Number(e.target.value))
              update('maxCompletionHistory', Number.isFinite(n) ? Math.min(500, Math.max(10, n)) : 30)
            }}
          />
        </Row>
        <Row label="模型会话保留天数" desc="删除超过此天数的旧模型会话">
          <input
            type="number"
            className={css.numInput}
            min={1}
            max={365}
            value={settings.modelChatRetentionDays}
            onChange={(e) => {
              const n = Math.round(Number(e.target.value))
              update('modelChatRetentionDays', Number.isFinite(n) ? Math.min(365, Math.max(1, n)) : 90)
            }}
          />
        </Row>
        <div className={css.row} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          <div className={css.rowText} style={{ marginBottom: 8 }}>
            <span className={css.rowLabel}>退出 Stackling</span>
            <span className={css.rowDesc}>关闭看板娘并退出应用</span>
          </div>
          <button
            className={`${css.btn} ${css.btnDanger}`}
            onClick={() => invoke('quit_app').catch(() => {})}
          >
            退出
          </button>
        </div>
      </Section>

      <footer className={css.appMeta}>
        <span className={css.version}>Stackling {appVersion ? `v${appVersion}` : ''}</span>
        <button
          type="button"
          className={css.githubBadge}
          title="kafuucoori/Stackling_Coding_Companion"
          aria-label="在 GitHub 查看 kafuucoori/Stackling_Coding_Companion"
          onClick={() => openUrl(GITHUB_URL).catch((e) => console.warn('[settings] open GitHub failed', e))}
        >
          <Github size={14} strokeWidth={2} aria-hidden="true" />
          <span>GitHub</span>
        </button>
      </footer>
    </div>
  )
}

export default function SettingsPanel({
  initialTheme,
  onThemeChange,
  ...rest
}: SettingsPanelProps & { initialTheme?: ThemeName; onThemeChange?: (n: ThemeName) => void }) {
  return (
    <ThemeProvider initialTheme={initialTheme ?? 'pink'} onThemeChange={onThemeChange}>
      <SettingsInner {...rest} />
    </ThemeProvider>
  )
}
