export const WORKBENCH_THEME_STORAGE_KEY = 'insect-workbench:visual-theme:v1'

export type WorkbenchTheme = 'day' | 'night'

export interface ThemeTransitionOrigin {
  x: number
  y: number
}

export function isWorkbenchTheme(value: unknown): value is WorkbenchTheme {
  return value === 'day' || value === 'night'
}

export function loadWorkbenchTheme(storage: Storage | undefined): WorkbenchTheme {
  if (!storage) return 'day'
  try {
    const value = storage.getItem(WORKBENCH_THEME_STORAGE_KEY)
    return isWorkbenchTheme(value) ? value : 'day'
  } catch {
    return 'day'
  }
}

export function saveWorkbenchTheme(
  storage: Storage | undefined,
  theme: WorkbenchTheme,
): void {
  try {
    storage?.setItem(WORKBENCH_THEME_STORAGE_KEY, theme)
  } catch {
  }
}

export function getNextWorkbenchTheme(theme: WorkbenchTheme): WorkbenchTheme {
  return theme === 'day' ? 'night' : 'day'
}

export function getThemeRevealRadius(
  origin: ThemeTransitionOrigin,
  viewportWidth: number,
  viewportHeight: number,
): number {
  return Math.hypot(
    Math.max(origin.x, viewportWidth - origin.x),
    Math.max(origin.y, viewportHeight - origin.y),
  )
}
