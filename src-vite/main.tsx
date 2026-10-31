/**
 * main.tsx —— 单入口，按 URL hash 按需加载对应窗口。
 */

import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'

const MascotWindow = lazy(() => import('./windows/MascotWindow'))
const PanelWindow = lazy(() => import('./windows/PanelWindow'))
const SettingsWindow = lazy(() => import('./windows/SettingsWindow'))
const CompletionWindow = lazy(() => import('./windows/CompletionWindow'))
const ChatInputWindow = lazy(() => import('./windows/ChatInputWindow'))
const ChatHistoryWindow = lazy(() => import('./windows/ChatHistoryWindow'))

function pickWindow() {
  const hash = window.location.hash.replace(/^#\/?/, '')
  switch (hash) {
    case 'panel':
      return <PanelWindow />
    case 'settings':
      return <SettingsWindow />
    case 'completion':
      return <CompletionWindow />
    case 'chat-input':
      return <ChatInputWindow />
    case 'chat-history':
      return <ChatHistoryWindow />
    case 'mascot':
    default:
      return <MascotWindow />
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode><Suspense fallback={null}>{pickWindow()}</Suspense></StrictMode>,
)
