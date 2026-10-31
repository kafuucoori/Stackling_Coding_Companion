// theme.ts —— 四主题系统（粉/绿/蓝/黑）。<ThemeProvider> + useTheme()；
// 同时把 token 注入成 CSS 变量（--accent 等）供 CSS module 用。

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

export type ThemeName = 'pink' | 'green' | 'blue' | 'dark'

export interface Theme {
  name: ThemeName
  accent: string
  accentSoft: string
  bg: string
  surface: string
  surfaceHover: string
  border: string
  text: string
  textDim: string
  textFaint: string
  statusWorking: string
  statusWaiting: string
  statusDone: string
  dark: boolean
}

export const THEMES: Record<ThemeName, Theme> = {
  pink: {
    name: 'pink',
    accent: '#f06fa0',
    accentSoft: 'rgba(240,111,160,0.12)',
    bg: '#fff5f8',
    surface: '#ffffff',
    surfaceHover: '#fdeef3',
    border: '#f3d7e1',
    text: '#3a2730',
    textDim: '#8a6f79',
    textFaint: '#b9a4ac',
    statusWorking: '#2ecc71',
    statusWaiting: '#f59e0b',
    statusDone: '#94a3b8',
    dark: false,
  },
  green: {
    name: 'green',
    accent: '#2ecc71',
    accentSoft: 'rgba(46,204,113,0.12)',
    bg: '#f3faf5',
    surface: '#ffffff',
    surfaceHover: '#eaf6ee',
    border: '#cfe9d8',
    text: '#23332a',
    textDim: '#5f7a69',
    textFaint: '#a3bcaf',
    statusWorking: '#2ecc71',
    statusWaiting: '#f59e0b',
    statusDone: '#94a3b8',
    dark: false,
  },
  blue: {
    name: 'blue',
    accent: '#007AFF',
    accentSoft: 'rgba(0,122,255,0.10)',
    bg: '#f2f7fd',
    surface: '#ffffff',
    surfaceHover: '#e9f2fc',
    border: '#cfe0f3',
    text: '#1f2d3d',
    textDim: '#5b6f86',
    textFaint: '#9fb2c8',
    statusWorking: '#2ecc71',
    statusWaiting: '#f59e0b',
    statusDone: '#94a3b8',
    dark: false,
  },
  dark: {
    name: 'dark',
    accent: '#6ea8fe',
    accentSoft: 'rgba(110,168,254,0.16)',
    bg: '#1b1d22',
    surface: '#24262c',
    surfaceHover: '#2c2f36',
    border: 'rgba(255,255,255,0.10)',
    text: '#e8eaed',
    textDim: 'rgba(232,234,237,0.62)',
    textFaint: 'rgba(232,234,237,0.34)',
    statusWorking: '#3ddc84',
    statusWaiting: '#f59e0b',
    statusDone: '#94a3b8',
    dark: true,
  },
}

export const THEME_ORDER: ThemeName[] = ['pink', 'green', 'blue', 'dark']
export const THEME_LABELS: Record<ThemeName, string> = {
  pink: '粉',
  green: '绿',
  blue: '蓝',
  dark: '黑',
}

interface ThemeContextValue {
  theme: Theme
  setTheme: (name: ThemeName) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function themeCssVars(theme: Theme): Record<string, string> {
  return {
    '--accent': theme.accent,
    '--accent-soft': theme.accentSoft,
    '--bg': theme.bg,
    '--surface': theme.surface,
    '--surface-hover': theme.surfaceHover,
    '--border': theme.border,
    '--text': theme.text,
    '--text-dim': theme.textDim,
    '--text-faint': theme.textFaint,
    '--status-working': theme.statusWorking,
    '--status-waiting': theme.statusWaiting,
    '--status-done': theme.statusDone,
  }
}

interface ThemeProviderProps {
  initialTheme?: ThemeName
  onThemeChange?: (name: ThemeName) => void
  children: ReactNode
}

export function ThemeProvider({
  initialTheme = 'pink',
  onThemeChange,
  children,
}: ThemeProviderProps) {
  const [name, setName] = useState<ThemeName>(initialTheme)
  useEffect(() => {
    setName(initialTheme)
  }, [initialTheme])
  const setTheme = useCallback(
    (n: ThemeName) => {
      setName(n)
      onThemeChange?.(n)
    },
    [onThemeChange],
  )
  const value = useMemo<ThemeContextValue>(
    () => ({ theme: THEMES[name], setTheme }),
    [name, setTheme],
  )
  return createElement(ThemeContext.Provider, { value }, children)
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) {
    return { theme: THEMES.pink, setTheme: () => {} }
  }
  return ctx
}
