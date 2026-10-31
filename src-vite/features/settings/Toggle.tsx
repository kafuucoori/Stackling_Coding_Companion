/** Toggle —— 主题化开关小组件。 */

import { useTheme } from '@/features/info-panel/theme'

interface ToggleProps {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}

export default function Toggle({ checked, onChange, disabled }: ToggleProps) {
  const { theme } = useTheme()
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      style={{
        position: 'relative',
        display: 'inline-flex',
        height: 24,
        width: 44,
        flexShrink: 0,
        cursor: disabled ? 'not-allowed' : 'pointer',
        borderRadius: 9999,
        border: '2px solid transparent',
        background: checked ? theme.accent : theme.border,
        transition: 'background 0.2s ease',
        opacity: disabled ? 0.5 : 1,
        padding: 0,
      }}
    >
      <span
        style={{
          pointerEvents: 'none',
          display: 'inline-block',
          height: 20,
          width: 20,
          borderRadius: '50%',
          background: '#fff',
          boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
          transform: checked ? 'translateX(20px)' : 'translateX(0)',
          transition: 'transform 0.2s ease',
        }}
      />
    </button>
  )
}
