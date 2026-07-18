// windowManager.ts —— 窗口定位/显隐（Tauri v2 JS API，Windows）。
// 核心 positionPanelNearMascot：面板从看板娘智能选位（上→下→侧→夹进屏内）。
// 另含看板娘位置持久化、拖动辅助。

import { getCurrentWindow, Window, LogicalPosition, LogicalSize, currentMonitor, monitorFromPoint, availableMonitors, primaryMonitor } from '@tauri-apps/api/window'
import { load } from '@tauri-apps/plugin-store'

const SCREEN_MARGIN = 8
const CHAT_INPUT_SCREEN_MARGIN = 2
const DOCK_OVERLAP = 0

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

async function logicalRect(win: Window): Promise<Rect> {
  const [pos, size, scale] = await Promise.all([
    win.outerPosition(),
    win.outerSize(),
    win.scaleFactor(),
  ])
  return { x: pos.x / scale, y: pos.y / scale, w: size.width / scale, h: size.height / scale }
}

async function monitorRect(win: Window): Promise<Rect> {
  const [pos, size] = await Promise.all([win.outerPosition(), win.outerSize()])
  const cx = pos.x + size.width / 2
  const cy = pos.y + size.height / 2
  const m = (await monitorFromPoint(cx, cy).catch(() => null)) ?? (await currentMonitor())
  if (!m) {
    return { x: 0, y: 0, w: 1920, h: 1080 }
  }
  const scale = m.scaleFactor || (await win.scaleFactor())
  const area = m.workArea ?? { position: m.position, size: m.size }
  return {
    x: area.position.x / scale,
    y: area.position.y / scale,
    w: area.size.width / scale,
    h: area.size.height / scale,
  }
}

async function positionPanel(show: boolean): Promise<void> {
  const mascot = await Window.getByLabel('mascot')
  const panel = await Window.getByLabel('panel')
  if (!mascot || !panel) return

  if (!show) {
    const visible = await panel.isVisible().catch(() => false)
    if (!visible) return
  }

  const m = await logicalRect(mascot)
  const p = await logicalRect(panel)
  const scr = await monitorRect(mascot)

  const mascotCenterX = m.x + m.w / 2

  let px = mascotCenterX - p.w / 2
  let py: number

  const spaceAbove = m.y - scr.y
  const spaceBelow = scr.y + scr.h - (m.y + m.h)

  if (spaceAbove >= p.h + SCREEN_MARGIN) {
    py = m.y - p.h
  } else if (spaceBelow >= p.h + SCREEN_MARGIN) {
    py = m.y + m.h
  } else {
    const scrCenterX = scr.x + scr.w / 2
    if (mascotCenterX > scrCenterX) {
      px = m.x - p.w
    } else {
      px = m.x + m.w
    }
    py = m.y + m.h / 2 - p.h / 2
  }

  px = Math.max(scr.x + SCREEN_MARGIN, Math.min(px, scr.x + scr.w - p.w - SCREEN_MARGIN))
  py = Math.max(scr.y + SCREEN_MARGIN, Math.min(py, scr.y + scr.h - p.h - SCREEN_MARGIN))

  await panel.setPosition(new LogicalPosition(Math.round(px), Math.round(py)))
  if (show) {
    await panel.show()
    await panel.setFocus()
  }
}

export async function positionPanelNearMascot(): Promise<void> {
  await positionPanel(true)
}

export async function hidePanel(): Promise<void> {
  const panel = await Window.getByLabel('panel')
  if (panel) await panel.hide()
}

export async function positionPanelIfVisible(): Promise<void> {
  await positionPanel(false)
}

