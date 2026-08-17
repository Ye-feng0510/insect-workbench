import { MoonStar, Sun } from 'lucide-react'
import { useWorkbenchTheme } from './useWorkbenchTheme'

export default function ThemeToggle() {
  const { theme, transitioning, toggleTheme } = useWorkbenchTheme()
  const night = theme === 'night'
  const label = night ? '切换到日间工作模式' : '切换到夜间护眼模式'

  return (
    <button
      type="button"
      role="switch"
      aria-checked={night}
      aria-label={label}
      title={label}
      disabled={transitioning}
      data-theme={theme}
      data-transitioning={transitioning || undefined}
      className="workbench-theme-toggle"
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect()
        toggleTheme({
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        })
      }}
    >
      <span className="workbench-theme-toggle__halo" aria-hidden="true" />
      <Sun className="workbench-theme-toggle__icon workbench-theme-toggle__icon--sun" aria-hidden="true" />
      <MoonStar className="workbench-theme-toggle__icon workbench-theme-toggle__icon--moon" aria-hidden="true" />
    </button>
  )
}
