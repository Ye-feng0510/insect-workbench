import { useContext } from 'react'
import { WorkbenchThemeContext } from './workbenchThemeContext'

export function useWorkbenchTheme() {
  const context = useContext(WorkbenchThemeContext)
  if (!context) {
    throw new Error('useWorkbenchTheme 必须在 WorkbenchThemeProvider 内使用')
  }
  return context
}