export async function positionCompletionNearMascot(): Promise<void> {
  const mascot = await Window.getByLabel('mascot')
  const win = await Window.getByLabel('completion')
  if (!mascot || !win) return

  const m = await logicalRect(mascot)
  const c = await logicalRect(win)
  const scr = await monitorRect(mascot)

  const panel = await Window.getByLabel('panel')
  const panelVisible = panel ? await panel.isVisible().catch(() => false) : false
  const anchor = panelVisible && panel ? await logicalRect(panel) : m

  let px = anchor.x + anchor.w / 2 - c.w / 2
  const spaceAbove = anchor.y - scr.y
  let py = spaceAbove >= c.h + SCREEN_MARGIN ? anchor.y - c.h : anchor.y + anchor.h

  px = Math.max(scr.x + SCREEN_MARGIN, Math.min(px, scr.x + scr.w - c.w - SCREEN_MARGIN))
  py = Math.max(scr.y + SCREEN_MARGIN, Math.min(py, scr.y + scr.h - c.h - SCREEN_MARGIN))

  await win.setPosition(new LogicalPosition(Math.round(px), Math.round(py)))
  await win.show()
}

export async function positionCompletionIfVisible(): Promise<void> {
  const win = await Window.getByLabel('completion')
  if (!win) return
  const visible = await win.isVisible().catch(() => false)
  if (visible) await positionCompletionNearMascot()
}

export async function resizeCompletionToContent(height: number): Promise<void> {
  const win = await Window.getByLabel('completion')
  if (!win) return
  const size = await win.outerSize()
  const scale = await win.scaleFactor()
  const logicalWidth = size.width / scale
  const nextHeight = Math.max(56, Math.min(150, Math.ceil(height)))
  await win.setSize(new LogicalSize(Math.round(logicalWidth), nextHeight))
}

export async function hideCompletion(): Promise<void> {
  const win = await Window.getByLabel('completion')
  if (win) await win.hide()
}

export async function positionChatInputNearMascot(): Promise<void> {
  const mascot = await Window.getByLabel('mascot')
  const input = await Window.getByLabel('chat-input')
  if (!mascot || !input) return

  const m = await logicalRect(mascot)
  const i = await logicalRect(input)
  const scr = await monitorRect(mascot)

  let px = m.x + m.w / 2 - i.w / 2
  let py = m.y + m.h - DOCK_OVERLAP

  px = Math.max(scr.x + SCREEN_MARGIN, Math.min(px, scr.x + scr.w - i.w - SCREEN_MARGIN))
  py = Math.max(
    scr.y + CHAT_INPUT_SCREEN_MARGIN,
    Math.min(py, scr.y + scr.h - i.h - CHAT_INPUT_SCREEN_MARGIN),
  )

  await input.setPosition(new LogicalPosition(Math.round(px), Math.round(py)))
  await input.show()
}

export async function hideChatInput(): Promise<void> {
  const input = await Window.getByLabel('chat-input')
  if (input) await input.hide()
  await hideChatHistory()
}

export async function positionChatHistoryNearMascot(show = true): Promise<void> {
  const mascot = await Window.getByLabel('mascot')
  const history = await Window.getByLabel('chat-history')
  if (!mascot || !history) return

  const m = await logicalRect(mascot)
  const h = await logicalRect(history)
  const scr = await monitorRect(mascot)

  const candidates = [
    { x: m.x - h.w + DOCK_OVERLAP, y: m.y + m.h / 2 - h.h / 2 },
    { x: m.x + m.w - DOCK_OVERLAP, y: m.y + m.h / 2 - h.h / 2 },
    { x: m.x + m.w / 2 - h.w / 2, y: m.y - h.h + DOCK_OVERLAP },
    { x: m.x + m.w / 2 - h.w / 2, y: m.y + m.h - DOCK_OVERLAP },
  ]

  const fits = (p: { x: number; y: number }) =>
    p.x >= scr.x + SCREEN_MARGIN &&
    p.y >= scr.y + SCREEN_MARGIN &&
    p.x + h.w <= scr.x + scr.w - SCREEN_MARGIN &&
    p.y + h.h <= scr.y + scr.h - SCREEN_MARGIN

  const chosen = candidates.find(fits) ?? candidates[0]
  const px = Math.max(scr.x + SCREEN_MARGIN, Math.min(chosen.x, scr.x + scr.w - h.w - SCREEN_MARGIN))
  const py = Math.max(scr.y + SCREEN_MARGIN, Math.min(chosen.y, scr.y + scr.h - h.h - SCREEN_MARGIN))

  await history.setPosition(new LogicalPosition(Math.round(px), Math.round(py)))
  if (show) await history.show()
}

