import { createContext } from 'react'
import type { ThemeTransitionOrigin, WorkbenchTheme } from './workbenchTheme'

export interface WorkbenchThemeContextValue {
  theme: WorkbenchTheme
  transitioning: boolean
  toggleTheme: (origin: ThemeTransitionOrigin) => void
}

export const WorkbenchThemeContext = createContext<WorkbenchThemeContextValue | null>(null)