export async function positionChatHistoryIfVisible(): Promise<void> {
  const history = await Window.getByLabel('chat-history')
  if (!history) return
  const visible = await history.isVisible().catch(() => false)
  if (visible) await positionChatHistoryNearMascot(false)
}

export async function hideChatHistory(): Promise<void> {
  const history = await Window.getByLabel('chat-history')
  if (history) await history.hide()
}

export async function toggleChatHistory(): Promise<void> {
  const history = await Window.getByLabel('chat-history')
  if (!history) return
  const visible = await history.isVisible().catch(() => false)
  if (visible) await history.hide()
  else await positionChatHistoryNearMascot()
}

export async function isPanelVisible(): Promise<boolean> {
  const panel = await Window.getByLabel('panel')
  return panel ? panel.isVisible() : false
}

const POS_KEY_X = 'mascot_x'
const POS_KEY_Y = 'mascot_y'

export async function restoreMascotPosition(): Promise<void> {
  const win = getCurrentWindow()
  const store = await load('settings.json', { defaults: {}, autoSave: true })
  const x = (await store.get<number>(POS_KEY_X)) ?? null
  const y = (await store.get<number>(POS_KEY_Y)) ?? null
  if (x != null && y != null) {
    const monitors = await availableMonitors().catch(() => [])
    const isVisible = monitors.some((monitor) => {
      const scale = monitor.scaleFactor || 1
      const area = monitor.workArea ?? { position: monitor.position, size: monitor.size }
      const left = area.position.x / scale
      const top = area.position.y / scale
      const right = left + area.size.width / scale
      const bottom = top + area.size.height / scale
      return x >= left - 40 && x < right && y >= top - 40 && y < bottom
    })
    if (isVisible || monitors.length === 0) {
      await win.setPosition(new LogicalPosition(x, y))
    } else {
      const monitor = await primaryMonitor().catch(() => null)
      if (monitor) {
        const scale = monitor.scaleFactor || 1
        const area = monitor.workArea ?? { position: monitor.position, size: monitor.size }
        await win.setPosition(new LogicalPosition(
          Math.round(area.position.x / scale + SCREEN_MARGIN),
          Math.round(area.position.y / scale + SCREEN_MARGIN),
        ))
        await saveMascotPosition()
      }
    }
  }
}

export async function saveMascotPosition(): Promise<void> {
  const win = getCurrentWindow()
  const r = await logicalRect(win)
  const store = await load('settings.json', { defaults: {}, autoSave: true })
  await store.set(POS_KEY_X, Math.round(r.x))
  await store.set(POS_KEY_Y, Math.round(r.y))
  await store.save()
}

export async function snapMascotToNearestEdge(threshold = 28): Promise<boolean> {
  const win = getCurrentWindow()
  const rect = await logicalRect(win)
  const screen = await monitorRect(win)
  const horizontal = [
    { distance: Math.abs(rect.x - screen.x), value: screen.x },
    { distance: Math.abs(screen.x + screen.w - (rect.x + rect.w)), value: screen.x + screen.w - rect.w },
  ].sort((a, b) => a.distance - b.distance)[0]
  const vertical = [
    { distance: Math.abs(rect.y - screen.y), value: screen.y },
    { distance: Math.abs(screen.y + screen.h - (rect.y + rect.h)), value: screen.y + screen.h - rect.h },
  ].sort((a, b) => a.distance - b.distance)[0]
  if (horizontal.distance > threshold && vertical.distance > threshold) return false
  const targetX = horizontal.distance <= threshold ? horizontal.value : rect.x
  const targetY = vertical.distance <= threshold ? vertical.value : rect.y
  const x = Math.max(screen.x, Math.min(targetX, screen.x + screen.w - rect.w))
  const y = Math.max(screen.y, Math.min(targetY, screen.y + screen.h - rect.h))
  await win.setPosition(new LogicalPosition(Math.round(x), Math.round(y)))
  await saveMascotPosition()
  return true
}

export async function startDragging(): Promise<void> {
  await getCurrentWindow().startDragging()
}
